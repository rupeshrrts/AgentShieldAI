"""Security utilities: password hashing, secrets, device signatures and JWT token management."""
import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Union
import jwt
from app.core.config import settings


PBKDF2_ITERATIONS = 600_000  # OWASP 2023 guidance for PBKDF2-HMAC-SHA256; older hashes keep their own count


def hash_password(password: str) -> str:
    """Hashes a password using PBKDF2-HMAC-SHA256 with a unique random salt."""
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITERATIONS,
    )
    return f"pbkdf2:sha256:{PBKDF2_ITERATIONS}${salt}${key.hex()}"


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verifies a plain password against the stored PBKDF2 hash."""
    try:
        if not hashed_password or "$" not in hashed_password:
            return False
        parts = hashed_password.split("$")
        if len(parts) != 3:
            return False
        header, salt, stored_hash = parts
        iterations = int(header.split(":")[2])
        key = hashlib.pbkdf2_hmac(
            "sha256",
            plain_password.encode("utf-8"),
            salt.encode("utf-8"),
            iterations,
        )
        return hmac.compare_digest(key.hex(), stored_hash)
    except Exception:
        return False


DEVICE_KEY_PREFIX = "asd_"


def generate_device_key() -> str:
    """Generates a new random device enrollment key (shown to the admin once)."""
    return DEVICE_KEY_PREFIX + secrets.token_urlsafe(32)


def hash_device_key(key: str) -> str:
    """Hashes a device key for storage and lookup. Keys are high-entropy, so SHA-256 is sufficient."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


INVITE_TOKEN_PREFIX = "asi_"
VERIFY_TOKEN_PREFIX = "asv_"
ACTIVATION_TOKEN_PREFIX = "asa_"


def generate_secret(prefix: str) -> str:
    """Random single-use secret (256 bits) with a readable prefix. Store only hash_device_key() of it."""
    return prefix + secrets.token_urlsafe(32)


# JWT "typ" claims. Dashboard tokens predate the claim, so a missing typ means "user".
TOKEN_TYPE_USER = "user"
TOKEN_TYPE_DEVICE = "device"
TOKEN_TYPE_CHALLENGE = "device_challenge"
TOKEN_TYPE_DOWNLOAD = "download"  # 5-minute link to download the extension (accounts with an active plan)


def verify_device_signature(public_key_b64: str, message: bytes, signature_b64: str) -> bool:
    """Checks a WebCrypto ECDSA P-256 / SHA-256 signature (raw r||s) against an SPKI public key."""
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

        public_key = serialization.load_der_public_key(base64.b64decode(public_key_b64))
        if not isinstance(public_key, ec.EllipticCurvePublicKey) or public_key.curve.name != "secp256r1":
            return False
        raw = base64.b64decode(signature_b64)
        if len(raw) != 64:
            return False
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        public_key.verify(der, message, ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False
    except Exception:
        return False


def is_valid_device_public_key(public_key_b64: str) -> bool:
    """True for a base64 SPKI P-256 public key."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        key = serialization.load_der_public_key(base64.b64decode(public_key_b64, validate=True))
        return isinstance(key, ec.EllipticCurvePublicKey) and key.curve.name == "secp256r1"
    except Exception:
        return False


def create_access_token(subject: Union[str, Any], expires_delta: Optional[timedelta] = None, extra_claims: Optional[dict] = None) -> str:
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    
    to_encode = {"exp": expire, "iat": datetime.now(timezone.utc), "sub": str(subject), "typ": TOKEN_TYPE_USER}
    if extra_claims:
        to_encode.update(extra_claims)
        
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt


def decode_access_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload
    except Exception:
        return None
