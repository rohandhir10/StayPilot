import { describe, expect, it } from 'vitest';
import { decryptOAuthSecret, encryptOAuthSecret } from '../src/oauth-crypto.js';

describe('mail OAuth token encryption', () => {
  it('round-trips encrypted secrets with versioned authenticated envelopes', () => {
    const secret = 'test-refresh-token-do-not-use-in-production';
    const key = Buffer.alloc(32, 7).toString('base64');
    const encrypted = encryptOAuthSecret(secret, key);
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain(secret);
    expect(decryptOAuthSecret(encrypted, key)).toBe(secret);
  });

  it('rejects modified ciphertext rather than returning corrupt token data', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    const encrypted = encryptOAuthSecret('secret-value', key);
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered-value').toString('base64url');
    expect(() => decryptOAuthSecret(parts.join('.'), key)).toThrow();
  });
});
