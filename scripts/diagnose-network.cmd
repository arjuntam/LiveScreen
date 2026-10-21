@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0diagnose-network.ps1"
if errorlevel 1 echo Diagnostic did not finish. Keep this message. Ask IT if PowerShell scripts are restricted. No policy changes were made.
pause
