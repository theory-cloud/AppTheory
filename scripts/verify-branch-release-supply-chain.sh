#!/usr/bin/env bash
set -euo pipefail

# Verifies required branch/release supply-chain artifacts exist and are wired for the expected flow:
# - `premain` -> prereleases (RCs)
# - `main` -> stable releases
#
# This is a deterministic grep-based check (not a full YAML parser).

failures=0

required_files=(
  "docs/development/planning/apptheory/supporting/apptheory-versioning-and-release-policy.md"
  ".github/workflows/ci.yml"
  ".github/workflows/prerelease.yml"
  ".github/workflows/prerelease-pr.yml"
  ".github/workflows/release.yml"
  ".github/workflows/release-pr.yml"
  "release-please-config.premain.json"
  "release-please-config.json"
  ".release-please-manifest.premain.json"
  ".release-please-manifest.json"
  "scripts/verify-branch-version-sync.sh"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "${f}" ]]; then
    echo "branch-release: missing ${f}"
    failures=$((failures + 1))
  fi
done

if [[ -f ".github/workflows/ci.yml" ]]; then
  # Staging is the integration branch in the documented TableTheory-style flow; it must run CI on merge.
  grep -Eq 'branches:' ".github/workflows/ci.yml" || {
    echo "branch-release: ci workflow must define push branches"
    failures=$((failures + 1))
  }
  grep -Eq '^\s*-\s*staging\s*$' ".github/workflows/ci.yml" || {
    echo "branch-release: ci workflow must run on staging pushes"
    failures=$((failures + 1))
  }
  grep -Eq '^\s*-\s*premain\s*$' ".github/workflows/ci.yml" || {
    echo "branch-release: ci workflow must run on premain pushes"
    failures=$((failures + 1))
  }
  grep -Eq '^\s*-\s*main\s*$' ".github/workflows/ci.yml" || {
    echo "branch-release: ci workflow must run on main pushes"
    failures=$((failures + 1))
  }
fi

if [[ -f ".github/workflows/prerelease.yml" ]]; then
  grep -Eq 'branches:.*premain' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must target premain"
    failures=$((failures + 1))
  }
  grep -Eq 'googleapis/release-please-action@[0-9a-fA-F]{40}.*\bv4\b' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must pin release-please v4 by commit SHA"
    failures=$((failures + 1))
  }
  grep -Eq 'contents:\s*write' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must request contents: write"
    failures=$((failures + 1))
  }
  grep -Eq 'config-file:\s*release-please-config\.premain\.json' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must reference release-please-config.premain.json"
    failures=$((failures + 1))
  }
  grep -Eq 'manifest-file:\s*\.release-please-manifest\.premain\.json' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must reference .release-please-manifest.premain.json"
    failures=$((failures + 1))
  }

  # Ensure prereleases attach release artifacts.
  grep -Eq 'release_created' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must use release-please outputs (release_created)"
    failures=$((failures + 1))
  }
  grep -Eq 'make rubric' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must build and verify (make rubric)"
    failures=$((failures + 1))
  }
  grep -Eq 'scripts/generate-checksums\.sh' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must generate checksums (scripts/generate-checksums.sh)"
    failures=$((failures + 1))
  }
  grep -Eq 'gh release upload' ".github/workflows/prerelease.yml" || {
    echo "branch-release: prerelease workflow must upload release assets to GitHub release"
    failures=$((failures + 1))
  }
fi

if [[ -f ".github/workflows/release.yml" ]]; then
  grep -Eq 'branches:.*main' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must target main"
    failures=$((failures + 1))
  }
  grep -Eq 'googleapis/release-please-action@[0-9a-fA-F]{40}.*\bv4\b' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must pin release-please v4 by commit SHA"
    failures=$((failures + 1))
  }
  grep -Eq 'contents:\s*write' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must request contents: write"
    failures=$((failures + 1))
  }
  grep -Eq 'config-file:\s*release-please-config\.json' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must reference release-please-config.json"
    failures=$((failures + 1))
  }
  grep -Eq 'manifest-file:\s*\.release-please-manifest\.json' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must reference .release-please-manifest.json"
    failures=$((failures + 1))
  }

  # Ensure stable releases attach release artifacts.
  grep -Eq 'release_created' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must use release-please outputs (release_created)"
    failures=$((failures + 1))
  }
  grep -Eq 'make rubric' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must build and verify (make rubric)"
    failures=$((failures + 1))
  }
  grep -Eq 'scripts/generate-checksums\.sh' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must generate checksums (scripts/generate-checksums.sh)"
    failures=$((failures + 1))
  }
  grep -Eq 'gh release upload' ".github/workflows/release.yml" || {
    echo "branch-release: release workflow must upload release assets to GitHub release"
    failures=$((failures + 1))
  }
fi

