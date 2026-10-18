"""AgentShield Windows app (2.4): connect a PC once, then every browser on it connects through the app.

A PC proves possession of its own key (like a browser) to get single-use activation codes for its
browsers. The PC uses one device slot of the plan; removing it signs out all its browsers.
"""
import pytest
from fastapi.testclient import TestClient

from app.core import ratelimit
from app.db.models import Computer, Device
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import DeviceKeys, activate, activation_token, create_company, login, session

client: TestClient = None  # set by the module fixture below


@pytest.fixture(scope="module", autouse=True)
def _client():
    global client
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        client = c
        yield c


@pytest.fixture(autouse=True)
def _limits():
    ratelimit.reset()
    yield


def _individual(trial: bool = False):
    """A free-plan individual (1 device slot) unless trial (3 slots). Returns (org_id, headers)."""
    ratelimit.reset()
    org_id, email = create_company(account_type="INDIVIDUAL", trial=trial)
    return org_id, login(client, email)


def _connect_pc(headers, keys=None, name="DESKTOP-TEST"):
    keys = keys or DeviceKeys()
    token = activation_token(client, headers)
    res = client.post("/api/v1/computer/activate", json={
        "activation_token": token, "public_key": keys.public_b64, "name": name, "platform": "Windows 11",
    })
    return res, keys


def _signed(path, computer_id, keys, **extra):
    nonce = client.post("/api/v1/computer/challenge", json={"computer_id": computer_id})
    if nonce.status_code != 200:
        return nonce
    n = nonce.json()["nonce"]
    return client.post(path, json={"computer_id": computer_id, "nonce": n, "signature": keys.sign(n), **extra})


def _browser(computer_id, pc_keys, name="Chrome 130"):
    """What the extension does through the app: get a code from the PC, then activate as usual."""
    code = _signed("/api/v1/computer/browser-code", computer_id, pc_keys, browser=name)
    assert code.status_code == 201, code.text
    keys = DeviceKeys()
    res = activate(client, code.json()["token"], keys)
    return res, keys


def test_pc_connects_all_browsers_with_one_slot():
    org_id, headers = _individual()  # Free plan: 1 device slot
    res, pc_keys = _connect_pc(headers)
    assert res.status_code == 201, res.text
    pc = res.json()["computer_id"]

    device_ids = []
    for name in ("Chrome 130", "Edge 130", "Brave 1.70"):
        dev, keys = _browser(pc, pc_keys, name)
        assert dev.status_code == 201, dev.text
        sess = session(client, dev.json()["device_id"], keys)
        assert sess.status_code == 200, sess.text
        device_ids.append(dev.json()["device_id"])

    # All three browsers share the PC's single slot
    status = client.get("/api/v1/billing/status", headers=headers).json()
    assert status["entitlement"]["devices_used"] == 1
    db = SessionLocal()
    try:
        assert {d.computer_id for d in db.query(Device).filter(Device.id.in_(device_ids))} == {pc}
    finally:
        db.close()

    # The portal lists the PC with its browsers
    pcs = client.get("/api/v1/me/computers", headers=headers).json()
    assert len(pcs) == 1 and pcs[0]["name"] == "DESKTOP-TEST" and len(pcs[0]["browsers"]) == 3

    # A browser connected on its own needs another slot, which the Free plan does not have
    token = activation_token(client, headers)
    alone = activate(client, token, DeviceKeys())
    assert alone.status_code == 409 and alone.json()["detail"]["code"] == "DEVICE_LIMIT"


def test_removing_the_pc_signs_out_its_browsers():
    _org, headers = _individual()
    res, pc_keys = _connect_pc(headers)
    pc = res.json()["computer_id"]
    dev, keys = _browser(pc, pc_keys)
    device_id = dev.json()["device_id"]
    sess = session(client, device_id, keys).json()
    device_headers = {"Authorization": f"Bearer {sess['session_token']}"}
    assert client.get("/api/v1/policies", headers=device_headers).status_code == 200

    removed = client.post(f"/api/v1/me/computers/{pc}/revoke", headers=headers)
    assert removed.status_code == 200 and removed.json()["status"] == "REVOKED"
    # The live session stops working, no new session, no new codes, and the slot is free again
    assert client.get("/api/v1/policies", headers=device_headers).status_code in (401, 403)
    again = session(client, device_id, keys)
    assert again.status_code == 403 and again.json()["detail"]["code"] == "REVOKED"
    assert _signed("/api/v1/computer/browser-code", pc, pc_keys).json()["detail"]["code"] == "REVOKED"
    assert client.get("/api/v1/billing/status", headers=headers).json()["entitlement"]["devices_used"] == 0
    assert client.get("/api/v1/me/computers", headers=headers).json() == []


def test_signing_out_one_pc_browser_removes_the_pc():
    """A single browser of a PC would reconnect through the app at once, so the whole PC is removed."""
    _org, headers = _individual()
    res, pc_keys = _connect_pc(headers)
    pc = res.json()["computer_id"]
    dev, _ = _browser(pc, pc_keys)
    out = client.post(f"/api/v1/me/devices/{dev.json()['device_id']}/revoke", headers=headers)
    assert out.status_code == 200
    assert out.json()["computer_id"] == pc
    db = SessionLocal()
    try:
        assert db.query(Computer).filter(Computer.id == pc).first().status == "REVOKED"
    finally:
        db.close()


