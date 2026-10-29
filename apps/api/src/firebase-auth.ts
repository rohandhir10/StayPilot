import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { env } from './config.js';

export class FirebaseAuthNotConfiguredError extends Error {
  constructor() {
    super('firebase_auth_not_configured');
    this.name = 'FirebaseAuthNotConfiguredError';
  }
}

type ServiceAccountJson = {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
};

let authClient: ReturnType<typeof getAuth> | null = null;

function getFirebaseAuthClient(): ReturnType<typeof getAuth> {
  if (authClient) return authClient;
  if (!env.firebaseProjectId || !env.firebaseServiceAccountJson) {
    throw new FirebaseAuthNotConfiguredError();
  }

  let account: ServiceAccountJson;
  try {
    account = JSON.parse(env.firebaseServiceAccountJson) as ServiceAccountJson;
  } catch {
    throw new FirebaseAuthNotConfiguredError();
  }
  if (
    account.project_id !== env.firebaseProjectId ||
    typeof account.client_email !== 'string' || !account.client_email ||
    typeof account.private_key !== 'string' || !account.private_key
  ) {
    throw new FirebaseAuthNotConfiguredError();
  }

  const appName = 'staypilot-firebase-auth';
  const app = getApps().find(candidate => candidate.name === appName) ?? initializeApp({
    projectId: env.firebaseProjectId,
    credential: cert({
      projectId: env.firebaseProjectId,
      clientEmail: account.client_email,
      privateKey: account.private_key.replace(/\\n/g, '\n')
    })
  }, appName);
  authClient = getAuth(app);
  return authClient;
}

export type VerifiedFirebaseIdentity = {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

export async function verifyFirebaseToken(idToken: string): Promise<VerifiedFirebaseIdentity> {
  const decoded: DecodedIdToken = await getFirebaseAuthClient().verifyIdToken(idToken, true);
  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email : null,
    emailVerified: decoded.email_verified === true,
    name: typeof decoded.name === 'string' ? decoded.name : null
  };
}
