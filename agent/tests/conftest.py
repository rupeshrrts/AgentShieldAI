"""Agent tests. They run the real backend in-process (FastAPI TestClient) so the agent is proven
wire-compatible with the live API, not a mock of it.

DATABASE_URL points at a throwaway SQLite file (AGENTS.md rule 1); the data dir is a temp folder.
"""
import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
for p in (ROOT / "agent", BACKEND, BACKEND / "tests"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

# Same throwaway test environment the backend suite uses (see backend/tests/conftest.py).
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(Path(tempfile.gettempdir()) / f'agent_test_{uuid.uuid4().hex}.db').as_posix()}")
os.environ.setdefault("SECRET_KEY", "test-only-signing-key-" + "0" * 32)
os.environ.setdefault("INITIAL_ADMIN_EMAIL", "admin@agentshield.local")
os.environ.setdefault("INITIAL_ADMIN_PASSWORD", "Test-Only-Admin-Pass-0001")
os.environ.setdefault("REMINDER_LOOP_ENABLED", "false")
os.environ.setdefault("EMAIL_VERIFICATION_REQUIRED", "true")
os.environ.setdefault("SIGNUP_CHECK_EMAIL_DOMAIN", "false")


@pytest.fixture(scope="session")
def backend_client():
    from app.db.seed import init_db
    from app.db.session import Base, SessionLocal, engine
    from app.main import app
    from fastapi.testclient import TestClient

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_limits():
    from app.core import ratelimit
    ratelimit.reset()
    yield


@pytest.fixture()
def agent_dir(tmp_path, monkeypatch):
    d = tmp_path / "agentdir"
    monkeypatch.setenv("AGENTSHIELD_AGENT_DIR", str(d))
    return d


@pytest.fixture()
def transport(backend_client):
    """A client.Transport that routes the agent's HTTP calls into the in-process backend."""
    base = "http://testserver"

    def _t(method, url, body, headers):
        assert url.startswith(base), url
        res = backend_client.request(method, url[len(base):], json=body, headers=headers)
        try:
            return res.status_code, res.json()
        except ValueError:
            return res.status_code, None

    return _t


@pytest.fixture()
def trial_code(backend_client, transport):
    """Creates a fresh individual account on a trial and returns an ASA1 connect code for it."""
    from helpers import create_company
    from app.core import ratelimit

    ratelimit.reset()
    org_id, email = create_company(account_type="INDIVIDUAL", trial=True)
    login = backend_client.post("/auth/login", json={"email": email, "password": "Employee-Pass-2026!"})
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    tok = backend_client.post("/api/v1/me/activation-tokens", headers=headers)
    assert tok.status_code == 201, tok.text
    import base64
    import json
    code = "ASA1." + base64.urlsafe_b64encode(json.dumps({"u": "http://testserver", "t": tok.json()["token"]}).encode()).decode().rstrip("=")
    return code, email, org_id
