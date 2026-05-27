#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

example_dir="examples/cdk/ssr-only-provided-assets-site"
stack_name="AppTheorySsrOnlyProvidedAssetsSiteDemo"

need_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ssr-only-provided-assets-synth: BLOCKED (${cmd} not found)" >&2
    exit 1
  fi
}

for cmd in node npm; do
  need_cmd "${cmd}"
done

if [[ ! -f "${example_dir}/package-lock.json" ]]; then
  echo "ssr-only-provided-assets-synth: FAIL (missing ${example_dir}/package-lock.json)" >&2
  exit 1
fi

tmp_out="$(mktemp -d)"
tmp_log="$(mktemp)"

cleanup() {
  rm -rf "${tmp_out}" "${example_dir}/node_modules" >/dev/null 2>&1 || true
  rm -f "${tmp_log}"
}
trap cleanup EXIT

(cd "${example_dir}" && npm ci >/dev/null)

if ! (cd "${example_dir}" && npx cdk synth "${stack_name}" --quiet --no-notices --no-version-reporting -o "${tmp_out}" >/dev/null 2>"${tmp_log}"); then
  echo "ssr-only-provided-assets-synth: FAIL (synth failed)" >&2
  cat "${tmp_log}" >&2
  exit 1
fi

template="${tmp_out}/${stack_name}.template.json"
if [[ ! -f "${template}" ]]; then
  echo "ssr-only-provided-assets-synth: FAIL (missing synthesized template ${template})" >&2
  exit 1
fi

node - "${template}" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");

const templatePath = process.argv[2];
const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
const resources = template.Resources ?? {};
const entries = Object.entries(resources);

function resourceEntries(type) {
  return entries.filter(([, resource]) => resource.Type === type);
}

function resourceValues(type) {
  return resourceEntries(type).map(([, resource]) => resource);
}

function statements(policy) {
  const statement = policy?.PolicyDocument?.Statement ?? [];
  return Array.isArray(statement) ? statement : [statement];
}

function actionIncludes(statement, action) {
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  return actions.includes(action);
}

function principalIsPublic(principal) {
  if (principal === "*") return true;
  if (principal?.AWS === "*") return true;
  if (Array.isArray(principal?.AWS) && principal.AWS.includes("*")) return true;
  return false;
}

function refLogicalId(value) {
  return value?.Ref;
}

function getAttLogicalId(value) {
  if (Array.isArray(value?.["Fn::GetAtt"])) return value["Fn::GetAtt"][0];
  return undefined;
}

function joinIncludes(value, expected) {
  return JSON.stringify(value).includes(expected);
}

assert.equal(template.Outputs?.AppTheorySsrSiteMode?.Value, "ssr-only", "example should synthesize SSR_ONLY topology");
assert.equal(template.Outputs?.AppTheorySsrSiteModeName?.Value, "SSR_ONLY", "example should label the enum name");
assert.equal(template.Outputs?.AssetsKeyPrefix?.Value, "assets", "assets key prefix should be assets");
assert.equal(template.Outputs?.KnownJsAssetPath?.Value, "/assets/app.js", "known JS path should be output");
assert.equal(template.Outputs?.KnownCssAssetPath?.Value, "/assets/site.css", "known CSS path should be output");

