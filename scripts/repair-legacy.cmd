@echo off
setlocal EnableExtensions DisableDelayedExpansion
title LiveScreen - Repair old uninstaller
echo Close all LiveScreen installation and uninstallation windows first.
echo This tool only replaces the old LiveScreen uninstaller. It does not delete projects or media.
echo.
set "LS_GUID=39e2c8a3-1633-5f23-bf69-e35f300f6ba0"
set "LS_HIVE=HKCU"
reg query "HKCU\Software\%LS_GUID%" /v InstallLocation /reg:64 >nul 2>&1
if errorlevel 1 set "LS_HIVE=HKLM"
set "LS_DIR="
set "LS_VERSION="
for /f "tokens=2,*" %%A in ('reg query "%LS_HIVE%\Software\%LS_GUID%" /v InstallLocation /reg:64 2^>nul') do if "%%A"=="REG_SZ" set "LS_DIR=%%B"
for /f "tokens=2,*" %%A in ('reg query "%LS_HIVE%\Software\Microsoft\Windows\CurrentVersion\Uninstall\%LS_GUID%" /v DisplayVersion /reg:64 2^>nul') do if "%%A"=="REG_SZ" set "LS_VERSION=%%B"
if not defined LS_DIR goto missing
if "%LS_VERSION%"=="0.2.1" goto already
if "%LS_VERSION%"=="__CURRENT_VERSION__" goto already
if "%LS_VERSION%"=="0.1.0" goto confirmed
if "%LS_VERSION%"=="0.2.0" goto confirmed
echo Unsupported version: %LS_VERSION%. Nothing was changed.
goto failed
:confirmed
if not exist "%LS_DIR%\LiveScreen.exe" goto missing
if not exist "%LS_DIR%\Uninstall LiveScreen.exe" goto missing
if not exist "%~dp0fixed-uninstaller.bin" goto missing
"%SystemRoot%\System32\certutil.exe" -hashfile "%~dp0fixed-uninstaller.bin" SHA256 | "%SystemRoot%\System32\findstr.exe" /I /C:"__PAYLOAD_SHA256__" >nul
if errorlevel 1 goto checksum
set "LS_BACKUP=%LOCALAPPDATA%\LiveScreen\installer-backups\%LS_VERSION%"
if not exist "%LS_BACKUP%" mkdir "%LS_BACKUP%"
if not exist "%LS_BACKUP%\Uninstall LiveScreen.exe" copy /B /Y "%LS_DIR%\Uninstall LiveScreen.exe" "%LS_BACKUP%\Uninstall LiveScreen.exe" >nul
if not exist "%LS_BACKUP%\Uninstall LiveScreen.exe" goto failed
copy /B /Y "%~dp0fixed-uninstaller.bin" "%LS_DIR%\Uninstall LiveScreen.exe" >nul
if errorlevel 1 goto failed
echo SUCCESS. The old uninstaller has been repaired.
echo You can now uninstall from Windows Settings, or install LiveScreen __CURRENT_VERSION__.
echo Projects and media have not been deleted.
pause
exit /b 0
:already
echo A fixed LiveScreen version is already registered. No old-version repair is needed.
pause
exit /b 0
:checksum
echo Payload checksum failed. Extract a fresh copy of the whole repair ZIP and retry.
goto failed
:missing
echo The registered old installation or repair payload was not found. Nothing was deleted.
:failed
echo Repair did not complete. Close all installer windows and retry.
echo If Windows reports access denied, right-click repair.cmd and run as administrator with the same account.
pause
exit /b 1
