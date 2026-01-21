# SR-SSR-INFRA — Lambda URL–First SSR Infrastructure (CDK/templates)

This sub-roadmap tracks the infrastructure support needed to deploy **FaceTheory-style SSR** stacks consistently on AWS,
without re-implementing the same patterns per application.

Primary dependency: “AWS resource support wishlist” in `FaceTheory/docs/WISHLIST.md`.

## Goals

- Provide a canonical **CloudFront + S3 + Lambda Function URL** deployment pattern.
- Keep the deployment story compatible with AppTheory’s multi-language posture (prefer **TS-first jsii constructs**, or
  document a template-first approach explicitly).
- Make builds/deployments reproducible and verifiable via `cdk synth` gates.

## Scope

### Required capabilities

- CloudFront distribution with:
  - **S3 origin** for immutable assets (`/assets/*`)
  - **Lambda URL origin** for SSR (`/*`)
  - OAC and least-privilege access
  - logs + basic security headers policy hooks
  - custom domain option (Route53 + ACM) and an escape hatch for non-Route53 DNS
- Deployment conventions:
  - assets upload (content-hashed, immutable caching)
  - manifest upload + deterministic manifest format expectation
  - runtime env wiring (bucket/manifest/cache table names)

### Optional capabilities

- WAF integration hooks (attach WAF ACL; leave policy decisions to apps).
- ISR plumbing for future SWR mode:
  - async regeneration trigger (Lambda Invoke / EventBridge / SQS)
  - minimal “revalidate job” pattern with idempotency keys

## Work items

### I1 — Decide packaging: constructs vs templates

Acceptance:
- Decision documented and enforced in `subroadmaps/SR-CDK.md`:
  - preferred: TS constructs exported via jsii for Go/Py CDK
  - fallback: template-first, but examples/templates are treated as first-class release artifacts

Decision (AppTheory `m14`): **TS-first jsii constructs** (in `cdk/`), shipped via GitHub Releases, with an example CDK
app in `examples/cdk/*` as the first integration surface.

### I2 — Implement SSR site deployment pattern (examples first)

Acceptance:
- A deployable example exists (at least TS) that creates:
  - S3 assets bucket + deployment
  - Lambda URL SSR function
  - CloudFront distribution with two origins and routing rules
- `cdk synth` output is deterministic and verified in CI/`make rubric`.

### I3 — Promote to reusable construct (if chosen)

Acceptance:
- A reusable construct exists (name TBD, e.g. `AppTheorySsrSite`) with clear inputs/outputs.
- The construct is consumable from Go/Py via jsii, or an explicit “TS-only constructs” posture is documented.

### I4 — Build/deploy helpers

Acceptance:
- A recommended script/tool convention exists for:
  - uploading assets + manifest
  - invalidation strategy (if needed)
  - wiring env vars for runtime to locate assets/manifest/cache metadata

Conventions (AppTheory `m14`):

- **Runtime env vars** (wired by `AppTheorySsrSite` when `wireRuntimeEnv` is enabled):
  - `APPTHEORY_ASSETS_BUCKET`: S3 bucket name for assets
  - `APPTHEORY_ASSETS_PREFIX`: S3 key prefix for assets (default `assets`)
  - `APPTHEORY_ASSETS_MANIFEST_KEY`: S3 object key for manifest (default `${APPTHEORY_ASSETS_PREFIX}/manifest.json`)
  - Optional cache metadata wiring when `cacheTableName` is set:
    - `APPTHEORY_CACHE_TABLE_NAME`, `CACHE_TABLE_NAME`, `CACHE_TABLE`
- **Build/deploy scripts** (example implementation):
  - `examples/cdk/ssr-site/scripts/generate-assets-manifest.mjs`
  - `examples/cdk/ssr-site/scripts/upload-assets.sh`
- **Invalidation input**: use `AppTheorySsrSite.distribution.distributionId` (exposed as `CloudFrontDistributionId` in the
  example stack) rather than wiring the distribution id into the Lambda env (avoids CloudFormation dependency cycles).
