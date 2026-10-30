export const clerkConfigured = true;

export async function waitForAuthReady() {
  const response = await fetch('/api/auth/api-token', { method: 'GET', cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  if (typeof data.token !== 'string') return null;
  return {
    id: 'authjs-session',
    email: '',
    getIdToken: async () => {
      const refreshed = await fetch('/api/auth/api-token', { method: 'GET', cache: 'no-store', credentials: 'same-origin' });
      if (!refreshed.ok) return null;
      const payload = await refreshed.json().catch(() => ({}));
      return typeof payload.token === 'string' ? payload.token : null;
    },
  };
}

export async function signOut() {
  const csrfResponse = await fetch('/api/auth/csrf', { cache: 'no-store', credentials: 'same-origin' });
  if (!csrfResponse.ok) throw new Error('Could not start sign-out.');
  const { csrfToken } = await csrfResponse.json();
  const body = new URLSearchParams({ csrfToken, callbackUrl: '/login' });
  const response = await fetch('/api/auth/signout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Sign-out failed.');
  window.location.replace('/login');
}
