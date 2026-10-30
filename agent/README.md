# AgentShield Network Agent

A local proxy that applies AgentShield policy to **every browser and desktop AI app on a PC** — not
just Chrome/Edge/Brave with the extension. It is **free and self-hosted**: it talks to the AgentShield
server you already run and needs no third-party subscription (no Zscaler/Netskope).

It is a **complement to the extension, not a replacement.** The extension stays the best control on
managed Chrome/Edge/Brave (it reads the page directly and shows inline dialogs). The agent fills the
gaps the extension cannot reach: Firefox, other browsers, and desktop apps such as the ChatGPT or
Copilot app, which use the Windows system proxy.

## What it does, and what it deliberately does **not** do

* It opens (decrypts) **only the AI domains** in `agentshield_agent/config.py` (`INTERCEPT_DOMAINS`:
  chatgpt.com, claude.ai, gemini.google.com, …). **All other traffic — banking, health, mail — is
  tunnelled untouched and never decrypted.** This matters for privacy (DATA_HANDLING.md) and means a
  pinned app or an outage only ever affects AI sites.
* For an AI request it extracts the prompt text, runs the **same detector and policy evaluator as the
  backend and the extension** (`backend/app/detection/detector.py`, `backend/app/policies/evaluator.py`
  are imported directly — there is no third copy of the rules), and then Blocks, Redacts, Warns,
  Monitors or Allows exactly as the extension would, including the employee Suspend/Restrict rules.
* It is **fail-closed**: AI sites stay blocked until the server issues a live device session. Nothing
  read from disk makes it authorized.
* It does **not** inspect file uploads (multipart) or binary bodies, the same limitation the extension
  has for non-text files.

## Authentication — no shared keys

The agent connects through the **same flow as the AgentShield Windows app** (`backend/app/api/computers.py`
and `device_auth.py`), so the backend needed no changes:

1. the person generates a single-use code in the portal (**Connect browser → Connect this PC**, or
   **My activation**);
2. `connect` sends it with a new PC key → the PC holds one device slot;
3. the agent gets a device of that PC (its own key) and signs a challenge for each 15-minute session.

The organization is always taken from the server session, never from the request. Private keys are
generated on the PC, protected with Windows DPAPI (machine scope), and never leave it or ship in any
installer. Each PC generates its **own** CA.

## Install on a PC (the easy way — one exe)

The exe is its own installer. For a personal PC this is all it takes, with **no browser extension and
no Developer mode**:

1. In the portal: **Connect browser → Generate activation code**, copy the `ASA1…` code.
2. Download **AgentShield-Agent.exe** (portal → Download) and run it. Click **Yes** at the Windows
   prompt, and paste the code when it asks.
3. Restart your browsers. AI sites are now protected in Chrome, Edge, Brave, Opera and Firefox.

Double-clicking the exe runs `install`: it elevates, copies itself to Program Files, generates this
PC's certificate and trusts it, sets a PAC proxy for the AI domains only, registers a SYSTEM service
that starts with the PC, and connects. Remove it any time with `AgentShield-Agent.exe uninstall`
(as administrator). Other commands: `status`, `connect`, `disconnect`, `new-ca`, `run`.

Build the exe (needs the backend venv, which has cryptography + pyinstaller):

```powershell
backend\.venv\Scripts\python.exe -m PyInstaller agent\packaging\agentshield-agent.spec `
    --distpath agent\packaging\dist --workpath agent\packaging\build --noconfirm
