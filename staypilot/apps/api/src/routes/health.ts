import type { FastifyInstance } from 'fastify';
import { checkDatabase, checkSchemaReady } from '../db.js';
import { noStore } from '../http.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_request, reply) => {
    noStore(reply);
    return reply.send({ ok: true, service: 'staypilot-api', version: process.env.npm_package_version || '0.1.0' });
  });

  app.get('/api/health/ready', async (_request, reply) => {
    noStore(reply);
    try {
      await checkDatabase();
      await checkSchemaReady();
      return reply.send({ ok: true, dependencies: { database: 'available', schema: 'ready' } });
    } catch {
      return reply.code(503).send({ ok: false, error: 'Service temporarily unavailable.', code: 'dependency_unavailable' });
    }
  });
}
