#!/usr/bin/env bash
# Generate RS256 key pair and JWT_REFRESH_SECRET for production.
# Usage:
#   ./scripts/gen-jwt-keys.sh           # print to stdout
#   ./scripts/gen-jwt-keys.sh >> .env   # append to existing .env
set -euo pipefail

require() { command -v "$1" &>/dev/null || { echo "ERROR: '$1' is required but not found." >&2; exit 1; }; }
require openssl

PRIVATE_KEY=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 2>/dev/null)
PUBLIC_KEY=$(echo "$PRIVATE_KEY" | openssl rsa -pubout 2>/dev/null)

# Encode as single-line with literal \n so the value is safe inside .env
private_oneline=$(echo "$PRIVATE_KEY" | awk '{printf "%s\\n", $0}')
public_oneline=$(echo "$PUBLIC_KEY"  | awk '{printf "%s\\n", $0}')

REFRESH_SECRET=$(openssl rand -hex 32)

cat <<EOF
JWT_PRIVATE_KEY="${private_oneline}"
JWT_PUBLIC_KEY="${public_oneline}"
JWT_REFRESH_SECRET="${REFRESH_SECRET}"
EOF
