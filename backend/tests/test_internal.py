"""Internal admin console: staff sign-in with mandatory MFA, token separation, the permission
matrix, licence exceptions, staff management, the bootstrap command, audit records and
cross-tenant protection of customer APIs."""
import re
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import ratelimit, totp
from app.core.permissions import STAFF_PERMISSIONS, STAFF_ROLES, staff_has
from app.core.security import create_access_token
from app.db.models import AdminAuditLog, Device, DomainRule, License, Policy, RestrictedKeyword, StaffUser, User
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import (
    STAFF_PASSWORD,
    DeviceKeys,
    activate,
    activation_token,
    create_company,
    create_staff,
    login,
    session,
    staff_headers,
)


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _limits():
    ratelimit.reset()
    yield


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _now_code(secret: str, offset: int = 0) -> str:
    return totp.code_at(secret, totp.current_step() + offset)


def _audit_actions(email: str) -> list:
    db = SessionLocal()
    try:
        return [(a.action, a.actor_type) for a in db.query(AdminAuditLog).filter(AdminAuditLog.actor == f"staff:{email}").all()]
    finally:
        db.close()


def _enrol(client, email: str, password: str = STAFF_PASSWORD) -> tuple:
    """Password -> authenticator enrolment. Returns (secret, recovery_codes, session_token)."""
    step = client.post("/internal/auth/login", json={"email": email, "password": password}).json()
    assert step["step"] == "mfa_setup"
    setup = client.post("/internal/auth/mfa/setup", headers=_bearer(step["token"])).json()
    assert setup["otpauth_uri"].startswith("otpauth://totp/") and setup["secret"] in setup["otpauth_uri"]
    res = client.post("/internal/auth/mfa/enable", headers=_bearer(step["token"]), json={"code": _now_code(setup["secret"])})
    assert res.status_code == 200, res.text
    return setup["secret"], res.json()["recovery_codes"], res.json()["session"]["access_token"]


# --- Sign-in and MFA --------------------------------------------------------------------------

def test_no_session_before_mfa_enrolment(client):
    _, email, _ = create_staff("PLATFORM_ADMIN", mfa=False)
    step = client.post("/internal/auth/login", json={"email": email, "password": STAFF_PASSWORD}).json()
    assert step["step"] == "mfa_setup" and "access_token" not in step
    # The step token is not a session
    assert client.get("/internal/api/companies", headers=_bearer(step["token"])).status_code == 401
    assert client.get("/internal/auth/me", headers=_bearer(step["token"])).status_code == 401

    setup = client.post("/internal/auth/mfa/setup", headers=_bearer(step["token"])).json()
    bad = client.post("/internal/auth/mfa/enable", headers=_bearer(step["token"]), json={"code": "000000"})
    assert bad.status_code == 400
    ok = client.post("/internal/auth/mfa/enable", headers=_bearer(step["token"]), json={"code": _now_code(setup["secret"])})
    assert ok.status_code == 200 and len(ok.json()["recovery_codes"]) == 10
    token = ok.json()["session"]["access_token"]
    assert client.get("/internal/api/companies", headers=_bearer(token)).status_code == 200
    # A leftover enrolment token can never replace the authenticator
    assert client.post("/internal/auth/mfa/setup", headers=_bearer(step["token"])).status_code == 409
    actions = _audit_actions(email)
    assert ("staff.mfa.enrolled", "staff") in actions and ("staff.login.success", "staff") in actions
    db = SessionLocal()
    try:
        stored = db.query(StaffUser).filter(StaffUser.email == email).first().totp_secret_enc
        assert setup["secret"] not in stored  # encrypted at rest
    finally:
        db.close()


