@echo off
rem Global shortcut: "deepseek" instead of the full path to deepseek-session.
rem Installed in %USERPROFILE%\.local\bin (already in PATH, alongside claude.exe).
node "%USERPROFILE%\.claude\deepseek-gateway\deepseek-session.mjs" %*
