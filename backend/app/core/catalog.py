"""Catalog of detection rules, known AI websites and blockable website categories.

Every policy must reference a rule ID listed here, because only these rule IDs
are produced by the detectors (backend/app/detection/detector.py and
extension/src/content/detector.ts). A policy with any other rule ID would never
match anything, so the API rejects it.
"""

import json
from typing import Dict, List, Optional

# Action precedence (most restrictive first). MONITOR = allow but record the violation.
ACTION_PRIORITY: Dict[str, int] = {
    "BLOCK": 5,
    "REDACT": 4,
    "WARN": 3,
    "MONITOR": 2,
    "ALLOW": 1,
}

RULE_CATALOG: List[dict] = [
    {
        "rule_id": "secret.api_key_like",
        "category": "SECRET",
        "name": "API keys, tokens, passwords & private keys",
        "description": "OpenAI/Anthropic/AWS/GitHub/Google/Slack/Stripe keys, JWTs, PEM private keys, and 'password: ...' style credentials.",
        "default_action": "BLOCK",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "pii.email",
        "category": "PII",
        "name": "Email addresses",
        "description": "Customer or employee email addresses.",
        "default_action": "WARN",
        "default_severity": "MEDIUM",
    },
    {
        "rule_id": "pii.phone",
        "category": "PII",
        "name": "Phone numbers",
        "description": "10+ digit phone numbers (Indian and North American formats).",
        "default_action": "WARN",
        "default_severity": "LOW",
    },
    {
        "rule_id": "pii.credit_card",
        "category": "PII",
        "name": "Payment card numbers",
        "description": "13-19 digit card numbers that pass the Luhn checksum.",
        "default_action": "BLOCK",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "pii.pan_india",
        "category": "PII",
        "name": "Indian PAN numbers",
        "description": "Permanent Account Number format (ABCDE1234F).",
        "default_action": "WARN",
        "default_severity": "MEDIUM",
    },
    {
        "rule_id": "pii.aadhaar",
        "category": "PII",
        "name": "Aadhaar numbers",
        "description": "12-digit Aadhaar numbers that pass the Verhoeff checksum.",
        "default_action": "BLOCK",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "restricted.keyword",
        "category": "RESTRICTED",
        "name": "Confidential keywords",
        "description": "Project codenames and internal terms managed in Deployment & Settings.",
        "default_action": "REDACT",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "file.upload",
        "category": "FILE",
        "name": "File uploads to AI sites",
        "description": "Files attached, dropped or pasted into a supported AI site. Text files are also scanned with the rules above.",
        "default_action": "WARN",
        "default_severity": "MEDIUM",
    },
]

RULE_IDS = {r["rule_id"] for r in RULE_CATALOG}

# Category defaults used when a rule has no configured policy
CATEGORY_DEFAULT_ACTION = {
    "SECRET": "BLOCK",
    "PII": "WARN",
    "RESTRICTED": "REDACT",
    "FILE": "WARN",
}

# One-click policy profiles shown in the Policy Editor
PRESETS: Dict[str, Dict[str, str]] = {
    "recommended": {r["rule_id"]: r["default_action"] for r in RULE_CATALOG},
    "strict": {r["rule_id"]: "BLOCK" for r in RULE_CATALOG},
    "monitor": {r["rule_id"]: "MONITOR" for r in RULE_CATALOG},
}

# Generative-AI websites. When "Block unapproved AI tools" is on, any of these
# that is not on the organization's ALLOW list is blocked by the extension.
KNOWN_AI_DOMAINS: List[str] = [
    "chatgpt.com",
    "chat.openai.com",
    "claude.ai",
    "gemini.google.com",
    "aistudio.google.com",
    "copilot.microsoft.com",
    "perplexity.ai",
    "chat.deepseek.com",
    "deepseek.com",
    "chat.mistral.ai",
    "poe.com",
    "character.ai",
    "you.com",
    "huggingface.co",
    "meta.ai",
    "grok.com",
    "chat.qwen.ai",
    "kimi.com",
    "pi.ai",
    "jasper.ai",
    "writesonic.com",
    "quillbot.com",
]

# Website categories the extension can block (lists ship inside the extension as DNR static
# rulesets; see extension/scripts/update-web-categories.js). Keep the ids identical to
# extension/src/shared/web-categories.ts. "default" applies until the account changes it.
WEB_CATEGORIES: List[Dict[str, object]] = [
    {"id": "malware", "name": "Malware, phishing & scams", "default": True,
     "description": "Known dangerous sites: malware, phishing, fake shops and scams."},
    {"id": "adult", "name": "Adult content", "default": True,
     "description": "Pornography and sexually explicit sites. Also turns on Safe Search unless you switch it off."},
    {"id": "piracy", "name": "Piracy", "default": True,
     "description": "Illegal streaming, torrent and download sites for films, music and software."},
    {"id": "gambling", "name": "Gambling", "default": False,
     "description": "Betting, casino and lottery sites."},
    {"id": "social", "name": "Social networks", "default": False,
     "description": "Social media sites such as Facebook, Instagram, TikTok and X. LinkedIn and Reddit stay open."},
    {"id": "bypass", "name": "Filter bypass", "default": False,
     "description": "Public VPN, proxy and encrypted-DNS services that can be used to get around blocking."},
    {"id": "streaming", "name": "Movies, music & streaming", "default": False,
     "description": "Film, video and music sites, legal or not: Netflix, Prime Video, Hotstar, Spotify, Gaana, JioSaavn, "
                    "and any site with words like mp3, song, movie or bhojpuri in its address. YouTube stays open."},
]
WEB_CATEGORY_IDS = [c["id"] for c in WEB_CATEGORIES]
WEB_CATEGORY_DEFAULTS: Dict[str, bool] = {c["id"]: bool(c["default"]) for c in WEB_CATEGORIES}


def effective_web_categories(stored: Optional[str]) -> Dict[str, bool]:
    """The account's category switches: defaults, overridden by what it saved (unknown keys ignored)."""
    result = dict(WEB_CATEGORY_DEFAULTS)
    try:
        saved = json.loads(stored) if stored else {}
    except (TypeError, ValueError):
        saved = {}
    if isinstance(saved, dict):
        for key, value in saved.items():
            if key in result and isinstance(value, bool):
                result[key] = value
    return result


def effective_safe_search(stored: Optional[bool], categories: Dict[str, bool]) -> bool:
    """Safe Search follows Adult blocking until the account sets it explicitly."""
    return bool(categories.get("adult")) if stored is None else bool(stored)
