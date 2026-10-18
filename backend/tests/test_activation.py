"""Acceptance tests: accounts, invites, activation codes, device authorization and sessions.

Every browser must be activated by a verified, active account with a single-use code
and a device key pair; copying files, storage or codes must grant nothing.
"""
import re
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import ratelimit
from app.core.security import create_access_token, generate_device_key, hash_device_key
from app.db.models import ActivationToken, DeviceKey, User, utc_now
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import (
    ORG_ID,
    PASSWORD,
    DeviceKeys,
    activate,
    activated_device,
    activation_token,
    admin_headers,
    create_account,
    login,
    session,
)

EVENT = {"site": "chatgpt.com", "rule_id": "pii.email", "category": "PII", "severity": "LOW",
         "action": "WARN", "outcome": "warned_and_confirmed"}


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _fresh_limits():
    ratelimit.reset()
    yield


def _code(res) -> str:
    detail = res.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else str(detail)


# 1. A newly installed extension has no access
def test_fresh_install_has_no_access(client):
    assert client.get("/api/v1/policies").status_code == 401
    assert client.get("/api/v1/domains").status_code == 401
    assert client.post("/api/v1/events", json=EVENT).status_code == 401
    assert client.post("/api/v1/endpoints/heartbeat", json={"device_id": "install-xyz-0001"}).status_code == 401
    unknown = client.post("/api/v1/device/challenge", json={"device_id": str(uuid.uuid4())})
    assert unknown.status_code == 401 and _code(unknown) == "DEVICE_UNKNOWN"


# 2 & 3. Random, used, revoked and expired codes are rejected
def test_random_activation_code_is_rejected(client):
    email = create_account()
    res = activate(client, "asa_" + "x" * 43, DeviceKeys())
    assert res.status_code == 400 and _code(res) == "INVALID_TOKEN"


def test_code_is_single_use(client):
    email = create_account()
    token = activation_token(client, login(client, email))
    assert activate(client, token, DeviceKeys()).status_code == 201
    again = activate(client, token, DeviceKeys())
    assert again.status_code == 400 and _code(again) == "INVALID_TOKEN"


def test_new_code_revokes_the_previous_one(client):
    email = create_account()
    headers = login(client, email)
    first = activation_token(client, headers)
    activation_token(client, headers)
    res = activate(client, first, DeviceKeys())
    assert res.status_code == 400 and _code(res) == "REVOKED"


def test_expired_code_is_rejected(client):
    email = create_account()
    token = activation_token(client, login(client, email))
    db = SessionLocal()
    try:
        row = db.query(ActivationToken).filter(ActivationToken.token_hash == hash_device_key(token)).first()
        row.expires_at = utc_now() - timedelta(minutes=1)
        db.commit()
    finally:
        db.close()
    res = activate(client, token, DeviceKeys())
    assert res.status_code == 400 and _code(res) == "EXPIRED"


# 4. A code binds the browser to the account that generated it; account and device policy apply
def test_code_binds_browser_to_its_owner(client):
    owner = create_account()
    token = activation_token(client, login(client, owner))
    keys = DeviceKeys()
    res = activate(client, token, keys)
    assert res.status_code == 201 and res.json()["user_email"] == owner
    sess = session(client, res.json()["device_id"], keys)
    assert sess.json()["user_email"] == owner
    # The owner sees it in their own list; another account does not
    mine = client.get("/api/v1/me/devices", headers=login(client, owner)).json()
    assert [d["id"] for d in mine] == [res.json()["device_id"]]
    assert client.get("/api/v1/me/devices", headers=login(client, create_account())).json() == []


def test_code_only_works_from_a_signed_in_account(client):
    # Codes can only be generated while signed in; without a sign-in there is nothing to paste
    assert client.post("/api/v1/me/activation-tokens").status_code == 401


def test_disabled_account_cannot_activate(client):
    email = create_account()
    token = activation_token(client, login(client, email))
    db = SessionLocal()
    try:
        db.query(User).filter(User.email == email).update({"active": False})
        db.commit()
    finally:
        db.close()
    res = activate(client, token, DeviceKeys())
    assert res.status_code == 403 and _code(res) == "ACCOUNT_DISABLED"

    # A disabled account cannot sign in either, so it can never get a new code
    res = client.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert res.status_code == 403


def test_device_approval_policy(client):
    admin = admin_headers(client)
    client.patch("/api/v1/org/settings", json={"require_device_approval": True}, headers=admin)
    try:
        email = create_account()
        keys = DeviceKeys()
        res = activate(client, activation_token(client, login(client, email)), keys)
        assert res.status_code == 201 and res.json()["status"] == "PENDING"
        device_id = res.json()["device_id"]
        pending = session(client, device_id, keys)
        assert pending.status_code == 403 and _code(pending) == "PENDING_APPROVAL"

        assert client.post(f"/api/v1/org/devices/{device_id}/approve", headers=admin).status_code == 200
        assert session(client, device_id, keys).status_code == 200
    finally:
        client.patch("/api/v1/org/settings", json={"require_device_approval": False}, headers=admin)


