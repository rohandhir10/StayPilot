import { GoogleAuthProvider, getRedirectResult, signInWithPopup, signInWithRedirect } from 'firebase/auth';
import { firebaseAuth, firebaseConfigured } from './lib/firebase.js';

const PREVIEW_MODE = import.meta.env.VITE_PREVIEW_MODE === 'true' || (import.meta.env.DEV && !firebaseConfigured);
const errorBox = document.getElementById('auth-error');
const signInButton = document.getElementById('google-sign-in');

function safeNext() {
  const candidate = new URLSearchParams(location.search).get('next') || '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/';
  return candidate;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = 'block';
}

if (PREVIEW_MODE) {
  signInButton.hidden = true;
  showError('You are viewing a read-only design preview. Sign-in and data changes are disabled in this deployment.');
} else if (!firebaseConfigured || !firebaseAuth) {
  signInButton.disabled = true;
  showError('Google sign-in is not configured yet. Add the Firebase web app settings to this Vercel environment and rebuild.');
} else {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    const result = await getRedirectResult(firebaseAuth);
    if (result?.user || firebaseAuth.currentUser) {
      location.replace(safeNext());
    }
  } catch (error) {
    showError(error?.code === 'auth/unauthorized-domain'
      ? 'This domain is not authorized in Firebase Authentication. Add it under Authentication → Settings → Authorized domains.'
      : 'Google sign-in could not be completed. Check your Firebase provider settings and try again.');
  }

  signInButton.addEventListener('click', async () => {
    signInButton.disabled = true;
    signInButton.textContent = 'Connecting to Google…';
    errorBox.style.display = 'none';
    try {
      await signInWithPopup(firebaseAuth, provider);
      location.replace(safeNext());
    } catch (error) {
      if (error?.code === 'auth/popup-blocked') {
        try {
          await signInWithRedirect(firebaseAuth, provider);
          return;
        } catch {
          showError('The Google sign-in popup was blocked. Allow popups for this site and try again.');
        }
      } else if (error?.code === 'auth/operation-not-allowed') {
        showError('Google sign-in is disabled for this Firebase project. Enable the Google provider in Firebase Authentication.');
      } else if (error?.code === 'auth/unauthorized-domain') {
        showError('This domain is not authorized in Firebase Authentication. Add it under Authentication → Settings → Authorized domains.');
      } else {
        showError('Google sign-in failed or was cancelled. Please try again.');
      }
      signInButton.disabled = false;
      signInButton.textContent = 'Continue with Google';
    }
  });
}
