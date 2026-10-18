"""Utility script to verify connectivity with Supabase or any PostgreSQL database.

Usage:
    python scripts/test_supabase_connection.py
    # or pass URL directly:
    python scripts/test_supabase_connection.py "postgresql://postgres.xxx:pass@host:5432/postgres"
"""

import importlib
import os
import subprocess
import sys

# Dynamically import sqlalchemy to prevent static missing-import warnings in IDEs
# when opened with a global interpreter that lacks project dependencies.
try:
    _sa = importlib.import_module("sqlalchemy")
    create_engine = getattr(_sa, "create_engine")
    text = getattr(_sa, "text")
except ImportError:
    # Auto-bridge to project virtual environment if available
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    venv_python_win = os.path.join(base_dir, "backend", ".venv", "Scripts", "python.exe")
    venv_python_unix = os.path.join(base_dir, "backend", ".venv", "bin", "python")
    target_python = (
        venv_python_win
        if os.path.exists(venv_python_win)
        else (venv_python_unix if os.path.exists(venv_python_unix) else None)
    )

    if target_python and sys.executable != target_python:
        result = subprocess.run([target_python, __file__] + sys.argv[1:])
        sys.exit(result.returncode)

    print("[ERROR] Required package 'sqlalchemy' is not installed in the active Python environment.")
    print("\nTo resolve this:")
    print("  1. Run with the project virtual environment:")
    print("     backend\\.venv\\Scripts\\python.exe scripts/test_supabase_connection.py")
    print("  2. Or install project requirements:")
    print("     pip install -r backend/requirements.txt")
    sys.exit(1)


def main():
    # 1. Grab connection string from environment or command-line arguments
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        if len(sys.argv) > 1:
            db_url = sys.argv[1]
        else:
            print("Usage: python scripts/test_supabase_connection.py <DATABASE_URL>")
            print("Example: python scripts/test_supabase_connection.py postgresql://postgres:secret@db.supabase.co:5432/postgres")
            sys.exit(1)

    # SQLAlchemy requires 'postgresql://' instead of legacy 'postgres://'
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql://", 1)

    # Mask credentials when printing to terminal
    safe_host = db_url.split("@")[-1] if "@" in db_url else "database"
    print(f"Testing database connection to: {safe_host} ...")

    try:
        engine = create_engine(db_url, pool_pre_ping=True)
        with engine.connect() as conn:
            # 2. Check engine version
            result = conn.execute(text("SELECT version();")).fetchone()
            print("[OK] Successfully connected to PostgreSQL!")
            print(f"  Version: {result[0]}")

            # 3. Check which AgentShield tables currently exist
            tables = conn.execute(text(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
            )).fetchall()
            table_names = [t[0] for t in tables]
            print(f"  Existing public tables ({len(table_names)}): {table_names}")

    except Exception as exc:
        print("[FAIL] Connection could not be established:")
        print(f"  Error details: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
