#!/usr/bin/env bash
# ──────────────────────────────────────────────
# Shut down the full dev stack — EVERY port, not just Node.
#
# The original shutdown swept only 3000/4000–4010 and missed analytics
# (:5001) and the Go engines (:6001–6003): a stale analytics process kept
# serving the OLD demo database, and the dashboard "bug" chased for an hour
# was that zombie returning honest zeros for a branch that exists only in
# the setup DB. This script is the cure: kill by stack port list, then
# verify nothing is left listening.
# ──────────────────────────────────────────────
set -u
cd "$(dirname "$0")/.."   # repo root

# 3000 web · 4000 gateway · 4001–4010 Node services · 5001 analytics ·
# 5002 ai-service · 6001–6003 Go engines
PORTS="3000 4000 4001 4002 4003 4004 4005 4006 4007 4008 4009 4010 5001 5002 6001 6002 6003"

PIDS=$(netstat -ano | grep LISTENING | grep -E ":($(echo $PORTS | tr ' ' '|')) " | awk '{print $5}' | sort -u)

if [ -z "$PIDS" ]; then
  echo "nothing listening on stack ports — already down"
  exit 0
fi

for pid in $PIDS; do
  # Never kill ourselves or a non-task process blindly; taskkill is targeted.
  taskkill //F //PID "$pid" 2>/dev/null && echo "killed PID $pid" || echo "PID $pid already gone"
done

sleep 2
LEFT=$(netstat -ano | grep LISTENING | grep -E ":($(echo $PORTS | tr ' ' '|')) " | awk '{print $5}' | sort -u)
if [ -z "$LEFT" ]; then
  echo "stack fully down — all stack ports clear"
else
  echo "WARNING: still listening: $LEFT"
  exit 1
fi