def test_codes_work_once_and_recovery_codes_are_single_use(client):
    _, email, _ = create_staff("SECURITY_ANALYST", mfa=False)
    secret, recovery, _ = _enrol(client, email)
    step = client.post("/internal/auth/login", json={"email": email, "password": STAFF_PASSWORD}).json()
    assert step["step"] == "mfa"
    # The code used for enrolment cannot be replayed
    assert client.post("/internal/auth/mfa/verify", headers=_bearer(step["token"]), json={"code": _now_code(secret)}).status_code == 400
    next_code = _now_code(secret, 1)
    assert client.post("/internal/auth/mfa/verify", headers=_bearer(step["token"]), json={"code": next_code}).status_code == 200
    assert client.post("/internal/auth/mfa/verify", headers=_bearer(step["token"]), json={"code": next_code}).status_code == 400

    ok = client.post("/internal/auth/mfa/verify", headers=_bearer(step["token"]), json={"recovery_code": recovery[0].upper()})
    assert ok.status_code == 200
    again = client.post("/internal/auth/mfa/verify", headers=_bearer(step["token"]), json={"recovery_code": recovery[0]})
    assert again.status_code == 400
    assert ("staff.recovery_code_used", "staff") in _audit_actions(email)


def test_wrong_password_lockout_and_no_staff_enumeration(client):
    _, email, _ = create_staff("SUPPORT_AGENT")
    unknown = client.post("/internal/auth/login", json={"email": "nobody@agentshield.test", "password": "x" * 20})
    wrong = client.post("/internal/auth/login", json={"email": email, "password": "x" * 20})
    assert unknown.status_code == wrong.status_code == 401 and unknown.json() == wrong.json()
    for _ in range(4):
        client.post("/internal/auth/login", json={"email": email, "password": "x" * 20})
    locked = client.post("/internal/auth/login", json={"email": email, "password": STAFF_PASSWORD})
    assert locked.status_code == 429
    assert ("staff.login.failed", "staff") in _audit_actions(email)


def test_temporary_password_must_be_changed_first(client):
    staff_id, email, _ = create_staff("PLATFORM_OWNER", must_change_password=True)
    token = create_access_token(subject=staff_id, expires_delta=timedelta(hours=1), extra_claims={"typ": "staff", "sv": 0})
    res = client.get("/internal/api/companies", headers=_bearer(token))
    assert res.status_code == 403 and res.json()["detail"]["code"] == "PASSWORD_CHANGE_REQUIRED"
    assert client.get("/internal/auth/me", headers=_bearer(token)).json()["must_change_password"] is True
    short = client.post("/internal/auth/change-password", headers=_bearer(token),
                        json={"current_password": STAFF_PASSWORD, "new_password": "short"})
    assert short.status_code == 400
    res = client.post("/internal/auth/change-password", headers=_bearer(token),
                      json={"current_password": STAFF_PASSWORD, "new_password": "A-much-longer-staff-password-1"})
    assert res.status_code == 200
    assert client.get("/internal/auth/me", headers=_bearer(token)).status_code == 401  # old session ended
    assert client.get("/internal/api/companies", headers=_bearer(res.json()["access_token"])).status_code == 200


def test_bootstrap_command_creates_owner_with_temporary_password(client):
    from app.cli import create_platform_owner

    email = f"owner-{uuid.uuid4().hex[:8]}@agentshield.test"
    temporary = create_platform_owner(email, force=True)
    assert len(temporary) >= 20
    with pytest.raises(ValueError):
        create_platform_owner(f"second-{uuid.uuid4().hex[:8]}@agentshield.test")  # an owner exists
    step = client.post("/internal/auth/login", json={"email": email, "password": temporary}).json()
    assert step["step"] == "mfa_setup" and step["must_change_password"] is True
    db = SessionLocal()
    try:
        owner = db.query(StaffUser).filter(StaffUser.email == email).first()
        assert owner.role == "PLATFORM_OWNER" and owner.must_change_password and owner.totp_enabled_at is None
        assert temporary not in (owner.password_hash or "")
    finally:
        db.close()