# then publish it so the portal can serve it:
Copy-Item agent\packaging\dist\agentshield-agent.exe dist-installer\AgentShield-Agent.exe
```

## Run from source (development)

```powershell
backend\.venv\Scripts\pip install -r agent\requirements.txt
cd agent
..\backend\.venv\Scripts\python.exe -m agentshield_agent connect ASA1.xxxxxxxxxxxx
..\backend\.venv\Scripts\python.exe -m agentshield_agent run --port 8080
# or, with mitmproxy doing the TLS/streaming work:
mitmdump -s mitm\agentshield_addon.py --listen-host 127.0.0.1 -p 8080 --set connection_strategy=lazy
```

The PowerShell scripts in `agent/packaging` (`Install-Agent.ps1` / `Uninstall-Agent.ps1`) do the same
machine setup as the exe's installer and are handy as a reference for a GPO/Intune rollout.

## Make it stick (production) — the part that gives real control

A local proxy a user sets by hand can be turned off by that user. The paid products stop bypass not
with cleverer interception but by **managing the device**. Do the same with tools you already own —
**Active Directory Group Policy** (free with Windows Server) or **Microsoft Intune** (included in many
Microsoft 365 plans). None of this is scripted by the agent; it is standard enterprise deployment:

1. **Run the agent as a service, as SYSTEM.** Package the venv with PyInstaller, or install it with
   [NSSM](https://nssm.cc/) (`nssm install AgentShieldAgent …`). Running as SYSTEM means a normal user
   cannot stop it. Connect each PC once (the code can be delivered by the portal's **Connect this PC**).
2. **Trust the certificate for every user.** Deploy each PC's
   `%ProgramData%\AgentShield\Agent\ca\agentshield-root.cer` to **Computer → Trusted Root Certification
   Authorities** via GPO (*Computer Configuration → Windows Settings → Security Settings → Public Key
   Policies*) or an Intune **Trusted certificate** profile. Because the CA is name-constrained to the
   AI domains, even if its key were stolen it cannot impersonate any other site.
3. **Set and lock the proxy — scoped to AI domains only.** Publish a **PAC file** that sends only the
   AI domains to `127.0.0.1:8080` and everything else `DIRECT`, and enforce it with the locked proxy
   policies so users cannot change it:
   * Chrome/Edge/Brave: `ProxyMode=pac_script` + `ProxyPacUrl` (the same GPO/Intune mechanism
     `scripts/system-installer/Install-AgentShield.ps1` already uses for the extension).
   * System-wide (covers Firefox and desktop apps that follow the Windows proxy): the WinHTTP/WinINET
     proxy, set by GPO.
   A PAC keeps pinned apps and non-AI traffic direct, so nothing else breaks.
4. **(Strongest) require the agent for access.** If AI tools are only reachable through the agent (e.g.
   egress firewall rule, or your server only accepting agent-tagged sessions), there is no incentive to
   bypass it — the same principle as a SASE "conditional access" control.

Steps 1–3 only apply to devices the customer manages (domain-joined, Entra-joined, or Intune-enrolled),
which is the same constraint every commercial product lives with, and the same one the extension
force-install already has.

## Tests

```powershell
cd agent; ..\backend\.venv\Scripts\python.exe -m pytest tests -q
```

The suite runs the **real backend in-process** (so the connect/session/sync/event flow is proven
wire-compatible, not mocked) and drives the proxy over real sockets (TLS interception + in-flight
redaction + blocking). It needs no mitmproxy and no network.

## Files

```
agent/
  agentshield_agent/
    config.py        intercept domain list, ports, data folder
    client.py        the connect + session API flow (reuses /computer and /device endpoints)
    keys.py          ECDSA P-256 keys in the server's format; DPAPI-protected at rest
    secure_store.py  Windows DPAPI (machine scope)
    ca.py            per-PC, name-constrained root CA; issues short-lived AI-host certs
    inspect_body.py  pulls the prompt text out of a request body; rewrites it for redaction
    engine.py        decisions, reusing backend detector + evaluator (the twins); NO rule copy
    proxy.py         the built-in proxy (CONNECT, selective TLS interception, streaming, WebSocket)
    agent.py         session, policy sync, heartbeat, event queue; fail-closed authorization
    cli.py           connect / disconnect / status / new-ca / run
  mitm/
    agentshield_addon.py   the same enforcement as a mitmproxy addon (mitmproxy does the proxy work)
  tests/             pytest suite (backend in-process + real-socket proxy)
  requirements.txt
```
