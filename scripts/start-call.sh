#!/usr/bin/env bash
# Trigger a Phase 1 call.
# Usage:   bash scripts/start-call.sh <phone-number> [name]
# Example: bash scripts/start-call.sh +15551234567 Janet

set -e

PHONE="${1:-}"
NAME="${2:-}"

if [ -z "$PHONE" ]; then
  echo "Usage: bash scripts/start-call.sh <phone-number> [name]"
  echo "Example: bash scripts/start-call.sh +15551234567 Janet"
  exit 1
fi

# Default to the deployed Render URL; override with: SERVER_URL=http://localhost:3000 bash scripts/start-call.sh ...
SERVER_URL="${SERVER_URL:-https://vapi-interview-webhook.onrender.com}"

curl -s -w "\nHTTP %{http_code}\n" -X POST "$SERVER_URL/start-call" \
  -H "Content-Type: application/json" \
  -d "{\"customerNumber\":\"$PHONE\",\"name\":\"$NAME\"}"
