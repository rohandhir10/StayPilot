import Clerk from "@clerk/clerk-js";

const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const button = document.querySelector("#google-sign-in");
const error = document.querySelector("#auth-error");

function showError(message) {
  if (error) error.textContent = message;
}

if (!key) {
  button?.addEventListener("click", () => {
    showError("Sign-in is not configured yet. Add VITE_CLERK_PUBLISHABLE_KEY in Vercel project settings.");
  });
} else {
  const clerk = new Clerk(key);
  try {
    await clerk.load();
    if (clerk.user) {
      const next = new URLSearchParams(location.search).get("next");
      location.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    }
    button?.addEventListener("click", async () => {
      button.disabled = true;
      showError("");
      try {
        await clerk.openSignIn({
          afterSignInUrl: new URLSearchParams(location.search).get("next") || "/",
          afterSignUpUrl: new URLSearchParams(location.search).get("next") || "/",
        });
      } catch (e) {
        showError(e?.message || "Unable to open sign-in. Please try again.");
      } finally {
        button.disabled = false;
      }
    });
  } catch {
    showError("Sign-in could not initialize. Check the Clerk publishable key and allowed domains.");
  }
}
