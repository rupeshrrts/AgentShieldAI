# Deploy AgentShieldAI (step by step, no domain needed)

Do one phase at a time. Each phase ends with a ✅ check: only continue when it passes.

**What goes where**

| Folder | Deployed to | Address you get |
| :--- | :--- | :--- |
| `backend/` | Render | `https://agentshield-api.onrender.com` |
| `dashboard/` (customer portal) | Vercel | `https://NAME-app.vercel.app` |
| `website/` (public website) | Vercel | `https://NAME-site.vercel.app` |
| `admin-console/` (staff console) | Vercel | `https://NAME-console.vercel.app` |
| Database | Supabase (already set up) | — |

`NAME` = a name you choose, e.g. `agentshield`. Write down every address you get, and never put a `/` at the
end of an address. One GitHub repository is imported into all of them: each host only builds its own folder.

**Names are often taken.** `agentshield-app.vercel.app`, `agentshield-console.vercel.app` and
`agentshield-api.onrender.com` already belong to other people. If a name is taken, Render / Vercel silently add
letters (e.g. `agentshield-api-midy.onrender.com`, `agentshield-app-murex.vercel.app`). Always read the real
address from the service page (Render) or **Domains** (Vercel) and use that one everywhere; never point
`ALLOWED_ORIGINS` or `DASHBOARD_URL` at the plain name, which may be someone else's site. Using your own prefix
(e.g. `yourname-agentshield-site`) avoids most clashes.

On Vercel's "Multiple applications detected" screen, click **Import single project** in the row of the folder you
want. Never import `backend` on Vercel, and do not use "Import multi-service project".

**You need:** a GitHub account, your Supabase database password, about 30 minutes.

---

## Phase 1 — Put the code on GitHub

1. Create an account at **https://github.com/signup**.
2. Install **GitHub Desktop** from **https://desktop.github.com** and sign in.
3. **File → Add local repository** → choose the `AgentShieldAI` folder → click **create a repository** →
   **Create repository**.
4. Check the file list on the left: `.env`, `keys` and `.db` files must **not** be there. If they are, stop.
5. Type `First deploy` in the summary box → **Commit to main**.
6. **Publish repository** → keep **"Keep this code private"** ticked → **Publish repository**.

✅ Your project is visible on github.com under your account, marked **Private**.

---

## Phase 2 — Backend on Render

1. Go to **https://render.com** → **Get Started** → **Sign up with GitHub**.
2. **New** → **Blueprint** → allow access to GitHub → choose **AgentShieldAI** → **Connect**.
3. Render shows the service `agentshield-api` (from `render.yaml`) and asks for these values:

| Setting | What to type |
| :--- | :--- |
| `DATABASE_URL` | Supabase → **Connect** → **Transaction pooler** → copy the address and put your database password in place of `[YOUR-PASSWORD]` |
| `PUBLIC_BASE_URL` | `https://agentshield-api.onrender.com` |
| `DASHBOARD_URL` | `https://NAME-app.vercel.app` |
| `ADMIN_CONSOLE_URL` | `https://NAME-console.vercel.app` |
| `ALLOWED_ORIGINS` | `https://NAME-app.vercel.app,https://NAME-console.vercel.app` |

   The Vercel addresses do not exist yet: type the names you plan to use (you can correct them in Phase 4).
4. Click **Apply** and wait 5–10 minutes until it shows **Live**.
5. Copy the real address shown at the top. If it differs from what you typed, open **Environment** → fix
   `PUBLIC_BASE_URL` → **Save**.

`SECRET_KEY` is created by Render automatically: never change it (everyone would be signed out).
The database tables are created automatically on this first start.

✅ `https://YOUR-RENDER-ADDRESS/health` shows `"status": "healthy"` and `"environment": "production"`.

---

## Phase 3 — Three projects on Vercel

First: **https://vercel.com/signup** → **Hobby** → **Continue with GitHub**.

Then do these steps **3 times**, once per row of the table below:

1. **Add New** → **Project** → find **AgentShieldAI** → **Import**.
2. **Project Name**: the name from the table.
3. **Root Directory**: **Edit** → choose the folder from the table → **Continue**.
4. Open **Environment Variables** → add each variable from the table (Name + Value) → **Add**.
5. **Deploy** → wait for **Congratulations**.

| # | Project Name | Root Directory | Environment Variables |
| :--- | :--- | :--- | :--- |
| 1 | `NAME-app` | `dashboard` | `VITE_API_BASE_URL` = your Render address<br>`VITE_WEBSITE_URL` = `https://NAME-site.vercel.app` |
| 2 | `NAME-site` | `website` | `VITE_PORTAL_URL` = `https://NAME-app.vercel.app` |
| 3 | `NAME-console` | `admin-console` | `VITE_API_BASE_URL` = your Render address |

Optional on projects 1 and 2: `VITE_ADMIN_CONSOLE_URL` = `https://NAME-console.vercel.app` (shows an
"Admin login" link).

