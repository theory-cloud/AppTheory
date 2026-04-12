# AppTheory SSR Site (Lambda URL + CloudFront) - CDK Example

Canonical operator guide: `docs/cdk/ssr-site.md`

This example synthesizes an opinionated **SSR site** deployment pattern:

- S3 bucket for immutable assets under `/assets/*`
- Lambda Function URL origin (response streaming enabled, signed through CloudFront by default)
- CloudFront distribution with explicit `ssr-only` / `ssg-isr` modes and shared FaceTheory edge glue

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

  // Forward FaceTheory's tenant header to SSR when needed (normalized + de-duped).
  ssrForwardHeaders: ["x-facetheory-tenant"],
});
```

Default SSR origin contract:

- `AppTheorySsrSite` creates the SSR Function URL with `AWS_IAM` auth and uses CloudFront Function URL OAC by default.
- Set `ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE` only as an explicit compatibility override for legacy public Function URL flows.
- `ssr-only` preserves the existing shape: Lambda is the default origin and direct S3 behaviors are only used for assets and explicitly configured static paths.
- `ssg-isr` promotes the stronger FaceTheory topology: S3 is the primary HTML origin, Lambda is the fallback, `/_facetheory/data/*` stays on direct S3, and extensionless paths rewrite to `/index.html` at the edge.
- The viewer-request function preserves an inbound `x-request-id`, otherwise falls back to the CloudFront request ID, and records both `x-apptheory-*` and `x-facetheory-*` original host/URI headers for the origin contract.
- The viewer-response function echoes `x-request-id` back to clients for both S3 and SSR responses.
- Default forwarded headers are limited to safe edge context: `cloudfront-forwarded-proto`, `cloudfront-viewer-address`, `x-apptheory-original-host`, `x-apptheory-original-uri`, `x-facetheory-original-host`, `x-facetheory-original-uri`, `x-request-id`, and `x-tenant-id`.
- Additional app-specific headers remain opt-in via `ssrForwardHeaders`; `host` and `x-forwarded-proto` are intentionally rejected.
- CloudFront defaults to origin-defined cache-control semantics for both SSR and direct-S3 behaviors, so FaceTheory cache headers remain the source of truth.
- AppTheory provisions baseline CDN security headers by default: HSTS, `nosniff`, `frame-options`, `referrer-policy`, XSS protection, and a restrictive `permissions-policy`. CSP remains origin-defined.

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

The deterministic synth hash is only the local gate for this example. The release path also runs a live AWS smoke
check through `scripts/verify-ssr-site-smoke.sh`.

Manual run from the repo root:

```bash
./scripts/verify-ssr-site-smoke.sh
```

Optional environment:

- `APPTHEORY_SSR_SITE_STACK_NAME` to override the temporary stack name
- `APPTHEORY_SSR_SMOKE_KEEP_STACK=1` to keep the deployed stack for debugging

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
