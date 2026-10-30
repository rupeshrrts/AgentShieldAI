"""Constants and paths of the AgentShield Network Agent (Windows service + local HTTPS-inspecting proxy)."""
import os
import sys
from pathlib import Path

VERSION = "1.0.0"
SERVICE_NAME = "AgentShieldAgent"
SERVICE_DISPLAY_NAME = "AgentShield Network Agent"

# Machine-wide data folder (SYSTEM and Administrators only, set by `install`). Tests point it elsewhere.
DATA_DIR = Path(os.environ.get("AGENTSHIELD_AGENT_DIR") or Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "AgentShield" / "Agent")

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("AGENTSHIELD_AGENT_PORT") or 8080)

SYNC_SECONDS = 5 * 60          # policies, website rules, heartbeat (same rhythm as the extension)
SESSION_REFRESH_MARGIN = 60    # renew the 15-minute device session this many seconds before it ends
MAX_QUEUED_EVENTS = 500
MAX_INSPECT_BYTES = 2 * 1024 * 1024   # request bodies above this are not inspected (and refused on AI sites)
WARN_CONFIRM_SECONDS = 120     # a WARN prompt sent again unchanged within this time is let through

# AI sites whose HTTPS traffic is opened and checked. Everything else is tunnelled untouched (never
# decrypted). The local root certificate is name-constrained to exactly these domains, so even a stolen
# CA key cannot impersonate a bank or any other site. Keep in step with extension/src/shared/domains.ts.
INTERCEPT_DOMAINS = [
    "chatgpt.com",
    "chat.openai.com",
    "claude.ai",
    "gemini.google.com",
    "aistudio.google.com",
    "copilot.microsoft.com",
    "perplexity.ai",
    "deepseek.com",
    "chat.mistral.ai",
    "poe.com",
    "meta.ai",
    "grok.com",
]


def host_matches(host: str, domains) -> bool:
    host = (host or "").lower().rstrip(".")
    for d in domains:
        d = str(d).lower().strip().lstrip(".")
        if d and (host == d or host.endswith("." + d)):
            return True
    return False


def is_intercepted(host: str) -> bool:
    return host_matches(host, INTERCEPT_DOMAINS)


def backend_dir() -> Path:
    """Folder holding the backend's `app` package (detector and policy evaluator are shared, not copied)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[2] / "backend"