if [[ -f ".github/workflows/prerelease-pr.yml" ]]; then
  grep -Eq 'branches:.*premain' ".github/workflows/prerelease-pr.yml" || {
    echo "branch-release: prerelease-pr workflow must target premain"
    failures=$((failures + 1))
  }
  grep -Eq 'googleapis/release-please-action@[0-9a-fA-F]{40}.*\bv4\b' ".github/workflows/prerelease-pr.yml" || {
    echo "branch-release: prerelease-pr workflow must pin release-please v4 by commit SHA"
    failures=$((failures + 1))
  }
  grep -Eq 'config-file:\s*release-please-config\.premain\.json' ".github/workflows/prerelease-pr.yml" || {
    echo "branch-release: prerelease-pr workflow must reference release-please-config.premain.json"
    failures=$((failures + 1))
  }
  grep -Eq 'manifest-file:\s*\.release-please-manifest\.premain\.json' ".github/workflows/prerelease-pr.yml" || {
    echo "branch-release: prerelease-pr workflow must reference .release-please-manifest.premain.json"
    failures=$((failures + 1))
  }
  grep -Eq 'skip-github-release:\s*true' ".github/workflows/prerelease-pr.yml" || {
    echo "branch-release: prerelease-pr workflow must set skip-github-release: true"
    failures=$((failures + 1))
  }
fi

if [[ -f ".github/workflows/release-pr.yml" ]]; then
  grep -Eq 'branches:.*main' ".github/workflows/release-pr.yml" || {
    echo "branch-release: release-pr workflow must target main"
    failures=$((failures + 1))
  }
  grep -Eq 'googleapis/release-please-action@[0-9a-fA-F]{40}.*\bv4\b' ".github/workflows/release-pr.yml" || {
    echo "branch-release: release-pr workflow must pin release-please v4 by commit SHA"
    failures=$((failures + 1))
  }
  grep -Eq 'config-file:\s*release-please-config\.json' ".github/workflows/release-pr.yml" || {
    echo "branch-release: release-pr workflow must reference release-please-config.json"
    failures=$((failures + 1))
  }
  grep -Eq 'manifest-file:\s*\.release-please-manifest\.json' ".github/workflows/release-pr.yml" || {
    echo "branch-release: release-pr workflow must reference .release-please-manifest.json"
    failures=$((failures + 1))
  }
  grep -Eq 'skip-github-release:\s*true' ".github/workflows/release-pr.yml" || {
    echo "branch-release: release-pr workflow must set skip-github-release: true"
    failures=$((failures + 1))
  }

  # Ensure stable releases can promote the RC baseline on premain (e.g., 0.5.0-rc.1 -> 0.5.0),
  # so the stable line never lags behind the prerelease line on promotion.
  grep -Fq "release-as:" ".github/workflows/release-pr.yml" || {
    echo "branch-release: release-pr workflow must set release-as to promote the premain RC baseline"
    failures=$((failures + 1))
  }
  grep -Fq "steps.version.outputs.release_as" ".github/workflows/release-pr.yml" || {
    echo "branch-release: release-pr workflow must pass release-as from computed premain RC baseline"
    failures=$((failures + 1))
  }
  grep -Fq ".release-please-manifest.premain.json" ".github/workflows/release-pr.yml" || {
    echo "branch-release: release-pr workflow must read .release-please-manifest.premain.json to align versions"
    failures=$((failures + 1))
  }
fi

for cfg in "release-please-config.premain.json" "release-please-config.json"; do
  if [[ ! -f "${cfg}" ]]; then
    continue
  fi

  grep -Eq '"extra-files"\s*:' "${cfg}" || {
    echo "branch-release: ${cfg}: must define extra-files for multi-language versioning"
    failures=$((failures + 1))
  }

  # Root VERSION
  grep -Eq '"path"\s*:\s*"VERSION"' "${cfg}" || {
    echo "branch-release: ${cfg}: must bump VERSION"
    failures=$((failures + 1))
  }

  # TS
  grep -Eq '"path"\s*:\s*"ts/package\.json"' "${cfg}" || {
    echo "branch-release: ${cfg}: must bump ts/package.json version"
    failures=$((failures + 1))
  }
  grep -Eq '"path"\s*:\s*"ts/package-lock\.json"' "${cfg}" || {
    echo "branch-release: ${cfg}: must bump ts/package-lock.json version"
    failures=$((failures + 1))
  }
  grep -Eq "\\$\\.packages\\[''\\]\\.version" "${cfg}" || {
    echo "branch-release: ${cfg}: must bump ts/package-lock.json packages[''].version"
    failures=$((failures + 1))
  }

  # CDK
  grep -Eq '"path"\s*:\s*"cdk/package\.json"' "${cfg}" || {
    echo "branch-release: ${cfg}: must bump cdk/package.json version"
    failures=$((failures + 1))
  }
  grep -Eq '"path"\s*:\s*"cdk/package-lock\.json"' "${cfg}" || {
    echo "branch-release: ${cfg}: must bump cdk/package-lock.json version"
    failures=$((failures + 1))
  }
  grep -Eq '"path"\s*:\s*"cdk/\.jsii"' "${cfg}" || {
    echo "branch-release: ${cfg}: must bump cdk/.jsii version"
    failures=$((failures + 1))
  }

  # Py
  grep -Eq '"path"\s*:\s*"py/pyproject\.toml"' "${cfg}" || {
    echo "branch-release: ${cfg}: must bump py/pyproject.toml version"
    failures=$((failures + 1))
  }
done

if [[ "${failures}" -ne 0 ]]; then
  echo "branch-release: FAIL (${failures} issue(s))"
  exit 1
fi

echo "branch-release: PASS"
