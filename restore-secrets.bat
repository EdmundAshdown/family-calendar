@echo off
setlocal EnableExtensions

REM Family Board - restore server_config.py and token_store.json from an
REM encrypted 7z archive made by backup-secrets.bat.
REM
REM Usage:
REM   restore-secrets.bat "D:\FamilyBoard-Backups\family-board-20261126-120000.7z"
REM
REM Stop the Family Board server before running this. Restart both the server
REM and kiosk Chrome afterwards.

set "PROJECT_DIR=%~dp0"

if "%~1"=="" (
    echo Usage: restore-secrets.bat "path\to\family-board-backup.7z"
    exit /b 1
)

set "ARCHIVE=%~1"

if not exist "%ARCHIVE%" (
    echo ERROR: archive not found: %ARCHIVE%
    exit /b 1
)

set "7Z=C:\Program Files\7-Zip\7z.exe"
if not exist "%7Z%" set "7Z=C:\Program Files (x86)\7-Zip\7z.exe"
if not exist "%7Z%" set "7Z=7z.exe"

echo.
echo This will OVERWRITE these files in %PROJECT_DIR% :
echo   server_config.py
echo   token_store.json
echo.
echo Make sure the Family Board server is stopped first.
echo.
pause

"%7Z%" x -p -y -o"%PROJECT_DIR%" "%ARCHIVE%"
if errorlevel 1 (
    echo.
    echo Restore failed. Check the password and archive path.
    exit /b 1
)

echo.
echo Restored. Start the server again, then close and relaunch kiosk Chrome.
