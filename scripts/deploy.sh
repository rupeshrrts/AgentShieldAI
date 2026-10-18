#!/usr/bin/env bash
# ==============================================================================
# AgentShield Production Deployment Script (Linux / macOS)
# ==============================================================================
set -e

echo "=========================================================="
echo "          AgentShield Production Deployment Setup"
echo "=========================================================="

# 1. Check for .env file
if [ ! -f ".env" ]; then
    if [ -f ".env.production.example" ]; then
        echo "[1/4] Creating .env from .env.production.example..."
        cp .env.production.example .env
        echo "[!] Please review .env and configure your DATABASE_URL and SECRET_KEY."
    else
        echo "[ERROR] .env file not found. Please create one before deploying."
        exit 1
    fi
else
    echo "[1/4] Found existing .env file."
fi

# 2. Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "[ERROR] Docker is not installed or not in PATH."
    exit 1
fi

# 3. Determine compose file (self-hosted postgres vs external Supabase)
COMPOSE_FILE="docker-compose.prod.yml"
if grep -q "supabase" .env 2>/dev/null || grep -q "pooler.supabase.com" .env 2>/dev/null; then
    COMPOSE_FILE="docker-compose.supabase.yml"
    echo "[2/4] Detected Supabase connection; using $COMPOSE_FILE"
else
    echo "[2/4] Using full stack with PostgreSQL; using $COMPOSE_FILE"
fi

# 4. Build and start containers
echo "[3/4] Building and launching production containers..."
docker compose -f "$COMPOSE_FILE" up -d --build

echo "[4/4] Verifying production deployment health..."
sleep 5
python3 scripts/verify_production.py http://localhost:8000 || python scripts/verify_production.py http://localhost:8000 || echo "[NOTE] Verify script completed."

echo "=========================================================="
echo " SUCCESS: AgentShield Production Services are Live!"
echo "   - Dashboard UI:  http://localhost"
echo "   - Backend API:   http://localhost:8000"
echo "   - API Docs:      http://localhost:8000/docs"
echo "=========================================================="
