import pg from 'pg';

const { Client } = pg;
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  // This short-lived helper only reads the public CA certificate so the API can
  // subsequently use normal certificate verification. It never exports a key.
  ssl: { rejectUnauthorized: false, servername: 'localhost' },
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  application_name: 'staypilot-ca-export-once'
});

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing');
  await client.connect();
  const result = await client.query(
    'SELECT pg_read_file($1) AS certificate',
    ['/var/lib/postgresql/data/certs/root.crt']
  );
  const certificate = result.rows[0]?.certificate;
  if (typeof certificate !== 'string' || !certificate.includes('BEGIN CERTIFICATE') || !certificate.includes('END CERTIFICATE')) {
    throw new Error('The expected public CA certificate was not returned');
  }
  console.log('STAYPILOT_PUBLIC_CA_BEGIN');
  console.log(certificate);
  console.log('STAYPILOT_PUBLIC_CA_END');
} catch (error) {
  const value = error && typeof error === 'object' ? error : {};
  console.error(JSON.stringify({
    event: 'staypilot_public_ca_export_failed',
    code: typeof value.code === 'string' ? value.code : 'export_failed',
    message: error instanceof Error ? error.message.slice(0, 180) : 'Unknown error'
  }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
