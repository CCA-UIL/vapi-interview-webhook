#!/usr/bin/env bash
# Trigger a Phase 1 call.
# Usage:   bash scripts/start-call.sh <phone-number> [name]
# Example: bash scripts/start-call.sh +15551234567 Janet
#
# Sources .env from the repo root to pick up START_CALL_API_KEY. If set,
# it's sent as the X-API-Key header.

set -e

PHONE="${1:-}"
NAME="${2:-}"

if [ -z "$PHONE" ]; then
  echo "Usage: bash scripts/start-call.sh <phone-number> [name]"
  echo "Example: bash scripts/start-call.sh +15551234567 Janet"
  exit 1
fi

# Source .env from the repo root so START_CALL_API_KEY (and SERVER_URL
# override, if any) is loaded.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

SERVER_URL="${SERVER_URL:-https://vapi-interview-webhook.onrender.com}"

AUTH_HEADER=()
if [ -n "${START_CALL_API_KEY:-}" ]; then
  AUTH_HEADER=(-H "X-API-Key: $START_CALL_API_KEY")
fi

curl -s -w "\nHTTP %{http_code}\n" -X POST "$SERVER_URL/start-call" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  -d "{\"customerNumber\":\"$PHONE\",\"name\":\"$NAME\"}"
