@echo off
setlocal enabledelayedexpansion
title AgentShield Production Deployment

echo ==========================================================
echo          AgentShield Production Deployment Setup
echo ==========================================================

REM 1. Check for .env file
if not exist ".env" (
    if exist ".env.production.example" (
        echo [1/4] Copying .env.production.example to .env...
        copy ".env.production.example" ".env" >nul
        echo [!] Created .env file. Please review it and set your SECRET_KEY and DATABASE_URL.
    ) else (
        echo [ERROR] .env file not found.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Found existing .env file.
)

REM 2. Check if Docker is installed
where docker >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Docker command was not found. Please start Docker Desktop.
    pause
    exit /b 1
)

REM 3. Choose compose file (check for supabase in .env)
set "COMPOSE_FILE=docker-compose.prod.yml"
findstr /I "supabase" .env >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "COMPOSE_FILE=docker-compose.supabase.yml"
    echo [2/4] Detected Supabase database in .env; using %COMPOSE_FILE%
) else (
    echo [2/4] Using full stack with local Postgres; using %COMPOSE_FILE%
)

REM 4. Build and run containers
echo [3/4] Building and launching production containers...
docker compose -f "%COMPOSE_FILE%" up -d --build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Docker compose failed to start.
    pause
    exit /b 1
)

echo [4/4] Verifying health probes...
timeout /t 5 /nobreak >nul
python scripts\verify_production.py http://localhost:8000

echo.
echo ==========================================================
echo  SUCCESS: AgentShield Production Stack is Live!
echo    - Dashboard:   http://localhost
echo    - Backend API: http://localhost:8000
echo    - API Docs:    http://localhost:8000/docs
echo ==========================================================
echo.
pause
