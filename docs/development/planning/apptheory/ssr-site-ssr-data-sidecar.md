# AppTheorySsrSite SSR data sidecar routing

Coordination: FaceTheory issue [theory-cloud/FaceTheory#250](https://github.com/theory-cloud/FaceTheory/issues/250)
Date: 2026-05-24
Milestone short-name: `ssr-site-ssr-data-sidecar`

## Scoped need

FaceTheory is adding strict no-inline-CSP SSR hydration sidecars so server-rendered pages can hydrate from framework-owned
raw resource routes instead of embedding JSON inline. In the `ssg-isr` deployment shape, the existing FaceTheory SSG
hydration sidecars at `/_facetheory/data/*` remain direct S3 objects. The new SSR sidecars at
`/_facetheory/ssr-data/*` must be served by the SSR Lambda origin because they are derived from request-time render
payloads and must not be rewritten to static HTML.

AppTheory owns the CloudFront behavior graph for `AppTheorySsrSite`, so this routing must be first-class in the
construct rather than requiring applications or FaceTheory examples to hand-wire raw CloudFront behaviors. The single
correct path is: in `ssg-isr` mode, AppTheory automatically reserves the SSR data sidecar prefix for direct SSR Lambda
routing, keeps the existing SSG data prefix on direct S3, applies the shared edge request/response functions, and
preserves the SSR origin's fail-closed `AWS_IAM` plus Lambda OAC default.

## Success criteria

- `AppTheorySsrSite` in `ssg-isr` mode automatically routes `/_facetheory/ssr-data/*` and the exact
  `/_facetheory/ssr-data` root to the SSR Lambda origin.
- Existing `/_facetheory/data/*` and exact `/_facetheory/data` routing remains direct S3.
- SSR sidecar paths bypass the SSG/ISR extensionless HTML rewrite and never fall through to `/index.html`.
- The SSR Lambda origin remains `AWS_IAM` plus Lambda Origin Access Control by default; no public Function URL is added
  for the sidecar route.
- Path collision detection rejects user-supplied direct-S3/static/bearer co-origin patterns that would take ownership of
  the reserved SSR sidecar prefix.
- CDK synth tests and docs describe the FaceTheory sidecar split clearly enough for cross-repo adoption.

## Non-goals

- No AppTheory Lambda runtime fixture: this is CDK deployment-contract behavior, not runtime event normalization.
- No new render mode and no FaceTheory implementation in this repository.
- No public prop for changing the reserved prefix in this milestone; prefix ownership is part of the contract.
- No raw CloudFront escape hatch or instructions to call `distribution.addBehavior(...)`.
- No release-manifest edits; Release Please owns version movement.

## Enumerated changes

### 1. Record the SSR data sidecar routing milestone

- **Paths**: `docs/development/planning/apptheory/ssr-site-ssr-data-sidecar.md`, `docs/development/planning/apptheory/README.md`, `docs/development/planning/apptheory/subroadmaps/SR-SSR-INFRA.md`
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: The scoped need, flat change list, roadmap, and single-milestone decision are recorded in repo planning docs.
- **Validation**: `bash scripts/verify-docs-standard.sh`
- **Conventional Commit subject**: `docs(planning): scope ssr data sidecar routing`

### 2. Add first-class SSG/ISR SSR sidecar routing and synth coverage

- **Paths**: `cdk/lib/ssr-site.ts`, `cdk/lib/ssr-site.js`, `cdk/.jsii`, `cdk-go/apptheorycdk/*`, `cdk/test/constructs.test.cjs`
- **Runtime scope**: none
- **Contract impact**: generated CDK artifacts only; no new public prop
- **Acceptance**: CDK synth tests prove `/_facetheory/data/*` targets S3, `/_facetheory/ssr-data/*` targets the SSR Lambda origin with Lambda OAC, the edge rewrite bypass includes the SSR data prefix, and conflicting direct-S3 ownership fails closed.
- **Validation**: `cd cdk && npm test`; `bash scripts/update-cdk-generated.sh`; `bash scripts/verify-cdk-go.sh`
- **Conventional Commit subject**: `feat(cdk): route ssr data sidecars to lambda`

### 3. Document the FaceTheory sidecar split

- **Paths**: `docs/cdk/ssr-site.md`, `examples/cdk/ssr-site/README.md`
- **Runtime scope**: none
- **Contract impact**: doc-only / example
- **Acceptance**: Operators can see that `/_facetheory/data/*` remains S3 while `/_facetheory/ssr-data/*` is automatically Lambda-backed in `ssg-isr`, and understand that this is the AppTheory-owned path for FaceTheory strict no-inline-CSP SSR sidecars.
- **Validation**: `bash scripts/verify-docs-standard.sh`; `bash scripts/verify-cdk-synth.sh`
- **Conventional Commit subject**: `docs(cdk): document ssr data sidecars`

## Roadmap

## Goal

Deliver a single AppTheory-owned deployment path for FaceTheory SSR hydration sidecars so strict no-inline-CSP SSR pages
can fetch render payload data from the same distribution without falling through to static HTML or weakening the Lambda
OAC origin.

## Phases

### Phase 1: Reserved sidecar behavior in AppTheorySsrSite

**Milestone candidates:**

- **ssr-site-ssr-data-sidecar** — AppTheorySsrSite reserves FaceTheory SSR data sidecars as direct SSR Lambda paths in `ssg-isr` mode.
  - Items: 1, 2, 3
  - Dependencies: current `origin/staging` baseline plus current `origin/main` release back-merge in the PR head; FaceTheory reserved prefix decision from issue #250
  - Risks:
    - The exact root behavior (`/_facetheory/ssr-data`) must be synthesized with the wildcard behavior, matching the existing behavior expansion contract.
    - The viewer-request rewrite bypass must include the SSR sidecar prefix, or extensionless JSON resource paths can be rewritten to `/index.html` before origin selection.
    - Generated jsii metadata moves even without a new public prop because the construct implementation changes.

## Cross-phase risks

- The two reserved prefixes are intentionally similar. Tests and docs must distinguish SSG sidecars (`/_facetheory/data/*` → S3) from SSR sidecars (`/_facetheory/ssr-data/*` → Lambda).
- Future FaceTheory changes that need a different reserved prefix should come back through the contract instead of adding per-app behavior overrides.

## Cross-repo dependencies

- FaceTheory can proceed with raw resource route primitives for strict no-inline-CSP SSR sidecars once this AppTheory CDK behavior is released.
- AppTheory should reply to the FaceTheory coordination email with the accepted prefix and PR link after this milestone is opened.

## Deprecation and migration plan

No deprecation. Existing `ssrPathPatterns`, `staticPathPatterns`, `directS3PathPatterns`, and `bearerFunctionUrlOrigins`
remain valid. Applications that temporarily configured `/_facetheory/ssr-data/*` through `ssrPathPatterns` can remove the
manual entry after adopting the AppTheory release containing this milestone; duplicate entries normalize to the same
reserved direct-SSR behavior.

## Open questions

None blocking this milestone. The reserved prefix is accepted as `/_facetheory/ssr-data/*` unless FaceTheory revises the
contract before this PR lands.
