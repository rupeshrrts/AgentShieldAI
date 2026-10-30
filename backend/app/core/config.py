"""AgentShield Application Configuration & Environment Settings.

Loads environment variables from .env with production validation:
- Validates SECRET_KEY strength in production mode.
- Restricts CORS wildcards when running in production.
- Provides defaults for database connectivity and token expiration.
"""

import logging
import os
from pathlib import Path
from dotenv import load_dotenv

logger = logging.getLogger("agentshield.config")

# Search for .env in current or parent directory
env_path = Path(__file__).resolve().parent.parent.parent.parent / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    load_dotenv()


_DEFAULT_SECRET_KEYS = {
    "agentshield-super-secret-production-key-change-me-321",
    "REPLACE_WITH_A_SECURE_64_CHAR_HEX_SECRET_FOR_PRODUCTION",
}


class Settings:
    PROJECT_NAME: str = os.getenv("PROJECT_NAME", "AgentShield Security & Governance API")
    VERSION: str = os.getenv("VERSION", "1.0.0")
    API_V1_STR: str = "/api/v1"
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development").lower()

    # Secret key for JWT signature verification. Required in production. In development a random
    # key is generated per process when unset (sessions then end when the server restarts).
    SECRET_KEY: str = os.getenv("SECRET_KEY", "")
    ALGORITHM: str = os.getenv("ALGORITHM", "HS256")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 60 * 24))

    # Database connection string (defaults to local SQLite; supports Supabase / PostgreSQL)
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./agentshield.db")

    # Optional first customer company and its admin, created on first boot only when BOTH are set.
    # There are no default credentials. Internal staff are created with `python -m app.cli`.
    INITIAL_ADMIN_EMAIL: str = os.getenv("INITIAL_ADMIN_EMAIL", "").strip().lower()
    INITIAL_ADMIN_PASSWORD: str = os.getenv("INITIAL_ADMIN_PASSWORD", "")
    # Development only: a read-only demo account (auditor@agentshield.local) when this is set
    DEMO_AUDITOR_PASSWORD: str = os.getenv("DEMO_AUDITOR_PASSWORD", "")

    # Internal admin console (staff accounts, separate from customers)
    STAFF_TOKEN_HOURS: int = int(os.getenv("STAFF_TOKEN_HOURS", "8"))
    # Key that encrypts staff authenticator secrets at rest. If unset, derived from SECRET_KEY.
    STAFF_MFA_KEY: str = os.getenv("STAFF_MFA_KEY", "")
    # Address of the internal console (used in staff invite links)
    ADMIN_CONSOLE_URL: str = os.getenv("ADMIN_CONSOLE_URL", "").rstrip("/")

    # Name of the organization created on first boot
    INITIAL_ORG_NAME: str = os.getenv("INITIAL_ORG_NAME", "Acme Corp")

    # Maximum audit events a single device key may submit per minute
    DEVICE_EVENTS_PER_MINUTE: int = int(os.getenv("DEVICE_EVENTS_PER_MINUTE", "120"))

    # Demo mode: shows a "Demo environment" banner and the guided demo page in the dashboard.
    # It does not fake any data or relax any check.
    DEMO_MODE: bool = os.getenv("DEMO_MODE", "false").lower() in ("1", "true", "yes")

    # Extension distribution (system installer / Group Policy force-install)
    # Folder with agentshield.crx + release.json produced by scripts/packaging/pack-extension.js
    EXTENSION_PACKAGE_DIR: str = os.getenv(
        "EXTENSION_PACKAGE_DIR",
        str(Path(__file__).resolve().parent.parent.parent.parent / "dist-installer" / "package"),
    )
    # Network Agent installer (one self-installing exe) offered for download; built by agent/packaging
    AGENT_PACKAGE_PATH: str = os.getenv(
        "AGENT_PACKAGE_PATH",
        str(Path(__file__).resolve().parent.parent.parent.parent / "dist-installer" / "AgentShield-Agent.exe"),
    )
    # Public base URL browsers use to reach this server (e.g. https://agentshield.company.com).
    # If empty, it is taken from the incoming request.
    PUBLIC_BASE_URL: str = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    # After publishing to the stores, set these so installers use the store copies
    # (store-hosted extensions can be force-installed on any Windows PC, not only managed ones).
    CHROME_STORE_EXTENSION_ID: str = os.getenv("CHROME_STORE_EXTENSION_ID", "").strip()
    EDGE_STORE_EXTENSION_ID: str = os.getenv("EDGE_STORE_EXTENSION_ID", "").strip()

    # Dashboard address used in invite emails (e.g. https://agentshield.company.com).
    # If empty, PUBLIC_BASE_URL is used; in development, the Vite dev server.
    DASHBOARD_URL: str = os.getenv("DASHBOARD_URL", "").rstrip("/")

    # Account, activation and device authorization
    INVITE_EXPIRE_HOURS: int = int(os.getenv("INVITE_EXPIRE_HOURS", "72"))
    # Self sign-up from the dashboard's login page (accounts join this server's organization as
    # EMPLOYEE after verifying their email). SIGNUP_ALLOWED_DOMAINS limits it, e.g. "motwane.com".
    SIGNUP_ENABLED: bool = os.getenv("SIGNUP_ENABLED", "true").lower() in ("1", "true", "yes")
    SIGNUP_ALLOWED_DOMAINS: list = [
        d.strip().lower().lstrip("@") for d in os.getenv("SIGNUP_ALLOWED_DOMAINS", "").split(",") if d.strip()
    ]
    EMAIL_VERIFY_EXPIRE_HOURS: int = int(os.getenv("EMAIL_VERIFY_EXPIRE_HOURS", "24"))
    # 2.4.1: when false (default), new accounts get the Free plan and can claim the trial without confirming
    # their email, and sign-up sends no confirmation email. True restores "confirm your email first".
    # The invite-a-friend bonus always needs a confirmed email (Profile & security -> confirm).
    EMAIL_VERIFICATION_REQUIRED: bool = os.getenv("EMAIL_VERIFICATION_REQUIRED", "false").lower() in ("1", "true", "yes")
    # Sign-up refuses addresses whose domain cannot receive email (no MX/A record in DNS, e.g. "gmail.comrre"),
    # and suggests the likely fix for typos of common providers. A DNS outage does not block sign-ups.
    SIGNUP_CHECK_EMAIL_DOMAIN: bool = os.getenv("SIGNUP_CHECK_EMAIL_DOMAIN", "true").lower() in ("1", "true", "yes")
    # Public company workspaces are "coming soon": off until company onboarding is released
    COMPANY_SIGNUP_ENABLED: bool = os.getenv("COMPANY_SIGNUP_ENABLED", "false").lower() in ("1", "true", "yes")
    # Browsers an account may use while it runs on prepaid credits only (no trial or subscription)
    CREDITS_DEVICE_LIMIT: int = int(os.getenv("CREDITS_DEVICE_LIMIT", "3"))
    # Free forever (2.3): individual accounts with a confirmed email and no live plan get the "free" plan's
    # monthly prompt checks (300 by default, edited in Plans & pricing); at the limit prompt checks pause.
    FREE_TIER_ENABLED: bool = os.getenv("FREE_TIER_ENABLED", "true").lower() in ("1", "true", "yes")
    # Referrals: both accounts get this many bonus prompt checks (credits) when the invited person confirms
    # their email; at most REFERRAL_MAX rewarded referrals per account.
    REFERRAL_BONUS_CHECKS: int = int(os.getenv("REFERRAL_BONUS_CHECKS", "100"))
    REFERRAL_MAX: int = int(os.getenv("REFERRAL_MAX", "10"))
    PASSWORD_RESET_EXPIRE_MINUTES: int = int(os.getenv("PASSWORD_RESET_EXPIRE_MINUTES", "60"))
    # Dashboard sign-in lifetime (hours). Password change/reset and "sign out everywhere" end sessions earlier.
    DASHBOARD_TOKEN_HOURS: int = int(os.getenv("DASHBOARD_TOKEN_HOURS", "12"))

    # Free trial and licensing
    TRIAL_DAYS: int = int(os.getenv("TRIAL_DAYS", "30"))
    TRIAL_CLAIMS_PER_IP_30D: int = int(os.getenv("TRIAL_CLAIMS_PER_IP_30D", "3"))
    # Payments (Razorpay). Use test-mode keys (rzp_test_...) until you go live. Secrets stay on the server.
    RAZORPAY_KEY_ID: str = os.getenv("RAZORPAY_KEY_ID", "").strip()
    RAZORPAY_KEY_SECRET: str = os.getenv("RAZORPAY_KEY_SECRET", "").strip()
    RAZORPAY_WEBHOOK_SECRET: str = os.getenv("RAZORPAY_WEBHOOK_SECRET", "").strip()
    RAZORPAY_API_BASE: str = os.getenv("RAZORPAY_API_BASE", "https://api.razorpay.com/v1").rstrip("/")
    # Seller details printed on payment receipts
    BILLING_SELLER_NAME: str = os.getenv("BILLING_SELLER_NAME", "AgentShield")
    BILLING_SELLER_DETAILS: str = os.getenv("BILLING_SELLER_DETAILS", "")

    # Hourly background job for trial/expiry reminders (access itself is enforced on every request)
    REMINDER_LOOP_ENABLED: bool = os.getenv("REMINDER_LOOP_ENABLED", "true").lower() in ("1", "true", "yes")
    ACTIVATION_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACTIVATION_TOKEN_EXPIRE_MINUTES", "30"))
    DEVICE_SESSION_MINUTES: int = int(os.getenv("DEVICE_SESSION_MINUTES", "15"))
    MAX_DEVICES_PER_USER: int = int(os.getenv("MAX_DEVICES_PER_USER", "3"))
    # AgentShield Windows app (2.4): browsers (profiles) one connected PC may hold; beyond it the
    # least recently seen browser of that PC is replaced
    MAX_BROWSERS_PER_COMPUTER: int = int(os.getenv("MAX_BROWSERS_PER_COMPUTER", "10"))
    # Accept the old organization-wide "asd_" device keys (X-Device-Key). Off: every browser
    # must be activated by a signed-in account. Only turn on temporarily while migrating.
    LEGACY_DEVICE_KEYS_ENABLED: bool = os.getenv("LEGACY_DEVICE_KEYS_ENABLED", "false").lower() in ("1", "true", "yes")

    # Outgoing email (invites). Without SMTP_HOST, links are written to the server log
    # in development and invites are refused in production.
    SMTP_HOST: str = os.getenv("SMTP_HOST", "").strip()
    SMTP_PORT: int = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USER: str = os.getenv("SMTP_USER", "").strip()
    SMTP_PASSWORD: str = os.getenv("SMTP_PASSWORD", "")
    SMTP_FROM: str = os.getenv("SMTP_FROM", "").strip()
    SMTP_STARTTLS: bool = os.getenv("SMTP_STARTTLS", "true").lower() in ("1", "true", "yes")

    def __init__(self):
        # Validate production environment security. Refuse to start with known defaults,
        # because anyone who has read this repository would know them.
        if self.is_production:
            if self.SECRET_KEY in _DEFAULT_SECRET_KEYS or len(self.SECRET_KEY) < 32:
                raise RuntimeError(
                    "Refusing to start in production with a missing, weak or default SECRET_KEY. "
                    "Generate one with: python scripts/generate_secret_key.py"
                )
            if self.INITIAL_ADMIN_PASSWORD and len(self.INITIAL_ADMIN_PASSWORD) < 14:
                raise RuntimeError("INITIAL_ADMIN_PASSWORD must be at least 14 characters in production.")
            if self.DATABASE_URL.startswith("sqlite"):
                logger.warning(
                    "[PRODUCTION WARNING] Using SQLite in production. "
                    "For multi-worker concurrency and high availability, configure PostgreSQL or Supabase in DATABASE_URL."
                )
        elif not self.SECRET_KEY:
            import secrets as _secrets

            self.SECRET_KEY = _secrets.token_hex(32)
            logger.warning("SECRET_KEY is not set: using a random key for this process (sessions end on restart).")

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT in ("production", "prod")

    @property
    def payments_configured(self) -> bool:
        return bool(self.RAZORPAY_KEY_ID and self.RAZORPAY_KEY_SECRET)

    @property
    def payments_test_mode(self) -> bool:
        return self.RAZORPAY_KEY_ID.startswith("rzp_test_")

    @property
    def email_configured(self) -> bool:
        return bool(self.SMTP_HOST and self.SMTP_FROM)

    @property
    def CORS_ORIGINS(self) -> list:
        custom_origins = os.getenv("ALLOWED_ORIGINS")
        if custom_origins:
            return [origin.strip() for origin in custom_origins.split(",") if origin.strip()]

        if self.is_production:
            # Safe production defaults: local container loopback only. Set ALLOWED_ORIGINS
            # to your dashboard URL. Extension service workers are not subject to CORS.
            return [
                "http://localhost",
                "https://localhost",
            ]

        # Development environment origins (the dashboard and internal console dev servers)
        return [
            "http://localhost:5173",
            "http://localhost:5175",
            "http://localhost:3000",
            "http://127.0.0.1:5173",
            "http://localhost:8000",
        ]


settings = Settings()
