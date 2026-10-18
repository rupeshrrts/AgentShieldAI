"""Test configuration. Runs before any test module imports the app.

The application has no built-in credentials, so the test-only demo company admin, demo auditor
and signing key are provided here as environment variables (never used outside the test run).
Run with DATABASE_URL pointing at a throwaway SQLite file (see AGENTS.md).
"""
import os

os.environ.setdefault("SECRET_KEY", "test-only-signing-key-" + "0" * 32)
os.environ.setdefault("INITIAL_ADMIN_EMAIL", "admin@agentshield.local")
os.environ.setdefault("INITIAL_ADMIN_PASSWORD", "Test-Only-Admin-Pass-0001")
os.environ.setdefault("DEMO_AUDITOR_PASSWORD", "Test-Only-Auditor-Pass-0001")
os.environ.setdefault("REMINDER_LOOP_ENABLED", "false")
# Most suites test the stricter mode (confirm email before the Free plan and trial); the default mode
# (no confirmation needed) is covered in test_no_email_confirmation.py.
os.environ.setdefault("EMAIL_VERIFICATION_REQUIRED", "true")
# Test addresses use reserved domains (example.com, .local) and tests must not depend on DNS;
# test_signup_email_check.py switches the check on with a fake resolver.
os.environ.setdefault("SIGNUP_CHECK_EMAIL_DOMAIN", "false")
