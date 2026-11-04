---
title: Local runner configuration
---

# Local runner configuration

This page describes exactly what `apptheory-local` generates: the CDK and
Docker commands it runs, the environment it injects, the provider events it
builds and the responses it accepts. Everything here is deterministic and
checked by the runner's unit tests.

## Command surface

```
apptheory-local [run]  --app <cdk-app-dir> [flags]   serve the app locally
apptheory-local plan   --app <cdk-app-dir> [flags]   synthesize and print the derived surface
apptheory-local invoke --app <cdk-app-dir> --function <id> [flags]
apptheory-local invoke --handler-dir <dir> --runtime <runtime> --handler <name> [flags]
apptheory-local session --app <cdk-app-dir> [flags]   run every target with a JSON command channel
apptheory-local down   --app <cdk-app-dir> [flags]   remove this app's leftover containers and networks
```

`run` is the default when no subcommand is given. TypeScript, Python and Go
apps use the same command; the handler runtime comes from the CDK stack.
`invoke` starts one function instead of an HTTP surface. `session` starts every
function the CDK definition targets and reads one JSON command per line.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--app DIR` | required | CDK app directory (contains `cdk.json`). |
| `-c`, `--context key=value` | none | Passed to `cdk synth` unchanged. Repeatable. |
| `--assembly DIR` | none | Read an existing cloud assembly instead of synthesizing. |
| `--scratch DIR` | `<user cache>/apptheory-local` | Synthesis output and materialized inline code. Must be under `$HOME` or the working directory. Each run's subdirectory is `<scratch>/runs/<app>-<run>` and is removed when the command exits. |
| `--profile PATH` | none | Local execution profile with digest-pinned images and endpoint names. Required for `run`, `invoke` and `session`: the in-container preflight needs the Python pin. |
| `--image class=ref` | profile | Override a runtime image pin (`go`, `node`, `python`). The reference must be `…@sha256:<64 hex>`. |
| `--endpoint service=url` | none | Inject a local AWS endpoint for `service` (`dynamodb`, `sqs`, `s3`, …). Repeatable. |
| `--add-host name=address` | none | Extra `/etc/hosts` entry inside function containers. Repeatable. |
| `--backend NAME` | none | Start a profile emulator on the run network: `dynamodb`, `sqs`, or a profile container such as `moto` (KMS, STS, SSM, Secrets Manager, SNS, Kinesis, Cognito) or `s3proxy` (S3). Repeatable. |
| `--port-base N` | ephemeral | Bind the API listeners at `N`, `N+1`, …; `0` asks the OS for free ports. |
| `--name-prefix PREFIX` | derived from the app path | Container and network names. Must be unique per run. |
| `--max-concurrency N` | 32 | In-flight invocations, `1..32`. Values above 32 are refused. |
| `--delivery-concurrency N` | 4 | Concurrent handler invocations the delivery engine performs, `1..32`. The default is sized for the documented 4 CPU / ~6 GB Colima host. |
| `--clock SPEC` | `real` | `run`/`session` time source: `real`, `test`, or `test=<RFC3339 start>`. A test clock starts at the given instant, or `2026-01-01T00:00:00Z` when omitted. |
| `--json` | off | `plan`: print the derived surface as JSON on stdout; progress goes to stderr. |
| `--allow-no-surface` | off | `plan`/`session`: allow an app whose functions have no served HTTP, event or rule surface. A session still needs `--target` to start a function. |
| `--function ID` | none | `invoke`: function logical id from the CDK assembly. |
| `--event FILE` | none | `invoke`: JSON event file. Repeatable. |
| `--stdio` | off | `invoke`: read newline-delimited JSON events from stdin and keep the container warm. |
| `--target ID` | none | `session`: start this CDK function even though no route, event source or rule targets it. Repeatable. |
| `--handler-dir DIR` | none | `invoke`: built handler directory for an example with no CDK definition. Derives no routes. |
| `--runtime RUNTIME` | none | `invoke --handler-dir`: Lambda runtime (`provided.al2023`, `nodejs24.x`, `python3.14`). |
| `--handler NAME` | none | `invoke --handler-dir`: handler name (`bootstrap` for the provided runtime). |
| `--architecture ARCH` | `arm64` for provided, `x86_64` otherwise | `invoke --handler-dir`: built architecture. |
| `--memory MB` | 128 | `invoke --handler-dir`: function memory. |
| `--timeout SECONDS` | 3 | `invoke --handler-dir`: function timeout. |

Exit codes: `0` success, `1` a run/plan failure, `2` a usage error.

Run output is stable enough to script:

```
function HandlerFunction0D87A48C (provided.al2023, public.ecr.aws/lambda/provided:al2023@sha256:…) ready on 127.0.0.1:49xxx
serving httpv2 ApiCD79AAA0 at http://127.0.0.1:8131
local-run: ready
…
shutting down: removing 1 container(s) and network …
```

The address to call is on the `serving …` line. The `127.0.0.1:<port>` on the
`function …` line is the internal Runtime Interface Emulator port, not the app
URL.

`invoke` writes one result per event on stdout; progress goes to stderr:

```json
{"proxy":true,"statusCode":200,"headers":{"content-type":["application/json"]},"body":"{\"ok\":true}"}
{"proxy":false,"raw":{"batchItemFailures":[]}}
```

`proxy` is true for a Lambda proxy response. `raw` carries a handler result that
is not a proxy response (for example an SQS partial-batch result), `rawText`
carries a non-JSON result, and `handlerError` names a handler that crashed.
`--stdio` reads one JSON event per line from stdin and flushes one result per
line, so the same function container stays warm. With no event or stdin line the
command fails rather than reporting an empty success.

`session` uses the same warm-container model for every target. It prints
`local-run: ready` on stderr and then reads one JSON command per line on stdin,
writing one response per line on stdout:

```json
{"op":"describe"}
{"op":"clock.now"}
{"op":"clock.advance","duration":"90m"}
{"op":"invoke","function":"WorkerFn","event":{"Records":[]}}
{"op":"sqs.send","queue":"EventsQueue","body":"{\"kind\":\"keep\"}","messageGroupId":"gA","messageDeduplicationId":"1"}
{"op":"sqs.attributes","queue":"EventsQueue"}
{"op":"sqs.event","queue":"EventsQueue","max":10,"waitSeconds":1,"visibilitySeconds":0,"delete":true}
{"op":"ddb.stream-event","table":"GoTable","key":{"pk":"item-1"},"eventName":"INSERT"}
{"op":"eventbridge.event","rule":"GoSchedule","detail":{}}
{"op":"kinesis.cloudwatch-event","stream":"LogsStream","logStream":"local","logEvents":[{"id":"1","timestamp":0,"message":"hello"}]}
{"op":"shutdown"}
```

The full operation set is `describe`, `clock.now`, `clock.advance`, `invoke`,
`sqs.send`, `sqs.receive`, `sqs.event`, `sqs.attributes`, `ddb.put`, `ddb.get`, `ddb.scan`,
`ddb.stream-event`, `s3.put`, `eventbridge.event`, `kinesis.event`,
`kinesis.cloudwatch-event` and `shutdown`. `sqs.receive` and `sqs.event`
serialize each message's SQS system attributes under `attributes` and its
message attributes under `messageAttributes`, which is how an SNS raw delivery's
published attributes are observed. Every response is
`{"ok":true,"result":…}` or `{"ok":false,"error":…}`. An operation that
references a resource the run did not provision fails with the reason; it never
falls back to a closed endpoint. `describe` is the only operation that returns
local secrets or resolved environment values, and it carries the live
delivery-engine state under `delivery`. `clock.advance` is accepted only on a
`--clock test` run; the real clock is never advanced.

`plan --json` emits:

```json
{
  "assemblyDir": "/…/cdk.out",
  "functions": [{"logicalId": "…", "runtime": "provided.al2023", "architecture": "arm64", "memoryMb": 256, …}],
  "apis": [{"class": "httpv2", "logicalId": "…", "stage": "$default", "routes": [{"method": "ANY", "path": "/{proxy+}", "function": "…", "streaming": false}]}],
  "functionUrls": [],
  "eventSources": [{"logicalId": "…", "function": "…", "type": "sqs", "sourceName": "events", "batchSize": 100, "reportBatchItemFailures": true, "maximumBatchingWindowInSeconds": 10, "maximumConcurrency": 50, "visibilityTimeout": 300}],
  "rules": [{"logicalId": "…", "name": "…", "schedule": "rate(5 minutes)", "targets": ["…"]}],
  "skipped": [{"logicalId": "…", "kind": "AWS::Lambda::Function", "reason": "…"}]
}
```

An unserved function whose `MemorySize`/`Timeout` is a CloudFormation expression
is listed as `unresolved (<intrinsic>)`, for example `unresolved (Ref)`, instead
of a default. The JSON carries `unresolvedMemorySize`/`unresolvedTimeout` and
`memorySizeExpression`/`timeoutExpression` for the same function. A served
function with an unresolved limit still fails closed.

## Run your own app

`apptheory-local` runs any CDK app, not only the examples in this repository.
The app can come from a released module, an installed binary or a sibling
AppTheory checkout; the flags and generated events are the same in all cases.

```bash
# From a released module; <version> must contain the command (v6.5.0 or later).
go run github.com/theory-cloud/apptheory/v6/cmd/apptheory-local@<version> \
  --app ~/code/my-app --profile ~/code/my-app/local-profile.json

