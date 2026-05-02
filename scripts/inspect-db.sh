#!/usr/bin/env bash
# Inspect the Supabase tables. Loads .env automatically.
# Usage:   bash scripts/inspect-db.sh [participants|sessions|scheduled_calls]
# Default: shows all three.

set -e
cd "$(dirname "$0")/.."
set -a
source .env
set +a

show() {
  echo
  echo "=== $1 ==="
  curl -s "$SUPABASE_URL/rest/v1/$1?select=*&order=created_at.desc&limit=20" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
  echo
}

if [ -n "$1" ]; then
  show "$1"
else
  show participants
  show sessions
  show scheduled_calls
fi
