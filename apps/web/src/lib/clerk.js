import Clerk from "@clerk/clerk-js";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
export const clerkConfigured = Boolean(publishableKey);
let clerk = null;
let loadPromise = null;

async function getClerk() {
  if (!clerkConfigured) return null;
  if (!clerk) clerk = new Clerk(publishableKey);
  if (!loadPromise) loadPromise = clerk.load();
  await loadPromise;
  return clerk;
}

export async function waitForAuthReady() {
  const instance = await getClerk();
  if (!instance?.user || !instance.session) return null;
  const user = instance.user;
  return {
    id: user.id,
    email: user.primaryEmailAddress?.emailAddress ?? "",
    getIdToken: () => instance.session.getToken(),
  };
}

export async function signOut() {
  const instance = await getClerk();
  if (instance) await instance.signOut();
}
