"""Deployment-time administration commands.

    python -m app.cli create-platform-owner --email you@agentshield.ai [--name "Your Name"] [--force]
    python -m app.cli reset-staff-password --email you@agentshield.ai [--reset-mfa]

create-platform-owner creates the first internal PLATFORM_OWNER with a random temporary password, printed once.
The owner must change it and set up an authenticator app at first sign-in to the internal console.
reset-staff-password is the recovery path for a forgotten staff password (the console has no self-service reset):
it sets a new temporary password (printed once, must be changed at next sign-in) and ends that account's
sessions; --reset-mfa also removes the authenticator and recovery codes so a new one is set up at sign-in.
It needs shell access to the server and its database, which is the trust boundary for both commands.
No credentials exist in source code or configuration files.
"""
import argparse
import secrets
import sys

from sqlalchemy import func

from app.core.audit import record_admin_action
from app.core.permissions import OWNER
from app.core.security import hash_password
from app.db.models import StaffRecoveryCode, StaffUser
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine


def create_platform_owner(email: str, name: str = None, force: bool = False) -> str:
    """Returns the temporary password. Raises ValueError when not allowed."""
    email = (email or "").strip().lower()
    if "@" not in email:
        raise ValueError("Give a valid --email.")
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        init_db(db)
        if db.query(StaffUser).filter(StaffUser.role == OWNER).count() and not force:
            raise ValueError("A platform owner already exists. Invite more staff from the console (or use --force).")
        if db.query(StaffUser).filter(func.lower(StaffUser.email) == email).first():
            raise ValueError("A staff account with this email already exists.")
        temporary = secrets.token_urlsafe(18)
        db.add(StaffUser(email=email, name=name, role=OWNER, active=True, password_hash=hash_password(temporary),
                         must_change_password=True, created_by="bootstrap-cli"))
        db.commit()
        record_admin_action(db, organization_id=None, actor="system:bootstrap-cli", action="staff.owner_created",
                            target_type="staff", target_id=email, summary=f"Created platform owner {email} (temporary password)",
                            actor_type="system")
        return temporary
    finally:
        db.close()


def reset_staff_password(email: str, reset_mfa: bool = False) -> str:
    """Gives an existing staff account a new temporary password. Returns it. Raises ValueError when not found."""
    email = (email or "").strip().lower()
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        staff = db.query(StaffUser).filter(func.lower(StaffUser.email) == email).first()
        if not staff:
            raise ValueError("No staff account with this email.")
        temporary = secrets.token_urlsafe(18)
        staff.password_hash = hash_password(temporary)
        staff.must_change_password = True
        staff.session_version = (staff.session_version or 0) + 1
        if reset_mfa:
            staff.totp_secret_enc = None
            staff.totp_enabled_at = None
            staff.totp_last_step = None
            db.query(StaffRecoveryCode).filter(StaffRecoveryCode.staff_id == staff.id).delete()
        db.commit()
        record_admin_action(db, organization_id=None, actor="system:cli", action="staff.password_reset",
                            target_type="staff", target_id=email,
                            summary=f"Reset the password of {email} (temporary password)" + (" and the authenticator" if reset_mfa else ""),
                            actor_type="system")
        return temporary
    finally:
        db.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("create-platform-owner", help="Create the first internal platform owner")
    p.add_argument("--email", required=True)
    p.add_argument("--name")
    p.add_argument("--force", action="store_true", help="Allow an additional owner")
    r = sub.add_parser("reset-staff-password", help="Give a staff account a new temporary password")
    r.add_argument("--email", required=True)
    r.add_argument("--reset-mfa", action="store_true", help="Also remove the authenticator (set up again at sign-in)")
    args = parser.parse_args(argv)
    if args.command == "reset-staff-password":
        try:
            temporary = reset_staff_password(args.email, args.reset_mfa)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        print("Staff password reset. Other sessions of this account are signed out.")
        print(f"  Email:              {args.email.strip().lower()}")
        print(f"  Temporary password: {temporary}")
        print("Sign in to the internal console now: you must change this password"
              + (" and set up an authenticator app again." if args.reset_mfa else " (your authenticator app is unchanged)."))
        print("This password is not stored anywhere in readable form and will not be shown again.")
        return 0
    try:
        temporary = create_platform_owner(args.email, args.name, args.force)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print("Platform owner created.")
    print(f"  Email:              {args.email.strip().lower()}")
    print(f"  Temporary password: {temporary}")
    print("Sign in to the internal console now: you must change this password and set up an authenticator app.")
    print("This password is not stored anywhere in readable form and will not be shown again.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
