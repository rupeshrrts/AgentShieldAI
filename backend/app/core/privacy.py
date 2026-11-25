"""Prompt sanitization applied before anything is written to the audit database.

The extension masks secrets before sending, but the backend must not trust that:
an old extension build, a test script, or a forged request could send plaintext
credentials. Everything stored passes through `mask_secrets` here.
"""

import re
from typing import Optional

from app.detection.detector import DetectorEngine

MAX_STORED_PROMPT_CHARS = 20000
MAX_PREVIEW_CHARS = 4000

_engine = DetectorEngine()

# Already-masked markers produced by the extension; leave them alone.
_ALREADY_MASKED = re.compile(r"\[(?:MASKED|SECRET_MASKED|MASKED_SECRET|MASKED_PASSWORD|REDACTED:[A-Z]+)\]")


def _mask_value(value: str) -> str:
    if len(value) <= 8:
        return "****[SECRET_MASKED]"
    return value[:4] + "****[MASKED]"


# Findings that are never stored in readable form, whatever the privacy settings
ALWAYS_MASKED_RULES = {
    "secret.api_key_like", "secret.password_like", "pii.credit_card", "pii.aadhaar",
    "secret.crypto_key", "secret.connection_string", "pii.iban", "pii.bank_account", "pii.passport", "pii.voter_id",
}


def mask_secrets(text: Optional[str]) -> Optional[str]:
    """Masks credentials, payment card numbers and Aadhaar numbers before storage."""
    if not text:
        return text
    findings = [f for f in _engine.detect(text) if f.rule_id in ALWAYS_MASKED_RULES]
    if not findings:
        return text

    # Merge overlapping findings (several patterns can match the same span)
    spans = sorted((f.start, f.end) for f in findings)
    merged = [list(spans[0])]
    for start, end in spans[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    result = text
    for start, end in reversed(merged):
        original = result[start:end]
        if _ALREADY_MASKED.search(original):
            continue
        result = result[:start] + _mask_value(original) + result[end:]
    return result


def prepare_prompt_for_storage(text: Optional[str], store_text: bool) -> tuple[Optional[str], Optional[str]]:
    """Returns the (prompt, prompt_preview) pair to persist for an event."""
    if not text:
        return None, None
    if not store_text:
        return None, f"[Prompt text not stored by privacy settings - {len(text)} characters]"
    masked = mask_secrets(text[:MAX_STORED_PROMPT_CHARS])
    return masked, masked[:MAX_PREVIEW_CHARS]
