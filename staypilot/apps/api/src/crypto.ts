import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomPartnerSecret(): string {
  return `sp_live_${randomBytes(32).toString('hex')}`;
}

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !/^sha256=[a-f0-9]{64}$/i.test(header) || !appSecret) return false;
  const presented = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function constantTimeStringEqual(left: string | undefined, right: string | undefined): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
