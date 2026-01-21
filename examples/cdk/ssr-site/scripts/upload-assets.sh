#!/usr/bin/env bash
set -euo pipefail

if ! command -v aws >/dev/null 2>&1; then
  echo "missing aws cli (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)" >&2
  exit 1
fi

ASSETS_DIR="${ASSETS_DIR:-assets}"
ASSETS_BUCKET="${ASSETS_BUCKET:-}"
ASSETS_PREFIX="${ASSETS_PREFIX:-assets}"
MANIFEST_FILE="${MANIFEST_FILE:-$ASSETS_DIR/manifest.json}"
MANIFEST_KEY="${MANIFEST_KEY:-$ASSETS_PREFIX/manifest.json}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-}"
SYNC_DELETE="${SYNC_DELETE:-1}"

if [[ -z "$ASSETS_BUCKET" ]]; then
  echo "ASSETS_BUCKET is required" >&2
  echo "Example:" >&2
  echo "  ASSETS_BUCKET=my-bucket ASSETS_PREFIX=assets ./scripts/upload-assets.sh" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST_FILE" ]]; then
  echo "manifest file not found: $MANIFEST_FILE" >&2
  echo "Generate one with:" >&2
  echo "  node scripts/generate-assets-manifest.mjs --assets-dir $ASSETS_DIR --out $MANIFEST_FILE" >&2
  exit 1
fi

delete_flag=""
if [[ "$SYNC_DELETE" == "1" ]]; then
  delete_flag="--delete"
fi

echo "syncing assets -> s3://$ASSETS_BUCKET/$ASSETS_PREFIX/ (excluding manifest.json)"
aws s3 sync "$ASSETS_DIR" "s3://$ASSETS_BUCKET/$ASSETS_PREFIX/" \
  $delete_flag \
  --exclude "manifest.json" \
  --cache-control "public, max-age=31536000, immutable" \
  --only-show-errors

echo "uploading manifest -> s3://$ASSETS_BUCKET/$MANIFEST_KEY"
aws s3 cp "$MANIFEST_FILE" "s3://$ASSETS_BUCKET/$MANIFEST_KEY" \
  --cache-control "no-cache, max-age=0, must-revalidate" \
  --content-type "application/json" \
  --only-show-errors

if [[ -n "$DISTRIBUTION_ID" ]]; then
  echo "invalidating CloudFront path /$MANIFEST_KEY (distribution $DISTRIBUTION_ID)"
  aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/$MANIFEST_KEY" \
    >/dev/null
fi
