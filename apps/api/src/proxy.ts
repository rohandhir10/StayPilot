import { isIP } from 'node:net';

/** Parse a comma-separated allowlist of proxy addresses/CIDR ranges. */
export function parseTrustedProxyCidrs(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean))];
}

/**
 * Fastify trusts forwarded headers only when the socket peer matches this
 * allowlist. Reject wildcard ranges because trusting every peer defeats the
 * point of validating forwarded client addresses.
 */
export function isValidTrustedProxyCidr(value: string): boolean {
  if (value !== value.trim()) return false;
  const parts = value.split('/');
  if (parts.length > 2 || !parts[0]) return false;

  const version = isIP(parts[0]);
  if (version === 0) return false;
  if (parts.length === 1) return true;

  const prefixText = parts[1];
  if (!prefixText || !/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  if (prefix === 0) return false;

  return version === 4 ? prefix <= 32 : prefix <= 128;
}
