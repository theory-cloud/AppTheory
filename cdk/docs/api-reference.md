# CDK API Reference

This document is the human-readable overview. The authoritative public surface is:
- `cdk/lib/index.ts`
- `cdk/.jsii` (jsii manifest)

## Constructs (inventory)

AppTheory CDK exports constructs such as:
- `AppTheoryFunction` (Lambda wrapper defaults, including an optional fail-closed stable execution `roleName`)
- `AppTheoryFunctionAlarms` (baseline alarms)
- `AppTheoryHttpApi` (API Gateway v2 HTTP API + proxy routes)
- `AppTheoryMcpServer` (API Gateway v2 HTTP API `POST /mcp` for MCP / Bedrock AgentCore)
- `AppTheoryInstallParameters` (governed namespace CloudFormation parameters, caller-account rule, and typed tokens)
- `AppTheoryRemoteMcpServer` (API Gateway REST API v1 streaming `/mcp` for Claude Remote MCP / Streamable HTTP)
- `AppTheoryMcpProtectedResource` (API Gateway REST API v1 `/.well-known/oauth-protected-resource` for OAuth discovery)
- `AppTheoryRestApi` (API Gateway REST API v1 + single-Lambda proxy routes)
- `AppTheoryRestApiRouter` (API Gateway REST API v1 + multi-Lambda routing + full streaming parity)
- `AppTheoryWebSocketApi` (WebSocket API + routes/permissions; optional connection table + stage access logging)
- `AppTheoryQueue` (SQS queue with optional DLQ)
- `AppTheoryQueueConsumer` (SQS → Lambda event source mapping with full options)
- `AppTheoryQueueProcessor` (SQS + Lambda consumer wiring convenience wrapper)
- `AppTheoryEventBridgeHandler` (EventBridge rule/schedule + Lambda target)
- `AppTheoryEventBridgeBus` (custom EventBridge bus + explicit cross-account publish allowlist)
- `AppTheoryEventBridgeRuleTarget` (EventBridge rule → Lambda target; schedule XOR eventPattern)
- `AppTheoryHttpIngestionEndpoint` (authenticated HTTP API v2 endpoint + Lambda request authorizer + stage throttling)
- `AppTheoryS3Ingest` (secure S3 ingest bucket + optional EventBridge/SQS notifications)
- `AppTheoryS3VersionedIngress` (versioned namespace artifact bucket + exact-object upload/read grants)
- `AppTheoryVectorIndex` (S3 Vectors bucket/index plus AppTheory vectorstore env/grants)
- `AppTheoryCodeBuildJobRunner` (CodeBuild project wrapper for batch steps; safe defaults + logs + state-change hook)
- `AppTheoryDynamoDBStreamMapping` (Streams mapping + permissions)
- `AppTheoryKinesisStream` (Kinesis Data Stream create/wrap surface with encryption and grant helpers)
- `AppTheoryKinesisStreamMapping` (Kinesis stream → Lambda event-source mapping; partial-batch failures default on)
- `AppTheoryCloudWatchLogsDestination` (CloudWatch Logs destination → Kinesis with explicit source allowlists)
- `AppTheoryCloudWatchLogsSubscription` (source log group subscription attachment to a caller-provided destination ARN)
- `AppTheoryEventBusTable` (opinionated EventBus DynamoDB table + required GSIs + Lambda binding helper)
- `AppTheoryDynamoTable` (general-purpose DynamoDB table; schema-explicit + consistent defaults)
- `AppTheoryJobsTable` (opinionated Jobs table for import pipelines; schema + GSIs + TTL)
- `AppTheoryLambdaRole` (Lambda execution role helper; baseline + X-Ray + KMS + escape hatches)
- `AppTheoryMicrovmNetworkConnector` (Lambda MicroVM VPC egress connector; caller-provided VPC, subnets, and security groups)
- `AppTheoryMicrovmImage` (Lambda MicroVM image; code artifact, base image, hooks, logging, resources, environment variables, and connector references)
- `AppTheoryPathRoutedFrontend` (CloudFront distribution: multi-SPA routing + API origin + SPA rewrite)
- `AppTheoryMediaCdn` (CloudFront distribution: S3-backed media CDN; optional private media via key groups)
- `AppTheorySsrSite` (FaceTheory-first CloudFront + S3 + Lambda URL SSR/SSG/ISR deployment; see `docs/cdk/ssr-site.md`)
- Domain/cert helpers (hosted zone, certificate, custom domains)
- Higher-level "app"/SSR patterns now converge on the FaceTheory-first deployment contract rather than a weaker helper path

