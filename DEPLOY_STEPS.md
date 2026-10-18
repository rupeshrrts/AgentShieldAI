# Put AgentShieldAI online (no domain needed)

Simple, click-by-click version of [DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md). You get free HTTPS addresses:

| Part | Host | Example address |
| :--- | :--- | :--- |
| Backend (API) | **Render** | `https://agentshield-api.onrender.com` |
| Customer portal | **Vercel** | `https://agentshield-app.vercel.app` |
| Public website | **Vercel** | `https://agentshield-site.vercel.app` |
| Admin console (optional) | **Vercel** | `https://agentshield-console.vercel.app` |
| Database | **Supabase** (you already have it) | — |

Your real addresses may differ (Render or Vercel adds letters if a name is taken). Write each one down as you go
and use **your** addresses wherever the examples appear. Never put a `/` at the end of an address.

What you need: a GitHub account, a Render account and a Vercel account (all free; sign up to Render and Vercel
**with GitHub**), and your Supabase database password.

---

## Step 1 — Put the project on GitHub (private)

1. Install **GitHub Desktop** from https://desktop.github.com and sign in with your GitHub account.
2. **File → Add local repository** → choose this `AgentShieldAI` folder → it says it is not a repository →
   click **create a repository** → **Create repository**.
3. Check the list of files on the left: `.env`, `keys/` and `*.db` files must **not** be there (`.gitignore`
   excludes them). If you ever see them, stop.
4. Type a summary such as `First deploy` → **Commit to main** → **Publish repository** → keep
   **"Keep this code private" ticked** → **Publish**.

Later changes: commit in GitHub Desktop and click **Push origin**; Render and Vercel redeploy by themselves.

## Step 2 — Get the database address from Supabase

Supabase → your project → **Connect** (top) → **Connection string** → choose **Transaction pooler** (or Session
pooler) → copy the `postgresql://...pooler.supabase.com...` address and replace `[YOUR-PASSWORD]` with your
database password. Keep it private: it goes only into Render in step 3.

(The address in your local `.env` is already this kind of address and can be used.)

## Step 3 — Backend on Render

1. Render → **New → Blueprint** → connect GitHub → pick the `AgentShieldAI` repository. Render reads
   `render.yaml` and shows a service **agentshield-api**.
2. It asks for these values:
   - `DATABASE_URL` → the address from step 2
   - `PUBLIC_BASE_URL` → `https://agentshield-api.onrender.com`
   - `DASHBOARD_URL` → `https://agentshield-app.vercel.app`
   - `ADMIN_CONSOLE_URL` → `https://agentshield-console.vercel.app`
   - `ALLOWED_ORIGINS` → `https://agentshield-app.vercel.app,https://agentshield-console.vercel.app`

   (The Vercel addresses do not exist yet: type the names you plan to use; you can correct them in step 5.)
3. **Apply**. The first build takes a few minutes. When it shows **Live**, open
   `https://agentshield-api.onrender.com/health` — it must answer `"status": "healthy"` and `"environment": "production"`.
4. If the real Render address is different from what you typed, open the service → **Environment** → fix
   `PUBLIC_BASE_URL` → **Save** (it restarts).

`SECRET_KEY` is created by Render automatically. Never change it (everyone would be signed out).
The database tables are created automatically on this first start.

## Step 4 — Three projects on Vercel

For each row: Vercel → **Add New → Project** → import the `AgentShieldAI` repository → **Root Directory**:
click **Edit** and pick the folder → open **Environment Variables** and add the values → **Deploy**.
Set the project name so the address matches what you typed in step 3.

| Project name (example) | Root Directory | Environment Variables |
| :--- | :--- | :--- |
| `agentshield-app` | `dashboard` | `VITE_API_BASE_URL` = `https://agentshield-api.onrender.com`<br>`VITE_WEBSITE_URL` = `https://agentshield-site.vercel.app` |
| `agentshield-site` | `website` | `VITE_PORTAL_URL` = `https://agentshield-app.vercel.app` |
| `agentshield-console` (optional) | `admin-console` | `VITE_API_BASE_URL` = `https://agentshield-api.onrender.com` |

Optional on the portal and website: `VITE_ADMIN_CONSOLE_URL` = the console address (shows an "Admin login" link).
If a build stops with "Set VITE_... in the Vercel project settings", the variable was not added: add it and **Redeploy**.
After changing any `VITE_` value you must **Redeploy** (they are built into the pages).

## Step 5 — Connect them

Compare the real Vercel addresses with what you typed in step 3. If any differ: Render → agentshield-api →
**Environment** → correct `DASHBOARD_URL`, `ADMIN_CONSOLE_URL`, `ALLOWED_ORIGINS` → **Save**.
If the portal says it cannot reach the server, `ALLOWED_ORIGINS` is wrong.

## Step 6 — Test

1. Open the website → **Sign up free** → create an account → start the free trial.
2. **Download** → download the extension (.zip) → unzip it.
3. On any laptop, in Chrome or Edge: `chrome://extensions` → **Developer mode** on → **Load unpacked** → the
   unzipped folder.
4. Portal → **Connect browser** → generate a code → AgentShield icon → paste → **Connect and verify**.
5. On ChatGPT, paste a fake key such as `sk-live-1234567890abcdefghijklmnop` → it is blocked.

Each browser needs its own code (one device each; the trial allows 3).

## Step 7 (optional) — Supabase SQL

Not required: the backend did it in step 3. If you want to apply/verify explicitly: Supabase → **SQL Editor →
New query** → paste the whole of `backend/migrations/RUN_ALL_IN_SUPABASE.sql` → **Run**. Safe to run again.
Never run `supabase_schema.sql` or `SUPABASE_SETUP.sql` on this database (they add demo logins).

## Step 8 (optional) — Admin console login

Render's free plan has no shell, so create the first staff login from this PC (it uses the Supabase address in
your local `.env`):
```powershell
cd backend; .venv\Scripts\python.exe -m app.cli create-platform-owner --email you@yourcompany.com
```
It prints a temporary password once; sign in at the console address and set up the authenticator app.
Forgot it later? `.venv\Scripts\python.exe -m app.cli reset-staff-password --email you@yourcompany.com`
(add `--reset-mfa` if the authenticator app is lost too).

---

## Good to know

* **Free Render plan sleeps** after about 15 minutes without traffic and takes about a minute to wake. Meanwhile
  browsers with the extension block AI sites (it never fails open). Fine for testing; for real users change the
  plan to **Starter** (Render → service → Settings → Instance type).
* **Emails** (forgot password, invites) need SMTP: add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`,
  `SMTP_FROM` in Render → Environment. Sign-up works without it.
* **Payments** stay off until you add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` on Render.
* **New extension version:** run `node scripts\packaging\pack-extension.js`, copy `dist-installer\package\*` to
  `backend\release\package\`, commit and push.
* **Windows setup (.exe) and one-click install:** not offered yet. It installs the extension on personal PCs only
  after it is listed on the Chrome Web Store / Edge Add-ons (DEPLOYMENT.md §6). Until then users use the .zip.
* **Your own domain later:** add it in Vercel / Render (Settings → Domains), then update the addresses above.
