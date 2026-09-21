@echo off
rem Full interactive Claude Code session running on DeepSeek.
rem Scoped to this window: other Claude sessions are unaffected.
node "%~dp0deepseek-session.mjs" %*
