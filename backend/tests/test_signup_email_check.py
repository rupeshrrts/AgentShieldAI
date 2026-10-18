"""Sign-up accepts only real email addresses: valid format and a domain that can receive email.

DNS is replaced by a fake resolver, so the tests do not depend on the network.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.core import abuse, ratelimit
from app.core.config import settings
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app

REAL = {"gmail.com", "outlook.com", "yahoo.co.uk", "motwane.com", "gmial.com"}


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _check_on(monkeypatch):
    ratelimit.reset()
    monkeypatch.setattr(settings, "SIGNUP_CHECK_EMAIL_DOMAIN", True)
    monkeypatch.setattr(abuse, "domain_receives_email", lambda domain: domain in REAL)
    yield


def _signup(client, email):
    return client.post("/auth/signup", json={"email": email, "password": "Correct-Horse-Battery-9", "account_type": "INDIVIDUAL"})


@pytest.mark.parametrize("email, hint", [
    ("person@gmail.comrre", "did you mean person@gmail.com"),
    ("person@gmial.com", "did you mean person@gmail.com"),       # exists in DNS, but a known typo
    ("person@gmall.com", "did you mean person@gmail.com"),       # cannot receive email, close to gmail.com
    ("person@no-such-domain-zq81.com", "does not exist or cannot receive email"),
    ("person@@gmail.com", "valid email address"),
])
def test_wrong_addresses_are_refused(client, email, hint):
    res = _signup(client, email)
    assert res.status_code in (400, 422), res.text
    if res.status_code == 400:
        assert res.json()["detail"]["code"] == "EMAIL_INVALID" and hint in res.json()["detail"]["message"]


def test_real_addresses_are_accepted(client):
    for domain in ("gmail.com", "outlook.com", "yahoo.co.uk", "motwane.com"):
        res = _signup(client, f"user-{uuid.uuid4().hex[:8]}@{domain}")
        assert res.status_code == 201, (domain, res.text)


def test_dns_trouble_never_blocks_sign_up(monkeypatch):
    import dns.resolver

    def boom(*_a, **_k):
        raise dns.resolver.NoNameservers()

    monkeypatch.undo()
    monkeypatch.setattr(dns.resolver.Resolver, "resolve", boom)
    abuse._DNS_CACHE.clear()
    assert abuse.domain_receives_email("some-company.example") is True


def test_check_can_be_switched_off(client, monkeypatch):
    monkeypatch.setattr(settings, "SIGNUP_CHECK_EMAIL_DOMAIN", False)
    assert _signup(client, f"user-{uuid.uuid4().hex[:8]}@no-such-domain-zq81.com").status_code == 201
