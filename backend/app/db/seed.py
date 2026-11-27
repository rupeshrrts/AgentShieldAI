"""Database Seeding and Schema Alignment.

Populates initial baseline data when starting with a fresh database:
- Demo tenant: Acme Corp (org-acme-corp-001)
- Initial administrative accounts (admin & auditor)
- Core DLP policies (blocking secrets, warning on emails/phones, redacting codewords)
- Standard domain traffic control rules (blocking file converters, allowing approved AI tools)
"""

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.catalog import RULE_CATALOG
from app.core.config import settings
from app.core.security import hash_password
from app.db.models import (
    DomainRule,
    ExtensionRelease,
    License,
    Organization,
    OrganizationSettings,
    Plan,
    Policy,
    RestrictedKeyword,
    User,
    utc_now,
)
from app.detection.detector import DetectorEngine


def ensure_catalog_policies(db: Session, organization_id: str, existing: set | None = None) -> int:
    """Adds a policy for every catalog rule the organization does not have yet. Returns how many were added.
    `existing` (the organization's rule IDs) may be passed in to save a query."""
    if existing is None:
        existing = {
            r[0] for r in db.query(Policy.rule_id).filter(Policy.organization_id == organization_id).all()
        }
    added = 0
    for rule in RULE_CATALOG:
        if rule["rule_id"] in existing:
            continue
        db.add(Policy(
            organization_id=organization_id,
            name=rule["name"],
            rule_id=rule["rule_id"],
            category=rule["category"],
            site_scope="*",
            action=rule["default_action"],
            severity=rule["default_severity"],
            enabled=True,
            version=1,
            updated_by="system",
        ))
        added += 1
    if added:
        db.flush()
    return added


DEFAULT_DOMAINS = [
    ("ilovepdf.com", "BLOCK", "File Converter / Data Exfiltration", "Public online PDF converter. High data exfiltration risk."),
    ("smallpdf.com", "BLOCK", "File Converter / Data Exfiltration", "Third-party document processing cloud."),
    ("pastebin.com", "BLOCK", "Public Code / Text Paste Site", "Public paste service. Potential source code leak target."),
    ("pdf2go.com", "BLOCK", "File Converter / Data Exfiltration", "Unauthorized online document manipulation service."),
    ("wetransfer.com", "BLOCK", "Unsanctioned Cloud Transfer", "Consumer file sharing platform."),
    ("chatgpt.com", "ALLOW", "Sanctioned GenAI Tool", "Corporate approved OpenAI ChatGPT subscription workspace."),
    ("chat.openai.com", "ALLOW", "Sanctioned GenAI Tool", "Corporate approved OpenAI interface."),
    ("claude.ai", "ALLOW", "Sanctioned GenAI Tool", "Approved Anthropic Claude AI workspace."),
    ("gemini.google.com", "ALLOW", "Sanctioned GenAI Tool", "Approved Google Gemini Workspace suite."),
    ("copilot.microsoft.com", "ALLOW", "Sanctioned GenAI Tool", "Approved Microsoft Copilot Enterprise suite."),
]

# Plans offered by the platform. Prices are deliberately unset: the platform admin sets them
# (Plans & pricing) before anything can be sold. Durations and device limits are editable too.
DEFAULT_PLANS = [
    # Free forever (individual accounts with a confirmed email): computed in core/entitlements.py, never a
    # licence and never sold. Staff edit its monthly prompt checks and browser limit in Plans & pricing.
    {"code": "free", "name": "Free", "kind": "FREE", "device_limit": 1, "check_limit": 300, "sort": -1,
     "features": ["300 prompt checks every month", "1 browser", "Website controls and category blocking"]},
    {"code": "trial", "name": "Free trial", "kind": "TRIAL", "duration_days": 30, "device_limit": 3, "sort": 0,
     "features": ["All protection features", "30 days, once per account", "Up to 3 browsers"]},
    {"code": "monthly", "name": "Monthly", "kind": "PAID", "duration_months": 1, "device_limit": 3, "billing": "recurring", "sort": 1,
     "features": ["All protection features", "Renews every month", "Cancel any time"]},
    {"code": "six_month", "name": "6 months", "kind": "PAID", "duration_months": 6, "device_limit": 3, "sort": 2,
     "features": ["All protection features", "One payment for 6 months", "Renewal reminder before expiry"]},
    {"code": "annual", "name": "Annual", "kind": "PAID", "duration_months": 12, "device_limit": 3, "sort": 3,
     "features": ["All protection features", "One payment for 12 months", "Renewal reminder before expiry"]},
    {"code": "internal", "name": "Internal (not for sale)", "kind": "INTERNAL", "device_limit": 10000, "sort": 9,
     "features": ["Platform operator's own company"]},
    # Pay as you go: prepaid credit pack (1 credit = 1 prompt check). Price and size are set in the internal console.
    {"code": "credits_1000", "name": "1,000 prompt checks", "kind": "CREDITS", "credits": 1000, "device_limit": 3, "sort": 5,
     "features": ["Pay only for what you use", "Credits never expire", "Up to 3 browsers"]},
]


