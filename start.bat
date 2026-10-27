@echo off
setlocal
rem Double-click: build C server in WSL, launch it on a free temporary port, open the UI.
rem 127.0.0.1, not localhost: WSL forwards IPv4 only, and browsers may resolve localhost to ::1.
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

rem ponytail: OS picks a free loopback port; tiny race until the server binds it.
for /f %%p in ('powershell -NoProfile -Command "$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()"') do set "PORT=%%p"
if not defined PORT (echo Could not find a free port. & pause & exit /b 1)

echo Building...
wsl.exe --cd "%ROOT%" -- make
if errorlevel 1 (echo Build failed. & pause & exit /b 1)

start "Musiclab server :%PORT% (close to stop)" wsl.exe --cd "%ROOT%" -- ./build/musiclab --port %PORT%

echo Waiting for http://127.0.0.1:%PORT% ...
for /l %%i in (1,1,20) do (
  curl.exe -s -o nul http://127.0.0.1:%PORT%/ && goto up
  timeout /t 1 /nobreak >nul
)
echo Server did not start. Check the server window. & pause & exit /b 1

:up
start "" http://127.0.0.1:%PORT%/
echo Musiclab running at http://127.0.0.1:%PORT%/  -- close the server window to stop.
