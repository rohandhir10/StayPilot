import { z } from 'zod';
import { isValidTrustedProxyCidr, parseTrustedProxyCidrs } from './proxy.js';

const booleanValue = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

const integerFromEnv = (fallback: number, min: number, max: number) =>
  z.preprocess((value) => value === undefined || value === '' ? fallback : Number(value),
    z.number().int().min(min).max(max));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integerFromEnv(3000, 1, 65535),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: integerFromEnv(10, 1, 50),
  DATABASE_SSL: booleanValue.default(false),
  DATABASE_SSL_REJECT_UNAUTHORIZED: booleanValue.default(true),
  API_AUTH_SECRET: z.string().min(32),
  AUTH_TOKEN_ISSUER: z.string().url(),
  OWNER_EMAIL: z.string().email().transform(value => value.trim().toLowerCase()),
  WEB_ORIGINS: z.string().min(1),
  META_APP_SECRET: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  META_WEBHOOK_VERIFY_TOKEN: z.preprocess(value => value === '' ? undefined : value, z.string().min(24).optional()),
  API_PUBLIC_ORIGIN: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  GOOGLE_OAUTH_CLIENT_ID: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  GOOGLE_OAUTH_CLIENT_SECRET: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  MICROSOFT_OAUTH_CLIENT_ID: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  OAUTH_TOKEN_ENCRYPTION_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  TURNSTILE_SECRET_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  TURNSTILE_SITE_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  RATE_LIMIT_PUBLIC_PER_HOUR: integerFromEnv(5, 1, 100),
  RATE_LIMIT_PARTNER_PER_MINUTE: integerFromEnv(120, 1, 10000),
  WEBHOOK_BODY_LIMIT_BYTES: integerFromEnv(1_048_576, 1024, 10_485_760),
  TRUSTED_PROXY_CIDRS: z.preprocess(value => typeof value === 'string' ? parseTrustedProxyCidrs(value) : value, z.array(z.string().min(1)).default([])),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  // Report missing variable names and validation messages only, never values.
  throw new Error(`Invalid StayPilot API configuration: ${issues}`);
}

if (parsed.data.OAUTH_TOKEN_ENCRYPTION_KEY && Buffer.from(parsed.data.OAUTH_TOKEN_ENCRYPTION_KEY, 'base64').length !== 32) {
  throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
}
if (parsed.data.API_PUBLIC_ORIGIN) {
  try {
    const publicOrigin = new URL(parsed.data.API_PUBLIC_ORIGIN);
    if (publicOrigin.origin !== parsed.data.API_PUBLIC_ORIGIN.replace(/\\/$/, '') || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash || (parsed.data.NODE_ENV === 'production' && publicOrigin.protocol !== 'https:')) {
      throw new Error();
    }
  } catch {
    throw new Error('API_PUBLIC_ORIGIN must be an exact API origin (HTTPS in production), without a path.');
  }
}

if (parsed.data.TRUSTED_PROXY_CIDRS.some(value => !isValidTrustedProxyCidr(value))) {
  throw new Error('TRUSTED_PROXY_CIDRS must contain only explicit IPv4/IPv6 addresses or CIDR ranges; wildcard ranges such as /0 are not allowed.');
}

if (parsed.data.NODE_ENV === 'production') {
  const origins = parsed.data.WEB_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  const invalidOrigin = origins.some(origin => {
    try { const parsedOrigin = new URL(origin); return origin === '*' || parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin; }
    catch { return true; }
  });
  if (origins.length === 0 || invalidOrigin) {
    throw new Error('Production WEB_ORIGINS must contain exact HTTPS origins only (scheme + host + optional port; no paths or wildcard).');
  }
  if (!parsed.data.DATABASE_SSL) {
    throw new Error('DATABASE_SSL=true is required in production; use a database TLS connection with certificate verification enabled.');
  }
  if (parsed.data.TRUSTED_PROXY_CIDRS.length === 0) {
    throw new Error('TRUSTED_PROXY_CIDRS must list the verified ingress proxy IP addresses/CIDR ranges in production; do not trust forwarded headers from every peer.');
  }
  if (parsed.data.DATABASE_SSL && !parsed.data.DATABASE_SSL_REJECT_UNAUTHORIZED) {
    throw new Error('Production database TLS certificate verification must remain enabled.');
  }
}

export const env = Object.freeze({
  nodeEnv: parsed.data.NODE_ENV,
  isProduction: parsed.data.NODE_ENV === 'production',
  port: parsed.data.PORT,
  host: parsed.data.HOST,
  databaseUrl: parsed.data.DATABASE_URL,
  databasePoolMax: parsed.data.DATABASE_POOL_MAX,
  databaseSsl: parsed.data.DATABASE_SSL ? { rejectUnauthorized: parsed.data.DATABASE_SSL_REJECT_UNAUTHORIZED } : false,
  apiAuthSecret: parsed.data.API_AUTH_SECRET,
  authTokenIssuer: parsed.data.AUTH_TOKEN_ISSUER,
  ownerEmail: parsed.data.OWNER_EMAIL,
  webOrigins: parsed.data.WEB_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
  metaAppSecret: parsed.data.META_APP_SECRET,
  metaWebhookVerifyToken: parsed.data.META_WEBHOOK_VERIFY_TOKEN,
  apiPublicOrigin: parsed.data.API_PUBLIC_ORIGIN?.replace(/\\/$/, ''),
  googleOAuthClientId: parsed.data.GOOGLE_OAUTH_CLIENT_ID,
  googleOAuthClientSecret: parsed.data.GOOGLE_OAUTH_CLIENT_SECRET,
  microsoftOAuthClientId: parsed.data.MICROSOFT_OAUTH_CLIENT_ID,
  microsoftOAuthClientSecret: parsed.data.MICROSOFT_OAUTH_CLIENT_SECRET,
  oauthTokenEncryptionKey: parsed.data.OAUTH_TOKEN_ENCRYPTION_KEY,
  turnstileSecretKey: parsed.data.TURNSTILE_SECRET_KEY,
  turnstileSiteKey: parsed.data.TURNSTILE_SITE_KEY,
  publicRateLimitPerHour: parsed.data.RATE_LIMIT_PUBLIC_PER_HOUR,
  partnerRateLimitPerMinute: parsed.data.RATE_LIMIT_PARTNER_PER_MINUTE,
  webhookBodyLimitBytes: parsed.data.WEBHOOK_BODY_LIMIT_BYTES,
  trustedProxyCidrs: parsed.data.TRUSTED_PROXY_CIDRS,
  logLevel: parsed.data.LOG_LEVEL
});
