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
| `pins` | `{type}:{logical}` → name | The physical name when the resource carries an explicit name today. |
| `generated` | `{type}:{logical}` list | The resource whose name CloudFormation generates today. Legacy-only. |
| `loggingProfile` | `standard` or `legacy` | Defaults to `legacy`. See [Logging and visibility](./logging-and-visibility.md). |
| `retentionDays` | an accepted CloudWatch Logs value | Passed from stage config; lab 30, live 90. |

A logical name is one or more segments `[a-z0-9]+(-[a-z0-9]+)*` joined by `/`, for example `audit-events` or
`logs/runtime/api`.

The `namingProfile` also selects the Security Hub-aligned defaults: a `derived` context applies them, while a `legacy`
context keeps the pinned live template byte for byte. See [Security Hub defaults](./security-hub-defaults.md).

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
| `api_rest`, `api_http`, `api_websocket` | dash | 128 |
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

Under `namingProfile: legacy` every resource the app names through AppTheory has exactly one entry, keyed
`{type}:{logical}`, in one of two stage-config lists:

- `pins`: a resource that carries an explicit physical name today. The construct sets the pin verbatim.
- `generated`: a resource whose name CloudFormation generates today. The construct sets no physical-name property, so
  the template keeps its pre-change shape and CloudFormation keeps today's name.

A resource with neither entry fails synthesis, and a resource with both fails synthesis. `generated` under `derived`
fails synthesis, because lab names are derived.

- A pin takes precedence over derivation under either profile, so a `derived` stage config may carry pins.
- **API names take pins, never generated entries.** A REST, HTTP or WebSocket API `Name` exists today (the CDK
  defaults it), so it is an explicit name. A `generated` entry for `api_rest`, `api_http` or `api_websocket` fails
  synthesis.
- **Construct logging resources take no entry.** A construct-created API or WebSocket access-log group, the Lambda
  runtime group (the `/aws/lambda/<fn>` group under the legacy profile and `logs/runtime/{logical}` under the standard
  profile), and a CloudFront logs bucket follow `logging.profile`. They consume no naming entry under either naming
  profile. Under `logging.profile: legacy` an access-log group the construct creates keeps today's
  CloudFormation-generated name; under `standard` it takes the log-source name. A `log_group` entry that names one is
  an orphan.
- **The orphan check is consumption-based.** `physicalName()` marks `{type}:{logical}` as used; a construct that
  consumes a suffixed key marks that exact key. An entry that no construct consumes, including an entry for a
  construct's own logging resource, fails synthesis. `AppTheoryNamingContext` runs the check at stack synthesis.
- S3 buckets keep the global namespace, with no account-regional prefix.

### Consumed entry keys

The table lists every entry key each contexted construct consumes. A construct consumes a key only when it creates (or
wires the name of) the resource; for example `AppTheoryFunction` consumes `iam_role:{logical}` only when it creates the
execution role.

| Construct | Entry keys consumed |
|---|---|
| `AppTheoryFunction` | `lambda_function:{logical}`; `iam_role:{logical}` when it creates the execution role |
| `AppTheoryBucket` | `s3_bucket:{logical}` |
| `AppTheoryHttpApi` | `api_http:{logical}` |
| `AppTheoryMicrovmController` | `api_http:{logical}` |
| `AppTheoryRestApiRouter` | `api_rest:{logical}` |
| `AppTheoryWebSocketApi` | `api_websocket:{logical}`; `dynamodb_table:{logical}-connections` when it creates the connection table |
| `AppTheoryMcpServer` | `api_http:{logical}` for its owned API; `dynamodb_table:{logical}-sessions` when session state creates the table |
| `AppTheoryMediaCdn` | `s3_bucket:{logical}-media` unless `props.bucket` supplies the bucket |
| `AppTheorySsrSite` | `s3_bucket:{logical}-assets`; `s3_bucket:{logical}-html-store` when the HTML store is configured; `dynamodb_table:{logical}-isr-metadata` under `mode: ssg-isr` when no external `isrMetadataTable` supplies the table |
| `AppTheoryKeeperVisibility` | `iam_role:keeper-reader` |
| Any construct with CloudFront standard logging (`AppTheorySsrSite`, `AppTheoryPathRoutedFrontend`, `AppTheoryMediaCdn`) | `log_delivery_source:logs/access/cdn/{logical}` and `log_delivery_destination:logs/access/cdn/{logical}` under `logging.profile: standard` |
| `AppTheoryPathRoutedFrontend` | only the CloudFront delivery entries above |

API and log-group names aside, these are the entries that must appear in `pins` (or, under `legacy`, `generated`) for
a legacy stack. Access-log groups, the Lambda runtime group and CloudFront logs buckets never appear in either list.

