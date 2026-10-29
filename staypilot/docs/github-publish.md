# Publish the prepared Git repository to GitHub

The code is committed locally on branch `main`; it has not been pushed to a remote. The current GitHub connector exposes repository file/branch actions but not repository creation. Create the empty private repository first, then push this commit.

## 1. Create an empty private repository

Open <https://github.com/new> while signed into `rohandhir10`.

- Repository name: `staypilot`
- Visibility: **Private**
- Do **not** initialize with a README, `.gitignore`, or license (this bundle already has its first commit).
- Click **Create repository**.

## 2. Clone the Git bundle and push

Download `staypilot-railway-vercel.bundle` from the conversation. In a terminal, run the commands below, replacing the bundle path if your browser saved it elsewhere:

```bash
git clone ~/Downloads/staypilot-railway-vercel.bundle staypilot
cd staypilot
git remote add origin git@github.com:rohandhir10/staypilot.git
git push -u origin main
```

This requires SSH authentication for GitHub. If SSH isn't configured, use HTTPS instead:

```bash
git remote set-url origin https://github.com/rohandhir10/staypilot.git
git push -u origin main
```

GitHub may ask you to authenticate through your credential manager or browser; do not paste a personal access token into source code or this repository.

## 3. Connect deployments only after the repository exists

- Connect the new GitHub repository to a new/existing Vercel frontend project only after you have located the actual StayPilot frontend source.
- Connect `apps/api` as the Railway service root, with a separate private Railway PostgreSQL service.
- Do not set real provider values in `.env.example` or commit `.env`; use Railway/Vercel encrypted environment variables.

A successful `git push` publishes source only; it does not deploy or configure production services by itself.
