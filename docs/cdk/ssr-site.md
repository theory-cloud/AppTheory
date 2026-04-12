# FaceTheory-First SSR Site (CloudFront + S3 + Lambda URL)

Use this guide when you want the canonical AppTheory deployment pattern for FaceTheory-style SSR, SSG, and ISR on AWS.

`AppTheorySsrSite` is the supported AppTheory companion construct for this shape. The example under
`examples/cdk/ssr-site/` is the canonical implementation to copy from; it is not a weaker helper path separate from
the FaceTheory deployment contract.

## Preferred mode

Prefer `mode: AppTheorySsrSiteMode.SSG_ISR` unless you are intentionally keeping a narrower compatibility path.

- `ssg-isr` is the FaceTheory-first topology:
  - `/assets/*` and `/_facetheory/data/*` stay on direct S3 behaviors
  - default `/*` uses an S3-primary origin group with Lambda Function URL fallback
  - extensionless routes rewrite to `/index.html` at the edge
- `ssr-only` remains available for compatibility, but it is not the preferred documented deployment story for new
  FaceTheory work.

## Canonical stack shape

```ts
import { AppTheorySsrSite, AppTheorySsrSiteMode } from "@theory-cloud/apptheory-cdk";

new AppTheorySsrSite(this, "Site", {
  ssrFunction,
  mode: AppTheorySsrSiteMode.SSG_ISR,
  assetsBucket,
  assetsKeyPrefix: "assets",
  assetsManifestKey: ".vite/manifest.json",

  // FaceTheory ISR HTML store (`S3HtmlStore`)
  htmlStoreBucket: isrBucket,
  htmlStoreKeyPrefix: "isr",

  // FaceTheory ISR metadata + lease coordination (TableTheory schema)
  isrMetadataTable,

  // Optional app-specific origin headers
  ssrForwardHeaders: ["x-facetheory-tenant"],
});
```

## Contract

`AppTheorySsrSite` now assumes the stronger FaceTheory deployment contract by default:

- SSR origin:
  - Lambda Function URL uses `AWS_IAM` auth by default
  - CloudFront reaches the Function URL through lambda Origin Access Control
  - `ssrUrlAuthType: NONE` is a compatibility escape hatch, not the preferred path
- Edge request normalization:
  - viewer-request preserves an inbound `x-request-id`, otherwise falls back to the CloudFront request ID
  - viewer-request records both `x-apptheory-original-host` / `x-apptheory-original-uri` and
    `x-facetheory-original-host` / `x-facetheory-original-uri`
  - raw `host` and `x-forwarded-proto` are intentionally rejected from the SSR origin request allowlist
- CDN response headers:
  - baseline security headers are set at CloudFront: HSTS, `nosniff`, frame options, referrer policy, XSS protection,
    and restrictive `permissions-policy`
  - Content-Security-Policy stays origin-defined so per-request SSR nonce flows remain possible
- Cache semantics:
  - CloudFront uses origin cache-control headers for both SSR and direct-S3 behaviors
  - FaceTheory response headers remain the source of truth for SSR, SSG, and ISR freshness

## Runtime env wiring

When `wireRuntimeEnv` is left enabled (the default), AppTheory wires:

- `APPTHEORY_ASSETS_BUCKET`
- `APPTHEORY_ASSETS_PREFIX`
- `APPTHEORY_ASSETS_MANIFEST_KEY`
- `FACETHEORY_ISR_BUCKET`
- `FACETHEORY_ISR_PREFIX`
- `APPTHEORY_CACHE_TABLE_NAME`
- `FACETHEORY_CACHE_TABLE_NAME`
- `CACHE_TABLE_NAME`
- `CACHE_TABLE`

If you pass `htmlStoreBucket` and `isrMetadataTable`, AppTheory also grants the SSR Lambda the required S3 and
DynamoDB permissions. If you use name-only wiring for the metadata table, you still need to grant access in your app
stack.

## Verification model

There are two verification layers for this pattern:

- deterministic local gate: `./scripts/verify-cdk-synth.sh` and `make rubric`
- live deploy-grade smoke: `./scripts/verify-ssr-site-smoke.sh`

The live smoke verifier deploys `examples/cdk/ssr-site`, checks:

- CloudFront root path reaches the Lambda Function URL fallback and returns the SSR body
- the previous `Host`-forwarding 403 regression stays covered by exercising the CloudFront-to-Function URL path end to end
- asset delivery works from S3 through CloudFront
- direct Function URL access remains blocked under the `AWS_IAM` auth model

Run it manually when you want an end-to-end AWS check:

```bash
./scripts/verify-ssr-site-smoke.sh
```

Optional environment:

- `APPTHEORY_SSR_SITE_STACK_NAME` to override the temporary stack name
- `APPTHEORY_SSR_SMOKE_KEEP_STACK=1` to skip automatic destroy for debugging

## Release workflow requirements

The release and prerelease GitHub workflows now treat the live smoke verifier as a required gate. Configure these repo
variables before relying on that path:

- `APPTHEORY_SSR_SMOKE_ROLE_ARN`
- `APPTHEORY_SSR_SMOKE_AWS_REGION`

Those workflows assume OIDC-based AWS access through `aws-actions/configure-aws-credentials`, then run
`./scripts/verify-ssr-site-smoke.sh` after `make rubric`.

## Example

The canonical runnable stack remains:

- `examples/cdk/ssr-site/`

Use that example plus this guide as the single AppTheory + FaceTheory deployment story.
