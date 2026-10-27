@echo off
rem Double-click launcher: runs start.ps1. Bypass only lifts PowerShell's script block for this one run.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
