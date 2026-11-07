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
| `--origin domain=url` | none | Map a CloudFront external custom origin's domain to a loopback URL. An unmapped external origin refuses the distribution at plan time; a non-loopback URL is refused. Repeatable. |
| `--viewer-country XX` | unset (undetermined) | CloudFront geo restriction's viewer country: an ISO 3166-1 alpha-2 code in upper case. Without it the viewer's location is undetermined and CloudFront serves the content. Also feeds `CloudFront-Viewer-Country` when a policy forwards it. |
| `--add-host name=address` | none | Extra `/etc/hosts` entry inside function containers. Repeatable. |
| `--backend NAME` | none | Start a profile emulator on the run network: `dynamodb`, `sqs`, or a profile container such as `moto` (KMS, STS, SSM, Secrets Manager, SNS, Kinesis, Cognito) or `s3proxy` (S3). Repeatable. |
| `--port-base N` | ephemeral | Bind the API listeners at `N`, `N+1`, …; `0` asks the OS for free ports. |
| `--name-prefix PREFIX` | derived from the app hash | Container and network names. Two concurrent runs of the same app share the default prefix (and container/network names), so set a unique prefix when they must not collide. Built-image tags also carry the run id, so concurrent runs never move each other's image tag. |
| `--max-concurrency N` | 32 | In-flight invocations, `1..32`. Values above 32 are refused. |
| `--delivery-concurrency N` | 4 | Concurrent handler invocations the delivery engine performs, `1..32`. The default is sized for the documented 4 CPU / ~6 GB Colima host. |
| `--clock SPEC` | `real` | `run`/`session` time source: `real`, `test`, or `test=<RFC3339 start>`. A test clock starts at the given instant, or `2026-01-01T00:00:00Z` when omitted. |
| `--json` | off | `plan`: print the derived surface as JSON on stdout; progress goes to stderr. |
| `--allow-no-surface` | off | `plan`/`session`: allow an app whose functions have no served HTTP, event or rule surface. A session still needs `--target` to start a function. |
| `--function ID` | none | `invoke`: function logical id from the CDK assembly. |
| `--event FILE` | none | `invoke`: JSON event file. Repeatable. |
| `--stdio` | off | `invoke`: read newline-delimited JSON events from stdin and keep the container warm. |
| `--stream-chunks` | off | `invoke`: with `--stdio`, write one `{"event":"chunk",…}` line per streamed response chunk before the result line. A buffered response still writes only the result, so the default one-result-per-event contract is unchanged. |
| `--rie` | off | Run function containers under the image's embedded Runtime Interface Emulator instead of the runner's Lambda Runtime API. Reported by `plan`, `plan --json` (`runtimeMode`) and `session describe`. It cannot stream incrementally. |
| `--target ID` | none | `session`: start this CDK function even though no route, event source or rule targets it. Repeatable. |
| `--handler-dir DIR` | none | `invoke`: built handler directory for an example with no CDK definition. Derives no routes. |
| `--runtime RUNTIME` | none | `invoke --handler-dir`: Lambda runtime (`provided.al2023`, `nodejs24.x`, `python3.14`). |
| `--handler NAME` | none | `invoke --handler-dir`: handler name (`bootstrap` for the provided runtime). |
| `--architecture ARCH` | `arm64` for provided, `x86_64` otherwise | `invoke --handler-dir`: built architecture. |
| `--memory MB` | 128 | `invoke --handler-dir`: function memory. |
| `--timeout SECONDS` | 3 | `invoke --handler-dir`: function timeout. |
| `--watch` | off | `run`/`session`: follow `cdk.json`'s `watch` include/exclude (or the app directory), re-synthesize on a change and apply the new surface without restarting the listeners. See [Dev loop](#dev-loop). |
| `--data-dir DIR` | none (ephemeral) | `run`/`session`/`invoke`: keep DynamoDB Local, s3proxy and ElasticMQ state under `DIR`; moto stays in memory. See [Dev loop](#dev-loop). |
| `--seed COMMAND` | none | `run`/`session`: run `sh -c COMMAND` after provisioning and before `local-run: ready`. See [Dev loop](#dev-loop). |

Exit codes: `0` success, `1` a run/plan failure, `2` a usage error.

Run output is stable enough to script:

```
function HandlerFunction0D87A48C (provided.al2023, public.ecr.aws/lambda/provided:al2023@sha256:…) ready on the runner's Runtime API at http://127.0.0.1:49xxx
serving httpv2 ApiCD79AAA0 at http://127.0.0.1:8131
local-run: ready
…
shutting down: removing 1 container(s) and network …
```

The address to call is on the `serving …` line. The `http://127.0.0.1:<port>` on
the `function …` line is the runner's own Runtime API address for that function,
not the app URL. Under `--rie` the runner starts the image's Runtime Interface
Emulator instead and the line reads `ready on 127.0.0.1:<port> (Runtime
Interface Emulator mode)`.

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
`ddb.stream-event`, `s3.put`, `s3.delete`, `eventbridge.event`, `kinesis.event`,
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

A function's `MemorySize`/`Timeout` can be a CloudFormation expression. The
runner resolves it through the same intrinsic resolver it uses for environment
values:

| Form | Resolved from |
| --- | --- |
| `Ref` to a template parameter | The parameter's `Default`. "For parameters with default values, CloudFormation uses the default values unless users specify another value." |
| `Fn::If` | The named condition, evaluated from parameter defaults (`Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Fn::Contains`, and a nested `Condition`). |
| `Fn::FindInMap` | The template's `Mappings` entry. |
| `Fn::Join` | The joined evaluated parts (a numeric string is accepted for a limit). |
| `Fn::If` selecting `AWS::NoValue` | Property omitted: "Removes the corresponding resource property when specified as a return value in the `Fn::If` intrinsic function" ([pseudo parameters](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/pseudo-parameter-reference.html)); the limit takes the Lambda default (128 MB, 3 s). |

The resolved value is validated against the `AWS::Lambda::Function` page:
`MemorySize` is 128..32768 MB ("The default value is 128 MB. The value can be
any multiple of 1 MB"), and `Timeout` is 1..900 seconds ("The default is 3
seconds, and the maximum allowed value is 900 seconds")
([AWS::Lambda::Function](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html)).
A value outside the range fails the run with the property named.

A limit that still cannot be resolved before deployment keeps the existing
fail-closed behaviour: a parameter without a `Default` ("If you omit the
default attribute, users are required to specify a value for that parameter"),
a `Fn::GetAtt` on a deployed resource, or an unknown condition or mapping. The
function is listed as `unresolved (<intrinsic>)`, for example `unresolved
(Ref)`, and the JSON keeps `unresolvedMemorySize`/`unresolvedTimeout` and
`memorySizeExpression`/`timeoutExpression`. A served function with an
unresolved limit fails closed and the error names the parameter or intrinsic.

## Dev loop

### Watch and rebuild

`--watch` follows the CDK CLI's watch configuration: a `cdk.json` `watch`
object's `include`/`exclude` patterns (paths relative to the directory holding
`cdk.json`), otherwise the app directory. Polling is every 300 ms with a
500 ms debounce and one synthesis in flight; a failed synthesis is logged and
the previous assembly keeps serving. A function is replaced only when its
`FunctionSpec` execution inputs change: asset hash, image asset, environment,
`MemorySize`/`Timeout`, layers, runtime, handler or architecture. The
replacement uses the same reset path as a Lambda execution-environment reset,
so the logical id and listener behaviour stay. Added functions start, removed
functions stop; routes, event sources, rules, subscriptions and delivery
wiring are re-derived. The listeners keep their ports and URLs.

| Change | Live |
| --- | --- |
| Function code, image, environment, limits, layers, runtime, handler or architecture | The function is replaced. |
| Routes on an existing HTTP/REST/Function URL listener | The route table swaps in place. |
| A new/removed HTTP, REST, Function URL or WebSocket listener | Requires a restart; reported by name. |
| A changed CloudFront distribution topology | Requires a restart; reported. |
| A new resource needing a backend this run did not start | Requires a restart with `--backend`; reported. |

A reload that fails after a function was replaced restores the previous
definition. A container-image function is restored from the immutable image id
recorded before the rebuild moved its tag, and the tag is pointed back at that
image. The image this reload built is then removed by id without `-f`, and only
after an inspect proves nothing still names or uses it: no repo tag, no repo
digest and no container, running or stopped. That is this run's dangling
rebuild; an image a foreign tag, a foreign digest reference or a container
still holds is left in place and the log names the reference. A daemon using
the containerd image store records a digest for each repository its repo tags
name, so this run's rebuild reports one while its tag names it and none once
the rollback points that tag back at the previous image; a digest entry under a
repository no tag on the image carries is a reference outside the run, such as
another repository's `repo@sha256:…` pin, and it keeps the image. An image
function the reload added and the rollback stops loses its built image under
the same check; this run's own build tag, and the digest the store derives from
it, are the references it may still carry. The check comes first rather than
relying on the daemon's refusal: Docker refuses an unforced `docker image rm
<id>` while a container references the image or while two or more repo tags
name it, and at exactly one tag it untags that tag and deletes the image
([docker image rm](https://docs.docker.com/reference/cli/docker/image/rm/)).
Docker's Engine API has no conditional delete (only `force` and `noprune`), so a
tag added between the inspect and the remove is the one window the check cannot
close; the remove is still refused while two tags exist. A tag-restore failure
keeps the rebuilt image and logs it. The apply log names the branch it took:
`rolled back ...; the previous assembly keeps serving` when every replaced
function was restored, `no replaced function was restored` when none was,
`partially applied: ... restored, ... not` in between, and `no function was
applied; the previous assembly keeps serving` when the failure stopped the
batch before any function was replaced. A branch that leaves any function
unrestored ends with `a restart is required`. A full rollback removes
the new assembly directory; any rollback that leaves a function unrestored
keeps it because a container may still mount it.

The shutdown sweep removes every image the run built, but it runs only on a
clean exit: a signal-killed run can leave its run-labelled images behind
(`apptheory.local.run=<run-id>`), and a tagged image survives a plain
`docker image prune`. Remove them with `docker image rm` on the tags the run
printed, or list them by label (`docker image ls --filter
label=apptheory.local.run`).

### `--data-dir` layout

```
<data-dir>/dynamodb/shared-local-instance.db   DynamoDB Local -dbPath /data (the pinned -sharedDb is kept)
<data-dir>/s3proxy/<bucket>/<key>              s3proxy jclouds filesystem provider, JCLOUDS_FILESYSTEM_BASEDIR=/data
<data-dir>/sqs/elasticmq.mv.db                 ElasticMQ messages-storage (H2), verified on the pinned 1.7.1 image
```

moto is memory-only and is not persisted ([moto server mode](https://docs.getmoto.org/en/latest/docs/server_mode.html)).
The data directory must be under `$HOME` or the working directory so Docker can
bind-mount it. The pinned emulator images run as their own non-root users
(DynamoDB Local as `dynamodblocal`, ElasticMQ as `elasticmq`). Colima maps a
bind mount's ownership to the container user, but a Linux bind mount keeps the
host UID, so the runner makes the root traversable (`0755`) and each backend
directory writable (`0777`); the ElasticMQ configuration file is `0644`
(container-readable, and it holds no secret). These modes assume a single-user
development machine: the backend directories are `0777` without the sticky bit,
so another user of the same host could write to or delete the emulator store.
Definitions are re-provisioned
from the assembly on every start;
existing tables, buckets, queues, topics, streams, parameters, secrets, pools
and keys are reconciled, never dropped. A DynamoDB key-schema change fails at
start with the table named and the UpdateTable rule that a table update cannot
change its key schema
([UpdateTable](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html)).
A new global secondary index sends its key attributes in the update's
`AttributeDefinitions`, which the API requires, and a new index keyed on an
existing attribute whose declared type differs from the table's fails by name
instead of creating the index over the existing type
([AttributeDefinition](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeDefinition.html)).
Local secondary indexes are created with the table. A re-run whose existing
table differs in a local secondary index cannot reconcile the difference in
place: a local secondary index is created when the table is created, and
UpdateTable cannot add, modify or delete one
([local secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html),
[UpdateTable](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html)).
Startup continues, the stored table is kept, and the run logs one warning
naming the table, the index and the difference, with the remedy: stop the run
and remove `<data-dir>/dynamodb` to recreate the table, or start without
`--data-dir`. That includes a table an earlier runner created without the local
secondary index an app declares, because that runner ignored
`LocalSecondaryIndexes`. A table with a hash-only key that declares a local
secondary index is AWS-invalid, because a local secondary index "has the same
partition key as the base table, but a different sort key"
([local secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html)):
the pinned DynamoDB Local 3.1.0 refuses its `CreateTable` with `Local Secondary
indices are not allowed on hash tables`, and checks that before it reports an
existing table, so a re-run over an existing `--data-dir` table fails the same
way; the CDK `Table` construct refuses it at synth with `a sort key of the
table must be specified to add local secondary indexes` (aws-cdk-lib 2.275.0,
`aws-dynamodb` `validateTable`). An existing global secondary index whose key
attribute's declared type differs from the table's stored type is reported and
kept the same way, because the earlier runner treated a type-only change as
unchanged. A new global secondary index whose declared key type differs from
the table's existing type still fails by name: the API refuses an index whose
key type differs from the table's `AttributeDefinitions`, and the stored table
cannot change it in place
([AttributeDefinition](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeDefinition.html)).
A global secondary index whose key schema or projection changed still fails by
name, as does a table key-schema change.
s3proxy's `jclouds.filesystem.basedir` sentence and ElasticMQ's
`messages-storage` section are the pages the configuration follows
([s3proxy](https://github.com/gaul/s3proxy),
[ElasticMQ](https://github.com/softwaremill/elasticmq)).

### `--seed` environment

`--seed` runs `sh -c <command>` in the app directory after provisioning and
listener start, before `local-run: ready`. Its environment carries:

| Variable | Meaning |
| --- | --- |
| `APPTHEORY_LOCAL_APP` | The CDK app directory. |
| `APPTHEORY_LOCAL_DATA_DIR` | The data directory, when `--data-dir` is set. |
| `APPTHEORY_LOCAL_APIS` | JSON array of `{"class","logicalId","url"}` for every served listener. |
| `APPTHEORY_LOCAL_URL_<LOGICALID>` | The same URLs keyed by logical id. |
| `APPTHEORY_LOCAL_ENDPOINT_<SERVICE>` | Host-side endpoint URLs (`DYNAMODB`, `S3`, `SQS`, `EVENTS`, `KMS`, …). |
| The profile's endpoint names | The `AWS_ENDPOINT_URL_*` names the runner injects into functions. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_DEFAULT_REGION` | The dummy static credentials and `us-east-1`. |

Inherited `AWS_*` names are removed. A non-zero exit fails the run with the
script output. The committed
`examples/cdk/restv1-router/scripts/seed-local.sh` is the pattern: it reads
`APPTHEORY_LOCAL_APIS` and drives the app's REST handler.

## Run your own app

`apptheory-local` runs any CDK app, not only the examples in this repository.
The app can come from a released module, an installed binary or a sibling
AppTheory checkout; the flags and generated events are the same in all cases.
The example harness's row-level classes and named limits are in the
[fidelity table](/examples/local-harness/#fidelity-table).

```bash
# From a released module; <version> must contain the command (v7.0.0 or later;
# the module path is /v7).
go run github.com/theory-cloud/apptheory/v7/cmd/apptheory-local@<version> \
  --app ~/code/my-app --profile ~/code/my-app/local-profile.json

# Or install it once.
go install github.com/theory-cloud/apptheory/v7/cmd/apptheory-local@<version>

# When developing the runner itself, run or build from a sibling AppTheory checkout.
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
| `AWS::Lambda::Url` (`AuthType: NONE`) | Served as a Function URL listener. `InvokeMode: RESPONSE_STREAM` is marked streaming and forwarded incrementally. A URL with `AWS_IAM` is not served as a standalone URL; when a served CloudFront distribution targets it, the gateway invokes it through the signed local OAC origin instead. |
| `AWS::ApiGatewayV2::Authorizer` (`REQUEST`) | For an HTTP API route with simple responses, the transport sends a v2 REQUEST authorizer event and enforces `isAuthorized`. With `EnableSimpleResponses: false` it sends payload format 1.0 or 2.0 and matches the returned IAM policy against the route ARN. For a WebSocket `$connect` route, the transport sends the documented WebSocket authorizer event and matches the returned IAM policy against the `$connect` method ARN. A type the transport cannot run fails the route that references it closed. |
| `AWS::ApiGateway::Authorizer` | Parsed; a `COGNITO_USER_POOLS` authorizer is run for the REST methods that reference it (R2a). A Lambda authorizer is R2b and fails closed. |
| `AWS::Lambda::EventSourceMapping` (SQS, DynamoDB Streams, Kinesis) | Reported with its function, source, batch options, filter criteria and scaling configuration; the function is started and the mapping is delivered automatically: an SQS queue (see [SQS event-source delivery](/examples/local-runner/#sqs-event-source-delivery)), a DynamoDB stream (see [DynamoDB Streams delivery](/examples/local-runner/#dynamodb-streams-delivery)) or a Kinesis stream (see [Kinesis event-source delivery](/examples/local-runner/#kinesis-event-source-delivery)). A session can still build the provider event from real local messages or a real local write. |
| `AWS::SNS::Topic`, `AWS::SNS::Subscription` and a topic's inline `Subscription` | Topics (standard and FIFO) are provisioned on moto. Every supported subscription is registered with the delivery engine and delivered automatically: a Lambda record, an SQS envelope or raw body, or a loopback HTTP POST. See [SNS subscription delivery](/examples/local-runner/#sns-subscription-delivery). SNS does not support Lambda or HTTP(S) targets on a FIFO topic; a Lambda or HTTP(S) subscription to one, a non-loopback HTTP endpoint and SMS/email/mobile push are reported under `skipped` with a named reason. |
| `AWS::Events::Rule` with a Lambda target | Reported with its schedule or event pattern and target; the function is started and the rule is delivered automatically: a schedule fires on the run clock and a pattern rule receives every matching `PutEvents` entry (see [EventBridge delivery](/examples/local-runner/#eventbridge-delivery)). A session can still build the event a rule would deliver. |
| `AWS::Logs::SubscriptionFilter` | Reported with its log group, filter and destination; the destination is a Lambda function, or an `AWS::Logs::Destination` followed to its Kinesis `TargetArn`. A Lambda destination is started and the filter is delivered automatically (see [CloudWatch Logs subscription delivery](/examples/local-runner/#cloudwatch-logs-subscription-delivery)); a destination the runner cannot deliver is reported under `skipped`. |
| `AWS::ApiGatewayV2::Api` (`ProtocolType: WEBSOCKET`) + `Route` + `AWS_PROXY` `Integration` + `Stage` | Served on its own RFC 6455 listener. Its route selection expression, `$connect`/`$disconnect`/`$default` and custom routes are derived; `$default` and custom routes are two-way. Only the single-field `$request.body.<field>` form and its wrapped `${request.body.<field>}` equivalent are served; any other declared form (multiple variables, a static value, a nested path) fails closed at plan time with the expression named. A `CUSTOM` `$connect` authorizer is derived with its identity sources and method ARN. See [WebSocket APIs](/examples/local-runner/#websocket-apis). |
| `AWS::ApiGateway::Method` with a `MOCK` integration | Served from the first `IntegrationResponses` entry: its status and `method.response.header.*` parameters become the response. No function is invoked. |
| `AWS::CloudFront::Distribution`, `AWS::CloudFront::Function`, `AWS::CloudFront::CachePolicy`, `AWS::CloudFront::OriginRequestPolicy`, `AWS::CloudFront::ResponseHeadersPolicy`, `AWS::CloudFront::OriginAccessControl` | Served as the distribution's edge path on a loopback listener, with S3, Function URL and origin-group origins. A property the gateway cannot faithfully apply refuses the distribution with a named reason; cache policies are applied, while a compression, logging, legacy behavior-TTL or placement property is reported. |
| `AWS::CloudFront::KeyGroup`, `AWS::CloudFront::PublicKey` | Reported with their parsed keys and groups. A distribution that trusts a key group requires a signed URL or signed cookie on every request except OPTIONS; the gateway verifies the signature (RSA with SHA-1 or SHA-256, or ECDSA) against the named public key and reports an unknown `Key-Pair-Id`. |

## Stage-prefixed URLs

A REST API is served at the root and at `/{stage}/...`; an HTTP API with a
named (non-`$default`) stage is served at the root and at `/{stage}/...`. The
`$default` stage keeps the root only. The root form is the custom-domain form
and keeps working byte for byte. The runner tries the stage-stripped route
first when the first segment equals the stage name and the remainder matches;
otherwise it matches the root path, so a root route that happens to start with
the stage name is only used when the stripped form has no route.

| Format | `path` / `resource` | `requestContext` |
| --- | --- | --- |
| REST v1 | The resource path without the stage (`/hello`). | `path` is `/{stage}/hello`; `stage` is the stage name. |
| HTTP API v2 | `rawPath` is `/{stage}/hello`; `pathParameters` come from the stripped path. | `http.path` is `/{stage}/hello`; `stage` is the stage name. |
| `$default` (either format) | The root path (`/hello`). | `path`/`http.path` is `/hello`; `stage` is `$default`. |

The REST base-URL format is
`https://{restapi_id}.execute-api.{region}.amazonaws.com/{stage_name}/`
([invoke a REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-call-api.html)).
An HTTP API's "$default stage ... is served from the base of your API's URL";
a named stage is served under `/{stage}`
([HTTP API stages](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-stages.html)).
`plan` prints both forms on each route line.

## Delivery engine

`run` and `session` start one delivery engine per run. It registers every
derived event-source mapping, EventBridge rule, CloudWatch Logs subscription
filter, SNS subscription and S3 bucket notification at start and reports each
source's state. An SQS mapping polls ElasticMQ automatically; a DynamoDB Streams
mapping polls the table's stream on DynamoDB Local; a Kinesis mapping polls
moto's stream; an EventBridge schedule fires on the run clock and a pattern rule
is armed on the runner's own bus; a CloudWatch Logs subscription filter polls its
group; an SNS subscription is armed on its topic hub and delivers every observed
publish; an S3 notification watcher lists its bucket and delivers each observed
object change to the destination. Every derived kind has a deliverer.

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

Each entry also reports `delivered`, `failed` and (for an SNS subscription or an
S3 notification destination) `filtered` counts, `lastError` and `paused`; an SQS
source reports `left`
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
listener binds loopback and, when the host owns the run network's gateway, that
address too; it never binds the unspecified address. It is injected into every function as
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

A CloudFront-only header listed here is derived when the gateway has a truthful
local value: `cloudfront-viewer-country` comes from `--viewer-country`, and is
empty, with the plan naming the flag, when the run sets no country. Device and
TLS headers are omitted; the policy parser reports that gap instead of
fabricating a value.

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

CloudFront device and TLS headers have no truthful local value and are
omitted; the policy parser reports this. `cloudfront-viewer-country` is the
run's `--viewer-country` when that flag is set; without it the viewer's location
is undetermined, the header is empty, and the parser reports that with the flag
named. Host follows the policy: `AllViewer`
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
| `DistributionConfig` | `DefaultCacheBehavior`, `CacheBehaviors`, `Origins`, `OriginGroups`, `DefaultRootObject`, `Enabled`, `CustomErrorResponses`, `Restrictions.GeoRestriction` | `Aliases`, `Comment`, `HttpVersion`, `IPV6Enabled`, `Logging`, `PriceClass`, `Staging` (false), `ViewerCertificate` | `ContinuousDeploymentPolicyId`, `Restrictions` members other than `GeoRestriction`, `WebACLId`, `Staging` (true), `Enabled` (false), unknown |
| Cache behavior | `PathPattern`, `TargetOriginId`, `AllowedMethods`, `CachedMethods` (OPTIONS failover), `CachePolicyId`, `OriginRequestPolicyId`, `ResponseHeadersPolicyId`, `FunctionAssociations`, `LambdaFunctionAssociations`, `TrustedKeyGroups`, `FieldLevelEncryptionId` | `Compress`, `DefaultTTL`, `MinTTL`, `MaxTTL`, `RealtimeLogConfigArn`, `SmoothStreaming` (false), `ViewerProtocolPolicy` | `ForwardedValues`, `GrpcConfig`, `TrustedSigners`, `SmoothStreaming` (true), unknown |
| Origin | `Id`, `DomainName` (literal, S3 bucket, Function URL), `OriginPath`, `CustomOriginConfig`, `S3OriginConfig`, `OriginAccessControlId`, `OriginCustomHeaders` | `ConnectionAttempts`, `ConnectionTimeout`, `OriginShield`, the custom origin protocol/SSL/ports/timeouts, `OriginAccessIdentity`, S3 OAC/OAI signing (the access model is applied, not the signature) | unresolved `DomainName`, missing or both origin configs, `OriginPath` without a leading slash, unknown |
| CloudFront Function | `FunctionCode`, `FunctionConfig.Runtime`, `FunctionConfig.KeyValueStoreAssociations` (runtime 2.0 only) | `AutoPublish`, `Name`, `FunctionConfig.Comment` | unsupported runtime, empty code, unknown |
| Lambda function association | `EventType`, `LambdaFunctionARN` (an `AWS::Lambda::Version` in the assembly), `IncludeBody` (request events only) | — | `$LATEST`, aliases, literal or unknown ARNs, container image, layers, VPC, dead-letter queue, reserved or provisioned concurrency, arm64, more than 512 MB ephemeral storage, environment variables, non-Node/Python runtime, unknown |
| Public key | `PublicKeyConfig` (`CallerReference`, `Comment`, `EncodedKey` as a 2048-bit RSA or P-256 ECDSA PEM, `Name`) | `CallerReference`, `Comment`, `Name` | malformed or wrong-size key, unknown |
| Key group | `KeyGroupConfig` (`Items`, `Name`) | `Comment`, `Name` | no keys, more than five keys, unknown |
| Key value store | `ImportSource` from an assembly asset, `Name`, `Comment` | `Name`, `Comment` | non-S3 source, an import source that is not an assembly asset, key/value/store quota, malformed import file, unknown |
| Field-level encryption configuration | `ContentTypeProfileConfig`, `QueryArgProfileConfig` | `CallerReference`, `Comment` | content type other than `application/x-www-form-urlencoded`, format other than `URLEncoded`, more than five query-argument profiles, unknown |
| Field-level encryption profile | `EncryptionEntities` (`PublicKeyId`, `ProviderId`, `FieldPatterns`) | `CallerReference`, `Comment`, `Name` | more than ten patterns, overlapping patterns, disallowed pattern characters, a non-RSA key, unknown |
| Cache policy | `ParametersInCacheKeyAndForwardedToOrigin`, `DefaultTTL`, `MinTTL`, `MaxTTL` | `Name`, `Comment`, `EnableAcceptEncodingBrotli`, `EnableAcceptEncodingGzip` | unknown managed ID, malformed config, unknown property |
| Origin request policy | `HeadersConfig`, `CookiesConfig`, `QueryStringsConfig` | `Name`, `Comment` | unknown mode, malformed config, unknown property |
| Response headers policy | `CorsConfig`, `CustomHeadersConfig`, `RemoveHeadersConfig`, `SecurityHeadersConfig` | `Name`, `Comment`, `ServerTimingHeadersConfig` | malformed config, unknown property |
| Origin access control | resolved and reported | type, signing behavior, signing protocol, name | — |

### Caching and invalidation

A behavior's cache policy is applied in full. The cache key is the distribution
domain plus the URL path, extended by the query strings, headers and cookies the
policy names. "The OPTIONS method is included in the cache key for OPTIONS
requests. This means that responses to OPTIONS requests are cached separately
from responses to GET and HEAD requests": GET and HEAD share one key, a HEAD is
answered from the GET-stored object without a body, and a HEAD response is never
stored (it has no body to serve a later GET). Only the behavior's
`CachedMethods` are cached, and a CachingDisabled policy (or no policy)
bypasses the cache.

The normal TTL follows the Expiration page's table: `s-maxage` wins over
`max-age`, `max-age` wins over `Expires`, `no-cache`/`no-store`/`private` are
not cached unless `MinTTL` is above zero, and `MinTTL`/`MaxTTL` bound the
result. Viewer `Cache-Control` and `Pragma` are never read.
`stale-while-revalidate` serves the stale object while the gateway refreshes it,
and `stale-if-error` serves it when the origin fails; both windows end at the
behavior's `MaxTTL`: "CloudFront will serve the stale content up to the value of
the stale-while-revalidate directive or the value of the CloudFront maximum TTL,
whichever is less." A 5xx response for an expired object also serves the stale
object, for the error caching minimum TTL (extended by `stale-if-error`), never
past `MaxTTL`; a 4xx response is returned instead of the stale object.

Error responses follow the HTTPStatusCodes page's status table, not "any 4xx or
5xx": 404, 414, 500, 501, 502, 503 and 504 are cached without a header; 400,
403, 405, 412 and 415 "only ... if your origin returns a Cache-Control max-age
or Cache-Control s-maxage header"; every other status (401, 429, ...) is not
cached. The duration is "the maximum of" the error caching minimum TTL (10
seconds by default, or the matched custom error response's
`ErrorCachingMinTTL`) and the origin response's max-age, s-maxage or `Expires`
value, capped by the behavior's Maximum TTL. For a custom error page the cap is
the Maximum TTL of the behavior the page is fetched through — the page's
behavior when an explicit behavior matches the page path, otherwise the
request's behavior: "The Cache-Control: max-age and Cache-Control: s-maxage
values cannot be greater than the Maximum TTL value set for the cache behavior
for which the error page is being fetched." An explicit `ErrorCachingMinTTL` of
0 disables error caching for a custom origin and means one second for an S3
origin. A CachingDisabled policy caches neither errors nor custom error pages,
including when it is the page's fetching behavior.

A hit answers `x-cache: Hit from cloudfront` and an `age` in seconds; a miss
answers `x-cache: Miss from cloudfront`. `session describe` reports per-behavior
hit and miss counts, each distribution's local id, the control-plane endpoint and
every invalidation.

**Custom error responses.** `CustomErrorResponses` is served: when the origin
answers a configured `ErrorCode`, the gateway finds "the first cache behavior in
your distribution that has a path pattern that matches the path of the custom
error page" and fetches `ResponsePagePath` from "the origin that is specified in
the cache behavior", with that behavior's origin request policy, then serves the
page with `ResponseCode`. When a cache behavior (not just the default behavior)
matches the page path, "CloudFront uses the cache behavior TTL instead" of the
error caching minimum. When the page itself is unavailable the gateway returns
"the status code that CloudFront received from the origin that contains the
custom error pages", i.e. the pages origin's status. A custom page is cached
under the same status/header rule as its `ErrorCode`. A `CustomErrorResponses`
entry for 412 or 415 that names a `ResponsePagePath` is refused by name, because
"CloudFront doesn't support creating custom error pages for these HTTP status
codes"; a status-only rewrite for those codes is accepted.

**Invalidation.** The runner serves `CreateInvalidation`, `GetInvalidation` and
`ListInvalidations` on a control endpoint that binds loopback and, when the host
owns the run network's gateway, that address too; it is
injected into every function as `AWS_ENDPOINT_URL_CLOUDFRONT`, `run` prints the
`127.0.0.1` URL, and `session describe` reports it. Paths must start with `/`,
are case sensitive, are URL-decoded before matching, may list at most 3000 paths
per request, and are at most 4000 characters; a `~` is refused. "The *, which
replaces 0 or more characters, must be the last character in the invalidation
path"; an asterisk anywhere else is a literal character. A path is matched
against the cached path plus the query string the cache policy forwarded, so
`/a.js` does not invalidate an entry cached under `/a.js?v=1` while `/a.js*`
does. Reusing a
`CallerReference` with the same paths returns the previous invalidation; with a
different path it is `InvalidationBatchAlreadyExists`, as the CreateInvalidation
reference states. An invalidation removes the matching cached objects, so the
next request is a miss.

**Deviations from CloudFront, and what the runner does instead:**

- A viewer request with a `Range` header bypasses the cache and reaches the
  origin; CloudFront can serve a byte range from the cached object, which this
  gateway does not slice. A conditional request (`If-None-Match` /
  `If-Modified-Since`) is answered 304 from the cached validators without
  reaching the origin.
- Concurrent misses for one key each reach the origin; CloudFront collapses
  them into one request.
- When the custom error page itself is unavailable, the pages origin's status is
  cached under the HTTPStatusCodes status table (a 404 page response is cached
  as a 404, for example); AWS does not state whether that fallback status is
  cached.
- A geo or signed-access denial routed through a custom error page is cached
  only when an explicit cache behavior matches the error page path: that
  behavior's cache policy then decides, using the page's `max-age`/`s-maxage`
  or its default TTL. The synthesized 403 carries no `max-age`, so without
  such a behavior it is not cached. The georestrictions page's "The default
  value is 10 seconds" suggests a geo denial gets the error caching window;
  the gateway keeps the HTTPStatusCodes rule and names that conservative
  choice here. When the page behavior does cache it, an unsigned 403 followed
  by a validly signed URL stays 403 until the TTL elapses; a page served with
  `Cache-Control: no-cache` under a behavior whose Minimum TTL is 0 avoids that
  in a dev loop, as does `ErrorCachingMinTTL: 0` where no explicit behavior
  matches.
- A custom error page fetch runs no origin-request function of the page's
  behavior and no viewer-request function; the trigger page exempts the viewer
  request for a custom error page fetch, and the gateway applies that exemption
  to the whole page request.
- A stored query key is order-normalized (the selected query strings are
  sorted), while an invalidation path's query string is compared exactly as
  given; AWS does not document the comparison. A path without the matching
  query string does not invalidate the entry, while a trailing `*` covers every
  variant.
- The control endpoint is unauthenticated and binds loopback plus, when the
  host owns it, the run network's gateway, so a function container reaches it
  through `host.docker.internal`, like the `@connections` management listener.
  It never binds the unspecified address. An invalidation is recorded `Completed`
  as soon as it removes the cached objects; CloudFront reports `InProgress`
  first.
- Lambda@Edge runs in the same container as every other local Lambda rather than
  in the CloudFront edge network. The viewer events observe the plain-HTTP
  connection, so a `CloudFront-Viewer-Protocol` value is `http`; the function's
  own `Timeout` is not applied because the event timeout (5 s viewer, 30 s
  origin) is the Lambda@Edge quota. A viewer-request function that adds a
  `CloudFront-*` header is a 502, as the restrictions page states; a
  `CloudFront-*` header the viewer sent is shown to the viewer-request function
  and, when a cache or origin request policy forwards it, replaced by the value
  CloudFront adds for origin-facing functions. `Content-Length` is not exposed
  to a local edge event because the gateway derives it from the body, so a
  function cannot read it and returning it is a 502 under the read-only rule.
- A key value store is materialised once, at plan time, from the asset the
  assembly carries. `fromBucket` is refused because the object is not part of
  the assembly; `fromAsset` and `fromInline` both carry one. CloudFront
  replicates a store to every edge location, which has no local equivalent.
- Signed URL and cookie verification happens before the viewer-request
  function. AWS does not document the order, and the gateway keeps the check
  ahead of every viewer function so a signed behavior matches the page's
  "requires a signed URL or signed cookie for every request except OPTIONS".
  A wildcard does not match a literal `;`, as the custom policy page states.
- Geo restriction runs before every viewer function, from the run flag; the
  viewer country is a run option, not a property of the request. When no flag is
  given the location is undetermined and the content is served.
- Field-level encryption runs after the origin-request function and before the
  origin fetch, so the function sees the plaintext fields. A blocked unknown
  content type or profile is a 400; AWS documents the block but not the status.
  The local viewer is plain HTTP, so the HTTPS viewer, all-seven-methods and
  origin-protocol preconditions are reported on the distribution instead of
  refusing it, and the origin receives a normal (not chunked) request body. The
  ciphertext uses RSA-OAEP with SHA-256 for both the hash and MGF1
  (`rsa.EncryptOAEP`); the page names
  `RSA/ECB/OAEPWithSHA-256AndMGF1Padding`, under which the MGF1 digest is a
  provider convention. CloudFront wire compatibility is proved only against the
  AWS Encryption SDK's `RSA_OAEP_SHA256_MGF1` wrapping algorithm. The page's 128
  character limit on a field pattern and on a query argument is not validated.
  When the configuration has no `QueryArgProfileConfig`, a `fle-profile` query
  argument has no effect; the gateway names it in the request log and in the
  distribution report instead of ignoring it silently.

`Compress`, `RealtimeLogConfigArn`, aliases, the viewer certificate, access
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
  `isBase64Encoded` and `body` map back. A `RESPONSE_STREAM` URL is streamed:
  the prelude supplies the status, headers and cookies and the payload after
  the 8-null-byte delimiter follows as the runtime writes it. A `NONE` URL is
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

**Not a CloudFront emulator: no edge network, no TLS.** The gateway does not
reproduce viewer protocol redirects, CloudFront's 1 ms CPU limit, the streaming
bandwidth cap (the "first 6 MB of your function's response payload has uncapped
bandwidth. After this initial burst, Lambda streams your response at a maximum
rate of 2 MBps"; the local gateway forwards at the origin's pace), custom
status descriptions or CloudFront-only device and TLS headers; the
viewer-country header is reproduced from `--viewer-country`. The streaming
branch applies the between-packet timeout from the origin's
`CustomOriginConfig.OriginReadTimeout` (the origin response timeout above), with
30 seconds as the default. A complete,
non-chunked origin response (including a Function URL whose `InvokeMode` is
`BUFFERED`, the template default) takes the unchanged buffered finish path, so
its viewer-response function, custom error pages, error caching, cache TTL and
refresh all run. A streamed origin response runs the Lambda@Edge
origin-response function, a CloudFront Function viewer-response and a
Lambda@Edge viewer-response function at the prelude. The viewer-response event
carries the status and headers, not the body: "Response event object data is
contained in three subobjects: config (`Records.cf.config`), request
(`Records.cf.request`), and response (`Records.cf.response`)", and the response
object holds `headers`, `status` and `statusDescription`
([event structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html));
the function therefore runs once both are known, before the body is forwarded,
and cannot change the status. A streamed response that ends with the
`Lambda-Runtime-Function-Error-Type` and `Lambda-Runtime-Function-Error-Body`
trailers keeps the bytes the runtime wrote: "Lambda treats this as a successful
response and forwards the error metadata that the runtime provides to the
client" ([custom runtime](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html)).
CloudFront removes the `Trailer` header before forwarding the response from the
origin to the viewer, and "if the chunked response is not complete, CloudFront
does not cache the object"
([custom origin behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html)).
The gateway logs the trailer metadata and does not cache the object as
complete, and the local surfaces do not forward the trailers to a client. A
`Content-Length` in a streaming prelude is recomputed by the local HTTP
server; a body without one is chunked, which is API Gateway's documented
default. The local forwarders write
the function's own response bytes to the local client; they do not build an
HTML page from request input. S3 bucket CORS rules, S3
IAM/bucket policies and Lambda IAM policy evaluation are not emulated. A viewer
`If-Range` is not carried to the S3 origin (CloudFront forwards it by default),
so a conditional range is served as an unconditional range. Lambda@Edge, key
value stores, signed URLs and cookies, geo restriction and field-level
encryption are applied; a WAF web ACL is refused because managed rule content is
a docs/125 true limit.

### Lambda@Edge, key value stores, signed access, geo restriction and field-level encryption

- **Lambda@Edge.** A behavior's `LambdaFunctionAssociations` invoke the real
  function container at the four documented events. The event is the
  `Records[0].cf` object; the viewer request and origin request events run only
  where the trigger page says, a viewer-request generated response is not
  cached, an origin-request generated response is cached under the behavior TTLs
  and served from the cache without the function, a viewer-response function
  cannot change the status, and an origin-request function may switch the
  request to another origin the distribution declares. An invalid returned
  object is a 502 and an unhandled exception or timeout is a 503. The viewer
  events time out at 5 seconds and the origin events at 30 seconds on the run
  clock. The plan-time rules are listed in the property inventory.
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-cloudfront-trigger-events.html
- **Key value stores.** A store is materialised from the asset its
  `ImportSource` names in the assembly. `cf.kvs()` returns `get` (string, json
  or bytes), `exists` and `meta`, and a missing key rejects, under the
  JavaScript 2.0 runtime only. A key over 512 bytes, a value over 1 KB, a store
  over 5 MB and more than one store per function are refused at plan time.
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html
- **Signed URLs and cookies.** A behavior with `TrustedKeyGroups` requires a
  signature for every request except OPTIONS. The local `Key-Pair-Id` for each
  `AWS::CloudFront::PublicKey` is deterministic and reported by `plan` and
  `session describe`. Canned and custom policies, SHA-1 and SHA-256, RSA and
  ECDSA, the section-bounded `Resource` wildcards, `DateLessThan`,
  `DateGreaterThan` and an IPv4 `IpAddress` are applied; the 403 is subject to
  the custom error response for 403 and its error caching. `TrustedSigners` is
  refused by name.
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html
- **Geo restriction.** `Restrictions.GeoRestriction` is applied from
  `--viewer-country XX` (ISO 3166-1 alpha-2, upper case) before any viewer
  function runs. Without the flag the location is undetermined and the content
  is served. A blocked viewer gets 403, subject to the custom error response and
  its error caching. When a cache or origin request policy forwards
  `CloudFront-Viewer-Country`, the gateway adds it. Any other `Restrictions`
  member is refused by name.
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/georestrictions.html
- **Field-level encryption.** A behavior linked to an
  `AWS::CloudFront::FieldLevelEncryptionConfig` encrypts the matching fields of
  a `application/x-www-form-urlencoded` POST. Each value becomes base64 AWS
  Encryption SDK ciphertext (version 1 non-framed message,
  `ALG_AES_256_GCM_IV12_TAG16_HKDF_SHA256`) that decrypts with the profile's
  provider name, the public key's name and
  `RSA/ECB/OAEPWithSHA-256AndMGF1Padding`. The unknown-content-type and
  unknown-profile rules forward or block as configured; a blocked request is a
  400. The page's HTTPS viewer, all-seven-methods and origin-protocol
  preconditions are reported as a local deviation (the local viewer is plain
  HTTP) instead of refusing the distribution.
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/field-level-encryption.html

The run fails, naming the construct, on:

- a WebSocket API that is the only surface;
- an HTTP API route whose authorization is not `NONE` or `CUSTOM`, or a CUSTOM
  route whose authorizer is not a REQUEST Lambda authorizer;
- a REST method whose authorization is not `NONE`, `COGNITO_USER_POOLS` or
  `CUSTOM`, or a CUSTOM method whose authorizer is not a TOKEN/REQUEST Lambda
  authorizer;
- a proxy integration that is not `AWS_PROXY`, a `MOCK` with no usable
  response, or HTTP API payload format other than `2.0`;
- a Function URL with an auth type other than `NONE` is not served as a
  standalone URL; it is listed under `skipped`. If it is the only surface, the
  run fails with that reason;
- a targeted function with no local asset (and no Docker asset), an inline code
  type the runtime cannot load, more than five layers or a layer the assembly
  cannot resolve, an image function that declares layers, an unsupported
  runtime, or a CloudFormation-expression `MemorySize`/`Timeout` (the AWS
  defaults apply only when the property is absent);
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
`AWS::SecretsManager::Secret` (`SecretString`, or a deterministic
`GenerateSecretString` in its bare, keyed and templated forms; a key without a
template keeps the v7.0.0 value and is reported as a warning), `AWS::SNS::Topic`
(standard and FIFO),
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

## Authorizers

| Kind | Template | What the transport does |
| --- | --- | --- |
| HTTP simple REQUEST | `AWS::ApiGatewayV2::Authorizer`, `AuthorizerType: REQUEST`, `EnableSimpleResponses` | Invokes the function with the v2 REQUEST event; `isAuthorized: false` is 401 and a true result's `context` becomes `requestContext.authorizer.lambda`. |
| HTTP JWT | `AWS::ApiGatewayV2::Authorizer`, `AuthorizerType: JWT`, `JwtConfiguration` | Reads the identity source (default `$request.header.Authorization`), requires the `Bearer` scheme, accepts only RSA-based algorithms (`RS256`, `RS384`, `RS512`; `none`, `HS*` and ECDSA are refused), and verifies the signature against the issuer's `/.well-known/jwks.json` with the key the header's `kid` names (a token without `kid`, or with no matching key after one refresh, is refused). Checks `iss`, `aud` (or `client_id` only when `aud` is absent; `aud` wins when both are present), `exp`, `nbf` and `iat` against the run clock. `AuthorizationScopes` is an any-of match: at least one of the route's scopes must be in the token's `scope`/`scp`, otherwise 403. Claims and scopes become `requestContext.authorizer.jwt.claims` and `.scopes`. |
| REST Cognito | `AWS::ApiGateway::Authorizer`, `Type: COGNITO_USER_POOLS`, `ProviderARNs` | Reads the identity-source header (a `Bearer ` prefix is accepted), validates the token against the pool's JWKS through the runner's local issuer with the same algorithm and claim checks as the HTTP JWT authorizer, treats `AuthorizationScopes` as an any-of match against the access token's `scope`/`scp` (the REST method API authorizes the invocation if any method scope matches a claimed scope), and exposes the claims as `requestContext.authorizer.claims`. |
| WebSocket `$connect` | `AWS::ApiGatewayV2::Authorizer`, `AuthorizerType: REQUEST`, referenced by the `$connect` route | Runs during the handshake with the documented WebSocket authorizer event and matches the returned IAM policy against `/<stage>/$connect`. See [WebSocket APIs](/examples/local-runner/#websocket-apis). |
| REST TOKEN/REQUEST policy | `AWS::ApiGateway::Authorizer`, `Type: TOKEN` or `REQUEST` | `TOKEN` invokes the function with `{type, authorizationToken, methodArn}` from the single `method.request.header.<name>` source and applies `IdentityValidationExpression` before the call. `REQUEST` invokes the documented request event with every `method.request.header.*`, `method.request.querystring.*` and `method.request.path.*` identity source. A missing identity source is 401 without invoking; `AuthorizerResultTtlInSeconds` caches the policy on the run clock (default 300, `0` disables, maximum 3600) keyed by the token or by every identity value in order, and a hit is re-evaluated against the current request's method ARN, because "If you enable authorization caching, API Gateway caches the policy so that the Lambda authorizer function isn't invoked again. Ensure that your policy is applicable to all resources and methods across your API." Allow invokes the method, Deny is 403, `{"errorMessage":"Unauthorized"}` is 401, an invalid response (including a missing `principalId`) is 500 and never cached, and the stringified context reaches `requestContext.authorizer`. |
| HTTP API policy (1.0/2.0) | `AWS::ApiGatewayV2::Authorizer`, `AuthorizerType: REQUEST`, `EnableSimpleResponses: false`, `AuthorizerPayloadFormatVersion` | Payload format 1.0 sends the REST-shaped event with `methodArn`; 2.0 sends the v2 event with `routeArn` and `routeKey`. The returned policy is matched against the route ARN; identity sources are the cache key and `$context.routeKey` caches per route. The cached value is the policy response: "By default, API Gateway uses the cached authorizer response for all routes of an API that use the authorizer", so a hit is re-evaluated against the current route ARN. A missing identity source is 401, the `Unauthorized` error is 401, an invalid response (including a missing `principalId`) is 500 and never cached, and the context reaches `requestContext.authorizer`. |

**Issuer resolution.** A JWT issuer or a Cognito `ProviderARN` may be a
CloudFormation expression, because a pool id exists only after creation. The run
evaluates the expression after provisioning. A canonical Cognito issuer
(`https://cognito-idp.<region>.amazonaws.com/<poolId>`) or pool ARN that names a
provisioned pool resolves to that pool's loopback issuer, and the canonical
issuer is accepted as an alias because it is the `iss` the pool's tokens carry.
Another `http(s)` OIDC URL is fetched directly. Anything else fails the run with
the route and the value named.

**Tokens and the clock.** Only RSA-based signature algorithms are supported:
RS256, RS384 and RS512. `alg: none`, HS* and ES256/ES384 are refused. `exp` is
required; `nbf` and `iat` are checked when present, and `exp`, `nbf` and `iat`
all use the run clock, so start a test clock slightly ahead of wall time (or
advance it past the token's `iat`) to use a freshly minted moto token,
`clock.advance` past its expiry tests the expired path, and a clock that starts
before the token's `iat` refuses it.

## Function packaging

| Construct | What the runner does |
| --- | --- |
| `Layers` on a zip function | Every entry must be an `AWS::Lambda::LayerVersion` in the function's stack with a local asset (`aws:asset:path`). The layer content is extracted into one `/opt` directory in the listed order; a later layer's file replaces an earlier one. A relative symlink whose target stays inside the layer is extracted as the same symlink (CDK's default `SymlinkFollowMode.NEVER` stores an asset's symlinks, and `npm install` leaves `node_modules/.bin` shims as symlinks); a symlink with an absolute target or one that escapes the layer root is refused by name. A layer asset that is a zip file rather than an extracted directory is refused because the runner needs the directory. More than five layers, a literal layer ARN, an `Fn::ImportValue` and any other unresolvable reference are refused by name. |
| Layer runtime paths | `/opt/bin` is prepended to `PATH`, `/opt/lib` to `LD_LIBRARY_PATH`, `/opt/nodejs/node_modules` and `/opt/nodejs/node<major>/node_modules` to `NODE_PATH` (Node), and `/opt/python` plus `/opt/python/lib/python<major>.<minor>/site-packages` to `PYTHONPATH` (Python). The image's own values are read with `docker image inspect` and kept after the layer paths; a failed inspect falls back to a documented default `PATH`. |
| `PackageType: Image` / `Code.ImageUri` | The `aws:asset:path`, `aws:asset:dockerfile-path`, `aws:asset:docker-build-args`, `aws:asset:docker-build-target` and `aws:asset:docker-platform` metadata are read from the function resource. `docker build` runs with the asset directory as the context, the image is tagged `<name-prefix>-<run-id>-<logical-id>-image` with the run label, and the container starts with the image's own entrypoint (no command, no code mount). The build runs before any listener serves. In the default mode the runner hosts the Runtime API the image's runtime client connects to; with `--rie` it starts the image's own Runtime Interface Emulator instead. The tag is per app hash plus the run id, so two concurrent runs of one app never move each other's image tag; docker's layer cache still reuses unchanged build steps. |
| Refusals | An image without `aws:asset:path`, an image that declares `Layers`, and — under `--rie` — an image whose container never starts a Runtime Interface Emulator all fail by name (the last cites the images-create page). A zip function whose runtime image cannot be pinned fails in the image-resolution step. |

Layer and image builds happen before `run` starts serving; the run shuts down
its containers, its network and every image it built.

## CodeBuild

A synthesized `AWS::CodeBuild::Project` is served on a control endpoint
injected into every function as `AWS_ENDPOINT_URL_CODEBUILD`. The endpoint
speaks the AWS JSON 1.1 protocol (`Content-Type:
application/x-amz-json-1.1`, `X-Amz-Target: CodeBuild_20161006.<operation>`):

| Operation | Behaviour |
| --- | --- |
| `StartBuild` | Creates `<project>:<uuid>`, publishes an `IN_PROGRESS` state-change event, runs the buildspec through the local agent, and returns the build record. `buildspecOverride`, `environmentVariablesOverride`, `imageOverride` and `timeoutInMinutesOverride` are honoured; `privilegedModeOverride=true` and a non-small `computeTypeOverride` are refused by name. |
| `BatchGetBuilds` | Returns the records for the requested ids, with `phases`, `buildStatus`, `environment`, and `logs` (the captured output is in the additive local `logs.text`). |
| `ListBuildsForProject` | Returns the project's build ids newest first. |
| `BatchGetProjects` / `ListProjects` | Return the local project documents and names. |

The profile pins the agent and one build image per declared image class and
architecture:

```json
{
  "profile": {
    "codeBuild": {
      "agent": {
        "aarch64": {"tag": "public.ecr.aws/codebuild/local-builds:aarch64", "digest": "sha256:…", "license": "Amazon Software License 1.0"},
        "x86_64": {"tag": "public.ecr.aws/codebuild/local-builds:latest", "digest": "sha256:…", "license": "Amazon Software License 1.0"}
      },
      "images": {
        "aws/codebuild/standard:7.0": {
          "aarch64": {"tag": "public.ecr.aws/codebuild/amazonlinux-aarch64-lambda-standard:nodejs24", "digest": "sha256:…", "compressedBytes": 1283010354},
          "x86_64": {"tag": "public.ecr.aws/codebuild/amazonlinux-x86_64-lambda-standard:nodejs24", "digest": "sha256:…", "compressedBytes": 1357342127}
        },
        "public.ecr.aws/codebuild/amazonlinux-aarch64-standard:3.0": {
          "aarch64": {"tag": "public.ecr.aws/codebuild/amazonlinux-aarch64-standard:3.0", "digest": "sha256:…", "compressedBytes": 4677714403}
        }
      }
    }
  }
}
```

An unmapped `Environment.Image` or an architecture with no pin fails before the
run starts. The agent takes the build image explicitly, so the class mapping is
a local affordance rather than an AWS rule; `standard:7.0` is an x86_64 image,
so the aarch64 host maps it to the Lambda-standard aarch64 image. A build that
needs the full toolchain opts in with
`imageOverride: public.ecr.aws/codebuild/amazonlinux-aarch64-standard:3.0`,
which the checked-in profile pins as its own class; the Lambda-standard image
stays the default. The images are distributed under the Amazon Software
License 1.0
([aws-codebuild-docker-images](https://github.com/aws/aws-codebuild-docker-images)).
The agent is the published local agent
([use the CodeBuild agent](https://docs.aws.amazon.com/codebuild/latest/userguide/use-codebuild-agent.html)).

`StartBuild` creates `<scratch>/codebuild/<project>/<build>/` with `src/`,
`artifacts/` and `env/`, writes the inline buildspec to `src/buildspec.yml` and
the project environment to `env/env.list`, then runs the agent container with
the Docker socket and `SOURCE`, `ARTIFACTS`, `IMAGE_NAME`,
`LOCAL_AGENT_IMAGE_NAME`, `ENV_VAR_FILE` and a unique `COMPOSE_PROJECT_NAME`.
The agent starts the pinned build image, and the runner parses the
`[Container] … Entering phase` / `Phase complete: …` lines into the build
phases. The build container is not attached to the run network; its AWS
endpoint is the closed local port, so a build that calls AWS fails closed. The
agent's compose containers, network and volumes are removed after the build.

The event shape is the documented "CodeBuild Build State Change" event:
`source: aws.codebuild`, `detail-type: CodeBuild Build State Change`, and
`detail: {build-status, project-name, build-id, current-phase,
additional-information}` ([build notifications](https://docs.aws.amazon.com/codebuild/latest/userguide/sample-build-notifications.html)).
The project name is the deterministic local name the template's `Ref` resolves
to, so a rule written as `detail.project-name: [{"Ref": "Project"}]` matches.
IN_PROGRESS and the final SUCCEEDED/FAILED events are published on the default
bus.

Deviations: CodePipeline, VPC, EFS, secondary sources, cache, artifact upload,
report groups, privileged mode and non-small compute types are not served; each
is reported on the project's `skipped` entry (and in `plan`). Only `NO_SOURCE`
buildspecs run. An `EnvironmentVariables` value that is a literal or a resolvable
CloudFormation expression (a parameter/condition/`Fn::Join`, or a `Ref`/`Fn::GetAtt`
naming a resource in the same stack) becomes the variable's value; one that still
depends on the deployed stack is named as a deviation and the variable is left
out. `CompressedBytes` is the public registry's compressed size. The
aarch64 agent plus Lambda-standard image need about 8 GB of colima disk, and the
opt-in full-toolchain image adds about 10.9 GB on disk; colima's disk is not a
fixed limit, so grow it before a pull when it is short. A capacity failure fails
the row rather than mocking a build.

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
| `AWS_ENDPOINT_URL_<SERVICE>` (and the profile's alias names) | the configured endpoint. Secrets Manager and Cognito use `AWS_ENDPOINT_URL_SECRETS_MANAGER` and `AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER`; the short `AWS_ENDPOINT_URL_COGNITO_IDP` alias is also injected. The CodeBuild control endpoint is `AWS_ENDPOINT_URL_CODEBUILD`. |
| `AWS_ENDPOINT_URL` | the single endpoint, or `http://127.0.0.1:1` when zero or several are configured |
| `AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI` | the WebSocket `@connections` endpoint, when the assembly declares a WebSocket API. The value is the container-facing TLS URL (`https://host.docker.internal:<port>`). The listener binds loopback and, when the host owns the run network's gateway, that address too; it never binds the unspecified address, is unauthenticated, and the session reports the loopback URL (`https://127.0.0.1:<port>`). |
| `AWS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` | the per-run management certificate, mounted at `/etc/apptheory-local/ca.pem`, so the Go, Node and Python SDKs trust the `@connections` TLS endpoint. |

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

**WebSocket** — the documented proxy event:
`requestContext` with `routeKey`, `eventType` (`CONNECT`/`DISCONNECT`/`MESSAGE`),
`messageId` (messages), `connectedAt` (epoch ms), `requestId`,
`extendedRequestId`, `requestTime` (`02/Jan/2006:15:04:05 -0700`),
`requestTimeEpoch`, `messageDirection` (`IN`), `identity.sourceIp`,
`identity.userAgent`, `stage`, `domainName` (the container-facing
`@connections` host and port), `connectionId` and `apiId`, plus `body` and
`isBase64Encoded`. A `$disconnect` event adds `disconnectReason`
(`CLIENT_INITIATED_DISCONNECT` or `INTERNAL_ERROR`). The API id is a stable
ten-character id derived from the logical id.

**WebSocket `$connect` authorizer** — `type: "REQUEST"`, `methodArn`
(`arn:aws:execute-api:us-east-1:123456789012:<apiId>/<stage>/$connect`),
`headers`, `multiValueHeaders`, `queryStringParameters`,
`multiValueQueryStringParameters`, `stageVariables` and the `requestContext`
above with `eventType: "CONNECT"`. The response is an IAM policy; the runner
matches each statement's `Action` and `Resource` (with `*`/`?` wildcards)
against the method ARN. A Deny wins; no Allow refuses with 401.

**JWT and Cognito authorizer claims** — an HTTP API JWT authorizer adds
`requestContext.authorizer.jwt = {"claims": {…}, "scopes": ["…"]}`; a REST
Cognito authorizer adds `requestContext.authorizer = {"claims": {…}}`. The
claims are the token's validated payload (for example `iss`, `aud`/`client_id`,
`sub`, `token_use`, `scope`, `exp`, `nbf`, `iat`).

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

**S3 event notification** — the record envelope is
`{"Records":[{…}]}` with `eventVersion: "2.6"`, `eventSource: "aws:s3"`,
`awsRegion`, `eventTime` (ISO-8601 with milliseconds), `eventName`
(`ObjectCreated:Put`, `ObjectRemoved:Delete`), `userIdentity`,
`requestParameters.sourceIPAddress`, `responseElements` (`x-amz-request-id`,
`x-amz-id-2`) and `s3` with `s3SchemaVersion: "1.0"`, the configuration's
`configurationId`, `bucket.name`/`bucket.arn`/`bucket.ownerIdentity` and
`object.key` (URL-encoded; space becomes `+`, `/` is kept),
`object.size`/`object.eTag`/`object.sequencer`. The SQS and SNS destinations
receive that JSON; an SNS delivery wraps it in the SNS envelope. The
`s3:TestEvent` message S3 sends on configuration has the simplified shape
`{"Service":"Amazon S3","Event":"s3:TestEvent","Time",…,"Bucket",…}`.

**S3 notification event names.** The watcher observes creates and deletes only.
A configuration may name `s3:ObjectCreated:*`, `s3:ObjectCreated:Put`,
`s3:ObjectRemoved:*` or `s3:ObjectRemoved:Delete`; plan refuses every other
`s3:` event name by name (for example `s3:ObjectCreated:Copy` or
`s3:ObjectRestore:*`) with the reason "the local watcher observes creates and
deletes only". A configuration mixing a producible and an unproducible name is
refused the same way, never silently narrowed. The four names are the part of
the
[S3 event notification types](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html)
list the observation can reproduce.

**Overlapping key filters are refused like AWS.** AWS's
`PutBucketNotificationConfiguration` rejects configurations on one bucket whose
prefix/suffix filters overlap for the same event type unless the suffixes do not
overlap
([object key name filtering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-filtering.html)).
The runner applies the same rule at derive time: a pair whose event types
intersect is refused when both the prefixes overlap (one is a prefix of the
other, or either configuration has no prefix rule) and the suffixes overlap (one
is a suffix of the other, or either configuration has no suffix rule). The error
names both configuration ids and the event type. Pairs with different event
types, or with non-overlapping suffixes, are registered.

**S3 → EventBridge** — a bucket with `EventBridgeConfiguration` publishes the
envelope the runner's bus builds from one entry: `source: "aws.s3"`,
`detail-type: "Object Created"` or `"Object Deleted"`, `resources:
["arn:aws:s3:::<bucket>"]`, and `detail` with `version: "0"`,
`event-version: "1.2"`, `bucket.name`, `object.key`/`object.etag`/`object.size`
(created events), `object.sequencer`, `request-id`, `requester`,
`source-ip-address` and `reason` (`PutObject`/`DeleteObject`). The bus adds the
`id`, `account` (`123456789012`), `time` and `region` fields, as it does for
every `PutEvents` entry.

**Kinesis / CloudWatch Logs** — a Kinesis event with
`eventSource: "aws:kinesis"`, the stream ARN and one record per input. The
CloudWatch Logs helper builds a `DATA_MESSAGE` subscription payload from the
supplied log events, gzips it, and base64-encodes it into `kinesis.data`, as
AWS does.

A body that is not valid UTF-8 is base64-encoded and `isBase64Encoded` is `true`.

## Response decoding

The runtime returns one JSON body (the emulator returns the same shape in
`--rie` mode):

- `statusCode`, `headers`, `multiValueHeaders`, `cookies`, `body`,
  `isBase64Encoded` are all honoured; `multiValueHeaders` wins over `headers` for
  the same name;
- a chunked body is a streaming response. The transports parse the metadata
  prelude (`{metadata JSON}` + eight NUL bytes) when the Function URL or REST
  API proxy integration requires one, forward the payload as it arrives, and a
  buffered caller decodes the complete framed body (`Streamed: true`) with its
  metadata and body;
- `errorType`/`errorMessage` without a `statusCode` is a handler error and is
  served as `502 {"message":"Internal Server Error"}` (the detail is logged)
  on the four HTTP-serving surfaces: the standalone Function URL listener, a
  Function URL origin behind CloudFront, HTTP API v2 and REST API v1. The
  `invoke` bullet below keeps its own result rules, and the WebSocket
  transport's answer is its own bullet;
- a Function URL applies AWS's inference rule to a genuine return value on
  every local Function URL surface: the standalone listener (a buffered
  response, and a buffered response on a `RESPONSE_STREAM` URL), the Function
  URL origin behind CloudFront, and a streamed response's prelude. "If your
  function returns valid JSON and doesn't return a statusCode, Lambda assumes
  the following: statusCode is 200 ... content-type is application/json ...
  body is the function response"
  ([Function URL payloads](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html)).
  A streaming prelude whose metadata omits `statusCode` is a 200 with the
  prelude's headers and the framed payload. An error payload is still the 502
  above;
- a buffered JSON object whose `statusCode` key is present but invalid
  (including one outside 100-599) and a buffered body that is neither valid
  JSON nor a framed stream are `502` on the standalone Function URL listener,
  the Function URL origin behind CloudFront, HTTP API v2 and REST API v1;
- a buffered streaming frame whose metadata carries a present-but-invalid
  `statusCode` is `502` on those same four HTTP-serving surfaces; it is neither
  an inferred return value nor a handler error, so neither of the two bullets
  above names it;
- a missing `statusCode` on HTTP API v2 and REST API v1 is `502` too, while
  the standalone listener and the CloudFront origin apply the Function URL
  inference rule above and answer a genuine JSON return value with a `200`;
- `invoke` never turns a result into a status: a valid JSON body that is not a
  proxy response, including one whose `statusCode` is missing or invalid, is
  the `raw` result and a non-JSON body is the `rawText` result, with
  `handlerError` reserved for a crashed handler;
- the WebSocket transport answers any invoke failure at `$connect` with `500`
  (not only a decode failure) and drops the message on a message route when the
  invoke fails, including a decode failure;
- a request with no matching route is `404 {"message":"Not Found"}` from the
  local transport; bodies above 10 MB are `413`.

`Content-Length`, `Transfer-Encoding` and other hop-by-hop headers from the
handler are dropped and recomputed by the local HTTP server.

Cookies follow the Function URL page: "To return cookies from your function,
don't manually add set-cookie headers. Instead, include the cookies in your
response payload object. Lambda automatically interprets this and adds them as
set-cookie headers in your HTTP response"
([Function URL payloads](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html)).
The buffered Function URL inference therefore takes cookies from the frame's
`cookies` field and does not turn a `Set-Cookie` header into cookies. The
streamed pipe sink forwards a `Set-Cookie` metadata header as-is, which is a
local pass-through divergence from that rule; a handler that wants the AWS
behaviour puts cookies in `cookies` on every surface.

## Runtime API fidelity

The runner's Runtime API follows the AWS pages, not the emulator. What it does
not reproduce, and the page that owns each rule:

- **Lambda Managed Instances concurrency.** "Managed Instances can accept
  concurrent /next and /response requests up to the configured
  `AWS_LAMBDA_MAX_CONCURRENCY` limit"
  ([runtime API](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html)).
  The runner starts no `AWS_LAMBDA_MAX_CONCURRENCY` and processes one
  invocation at a time per container, which is the default-capacity contract.
- **SnapStart.** `/runtime/restore/next` and `/runtime/restore/error` answer
  `404` with "SnapStart is not enabled for this function" (same page). No
  snapshot, restore hook or before-checkpoint hook runs.
- **Extensions and the Telemetry API.** The lifecycle page says extensions
  "communicate with Lambda using the Extensions API" and "can also receive log
  messages and other telemetry from the function by using the Telemetry API"
  ([execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)).
  The runner starts no extension process and serves neither API, so the
  shutdown event, the extension crash rules and the telemetry events are not
  reproduced.
- **X-Ray.** The invocation carries a `Lambda-Runtime-Trace-Id` response header
  and the runtime sets `_X_AMZN_TRACE_ID` from it, as the runtime API page
  describes, but no X-Ray daemon runs and `AWS_XRAY_DAEMON_ADDRESS` is not set,
  so no trace segment is produced.
- **Init-phase timing and billing.** The 10-second Init limit and the billed
  Init duration are not simulated; a slow initialization is simply allowed to
  finish, and the first invocation fails with the runtime's own initialization
  error if it does not.
- **`/tmp` across a reset.** A reset replaces the container, so the next
  execution environment starts with an empty `/tmp`. The lifecycle page says
  "the Lambda reset does not clear the `/tmp` directory content before the next
  init phase" ([execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html));
  the runner does not carry the directory over.
- **Streaming bandwidth and payload limits.** The 6 MB uncapped burst and
  2 MBps cap are not reproduced, and the 6 MB buffered / 200 MB streamed
  payload limits are not enforced.

Where the emulator deviates from a page, the runner implements the page: a
timeout is the documented `Sandbox.Timedout` error rather than the emulator's
plain-text body, an initialization failure keeps its documented error type and
message, and a streamed response is forwarded as it is written. The conformance
suite in [the runner guide](/examples/local-runner/#conformance-suite) reports
every remaining difference between the two modes.

## Isolation and cleanup

- One Docker network per run: `<name-prefix>-net`, labelled
  `apptheory.local.run`, `apptheory.local.app` and `apptheory.local.managed`.
- Function containers: `<name-prefix>-<logicalId>`. Backend containers:
  `<name-prefix>-dynamodb`, `<name-prefix>-moto`, `<name-prefix>-s3proxy` and
  `<name-prefix>-sqs`; each also carries its profile container name as a
  network alias.
- Each backend port is published on loopback only (`-p 127.0.0.1::<port>`).
  In `--rie` mode the emulator port is published the same way. In the default
  mode a function container reaches the Runtime API through
  `host.docker.internal:<port>`. The listener never binds the unspecified
  address: it binds loopback (`127.0.0.1:<port>`) and, when the host owns the
  run network's gateway address (`docker network inspect <run network>` reports
  it as the IPAM gateway, the Linux bridge case), also binds that address and
  names it in the container's `host.docker.internal` host entry. When the host
  does not own it (Colima, Docker Desktop), the container keeps Docker's
  `host-gateway` entry, which those runtimes forward to the host's loopback,
  and the gateway bind fails harmlessly. The runtime's first `/next` proves the
  address and the runner logs the entry it used; the session reports the
  loopback URL. The runner uses the backend's loopback port to
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
