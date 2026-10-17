@echo off
setlocal

REM Family Board kiosk launcher — v2
REM Fixes from the first version:
REM  - Chrome now gets its own dedicated profile (--user-data-dir), which
REM    forces a genuinely new Chrome process instead of silently handing
REM    the URL to whatever Chrome window you already had open (that
REM    silent hand-off is why --kiosk was being ignored before, and why
REM    theme/calendar selections weren't sticking reliably).
REM  - The server now runs in its own titled console window instead of
REM    fully hidden, so you can actually see it and close/Ctrl+C it to
REM    stop or restart. Switch to the hidden pythonw version (see the
REM    bottom of this file) once everything's solid and you want it to
REM    truly run invisibly.

REM EDIT THIS ONE PATH if Chrome isn't installed in the default location.
set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe

REM Computed automatically from where this .bat file lives — no need to
REM hardcode your username or project path.
set PROJECT_DIR=%~dp0
set KIOSK_PROFILE=%PROJECT_DIR%chrome-kiosk-profile

echo Starting Family Board server...
start "Family Board Server" cmd /k python "%PROJECT_DIR%server.py"

echo Waiting for the server to come up...
timeout /t 3 /nobreak >nul

echo Launching Chrome in kiosk mode...
start "" "%CHROME_PATH%" --kiosk --user-data-dir="%KIOSK_PROFILE%" --app=http://localhost:5000

echo.
echo Done.
echo   - The server is running in its own window titled "Family Board Server".
echo     Close that window (or click into it and press Ctrl+C) to stop it.
echo   - Press Alt+F4 in the Chrome kiosk window to exit full-screen mode.
echo   - Chrome's kiosk profile lives in: %KIOSK_PROFILE%
echo     (delete that folder if you ever want to reset it to a clean slate)

endlocal

REM ---------------------------------------------------------------------
REM Once you've confirmed everything works and you're ready to make this
REM a true invisible background service, swap the "start" line above for:
REM
REM   start /min pythonw "%PROJECT_DIR%server.py"
REM
REM That removes the visible console window entirely. At that point,
REM stopping it means using stop-kiosk.bat or Task Manager instead.
REM ---------------------------------------------------------------------
