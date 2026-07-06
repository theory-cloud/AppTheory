---
title: Dependency Automation for Release-Pinned Installs
---

# Dependency Automation for Release-Pinned Installs

AppTheory and the rest of the Theory Cloud framework stack distribute TypeScript and Python packages as immutable
GitHub Release assets, not through npm or PyPI publication. Consumers that pin release tarballs and wheels need a
release-aware dependency bot; otherwise direct URLs stay invisible until a human edits them.

Use Renovate's `github-releases` datasource with regex managers. Dependabot can still help with ordinary registry
packages in your application, but it does not provide an equivalent custom manager for AppTheory's tarball/wheel URLs.

## Renovate config

Put this in `renovate.json` (or merge the same fields into your existing Renovate config):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "customManagers": [
    {
      "customType": "regex",
      "description": "AppTheory GitHub Release asset URLs and Go module tags",
      "managerFilePatterns": [
        "/(^|/)(package\\.json|package-lock\\.json|requirements\\.txt|pyproject\\.toml|go\\.mod)$/"
      ],
      "matchStrings": [
        "github\\.com/theory-cloud/AppTheory/releases/download/v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?)",
        "github\\.com/theory-cloud/apptheory\\s+v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?)"
      ],
      "depNameTemplate": "theory-cloud/AppTheory",
      "datasourceTemplate": "github-releases",
      "versioningTemplate": "semver"
    },
    {
      "customType": "regex",
      "description": "TableTheory GitHub Release asset URLs and Go module tags",
      "managerFilePatterns": [
        "/(^|/)(package\\.json|package-lock\\.json|requirements\\.txt|pyproject\\.toml|go\\.mod)$/"
      ],
      "matchStrings": [
        "github\\.com/theory-cloud/TableTheory/releases/download/v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?)",
        "github\\.com/theory-cloud/tabletheory\\s+v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?)"
      ],
      "depNameTemplate": "theory-cloud/TableTheory",
      "datasourceTemplate": "github-releases",
      "versioningTemplate": "semver"
    }
  ],
  "packageRules": [
    {
      "description": "Review AppTheory and TableTheory release pins together",
      "matchPackageNames": ["theory-cloud/AppTheory", "theory-cloud/TableTheory"],
      "groupName": "Theory Cloud framework release pins"
    }
  ]
}
```

This config intentionally matches both direct release assets and Go module requirements:

```text
github.com/theory-cloud/apptheory v1.15.2
https://github.com/theory-cloud/AppTheory/releases/download/v1.15.2/theory-cloud-apptheory-1.15.2.tgz
https://github.com/theory-cloud/AppTheory/releases/download/v1.15.2/theory-cloud-apptheory-cdk-1.15.2.tgz
https://github.com/theory-cloud/AppTheory/releases/download/v1.15.2/apptheory-1.15.2-py3-none-any.whl
https://github.com/theory-cloud/AppTheory/releases/download/v1.15.2/apptheory_cdk-1.15.2-py3-none-any.whl
```

When Renovate opens a bump PR, keep AppTheory's runtime package, CDK package, and generated lockfiles in the same PR.
If your app also consumes TableTheory directly, review that bump in the same change so TableTheory data-layer pins and
AppTheory runtime/CDK pins do not drift independently.

## Checksum discipline

Renovate can move URLs, but it cannot prove that your downloaded release assets still match `SHA256SUMS.txt`. Keep the
checksum verification step from the install docs in your CI or bootstrap script:

```bash
VERSION=1.15.2
TAG="v${VERSION}"
gh release download "${TAG}" --repo theory-cloud/AppTheory --pattern "SHA256SUMS.txt" --clobber
grep -E " (theory-cloud-apptheory-${VERSION}\\.tgz|apptheory-${VERSION}-py3-none-any\\.whl)$" SHA256SUMS.txt | sha256sum -c -
```

For npm lockfiles, run `npm install` after Renovate updates the release URL so `package-lock.json` records the new
integrity. For Python, keep the wheel URL in `requirements.txt` or `pyproject.toml` and verify the downloaded release
asset before installing it in production bootstrap.

## Dependabot notes

Dependabot remains useful for ordinary registry dependencies such as `aws-cdk-lib`, `constructs`, or application-only
npm packages. It is not the single path for AppTheory because AppTheory intentionally does not publish npm or PyPI
registry packages. Do not replace the GitHub Release pins with registry coordinates to make Dependabot work; use
Renovate for the release-pinned framework assets and Dependabot only for the dependencies that already come from a
registry.

## Maintainer override notes

AppTheory only carries package-manager `overrides` while a current audit, compatibility, or deterministic-build gate
requires them. In SP17, the TypeScript runtime package removed stale transitive overrides after the regenerated lockfile
passed `npm audit` with zero vulnerabilities. The removal rationale was:

- `@typescript-eslint/typescript-estree` → `minimatch`: upstream now resolves to `minimatch@10.2.5`, so the local
  pin was no longer carrying a security fix.
- `@eslint/eslintrc` / `eslint` → `ajv`: ESLint selects its compatible `ajv@6.14.0`; AppTheory does not override
  lint-tool internals without an active advisory.
- `@eslint/eslintrc` / `eslint` / `eslint-plugin-import` → `minimatch`: the lint stack remains audit-clean on its
  upstream-selected `minimatch` versions, and none of these packages are runtime dependencies.
- `fast-xml-parser` / `fast-xml-builder`: the regenerated TypeScript lockfile no longer contains those packages, so
  keeping orphan overrides would hide dependency graph drift instead of fixing it.
- `flatted` / `js-yaml`: upstream-selected lint-tool transitive versions remain audit-clean; local pins were redundant.
- `yaml`: the TableTheory release asset now resolves `yaml@2.9.0`; AppTheory should not override TableTheory's
  transitive dependency unless a current advisory or contract gate requires it.
