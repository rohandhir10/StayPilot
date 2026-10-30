import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const credentialsSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) });
const testLoginEnabled = process.env.TEST_LOGIN_ENABLED === 'true';

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: process.env.NODE_ENV !== 'production',
  session: { strategy: 'jwt', maxAge: 60 * 60 * 8, updateAge: 60 * 15 },
  pages: { signIn: '/login' },
  providers: [
    Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET, checks: ['pkce', 'state'] }),
    Credentials({
      id: 'test-credentials',
      name: 'StayPilot test account',
      credentials: { email: { label: 'Email', type: 'email' }, password: { label: 'Password', type: 'password' } },
      async authorize(raw) {
        if (!testLoginEnabled) return null;
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const expectedEmail = process.env.TEST_LOGIN_EMAIL?.trim().toLowerCase();
        const passwordHash = process.env.TEST_LOGIN_PASSWORD_HASH;
        if (!expectedEmail || !passwordHash || parsed.data.email.trim().toLowerCase() !== expectedEmail) return null;
        if (!(await bcrypt.compare(parsed.data.password, passwordHash))) return null;
        return { id: 'test:' + expectedEmail, email: expectedEmail, name: 'StayPilot Test User' };
      },
    }),
  ],
  callbacks: {
    async signIn({ account, profile, user }) {
      if (account?.provider === 'google') {
        const p = profile as { email_verified?: boolean; email?: string } | undefined;
        return p?.email_verified === true && Boolean(p.email);
      }
      return account?.provider === 'test-credentials' && testLoginEnabled && Boolean(user.email);
    },
    async jwt({ token, user, account }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
        token.name = user.name;
        token.provider = account?.provider ?? 'unknown';
        token.emailVerified = account?.provider === 'test-credentials';
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.sub ?? '');
        session.user.email = String(token.email ?? '');
        session.user.name = String(token.name ?? '');
      }
      return session;
    },
  },
});
