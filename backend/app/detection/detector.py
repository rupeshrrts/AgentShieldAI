"""Deterministic Sensitive Data Detection Engine.

Performs local text analysis using compiled regular expressions, checksums and
keyword matching. It runs identically inside the Python backend or as a standalone
utility without requiring heavy machine learning models or external API calls.

IMPORTANT: extension/src/content/detector.ts implements the same rules for the
browser. Keep both in sync; backend/tests/detection_cases.json is checked against
both implementations.
"""

import re
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Finding:
    """Represents a single sensitive data match within a string."""
    rule_id: str
    category: str        # 'SECRET', 'PII', or 'RESTRICTED'
    severity: str        # 'LOW', 'MEDIUM', 'HIGH', or 'CRITICAL'
    start: int           # Character start index in original text
    end: int             # Character end index in original text
    matched_value: Optional[str] = None  # Captured snippet (stripped during audit logging if needed)

    def to_dict(self, include_matched_value: bool = False) -> dict:
        """Serializes finding to a dictionary suitable for API responses."""
        data = {
            "rule_id": self.rule_id,
            "category": self.category,
            "severity": self.severity,
            "start": self.start,
            "end": self.end,
        }
        if include_matched_value and self.matched_value is not None:
            data["matched_value"] = self.matched_value
        return data


# --- Checksums ---

def luhn_valid(digits: str) -> bool:
    """Luhn checksum used by payment card numbers."""
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


_VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
_VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def verhoeff_valid(digits: str) -> bool:
    """Verhoeff checksum used by Aadhaar numbers."""
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[i % 8][int(ch)]]
    return c == 0


_BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_valid(gstin: str) -> bool:
    """GSTIN check character (the GST Network's mod-36 algorithm over the first 14 characters)."""
    if len(gstin) != 15:
        return False
    total = 0
    for i in range(14):
        v = _BASE36.find(gstin[i])
        if v < 0:
            return False
        p = v * (1 if i % 2 == 0 else 2)
        total += p // 36 + p % 36
    return _BASE36[(36 - total % 36) % 36] == gstin[14]


def iban_valid(iban: str) -> bool:
    """IBAN mod-97 check (ISO 13616); spaces are ignored."""
    s = iban.replace(" ", "").upper()
    if not 15 <= len(s) <= 34:
        return False
    mod = 0
    for ch in s[4:] + s[:4]:
        v = _BASE36.find(ch)
        if v < 0:
            return False
        for d in str(v):
            mod = (mod * 10 + int(d)) % 97
    return mod == 1


# Common UPI handles (the part after @). Only these count, so ordinary @mentions are not UPI IDs.
UPI_HANDLES = [
    "ybl", "ibl", "axl", "okaxis", "okhdfcbank", "okicici", "oksbi", "paytm", "ptyes", "ptaxis", "pthdfc", "ptsbi",
    "apl", "yapl", "upi", "icici", "sbi", "hdfcbank", "axisbank", "kotak", "idfcbank", "idfcfirst", "indus", "federal",
    "pnb", "boi", "unionbank", "barodampay", "aubank", "airtel", "freecharge", "jupiteraxis", "fbl", "waicici",
    "wahdfcbank", "wasbi", "waaxis", "abfspay", "ikwik", "mbk", "slice", "naviaxis", "yesbank", "rbl", "dbs", "kbl",
    "cnrb", "equitas", "jio", "superyes", "amazonpay", "postbank",
]

# A password part that is only a placeholder (connection-string examples are not secrets)
_PASSWORD_PLACEHOLDER = re.compile(r"\$\{.+\}|<[^>]+>|\[REDACTED:SECRET\]|\[(?:MASKED|SECRET_MASKED|MASKED_SECRET|MASKED_PASSWORD)\]|\*{4}\[SECRET_MASKED\]")
_PLACEHOLDER = re.compile(r"^(?:\*+|x+|<[^>]*>|\$\{[^}]*\}|\{[^}]*\}|password|pass|pwd|secret|changeme)$", re.IGNORECASE)


def _overlaps(spans, start: int, end: int) -> bool:
    return any(start < e and end > s for s, e in spans)


