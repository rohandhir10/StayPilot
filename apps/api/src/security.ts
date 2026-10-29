import { pool } from './db.js';
import { sha256 } from './crypto.js';

export { sha256, randomPartnerSecret, verifyMetaSignature, constantTimeStringEqual } from './crypto.js';

export async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const bucketKey = sha256(`${key}:${bucket}`);
  const expiresAt = new Date((bucket + 2) * windowSeconds * 1000);
  const result = await pool.query<{ hits: number }>(
    `INSERT INTO sp_rate_limit_buckets (bucket_key, hits, expires_at) VALUES ($1, 1, $2)
     ON CONFLICT (bucket_key) DO UPDATE SET
       hits = CASE WHEN sp_rate_limit_buckets.expires_at <= now() THEN 1 ELSE sp_rate_limit_buckets.hits + 1 END,
       expires_at = CASE WHEN sp_rate_limit_buckets.expires_at <= now() THEN EXCLUDED.expires_at ELSE sp_rate_limit_buckets.expires_at END
     RETURNING hits`, [bucketKey, expiresAt]
  );
  return Number(result.rows[0]?.hits || 0) <= limit;
}