Every construct above that creates the resource also declares it through `declareName()`, so the derived-name artifact
covers it (see [Cross-app uniqueness](#cross-app-uniqueness)). `AppTheorySsrSite`'s
`dynamodb_table:{logical}-isr-metadata` entry is the exception: the construct only wires the name into the SSR
function, so the stack that creates the table declares it.

### Explicit name props

When an AppTheory construct has a naming context, an explicit physical-name prop fails synthesis under either
profile: `functionName` and `roleName` on `AppTheoryFunction`, `apiName` on `AppTheoryHttpApi`,
`AppTheoryRestApiRouter`, `AppTheoryWebSocketApi`, `AppTheoryMcpServer` (`ownedApi.apiName`) and
`AppTheoryMicrovmController`, `connectionTableName` on `AppTheoryWebSocketApi`, `sessionState.tableName` on
`AppTheoryMcpServer`, `isrMetadataTableName` and `cacheTableName` on `AppTheorySsrSite`, `bucketName` on
`AppTheoryBucket` and `AppTheoryMediaCdn`, and `sessionTableName` on `AppTheoryMicrovmController`. The message names the
exact entry key to use instead, including suffixes: for example `dynamodb_table:{logical}-connections`,
`dynamodb_table:{logical}-sessions`, `dynamodb_table:{logical}-isr-metadata` and `s3_bucket:{logical}-media`.
`AppTheoryMicrovmController` names only its API in v0.1, so under a context its session table stays
CloudFormation-generated; the `controller` prop is an ordinary `lambda.FunctionProps` pass-through, so the construct does
not name that function. With no context the props behave exactly as they do today.

### Constructs that accept no naming context

These constructs carry physical-name props whose type has a section 2 row but do not yet take a `namingContext`; their
names stay hand-built in stage config until their own adoption.

| Construct | Physical-name props |
|---|---|
| `AppTheoryRestApi` | `apiName` |
| `AppTheoryDynamoTable` | `tableName` |
| `AppTheoryQueue` | `queueName`, dead-letter queue name |
| `AppTheoryQueueProcessor` | `queueName` (delegates to `AppTheoryQueue`) |
| `AppTheoryEventBridgeBus` | `eventBusName` |
| `AppTheoryEventBridgeHandler` | `ruleName` |
| `AppTheoryEventBridgeRuleTarget` | `ruleName` |
| `AppTheoryKmsKey` | `aliasName`, `ssmParameterPath` |
| `AppTheoryVectorIndex` | `vectorBucketName`, `indexName` |
| `AppTheoryCodeBuildJobRunner` | `projectName`, `stateChangeRuleName` |
| `AppTheoryHttpIngestionEndpoint` | `apiName` |
| `AppTheoryCloudWatchLogsDestination` | `destinationName` |
| `AppTheoryJobsTable` | `tableName` |
| `AppTheoryEventBusTable` | `tableName` |
| `AppTheoryMicrovmNetworkConnector` | `operatorRoleName` |
| `AppTheoryLambdaRole` | `roleName` |
| `AppTheoryApp` | `roleName`, `databaseTableName`, `rateLimitTableName` |
| `AppTheoryS3Ingest` | `bucketName` |
| `AppTheoryS3VersionedIngress` | `bucketName` |
| `AppTheoryObservability` | `dashboardName` |
| `AppTheoryEnhancedSecurity` | each `secrets[].name` |
| `AppTheoryRemoteMcpServer` | `apiName`; `sessionTableName`, `streamTableName`, `taskTableName` |
| `AppTheoryMcpServer` attach mode (`api` prop set) | `sessionTableName`, `sessionState.tableName` |

### Names outside v0.1

Some name props have no section 2 type row yet, so they are outside the contract: `AppTheoryKinesisStream.streamName`;
the authorizer names on `AppTheoryHttpIngestionEndpoint` and `AppTheoryMicrovmController`;
`AppTheoryCloudWatchLogsSubscription.filterName` (`logGroupName` names an existing group); DNS-class names
(`AppTheoryApp.domainName`, `AppTheoryApiDomain.domainName`, `AppTheoryHostedZone.zoneName`,
`AppTheoryCertificate.certificateName`, `AppTheoryHttpIngestionEndpoint.domainName`);
`AppTheoryMicrovmImage.microvmImageName`; URL and header paths; and `AppTheoryObservability.serviceName` (a metric
dimension, not a physical name).

WAF names arrive through the `waf` option on `AppTheoryApp`, `AppTheoryRestApi`, `AppTheoryRestApiRouter` and
`AppTheoryHttpApi`. WAF is not in v0.1, so those names stay hand-managed.

### Logical names

A construct's default logical name is the kebab-cased leaf construct id. Where the contract's budget table uses a
different logical, the app passes an explicit `logicalName`. Table families derive the name from a suffix:
`AppTheoryWebSocketApi` names its connection table `{logical}-connections` and `AppTheoryMcpServer` names its session
table `{logical}-sessions`.

## Runtime surfaces

The same primitives are exposed in each language:

- Go: `pkg/naming` — `Context`, `ValidateContext`, `PhysicalName`, `LogGroupName`, `CompilePolicy`,
  `PreviewBuild`, `ManifestBuild`, `KeeperDecision`, `NamingScope`, `SynthCheck`.
- TypeScript: `physicalResourceName`, `logGroupName`, `compileVisibilityPolicy`, `visibilityPreview`,
  `visibilityManifest`, `keeperDecision`, `namingScope`, `synthCheck` from `@theory-cloud/apptheory`.
- Python: `physical_resource_name`, `log_group_name`, `compile_visibility_policy`, `visibility_preview`,
  `visibility_manifest`, `keeper_decision`, `naming_scope`, `synth_check` from `apptheory`.

The contract corpus lives in `contract-tests/fixtures/resource-naming/v0.1/`. A conformance runner in each language
evaluates every fixture and must agree with its `expected` value, including every rejection.

## Cross-app uniqueness

Derivation alone does not keep two apps from producing the same physical name: `{app}-{stage}-{logical}` with hyphens
inside app ids and logical names is ambiguous (app `shop`, stage `lab`, logical `lab-site-status` and app `shop-lab`,
stage `lab`, logical `site-status` both derive `shop-lab-lab-site-status`), and an over-budget shortened name can equal
a valid one. Contract r4 adds no derivation change — every existing name is unchanged and nothing is renamed — and
enforces uniqueness in three layers. AppTheory owns layer one (naming scope, below) and layer two (the synth check and
its artifact); TheoryCloud.ai's installer owns layer three, the name reservation index.

### Naming scope

Each type has the scope in which AWS requires its names to be unique.

| Scope | Types |
|---|---|
| `account` (global across Regions) | `iam_role`, `iam_managed_policy`, `dashboard` |
| `account_region` | every other type except the API names; S3 account-regional buckets carry the Region in the name |
| `not_unique` | `api_rest`, `api_http`, `api_websocket` — display names AWS does not keep unique |

A type with no stated scope cannot be reserved, so it cannot be deployed through the installer until a revision states
it: `AppTheoryResourceNaming.namingScope`, `namingScope`, and `naming_scope` refuse it. Uniqueness is per
**(scope, type, name)**, so a Lambda function and its IAM role may share a name.

### Synth check and the derived-name artifact

At synthesis a naming context refuses two **different** logical resources that derive the same name in the same
naming scope. The refusal names both CloudFormation logical ids, the name and the scope:

```
LabSiteStatus and SiteStatus derive shop-lab-lab-site-status in scope account
```

A Lambda function and its IAM role may share a name because their scopes differ, and two APIs may share one because
AWS does not keep API names unique. The check runs inside one naming context, so two contexts in one stack never
collide with each other.

Every synth with a naming context writes the **derived-name artifact** the installer reserves: the complete set of
`{name, type, scope, logical_id}` for each physically named resource the context's constructs declare, where
`logical_id` is the CloudFormation logical id of the resource that carries the name. Constructs declare through
`AppTheoryNamingContext.declareName(resourceType, logical, resource)`; an application that names its own resource with
`physicalName()` declares it the same way once the resource exists.

- **Location.** `cdk.out/<stack>.metadata.json`, in the cloud assembly the deploy already consumes. AppTheory writes it
  as cloud-assembly metadata under the type `apptheory:resource-naming/derived-names` rather than to a file of its own,
  so it travels with the assembly through `cdk synth`, `cdk deploy`, and CDK Pipelines, needs no filesystem writes
  during synthesis, and never touches a template (the synthesized `Resources` are byte-identical to a run without it).
- **Format.** One document per naming context:

  ```json
  {
    "contract": "theorycloud_resource_naming.v0.1",
    "schema": "apptheory_resource_naming.derived_names.v1",
    "context": { "namespace": "theorycloud", "app": "shop", "stage": "lab", "account": "998115851393", "region": "us-east-1" },
    "entries": [
      { "name": "shop-lab-worker", "type": "iam_role", "scope": "account", "logical_id": "WorkerServiceRole8543584E" },
      { "name": "shop-lab-worker", "type": "lambda_function", "scope": "account_region", "logical_id": "Worker11F36D0F" }
    ]
  }
  ```

- **Order.** Entries sort by `scope`, then `type`, then `name`, then `logical_id`, so the document is byte-identical
  whatever order the constructs were created in.
- **Generated entries.** A `generated` entry means CloudFormation owns the name today, so nothing exists to reserve.
  Its row carries `"generated": true` and **no** `name`, and it takes no part in the check.
- **Stacks without a naming context.** No check and no artifact: synthesis is byte-identical to before this contract.

## CDK

`AppTheoryNamingContext` holds the bound values and fails synthesis on an unresolved account token, an invalid context,
an invalid retention value, or a `pins`/`generated` entry that matches no resource in the stack. Constructs take it as
an optional `namingContext` prop; **with no context every construct synthesizes exactly as before**.

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
`visibilityPreview`, `visibilityManifest`, `manifestJson`, `keeperDecision(rules, logical, awsResult)`) through jsii, so
the Go and Python CDK bindings use the same implementation and the Keeper read decision takes the runtimes' parameter
order.

Live stacks use `namingProfile: legacy` with pins and generated entries and `loggingProfile: legacy` until the account
moves. A legacy construct keeps its pre-contract logging behaviour, sets pinned names verbatim and sets no name for a
generated entry.
