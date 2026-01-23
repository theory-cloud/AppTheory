# AppTheory SSR Site (Lambda URL + CloudFront) — CDK Example

This example synthesizes an opinionated **SSR site** deployment pattern:

- S3 bucket for immutable assets under `/assets/*`
- Lambda Function URL origin (response streaming enabled)
- CloudFront distribution with two origins + path routing

The construct (`AppTheorySsrSite`) also wires recommended runtime environment variables onto the SSR function:

- `APPTHEORY_ASSETS_BUCKET`
- `APPTHEORY_ASSETS_PREFIX`
- `APPTHEORY_ASSETS_MANIFEST_KEY`
- Optional (when configured): `APPTHEORY_CACHE_TABLE_NAME`, `CACHE_TABLE_NAME`, `CACHE_TABLE`

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
