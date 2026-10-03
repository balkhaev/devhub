@echo off
rem Opens the hub in the browser, starting it hidden in the background when it is not running.
bun "%~dp0src\open.ts"
if errorlevel 1 pause
