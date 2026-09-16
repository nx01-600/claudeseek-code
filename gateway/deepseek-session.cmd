@echo off
rem Sesion interactiva de Claude Code completa sobre DeepSeek.
rem Acotada a esta ventana: las demas sesiones de Claude no se enteran.
node "%~dp0deepseek-session.mjs" %*
