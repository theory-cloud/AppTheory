---
title: CDK API Reference
---

# CDK API Reference

This page is the canonical human-readable overview of the AppTheory CDK surface. For exact prop types and exported
constructs, read `cdk/.jsii`, `cdk/lib/index.ts`, and `cdk/lib/*.d.ts`.

## Core API constructs

- `AppTheoryHttpApi`: API Gateway HTTP API v2 plus Lambda proxy routes; explicit, semantically identified `routes` with
  an `AppTheoryHttpApiRouteAuthorizer` posture (`IAM` or `NONE`) added alongside the greedy routes, route-keyed
  `routeSettings` throttling validated against the emitted route keys (an unknown key fails synthesis naming the keys
  the construct emits), and a configurable `stage.accessLogFormat` (default: the AppTheory JSON format)
- `AppTheoryRestApi`: API Gateway REST API v1 plus single-Lambda proxy routes
- `AppTheoryRestApiRouter`: REST API v1 multi-Lambda routing with streaming support
- `AppTheoryMcpServer`: attach-first HTTP API v2 route-family facade with authenticated MCP `POST`/`GET`/`DELETE`
  transport routes (IAM by default, or a configured JWT authorizer), public RFC 9728 and canonical/suffix RFC 8414
  discovery, and application-owned authorize/token routes; owned API, session state, logging, and throttling are the
  standalone specialization with production defaults. `routeModel` (`AppTheoryMcpRouteModel`) selects the
  route-emission model: `EXPLICIT` (the default) keeps one gateway route per derived route key, while `CONSOLIDATED`
  emits exactly `ANY /` + `ANY /{proxy+}` with one shared integration and is valid only for the `runtime-bearer` and
  `none-public` postures. `routeIdMode` (`AppTheoryMcpRouteIdMode`) selects construct-id derivation on the explicit
  model: `LEGACY` (the default) keeps the positional `Route0`, `Route1`, ... ids byte-stable, and `SEMANTIC` derives
  each id from the route method and pattern so a move or insertion does not rename unrelated routes; `cors` configures
  preflight on a construct-owned API
- `AppTheoryMcpRouteAlgebra`: versioned MCP patterns and every protected-resource, discovery, authorize, and token
  derivation consumed by the construct and mirrored Go runtime helper
- `AppTheoryMcpPaths`: canonical MCP and OAuth discovery route paths
- `AppTheoryRemoteMcpServer`: REST API v1 `/mcp` with streaming for Remote MCP
- `AppTheoryMcpProtectedResource`: deprecated URL-valued compatibility surface for a synth-time-static
  `/.well-known/oauth-protected-resource` document; `metadataPath` is its explicit static-route escape hatch
- `AppTheoryInstallParameters`: ten required governed namespace `String` parameters, a caller-account CloudFormation
  Rule, and typed `Ref` token accessors for consuming constructs
- `AppTheoryJobsTable`: opinionated DynamoDB jobs ledger table
- `AppTheoryS3Ingest`: secure S3 ingest front door with optional notifications
- `AppTheoryS3VersionedIngress`: versioned namespace artifact bucket with fixed `ns/` layout and exact-object grants
- `AppTheoryVectorIndex`: S3 vector bucket/index plus vectorstore and Bedrock embedding env/grants
- `AppTheoryCodeBuildJobRunner`: batch-step runner for import pipelines
- `AppTheoryEventBridgeBus`: custom EventBridge bus with explicit cross-account publish allowlist
- `AppTheoryEventBridgeRuleTarget`: EventBridge rule or schedule to Lambda target
- `AppTheoryKinesisStream`: create or wrap the encrypted Kinesis Data Stream used by AppTheory stream consumers
- `AppTheoryKinesisStreamMapping`: Kinesis stream to AppTheory Lambda event-source mapping with partial-batch failures
  enabled by default and an optional on-failure destination for discarded records
- `AppTheoryCloudWatchLogsDestination`: CloudWatch Logs destination and fail-closed source allowlist for Logs-to-Kinesis
  delivery
- `AppTheoryCloudWatchLogsSubscription`: source-side CloudWatch Logs subscription attachment for a caller-provided log
  group, destination ARN, filter pattern, and optional delivery role
- `AppTheoryHttpIngestionEndpoint`: authenticated HTTP API v2 ingestion endpoint with Lambda request authorizer
- `AppTheoryMicrovmNetworkConnector`: caller-owned VPC/subnet/security-group egress wiring plus typed
  ingress/egress/shell connector references for Lambda MicroVMs
