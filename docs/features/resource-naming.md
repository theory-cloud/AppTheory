---
title: Resource Naming
---

# Resource naming

AppTheory derives the physical name of every AWS resource a platform app creates from one bound context. Applications
declare logical names and stage configuration; AppTheory turns them into physical names, including the account-regional
S3 prefix and the deterministic over-budget form. The normative contract is Factory's
`theorycloud_resource_naming.v0.1`; this page describes the shipped implementation and the CDK surface.

## Bound context

The context comes from stage config. Nothing comes from environment variables.

| Field | Grammar | Notes |
|---|---|---|
| `namespace` | `[a-z0-9]+(-[a-z0-9]+)*` | Defaults to `theorycloud`. Appears only in log-source names. |
| `app` | same as namespace | The app instance id. No `/` or `_`. |
| `stage` | `[a-z][a-z0-9]{0,7}` | For example `lab` or `live`. |
| `account` | exactly 12 digits | An unresolved token fails synthesis. |
| `region` | a full Region code | For example `us-east-1`. |
| `namingProfile` | `derived` or `legacy` | Defaults to `derived`. |
| `pins` | `{type}:{logical}` → name | Required for every AppTheory-managed resource under `legacy`. |
| `loggingProfile` | `standard` or `legacy` | Defaults to `legacy`. See [Logging and visibility](./logging-and-visibility.md). |
| `retentionDays` | an accepted CloudWatch Logs value | Defaults to 30. |

A logical name is one or more segments `[a-z0-9]+(-[a-z0-9]+)*` joined by `/`, for example `audit-events` or
`logs/runtime/api`.

## Composition

`dash` names are `{app}-{stage}-{logical with / replaced by -}`. `path` names are `{lead}{app}/{stage}/{logical}`.

| Type key | Form | Limit |
|---|---|---|
| `s3_bucket` | account-regional prefix plus the CloudFormation suffix | 63 |
| `s3_vector_bucket`, `s3_vector_index` | dash | 63 |
| `dynamodb_table` | dash | 255 |
| `lambda_function` | dash | 64 |
| `sqs_queue` | dash | 80 |
| `sns_topic` | dash | 256 |
| `secret` | path, no lead | 512 |
| `ssm_parameter` | path, lead `/` | 900 (at most 15 levels) |
| `kms_alias` | path, lead `alias/` | 256 |
| `event_bus`, `event_rule`, `schedule` | dash | 256, 64, 64 |
| `alarm`, `dashboard` | dash | 255 |
| `iam_role`, `iam_managed_policy` | dash | 64, 128 |
| `state_machine`, `codebuild_project` | dash | 80, 150 |
| `api_rest`, `api_http` | dash | 128 |
| `log_delivery_source`, `log_delivery_destination` | dash | 60 |
| `log_group` | log source | 512 |

A type that is not in the table is added by a contract revision before an application uses it.

### S3 general purpose buckets

S3 buckets use the account-regional namespace. AppTheory sets `BucketNamespace: account-regional` and
`BucketNamePrefix: {app}-{stage}-{logical}`. CloudFormation appends `-{account}-{region}-an`, which only this account
can create. The prefix budget is `63 − len(suffix)`; for a 12-digit account in `us-east-1` the suffix is 26 characters,
which leaves 37 for the prefix. Longer Region codes shrink the budget.

The pinned `aws-cdk-lib` L2 exposes `bucketNamespace` and `bucketNamePrefix` on `s3.BucketProps`, so `AppTheoryBucket`
uses those props directly; no L1 property override is needed.

### Over-budget names

Only dash names and the S3 prefix shorten. A path name or a log-group name over its limit fails synthesis.

When a dash name or S3 prefix exceeds its limit, AppTheory keeps the first `limit − 9` characters, strips trailing
`-_./`, and appends `-` and the first 8 characters of lowercase, unpadded base32 of SHA-256 over the full untruncated
name. The result is deterministic and carries 40 bits of hash. The shortened form is a safety net; choose logical names
that fit.

### Legacy profile

Under `namingProfile: legacy` every AppTheory-managed resource takes its pinned physical name from `pins`, and a
resource with no pin fails synthesis. Names that CloudFormation generates today are pinned as literal names, so a
resource whose pre-change template carried no explicit name gains that literal in the template. S3 buckets keep the
global namespace, with no account-regional prefix.

## Runtime surfaces

The same primitives are exposed in each language:

- Go: `pkg/naming` — `Context`, `ValidateContext`, `PhysicalName`, `LogGroupName`, `CompilePolicy`,
  `PreviewBuild`, `ManifestBuild`, `KeeperDecision`.
- TypeScript: `physicalResourceName`, `logGroupName`, `compileVisibilityPolicy`, `visibilityPreview`,
  `visibilityManifest`, `keeperDecision` from `@theory-cloud/apptheory`.
- Python: `physical_resource_name`, `log_group_name`, `compile_visibility_policy`, `visibility_preview`,
  `visibility_manifest`, `keeper_decision` from `apptheory`.

The contract corpus lives in `contract-tests/fixtures/resource-naming/v0.1/`. A conformance runner in each language
evaluates every fixture and must agree with its `expected` value, including every rejection.

## CDK

`AppTheoryNamingContext` holds the bound values and fails synthesis on an unresolved account token, an invalid context,
or an invalid retention value. Constructs take it as an optional `namingContext` prop; **with no context every
construct synthesizes exactly as before**.

```ts
const context = new AppTheoryNamingContext(this, "Naming", {
  app: "autheory",
  stage: "lab",
  account: "998115851393",
  region: "us-east-1",
  namingProfile: AppTheoryNamingProfile.DERIVED,
  loggingProfile: AppTheoryLoggingProfile.STANDARD,
});

new AppTheoryBucket(this, "Audit", { namingContext: context, logical: "audit-events" });
new AppTheoryFunction(this, "Api", { ...functionProps, namingContext: context, logicalName: "api" });
```

`AppTheoryResourceNaming` exposes the pure primitives (`physicalName`, `logGroupName`, `compileVisibilityPolicyJson`,
`visibilityPreview`, `visibilityManifest`, `manifestJson`, `keeperDecision`) through jsii, so the Go and Python CDK
bindings use the same implementation.

Live stacks use `namingProfile: legacy` with pins and `loggingProfile: legacy` until the account moves. A legacy
construct keeps its pre-contract logging behaviour and takes names from pins verbatim.
