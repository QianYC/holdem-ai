@echo off
rem Start the hold'em server in the background (if not running) and open the table in the browser.
cd /d "%~dp0"
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3095/state -TimeoutSec 2 | Out-Null } catch { Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'src/server.js' -WorkingDirectory '%~dp0'; Start-Sleep 2 }"
start "" http://127.0.0.1:3095
