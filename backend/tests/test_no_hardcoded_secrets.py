"""Source scan: no credentials, live keys or secret tokens are hardcoded in shipped code.

Scans backend/app, dashboard/src, admin-console/src and extension/src (not tests, which use
throwaway fixtures). Two deliberate exceptions are DENY-LISTS that contain old published
defaults so they can be refused; they are listed explicitly below.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCANNED = ["backend/app", "dashboard/src", "admin-console/src", "extension/src"]
EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".json", ".html"}
SKIP_PARTS = {"node_modules", "dist", "__pycache__"}
SKIP_FILES = {"extension/src/popup/popup.js"}  # generated

PUBLISHED_DEFAULTS = ["AdminShield2026!", "Auditor2026!", "agentshield-super-secret-production-key-change-me-321"]
DENY_LIST_FILES = {"backend/app/api/auth.py", "backend/app/core/config.py"}

SECRET_PATTERNS = {
    "live Razorpay key": re.compile(r"rzp_live_[A-Za-z0-9]{8,}"),
    "live Stripe key": re.compile(r"sk_live_[A-Za-z0-9]{8,}"),
    "private key": re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "device key": re.compile(r"\basd_[A-Za-z0-9_-]{20,}"),
    "enrollment code": re.compile(r"\bASE1\.[A-Za-z0-9_-]{20,}"),
    "activation code": re.compile(r"\bASA1\.[A-Za-z0-9_-]{20,}"),
    "activation/invite/API token": re.compile(r"\b(asa|asi|asv|asr|ast|aspt)_[A-Za-z0-9_-]{30,}"),
}
# os.getenv("<NAME ending in PASSWORD / SECRET / _KEY / _TOKEN>", "<non-empty default>")
ENV_DEFAULT = re.compile(r"""os\.getenv\(\s*["']([A-Z0-9_]*(?:PASSWORD|SECRET|_KEY|_TOKEN))["']\s*,\s*["']([^"']+)["']""")


def _files():
    for folder in SCANNED:
        base = ROOT / folder
        if not base.exists():
            continue
        for path in base.rglob("*"):
            rel = path.relative_to(ROOT).as_posix()
            if path.is_file() and path.suffix in EXTENSIONS and not (SKIP_PARTS & set(path.parts)) and rel not in SKIP_FILES:
                yield rel, path.read_text(encoding="utf-8", errors="ignore")


def test_scan_covers_the_apps():
    scanned = {rel.split("/")[0] for rel, _ in _files()}
    assert {"backend", "dashboard", "extension"} <= scanned


def test_no_secret_tokens_or_live_keys_in_source():
    problems = [f"{rel}: {name}" for rel, text in _files() for name, rx in SECRET_PATTERNS.items() if rx.search(text)]
    assert problems == []


def test_no_default_credentials_in_configuration():
    problems = [f"{rel}: {m.group(1)} has a built-in default" for rel, text in _files() for m in ENV_DEFAULT.finditer(text)]
    assert problems == []


def test_published_default_passwords_only_in_deny_lists():
    problems = [f"{rel}: {pw}" for rel, text in _files() for pw in PUBLISHED_DEFAULTS
                if pw in text and rel not in DENY_LIST_FILES]
    assert problems == []
