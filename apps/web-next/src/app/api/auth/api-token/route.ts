import { auth } from '@/auth';
import { SignJWT } from 'jose';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const secret = process.env.API_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    return NextResponse.json({ error: 'Authentication service is not configured.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: session.user.email.toLowerCase(), name: session.user.name ?? session.user.email, email_verified: true, auth_provider: session.user.authProvider ?? 'unknown' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(session.user.id)
    .setIssuer(process.env.AUTH_TOKEN_ISSUER ?? 'https://staypilot.app')
    .setAudience('staypilot-api')
    .setIssuedAt(now).setNotBefore(now - 5).setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(secret));
  return NextResponse.json({ token, expires_in: 300 }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
}