def test_reset_staff_password_command(client):
    from datetime import datetime, timezone

    from app.cli import create_platform_owner, reset_staff_password

    email = f"reset-{uuid.uuid4().hex[:8]}@agentshield.test"
    first = create_platform_owner(email, force=True)
    db = SessionLocal()
    try:  # pretend the authenticator was set up and the temporary password changed
        owner = db.query(StaffUser).filter(StaffUser.email == email).first()
        owner.totp_enabled_at, owner.totp_secret_enc, owner.must_change_password = datetime.now(timezone.utc), "x", False
        version = owner.session_version or 0
        db.commit()
    finally:
        db.close()
    with pytest.raises(ValueError):
        reset_staff_password(f"nobody-{uuid.uuid4().hex[:8]}@agentshield.test")

    temporary = reset_staff_password(email.upper())  # email is matched case-insensitively
    assert len(temporary) >= 20 and temporary != first
    assert client.post("/internal/auth/login", json={"email": email, "password": first}).status_code == 401
    step = client.post("/internal/auth/login", json={"email": email, "password": temporary}).json()
    assert step["step"] == "mfa" and step["must_change_password"] is True  # authenticator kept
    db = SessionLocal()
    try:
        owner = db.query(StaffUser).filter(StaffUser.email == email).first()
        assert owner.session_version == version + 1 and temporary not in owner.password_hash
    finally:
        db.close()

    again = reset_staff_password(email, reset_mfa=True)
    step = client.post("/internal/auth/login", json={"email": email, "password": again}).json()
    assert step["step"] == "mfa_setup"  # authenticator removed: set up again
    db = SessionLocal()
    try:
        owner = db.query(StaffUser).filter(StaffUser.email == email).first()
        assert owner.totp_secret_enc is None and owner.totp_enabled_at is None
    finally:
        db.close()


# --- Token separation -------------------------------------------------------------------------

def test_customer_and_device_tokens_are_refused_internally_and_vice_versa(client):
    org, email = create_company(trial=True)
    customer = login(client, email)
    keys = DeviceKeys()
    device_id = activate(client, activation_token(client, customer), keys).json()["device_id"]
    device = _bearer(session(client, device_id, keys).json()["session_token"])
    for headers in (customer, device, {}):
        for path in ("/internal/api/companies", "/internal/api/metrics", "/internal/api/analytics", "/internal/api/staff",
                     "/internal/api/billing/orders", "/internal/auth/me"):
            assert client.get(path, headers=headers).status_code == 401, path
    staff = staff_headers()
    for path in ("/auth/me", "/api/v1/policies", "/api/v1/events", "/api/v1/billing/status", "/api/v1/me/devices"):
        assert client.get(path, headers=staff).status_code == 401, path


# --- Permission matrix ------------------------------------------------------------------------

MATRIX = [
    ("get", "/internal/api/companies", None, "companies.read"),
    ("post", "/internal/api/companies/missing/suspend", {"reason": "test"}, "companies.suspend"),
    ("post", "/internal/api/companies/missing/licenses", {"plan_code": "trial", "reason": "test"}, "licenses.manage"),
    ("post", "/internal/api/licenses/missing/revoke", {"reason": "test"}, "licenses.manage"),
    ("post", "/internal/api/users/missing/suspend", None, "users.suspend"),
    ("get", "/internal/api/devices", None, "devices.read"),
    ("get", "/internal/api/plans", None, "plans.read"),
    ("patch", "/internal/api/plans/missing", {}, "plans.manage"),
    ("get", "/internal/api/releases", None, "releases.read"),
    ("post", "/internal/api/releases", {"version": "0.0.1", "make_current": False}, "releases.manage"),
    ("get", "/internal/api/billing/orders", None, "billing.read"),
    ("get", "/internal/api/billing/webhooks", None, "billing.read"),
    ("post", "/internal/api/billing/payments/missing/refund", {"reason": "test"}, "billing.refund"),
    ("post", "/internal/api/billing/reconcile", None, "billing.reconcile"),
    ("get", "/internal/api/audit", None, "audit.read"),
    ("get", "/internal/api/metrics", None, "metrics.read"),
    ("get", "/internal/api/analytics", None, "metrics.read"),
    ("post", "/internal/api/jobs/run-reminders", None, "jobs.run"),
    ("get", "/internal/api/staff", None, "staff.manage"),
    ("patch", "/internal/api/staff/missing", {}, "staff.manage"),
]


