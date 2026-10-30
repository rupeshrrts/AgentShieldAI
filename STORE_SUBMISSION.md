# Publishing AgentShield to the Chrome Web Store and Microsoft Edge Add-ons

Extension 1.9.0 (server 2.6.0). Everything a reviewer asks for, in the order the store forms ask for it. The
facts here must stay true: if the extension's behaviour changes, update this file with
[SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) and [DATA_HANDLING.md](./DATA_HANDLING.md).

## 1. Build the packages

```powershell
cd extension; npm install; npm test
node ..\scripts\packaging\store-packages.js --api-url https://YOUR-API --dashboard-url https://YOUR-PORTAL
```

Output in `dist-store/`: `agentshield-chrome-1.9.0.zip`, `agentshield-edge-1.9.0.zip` (the same Manifest V3 package)
and `store-release.json` (sizes and SHA-256). The script refuses to write a package unless:

* Manifest V3, valid version, name ≤ 75 and description ≤ 132 characters, no `key`, no `optional_permissions`, no `externally_connectable`;
* permissions are exactly the ones below (no `nativeMessaging`: the extension needs no `.exe` or other program);
* every file the manifest or the HTML pages refer to is inside, the 128 px icon is present, every JSON file parses;
* no `.exe`, `.dll`, scripts, keys, `.env`, source maps, TypeScript sources, tests or `client-config.json`;
* no remote or dynamically evaluated code (`eval`, `new Function`, `importScripts`, remote `<script>`);
* the production server address is built in (`--api-url`, https only).

`--api-url` / `--dashboard-url` are only the defaults shown before a browser is connected (the popup's link to the
portal); every activation code carries its own server address. Test builds: `--allow-localhost --out <folder>` (never upload those).

## 2. Store listing

| Field | Value |
| :--- | :--- |
| Name | AgentShield - AI Browser Security |
| Short description (manifest, 132 max) | Stops secrets and personal data leaking into AI tools, and blocks dangerous, adult and piracy websites. |
| Category | Chrome: Productivity → Tools (or Workflow & Planning). Edge: Productivity |
| Language | English |
| Icon | `extension/icons/icon-128.png` |
| Screenshots (to make, 1280×800 or 640×400) | Popup connected · "Prompt blocked" dialog on an AI site · dashboard Protection rules · Website controls · block page |
| Support / homepage | Your portal address and a support email |
| Privacy policy URL | Host §5 below on your website (required because the extension handles account and website data) |

**Detailed description** (paste):

> AgentShield protects your organization's data in AI tools such as ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral, Poe, Meta AI and Grok.
>
> Before a prompt or file leaves the browser, AgentShield checks it inside the browser for passwords, API keys and tokens, private keys, payment card numbers, email addresses, phone numbers, Indian PAN and Aadhaar numbers, and your company's confidential keywords. Depending on the rules your administrator switched on, it blocks, masks, warns, records or allows. It can also block dangerous, adult, piracy, gambling and other kinds of websites, enforce Safe Search, and block AI tools your organization has not approved.
>
> Rules are managed centrally in the AgentShield portal and reach connected browsers within about a minute. Only rules that are switched on are enforced.
>
> An AgentShield account is required: sign in to the AgentShield portal, generate an activation code and paste it into the extension. AI sites stay blocked in a browser until it is connected.

**Single purpose** (Chrome form): "Data-loss prevention for AI tools: check what a user sends to AI websites against the organization's rules, and block websites the organization does not allow."

## 3. Permission justifications

| Permission | Justification (paste) |
| :--- | :--- |
| `storage` | Keeps the organization's rules, website lists and a queue of unsent security events between browser sessions, and the short-lived session in session storage. Reads the managed policy an IT administrator may set (server address only). |
| `alarms` | Once a minute checks whether the organization changed its rules and renews the browser's 15-minute session, so dashboard changes apply within about a minute. |
| `tabs` | Sends updated rules to open tabs at once, and redirects a tab to the block page when it opens a website the organization blocks (backup for the network rules). |
| `declarativeNetRequest` | Blocks websites the organization blocks (its own list, the built-in website categories, unapproved AI tools) before they load, and applies Safe Search parameters and YouTube Restricted Mode. |
| Host permission `<all_urls>` | Website blocking must work on any address the organization chooses and on the category lists, and the extension must reach the organization's own AgentShield server. Prompt and upload checks run only on known AI websites; on other pages the content script only compares the address with the block lists. Page content of other sites is not read or sent. |
| Remote code | No. All code is in the package; rules and lists are data. |

