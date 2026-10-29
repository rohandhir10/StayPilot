import type { FastifyReply, FastifyRequest } from 'fastify';
import { isIP } from 'node:net';

export function fail(reply: FastifyReply, statusCode: number, message: string, code: string) {
  return reply.code(statusCode).send({ error: message, code });
}

export function noStore(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store, private');
  reply.header('Pragma', 'no-cache');
}

export function safeText(value: unknown, maxLength: number, fallback = ''): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).replace(/\u0000/g, '').trim();
  if (result.length > maxLength) return null;
  return result;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Railway's public HTTP edge overwrites X-Real-IP with the client's IP.
 * Use it only to build rate-limit buckets; keep Fastify trustProxy disabled
 * so request.ip, host, and protocol do not depend on forwarding headers.
 * Private-network requests bypass the public edge and must be trusted workloads.
 */
export function clientIpForRateLimiting(request: FastifyRequest): string {
  const candidate = request.headers['x-real-ip'];
  if (typeof candidate === 'string' && isIP(candidate) !== 0) return candidate;
  return request.ip || 'unknown';
}

export function clientErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 64);
  }
  return 'unexpected_error';
}
