@echo off
setlocal

echo Stopping the Family Board server window...
taskkill /FI "WINDOWTITLE eq Family Board Server*" /T /F >nul 2>&1

echo Closing the kiosk Chrome window (only the one using the kiosk profile —
echo any other Chrome windows you have open are left alone)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*chrome-kiosk-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo Done. Run start-kiosk.bat again when you're ready to relaunch.
endlocal
