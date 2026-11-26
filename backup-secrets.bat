@echo off
setlocal EnableExtensions

REM Family Board - encrypted backup of the two files that are not in git:
REM   server_config.py  (Google OAuth client secret)
REM   token_store.json  (the only copy of every family refresh token)
REM
REM Set FAMILY_BOARD_BACKUP_DIR to a secure, non-synced destination before
REM running, for example an external drive or a local admin-only folder:
REM
REM   set FAMILY_BOARD_BACKUP_DIR=D:\FamilyBoard-Backups
REM   backup-secrets.bat
REM
REM 7-Zip is required (https://www.7-zip.org/). The archive is password
REM protected and its header is encrypted, so file names are hidden too.
REM Store the password in a password manager, NOT in this repo or the vault.

set "PROJECT_DIR=%~dp0"

if "%FAMILY_BOARD_BACKUP_DIR%"=="" (
    echo ERROR: FAMILY_BOARD_BACKUP_DIR is not set.
    echo Choose a secure folder that is NOT synced to OneDrive/Dropbox/iCloud,
    echo then: set FAMILY_BOARD_BACKUP_DIR=path\to\that\folder
    exit /b 1
)

if not exist "%FAMILY_BOARD_BACKUP_DIR%" (
    echo ERROR: backup folder does not exist: %FAMILY_BOARD_BACKUP_DIR%
    exit /b 1
)

if not exist "%PROJECT_DIR%server_config.py" (
    echo ERROR: server_config.py is missing from %PROJECT_DIR%
    exit /b 1
)

if not exist "%PROJECT_DIR%token_store.json" (
    echo ERROR: token_store.json is missing from %PROJECT_DIR%
    exit /b 1
)

set "7Z=C:\Program Files\7-Zip\7z.exe"
if not exist "%7Z%" set "7Z=C:\Program Files (x86)\7-Zip\7z.exe"
if not exist "%7Z%" set "7Z=7z.exe"

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "STAMP=%%I"

set "ARCHIVE=%FAMILY_BOARD_BACKUP_DIR%\family-board-%STAMP%.7z"

echo.
echo Creating encrypted archive:
echo   %ARCHIVE%
echo.
echo You will be asked for a password twice. Use a non-empty password and
echo save it in your password manager; there is no recovery if it is lost.
echo.

pushd "%PROJECT_DIR%"
"%7Z%" a -t7z -mhe=on -p "%ARCHIVE%" server_config.py token_store.json
set "RC=%ERRORLEVEL%"
popd

if not "%RC%"=="0" (
    echo.
    echo Backup failed. Nothing was removed.
    exit /b 1
)

echo.
echo Done. Verify the archive opens with your password, and keep it outside
echo any cloud-synced folder. Do not delete older backups until the new one
echo has been tested.
