import pg from 'pg';
import { env } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.databasePoolMax,
  ssl: env.databaseSsl,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
  query_timeout: 12_000,
  application_name: 'staypilot-api'
});

pool.on('error', (error) => {
  // No SQL parameters, customer content, credentials, or connection string in logs.
  console.error(JSON.stringify({ level: 'error', event: 'postgres_idle_client_error', code: (error as NodeJS.ErrnoException).code || 'unknown' }));
});

export async function checkDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function checkSchemaReady(): Promise<void> {
  const result = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1", ['0001_initial.sql']);
  if (!result.rows.length) throw new Error('database_schema_not_migrated');
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '8s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
