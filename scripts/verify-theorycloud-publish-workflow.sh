#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKFLOW_FILE="${REPO_ROOT}/.github/workflows/theorycloud-apptheory-subtree-publish.yml"

fail() {
  echo "verify-theorycloud-publish-workflow: FAIL ($*)" >&2
  exit 1
}

assert_file_contains() {
  local needle="$1"
  if ! grep -Fq -- "${needle}" "${WORKFLOW_FILE}"; then
    fail "expected workflow to contain '${needle}'"
  fi
}

assert_file_not_contains() {
  local needle="$1"
  if grep -Fq -- "${needle}" "${WORKFLOW_FILE}"; then
    fail "workflow must not contain '${needle}'"
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if ! grep -Fq -- "${needle}" <<<"${haystack}"; then
    fail "expected block to contain '${needle}'"
  fi
}

if [[ ! -f "${WORKFLOW_FILE}" ]]; then
  fail "missing workflow file ${WORKFLOW_FILE}"
fi

bash -n \
  "${REPO_ROOT}/scripts/stage-theorycloud-apptheory-subtree.sh" \
  "${REPO_ROOT}/scripts/verify-theorycloud-apptheory-subtree.sh" \
  "${REPO_ROOT}/scripts/theorycloud-apptheory-env.sh" \
  "${REPO_ROOT}/scripts/sync-theorycloud-apptheory-subtree.sh" \
  "${REPO_ROOT}/scripts/trigger-theorycloud-publish.sh" \
  "${REPO_ROOT}/scripts/verify-theorycloud-apptheory-publish-config.sh" \
  "${REPO_ROOT}/scripts/verify-theorycloud-publish-workflow.sh"

bash "${REPO_ROOT}/scripts/verify-theorycloud-apptheory-publish-config.sh"
THEORYCLOUD_STAGE=lab \
THEORYCLOUD_PUBLISH_REASON='github:theory-cloud/AppTheory:premain' \
AWS_REGION=us-east-1 \
AWS_ROLE_ARN='arn:aws:iam::787107040121:role/KnowledgeTheory-TheoryCloud-AppTheory-lab-Publisher' \
  bash "${REPO_ROOT}/scripts/verify-theorycloud-apptheory-publish-config.sh"
THEORYCLOUD_STAGE=live \
THEORYCLOUD_PUBLISH_REASON='github:theory-cloud/AppTheory:main' \
AWS_REGION=us-east-1 \
AWS_ROLE_ARN='arn:aws:iam::787107040121:role/KnowledgeTheory-TheoryCloud-AppTheory-live-Publisher' \
  bash "${REPO_ROOT}/scripts/verify-theorycloud-apptheory-publish-config.sh"

assert_file_contains "name: AppTheory TheoryCloud subtree publish"
assert_file_contains "permissions:"
assert_file_contains "  contents: read"
assert_file_contains "  id-token: write"
assert_file_contains "group: apptheory-theorycloud-subtree-publish-\${{ github.ref_name }}"
assert_file_contains "AWS_REGION: us-east-1"
assert_file_contains "THEORYCLOUD_STAGE: \${{ github.ref_name == 'premain' && 'lab' || github.ref_name == 'main' && 'live' || '' }}"
assert_file_contains "AWS_ROLE_ARN: \${{ github.ref_name == 'premain' && 'arn:aws:iam::787107040121:role/KnowledgeTheory-TheoryCloud-AppTheory-lab-Publisher' || github.ref_name == 'main' && 'arn:aws:iam::787107040121:role/KnowledgeTheory-TheoryCloud-AppTheory-live-Publisher' || '' }}"
assert_file_contains "THEORYCLOUD_PUBLISH_REASON: \${{ format('github:{0}:{1}', github.repository, github.ref_name) }}"
assert_file_contains "uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2"
assert_file_contains "uses: aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a # v4"
assert_file_contains "bash scripts/verify-theorycloud-publish-workflow.sh"
assert_file_contains "bash scripts/sync-theorycloud-apptheory-subtree.sh \\"
assert_file_contains "bash scripts/trigger-theorycloud-publish.sh \\"
assert_file_not_contains "Install awscurl"
assert_file_not_contains "pip install --user awscurl"
assert_file_not_contains "vars.AWS_REGION"
assert_file_not_contains "vars.THEORYCLOUD_AWS_ROLE_ARN_LAB"
assert_file_not_contains "vars.THEORYCLOUD_AWS_ROLE_ARN_LIVE"

branches_block="$(awk '
  /^    branches:$/ {capture=1; next}
  capture && /^[[:space:]]{4}[A-Za-z0-9_-]+:/ {exit}
  capture && /^[^[:space:]]/ {exit}
  capture {print}
' "${WORKFLOW_FILE}")"
assert_contains "${branches_block}" "- premain"
assert_contains "${branches_block}" "- main"

paths_block="$(awk '
  /^    paths:$/ {capture=1; next}
  capture && /^[^[:space:]]/ {exit}
  capture {print}
' "${WORKFLOW_FILE}")"

for required_path in \
  '".github/workflows/theorycloud-apptheory-subtree-publish.yml"' \
  '"docs/README.md"' \
  '"docs/_contract.yaml"' \
  '"docs/_concepts.yaml"' \
  '"docs/_patterns.yaml"' \
  '"docs/_decisions.yaml"' \
  '"docs/getting-started.md"' \
  '"docs/api-reference.md"' \
  '"docs/core-patterns.md"' \
  '"docs/testing-guide.md"' \
  '"docs/troubleshooting.md"' \
  '"docs/migration-guide.md"' \
  '"docs/cdk/**"' \
  '"docs/features/**"' \
  '"docs/integrations/**"' \
  '"docs/migration/**"' \
  '"docs/llm-faq/**"' \
  '"scripts/stage-theorycloud-apptheory-subtree.sh"' \
  '"scripts/theorycloud-apptheory-env.sh"' \
  '"scripts/sync-theorycloud-apptheory-subtree.sh"' \
  '"scripts/trigger-theorycloud-publish.sh"' \
  '"scripts/verify-theorycloud-apptheory-publish-config.sh"' \
  '"scripts/verify-theorycloud-publish-workflow.sh"'
do
  assert_contains "${paths_block}" "${required_path}"
done

for disallowed_path in \
  'docs/development/' \
  'docs/planning/' \
  'docs/internal/' \
  'docs/archive/' \
  'docs/development-guidelines.md'
do
  if grep -Fq "${disallowed_path}" <<<"${paths_block}"; then
    fail "workflow paths unexpectedly include out-of-scope content: ${disallowed_path}"
  fi
done

echo "verify-theorycloud-publish-workflow: PASS"
