@echo off
cd /d "%~dp0"
title Relay Yealink
:loop
node relay.js
echo Relay parou. Reiniciando em 5 segundos...
timeout /t 5 >nul
goto loop