def test_device_limit(client):
    email = create_account()
    headers = login(client, email)
    for _ in range(3):
        ratelimit.reset()
        assert activate(client, activation_token(client, headers), DeviceKeys()).status_code == 201
    ratelimit.reset()
    res = activate(client, activation_token(client, headers), DeviceKeys())
    assert res.status_code == 409 and _code(res) == "DEVICE_LIMIT"


# 5. Copying a device ID (files, storage) without the private key grants nothing
def test_copied_device_id_without_private_key_is_rejected(client):
    _headers, info = activated_device(client)
    attacker = DeviceKeys()
    res = session(client, info["device_id"], attacker)
    assert res.status_code == 401 and _code(res) == "INVALID_SIGNATURE"


def test_challenge_cannot_be_replayed(client):
    _headers, info = activated_device(client)
    nonce = client.post("/api/v1/device/challenge", json={"device_id": info["device_id"]}).json()["nonce"]
    body = {"device_id": info["device_id"], "nonce": nonce, "signature": info["keys"].sign(nonce)}
    assert client.post("/api/v1/device/session", json=body).status_code == 200
    replay = client.post("/api/v1/device/session", json=body)
    assert replay.status_code == 401


# 6. Forged, expired, mistyped and revoked sessions are rejected
def test_forged_and_expired_sessions_are_rejected(client):
    _headers, info = activated_device(client)
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == info["email"]).first()
        uid = user.id
    finally:
        db.close()
    claims = {"typ": "device", "uid": uid, "org": ORG_ID}

    import jwt
    forged = jwt.encode({"sub": info["device_id"], **claims, "exp": utc_now() + timedelta(minutes=5)}, "not-the-secret", algorithm="HS256")
    assert client.get("/api/v1/policies", headers={"Authorization": f"Bearer {forged}"}).status_code == 401

    expired = create_access_token(info["device_id"], expires_delta=timedelta(seconds=-5), extra_claims=claims)
    assert client.get("/api/v1/policies", headers={"Authorization": f"Bearer {expired}"}).status_code == 401

    # A challenge nonce is not a session
    nonce = client.post("/api/v1/device/challenge", json={"device_id": info["device_id"]}).json()["nonce"]
    assert client.get("/api/v1/policies", headers={"Authorization": f"Bearer {nonce}"}).status_code == 401

    # Session claims must match the device's real account
    wrong_user = create_access_token(info["device_id"], extra_claims={**claims, "uid": "usr-admin-001"})
    assert client.get("/api/v1/policies", headers={"Authorization": f"Bearer {wrong_user}"}).status_code == 401


def test_revoking_device_or_disabling_account_locks_live_session(client):
    headers, info = activated_device(client)
    assert client.get("/api/v1/policies", headers=headers).status_code == 200
    assert client.post(f"/api/v1/me/devices/{info['device_id']}/revoke", headers=login(client, info["email"])).status_code == 200
    assert client.get("/api/v1/policies", headers=headers).status_code == 401
    res = session(client, info["device_id"], info["keys"])
    assert res.status_code == 403 and _code(res) == "REVOKED"

    headers2, info2 = activated_device(client)
    db = SessionLocal()
    try:
        db.query(User).filter(User.email == info2["email"]).update({"active": False})
        db.commit()
    finally:
        db.close()
    assert client.get("/api/v1/policies", headers=headers2).status_code == 401


def test_extension_sign_out_revokes_device(client):
    headers, info = activated_device(client)
    assert client.post("/api/v1/device/deactivate", headers=headers).status_code == 204
    assert client.get("/api/v1/policies", headers=headers).status_code == 401
    assert client.post("/api/v1/device/deactivate", headers=admin_headers(client)).status_code == 403


# 7. Events are attributed to the device's account, never to a value in the request
def test_event_user_comes_from_device(client):
    headers, info = activated_device(client)
    res = client.post("/api/v1/events", json={**EVENT, "user_id": "ceo@example.com"}, headers=headers)
    assert res.status_code == 201
    assert res.json()["user_id"] == info["email"]


# 8. Employee accounts cannot read organization data
def test_employee_role_isolation(client):
    email = create_account()
    emp = login(client, email)
    for path in ("/api/v1/events", "/api/v1/metrics/summary", "/api/v1/org/settings", "/api/v1/endpoints",
                 "/api/v1/org/audit-log", "/api/v1/policies", "/api/v1/org/users"):
        assert client.get(path, headers=emp).status_code == 403, path
    assert client.get("/auth/me", headers=emp).status_code == 200
    assert client.get("/api/v1/me/devices", headers=emp).status_code == 200


# 9. Rate limits
def test_activation_is_rate_limited(client):
    codes = [activate(client, "asa_" + "y" * 43, DeviceKeys()).status_code for _ in range(11)]
    assert codes[:10] == [400] * 10 and codes[10] == 429


