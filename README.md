# AgentShieldAI

AgentShieldAI helps individuals and organizations reduce accidental data exposure when people use AI tools in a web browser. A browser extension checks prompts against security rules, can warn about or block risky submissions, and reports policy events to an AgentShield server for review.

## What it does

- **Checks prompts in the browser.** The extension detects configured sensitive information and applies the account's security policy before a prompt is submitted on supported AI sites.
- **Controls access to websites.** Configured domain and website-category rules can block selected sites.
- **Provides central administration.** The customer portal manages policies, users and browsers, security events, account plans, and usage.
- **Records security events.** Activated browsers report policy outcomes to the API so authorized account operators can review activity.
- **Supports optional Windows deployment.** The Windows app can connect a PC and help activate its browsers.
- **Separates service administration.** The internal admin console is for AgentShieldAI staff and is separate from customer accounts.

## How it works

1. An administrator or individual configures an account and its policies in the customer portal.
2. A user installs the browser extension and activates that browser using a single-use code from the portal. Installing the extension alone does not authorize it.
3. The extension checks prompts locally in the browser and applies the configured policy.
4. The extension sends security events to the AgentShield API. Prompt text is not needed for local decisions; any prompt text stored for auditing is subject to the account's settings and masking.
5. Authorized operators review events and manage policies in the portal.

## Main components

| Component | Location | Purpose |
| --- | --- | --- |
| Browser extension | [`extension/`](./extension/) | Checks AI prompts, applies browser policies, blocks configured websites, and reports events |
| Backend API | [`backend/`](./backend/) | Authentication, browser authorization, policy delivery, event ingestion, account and usage services |
| Customer portal | [`dashboard/`](./dashboard/) | Account, policy, browser, event, and usage management |
| Internal admin console | [`admin-console/`](./admin-console/) | AgentShieldAI staff operations, isolated from the customer portal |
| Optional Windows app and installer | [`scripts/`](./scripts/), [`dist-installer/`](./dist-installer/) | PC connection and managed browser deployment |

## Getting started

- **Deploy and configure AgentShield:** see [INSTALL.md](./INSTALL.md).
- **Set up an individual account or activate as an employee:** see [USER_SETUP.md](./USER_SETUP.md).
- **Deployment options:** see [DEPLOYMENT.md](./DEPLOYMENT.md) and [PRODUCTION_GUIDE.md](./PRODUCTION_GUIDE.md).

The root `npm start` command starts the local project workflow. Before running the backend or tests, use a temporary SQLite `DATABASE_URL` so a local run cannot connect to a live database. See [AGENTS.md](./AGENTS.md) for the safe verification commands and contributor requirements.

## Architecture, security, and privacy

- [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) describes the components, trust boundaries, and authentication model.
- [DATA_HANDLING.md](./DATA_HANDLING.md) describes what browser and account data is processed and stored.
- Browser access is granted through per-browser activation and server-issued device sessions; installation or locally stored state alone does not grant authorization.
- The API derives organization identity from authenticated credentials and isolates customer data by organization.

## For AI agents and contributors

Read [AGENTS.md](./AGENTS.md) before changing code. In particular:

- Keep prompt detection and policy evaluation in the extension and backend aligned.
- Route prompt text stored in the database through `prepare_prompt_for_storage()` in `backend/app/core/privacy.py`.
- Preserve the documented authentication boundaries, tenant isolation, and fail-closed extension authorization.
- Do not edit generated files such as `extension/dist/`, `extension/src/popup/popup.js`, or `dashboard/dist/`.
- Set `DATABASE_URL` to a temporary SQLite database before backend tests or local server runs.

## Change history

- Added this project overview, component map, and links to setup, architecture, security, and contributor guidance.