def ensure_plans(db: Session) -> None:
    import json

    # Seeded text that was wrong for individual accounts (one trial per person); replaced only while unedited
    outdated = {"trial": ["All protection features", "30 days, once per company", "Up to 3 browsers"]}
    for p in DEFAULT_PLANS:
        existing = db.query(Plan).filter(Plan.code == p["code"]).first()
        if existing:
            try:
                current = json.loads(existing.features or "[]")
            except ValueError:
                current = None
            if outdated.get(p["code"]) == current:
                existing.features = json.dumps(p["features"])
            continue
        days = settings.TRIAL_DAYS if p["code"] == "trial" else p.get("duration_days")
        db.add(Plan(
            code=p["code"], name=p["name"], kind=p["kind"],
            duration_days=days, duration_months=p.get("duration_months"),
            device_limit=p["device_limit"], billing=p.get("billing", "one_time"), credits=p.get("credits"),
            check_limit=p.get("check_limit"),
            features=json.dumps(p["features"]), purchasable=False, active=True, sort=p["sort"], updated_by="system",
        ))
    db.flush()


def provision_organization(db: Session, org: Organization) -> None:
    """Default settings, rules, keywords and website controls for a new company (also used by self sign-up)."""
    ensure_catalog_policies(db, org.id)
    if db.query(OrganizationSettings).filter(OrganizationSettings.organization_id == org.id).first() is None:
        db.add(OrganizationSettings(organization_id=org.id, updated_by="system"))
    if db.query(RestrictedKeyword).filter(RestrictedKeyword.organization_id == org.id).count() == 0:
        db.add_all(
            RestrictedKeyword(organization_id=org.id, keyword=kw, created_by="system")
            for kw in DetectorEngine.DEFAULT_RESTRICTED_KEYWORDS
        )
    existing = {d[0] for d in db.query(DomainRule.domain).filter(DomainRule.organization_id == org.id).all()}
    for dom_name, act, cat, desc in DEFAULT_DOMAINS:
        if dom_name not in existing:
            db.add(DomainRule(organization_id=org.id, domain=dom_name, action=act, category=cat, description=desc, enabled=True))
    db.flush()


def _ensure_internal_licence(db: Session, org: Organization) -> None:
    """The initial company (the operator's own) has a non-expiring internal licence."""
    has_licence = db.query(License).filter(License.organization_id == org.id, License.status == "ACTIVE").first()
    if not has_licence:
        db.add(License(
            organization_id=org.id, plan_code="internal", kind="INTERNAL", status="ACTIVE",
            expires_at=None, device_limit=10000, created_by="system",
        ))
    db.flush()