@pytest.mark.parametrize("role", STAFF_ROLES)
def test_permission_matrix(client, role):
    headers = staff_headers(role)
    for method, path, body, permission in MATRIX:
        kwargs = {"headers": headers}
        if body is not None:
            kwargs["json"] = body
        res = getattr(client, method)(path, **kwargs)
        if staff_has(role, permission):
            assert res.status_code != 403, f"{role} should be allowed {method.upper()} {path} ({permission})"
        else:
            assert res.status_code == 403, f"{role} must be refused {method.upper()} {path} ({permission})"


def test_every_permission_is_tested_and_owner_holds_all():
    assert {p for *_, p in MATRIX} | {"licenses.exception"} == set(STAFF_PERMISSIONS)
    assert all(staff_has("PLATFORM_OWNER", p) for p in STAFF_PERMISSIONS)
    assert not any(staff_has("READONLY_ANALYST", p) for p in STAFF_PERMISSIONS if p.split(".")[1] not in ("read",))


# --- Licence exceptions -----------------------------------------------------------------------

def test_paid_licence_without_payment_is_an_owner_only_audited_exception(client):
    org, _ = create_company()
    admin = staff_headers("PLATFORM_ADMIN")
    res = client.post(f"/internal/api/companies/{org}/licenses", headers=admin, json={"plan_code": "annual", "reason": "partner deal"})
    assert res.status_code == 403
    trial = client.post(f"/internal/api/companies/{org}/licenses", headers=admin, json={"plan_code": "trial", "reason": "pilot"})
    assert trial.status_code == 201
    # Extending paid time is an exception too
    owner = staff_headers("PLATFORM_OWNER")
    assert client.post(f"/internal/api/companies/{org}/licenses", headers=owner, json={"plan_code": "annual"}).status_code == 422
    paid = client.post(f"/internal/api/companies/{org}/licenses", headers=owner, json={"plan_code": "annual", "reason": "invoice 1042 paid by bank transfer"})
    assert paid.status_code == 201
    assert client.post(f"/internal/api/licenses/{paid.json()['id']}/extend", headers=admin,
                       json={"add_days": 30, "reason": "goodwill"}).status_code == 403
    db = SessionLocal()
    try:
        lic = db.query(License).filter(License.id == paid.json()["id"]).first()
        assert lic.payment_ref.startswith("exception:")
        row = db.query(AdminAuditLog).filter(AdminAuditLog.action == "platform.license_exception",
                                             AdminAuditLog.organization_id == org).first()
        assert row is not None and row.actor_type == "staff" and "invoice 1042" in row.summary
    finally:
        db.close()


# --- Staff management -------------------------------------------------------------------------

def test_owner_invites_staff_who_must_enrol_mfa(client, monkeypatch):
    sent = []
    monkeypatch.setattr("app.api.staff_admin.send_email", lambda to, s, b: sent.append(b) or "log")
    owner = staff_headers("PLATFORM_OWNER")
    email = f"agent-{uuid.uuid4().hex[:8]}@agentshield.test"
    res = client.post("/internal/api/staff/invite", headers=owner, json={"email": email, "role": "SUPPORT_AGENT"})
    assert res.status_code == 201 and res.json()["invite_pending"]
    assert client.post("/internal/api/staff/invite", headers=owner, json={"email": email, "role": "SUPPORT_AGENT"}).status_code == 409
    assert client.post("/internal/api/staff/invite", headers=owner, json={"email": "x@y.test", "role": "GOD"}).status_code == 400
    token = re.search(r"#staff-invite=(ast_[\w-]+)", sent[0]).group(1)
    assert client.get(f"/internal/auth/invite/{token}").json()["role"] == "SUPPORT_AGENT"
    assert client.post("/internal/auth/accept-invite", json={"token": token, "password": "short"}).status_code == 400
    step = client.post("/internal/auth/accept-invite", json={"token": token, "password": "Support-agent-password-1"})
    assert step.status_code == 200 and step.json()["step"] == "mfa_setup"
    assert client.post("/internal/auth/accept-invite", json={"token": token, "password": "Support-agent-password-1"}).status_code == 404
    # A support agent cannot manage staff or read billing
    _, _, session_token = _enrol(client, email, "Support-agent-password-1")
    assert client.get("/internal/api/staff", headers=_bearer(session_token)).status_code == 403
    assert client.get("/internal/api/billing/orders", headers=_bearer(session_token)).status_code == 403
    assert client.get("/internal/api/companies", headers=_bearer(session_token)).status_code == 200


