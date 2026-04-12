# AppTheory SSR Site (Lambda URL + CloudFront) — CDK Example

This example synthesizes an opinionated **SSR site** deployment pattern:

- S3 bucket for immutable assets under `/assets/*`
- Lambda Function URL origin (response streaming enabled, signed through CloudFront by default)
- CloudFront distribution with two origins + path routing

The construct (`AppTheorySsrSite`) also wires recommended runtime environment variables onto the SSR function:

- `APPTHEORY_ASSETS_BUCKET`
- `APPTHEORY_ASSETS_PREFIX`
- `APPTHEORY_ASSETS_MANIFEST_KEY`
- Optional (when configured): `APPTHEORY_CACHE_TABLE_NAME`, `FACETHEORY_CACHE_TABLE_NAME`, `CACHE_TABLE_NAME`, `CACHE_TABLE`

## FaceTheory-first deployment guide

FaceTheory’s recommended topology splits CloudFront behaviors so static paths don’t traverse the SSR Lambda:

- `assets/*` → S3 (assets)
- `/_facetheory/data/*` → S3 (SSG hydration JSON)
- default `*` → Lambda Function URL (SSR + ISR)

Example configuration:

```ts
new AppTheorySsrSite(this, "Site", {
  ssrFunction: ssrFn,

  // Static routes served directly from S3 (accepts with/without leading "/").
  staticPathPatterns: ["/_facetheory/data/*"],

  // Forward FaceTheory’s tenant header to SSR when needed (normalized + de-duped).
  ssrForwardHeaders: ["x-facetheory-tenant"],

  // ISR/cache metadata table (TableTheory). Wires FACETHEORY_CACHE_TABLE_NAME + generic aliases.
  cacheTableName: "facetheory-isr-metadata",
});
```

Default SSR origin contract:

- `AppTheorySsrSite` creates the SSR Function URL with `AWS_IAM` auth and uses CloudFront Function URL OAC by default.
- Set `ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE` only as an explicit compatibility override for legacy public Function URL flows.
- Default forwarded headers are limited to safe edge context: `cloudfront-forwarded-proto`, `cloudfront-viewer-address`, `x-request-id`, and `x-tenant-id`.
- Additional app-specific headers remain opt-in via `ssrForwardHeaders`; `host` and `x-forwarded-proto` are intentionally rejected.

Notes for ISR permissions (app-defined):

- Your SSR Lambda needs **read/write** access to the S3 bucket/prefix used by your HTML store (e.g. `S3HtmlStore`).
- Your SSR Lambda needs **read/write** access to the DynamoDB table backing ISR metadata + leases (TableTheory schema).

## Prerequisites

- Node.js 24+
- `npm`

## Synth

```bash
cd examples/cdk/ssr-site
npm ci
npx cdk synth
```

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