# 10. Old organization-wide device keys no longer work
def test_legacy_device_key_is_rejected(client):
    raw = generate_device_key()
    db = SessionLocal()
    try:
        db.add(DeviceKey(organization_id=ORG_ID, name="legacy", key_hash=hash_device_key(raw), key_prefix=raw[:10]))
        db.commit()
    finally:
        db.close()
    assert client.get("/api/v1/policies", headers={"X-Device-Key": raw}).status_code == 401
    assert client.get("/api/v1/org/device-keys", headers=admin_headers(client)).status_code == 410


# Self sign-up: create account (signed in at once) -> confirm email -> trial -> code -> connect
def test_signup_flow(client, monkeypatch):
    sent = []
    monkeypatch.setattr("app.api.auth.send_email", lambda to, subject, body: sent.append(body) or "log")
    email = f"signup-{uuid.uuid4().hex[:8]}@example.com"

    assert client.post("/auth/signup", json={"email": email, "password": "short"}).status_code == 422
    res = client.post("/auth/signup", json={"email": email, "password": PASSWORD})
    # Signed in straight away as the owner of a new individual account; a confirmation link is emailed
    assert res.status_code == 201 and len(sent) == 1 and "#verify=asv_" in sent[0]
    assert res.json()["role"] == "ADMIN" and res.json()["organization_id"] != ORG_ID and res.json()["access_token"]
    assert res.json()["account_type"] == "INDIVIDUAL" and res.json()["email_verified"] is False
    assert client.post("/auth/login", json={"email": email, "password": PASSWORD}).status_code == 200

    # The same email cannot sign up twice, and the existing password is unchanged
    again = client.post("/auth/signup", json={"email": email.upper(), "password": "Another-Password-2026!"})
    assert again.status_code == 409
    assert client.post("/auth/login", json={"email": email, "password": "Another-Password-2026!"}).status_code == 401

    headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
    assert client.get("/api/v1/events", headers=headers).json()["items"] == []  # only its own (empty) account
    # The free trial needs a confirmed email
    refused = client.post("/api/v1/billing/trial", headers=headers)
    assert refused.status_code == 409 and "Confirm your email" in str(refused.json())
    token = re.search(r"#verify=(asv_[\w-]+)", sent[0]).group(1)
    assert client.post("/auth/verify-email", json={"token": token}).status_code == 200

    # Now claim the trial, generate a code, and connect a browser with it
    assert client.post("/api/v1/billing/trial", headers=headers).status_code == 201
    assert activate(client, activation_token(client, headers), DeviceKeys()).status_code == 201


def test_signup_domain_restriction(client, monkeypatch):
    monkeypatch.setattr("app.api.auth.settings.SIGNUP_ALLOWED_DOMAINS", ["motwane.com"])
    monkeypatch.setattr("app.api.auth.send_email", lambda *a: "log")
    res = client.post("/auth/signup", json={"email": "someone@gmail.com", "password": PASSWORD})
    assert res.status_code == 400
    assert client.post("/auth/signup", json={"email": f"x{uuid.uuid4().hex[:6]}@motwane.com", "password": PASSWORD}).status_code == 201


# Invites: admins can also create accounts directly
def test_invite_flow(client, monkeypatch):
    sent = {}

    def fake_send(to, subject, body):
        sent["to"], sent["body"] = to, body
        return "log"

    monkeypatch.setattr("app.api.users.send_email", fake_send)
    admin = admin_headers(client)
    email = f"invitee-{uuid.uuid4().hex[:8]}@example.com"
    res = client.post("/api/v1/org/users/invite", json={"email": email, "role": "EMPLOYEE"}, headers=admin)
    assert res.status_code == 201 and res.json()["delivery"] == "log"
    assert "token" not in res.json()  # the admin never sees the secret link

    token = re.search(r"#invite=(asi_[\w-]+)", sent["body"]).group(1)
    info = client.get(f"/auth/invite/{token}")
    assert info.status_code == 200 and info.json()["email"] == email

    assert client.post("/auth/accept-invite", json={"token": token, "password": "short"}).status_code == 422
    accepted = client.post("/auth/accept-invite", json={"token": token, "password": PASSWORD})
    assert accepted.status_code == 200 and accepted.json()["role"] == "EMPLOYEE"
    assert client.post("/auth/accept-invite", json={"token": token, "password": PASSWORD}).status_code == 404

    db = SessionLocal()
    try:
        assert db.query(User).filter(User.email == email).first().email_verified_at is not None
    finally:
        db.close()

    # The new employee can now activate a browser
    user_headers = {"Authorization": f"Bearer {accepted.json()['access_token']}"}
    assert activate(client, activation_token(client, user_headers), DeviceKeys()).status_code == 201

    # Inviting an existing account is refused; a random invite link is not found
    assert client.post("/api/v1/org/users/invite", json={"email": email}, headers=admin).status_code == 409
    assert client.get("/auth/invite/asi_" + "z" * 43).status_code == 404