def test_role_change_takes_effect_immediately_and_last_owner_is_protected(client, monkeypatch):
    owner = staff_headers("PLATFORM_OWNER")
    staff_id, _, _ = create_staff("PLATFORM_ADMIN")
    token = create_access_token(subject=staff_id, expires_delta=timedelta(hours=1), extra_claims={"typ": "staff", "sv": 0})
    assert client.get("/internal/api/audit", headers=_bearer(token)).status_code == 200
    res = client.patch(f"/internal/api/staff/{staff_id}", headers=owner, json={"role": "READONLY_ANALYST"})
    assert res.status_code == 200 and res.json()["role"] == "READONLY_ANALYST"
    assert client.get("/internal/api/audit", headers=_bearer(token)).status_code == 401  # old session ended

    owner_id, _, _ = create_staff("PLATFORM_OWNER")
    monkeypatch.setattr("app.api.staff_admin._active_owners", lambda db: 1)
    assert client.patch(f"/internal/api/staff/{owner_id}", headers=owner, json={"active": False}).status_code == 400
    assert client.patch(f"/internal/api/staff/{owner_id}", headers=owner, json={"role": "PLATFORM_ADMIN"}).status_code == 400


def test_mfa_reset_forces_new_enrolment(client):
    owner = staff_headers("PLATFORM_OWNER")
    staff_id, email, _ = create_staff("BILLING_ADMIN")
    assert client.post(f"/internal/api/staff/{staff_id}/reset-mfa", headers=owner).status_code == 200
    step = client.post("/internal/auth/login", json={"email": email, "password": STAFF_PASSWORD}).json()
    assert step["step"] == "mfa_setup"


# --- Cross-tenant protection of customer APIs ----------------------------------------------

def test_company_admin_cannot_touch_another_companys_objects(client):
    org_a, email_a = create_company(trial=True)
    org_b, email_b = create_company(trial=True)
    a = login(client, email_a)
    b = login(client, email_b)
    keys = DeviceKeys()
    device_b = activate(client, activation_token(client, b), keys).json()["device_id"]
    db = SessionLocal()
    try:
        user_b = db.query(User).filter(User.email == email_b).first().id
        policy_b = db.query(Policy).filter(Policy.organization_id == org_b).first().id
        domain_b = db.query(DomainRule).filter(DomainRule.organization_id == org_b).first().id
        keyword_b = db.query(RestrictedKeyword).filter(RestrictedKeyword.organization_id == org_b).first().id
    finally:
        db.close()
    attempts = [
        ("patch", f"/api/v1/org/users/{user_b}", {"active": False}),
        ("post", f"/api/v1/org/devices/{device_b}/revoke", None),
        ("post", f"/api/v1/org/devices/{device_b}/approve", None),
        ("patch", f"/api/v1/policies/{policy_b}", {"enabled": False}),
        ("delete", f"/api/v1/policies/{policy_b}", None),
        ("patch", f"/api/v1/domains/{domain_b}", {"enabled": False}),
        ("delete", f"/api/v1/domains/{domain_b}", None),
        ("delete", f"/api/v1/org/keywords/{keyword_b}", None),
    ]
    for method, path, body in attempts:
        kwargs = {"headers": a}
        if body is not None:
            kwargs["json"] = body
        res = getattr(client, method)(path, **kwargs)
        assert res.status_code in (403, 404), f"{method} {path} -> {res.status_code}"
    # B's data is untouched, and A's lists never include B's records
    db = SessionLocal()
    try:
        assert db.query(Device).filter(Device.id == device_b).first().status == "ACTIVE"
        assert db.query(User).filter(User.id == user_b).first().active
        assert db.query(Policy).filter(Policy.id == policy_b).first() is not None
    finally:
        db.close()
    assert all(u["email"] != email_b for u in client.get("/api/v1/org/users", headers=a).json()["users"])
    assert client.get("/api/v1/events?organization_id=" + org_b, headers=a).json()["total"] == 0
