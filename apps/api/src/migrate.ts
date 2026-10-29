import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { env } from './config.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: env.databaseUrl, max: 1, ssl: env.databaseSsl, connectionTimeoutMillis: 5000 });
const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const migrations = (await readdir(migrationDirectory)).filter(name => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(name)).sort();

// A session advisory lock serializes migration runners even when deployments overlap.
const lockKey = [20261029, 501];
let client: pg.PoolClient | undefined;
let lockAcquired = false;

try {
  client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1, $2)', lockKey);
  lockAcquired = true;

  if (migrations.length === 0) throw new Error('No migration files found.');
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );

  for (const name of migrations) {
    const existing = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [name]);
    if (existing.rows.length) continue;
    const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(JSON.stringify({ event: 'migration_applied', name }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'migration_failed';
  console.error(JSON.stringify({ level: 'error', event: 'migration_failed', code }));
  process.exitCode = 1;
} finally {
  if (client) {
    if (lockAcquired) await client.query('SELECT pg_advisory_unlock($1, $2)', lockKey).catch(() => undefined);
    client.release();
  }
  await pool.end();
}
