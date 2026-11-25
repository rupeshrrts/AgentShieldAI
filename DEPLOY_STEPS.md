# Deploy AgentShieldAI (step by step, no domain needed)

This is the one deployment and operations guide. The first part (Phases 1–5) puts the project online with free
addresses; the [Reference](#reference) part below covers settings, your own server, payments, installing on PCs,
updating and troubleshooting.

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
   (`.gitignore` already excludes them, together with `*.pem`, `node_modules` and build output.)
5. Type `First deploy` in the summary box → **Commit to main**.
6. **Publish repository** → keep **"Keep this code private"** ticked → **Publish repository**.

Keep a private backup of `keys\agentshield-extension.pem` (the extension signing key). It is never uploaded, and
the extension's ID depends on it: if it is lost, PCs that force-install the extension must be set up again.

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
The database tables are created automatically on this first start. Render builds `backend/Dockerfile`
(Python 3.14, **one** worker) and also sets `EXTENSION_PACKAGE_DIR=/app/release/package`, so the portal offers the
extension files committed in `backend/release/package/`.

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
| 1 | `NAME-app` | `dashboard` | `VITE_API_BASE_URL` = your Render address (required)<br>`VITE_ADMIN_CONSOLE_URL` = `https://NAME-console.vercel.app` (required: the sign-in card's **Site owner? Admin login** link)<br>`VITE_WEBSITE_URL` = `https://NAME-site.vercel.app` |
| 2 | `NAME-site` | `website` | `VITE_PORTAL_URL` = `https://NAME-app.vercel.app` (required: **Log in** and **Sign up free** open the portal) |
| 3 | `NAME-console` | `admin-console` | `VITE_API_BASE_URL` = your Render address (required) |

* No `/` at the end of any address.
* Build failed with **"Set VITE_... in the Vercel project settings"**? A required variable is missing: add it under
  **Settings → Environment Variables**, then **Deployments → ⋯ → Redeploy**. (The builds stop on purpose, so a
  page can never be published pointing at the wrong server.)
* After changing any `VITE_` value you must **Redeploy** (the values are built into the pages).
* Each folder has its own `vercel.json` (Vite build, `dist` output, single-page fallback, security headers), so
  nothing else needs setting. The console also tells search engines not to index it.
* Why the backend is not on Vercel: Vercel runs Python as short-lived functions, while the backend needs one
  long-running process (replay protection, login lockouts and rate limits are kept in memory, the plan-reminder
  job runs in the background, and the extension files are served from disk).

✅ All three projects show **Ready**, each with its own `.vercel.app` address.

---

## Phase 4 — Connect them

1. Compare the three real Vercel addresses with what you typed into Render in Phase 2.
2. If any differ: Render → `agentshield-api` → **Environment** → correct `DASHBOARD_URL`, `ADMIN_CONSOLE_URL`
   and `ALLOWED_ORIGINS` → **Save** (it restarts by itself).

`ALLOWED_ORIGINS` (CORS) must list exactly the portal and the console addresses, comma separated. The website
needs no entry (it only links to the portal), and the extension is not affected by CORS.

✅ The website's **Sign up free** opens the portal, and the portal does not say it cannot reach the server
(if it does, `ALLOWED_ORIGINS` is wrong).

---

## Phase 5 — Test

1. Open your website → **Sign up free** → create an account → **Start free trial**.
2. **Download** → download the extension `.zip` → unzip it.
3. Chrome or Edge: `chrome://extensions` → **Developer mode** on → **Load unpacked** → the unzipped folder.
4. Portal → **Connect browser** → **Generate activation code** → AgentShield icon → paste → **Connect and verify**.
5. On ChatGPT type `sk-live-1234567890abcdefghijklmnop` → it is **blocked**.

Each browser needs its own code (one device each; the trial allows 3).

✅ The block appears, and the portal's **Overview** charts show the event.

---

## Good to know

* **Updating later:** change the code → GitHub Desktop → **Commit to main** → **Push origin**. Render and
  Vercel redeploy by themselves. More in [Updating](#updating).
* **Moving the project to another PC:** do not zip the whole folder (it holds `node_modules`, `.venv`, local
  databases and secrets). Copy only what git tracks, then on the other PC recreate the backend environment
  (`cd backend; python -m venv .venv; .venv\Scripts\pip install -r requirements.txt`) and copy `.env` and
  `keys\` across separately and privately (they are never pushed).
* **A deploy failed (fallback):** Render keeps the **previous version live** when a new build fails or the new
  version does not answer `/health`, so a bad push does not take the backend down. Open Render →
  `agentshield-api` → **Events** / **Logs** to read the error; to go back by hand, **Events** → an older
  successful deploy → **Rollback**. On start the backend retries the database for about 20 seconds before
  giving up ("Database unreachable at startup; check DATABASE_URL" in the log means the address or password is
  wrong). GitHub → **Actions** shows the test run for each push: a red cross there means a test failed, not
  that Render is down.
* **Free Render plan sleeps** after ~15 minutes without traffic and takes ~1 minute to wake; meanwhile browsers
  with the extension block AI sites (it never fails open), and the first sign-in waits for it (the portal then
  says the server is starting up). Fine for testing; for real users switch to **Starter**
  (Render → service → Settings → Instance type, about $7/month), which never sleeps.
  **Free alternative for testing:** keep it awake with a free uptime monitor, e.g. UptimeRobot or cron-job.org:
  add an HTTP(S) monitor for `https://YOUR-RENDER-ADDRESS/health` every 5 minutes. One always-on free service
  fits Render's 750 free hours a month (do not do this for several free services). The free plan is also slow
  in general (a small share of one CPU), so each sign-in still takes a few seconds; Starter is faster.
* **Keep one backend worker.** Do not raise the worker count or run several instances: replay protection for
  browser sign-in and the login lockouts are kept in the memory of one process.
* **Supabase SQL is not needed:** the backend creates the tables. Optional check: see [Database](#database).
* **Emails** (forgot password, invites): add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
  in Render → Environment. Sign-up works without them.
* **Payments** stay off until you add the Razorpay keys on Render: [Online payments](#online-payments-razorpay).
* **Admin console login:** Render's free plan has no shell, so create the first staff login from this PC:
  [First staff account](#first-staff-account).
* **New extension version:** see [Updating](#updating).
* **Your own domain later:** add it in Vercel (project → **Settings → Domains**) and Render (service →
  **Settings → Custom Domains**). Then update `PUBLIC_BASE_URL`, `DASHBOARD_URL`, `ADMIN_CONSOLE_URL` and
  `ALLOWED_ORIGINS` on Render and the `VITE_` addresses on Vercel (and **Redeploy**). Keep the console on its own
  address, never under the portal's.

---

# Reference

## Environment variables

**Where they go:** on Render, service → **Environment**. On your own server, a `.env` file in the project folder
(copy `.env.production.example` and fill it in). Real environment variables override `.env`. Never commit `.env`
or paste its values anywhere. Frontend (`VITE_...`) variables are listed in [Phase 3](#phase-3--three-projects-on-vercel).

**Required in production**

| Variable | What to put |
| :--- | :--- |
| `ENVIRONMENT` | `production` (refuses to start with a missing, short or published `SECRET_KEY`; turns off development helpers) |
| `SECRET_KEY` | A long random value, generated once: `python scripts/generate_secret_key.py` (Render creates it for you). Never change it: everyone would be signed out |
| `DATABASE_URL` | `postgresql://...` (Supabase: the **Transaction pooler** address, port 6543) |
| `PUBLIC_BASE_URL` | The backend's HTTPS address that every PC can reach (used in activation codes and download links) |
| `DASHBOARD_URL` | The portal's address (used in invite, password-reset and reminder email links) |
| `ADMIN_CONSOLE_URL` | The internal console's address (used in staff invite links) |
| `ALLOWED_ORIGINS` | The portal and console addresses, comma separated, no trailing `/` |
| `SMTP_HOST`, `SMTP_PORT` (`587`), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_STARTTLS` (`true`) | Outgoing mail. Without it invites and password resets fail ("email not configured") and plan reminders are not emailed. In development the links are printed in the backend console instead |

**Recommended**

| Variable | What it does |
| :--- | :--- |
| `STAFF_MFA_KEY` | A second random key (generate like `SECRET_KEY`) that encrypts staff authenticator secrets. If empty it is derived from `SECRET_KEY`, so changing `SECRET_KEY` would make every staff authenticator stop working (staff then sign in with a recovery code and an owner resets the others) |

**Sign-up, plans and payments** (defaults are fine to start)

| Variable | Default and meaning |
| :--- | :--- |
| `SIGNUP_ENABLED` | `true`: the portal offers **Create an account** (an Individual account). `false`: only invites create accounts |
| `SIGNUP_ALLOWED_DOMAINS` | Empty. A comma list (e.g. `yourcompany.com`) limits sign-up to those email domains, for a private single-company server |
| `COMPANY_SIGNUP_ENABLED` | `false`: **Company** shows *Coming soon* and company sign-ups are refused (`COMPANY_COMING_SOON`). Keep it off until company onboarding ships |
| `EMAIL_VERIFICATION_REQUIRED` | `false`: new accounts can start right after sign-up and no confirmation email is sent. `true`: they must confirm their email first |
| `SIGNUP_CHECK_EMAIL_DOMAIN` | `true`: sign-up refuses email domains that cannot receive mail |
| `TRIAL_DAYS` | `30`: trial length when the plans are first created; later edit it in the console's **Plans & pricing** |
| `TRIAL_CLAIMS_PER_IP_30D` | `3` trial claims per network per 30 days |
| `FREE_TIER_ENABLED` | `true`: individual accounts without a live plan get the Free plan's monthly prompt checks |
| `CREDITS_DEVICE_LIMIT` | `3` browsers while an account runs on prepaid credits only |
| `REFERRAL_BONUS_CHECKS`, `REFERRAL_MAX` | `100` bonus prompt checks per successful referral, at most `10` per account |
| `REMINDER_LOOP_ENABLED` | `true`: hourly job that sends plan reminders |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Empty = online payment off. See [Online payments](#online-payments-razorpay) |
| `RAZORPAY_API_BASE` | `https://api.razorpay.com/v1` (change only for testing) |
| `BILLING_SELLER_NAME`, `BILLING_SELLER_DETAILS` | `AgentShield` / empty: seller name and details (e.g. address) on receipts and in Checkout |
| `INITIAL_ORG_NAME`, `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` | Empty. When both email and password are set, the first start creates one customer company with that account as its admin and a non-expiring internal licence (password at least 14 characters in production). It has no staff rights. Leave empty for a self-serve service |

**Extension distribution**

| Variable | Default and meaning |
| :--- | :--- |
| `EXTENSION_PACKAGE_DIR` | `dist-installer/package` in the project folder; Render: `/app/release/package` (set in `render.yaml`). Folder with the built extension; without it the portal hides the download |
| `CHROME_STORE_EXTENSION_ID`, `EDGE_STORE_EXTENSION_ID` | Empty. Set after the store listings are approved: the portal then shows store links, and policy installs use the store copies |

**Lifetimes and limits** (defaults are fine): `INVITE_EXPIRE_HOURS` (72), `EMAIL_VERIFY_EXPIRE_HOURS` (24),
`PASSWORD_RESET_EXPIRE_MINUTES` (60), `DASHBOARD_TOKEN_HOURS` (12, portal sign-in), `STAFF_TOKEN_HOURS` (8, console
sign-in), `ACTIVATION_TOKEN_EXPIRE_MINUTES` (30), `DEVICE_SESSION_MINUTES` (15, browser session, renewed
automatically), `MAX_DEVICES_PER_USER` (3), `DEVICE_EVENTS_PER_MINUTE` (120).

**Leave as they are in production:** `DEMO_MODE` (`false`; `true` only on a demo server: banner and Guided Demo
page), `DEMO_AUDITOR_PASSWORD` (empty; development only), `LEGACY_DEVICE_KEYS_ENABLED` (`false`; emergency use
only).

## Running on your own server

Instead of Render and Vercel you can run everything on one machine (Windows or Linux) that every PC reaches over
**HTTPS**. To try the whole project on one PC first, see the Quick start in [README.md](./README.md).

| You need | Details |
| :--- | :--- |
| Python | 3.11 or newer (3.14 recommended: the same as the Render image). `backend/requirements.txt` pins exact versions |
| Node.js | 18 or newer, to build the portal, the console, the website and the extension |
| Database | Supabase or PostgreSQL ([Database](#database)). SQLite only for development |
| Web server | Any HTTPS reverse proxy (nginx, Caddy, IIS, a cloud load balancer) |
| Size | 1 vCPU / 1 GB RAM handles a few hundred browsers |

**1. Backend** (in `backend/`; on Linux use `.venv/bin/...` instead of `.venv\Scripts\...`):

```powershell
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --proxy-headers
```

* Fill in `.env` first ([Environment variables](#environment-variables)).
* **Always one worker** (in-memory replay protection and login lockouts). Keep it running as a service.
* Put the HTTPS reverse proxy in front and forward the backend's address (e.g. `https://api.yourcompany.com`)
  to `127.0.0.1:8000`. `PUBLIC_BASE_URL` is that address.
* Or build the same container Render uses: `docker build -t agentshield-api backend`, then run it with your
  environment variables and port 8000 published (it serves `/app/release/package`, so set
  `EXTENSION_PACKAGE_DIR` to that).

**2. Portal, console and website** (static files; run each line from the project folder):

```powershell
cd dashboard;     npm install; $env:VITE_API_BASE_URL="https://api.yourcompany.com"; npm run build
cd admin-console; npm install; $env:VITE_API_BASE_URL="https://api.yourcompany.com"; npm run build
cd website;       npm install; $env:VITE_PORTAL_URL="https://app.yourcompany.com"; npm run build
```

Serve each folder's `dist\` on its **own** HTTPS address, answering unknown paths with `index.html` (single-page
apps). Never put the console under the portal's address; if you can, limit who reaches it (VPN or IP allow-list).
Add the portal and console addresses to `ALLOWED_ORIGINS`, set `DASHBOARD_URL` and `ADMIN_CONSOLE_URL`, and
restart the backend.

**3. Extension package:** build it on this machine (`node scripts\packaging\pack-extension.js`, see
[Updating](#updating)); the backend finds it in `dist-installer\package\` by default.

## Database

* **Supabase** (recommended) or **PostgreSQL** (13 or newer). Use Supabase's **Transaction pooler** address
  (port 6543) in `DATABASE_URL`.
* **Nothing to run by hand:** on start the backend creates every table and column it needs and turns on Row Level
  Security (harmless outside Supabase).
* **Optional check:** Supabase → **SQL Editor** → paste `backend/migrations/RUN_ALL_IN_SUPABASE.sql` → **Run**,
  after the backend has started once. It applies every file in `backend/migrations/` in order and is safe to run
  again.
* **Never point a development server or tests at the live database:** set `DATABASE_URL` to a local SQLite file
  first (e.g. `$env:DATABASE_URL="sqlite:///./test_agentshield.db"`).
* Back up the database before larger upgrades.

## Online payments (Razorpay)

Optional. Without it everything else works: plan buttons say **Contact AgentShield**, and the platform owner grants
paid plans by hand (internal console → **Accounts** → **Grant licence**, an audited exception that needs a reason
such as the invoice number). Customers pay in Razorpay's own hosted Checkout, so card and UPI details never reach
your server.

1. Create a Razorpay account (business verification is needed only for live payments).
2. **Test keys first:** Razorpay Dashboard (Test mode) → Account & Settings → API Keys → Generate. Set
   `RAZORPAY_KEY_ID` (starts `rzp_test_`) and `RAZORPAY_KEY_SECRET` on the backend. A test key puts the portal in
   test mode ("no real money is taken"). The secret stays on the server; only the key id reaches browsers.
3. **Webhook:** Razorpay → Account & Settings → Webhooks → Add new webhook:
   * URL: `https://YOUR-BACKEND/api/v1/billing/razorpay/webhook` (reachable from the internet)
   * Secret: a long random value; set the same value as `RAZORPAY_WEBHOOK_SECRET` (without it every webhook is
     rejected).
   * Events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`,
     `refund.created`, `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`,
     `payment.dispute.closed`, `subscription.activated`, `subscription.authenticated`, `subscription.charged`,
     `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`.
4. Restart the backend (Render restarts by itself when you save).
5. Internal console → **Plans & pricing** (owner): give each plan you sell and the credit pack a price and tick
   **Offered for sale** ([Plans and credits](#plans-and-credits)).
6. **Test** with Razorpay's test cards / test UPI: the plan becomes active, the receipt opens under **Billing**,
   and internal console → **Payments** shows the order *paid* and the webhook events `processed`. Try a refund
   there (owner or billing admin).
7. **Go live:** generate live keys (`rzp_live_...`), replace both keys, add the same webhook in Live mode (update
   `RAZORPAY_WEBHOOK_SECRET` if it differs) and restart.

How it works: six-month and annual plans and credit packs are one-time Razorpay Orders; the monthly plan is a
Razorpay Subscription (its Razorpay plan is created for you, and again when the price changes). A plan activates,
or credits are added, only for a payment Razorpay reports as captured for exactly the order amount, confirmed by
the signed checkout result and a server-side check, or by the signed webhook; each payment and event is applied
once. The backend calls `api.razorpay.com` and the admin's browser loads `checkout.razorpay.com`, so allow both
through any firewall or content-security policy. Receipts are payment receipts, not tax invoices.

## First staff account

There are no built-in logins. Create the first internal console account (platform owner) with a command, on a
machine that reaches the production database, in `backend/` with the same `DATABASE_URL` as the server (with
Render: from this PC, using the Supabase address in your local `.env`):

```powershell
cd backend; .venv\Scripts\python.exe -m app.cli create-platform-owner --email you@yourcompany.com
```

1. It prints a **temporary password once** (add `--name "Your Name"` if you like). It refuses if an owner already
   exists; `--force` adds another owner on purpose.
2. Open the internal console (`ADMIN_CONSOLE_URL`) and sign in with that email and password.
3. Set up an **authenticator app** (scan the QR code or type the key), enter a code, **save the 10 recovery
   codes** (shown once; each works once), then choose a new password (at least 14 characters). Nothing else opens
   before that.
4. **Staff & roles → Invite** colleagues with the least role they need (roles: [README.md](./README.md)
   "Authentication model"). Invite links work once and expire after 48 hours; SMTP is needed.

**Passwords:** a signed-in admin changes their own with **Change password** (bottom of the console sidebar). Forgot
it: another platform owner clicks **Staff & roles → Reset password** and passes on the one-time password it shows;
the only owner runs `.venv\Scripts\python.exe -m app.cli reset-staff-password --email you@yourcompany.com` (add
`--reset-mfa` if the authenticator app is lost too). The console's **Forgot password?** link explains both; staff
passwords are never reset by email. A lost phone can also be handled with a recovery code, or another owner resets
that person's authenticator in **Staff & roles** (an owner cannot reset their own). Five
wrong passwords lock a staff email for 15 minutes.

## Plans and credits

As the platform owner, in internal console → **Plans & pricing**:

1. Check the plan names, lengths and browser limits. **No prices are preset:** a plan is sold only once it has a
   price and **Offered for sale** is ticked.
2. **Credit pack** (`credits_1000`, 1,000 prompt checks): set the pack size if you want, a price and currency,
   and tick **Offered for sale**. Customers then see **Buy credits** (needs online payment). One credit is one
   prompt check; credits never expire.
3. **Included prompt checks per month** (optional, on the trial and paid plans; empty = unlimited). When an account
   uses them up, further checks use its credits; without credits its browsers lock until next month, a top-up or
   an upgrade. The Free plan's monthly checks are set here too.
4. **Extension releases:** check that the packaged build registered itself (it does on every server start) and add
   release notes.

Customers can set their own monthly limit in **Usage & credits**. Staff see usage and credits under **Accounts**;
adding credits without a payment is an owner-only, audited exception with a reason.

## Portal configuration

Two kinds of admin, in two separate apps:

* **AgentShield staff** use the internal console (above). Customer accounts can never open it.
* **Customers** use the portal. Public sign-up creates an **Individual** account (one person, its own admin).
  **Company workspaces** exist only for the `INITIAL_ADMIN_EMAIL` company or companies created before company
  sign-up was paused; only they can invite people.

A customer admin (the portal's **Get started** section and the **Overview** checklist guide them):

1. **Start a plan:** **Account & plan** → **Start free** (the trial, then the Free plan), buy a plan (**Buy**:
   six-month or annual; **Subscribe**: monthly, renews automatically) or **Buy credits**. Without an active plan
   or credits, activation codes cannot be generated and browsers stay locked.
2. **Invite the team** (company workspaces): **Users & Devices** → **Invite someone** → work email and role
   (**EMPLOYEE**: activates their own browsers only; **VIEWER**: read-only; **ADMIN**). The single-use link is valid
   72 hours. Employees must **not** use **Create an account** (that makes a separate individual account). Optional:
   **Require admin approval for new browsers**.
3. **Rules:** **Data Protection Rules** (individual: **Protection rules**) → start with the **Monitor only** preset
   for a week, then **Recommended**.
4. **Websites:** **Website Controls** → review blocked sites and categories; optionally block unapproved AI tools.
5. **Keywords** (company workspaces): **Deployment & Settings → Confidential keywords** → add project code names.
6. **Privacy:** **Deployment & Settings → Privacy & retention** → recommended: store the text of rule-breaking
   prompts only, keep events 30–90 days (what is stored: [DATA_HANDLING.md](./DATA_HANDLING.md)).

Changes reach connected browsers within about a minute. Plan reminders (in the portal and by email) go out 7, 3
and 1 days before a plan ends and when it ends. Day-to-day administration: [ADMIN_GUIDE.md](./ADMIN_GUIDE.md).

## Installing the extension on PCs

The extension carries **no credential** and starts locked: every AI site shows **Activation Required** until a
user activates that browser with their own account. Installing, copying or enabling it grants nothing.

| Way | Users can remove it? | Works on | Use for |
| :--- | :--- | :--- | :--- |
| **A. Force install by enterprise policy** | No | Chrome, Edge and Brave, every user of the PC | Company PCs |
| **B. Load unpacked** from the portal's zip | Yes | One browser | Individuals, pilots |
| **C. Store listing** | Yes (unless also force-installed) | Any PC | Selling to everyone |

**A. Force install (as Administrator):**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\system-installer\Install-AgentShield.ps1 -ServerUrl https://YOUR-BACKEND [-DashboardUrl https://YOUR-PORTAL] [-BlockDeveloperTools]
```

* It asks the server for the extension ID and update address, then writes `ExtensionInstallForcelist`,
  `ExtensionInstallAllowlist` and the extension policy `apiUrl` (plus `dashboardUrl` if given) for Chrome, Edge and
  Brave, keeping existing policy entries. With `apiUrl` set, codes from any other server are refused.* Exit code 0 = success; log: `C:\ProgramData\AgentShield\install.log`. Restart the browsers; the icon appears
  within a few minutes.
* Many PCs: run the same command from a Group Policy startup script, Intune or SCCM, or set the same policies
  directly with the Chrome / Edge ADMX templates. The portal's **Deployment & Settings → Install on company PCs**
  shows the exact `ExtensionInstallForcelist` value for your server.
* **Device requirement:** Chrome and Edge force-install a **self-hosted** extension only on PCs joined to Active
  Directory or Microsoft Entra ID, or enrolled in Intune/MDM (Chrome also accepts Chrome Browser Cloud Management:
  `-ChromeEnrollmentToken`). On other PCs the policy shows in `chrome://policy` but nothing installs, and the
  script says so. Fix: publish to the stores (C) and set `CHROME_STORE_EXTENSION_ID` / `EDGE_STORE_EXTENSION_ID`;
  the same command then installs the store copies on any Windows PC.

**B. Load unpacked:** portal → **Download** → the `.zip` → extract to a **permanent** folder →
`chrome://extensions` (or `edge://extensions`) → **Developer mode** on → **Load unpacked** → that folder → pin the
icon. Repeat per browser. The Download page shows the zip's SHA-256 (check with `certutil -hashfile <file> SHA256`).

**C. Store listing:** build with `node scripts\packaging\store-packages.js --api-url https://YOUR-BACKEND
--dashboard-url https://YOUR-PORTAL` and follow [STORE_SUBMISSION.md](./STORE_SUBMISSION.md). After approval set
the two store IDs on the backend.

To cover "the whole PC", also block other browsers (AppLocker / Intune app control) and, optionally, AI sites at
your firewall or DNS filter.

## Activating browsers

Each person does this once in every browser (needs their own account and an active plan, the Free plan or
credits; at most 3 browsers per account and the plan's limit):

1. Portal → **Connect browser** (individual) or **My activation** (company workspace) → **Generate activation
   code**. The code works once, for 30 minutes; a new one cancels the old one. Never share it.
2. Click the AgentShield icon → paste the code → **Connect and verify**. The extension never asks for an email or
   password.
3. If **Require admin approval** is on, the browser waits until an admin approves it in **Users & Devices**.

When a plan, included checks or credits run out, browsers lock at their next request and reconnect by themselves
after renewal or a top-up (no new code). Step-by-step for end users: [README.md](./README.md#user-setup); what
is blocked and why: [README.md](./README.md#what-is-blocked-and-allowed).

## Verification

```powershell
python scripts/verify_production.py https://YOUR-BACKEND
```

It checks `/health`, `/health/live` and `/health/ready`. Then:

| Check | Expected |
| :--- | :--- |
| `GET /health` | `"status": "healthy"`, `"environment": "production"` |
| `GET /health/ready` | `"status": "ready"`, `"database": "connected"` |
| `GET /extension-updates/info` | The extension version and ID (otherwise the package is missing) |
| `GET /api/v1/policies` without credentials | `401` |
| `GET /internal/api/companies` without a token, or with a customer's token | `401` |
| `POST /auth/signup` with `"account_type": "COMPANY"` | `403` `COMPANY_COMING_SOON` |
| A new, not-yet-activated browser opens chatgpt.com | **Activation Required** page |
| After activating: the test key from Phase 5 | Blocked; the event appears in the portal |
| Revoke that browser in the portal | AI sites are blocked there again at its next request |
| Internal console sign-in with the right password | An authenticator code is asked for before any page opens |
| Without Razorpay keys: **Account & plan** | **Contact AgentShield**; `POST /api/v1/billing/checkout` returns `503` |
| `POST /api/v1/billing/razorpay/webhook` with a wrong signature | `400` |
| **Forgot password?** | A reset link arrives by email |

Automated test suites: [README.md](./README.md#testing).

## Updating

* **Code:** push to GitHub; Render and Vercel redeploy by themselves. Own server: pull, `pip install -r
  requirements.txt` again, restart the backend, rebuild the frontends. New tables and columns are added on start.
* **Library versions:** `backend/requirements.txt` pins exact versions. Upgrade by editing a version, running the
  tests, then pushing.
* **Rules, websites, keywords, settings:** change them in the portal; browsers pick them up within about a minute.
* **New extension version:**
  1. Bump `version` in `extension/manifest.json`.
  2. `node scripts\packaging\pack-extension.js` (builds and signs; needs `keys\agentshield-extension.pem`, created
     once with `node scripts\packaging\new-extension-key.js`). Optional: set `$env:AGENTSHIELD_API_URL` and
     `$env:AGENTSHIELD_DASHBOARD_URL` (https addresses) first to make your server and portal the built-in
     defaults; without them activation codes still carry the server address.
  3. Copy `agentshield-extension.zip`, `agentshield.crx` and `release.json` from `dist-installer\package\` to
     `backend\release\package\` (not `agentshield-store.zip`, which is only uploaded to the stores), commit and
     push. Own server: restart the backend instead.
  4. The server registers the new build on start; add notes or make it current in internal console →
     **Extension releases**. Deploy the backend before handing out an extension that needs new server features.
  5. Force-installed copies update by themselves; Load-unpacked copies need the new zip and ↻ in
     `chrome://extensions`; store copies update after the store approves the new upload. Activations are kept.
  For a portal-only ZIP update, run `node scripts/packaging/pack-extension.js --portal-zip` from the repository root.
  It rebuilds the ZIP and metadata directly in `backend/release/package/` using the extension's existing public key.
  The managed update feed continues to advertise the version of the signed CRX. Deploy the backend to publish the new ZIP.
* **Older upgrade notes** (per version) are in [README.md](./README.md) "Change history".

## Uninstalling

* **Force-installed:** as Administrator, `powershell -ExecutionPolicy Bypass -File
  scripts\system-installer\Install-AgentShield.ps1 -Uninstall` (removes only AgentShield's policy entries), then
  restart the browsers.
* **Load unpacked or store:** `chrome://extensions` → AgentShield → **Remove**.
* **Stop one browser:** portal → **Users & Devices** → **Revoke** (individual: sign it out on **Connect browser**).
  It is locked at its next request.
* **Stop a person:** **Users & Devices** → **Disable**. All their browsers lock at their next request.

## Troubleshooting

| Problem | Fix |
| :--- | :--- |
| Portal says it cannot reach the server; console sign-in fails with a network/CORS error | `ALLOWED_ORIGINS` must list the exact portal and console addresses (no `/` at the end); check `VITE_API_BASE_URL` and redeploy |
| Vercel build: "Set VITE_... in the Vercel project settings" | Add the variable, then **Redeploy** (Phase 3) |
| Render: "Database unreachable at startup; check DATABASE_URL" | Wrong pooler address or password; Render keeps the previous version live meanwhile |
| First request takes about a minute | Free Render plan waking up ([Good to know](#good-to-know)) |
| Portal download missing / "package has not been built" | The extension files are not in `EXTENSION_PACKAGE_DIR` ([Updating](#updating)) |
| Inviting says "email not configured"; reset emails never arrive | Set the `SMTP_...` variables; check `SMTP_FROM`, `DASHBOARD_URL` and the spam folder |
| Force install: no icon appears | Restart the browser, open `chrome://policy` and `install.log`. If the PC is not domain/Intune-managed, use the stores or Load unpacked |
| **Activation Required** on AI sites | Expected until the browser is activated; also after a revoke, a disabled account, an ended plan, or when the server is unreachable |
| Activation code refused | Codes work once, for 30 minutes, and a newer code cancels older ones; generate a new one. "Refused for this server": IT set a different `apiUrl` |
| **Generate activation code** disabled | No active plan or credits, or the checks / credits / monthly limit are used up: **Account & plan** |
| Popup names `LICENSE_EXPIRED`, `NO_LICENSE`, `USAGE_LIMIT`, `SPEND_CAP` or `NO_CREDITS` | Renew, buy credits or raise the limit; the browser reconnects by itself (or **Check again**) |
| Popup: `LICENSE_REVOKED` or `ORG_SUSPENDED` | Set by AgentShield staff in the internal console |
| Popup: `DEVICE_LIMIT` or "already has 3 browsers" | Sign one out on **Connect browser** / **My activation**, or revoke one in **Users & Devices** |
| Popup: "Cannot reach the AgentShield server" | The backend address is not reachable from that PC (VPN, firewall, a sleeping free server). AI sites stay blocked meanwhile |
| Plan buttons say **Contact AgentShield**; **Buy credits** missing | Razorpay keys not set, or the plan / pack has no price or is not **Offered for sale** |
| Paid but the plan is not active | Internal console → **Payments**: rejected webhooks usually mean a wrong `RAZORPAY_WEBHOOK_SECRET` or unreachable URL; **Reconcile** re-checks recent one-time orders |
| Internal console: code "not valid" | Set the phone's clock to automatic; each code works once; or use a recovery code |
| Internal console: every staff authenticator refused after a change | `SECRET_KEY` changed without a fixed `STAFF_MFA_KEY`: sign in with a recovery code, then an owner resets the others |
| Internal console: "Too many failed attempts" | Five wrong passwords lock that email for 15 minutes |
| Prompts not blocked on an AI site | Reopen the tab after installing or updating; the badge must say "Protected" |

Security design: [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md). Data stored and privacy:
[DATA_HANDLING.md](./DATA_HANDLING.md).