def test_app_disconnect_and_status():
    _org, headers = _individual()
    res, pc_keys = _connect_pc(headers)
    pc = res.json()["computer_id"]
    st = _signed("/api/v1/computer/status", pc, pc_keys)
    assert st.status_code == 200 and st.json()["status"] == "ACTIVE" and st.json()["browsers"] == 0
    assert _signed("/api/v1/computer/deactivate", pc, pc_keys).status_code == 204
    assert _signed("/api/v1/computer/status", pc, pc_keys).json()["detail"]["code"] == "REVOKED"


def test_pc_signature_and_replay_are_refused():
    _org, headers = _individual()
    res, pc_keys = _connect_pc(headers)
    pc = res.json()["computer_id"]
    nonce = client.post("/api/v1/computer/challenge", json={"computer_id": pc}).json()["nonce"]
    # Another key cannot get codes for this PC
    bad = client.post("/api/v1/computer/browser-code", json={"computer_id": pc, "nonce": nonce, "signature": DeviceKeys().sign(nonce)})
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "INVALID_SIGNATURE"
    ok = client.post("/api/v1/computer/browser-code", json={"computer_id": pc, "nonce": nonce, "signature": pc_keys.sign(nonce)})
    # The rejected attempt did not burn the nonce; the valid one works once
    assert ok.status_code == 201
    replay = client.post("/api/v1/computer/browser-code", json={"computer_id": pc, "nonce": nonce, "signature": pc_keys.sign(nonce)})
    assert replay.status_code == 401
    # A browser's device challenge cannot be used as a PC challenge
    dev, keys = _browser(pc, pc_keys)
    device_nonce = client.post("/api/v1/device/challenge", json={"device_id": dev.json()["device_id"]}).json()["nonce"]
    mixed = client.post("/api/v1/computer/browser-code", json={"computer_id": pc, "nonce": device_nonce, "signature": pc_keys.sign(device_nonce)})
    assert mixed.status_code == 401


def test_codes_are_single_use_and_not_interchangeable():
    _org, headers = _individual(trial=True)
    res, pc_keys = _connect_pc(headers)
    pc = res.json()["computer_id"]
    # The portal code was consumed by the PC
    db = SessionLocal()
    try:
        assert db.query(Computer).filter(Computer.id == pc).first().activation_token_id
    finally:
        db.close()
    # A browser code works once
    code = _signed("/api/v1/computer/browser-code", pc, pc_keys).json()["token"]
    assert activate(client, code, DeviceKeys()).status_code == 201
    assert activate(client, code, DeviceKeys()).status_code == 400
    # A browser code cannot connect another PC
    code2 = _signed("/api/v1/computer/browser-code", pc, pc_keys).json()["token"]
    other = client.post("/api/v1/computer/activate", json={"activation_token": code2, "public_key": DeviceKeys().public_b64})
    assert other.status_code == 400 and other.json()["detail"]["code"] == "INVALID_TOKEN"
    # Only the newest browser code of a PC is valid
    code3 = _signed("/api/v1/computer/browser-code", pc, pc_keys).json()["token"]
    assert activate(client, code2, DeviceKeys()).status_code == 400
    assert activate(client, code3, DeviceKeys()).status_code == 201


def test_pc_needs_a_free_slot_and_an_active_plan():
    _org, headers = _individual()  # Free plan, 1 slot
    first, _ = _connect_pc(headers, name="PC-1")
    assert first.status_code == 201
    second, _ = _connect_pc(headers, name="PC-2")
    assert second.status_code == 409 and second.json()["detail"]["code"] == "DEVICE_LIMIT"

    # No plan at all (unconfirmed individual without licence): no PC connection
    ratelimit.reset()
    _org2, email = create_company(account_type="INDIVIDUAL")
    db = SessionLocal()
    try:
        from app.db.models import User
        u = db.query(User).filter(User.email == email).first()
        u.email_verified_at = None
        db.commit()
    finally:
        db.close()
    res = client.post("/api/v1/me/activation-tokens", headers=login(client, email))
    assert res.status_code == 403


def test_pc_browser_limit_replaces_the_oldest(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "MAX_BROWSERS_PER_COMPUTER", 2)
    _org, headers = _individual()
    res, pc_keys = _connect_pc(headers)
    pc = res.json()["computer_id"]
    ids = [_browser(pc, pc_keys, f"Browser {i}")[0].json()["device_id"] for i in range(3)]
    db = SessionLocal()
    try:
        statuses = {d.id: d.status for d in db.query(Device).filter(Device.id.in_(ids))}
    finally:
        db.close()
    assert statuses[ids[0]] == "REVOKED" and statuses[ids[1]] == "ACTIVE" and statuses[ids[2]] == "ACTIVE"


def test_pcs_are_private_to_their_account():
    _org, headers = _individual()
    res, _ = _connect_pc(headers)
    pc = res.json()["computer_id"]
    _org2, other = _individual()
    assert client.get("/api/v1/me/computers", headers=other).json() == []
    assert client.post(f"/api/v1/me/computers/{pc}/revoke", headers=other).status_code == 404
