# AgentShield — Administrator Guide

Day-to-day use of the dashboard (customer portal), plus the internal admin console used by AgentShieldAI staff. Installation and hosting are in [DEPLOY_STEPS.md](./DEPLOY_STEPS.md).

---

## Roles

| Role | Can |
| :--- | :--- |
| **Admin** | Everything in their own account: rules, websites, keywords, settings, **Account & plan** (claim the trial, buy plans or credits, see licences and reminders), **Usage & credits**, API connections; in a company workspace also users and browsers and employee actions |
| **Viewer** | Read everything in their company (events, browsers, audit log); change nothing |
| **Employee** | Only the **My activation** page: generate activation codes and sign out their own browsers. Sees no organization data |

Platform administration is **not** a customer role any more (since 2.0). The former `SUPERADMIN` role was removed: such accounts became **Admin** of their own company and no longer see any platform pages. AgentShieldAI's own staff use the separate [internal admin console](#internal-admin-console-agentshieldai-staff) with separate staff accounts. Customer roles are Admin, Viewer and Employee (Phase B will add Company Owner / Security Manager, seats and departments).

**Account types (2.1).** Every customer account is either an **Individual** account or a **Company** workspace; each has its own rules, events and browsers, and accounts never see each other's data.

* **Individual (available now):** **Create an account** on the dashboard's sign-in page (optional name, email, password) creates a one-person account with that person as its **Admin** and signs them in straight away. A confirmation link is emailed; the email must be confirmed before the free trial can start (plans and credits can be bought without it). The person's own walkthrough is in [README.md → User setup](./README.md#user-setup).
* **Company workspace (coming soon):** the sign-up page shows **Company** as *Coming soon*, and the server refuses company sign-ups (403 `COMPANY_COMING_SOON`) unless `COMPANY_SIGNUP_ENABLED=true`. Company workspaces created before 2.1 (and the initial company created from `INITIAL_ADMIN_EMAIL`) keep every company feature: an admin's email invite (**Users & Devices → Invite someone**) adds a person to the admin's own company as EMPLOYEE, VIEWER or ADMIN. Employees must not use **Create an account**: that creates a separate individual account.

Company management (users, invites, other people's browsers) is hidden for individual accounts and refused by the server (403 `COMPANY_FEATURE_UNAVAILABLE` on `/api/v1/org/users`, invites and devices); their sidebar shows **Company workspace** with a *Soon* badge instead.

Everyone, including admins, needs an account to activate a browser, and the account needs an active plan or prepaid credits.

## First day (≈ 15 minutes, company workspace)

1. **Get started → Account & plan:** click **Claim free 30-day trial** (needs a confirmed email), buy a plan or credits, or ask AgentShield to grant a paid licence. Without an active plan or credits no activation codes can be generated and browsers stay locked.
2. **Overview → Finish setup** lists what is left. Each item disappears only when the backend confirms it. The **Account & plan** page also has a 4-step checklist.
3. **Change your password** (Deployment & Settings) if needed. A red banner shows while a published default password is in use.
4. **Pick a preset** (Data Protection Rules). Start with **Monitor only** for a week to see what employees do without interrupting them, then switch to **Recommended**.
5. **Invite your team** (Users & Devices → **Invite someone**). Email must be configured on the server (`SMTP_...` in `.env`; see [DEPLOY_STEPS.md](./DEPLOY_STEPS.md)).
6. **Activate a test browser** (**Download** page → install, then My activation → **Generate activation code**, then the extension popup) and run the **Guided Demo** (demo mode) or the tests in [README.md → Testing](./README.md#testing).

An individual account follows the same idea with a personal sidebar: **Account & plan**, **Download**, **Connect browser**, **Overview**, **Security alerts**, **Usage & credits**, **Protection rules**, **Website controls**, **API connections**, **Profile & security**, **Test a prompt**, **Coverage & limits** and **Company workspace** (*Soon*).

## Account & plan

Under **Get started** in the sidebar (account admins):

* **Status:** the current plan (Free trial, a paid plan, Pay as you go, or Internal), its state (TRIAL_ACTIVE, SUBSCRIPTION_ACTIVE, CREDITS_ACTIVE, LIMIT_REACHED, CAP_REACHED, NO_CREDITS, EXPIRED, NONE, REVOKED, SUSPENDED), a countdown and progress bar (or the credits left), and buttons to **Download** the extension and **Get activation code**. A 4-step checklist (plan, download, activation code, connected browser).
* **Claim free 30-day trial:** once per account, timed by the server. Refused, with the reason shown, when: the email is not confirmed yet (a banner across the portal offers **Send a new link**), this email already had a trial (case, Gmail dots and `+tags` are ignored), the mailbox is disposable, or the network has reached `TRIAL_CLAIMS_PER_IP_30D` (3) claims in 30 days. For **company workspaces only**, a trial is also refused when another company with the same email domain already had one (public webmail such as gmail.com excepted); individuals are limited per person instead. The database prevents two trials for one account even if clicked twice at once. Audit: `trial.claimed`, `trial.refused`.
* **Plans:** a comparison of the plans and credit packs AgentShield offers (prices are set by AgentShield staff). Account admins pay online with Razorpay (cards, UPI, net banking) in Razorpay's own Checkout window; AgentShield never sees card or UPI details.
  * **Buy** / **Buy / extend** (six-month or annual): one payment. **Subscribe** (monthly): renews automatically every month until cancelled. **Buy credits** (credit pack, e.g. 1,000 prompt checks): one payment that adds prepaid credits; see [Usage & credits](#usage--credits).
  * A plan may include a number of **prompt checks per month** (shown on the plan card; no number means unlimited).
  * The plan activates (or the credits are added) as soon as Razorpay confirms the payment (the portal says "Payment received" with the receipt number). If the window was closed early or confirmation is still pending, it happens when Razorpay's confirmation reaches the server; nothing is activated from an unconfirmed payment.
  * Buying while a paid plan is running adds the new period **after** the paid time already bought (no days lost). Buying during the free trial starts the paid plan immediately and replaces the trial. There is no proration when switching between plans.
  * With test keys the page says **Test mode: no real money is taken**. If online payment is not switched on, the buttons say **Contact AgentShield** and AgentShield staff activate the plan with **Grant licence** in the internal console.
* **Billing** (shown once there is a payment or subscription): the billing history (date, plan or pack, amount, status including refunds), a printable **receipt** for each payment (only your own account's; it is a payment receipt, not a tax invoice) and, for the monthly plan, its status and **Cancel automatic renewal**: no further charges, and the time already paid for stays active until the period ends. Audit: `billing.checkout`, `billing.payment_captured`, `billing.subscription_cancel`.
* **Licence history, notices** (plan reminders, payment and credit notices) and account information, plus **Sign out everywhere** (ends every dashboard session of your account).

**Licences:** the account is entitled while it has an active licence (trial, monthly, six_month, annual, or the non-expiring internal licence of the initial company created from `INITIAL_ADMIN_EMAIL`) whose monthly prompt checks are not used up, or while it has prepaid credits. The server checks this on every extension request (activation, session, policies, websites, events, heartbeat), not with a scheduled job, and a browser session never lasts past the licence end. Each plan has a browser limit for the whole account (trial: 3; credits only: `CREDITS_DEVICE_LIMIT`, 3); when it is full, activation is refused (`DEVICE_LIMIT`). When the licence ends or is revoked, the included checks, credits or your own monthly limit run out, or the account is suspended, browsers are locked (AI sites blocked) at their next request but keep their activation, and reconnect by themselves once access is restored (within 5 minutes, or **Check again** in the popup). A red banner appears in the dashboard with the reason (plan ended, monthly checks used up, your monthly limit reached, credits used up) and a button (**Choose a plan** or **Change limit**), and **My activation** / **Connect browser** disables code generation with the reason.

**Reminders:** account admins get an in-app notice and an email 7, 3 and 1 days before the licence ends and when it ends. Each is sent once. No reminders are sent while a monthly subscription renews automatically (they resume if renewal is cancelled or Razorpay stops charging). Payments and full refunds also produce an in-app notice, and so do low and used-up credits (below). They are produced by an hourly background job (`REMINDER_LOOP_ENABLED`); access never depends on that job.

## Usage & credits

The billable unit is one **prompt check**: one prompt the extension inspected on an AI site and reported from an **activated browser**. Allowed prompts count too (their text is not stored unless your privacy settings say so). Website blocks (`dlp.*`), file-upload events, **Test a prompt** and anything sent with a dashboard sign-in are **not** counted. Each event carries a random ID (`client_event_id`), so retries and the offline queue are counted once. Usage is counted per **UTC calendar month**.

**Usage & credits** page (individuals, and company admins and viewers; through the API an employee of a company workspace sees only their own usage): prompt checks this month, included checks used of the plan's monthly number (or "Unlimited"), checks paid with credits, the credit balance, a daily chart (blocked, warned, redacted) and the credit history (purchases, refunds, disputes, grants by AgentShield). **Buy credits** opens **Account & plan**.

* **Order of payment:** a check is covered by the plan while its included monthly checks last; after that each check uses one prepaid credit. Without any active plan, credits alone keep the account protected (**Pay as you go**, state `CREDITS_ACTIVE`). A credit is spent with one atomic database update, so it can never be spent twice or go below zero.
* **Your own monthly limit** (admins): set a maximum number of prompt checks per month (empty or 0 = no limit). It applies to every way of paying; when it is reached, browsers lock (`SPEND_CAP`) until next month or until you raise it. Audit: `usage.cap_update`.
* **Credits** never expire and are not prorated. A full refund or an opened dispute of a credit pack removes that pack's credits (never below zero, so credits already used are not taken back); a won dispute restores them; a partial refund keeps them.
* **Notices:** one in-app notice per top-up when the balance falls to 10% of the last pack (at least 10 checks), and one when it reaches zero.
* **When something runs out** the extension gets one of these codes at its next request and locks, keeping its activation: `USAGE_LIMIT` (the plan's monthly checks are used up and there are no credits), `SPEND_CAP` (your own monthly limit), `NO_CREDITS` (pay-as-you-go credits used up), `LICENSE_EXPIRED` / `NO_LICENSE`. After a top-up, an upgrade, a higher limit or the new month it unlocks by itself (within 5 minutes, or **Check again**); no reinstall and no new code.

## API connections

**API connections** lets an account admin or viewer create **personal API tokens** for their own tools (for example a SIEM or a spreadsheet):

* Token format `aspt_…`, shown **once** when created (the server stores only its SHA-256 hash; the list shows the first characters). Choose a name, the scopes (**alerts:read** — your security alerts; **usage:read** — your usage and credit balance) and an expiry (1–365 days, default 90, or none). At most 10 active tokens per person; **Revoke** stops a token at once. Audit: `api_token.create`, `api_token.revoke`.
* Use: `Authorization: Bearer aspt_…` on `GET /api/v1/public/alerts` (`since`, `limit`) and `GET /api/v1/public/usage`. Read-only, limited to the creator's own account, 60 requests per minute per token. Alerts never include prompt text.
* A personal token is refused (401) by every other endpoint: dashboard, extension and internal APIs.

## Internal admin console (AgentShieldAI staff)

A separate web app on its own address (e.g. `https://admin.yourcompany.com`; development `http://localhost:5175`), for the people who run the AgentShield service. Customer accounts cannot sign in to it, and staff accounts cannot sign in to the customer portal. The server checks a named permission on every request; hidden buttons are only a convenience.

**Signing in:** email and password, then a 6-digit code from an authenticator app, or one of your recovery codes. At the first sign-in you scan a QR code (or type the manual key) into your authenticator app, enter a code, are shown **10 recovery codes once** (store them safely; each works once), and must replace your temporary password with one of at least 14 characters. Sessions last 8 hours (`STAFF_TOKEN_HOURS`). Five wrong passwords lock the email for 15 minutes. **Sign out everywhere** (sidebar) ends all your console sessions.

**First owner:** there is no built-in staff login. The first platform owner is created on the server with `python -m app.cli create-platform-owner --email you@yourcompany.com` (run in `backend/` with the production `DATABASE_URL` and `SECRET_KEY`); it prints a temporary password once and refuses if an owner already exists unless `--force`. See [DEPLOY_STEPS.md](./DEPLOY_STEPS.md).

**Staff roles** (full permission table in the README, "Authentication model"):

| Role | Can |
| :--- | :--- |
| **Platform owner** | Everything, including licence and credit **exceptions** (paid access without a verified payment), editing plans and prices, and managing staff |
| **Platform administrator** | Customer accounts (suspend accounts and companies, browsers, trial licences, revoke licences, browser limits, remove credits), publish extension releases, audit log, metrics and health, run jobs |
| **Security analyst** | Read customer accounts and browsers, extension releases, audit log, metrics and health |
| **Support agent** | Read customer accounts and browsers, and extension releases |
| **Billing administrator** | Read customer accounts, plans, payments and the webhook log; refunds and Reconcile; metrics and health |
| **Read-only analyst** | Read customer accounts, plans, extension releases, payments; metrics and health |

**Pages** (each shown only with its permission):

* **Overview** (`metrics.read`): customer accounts (individuals / companies), user accounts, trials active, paid plans active, expired, trials claimed, trial→paid conversion, licensed browsers, prompt checks and credit-paid checks this month, credits outstanding, credits sold this month and net revenue this month. **Run now** (`jobs.run`) sends due plan reminders immediately.
* **Platform health** (`metrics.read`): database response time; last-24-hour counts of customer and staff sign-in failures, activation failures, refused browser sessions, Razorpay webhooks received and failed, security events and blocked prompts; the current extension release and the extension versions browsers reported in the last 7 days. Counts only, no customer content.
* **Accounts** (`companies.read`): every customer account (individuals and company workspaces), with a type filter, search and **Export CSV**; status, plan end, prompt checks this month and credits. The detail panel shows the entitlement, usage this month (included checks, credits left, the customer's own monthly limit), a 60-day usage chart, the credit history, licences and licence-change history, accounts and verification state. Actions:
  * **Grant licence** with a reason: a trial needs `licenses.manage` (owner, platform admin); a PAID or INTERNAL plan without a verified payment is an **owner-only exception** (`licenses.exception`), stored with `payment_ref = exception:<staff email>` and audited as `platform.license_exception`. Credit packs cannot be granted as licences.
  * **Extend** a licence by N days with a reason (never silent): trials need `licenses.manage`; extending a non-trial licence is an owner-only exception. **Browser limit** and **Revoke** (with a reason) need `licenses.manage`.
  * **Add credits** (owner only, an exception with a reason, audited `platform.credits_exception`) and **Remove credits** (`licenses.manage`, e.g. for abuse or corrections, never below zero, audited `platform.credits_adjust`).
  * **Suspend** / lift a company (`companies.suspend`), suspend / re-enable individual user accounts (`users.suspend`). The account's browsers are listed only for roles with `devices.read`.
* **Payments** (`billing.read`): every account's orders and payments (amount, status, receipt, refunded amount) and the **Razorpay webhooks** log (event, status `processed` / `ignored` / `failed` with the error, times). Refund and Reconcile need `billing.refund` / `billing.reconcile` (owner, billing administrator).
  * **Refund** a payment (full or partial, with a reason): the request is sent to Razorpay and audited (`billing.refund_requested`); the licence or credits change when Razorpay confirms the refund (at once if Razorpay reports it already processed). A **full refund** ends the plan that payment bought, or removes the pack's credits; a **partial refund** keeps them. An opened **dispute** (chargeback) also ends it; a won dispute restores it.
  * **Reconcile** re-checks one-time orders from the last 7 days that are still unpaid or failed and completes any that Razorpay reports as captured (use it if a webhook was missed). Monthly subscription charges are completed only by webhooks.
  * A payment whose amount or currency does not match the order is ignored and audited (`billing.amount_mismatch`).
* **Plans & pricing** (`plans.read`; editing needs `plans.manage`, owner only): name, length (the trial's comes from `TRIAL_DAYS` on first start), browser limit, price in the main currency unit, currency, features and whether it is available; **Included prompt checks per month** for trial and paid plans (empty = unlimited); **Prompt checks per pack** for credit packs (the `credits_1000` pack is created with 1,000 checks and no price). A plan or pack is offered for online sale only when it has a price and **Offered for sale** is ticked; no prices are preset. Changing the monthly price creates a new Razorpay plan for new subscriptions automatically.
* **Extension releases** (`releases.read`; publishing needs `releases.manage`, owner or platform admin): publish an extension version with notes, SHA-256 and minimum Chrome/Edge version, and make it current. The packaged build registers itself when the server starts.
* **Audit log** (`audit.read`): the platform-wide audit log, filterable by action and by actor type (**customer**, **staff**, **system**). Staff actions are recorded as actor `staff:<email>`: `platform.license_grant`, `platform.license_exception`, `platform.license_extend`, `platform.license_revoke`, `platform.license_devices`, `platform.credits_exception`, `platform.credits_adjust`, `platform.company_suspend`, `platform.company_unsuspend`, `platform.user_suspend`, `platform.user_activate`, `platform.plan_update`, `platform.release`, `platform.reminders_run`; staff sign-in and management: `staff.login.*`, `staff.mfa.*`, `staff.recovery_code_used`, `staff.password_changed`, `staff.logout_all`, `staff.invited`, `staff.invite_accepted`, `staff.updated`, `staff.mfa_reset`, `staff.sessions_ended` (the bootstrap command writes `staff.owner_created` as `system`). Payment actions (filter **Payments**): `billing.checkout`, `billing.confirm_refused`, `billing.payment_captured`, `billing.amount_mismatch`, `billing.refund`, `billing.refund_requested`, `billing.dispute_created`, `billing.dispute_won`, `billing.dispute_lost`, `billing.subscription_cancel`, `billing.reconcile`.
* **Staff & roles** (`staff.manage`, owner only): **Invite** a colleague by email with a role (single-use link valid 48 hours; SMTP needed in production, in development the link is printed in the backend log); the invitee sets a password and must enrol an authenticator. **Change role** (ends that person's sessions at once), **Disable**, **Reset MFA** (they enrol again at their next sign-in; you cannot reset your own, another owner must) and **End sessions**. The last active platform owner cannot be demoted or disabled.

**Lost authenticator:** sign in with a recovery code, or ask another owner to **Reset MFA**. If `SECRET_KEY` was changed while `STAFF_MFA_KEY` was empty, the stored authenticator secrets can no longer be read and every authenticator code stops working: staff sign in with a recovery code, then an owner resets the others' authenticators (an owner cannot reset their own; another owner must).

## Users & Devices

Company workspaces only (individual accounts manage their own browsers on **Connect browser**).

**Invite someone:** enter the work email and a role (EMPLOYEE, VIEWER or ADMIN). The person gets a single-use link, valid 72 hours (`INVITE_EXPIRE_HOURS`). Opening it, they set a password of at least 12 characters; that creates the account and confirms the email address. Pending invites can be **Resent** (new link, old one stops working) or **Cancelled**. Without email configured, inviting fails in production; in development the link is printed to the backend console.

**Self sign-up (creates an individual account):** on the sign-in page, **Create an account** shows two cards: **Individual** (*Available now*) and **Company** (*Coming soon*, not selectable). It asks for Your name (optional), Email, Choose a password (at least 12 characters) and Confirm password. The server creates a one-person account named after the person (or the part of the email before the @), with that person as its ADMIN, signs them in straight away, and emails a single-use confirmation link (`#verify=…`, valid `EMAIL_VERIFY_EXPIRE_HOURS`). Until the link is opened a banner offers **Send a new link**; confirming is needed only for the free trial. An email that already has an account is refused ("An account with this email already exists. Sign in, or use Forgot password."). Disposable mailbox domains are refused, and sign-up is limited to 10 per IP address per hour. Settings in `.env` (set by whoever runs the server):

| Setting | Default | Effect |
| :--- | :--- | :--- |
| `SIGNUP_ENABLED` | `true` | `false` hides **Create an account** and refuses sign-ups; only invites create accounts |
| `COMPANY_SIGNUP_ENABLED` | `false` | `true` lets the API create company workspaces at sign-up (the portal still shows Company as *Coming soon*) |
| `SIGNUP_ALLOWED_DOMAINS` | empty (any) | Comma list, e.g. `motwane.com`; only these email domains can sign up (for a private server) |
| `EMAIL_VERIFY_EXPIRE_HOURS` | `24` | Lifetime of sign-up confirmation links |
| `CREDITS_DEVICE_LIMIT` | `3` | Browsers an account may connect while it runs on prepaid credits only |

Sign-up needs SMTP in production for the confirmation email (without it the account is still created and signed in, but the confirmation link cannot be sent, so the trial cannot be claimed). Turn on **Require admin approval for new browsers** (company workspaces) if you want to vet every browser.

**Passwords and sessions:** **Forgot password?** on the sign-in page emails a single-use reset link (`#reset=…`, valid 60 minutes, `PASSWORD_RESET_EXPIRE_MINUTES`); it works for any active account, the answer is the same whether or not the email exists, and requests are rate-limited. Using the link also marks the email as verified (opening it proves the inbox). Setting a new password from the link, or changing it in Deployment & Settings (Profile & security for individuals), signs the account out of its other sessions; **Sign out everywhere** on Account & plan does the same. Dashboard sign-ins last 12 hours (`DASHBOARD_TOKEN_HOURS`). **Profile & security** also sets the person's name (for an individual account it renames the account; audit `user.profile_update`).

**Accounts:** change a role, or **Disable** / **Enable** an account. Disabling locks all of that person's browsers at their next request (AI sites are blocked there again) and stops them signing in.

**Authorized browsers:** every activated browser, with its account, browser name, OS, status and last seen time. **Revoke** locks that browser at its next request; the user must activate it again with a new code. Each account can have up to 3 browsers (`MAX_DEVICES_PER_USER`), and the whole company up to its plan's browser limit (trial: 3).

**Require admin approval for new browsers:** when on, a newly activated browser stays *Pending approval* (AI sites blocked) until an admin clicks **Approve** (or **Reject**).

**How activation works:** the user signs in to the dashboard → **My activation** (**Connect browser** for individuals) → **Generate activation code** (single-use, 30 minutes, starts with `ASA1.`; a new code cancels the old one). In the extension, they click the AgentShield icon (**AgentShieldAI — Activation Required**), paste the code into the **Activation code** box and click **Connect and verify**; the extension never asks for an email or password. The code identifies the account that generated it (it can only be generated while signed in), so whoever pastes it first connects a browser to that account: users must not share it. Users can sign out their own browsers on the same page, or with **Sign out this browser** in the popup.

Until a browser is activated — and again whenever it is revoked, its account is disabled, the account's licence ends or is revoked, its included checks, credits or monthly limit run out, the account is suspended, or the server cannot be reached — AgentShield blocks all AI sites in it with an **Activation Required** page (for plan and usage problems the popup says **Your plan has ended** or names the problem). Installing or copying the extension grants nothing. Codes can only be generated while the account has an active plan or credits.

## Data Protection Rules

Each rule has an **action**, a **severity** (for sorting and risk scores) and an **On/Off** switch.

| Action | Employee experience | Recorded |
| :--- | :--- | :--- |
| Block | Red dialog; nothing sent | Yes |
| Redact | Preview with `[REDACTED:...]`; masked text sent (files with a match are blocked) | Yes |
| Warn | Must confirm | Yes, with the outcome |
| Monitor | Nothing visible | Yes |
| Allow | Nothing visible | No violation (prompt counted only) |

The strictest action of all matching rules wins. A rule that is **Off** is not enforced at all. Built-in rules cannot be deleted (turn them Off instead). Changes reach connected browsers within about a minute, or immediately when the employee clicks **Sync Policies**. Every kind of restriction on one page: [README.md → What is blocked and allowed](./README.md#what-is-blocked-and-allowed). The **Protected Browsers** page shows which browsers have the latest policy version.

Rules: credentials & keys, emails, phone numbers, payment cards, PAN, Aadhaar, confidential keywords, file uploads; since 2.6 also crypto wallet keys, connection strings with passwords, IBAN, Indian bank accounts (IFSC), UPI IDs, passport, voter ID, GSTIN and internal IP addresses (details and defaults: [README.md → What is blocked and allowed](./README.md#what-is-blocked-and-allowed)).

**Block passwords and secrets** overrides the action for high-confidence credential matches on supported
integrations. Off disables credential rules. Saved credential rules still apply until the switch is first set.
Set public credential prefixes and managed native-form or Gmail destinations on the same page. The
Protected Browsers page shows each browser's last acknowledged switch state.
[Coverage and limits](./README.md#credential-protection-and-channel-coverage)

## Confidential keywords

Deployment & Settings → Confidential keywords. Whole-word, case-insensitive matches. Used by the "Confidential keywords" rule (Redact by default). Add project codenames, unreleased product names and internal document labels; avoid common words, which cause false alarms.

## Website controls

* **Blocked:** the page never loads; the employee sees why. Applies to the domain and all its subdomains.
* **Allowed:** your approved AI tools. Prompts there are still checked.
* **Block unapproved AI tools** (switch at the top): blocks known AI sites (DeepSeek, Poe, Character.AI, Mistral, Grok, ...) that are not on the Allowed list.

## Privacy & retention

Deployment & Settings → Privacy & retention.

| Setting | Default | Effect |
| :--- | :--- | :--- |
| Store text of prompts that broke a rule | On | Investigators can see what was blocked/warned (credentials, wallet keys, card, Aadhaar, IBAN, bank account, passport and voter ID numbers always masked) |
| Store text of all other prompts | Off | When on, every prompt's text is stored. Inform employees first (DPDP Act) |
| Keep events for N days | 30 | Older events are deleted automatically |

## Investigating

**Prompts & Risk Events** (**Security alerts** for individuals)
* Filter by decision, application, time and employee; search text.
* Click an event to see the rule and outcome. Historical or legacy events can include stored text.
* **Export CSV** downloads the filtered list (logged in the audit log).
* **Employee Risk Profiles** tab: per-employee counts and risk level. Open an employee to **Warn**, **Restrict** (warnings become blocks) or **Suspend** (all prompts blocked). Takes effect in the browser within about 30 seconds.

**Protected Browsers**
* *Online:* reported in the last 15 minutes. *Not seen today / Offline:* browser closed, PC off, or the extension removed or disabled. A browser that stays offline while the employee is working is worth a follow-up.
* *Outdated policy:* has not synced since the last rule change.

**Admin Audit Log**
* Every change with before/after values, every sign-in (including failures and lockouts) and every export. Export to CSV for your records.
* Accounts and browsers: `user.invite`, `user.invite_accepted`, `user.signup`, `user.email_verified` (confirmation link opened), `user.profile_update`, `user.password_change`, `user.password_reset_requested`, `user.password_reset`, `user.logout_all`, `activation_token.create`, `device.activate`, `device.activate_failed`, `device.approve`, `device.revoke`, `device.sign_out`, `device.session_refused`.
* Usage and API: `usage.cap_update`, `api_token.create`, `api_token.revoke`.
* Plans: `trial.claimed`, `trial.refused`. AgentShieldAI staff actions on your account appear here too, with actor `staff:<email>`: licence changes (`platform.license_grant`, `platform.license_exception`, `platform.license_extend`, ...), credit changes (`platform.credits_exception`, `platform.credits_adjust`), suspensions and account changes.

## Activation security

* Activation codes, invite links, confirmation links and password-reset links are single-use and shown or sent once; the server stores only their SHA-256 hashes.
* An activation code is tied to the account that generated it; whoever pastes it first connects a browser to that account. Tell users never to share codes, and use **Require admin approval for new browsers** if you want to vet each browser.
* Each browser holds its own non-extractable key pair; the server stores only the public key. Copying the extension's files or storage to another browser grants nothing.
* An activated browser works with 15-minute sessions that renew automatically (never past the licence end), and every request re-checks that the browser is active, the account enabled and not suspended, and its licence, included checks, credits and monthly limit allow it. Revoking, disabling, licence expiry or revocation, used-up checks or credits and suspension therefore take effect at the browser's next request to the server, at the latest at its next 5-minute sync (immediately after **Sync policies**).
* Repeated failures are rate-limited: 5 failed sign-ins per account and 30 per IP address per 15 minutes; 10 activation attempts per IP per hour; 5 code generations per user per hour; 10 sign-ups per IP per hour; 3 password-reset emails per email and 10 per IP per hour; 60 requests per minute per personal API token. These counters are in memory, per server process.
* Trial-abuse controls (one per account, per normalized email; one per company email domain for company workspaces; confirmed email required; no disposable mailboxes; 3 per network per 30 days) raise the cost of repeated free trials, but a determined person with new emails and networks can still claim more.
* Sign-up signs the person in before the email is confirmed, so anyone can create an account with an address they do not own. They cannot start the free trial with it (that needs the confirmation link from the inbox), but a squatted email blocks the real owner's sign-up ("already exists"); the real owner takes the account over with **Forgot password?** (the link goes to their inbox), which also ends all other sessions. Because an existing email is refused at sign-up, sign-up reveals whether an email has an account; the sign-up rate limit (10 per IP per hour) limits such probing.
* An activation code cannot change anything in the dashboard.

## Troubleshooting

| Symptom | Likely cause / fix |
| :--- | :--- |
| Browser never appears in Users & Devices | Not activated yet, or activation failed. Check the Admin Audit Log for `device.activate_failed` (with the reason) and ask the user for the popup's message. |
| Browser stuck in *Pending approval* | **Require admin approval for new browsers** is on: **Approve** it in Users & Devices. |
| User says AI sites show "Activation Required" | Not activated, revoked, account disabled, the plan, checks or credits ran out, or the server unreachable from their PC (HTTPS/firewall/VPN). Look up their browser in Users & Devices and `device.session_refused` in the audit log; check **Account & plan** and **Usage & credits**. |
| Popup "Your plan has ended" / `NO_LICENSE`, `LICENSE_EXPIRED` | Claim the trial (if never claimed), buy a plan or credits, or ask AgentShield to grant or extend a licence. Browsers reconnect by themselves (within 5 minutes, or **Check again**); no reactivation. |
| `USAGE_LIMIT` (monthly checks used up) | Buy credits (extra checks then use credits) or move to a plan with more checks; the included checks also reset at the start of the next UTC month. |
| `SPEND_CAP` (your monthly limit reached) | Raise or remove the limit in **Usage & credits**; browsers reconnect by themselves. |
| `NO_CREDITS` (credits used up) | **Buy credits** or choose a plan on **Account & plan**. |
| `LICENSE_REVOKED` or `ORG_SUSPENDED` | Set by AgentShieldAI staff in the internal console. Contact AgentShield. |
| "Your plan allows N browsers and all are in use" (`DEVICE_LIMIT`) | Revoke unused browsers in Users & Devices (or sign one out on **Connect browser**), or ask AgentShield for a higher browser limit. |
| Paid but the plan or credits are not active yet | It activates once Razorpay confirms the payment (usually within a minute). AgentShield staff can check **internal console → Payments** (order status, webhook log) and click **Reconcile**. |
| Plan buttons say **Contact AgentShield** | Online payment is not switched on for this server; AgentShield staff activate plans with **Grant licence**. |
| **Claim free 30-day trial** refused | Read the reason shown (email not confirmed yet, email, domain or network already used, disposable mailbox). Confirm your email from the link (or **Send a new link**), or ask AgentShield to **Grant licence** instead. |
| Confirmation email never arrives | Check the spam folder; **Send a new link** from the banner or **Profile & security**. The server needs SMTP (`SMTP_HOST`, `SMTP_FROM`). |
| "Company accounts are coming soon" (`COMPANY_COMING_SOON`) | Company workspaces are not open for sign-up yet. Create an individual account. |
| "This feature is not available for individual accounts" (`COMPANY_FEATURE_UNAVAILABLE`) | Inviting people and managing other people's browsers are company-workspace features (coming soon). |
| An employee created their own account by mistake | They used **Create an account** instead of your invite. Invite them; their separate account has no access to yours (AgentShield can suspend it). Note that an email can only have one account. |
| "Email not configured" when inviting | Set `SMTP_HOST`, `SMTP_FROM` (and user/password) in `.env` and restart. |
| Invite expired | **Resend** it (new 72-hour link). |
| "An account with this email already exists" on sign-up | The email already has an account. Sign in, or use **Forgot password?** (the reset link goes to that inbox). If someone else registered the address, the real owner takes it over this way; the reset ends all other sessions. |
| Strangers signing up | On a public service this is expected: each sign-up gets its own, isolated account and sees nothing of yours. For a private server set `SIGNUP_ALLOWED_DOMAINS` or `SIGNUP_ENABLED=false` and restart; AgentShield staff can suspend unwanted accounts in the internal console. |
| "Use your work email address" on sign-up | The domain is not in `SIGNUP_ALLOWED_DOMAINS`; invite the person instead if they should have access. |
| "This account already has 3 browsers" | The user signs one out in My activation, or you **Revoke** an old one. |
| Browsers stopped working after upgrading to 1.3 | Expected: enrollment codes and device keys were retired. Invite users (or let them sign up) and have each browser activated. `LEGACY_DEVICE_KEYS_ENABLED=true` re-accepts old keys temporarily, for emergencies only. |
| Many "Not seen today" | Extensions disabled or removed. Use force-install (DEPLOY_STEPS.md). |
| Events missing for an employee | Their browser is offline; events are queued (up to 500) and arrive after the next sync. |
| "Too many failed sign-in attempts" | Wait 15 minutes; check the audit log for `login.failed` from unexpected IP addresses. |
| A legitimate prompt is blocked | Check which rule fired (event detail). Remove a too-broad keyword, or lower that rule to Warn/Monitor. |
| Dashboard says session expired | Sign in again (dashboard sign-ins last `DASHBOARD_TOKEN_HOURS`, 12 h; a password change, reset or **Sign out everywhere** also ends them). |
| Personal API token gets 401 | It was revoked, expired or mistyped, or used on an endpoint other than `/api/v1/public/*`. 403 means the token lacks that scope or the account is disabled or suspended. |
