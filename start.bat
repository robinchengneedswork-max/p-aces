@echo off
cd /d "%~dp0"
start "" http://localhost:8068/
node serve.js
