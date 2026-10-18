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


class DetectorEngine:
    """Regex, checksum and keyword detection engine for credentials, PII, and trade secrets."""

    # Pre-compiled regular expressions for high-throughput matching
    API_KEY_PATTERNS: List[re.Pattern] = [
        re.compile(r"\bsk-demo-[A-Za-z0-9_-]{10,}\b", re.IGNORECASE),
        re.compile(r"\bsk-(?:proj|live|test|ant)-[A-Za-z0-9_-]{20,}\b"),
        re.compile(r"\bAKIA[0-9A-Z]{12,20}\b"),  # AWS Access Key ID
        re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{36,}\b"),  # GitHub Personal Access Tokens
        re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),  # Google API key
        re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),  # Slack token
        re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b"),  # Stripe live key
        re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),  # JWT
        re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----"),
        re.compile(r"\b(?:api[_-]?key|secret[_-]?token|bearer)\s*[:=]\s*['\"]?([A-Za-z0-9_\-\.]{16,})['\"]?", re.IGNORECASE),
        re.compile(r"\b(?:password|passwd|pwd|secret)\s*[:=]\s*['\"]?(\S{4,})['\"]?", re.IGNORECASE),
        re.compile(r"\b(?:my\s+password\s+is|password\s+is|(?:this\s+is\s+my\s+)?password\s*[:=])\s*['\"]?(\S{4,})['\"]?", re.IGNORECASE),
        re.compile(r"\b(\S{4,})\s+(?:(?:this\s+)?is\s+my\s+(?:\w+\s+)?password)\b", re.IGNORECASE),
    ]

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

    def detect(self, text: str) -> List[Finding]:
        """Scans input text and returns all detected sensitive data occurrences."""
        if not text:
            return []

        findings: List[Finding] = []

        # 1. API keys, tokens, private keys and password definitions
        for pattern in self.API_KEY_PATTERNS:
            for match in pattern.finditer(text):
                findings.append(Finding("secret.api_key_like", "SECRET", "HIGH", match.start(), match.end(), match.group(0)))

        # 2. Email addresses
        for match in self.EMAIL_PATTERN.finditer(text):
            findings.append(Finding("pii.email", "PII", "MEDIUM", match.start(), match.end(), match.group(0)))

        # 3. Payment card numbers
        number_spans = []
        for match in self.CARD_PATTERN.finditer(text):
            digits = re.sub(r"\D", "", match.group(0))
            if 13 <= len(digits) <= 19 and len(set(digits)) > 1 and luhn_valid(digits):
                findings.append(Finding("pii.credit_card", "PII", "HIGH", match.start(), match.end(), match.group(0)))
                number_spans.append((match.start(), match.end()))

        # 4. Aadhaar numbers
        for match in self.AADHAAR_PATTERN.finditer(text):
            digits = re.sub(r"\D", "", match.group(0))
            if len(digits) == 12 and verhoeff_valid(digits):
                findings.append(Finding("pii.aadhaar", "PII", "HIGH", match.start(), match.end(), match.group(0)))
                number_spans.append((match.start(), match.end()))

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
