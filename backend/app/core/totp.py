"""Authenticator-app MFA (TOTP, RFC 6238) for internal staff.

- 6 digits, 30-second steps, SHA-1 (what Google/Microsoft Authenticator expect), ±1 step of clock drift.
- A code is accepted once: the last accepted step is stored and anything at or before it is refused.
- Secrets are encrypted at rest with Fernet; the key is STAFF_MFA_KEY, or derived from SECRET_KEY.
- Recovery codes: 10 random single-use codes shown once, stored only as SHA-256 digests (api/staff_auth.py).
"""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from typing import List, Optional
from urllib.parse import quote

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import settings

STEP_SECONDS = 30
DIGITS = 6
ISSUER = "AgentShieldAI Internal"


def _fernet() -> Fernet:
    if settings.STAFF_MFA_KEY:
        raw = settings.STAFF_MFA_KEY.encode()
    else:
        raw = settings.SECRET_KEY.encode()
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"agentshield-staff-mfa", info=b"totp-secret").derive(raw)
    return Fernet(base64.urlsafe_b64encode(key))


def new_secret() -> str:
    """A random base32 secret (160 bits), as authenticator apps expect."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt_secret(token: str) -> Optional[str]:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        return None


def provisioning_uri(secret: str, email: str) -> str:
    label = quote(f"{ISSUER}:{email}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(ISSUER)}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECONDS}"


def code_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def current_step(now: Optional[float] = None) -> int:
    return int((now if now is not None else time.time()) // STEP_SECONDS)


def verify(secret: str, code: str, last_step: Optional[int], now: Optional[float] = None) -> Optional[int]:
    """Returns the matched step if the code is valid and newer than last_step, else None."""
    code = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(code) != DIGITS:
        return None
    step = current_step(now)
    for candidate in (step - 1, step, step + 1):
        if last_step is not None and candidate <= last_step:
            continue
        if hmac.compare_digest(code_at(secret, candidate), code):
            return candidate
    return None


def new_recovery_codes(count: int = 10) -> List[str]:
    """Codes like 'k3f9-2m7q-x8d4' (no ambiguous characters)."""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return ["-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3)) for _ in range(count)]


def normalize_recovery_code(code: str) -> str:
    return "".join(ch for ch in (code or "").lower() if ch.isalnum())
