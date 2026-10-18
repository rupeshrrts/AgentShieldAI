"""AgentShield Backend API

Main FastAPI application entry point. Handles startup/shutdown lifecycle,
database initialization, CORS middleware, API route registration, and
serving local static assets for development testing.
"""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.api import (
    api_tokens,
    auth,
    billing,
    computers,
    device_auth,
    distribution,
    domains,
    endpoints,
    events,
    metrics,
    organization,
    payments,
    platform,
    policies,
    referrals,
    staff_admin,
    staff_auth,
    usage,
    users,
)
from app.api.events import purge_expired_events
from app.core.config import settings
from app.core.notifications import reminder_loop
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle manager.

    Creates database tables if they do not exist, runs seed initialization so new
    environments start with a ready-to-use tenant, admin account and baseline
    policies, and deletes events older than each organization's retention period.
    """
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        init_db(db)
        purge_expired_events(db)
    finally:
        db.close()
    # Trial/expiry reminders (informational; access is enforced on every request)
    reminder_task = asyncio.create_task(reminder_loop(SessionLocal)) if settings.REMINDER_LOOP_ENABLED else None
    yield
    if reminder_task:
        reminder_task.cancel()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="AgentShield security policy management and audit ingestion backend.",
    lifespan=lifespan,
)

# Configure CORS to allow communication from the React dashboard (local ports)
# and Chrome browser extensions (which run under chrome-extension:// origins).
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Health & Monitoring Endpoints ---

@app.get("/health", tags=["Health"])
def health_check():
    """Basic health check showing application metadata and active environment."""
    return {
        "status": "healthy",
        "service": "AgentShield",
        "environment": settings.ENVIRONMENT,
        "version": settings.VERSION,
    }


@app.get("/health/live", tags=["Health"])
def liveness_check():
    """Liveness probe for container orchestrators (e.g., Kubernetes, Docker)."""
    return {"status": "alive"}


@app.get("/health/ready", tags=["Health"])
def readiness_check():
    """Readiness probe that validates active database connectivity."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {
            "status": "ready",
            "database": "connected",
            "environment": settings.ENVIRONMENT,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Database readiness check failed: {str(exc)}"
        )


# --- Core API Routers ---
app.include_router(auth.router)
app.include_router(policies.router)
app.include_router(domains.router)
app.include_router(events.router)
app.include_router(metrics.router)
app.include_router(organization.router)
app.include_router(endpoints.router)
app.include_router(distribution.router)
app.include_router(users.org_router)
app.include_router(users.me_router)
app.include_router(device_auth.router)
app.include_router(computers.router)
app.include_router(computers.me_router)
app.include_router(billing.router)
app.include_router(billing.releases_router)
app.include_router(payments.router)
app.include_router(usage.router)
app.include_router(referrals.router)
app.include_router(api_tokens.router)
app.include_router(api_tokens.public_router)

# --- Internal admin console (AgentShieldAI staff only; separate tokens, MFA, per-route permissions) ---
app.include_router(staff_auth.router)
app.include_router(staff_admin.router)
app.include_router(platform.router)
app.include_router(payments.platform_router)


# --- Local Development Static Mounts (Interactive Test Bench) ---
# When running locally, mount extension assets so developers can test prompt
# interception and modal popups directly at http://localhost:8000/test-bench.
# Never mounted in production: the folder may contain client-config.json with a device key.
extension_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "extension"))
if os.path.exists(extension_dir) and not settings.is_production:
    dist_dir = os.path.join(extension_dir, "dist")
    src_dir = os.path.join(extension_dir, "src")
    if os.path.exists(dist_dir):
        app.mount("/dist", StaticFiles(directory=dist_dir), name="dist")
    if os.path.exists(src_dir):
        app.mount("/src", StaticFiles(directory=src_dir), name="src")
    app.mount("/extension", StaticFiles(directory=extension_dir), name="extension")


@app.get("/test-bench", tags=["TestBench"])
def get_test_bench():
    """Serves the interactive ChatGPT simulator playground for local testing."""
    bench_file = os.path.join(extension_dir, "test-bench.html")
    if os.path.exists(bench_file) and not settings.is_production:
        return FileResponse(bench_file)
    return JSONResponse(
        status_code=404,
        content={"detail": "Interactive test bench is only mounted when extension files are present."}
    )


if __name__ == "__main__":
    import uvicorn
    # Development runner: listen on this machine only. Production uses the Dockerfile / a process manager.
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