For the exact list and prop types, read `cdk/lib/*.d.ts`.

## Governed namespace install parameters

`AppTheoryInstallParameters` emits the ten required namespace `String` parameters without defaults and exposes their
`Ref` values as typed string tokens. It also emits `TargetAccountMatchesCaller`, which compares `TargetAccountId` with
`AWS::AccountId`. CloudFormation owns pattern and allowed-value validation; invalid install values are not rejected by
CDK synthesis.

CloudFormation Rules cannot use `Fn::Join`. The governed install-profile validator therefore retains the relational
`DnsHost == cloud-keeper.<NamespaceSlug>.theorycloud.app` check, while the `DnsHost` allowed pattern enforces the
`theorycloud.app` suffix at stack evaluation. See the canonical
[Namespace Install Parameters](../../docs/features/install-parameters.md) guide.

## Versioned namespace artifact ingress

`AppTheoryS3VersionedIngress` owns the fixed namespace release bucket posture: enabled S3 versioning, all four public
access blocks, S3-managed encryption, bucket-owner-enforced ownership, TLS-only access, and retain semantics. No
lifecycle expiration is emitted because no governed retention decision exists for pinned artifact versions.

The `grantUpload` and `grantVersionedRead` helpers grant only `s3:PutObject` and `s3:GetObjectVersion`, respectively,
on one exact `ns/<namespaceSlug>/<bundleId>` ARN. Literal locations are synthesis-validated; unresolved tokens skip
only value validation and remain CloudFormation-safe joins. Use the static `KEY_ROOT` or instance `keyRoot` accessor
instead of copying `ns/`. See the canonical
[S3 Versioned Artifact Ingress](../../docs/features/s3-versioned-ingress.md) guide.

## Stable Lambda execution role names

Set `roleName` on `AppTheoryFunction` or `AppTheoryApp` when the Lambda execution role needs a stable physical name.
`AppTheoryApp` forwards the value unchanged to its function. The function lets the Lambda L2 create its execution role,
preserving every CDK-computed managed policy, then applies the exact requested `AWS::IAM::Role.RoleName`. Concrete names
are validated at synthesis against IAM's `[\w+=,.@-]+` character set and 64-character limit. Token-valued names are
accepted and IAM validates their resolved value at deploy time, so a bad resolved name fails deployment rather than
synthesis. The token exemption keeps account-agnostic synthesis representable for the THE-2861 token-valued-input
failure class. Synthesis still fails if the generated role is not available for the rename; omitting the prop preserves
CloudFormation-generated names. This supported prop supersedes direct CloudFormation property-override escape hatches
for stable function role names.

## Kinesis and CloudWatch Logs path

The supported AppTheory Kinesis ingestion path is:

```text
AppTheoryCloudWatchLogsSubscription
  -> AppTheoryCloudWatchLogsDestination
  -> AppTheoryKinesisStream
  -> AppTheoryKinesisStreamMapping
  -> AppTheory Lambda runtime decoder
```

Use `AppTheoryKinesisStream` to create or wrap the stream, `AppTheoryKinesisStreamMapping` to connect the stream to the
consumer Lambda, `AppTheoryCloudWatchLogsDestination` to expose a fail-closed Logs destination, and
`AppTheoryCloudWatchLogsSubscription` to attach a source log group to the destination ARN. The destination requires
`allowedSourceAccounts` and/or `allowedOrganizationIds`; placeholder IDs in examples are examples only and are not live
account claims.

