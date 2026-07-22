#!/usr/bin/env bash
# Purpose: prove release-please credentials never cross an npm or OS argument boundary.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() {
  echo "release-please-token-safety: FAIL ($1)" >&2
  exit 1
}

wrapper="scripts/run-release-please-pr.sh"
transport="scripts/invoke-release-please-pr.sh"
launcher="scripts/invoke-release-please-pr.mjs"
stager="scripts/stage-release-please-package.sh"

[[ -f "${transport}" ]] || fail "missing environment-only transport ${transport}"
[[ -f "${launcher}" ]] || fail "missing environment-only launcher ${launcher}"
[[ -f "${stager}" ]] || fail "missing credential-free package stager ${stager}"

if grep -Fq -- '--token' "${wrapper}" "${transport}" "${stager}"; then
  fail "shell release wrappers must never place a token on a command line"
fi

grep -Fq 'bash scripts/invoke-release-please-pr.sh' "${wrapper}" ||
  fail "release wrapper must enter the environment-only transport"
grep -Fq 'unset RELEASE_PLEASE_TOKEN GH_TOKEN GITHUB_TOKEN' "${transport}" ||
  fail "transport must remove all GitHub credentials before entering npm"
grep -Fq 'release-please@17.1.3' "${stager}" ||
  fail "credential-free npm boundary must pin release-please"
grep -Fq 'GitHub credentials are forbidden at the npm boundary' "${stager}" ||
  fail "npm boundary must fail closed when any GitHub credential is present"

grep -Fq 'requiredEnvironment("RELEASE_PLEASE_TOKEN")' "${launcher}" ||
  fail "launcher must read the release credential from the environment"
grep -Fq 'parser.parseAsync(releasePleaseArgs)' "${launcher}" ||
  fail "launcher must call the pinned release-please parser in-process"
grep -Fq '`${options.message}\n\n[skip ci]`' "${launcher}" ||
  fail "release-please commits must suppress redundant pull_request CI events"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-token-safety.XXXXXX")"
cleanup() {
  rm -rf -- "${test_root}"
}
trap cleanup EXIT

mkdir -p "${test_root}/bin"
cat > "${test_root}/bin/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${RELEASE_PLEASE_TOKEN:-}" || -n "${GH_TOKEN:-}" || -n "${GITHUB_TOKEN:-}" ]]; then
  echo "fake-npm: FAIL (received a GitHub credential)" >&2
  exit 1
fi

prefix=""
found_pin="false"
found_ignore_scripts="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      prefix="${2:-}"
      shift 2
      ;;
    --ignore-scripts)
      found_ignore_scripts="true"
      shift
      ;;
    release-please@17.1.3)
      found_pin="true"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "${prefix}" || "${found_pin}" != "true" || "${found_ignore_scripts}" != "true" ]]; then
  echo "fake-npm: FAIL (unsafe package staging arguments)" >&2
  exit 1
fi

module_dir="${prefix}/node_modules/release-please/build/src/bin"
code_suggester_dir="${prefix}/node_modules/code-suggester/build/src"
mkdir -p "${module_dir}"
mkdir -p "${code_suggester_dir}"
cat > "${prefix}/node_modules/code-suggester/package.json" <<'FAKE_CODE_SUGGESTER_PACKAGE'
{"name":"code-suggester","main":"build/src/index.js"}
FAKE_CODE_SUGGESTER_PACKAGE
cat > "${code_suggester_dir}/index.js" <<'FAKE_CODE_SUGGESTER'
exports.createPullRequest = async (_octokit, _changes, options) => {
  if (typeof options?.message !== "string" || !options.message.endsWith("\n\n[skip ci]")) {
    throw new Error("release-please commit did not suppress redundant pull_request CI");
  }
};
FAKE_CODE_SUGGESTER
cat > "${module_dir}/release-please.js" <<'FAKE_MODULE'
const fs = require("node:fs");
const codeSuggester = require("code-suggester");

exports.parser = {
  parseAsync: async (args) => {
    const token = process.env.RELEASE_PLEASE_TOKEN ?? "";
    const kernelArgv = fs.existsSync("/proc/self/cmdline")
      ? fs.readFileSync("/proc/self/cmdline").toString("utf8")
      : process.argv.join("\0");

    if (!token || args[0] !== "release-pr" || args[1] !== "--token" || args[2] !== token) {
      throw new Error("credential did not reach only the in-memory parser arguments");
    }
    if (kernelArgv.includes(token)) {
      throw new Error("credential crossed the OS process argument boundary");
    }
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
      throw new Error("ambient GitHub credentials reached the release-please process");
    }

    await codeSuggester.createPullRequest(null, null, { message: "chore: release test" });
    console.log("release-please-token-transport: PASS");
  },
};
FAKE_MODULE
FAKE_NPM
chmod +x "${test_root}/bin/npm"

sentinel='release-please-token-safety-sentinel-do-not-log'
output="$({
  RELEASE_PLEASE_TOKEN="${sentinel}" \
    GH_TOKEN="${sentinel}-gh" \
    GITHUB_TOKEN="${sentinel}-github" \
    RELEASE_PLEASE_REPO_URL="theory-cloud/AppTheory" \
    RELEASE_PLEASE_TARGET_BRANCH="premain" \
    RELEASE_PLEASE_CONFIG_FILE="release-please-config.premain.json" \
    RELEASE_PLEASE_MANIFEST_FILE=".release-please-manifest.premain.json" \
    PATH="${test_root}/bin:${PATH}" \
    bash "${transport}"
} 2>&1)" || {
  printf '%s\n' "${output}" >&2
  fail "environment-only launcher self-test failed"
}

if [[ "${output}" == *"${sentinel}"* || "${output}" == *"${sentinel}-gh"* || "${output}" == *"${sentinel}-github"* ]]; then
  fail "launcher emitted the credential sentinel"
fi
if [[ "${output}" != *"release-please-token-transport: PASS"* ]]; then
  printf '%s\n' "${output}" >&2
  fail "launcher self-test did not report success"
fi

echo "release-please-token-safety: PASS"
