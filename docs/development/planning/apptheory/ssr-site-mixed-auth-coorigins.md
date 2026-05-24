# AppTheorySsrSite mixed-auth co-origins

Issue: [theory-cloud/AppTheory#593](https://github.com/theory-cloud/AppTheory/issues/593)
Date: 2026-05-24
Milestone short-name: `ssr-site-mixed-auth-coorigins`

## Scoped need

`lesser-host` is adopting the FaceTheory-first `AppTheorySsrSite` deployment shape while preserving one CloudFront
distribution with existing bearer-auth Lambda Function URL API origins. The AppTheory SSR origin must remain fail-closed
with Lambda OAC and `AWS_IAM`; the API and trust origins must remain bearer-auth-only because those tokens are consumer
contracts for sibling repos and third-party attestation readers.

AppTheory must provide one supported path for this composition. The path should be first-class enough for AppTheory to
keep path ownership, CloudFront behavior options, and SSG/ISR rewrite bypasses fail-closed inside the construct, rather
than asking applications to hand-wire raw `distribution.addBehavior(...)` calls that bypass the construct's contract.

## Success criteria

- `AppTheorySsrSite` accepts a narrow first-class co-origin list for bearer-auth Lambda Function URL origins.
- The SSR Function URL keeps the existing omitted-`ssrUrlAuthType` default: `AWS_IAM` plus Lambda Origin Access Control.
- Co-origin Function URLs synthesize with `AuthType: NONE` and without Lambda OAC.
- Co-origin behaviors are non-cacheable by default, allow all methods, do not forward the viewer `Host` header, and use
  the site response headers policy unless explicitly overridden.
- Co-origin path patterns participate in the existing path-collision checks and bypass SSG/ISR HTML rewrites.
- Generated jsii artifacts and Go bindings expose the new public CDK surface.
- The docs and example show the supported pattern and explicitly distinguish it from raw post-construction
  `distribution.addBehavior(...)`.

## Non-goals

- No new AppTheory runtime fixture: this is CDK deployment-contract behavior, not P0/P1/P2 Lambda runtime behavior.
- No raw AWS SDK or raw CloudFront escape hatch.
- No support for arbitrary origin types in this milestone; the first path is bearer-auth Lambda Function URLs only.
- No change to release manifests or package versions; Release Please owns version movement.

## Enumerated changes

### 1. Add mixed-auth co-origin planning record

- **Paths**: `docs/development/planning/apptheory/ssr-site-mixed-auth-coorigins.md`, `docs/development/planning/apptheory/README.md`, `docs/development/planning/apptheory/subroadmaps/SR-SSR-INFRA.md`
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: The scoped need, flat change list, roadmap, and single-milestone decision are recorded in repo planning docs.
- **Validation**: `bash scripts/verify-docs-standard.sh`
- **Conventional Commit subject**: `docs(planning): scope ssr mixed-auth co-origins`

### 2. Add first-class AppTheorySsrSite co-origin API and synth coverage

- **Paths**: `cdk/lib/ssr-site.ts`, `cdk/lib/ssr-site.js`, `cdk/lib/ssr-site.d.ts`, `cdk/.jsii`, `cdk-go/apptheorycdk/*`, `cdk/test/constructs.test.cjs`
- **Runtime scope**: none
- **Contract impact**: api-snapshot-update (jsii/generated CDK surface)
- **Acceptance**: CDK synth tests prove one OAC-protected SSR origin can coexist with bearer-auth Lambda Function URL behaviors and prove overlapping co-origin paths fail closed.
- **Validation**: `cd cdk && npm test`; `bash scripts/update-cdk-generated.sh`; `bash scripts/verify-cdk-go.sh`
- **Conventional Commit subject**: `feat(cdk): add ssr mixed-auth co-origins`

### 3. Document and example the supported co-origin pattern

- **Paths**: `docs/cdk/ssr-site.md`, `examples/cdk/ssr-site/README.md`, `examples/cdk/ssr-site/lib/ssr-site-stack.ts`
- **Runtime scope**: none
- **Contract impact**: doc-only / example
- **Acceptance**: Operators can copy the documented co-origin API, understand that OAC is origin-scoped, and see how added bearer origins differ from raw `distribution.addBehavior(...)`.
- **Validation**: `bash scripts/verify-docs-standard.sh`; `bash scripts/verify-cdk-synth.sh`
- **Conventional Commit subject**: `docs(cdk): document ssr mixed-auth co-origins`

## Roadmap

## Goal

Deliver a single AppTheory-owned deployment path for `AppTheorySsrSite` mixed-auth Lambda Function URL co-origins so
FaceTheory SSR sites can share one CloudFront distribution with bearer-auth API origins without bypassing construct
contract checks.

## Phases

### Phase 1: Contract shape and implementation

**Milestone candidates:**

- **ssr-site-mixed-auth-coorigins** — AppTheorySsrSite exposes and documents a first-class mixed-auth co-origin pattern for bearer-auth Lambda Function URL paths.
  - Items: 1, 2, 3
  - Dependencies: current `origin/staging` baseline; AWS CDK `FunctionUrlOrigin`; no runtime parity dependency
  - Risks:
    - jsii may require the public prop shape to avoid structural types that do not bind cleanly to Go.
    - SSG/ISR rewrite bypass must include co-origin paths, or API routes without file extensions can be rewritten to `/index.html` before origin selection.
    - Example synth snapshots may move if the example demonstrates the new pattern directly.

## Cross-phase risks

- CDK-generated artifacts (`cdk/lib`, `cdk/.jsii`, `cdk-go/`) must stay synchronized in the same commit as the public API move.
- Raw post-construction `distribution.addBehavior(...)` remains possible because CDK exposes `Distribution`, but it should not be documented as the AppTheory path for this use case.

## Cross-repo dependencies

- FaceTheory does not need code changes for this AppTheory milestone.
- Host can keep its temporary SEC-8 verifier until the AppTheory release containing this API is adopted.

## Deprecation and migration plan

No deprecation. Existing `ssrPathPatterns`, `staticPathPatterns`, and `directS3PathPatterns` remain valid. Applications
that hand-wired extra behaviors can migrate to `coOrigins` when they want AppTheory-owned collision checks and rewrite
bypass behavior.

## Open questions

None blocking this milestone. If future users need arbitrary CloudFront origins, scope a separate construct growth; do
not widen this milestone beyond bearer-auth Lambda Function URL origins.
