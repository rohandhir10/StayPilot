# StayPilot GitHub repository and source workflow

Repository: <https://github.com/rohandhir10/StayPilot> (private). The repository is the source of truth for this starter.

## Verify the published source

After publishing, confirm the default branch is `main` and that it contains `apps/api/`, `docs/`, `.github/workflows/api-ci.yml`, `.gitignore`, and this README. Do not commit `.env` files with real secrets. The `.env.example` values are placeholders.

## Deployment wiring

- Connect `apps/api` as the Railway service root and attach a private Railway PostgreSQL service.
- Connect the existing StayPilot frontend source to Vercel only after locating the correct frontend repository/project and setting its API base URL.
- Store real provider credentials as Railway/Vercel encrypted environment variables; never place them in source control.
- A successful source upload publishes code only. It does not configure provider accounts, run a production migration, or deploy services automatically unless CI/CD is explicitly configured.

See [Railway setup](railway.md), [Vercel frontend setup](vercel-frontend.md), [secrets and providers](secrets-and-providers.md), and [the launch checklist](launch-checklist.md).
