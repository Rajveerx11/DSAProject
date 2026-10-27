@echo off
rem Double-click: runs only the C backend with a menu for typing inputs (no browser). Steps live in backend.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend.ps1"
