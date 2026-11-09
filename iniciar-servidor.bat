@echo off
cd /d "%~dp0"
title Servidor de Ligacoes
set TOKEN=caue299792458
set PORT=8090
:loop
node server.js
echo Servidor parou. Reiniciando em 5 segundos...
timeout /t 5 >nul
goto loop