# Or install it once.
go install github.com/theory-cloud/apptheory/v6/cmd/apptheory-local@<version>

# Before a release, run or build from a sibling AppTheory checkout.
go run -C ~/code/AppTheory ./cmd/apptheory-local \
  --app ~/code/my-app --profile ~/code/my-app/local-profile.json
go build -C ~/code/AppTheory -o ~/bin/apptheory-local ./cmd/apptheory-local
```

TypeScript and Python apps need a Go toolchain only to run the command; their
handlers run in the official Node or Python image, not in a Go process.

The app directory must contain `cdk.json` and a local CDK CLI at
`node_modules/.bin/cdk`. A CDK v2 app declares `aws-cdk-lib` and `constructs`
and installs the CLI as a dev dependency:

```bash
npm install --save aws-cdk-lib@2.275.0 constructs@10.8.1
npm install --save-dev aws-cdk@2.1147.0
```

`HttpLambdaIntegration` is exported from
`aws-cdk-lib/aws-apigatewayv2-integrations`, which ships inside `aws-cdk-lib`;
there is no separate integrations package. The runner does not install
packages. `--profile` is required for `run`: it pins runtime images by digest
and names the endpoint variables. The smallest valid profile names the images
the app uses plus the Python image the in-container preflight needs:

#### `local-profile.json`

```json
{
  "profile": {
    "lambda": {
      "images": {
        "node": {
          "tag": "public.ecr.aws/lambda/nodejs:24",
          "digest": "sha256:8466f17dcfbec19afcfefff53964fac7bc3f7975fa132d5fd74dce53004827d0",
          "pinned": "2026-11-01"
        },
        "python": {
          "tag": "public.ecr.aws/lambda/python:3.14",
          "digest": "sha256:51985f11b2fb1949619bda27d121f38ef7d4db64423ca6189ab1d7e632527d27",
          "pinned": "2026-11-01"
        }
      }
    }
  }
}
```

Malformed JSON fails when the command starts, before synthesis. A missing image
class or an unpinned tag fails after synthesis, when the images for the served
functions are resolved, and before any function container starts; the error
names the profile path and the reason. A missing Python pin for the preflight
fails after the run network is created, still before any function container
starts.

Add a `go` pin for a Go app (`provided:al2023`) or use `python` for a Python
app. Add `dynamodbLocal` and `endpoints.dynamodb` only when the run needs
DynamoDB Local. The user guide has a complete minimal app (`package.json`,
`cdk.json`, `bin/app.js`, handler and profile) with the plan, run, curl and stop
commands: [Run an app locally](/examples/local-runner/).

## Local execution profile

`scripts/local/examples-local.json` is the checked-in profile. The runner reads
the emulator containers, Lambda images and endpoints; the harness validates the
same values.

```json
{
  "profile": {
    "dynamodbLocal": {
      "image": "amazon/dynamodb-local@sha256:7ef4a2c4…",
      "port": 8130
    },
    "containers": {
      "dynamodb-local": {"image": "amazon/dynamodb-local@sha256:7ef4a2c4…", "containerPort": 8000,
                         "command": ["-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"]},
      "moto":    {"image": "motoserver/moto@sha256:59a1965d…", "containerPort": 5000},
      "s3proxy": {"image": "andrewgaul/s3proxy@sha256:1f8915c2…", "containerPort": 80,
                  "environment": {"S3PROXY_AUTHORIZATION": "aws-v2-or-v4", "S3PROXY_IDENTITY": "dummy", "S3PROXY_CREDENTIAL": "dummy"}},
      "sqs":     {"image": "softwaremill/elasticmq-native@sha256:e4580ab9…", "containerPort": 9324}
    },
    "lambda": {
      "images": {
        "go":     {"tag": "public.ecr.aws/lambda/provided:al2023", "digest": "sha256:2dc0f1f2…", "pinned": "2026-11-01"},
        "node":   {"tag": "public.ecr.aws/lambda/nodejs:24",       "digest": "sha256:8466f17d…", "pinned": "2026-11-01"},
        "python": {"tag": "public.ecr.aws/lambda/python:3.14",      "digest": "sha256:51985f11…", "pinned": "2026-11-01"}
      }
    },
    "endpoints": {
      "dynamodb": {"container": "dynamodb-local", "env": ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_DYNAMODB", "DYNAMODB_ENDPOINT", "DDB_ENDPOINT"]},
      "kms":      {"container": "moto",           "env": ["AWS_ENDPOINT_URL_KMS", "KMS_ENDPOINT"]},
      "sts":      {"container": "moto",           "env": ["AWS_ENDPOINT_URL_STS", "STS_ENDPOINT"]},
      "s3":       {"container": "s3proxy",        "env": ["AWS_ENDPOINT_URL_S3", "S3_ENDPOINT"]},
      "sqs":      {"container": "sqs",            "env": ["AWS_ENDPOINT_URL_SQS", "SQS_ENDPOINT"]},
      "ssm":      {"container": "moto",           "env": ["AWS_ENDPOINT_URL_SSM", "SSM_ENDPOINT"]},
      "secretsmanager": {"container": "moto",     "env": ["AWS_ENDPOINT_URL_SECRETS_MANAGER", "SECRETS_MANAGER_ENDPOINT"]},
      "sns":      {"container": "moto",           "env": ["AWS_ENDPOINT_URL_SNS", "SNS_ENDPOINT"]},
      "kinesis":  {"container": "moto",           "env": ["AWS_ENDPOINT_URL_KINESIS", "KINESIS_ENDPOINT"]},
      "logs":     {"container": "moto",           "env": ["AWS_ENDPOINT_URL_LOGS", "AWS_ENDPOINT_URL_CLOUDWATCH_LOGS", "CLOUDWATCH_LOGS_ENDPOINT"]},
      "cognito-idp": {"container": "moto",        "env": ["AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER", "AWS_ENDPOINT_URL_COGNITO_IDP", "COGNITO_ENDPOINT"]}
    }
  }
}
```

`--backend NAME` starts the profile container that provides the name's
endpoints: `dynamodb` maps to the `dynamodb-local` container (the
`dynamodbLocal` shortcut still works), `moto` provides `kms`, `sts`, `ssm`,
`secretsmanager`, `sns`, `kinesis`, `logs` and `cognito-idp`, `s3proxy`
provides `s3`, and `sqs` provides `sqs` (ElasticMQ). The runner also binds its
own EventBridge `PutEvents` endpoint as `events` at start; it is not a profile
container and is injected as `AWS_ENDPOINT_URL_EVENTS`. A backend with no
endpoint fails before any container starts.

After a started backend publishes its loopback port, the runner waits up to 60
seconds for every endpoint bound to that container to answer a read-only call
over the published port: `ListTables` (DynamoDB Local), `ListKeys` or
`GetCallerIdentity` (moto KMS/STS), `DescribeParameters` (SSM), `ListSecrets`
(Secrets Manager), `ListTopics` (SNS), `ListStreams` (Kinesis),
`DescribeLogGroups` (Logs), `ListUserPools` (Cognito), `ListBuckets` (s3proxy)
and `ListQueues` (ElasticMQ). A service with
no native probe only has to accept a plain HTTP request. The wait respects cancellation and fails with the backend name, image
and last error; nothing is provisioned until it succeeds. A backend with no
published host port is reported ready without this wait.

Rules the runner enforces:

- every image is `tag@sha256:<64 hex>`; a tag-only pin is refused;
- the `go` pin must be a `public.ecr.aws/lambda/provided:` image, `node` a
  `nodejs:` image and `python` a `python:` image;
- `AWS_ENDPOINT_URL` in a service's `env` list is ignored: the runner sets the
  global override itself (the single configured endpoint, or a closed local port
  when zero or several are configured), and service-specific names always win.

## CDK synthesis

`cdk synth` runs in `--app`:

```
node_modules/.bin/cdk synth --quiet --no-notices --no-version-reporting \
  -o <scratch>/cdk.out [-c key=value …]
```

with this clean environment (everything else is inherited only if it is not
`AWS_*`, `CDK_*`, a proxy variable, or one of `DYNAMODB_ENDPOINT`,
`DDB_ENDPOINT`, `TABLE_NAME`, `QUEUE_URL`):

```
AWS_REGION=us-east-1
AWS_DEFAULT_REGION=us-east-1
AWS_ACCESS_KEY_ID=dummy
AWS_SECRET_ACCESS_KEY=dummy
AWS_EC2_METADATA_DISABLED=true
AWS_CONFIG_FILE=/dev/null
AWS_SHARED_CREDENTIALS_FILE=/dev/null
CDK_DEFAULT_ACCOUNT=123456789012
CDK_DEFAULT_REGION=us-east-1
CI=1
NO_COLOR=1
FORCE_COLOR=0
JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1
TS_NODE_TRANSPILE_ONLY=1
```

`TS_NODE_TRANSPILE_ONLY=1` keeps local synthesis independent of a stale
`cdk/node_modules`; `make verify-cdk-synth` owns type checking.

## Derived surface

| Template resource | Handling |
| --- | --- |
| `AWS::Lambda::Function` with `Metadata["aws:asset:path"]` | Runs from the assembled asset directory. |
| `AWS::Lambda::Function` with `Code.ZipFile` | Materialized as `<module>.js` / `<module>.py` under `<scratch>/inline/<logicalId>/`. |
| `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`) + `Route` + `AWS_PROXY` `Integration` | Served as HTTP API v2. `$default` routes become a catch-all. |
| `AWS::ApiGateway::RestApi` + `Resource` tree + `Method` + `AWS_PROXY` integration | Served as REST API v1 at the path reconstructed from the resource tree. `ResponseTransferMode: STREAM` and `/response-streaming-invocations` are marked streaming. |
| `AWS::Lambda::Url` (`AuthType: NONE`) | Served as a Function URL listener. `InvokeMode: RESPONSE_STREAM` is marked streaming (buffered). A URL with `AWS_IAM` is not served as a standalone URL; when a served CloudFront distribution targets it, the gateway invokes it through the signed local OAC origin instead. |
| `AWS::ApiGatewayV2::Authorizer` (`REQUEST`, simple responses) | Run for the CUSTOM routes that reference it. The transport sends a v2 REQUEST authorizer event and enforces `isAuthorized`. |
| `AWS::Lambda::EventSourceMapping` (SQS, DynamoDB Streams, Kinesis) | Reported with its function, source, batch options, filter criteria and scaling configuration; the function is started and the mapping is delivered automatically: an SQS queue (see [SQS event-source delivery](/examples/local-runner/#sqs-event-source-delivery)), a DynamoDB stream (see [DynamoDB Streams delivery](/examples/local-runner/#dynamodb-streams-delivery)) or a Kinesis stream (see [Kinesis event-source delivery](/examples/local-runner/#kinesis-event-source-delivery)). A session can still build the provider event from real local messages or a real local write. |
| `AWS::SNS::Topic`, `AWS::SNS::Subscription` and a topic's inline `Subscription` | Topics (standard and FIFO) are provisioned on moto. Every supported subscription is registered with the delivery engine and delivered automatically: a Lambda record, an SQS envelope or raw body, or a loopback HTTP POST. See [SNS subscription delivery](/examples/local-runner/#sns-subscription-delivery). SNS does not support Lambda or HTTP(S) targets on a FIFO topic; a Lambda or HTTP(S) subscription to one, a non-loopback HTTP endpoint and SMS/email/mobile push are reported under `skipped` with a named reason. |
| `AWS::Events::Rule` with a Lambda target | Reported with its schedule or event pattern and target; the function is started and the rule is delivered automatically: a schedule fires on the run clock and a pattern rule receives every matching `PutEvents` entry (see [EventBridge delivery](/examples/local-runner/#eventbridge-delivery)). A session can still build the event a rule would deliver. |
| `AWS::Logs::SubscriptionFilter` | Reported with its log group, filter and destination; the destination is a Lambda function, or an `AWS::Logs::Destination` followed to its Kinesis `TargetArn`. A Lambda destination is started and the filter is delivered automatically (see [CloudWatch Logs subscription delivery](/examples/local-runner/#cloudwatch-logs-subscription-delivery)); a destination the runner cannot deliver is reported under `skipped`. |
| `AWS::ApiGatewayV2::Api` (`ProtocolType: WEBSOCKET`) | Reported under `skipped`, never served. An app with no other surface fails with the skipped reasons. |
| `AWS::ApiGateway::Method` with a `MOCK` integration | Served from the first `IntegrationResponses` entry: its status and `method.response.header.*` parameters become the response. No function is invoked. |
| `AWS::CloudFront::Distribution`, `AWS::CloudFront::Function`, `AWS::CloudFront::CachePolicy`, `AWS::CloudFront::OriginRequestPolicy`, `AWS::CloudFront::ResponseHeadersPolicy`, `AWS::CloudFront::OriginAccessControl` | Served as the distribution's edge path on a loopback listener, with S3, Function URL and origin-group origins. A property the gateway cannot faithfully apply refuses the distribution with a named reason; a caching, compression, logging or placement property is reported. |
| `AWS::CloudFront::KeyGroup`, `AWS::CloudFront::PublicKey` | Reported only; a distribution that trusts a key group is refused because signed URLs and cookies are not verified locally. |

## Delivery engine

`run` and `session` start one delivery engine per run. It registers every
derived event-source mapping, EventBridge rule, CloudWatch Logs subscription
filter and SNS subscription at start and reports each source's state. An SQS
mapping polls ElasticMQ automatically; a DynamoDB Streams mapping polls the
table's stream on DynamoDB Local; a Kinesis mapping polls moto's stream; an
EventBridge schedule fires on the run clock and a pattern rule is armed on the
runner's own bus; a CloudWatch Logs subscription filter polls its group; an SNS
subscription is armed on its topic hub and delivers every observed publish.
Every derived kind has a deliverer.

The state vocabulary follows the Lambda event source mapping API, which reports
a mapping's lifecycle in `State` and its processing outcome in
`LastProcessingResult` ([EventSourceMappingConfiguration](https://docs.aws.amazon.com/lambda/latest/dg/API_EventSourceMappingConfiguration.html)):

| State | Meaning |
| --- | --- |
| `registered` | The kind has a deliverer and the source is registered. |
| `polling` | A queue or stream deliverer is polling the backend. |
| `armed` | A schedule or rule deliverer is waiting for the clock, or an SNS subscription is attached to its topic hub. |
| `paused` | Registered, not delivering. |
| `stopped` | The deliverer stopped at shutdown. |
| `failed` | The deliverer could not start or deliver; `lastError` carries the cause. |
| `not-delivered` | The source kind has no deliverer yet; `task` and `reason` name the implementing task. |

Each entry also reports `delivered`, `failed` and (for an SNS subscription)
`filtered` counts, `lastError` and `paused`; an SQS source reports `left`
(records left for redelivery), `inflight` and `peakInflight`; a DynamoDB Streams
mapping reports `discarded` (records sent to its on-failure destination); an
EventBridge rule reports `fired`, `delivered`, `failed` and `deadLettered`; a
Kinesis mapping also reports `discarded`; a CloudWatch Logs subscription
reports `filtered`. `plan` prints the state the engine would register (and
carries it under `delivery` in `plan --json`); every derived kind is
`registered` because it has a deliverer. `session describe` reports the live state:

```json
"delivery": {
  "running": true,
  "clock": {"mode": "test", "now": "2026-01-01T00:00:00Z"},
  "concurrency": 4,
  "sources": [
    {"id": "WorkerFnEventSourceMapping", "kind": "sqs", "function": "WorkerFn",
     "state": "polling", "delivered": 12, "failed": 0, "inflight": 0,
     "peakInflight": 2, "left": 0, "paused": false}
  ]
}
```

`--delivery-concurrency` bounds concurrent handler invocations the engine
performs (`1..32`, default 4). An SQS mapping's
`ScalingConfig.MaximumConcurrency` (2–1000) bounds its batches within that
global bound. `--clock real` is the default; `--clock test[=<RFC3339 start>]`
makes the batching window and visibility deadlines deterministic, and the
`clock.now`/`clock.advance` session operations read and move it. The clock does
not slow ElasticMQ's own wall-clock timers or the runtime images; the exact
boundary is documented in
[What the test clock controls](/examples/local-runner/#what-the-test-clock-controls).

An SQS mapping's `FilterCriteria` is validated when the mapping is derived
against the EventBridge pattern grammar Lambda documents
([Lambda event filtering](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html),
[EventBridge comparison operators](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-content-based-filtering.html)).
A scalar where a rule list is required, an unknown operator (`wildcard` and
`cidr` among them), a `numeric` list
that is not the documented operator/number form, a non-boolean `exists`, a
non-string `prefix`/`suffix`/`equals-ignore-case`, a malformed `anything-but`, a
non-object `$or` entry, an empty list and a pattern over the documented
4096-character maximum each refuse the plan with the mapping, the filter index
and the offending key and value named. `exists` matches leaf nodes only, and
`anything-but` supports the `prefix` and `suffix` object forms. If an accepted
pattern still cannot be evaluated at delivery time, the deliverer reports the
failure, leaves the whole batch for redelivery and deletes nothing.

A FIFO mapping runs one receive loop locally: one batch per queue is in flight
and message groups are not processed in parallel. AWS preserves per-group order
while processing different groups concurrently; the local one-loop form
preserves order at the cost of that parallelism.

A DynamoDB Streams mapping reads the provisioned table's stream with
`DescribeStream`, `GetShardIterator` and `GetRecords`. `BatchSize` defaults to
100; a positive `MaximumBatchingWindowInSeconds` closes the batch on the run
clock. `StartingPosition` is `TRIM_HORIZON` or `LATEST` (`AT_TIMESTAMP` is
refused for DynamoDB). `FilterCriteria` uses the same validated EventBridge
grammar as SQS, applied to the record (`eventName`, `eventSourceARN`,
`dynamodb.Keys` and the images); a record that matches nothing is advanced past
without an invocation. `ReportBatchItemFailures` checkpoints at the lowest
failed sequence number, `BisectBatchOnFunctionError` splits a failed batch,
`MaximumRetryAttempts` and `MaximumRecordAgeInSeconds` are evaluated on the run
clock, and a discarded batch goes to `DestinationConfig.OnFailure` as the
documented invocation record on local SQS or SNS. `ParallelizationFactor` keeps
records with the same partition key in order. An expired iterator is re-seeked
after the last consumed record, and child shards of a closed shard are picked
up. TTL is performed by the runner on the run clock because DynamoDB Local never
expires an item; the delete goes through DynamoDB Local and the resulting REMOVE
record carries the documented service `userIdentity`. The observed DynamoDB
Local deviations and their normalization are listed in
[DynamoDB Streams delivery](/examples/local-runner/#dynamodb-streams-delivery).

EventBridge is served by the runner itself: the `PutEvents` JSON protocol
listener binds every interface and is injected into every function as
`AWS_ENDPOINT_URL_EVENTS` and `AWS_ENDPOINT_URL_EVENTBRIDGE`, and the session
reports the loopback URL under the `events` endpoint. The pinned moto accepted PutEvents and simple patterns but
ignored `Input`/`InputPath`/`InputTransformer`, could not reach the RIE or
ElasticMQ, and had no schedule or retry/DLQ behavior, so the runner owns the
bus. A `rate(...)` or `cron(...)` rule fires on the run clock and delivers the
documented Scheduled Event envelope with the CDK rule ARN. A pattern rule
matches the documented EventBridge grammar over the full envelope and accepts
Lambda, SQS (including a FIFO message group from `SqsParameters`) and SNS
targets with `Input`, `InputPath` or `InputTransformer` (including the
predefined `aws.events.*` variables). `RetryPolicy` and `DeadLetterConfig` use
the run clock and deliver the failed event to the standard SQS DLQ with
`RULE_ARN`, `TARGET_ARN`, `ERROR_CODE`, `ERROR_MESSAGE`,
`EXHAUSTED_RETRY_CONDITION` and `RETRY_ATTEMPTS`. The cron parser supports the
documented `*`, `?`, lists, ranges, steps and names and refuses the `L`, `W` and
`#` forms by name. A scheduled rule is only valid on the default bus. No
example synthesizes an EventBridge Scheduler schedule. The full behavior and
the moto probe are in
[EventBridge delivery](/examples/local-runner/#eventbridge-delivery).

A Kinesis mapping uses the shared stream poller with DynamoDB Streams: batch
size, batching window on the run clock, filter criteria, `ReportBatchItemFailures`,
bisect, retry attempts, record age, the on-failure record and iterator re-seek.
It adds the three Kinesis starting positions (`TRIM_HORIZON`, `LATEST`,
`AT_TIMESTAMP`), the documented Kinesis record shape (base64 `data`,
`partitionKey`, `sequenceNumber`, `approximateArrivalTimestamp`, CDK stream ARN)
and partition-key lanes for `ParallelizationFactor`. The shard list is re-read
so a closed shard's children are started. The observed moto deviations and their
normalization are in
[Kinesis event-source delivery](/examples/local-runner/#kinesis-event-source-delivery).

CloudWatch Logs has two halves. Function log capture follows every started
container's stdout/stderr with `docker logs` and writes it to the
`/aws/lambda/<function name>` group through the real `PutLogEvents` API on
moto, with wall-clock ingestion timestamps; the platform-style lines the
official runtime image prints itself (`START`/`END`/`REPORT` and the
rapid-runtime `INIT`/`INVOKE` lines) are captured with the handler's own output. A
subscription filter polls its group with `FilterLogEvents`, applies the
supported filter patterns (blank, terms with `?`/`-`/quotes, and JSON
`$.path = value` with `&&`/`||`/parentheses) and delivers the documented
gzip payload: `awslogs.data` (base64 gzip) to a Lambda target, or the same gzip
bytes as Kinesis record data to a stream destination, with `Distribution`
choosing the partition key. Regex patterns, array selectors and field selectors
are refused at plan time. The full behavior is in
[CloudWatch Logs subscription delivery](/examples/local-runner/#cloudwatch-logs-subscription-delivery).

An SNS subscription runs on a per-topic hub. At provisioning the runner creates
one drain queue on moto's own SQS and subscribes it to the topic without raw
message delivery, so moto writes the documented notification envelope and the
runner observes every publish on the same path for every subscription. A
`FilterPolicy` is evaluated for both scopes; `$or` is recognized only when its
value is an array of at least two objects and none of those objects has a
reserved keyword as a field name, otherwise `$or` is an ordinary attribute or
property name
([OR logic](https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html)).
An exact-value rule compares a `Number` attribute's textual form; use `numeric`
for numeric comparison, because AWS does not pin the exact-value form. A FIFO
topic uses a FIFO drain queue with content-based deduplication, so the drain
message also carries `MessageGroupId` and `MessageDeduplicationId`. The runner
does not create the application's subscriptions in moto; it performs the
fan-out itself and records one attempt per subscription: a success increments
`delivered`, a filter miss increments `filtered`, and a target failure
increments `failed` with `lastError`. There is no retry: AWS applies the
subscription's delivery policy and dead-letter queue, while the local runner
delivers once. The fan-out is also available in-process as
`Runner.PublishLocal(topicARN, message)` (and `PublishLocalMessage` for
attributes, a subject and FIFO ids), for E3 and E4 targets that publish without
going through moto; it takes the same filter and target path as an observed
publish.

Shutdown drains in-flight deliveries for up to five seconds, then cancels and
stops the deliverers.

## CloudFront distributions

A synthesized `AWS::CloudFront::Distribution` is the delivery definition. The
gateway reads its `DistributionConfig` and the policies and functions it
references from the same cloud assembly the Lambda surface comes from. No
second route table exists.

### Behavior selection

CloudFront selects a cache behavior by the **original** viewer path, before a
viewer-request function can rewrite it. The gateway evaluates `CacheBehaviors`
in the order the template lists them and then `DefaultCacheBehavior`. A path
pattern may omit its leading slash; matching is case-sensitive, `*` matches any
run of characters (including none) and `?` matches exactly one character. A
function that changes the URI does not change the selected behavior.

`AllowedMethods` is enforced after the viewer-request function. A method the
behavior does not allow receives a 403 with a CloudFront-style error body and
the origin is not called. `HEAD` is allowed whenever `GET` is. CloudFront
documents the viewer-request trigger and the 403 (Invalid method) response
separately, but not their relative order; running the function first is the
local gateway's choice, so a function can answer a request whose method the
behavior does not allow.

`CachedMethods` does not admit or refuse a method; it decides whether an OPTIONS
request may fail over to an origin group's secondary member. GET and HEAD always
fail over; OPTIONS does so only when the behavior lists it in `CachedMethods`.

### Request phases

1. viewer-request function (if the behavior declares one);
2. `AllowedMethods`;
3. `DefaultRootObject` for a request whose URI is `/`;
4. cache policy + origin request policy, then the origin;
5. viewer-response function (if declared) on the origin response;
6. response headers policy.

A viewer-request function that returns a response short-circuits steps 2–5: the
response is sent to the viewer and the response headers policy is applied. A
viewer-response function never sees the origin body; it may replace the body,
change the status, or add/remove headers and cookies.

### CloudFront Functions event

The event is version `1.0`:

```json
{
  "version": "1.0",
  "context": {
    "distributionDomainName": "<loopback host>",
    "distributionId": "LOCAL<hash>",
    "eventType": "viewer-request",
    "requestId": "<request id>"
  },
  "viewer": {"ip": "<viewer ip>"},
  "request": {
    "method": "GET",
    "uri": "/path",
    "querystring": {"name": {"value": "value"}},
    "headers": {"host": {"value": "..."}},
    "cookies": {"name": {"value": "..."}}
  }
}
```

Header names are lower-cased and a repeated name carries `multiValue`. An
edited `multiValue` array is applied and its first entry replaces `value`; an
edit to `value` alone is applied and the remaining `multiValue` entries stay
unchanged, as CloudFront documents. The `Cookie` header is not part of
`headers`; it is split into `cookies`. A viewer-response event adds `response`
(`statusCode`, `statusDescription`, `headers`, `cookies`; no body). `distributionId` is a stable local placeholder
derived from the distribution's logical id, and `distributionDomainName` is the
loopback host the viewer used.

### Function executor

The executor runs the exact `FunctionCode` string from the template in a fresh
Node `vm` context per invocation. The context is strict — the runtime's
`"use strict";` prologue is prepended and the function body is not rewritten —
has a fixed `Date` for the invocation, and exposes only the documented surface:

| Runtime | Modules and globals |
| --- | --- |
| `cloudfront-js-2.0` | `require('crypto')`, `require('querystring')`, `require('buffer')`, `require('cloudfront')` (its `kvs()` throws), `Buffer`, `TextEncoder`, `TextDecoder`, `console.log` (one string) |
| `cloudfront-js-1.0` | `require('crypto')`, `require('querystring')`, `console.log`; `const`, `let`, `async` and `await` are rejected before execution |

Both runtimes have no network, file system, `process`, timers, `eval`,
`Function` constructor or environment access. `Buffer` and the text codecs
implement the documented methods the gateway supports; an unimplemented method
throws a `TypeError` instead of silently behaving differently, and CloudFront's
nonstandard string helpers (`bytesFrom`, `toBytes`, `toUTF8`, and the others)
are not implemented. A thrown error, invalid return,
changed `request.method`, `Set-Cookie` in a request or response header, a
Promise return or an invalid base64 body is a 503-class failure with a clear
log; it is never a pass-through. The executor's watchdog is 5 seconds; it does
not enforce CloudFront's 1 ms CPU budget. Node's `vm` is not a hardened
security boundary; it runs the app developer's own generated code.

### Managed policy table

A behavior policy referenced by ID is accepted only from this pinned table. A
custom policy (`Ref`) is read from the assembly. The table is checked by a test
against every snapshot the constructs ship.

Cache policies:

| ID | Name | Forwarded to the origin |
| --- | --- | --- |
| `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` | CachingDisabled | no headers, cookies or query strings |
| `658327ea-f89d-4fab-a63d-7e88639e58f6` | CachingOptimized | no headers, cookies or query strings |
| `b2884449-e4de-46a7-ac36-70bc7f1ddd6d` | CachingOptimizedForUncompressedObjects | no headers, cookies or query strings |
| `2e54312d-136d-493c-8eb9-b001f22f67d2` | Amplify | `authorization`, `cloudfront-viewer-country`, `host`; all cookies and query strings |
| `08627262-05a9-4f76-9ded-b50ca2e3a84f` | Elemental-MediaPackage | `origin`; query `aws.manifestfilter`, `start`, `end`, `m` |
| `83da9c7e-98b4-4e11-a168-04f0df8e2c65` | UseOriginCacheControlHeaders | `host`, `origin`, `x-http-method-override`, `x-http-method`, `x-method-override`; all cookies |
| `4cc15a8a-d715-48a4-82b8-cc0b614638fe` | UseOriginCacheControlHeaders-QueryStrings | the same headers; all cookies and query strings |

A CloudFront-only header listed here (`cloudfront-viewer-country`, for example)
is omitted when the gateway cannot derive a truthful local value; the policy
parser reports that gap instead of fabricating a country, device or TLS value.

Origin request policies:

| ID | Name | Forwarded to the origin |
| --- | --- | --- |
| `216adef6-5c7f-47e4-b989-5492eafa07d3` | AllViewer | every viewer header (including Host), all cookies and query strings |
| `33f36d7e-f396-46d9-90e0-52428a34d9dc` | AllViewerAndCloudFrontHeaders-2022-06 | every viewer header, all cookies/query, plus the derivable CloudFront headers |
| `b689b0a8-53d0-40ab-baf2-68738e2966ac` | AllViewerExceptHostHeader | every viewer header except Host; Host becomes the origin domain; all cookies/query; CloudFront headers |
| `59781a5b-3903-41f3-afcb-af62929ccde1` | CORS-CustomOrigin | `origin`; no cookies or query strings |
| `88a5eaf4-2fd4-4709-b370-b4c650ea3fcf` | CORS-S3Origin | `origin`, `access-control-request-headers`, `access-control-request-method`; no cookies/query |
| `775133bc-15f2-49f9-abea-afb2e0bf67d2` | Elemental-MediaTailor-PersonalizedManifests | `origin`, `access-control-request-headers`, `access-control-request-method`, `user-agent`, `x-forwarded-for`; all query |
| `bf0718e1-ba1e-49d1-88b1-f726733018ae` | HostHeaderOnly | `host` only |
| `acba4595-bd28-49b8-b9fe-13317c0390fa` | UserAgentRefererHeaders | `user-agent`, `referer` only |

For an Amazon S3 origin, the four policies marked with a query-string setting
above (AllViewer, AllViewerAndCloudFrontHeaders-2022-06,
AllViewerExceptHostHeader and Elemental-MediaTailor-PersonalizedManifests)
do not forward `response-content-type`,
`response-content-disposition` or `response-content-encoding`; a custom policy
forwards them as configured. The S3 origin applies this suppression through
`OriginRequest.SuppressS3ResponseOverrides`.

Response headers policies:

| ID | Name | Applied |
| --- | --- | --- |
| `60669652-455b-4ae9-85a4-c4c02393f86c` | SimpleCORS | `Access-Control-Allow-Origin: *` |
| `5cc3b908-e619-4b99-88e5-2cf7f45965bd` | CORS-With-Preflight | allow origin/methods/expose headers |
| `67f7725c-6f97-4210-82d7-5512b31e9d03` | SecurityHeadersPolicy | Referrer-Policy, HSTS, X-Content-Type-Options, X-Frame-Options, X-XSS-Protection |
| `e61eb60c-9c35-4d20-a928-2b84e02af89c` | CORS-and-SecurityHeadersPolicy | SimpleCORS + security headers |
| `eaab4381-ed33-4a86-88ca-d9558dc6cd63` | CORS-with-preflight-and-SecurityHeadersPolicy | CORS-With-Preflight + security headers |

### Origin request policy application

The cache policy and the origin request policy are combined. Headers, cookies
and query strings each have `none`, `whitelist`, `all` and `allExcept` modes
(the cache policy does not use `all`/`allExcept`); a union is forwarded to the
origin. A viewer-supplied `CloudFront-*` header is stripped and replaced only
when the policy asks for a header the gateway can derive:

- `cloudfront-forwarded-proto` is `http`;
- `cloudfront-viewer-address` is the loopback viewer address;
- `cloudfront-viewer-http-version` is the request's HTTP version.

CloudFront device, location and TLS headers have no truthful local value and are
omitted; the policy parser reports this. Host follows the policy: `AllViewer`
and a `host` whitelist forward the viewer Host, `AllViewerExceptHostHeader` uses
the origin domain, and a policy that forwards no Host also uses the origin
domain (empty for an origin group, whose origin implementation chooses the
member). For an S3 or Function URL origin the topology records a local
placeholder domain; the origin implementation sets the endpoint it actually
reaches. `OriginPath` is applied to the origin request path, not to the viewer
URI.

### Response headers policy application

The policy is applied after the viewer-response function. Remove headers run
first, then CORS, security headers and custom headers. Each security/custom
header has its own override flag: `true` replaces the origin header, `false`
keeps the origin value and adds the policy value only when the origin did not
send it. CORS headers are added only when the viewer sent `Origin`; with
`OriginOverride` false, any `Access-Control-*` header in the origin response
suppresses every CORS addition from the policy. A preflight request
(`OPTIONS` + `Access-Control-Request-Method`) also receives allow methods,
allow headers and max age.

### Property inventory

Every property the reader understands is classified; an unknown property
refuses the distribution instead of being ignored.

| Property group | Implemented | Reported (not emulated) | Refused |
| --- | --- | --- | --- |
| `DistributionConfig` | `DefaultCacheBehavior`, `CacheBehaviors`, `Origins`, `OriginGroups`, `DefaultRootObject`, `Enabled` | `Aliases`, `Comment`, `HttpVersion`, `IPV6Enabled`, `Logging`, `PriceClass`, `Staging` (false), `ViewerCertificate` | `ContinuousDeploymentPolicyId`, `CustomErrorResponses`, `Restrictions`, `WebACLId`, `Staging` (true), `Enabled` (false), unknown |
| Cache behavior | `PathPattern`, `TargetOriginId`, `AllowedMethods`, `CachedMethods` (OPTIONS failover), `CachePolicyId`, `OriginRequestPolicyId`, `ResponseHeadersPolicyId`, `FunctionAssociations` | `Compress`, `DefaultTTL`, `MinTTL`, `MaxTTL`, `RealtimeLogConfigArn`, `SmoothStreaming` (false), `ViewerProtocolPolicy` | `FieldLevelEncryptionId`, `ForwardedValues`, `GrpcConfig`, `LambdaFunctionAssociations`, `TrustedKeyGroups`, `TrustedSigners`, `SmoothStreaming` (true), unknown |
| Origin | `Id`, `DomainName` (literal, S3 bucket, Function URL), `OriginPath`, `CustomOriginConfig`, `S3OriginConfig`, `OriginAccessControlId`, `OriginCustomHeaders` | `ConnectionAttempts`, `ConnectionTimeout`, `OriginShield`, the custom origin protocol/SSL/ports/timeouts, `OriginAccessIdentity`, S3 OAC/OAI signing (the access model is applied, not the signature) | unresolved `DomainName`, missing or both origin configs, `OriginPath` without a leading slash, unknown |
| CloudFront Function | `FunctionCode`, `FunctionConfig.Runtime` | `AutoPublish`, `Name`, `FunctionConfig.Comment` | `KeyValueStoreAssociations`, unsupported runtime, empty code, unknown |
| Cache policy | `ParametersInCacheKeyAndForwardedToOrigin` | `Name`, `Comment`, `DefaultTTL`, `MinTTL`, `MaxTTL`, `EnableAcceptEncodingBrotli`, `EnableAcceptEncodingGzip` | unknown managed ID, malformed config, unknown property |
| Origin request policy | `HeadersConfig`, `CookiesConfig`, `QueryStringsConfig` | `Name`, `Comment` | unknown mode, malformed config, unknown property |
| Response headers policy | `CorsConfig`, `CustomHeadersConfig`, `RemoveHeadersConfig`, `SecurityHeadersConfig` | `Name`, `Comment`, `ServerTimingHeadersConfig` | malformed config, unknown property |
| Origin access control | resolved and reported | type, signing behavior, signing protocol, name | — |

### Caching and other reported properties

Caching is not emulated. Every request is forwarded to the origin as a cache
miss; a cache policy contributes only the values it forwards to the origin.
`CachedMethods` is parsed even though nothing is cached: it decides whether an
OPTIONS request may fail over to an origin group's secondary member. `Compress`,
cache TTLs, `RealtimeLogConfigArn`, aliases, the viewer certificate, access
logging, `HttpVersion`, `IPV6Enabled`, `PriceClass` and the origin connection
settings are reported on the distribution and never silently applied.
`ViewerProtocolPolicy` is reported because the local URL is plain HTTP; an
`https-only` behavior is still served locally over HTTP.

### Origin interface

```go
type Origin interface {
    Fetch(ctx context.Context, request OriginRequest) (OriginResponse, error)
}
```

`OriginRequest` carries the behavior's `OriginID`, the viewer `Method`, the
viewer-modified `URI` (without the origin path), `OriginPath`, the filtered
`Query` and `Header`, `Host`, the body, the viewer IP and the request id.
`Path()` joins `OriginPath` and `URI`. `Range` carries the viewer `Range`
header, which CloudFront forwards to the origin outside the policies. `Header`
also always carries `If-Match`, `If-None-Match`, `If-Modified-Since` and
`If-Unmodified-Since` from the viewer: CloudFront forwards those to the origin
for the origin to evaluate, so a cache or origin request policy that does not
name them does not drop them.
`SuppressS3ResponseOverrides` is set when the behavior uses one of the managed
origin request policies below, so an S3 origin drops
`response-content-type`, `response-content-disposition` and
`response-content-encoding`. An origin group receives `OriginPath` empty and
applies each member's own path and Host.

The runner registers:

- **S3 origin.** Reads the bucket `provisionBuckets` created and the objects
  `provisionDeployments` copied from each `Custom::CDKBucketDeployment` source in
  the cloud assembly (the asset directory or zip resolved through
  `<Stack>.assets.json`), applying the deployment's `DestinationBucketKeyPrefix`,
  its `SystemMetadata` (content-type, cache-control, content-disposition,
  content-encoding, content-language, expires) and `UserMetadata`. Without a
  declared content-type the extension decides, as the CDK deployment's AWS CLI
  does. `Prune` deletes objects under the prefix that the deployment no longer
  contains. `Include`/`Exclude`, `Extract=false` and non-asset sources are
  refused with a named reason. GET and HEAD pass the object's
  `Content-Type`, `ETag`, `Last-Modified`, `Content-Length`, `Cache-Control`,
  `Content-Range` and user metadata through. A ranged GET returns 206. A HEAD
  with a single satisfiable byte `Range` returns 206 with
  `Content-Range: bytes <first>-<last>/<total>`, the ranged `Content-Length`
  and no body, because AWS documents HeadObject as the GetObject response
  without a body and a satisfiable GetObject range as 206
  ([HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html),
  [GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)).
  The pinned s3proxy backend ignores `Range` on HEAD (200, full length, no
  `Content-Range`), so the local origin requests the full metadata and derives
  the ranged answer from it. An unsatisfiable single range on a HEAD is 416 with
  `Content-Range: bytes */<total>` as HeadObject documents, while a ranged GET's
  416 comes from the backend and carries no `Content-Range`; a multi-range or
  unparseable `Range` is ignored and the full object is returned, because S3
  does not support multiple ranges per request and RFC 9110 permits ignoring a
  `Range`
  ([RFC 9110 §14.2](https://www.rfc-editor.org/rfc/rfc9110#section-14.2)).
  CloudFront forwards `If-Match`, `If-None-Match`, `If-Modified-Since` and
  `If-Unmodified-Since` to the origin, which evaluates them
  ([request headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html),
  [S3 conditional GET](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorS3Origin.html)).
  The local gateway forwards those four headers regardless of the origin
  request policy's header whitelist, so a conditional GET or HEAD passes a 304
  Not Modified (or a 412 Precondition Failed for
  `If-Match`/`If-Unmodified-Since`) through with the validators the origin
  attached and no body; the local response carries exactly what the origin
  supplied. The pinned s3proxy attaches `ETag` to a `GET` 304 and to the 412 of
  either method, attaches no validator to a `HEAD` 304, and attaches
  `Last-Modified` to none of them. OPTIONS returns 403 `AccessForbidden` for a
  bucket without CORS and a named local gap for a bucket that declares CORS
  rules. An OAC/OAI origin has no `s3:ListBucket`, so a missing object is 403
  `AccessDenied`; a public S3 origin returns 404 `NoSuchKey`
  ([S3 access control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-best-practices.html),
  [why S3 hides 404 behind 403](https://repost.aws/knowledge-center/403-vs-404-error-s3)).
  Methods other than GET/HEAD/OPTIONS are a named local refusal.
- **Function URL origin.** Builds the
  [Function URL payload format 2.0 event](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html)
  from the origin request and invokes the real function through the same
  runtime container `run` starts. `statusCode`, `headers`, `cookies`,
  `isBase64Encoded` and `body` map back. `RESPONSE_STREAM` is buffered by the
  RIE: the body is complete and chunk timing is not reproduced. A `NONE` URL is
  invoked directly. An `AWS_IAM` URL is signed with SigV4 (method, path, query,
  Host, body hash and date); the gateway's in-process verifier checks that
  locally signed request before it invokes the handler, and the event reports
  `requestContext.authorizer.iam` with a loopback identity. IAM policy
  evaluation is not emulated
  ([Function URL auth](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)).
- **Origin group.** GET and HEAD always fail over. OPTIONS fails over only when
  the behavior's `CachedMethods` lists OPTIONS
  ([origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)).
  CloudFront retries the secondary member when the primary returns a status in
  `FailoverCriteria`, fails to connect with 503 configured, or times out with
  504 configured; each attempt uses that member's `OriginPath` and Host. Other
  methods go to the primary only; if both members fail, the secondary's
  response is returned.
- **Refused origin.** A literal external custom origin is a named 503; the
  gateway never makes an external network request. A viewer-request response
  that short-circuits the origin is fully served.

### Managed origin request policies and S3 response overrides

AWS documents that `AllViewer`, `AllViewerAndCloudFrontHeaders-2022-06`,
`AllViewerExceptHostHeader` and `Elemental-MediaTailor-PersonalizedManifests`
do not forward `response-content-type`, `response-content-disposition` or
`response-content-encoding` to an Amazon S3 origin; a custom policy forwards
them as configured
([managed origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html)).
The gateway sets `OriginRequest.SuppressS3ResponseOverrides` for those four
managed policies and the S3 origin filters the three parameters before applying
S3's response overrides. Every other query parameter is unchanged.

### Fidelity

**Not a CloudFront emulator: no caching, no edge network, no TLS.** The gateway
does not reproduce viewer protocol redirects, CloudFront's 1 ms CPU limit,
incremental streaming (the Function URL origin is buffered by the RIE),
CloudFront-only device/location/TLS headers, custom status descriptions,
signed-URL verification, Lambda@Edge, KeyValueStore, WAF, geo restriction,
field-level encryption or custom error pages. S3 bucket CORS rules, S3
IAM/bucket policies and Lambda IAM policy evaluation are not emulated. A viewer
`If-Range` is not carried to the S3 origin (CloudFront forwards it by default),
so a conditional range is served as an unconditional range. It refuses a
distribution that depends on the routing or content of those features and
reports the rest.

The run fails, naming the construct, on:

- a WebSocket API that is the only surface;
- an HTTP API authorizer that is not `REQUEST` with simple responses, or a
  route whose authorization is not `NONE` or `CUSTOM`, or a CUSTOM route with no
  resolvable authorizer;
- a REST API authorizer, or a REST method whose authorization is not `NONE`;
- a proxy integration that is not `AWS_PROXY`, a `MOCK` with no usable
  response, or HTTP API payload format other than `2.0`;
- a Function URL with an auth type other than `NONE` is not served as a
  standalone URL; it is listed under `skipped`. If it is the only surface, the
  run fails with that reason;
- a targeted function with no local asset, a container image, an inline code type
  the runtime cannot load, Lambda layers, an unsupported runtime, or a
  CloudFormation-expression `MemorySize`/`Timeout` (the AWS defaults apply only
  when the property is absent);
- a targeted function whose environment expression is not `Ref`, `Fn::GetAtt` or
  `Fn::Join`, or names a resource the runner cannot resolve;
- a CloudFront distribution whose property the gateway cannot route or render
  faithfully: the distribution is listed under `skipped` with the reason and no
  listener is started. If it is the only surface, the run fails with that
  reason;
- an assembly with no HTTP API v2 route, REST v1 route, Function URL, servable
  CloudFront distribution, event source mapping or EventBridge rule target at
  all, unless `invoke` selected a function.

## Environment resolution and provisioning

Before a targeted function starts, these expressions resolve to local values:

| Expression | Local value |
| --- | --- |
| `Ref`/`Fn::GetAtt` on `AWS::DynamoDB::Table` | The template's `TableName`, or `local-<stack>-<logicalId>`. `StreamArn` is the stream ARN the local table reported, when the table declares a stream. |
| `Ref` on `AWS::SQS::Queue` | The queue URL the runner created in ElasticMQ, rewritten to the run-network endpoint (or the closed local endpoint when no `--backend sqs` was started). |
| `Fn::GetAtt [Queue, QueueName]` / `Arn` | The template's `QueueName` (or the deterministic local name) and the provider-shaped queue ARN. |
| `Ref`/`Fn::GetAtt Name`/`Arn` on `AWS::Events::Rule` | The template's `Name` (or the deterministic local name) and the provider-shaped rule ARN. |
| `Ref`/`Fn::GetAtt` on `AWS::S3::Bucket` | The bucket the runner created in s3proxy; `Arn` is built from that name. Requires `--backend s3proxy`. |
| `Ref`/`Fn::GetAtt` on `AWS::KMS::Key` | The key id or ARN the runner created in moto. Requires `--backend moto`. |
| `Ref`/`Fn::GetAtt Arn` on `AWS::Kinesis::Stream` | The stream name and ARN the runner created in moto (the template's `Name`, or the deterministic local name). Requires `--backend moto`. |
| `Ref`/`Fn::GetAtt Type`/`Value` on `AWS::SSM::Parameter` | The parameter name (provisioned with a leading `/`; AWS allows a bare name), declared type and declared value the runner created in moto. Requires `--backend moto`. |
| `Ref`/`Fn::GetAtt` on `AWS::SecretsManager::Secret` | The ARN of the secret the runner created in moto (AWS appends a six-character suffix). A `{{resolve:secretsmanager:…}}` value resolves to the provisioned secret's value and JSON key, or keeps the deterministic placeholder when no provisioned secret matches; the session's `describe` returns it. Requires `--backend moto`. |
| `Ref`/`Fn::GetAtt TopicName`/`TopicArn` on `AWS::SNS::Topic` | The topic ARN, or its name. Requires `--backend moto`. |
| `Ref`/`Fn::GetAtt` on `AWS::Cognito::UserPool` | The pool id, plus `Arn`, `ProviderName` and `ProviderURL`. Requires `--backend moto`. |
| `Ref` on `AWS::Cognito::UserPoolClient` | The client id. Requires `--backend moto`. |
| `Ref` on `AWS::KMS::Alias` | The alias name; the alias is usable as a `KeyId`. Requires `--backend moto`. |
| `Fn::GetAtt Arn` on `AWS::IAM::Role` | A provider-shaped role ARN. |
| `Fn::GetAtt ImageArn` on `AWS::Lambda::MicrovmImage` | A provider-shaped MicroVM image ARN. |
| `Fn::GetAtt IndexArn` on `AWS::S3Vectors::Index` | A provider-shaped S3 Vectors index ARN built from the declared vector bucket and index names. |
| `Fn::GetAtt ApiEndpoint` on `AWS::ApiGatewayV2::Api` | The closed local endpoint; the runner does not invent a public API URL. |
| `Fn::Join` | The joined evaluated parts. |
| `AWS::Partition`, `AWS::Region`, `AWS::AccountId`, `AWS::StackName`, `AWS::NoValue` | `aws`, `us-east-1`, `123456789012`, the stack name, and the empty string. |

When a backend answers its readiness probe, the runner provisions the resources
for it: every `AWS::S3::Bucket` in s3proxy and every
`Custom::CDKBucketDeployment` source copied into its bucket; every
`AWS::KMS::Key` and `AWS::KMS::Alias` in moto; every `AWS::DynamoDB::Table` in
DynamoDB Local with its
key schema, GSIs, streams and TTL; and every `AWS::SQS::Queue` in ElasticMQ with
its visibility, retention, FIFO and redrive attributes; every
`AWS::SSM::Parameter` (String, StringList, SecureString),
`AWS::SecretsManager::Secret` (`SecretString` or a deterministic
`GenerateSecretString`), `AWS::SNS::Topic` (standard and FIFO),
`AWS::Kinesis::Stream` and `AWS::Cognito::UserPool`/`UserPoolClient` in moto.
Table SSE, PITR and deletion protection, SQS KMS/SSE, IAM resource policies and
the Cognito hosted UI are not provisioned; they are not part of the local
contract. An unresolvable expression fails before any function container
starts, with the function and variable named.

A provisioned Cognito pool gets a loopback issuer at
`http://127.0.0.1:<port>/cognito-idp/<region>/<poolId>`; both
`/.well-known/jwks.json` and `/.well-known/openid-configuration` are served
there. `session describe` reports it as `localIssuer` on the pool resource. The
full service semantics and the observed moto deviations are in
[moto-backed services](/examples/local-runner/#moto-backed-services-ssm-secrets-manager-sns-kinesis-cognito-and-kms-signing).

Functions that no supported route, Function URL, CloudFront origin, event source
mapping or rule targets are listed under `skipped` with the reason; they are
never silently dropped. A session's `--target` starts one of them explicitly.

## Container environment

Each function container is started with:

```
docker run -d --name <prefix>-<logicalId> --network <prefix>-net --dns 127.0.0.2 \
  --add-host <service>:<address> -p 127.0.0.1::8080 --memory <MemorySize>m \
  -v <code>:/var/task:ro -e KEY=VALUE … <image> <handler>
```

Environment, in order (later wins):

1. the function's `Environment.Variables` from the template (literal strings
   only);
2. the runner-owned values below.

| Variable | Value |
| --- | --- |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | `us-east-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `dummy` |
| `AWS_EC2_METADATA_DISABLED` | `true` |
| `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` | `/dev/null` |
| `AWS_REQUEST_CHECKSUM_CALCULATION`, `AWS_RESPONSE_CHECKSUM_VALIDATION` | `WHEN_REQUIRED` (s3proxy does not implement the SDK's default flexible-checksum trailers) |
| `AWS_ENDPOINT_URL_<SERVICE>` (and the profile's alias names) | the configured endpoint. Secrets Manager and Cognito use `AWS_ENDPOINT_URL_SECRETS_MANAGER` and `AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER`; the short `AWS_ENDPOINT_URL_COGNITO_IDP` alias is also injected. |
| `AWS_ENDPOINT_URL` | the single endpoint, or `http://127.0.0.1:1` when zero or several are configured |

When a template variable is replaced, the run prints
`function <id>: runner-owned environment overrides template values for <names>`.
A `AWS_SESSION_TOKEN` is never injected.

`--backend dynamodb` starts
`amazon/dynamodb-local@sha256:… -jar DynamoDBLocal.jar -sharedDb -inMemory` on
the run network and adds `dynamodb-local:<network address>` to every function
container's `/etc/hosts`, because closed DNS cannot resolve container names.
`--backend moto`, `--backend s3proxy` and `--backend sqs` start their profile
containers the same way; the SQS container answers on the `sqs` alias with
ElasticMQ's loopback queue URLs rewritten to `http://sqs:9324/...`. The S3
endpoint is injected as `http://<container address>:80` rather than
`http://s3proxy:80`: the AWS SDK uses path-style addressing for an IP endpoint,
and s3proxy does not serve the virtual-host form the SDK would otherwise pick.

## Preflight

Before the first handler starts, a probe container from the pinned Python image
runs on the same network with the same environment. Backend readiness above has
already proven each published host port answers its service from the host; this
probe proves the view from inside a function container. It must report:

- credentials are the `dummy` static keys and no session token is present;
- every configured endpoint host resolves and answers an HTTP request (this
  includes the moto KMS/STS and s3proxy S3 endpoints when those backends are
  running);
- when a DynamoDB endpoint is configured, `boto3` (from the runtime image)
  resolves DynamoDB to that endpoint and `ListTables` succeeds;
- `dynamodb.us-east-1.amazonaws.com`, `s3.amazonaws.com` and
  `sqs.us-east-1.amazonaws.com` do **not** resolve.

Any failure stops the run before an app handler is invoked. Endpoints whose host
is a public AWS domain are refused earlier, on the host.

## Generated events

For an HTTP surface, one event is sent per request. Fixed values: account `123456789012`, region
`us-east-1`, stage from the stack (`$default` or the REST stage), and a fresh
32-hex-character request id that also appears in `requestContext.requestId`.

**HTTP API v2** — `version`, `routeKey` (the matched template, e.g.
`ANY /{proxy+}`, or `$default`), `rawPath`, `rawQueryString`, lower-cased
`headers`, `cookies` (split on `;`), `queryStringParameters`,
`pathParameters`, `body`, `isBase64Encoded`, and
`requestContext.http` (`method`, `path`, `protocol`, `sourceIp`, `userAgent`).
As API Gateway does when it populates `cookies`, the runner removes the `cookie`
entry from `headers` so a handler cannot read the same cookies twice.

**REST API v1** — `resource` (the matched template), `path`, `httpMethod`,
`headers`, `multiValueHeaders`, `queryStringParameters`,
`multiValueQueryStringParameters`, `pathParameters`, `body`,
`isBase64Encoded`, and `requestContext` (`resourcePath`, `resourceId`,
`httpMethod`, `stage`, `path`, `protocol`, `requestId`, `identity.sourceIp`,
`identity.userAgent`).

**Function URL** — the v2 shape with `routeKey: "$default"`,
`requestContext.routeKey` and `requestContext.stage` both `$default`, and
`requestContext.domainName` ending in
`.lambda-url.us-east-1.on.aws`; it carries no `pathParameters`. The AppTheory
runtime uses the domain to distinguish it from HTTP API v2.

**HTTP API v2 REQUEST authorizer** — the same v2 request shape plus
`type: "REQUEST"`, `routeArn`, `identitySource` (an array holding every
configured identity source's value, in the order the template declares) and the
route key. The supported identity sources are `$request.header.<name>` (header
names are case-insensitive) and `$request.querystring.<name>` (query string
names are case-sensitive); any other expression, including `$context` and
`$stageVariables`, fails closed at derive/plan time with the source named. When
the authorizer declares identity sources and a request does not carry every one
of them, the transport returns `401 {"message":"Unauthorized"}` without invoking
the authorizer, as API Gateway does. The transport reads
`{"isAuthorized":bool,"context":{…}}`; a false result is a 401, and a true
result's context is carried to the handler as
`requestContext.authorizer.lambda`.

**SQS** — built from messages an ElasticMQ queue actually returned:
`Records[].messageId`, `receiptHandle`, `body`, `md5OfBody`, the receive
attributes (including a FIFO record's `MessageGroupId`,
`MessageDeduplicationId` and `SequenceNumber`), `messageAttributes` (always an
object, empty when the message has none), an optional
`md5OfMessageAttributes`, `eventSource: "aws:sqs"`, `eventSourceARN` (the
CDK-resolved local queue ARN) and `awsRegion`. The shape is the standard and
FIFO example in
[Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#example-standard-queue-message-event).

**DynamoDB Streams** — built from the stored item read back from DynamoDB
Local: `Records[].eventID`, `eventName` (`INSERT`/`MODIFY`/`REMOVE`),
`eventVersion: "1.1"`, `eventSource: "aws:dynamodb"`, `awsRegion`, the table's
real local stream ARN, and `dynamodb` with `Keys`, `NewImage`/`OldImage` in
DynamoDB JSON, `SequenceNumber`, `StreamViewType` and `SizeBytes`.

**EventBridge** — a schedule rule gets `source: "aws.events"`,
`detail-type: "Scheduled Event"` and `resources: [<rule ARN>]`; a pattern rule
gets the source and detail-type from its declared `EventPattern`. Callers may
supply the detail; it must be valid JSON.

**Kinesis / CloudWatch Logs** — a Kinesis event with
`eventSource: "aws:kinesis"`, the stream ARN and one record per input. The
CloudWatch Logs helper builds a `DATA_MESSAGE` subscription payload from the
supplied log events, gzips it, and base64-encodes it into `kinesis.data`, as
AWS does.

A body that is not valid UTF-8 is base64-encoded and `isBase64Encoded` is `true`.

## Response decoding

The Runtime Interface Emulator returns one JSON body:

- `statusCode`, `headers`, `multiValueHeaders`, `cookies`, `body`,
  `isBase64Encoded` are all honoured; `multiValueHeaders` wins over `headers` for
  the same name;
- a body framed as `{metadata JSON}` + eight NUL bytes + bytes is decoded as a
  buffered streaming response (`Streamed: true`) and served with its metadata
  and complete body;
- `errorType`/`errorMessage` without a `statusCode` is a handler error and is
  served as `502 {"message":"Internal Server Error"}` (the detail is logged);
- a missing or out-of-range `statusCode` and a malformed body are `502`;
- a request with no matching route is `404 {"message":"Not Found"}` from the
  local transport; bodies above 10 MB are `413`.

`Content-Length`, `Transfer-Encoding` and other hop-by-hop headers from the
handler are dropped and recomputed by the local HTTP server.

## Isolation and cleanup

- One Docker network per run: `<name-prefix>-net`, labelled
  `apptheory.local.run`, `apptheory.local.app` and `apptheory.local.managed`.
- Function containers: `<name-prefix>-<logicalId>`. Backend containers:
  `<name-prefix>-dynamodb`, `<name-prefix>-moto`, `<name-prefix>-s3proxy` and
  `<name-prefix>-sqs`; each also carries its profile container name as a
  network alias.
- The RIE port and each backend port are published on loopback only
  (`-p 127.0.0.1::<port>`). The runner uses the backend's loopback port to
  provision buckets, keys, tables and queues and to serve a session's data
  operations; function containers reach the backend over the run network.
- On success, failure or `SIGTERM`/`SIGINT`, the runner removes exactly its own
  containers and network, then deletes `<scratch>/runs/<app>-<run>`. Shutdown
  is ordered: close the listeners (stop accepting requests), force-remove every
  container labelled with the run id (including one whose start was
  interrupted), close any connections still in flight, then remove the network.
  It never waits for a handler before removing containers, so a request that is
  still running cannot hold cleanup past its budget.
- `SIGKILL` cannot run cleanup. `apptheory-local down --app <dir>` is the
  recovery path: it removes containers and networks labelled with that app. It
  does not delete the stale run scratch directory, `<scratch>/runs/<app>-<run>`
  (`--scratch` defaults to `<user cache>/apptheory-local`); it is safe to delete
  by hand.