def init_db(db: Session):
    """Schema alignment, plans, releases, catalog policies; optionally the initial company and its admin.

    No credentials are built in: the initial company admin is created only when INITIAL_ADMIN_EMAIL and
    INITIAL_ADMIN_PASSWORD are both set, and internal staff only with `python -m app.cli`.
    """
    # Add columns introduced after the first release before any model query touches them
    _align_schema(db)

    # Platform administration moved to staff accounts: former SUPERADMIN users stay admins of their company
    db.query(User).filter(User.role == "SUPERADMIN").update({"role": "ADMIN"}, synchronize_session=False)

    admin_email = settings.INITIAL_ADMIN_EMAIL
    admin_user = db.query(User).filter(User.email == admin_email).first() if admin_email else None

    initial_org = None
    if admin_user:
        initial_org = db.query(Organization).filter(Organization.id == admin_user.organization_id).first()
    elif admin_email and settings.INITIAL_ADMIN_PASSWORD:
        initial_org = db.query(Organization).filter(Organization.name == settings.INITIAL_ORG_NAME).first()
        if not initial_org:
            org_kwargs = {"name": settings.INITIAL_ORG_NAME, "retention_days": 30}
            if settings.INITIAL_ORG_NAME == "Acme Corp":
                org_kwargs["id"] = "org-acme-corp-001"
            initial_org = Organization(**org_kwargs)
            db.add(initial_org)
            db.flush()
        id_kwargs = {} if db.query(User).filter(User.id == "usr-admin-001").first() else {"id": "usr-admin-001"}
        admin_user = User(
            **id_kwargs,
            organization_id=initial_org.id,
            email=admin_email,
            password_hash=hash_password(settings.INITIAL_ADMIN_PASSWORD),
            role="ADMIN",
            active=True,
            email_verified_at=utc_now(),
        )
        db.add(admin_user)

    # Optional read-only demo account (development only; password from DEMO_AUDITOR_PASSWORD)
    viewer_user = db.query(User).filter(User.email == "auditor@agentshield.local").first()
    if settings.is_production:
        if viewer_user and viewer_user.active:
            viewer_user.active = False
    elif not viewer_user and initial_org is not None and settings.DEMO_AUDITOR_PASSWORD:
        db.add(User(
            id="usr-viewer-001",
            organization_id=initial_org.id,
            email="auditor@agentshield.local",
            password_hash=hash_password(settings.DEMO_AUDITOR_PASSWORD),
            role="VIEWER",
            active=True,
            email_verified_at=utc_now(),
        ))

    # Every organization has exactly one policy per catalog rule (new rules are added
    # with their recommended action). Admins enable/disable or change them; they are not deleted.
    # One query for all organizations' rules (not one per organization: startup time must not grow with sign-ups)
    rules_by_org: dict = {}
    for org_id, rule_id in db.query(Policy.organization_id, Policy.rule_id).all():
        rules_by_org.setdefault(org_id, set()).add(rule_id)
    for (org_id,) in db.query(Organization.id).all():
        ensure_catalog_policies(db, org_id, rules_by_org.get(org_id, set()))

    ensure_plans(db)
    db.flush()
    _register_current_release(db)

    if initial_org is not None:
        _ensure_internal_licence(db, initial_org)
        # Keywords and domains are seeded only on first setup (marked by the settings row),
        # so anything an admin deletes in the dashboard is not re-added on the next restart.
        if db.query(OrganizationSettings).filter(OrganizationSettings.organization_id == initial_org.id).first() is None:
            provision_organization(db, initial_org)
    db.commit()


def _register_current_release(db: Session) -> None:
    """Adds the packaged extension version (release.json from pack-extension.js) to the release list once."""
    import json
    from pathlib import Path

    path = Path(settings.EXTENSION_PACKAGE_DIR) / "release.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    except Exception:
        data = None
    if not data or not data.get("version"):
        return
    if db.query(ExtensionRelease).filter(ExtensionRelease.version == data["version"]).first():
        return
    has_current = db.query(ExtensionRelease).filter(ExtensionRelease.is_current == True).first()
    db.add(ExtensionRelease(
        version=data["version"], sha256=data.get("zip_sha256") or data.get("sha256"), size_bytes=data.get("zip_size"),
        notes=data.get("notes"), is_current=not has_current, published_by="system",
    ))
    db.flush()


