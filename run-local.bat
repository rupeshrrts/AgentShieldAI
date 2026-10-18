@echo off
rem Double-click or run: run-local.bat   (same options as run-local.ps1, e.g. run-local.bat -Owner you@company.com)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1" %*
