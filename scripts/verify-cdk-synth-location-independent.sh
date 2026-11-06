#!/usr/bin/env bash
# Purpose: prove CDK example templates hash identically from a relocated copy.
#
# scripts/verify-cdk-synth.sh pins one SHA-256 per example. A hash only proves
# location independence if synthesis from another absolute path produces the
# same bytes, so this gate copies the working tree (without dependency trees or
# build output), synthesizes there, and requires every pinned hash to match
# again. Nothing outside $HOME is written: the copy is scratch for the Docker
# share and is removed unless --keep is passed.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$(pwd -P)"

keep=0
for arg in "$@"; do
  case "${arg}" in
    --keep) keep=1 ;;
    *) echo "cdk-synth-location-independent: FAIL (unknown argument ${arg})" >&2; exit 2 ;;
  esac
done

if ! command -v rsync >/dev/null 2>&1; then
  echo "cdk-synth-location-independent: BLOCKED (rsync not found)" >&2
  exit 2
fi

scratch="${APPTHEORY_CDK_SYNTH_COPY_DIR:-${HOME}/.cache/apptheory-cdk-synth-location-independent}"
copy="${scratch}/repo"
rm -rf "${scratch}"
mkdir -p "${copy}"

# Exclude every dependency tree, build output and VCS/agent materialization so
# the copy is a source tree, not a second checkout. ts/dist stays: it is
# checked-in build output that the assets consume. The lambda-packaging example
# commits a Lambda layer's node_modules content (Lambda reads it from
# /opt/nodejs/node_modules), so that path is source and the include rules keep
# it before the node_modules exclusion.
rsync -a \
  --exclude '.git' \
  --include 'examples/cdk/lambda-packaging/layers/node/nodejs/node_modules/' \
  --include 'examples/cdk/lambda-packaging/layers/node/nodejs/node_modules/**' \
  --exclude 'node_modules' \
  --exclude 'cdk.out' \
  --exclude '.cdk-asset-stage' \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '.ruff_cache' \
  --exclude '/dist' \
  --exclude '.theorymcp' \
  --exclude '.agents' \
  --exclude '.claude' \
  --exclude '.codex' \
  --exclude '.kimi-code' \
  --exclude 'gov-infra/evidence' \
  "${root}/." "${copy}/"

epoch="0"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  epoch="$(git show -s --format=%ct HEAD)"
fi
export SOURCE_DATE_EPOCH="${epoch}"

echo "cdk-synth-location-independent: synthesizing ${copy}"
if ! (cd "${copy}" && bash scripts/verify-cdk-synth.sh); then
  echo "cdk-synth-location-independent: FAIL (copied checkout did not reproduce the pinned hashes)" >&2
  exit 1
fi

if [[ "${keep}" -eq 0 ]]; then
  rm -rf "${scratch}"
fi
echo "cdk-synth-location-independent: PASS"
