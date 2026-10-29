import { z } from 'zod';

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
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  OWNER_CLERK_USER_ID: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  WEB_ORIGINS: z.string().min(1),
  META_APP_SECRET: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  META_WEBHOOK_VERIFY_TOKEN: z.preprocess(value => value === '' ? undefined : value, z.string().min(24).optional()),
  TURNSTILE_SECRET_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  TURNSTILE_SITE_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  RATE_LIMIT_PUBLIC_PER_HOUR: integerFromEnv(5, 1, 100),
  RATE_LIMIT_PARTNER_PER_MINUTE: integerFromEnv(120, 1, 10000),
  WEBHOOK_BODY_LIMIT_BYTES: integerFromEnv(1_048_576, 1024, 10_485_760),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  // Report missing variable names and validation messages only, never values.
  throw new Error(`Invalid StayPilot API configuration: ${issues}`);
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
  if (!parsed.data.OWNER_CLERK_USER_ID || !parsed.data.OWNER_CLERK_USER_ID.startsWith('user_') || parsed.data.OWNER_CLERK_USER_ID.includes('REPLACE')) {
    throw new Error('OWNER_CLERK_USER_ID must be the real Clerk user ID of the intended workspace owner.');
  }
  if (!parsed.data.CLERK_PUBLISHABLE_KEY.startsWith('pk_live_') || !parsed.data.CLERK_SECRET_KEY.startsWith('sk_live_')) {
    throw new Error('Production requires live Clerk publishable/secret keys. Development test keys are not allowed in NODE_ENV=production.');
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
  clerkPublishableKey: parsed.data.CLERK_PUBLISHABLE_KEY,
  clerkSecretKey: parsed.data.CLERK_SECRET_KEY,
  ownerClerkUserId: parsed.data.OWNER_CLERK_USER_ID,
  webOrigins: parsed.data.WEB_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
  metaAppSecret: parsed.data.META_APP_SECRET,
  metaWebhookVerifyToken: parsed.data.META_WEBHOOK_VERIFY_TOKEN,
  turnstileSecretKey: parsed.data.TURNSTILE_SECRET_KEY,
  turnstileSiteKey: parsed.data.TURNSTILE_SITE_KEY,
  publicRateLimitPerHour: parsed.data.RATE_LIMIT_PUBLIC_PER_HOUR,
  partnerRateLimitPerMinute: parsed.data.RATE_LIMIT_PARTNER_PER_MINUTE,
  webhookBodyLimitBytes: parsed.data.WEBHOOK_BODY_LIMIT_BYTES,
  logLevel: parsed.data.LOG_LEVEL
});
