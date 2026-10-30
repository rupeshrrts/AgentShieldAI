"""ECDSA P-256 key pairs in the format the server expects (same as WebCrypto in the extension):
public key = base64 SPKI DER, signature = base64 raw r||s over SHA-256."""
import base64

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from . import secure_store


def new_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def public_b64(key: ec.EllipticCurvePrivateKey) -> str:
    der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(der).decode()


def sign_b64(key: ec.EllipticCurvePrivateKey, message: str) -> str:
    r, s = decode_dss_signature(key.sign(message.encode("utf-8"), ec.ECDSA(hashes.SHA256())))
    return base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode()


def dump_protected(key) -> str:
    """Private key -> DPAPI-protected PKCS#8, base64 (for the state file)."""
    der = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return base64.b64encode(secure_store.protect(der)).decode()


def load_protected(value: str):
    return serialization.load_der_private_key(secure_store.unprotect(base64.b64decode(value)), password=None)
