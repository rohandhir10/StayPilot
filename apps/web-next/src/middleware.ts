export { auth as middleware } from './auth';

export const config = {
  // Keep the authenticated workspace route protected. The legacy route is
  // intentionally public because it runs in isolated, read-only demo mode.
  matcher: ['/dashboard/:path*'],
};
