import { describe, expect, it } from 'vitest';
import { decryptOAuthSecret, encryptOAuthSecret } from '../src/oauth-crypto.js';

describe('mail OAuth token encryption', () => {
  it('round-trips encrypted secrets with versioned authenticated envelopes', () => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const secret = 'test-refresh-token-do-not-use-in-production';
    const encrypted = encryptOAuthSecret(secret);
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain(secret);
    expect(decryptOAuthSecret(encrypted)).toBe(secret);
  });

  it('rejects modified ciphertext rather than returning corrupt token data', () => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    const encrypted = encryptOAuthSecret('secret-value');
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered-value').toString('base64url');
    expect(() => decryptOAuthSecret(parts.join('.'))).toThrow();
  });
});
