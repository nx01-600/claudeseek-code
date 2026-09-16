@echo off
rem Atajo global: "deepseek" en vez de la ruta completa a deepseek-session.
rem Instalado en %USERPROFILE%\.local\bin (ya está en el PATH, junto a claude.exe).
node "%USERPROFILE%\.claude\deepseek-gateway\deepseek-session.mjs" %*
