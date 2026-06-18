@echo off
cd /d "%~dp0"
start "HPA Automations Server" cmd /k npm start
timeout /t 2 /nobreak >nul
start "" http://localhost:4173
