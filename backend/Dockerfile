# Same Python as the development PCs and CI, so what passes the tests is what runs on Render
FROM python:3.14-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# curl for the health check. No compiler needed: every requirement installs from a prebuilt wheel
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Create unprivileged system user for container security
RUN groupadd -r -g 1001 appuser && useradd -r -u 1001 -g appuser appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Adjust permissions for non-root user
RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

# Startup talks to the database (table check, seed), which can take a while on a cold free host
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# One worker: replay protection for device sign-in and login lockouts are kept in process memory, and the free
# Render instance (512 MB) runs out of memory with several. Same command as render.yaml, so a service created
# without the Blueprint behaves the same. Listens on $PORT when the host sets it.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips=*"]
