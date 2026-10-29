import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { constantTimeStringEqual, randomPartnerSecret, sha256, verifyMetaSignature } from '../src/crypto.js';

describe('credential and webhook primitives', () => {
  it('generates high-entropy partner credentials with the expected prefix', () => {
    const first = randomPartnerSecret();
    const second = randomPartnerSecret();
    expect(first).toMatch(/^sp_live_[a-f0-9]{64}$/);
    expect(second).toMatch(/^sp_live_[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
  });

  it('stores a one-way SHA-256 digest, not the raw partner secret', () => {
    const secret = randomPartnerSecret();
    expect(sha256(secret)).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(secret)).not.toBe(secret);
  });

  it('compares webhook verification tokens safely and rejects missing values', () => {
    expect(constantTimeStringEqual('verify-token-1234567890123456', 'verify-token-1234567890123456')).toBe(true);
    expect(constantTimeStringEqual('verify-token-1234567890123456', 'verify-token-1234567890123457')).toBe(false);
    expect(constantTimeStringEqual(undefined, 'verify-token-1234567890123456')).toBe(false);
  });

  it('accepts the exact signed raw body', () => {
    const body = Buffer.from('{"object":"page","entry":[]}');
    const signature = `sha256=${createHmac('sha256', 'test-only-secret').update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, signature, 'test-only-secret')).toBe(true);
  });

  it('rejects a tampered body and malformed signature', () => {
    const body = Buffer.from('{"object":"page","entry":[]}');
    const signature = `sha256=${createHmac('sha256', 'test-only-secret').update(body).digest('hex')}`;
    expect(verifyMetaSignature(Buffer.from('{"object":"page","entry":[1]}'), signature, 'test-only-secret')).toBe(false);
    expect(verifyMetaSignature(body, 'not-a-signature', 'test-only-secret')).toBe(false);
    expect(verifyMetaSignature(body, signature, '')).toBe(false);
  });
});
