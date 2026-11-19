---
title: Logging and Visibility
---

# Standard logging and Keeper visibility

This page describes AppTheory's infrastructure logging profile and the visibility rules a consumer shares with
cloud-keeper. It is separate from the record-encoding [logging profiles](./logging-profiles.md): those decide the shape
of a JSON log record, while this page decides which log groups exist, who can read them, and through which role.

Both behaviours are opt-in. A CDK construct with no naming context synthesizes exactly as it did before the
resource-naming contract existed.

## Standard logging

Set `loggingProfile: AppTheoryLoggingProfile.STANDARD` on an `AppTheoryNamingContext` and pass it to the constructs.
Log retention comes from the app's stage config (`logging.retention_days`, lab 30 and live 90 per the contract); the
app passes it as `retentionDays`, which must be a value CloudWatch Logs accepts. An AppTheory construct default is not a
stage default.

### Lambda runtime

`AppTheoryFunction` creates an explicit log group named `logs/runtime/{component}`, sets Lambda's
`LoggingConfig.LogGroup` to it, and grants the execution role `logs:CreateLogStream` and `logs:PutLogEvents` on that
group. Lambda adds no permission when a log group is set through infrastructure as code, so AppTheory grants it.

### API access logging

`AppTheoryHttpApi`, `AppTheoryRestApiRouter`, `AppTheoryMcpServer` and `AppTheoryWebSocketApi` log access by default to
`logs/access/api/{api}`. The HTTP and REST format is JSON with exactly these fields:

| Field | Source |
|---|---|
| `requestId` | `$context.requestId` |
| `requestTime` | `$context.requestTime` |
| `httpMethod` | `$context.httpMethod` (REST and HTTP) |
| `routeKey` | `$context.routeKey` (HTTP and WebSocket) |
| `resourcePath` | `$context.resourcePath` (REST) |
| `status` | `$context.status` |
| `protocol` | `$context.protocol` |
| `responseLength` | `$context.responseLength` |
| `integrationLatency` | `$context.integrationLatency` (HTTP) |
| `responseLatency` | `$context.responseLatency` (REST) |
| `sourceIp` | `$context.identity.sourceIp` |

WebSocket APIs use their own field set, because the [WebSocket logging
variables](https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-logging.html) list no
`$context.protocol`, `$context.httpMethod` or `$context.responseLength`:

| Field | Source |
|---|---|
| `requestId` | `$context.requestId` |
| `requestTime` | `$context.requestTime` |
| `eventType` | `$context.eventType` |
| `routeKey` | `$context.routeKey` |
| `connectionId` | `$context.connectionId` |
| `status` | `$context.status` |
| `integrationLatency` | `$context.integrationLatency` |
| `sourceIp` | `$context.identity.sourceIp` |

The client IP is logged as delivered. Neither API Gateway nor CloudFront offers native truncation, and by operator
ruling no masking or processing step is added. Query strings, headers, cookies and bodies are not logged.

Opt out per construct with `stage.accessLogging: false` (HTTP and REST), `enableAccessLogging: false` (WebSocket), or
`ownedApi.stage.accessLogging: false` (MCP). A caller-supplied log group is used unchanged. Under a legacy naming
profile the access-log group a construct creates is a named resource like any other: a `log_group` pin sets its name
and a `log_group` generated entry leaves CloudFormation's name in place. The `/aws/lambda/<fn>` runtime group and the
CloudFront logs bucket are logging-profile resources and take no naming entry.

### CloudFront access logging

`AppTheorySsrSite`, `AppTheoryPathRoutedFrontend` and `AppTheoryMediaCdn` log access by default to
`logs/access/cdn/{distribution}` through CloudWatch Logs vended delivery:

- `AWS::Logs::DeliverySource` with `LogType: ACCESS_LOGS` over the distribution ARN;
- `AWS::Logs::DeliveryDestination` over the log group;
- `AWS::Logs::Delivery` with the record fields below.

Delivery source and destination names follow the 60-character dash rule. The resources live in `us-east-1`; a stack in
another Region fails synthesis, which is out of the contract's scope.

Record fields, in delivery order: `timestamp`, `x-edge-request-id`, `cs-method`, `cs-uri-stem`, `sc-status`,
`sc-bytes`, `time-taken`, `x-edge-result-type`, `c-ip`. No query string, cookies or referrer.

