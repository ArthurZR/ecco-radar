@echo off
rem Liga o ecco RADAR no Windows. Clique duas vezes neste arquivo.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\iniciar-radar.ps1"