def _align_schema(db: Session):
    """Schema alignment helper for existing database files (adds newly added audit columns if missing)."""
    audit_columns = [
        ("department", "VARCHAR(100) DEFAULT 'Engineering'"),
        ("application", "VARCHAR(100) DEFAULT 'ChatGPT'"),
        ("prompt", "TEXT"),
        ("prompt_preview", "TEXT"),
        ("dlp_engine", "VARCHAR(100) DEFAULT '-'"),
        ("location", "VARCHAR(100) DEFAULT 'Bangalore'"),
    ]

    alterations = [("security_events", name, col_type) for name, col_type in audit_columns] + [
        ("security_events", "justification", "TEXT"),
        ("organization_settings", "block_unapproved_ai", "BOOLEAN DEFAULT FALSE"),
        ("organization_settings", "require_device_approval", "BOOLEAN DEFAULT FALSE"),
        ("users", "email_verified_at", "TIMESTAMP WITH TIME ZONE"),
        ("users", "session_version", "INTEGER DEFAULT 0 NOT NULL"),
        ("organizations", "suspended_at", "TIMESTAMP WITH TIME ZONE"),
        ("organizations", "suspended_reason", "VARCHAR(255)"),
        ("email_verifications", "purpose", "VARCHAR(10) DEFAULT 'verify' NOT NULL"),
        ("plans", "razorpay_plan_id", "VARCHAR(60)"),
        ("plans", "razorpay_plan_amount", "INTEGER"),
        ("admin_audit_log", "actor_type", "VARCHAR(10) DEFAULT 'customer'"),
        ("organizations", "account_type", "VARCHAR(12) DEFAULT 'COMPANY' NOT NULL"),
        ("organizations", "credit_balance", "INTEGER DEFAULT 0 NOT NULL"),
        ("organizations", "monthly_check_cap", "INTEGER"),
        ("users", "display_name", "VARCHAR(120)"),
        ("security_events", "client_event_id", "VARCHAR(64)"),
        ("plans", "credits", "INTEGER"),
        ("plans", "check_limit", "INTEGER"),
        ("organization_settings", "block_passwords_and_secrets", "BOOLEAN"),
        ("organization_settings", "credential_prefixes", "TEXT"),
        ("organization_settings", "secret_protected_hosts", "TEXT"),
        ("endpoints", "secret_policy_active", "BOOLEAN"),
        ("endpoints", "applied_policy_revision", "INTEGER"),
        ("organization_settings", "web_categories", "TEXT"),
        ("organization_settings", "safe_search", "BOOLEAN"),
        ("organizations", "referral_code", "VARCHAR(16)"),
        ("organizations", "free_started_at", "TIMESTAMP WITH TIME ZONE"),
        ("organizations", "policy_revision", "INTEGER DEFAULT 1 NOT NULL"),
        ("devices", "computer_id", "VARCHAR(36)"),
        ("activation_tokens", "computer_id", "VARCHAR(36)"),
    ]

    # Read every table's columns at once (one query on PostgreSQL), then add only what is missing, so a
    # restart (e.g. a free host waking up) does not pay one remote round trip per known column.
    try:
        tables = {t for t, _, _ in alterations}
        existing_columns = {
            key[1]: {c["name"] for c in cols}
            for key, cols in inspect(db.get_bind()).get_multi_columns(filter_names=list(tables)).items()
        }
    except Exception:
        existing_columns = {}
    for table_name, col_name, col_type in alterations:
        if col_name in existing_columns.get(table_name, ()):
            continue
        try:
            db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_type}"))
            db.commit()
        except Exception:
            # Column already exists or ALTER not needed
            db.rollback()

    # Existing databases: one stored event per extension event id (metering idempotency)
    try:
        db.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_events_client_event ON security_events (organization_id, client_event_id)"
        ))
        db.commit()
    except Exception:
        db.rollback()
    # Referral codes (2.3) are unique
    try:
        db.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_org_referral_code ON organizations (referral_code)"))
        db.commit()
    except Exception:
        db.rollback()

    # PostgreSQL / Supabase: Supabase publishes every public table through its REST API to
    # holders of the public "anon" key. Row Level Security with no policies closes that path;
    # the backend connects as the table owner, which bypasses RLS, so it keeps working.
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        from app.db.session import Base

        try:
            protected = {r[0] for r in db.execute(text(
                "SELECT relname FROM pg_class WHERE relrowsecurity AND relnamespace = 'public'::regnamespace"
            ))}
        except Exception:
            db.rollback()
            protected = set()
        for table_name in Base.metadata.tables:
            if table_name in protected:
                continue
            try:
                db.execute(text(f'ALTER TABLE "{table_name}" ENABLE ROW LEVEL SECURITY'))
                db.commit()
            except Exception:
                db.rollback()

    db.commit()
