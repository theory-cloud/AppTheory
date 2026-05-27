# FaceTheory-First SSR Site (CloudFront + S3 + Lambda URL)

Use this guide when you want the canonical AppTheory deployment pattern for FaceTheory-style SSR, SSG, and ISR on AWS.

`AppTheorySsrSite` is the supported AppTheory companion construct for this shape. The example under
`examples/cdk/ssr-site/` is the canonical implementation to copy from; it is not a weaker helper path separate from
the FaceTheory deployment contract.

For v1.0 fail-closed migration notes covering Function URL auth defaults, tenant-header trust, and related cache-key
changes, see `docs/migration/v1-security.md`.

## Preferred mode

Prefer `mode: AppTheorySsrSiteMode.SSG_ISR` unless you are intentionally keeping a narrower compatibility path.

- `ssg-isr` is the FaceTheory-first topology:
  - `/assets/*` and `/_facetheory/data/*` stay on direct S3 behaviors
  - `/_facetheory/ssr-data/*` routes directly to the SSR Lambda Function URL for strict no-inline-CSP SSR sidecars
  - default `/*` uses a primary HTML S3 origin with Lambda Function URL fallback for `GET` / `HEAD` / `OPTIONS`
  - extensionless HTML routes rewrite to `/index.html` at the edge, except for direct S3/data and direct SSR carve-outs
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

  // Dynamic same-origin routes that should stay on the SSR Lambda.
  // AppTheory adds /_facetheory/ssr-data/* automatically in ssg-isr mode.
  ssrPathPatterns: ["/actions/*"],

  // Bearer-auth API co-origins that share the distribution without weakening
  // the SSR origin's AWS_IAM + Lambda OAC posture.
  bearerFunctionUrlOrigins: [
    {
      function: controlPlaneApiFunction,
      pathPatterns: ["/api/*", "/auth/*", "/setup/*"],
    },
    {
      function: trustApiFunction,
      pathPatterns: ["/.well-known/*", "/attestations/*"],
    },
  ],

  // Optional explicit compatibility override. Omit this to keep the default
  // CloudFront-signed AWS_IAM Function URL origin.
  // ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE,

  // Optional app-specific origin headers
  ssrForwardHeaders: ["x-facetheory-segment"],
});
```

## FaceTheory data sidecars

`ssg-isr` mode reserves two FaceTheory data prefixes with different origins:

- `/_facetheory/data/*` and exact `/_facetheory/data` are SSG sidecars and stay on direct S3 behaviors.
- `/_facetheory/ssr-data/*` and exact `/_facetheory/ssr-data` are SSR sidecars and route directly to the SSR Lambda
  Function URL.

The SSR sidecar behavior is automatic; do not add it to `directS3PathPatterns`. AppTheory includes it in the same
fail-closed path ownership checks as assets, static HTML sections, direct SSR paths, and bearer Function URL co-origins.
Exact, broader, or nested wildcard patterns that would shadow the reserved SSR sidecar prefix are rejected, including
CloudFront `*` and `?` path-pattern wildcards. The sidecar behavior also bypasses the `ssg-isr` HTML rewrite so
extensionless sidecar URLs cannot become `/index.html` requests before origin selection. The behavior uses the same SSR
Lambda origin request policy and preserves the default `AWS_IAM` plus Lambda Origin Access Control posture when
`ssrUrlAuthType` is omitted.

## Contract

`AppTheorySsrSite` now assumes the stronger FaceTheory deployment contract by default:

- SSR origin:
  - omitted `ssrUrlAuthType` now fails closed to `AWS_IAM` + lambda Origin Access Control for **all** CloudFront-to-Lambda traffic
  - set `ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE` only when you intentionally require public direct Function URL access as a compatibility choice
- Edge request normalization:
  - viewer-request preserves an inbound `x-request-id`, otherwise falls back to the CloudFront request ID
  - viewer-request records both `x-apptheory-original-host` / `x-apptheory-original-uri` and
    `x-facetheory-original-host` / `x-facetheory-original-uri`
  - viewer-request strips `x-tenant-id` by default, and tenant-like `ssrForwardHeaders` are rejected unless you explicitly enable compatibility passthrough
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
    - stable public variant headers (`x-*-original-host` and non-tenant opted-in forwarded headers) are part of the
      cache key by default
    - tenant-like viewer headers join the cache key only when `allowViewerTenantHeaders: true` is explicitly enabled
    - origin cache-control headers still drive freshness within that safe cache key
  - direct S3 asset/data behaviors use the AppTheory static asset cache policy: no viewer headers, cookies, or query
    strings are forwarded to the S3/OAC origin (including the viewer `Host` header), origin cache-control headers drive
    freshness with a 0-second minimum TTL, and objects without origin cache-control fall back to a 1-day default TTL
  - the reserved SSR sidecar behavior (`/_facetheory/ssr-data/*`) is Lambda-backed and defaults to `CACHING_DISABLED`

## Mixed-auth Lambda Function URL co-origins

Use `bearerFunctionUrlOrigins` when the same CloudFront distribution must host AppTheory-managed FaceTheory SSR plus
additional Lambda Function URL APIs that authenticate inside handler code. This is the supported AppTheory path for
mixed-auth co-origins. Do not hand-wire raw `site.distribution.addBehavior(...)` calls when AppTheory should own path
collision checks, SSG/ISR rewrite bypasses, and edge request-id/original-host policy.

```ts
new AppTheorySsrSite(this, "Site", {
  ssrFunction,
  mode: AppTheorySsrSiteMode.SSG_ISR,

  // Omit ssrUrlAuthType so the SSR origin keeps AWS_IAM + Lambda OAC.
  bearerFunctionUrlOrigins: [
    {
      function: controlPlaneApiFunction,
      pathPatterns: ["/api/*", "/auth/*", "/setup/*"],
    },
    {
      function: trustApiFunction,
      pathPatterns: ["/.well-known/*", "/attestations/*"],
    },
  ],
});
```

AppTheory creates each co-origin Function URL with `lambda.FunctionUrlAuthType.NONE`. The co-origin behaviors use
`AllowedMethods.ALLOW_ALL`, `CachePolicy.CACHING_DISABLED`, and
`OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER`, so bearer headers reach the API without forwarding the viewer
`Host` header to Lambda Function URLs. The site's response headers policy and viewer request/response functions are
applied to these behaviors, preserving `x-request-id` echo and `x-apptheory-*` / `x-facetheory-*` original host and URI
headers.

The SSR Lambda OAC posture is origin-scoped: AppTheory attaches Lambda OAC only to the SSR Function URL origin when
`ssrUrlAuthType` is omitted or set to `AWS_IAM`. Bearer co-origins remain non-OAC `AuthType.NONE` Function URLs and are
expected to enforce authentication in handler code.

## Tenant trust

`AppTheorySsrSite` now distinguishes **forwarded edge context** from **trusted tenant derivation**:

- `x-apptheory-original-host` / `x-facetheory-original-host` remain the safe edge context headers for host-aware SSR.
- viewer-supplied tenant headers are **not trusted by default**:
  - `x-tenant-id` is stripped before the request reaches the origin
  - tenant-like entries in `ssrForwardHeaders` are rejected unless compatibility passthrough is explicitly enabled
- if your tenancy depends on host mapping, derive the tenant inside your SSR function from the original-host headers and your allowlisted domain mapping

Compatibility escape hatch:

```ts
new AppTheorySsrSite(this, "Site", {
  ssrFunction,
  allowViewerTenantHeaders: true,
  ssrForwardHeaders: ["x-facetheory-tenant"],
});
```

Use `allowViewerTenantHeaders: true` only as a migration bridge for existing FaceTheory-first deployments that still
depend on viewer-supplied tenant headers. It restores legacy passthrough for `x-tenant-id` and tenant-like
`ssrForwardHeaders`, but those headers remain **viewer-controlled**, not trusted edge-derived values.

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

## SSR_ONLY provided-assets validation example

`examples/cdk/ssr-only-provided-assets-site/` is a narrow validation example for operators who need to prove
`ssr-only` asset delivery with a caller-provided, stack-owned assets bucket. It is not a second architecture and it does
not change the preferred FaceTheory-first `ssg-isr` guidance above.

The example deliberately omits `assetsPath` on `AppTheorySsrSite`; it passes `assetsBucket` and uploads the known JS,
CSS, and text probe objects with an example-local `BucketDeployment`. The SSR Lambda returns HTML that references
`/assets/app.js` and `/assets/site.css`, matching Vite/FaceTheory-style absolute asset URLs while avoiding a
FaceTheory dependency for this smoke target.

Security posture stays on the AppTheory default path:

- the SSR Lambda Function URL remains `AWS_IAM` and is reached through CloudFront Lambda OAC
- the provided assets bucket blocks public access, enforces SSL, and receives only the AppTheory-generated CloudFront
  service-principal read grant scoped to the distribution `SourceArn`
- `/assets/*` and exact `/assets` stay on AppTheory-managed direct S3 OAC behaviors with the standard
  viewer-request/viewer-response functions for request-id propagation and the no-viewer-`Host` static asset cache policy
- no legacy OAI comparison path is part of the example

Local deterministic proof:

```bash
./scripts/verify-ssr-only-provided-assets-synth.sh
```

Authorized live handoff, when Factory explicitly approves AWS mutation:

```bash
AWS_PROFILE=Mcp ./scripts/verify-ssr-only-provided-assets-site-smoke.sh
```

Set `KEEP_STACK=1` only for an explicitly authorized debugging run; otherwise the smoke helper destroys its stack on
exit.

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
- direct Function URL access matches the deployed auth model for the example's explicit compatibility setting

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