- `AppTheoryMicrovmImage`: `AWS::Lambda::MicrovmImage` deployment with AppTheory hook, logging, resource, and connector
  validation
- `AppTheoryMicrovmController`: protected controller routes, controller Lambda, IAM grants, and durable `pk`/`sk`/`ttl`
  session registry table
- `AppTheorySsrSite`: FaceTheory-first CloudFront + S3 + Lambda URL deployment for SSR, SSG, and ISR
- `AppTheoryQueue`, `AppTheoryQueueConsumer`, `AppTheoryQueueProcessor`: SQS queue and consumer patterns

## Supporting constructs exported from `cdk/lib/index.ts`

- `AppTheoryFunction`: Lambda wrapper with AppTheory defaults; set `roleName` when the execution role needs a stable
  physical name
- `AppTheoryFunctionAlarms`
- `AppTheoryDynamoDBStreamMapping`: DynamoDB Streams to AppTheory Lambda event-source mapping with an optional
  on-failure destination for discarded records
- `AppTheoryDynamoTable`
- `AppTheoryEventBusTable`: durable EventBus DynamoDB table plus Lambda binding helper for publish/query/replay flows
- `AppTheoryLambdaRole`
- `AppTheoryPathRoutedFrontend`
- `AppTheoryMediaCdn`
- `AppTheoryWebSocketApi`

## Governed namespace install parameters

`AppTheoryInstallParameters` keeps namespace templates account-agnostic. It accepts no install identity as props;
instead it emits `TargetAccountId`, `NamespaceSlug`, `AccountClass`, `TargetApplicationId`, `TenantId`, `DnsHost`,
`Stage`, `PublicHostedZoneId`, `AuthorizationServerOrigin`, and `AutheoryJwksUrl` as required `String` parameters and
exposes each value as a typed string token. `TargetAccountMatchesCaller` rejects a target account that differs from
`AWS::AccountId`.

Patterns and allowed values are evaluated by CloudFormation rather than duplicated at synthesis. CloudFormation Rules
cannot use `Fn::Join`, so the governed install-profile validator retains the relational
`DnsHost == cloud-keeper.<NamespaceSlug>.theorycloud.app` check; the parameter pattern still enforces the
`theorycloud.app` suffix. See [Namespace Install Parameters](../features/install-parameters.md).

## Versioned namespace artifact ingress

`AppTheoryS3VersionedIngress` creates the namespace release bucket with versioning enabled, all four public-access-block
settings, S3-managed encryption, bucket-owner-enforced ownership, TLS enforcement, retain semantics, and an enabled
lifecycle rule that aborts incomplete multipart uploads after 7 days. It defines no object expiration or
noncurrent-version deletion because the governed artifact flow does not authorize deletion of pinned versions.

`grantUpload` grants exactly one action, `s3:PutObject`; `grantVersionedRead` grants exactly one action,
`s3:GetObjectVersion`. For literal inputs, each grant targets one exact `ns/<namespaceSlug>/<bundleId>` object ARN with
no wildcard. `s3:PutObject` inherently covers multipart create, part upload, and completion on that key, but the helper
does not grant the separate abort or part-listing actions; the lifecycle rule prevents permanent incomplete-upload
residue. Both inputs must be literal strings: literal slugs and bundle IDs are synthesis-validated against the
application-release patterns, and unresolved CDK tokens are rejected at synthesis, because a grant cannot guarantee an
exact object key for a location that CloudFormation only resolves at deployment. Bucket identity is exposed through
`bucketName` and `bucketArn`; the canonical root is
`AppTheoryS3VersionedIngress.KEY_ROOT` and the instance `keyRoot` accessor. See
[S3 Versioned Artifact Ingress](../features/s3-versioned-ingress.md).

## Stable Lambda execution role names

`AppTheoryFunctionProps.roleName` lets the Lambda L2 create its execution role, preserving every CDK-computed managed
policy, then sets the synthesized `AWS::IAM::Role.RoleName` to the exact requested value.
`AppTheoryAppProps.roleName` forwards the same contract to its named function:

```ts
new AppTheoryApp(this, "Runtime", {
  appName: "orders-api",
  code: lambda.Code.fromAsset("dist"),
  roleName: "orders-api-runtime",
});
```

When `roleName` is omitted, CloudFormation generates the role name. Concrete values must be non-empty, no more than 64
characters, and match IAM's `^[\w+=,.@-]+$` role-name pattern; AppTheory validates those constraints at synthesis.
Values for which `Token.isUnresolved(roleName)` is true are exempt from value validation so account-agnostic synthesis
remains representable for the THE-2861 token-valued-input failure class. IAM validates the resolved value at deployment,
so a bad token-resolved name fails deployment rather than synthesis. AppTheory still fails synthesis rather than
silently using an unnamed or differently named role when the generated role cannot be renamed. This prop supersedes
direct `CfnRole.addPropertyOverride("RoleName", ...)` escape hatches for stable function role names.

