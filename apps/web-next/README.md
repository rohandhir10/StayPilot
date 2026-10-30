# StayPilot Next.js authentication application

This is the new Next.js/Auth.js application shell, introduced alongside the current Vite dashboard so the production dashboard is not replaced by an incomplete migration.

Google sign-in requires AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET. Auth.js requires AUTH_SECRET. The API token endpoint requires an independent API_AUTH_SECRET of at least 32 characters, shared only with the Fastify API, and AUTH_TOKEN_ISSUER set to the exact deployment issuer.

The restricted test Credentials provider is disabled unless TEST_LOGIN_ENABLED=true. It requires TEST_LOGIN_EMAIL and TEST_LOGIN_PASSWORD_HASH (bcrypt). Never commit the plaintext password or hash. Generate a hash locally with bcryptjs and a long random password.

The API token endpoint issues a 5-minute audience-restricted token with no-store headers. The existing Fastify API remains Clerk-backed until its coordinated identity migration and regression tests are complete. Do not route production traffic to this shell yet.