class DetectorEngine:
    """Regex, checksum and keyword detection engine for credentials, PII, and trade secrets."""

    # Pre-compiled regular expressions for high-throughput matching
    API_KEY_PATTERNS: List[re.Pattern] = [
        re.compile(r"\b[a-z][a-z0-9]{1,30}_(?:live|test)_sk_[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])", re.IGNORECASE | re.ASCII),
        re.compile(r"(?<![A-Za-z0-9_-])AQ\.[A-Za-z0-9_-]{40,100}(?![A-Za-z0-9_-])"),
        re.compile(r"(?<![A-Za-z0-9_-])api-(?=[A-Za-z0-9]{0,79}[0-9])(?=[A-Za-z0-9]{0,79}[A-Za-z])[A-Za-z0-9]{20,80}(?![A-Za-z0-9_-])", re.IGNORECASE | re.ASCII),
        re.compile(r"\bsk-demo-[A-Za-z0-9_-]{10,}\b", re.IGNORECASE),
        re.compile(r"\bsk-(?:proj|live|test|ant|svcacct)-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])"),
        re.compile(r"\bsk[-_][A-Za-z0-9]{32,64}(?![A-Za-z0-9_-])"),
        re.compile(r"\b(?:xai-|pplx-|hf_)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])"),
        re.compile(r"\bAKIA[0-9A-Z]{12,20}\b"),  # AWS Access Key ID
        re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{36,}\b"),  # GitHub Personal Access Tokens
        re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),  # Google API key
        re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),  # Slack token
        re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b"),  # Stripe live key
        re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),  # JWT
        re.compile(r"-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----(?:[\s\S]*?-----END \1-----|(?:\r?\n[^\r\n]*)*)"),
        re.compile(r"""(?<![A-Za-z0-9])(?:password|passwd|pwd|passcode|passphrase|pin|secret)["']?[ \t]*:[ \t]*[|>][-+]?[ \t]*\r?\n([ \t]+)[^\r\n]+(?:\r?\n\1[^\r\n]*)*""", re.IGNORECASE | re.ASCII),
        re.compile(r"(?<!\S)(?!what\b|who\b|how\b|where\b|when\b|why\b|this\b|that\b)(\S+)[ \t]+(?:this[ \t]+)?is[ \t]+my[ \t]+(?:[A-Za-z]+[ \t]+)?(?:password|passphrase|passcode|pin)\b", re.IGNORECASE | re.ASCII),
    ]

    CONTEXTUAL_PASSWORD = re.compile(
        r"""(?<![A-Za-z0-9])(?:password|passwd|pwd|passcode|passphrase|pin|secret|contrase[\u00f1\u00d1]a|mot[ \t]+de[ \t]+passe|senha)["']?(?:[ \t]*[:=][ \t]*|[ \t]+is[ \t]+(?![ \t]*(?:required|optional|case-sensitive|stored|hashed|encrypted|reset|invalid|incorrect)(?![A-Za-z0-9_-])))(?:"((?:\\.|[^"\\\r\n])+)"|'((?:\\.|[^'\\\r\n])+)'|(\$\{[^}\r\n]+\}|(?!["'])[^\r\n]+))""",
        re.IGNORECASE | re.ASCII,
    )

    CLI_CREDENTIAL = re.compile(r"""(?<![A-Za-z0-9_-])--(?:password|passwd|passphrase|passcode|db-password|client-secret)(?:[ \t]+|=)(?:"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|(?!--[A-Za-z])[^\s"'$<][^\s"'<>]*)(?![A-Za-z0-9_-])""", re.IGNORECASE | re.ASCII)
    XML_CREDENTIAL = re.compile(r"""<(password|passwd|passphrase|passcode|client-secret)>[ \t]*([^<\r\n]+)(?=</\1>)""", re.IGNORECASE | re.ASCII)

    LABELED_API_CREDENTIAL = re.compile(
        r"(?<![A-Za-z0-9])(?:(?:api[ _-]?(?:key|token|secret)|secret[ _-]?token|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|bearer)['\"]?\s*[:=]\s*['\"]?"
        r"|authorization['\"]?[ \t]*[:=][ \t]*['\"]?(?:bearer|basic)[ \t]+)"
        r"([A-Za-z0-9._~+/-]{4,}=*)(?=$|[\s'\"&,;)}\]])",
        re.IGNORECASE | re.ASCII,
    )

    # Standard email address matching
    EMAIL_PATTERN: re.Pattern = re.compile(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
    )

    # Phone numbers (North American formats and common international/Indian mobile formats)
    PHONE_PATTERNS: List[re.Pattern] = [
        re.compile(r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b"),
        re.compile(r"\b(?:\+91[-.\s]?)?[6-9]\d{9}\b"),
    ]

    # Payment cards: 13-19 digits, optionally grouped by spaces or dashes, Luhn-validated
    CARD_PATTERN: re.Pattern = re.compile(r"\b\d(?:[ -]?\d){12,18}\b")

    # Aadhaar: 12 digits starting 2-9, optionally grouped 4-4-4, Verhoeff-validated
    AADHAAR_PATTERN: re.Pattern = re.compile(r"\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b")

    # Indian PAN: 5 letters (4th = holder type), 4 digits, 1 letter
    PAN_PATTERN: re.Pattern = re.compile(r"\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b")

    # --- 2.6 data rules. Patterns that need a nearby word put the value in group 1 at the END of the match.

    # Connection strings with a password: scheme://user:password@host (group 1 = password)
    CONNECTION_PATTERN: re.Pattern = re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]{1,20}://[^\s:/@'\"]+:([^\s@/'\"]+)@[^\s/'\"]+")

    # Crypto wallet private keys: Bitcoin WIF (uncompressed / compressed), BIP32 xprv, 64-hex key next to a key word
    CRYPTO_PATTERNS: List[re.Pattern] = [
        re.compile(r"\b5[HJK][1-9A-HJ-NP-Za-km-z]{49}\b"),
        re.compile(r"\b[KL][1-9A-HJ-NP-Za-km-z]{51}\b"),
        re.compile(r"\bxprv[1-9A-HJ-NP-Za-km-z]{107,108}\b"),
        re.compile(r"\b(?:private[\s_-]?key|priv[\s_-]?key|wallet[\s_-]?key|seed)\b[^\n]{0,20}?\b(?:0x)?([a-fA-F0-9]{64})\b", re.IGNORECASE),
    ]

    # IBAN: country code, 2 check digits, 11-30 letters/digits (optionally in groups), mod-97 checked
    IBAN_PATTERN: re.Pattern = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b")

    # UPI ID: name@handle with a known UPI handle, not followed by a domain ending (that would be an email)
    UPI_PATTERN: re.Pattern = re.compile(
        r"\b[A-Za-z0-9][A-Za-z0-9._-]{1,255}@(?:" + "|".join(UPI_HANDLES) + r")(?!\.?[A-Za-z0-9-])", re.IGNORECASE
    )

    # GSTIN: state code, PAN, entity number, Z, check character (checked)
    GSTIN_PATTERN: re.Pattern = re.compile(r"\b(?:0[1-9]|[12]\d|3[0-8]|97|99)[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b")

    # Indian passport number, only when the word "passport" comes shortly before it (group 1)
    PASSPORT_PATTERN: re.Pattern = re.compile(r"\bpassport\b[^\n]{0,40}?\b([A-PR-WY][1-9]\d{6})\b", re.IGNORECASE)

    # Voter ID (EPIC): 3 letters + 7 digits, only with "voter", "EPIC" or "election" shortly before it (group 1)
    VOTER_PATTERN: re.Pattern = re.compile(r"\b(?:voter|epic|election)\b[^\n]{0,40}?\b([A-Z]{3}\d{7})\b", re.IGNORECASE)

    # Indian bank details: IFSC code, or a 9-18 digit account number after "account" / "a/c" / "acct" (group 1)
    IFSC_PATTERN: re.Pattern = re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")
    ACCOUNT_PATTERN: re.Pattern = re.compile(
        r"\b(?:a/c|acct|account)(?:\s*(?:no|number|num)\.?)?(?:\s*is)?\s*[:#-]?\s*(\d{9,18})\b", re.IGNORECASE
    )

    # Internal (private) IPv4 addresses: 10.x, 172.16-31.x, 192.168.x (not part of a longer dotted number)
    PRIVATE_IP_PATTERN: re.Pattern = re.compile(
        r"\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b(?!\.\d)"
    )

    # Baseline keywords used until an organization manages its own list in the dashboard
    DEFAULT_RESTRICTED_KEYWORDS = [
        "PROJECT-ALPHA-CONFIDENTIAL",
        "CONFIDENTIAL_FINANCIALS",
        "INTERNAL_ONLY_DOC",
        "RESTRICTED_CUSTOMER_PII",
        "RESTRICTED_SOURCE_CODE",
    ]

    def __init__(self, custom_keywords: Optional[List[str]] = None, include_defaults: bool = True):
        # Organizations that manage their own keyword list from the dashboard pass
        # include_defaults=False so deleted keywords really stop matching.
        self.restricted_keywords = set(self.DEFAULT_RESTRICTED_KEYWORDS) if include_defaults else set()
        if custom_keywords:
            self.restricted_keywords.update(k.strip() for k in custom_keywords if k and k.strip())

    def add_keyword(self, keyword: str):
        """Dynamically add an internal project code or confidential term."""
        if keyword and keyword.strip():
            self.restricted_keywords.add(keyword.strip())

    def detect(self, text: str, credential_prefixes: Optional[List[str]] = None) -> List[Finding]:
        """Scans input text and returns all detected sensitive data occurrences."""
        if not text:
            return []

        findings: List[Finding] = []

        def add_group(rule_id: str, category: str, severity: str, match: re.Match) -> tuple:
            # Value in group 1 at the end of the match (the words before it are only context)
            end = match.end()
            start = end - len(match.group(1))
            findings.append(Finding(rule_id, category, severity, start, end, match.group(1)))
            return (start, end)

        # 1. API keys, tokens, private keys and password definitions
        for pattern in self.API_KEY_PATTERNS:
            for match in pattern.finditer(text):
                findings.append(Finding("secret.api_key_like", "SECRET", "HIGH", match.start(), match.end(), match.group(0)))
        for match in self.CONTEXTUAL_PASSWORD.finditer(text):
            quoted = match.group(1) if match.group(1) is not None else match.group(2)
            value = quoted if quoted is not None else match.group(3).rstrip(" \t")
            if not value or _PASSWORD_PLACEHOLDER.fullmatch(value):
                continue
            end = match.end() - (1 if quoted is not None else len(match.group(3)) - len(value))
            findings.append(Finding("secret.api_key_like", "SECRET", "HIGH", end - len(value), end, value))
        for match in self.CLI_CREDENTIAL.finditer(text):
            findings.append(Finding("secret.api_key_like", "SECRET", "HIGH", match.start(), match.end(), match.group(0)))
        for match in self.XML_CREDENTIAL.finditer(text):
            value = match.group(2).strip()
            if not value or _PASSWORD_PLACEHOLDER.fullmatch(value):
                continue
            findings.append(Finding("secret.api_key_like", "SECRET", "HIGH", match.start(2), match.end(2), match.group(2)))
        for prefix in credential_prefixes or []:
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{2,30}[-_]", prefix):
                continue
            pattern = r"(?<![A-Za-z0-9_-])" + prefix + r"[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])"
            for match in re.finditer(pattern, text):
                findings.append(Finding("secret.api_key_like", "SECRET", "HIGH", match.start(), match.end(), match.group(0)))
        for match in self.LABELED_API_CREDENTIAL.finditer(text):
            if not _PLACEHOLDER.fullmatch(match.group(1)):
                add_group("secret.api_key_like", "SECRET", "HIGH", match)

        # A standalone name, symbol and digit sequence is ambiguous, so it has its own policy.
        password_like = re.match(r"[ \t\r\n]*([A-Za-z]{3,32}[@!#$%&*][0-9]{4,16})(?=[ \t\r\n]*\Z)", text)
        if password_like:
            add_group("secret.password_like", "SECRET", "MEDIUM", password_like)

        # 1b. Connection strings with a real password, and crypto wallet private keys
        connection_spans = []
        for match in self.CONNECTION_PATTERN.finditer(text):
            if _PLACEHOLDER.match(match.group(1)):
                continue
            findings.append(Finding("secret.connection_string", "SECRET", "HIGH", match.start(), match.end(), match.group(0)))
            connection_spans.append((match.start(), match.end()))
        for pattern in self.CRYPTO_PATTERNS:
            for match in pattern.finditer(text):
                if pattern.groups:
                    add_group("secret.crypto_key", "SECRET", "HIGH", match)
                else:
                    findings.append(Finding("secret.crypto_key", "SECRET", "HIGH", match.start(), match.end(), match.group(0)))

        # 2. Email addresses (not the user:password@host part of a connection string)
        for match in self.EMAIL_PATTERN.finditer(text):
            if _overlaps(connection_spans, match.start(), match.end()):
                continue
            findings.append(Finding("pii.email", "PII", "MEDIUM", match.start(), match.end(), match.group(0)))

        # 2b. IBAN (checked), before cards so its digits are not read as a card or Aadhaar number
        iban_spans = []
        for match in self.IBAN_PATTERN.finditer(text):
            if not iban_valid(match.group(0)):
                continue
            findings.append(Finding("pii.iban", "PII", "HIGH", match.start(), match.end(), match.group(0)))
            iban_spans.append((match.start(), match.end()))

        # 3. Payment card numbers
        number_spans = list(iban_spans)
        for match in self.CARD_PATTERN.finditer(text):
            digits = re.sub(r"\D", "", match.group(0))
            if _overlaps(iban_spans, match.start(), match.end()):
                continue
            if 13 <= len(digits) <= 19 and len(set(digits)) > 1 and luhn_valid(digits):
                findings.append(Finding("pii.credit_card", "PII", "HIGH", match.start(), match.end(), match.group(0)))
                number_spans.append((match.start(), match.end()))

        # 4. Aadhaar numbers
        for match in self.AADHAAR_PATTERN.finditer(text):
            digits = re.sub(r"\D", "", match.group(0))
            if _overlaps(iban_spans, match.start(), match.end()):
                continue
            if len(digits) == 12 and verhoeff_valid(digits):
                findings.append(Finding("pii.aadhaar", "PII", "HIGH", match.start(), match.end(), match.group(0)))
                number_spans.append((match.start(), match.end()))

        # 4b. UPI IDs, GSTIN, passport and voter ID numbers, bank details, internal IP addresses
        for match in self.UPI_PATTERN.finditer(text):
            findings.append(Finding("pii.upi", "PII", "MEDIUM", match.start(), match.end(), match.group(0)))
            number_spans.append((match.start(), match.end()))
        for match in self.GSTIN_PATTERN.finditer(text):
            if gstin_valid(match.group(0)):
                findings.append(Finding("pii.gstin", "PII", "LOW", match.start(), match.end(), match.group(0)))
        for match in self.PASSPORT_PATTERN.finditer(text):
            add_group("pii.passport", "PII", "HIGH", match)
        for match in self.VOTER_PATTERN.finditer(text):
            add_group("pii.voter_id", "PII", "MEDIUM", match)
        for match in self.IFSC_PATTERN.finditer(text):
            findings.append(Finding("pii.bank_account", "PII", "HIGH", match.start(), match.end(), match.group(0)))
        for match in self.ACCOUNT_PATTERN.finditer(text):
            number_spans.append(add_group("pii.bank_account", "PII", "HIGH", match))
        for match in self.PRIVATE_IP_PATTERN.finditer(text):
            if all(int(o) <= 255 for o in match.group(0).split(".")):
                findings.append(Finding("restricted.internal_ip", "RESTRICTED", "LOW", match.start(), match.end(), match.group(0)))

        # 5. PAN numbers
        for match in self.PAN_PATTERN.finditer(text):
            findings.append(Finding("pii.pan_india", "PII", "MEDIUM", match.start(), match.end(), match.group(0)))

        # 6. Telephone numbers: at least 10 digits, not glued to other letters/digits
        #    (e.g. inside an order number or API key), and not part of a card/Aadhaar/secret match
        secret_spans = [(f.start, f.end) for f in findings if f.category == "SECRET"]
        for pattern in self.PHONE_PATTERNS:
            for match in pattern.finditer(text):
                val = match.group(0).strip()
                digits = re.sub(r"\D", "", val)
                if len(digits) < 10:
                    continue
                before = text[match.start() - 1] if match.start() > 0 else ""
                after = text[match.end()] if match.end() < len(text) else ""
                if (before and (before.isalnum() or before in "_-")) or (after and after.isalnum()):
                    continue
                if any(match.start() < end and match.end() > start for start, end in number_spans + secret_spans):
                    continue
                findings.append(Finding("pii.phone", "PII", "LOW", match.start(), match.end(), val))

        # 7. Restricted internal codewords
        for kw in self.restricted_keywords:
            if not kw:
                continue
            pattern = re.compile(rf"\b{re.escape(kw)}\b", re.IGNORECASE)
            for match in pattern.finditer(text):
                findings.append(Finding("restricted.keyword", "RESTRICTED", "MEDIUM", match.start(), match.end(), match.group(0)))

        # Sort findings by starting position in the text
        findings.sort(key=lambda f: (f.start, f.rule_id))
        return findings

    def redact(self, text: str, findings: Optional[List[Finding]] = None) -> str:
        """Replaces detected sensitive tokens with safe category placeholders.

        Overlapping findings are merged, and replacements run from the end of the
        string backwards so character indexes for earlier matches stay accurate.
        """
        if findings is None:
            findings = self.detect(text)

        if not findings:
            return text

        spans = []
        for f in sorted(findings, key=lambda f: f.start):
            if spans and f.start < spans[-1][1]:
                spans[-1][1] = max(spans[-1][1], f.end)
            else:
                spans.append([f.start, f.end, f.category])

        result = text
        for start, end, category in reversed(spans):
            result = result[:start] + f"[REDACTED:{category}]" + result[end:]
        return result
