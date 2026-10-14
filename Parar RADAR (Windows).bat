@echo off
rem Desliga o ecco RADAR. Seus dados ficam guardados para a proxima vez.
chcp 65001 >nul
cd /d "%~dp0"
docker compose down && echo RADAR desligado. Seus dados continuam guardados.
pause
