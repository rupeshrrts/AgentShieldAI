"""Default mode since 2.4.1 (EMAIL_VERIFICATION_REQUIRED=false): a new individual account gets the Free plan
and can claim the free trial right after sign-up, without confirming its email; no confirmation email is sent.
The invite-a-friend bonus still waits for a confirmed email.

The other suites run with EMAIL_VERIFICATION_REQUIRED=true (conftest.py); this module switches it off.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.api import auth as auth_api
from app.core import ratelimit
from app.core.config import settings
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _no_confirmation(monkeypatch):
    ratelimit.reset()
    monkeypatch.setattr(settings, "EMAIL_VERIFICATION_REQUIRED", False)
    monkeypatch.setattr(settings, "TRIAL_CLAIMS_PER_IP_30D", 100000)
    sent = []
    monkeypatch.setattr(auth_api, "send_email", lambda to, subject, body: sent.append((to, subject)) or "logged")
    yield sent


def _signup(client, referral_code=None):
    email = f"direct-{uuid.uuid4().hex[:10]}@example.com"
    body = {"email": email, "password": "Direct-Access-Pass-2026!", "account_type": "INDIVIDUAL"}
    if referral_code:
        body["referral_code"] = referral_code
    res = client.post("/auth/signup", json=body)
    assert res.status_code == 201, res.text
    data = res.json()
    return email, {"Authorization": f"Bearer {data['access_token']}"}, data


def test_free_plan_and_trial_right_after_signup(client, _no_confirmation):
    email, headers, data = _signup(client)
    assert data["email_verified"] is False and data["email_verification_required"] is False
    assert client.get("/auth/signup-info").json()["email_verification_required"] is False
    assert client.get("/auth/me", headers=headers).json()["email_verification_required"] is False
    # No confirmation email is sent
    assert [to for to, _ in _no_confirmation if to == email] == []

    status = client.get("/api/v1/billing/status", headers=headers).json()
    # No access until a plan is chosen: no download link, no activation code
    assert status["entitlement"]["state"] == "NONE"
    assert status["free"]["eligible"] is True and status["trial"]["eligible"] is True
    assert client.post("/api/v1/me/activation-tokens", headers=headers).status_code == 403
    assert client.post("/api/v1/me/download-link", headers=headers, json={"file": "agentshield-extension.zip"}).status_code == 403
    # Choosing the Free plan works right away (no confirmation needed here), then downloading and connecting do
    free = client.post("/api/v1/billing/free", headers=headers)
    assert free.status_code == 201 and free.json()["state"] == "FREE_ACTIVE"
    assert client.post("/api/v1/billing/free", headers=headers).status_code == 409
    assert client.post("/api/v1/me/activation-tokens", headers=headers).status_code == 201
    # The trial can still be claimed once after choosing the Free plan
    claim = client.post("/api/v1/billing/trial", headers=headers)
    assert claim.status_code in (200, 201), claim.text
    assert client.get("/api/v1/billing/status", headers=headers).json()["entitlement"]["state"] == "TRIAL_ACTIVE"


def test_trial_is_still_once_per_person(client):
    _email, headers, _ = _signup(client)
    assert client.post("/api/v1/billing/trial", headers=headers).status_code in (200, 201)
    again = client.post("/api/v1/billing/trial", headers=headers)
    assert again.status_code >= 400


def test_referral_bonus_still_needs_a_confirmed_email(client):
    _inviter, inviter_headers, _ = _signup(client)
    code = client.get("/api/v1/referrals", headers=inviter_headers).json()["code"]
    _friend, _friend_headers, _ = _signup(client, referral_code=code)
    after = client.get("/api/v1/referrals", headers=inviter_headers).json()
    assert after["pending"] == 1 and after["rewarded"] == 0
