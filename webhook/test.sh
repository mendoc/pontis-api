#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:9000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load secret from .env if not already set
if [[ -z "${GITHUB_WEBHOOK_SECRET:-}" ]]; then
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    GITHUB_WEBHOOK_SECRET="$(grep '^GITHUB_WEBHOOK_SECRET=' "$SCRIPT_DIR/.env" | cut -d= -f2-)"
  fi
fi

if [[ -z "${GITHUB_WEBHOOK_SECRET:-}" ]]; then
  echo "ERROR: GITHUB_WEBHOOK_SECRET not set and not found in .env" >&2
  exit 1
fi

# Extract repo info from real payload
FULL_NAME=$(node -p "require('$SCRIPT_DIR/payload.json').repository.full_name")
DEFAULT_BRANCH=$(node -p "require('$SCRIPT_DIR/payload.json').repository.default_branch")
SLUG=$(node -p "require('$SCRIPT_DIR/payload.json').repository.name")

# Build push payload from real repo metadata
PAYLOAD=$(node -e "
const p = require('$SCRIPT_DIR/payload.json');
console.log(JSON.stringify({
  ref: 'refs/heads/' + p.repository.default_branch,
  after: p.repository.pushed_at,
  repository: {
    name: p.repository.name,
    full_name: p.repository.full_name,
    default_branch: p.repository.default_branch
  }
}));
")

SIG="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')"

echo "==> Deploy: $BASE_URL/deploy/$SLUG"
echo "    repo:   $FULL_NAME (branch: $DEFAULT_BRANCH)"
echo

curl -s -w "\nHTTP %{http_code}\n" \
  -X POST "$BASE_URL/deploy/$SLUG" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$PAYLOAD"
