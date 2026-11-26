---
title: Resource Naming
---

# Resource naming

AppTheory derives the physical name of every AWS resource a platform app creates from one bound context. Applications
declare logical names and stage configuration; AppTheory turns them into physical names, including the account-regional
S3 prefix and the deterministic over-budget form. The normative contract is Factory's
`theorycloud_resource_naming.v0.1`; this page describes the shipped implementation and the CDK surface.

A **platform app** is a first-party app in namespace `theorycloud`. A **hosted deployment** is anything TheoryCloud.ai
places on a tenant's behalf, and it carries its namespace in every derived name
([Hosted deployments](#hosted-deployments-r5)): many namespaces share one pooled account, so `{app}-{stage}-{logical}`
alone would collide across tenants.

## Bound context

The context comes from stage config. Nothing comes from environment variables.

| Field | Grammar | Notes |
|---|---|---|
| `namespace` | `[a-z0-9]+(-[a-z0-9]+)*` | Defaults to `theorycloud`. A platform app's namespace appears only in log-source names; a hosted deployment's appears in every derived name. At most 12 characters, never starting `aws` or `ssm`, and never `theorycloud` for a hosted deployment (r5). |
| `hosted` | boolean | Defaults to `false`. `true` marks a deployment TheoryCloud.ai places; it must then supply `namespace`. See [Hosted deployments](#hosted-deployments-r5). |
| `app` | same as namespace | The app instance id. No `/` or `_`. |
| `stage` | `[a-z][a-z0-9]{0,7}` | For example `lab` or `live`. |
| `account` | exactly 12 digits | An unresolved token fails synthesis. For a hosted deployment TheoryCloud.ai injects it from its placement. |
| `region` | a full Region code | For example `us-east-1`. Injected the same way for a hosted deployment. |
| `namingProfile` | `derived` or `legacy` | Defaults to `derived`. |
| `pins` | `{type}:{logical}` → name | The physical name when the resource carries an explicit name today. Under a hosted deployment the name must start with its namespace component. |
| `generated` | `{type}:{logical}` list | The resource whose name CloudFormation generates today. Legacy-only, and first-party only. |
| `loggingProfile` | `standard` or `legacy` | Defaults to `legacy`. See [Logging and visibility](./logging-and-visibility.md). |
| `retentionDays` | an accepted CloudWatch Logs value | Passed from stage config; lab 30, live 90. |

A logical name is one or more segments `[a-z0-9]+(-[a-z0-9]+)*` joined by `/`, for example `audit-events` or
`logs/runtime/api`.

The `namingProfile` also selects the Security Hub-aligned defaults: a `derived` context applies them, while a `legacy`
context keeps the pinned live template byte for byte. See [Security Hub defaults](./security-hub-defaults.md).

### Hosted deployments (r5)

TheoryCloud.ai deploys AppTheory systems for many tenants into a pool of managed AWS accounts. Two namespaces in one
pooled account would derive the same `{app}-{stage}-{logical}` name, so a hosted deployment carries its namespace in
every derived name.

**The hosted handoff.** TheoryCloud.ai sets `hosted: true` and the tenant `namespace` on every deployment it places —
pooled, isolated and dedicated alike — and injects `account` and `region` from its own placement logic. Only
first-party platform apps omit `hosted`; for them the platform default (namespace `theorycloud`, the r4 forms) is
unchanged. A hosted deployment always supplies its namespace and never defaults to the platform form.

**The namespace label rule.** A hosted namespace is at most **12 characters**, follows the namespace grammar, and never
starts with `aws` or `ssm` (both are reserved by AWS). `theorycloud` is reserved for first-party platform apps, so a
hosted deployment may never use it. The cap applies to any namespace other than the reserved platform one, hosted flag
or not, because only the platform namespace keeps the r4 form.

**Hosted forms** (namespace `acme`, app `shop`, stage `lab`):

| Type | Platform form | Hosted form |
|---|---|---|
| `dash` names | `{app}-{stage}-{logical}` | `{namespace}-{app}-{stage}-{logical}` |
| `path` names | `{lead}{app}/{stage}/{logical}` | `{lead}{namespace}/{app}/{stage}/{logical}` |
| S3 `BucketNamePrefix` | `{app}-{stage}-{logical}` | `{namespace}-{app}-{stage}-{logical}` |
| log groups | `theorycloud_{namespace}_{app}_{stage}_{logical}` | unchanged — they already carry the namespace (`theorycloud_acme_shop_lab_logs_runtime_api`) |

The limits, charsets and the over-budget rule do not change; the longer stem only means a hosted name reaches the
shortened form sooner. The stem costs `len(namespace) + len(app) + len(stage) + 3` characters, so choose logical names
that fit:

| Context | Type | Logical | Result |
|---|---|---|---|
| `acme`/`shop`/`lab` | `lambda_function` | `worker` | `acme-shop-lab-worker` (fits) |
| `acme`/`shop`/`lab` | `s3_bucket` prefix | `uploads` | `acme-shop-lab-uploads` (fits) |
| `acme`/`storefront-checkout`/`lab` | `s3_bucket` prefix | `customer-uploads-archive` | `acme-storefront-checkout-lab-5cs2pek2` (shortened) |
| `northwind`/`customer-portal-analytics`/`lab` | `iam_role` | `keeper-reader-cross-account` | `northwind-customer-portal-analytics-lab-keeper-reader-c-r3njssl4` (shortened) |

**Hosted pins.** A hosted deployment's pinned name must start with its namespace component, exactly where the derived
form puts it: `{namespace}-` for `dash` names and S3 prefixes, `{lead}{namespace}/` for `path` names, and
`theorycloud_{namespace}_` for log groups. Containing the namespace elsewhere is not enough: `shop-lab-events` is not a
pin for namespace `hop`. `naming.generated` and `naming.profile: legacy` exist for the live compatibility of platform
apps only, so a hosted deployment that uses either fails synthesis.

**Refusals at synthesis.** Each names the rule it broke:

| Context | Refusal |
|---|---|
| `hosted: true` with no namespace, or an empty one | a hosted deployment must supply its namespace |
| namespace longer than 12 characters | hosted namespace longer than 12 characters |
| namespace starting with `aws` or `ssm` | hosted namespace must not start with aws or ssm |
| `hosted: true` with namespace `theorycloud` | namespace theorycloud is reserved for first-party platform apps |
| `hosted: true` with `naming.profile: legacy` or a `generated` entry | a hosted deployment takes no legacy profile or generated entries |
| a hosted pin that does not start with its namespace component | a hosted pin must start with the namespace component |

**AppTheory does not resolve or choose the account or Region.** They are naming inputs the caller supplies, so the
S3 account-regional suffix budget is the only thing they change. An unresolved token still fails synthesis as it always
did, and nothing is read from the environment. TheoryCloud.ai is the party that injected them, so its installer is the
party that validates them against the account and Region it deploys to.

**Placement is not AppTheory's.** Which accounts and Regions a tenant may be placed into, and whether a deployment's
`{namespace}-{app}` stem collides with another tenant's, is TheoryCloud.ai's placement check; AppTheory only derives
the names.

## Composition

`dash` names are `{app}-{stage}-{logical with / replaced by -}`. `path` names are `{lead}{app}/{stage}/{logical}`.
A hosted deployment prepends its namespace to both forms; see [Hosted deployments](#hosted-deployments-r5).

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
`BucketNamePrefix: {app}-{stage}-{logical}` (`{namespace}-{app}-{stage}-{logical}` for a hosted deployment).
CloudFormation appends `-{account}-{region}-an`, which only this account can create. The prefix budget is `63 − len(suffix)`; for a 12-digit account in `us-east-1` the suffix is 26 characters,
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
fails synthesis, because lab names are derived. The whole legacy profile is first-party only: a hosted deployment that
sets it, or that carries any `generated` entry, fails synthesis.

- A pin takes precedence over derivation under either profile, so a `derived` stage config may carry pins.
- **API names take pins, never generated entries.** A REST, HTTP or WebSocket API `Name` exists today (the CDK
  defaults it), so it is an explicit name. A `generated` entry for `api_rest`, `api_http` or `api_websocket` fails
  synthesis.
- **Construct logging resources take no entry.** A construct-created API or WebSocket access-log group, the Lambda
  runtime group (the `/aws/lambda/<fn>` group under the legacy profile and `logs/runtime/{logical}` under the standard
  profile), and a CloudFront logs bucket follow `logging.profile`. They consume no naming entry under either naming
  profile. Under `logging.profile: legacy` an access-log group the construct creates keeps today's
  CloudFormation-generated name; under `standard` it takes the log-source name. A `log_group` entry that names one is
  an orphan. Taking no entry is not the same as staying out of the artifact: the `/aws/lambda/<fn>` group and the
  standard-profile groups have names the context determines, so the artifact declares them; a legacy access-log group
  and a CloudFront logs bucket have CloudFormation-generated names, so they are not declared.
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

Every construct above declares each resource whose name it takes from the context, so the derived-name artifact covers
it (see [Cross-app uniqueness](#cross-app-uniqueness)). Three things are deliberately outside the artifact, and none of
them is reserved by the installer:

- **A name AppTheory only wires for a resource another stack owns.** `AppTheorySsrSite`'s
  `dynamodb_table:{logical}-isr-metadata` entry is the case in v0.1: the construct consumes the entry and passes the
  name to the SSR function, but the stack that creates the table declares it.
- **A name a construct builds from its own props instead of the context.** `AppTheoryApp` names its function from
  `appName` and its tables `{appName}-table` and `{appName}-rate-limits`; those names never pass through the context, so
  they are not in the artifact and are not reserved. The same holds for every physical-name prop listed under
  [Constructs that accept no naming context](#constructs-that-accept-no-naming-context) and
  [Names outside v0.1](#names-outside-v0.1).
- **A name CloudFormation generates.** Under the legacy logging profile a construct access-log group keeps today's
  generated name, and a `generated` entry means the same for a named type. Nothing exists to reserve.

Consuming a name without declaring it is silent: an application that calls `physicalName()` itself and passes the
result to a raw construct gets no warning, and the name does not appear in the artifact. The reservation index cannot
see it, so declaring such a resource with `declareName()` (a derived name) or `declareFixedName()` (a fixed contract
path) is the application's duty. AppTheory never infers a declaration from a string it merely handed over.

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
naming scope. A resource is identified by its owning stack plus its CloudFormation logical id, because a logical id is
unique only inside one template: two stacks of one context that both define a `Worker` construct would otherwise carry
the same stack-local ids and read as one re-declared resource. The refusal names both resources, the name and the
scope:

```
One/Worker11F36D0F and Two/Worker11F36D0F derive shop-lab-worker in scope account_region
```

A Lambda function and its IAM role may share a name because their scopes differ, and two APIs may share one because
AWS does not keep API names unique. Declaring the same CloudFormation resource twice is one resource, not two: it is
admitted and the artifact lists it once. The check runs inside one naming context, so two contexts in one stack never
collide with each other.

Every synth with a naming context writes the **derived-name artifact** the installer reserves: the complete set of
`{name, type, scope, logical_id}` for each physically named resource the context's constructs declare, where
`logical_id` is the CloudFormation logical id of the resource that carries the name **in its own stack's template**.
Constructs declare through `AppTheoryNamingContext.declareName(resourceType, logical, resource)` when the name comes
from the derivation table, and `AppTheoryNamingContext.declareFixedName(resourceType, name, resource)` when the name is
a fixed contract path. An application that names its own resource declares it the same way once the resource exists; a
name it never declares is absent from the artifact and produces no warning, because only the application knows it
created the resource.

Two rules bound **where** a context may be used, and the first refuses at synthesis rather than emit a document the
installer would read wrong:

- **One Stage.** A naming context and every stack that declares through it sit in the same CDK `Stage` (or all above
  the stages, at the `App` root). Each Stage is its own cloud assembly and CDK validates one Stage at a time, so a
  context above a Stage cannot compare that assembly's names and its document for it would be written too late to
  reach the assembly. Sharing one context across two Stages would also mean two assemblies claiming one context. A
  context created inside the Stage — in one of its stacks — works and emits that Stage's documents.
- **One environment, owned by the context and checked by the installer.** The artifact's `account` and `Region` are the
  naming context's. AppTheory does not compare them with the owning stack's environment: a stack whose account or
  Region differs from the context's, is a token, or is left unset synthesizes as it always did, and every row still
  describes the context. **TheoryCloud.ai's installer validates the artifact's account and Region against the stack it
  deploys**, and refuses a deploy whose environment is not the one the names were derived for. Nothing in the naming
  code resolves a `Lazy` or any other token of a stack's environment, so a producer that is only valid later in
  synthesis is never evaluated early (SANITY-AT-N3-09; operator ruling 2026-11-25).

For a hosted deployment the artifact carries the hosted names, because every declaration composes through its
context: the reservation index TheoryCloud.ai runs therefore reserves the namespaced forms, which never collide across
tenants. The artifact's wire schema is unchanged (`apptheory_resource_naming.derived_names.v1`) and its
`context.namespace` is the tenant namespace, so a reader can tell a hosted deployment (`context.namespace` other than
`theorycloud`) from a platform app. A platform app's artifact stays byte-identical to r4.

Two names AppTheory creates fall outside the derivation table and go through `declareFixedName()`: the Lambda service
log group `/aws/lambda/{function name}` that `AppTheoryFunction` creates under the legacy logging profile, and the
visibility manifest parameter `/theorycloud/visibility/{app}/{stage}/manifest`. Both carry the type's section 11.1
scope when they appear in the artifact (`log_group` and `ssm_parameter`: `account_region`).

A fixed name is still a physical name of its type, so it must satisfy that type's section 2 rule row — the same row the
derivation uses, not a second table — or synthesis fails:

| Rule | Applies to |
|---|---|
| charset of the type's row | every type |
| the upper length limit of the row | every type |
| the lower length limit of the row (3 for `dynamodb_table`; the only row that states one) | `dynamodb_table` |
| start and end with a letter or digit | `s3_bucket`, `s3_vector_bucket`, `s3_vector_index` |
| the row's path lead (`/` for `ssm_parameter`, `alias/` for `kms_alias`) | the path types that state one |
| at least one non-empty segment after the lead, and no empty segment | `ssm_parameter` |
| a name after the `alias/` lead | `kms_alias` |
| at most 15 levels, never beginning `aws` or `ssm` | `ssm_parameter` |
| never in the `alias/aws/` namespace | `kms_alias` |
| never ending in a hyphen and six characters | `secret` |
| never beginning `aws/` | `log_group` |

A `log_group` accepts `/` in its charset only for the two shapes contract section 3 states: a **log-source name**,
`theorycloud_{namespace}_{app}_{stage}_{logical}`, whose segments are joined with `_` precisely so no `/` appears in it,
and the **Lambda service path** `/aws/lambda/{function name}`, whose function name satisfies the `lambda_function` row.
Every other `/`-bearing log group — `arbitrary/path`, `/aws/lambda/`, `/aws/lambda/worker/suffix` — is refused, because
it is neither shape, and a path that is not a log group (`/theorycloud/visibility/...`) is an `ssm_parameter`, not a
`log_group`.

`AppTheoryResourceNaming.validatePhysicalName` is **structural** — it holds no context values — so it cannot tell
whether a slash-free log-group name is a log source at all, let alone this context's. A fixed log-group name is
therefore narrowed once more where the bound prefix is known: `AppTheoryNamingContext.declareFixedName` admits exactly
one of

- **this context's own log source**, `theorycloud_{namespace}_{app}_{stage}_` built from the context's own namespace,
  app and stage, followed by `logs` and the logical source's segments joined with `_` (so
  `theorycloud_theorycloud_shop_lab_logs_runtime_api` for `shop`/`lab`); or
- **the Lambda service path** `/aws/lambda/{function name}`, with a function name that satisfies the `lambda_function`
  row.

Anything else fails synthesis: `orders` is no log source, `theorycloud_other_app_lab_x` is another context's, and a
remainder outside the section 3 grammar (`…_logs__runtime`, `…_logs_Runtime`, `…_lab_orders`) is not the source either
(SANITY-AT-N3-08). AppTheory's own two fixed log-group names — the `/aws/lambda/{fn}` group of the legacy logging
profile and the `logs/runtime/{logical}` group of the standard profile — satisfy the rule and still reach the artifact.

Every rule above is the row's own limit: a row that states no lower length limit has none, so a one-character
`iam_role` name is admitted and a one-character `dynamodb_table` name is not. A name outside these rules is refused
instead of entering the artifact as a name the installer reserves and no deploy can create.

- **Location.** `cdk.out/<stack>.metadata.json`, in the cloud assembly the deploy already consumes. AppTheory writes it
  as cloud-assembly metadata under the type `apptheory:resource-naming/derived-names` rather than to a file of its own,
  so it travels with the assembly through `cdk synth`, `cdk deploy`, and CDK Pipelines, needs no filesystem writes
  during synthesis, and never touches a template (the synthesized `Resources` are byte-identical to a run without it).
- **Format.** One document per stack construct, carrying that stack construct's rows:

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
- **Stack attribution.** A document is recorded under the **construct path of the stack that holds the rows**, and
  every row belongs to the template that path names. A naming context shared by several stacks therefore produces one
  document per stack, and no stack's document describes another stack's resource. The refusal above still spans the
  whole context, because two stacks in one context that derive the same name in the same scope are one collision, not
  two independent ones.
- **Joining a row to its template.** The installer reads a document's construct path `P` (for example `/Shop/Lab`),
  takes the `aws:cdk:templateFile` metadata entry CDK writes under that same path `P`, and looks the row's `logical_id`
  up in that template. For an ordinary stack the file is `<stack>.template.json` and the path is that stack's. For a
  `NestedStack` the path is the nested stack's construct path (for example `/Shop/Child`) and the file is
  `<Parent><Child-hash>.nested.template.json`, so the rows describe the **nested** template and never the parent's; the
  parent's own document keeps only the parent's rows. A nested template is deployed by its parent, so the rows still
  belong to the assembly the installer is deploying.
- **An empty document.** A context whose declarations all attribute to other stacks still leaves an explicit document
  with an empty `entries` array on its own stack, because the contract requires every synth with a naming context to
  emit the artifact and the installer must be able to tell "declares nothing" from "no naming context at all". A
  context created above the stacks has no stack of its own; its documents are the ones its declarations produce.
- **Generated entries.** A `generated` entry means CloudFormation owns the name today, so nothing exists to reserve.
  Its row carries `"generated": true` and **no** `name`, and it takes no part in the check.
- **Stacks without a naming context.** No check and no artifact: synthesis is byte-identical to before this contract.

## CDK

`AppTheoryNamingContext` holds the bound values and fails synthesis on an unresolved account token, an invalid context,
an invalid retention value, or a `pins`/`generated` entry that matches no resource in the stack. A declaration fails
synthesis when its owning stack sits in another `Stage` than the context, or when a fixed name breaks its type's
section 2 rules or is a log-group name that is neither this context's log source nor the Lambda service path; the
message names the construct, the stack, the Stage and the rule. It does **not** compare the owning stack's account or
Region with the context's — the artifact's account and Region are the context's, and TheoryCloud.ai's installer
validates them against the stack it deploys. Constructs take it as an optional `namingContext` prop; **with no context
every construct synthesizes exactly as before**.

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
