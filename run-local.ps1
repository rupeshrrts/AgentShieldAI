# AgentShieldAI - start everything locally for testing (one command).
#
#   .\run-local.ps1                              start backend + user dashboard + developer console
#   .\run-local.ps1 -Owner you@company.com       also create your developer-console login (first time)
#   .\run-local.ps1 -Reset                       start with an empty test database
#
# Uses a local SQLite test database (backend\local_test.db), never the live Supabase database from .env.
param(
    [string]$Owner = "",
    [switch]$Reset
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$py = Join-Path $root "backend\.venv\Scripts\python.exe"
$db = "sqlite:///./local_test.db"

if (-not (Test-Path $py)) {
    Write-Host "Creating the Python environment (first run only)..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "backend")
    python -m venv .venv
    & .\.venv\Scripts\python.exe -m pip install -q -r requirements.txt
    Pop-Location
}
foreach ($app in "dashboard", "admin-console", "extension") {
    if (-not (Test-Path (Join-Path $root "$app\node_modules"))) {
        Write-Host "Installing $app packages (first run only)..." -ForegroundColor Cyan
        Push-Location (Join-Path $root $app); npm.cmd install --no-audit --no-fund | Out-Null; Pop-Location
    }
}
if ($Reset) { Remove-Item (Join-Path $root "backend\local_test.db") -ErrorAction SilentlyContinue }

Write-Host "Building the extension..." -ForegroundColor Cyan
Push-Location (Join-Path $root "extension"); node build.js | Out-Null; Pop-Location

# Each app runs in its own window; close a window to stop that app
$backend = "`$env:DATABASE_URL='$db'; `$env:ALLOWED_ORIGINS='http://localhost:5173,http://localhost:5175'; " +
           "`$env:DASHBOARD_URL='http://localhost:5173'; `$env:ADMIN_CONSOLE_URL='http://localhost:5175'; `$env:SMTP_HOST=''; " +
           "`$Host.UI.RawUI.WindowTitle='AgentShield backend :8000 (emails print here)'; " +
           "Set-Location '$root\backend'; & '$py' -m uvicorn app.main:app --port 8000 --reload"
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $backend
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle='User dashboard :5173'; Set-Location '$root\dashboard'; npm.cmd run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle='Developer console :5175'; Set-Location '$root\admin-console'; npm.cmd run dev"

if ($Owner) {
    Start-Sleep -Seconds 4
    Write-Host "Creating your developer-console login..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "backend")
    $env:DATABASE_URL = $db
    & $py -m app.cli create-platform-owner --email $Owner
    Pop-Location
}

Write-Host ""
Write-Host "AgentShieldAI is starting:" -ForegroundColor Green
Write-Host "  User dashboard     http://localhost:5173   (sign up as Individual; confirmation links print in the backend window)"
Write-Host "  Developer console  http://localhost:5175   (first time: .\run-local.ps1 -Owner you@company.com)"
Write-Host "  Backend API        http://localhost:8000/docs"
Write-Host "  Extension          chrome://extensions > Developer mode > Load unpacked > $root\extension"