## Function log group retention and removal policy

`logRetention` and `logRemovalPolicy` are deprecated in the Lambda L2 (`@deprecated use logGroup instead`).
`AppTheoryFunction` accepts the inherited `logRemovalPolicy` prop for log groups it creates, and
`AppTheoryAppProps.logRemovalPolicy` forwards that contract to the app's named function. Create a
`logs.LogGroup`, configure its `retention` and `removalPolicy`, and pass it as `logGroup` instead:

```ts
const logGroup = new logs.LogGroup(this, "RuntimeLogs", {
  logGroupName: "/aws/lambda/orders-api",
  retention: logs.RetentionDays.ONE_MONTH,
  removalPolicy: RemovalPolicy.RETAIN,
});

new AppTheoryApp(this, "Runtime", {
  appName: "orders-api",
  code: lambda.Code.fromAsset("dist"),
  logGroup,
});
```

Until the deprecated props are removed, they keep working: an explicit `logGroup` wins over `logRetention`, and
combining `logGroup` with `logRemovalPolicy` fails synthesis. Without `logGroup`, the deprecated props configure the
AppTheory-created log group exactly as before.

All AppTheory-created function log groups default to `RemovalPolicy.RETAIN`, including the anonymous path whose
function name CloudFormation generates, so deleting a stack preserves the execution logs. This is a breaking default
change: an existing deployment that did not set `logRemovalPolicy` flips its function log group to `RETAIN` on its next
update. Set `RemovalPolicy.DESTROY` explicitly when the logs should be deleted with the stack. `RemovalPolicy.SNAPSHOT`
fails synthesis
because `AWS::Logs::LogGroup` does not support snapshot removal policies. The prop supersedes direct
`CfnLogGroup.applyRemovalPolicy(...)` escape hatches for AppTheory-created function log groups.

Caller-provided log groups remain caller-owned: AppTheory never changes their removal policy. Supplying both
`logGroup` and `logRemovalPolicy` fails synthesis rather than silently ignoring the requested policy. AppTheory also
fails synthesis if an AppTheory-created log group is not backed by the expected `AWS::Logs::LogGroup` resource.

Stage access-log groups are intentionally outside this function-log policy. The auto-created access-log groups in
`AppTheoryHttpApi`, `AppTheoryMcpServer`, `AppTheoryRestApiRouter`, `AppTheoryMicrovmController`, and
`AppTheoryHttpIngestionEndpoint` omit `logGroupName` and deliberately retain the CDK removal-policy default.
`AppTheoryWebSocketApi` is the sixth construct with an auto-created unnamed access-log group; it defaults to one-week
retention and applies the caller-tunable `accessLogRemovalPolicy`, which defaults to `RemovalPolicy.RETAIN`. Because
CloudFormation generates the physical names for all six groups, none can hit the fixed-name collision on redeploy that
`RemovalPolicy.DESTROY` prevents for named Lambda log groups.

## Selection guide

- Use `AppTheoryHttpApi` for the simplest HTTP API v2 deployment; add `routes` for explicit per-path postures (a full
  method+path match outranks the greedy routes) and `routeSettings` for route-level throttling
- Use `AppTheoryRestApi` when you need REST API v1 but not multi-Lambda routing
- Use `AppTheoryRestApiRouter` when you need SSE or response streaming
- Use `AppTheoryMcpServer` for the route-algebra MCP facade. Supply `api` for a shared front door or omit it for the
  standalone owned API; the MCP transport routes require credentials by default (`iam`, or `jwt` with a configured
  `transportAuthorizer`), while OAuth discovery, protected-resource metadata, authorize, and token routes stay public.
  Attaching `facade` flips the default to `runtime-bearer`, where the gateway authorizer is `NONE` and the runtime
  validates RFC 9728 bearer tokens. Then use Go `mcpfacade.RegisterMCPFacade` with explicit app-owned issuer, JWKS,
  scopes, capabilities, and handlers. A deliberately public MCP server must select
  `transportPosture: AppTheoryMcpTransportPosture.NONE_PUBLIC` and carry the mandatory `originReachability` and
  throttling floor; `runtime-bearer` additionally requires `FacadeConfig.RequireBearerToken` on the runtime side and a
  `denialSignal` declaration. `routeModel` defaults to `AppTheoryMcpRouteModel.EXPLICIT`; set
  `AppTheoryMcpRouteModel.CONSOLIDATED` to emit only `ANY /` + `ANY /{proxy+}` for the runtime router to dispatch,
  which is valid only for the `runtime-bearer` and `none-public` postures. `routeIdMode` defaults to
  `AppTheoryMcpRouteIdMode.LEGACY`; `AppTheoryMcpRouteIdMode.SEMANTIC` derives explicit route ids from method and
  pattern and is for newly created explicit APIs, because an in-place `legacy` to `semantic` switch is itself a
  create-before-delete route-key collision. See
  [MCP Server Facade Construct](../features/mcp-server-construct.md).
