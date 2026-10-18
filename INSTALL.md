# AgentShield — Installation & Setup Guide

This guide takes you from nothing to protected PCs. Follow the parts in order.

| Part | Who | How often | Time |
| :--- | :--- | :--- | :--- |
| [1. Set up the server](#part-1--set-up-the-server-once) | IT administrator | Once | 30–60 min |
| [2. Configure in the portal](#part-2--configure-in-the-portal-once) | IT administrator | Once | 10 min |
| [3. Download and install on PCs](#part-3--download-from-the-portal-and-install-on-pcs) | IT (or each employee for manual install) | Per PC / once per GPO | 2 min per PC |
| [4. Activate each browser](#part-4--activate-each-browser) | Each employee | Once per browser | 2 min |
| [5. Check it works](#part-5--check-that-it-works) | IT | After each install | 2 min |

The **portal** is the AgentShield admin dashboard in a web browser, e.g. `https://agentshield.yourcompany.com` (or `http://localhost:5173` when testing on one PC). It is for customer companies only.

The **internal console** (version 2.0.0 and later) is a separate web app for the people who run the AgentShield service itself (staff), on its own address, e.g. `https://admin.yourcompany.com` (or `http://localhost:5175`). Companies, licences, payments, plans and prices, extension releases and the platform-wide audit log are managed there, by separate staff accounts that must use an authenticator app. There are no built-in logins anywhere: the first staff account is created with a command (1.8).

> **How access works (version 1.3.0 and later).** Installing the extension grants nothing. Until a browser is activated by a signed-in user, AgentShield blocks every AI site (ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral, Poe, Meta AI, Grok, AI Studio, OpenAI) with an **Activation Required** page. Every person gets an account, either from an admin's **email invite** or by **creating one on the portal's sign-in page** (email + password; signed in straight away; since 2.1 a confirmation link is emailed and must be opened before the free trial), and activates each of their browsers by pasting a **single-use activation code** generated in the portal. The extension never asks for an email or password. Organization-wide enrollment codes no longer exist.
>
> **Individual accounts and usage (version 2.1.0).** **Create an account** now creates an **Individual** account (one person, its own admin); **Company** shows *Coming soon* and company sign-ups are refused unless `COMPANY_SIGNUP_ENABLED=true`. Company workspaces that already exist (and the initial company) keep inviting employees and every company feature. An account is protected while it has an active plan whose included monthly prompt checks are not used up, or prepaid **credits**; it can also set its own monthly limit. When any of these runs out, its browsers lock at their next request and unlock by themselves after renewal or a top-up. Operators set the credit pack's price and, optionally, included checks per plan in the internal console (1.9).
>
> **Companies and plans (version 1.4.0, "SaaS phase 1").** **Create an account** on the sign-in page created a new **company** (until 2.1) (named automatically from the email): the person who signs up becomes the **admin of their own company** (own rules, events, users and browsers; companies never see each other's data) and can invite colleagues into it. A company can only use AgentShield while it has an **active licence**: a free 30-day trial (claimed once per company on **Account & plan**), a paid plan (bought online, or granted by the platform owner in the internal console), or the non-expiring *internal* licence of the initial company created from `INITIAL_ADMIN_EMAIL`. The server checks the licence on every extension request; when it ends, the company's browsers are locked (AI sites blocked) until a new licence is active, then reconnect by themselves without reinstalling or reactivating.

---

## The easiest way (recommended)

**Host the server online once, publish the extension to the browser stores once, invite your people, then each PC takes about two minutes.**

| Step | Done by | Time | Details |
| :--- | :--- | :--- | :--- |
| 1. Put the server online with an HTTPS address, with email (SMTP) configured | IT, once | ~1 hour | Part 1 below (Docker on a small cloud server + Supabase) |
| 2. Publish the extension to Chrome Web Store (Unlisted) and Edge Add-ons | IT, once | 1–3 days store review | [3.4](#34-optional-publish-to-the-chrome-web-store-and-edge-add-ons) |
| 3. Create an account and start a plan | Each customer | 5 minutes | **Create an account** → **Individual** (name, email, password) → signed in → open the confirmation link from the email → **Account & plan** → **Claim free 30-day trial**, buy a plan or **Buy credits** (or AgentShield staff grant a paid licence) |
| 4. Invite employees (existing company workspaces only) | Company admin | 1 minute each | Portal → **Users & Devices** → **Invite someone**. Each person gets an email link, sets a password and joins *your* company. (Employees must not use **Create an account**: that makes a separate individual account) |
| 5. Employees install and activate | Each employee | ~2 minutes | **Add to Chrome** from the store link (or the portal's **Download** page), then [Part 4](#part-4--activate-each-browser) |

Why this is easiest:

| Method | Steps per PC | Works on PCs not joined to a domain/Intune? |
| :--- | :--- | :--- |
| **Store link + activation** | Add to Chrome, activate (~2 min) | ✅ Yes (after publishing) |
| Portal download `.zip` + activation | Unzip, Developer mode, Load unpacked, activate (~4 min) | ✅ Yes, today |
| Portal download `.exe` (system installer) + activation | IT runs it once per PC or via GPO/Intune; each employee still activates their browser | ✅ after publishing; before that only on domain/Intune PCs |

Until the store approves the extension, use the portal's `.zip` download ([3.2](#32-manual-install-one-pc-pilots-pcs-not-managed-by-it)). After approval, the `.exe` also works on every PC, so IT can switch to fully automatic installs.

---

## Part 1 — Set up the server (once)

### 1.1 What you need

| Item | Details |
| :--- | :--- |
| A server or PC that stays on | Windows or Linux. Python 3.10+ and Node.js 18+ (or Docker). |
| A database | **Supabase** (free tier is fine to start) or PostgreSQL. SQLite only for testing. |
| A web address | An **HTTPS** address every employee PC can reach, e.g. `https://agentshield.yourcompany.com`. `localhost` works only on the server itself. |
| An email account for sending | Any SMTP server (Microsoft 365, Google Workspace, your mail relay). Sign-up confirmation links, invites, password-reset links and plan reminders are sent by email. |
| Inno Setup 6 (Windows) | Only on the machine that builds the `.exe` installer. Free: https://jrsoftware.org/isinfo.php |

### 1.2 Configure `.env`

Copy `.env.production.example` to `.env` in the project folder and fill in:

| Setting | What to put | Required |
| :--- | :--- | :--- |
| `ENVIRONMENT` | `production` | Yes |
| `SECRET_KEY` | Output of `python scripts/generate_secret_key.py`. There is no default; the server refuses to start in production without a strong key | Yes |
| `DATABASE_URL` | Supabase: Project Settings → Database → Connection string (URI, pooler port 6543) | Yes |
| `INITIAL_ORG_NAME`, `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | Optional, no defaults. If **both** email and password are set, the first start creates a first customer company (`INITIAL_ORG_NAME`) with that account as its admin (password at least 14 characters), and that company gets a non-expiring *internal* licence. This account has no platform rights. Leave empty if every company signs up itself | No |
| `ADMIN_CONSOLE_URL` | The internal console's HTTPS address, e.g. `https://admin.yourcompany.com` (used in staff invite emails) | Yes, for the internal console |
| `STAFF_MFA_KEY` | Recommended: a second random key (generate like `SECRET_KEY`) that encrypts staff authenticator secrets. If empty, it is derived from `SECRET_KEY`, so changing `SECRET_KEY` later makes the stored authenticator secrets unreadable and authenticator codes stop working: staff then sign in with a recovery code and an owner resets the others' authenticators (an owner cannot reset their own; another owner must) | No |
| `PUBLIC_BASE_URL` | The HTTPS address PCs use, e.g. `https://agentshield.yourcompany.com` | Yes |
| `ALLOWED_ORIGINS` | The portal's address **and** the internal console's address, comma-separated, e.g. `https://agentshield.yourcompany.com,https://admin.yourcompany.com` | Yes |
| `SMTP_HOST`, `SMTP_PORT` (`587`), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_STARTTLS` (`true`) | Your outgoing mail server. Without it, in production sign-up confirmation emails cannot be sent (accounts are created but cannot confirm their email, so they cannot claim the trial), inviting people and password resets fail ("email not configured"), and plan reminders are not emailed | Yes, in production |
| `DASHBOARD_URL` | The portal address used in confirmation, invite, password-reset and reminder emails, if different from `PUBLIC_BASE_URL` | Recommended |
| `SIGNUP_ENABLED` | `true` (default): the sign-in page offers **Create an account**, which creates an **Individual** account. `false`: hidden and refused, so only admin invites create accounts | No |
| `COMPANY_SIGNUP_ENABLED` | `false` (default): the **Company** option is *Coming soon* and company sign-ups are refused (403 `COMPANY_COMING_SOON`). Keep it `false` until company onboarding ships | No |
| `TRIAL_DAYS` | `30`: free-trial length when the plans are first created (later edit it in **Plans & pricing**). The trial starts only after the email is confirmed | No |
| `CREDITS_DEVICE_LIMIT` | `3`: browsers an account may connect while it runs on prepaid credits only | No |
| `SIGNUP_ALLOWED_DOMAINS` | Comma list, e.g. `motwane.com`. If set, only those email domains can sign up. Leave empty for a public self-serve service; set it (or `SIGNUP_ENABLED=false`) for a private, single-company server | No |
| `DEMO_MODE` | `false` (or `true` for a demo server) | No |
| `CHROME_STORE_EXTENSION_ID`, `EDGE_STORE_EXTENSION_ID` | Only after publishing to the stores (see 3.4). When set, the portal's **Download** page shows the store link instead of the `.zip` | No |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys (Razorpay Dashboard → Account & Settings → API Keys), e.g. `rzp_test_xxxxxxxx` and its secret. Both must be set, otherwise online payment is switched off and the portal shows "Contact AgentShield". A key id starting `rzp_test_` means **test mode** (no real money). See 1.7 | Only to sell plans online |
| `RAZORPAY_WEBHOOK_SECRET` | The secret you type when adding the webhook in Razorpay (see 1.7). Without it every webhook is rejected | With Razorpay keys |
| `BILLING_SELLER_NAME`, `BILLING_SELLER_DETAILS` | Seller name (default `AgentShield`) and details (e.g. address) printed on payment receipts and shown in Checkout | No |

Optional limits (defaults are fine): `INVITE_EXPIRE_HOURS` (72), `EMAIL_VERIFY_EXPIRE_HOURS` (24, lifetime of sign-up confirmation links), `PASSWORD_RESET_EXPIRE_MINUTES` (60), `DASHBOARD_TOKEN_HOURS` (12, portal sign-in lifetime), `ACTIVATION_TOKEN_EXPIRE_MINUTES` (30), `DEVICE_SESSION_MINUTES` (15), `MAX_DEVICES_PER_USER` (3), `STAFF_TOKEN_HOURS` (8, internal console sign-in lifetime).

Plans and trials (defaults are fine): `TRIAL_CLAIMS_PER_IP_30D` (3, trial claims per network per 30 days), `REMINDER_LOOP_ENABLED` (`true`, hourly plan-reminder job).

The server refuses to start in production with a missing, short or default secret key, or an `INITIAL_ADMIN_PASSWORD` shorter than 14 characters. Passwords published by older releases are refused as new passwords. `DEMO_AUDITOR_PASSWORD` (a read-only demo account) is for development only; leave it empty.

### 1.3 Prepare the database

* **New Supabase project:** Supabase → SQL Editor → paste and run `SUPABASE_SETUP.sql`, then `backend/migrations/2026_10_accounts_activation.sql`, then `backend/migrations/2026_10_saas_phase1.sql`, then `backend/migrations/2026_10_saas_phase2.sql`, then `backend/migrations/2026_10_internal_console.sql`, then `backend/migrations/2026_10_individual_launch.sql`. **Warning:** `SUPABASE_SETUP.sql` also inserts two demo accounts whose passwords are published (`admin@agentshield.local`, `auditor@agentshield.local`). They are for local testing only: on a real server delete them right after running it (or remove that seed section before running it).
* **Existing AgentShield database:** run, in order, `backend/migrations/2026_10_production_hardening.sql`, `backend/migrations/2026_10_enterprise_features.sql`, `backend/migrations/2026_10_accounts_activation.sql`, `backend/migrations/2026_10_saas_phase1.sql`, `backend/migrations/2026_10_saas_phase2.sql` (payments), `backend/migrations/2026_10_internal_console.sql` (internal console) and `backend/migrations/2026_10_individual_launch.sql` (2.1: account types, usage, credits, API tokens; each is safe to run more than once).
* **Plain PostgreSQL:** nothing to do; tables are created on first start.

The backend also creates the account, invite, email-verification, activation-code and device tables, the 1.4.0 plan, licence, trial-claim, licence-change, notification and release tables, the 1.5.0 billing order, payment, subscription and webhook-event tables, the 2.0.0 staff tables, and the 2.1.0 usage, credit-ledger and API-token tables and new columns, on startup, and seeds the `credits_1000` credit pack (1,000 prompt checks, **no price**: it is not sold until you price it, 1.9). Since 2.1, self-registered accounts can sign in, buy and activate browsers before confirming their email, but the free trial needs the emailed confirmation link (a password-reset link also confirms it; the internal console shows whether an account is verified). Existing companies become **Company** workspaces and keep their features. If `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` are set, that account's company gets a non-expiring *internal* licence, so an existing single-company setup keeps working after the upgrade. Accounts that had the old SUPERADMIN role become ordinary company admins.

> **Upgrading from 1.2 or earlier:** old enrollment codes and device keys stop working (browsers get `401`). Every browser must be activated again (Part 4). Invite your employees (or tell them to create an account) before you upgrade so they can activate straight away.

### 1.4 Build the extension and the installer

Run in the project folder (Windows PowerShell):

```powershell
# First time only: creates the signing key that fixes the extension's identity.
# BACK UP keys\agentshield-extension.pem — if lost, every PC must be reinstalled.
node scripts\packaging\new-extension-key.js

# Every release: builds and signs the extension package
cd extension; npm install; cd ..
node scripts\packaging\pack-extension.js

# Builds the Windows installer offered for download in the portal
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" scripts\system-installer\AgentShield-System-Setup.iss
```

Results: `dist-installer\package\` (extension files, plus `release.json` with the version, the zip's SHA-256 `zip_sha256` and size `zip_size`) and `dist-installer\AgentShield-System-Setup.exe`. The server offers both for download automatically, and registers the packaged build as a release on start (shown on the portal's **Download** page and in **internal console → Extension releases**).

### 1.5 Start the server

**Docker (recommended):**
```bash
docker compose -f docker-compose.supabase.yml up -d --build
```
Put an HTTPS reverse proxy (IIS, nginx, Caddy or your cloud load balancer) in front of it. Since 2.1 the compose files pass `DASHBOARD_URL`, `SIGNUP_ENABLED`, `COMPANY_SIGNUP_ENABLED`, `TRIAL_DAYS`, `CREDITS_DEVICE_LIMIT`, the `SMTP_*`, `RAZORPAY_*` and `BILLING_SELLER_*` settings from `.env` to the backend (before 2.1 these were missing from the compose files); `SMTP_STARTTLS`, `RAZORPAY_API_BASE` and other settings not listed in the compose file's `environment:` still need to be added there if you change them.

**Without Docker (Windows):**
```powershell
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# Portal (second window): build once, then serve dashboard\dist with your web server
cd dashboard; npm install; npm run build

# Internal console (third window): build once, then serve admin-console\dist on its own HTTPS address
cd admin-console; npm install; npm run build
```
The Docker compose files do not include the internal console: build it as above (set `VITE_API_BASE_URL` to an API address that answers `/internal/...` before `npm run build`, or let the console's web server forward `/internal/` to the backend) and serve `admin-console\dist` on its own address, never under the portal's address. If you can, limit access to it (VPN or IP allow-list).

For a quick test on one PC you can run the portal with `npm run dev` (http://localhost:5173) and the internal console with `cd admin-console; npm run dev` (http://localhost:5175). Without SMTP in development, invite, staff-invite and password-reset links are printed to the backend console instead of emailed.

### 1.6 Check the server

Open these in a browser:

| Address | Expected |
| :--- | :--- |
| `https://<your server>/health/ready` | `"status":"ready","database":"connected"` |
| `https://<your server>/extension-updates/info` | Shows the extension version and ID |

### 1.7 Turn on online payments (Razorpay, optional)

Without this, everything else works and the platform owner grants paid plans by hand (**internal console → Companies → Grant licence**, an audited exception that needs a reason such as the invoice number). Customers pay in Razorpay's own hosted Checkout window, so card and UPI details never reach your server.

1. **Create a Razorpay account** at razorpay.com and complete its business verification (needed for live payments, not for test mode).
2. **Get test API keys first:** Razorpay Dashboard (Test mode) → Account & Settings → API Keys → Generate. Put them in `.env`: `RAZORPAY_KEY_ID=rzp_test_xxxxxxxx` and `RAZORPAY_KEY_SECRET=<key secret>`. Never commit them or paste them anywhere else.
3. **Run the migration** `backend/migrations/2026_10_saas_phase2.sql` in the Supabase SQL Editor (after `2026_10_saas_phase1.sql`; see 1.3).
4. **Add the webhook:** Razorpay Dashboard → Account & Settings → Webhooks → Add new webhook:
   * URL: `https://<your-server>/api/v1/billing/razorpay/webhook`
   * Secret: a long random value; put the same value in `RAZORPAY_WEBHOOK_SECRET`.
   * Active events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.created`, `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed`, `subscription.activated`, `subscription.authenticated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`.
5. **Restart the server** so it reads the new settings.
6. **Set prices:** sign in to the internal console as the platform owner → **Plans & pricing**: give each paid plan and the credit pack a price and tick **Offered for sale**. Six-month and annual plans and credit packs are one-time payments; the monthly plan renews automatically (the matching Razorpay plan is created for you, and created again when you change the price). See 1.9 for credits and included checks.
7. **Test:** in a test company, **Account & plan** shows "Test mode: no real money is taken". Buy a plan with Razorpay's test cards or test UPI ID, check that the plan becomes active, the receipt opens under **Billing**, and **internal console → Payments** shows the order and the webhook events as `processed`. Try a refund from the Payments page (platform owner or billing admin).
8. **Go live:** generate live keys in Razorpay (Live mode), replace both keys in `.env` (`rzp_live_…`), add the same webhook in Live mode (the webhook secret may differ; update `RAZORPAY_WEBHOOK_SECRET`), and restart.

### 1.8 Create the first internal console account (platform owner)

There is no built-in staff login. Create the first one with a command, on a machine that reaches the production database, in the `backend` folder with the same settings as the server (`ENVIRONMENT`, `DATABASE_URL`, `SECRET_KEY`, `STAFF_MFA_KEY` if used). With Docker: `docker compose -f docker-compose.supabase.yml exec backend python -m app.cli create-platform-owner --email you@yourcompany.com`.

```powershell
cd backend
.venv\Scripts\python.exe -m app.cli create-platform-owner --email you@yourcompany.com --name "Your Name"
```

1. It prints a **temporary password once** (it is not stored in readable form and will not be shown again). If an owner already exists it refuses; `--force` adds another owner deliberately.
2. Open the internal console (`ADMIN_CONSOLE_URL`) and sign in with the email and the temporary password.
3. **Set up your authenticator app** (Google Authenticator, Microsoft Authenticator or similar): scan the QR code, or type the key shown under it, then enter the 6-digit code.
4. **Save the 10 recovery codes** shown next (copy them to a password manager or print them). They are shown only once; each works once, for signing in without your phone.
5. **Choose a new password** (at least 14 characters). Only then do the console pages open.
6. **Staff & roles → Invite** colleagues with the least role they need (Platform admin, Security analyst, Support agent, Billing administrator, Read-only analyst; see README "Authentication model" for what each can do). Each gets a single-use link valid 48 hours by email (SMTP needed; in development the link is printed in the backend console), sets a password and must set up an authenticator.

Lost phone: another platform owner resets that person's authenticator in **Staff & roles** (an owner cannot reset their own), or the person signs in with a recovery code. Five wrong passwords lock a staff account for 15 minutes. Staff sessions last 8 hours.

### 1.9 Set up plans, credits and usage limits (2.1.0)

As the platform owner, in **internal console → Plans & pricing**:

1. **Credit pack:** the `credits_1000` pack ("1,000 prompt checks") is created without a price. Set **Prompt checks per pack** if you want a different size, a **Price** and **Currency**, and tick **Offered for sale**. Customers then see **Buy credits** on **Account & plan** (needs online payment, 1.7). A credit is one prompt check; credits never expire.
2. **Included checks (optional):** on the trial and paid plans, **Included prompt checks per month** limits how many prompt checks the plan covers per UTC calendar month. Leave it empty for unlimited (the default). When an account uses them up, further checks use its credits; without credits its browsers lock (`USAGE_LIMIT`) until next month, a top-up or an upgrade.
3. **Browser limit while on credits only:** `CREDITS_DEVICE_LIMIT` in `.env` (default 3).

Customers can also set their own monthly limit in **Usage & credits**. Staff watch usage and credits in **Accounts** (and **Overview**); adding credits without a payment is an owner-only, audited exception with a reason, removing credits needs a platform admin or owner.

Check SMTP before opening sign-up: sign up a test **Individual** account and confirm that the confirmation email arrives and its link (`#verify=…`) opens the portal on `DASHBOARD_URL`.

---

## Part 2 — Configure in the portal (once)

There are two kinds of admin, in two separate apps:

* **AgentShield staff** (internal console, not the portal) — separate staff accounts with an authenticator app (1.8). The platform owner sets plan names, browser limits and prices in **internal console → Plans & pricing** before paid plans are offered (no prices are preset). Customer accounts, including the former SUPERADMIN account, cannot open the internal console.
* **Individual account** (2.1, the public sign-up) — anyone who used **Create an account** → **Individual**: name (optional), email, password (at least 12 characters) and confirm password → signed in straight away as the admin of their own one-person account; a confirmation link is emailed. They follow [USER_SETUP.md](./USER_SETUP.md): confirm the email, start the trial or buy a plan or credits, download, **Connect browser**. Company features (inviting people, other people's browsers) are not available to them.
* **Company admin** — the `INITIAL_ADMIN_EMAIL` account if you set one (its company has a non-expiring internal licence), or the admin of a company workspace created before 2.1. (Company sign-up is *Coming soon*: refused unless `COMPANY_SIGNUP_ENABLED=true`.)

A company admin then (the sidebar's **Get started** section, and the **Overview** page's **Finish setup** checklist, guide them; each checklist item disappears when done):

1. **Start a plan** — *Account & plan → **Claim free 30-day trial**.* Once per account, and only after the admin's email is confirmed; the trial runs on server time. Some claims are refused with a reason (an email or company email domain that already had a trial, a disposable mailbox, or too many claims from the same network). **Buy credits** adds prepaid prompt checks. For a paid plan, click **Buy** (six-month or annual, one payment) or **Subscribe** (monthly, renews automatically) on **Account & plan** and pay in the Razorpay window; the plan activates as soon as Razorpay confirms the payment. Buying while a paid plan runs adds the new period after it; buying during a trial starts the paid plan at once. If online payment is not switched on (1.7), the button reads **Contact AgentShield** and the platform owner grants the licence (**internal console → Companies → Grant licence**). Without an active plan, activation codes cannot be generated and browsers stay locked.
2. **Change your password** if needed — *Deployment & Settings → Change your password* (this signs out your other sessions). Forgotten passwords: **Forgot password?** on the sign-in page.
3. **Invite your team** — *Users & Devices → Invite someone.*
   * Enter the person's work email and choose a role: **EMPLOYEE** (activates their own browsers only; sees no organization data), **VIEWER** (read-only dashboard) or **ADMIN**. They join your company.
   * They receive a single-use link, valid 72 hours. Opening it, they set a password (at least 12 characters), which creates the account and confirms the email address.
   * Pending invites can be **Resent** or **Cancelled** from the same page.
   * Employees should **not** use **Create an account**: it creates a separate individual account with no access to yours.
   * Optional: turn on **Require admin approval for new browsers** if an admin should approve every newly activated browser before it works.
4. **Choose the rules** — *Data Protection Rules.* Click a preset:
   * **Monitor only** for the first week (nothing is blocked, everything is recorded), then
   * **Recommended** (blocks keys, passwords, card and Aadhaar numbers; warns on other personal data and file uploads).
5. **Websites** — *Website Controls.* Review blocked sites; optionally turn on **Block unapproved AI tools**.
6. **Keywords** — *Deployment & Settings → Confidential keywords.* Add your project codenames.
7. **Privacy** — *Deployment & Settings → Privacy & retention.* Recommended: store text of rule-breaking prompts **on**, all other prompts **off**, keep events 30–90 days.

**Plan reminders:** company admins get an in-app notice and an email 7, 3 and 1 days before the licence ends and when it ends (each once); none are sent while a monthly subscription renews automatically. **Account & plan** shows the days left, the licence history and these notices; a red banner appears across the portal when the plan has ended.

---

## Part 3 — Download from the portal and install on PCs

Open *Deployment & Settings → Install on company PCs* (for IT), or the **Download** page under **Get started** (for everyone). Downloading needs no plan; activating does. Installing puts the extension in the browser; it stays locked (AI sites blocked) until the user activates it in Part 4.

The **Download** page has **Chrome** and **Edge** tabs. If `CHROME_STORE_EXTENSION_ID` / `EDGE_STORE_EXTENSION_ID` are set it shows the store link; otherwise the versioned `.zip` with "extract, then **Load unpacked**" steps (a zip cannot be installed by double-clicking it). It also offers the Windows installer for IT, the zip's SHA-256 with the commands to check it (`certutil -hashfile <file> SHA256` on Windows, `shasum -a 256 <file>` on macOS/Linux), the release notes and the supported browsers (Chrome/Edge 110+). Its **Connection status** table separates *Downloaded* (the server cannot see downloads), *Connected* (activated) and *Authorized* (seen in the last 20 minutes with an active plan).

### 3.1 Recommended: system installer (all users, Chrome and Edge, cannot be removed)

1. In the portal click **Download installer (.exe, for IT)** → `AgentShield-System-Setup.exe`.
2. On the PC: right-click the file → **Run as administrator**.
3. Enter the **server address** (your HTTPS address, as shown in the portal's silent-install command) → **Next** → optionally tick *Block browser developer tools* → **Install**.
4. Close and reopen Chrome and Edge. Within a few minutes the AgentShield icon appears for every user, showing **Activation Required** until that user activates it (Part 4).

The installer carries no credential: it only sets the server address. With the address set by IT, activation codes for any other server are refused.

Windows may show "Windows protected your PC" because the installer is not code-signed: click **More info → Run anyway** (or sign the `.exe` with your company certificate).

**Many PCs at once (no clicks):** deploy the same file with Group Policy (startup script), Intune (Win32 app) or SCCM:
```
AgentShield-System-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVER=https://agentshield.yourcompany.com
```
Optionally add `/DASHBOARD=<portal address>` if the portal is on a different address. The portal shows this command with your server filled in (copy button). Exit code `0` = success; log: `C:\ProgramData\AgentShield\install.log`.

> **Requirement:** Chrome and Edge only install a self-hosted extension this way on PCs that are **joined to Active Directory or Microsoft Entra ID, or enrolled in Intune**. On other PCs the installer warns you and the extension will not appear. For those, use 3.4 (store publishing) — after that, the same installer works on any PC — or use 3.2 meanwhile.

### 3.2 Manual install (one PC, pilots, PCs not managed by IT)

1. In the portal click **Download extension (.zip, manual install)**.
2. Extract the zip to a **permanent** folder, e.g. `C:\AgentShield\extension` (don't delete it later; the browser loads it from there).
3. Open `chrome://extensions` (or `edge://extensions`) → turn on **Developer mode** → **Load unpacked** → select that folder.
4. Pin the AgentShield icon (puzzle-piece icon → pin).
5. Activate it (Part 4).

Repeat for each browser you use (Chrome and Edge are separate).

### 3.3 Sending employees their part

For everyone: invite them (Part 2, step 3) and they create their account from the email. (Do not send employees to **Create an account**: that creates a separate individual account.)
For 3.1: they restart their browser and activate it (Part 4).
For 3.2: also send them the zip (or the portal link) and [USER_SETUP.md](./USER_SETUP.md).

### 3.4 Optional: publish to the Chrome Web Store and Edge Add-ons

Needed to use the system installer on PCs that are not domain/Intune-managed, or to sell AgentShield.
1. Upload `dist-installer\package\agentshield-store.zip` to the Chrome Web Store (developer account, one-time USD 5; choose *Unlisted*) and to Microsoft Edge Add-ons (free). Use [DATA_HANDLING.md](./DATA_HANDLING.md) for the privacy questions.
2. After approval, put the two store IDs in `.env` as `CHROME_STORE_EXTENSION_ID` and `EDGE_STORE_EXTENSION_ID` and restart the server.
3. Roll out, either way:
   * **Employees install it themselves:** send them the store link. They open the link → **Add to Chrome** (Edge: **Get**) → activate (Part 4).
   * **IT installs it for everyone:** run the system installer (3.1) on PCs; it now installs the store copy, which works on any Windows PC. Employees only activate.

---

## Part 4 — Activate each browser

Each person does this once in every browser they use (up to 3 browsers per account, and up to the plan's browser limit for the whole account; the trial allows 3, credits only `CREDITS_DEVICE_LIMIT`). It needs their own account (from an invite or self sign-up) and an **active plan or prepaid credits**.

1. Sign in to the portal with the account's email and password → **Connect browser** (individual accounts) or **My activation** (company workspaces) → **Generate activation code**. The code starts with `ASA1.`, works once and is valid for 30 minutes. Generating a new one cancels the previous one. If there is no active plan or credits, the button is disabled and the page says why.
2. In Chrome or Edge, click the AgentShield icon. The **AgentShieldAI — Activation Required** screen opens with three steps: 1 Create an account or sign in, 2 Generate your code, 3 Paste it below.
3. Paste the code into the **Activation code** box and click **Connect and verify**. No email or password is entered in the extension.
4. The popup shows success only after the server confirms. If the organization requires approval for new browsers, the browser stays *Pending approval* and AI sites stay blocked until an admin approves it in **Users & Devices**.

The code identifies the account that generated it (it can only be generated while signed in), so whoever pastes it first connects a browser to that account: users must never share it. The browser then keeps itself signed in with short sessions that renew automatically; a session never outlasts the company's licence.

**When the plan, included checks or credits run out** (or the account's own monthly limit is reached): at the browser's next request the popup shows **Your plan has ended** (or names the problem) with **Choose a plan** (opens the portal) and **Check again**, and AI sites are blocked. The browser keeps its activation: once access is restored (renewal, credits bought, a higher limit, or the next month for included checks) it reconnects by itself (within 5 minutes, or at once with **Check again**), without reinstalling or a new code. While the plan is active the popup shows a plan card (Free trial or the plan name, days left, end date; **Pay as you go** with the prompt checks left on credits only), and a yellow "ends in N days" banner in the last 7 days.

---

## Part 5 — Check that it works

1. Open chatgpt.com **before** activating: the **Activation Required** page appears instead of ChatGPT.
2. After activating, click the AgentShield icon: **Protected**, **Signed in as** the user's email, your organization name, and the plan card (Free trial / plan name, days left, end date).
3. Open chatgpt.com: a small **AgentShield Protected** badge appears bottom-right.
4. Type `Why does this fail? api_key = sk-demo-ABCDEF1234567890XYZ` and press Enter → a red **Blocked by your organization** box appears.
5. In the portal: **Users & Devices** lists the browser under *Authorized browsers*, **Protected Browsers** lists it as Online, and **Prompts & Risk Events** shows the blocked prompt with the key masked (individual accounts: **Connect browser** lists the browser, **Security alerts** shows the prompt). **Usage & credits** counts the prompt check.

---

## Updating

* **Rules, websites, keywords, settings:** change them in the portal; PCs pick them up within 5 minutes.
* **New extension version:** bump `version` in `extension/manifest.json`, run `node scripts\packaging\pack-extension.js` on the server and restart it (the new build registers itself as a release; add notes or make it current in **internal console → Extension releases**). PCs installed with the system installer update automatically; manual installs need the new zip and a click on ↻ in `chrome://extensions`. Activations are kept across updates.
* **Plan renewal:** when a company gets a new licence (trial, grant or extension by AgentShield staff), its locked browsers reconnect by themselves; nothing to reinstall or reactivate.

## Uninstalling

* **System installer:** Windows Settings → Apps → **AgentShield** → Uninstall (or `"C:\Program Files\AgentShield\unins000.exe" /VERYSILENT`). Removes only AgentShield's browser policies.
* **Manual install:** `chrome://extensions` → AgentShield → **Remove**.
* **Stop one browser:** *Users & Devices → Authorized browsers →* **Revoke**. It is locked at its next request, and AI sites are blocked there again.
* **Stop a person:** *Users & Devices → Accounts →* **Disable**. All of their browsers are locked at their next request.

## Troubleshooting

| Problem | Fix |
| :--- | :--- |
| Download buttons say "not built" | Run the commands in 1.4 on the server. |
| Inviting says "email not configured" | Set the `SMTP_...` values in `.env` (1.2) and restart the server. |
| Invite email never arrives | Check the spam folder and the `SMTP_FROM` address; **Resend** the invite. Links expire after 72 hours. |
| Installer: "could not be set up" | Open `C:\ProgramData\AgentShield\install.log`. Usually a missing/invalid server address or the PC cannot reach it. |
| Installed with 3.1 but no icon appears | Restart the browser and open `chrome://policy`. If AgentShield is listed with an error, the PC is not domain/Intune-managed: use 3.4 or 3.2. |
| AI sites show **Activation Required** | Expected until the browser is activated (Part 4). Also shown after the browser was revoked, the account was disabled, the company's plan ended, or the server could not be reached. |
| Sign-up: "An account with this email already exists" | Sign in, or use **Forgot password?** (the reset link goes to that inbox, so the real owner of the address can take the account over; this also signs out every other session). |
| Sign-up: "Use your work email address" | The email's domain is not in `SIGNUP_ALLOWED_DOMAINS`. |
| Sign-up: "Temporary email addresses can't be used" | Disposable mailbox domains are refused. Use a real work email. |
| Forgot the portal password | **Forgot password?** on the sign-in page: a single-use link valid 60 minutes is emailed (same answer whether or not the account exists). Setting the new password signs out every session. |
| **Claim free 30-day trial** refused | The reason is shown: the email is not confirmed yet (open the emailed link or **Send a new link**); the account already had a trial; this email (Gmail dots and `+tags` count as the same address) already had one; for company workspaces, the company email domain already had one; disposable mailbox; or too many claims from this network in 30 days. Ask AgentShield staff to grant a licence instead. |
| Sign-up confirmation email never arrives | Production needs SMTP (`SMTP_HOST`, `SMTP_FROM`, credentials) passed to the backend; check `DASHBOARD_URL` (the link's address) and the spam folder. The user can **Send a new link** from the portal banner. In development the link is printed in the backend console. |
| Sign-up: "Company accounts are coming soon" (`COMPANY_COMING_SOON`) | Expected while `COMPANY_SIGNUP_ENABLED=false`: only Individual accounts can sign up. |
| `COMPANY_FEATURE_UNAVAILABLE` | An individual account called a company-workspace API (users, invites, other people's browsers). Expected. |
| **Buy credits** not shown | The credit pack has no price or **Offered for sale** is not ticked in **internal console → Plans & pricing** (1.9), or online payment is off (1.7). |
| Popup: `USAGE_LIMIT`, `SPEND_CAP` or `NO_CREDITS` | The plan's included monthly checks are used up (and no credits), the account's own monthly limit is reached, or the credits are used up. Buy credits, upgrade or raise the limit in **Usage & credits**; the browser reconnects by itself. |
| Plan buttons say **Contact AgentShield** | Online payment is off: set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (1.7) and restart. If payment is on but a plan cannot be bought, it has no price or **Offered for sale** is not ticked in **internal console → Plans & pricing**. |
| Paid in Razorpay but the plan is not active | The portal says the plan activates once Razorpay confirms. Check **internal console → Payments**: webhook events rejected or `failed` usually mean a wrong `RAZORPAY_WEBHOOK_SECRET` or an unreachable webhook URL. Click **Reconcile** to re-check one-time orders from the last 7 days. |
| **Generate activation code** disabled | The account has no active plan or credits, or its checks, credits or monthly limit are used up. Open **Account & plan** to claim the trial, buy a plan or credits, or get a licence. |
| Popup: "Your plan has ended" (`LICENSE_EXPIRED`) or "no licence" (`NO_LICENSE`) | Renew on **Account & plan** / ask AgentShield staff. The browser then reconnects by itself (or click **Check again**); no new code needed. |
| Popup: licence revoked (`LICENSE_REVOKED`) or company suspended (`ORG_SUSPENDED`) | Set by AgentShield staff. Contact them; once restored, browsers reconnect by themselves. |
| Popup: plan's browser limit reached (`DEVICE_LIMIT`) | All browsers allowed by the company's plan are in use. Sign one out in **My activation**, revoke one in **Users & Devices**, or move to a plan with more browsers. |
| Popup: "This activation code is not valid" | Paste the whole code (starts with `ASA1.`) or generate a new one in **My activation**. |
| Popup: code "already used", "expired" or "replaced or revoked" | Codes work once, expire after 30 minutes, and a newer code cancels older ones: generate a new one in **My activation**. |
| Popup: code refused for this server | IT set a different server address. Generate the code in the portal on that server. |
| Popup: "Waiting for an administrator to approve this browser" | **Require admin approval for new browsers** is on. An admin approves it in **Users & Devices** (it shows as *Pending approval* there). |
| Popup: "This account already has 3 browsers" | Sign one out in **My activation**, or ask an admin to revoke one. |
| Popup: "This account is disabled" | Ask an admin to enable the account in **Users & Devices** (or AgentShield staff, if it was suspended in the internal console). Email confirmation is not required for activation. |
| Popup: "Cannot reach the AgentShield server" | The HTTPS address is not reachable from that PC (VPN, firewall, `localhost`). AI sites stay blocked until it is reachable again. |
| Popup: "updated but not reloaded" | `chrome://extensions` → ↻ on AgentShield, then reopen AI tabs. |
| Prompts not blocked on an AI site | Reopen the tab after installing/updating. Check the popup version and that the badge says "Protected". |
| Errors listed on the extension card | Click **Errors → Clear all**, reload the extension, reopen tabs; report any that come back. |
| PC shows "Not seen today" in the portal | Browser closed, PC off, or extension removed/disabled. |
| The old platform operator (SUPERADMIN) login no longer shows platform pages | Expected since 2.0: that account is now an ordinary company admin. Create a staff account with `python -m app.cli create-platform-owner` (1.8) and use the internal console. |
| Internal console: "That code is not valid" | Check that the phone's time is set automatically (codes change every 30 seconds) and use a code you have not used before; each code works once. Or use a recovery code. |
| Internal console: every staff member's authenticator codes are refused after a server change | `SECRET_KEY` changed while `STAFF_MFA_KEY` was empty (or `STAFF_MFA_KEY` changed), so the stored authenticator secrets can no longer be read and authenticator codes stop working. Sign in with a recovery code (they still work), then a platform owner resets the others' authenticators in **Staff & roles** (an owner cannot reset their own; another owner must). Set a fixed `STAFF_MFA_KEY` to avoid this in future. |
| Internal console: "Too many failed attempts" | Five wrong passwords lock that staff email for 15 minutes. |
| Internal console page or button missing | Your staff role does not have that permission; ask a platform owner. |
| Internal console sign-in fails with a network/CORS error | Add the console's address to `ALLOWED_ORIGINS`, check `VITE_API_BASE_URL` used at build time, and restart the server. |

More detail: [DEPLOYMENT.md](./DEPLOYMENT.md) (IT), [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) (daily use), [USER_SETUP.md](./USER_SETUP.md) (employees).