Opt out with `enableLogging: false`. Under the standard logging profile a caller-supplied `logsBucket` fails synthesis:
the profile owns the destination, so passing one would be silently ignored. The delivery is created only when the
stack's own resolved region is `us-east-1`; an unresolved stack region also fails under the standard profile.

**Output format.** The CloudFront destination format cannot be changed later without replacing the destination. The
contract settles it from `DescribeConfigurationTemplates`; until that lab evidence exists AppTheory exposes a typed
choice (`AppTheoryCloudFrontLogFormat.JSON` or `W3C`) that defaults to `W3C`.

## Legacy logging profile

`loggingProfile: AppTheoryLoggingProfile.LEGACY` keeps each construct's pre-contract behaviour: the explicit
`/aws/lambda/<function>` group with its retention and `RETAIN` removal policy and no `LoggingConfig`; access logging as
each caller configures it; S3 CloudFront logging as before; and today's defaults.

## Keeper visibility

A consumer shares log sources with cloud-keeper through include and exclude selectors in stage config. Visibility is
off by default: with no visibility block no role, policy or manifest is created.

### Selectors

A selector is an exact logical source (`logs/access/api/main`) or a prefix with a trailing `/*` (`logs/runtime/*`). A
prefix matches descendants only, not the prefix itself. The first segment must be exactly `logs`; a bare `logs` is valid
only as `logs/*`. `*` may appear only as the trailing `/*`.

A source is visible when an include matches it and no exclude does. Exclusions win. Selectors apply only inside the app's
own bound prefix, so a lookalike such as `logs/runtime-shadow/api` does not match `logs/runtime/*`. A newly deployed
component under an included prefix becomes readable without editing the rule.

### Reader role and manifest

`AppTheoryKeeperVisibility` creates, only when the consumer passes a reader principal and rules:

- the role `{app}-{stage}-keeper-reader`. Its trust policy names the reader's **account** as `Principal` for
  `sts:AssumeRole`, restricted by an `aws:PrincipalArn` condition:

  ```json
  {
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::191637461429:root" },
    "Action": "sts:AssumeRole",
    "Condition": { "ArnEquals": { "aws:PrincipalArn": "arn:aws:iam::191637461429:role/cloud-keeper-runtime" } }
  }
  ```

  The account rather than the role ARN is the principal because AWS converts a role ARN in a trust `Principal` into
  the role's unique ID: deleting and recreating Keeper's role would silently break such a trust, while condition-key
  ARNs are not converted
  ([IAM Principal element, IAM role principals](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html#principal-roles)).
  The same shape lets an app deploy before Keeper's role exists. `readerPrincipalArn` must resolve at synthesis and be
  an `arn:aws:iam::<12 digits>:role/...` ARN. Cross-account access needs **both sides**: Keeper's own role must also
  allow `sts:AssumeRole` on each reader-role ARN (same page, "All principals");
- an inline policy compiled from the rules;
- the SSM parameter `/theorycloud/visibility/{app}/{stage}/manifest`.

The compiled policy grants `logs:FilterLogEvents`, `logs:DescribeLogStreams` and `logs:GetLogEvents`: one `Allow` for the
includes and one `Deny` for the excludes. It never grants `logs:DescribeLogGroups`, Logs Insights, or Live Tail.

The manifest holds the rule version, the sources the rules match now, and the selectors. It omits the sources the rules
do not match, so the app's private source inventory is never published to the reader. Synthesis fails when the manifest
exceeds the SSM parameter value limit for its tier.

The source list is the logical names of the log groups the stack declares under the app prefix; pass `sources` to
override discovery.

### Read decision

For a reader's request about a logical source:

| Condition | Answer |
|---|---|
| No manifest, or the rules do not make the source visible | `not_shared` (no AWS log call) |
| Visible, and the read returns events | `events` |
| Visible, and the read returns no events or `ResourceNotFoundException` | `allowed_no_events` |
| Visible, but the read is denied or the account is unreachable | `not_shared` (fail closed) |

cloud-keeper consumes `KeeperDecision` / `keeperDecision` from the runtime packages, so the same rules decide reads on
every surface.

### Preview

The compiler prints the preview at synthesis, including the sources the rules do not match yet. The same preview,
minus the non-matching sources, is the manifest.
