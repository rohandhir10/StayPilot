import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { verifyApiToken } from '../src/auth-token.js';

const secret = 'test-only-secret-with-at-least-thirty-two-characters';
const issuer = 'https://staypilot.test';

async function issue(overrides: Record<string, unknown> = {}, options: { issuer?: string; audience?: string; expired?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({
    email: 'operator@example.test', name: 'Test Operator', email_verified: true,
    auth_provider: 'google', ...overrides
  }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject('google-subject-123')
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? 'staypilot-api')
    .setIssuedAt(now).setNotBefore(now - 1)
    .setExpirationTime(options.expired ? now - 10 : now + 300);
  return jwt.sign(new TextEncoder().encode(secret));
}

describe('Auth.js API token verification', () => {
  it('accepts a valid verified Google identity token', async () => {
    const token = await issue();
    await expect(verifyApiToken(token, secret, issuer)).resolves.toMatchObject({
      id: 'google-subject-123', email: 'operator@example.test', provider: 'google'
    });
  });
  it('accepts a valid test credential identity for API-side workspace isolation', async () => {
    const token = await issue({ auth_provider: 'test-credentials' });
    await expect(verifyApiToken(token, secret, issuer)).resolves.toMatchObject({ provider: 'test-credentials' });
  });
  it('rejects an invalid signature', async () => {
    const token = await issue();
    await expect(verifyApiToken(token, 'different-secret-that-is-long-enough-123', issuer)).resolves.toBeNull();
  });
  it('rejects expired, wrong-issuer and wrong-audience tokens', async () => {
    await expect(verifyApiToken(await issue({}, { expired: true }), secret, issuer)).resolves.toBeNull();
    await expect(verifyApiToken(await issue({}, { issuer: 'https://attacker.test' }), secret, issuer)).resolves.toBeNull();
    await expect(verifyApiToken(await issue({}, { audience: 'other-api' }), secret, issuer)).resolves.toBeNull();
  });
  it('rejects unverified email and unknown authentication providers', async () => {
    await expect(verifyApiToken(await issue({ email_verified: false }), secret, issuer)).resolves.toBeNull();
    await expect(verifyApiToken(await issue({ auth_provider: 'unknown' }), secret, issuer)).resolves.toBeNull();
  });
});
