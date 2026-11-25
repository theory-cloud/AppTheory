---
title: Runtime Support
description: The one place that states which Go, Node.js and Python lines AppTheory supports, tests and is retiring.
---

# Runtime Support

This page is the single source of truth for AppTheory's runtime support. Every
other page links here instead of restating a support statement, so there is one
answer to "is this line supported?" and it cannot drift between pages.

AppTheory is implemented independently in Go, TypeScript and Python, and each
implementation is tested on real toolchains. Support has three separate parts,
and they are deliberately not the same number:

- the **floor** is what the package metadata allows (`go.mod`,
  `ts/package.json`, `cdk/package.json`, `py/pyproject.toml`). Below the floor,
  install fails.
- the **tested lines** are the toolchains the shared contract corpus, the package
  builds and the CDK bindings are actually verified on. A line at or above the
  floor but outside this set is untested, and untested is not supported.
- the **selected line** is what AppTheory's own scaffolding and constructs choose
  when they create a runtime for you.

## Support table

| Runtime | Floor (unchanged) | Tested lines | Status |
| --- | --- | --- | --- |
| Go | `1.27.4` (`go.mod`) | `1.27.4` | Supported |
| Node.js | `>=22` (`ts/package.json`, `cdk/package.json`) | 22, 24, 26 | 22 **deprecated**; see below. 24 and 26 supported. |
| Python | `>=3.12` (`py/pyproject.toml`) | 3.12, 3.14, 3.15 | Supported |

Node 26 and Python 3.15 are supported on `staging` now and ship in the next
AppTheory release. Published releases up to and including **v7.5.0** were tested
on Node.js 22 and 24 and on Python 3.12 and 3.14 only; if you are running a
published release, nothing on this page asks you to change it. Read the section
for the release you actually deploy.

## Node.js 22 is deprecated

Node.js 22 reaches end of life on **2027-04-30**. AppTheory keeps Node.js 22 as
the floor and keeps testing it until then, but it is no longer the line new work
should target:

- **Now (next release):** Node.js 26 is tested and supported alongside 22 and 24.
  No code change is required to move to it, and no API changes with it.
- **2027-02 major:** the floor rises to `>=24`, Node.js 22 stops being tested, and
  `engines.node` in `ts/package.json` and `cdk/package.json` becomes `>=24`. That
  is a breaking change for anyone still installing on 22, which is why it is a
  major and why it is dated rather than immediate.
- **Between now and then:** Node.js 22 keeps working. A deprecation notice is a
  notice; only the dated major changes the requirement.

Migration notes for the floor move live in
[Upgrading AppTheory](../../UPGRADING.md).

## Which line AppTheory selects for you

Selection is unchanged by this support-table update:

- `AppTheoryFunction` keeps deploying whatever `runtime` you pass. Where a
  construct creates a Node runtime on your behalf, it selects `NODEJS_24_X`
  (`AppTheoryMicrovmImage`, `AppTheoryRestV1ChallengeRestoration`).
- The `apptheory-init` templates select `NODEJS_24_X` for TypeScript and
  `PYTHON_3_14` for Python.
- `AppTheoryFunction`'s own default stays `PROVIDED_AL2023`; AppTheory does not
  pick a managed runtime for a handler you provide.

Selecting `NODEJS_26_X` or `PYTHON_3_15` yourself is supported: both are real
Lambda runtimes in the pinned `aws-cdk-lib`, both resolve their own bundling
image, and a stack that declares them synthesizes. That path is proven on every
commit by the clean-consumer install proof, which installs the packed CDK
artifact into an empty project, selects both runtimes, and synthesizes them.

## How support is proven

Every line in the table above names a tracked proof profile, and each profile
carries a committed evidence record produced under that exact environment:
`ts`, `py`, `contract-tests` and `cdk-go-drift` for the package and corpus
claims, and `consumer-install` for the "a consumer can install and run this"
claim. CI verifies those records on every pull request into `staging`
instead of re-running them, and fails when an input or a floor moves without the
record moving with it.

`scripts/verify-runtime-floor-claims.sh` is the guard that keeps this page
honest: it fails closed unless the package floors, the lockfiles, the pinned
TableTheory GitHub Release artifacts and the CI matrix agree. If a claim here is
not in that matrix, the guard fails the build. The mechanics are documented in
[Proportionate release validation](../development/validation-evidence.md).

## What is not supported

- Node.js below 22 and Python below 3.12: refused at install by the package
  floors.
- A line at or above the floor but outside the tested set: not claimed. It may
  work, but nothing here asserts that it does, and no record proves it.
- Non-Lambda HTTP hosting. AppTheory's runtime contract assumes the Lambda
  execution and concurrency model; there is no Express, Fiber or Flask adapter
  and no plan for one.
