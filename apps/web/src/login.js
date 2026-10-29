import { Clerk } from '@clerk/clerk-js';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const errorBox = document.getElementById('auth-error');
const signInMount = document.getElementById('clerk-sign-in');

function safeNext() {
  const candidate = new URLSearchParams(location.search).get('next') || '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\\\')) return '/';
  return candidate;
}

if (!publishableKey) {
  errorBox.textContent = 'Sign-in is not configured yet. Add VITE_CLERK_PUBLISHABLE_KEY to your local environment or Vercel settings.';
  errorBox.style.display = 'block';
  signInMount.textContent = 'Authentication configuration missing.';
} else {
  try {
    const clerk = new Clerk(publishableKey);
    await clerk.load({
      signInUrl: '/login',
      signInFallbackRedirectUrl: safeNext(),
      signUpFallbackRedirectUrl: safeNext(),
      afterSignOutUrl: '/login'
    });
    if (clerk.isSignedIn) {
      location.replace(safeNext());
    } else {
      clerk.mountSignIn(signInMount, { routing: 'hash' });
    }
  } catch {
    errorBox.textContent = 'Could not initialize secure sign-in. Verify the Clerk publishable key, allowed domains, and network access.';
    errorBox.style.display = 'block';
  }
}