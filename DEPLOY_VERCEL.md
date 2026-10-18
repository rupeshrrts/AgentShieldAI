# Deploying with Vercel (frontends) + a container host (backend)

> New to this? Follow [DEPLOY_STEPS.md](./DEPLOY_STEPS.md): click-by-click, with Render for the backend
> (`render.yaml` Blueprint, extension package shipped from `backend/release/package`) and free `vercel.app` /
> `onrender.com` addresses, no domain needed.

AgentShield has three static frontends that suit Vercel and one backend that does **not**:

| Folder | What | Where to host |
| :--- | :--- | :--- |
| `dashboard/` | Customer portal | Vercel project 1 |
| `admin-console/` | Internal staff console | Vercel project 2 |
| `website/` | Public website | Vercel project 3 |
| `backend/` | FastAPI API | Render, Railway, Fly.io or a VM, using `backend/Dockerfile` |
| `extension/` | Browser extension | Chrome Web Store / Edge Add-ons (and the portal's download) |

**Why not the backend on Vercel:** Vercel runs Python as short-lived functions. The backend expects one long-running
process: the reminder loop runs in the background, the device sign-in challenge (anti-replay) cache, rate limits and
lockout counters are kept in process memory, and it serves the extension package files from disk.

Example addresses used below (replace with yours):
`https://agentshield.example` (website), `https://app.agentshield.example` (portal),
`https://console.agentshield.example` (console), `https://api.agentshield.example` (backend).

## 0. Before anything

1. Put the project in a **git repository on GitHub**. `.gitignore` already excludes `.env`, `keys/` (the extension
   signing key), `*.db`, `*.pem`, `node_modules/`, build output and `dist-installer/package/`. Check with
   `git status` before the first commit that none of these appear.
2. Never upload `keys/agentshield-extension.pem`; keep a private backup of it (the extension ID depends on it).

## 1. Backend (container host)

1. Create a web service from the repository with root `backend/` and its `Dockerfile` (port 8000).
2. Environment variables (full list and meaning: `.env.production.example` and DEPLOYMENT.md §2). At least:
   - `ENVIRONMENT=production`, `SECRET_KEY` (long random value, never changes), `DATABASE_URL` (Supabase, pooled)
   - `ALLOWED_ORIGINS=https://app.agentshield.example,https://console.agentshield.example`
   - `DASHBOARD_URL=https://app.agentshield.example`, `ADMIN_CONSOLE_URL=https://console.agentshield.example`
   - `PUBLIC_BASE_URL=https://api.agentshield.example` (activation codes and download links use it)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (sign-up confirmation emails)
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (payments; leave empty to keep them off)
3. **Database:** in the Supabase SQL editor, run the files in `backend/migrations/` that your database does not have
   yet, in this order: `2026_10_production_hardening`, `2026_10_enterprise_features`, `2026_10_accounts_activation`,
   `2026_10_saas_phase1`, `2026_10_saas_phase2`, `2026_10_internal_console`, `2026_10_individual_launch`,
   `2026_10_web_categories`, `2026_10_free_tier`, `2026_10_windows_app`, `2026_10_free_claim` (details per file:
   DEPLOYMENT.md §7 and the comment at the top of each file).
4. **Extension downloads:** `dist-installer/package/` is not in git. Build it (`node scripts/packaging/pack-extension.js`,
   needs the signing key) and make it available to the container (a volume, or copy it into the image in a private
   build) and set `EXTENSION_PACKAGE_DIR` to that folder; otherwise the portal's download button is hidden.
5. First staff login: `python -m app.cli create-platform-owner --email you@yourcompany.com` inside the container
   (prints a temporary password once).
6. Check `https://api.agentshield.example/health` answers.

## 2. Vercel projects

Create three projects from the same repository (**Add New → Project → Import**). Each folder has a `vercel.json`
(Vite build, `dist` output, single-page fallback, security headers), so only the root directory and environment
variables need setting:

| Project | Root Directory | Environment variables (Production) |
| :--- | :--- | :--- |
| Portal | `dashboard` | `VITE_API_BASE_URL=https://api.agentshield.example`, `VITE_WEBSITE_URL=https://agentshield.example`, optional `VITE_ADMIN_CONSOLE_URL=https://console.agentshield.example` (shows an Admin login link) |
| Console | `admin-console` | `VITE_API_BASE_URL=https://api.agentshield.example` |
| Website | `website` | `VITE_PORTAL_URL=https://app.agentshield.example`, optional `VITE_ADMIN_CONSOLE_URL=https://console.agentshield.example` (Admin console in the Log in menu) |

The builds **stop with an error on Vercel** if the required variable is missing, so a portal can never be published
pointing at the wrong server. `VITE_*` values are built into the pages: change them, then redeploy.

Then add your domains (**Settings → Domains**) and update `ALLOWED_ORIGINS`, `DASHBOARD_URL` and
`ADMIN_CONSOLE_URL` on the backend if they changed. The console should stay on its own domain; it sends
`X-Robots-Tag: noindex`.

## 3. Extension

The extension talks to `http://localhost:8000` unless told otherwise (`extension/src/shared/config.ts`). Before
publishing or sharing it, it must use `https://api.agentshield.example` (release build or IT policy via
`managed_schema.json`), then repackage with `node scripts/packaging/pack-extension.js` and upload
`dist-installer/package/agentshield-store.zip` to the Chrome Web Store / Edge Add-ons. Once listed, set
`CHROME_STORE_EXTENSION_ID` / `EDGE_STORE_EXTENSION_ID` on the backend: the portal then shows "Add to Chrome".

## 4. After the first deploy

Sign up on the portal with a real mailbox, confirm the email, start the trial, install the extension, connect it with a
code and check: a test API key is blocked on ChatGPT, a piracy site shows the block page, and the console Overview
shows the new account.
