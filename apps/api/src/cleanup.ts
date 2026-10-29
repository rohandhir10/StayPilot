import { pool, closeDatabase } from './db.js';

try {
  const [rateLimits, webhookEvents] = await Promise.all([
    pool.query('DELETE FROM sp_rate_limit_buckets WHERE expires_at < now()'),
    pool.query(`DELETE FROM sp_webhook_events WHERE (status IN ('processed','ignored') AND received_at < now() - interval '90 days') OR (status='failed' AND received_at < now() - interval '30 days')`)
  ]);
  // Audit-event retention is deliberately not automated until the workspace
  // owner approves a policy and contractual/legal requirements are reviewed.
  console.log(JSON.stringify({ event: 'maintenance_cleanup_completed', rate_limit_buckets_removed: rateLimits.rowCount ?? 0, webhook_events_removed: webhookEvents.rowCount ?? 0 }));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'cleanup_failed';
  console.error(JSON.stringify({ level: 'error', event: 'maintenance_cleanup_failed', code }));
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
