@echo off
title The B Hive Resort - WhatsApp Automation Startup
echo ========================================================
echo   Starting The B Hive Resort WhatsApp Automation System
echo ========================================================
echo.

echo [1/3] Starting n8n Workflow Automation Server...
start "n8n Server" cmd /k "n8n"

echo [2/3] Starting Web Dashboard Node Server (Port 3000)...
start "B Hive Web Dashboard (Node.js)" cmd /k "cd /d "%~dp0" && node server.js"

echo [3/3] Starting Cloudflare Tunnel (thebhiveresort.in)...
start "Cloudflare Tunnel" cmd /k "cd /d "%~dp0" && "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run thebhiveresort"

echo.
echo ========================================================
echo   All 3 services have been launched in separate windows!
echo   - Dashboard: https://chat.thebhiveresort.in
echo   - n8n UI:    http://localhost:5678
echo ========================================================
echo.
pause
