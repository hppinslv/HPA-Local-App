@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\scripts\run-monthly-report.ps1" %*