- Use `AppTheoryRemoteMcpServer` when REST API v1 response streaming and resumable Remote MCP transport are required;
  do not start new namespace applications on the URL-valued `AppTheoryMcpProtectedResource` compatibility construct.
- Use `AppTheorySsrSite` when you need the canonical FaceTheory-first SSR/SSG/ISR deployment story
- Use `AppTheoryJobsTable`, `AppTheoryS3Ingest`, and `AppTheoryCodeBuildJobRunner` for import pipelines
- Use `AppTheoryVectorIndex` when an import pipeline or MCP tool needs S3 Vectors semantic recall
- Use `AppTheoryMicrovmNetworkConnector`, `AppTheoryMicrovmImage`, and `AppTheoryMicrovmController` together for the
  corrective M16 AWS Lambda MicroVM golden path. The controller requires an authorizer, explicit ingress/egress/shell
  connector references, endpoint-dispatched no-hook image wiring for the live example path, token-hidden invoke routes,
  and fails closed when omitted.

Event workload wiring:

- use `AppTheoryEventBridgeRuleTarget` for scheduled workloads and EventBridge pattern intake
- use `targetProps` on EventBridge targets for DLQ, retry, and maximum-event-age policy
- use `AppTheoryDynamoDBStreamMapping` for DynamoDB Streams to Lambda wiring
- use `AppTheoryKinesisStream` plus `AppTheoryKinesisStreamMapping` for Kinesis stream consumers
- pass `onFailure` to either stream mapping to retain the records Lambda discards after retries are exhausted: an SQS
  queue (`new lambdaEventSources.SqsDlq(queue)`), an SNS topic (`new lambdaEventSources.SnsDlq(topic)`), or an S3 bucket
  (`new lambdaEventSources.S3OnFailureDestination(bucket)`). Binding the DLQ adds exactly the permission the destination
  needs (`sqs:SendMessage` or `sns:Publish`) to the consumer role, and the destination carries batch metadata — shard ID
  and sequence numbers — rather than record payloads. Lambda only sends to the destination once retries are exhausted or
  the record ages out, so a mapping that leaves `retryAttempts` and `maxRecordAge` unbounded never sends anything: pair
  `onFailure` with a bounded `retryAttempts` and `bisectBatchOnError`. Omit `onFailure` to keep the previous template
  byte-identical
- use `AppTheoryCloudWatchLogsDestination` when CloudWatch Logs subscriptions deliver through Kinesis; configure
  `allowedSourceAccounts` and/or `allowedOrganizationIds` explicitly
- use `AppTheoryCloudWatchLogsSubscription` to attach one source log group to the destination ARN from TypeScript
  (`new AppTheoryCloudWatchLogsSubscription(...)`) or Go
  (`apptheorycdk.NewAppTheoryCloudWatchLogsSubscription(...)`)
- use `AppTheoryJobsTable` when the workload needs durable run state, idempotency, leases, or record status
- keep handlers on AppTheory runtime entrypoints so routing, retry posture, and observability stay fixture-backed

Runtime guide:

- [Event Workload Contracts](../features/event-workloads.md)

Kinesis guide and example:

- [Kinesis + CloudWatch Logs](./kinesis-cloudwatch-logs.md)
- `examples/cdk/kinesis-cloudwatch-logs`

Guide:

- [FaceTheory-First SSR Site](./ssr-site.md)

MicroVM guide and example:

- [Lambda MicroVM CDK Constructs](./lambda-microvm.md)
- `examples/cdk/microvm-controller`

## AppSync note

AppTheory does not currently export an AppSync-specific CDK construct.

Use `aws-cdk-lib/aws-appsync` for the GraphQL API, schema, auth, and Lambda data source wiring, and keep the Lambda
handler on AppTheory's AppSync runtime entrypoints.

Guide:

- [AppSync Lambda Resolvers](./appsync-lambda-resolvers.md)
