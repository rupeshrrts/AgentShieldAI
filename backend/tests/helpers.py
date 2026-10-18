"""Test helpers: create accounts and activate a browser through the real API flow."""
import base64
import os
import uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from app.core import ratelimit
from app.core.security import hash_password
from app.db.models import Device, User, utc_now
from app.db.session import SessionLocal

ORG_ID = "org-acme-corp-001"
PASSWORD = "Employee-Pass-2026!"
STAFF_PASSWORD = "Staff-Test-Password-2026!"


def admin_headers(client) -> dict:
    """The test company's admin (credentials come from conftest.py environment variables)."""
    res = client.post("/auth/login", json={"email": os.environ["INITIAL_ADMIN_EMAIL"], "password": os.environ["INITIAL_ADMIN_PASSWORD"]})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def create_staff(role: str = "PLATFORM_OWNER", mfa: bool = True, must_change_password: bool = False,
                 password: str = STAFF_PASSWORD) -> tuple:
    """An internal staff member. Returns (staff_id, email, totp_secret or None)."""
    from app.core import totp
    from app.db.models import StaffUser

    email = f"staff-{uuid.uuid4().hex[:10]}@agentshield.test"
    secret = totp.new_secret() if mfa else None
    db = SessionLocal()
    try:
        staff = StaffUser(email=email, role=role, active=True, password_hash=hash_password(password),
                          must_change_password=must_change_password,
                          totp_secret_enc=totp.encrypt_secret(secret) if secret else None,
                          totp_enabled_at=utc_now() if secret else None)
        db.add(staff)
        db.commit()
        return staff.id, email, secret
    finally:
        db.close()


def staff_headers(role: str = "PLATFORM_OWNER") -> dict:
    """A signed-in, MFA-verified staff session for `role` (token minted directly; the sign-in flow has its own tests)."""
    from datetime import timedelta

    from app.core.security import create_access_token

    staff_id, _, _ = create_staff(role)
    token = create_access_token(subject=staff_id, expires_delta=timedelta(hours=1), extra_claims={"typ": "staff", "sv": 0})
    return {"Authorization": f"Bearer {token}"}


def create_account(email: str = None, role: str = "EMPLOYEE", verified: bool = True, active: bool = True, org_id: str = ORG_ID) -> str:
    """Inserts an account directly (as accepting an invite would) and returns its email."""
    email = email or f"emp-{uuid.uuid4().hex[:10]}@example.com"
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == email).first()
        if existing:  # Re-running against the same test database: reset the account and its browsers
            db.query(Device).filter(Device.user_id == existing.id).update({"status": "REVOKED"})
            existing.password_hash = hash_password(PASSWORD)
            existing.role, existing.active = role, active
            existing.email_verified_at = utc_now() if verified else None
        else:
            db.add(User(
                organization_id=org_id, email=email, password_hash=hash_password(PASSWORD), role=role,
                active=active, email_verified_at=utc_now() if verified else None,
            ))
        db.commit()
    finally:
        db.close()
    return email


def create_company(name: str = None, email: str = None, trial: bool = False, account_type: str = "COMPANY",
                   credits: int = 0, free: bool = None) -> tuple:
    """An account (as /auth/signup + email confirmation would create it). Returns (org_id, admin_email).
    `free` (default: True for individual accounts) means the owner already chose the Free plan."""
    from app.core.entitlements import grant_license
    from app.db.models import Organization, Plan
    from app.db.seed import provision_organization

    db = SessionLocal()
    try:
        chose_free = (account_type == "INDIVIDUAL") if free is None else free
        org = Organization(name=name or f"Co {uuid.uuid4().hex[:6]}", account_type=account_type, credit_balance=0,
                           free_started_at=utc_now() if chose_free else None)
        db.add(org)
        db.flush()
        provision_organization(db, org)
        email = email or f"owner-{uuid.uuid4().hex[:10]}@{uuid.uuid4().hex[:6]}.example"
        db.add(User(organization_id=org.id, email=email, password_hash=hash_password(PASSWORD), role="ADMIN",
                    active=True, email_verified_at=utc_now()))
        if trial:
            grant_license(db, org.id, db.query(Plan).filter(Plan.code == "trial").first(), "test")
        if credits:
            from app.core.usage import add_credits
            add_credits(db, org.id, credits, "grant", reference="test", note="test credits", created_by="test")
        db.commit()
        return org.id, email
    finally:
        db.close()


def login(client, email: str, password: str = PASSWORD) -> dict:
    res = client.post("/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


class DeviceKeys:
    """A browser's key pair, as the extension creates it with WebCrypto (ECDSA P-256)."""

    def __init__(self):
        self.private = ec.generate_private_key(ec.SECP256R1())
        spki = self.private.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        self.public_b64 = base64.b64encode(spki).decode()

    def sign(self, message: str) -> str:
        """Raw r||s signature, the format WebCrypto produces."""
        r, s = decode_dss_signature(self.private.sign(message.encode(), ec.ECDSA(hashes.SHA256())))
        return base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode()


def activation_token(client, user_headers: dict) -> str:
    res = client.post("/api/v1/me/activation-tokens", headers=user_headers)
    assert res.status_code == 201, res.text
    return res.json()["token"]


def activate(client, token: str, keys: DeviceKeys):
    """What the extension sends: only the activation code and the new browser's public key."""
    return client.post("/api/v1/device/activate", json={
        "activation_token": token, "public_key": keys.public_b64, "browser": "Test Chrome", "platform": "Windows",
    })


def session(client, device_id: str, keys: DeviceKeys):
    nonce = client.post("/api/v1/device/challenge", json={"device_id": device_id})
    if nonce.status_code != 200:
        return nonce
    n = nonce.json()["nonce"]
    return client.post("/api/v1/device/session", json={"device_id": device_id, "nonce": n, "signature": keys.sign(n)})


def activated_device(client, email: str = None):
    """Full flow: account -> sign in -> activation code -> activate -> signed challenge -> session.

    Returns (headers, info) where info has email, device_id and keys.
    """
    ratelimit.reset()
    email = create_account(email)
    token = activation_token(client, login(client, email))
    keys = DeviceKeys()
    res = activate(client, token, keys)
    assert res.status_code == 201, res.text
    device_id = res.json()["device_id"]
    sess = session(client, device_id, keys)
    assert sess.status_code == 200, sess.text
    headers = {"Authorization": f"Bearer {sess.json()['session_token']}"}
    return headers, {"email": email, "device_id": device_id, "keys": keys}
