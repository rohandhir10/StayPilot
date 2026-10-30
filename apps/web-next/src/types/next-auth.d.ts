import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      authProvider: string;
    } & DefaultSession['user'];
  }
}
declare module 'next-auth/jwt' {
  interface JWT {
    provider?: string;
    emailVerified?: boolean;
  }
}
