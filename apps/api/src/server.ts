import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rawBody from 'fastify-raw-body';
import rateLimit from '@fastify/rate-limit';
import { clerkPlugin } from '@clerk/fastify';
import { env } from './config.js';
import { closeDatabase, checkDatabase, checkSchemaReady } from './db.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerLeadRoutes } from './routes/leads.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerEmailOAuthRoutes } from './routes/email-oauth.js';
import { registerPartnerRoutes } from './routes/partner.js';
import { registerPublicInquiryRoutes } from './routes/public-inquiry.js';
import { registerImportRoutes } from './routes/import.js';
import { registerMetaWebhookRoutes } from './routes/webhooks-meta.js';

const app = Fastify({
  logger: {
    level: env.logLevel,
    redact: {
      paths: ['req.url', 'req.query', 'req.headers.authorization', 'req.headers.cookie', 'req.headers.x-api-key', 'req.headers.x-hub-signature-256'],
      censor: '[REDACTED]'
    }
  },
  trustProxy: env.trustProxyHops,
  bodyLimit: env.webhookBodyLimitBytes,
  requestIdHeader: false,
  genReqId: () => randomUUID()
});

await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
});
await app.register(cors, {
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Hub-Signature-256'],
  exposedHeaders: ['Retry-After', 'X-Request-Id'],
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, env.webOrigins.includes(origin));
  }
});
await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({ error: 'Too many requests. Retry shortly.', code: 'rate_limit_exceeded' })
});
await app.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: false,
  runFirst: true,
  routes: ['/api/webhooks/meta']
});
await app.register(clerkPlugin);

app.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Request-Id', request.id);
  if (request.url.startsWith('/api/')) {
    reply.header('Cache-Control', 'no-store, private');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  }
  return payload;
});

app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Endpoint not found.', code: 'not_found' }));
app.setErrorHandler((error, request, reply) => {
  const status = Number.isInteger(error.statusCode) && error.statusCode! >= 400 && error.statusCode! < 600 ? error.statusCode! : 500;
  if (status >= 500) {
    request.log.error({ requestId: request.id, errorCode: (error as NodeJS.ErrnoException).code || 'internal_error' }, 'request failed');
    return reply.code(500).send({ error: 'An unexpected error occurred.', code: 'internal_error', request_id: request.id });
  }
  const code = status === 413 ? 'request_too_large' : status === 415 ? 'unsupported_media_type' : 'invalid_request';
  return reply.code(status).send({ error: status === 413 ? 'Request body is too large.' : status === 415 ? 'Send JSON with Content-Type application/json.' : 'Request could not be processed.', code });
});

await registerHealthRoutes(app);
await registerWorkspaceRoutes(app);
await registerLeadRoutes(app);
await registerInboxRoutes(app);
await registerChannelRoutes(app);
await registerIntegrationRoutes(app);
await registerEmailOAuthRoutes(app);
await registerPartnerRoutes(app);
await registerPublicInquiryRoutes(app);
await registerImportRoutes(app);
await registerMetaWebhookRoutes(app);

try {
  await checkDatabase();
  await checkSchemaReady();
  await app.listen({ port: env.port, host: env.host });
  app.log.info({ event: 'server_started', port: env.port, environment: env.nodeEnv }, 'StayPilot API ready');
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'startup_failed';
  app.log.error({ event: 'server_start_failed', code }, 'StayPilot API failed to start');
  await closeDatabase().catch(() => undefined);
  process.exit(1);
}

async function shutdown(signal: string) {
  app.log.info({ event: 'shutdown_started', signal }, 'Graceful shutdown');
  try {
    await app.close();
    await closeDatabase();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
