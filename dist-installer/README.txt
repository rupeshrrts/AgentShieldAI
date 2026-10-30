========================================================================
                          AgentShield Setup
        Protects company data in ChatGPT and other AI tools
========================================================================

YOU NEED: Google Chrome or Microsoft Edge (version 110 or newer) and an
AgentShield account with an active plan, the Free plan or prepaid credits.
  - For yourself: "Create an account" > Individual (Company is
    "coming soon"), then confirm your email from the link we send.
  - Employees of an existing company workspace: use the invite email
    from your company's admin. Do NOT click "Create an account" - that
    creates a separate, individual account.
No Windows program is needed: AgentShield is a browser extension.
The extension never asks for your email or password. Installing alone
gives no access: AI sites stay blocked until you connect.

------------------------------------------------------------------------
INSTALL
  From the store (once published): open the store link on the portal's
  Download page and click "Add to Chrome" / "Get".

  From the zip on the portal's Download page:
  1. A zip cannot be installed by double-clicking it. Extract it to a
     folder you keep.
  2. chrome://extensions (or edge://extensions) > "Developer mode" on >
     "Load unpacked" > choose that folder.
  (Quick-Install.bat does the same from the "extension" folder next to it:
   it copies it to %LOCALAPPDATA%\AgentShield\extension and opens the
   extensions page.)
  The Download page shows the zip's SHA-256; check it with:
     certutil -hashfile <zip file> SHA256

CONNECT
  1. In the portal, Connect browser > "Generate activation code"
     (single-use, valid 30 minutes, starts with ASA1.).
  2. Click the AgentShield toolbar icon, paste the code and click
     "Connect and verify". Each browser connects with its own code.

IF THE POPUP SAYS "Your plan has ended" (or checks / credits used up,
or your monthly limit reached):
  AI sites are blocked until the plan is renewed, credits are bought
  or the limit is raised in the portal (employees: your admin does
  this). The browser then reconnects by itself within about a minute
  (or click "Check again"). No reinstall and no new code needed.

FOR IT (users cannot remove it):
  Force-install with Chrome / Edge enterprise policy (Group Policy,
  Intune or any MDM): ExtensionInstallForcelist = the value on the
  portal's Deployment page, and the extension policy apiUrl = your
  server. Or run, as administrator:
    powershell -ExecutionPolicy Bypass -File scripts\system-installer\Install-AgentShield.ps1 -ServerUrl https://agentshield.company.com
  Every user still connects their own browser. See DEPLOYMENT.md.

This folder: package\ = the built extension (zip and CRX, made by
node scripts\packaging\pack-extension.js); AgentShield-Agent.exe = the
optional Network Agent (other browsers and desktop AI apps, see
agent\README.md). The AgentShield Windows app and AgentShield-System-
Setup.exe were retired in 2.6: the extension no longer needs any .exe.

Full guide for individuals and employees: USER_SETUP.md
========================================================================