const bucketEntries = resourceEntries("AWS::S3::Bucket");
const providedBucketEntry = bucketEntries.find(([logicalId]) => logicalId.startsWith("ProvidedAssetsBucket"));
assert.ok(providedBucketEntry, "provided stack-owned assets bucket should be synthesized");
const [providedBucketId, providedBucket] = providedBucketEntry;
assert.ok(
  !bucketEntries.some(([logicalId]) => logicalId.startsWith("SiteAssetsBucket")),
  "AppTheorySsrSite should not create its own AssetsBucket when assetsBucket is provided",
);
assert.ok(
  !bucketEntries.some(([logicalId]) => logicalId.startsWith("SiteCloudFrontLogsBucket")),
  "throwaway smoke example should disable CloudFront logging for deterministic cleanup",
);
assert.deepEqual(
  providedBucket.Properties?.PublicAccessBlockConfiguration,
  {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
  "provided assets bucket should block public access",
);
assert.ok(providedBucket.Properties?.BucketEncryption, "provided assets bucket should use S3-managed encryption");

const deployment = resourceValues("Custom::CDKBucketDeployment").find(
  (resource) => refLogicalId(resource.Properties?.DestinationBucketName) === providedBucketId,
);
assert.ok(deployment, "example-local BucketDeployment should upload into the provided assets bucket");
assert.equal(deployment.Properties?.DestinationBucketKeyPrefix, "assets", "BucketDeployment should upload under assets/");
assert.equal(deployment.Properties?.Prune, false, "example-local deployment should not prune outside its proof assets");

const functionUrls = resourceValues("AWS::Lambda::Url");
assert.equal(functionUrls.length, 1, "SSR_ONLY example should expose one SSR Function URL");
assert.equal(functionUrls[0].Properties?.AuthType, "AWS_IAM", "SSR Function URL must remain AWS_IAM by default");

const originAccessControls = resourceValues("AWS::CloudFront::OriginAccessControl");
assert.ok(
  originAccessControls.some(
    (resource) => resource.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType === "lambda",
  ),
  "SSR Function URL origin should use Lambda OAC",
);
assert.ok(
  originAccessControls.some(
    (resource) => resource.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType === "s3",
  ),
  "asset origin should use S3 OAC",
);

const distribution = resourceValues("AWS::CloudFront::Distribution")[0];
assert.ok(distribution, "CloudFront distribution should be synthesized");
const distributionConfig = distribution.Properties?.DistributionConfig ?? {};
assert.equal(distributionConfig.Logging, undefined, "example distribution should not configure CloudFront logging");
assert.ok(!distributionConfig.OriginGroups, "SSR_ONLY topology should not synthesize an SSG/ISR origin group");
assert.deepEqual(
  distributionConfig.DefaultCacheBehavior?.AllowedMethods,
  ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
  "SSR_ONLY default behavior should keep Lambda as the full-method default origin",
);

const origins = distributionConfig.Origins ?? [];
const behaviors = distributionConfig.CacheBehaviors ?? [];
const behaviorByPath = new Map(behaviors.map((behavior) => [behavior.PathPattern, behavior]));
const assetWildcardBehavior = behaviorByPath.get("assets/*");
const assetExactBehavior = behaviorByPath.get("assets");
assert.ok(assetWildcardBehavior, "AppTheory should generate the /assets/* direct S3 behavior");
assert.ok(assetExactBehavior, "AppTheory should generate the exact /assets direct S3 behavior");
assert.equal(
  assetWildcardBehavior.TargetOriginId,
  assetExactBehavior.TargetOriginId,
  "/assets/* and exact /assets should target the same S3 OAC origin",
);

const staticCachePolicyEntry = resourceEntries("AWS::CloudFront::CachePolicy").find(([, resource]) =>
  String(resource.Properties?.CachePolicyConfig?.Comment ?? "").includes("AppTheory direct S3 asset/data"),
);
assert.ok(staticCachePolicyEntry, "AppTheory should synthesize the direct-S3 static asset cache policy");
const [staticCachePolicyId, staticCachePolicy] = staticCachePolicyEntry;
const staticCacheConfig = staticCachePolicy.Properties?.CachePolicyConfig ?? {};
const staticCacheKey = staticCacheConfig.ParametersInCacheKeyAndForwardedToOrigin ?? {};
assert.equal(staticCacheConfig.MinTTL, 0, "static asset cache policy should preserve no-cache origin responses");
assert.equal(staticCacheConfig.DefaultTTL, 86400, "static asset cache policy should default to a 1-day TTL");
assert.equal(staticCacheConfig.MaxTTL, 31536000, "static asset cache policy should cap asset caching at 365 days");
assert.equal(staticCacheKey.HeadersConfig?.HeaderBehavior, "none", "static asset policy must not forward viewer Host");
assert.equal(staticCacheKey.CookiesConfig?.CookieBehavior, "none", "static asset policy should not forward cookies");
assert.equal(staticCacheKey.QueryStringsConfig?.QueryStringBehavior, "none", "static asset policy should not forward query strings");

for (const behavior of [assetWildcardBehavior, assetExactBehavior]) {
  assert.deepEqual(behavior.AllowedMethods, ["GET", "HEAD", "OPTIONS"], `${behavior.PathPattern} should be read-only`);
  assert.deepEqual(
    behavior.CachePolicyId,
    { Ref: staticCachePolicyId },
    `${behavior.PathPattern} should use the no-viewer-Host static asset cache policy`,
  );
  assert.equal(behavior.OriginRequestPolicyId, undefined, `${behavior.PathPattern} should not forward viewer headers`);
  const eventTypes = (behavior.FunctionAssociations ?? []).map((association) => association.EventType).sort();
  assert.deepEqual(
    eventTypes,
    ["viewer-request", "viewer-response"],
    `${behavior.PathPattern} should carry request-id viewer function associations`,
  );
}

const assetOrigin = origins.find((origin) => origin.Id === assetWildcardBehavior.TargetOriginId);
assert.ok(assetOrigin, "asset behavior should target an origin");
assert.ok(assetOrigin.S3OriginConfig, "asset origin should be S3");
assert.ok(assetOrigin.OriginAccessControlId, "asset origin should use OAC");
assert.equal(assetOrigin.OriginPath, undefined, "asset origin must not set OriginPath");
assert.equal(
  getAttLogicalId(assetOrigin.DomainName),
  providedBucketId,
  "asset origin should use the provided assets bucket regional domain name",
);
assert.equal(
  assetOrigin.S3OriginConfig?.OriginAccessIdentity,
  "",
  "asset origin should not use the legacy OAI origin access identity",
);

const bucketPolicy = resourceValues("AWS::S3::BucketPolicy").find(
  (resource) => refLogicalId(resource.Properties?.Bucket) === providedBucketId,
);
assert.ok(bucketPolicy, "provided assets bucket policy should be synthesized");
const bucketStatements = statements(bucketPolicy.Properties);
assert.ok(
  bucketStatements.some(
    (statement) =>
      statement.Effect === "Deny" &&
      actionIncludes(statement, "s3:*") &&
      statement.Condition?.Bool?.["aws:SecureTransport"] === "false",
  ),
  "provided assets bucket policy should enforce SSL",
);
assert.ok(
  bucketStatements.some(
    (statement) =>
      statement.Effect === "Allow" &&
      actionIncludes(statement, "s3:GetObject") &&
      statement.Principal?.Service === "cloudfront.amazonaws.com" &&
      joinIncludes(statement.Condition?.StringEquals?.["AWS:SourceArn"], "SiteDistribution") &&
      joinIncludes(statement.Resource, providedBucketId),
  ),
  "provided assets bucket policy should allow CloudFront service principal reads scoped to distribution SourceArn",
);
assert.ok(
  !bucketStatements.some((statement) => statement.Effect === "Allow" && principalIsPublic(statement.Principal)),
  "provided assets bucket policy should not contain public Allow statements",
);

console.log("ssr-only-provided-assets-synth: PASS");
NODE
