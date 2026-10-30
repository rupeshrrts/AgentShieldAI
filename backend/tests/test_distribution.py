"""Tests for the extension distribution endpoints used by the system installer and browser policies."""
import json
import xml.etree.ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import create_company, login

EXT_ID = "ahdfdohnhdlppjhnppbhecggfjceaalc"


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture
def package(tmp_path, monkeypatch):
    (tmp_path / "agentshield.crx").write_bytes(b"Cr24\x03\x00\x00\x00fake")
    (tmp_path / "release.json").write_text(json.dumps({"id": EXT_ID, "version": "1.2.1", "built_at": "2026-10-15T00:00:00Z"}))
    monkeypatch.setattr(settings, "EXTENSION_PACKAGE_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "PUBLIC_BASE_URL", "https://agentshield.example.com")
    monkeypatch.setattr(settings, "CHROME_STORE_EXTENSION_ID", "")
    monkeypatch.setattr(settings, "EDGE_STORE_EXTENSION_ID", "")
    return tmp_path


def test_info_self_hosted(client, package):
    info = client.get("/extension-updates/info").json()
    assert info["version"] == "1.2.1"
    assert info["chrome"] == {"id": EXT_ID, "update_url": "https://agentshield.example.com/extension-updates/updates.xml", "source": "self_hosted"}
    assert info["edge"]["id"] == EXT_ID
    assert info["requires_managed_device"] is True


def test_info_prefers_store_ids(client, package, monkeypatch):
    monkeypatch.setattr(settings, "CHROME_STORE_EXTENSION_ID", "a" * 32)
    monkeypatch.setattr(settings, "EDGE_STORE_EXTENSION_ID", "b" * 32)
    info = client.get("/extension-updates/info").json()
    assert info["chrome"]["source"] == "chrome_web_store"
    assert info["chrome"]["update_url"] == "https://clients2.google.com/service/update2/crx"
    assert info["edge"]["source"] == "edge_add_ons"
    assert info["requires_managed_device"] is False


def test_update_manifest_is_valid_gupdate(client, package):
    res = client.get("/extension-updates/updates.xml")
    assert res.status_code == 200
    root = ET.fromstring(res.text)
    ns = {"g": "http://www.google.com/update2/response"}
    app_el = root.find("g:app", ns)
    assert app_el.get("appid") == EXT_ID
    check = app_el.find("g:updatecheck", ns)
    assert check.get("version") == "1.2.1"
    assert check.get("codebase") == "https://agentshield.example.com/extension-updates/agentshield-1.2.1.crx"


def test_crx_download(client, package):
    res = client.get("/extension-updates/agentshield-1.2.1.crx")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/x-chrome-extension"
    assert res.content.startswith(b"Cr24")
    assert client.get("/extension-updates/agentshield-0.0.1.crx").status_code == 404


def _link(client, headers, file):
    return client.post("/api/v1/me/download-link", headers=headers, json={"file": file})


def _path(url):
    return url.replace("https://agentshield.example.com", "")


def test_downloads_need_a_link_from_an_account_with_a_plan(client, package, tmp_path, monkeypatch):
    agent_exe = tmp_path / "AgentShield-Agent.exe"
    monkeypatch.setattr(settings, "AGENT_PACKAGE_PATH", str(agent_exe))
    _, email = create_company(trial=True)
    user = login(client, email)
    info = client.get("/extension-updates/info").json()
    assert info["downloads"] == {"extension_zip": False, "network_agent": False}
    link = _link(client, user, "agentshield-extension.zip")
    assert link.status_code == 200 and link.json()["expires_in"] == 300
    assert client.get(_path(link.json()["url"])).status_code == 404  # package not built yet

    (package / "agentshield-extension.zip").write_bytes(b"PK\x03\x04fake")
    # No link, a forged link, or a link for the other file: refused
    for path in ("/extension-updates/download/agentshield-extension.zip",
                 "/extension-updates/download/agentshield-extension.zip?t=not-a-token"):
        res = client.get(path)
        assert res.status_code == 401 and res.json()["detail"]["code"] == "DOWNLOAD_LINK_REQUIRED", path
    zip_url = _path(_link(client, user, "agentshield-extension.zip").json()["url"])
    assert client.get(zip_url.replace("agentshield-extension.zip", "AgentShield-Agent.exe")).status_code == 401
    # A customer session token is not a download link
    assert client.get("/extension-updates/download/agentshield-extension.zip?t=" + user["Authorization"].split()[1]).status_code == 401

    z = client.get(zip_url)
    assert z.status_code == 200 and z.content.startswith(b"PK")
    assert "agentshield-extension-1.2.1.zip" in z.headers["content-disposition"]
    # The retired Windows setup (2.6) is no longer offered or served
    assert _link(client, user, "AgentShield-System-Setup.exe").status_code == 422
    assert client.get("/extension-updates/download/AgentShield-System-Setup.exe").status_code == 404

    # Network Agent installer: needs a link, and is served once built
    assert client.get("/extension-updates/download/AgentShield-Agent.exe").status_code == 401
    agent_exe.write_bytes(b"MZfake-agent-exe")
    assert client.get("/extension-updates/info").json()["downloads"]["network_agent"] is True
    ag = client.get(_path(_link(client, user, "AgentShield-Agent.exe").json()["url"]))
    assert ag.status_code == 200 and ag.content.startswith(b"MZ")
    assert "AgentShield-Agent.exe" in ag.headers["content-disposition"]


def test_no_download_link_without_a_plan(client, package):
    (package / "agentshield-extension.zip").write_bytes(b"PK\x03\x04fake")
    _, email = create_company(trial=False)  # a company without a trial, plan or credits
    user = login(client, email)
    res = _link(client, user, "agentshield-extension.zip")
    assert res.status_code == 403 and res.json()["detail"]["code"] == "NO_LICENSE"
    assert client.post("/api/v1/me/download-link", json={"file": "agentshield-extension.zip"}).status_code == 401
    assert _link(client, user, "../../etc/passwd").status_code == 422


def test_missing_package_is_explained(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "EXTENSION_PACKAGE_DIR", str(tmp_path / "nothing-here"))
    res = client.get("/extension-updates/info")
    assert res.status_code == 404
    assert "pack-extension" in res.json()["detail"]