TypeScript uses `new AppTheoryCloudWatchLogsSubscription(...)`; Go uses
`apptheorycdk.NewAppTheoryCloudWatchLogsSubscription(...)` from
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v3`.

Keep the handler on the AppTheory runtime entrypoint and decode Kinesis-delivered CloudWatch Logs envelopes with
`DecodeCloudWatchLogsSubscription` / `decodeCloudWatchLogsSubscription` /
`decode_cloudwatch_logs_subscription`.

Canonical guide: `docs/cdk/kinesis-cloudwatch-logs.md`.
Canonical example: `examples/cdk/kinesis-cloudwatch-logs`.

## Lambda MicroVM network connector

`AppTheoryMicrovmNetworkConnector` creates the CloudFormation `AWS::Lambda::NetworkConnector` resource for
Lambda MicroVM VPC egress. The construct requires caller-owned VPC, subnet, and security group context and never
creates a VPC or falls back to a default security group.

When `operatorRole` is omitted, AppTheory creates a Lambda-trusted operator role with the EC2 network-interface
permissions required by the connector. If `operatorRole` is supplied, the role is passed through unchanged; the
caller is responsible for its trust policy and permissions.

```ts
new AppTheoryMicrovmNetworkConnector(this, "MicrovmEgress", {
  vpc,
  subnets: vpc.privateSubnets,
  securityGroups: [microvmEgressSecurityGroup],
  connectorName: "my_microvm_egress",
});
```

Package-local guide: `cdk/docs/microvm-network-connector.md`.

## Lambda MicroVM image

`AppTheoryMicrovmImage` creates the CloudFormation `AWS::Lambda::MicrovmImage` resource for Lambda MicroVM images.
It requires caller-provided code artifact URI, base image ARN/version, build role ARN, hook configuration, logging
configuration, one resources entry, and one to ten `AppTheoryMicrovmNetworkConnector` references. The normalized
CloudWatch-or-disabled posture is exposed through `IAppTheoryMicrovmImage.logging` so controllers propagate the
deployment choice instead of inferring a runtime default.

```ts
new AppTheoryMicrovmImage(this, "MicrovmImage", {
  name: "my-microvm-image",
  description: "My AppTheory MicroVM image",
  baseImageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image/base",
  baseImageVersion: "1",
  buildRoleArn: "arn:aws:iam::123456789012:role/MicrovmBuildRole",
  codeArtifact: { uri: "s3://my-artifacts/microvm/app.tar" },
  egressNetworkConnectors: [connector],
  hooks: { microvmImageHooks: { validate: AppTheoryMicrovmHookMode.ENABLED } },
  logging: { cloudWatch: { logGroup: "/aws/lambda/microvm/my-service" } },
  resources: [{ minimumMemoryInMiB: 2048 }],
});
```

Package-local guide: `cdk/docs/microvm-image.md`.

## Lambda MicroVM controller

`AppTheoryMicrovmController` creates the protected HTTP API route set for the M16 MicroVM controller contract, the
controller Lambda from caller-supplied Lambda packaging props, and the durable session registry table using the
canonical TableTheory `pk`/`sk` + `ttl` shape. It requires a Lambda request authorizer; unauthenticated routes are not
synthesized. The construct serializes the image logging posture into the reserved
`APPTHEORY_MICROVM_LOGGING` environment value and requires `executionRole` whenever that posture is CloudWatch.

```ts
new AppTheoryMicrovmController(this, "MicrovmController", {
  controller: {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromAsset("dist/microvm-controller"),
  },
  authorizer,
  microvmImage: image,
  egressNetworkConnectors: [connector],
  sessionTableName: "my-microvm-sessions",
});
```

Package-local guide: `cdk/docs/microvm-controller.md`.
