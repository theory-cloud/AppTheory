# AppTheory SSR_ONLY Provided Assets Site - CDK Example

This example is a deployable validation target for AppTheory-managed asset serving when an
`AppTheorySsrSite` is configured in `SSR_ONLY` mode with a stack-owned bucket passed through
`assetsBucket`.

It intentionally proves the provided-bucket path instead of `AppTheorySsrSite.assetsPath`:

- `AppTheorySsrSiteMode.SSR_ONLY` keeps the Lambda Function URL as the default origin.
- The SSR Function URL uses the AppTheory default `AWS_IAM` auth and CloudFront Lambda OAC.
- A private `ProvidedAssetsBucket` is passed as `assetsBucket`.
- `BucketDeployment` uploads assets under `assets/` outside `AppTheorySsrSite`.
- AppTheory still owns the CloudFront `/assets/*` and exact `/assets` S3 OAC behaviors.
- The smoke stack sets `enableLogging: false` so CloudFront log delivery cannot race auto-delete
  cleanup for this throwaway validation target.

The asset bucket remains private: block-public-access is enabled, SSL is enforced, and the only
CloudFront read grant is the AppTheory-generated service-principal policy scoped to the distribution
`SourceArn`. Direct asset behaviors use AppTheory's static asset cache policy, which does not forward
the viewer `Host` header to S3/OAC. This example does not use the legacy OAI workaround.

The SSR handler reflects `x-request-id` only after HTML escaping it. Treat all forwarded request
headers as viewer supplied when rendering deployable examples: preserve the AppTheory request-id
forwarding behavior, but escape any value before concatenating it into HTML.

## Local synth

```bash
cd examples/cdk/ssr-only-provided-assets-site
npm ci
npm run synth
```

From the repo root, the narrow deterministic assertion is:

```bash
./scripts/verify-ssr-only-provided-assets-synth.sh
```

The broader CDK example snapshot gate also covers this example:

```bash
./scripts/verify-cdk-synth.sh
```

## Authorized deploy handoff

Do not run this from an unapproved delegated session. When Factory explicitly authorizes a live Mode 3
validation, an operator can deploy with the AppTheory CDK example directly:

```bash
cd examples/cdk/ssr-only-provided-assets-site
AWS_PROFILE=Mcp npm ci
AWS_PROFILE=Mcp APPTHEORY_SSR_ONLY_PROVIDED_ASSETS_STACK_NAME=AppTheorySsrOnlyProvidedAssetsSmoke \
  npx cdk deploy AppTheorySsrOnlyProvidedAssetsSmoke --require-approval never
```

Useful outputs:

- `CloudFrontUrl`
- `CloudFrontDistributionId`
- `AssetsBucketName`
- `KnownJsAssetPath` (`/assets/app.js`)
- `KnownCssAssetPath` (`/assets/site.css`)
- `KnownTextAssetPath` (`/assets/probe.txt`)

The repo-root smoke helper deploys, checks CloudFront asset reads with an injected `x-request-id`,
and destroys the stack by default:

```bash
AWS_PROFILE=Mcp ./scripts/verify-ssr-only-provided-assets-site-smoke.sh
```

Set `KEEP_STACK=1` only when an explicitly authorized operator wants to inspect the deployed stack:

```bash
AWS_PROFILE=Mcp KEEP_STACK=1 ./scripts/verify-ssr-only-provided-assets-site-smoke.sh
```
