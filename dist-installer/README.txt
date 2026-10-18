========================================================================
                          AgentShield Setup
        Protects company data in ChatGPT and other AI tools
========================================================================

YOU NEED: Windows 10 or 11 with Google Chrome, Microsoft Edge or Brave
(version 110 or newer), and an AgentShield account with an active plan,
the Free plan or prepaid credits.
  - For yourself: "Create an account" > Individual (Company is
    "coming soon"), then confirm your email from the link we send.
    You then have the Free plan; Account & plan offers the 30-day
    trial, plans and credits.
  - Employees of an existing company workspace: use the invite email
    from your company's admin. Do NOT click "Create an account" - that
    creates a separate, individual account.
The extension never asks for your email or password. Installing alone
gives no access: AI sites stay blocked until you connect.

------------------------------------------------------------------------
EASIEST ON WINDOWS: AgentShield-System-Setup.exe (every browser at once)
  1. Run AgentShield-System-Setup.exe and click Yes when Windows asks.
     It adds AgentShield to Chrome, Edge and Brave and installs the
     AgentShield app.
  2. At the end leave "Connect this PC to my AgentShield account now"
     ticked and click Finish. The "Connect AgentShield" window opens.
  3. Sign in to the AgentShield portal, open Connect browser and click
     "Connect this PC" (then "Open AgentShield" and "Connect").
     Or click "Generate activation code" and paste the code (starts
     with ASA1.) into the Connect AgentShield window.
  4. Done. Every browser on this PC connects by itself within a minute
     (restart the browsers if the AgentShield icon is not there yet).
  Your PC uses ONE device of your plan, however many browsers it has.
  Other Windows users of this PC: open "Connect AgentShield" from the
  Start menu and connect with their own account.
  Remove a PC in the portal (Connect browser > Remove PC) or in the
  Connect AgentShield window (Disconnect). Uninstall: Windows Settings >
  Apps > AgentShield.
  NOTE: on a personal PC, browsers only accept this automatic install
  when the extension is published in the Chrome Web Store / Edge Add-ons
  (the server then uses the store copies). The browsers show "Managed by
  your organization" because AgentShield is installed by policy.

ONE BROWSER ONLY (any computer): Quick-Install.bat or the store
  1. Make sure the "extension" folder is next to Quick-Install.bat and
     double-click it (or install from the store link on the Download page).
  2. On the Extensions page that opens: turn on "Developer mode",
     click "Load unpacked", and select the folder that opened
     (%LOCALAPPDATA%\AgentShield\extension).
  3. In the portal, Connect browser > "Generate activation code"
     (single-use, valid 30 minutes, starts with ASA1.).
  4. Click the AgentShield toolbar icon, paste the code in the
     "Activation code" box and click "Connect and verify".

IF YOU HAVE A ZIP FROM THE PORTAL'S DOWNLOAD PAGE:
  A zip cannot be installed by double-clicking it. Extract it to a
  folder you keep, then chrome://extensions (or edge://extensions) >
  "Developer mode" on > "Load unpacked" > choose that folder. Then do
  steps 3 and 4. The Download page shows the zip's SHA-256; check it
  with:  certutil -hashfile <zip file> SHA256

IF THE POPUP SAYS "Your plan has ended" (or checks / credits used up,
or your monthly limit reached):
  AI sites are blocked until the plan is renewed, credits are bought
  or the limit is raised in the portal (employees: your admin does
  this). The browser then reconnects by itself within 5 minutes (or
  click "Check again"). No reinstall and no new code needed.

FOR IT (users cannot remove it):
  AgentShield-System-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
    /SERVER=https://agentshield.company.com  [/DASHBOARD=https://...]
    [/CODE=ASA1....]
  (or scripts\enterprise\Set-AgentShieldPolicy.ps1 -ApiUrl <server>).
  This installs the extension and the AgentShield app and sets the
  server address; every Windows user still connects with their own
  account (Connect AgentShield, or /CODE= for the installing user).
  See DEPLOYMENT.md.

BUILDING THE SETUP (developers):
  powershell -File scripts\helper\build-helper.ps1
  ISCC.exe scripts\system-installer\AgentShield-System-Setup.iss
  For the public build add /DDefaultServer=https://api... and
  /DDefaultDashboard=https://app... so nobody is asked for addresses.

NOTE: the old per-user AgentShield-Setup.exe and AgentShield-Client-v1.0.0.zip
builds (which asked for an enrollment code, no longer used) were removed.
Rebuild them from scripts\installer.py / scripts\installer.iss if ever needed.

Full guide for individuals and employees: USER_SETUP.md
========================================================================
