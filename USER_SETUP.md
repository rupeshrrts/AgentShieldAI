# AgentShield — Setup for Individuals and Employees

AgentShield checks what you send to AI tools such as ChatGPT, so customer data, passwords and confidential information don't leak by accident. It works inside your browser and takes about **5 minutes** to set up.

You need: **Google Chrome or Microsoft Edge**, and the **address of the AgentShield portal** (the AgentShield website, or from your company's IT if your company runs its own).

> **Until you activate it, AI sites are blocked.** In a browser where AgentShield is installed but not yet activated, ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral, Poe, Meta AI, Grok, AI Studio and OpenAI show an **Activation Required** page. This is expected: follow the steps below.
>
> **On most company PCs, IT has already installed AgentShield** in Chrome and Edge (with *AgentShield-System-Setup*). Then skip step 3 and just sign in and activate.

**The whole journey (individual account):** sign up → confirm your email → start the free trial, buy a plan or buy credits → download the extension → **Connect browser** in the portal and generate an activation code → paste it into the extension → protected. Everything else (usage, credits, alerts, browsers, API tokens, profile) is managed in the same portal with the same sign-in.

---

## 1. Create your account

**For yourself (Individual account):**

1. Open the AgentShield portal and click **Create an account**.
2. Choose **Individual** (*Available now*). **Company** shows *Coming soon*: company workspaces with employees and central billing are not open for sign-up yet.
3. Enter **Your name** (optional), **Email**, **Choose a password** (at least 12 characters) and **Confirm password**, then click **Create account**. You are signed in straight away.
4. **Confirm your email:** we send you a link (it works once and expires after 24 hours). Open it. Until you do, a banner in the portal reminds you and offers **Send a new link**. Confirming is needed to start the free trial; you can look around, buy a plan or buy credits before that.

If **Create an account** is not shown, or your email is refused, the server only allows invited accounts or certain email domains, or the address is a temporary mailbox.

**If your company sent you an invite email (employees of an existing company workspace):** click the link in it (it works once and expires after 72 hours; ask IT to resend it if it has expired), choose a password of at least 12 characters and confirm. Your account is now created in your company, and your company's plan covers you: skip step 2.

> **Employees: do not click "Create an account".** That creates a separate, **individual** account. It does not join your employer's company, and you would not get its rules or access. If you have no invite, ask IT.

Keep your password private: you need it to sign in to the portal and generate activation codes. Forgot it? Click **Forgot password?** on the sign-in page; a link valid for 60 minutes is emailed to you, and setting a new password signs you out everywhere.

## 2. Start a plan

Open **Account & plan** (under **Get started**) and choose one:

* **Claim free 30-day trial** — once per person, after your email is confirmed. If it is refused, the page tells you why (email not confirmed yet, this email already had a trial, a temporary mailbox, or too many trials from your network).
* **Buy a plan** — monthly (**Subscribe**, renews automatically until you cancel), 6-month or annual (**Buy**, one payment). You pay in Razorpay's secure window (card, UPI, net banking); AgentShield never sees your card or UPI details. The plan starts as soon as the payment is confirmed and you get a receipt under **Billing**. A plan may include a number of prompt checks per month (shown on the plan).
* **Buy credits** — prepaid prompt checks (pay as you go, e.g. 1,000 checks). Credits never expire. Without a plan, credits alone keep you protected; with a plan, they are used once the plan's monthly checks are used up.

A **prompt check** is one prompt that AgentShield inspected on an AI site in your activated browser (allowed prompts count too; blocked websites and file uploads don't). **Usage & credits** shows how many you used this month (calendar month, UTC), your credits and their history, and lets you set **your own monthly limit** so you never use more than you want.

## 3. Install

**On Windows (easiest, every browser at once):** in the portal open **Download** and click **Download for Windows (.exe)**. Then:

1. In the portal open **Connect browser** and click **Generate activation code**. Copy the code (starts with `ASA1.`, works once, for 30 minutes).
2. Run `AgentShield-System-Setup.exe`, click **Yes** when Windows asks, and paste the code when setup asks for it. Setup installs the AgentShield app and connects this PC to your account. (No code yet? Leave it empty and connect later from **Connect AgentShield** in the Start menu, or with **Connect this PC** in the portal.)
3. Click **Finish**.
   * **Personal PC** (not joined to a company domain, Entra ID or Intune): Chrome and Edge do not let a setup add an extension by itself, so the extensions page of each browser opens. Turn on **Developer mode**, click **Load unpacked**, press **Ctrl+V** (setup copied the folder `C:\Program Files\AgentShield\extension`) and select it. Do this once per browser.
   * **Company-managed PC:** AgentShield appears in Chrome, Edge and Brave by itself (restart them if the icon is not there yet).
4. Done: AgentShield connects by itself in every browser, without pasting a code into the browser. Skip step 4 below.

Your PC uses **one device** of your plan, however many browsers it has. The browsers may show "Managed by your organization" because setup writes AgentShield's settings as browser policy. To update a copy added with **Load unpacked**, run the newest setup again and click reload on the extensions page. To stop, remove the PC in **Connect browser → Remove PC** or uninstall AgentShield in Windows **Settings → Apps**. Other Windows users of the same PC connect their own account from **Connect AgentShield** in the Start menu.

**If you received a store link:** open it in Chrome and click **Add to Chrome** (in Edge click **Get**), confirm, then go to step 4.

**From the portal:** sign in and open **Download** (under **Get started**). Pick the **Chrome** or **Edge** tab. It shows a store link if there is one; otherwise a versioned zip with the steps below. Downloading needs no plan.

**If you received a zip file (e.g. `agentshield-extension.zip`):** a zip cannot be installed by double-clicking it. Extract it to a folder you will keep (e.g. `C:\AgentShield\extension`), open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and choose that folder. Chrome or Edge 110 or newer is needed. (Optional: the **Download** page shows the zip's SHA-256 and the command to check it.)

**If you received a folder with `Quick-Install.bat`:** double-click it and follow the instructions. When the Extensions page opens, turn on **Developer mode** (top right), click **Load unpacked**, and choose the folder it shows (`%LOCALAPPDATA%\AgentShield\extension`).

Then click the puzzle-piece icon in the toolbar and pin **AgentShield**.

## 4. Activate this browser

Not needed if you connected the PC with AgentShield for Windows (step 3). Otherwise do this once in each browser you use (Chrome and Edge are separate). Each browser connected this way uses one device of your plan.

1. Sign in to the AgentShield portal with your email and password. Open **Connect browser** (in a company workspace: **My activation**) and click **Generate activation code**. The code starts with `ASA1.`, works once and is valid for 30 minutes. If the button is disabled, there is no active plan or credits yet: the page says why (start one in step 2, or ask your company admin).
2. In Chrome or Edge, click the AgentShield icon. The **AgentShieldAI — Activation Required** screen opens with three steps: 1 Create an account or sign in, 2 Generate your code, 3 Paste it below.
3. Paste the code into the **Activation code** box and click **Connect and verify**. The extension does not ask for your email or password.
4. Wait for the confirmation from the AgentShield server. If your company requires approval for new browsers, the popup says it is waiting for an administrator; AI tools stay blocked until IT approves it.

**Never share your code.** It belongs to your account: whoever pastes it first connects a browser to *your* account. Generate a new one if it expires (a new code cancels the old one).

## 5. Check it works

1. Click the AgentShield icon. You should see **Protected**, **Signed in as** your email, your account's name and a plan card (Free trial or the plan name with days left and end date, or **Pay as you go** with the prompt checks left). In the last 7 days of a plan a yellow "ends in N days" banner appears.
2. Open chatgpt.com. A small "AgentShield Protected" badge appears in the corner.
3. Optional test: type `password: Test-Only-123` and press Enter. A red **Blocked** message should appear, and nothing is sent.

## 6. What the alerts mean

| You see | What happened | What to do |
| :--- | :--- | :--- |
| **Activation Required page** | This browser is not activated, its activation was removed, your account is disabled, your plan, included checks or credits ran out, your own monthly limit was reached, or the AgentShield server cannot be reached. | Activate it (step 4). If it was working before, open the popup to see why, check your connection, or look at **Account & plan** and **Usage & credits**. |
| **Popup: Your plan has ended** (or "checks used up", "limit reached", "credits used up") | The plan expired, this month's included prompt checks or your credits are used up, or you reached your own monthly limit. AI sites are blocked. | Renew, buy credits or raise your limit in the portal (**Choose a plan** opens it; employees: ask your company admin). Your browser stays activated and unlocks by itself within 5 minutes, or click **Check again**. No new code and no reinstall needed. |
| **Red — Blocked by your organization** | The prompt or file contained something that must never go to an AI tool (password, API key, card or Aadhaar number, or something your rules block). Nothing was sent. | Remove the sensitive part and send again. If a password or key was already shared elsewhere, change it (company: tell IT). |
| **Amber — Check before you send** | It may contain personal or sensitive data (email, phone, PAN, a file upload). | Remove it, or click **Send anyway** if it's allowed for your work. Adding a short reason helps whoever reviews the alerts. |
| **Blue — Mask sensitive terms** | It contains a confidential term from your keyword list. | Click **Mask and send** to send it with the term replaced by `[REDACTED]`, or edit it yourself. |
| **Website Blocked page** | The site (for example an online PDF converter or an unapproved AI tool) is not allowed. | Use an approved tool, or change **Website controls** (company: ask IT to review the site). |

**What is recorded:** your account (and, for employees, your company) receives a record when a rule is triggered: the rule, the site, the time, your account's email and, depending on the privacy settings, the prompt with passwords, keys and card/Aadhaar numbers hidden. Every inspected prompt is also counted for usage (a number per day, without its text). The account can also see which browsers are activated. Your browsing history is not collected.

**Managing your account (individuals):** in the same portal: **Security alerts**, **Usage & credits**, **Protection rules**, **Website controls**, **Connect browser** (your browsers), **API connections** (personal read-only tokens for your own tools; each token is shown once), **Profile & security** (name, email confirmation, password, sign out everywhere). **Company workspace** shows *Soon*.

**Leaving a shared or old PC:** click the AgentShield icon → **Sign out this browser**, or sign out that browser from **Connect browser** / **My activation** in the portal.

## 7. Troubleshooting

| Problem | Fix |
| :--- | :--- |
| Invite link "expired" or "already used" | Ask IT to resend the invite. |
| "An account with this email already exists" after **Create account** | You (or someone using your address) already signed up. Sign in, or click **Forgot password?**: the reset link goes to your inbox, so you can take the account over; this also signs out every other session. |
| "Company accounts are coming soon" | Company workspaces are not open yet. Create an **Individual** account. |
| Confirmation email not received | Check your spam folder, then **Send a new link** (banner or **Profile & security**). |
| Confirmation link "invalid, expired or already used" | Links work once and expire after 24 hours. Sign in and **Send a new link**. |
| **Claim free 30-day trial** refused: "Confirm your email address" | Open the confirmation link from your inbox first. |
| "Use your work email address to create an account" | Only certain email domains can sign up on this server. Use your work email, or ask IT for an invite. |
| "Temporary email addresses can't be used" | Disposable mailboxes are refused. Use a real email address. |
| "Invalid email or password" on the portal | Use the email and password of your AgentShield account, or click **Forgot password?**. |
| Reset link "invalid, expired or already used" | Request a new one with **Forgot password?**; links work once and expire after 60 minutes. |
| Signed out of the portal | Sign-ins last 12 hours; changing or resetting your password, or **Sign out everywhere**, also signs you out. Sign in again. |
| "Your plan has ended", or "no licence" / "licence revoked" / "account suspended" in the popup | No active plan. Start or renew one on **Account & plan** (employees: ask your company admin). Once it is restored, click **Check again**; you don't need a new code. |
| "This month's included prompt checks are used up" | Buy credits (extra checks then use credits) or upgrade; included checks start again on the 1st of next month (UTC). |
| "Your monthly usage limit is reached" | You set this limit. Raise or remove it in **Usage & credits**. |
| "Your prepaid credits are used up" | **Buy credits** or choose a plan on **Account & plan**. |
| "Your plan allows N browsers and all are in use" | Sign out a browser you no longer use in **Connect browser** / **My activation**, or move to a plan with more browsers. |
| "This activation code is not valid" | Copy the whole code (it starts with `ASA1.`), or generate a new one. |
| Code "expired", "already used" or "replaced" | Generate a new code and use it within 30 minutes. |
| "Waiting for an administrator to approve this browser" | IT must approve it. AI tools stay blocked until then. |
| "This account already has 3 browsers" | Sign out a browser you no longer use in **Connect browser** / **My activation**, then try again. |
| "Cannot reach the AgentShield server" | Check your internet/VPN connection, then click **Retry connection**. AI tools stay blocked until the connection is restored. |
| AI sites suddenly show **Activation Required** | The browser's activation was revoked, your account disabled, your plan, checks or credits ran out, or the server is unreachable. Check the message in the popup; activate again, click **Check again**, or check **Account & plan**. |
| Badge shows **Not Protected** on an AI site | The site changed its layout. Reload the page; if it persists, tell IT or AgentShield support. |
| A normal prompt is flagged by mistake | Choose **Send anyway** for warnings, or adjust **Protection rules** (company: tell IT, including the time). |
| The AgentShield icon disappeared | It was removed or disabled. Re-install it (step 3), or ask IT. |
