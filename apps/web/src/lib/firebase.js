import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const firebaseConfigured = Boolean(
  config.apiKey && config.authDomain && config.projectId && config.appId
);

export const firebaseAuth = firebaseConfigured
  ? getAuth(getApps().length ? getApp() : initializeApp(config))
  : null;

export function waitForAuthReady() {
  if (!firebaseAuth) return Promise.resolve(null);
  if (firebaseAuth.currentUser) return Promise.resolve(firebaseAuth.currentUser);
  return new Promise(resolve => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = user => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(user);
    };
    unsubscribe = onAuthStateChanged(firebaseAuth, finish, () => finish(null));
  });
}
