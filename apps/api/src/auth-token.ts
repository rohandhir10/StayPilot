import { jwtVerify } from 'jose';

export type VerifiedApiIdentity = { id: string; email: string; name: string; provider: 'google' | 'test-credentials' };

export async function verifyApiToken(token: string, secret: string, issuer: string): Promise<VerifiedApiIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'], issuer, audience: 'staypilot-api', clockTolerance: 5
    });
    if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 200 ||
        typeof payload.email !== 'string' || payload.email_verified !== true ||
        typeof payload.name !== 'string' ||
        (payload.auth_provider !== 'google' && payload.auth_provider !== 'test-credentials')) return null;
    const email = payload.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return null;
    return { id: payload.sub, email, name: payload.name.slice(0, 160) || email, provider: payload.auth_provider };
  } catch {
    return null;
  }
}