## 4. Data disclosure (Chrome "Privacy practices", Edge "Privacy" section)

What the extension sends to **the organization's own AgentShield server** (no other recipient, no advertising, no analytics, nothing sold):

| Store category | Collected? | What exactly |
| :--- | :--- | :--- |
| Personally identifiable information | Yes | The account email the browser is connected to (from the server, used to attribute security events). Detected personal data in prompts is never sent in readable form when masked rules apply (see website content) |
| Authentication information | Yes (not passwords) | A device public key and short-lived session tokens. The extension never asks for or stores a password |
| Website content | Yes, limited | For a prompt or upload that matched a rule: site, rule, action, outcome and, **only if the organization switched it on**, the prompt text with credentials, wallet keys, card, Aadhaar, IBAN, bank account, passport and voter ID numbers masked. Allowed prompts are counted; their text is sent only if the organization opted in |
| Web history / user activity | Limited | When a website is blocked: the blocked domain (organization's own list or unapproved AI) or only the category name (category lists). Other browsing is not reported |
| Location, health, financial, personal communications | No | Not collected (payment card numbers in prompts are detected locally and masked) |

Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

## 5. Privacy policy (host this text; adapt the company name and contact)

> **AgentShield browser extension — privacy policy**
>
> The AgentShield extension is provided to organizations to stop sensitive data from being sent to AI tools. It works only after a user connects it to their organization's AgentShield account.
>
> **What is checked locally.** Prompts and attached text files on supported AI websites are checked inside the browser. Nothing is sent anywhere to make that decision.
>
> **What is sent, and to whom.** Only to the organization's AgentShield server: the connected account's email; for prompts or uploads that matched a rule, the website, rule, action and outcome, and, only if the organization chose to store it, the prompt text with credentials, wallet keys, card, Aadhaar, IBAN, bank account, passport and voter ID numbers masked; the domain or category of websites that were blocked; the extension and browser version for the organization's device list. Nothing is sent to the extension's developer, advertisers or any other third party, and no data is sold.
>
> **What is stored in the browser.** The organization's rules, website lists, a non-extractable device key and a queue of unsent events. No password or activation code is stored.
>
> **Retention and access.** The organization controls how long events are kept (retention setting) and who can see them. Ask your organization's administrator to see or delete your data, or contact [support email].
>
> **Removing the extension** stops all checks and reporting; the organization can also disconnect the browser from its portal.

## 6. Reviewer access (both stores ask how to test)

Reviewers cannot use the extension without an account. In "Notes for certification" (Edge) / "Test instructions" (Chrome) give:

1. A review account on the production portal (individual account with an active plan), its email and password.
2. Steps: sign in → **Connect browser** → **Generate activation code** → click the AgentShield icon → paste → **Connect and verify** → open chatgpt.com and send `my key sk-demo-EXAMPLE123456789` (blocked) → in the portal switch **API keys** Off under Protection rules → within a minute the same prompt is sent.

Create that account just before submitting and remove it after review. Never put the password in this repository.

## 7. After approval

* Set `CHROME_STORE_EXTENSION_ID` and `EDGE_STORE_EXTENSION_ID` on the server: the portal's Download page then links to the stores and the Deployment page shows the force-install values (`<id>;https://clients2.google.com/service/update2/crx` for Chrome, `<id>;https://edge.microsoft.com/extensionwebstorebase/v1/crx` for Edge).
* Company PCs: force-install with `ExtensionInstallForcelist` and set the extension policy `apiUrl` (Group Policy, Intune or any MDM). No Windows program is needed.
* The store IDs differ from the self-hosted ID (`ahdfdohnhdlppjhnppbhecggfjceaalc`); browsers connected with the self-hosted copy must be connected again after switching to the store copy.

## 8. Still open before submitting

* Screenshots and the small promo tile (440×280) are not in the repository.
* The website-category lists are HaGeZi DNS blocklists under GPL-3.0 and UT1 blacklists under CC BY-SA 4.0 (attribution and share-alike; see `extension/rulesets/LICENSE-DATA.md`): have the distribution terms reviewed before publishing.
* The package was tested in Microsoft Edge 156 (automated, `npm run test:e2e`). Google Chrome 156 refuses to load unpacked extensions from the command line, so Chrome itself was not automated; install the zip once in Chrome (Developer mode → Load unpacked on the extracted folder) and repeat the reviewer steps above before uploading.
