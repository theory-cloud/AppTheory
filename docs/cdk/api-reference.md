---
title: CDK API Reference
---

# CDK API Reference

This page is the canonical human-readable overview of the AppTheory CDK surface. For exact prop types and exported
constructs, read `cdk/.jsii`, `cdk/lib/index.ts`, and `cdk/lib/*.d.ts`.

## Core API constructs

- `AppTheoryHttpApi`: API Gateway HTTP API v2 plus Lambda proxy routes
- `AppTheoryRestApi`: API Gateway REST API v1 plus single-Lambda proxy routes
- `AppTheoryRestApiRouter`: REST API v1 multi-Lambda routing with streaming support
- `AppTheoryMcpServer`: umbrella HTTP API v2 MCP route bundle with literal `mcpPath`, runtime-served RFC 9728 discovery,
  and issuer/JWKS runtime config; omitting both auth props retains the existing POST-only AgentCore shape
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
  enabled by default
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
- `AppTheoryDynamoDBStreamMapping`
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
residue. Literal slugs and bundle IDs are synthesis-validated against the application-release patterns. Under the
accepted Option A policy, unresolved CDK tokens skip literal value validation but remain required and render through a
CloudFormation-safe join. CloudFormation resolves them at deployment; AppTheory cannot guarantee exactness for
token-valued inputs. Bucket identity is exposed through `bucketName` and `bucketArn`; the canonical root is
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

## Function log group removal policy

`AppTheoryFunction` accepts the inherited `logRemovalPolicy` prop for log groups it creates, and
`AppTheoryAppProps.logRemovalPolicy` forwards that contract to the app's named function:

```ts
new AppTheoryApp(this, "Runtime", {
  appName: "orders-api",
  code: lambda.Code.fromAsset("dist"),
  logRemovalPolicy: RemovalPolicy.RETAIN,
});
```

All AppTheory-created function log groups default to `RemovalPolicy.DESTROY`, including the anonymous path whose
function name CloudFormation generates. This matches the prototype's self-cleaning posture; for named functions it
also prevents failed deployments from leaving `/aws/lambda/<function-name>` behind and blocking a recreate. Set
`RemovalPolicy.RETAIN` explicitly when the logs must survive stack deletion. `RemovalPolicy.SNAPSHOT` fails synthesis
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

- Use `AppTheoryHttpApi` for the simplest HTTP API v2 deployment
- Use `AppTheoryRestApi` when you need REST API v1 but not multi-Lambda routing
- Use `AppTheoryRestApiRouter` when you need SSE or response streaming
- Use `AppTheoryMcpServer` for namespace MCP applications and Bedrock AgentCore. Namespace applications supply
  `authorizationServerIssuer` and `jwksUri`, then use the Go `oauth.RegisterMCPServer` helper so `/mcp` is
  authenticated and discovery is public.
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
