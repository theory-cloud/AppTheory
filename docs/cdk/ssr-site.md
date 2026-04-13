# FaceTheory-First SSR Site (CloudFront + S3 + Lambda URL)

Use this guide when you want the canonical AppTheory deployment pattern for FaceTheory-style SSR, SSG, and ISR on AWS.

`AppTheorySsrSite` is the supported AppTheory companion construct for this shape. The example under
`examples/cdk/ssr-site/` is the canonical implementation to copy from; it is not a weaker helper path separate from
the FaceTheory deployment contract.

## Preferred mode

Prefer `mode: AppTheorySsrSiteMode.SSG_ISR` unless you are intentionally keeping a narrower compatibility path.

- `ssg-isr` is the FaceTheory-first topology:
  - `/assets/*` and `/_facetheory/data/*` stay on direct S3 behaviors
  - default `/*` uses a primary HTML S3 origin with Lambda Function URL fallback for `GET` / `HEAD` / `OPTIONS`
  - extensionless HTML routes rewrite to `/index.html` at the edge
  - same-origin dynamic paths such as actions, auth callbacks, and form posts should be carved out with
    `ssrPathPatterns` so they bypass the origin group and route straight to Lambda
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

  // Cacheable HTML sections that should stay on S3.
  staticPathPatterns: ["/marketing/*"],

  // Dynamic same-origin routes that should stay on Lambda.
  ssrPathPatterns: ["/actions/*"],

  // Optional explicit override; omitted auth auto-selects NONE for writable Lambda routes.
  // ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE,

  // Optional app-specific origin headers
  ssrForwardHeaders: ["x-facetheory-tenant"],
});
```

## Contract

`AppTheorySsrSite` now assumes the stronger FaceTheory deployment contract by default:

- SSR origin:
  - AppTheory auto-selects the Function URL auth model based on the Lambda-backed surface:
    - `AWS_IAM` + lambda Origin Access Control for read-only Lambda traffic
    - `NONE` for browser-facing writable Lambda traffic (`ssr-only`, or `ssg-isr` plus `ssrPathPatterns`)
  - set `ssrUrlAuthType` explicitly when you need to force a specific Function URL auth mode
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
  - `ssr-only` defaults Lambda-backed behaviors to `CACHING_DISABLED`; opt into `ssrCachePolicy` only when the
    Lambda response variance model is explicitly cache-safe
  - `ssg-isr` uses a dedicated public HTML cache policy on the default behavior and any `staticPathPatterns` HTML
    behaviors:
    - all query strings are part of the cache key
    - cookies are excluded from the cache key and are not forwarded to the HTML S3 origin
    - stable public variant headers (`x-*-original-host`, `x-tenant-id`, and opted-in forwarded headers) are part of
      the cache key
    - origin cache-control headers still drive freshness within that safe cache key
  - direct S3 asset/data behaviors continue to use origin cache-control semantics

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
- `/marketing` and `/marketing/about` stay on S3 HTML behaviors and serve rewritten `index.html` objects
- `/_facetheory/data/home.json` stays on the raw S3 data path without HTML rewrites
- `POST /actions/ping` bypasses the origin group and reaches Lambda with full method support
- the previous `Host`-forwarding 403 regression stays covered by exercising the CloudFront-to-Function URL path end to end
- asset and direct-S3 delivery work from S3 through CloudFront
- direct Function URL access matches the deployed auth model for the example's writable route surface

Run it manually when you want an end-to-end AWS check:

```bash
./scripts/verify-ssr-site-smoke.sh
```

Optional environment:

- `APPTHEORY_SSR_SITE_STACK_NAME` to override the temporary stack name
- `APPTHEORY_SSR_SMOKE_KEEP_STACK=1` to skip automatic destroy for debugging

The live smoke verifier is intentionally separate from release automation so the normal release path stays zero-config.
Use it as a manual deploy-grade check when you explicitly want a real AWS verification pass.

## Example

The canonical runnable stack remains:

- `examples/cdk/ssr-site/`

Use that example plus this guide as the single AppTheory + FaceTheory deployment story.
