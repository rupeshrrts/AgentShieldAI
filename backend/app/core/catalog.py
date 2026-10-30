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
    # --- 2.6: rules modelled on enterprise DLP dictionaries. Format checks plus checksums or a nearby word
    # ("passport", "voter", "account") keep false alarms down.
    {
        "rule_id": "secret.crypto_key",
        "category": "SECRET",
        "name": "Crypto wallet private keys",
        "description": "Bitcoin WIF keys, BIP32 xprv extended keys, and 64-character hex keys written next to 'private key' or 'seed'.",
        "default_action": "BLOCK",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "secret.connection_string",
        "category": "SECRET",
        "name": "Connection strings with passwords",
        "description": "Database and service URLs that contain a password, e.g. postgres://user:password@host (placeholders are ignored).",
        "default_action": "BLOCK",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "pii.iban",
        "category": "PII",
        "name": "IBAN bank account numbers",
        "description": "International bank account numbers that pass the IBAN mod-97 check.",
        "default_action": "BLOCK",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "pii.bank_account",
        "category": "PII",
        "name": "Indian bank account details",
        "description": "IFSC codes, and 9-18 digit account numbers written after 'account', 'a/c' or 'acct'.",
        "default_action": "WARN",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "pii.upi",
        "category": "PII",
        "name": "UPI IDs",
        "description": "UPI payment addresses such as name@okaxis, 98xxxxxxxx@ybl or name@paytm (known UPI handles only).",
        "default_action": "WARN",
        "default_severity": "MEDIUM",
    },
    {
        "rule_id": "pii.passport",
        "category": "PII",
        "name": "Indian passport numbers",
        "description": "Passport numbers (letter + 7 digits) when the word 'passport' is written shortly before them.",
        "default_action": "BLOCK",
        "default_severity": "HIGH",
    },
    {
        "rule_id": "pii.voter_id",
        "category": "PII",
        "name": "Voter ID (EPIC) numbers",
        "description": "3 letters + 7 digits when 'voter', 'EPIC' or 'election' is written shortly before them.",
        "default_action": "WARN",
        "default_severity": "MEDIUM",
    },
    {
        "rule_id": "pii.gstin",
        "category": "PII",
        "name": "GSTIN numbers",
        "description": "15-character GST identification numbers that pass the GSTIN check character (business IDs, so recorded only).",
        "default_action": "MONITOR",
        "default_severity": "LOW",
    },
    {
        "rule_id": "restricted.internal_ip",
        "category": "RESTRICTED",
        "name": "Internal IP addresses",
        "description": "Private network addresses (10.x, 172.16-31.x, 192.168.x) that reveal the company network (recorded only).",
        "default_action": "MONITOR",
        "default_severity": "LOW",
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
# extension/src/shared/web-categories.json. "default" applies until the account changes it.
# "group" puts the switch under a heading in the dashboard (WEB_CATEGORY_GROUPS). The groups follow the way
# enterprise web filters (security vs. content categories) and parental controls arrange their categories.
WEB_CATEGORY_GROUPS: List[Dict[str, str]] = [
    {"id": "security", "name": "Security threats", "description": "Sites that attack the computer or the person using it."},
    {"id": "data", "name": "Data leaks", "description": "Places where company files and text can leave the organization."},
    {"id": "content", "name": "Adult content & kids safety", "description": "Content that is not suitable at work or for children."},
    {"id": "productivity", "name": "Productivity", "description": "Sites that are fine in themselves but not during work or school time."},
]

WEB_CATEGORIES: List[Dict[str, object]] = [
    # --- Security threats
    {"id": "malware", "group": "security", "name": "Malware, phishing & scams", "default": True,
     "description": "Known dangerous sites: malware, phishing, fake shops and scams."},
    {"id": "cryptomining", "group": "security", "name": "Cryptomining", "default": False,
     "description": "Sites and mining pools that use the computer to mine cryptocurrency in the background."},
    {"id": "spyware", "group": "security", "name": "Spyware & stalkerware", "default": False,
     "description": "Phone and computer spying apps and the servers they report to."},
    {"id": "hacking", "group": "security", "name": "Hacking & password cracking", "default": False,
     "description": "Hacking tools, password cracks and stolen-account sites."},
    {"id": "remote_access", "group": "security", "name": "Remote-access tools", "default": False,
     "description": "Remote desktop and remote support websites often used in 'tech support' scams."},
    {"id": "dyndns", "group": "security", "name": "Dynamic DNS", "default": False,
     "description": "Free dynamic-DNS host names, often used by malware and phishing. May block some home cameras or NAS."},
    {"id": "shortener", "group": "security", "name": "URL shorteners", "default": False,
     "description": "Short-link services that hide where a link really goes (bit.ly style)."},
    {"id": "bypass", "group": "security", "name": "Filter bypass", "default": False,
     "description": "Public VPN, proxy and encrypted-DNS services that can be used to get around blocking."},
    # --- Data leaks
    {"id": "filesharing", "group": "data", "name": "File sharing & online storage", "default": False,
     "description": "Public file-hosting and upload sites where files can be shared outside the company."},
    {"id": "webmail", "group": "data", "name": "Personal webmail", "default": False,
     "description": "Free and throw-away email sites (Yahoo, Proton, temp-mail...). Gmail and Outlook stay open."},
    # --- Adult content & kids safety
    {"id": "adult", "group": "content", "name": "Adult content", "default": True,
     "description": "Pornography and sexually explicit sites. Also turns on Safe Search unless you switch it off."},
    {"id": "mature", "group": "content", "name": "Mature & suggestive", "default": False,
     "description": "Suggestive, lingerie and mixed adult sites that are not pornography."},
    {"id": "dating", "group": "content", "name": "Dating", "default": False,
     "description": "Dating, flirting and matchmaking sites."},
    {"id": "gambling", "group": "content", "name": "Gambling", "default": False,
     "description": "Betting, casino and lottery sites."},
    {"id": "drugs", "group": "content", "name": "Drugs", "default": False,
     "description": "Sites that sell or promote illegal drugs."},
    {"id": "hate", "group": "content", "name": "Hate & violence", "default": False,
     "description": "Hate speech, extremist and violent sites."},
    {"id": "weapons", "group": "content", "name": "Weapons", "default": False,
     "description": "Sites that sell weapons or explain how to make dangerous materials."},
    {"id": "chat", "group": "content", "name": "Chat rooms", "default": False,
     "description": "Open and anonymous chat rooms where children can meet strangers."},
    {"id": "piracy", "group": "content", "name": "Piracy", "default": True,
     "description": "Illegal streaming, torrent and download sites for films, music and software."},
    # --- Productivity
    {"id": "social", "group": "productivity", "name": "Social networks", "default": False,
     "description": "Social media sites such as Facebook, Instagram, TikTok and X. LinkedIn and Reddit stay open."},
    {"id": "streaming", "group": "productivity", "name": "Movies, music & streaming", "default": False,
     "description": "Film, video and music sites, legal or not: Netflix, Prime Video, Hotstar, Spotify, Gaana, JioSaavn, "
                    "and any site with words like mp3, song, movie or bhojpuri in its address. YouTube stays open."},
    {"id": "games", "group": "productivity", "name": "Online games", "default": False,
     "description": "Browser games and gaming sites."},
    {"id": "shopping", "group": "productivity", "name": "Shopping", "default": False,
     "description": "Online shops and marketplaces. Amazon stays open."},
    {"id": "jobsearch", "group": "productivity", "name": "Job search", "default": False,
     "description": "Job boards and recruitment sites."},
]
WEB_CATEGORY_IDS = [c["id"] for c in WEB_CATEGORIES]
WEB_CATEGORY_DEFAULTS: Dict[str, bool] = {c["id"]: bool(c["default"]) for c in WEB_CATEGORIES}

_SECURITY = ["malware", "cryptomining", "spyware", "hacking", "remote_access", "dyndns", "bypass"]
_KIDS_CONTENT = ["adult", "mature", "dating", "gambling", "drugs", "hate", "weapons", "chat", "piracy"]


def _preset(on: List[str]) -> Dict[str, bool]:
    return {cid: cid in on for cid in WEB_CATEGORY_IDS}


# One-click settings in the dashboard. Each sets EVERY category (so the result is predictable); the admin
# can still switch single categories afterwards. safe_search None = leave Safe Search as it is.
WEB_CATEGORY_PRESETS: List[Dict[str, object]] = [
    {"id": "kids", "name": "Kids / family",
     "description": "Security threats, adult and mature content, dating, gambling, drugs, hate, weapons, chat rooms, "
                    "piracy and social networks blocked; Safe Search on.",
     "categories": _preset(_SECURITY + _KIDS_CONTENT + ["social"]), "safe_search": True},
    {"id": "workplace", "name": "Workplace",
     "description": "Security threats, data-leak sites, adult and mature content, dating, gambling, drugs, hate, weapons "
                    "and games blocked; Safe Search on.",
     "categories": _preset(_SECURITY + ["filesharing", "webmail", "adult", "mature", "dating", "gambling", "drugs", "hate",
                                        "weapons", "piracy", "games"]), "safe_search": True},
    {"id": "security", "name": "Security only",
     "description": "Only security threats and piracy blocked; every content and productivity category off.",
     "categories": _preset(_SECURITY + ["piracy"]), "safe_search": None},
    {"id": "off", "name": "All off",
     "description": "No website category is blocked and Safe Search is off. Your own website rules still apply.",
     "categories": _preset([]), "safe_search": False},
]


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
