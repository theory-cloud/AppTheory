# AppTheory SSR Site (Lambda URL + CloudFront) - CDK Example

Canonical operator guide: `docs/cdk/ssr-site.md`

This example synthesizes an opinionated **SSR site** deployment pattern:

- S3 bucket for immutable assets under `/assets/*`
- Lambda Function URL origin (response streaming enabled, with auth explicit when public compatibility is desired)
- CloudFront distribution with explicit `ssr-only` / `ssg-isr` modes and shared FaceTheory edge glue
- `ssg-isr` primary HTML origin backed by `htmlStoreBucket`, plus direct Lambda carve-outs for same-origin dynamic routes

The construct (`AppTheorySsrSite`) also wires recommended runtime environment variables onto the SSR function:

- `APPTHEORY_ASSETS_BUCKET`
- `APPTHEORY_ASSETS_PREFIX`
- `APPTHEORY_ASSETS_MANIFEST_KEY`
- Optional (when configured): `FACETHEORY_ISR_BUCKET`, `FACETHEORY_ISR_PREFIX`
- Optional (when configured): `APPTHEORY_CACHE_TABLE_NAME`, `FACETHEORY_CACHE_TABLE_NAME`, `CACHE_TABLE_NAME`, `CACHE_TABLE`

## FaceTheory-first deployment guide

FaceTheory's recommended topology splits CloudFront behaviors so static paths don't traverse the SSR Lambda:

- `assets/*` -> S3 (assets)
- `/_facetheory/data/*` -> S3 (SSG hydration JSON)
- default `*` -> S3 primary HTML origin with Lambda Function URL fallback

Example configuration:

```ts
new AppTheorySsrSite(this, "Site", {
  ssrFunction: ssrFn,
  mode: AppTheorySsrSiteMode.SSG_ISR,

  // FaceTheory ISR HTML storage (`S3HtmlStore`).
  htmlStoreBucket: isrBucket,
  htmlStoreKeyPrefix: "isr",

  // FaceTheory ISR metadata + lease coordination (TableTheory schema).
  isrMetadataTable,

  // Cacheable HTML sections that should stay on the HTML store.
  staticPathPatterns: ["/marketing/*"],

  // Dynamic same-origin routes that should bypass the origin group.
  ssrPathPatterns: ["/actions/*"],

  // This example keeps the auth model explicit because it wants public direct
  // Function URL compatibility during smoke verification.
  ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE,
});
```

Default SSR origin contract:

- Omitted `ssrUrlAuthType` now fails closed to `AWS_IAM` + CloudFront Function URL OAC for all CloudFront-to-Lambda traffic.
- Set `ssrUrlAuthType` explicitly to `NONE` only when you intentionally need public direct Function URL access.
- `ssr-only` preserves the existing shape: Lambda is the default origin and direct S3 behaviors are only used for assets and explicitly configured static paths.
- `ssg-isr` promotes the stronger FaceTheory topology: `htmlStoreBucket` becomes the primary HTML origin, Lambda is the fallback for cache misses on `GET` / `HEAD` / `OPTIONS`, `/_facetheory/data/*` stays on direct S3, and extensionless HTML paths rewrite to `/index.html` at the edge.
- Use `ssrPathPatterns` for same-origin dynamic routes such as actions, callbacks, or form posts that must bypass the origin group and route directly to Lambda with full method support.
- The viewer-request function preserves an inbound `x-request-id`, otherwise falls back to the CloudFront request ID, and records both `x-apptheory-*` and `x-facetheory-*` original host/URI headers for the origin contract.
- The viewer-response function echoes `x-request-id` back to clients for both S3 and SSR responses.
- Default forwarded headers are limited to safe edge context: `cloudfront-forwarded-proto`, `cloudfront-viewer-address`, `x-apptheory-original-host`, `x-apptheory-original-uri`, `x-facetheory-original-host`, `x-facetheory-original-uri`, and `x-request-id`.
- Viewer-supplied tenant headers are not trusted by default: `x-tenant-id` is stripped at the edge, and tenant-like `ssrForwardHeaders` require `allowViewerTenantHeaders: true` as a deliberate compatibility mode.
- Additional non-tenant app-specific headers remain opt-in via `ssrForwardHeaders`; `host` and `x-forwarded-proto` are intentionally rejected.
- Direct Lambda-backed SSR behaviors default to `CACHING_DISABLED` unless you opt into `ssrCachePolicy`.
- The default `ssg-isr` HTML behavior and any `staticPathPatterns` HTML sections use a public cache policy that keys on all query strings plus stable public variant headers, excludes cookies, and still lets origin cache-control headers drive freshness.
- Direct S3 asset/data behaviors continue to use origin-defined cache-control semantics.
- AppTheory provisions baseline CDN security headers by default: HSTS, `nosniff`, `frame-options`, `referrer-policy`, XSS protection, and a restrictive `permissions-policy`. CSP remains origin-defined.

Tenant trust migration note:

- Prefer deriving tenant from `x-apptheory-original-host` / `x-facetheory-original-host` inside your SSR function.
- If you must preserve legacy viewer-header passthrough temporarily, opt in explicitly:

```ts
new AppTheorySsrSite(this, "Site", {
  ssrFunction: ssrFn,
  allowViewerTenantHeaders: true,
  ssrForwardHeaders: ["x-facetheory-tenant"],
});
```

Notes for ISR resource wiring:

- If you pass `htmlStoreBucket` and `isrMetadataTable`, `AppTheorySsrSite` grants the SSR Lambda read/write access and wires the matching env vars automatically.
- If you use name-only wiring (`isrMetadataTableName` / legacy `cacheTableName`), you still need to grant table access in your app stack.

## Prerequisites

- Node.js 24+
- `npm`

## Synth

```bash
cd examples/cdk/ssr-site
npm ci
npx cdk synth
```

## Deploy-grade smoke verification

The deterministic synth hash is the normal automated gate for this example. When you want a real AWS verification pass,
run the live smoke check through `scripts/verify-ssr-site-smoke.sh` manually.

Manual run from the repo root:

```bash
./scripts/verify-ssr-site-smoke.sh
```

Optional environment:

- `APPTHEORY_SSR_SITE_STACK_NAME` to override the temporary stack name
- `APPTHEORY_SSR_SMOKE_KEEP_STACK=1` to keep the deployed stack for debugging

The smoke check covers:

- SSR fallback on `/`
- HTML store routing on `/marketing` and `/marketing/about`
- raw S3 hydration data on `/_facetheory/data/home.json`
- direct Lambda action routing on `POST /actions/ping`
- direct Function URL access matching the example's explicit public auth model

## Build/deploy helpers (optional)

This example uses `BucketDeployment` for convenience, but real SSR sites typically upload build artifacts separately.

Generate a deterministic assets manifest:

```bash
cd examples/cdk/ssr-site
node scripts/generate-assets-manifest.mjs --assets-dir assets --out assets/manifest.json
```

Upload assets + manifest (requires AWS CLI v2):

```bash
export ASSETS_BUCKET=...
export ASSETS_PREFIX=assets
export DISTRIBUTION_ID=... # optional (invalidation)
./scripts/upload-assets.sh
```
