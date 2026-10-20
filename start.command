#!/bin/sh
# start.command — macOS launcher (double-click in Finder). Linux: sh start.command.
# Needs Node (nodejs.org). Opens the game on localhost: the camera needs a secure origin.
cd "$(dirname "$0")"
( sleep 1; open http://localhost:8068/ 2>/dev/null || xdg-open http://localhost:8068/ 2>/dev/null ) &
node serve.js