* No `/` at the end of any address.
* Build failed with **"Set VITE_... in the Vercel project settings"**? The variable is missing: add it under
  **Settings → Environment Variables**, then **Deployments → ⋯ → Redeploy**.
* After changing any `VITE_` value you must **Redeploy** (the values are built into the pages).

✅ All three projects show **Ready**, each with its own `.vercel.app` address.

---

## Phase 4 — Connect them

1. Compare the three real Vercel addresses with what you typed into Render in Phase 2.
2. If any differ: Render → `agentshield-api` → **Environment** → correct `DASHBOARD_URL`, `ADMIN_CONSOLE_URL`
   and `ALLOWED_ORIGINS` → **Save** (it restarts by itself).

✅ The website's **Sign up free** opens the portal, and the portal does not say it cannot reach the server
(if it does, `ALLOWED_ORIGINS` is wrong).

---

## Phase 5 — Test

1. Open your website → **Sign up free** → create an account → **Start free trial**.
2. **Download** → download the extension `.zip` → unzip it.
3. Chrome or Edge: `chrome://extensions` → **Developer mode** on → **Load unpacked** → the unzipped folder.
4. Portal → **Connect browser** → **Generate code** → AgentShield icon → paste → **Connect and verify**.
5. On ChatGPT type `sk-live-1234567890abcdefghijklmnop` → it is **blocked**.

Each browser needs its own code (one device each; the trial allows 3).

✅ The block appears, and the portal's **Overview** charts show the event.

---

## Good to know

* **Updating later:** change the code → GitHub Desktop → **Commit to main** → **Push origin**. Render and
  Vercel redeploy by themselves.
* **Free Render plan sleeps** after ~15 minutes without traffic and takes ~1 minute to wake; meanwhile browsers
  with the extension block AI sites (it never fails open), and the first sign-in waits for it (the portal then
  says the server is starting up). Fine for testing; for real users switch to **Starter**
  (Render → service → Settings → Instance type, about $7/month), which never sleeps.
  **Free alternative for testing:** keep it awake with a free uptime monitor, e.g. UptimeRobot or cron-job.org:
  add an HTTP(S) monitor for `https://YOUR-RENDER-ADDRESS/health` every 5 minutes. One always-on free service
  fits Render's 750 free hours a month (do not do this for several free services). The free plan is also slow
  in general (a small share of one CPU), so each sign-in still takes a few seconds; Starter is faster.
* **Supabase SQL is not needed:** the backend creates the tables. Optional check: Supabase → **SQL Editor** →
  paste `backend/migrations/RUN_ALL_IN_SUPABASE.sql` → **Run** (safe to run again). Never run
  `supabase_schema.sql` or `SUPABASE_SETUP.sql` on this database (they add demo logins).
* **Emails** (forgot password, invites): add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
  in Render → Environment. Sign-up works without them.
* **Payments** stay off until you add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` on Render.
* **Admin console login:** Render's free plan has no shell, so create the first staff login from this PC (it
  uses the Supabase address in your local `.env`):
  ```powershell
  cd backend; .venv\Scripts\python.exe -m app.cli create-platform-owner --email you@yourcompany.com
  ```
  It prints a temporary password once. Forgot it later: `.venv\Scripts\python.exe -m app.cli reset-staff-password
  --email you@yourcompany.com` (add `--reset-mfa` if the authenticator app is lost too).
* **New extension version:** run `node scripts\packaging\pack-extension.js`, copy `dist-installer\package\*` to
  `backend\release\package\`, commit and push.
* **Windows setup (.exe):** offered on the portal's Download page from `backend/release/AgentShield-System-Setup.exe`
  (`SYSTEM_SETUP_PATH` in `render.yaml`). It is built with the live addresses inside, so it asks nothing:
  ```powershell
  powershell -File scripts\helper\build-helper.ps1
  & "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" /DDefaultServer=https://YOUR-RENDER-ADDRESS /DDefaultDashboard=https://YOUR-PORTAL-ADDRESS scripts\system-installer\AgentShield-System-Setup.iss
  Copy-Item dist-installer\AgentShield-System-Setup.exe backend\release\ -Force
  ```
  Then commit and push. Rebuild it whenever the Render or portal address changes. **Limitation:** Chrome and Edge
  only install the extension from the setup on company-managed PCs (Active Directory, Entra ID, Intune) or once the
  extension is on the Chrome Web Store / Edge Add-ons with `CHROME_STORE_EXTENSION_ID` / `EDGE_STORE_EXTENSION_ID`
  set on Render (DEPLOYMENT.md §6). On other PCs the setup installs the Windows app, but the browsers ignore the
  extension; use the .zip there.
* **Your own domain later:** add it in Vercel / Render (Settings → Domains), then update the addresses above.
* More detail: [DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md) and [DEPLOYMENT.md](./DEPLOYMENT.md).
