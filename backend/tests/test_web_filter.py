"""Website-category blocking and Safe Search settings (dashboard -> server -> extension sync)."""
import json
import os
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.catalog import (
    WEB_CATEGORIES,
    WEB_CATEGORY_DEFAULTS,
    WEB_CATEGORY_GROUPS,
    WEB_CATEGORY_PRESETS,
    effective_safe_search,
    effective_web_categories,
)
from app.db.models import AdminAuditLog, UsageDaily
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import DeviceKeys, activate, activation_token, create_account, create_company, login, session

EXTENSION_CONFIG = Path(__file__).resolve().parents[2] / "extension" / "src" / "shared" / "web-categories.json"


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


def _account(client, account_type="INDIVIDUAL"):
    """An account with an activated browser. Returns (org_id, admin headers, device headers)."""
    org_id, email = create_company(trial=True, account_type=account_type)
    admin = login(client, email)
    keys = DeviceKeys()
    res = activate(client, activation_token(client, admin), keys)
    assert res.status_code == 201, res.text
    sess = session(client, res.json()["device_id"], keys)
    assert sess.status_code == 200, sess.text
    return org_id, admin, {"Authorization": f"Bearer {sess.json()['session_token']}"}


def test_category_ids_match_the_extension():
    ext = json.loads(EXTENSION_CONFIG.read_text(encoding="utf-8"))
    assert [c["id"] for c in ext["categories"]] == [c["id"] for c in WEB_CATEGORIES]
    assert {c["id"]: c["default"] for c in ext["categories"]} == WEB_CATEGORY_DEFAULTS


def test_effective_settings_ignore_bad_stored_values():
    assert effective_web_categories(None) == WEB_CATEGORY_DEFAULTS
    assert effective_web_categories("not json") == WEB_CATEGORY_DEFAULTS
    assert effective_web_categories('{"adult": "no", "astrology": true, "gambling": true}') == {**WEB_CATEGORY_DEFAULTS, "gambling": True}
    assert effective_safe_search(None, {"adult": True}) is True
    assert effective_safe_search(None, {"adult": False}) is False
    assert effective_safe_search(False, {"adult": True}) is False


def test_defaults_reach_dashboard_and_extension(client):
    _org, admin, device = _account(client)
    settings = client.get("/api/v1/org/settings", headers=admin).json()
    assert settings["web_categories"] == WEB_CATEGORY_DEFAULTS
    assert settings["safe_search"] is True  # follows adult blocking, which is on by default
    assert [c["id"] for c in settings["web_category_catalog"]] == [c["id"] for c in WEB_CATEGORIES]
    sync = client.get("/api/v1/policies", headers=device).json()["settings"]
    assert sync["web_categories"] == WEB_CATEGORY_DEFAULTS and sync["safe_search"] is True


def test_admin_changes_categories_with_audit_and_sync(client):
    org_id, admin, device = _account(client)
    res = client.patch("/api/v1/org/settings", headers=admin, json={"web_categories": {"gambling": True, "adult": False}})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["web_categories"]["gambling"] is True and body["web_categories"]["adult"] is False
    assert body["web_categories"]["malware"] is True  # categories not sent keep their value
    assert body["safe_search"] is False  # follows adult until set explicitly
    res = client.patch("/api/v1/org/settings", headers=admin, json={"safe_search": True})
    assert res.json()["safe_search"] is True and res.json()["web_categories"]["adult"] is False

    sync = client.get("/api/v1/policies", headers=device).json()["settings"]
    assert sync["web_categories"]["gambling"] is True and sync["safe_search"] is True

    db = SessionLocal()
    try:
        rows = db.query(AdminAuditLog).filter(AdminAuditLog.organization_id == org_id, AdminAuditLog.action == "settings.update").all()
        assert any("web_categories" in (r.summary or "") for r in rows)
        assert any("safe_search" in (r.summary or "") for r in rows)
    finally:
        db.close()


