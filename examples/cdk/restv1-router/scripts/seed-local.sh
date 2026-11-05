#!/bin/sh
# Seed the local REST v1 router through the app's own handler.
#
# `apptheory-local session --seed <this script>` runs it after provisioning and
# before `local-run: ready`. APPTHEORY_LOCAL_APIS carries each served URL:
# [{"class":"restv1","logicalId":"...","url":"http://127.0.0.1:..."}].
set -eu

api_url=$(printf '%s' "${APPTHEORY_LOCAL_APIS:-}" |
    sed -n 's/.*"class":"restv1"[^}]*"url":"\([^"]*\)".*/\1/p' | head -n 1)
if [ -z "$api_url" ]; then
    echo "seed-local: no restv1 URL in APPTHEORY_LOCAL_APIS" >&2
    exit 1
fi

curl -fsS -X PUT "$api_url/inventory/seeded-item" \
    -H 'content-type: application/json' \
    -d '{"id":"seeded-item","name":"Seeded Widget","quantity":7}' >/dev/null
curl -fsS "$api_url/inventory/seeded-item" | grep -q 'Seeded Widget'
echo "seed-local: wrote and read inventory/seeded-item"
