"""Database Session Engine & Connection Pooling.

Supports both local SQLite and production-grade PostgreSQL (including Supabase,
AWS RDS, and Google Cloud SQL) with automatic connection pooling and pre-ping checks.
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from app.core.config import settings

db_url = settings.DATABASE_URL

# SQLAlchemy requires 'postgresql://' instead of legacy 'postgres://' scheme
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

connect_args = {}
engine_kwargs = {"pool_pre_ping": True}

if db_url.startswith("sqlite"):
    # SQLite requires disabling same-thread checks when used with FastAPI async threads
    connect_args = {"check_same_thread": False}
else:
    # Production PostgreSQL connection pool configuration
    engine_kwargs.update({
        "pool_size": int(os.getenv("DB_POOL_SIZE", "10")),
        "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", "20")),
        "pool_recycle": int(os.getenv("DB_POOL_RECYCLE", "1800")),
    })

engine = create_engine(
    db_url,
    connect_args=connect_args,
    **engine_kwargs,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI dependency that provides a dedicated database session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