def test_every_category_has_a_group_and_every_preset_sets_every_category():
    group_ids = [g["id"] for g in WEB_CATEGORY_GROUPS]
    assert all(c["group"] in group_ids for c in WEB_CATEGORIES)
    assert all(any(c["group"] == g for c in WEB_CATEGORIES) for g in group_ids)
    ids = [c["id"] for c in WEB_CATEGORIES]
    assert len(ids) == len(set(ids))
    for preset in WEB_CATEGORY_PRESETS:
        assert sorted(preset["categories"]) == sorted(ids), preset["id"]
        assert all(isinstance(v, bool) for v in preset["categories"].values())
        assert preset["safe_search"] in (True, False, None)
    kids = next(p for p in WEB_CATEGORY_PRESETS if p["id"] == "kids")
    for cid in ("adult", "mature", "dating", "gambling", "drugs", "hate", "weapons", "chat", "malware"):
        assert kids["categories"][cid] is True, cid
    assert kids["safe_search"] is True
    assert not any(next(p for p in WEB_CATEGORY_PRESETS if p["id"] == "off")["categories"].values())


def test_presets_are_offered_and_apply_through_the_settings_api(client):
    _org, admin, device = _account(client)
    settings = client.get("/api/v1/org/settings", headers=admin).json()
    assert [g["id"] for g in settings["web_category_groups"]] == [g["id"] for g in WEB_CATEGORY_GROUPS]
    presets = {p["id"]: p for p in settings["web_category_presets"]}
    assert set(presets) == {"kids", "workplace", "security", "off"}
    revision = client.get("/api/v1/policies/revision", headers=device).json()["revision"]
    kids = presets["kids"]
    res = client.patch("/api/v1/org/settings", headers=admin, json={"web_categories": kids["categories"], "safe_search": True})
    assert res.status_code == 200, res.text
    sync = client.get("/api/v1/policies", headers=device).json()
    assert sync["settings"]["web_categories"] == kids["categories"] and sync["settings"]["safe_search"] is True
    assert sync["policy_revision"] > revision
    off = presets["off"]
    client.patch("/api/v1/org/settings", headers=admin, json={"web_categories": off["categories"], "safe_search": False})
    sync = client.get("/api/v1/policies", headers=device).json()["settings"]
    assert not any(sync["web_categories"].values()) and sync["safe_search"] is False


def test_unknown_category_is_rejected(client):
    _org, admin, _device = _account(client)
    res = client.patch("/api/v1/org/settings", headers=admin, json={"web_categories": {"astrology": True}})
    assert res.status_code == 400
    assert client.patch("/api/v1/org/settings", headers=admin, json={"web_categories": {"adult": "yes"}}).status_code == 422


def test_only_admins_change_categories(client):
    org_id, _admin, _device = _account(client, account_type="COMPANY")
    employee = login(client, create_account(org_id=org_id, role="EMPLOYEE"))
    assert client.patch("/api/v1/org/settings", headers=employee, json={"web_categories": {"adult": False}}).status_code == 403
    viewer = login(client, create_account(org_id=org_id, role="VIEWER"))
    assert client.patch("/api/v1/org/settings", headers=viewer, json={"web_categories": {"adult": False}}).status_code == 403


def test_settings_are_per_account(client):
    _org_a, admin_a, _ = _account(client)
    _org_b, admin_b, device_b = _account(client)
    client.patch("/api/v1/org/settings", headers=admin_a, json={"web_categories": {"social": True}})
    assert client.get("/api/v1/org/settings", headers=admin_b).json()["web_categories"]["social"] is False
    assert client.get("/api/v1/policies", headers=device_b).json()["settings"]["web_categories"]["social"] is False


def test_category_blocks_are_logged_but_not_metered(client):
    org_id, admin, device = _account(client)
    event = {"site": "adult website", "rule_id": "dlp.category.adult", "category": "WEB_FILTER", "severity": "MEDIUM",
             "action": "BLOCK", "outcome": "navigation_blocked", "prompt": "Adult content blocked (website category: adult).",
             "client_event_id": uuid.uuid4().hex}
    assert client.post("/api/v1/events", headers=device, json=event).status_code == 201
    db = SessionLocal()
    try:
        assert sum(r.prompt_checks for r in db.query(UsageDaily).filter(UsageDaily.organization_id == org_id).all()) == 0
    finally:
        db.close()
    events = client.get("/api/v1/events?limit=10", headers=admin).json()
    items = events["items"] if isinstance(events, dict) else events
    assert any(e["rule_id"] == "dlp.category.adult" for e in items)
