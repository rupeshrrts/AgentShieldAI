# AgentShield — Deployment Guide

Covers development, demo, staging and production. For end users see [USER_SETUP.md](./USER_SETUP.md); for day-to-day administration see [ADMIN_GUIDE.md](./ADMIN_GUIDE.md).

---

## 1. Requirements

| Item | Requirement |
| :--- | :--- |
| Server | Any host that runs Python 3.10+ (or Docker). 1 vCPU / 1 GB RAM handles a few hundred browsers. |
| Database | PostgreSQL 13+ or Supabase for staging/production. SQLite only for development. |
| Network | The server must be reachable over **HTTPS** from every employee PC. |
| Build machine | Node.js 18+ (to build the extension, the dashboard and the internal admin console). |
| Internal console host | A second HTTPS address (e.g. `https://admin.yourcompany.com`) for `admin-console/dist/`, separate from the customer portal. Restrict who can reach it if you can (VPN / IP allow-list). |
| Employee browsers | Google Chrome or Microsoft Edge (current versions). Firefox and Safari are not supported. |

## 2. Environment variables

Set in `.env` at the repository root (copy `.env.production.example`). Real environment variables override `.env`.

| Variable | Production value |
| :--- | :--- |
| `ENVIRONMENT` | `production` (refuses to start with default secrets; disables the test bench and demo auditor) |
| `SECRET_KEY` | **Required, no default.** 64 hex chars: `python scripts/generate_secret_key.py`. Production refuses to start if it is missing, shorter than 32 characters or a published default. In development without it a random key is generated per process (everyone is signed out on each restart, and staff authenticator secrets derived from it can no longer be read) |
| `DATABASE_URL` | `postgresql://...` (Supabase: transaction pooler, port 6543) |
| `INITIAL_ORG_NAME`, `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` | **Optional, no defaults.** When both email and password are set, the first boot creates a first **customer** company (`INITIAL_ORG_NAME`) with that account as its ADMIN; that company gets a non-expiring internal licence. Password at least 14 characters in production. Leave both empty for a pure self-serve SaaS. This account has **no** platform rights (platform administration is the internal console) |
| `DEMO_AUDITOR_PASSWORD` | Leave empty in production. Development only: creates a read-only demo account `auditor@agentshield.local` in the initial company; ignored (and the account disabled) when `ENVIRONMENT=production` |
| `ADMIN_CONSOLE_URL` | HTTPS address of the internal admin console, e.g. `https://admin.yourcompany.com` (used in staff invite links; development default `http://localhost:5175`) |
| `STAFF_MFA_KEY` | Recommended: a separate random key (generate like `SECRET_KEY`) that encrypts staff authenticator secrets at rest. If empty, a key is derived from `SECRET_KEY`, and rotating `SECRET_KEY` then makes the stored authenticator secrets unreadable: authenticator codes stop working, staff sign in with a recovery code, and an owner resets the others' authenticators (an owner cannot reset their own; another owner must). Changing `STAFF_MFA_KEY` has the same effect |
| `STAFF_TOKEN_HOURS` | `8` (internal console session lifetime). Not passed through by the compose files; add it to the `environment:` list if you change it |
| `ALLOWED_ORIGINS` | Your dashboard URL **and** the internal console URL, e.g. `https://agentshield.yourcompany.com,https://admin.yourcompany.com` (development defaults already include `http://localhost:5173` and `http://localhost:5175`) |
| `PUBLIC_BASE_URL` | The HTTPS address PCs use, e.g. `https://agentshield.yourcompany.com` |
| `DASHBOARD_URL` | Dashboard address used in sign-up confirmation, invite, password-reset and reminder emails (default: `PUBLIC_BASE_URL`; in development `http://localhost:5173`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_STARTTLS` | Outgoing mail for sign-up confirmation links, invites, password-reset links and plan reminders (port `587`, STARTTLS `true`). **Required in production** (2.1): without it new accounts cannot receive their confirmation link and so cannot claim the trial, and invites and password resets fail ("email not configured"); in development without SMTP the link is printed to the backend console/log. The compose files pass all of these except `SMTP_STARTTLS` |
| `SIGNUP_ENABLED` | `true` (default): the login page offers **Create an account**, which creates an **Individual** account (optional name, email, password) with the person as its ADMIN, signs them in at once and emails a confirmation link (needed before the free trial). `false`: hidden and refused; only admin invites create accounts |
| `COMPANY_SIGNUP_ENABLED` | `false` (default): **Company** is shown as *Coming soon* and `account_type: COMPANY` sign-ups get 403 `COMPANY_COMING_SOON`. `true` lets the API create company workspaces (named from `company_name` or the email domain); keep `false` until company onboarding ships |
| `SIGNUP_ALLOWED_DOMAINS` | Comma list, e.g. `motwane.com`. If set, only these email domains can sign up. Leave empty for a public self-serve service; set it (or `SIGNUP_ENABLED=false`) for a private, single-company server |
| `EMAIL_VERIFY_EXPIRE_HOURS` | `24` (lifetime of sign-up confirmation links) |
| `EMAIL_VERIFICATION_REQUIRED` | `false` (2.4.1): new individual accounts get the Free plan and can start the trial right after sign-up, and no confirmation email is sent. `true` = they must confirm their email first (stronger against fake accounts). The invite-a-friend bonus always needs a confirmed email |
| `CREDITS_DEVICE_LIMIT` | `3` (browsers an account may connect while it runs on prepaid credits only, without a plan) |
| `PASSWORD_RESET_EXPIRE_MINUTES` | `60` (password-reset link lifetime) |
| `DASHBOARD_TOKEN_HOURS` | `12` (dashboard sign-in lifetime) |
| `TRIAL_DAYS` | `30`. Length of the trial plan when the plans are first created; afterwards edit it in **internal console → Plans & pricing**. Also quoted in the confirmation email |
| `TRIAL_CLAIMS_PER_IP_30D` | `3` (trial claims per network per 30 days; the network is stored as a keyed hash) |
| `REMINDER_LOOP_ENABLED` | `true`. Hourly background job that sends plan reminders (first run 1 minute after start). Turn off on extra workers/replicas if you only want one sender; reminders are sent once each anyway (database constraint), and access never depends on the job |
| `DEMO_MODE` | `false` (`true` only for demo environments) |
| `DEVICE_EVENTS_PER_MINUTE` | `120` (per activated browser and employee) |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Default token lifetime for other tokens; dashboard sign-ins use `DASHBOARD_TOKEN_HOURS` |
| `INVITE_EXPIRE_HOURS` | `72` (invite link lifetime) |
| `ACTIVATION_TOKEN_EXPIRE_MINUTES` | `30` (activation code lifetime) |
| `DEVICE_SESSION_MINUTES` | `15` (browser session lifetime; renewed automatically) |
| `MAX_DEVICES_PER_USER` | `3` (active browsers per account; each plan also has a browser limit for the whole company, set in **Plans & pricing** or per customer) |
| `CHROME_STORE_EXTENSION_ID`, `EDGE_STORE_EXTENSION_ID` | Only after store publishing (§6 C). The portal's **Download** page then shows store links instead of the `.zip` |
| `LEGACY_DEVICE_KEYS_ENABLED` | `false`. `true` temporarily re-accepts pre-1.3 device keys; emergency use only (§7) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API key id and secret (e.g. `rzp_test_xxxxxxxx` / its secret in test mode, `rzp_live_…` in production). Empty (default): online payment is off, checkout returns `503` and the portal shows "Contact AgentShield". A key id starting `rzp_test_` puts the portal in test mode ("no real money is taken"). The secret stays on the server; only the key id is sent to browsers (§5.4) |
| `RAZORPAY_WEBHOOK_SECRET` | Secret of the Razorpay webhook (§5.4). Empty: every webhook is rejected, so payments complete only through the checkout confirmation (or Reconcile) |
| `RAZORPAY_API_BASE` | `https://api.razorpay.com/v1` (default; change only for testing) |
| `BILLING_SELLER_NAME`, `BILLING_SELLER_DETAILS` | Seller name in Checkout and on receipts (default `AgentShield`) and extra seller details printed on receipts (e.g. address) |
| `VITE_API_BASE_URL` (dashboard and admin-console builds) | Empty when the API is served from the same origin behind the reverse proxy; otherwise the API URL. For the admin console, the API must answer `/internal/*` at that address (the dashboard's `nginx.conf` does not proxy `/internal/`) |

## 3. Development (one PC)

```powershell
# Backend: ALWAYS use a local database for development
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
$env:DATABASE_URL = "sqlite:///./agentshield.db"
$env:SECRET_KEY = (.venv\Scripts\python.exe -c "import secrets; print(secrets.token_hex(32))")   # optional; keeps sessions and staff MFA across restarts
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000

# Dashboard (customer portal)
cd dashboard; npm install; npm run dev          # http://localhost:5173

# Internal admin console (AgentShieldAI staff)
cd admin-console; npm install; npm run dev      # http://localhost:5175

# Extension
cd extension; npm install; node build.js; npm test
```

There are no built-in logins. Create a test account with **Create an account** → **Individual** on the login page of http://localhost:5173 (you are signed in at once), open the confirmation link printed in the backend console (no SMTP in development) and claim its trial on **Account & plan**, or set `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` before the first start to create an initial company workspace with an internal licence (optionally `DEMO_AUDITOR_PASSWORD` for a read-only demo account). In that company workspace, invite yourself (Users & Devices → **Invite someone**; without SMTP, invite links are printed in the backend console) and follow [USER_SETUP.md](./USER_SETUP.md). Activation codes generated on this server point at `http://localhost:8000`.

For the internal console, create the first platform owner in `backend/` with the same `DATABASE_URL` (and `SECRET_KEY`) as the server: `.venv\Scripts\python.exe -m app.cli create-platform-owner --email you@example.com`, then sign in at http://localhost:5175 (§5.3).

> If `.env` points at your production Supabase, a `--reload` dev server writes to production. Set `DATABASE_URL` as shown.

## 4. Demo environment

Same as development or staging, plus `DEMO_MODE=true`. The dashboard then shows a "Demo environment" banner and a **Guided Demo** page whose checks read real events. Use only the synthetic data shown on that page. Demo mode does not change any security check.

## 5. Staging and production

### 5.1 Database

* **Supabase, new project:** SQL Editor → run `SUPABASE_SETUP.sql`, then `backend/migrations/2026_10_accounts_activation.sql`, then `backend/migrations/2026_10_saas_phase1.sql`, then `backend/migrations/2026_10_saas_phase2.sql`, then `backend/migrations/2026_10_internal_console.sql`, then `backend/migrations/2026_10_individual_launch.sql`. **Warning:** section 5 of `SUPABASE_SETUP.sql` inserts demo accounts (`admin@agentshield.local`, `auditor@agentshield.local`) whose passwords are published; it is meant for local testing. For production, skip that section or delete those accounts right after running it.
* **Supabase, existing AgentShield database:** run `backend/migrations/2026_10_production_hardening.sql`, then `backend/migrations/2026_10_enterprise_features.sql`, then `backend/migrations/2026_10_accounts_activation.sql`, then `backend/migrations/2026_10_saas_phase1.sql`, then `backend/migrations/2026_10_saas_phase2.sql`, then `backend/migrations/2026_10_internal_console.sql`, then `backend/migrations/2026_10_individual_launch.sql`. The final query of the enterprise migration lists every table with `rowsecurity = true`.
* The backend also creates the `user_invites`, `email_verifications`, `activation_tokens` and `devices` tables, and the 1.4.0 tables `plans`, `licenses`, `trial_claims`, `license_adjustments`, `notifications` and `extension_releases` plus the new columns (`organizations.suspended_at`, `organizations.suspended_reason`, `users.session_version`, `email_verifications.purpose`), and the 1.5.0 payment tables `billing_orders`, `billing_payments`, `billing_subscriptions`, `webhook_events`, on startup plus the columns `plans.razorpay_plan_id` and `plans.razorpay_plan_amount`, and the 2.0.0 tables `staff_users`, `staff_recovery_codes`, `staff_invites` plus the column `admin_audit_log.actor_type`, and the 2.1.0 tables `usage_daily`, `credit_ledger`, `api_tokens` plus the columns `organizations.account_type`, `organizations.credit_balance`, `organizations.monthly_check_cap`, `users.display_name`, `security_events.client_event_id`, `plans.credits`, `plans.check_limit` and the unpriced `credits_1000` pack, on startup (the migrations create them too).
* **Plain PostgreSQL:** nothing to run; the backend creates tables on first start and enables RLS (harmless outside Supabase).

### 5.2 Backend and dashboard

**Docker (recommended):**
```bash
cp .env.production.example .env      # then edit it
docker compose -f docker-compose.supabase.yml up -d --build    # external DB
# or: docker compose -f docker-compose.prod.yml up -d --build  # bundled PostgreSQL
python scripts/verify_production.py https://agentshield.yourcompany.com
```
Put a TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer) in front, serving the dashboard and proxying `/api/`, `/auth/` and `/health` to the backend.

**Without Docker:** `uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2` behind the same reverse proxy; dashboard: `npm run build` and serve `dashboard/dist/` as static files.

**Internal admin console** (not part of the compose files; deploy it separately):
```powershell
cd admin-console
npm install
$env:VITE_API_BASE_URL = "https://api.yourcompany.com"   # an API address that serves /internal/*; leave empty if the console's own web server proxies /internal/ to the backend
npm run build                                            # output: admin-console/dist/
```
Serve `admin-console/dist/` as static files over HTTPS on its **own** address (e.g. `https://admin.yourcompany.com`), never under the customer portal's origin. Add that origin to `ALLOWED_ORIGINS`, set `ADMIN_CONSOLE_URL` to it, restart the backend, and (recommended) limit access to it by VPN or IP allow-list and send a strict Content-Security-Policy. The console loads only its own files and Google Fonts.

Note: login lockout and rate-limit counters (failed sign-ins, staff sign-in lockout and MFA attempts, activation attempts (10 per IP per hour), activation-code generation, invite and reset link checks, sign-ups (10 per IP per hour), password-reset requests, challenge/session requests) are in memory, per process. With several workers they are per worker. The trial-per-network cap is different: it is counted in the database (`trial_claims`), so it holds across workers.

The plan-reminder job runs in every process with `REMINDER_LOOP_ENABLED=true` (hourly, first run 1 minute after start); a database unique constraint makes sure each reminder is sent once.

### 5.3 First sign-in

1. **Create the first platform owner** (internal staff, not a customer account). On a machine that reaches the production database, in `backend/`, with the production environment (`ENVIRONMENT`, `DATABASE_URL`, `SECRET_KEY`, and `STAFF_MFA_KEY` if you use it; e.g. `docker compose exec backend python -m app.cli …` inside the backend container):
   ```
   python -m app.cli create-platform-owner --email you@yourcompany.com [--name "Your Name"]
   ```
   It prints a random temporary password **once** (only its hash is stored). It refuses if an owner already exists (add `--force` only to create a second owner deliberately).
2. **Sign in to the internal console** (`ADMIN_CONSOLE_URL`) with that email and temporary password. You must set up an authenticator app (scan the QR code or type the key into Google/Microsoft Authenticator or similar), enter a code, **save the 10 recovery codes** (shown once; each works once), then choose a new password (at least 14 characters). Nothing else works before that.
3. **Staff & roles:** invite colleagues by email with the least role they need (table in README "Authentication model"). Invite links are single-use and expire after 48 hours; SMTP is required in production (in development without SMTP the link is written to the server log). Each invitee sets a password and must enrol an authenticator.
4. **Plans & pricing** (owner): check plan names, lengths and browser limits, and set prices for the plans you want to sell (no prices are preset; a plan is offered for sale only once priced). Set the **credit pack** (`credits_1000`) price and tick **Offered for sale** to sell prepaid credits, and optionally set **Included prompt checks per month** on the trial and paid plans (empty = unlimited). **Extension releases:** confirm the packaged build registered itself (it does on server start) and add release notes.
5. Customers sign up themselves in the customer portal (**Create an account** → **Individual** → signed in at once → open the emailed confirmation link → **Account & plan** → **Claim free 30-day trial**) and buy a plan or credits on **Account & plan** once online payment is set up (§5.4; a plan is offered online only when it has a price and **Offered for sale** is ticked). Without Razorpay, or for invoiced customers, the platform owner activates a paid plan with **internal console → Companies → Grant licence**; this is an audited **exception** (`licenses.exception`, owner only) and needs a reason such as the invoice or payment reference. Platform admins can grant trial licences.
6. If you set `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`, sign in to the customer portal with them and complete the **Finish setup** checklist (change password, invite your team, connect the first browser, review policies, test blocking). That account is a normal company ADMIN.

### 5.4 Online payments (Razorpay)

1. Create a Razorpay account. Start in **test mode**: Razorpay Dashboard → Account & Settings → API Keys → generate a test key; set `RAZORPAY_KEY_ID=rzp_test_xxxxxxxx` and `RAZORPAY_KEY_SECRET` in `.env`.
2. Supabase: run `backend/migrations/2026_10_saas_phase2.sql` after `2026_10_saas_phase1.sql` (§5.1).
3. Razorpay Dashboard → Webhooks → **Add new webhook**: URL `https://<your-server>/api/v1/billing/razorpay/webhook` (must be reachable from the internet through your reverse proxy), a long random secret (also set as `RAZORPAY_WEBHOOK_SECRET`), and these events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.created`, `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed`, `subscription.activated`, `subscription.authenticated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`.
4. Restart the backend. **Internal console → Plans & pricing** (owner): set prices (plans and the credit pack) and tick **Offered for sale**.
5. Test with Razorpay's test cards / test UPI (one-time plan, monthly subscription, refund) and check **internal console → Payments** (owner, billing admin or read-only analyst; refunds and Reconcile need owner or billing admin): the order is *paid*, the webhook log shows `processed`.
6. Switch to live keys (`rzp_live_…`) and add the same webhook in Razorpay live mode; restart.

How it works: the server creates a Razorpay Order (six-month and annual plans, credit packs) or Subscription (monthly plan; the Razorpay plan is created automatically, recreated when the price changes, 120 monthly cycles authorised and cancellable); the admin pays in Razorpay's hosted Checkout (card/UPI data never reaches AgentShield). A plan activates (or a pack's credits are added) only from a payment Razorpay reports as captured for exactly the order amount and currency, confirmed by the signed checkout result plus a server-side fetch of the payment, or by the HMAC-verified webhook; each payment and each webhook event is applied once. If processing a webhook fails the server answers `500` and Razorpay retries. The backend makes outbound HTTPS calls to `api.razorpay.com` and the admin's browser loads `checkout.razorpay.com`, so allow both through any firewall or content-security policy.

### 5.5 Verification

| Check | Expected |
| :--- | :--- |
| `GET /health/ready` | `{"status":"ready","database":"connected"}` |
| `GET /api/v1/policies` without credentials | `401` |
| Invite a test account | Invite email arrives (or, in development, the link is in the backend log) |
| Sign up on the login page (**Create an account** → **Individual**: name, email, password, confirm password) | **Company** shows *Coming soon*. Signed in at once as admin of a new individual account, which sees none of your data; a confirmation email arrives (link `#verify=…` on `DASHBOARD_URL`) and a banner asks to confirm. Signing up again with the same email says the account already exists ("Sign in, or use Forgot password"). If `SIGNUP_ENABLED=false`, **Create an account** is not shown |
| New account → **Account & plan** before confirming the email | "No active plan"; **Connect browser** has code generation disabled with the reason; **Claim free 30-day trial** refused ("Confirm your email address…"). After opening the link: trial active, 30 days left; a second claim is refused |
| `POST /auth/signup` with `"account_type": "COMPANY"` | `403` `COMPANY_COMING_SOON` (while `COMPANY_SIGNUP_ENABLED=false`) |
| Credit pack priced and offered for sale; **Buy credits** with a Razorpay test card | Credits added after the payment is confirmed; **Usage & credits** shows the balance and the purchase in the credit history; with no plan the popup shows **Pay as you go** |
| Set a monthly limit of 1 in **Usage & credits**, send one prompt from an activated browser, then **Check again** | Browser locked with "monthly usage limit is reached" (`SPEND_CAP`); removing the limit unlocks it without a new code |
| `GET /internal/api/companies` with a customer admin's token, or without a token | `401` |
| `GET /api/v1/policies` with a staff session token | `401` |
| Internal console sign-in with the correct password | An authenticator code (or enrolment) is asked for; no console page opens before it |
| A staff member with a limited role (e.g. Support agent) | Sees only the pages of their permissions; other `/internal/api/*` calls return `403` |
| Without Razorpay keys: **Account & plan** | Plan buttons say **Contact AgentShield**; `POST /api/v1/billing/checkout` returns `503` |
| With test keys: buy a plan with a Razorpay test card | "Test mode: no real money is taken" shown; plan active after paying; receipt under **Billing**; **internal console → Payments** shows the order *paid* and the webhook events `processed` |
| `POST /api/v1/billing/razorpay/webhook` with a wrong signature | `400` |
| **Forgot password?** | A reset link arrives (also for a self-signed-up account); setting a new password signs out other sessions, and the internal console's account detail now shows the account as verified |
| A freshly installed, not-yet-activated browser opens chatgpt.com | **Activation Required** page |
| Dashboard → Users & Devices and Protected Browsers after activating a test browser | The browser is listed (Active / Online) within a minute |
| Revoke that browser in Users & Devices | AI sites are blocked in it again at its next request to the server (at the latest its next 5-minute sync; immediately after **Sync policies** in the popup) |
| Guided Demo steps 2–8 (demo/staging only) | All verified |

## 6. Distributing the extension

| Option | Effort | Users can remove it? | Works on | Use for |
| :--- | :--- | :--- | :--- | :--- |
| **A. System installer** `AgentShield-System-Setup.exe` (or GPO/Intune) | One run per PC, or one GPO | **No** | Chrome **and** Edge, every user | **Production** |
| **B. Folder** (`Quick-Install.bat`) | Lowest | Yes | One browser, one user | Demos, quick pilots |
| **C. Store listing** | Store review | Yes, unless also installed by A | Any PC | Selling to other companies |

Whichever option you use, the extension carries **no credential** and starts locked: every AI site shows **Activation Required** until a user activates that browser with their own account (invite or self sign-up → **My activation** → **Generate activation code** → paste the code in the popup → **Connect and verify**; the extension never asks for an email or password; see [USER_SETUP.md](./USER_SETUP.md)). The user's company must have an active licence, both to generate the code and on every later request. Installing, enabling or copying the extension, its files or its storage grants nothing.

### A. System installer (recommended)

**1. Build the package (once per release, on the server/build machine):**
```powershell
node scripts\packaging\new-extension-key.js      # first time only: creates keys\agentshield-extension.pem (BACK IT UP) and pins the extension ID
node scripts\packaging\pack-extension.js         # builds dist-installer\package\agentshield.crx, agentshield-store.zip, release.json (with zip_sha256 and zip_size)
node scripts\packaging\verify-crx.js             # optional: verifies the signature
powershell -File scripts\helper\build-helper.ps1   # builds dist-installer\helper\AgentShieldHelper.exe (the AgentShield Windows app)
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" scripts\system-installer\AgentShield-System-Setup.iss   # rebuilds the .exe
```
**Public build for individuals (2.4):** bake your addresses in so the setup asks no questions, and sign both files so Windows SmartScreen does not warn:
```powershell
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" /DDefaultServer=https://api.example.com /DDefaultDashboard=https://app.example.com scripts\system-installer\AgentShield-System-Setup.iss
signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a dist-installer\helper\AgentShieldHelper.exe   # before ISCC
signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a dist-installer\AgentShield-System-Setup.exe
```
The backend serves the file to signed-in accounts with an active plan from the portal's **Download** and **Connect browser** pages (`SYSTEM_SETUP_PATH`, default `dist-installer\AgentShield-System-Setup.exe`). On personal PCs the silent extension install needs the store copies (see "Important device requirement" below).
The backend serves the package at `/extension-updates/` (`info`, `updates.xml`, `agentshield-<version>.crx`). Set `PUBLIC_BASE_URL` to the HTTPS address PCs use. Browsers check for updates automatically, so a new release reaches every PC without reinstalling. On start, the server registers the packaged build as a release (version, SHA-256 of the zip); the portal's **Download** page shows it with its checksum and notes, and staff with `releases.manage` (owner, platform admin) manage releases in **internal console → Extension releases** (publish version, notes, SHA-256, minimum Chrome/Edge version, make current).

**2. Install on PCs (as Administrator):**
* Interactive: run `dist-installer\AgentShield-System-Setup.exe`, enter the server address (`https://...`), finish. Restart the browsers.
* Silent (Group Policy startup script, Intune Win32 app, SCCM, PDQ):
  ```
  AgentShield-System-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVER=https://agentshield.company.com [/DASHBOARD=https://...] [/BLOCKDEVTOOLS]
  ```
  `/SERVER` is the backend address; `/DASHBOARD` is optional (the dashboard address shown to users, if different). The dashboard's Deployment page shows this command with your server filled in. Exit code 0 = success; details in `C:\ProgramData\AgentShield\install.log`.
* Without the .exe: `powershell -ExecutionPolicy Bypass -File scripts\system-installer\Install-AgentShield.ps1 -ServerUrl https://agentshield.company.com [-DashboardUrl https://...]`.
* Uninstall: Settings > Apps > AgentShield (removes only AgentShield's policy entries).

The installer force-installs the extension for every user in Chrome, Edge and Brave and installs the **AgentShield Windows app**, but it carries no credential. Each Windows user connects the PC once (the setup's last page, **Connect AgentShield** in the Start menu, or the portal's **Connect this PC** button; silent installs can pass `/CODE=ASA1.…` for the installing user), and every browser of that user then connects by itself. A connected PC uses one device of the plan.

Besides the policies below it writes: `HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.agentshield.helper`, the same under `Microsoft\Edge` and `BraveSoftware\Brave-Browser` (pointing at `C:\Program Files\AgentShield\com.agentshield.helper.json`, which allows only the AgentShield extension IDs), the `agentshield://` link handler (`HKLM\SOFTWARE\Classes\agentshield`) and `HKLM\SOFTWARE\AgentShield` (server and portal address). Uninstall disconnects the PC and removes all of it.

What it writes (existing policy entries are preserved), for `HKLM\SOFTWARE\Policies\Google\Chrome`, `...\Microsoft\Edge` and `...\BraveSoftware\Brave`:

| Policy | Value |
| :--- | :--- |
| `ExtensionInstallForcelist` | `<extension id>;<update URL>` (from the dashboard's Deployment page) |
| `ExtensionInstallAllowlist` | `<extension id>` |
| `3rdparty\extensions\<id>\policy\apiUrl` | the server address (`/SERVER`) |
| `3rdparty\extensions\<id>\policy\dashboardUrl` | the dashboard address, only with `/DASHBOARD` |
| `DeveloperToolsAvailability` | `2`, only with `/BLOCKDEVTOOLS` |

When IT sets `apiUrl`, the extension refuses activation codes issued by any other server.

**Pure Group Policy (Active Directory) alternative:** import the Chrome and Edge ADMX templates, set *Configure the list of force-installed apps and extensions* (`ExtensionInstallForcelist`) to the value shown in the dashboard, and deploy the extension policies `apiUrl` and, optionally, `dashboardUrl` as `3rdparty` registry values with Group Policy Preferences > Registry. No other extension policy is used.

**Important device requirement.** Chrome and Edge only force-install a **self-hosted** extension on PCs that are joined to Active Directory or Microsoft Entra ID, or enrolled in Intune/MDM (Chrome also accepts Chrome Browser Cloud Management: pass `-ChromeEnrollmentToken` to the script). On other PCs the policy is shown in `chrome://policy` but the extension is not installed; the installer warns about this. To support unmanaged PCs, publish to the Chrome Web Store (unlisted) and Edge Add-ons (option C), then set `CHROME_STORE_EXTENSION_ID` and `EDGE_STORE_EXTENSION_ID` on the server: the same installer then force-installs the store copies, which works on any Windows PC.

### B. Folder
Build the extension (`node build.js`), copy `extension/` and `dist-installer/` to a share, and invite the users (or let them create an account). `Quick-Install.bat` copies the extension and opens the Extensions page for the one-time "Load unpacked"; each user then activates the browser in the popup. No credential is needed or stored in the folder.

### C. Store listing
Upload `dist-installer\package\agentshield-store.zip` (the signing key field is removed; stores assign their own ID). Store review requires a privacy policy; [DATA_HANDLING.md](./DATA_HANDLING.md) contains the facts it must state. Employees can install from the store link and activate it with their own account, or IT force-installs it with option A.

### Covering "the whole system"
AgentShield protects Chrome and Edge. To make sure employees cannot simply use another browser or app: block other browsers with AppLocker / Intune app control, and optionally block AI websites at your firewall or DNS filter for anything that is not Chrome/Edge.

### What never goes into the extension package

No API secrets, admin credentials, device keys or private keys. The only organization-specific values are the server address (`apiUrl`) and, optionally, the dashboard address (`dashboardUrl`), set by the installer or managed policy. The access credential is created per browser at activation: a non-extractable ECDSA P-256 key pair generated in the browser (WebCrypto, kept in IndexedDB), of which the server stores only the public key. Sessions (15 minutes, `DEVICE_SESSION_MINUTES`) are obtained by signing a one-time server challenge and live only in memory / `chrome.storage.session`.

## 7. Upgrades

1. Back up the database.
2. Run any new file in `backend/migrations/` (Supabase) — the backend also adds new tables/columns on start.
3. Deploy the backend, rebuild the dashboard (and the internal admin console), rebuild the extension and bump `manifest.json` `version`.
4. Browsers pick up new rules automatically; a new extension version needs re-distribution (store or policy updates are automatic).

### Upgrading to 2.4.0 (AgentShield for Windows: one connection for every browser)

* **Database:** Supabase: run `backend/migrations/2026_10_windows_app.sql` **after** `2026_10_free_tier.sql` (table `computers` with RLS, columns `devices.computer_id` and `activation_tokens.computer_id`). Safe to run more than once; the backend also does this on start.
* **Plans:** device limits now count a connected PC once, whatever its number of browsers; browsers connected with their own code count as before. New optional setting `MAX_BROWSERS_PER_COMPUTER` (10).
* **Extension 1.8.0** adds the `nativeMessaging` permission. Store installs ask users to accept the new permission once; force-installed copies get it automatically. Rebuild and publish the package as usual.
* **Windows setup:** rebuild with `scripts\helper\build-helper.ps1` and ISCC (public build: `/DDefaultServer` and `/DDefaultDashboard`), sign both .exe files, and publish the setup on the server. PCs installed with an older setup keep working; run the new setup to get the Windows app and Brave.

### Upgrading to 2.1.0 (Individual launch, Company coming soon)

* **Database:** Supabase: run `backend/migrations/2026_10_individual_launch.sql` **after** `2026_10_internal_console.sql`. It adds `organizations.account_type` (existing tenants become `COMPANY`), `organizations.credit_balance` (with a CHECK constraint against negative balances), `organizations.monthly_check_cap`, `users.display_name`, `security_events.client_event_id` (unique per organization), `plans.credits`, `plans.check_limit`, the tables `usage_daily`, `credit_ledger`, `api_tokens` (RLS enabled), and the `credits_1000` pack without a price. Safe to run more than once; the backend also does this on start.
* **`.env`:** add `COMPANY_SIGNUP_ENABLED=false` and `CREDITS_DEVICE_LIMIT=3` (both defaults), check `DASHBOARD_URL`, `SIGNUP_ENABLED`, `TRIAL_DAYS`. **SMTP is now needed for sign-up** (confirmation emails; the free trial requires a confirmed email). See `.env.production.example`.
* **Compose fix:** `docker-compose.prod.yml` and `docker-compose.supabase.yml` now pass `DASHBOARD_URL`, `SIGNUP_ENABLED`, `COMPANY_SIGNUP_ENABLED`, `TRIAL_DAYS`, `CREDITS_DEVICE_LIMIT`, `SMTP_*`, `RAZORPAY_*` and `BILLING_SELLER_*` to the backend; they were missing before, so check that the values in your `.env` are what you want before restarting.
* **Internal console → Plans & pricing** (owner): set the credit pack's price and tick **Offered for sale** to sell credits; optionally set **Included prompt checks per month** on the trial and paid plans (empty = unlimited, the previous behaviour).
* **Rebuild** the dashboard (Individual / Company-coming-soon sign-up, confirmation banner, personal navigation, Usage & credits, API connections, Profile & security, credit packs, lock banners) and the internal console (Accounts page with usage and credits, Platform health, plan credits and included checks).
* **Extension 1.5.0:** rebuild and distribute it (`client_event_id` on every event; understands `CREDITS_ACTIVE`, `USAGE_LIMIT`, `SPEND_CAP`, `NO_CREDITS`). Existing activations are kept. Older extensions without `client_event_id` are still metered; for them only identical submissions within 3 seconds are ignored, so a replay after a longer offline period can be counted again.
* **Behaviour changes:** new self sign-ups are Individual accounts (one person; no invites or company management, 403 `COMPANY_FEATURE_UNAVAILABLE`); existing company workspaces keep every company feature. The one-trial-per-company-domain rule now applies only to company workspaces. Accounts that signed up under 1.5.x without confirming their email must confirm it before claiming a trial (they can **Send a new link**).
* **Limits:** metering counts only what activated extensions report (a modified extension could under-report; protection still stops server-side when access ends); the offline queue holds at most 500 events; the usage month is the UTC calendar month; credits never expire; no proration; receipts only, no invoices.

### Upgrading to 2.0.0 (internal admin console, staff roles and MFA, Phase A)

* **Database:** Supabase: run `backend/migrations/2026_10_internal_console.sql` **after** `2026_10_saas_phase2.sql`. It adds `admin_audit_log.actor_type`, the tables `staff_users`, `staff_recovery_codes`, `staff_invites` (RLS enabled), and converts every `SUPERADMIN` customer account to `ADMIN`. Safe to run more than once; the backend also does all of this on start.
* **`SECRET_KEY` is now required** and has no default (production refuses to start without a strong one; development without it uses a random key per restart). Keep your existing value: changing it signs everyone out.
* **Optional `STAFF_MFA_KEY`:** set a separate random key now if you want to be able to rotate `SECRET_KEY` later. Without it, rotating `SECRET_KEY` makes the stored authenticator secrets unreadable: authenticator codes stop working, staff sign in with a recovery code, and an owner resets the others' authenticators (an owner cannot reset their own; another owner must).
* **`INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` are optional** and have no defaults. On an existing server you can keep them (the account stays ADMIN of its company and that company keeps its internal licence) or remove them; nothing is created unless both are set. The compose files no longer require them.
* **The old SUPERADMIN login no longer opens platform pages.** That account remains ADMIN of its own company in the customer portal. The portal's platform console and demo-login buttons are gone; rebuild the dashboard (`VITE_SHOW_DEMO_LOGINS` is no longer used).
* **Deploy the internal console** (§5.2): `cd admin-console; npm install; npm run build` with `VITE_API_BASE_URL` set, serve `dist/` on its own HTTPS origin, add that origin to `ALLOWED_ORIGINS`, set `ADMIN_CONSOLE_URL` (and `STAFF_MFA_KEY` if used; the compose files pass both through), restart the backend.
* **Create the platform owner** with `python -m app.cli create-platform-owner --email you@yourcompany.com` (§5.3), sign in, enrol MFA, save the recovery codes, change the temporary password, then invite other staff.
* **Licence grants changed:** granting a paid or internal plan, or extending a non-trial licence, without a verified payment is now an owner-only exception with a reason (`payment_ref = exception:<staff>`, audit `platform.license_exception`). Platform admins can still grant and extend trials.
* **Demo accounts:** the application no longer creates any. If your database was created with `SUPABASE_SETUP.sql`, check for `admin@agentshield.local` / `auditor@agentshield.local` and disable or delete them in production (the portal flags accounts still using a published password).
* No extension change. Limits (Phase A): staff lockout and rate limits are per process; staff MFA is TOTP only (no WebAuthn); the staff session token is kept in `sessionStorage`; customer analytics, support and operations pages are not built yet.

### Upgrading to 1.5.1 (sign-up without email confirmation)

* No migration. Rebuild the dashboard (the sign-up form asks only for email, password and confirm password; no "Check your email" screen or "resend" button) and redeploy the backend.
* Sign-up no longer sends email or needs SMTP; invites, password reset and reminders still do. Accounts that signed up but never confirmed under an older version can now sign in directly; old confirmation links still work.
* Email verification no longer gates sign-in, the trial, activation codes or browser activation (disabled accounts are still refused). (Changed again in 2.1: the trial requires a confirmed email.) The startup step that marked old accounts verified was removed; `email_verified_at` is now informational (shown in the platform console; since 2.0 the internal console) and is set when a password-reset link is used.
* Limits: anyone can sign up with an address they don't own, so a squatter can use up a domain's one trial (grant a licence to the real company instead) or block the real owner's sign-up (the owner recovers the account with **Forgot password?**). Sign-up reveals whether an email has an account (409), limited by the sign-up rate limit. On a private server, `SIGNUP_ALLOWED_DOMAINS` or `SIGNUP_ENABLED=false` avoids these.

### Upgrading to 1.5.0 (SaaS phase 2: Razorpay payments)

* Supabase: run `backend/migrations/2026_10_saas_phase2.sql` **after** `2026_10_saas_phase1.sql`. It adds the tables `billing_orders`, `billing_payments`, `billing_subscriptions`, `webhook_events` (RLS enabled) and the columns `plans.razorpay_plan_id`, `plans.razorpay_plan_amount`. Safe to run more than once.
* New settings (§2): `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_API_BASE`, `BILLING_SELLER_NAME`, `BILLING_SELLER_DETAILS`. Without the Razorpay keys nothing changes for customers: payment stays off and the platform operator keeps granting licences by hand.
* To sell online, follow §5.4 (test keys first, webhook with the event list, prices and **Offered for sale**, then live keys).
* Rebuild the dashboard (new Buy/Subscribe flow, **Billing** section, **Platform console → Payments**). No extension change is needed for payments.
* Limits: receipts are payment receipts, not GST tax invoices; no proration when switching plans; Reconcile re-checks one-time orders only (monthly charges rely on webhooks); not yet run end-to-end against Razorpay test mode with live webhooks.

### Upgrading to 1.4.0 (SaaS phase 1: companies, trials, licences)

* Supabase: run `backend/migrations/2026_10_saas_phase1.sql` **after** `2026_10_accounts_activation.sql`. It adds the tables `plans`, `licenses`, `trial_claims`, `license_adjustments`, `notifications`, `extension_releases` and the columns `organizations.suspended_at`, `organizations.suspended_reason`, `users.session_version`, `email_verifications.purpose`. The backend also creates them on start.
* On start, the `INITIAL_ADMIN_EMAIL` account becomes SUPERADMIN, and its company gets a non-expiring **internal** licence, so an existing single-company setup keeps working. Other existing companies have **no licence** until the platform operator grants one (**Platform console → Customers → Grant licence**) or their admin claims the trial; until then their browsers are locked.
* **Create an account** now creates a new company (ADMIN role) instead of adding an EMPLOYEE to the server's organization. On a private server that should not accept other companies, set `SIGNUP_ENABLED=false` (or `SIGNUP_ALLOWED_DOMAINS`), and add employees by invite.
* New settings (§2): `TRIAL_DAYS`, `TRIAL_CLAIMS_PER_IP_30D`, `REMINDER_LOOP_ENABLED`, `PASSWORD_RESET_EXPIRE_MINUTES`, `DASHBOARD_TOKEN_HOURS`.
* Set prices in **Plans & pricing** before offering paid plans (none are preset). Online payment came in 1.5.0 (above).
* Rebuild and distribute extension 1.4.0 (it understands the licence states `TRIAL_ACTIVE` / `SUBSCRIPTION_ACTIVE` and the codes `NO_LICENSE`, `LICENSE_EXPIRED`, `LICENSE_REVOKED`, `ORG_SUSPENDED`, `DEVICE_LIMIT`). Existing activations are kept.
* Limits: expiry, revocation and suspension reach a browser at its next server request (sessions last at most 15 minutes, sync every 5 minutes); in-memory rate limits are per process; trial-abuse controls can be beaten by someone using new emails, domains and networks.

### Upgrading to 1.3.0 (breaking: browser activation)

* Organization-wide enrollment codes (`ASE1.…`) and device keys are retired. After the upgrade the server rejects them (`401`), and `/api/v1/org/device-keys` returns `410`. **Every browser must be activated again.**
* Supabase: run `backend/migrations/2026_10_accounts_activation.sql` (it also creates the `email_verifications` table; the backend also creates the tables on startup). (Since 1.5.1, email verification no longer affects access; see above.)
* Decide on self sign-up: set `SIGNUP_ALLOWED_DOMAINS` (or `SIGNUP_ENABLED=false`), and optionally turn on **Require admin approval for new browsers**.
* Configure SMTP (§2) and invite every employee (or tell them to create an account) **before** the upgrade, so they can activate as soon as the new extension arrives. Until a browser is activated, all AI sites are blocked in it.
* Re-run the system installer with `/SERVER=` (or update your GPO to set `apiUrl`) so the old `enrollmentCode` policy is replaced.
* Emergency only: `LEGACY_DEVICE_KEYS_ENABLED=true` temporarily re-accepts old device keys. Turn it off once browsers are activated.
