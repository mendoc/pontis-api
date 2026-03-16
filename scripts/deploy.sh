#!/bin/sh
set -eu

REGISTRY="ghcr.io"
IMAGE="ghcr.io/mendoc/pontis-api"
VERSION=$(node -p "require('./package.json').version")

# ── Login ────────────────────────────────────────────────────────────────────
if [ -z "${GHCR_TOKEN:-}" ]; then
  echo "GHCR_TOKEN is not set" >&2
  exit 1
fi

echo "${GHCR_TOKEN}" | docker login "${REGISTRY}" -u mendoc --password-stdin

# ── Build ────────────────────────────────────────────────────────────────────
echo "→ Building ${IMAGE}:${VERSION} ..."
docker build \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:latest" \
  .

# ── Push ─────────────────────────────────────────────────────────────────────
echo "→ Pushing ${IMAGE}:${VERSION} ..."
docker push "${IMAGE}:${VERSION}"

echo "→ Pushing ${IMAGE}:latest ..."
docker push "${IMAGE}:latest"

echo "✓ Done — ${IMAGE}:${VERSION} and :latest pushed to GHCR"
