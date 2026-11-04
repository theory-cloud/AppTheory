---
title: Run an app locally
---

# Run an app locally

`apptheory local` runs an AppTheory app's **real Lambda handlers** on your
machine. The app's existing CDK definition is the only routing source: the
command synthesizes the app, reads the cloud assembly, starts each function in
the official AWS Lambda runtime image, and serves the HTTP API v2, REST API v1,
Function URL and CloudFront distribution surfaces it found. There is no second
hand-written route table.

A CloudFront distribution is served as its edge path, not as a second copy of
the origin: the gateway selects the cache behavior, runs the distribution's
generated CloudFront Functions, applies the origin request and response headers
policies, and hands origin requests to an origin implementation. The S3 origin
reads the app's own bucket deployments from the local s3proxy backend, the
Function URL origin invokes the real handler through the runner's runtime
container, and an origin group applies CloudFront's failover rules. It is not a
CloudFront emulator: there is no caching, no edge network and no TLS.

```bash
# Serve the app in the background, then use the printed URLs.
go run ./cmd/apptheory-local --app examples/cdk/hello-world -c lang=go \
  --profile scripts/local/examples-local.json --backend dynamodb

# Print the derived surface without starting anything.
go run ./cmd/apptheory-local plan --app examples/cdk/hello-world -c lang=go --json
```

`apptheory-local invoke` starts one function instead of an HTTP surface. It is
for event-source handlers and for examples that ship a handler but no CDK
definition; see [Invoking one function](#invoking-one-function).
`apptheory-local session` starts every function the CDK definition targets and
exposes one JSON command per line on stdin/stdout; the examples harness uses it
to receive real messages, write real items and build the provider events the
event-source mappings would deliver. See [Automation sessions](#automation-sessions).

The command is language-neutral. A Go, TypeScript or Python handler is served by
the same binary because the runtime comes from the CDK stack, not from the
caller: `provided.al2023` for Go, `nodejs:24` for Node, `python:3.14` for Python.
`make examples-local` runs the three hello-world rows this way.

## Run your own app

The commands above run from this repository. An app that lives anywhere else
uses the same command; `--app` is the app's CDK directory and `--profile` pins
the runtime images:

```bash
# Run a released module without checking out AppTheory.
go run github.com/theory-cloud/apptheory/v6/cmd/apptheory-local@<version> \
  --app ~/code/my-app --profile ~/code/my-app/local-profile.json

# Or install the command once.
go install github.com/theory-cloud/apptheory/v6/cmd/apptheory-local@<version>
apptheory-local --app ~/code/my-app --profile ~/code/my-app/local-profile.json
```

`<version>` is a release that contains the command (v6.5.0 or later);
`go list -m -versions github.com/theory-cloud/apptheory/v6` lists released
versions.

Before that release, run the command from a sibling AppTheory checkout (the
same model as FaceTheory Phase 3):

```bash
# Run from the checkout without installing anything.
go run -C ~/code/AppTheory ./cmd/apptheory-local \
  --app ~/code/my-app --profile ~/code/my-app/local-profile.json

# Or build the command once and keep it outside the checkout.
go build -C ~/code/AppTheory -o ~/bin/apptheory-local ./cmd/apptheory-local
~/bin/apptheory-local --app ~/code/my-app --profile ~/code/my-app/local-profile.json
```

TypeScript and Python apps need a Go toolchain only to run `apptheory-local`;
their handlers keep running in the official Node or Python runtime image and
never see the Go toolchain. A Go handler is built by its CDK bundling step
during synthesis, before any function container starts.

### What your app needs

- `cdk.json` and a synthesized HTTP API v2, REST API v1 or Function URL. The
  CDK definition is the only routing source.
- A CDK v2 app with `aws-cdk-lib` and `constructs`, and the CDK CLI installed in
  the app directory as a dev dependency:

  ```bash
  npm install --save aws-cdk-lib@2.275.0 constructs@10.8.1
  npm install --save-dev aws-cdk@2.1147.0
  ```

  `HttpLambdaIntegration` is exported from
  `aws-cdk-lib/aws-apigatewayv2-integrations`, which ships inside
  `aws-cdk-lib`; there is no separate integrations package to install. The
  runner executes `node_modules/.bin/cdk`; it does not install packages.
- A local profile passed with `--profile`. It is required for `run` and
  `invoke`, because it pins every runtime image by digest and the Python image
  the preflight needs.

The minimal profile below names only the images the app uses, plus the Python
image for the in-container preflight. The complete example includes one.

### A complete minimal app

These five files are a working Node app: one Lambda function behind one HTTP
API v2 route. Create a directory outside this checkout, save each file there,
then run the commands in the next section.

#### `package.json`

```json
{
  "name": "my-local-app",
  "private": true,
  "dependencies": {
    "aws-cdk-lib": "2.275.0",
    "constructs": "10.8.1"
  },
  "devDependencies": {
    "aws-cdk": "2.1147.0"
  }
}
```

#### `cdk.json`

```json
{
  "app": "node bin/app.js"
}
```

#### `bin/app.js`

```javascript
const cdk = require("aws-cdk-lib");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const integrations = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const lambda = require("aws-cdk-lib/aws-lambda");

const app = new cdk.App();
const stack = new cdk.Stack(app, "MyLocalAppStack");

const handler = new lambda.Function(stack, "Handler", {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset("handler"),
});

const api = new apigwv2.HttpApi(stack, "Api");
api.addRoutes({
  path: "/hello",
  methods: [apigwv2.HttpMethod.GET],
  integration: new integrations.HttpLambdaIntegration("HandlerIntegration", handler),
});
```

#### `handler/index.js`

```javascript
exports.handler = async (event) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    message: "hello from your local app",
    path: event.rawPath,
  }),
});
```

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

Add a `go` pin (`provided:al2023`) for a Go app or use `python` for a Python
app. Add `dynamodbLocal` and an `endpoints.dynamodb` entry only when you pass
`--backend dynamodb`; the [configuration reference](/reference/local-runner-configuration/)
has the full schema.

Profile validation happens in three stages. Malformed JSON fails when the command
starts, before it synthesizes anything. A missing image class or an unpinned tag
is reported after synthesis, when the runner resolves the images for the served
functions — still before any function container starts — with the profile path
and the reason. A missing Python pin for the preflight is reported after the run
network is created, before any function container starts.

### Plan, run, call and stop

From the app directory, with a sibling AppTheory checkout at `~/code/AppTheory`:

```bash
cd ~/code/my-local-app
npm install

# Print the derived surface without starting a container.
go run -C ~/code/AppTheory ./cmd/apptheory-local plan \
  --app ~/code/my-local-app --profile ~/code/my-local-app/local-profile.json

# Serve the app. Keep this terminal open.
go run -C ~/code/AppTheory ./cmd/apptheory-local \
  --app ~/code/my-local-app --profile ~/code/my-local-app/local-profile.json \
  --name-prefix my-local-app
```

The served URL is the address on the `serving …` line the runner prints before
`local-run: ready`:

```
function Handler… (nodejs24.x, public.ecr.aws/lambda/nodejs:24@sha256:…) ready on 127.0.0.1:49xxx
serving httpv2 Api… at http://127.0.0.1:18780
local-run: ready
```

Call the URL from another terminal (replace the port with the one the `serving`
line printed):

```bash
curl -i http://127.0.0.1:18780/hello
```

The response is:

```json
{"message":"hello from your local app","path":"/hello"}
```

The `127.0.0.1:<port>` on the `function …` line is the internal Runtime
Interface Emulator port, not the app URL. Stop the run with `Ctrl-C` (`SIGINT`)
or `SIGTERM`; the command closes the listeners, removes its containers and
network, deletes the scratch directory and exits 0.

A built binary replaces `go run -C` in the same commands:

```bash
go build -C ~/code/AppTheory -o ~/bin/apptheory-local ./cmd/apptheory-local
~/bin/apptheory-local plan \
  --app ~/code/my-local-app --profile ~/code/my-local-app/local-profile.json
~/bin/apptheory-local \
  --app ~/code/my-local-app --profile ~/code/my-local-app/local-profile.json \
  --name-prefix my-local-app
```

## What "locally" means

- **No AWS credentials.** The runner sets static dummy keys and removes every
  inherited `AWS_*`, `CDK_*`, proxy variable, and the `DYNAMODB_ENDPOINT`,
  `DDB_ENDPOINT`, `TABLE_NAME` and `QUEUE_URL` aliases from the processes it
  starts.
- **No real AWS.** Function containers get closed DNS (`127.0.0.2`) and only the
  `/etc/hosts` entries the runner adds. Every SDK endpoint is overridden to a
  local URL. A preflight probe inside the run network must prove that a real AWS
  hostname does not resolve before the first handler starts.
- **No operator environment variables.** Endpoints, image pins and backend
  settings come from flags or the checked-in local profile
  (`scripts/local/examples-local.json`).

## How it works

1. **Synthesize.** `cdk synth` runs with dummy credentials, a fixed account and
   region (`123456789012` / `us-east-1`) and the app's local CDK CLI. Context
   passed with `-c key=value` reaches CDK unchanged.
2. **Derive.** The cloud assembly is read, not the deployed stack:
   - `AWS::Lambda::Function`: runtime, handler, architecture, memory, environment
     and the CDK asset directory (or inline `Code.ZipFile`);
   - `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), routes and proxy
     integrations;
   - `AWS::ApiGatewayV2::Api` (`ProtocolType: WEBSOCKET`), its route selection
     expression, its `$connect`/`$disconnect`/`$default` and custom routes, and
     a `$connect` REQUEST authorizer;
   - `AWS::ApiGateway::RestApi`, its resource tree, methods and stage;
   - `AWS::Lambda::Url` Function URLs;
   - `AWS::Logs::SubscriptionFilter`, its log group and its destination (a
     Lambda function, or an `AWS::Logs::Destination` followed to its Kinesis
     stream);
   - `AWS::SSM::Parameter`, `AWS::SecretsManager::Secret`, `AWS::SNS::Topic`
     (including its inline `Subscription`), `AWS::SNS::Subscription`,
     `AWS::Kinesis::Stream`, `AWS::Cognito::UserPool`/`UserPoolClient` and
     `AWS::KMS::Alias`. A `AWS::SecretsManager::ResourcePolicy`,
     `AWS::SNS::TopicPolicy` or `AWS::Cognito::UserPoolDomain` is reported
     under `skipped`: the resource it attaches to is still provisioned, but IAM
     policy evaluation and the Cognito hosted UI are outside the local runner;
   - every provisioned resource is listed by `plan` with the local identifier
     the CDK definition fixes (a KMS key id and a secret ARN suffix are marked
     as assigned at run);
   - `AWS::CloudFront::Distribution`, its cache behaviors, origins and origin
     groups, the `AWS::CloudFront::Function` resources it associates, and the
     cache, origin request and response headers policies and origin access
     controls it references. A distribution property the gateway cannot route or
     render faithfully is reported, and the distribution is refused.
   A REST `MOCK` integration is served from the status and headers the template
   declares (CDK uses it for CORS preflight).
3. **Resolve images.** The profile's digest-pinned image for each served
   function's runtime is selected before any container starts. A missing image
   class or a tag that is not pinned by digest fails here, after synthesis.
4. **Prepare the run workspace.** Inline `Code.ZipFile` code is materialized
   under the run scratch directory, then the run's private Docker network is
   created.
5. **Start backends.** `--backend dynamodb`, `--backend moto`,
   `--backend s3proxy` and `--backend sqs` start the profile's digest-pinned
   emulators on the run's private network. Before it reports a backend ready,
   the runner waits up to 60 seconds for every endpoint configured on that
   backend to answer a read-only call native to the service over its published
   loopback port: `ListTables` for DynamoDB Local, `ListKeys` and
   `GetCallerIdentity` for moto KMS/STS, `DescribeParameters` for SSM,
   `ListSecrets` for Secrets Manager, `ListTopics` for SNS, `ListStreams` for
   Kinesis, `ListUserPools` for Cognito, `ListBuckets` for s3proxy and
   `ListQueues` for ElasticMQ. A service with no native probe is checked with a
   plain HTTP request. On timeout the run fails with the backend, its image and
   the last error, before any resource is provisioned. A backend with no
   published host port is reported ready without this wait.
6. **Provision resources.** When the backend is ready, the runner creates every
   resource the assembly declares, in this order: S3 buckets; each
   `Custom::CDKBucketDeployment` source copied into its bucket with the declared
   destination prefix and metadata; KMS keys (symmetric and asymmetric) and
   their aliases; DynamoDB tables with their key schema, GSIs, streams and TTL;
   SQS queues with their visibility, retention and redrive policy; SSM
   parameters (String, StringList and SecureString); Secrets Manager secrets
   (`SecretString`, and a deterministic local `GenerateSecretString`); SNS
   topics (standard and FIFO); Kinesis streams (provisioned or on-demand, with
   retention); and Cognito user pools and clients. It records the provisioned
   values environment resolution needs. Attributes the local emulator does not
   implement (SSE, PITR, deletion protection, KMS-on-SQS, IAM resource
   policies) are not provisioned; they are not part of the local contract.
7. **Resolve environment references.** A served function's `Ref`/`Fn::GetAtt`
   environment values are resolved to deterministic local values: a DynamoDB
   table name and stream ARN, an SQS queue name or URL, an EventBridge rule
   name, an S3 bucket name or ARN, a Kinesis stream name or ARN, an SSM
   parameter name, Type and Value, a Secrets Manager secret ARN, an SNS topic
   ARN or TopicName, a Cognito pool id or client id with its Arn, ProviderName
   and ProviderURL, a KMS key id or ARN, a KMS alias name, and the ARNs of IAM,
   MicroVM-image and S3 Vectors resources. The values for provisioned resources
   are the ones the previous step created. A `{{resolve:secretsmanager:…}}`
   value resolves to the provisioned secret's value when that secret exists in
   the assembly (the same JSON key), and otherwise keeps the wave-1
   deterministic local placeholder; the session's `describe` returns it, and
   the run never prints it. An expression the runner cannot resolve fails
   closed with the function and variable named.
8. **Preflight.** A probe container on the run's private network proves the
   dummy credentials, every configured endpoint, the DynamoDB SDK endpoint when
   one is configured, and closed DNS.
9. **Run.** One container per function the CDK definition targets: HTTP routes,
   Function URLs, HTTP API authorizers, enabled event-source consumers, enabled
   EventBridge rule targets and Lambda log-subscription destinations. Each uses
   the official image for its runtime, digest-pinned in the profile. Handlers
   run under the embedded Runtime Interface Emulator; the transport invokes
   `/2015-03-31/functions/function/invocations`.
10. **Serve, invoke or session.** One loopback listener per API (and per
    Function URL) builds the provider event for the matched route, runs a
    CUSTOM request authorizer first when the route declares one, invokes the
    handler and decodes the response — including the RIE's buffered streaming
    frame. One gateway listener per servable CloudFront distribution serves the
    distribution's local URL: it selects the cache behavior, runs the generated
    CloudFront Functions, applies the edge policies and refuses an unwired
    origin with a named 503. `invoke` instead sends explicit events to one warm
    container. A session keeps every target warm, serves the same HTTP surface,
    and answers the JSON command protocol on stdin/stdout.
11. **Start event delivery.** The delivery engine registers every derived
    event-source mapping, EventBridge rule, CloudWatch Logs subscription filter
    and SNS subscription, starts one deliverer per source kind that has one, and
    records the others as `not-delivered` with the task that will implement
    them. SNS subscriptions are registered from `AWS::SNS::Subscription` and
    from the inline `Subscription` property of a topic; each attaches to its
    topic's hub, which polls the topic's moto drain queue and fans every publish
    out to the subscription's Lambda, SQS or HTTP target. The engine
    takes the run's clock and the delivery concurrency bound; see
    [Event delivery](#event-delivery) and
    [SNS subscription delivery](#sns-subscription-delivery).
12. **Shut down.** `Ctrl-C` (`SIGINT`) or `SIGTERM` drains and stops the
    delivery engine, then stops accepting requests by closing the listeners,
    force-removes the run's containers (which aborts an in-flight invocation),
    closes any connections still in flight, removes the network and deletes the
    scratch directory. A `SIGKILL` cannot be caught: after one,
    `apptheory-local down --app <dir>` removes the containers and networks
    labelled with that app; it does not delete the stale run scratch directory.
    That directory is `<scratch>/runs/<app>-<run>`, where `--scratch` defaults to
    `<user cache>/apptheory-local`; it is safe to delete by hand.

## moto-backed services: SSM, Secrets Manager, SNS, Kinesis, Cognito and KMS signing

The profile's pinned moto container (`motoserver/moto@sha256:59a1965d…`, 5.2.5)
provides these services. The runner creates each resource from the cloud
assembly before any function starts and injects the service endpoint:

| Service | Endpoint variable | Resources created |
| --- | --- | --- |
| SSM | `AWS_ENDPOINT_URL_SSM` | `AWS::SSM::Parameter`, `Type` `String`, `StringList` or `SecureString` |
| Secrets Manager | `AWS_ENDPOINT_URL_SECRETS_MANAGER` | `AWS::SecretsManager::Secret` with `SecretString` or `GenerateSecretString` |
| SNS | `AWS_ENDPOINT_URL_SNS` | `AWS::SNS::Topic` (standard and FIFO) |
| Kinesis | `AWS_ENDPOINT_URL_KINESIS` | `AWS::Kinesis::Stream` (provisioned or on-demand) |
| Cognito Identity Provider | `AWS_ENDPOINT_URL_COGNITO_IDP` (and the SDK's `AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER`) | `AWS::Cognito::UserPool` and `UserPoolClient` |
| KMS | `AWS_ENDPOINT_URL_KMS` | `AWS::KMS::Key` (symmetric, RSA or ECC) and `AWS::KMS::Alias` |

### Return values the templates resolve

The values follow the CloudFormation reference for each resource:

- **SSM** (`AWS::SSM::Parameter`): `Ref` is the parameter name; `Fn::GetAtt
  Type` and `Fn::GetAtt Value` are the declared type and value
  ([reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ssm-parameter.html)).
  A parameter name is provisioned with a leading `/`: a name without one is
  prefixed (AWS allows a bare name; CDK generates path names), and a name that
  is not a literal gets a deterministic local name.
- **Secrets Manager** (`AWS::SecretsManager::Secret`): `Ref` is the secret ARN
  ([reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html)).
  AWS appends a six-character suffix to the ARN; moto does the same, so the ARN
  is not byte-identical across runs even though the friendly name is. A runtime
  `GetSecretValue` reads the secret the runner created.
- **SNS** (`AWS::SNS::Topic`): `Ref` is the topic ARN; `Fn::GetAtt TopicName`
  and `TopicArn` are the name and ARN
  ([reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sns-topic.html)).
  `AWS::SNS::Subscription` and a topic's inline `Subscription` are registered
  with the delivery engine; the runner does not create application
  subscriptions in moto, because moto cannot reach the Runtime Interface
  Emulator or ElasticMQ and the engine performs the fan-out itself. The runner
  creates one drain queue per topic on moto's SQS and subscribes it without raw
  delivery, so the publish is observed in the documented envelope form; see
  [SNS subscription delivery](#sns-subscription-delivery).
- **Kinesis** (`AWS::Kinesis::Stream`): `Ref` is the stream name; `Fn::GetAtt
  Arn` is the stream ARN
  ([reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-kinesis-stream.html)).
  `StreamModeDetails` `PROVISIONED` uses `ShardCount`; `ON_DEMAND` sends the
  stream mode instead. `RetentionPeriodHours` is applied with
  `IncreaseStreamRetentionPeriod` or `DecreaseStreamRetentionPeriod`
  ([API](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_IncreaseStreamRetentionPeriod.html)).
- **Cognito user pool** (`AWS::Cognito::UserPool`): `Ref` is the pool id;
  `Fn::GetAtt Arn`, `ProviderName` and `ProviderURL` are the pool ARN and its
  provider values
  ([reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html)).
  `AWS::Cognito::UserPoolClient` Ref is the client id
  ([reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpoolclient.html)).
- **KMS** (`AWS::KMS::Alias`): `Ref` is the alias name, and the alias is usable
  as a `KeyId`
  ([reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-kms-alias.html),
  [alias use](https://docs.aws.amazon.com/kms/latest/developerguide/alias-using.html)).
  `KeySpec` RSA_2048/3072/4096 and ECC_NIST_P256/P384/P521 with
  `KeyUsage SIGN_VERIFY` support `Sign`, `Verify` and `GetPublicKey`; the wave-1
  symmetric path is unchanged.

### The local Cognito issuer

Moto serves a pool's JWKS only at the path-style
`/{poolId}/.well-known/jwks.json`. A Cognito token names its issuer as
`https://cognito-idp.{region}.amazonaws.com/{poolId}` (["Verifying a JSON Web
Token"](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html)).
The runner therefore starts a loopback issuer listener for every provisioned
pool and serves both documents at the ordinary OIDC paths:

```
http://127.0.0.1:<port>/cognito-idp/us-east-1/<poolId>/.well-known/jwks.json
http://127.0.0.1:<port>/cognito-idp/us-east-1/<poolId>/.well-known/openid-configuration
```

`jwks.json` proxies the pool's JWKS from moto. `openid-configuration` names the
local issuer and the local `jwks_uri`, so R2a can validate a token against a
normal issuer instead of special-casing moto's path. The issuer URL is recorded
on the pool resource in `session describe` (`localIssuer`); `plan` lists the
pool and its GetAtt values but cannot know the listener port. Tokens minted by
moto carry the AWS issuer string above; R2a maps that issuer to the local one.
An `AWS::Cognito::UserPoolDomain` is reported under `skipped`: the hosted UI and
OAuth domain are not served.

### GenerateSecretString

AWS does not publish its password-generation algorithm. The runner generates a
deterministic local value from the CDK definition and documents the difference:

- `PasswordLength` defaults to 32 and must be 1..4096.
- The character classes are uppercase, lowercase, numbers and the ASCII
  punctuation set, each omitted by its `Exclude*` flag; `ExcludeCharacters`
  removes individual characters and `IncludeSpace` adds a space.
- `RequireEachIncludedType` defaults to true and guarantees at least one
  character from each remaining class.
- The value is seeded from the stack and logical id, so the same definition
  always produces the same secret. Moto keeps only the current run's state
  (docs/125's memory-only limit); a restart re-provisions the same value.
- `SecretStringTemplate` must be a JSON object; the generated string is stored
  under `GenerateStringKey` and the resulting JSON is the secret string.

A deploy-time `{{resolve:secretsmanager:…}}` reference to a secret the run
provisioned resolves to that secret's value (the referenced JSON key), so the
deploy-time value and the runtime `GetSecretValue` value agree. With no
provisioned secret the wave-1 deterministic placeholder is kept unchanged.

### Observed moto deviations the runner normalizes

- **SNS subscriptions are not created in moto.** Moto cannot reach the Runtime
  Interface Emulator or ElasticMQ. The runner registers the application's
  subscriptions with the delivery engine and performs the fan-out itself. Moto
  is used for topics, the publish path and the runner's per-topic drain queue;
  the observed deviations and their normalization are listed under
  [SNS subscription delivery](#sns-subscription-delivery).
- **Cognito JWKS path.** Only `/{poolId}/.well-known/jwks.json` is served; the
  runner's issuer listener is the path R2a uses.
- **Kinesis on-demand describe.** Moto omits `StreamModeDetails` from
  `DescribeStream`; the runner records the requested mode and does not read it
  back. `DescribeStream` still reports the ARN, shards and retention.
- **SecureString.** Moto accepts `SecureString`, reports `KeyId
  alias/aws/ssm`, returns a `kms:alias/aws/ssm:<value>` marker without
  `WithDecryption` and the plaintext with it. It does not perform envelope
  encryption; the value lives only in moto's memory and is never written to a
  file or a log.
- **Secret ARN suffix.** moto appends a random six-character suffix as AWS
  does; the friendly name and the dynamic-reference resolution are stable.
- **SNS FIFO.** The pinned moto accepts `FifoTopic` and
  `ContentBasedDeduplication` and reports both from `GetTopicAttributes`; the
  FIFO ordering and deduplication rules are the runner's, not moto's. A
  content-based publish is delivered to a FIFO drain queue whose own
  deduplication id is the envelope hash; the runner converts it to the
  documented message-body hash.
- **SNS message attributes and `x-amz-sns-*` headers.** The runner observes
  publishes through a moto-SQS drain queue and emits the documented SNS
  record/HTTP shapes itself; the envelope encoding, the `UnsubscribeURL`
  placeholder and the FIFO ids are documented under
  [SNS subscription delivery](#sns-subscription-delivery).

## WebSocket APIs

An `AWS::ApiGatewayV2::Api` with `ProtocolType: WEBSOCKET` is served as a real
WebSocket listener on its own loopback URL. The listener speaks RFC 6455: the
handshake, masked client frames, fragmented messages, ping/pong and the close
handshake. Its URL is `ws://127.0.0.1:<port>/<stage>`.

**Routes.** `plan` prints the API's route table: `$connect`, `$disconnect`,
`$default` and every custom route key the template declares. A text message is
routed by the API's `RouteSelectionExpression` (default
`$request.body.action`): the expression's field is read from the JSON body and
matched against the route keys. The runner implements the single-field
`$request.body.<field>` form and its wrapped `${request.body.<field>}`
equivalent; every other documented form — multiple variables such as
`${request.body.service}/${request.body.action}`, a static value such as
`action`, or a nested path such as `$request.body.data.room` — is refused at
plan time with the expression named, because serving it as `$default` would
silently leave every custom route unmatched. A message that is not JSON, has no
such field, or selects no declared route goes to `$default`; an API with no
`$default` route drops it. `$connect` and `$disconnect` are one-way; `$default`
and custom routes are two-way, so a 2xx integration response body is sent back
to the client.

**The event.** Each invocation receives the documented WebSocket proxy event:
`requestContext.routeKey`, `eventType` (`CONNECT`/`DISCONNECT`/`MESSAGE`),
`messageId` (messages), `connectionId`, `connectedAt`, `requestId`,
`extendedRequestId`, `requestTime`, `requestTimeEpoch`, `messageDirection`,
`identity.sourceIp`/`identity.userAgent`, `stage`, `domainName` and `apiId`,
plus `body` and `isBase64Encoded`. A `$disconnect` event also carries
`requestContext.disconnectReason`: `CLIENT_INITIATED_DISCONNECT` when the client
closed, `INTERNAL_ERROR` when the server closed the connection.

**The `$connect` authorizer.** A `REQUEST` Lambda authorizer on `$connect` runs
during the handshake, before the `$connect` integration. It receives the
documented authorizer event (`type: "REQUEST"`, `methodArn` ending in
`/<stage>/$connect`, headers, multi-value headers, query parameters and
`requestContext`) and returns an IAM policy. The runner applies the narrow
Allow/Deny match docs/125 permits: each statement's `Action` must be
`execute-api:Invoke` (or `*`) and its `Resource` must match the `$connect`
method ARN with IAM-style `*`/`?` wildcards; an explicit Deny wins, and no
matching Allow refuses the connection with 401. This is an authorizer-policy
match, never IAM evaluation, which stays a docs/125 true limit. A request that
does not carry every configured identity source is refused before the authorizer
runs. Only `$connect` can be authorized on a WebSocket API; an authorizer on
another WebSocket route fails closed at plan time. REST and HTTP API Lambda
authorizers that return a policy are served on their own APIs; see
[Authorizers](#authorizers).

**The `@connections` management API.** The runner serves
`PostToConnection`, `GetConnection` and `DeleteConnection` on a TLS listener
(`POST`/`GET`/`DELETE /{connectionId}`) that binds every interface
(`0.0.0.0:0`) so a function container reaches it through `host.docker.internal`;
the session reports the loopback URL (`https://127.0.0.1:<port>`) and the
harness uses that, while the container-facing URL is
`https://host.docker.internal:<port>`. The listener is unauthenticated and
reachable from any interface on the host while a session runs. The endpoint is
injected into every function as the API Gateway Management API endpoint override
(`AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI`), and the event's
`requestContext.domainName` is the container-facing host of that listener, so a
handler that builds the client from the request context reaches it unchanged.
The listener uses a self-signed certificate generated per run; its PEM is
mounted at `/etc/apptheory-local/ca.pem` and exported as `AWS_CA_BUNDLE`,
`NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` for the Go, Node and Python SDKs. A
closed or unknown connection answers the documented `410 {"message":"Gone"}`.
`session describe` reports the loopback `managementEndpoint`, the CA path and
the live connection count.

**Lifecycle.** API Gateway closes an idle connection after 10 minutes and a
connection at the 2-hour maximum lifetime, with close code 1001; the runner
takes both from the run clock, so `--clock test` plus `clock.advance` closes
them deterministically. A binary frame is refused with 1003 (API Gateway does
not support binary media types), and a frame over 32 KB or a message over
128 KB is refused with 1009. When the runner closes a connection it invokes
`$disconnect` with `INTERNAL_ERROR`; a client close invokes it with
`CLIENT_INITIATED_DISCONNECT`.

Custom domains, IAM authorization and a REST-style Lambda authorizer on a
WebSocket route are not served; they fail closed.

## Authorizers

The transport runs the authorizer a route declares before the integration. It
never bypasses one: a kind it cannot run refuses the route at plan time with the
kind named.

**HTTP API JWT authorizers.** An `AWS::ApiGatewayV2::Authorizer` with
`AuthorizerType: JWT` validates the token from its identity source (default
`$request.header.Authorization`, `Bearer` scheme) as
[Controlling access to HTTP APIs with JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
describes. Only RSA-based algorithms are supported: the header's `alg` must be
`RS256`, `RS384` or `RS512`; `none`, `HS*` and the ECDSA algorithms are refused.
The signature is verified against the issuer's `/.well-known/jwks.json` with the
key the header's `kid` names — a token without `kid`, or whose `kid` matches no
key after one refresh, is refused. The checked claims are `iss` (must match the
configured issuer), `aud` (or `client_id` only when `aud` is absent; `aud` wins
when both are present), `exp`, `nbf` and `iat` (all compared with the run
clock), and `scope`/`scp`: a route's `AuthorizationScopes` is an any-of match, so
at least one of the route's scopes must be present in the token. The validated
claims and scopes reach the integration as
`requestContext.authorizer.jwt.claims` and `requestContext.authorizer.jwt.scopes`.
A missing or malformed token, a bad signature, a wrong issuer or audience, an
unknown `kid` and a non-RSA algorithm are 401; a token carrying none of the
route's scopes is 403.

The issuer can be a literal OIDC URL or a CloudFormation expression that names a
provisioned Cognito pool. For a pool the runner serves the issuer at
`http://127.0.0.1:<port>/cognito-idp/<region>/<poolId>`; the template's canonical
issuer (`https://cognito-idp.<region>.amazonaws.com/<poolId>`) is accepted too,
because that is the `iss` a real pool's tokens carry. An issuer the run cannot
resolve to a provisioned pool fails closed.

**REST API Cognito user-pool authorizers.** An `AWS::ApiGateway::Authorizer`
with `Type: COGNITO_USER_POOLS` validates the token in its identity-source
header against the named pool's JWKS, as
[Using Amazon Cognito user pools as authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html)
describes, with the same claim and algorithm checks as the HTTP API JWT
authorizer: RSA-based algorithms only, a `kid` that names the signing key,
`iss`, `aud` (with `client_id` only when `aud` is absent), `exp`, `nbf` and
`iat`. A route's `AuthorizationScopes` is the any-of match the REST method API
documents — the invocation is authorized if any method scope matches a claimed
scope — so at least one of the route's scopes must be present in the access
token's `scope`/`scp`
([PutMethod](https://docs.aws.amazon.com/apigateway/latest/api/API_PutMethod.html)).
The claims reach the integration as `requestContext.authorizer.claims`. A
missing or invalid token is 401; a token carrying none of the route's scopes is
403.

**The run clock.** `exp`, `nbf` and `iat` are compared with the run clock, so
`--clock test` changes what "expired", "not yet valid" and "issued in the
future" mean. A token minted by the moto pool uses wall-clock times; start a
test clock a few minutes ahead of wall time so a token minted after the session
starts has `iat` before the run clock (the `lambda-role-authorizers` row starts
ten minutes ahead), and `clock.advance` past its expiry to prove the check. A
test clock that starts before the token's `iat` refuses it, which is the
documented behaviour.

**REST API Lambda authorizers (TOKEN and REQUEST).** An
`AWS::ApiGateway::Authorizer` with `Type: TOKEN` or `Type: REQUEST` runs through
the real function path before the method's integration, as
[Use API Gateway Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html)
describes:

- A **TOKEN** authorizer receives `{"type":"TOKEN","authorizationToken":<value>,
  "methodArn":<arn>}`; the token comes from the single
  `method.request.header.<name>` identity source. With caching enabled, the
  token value is the cache key. `IdentityValidationExpression` is applied to the
  token before the authorizer runs, and a non-match is 401 (TOKEN authorizers
  only; the property on a REQUEST authorizer is refused at plan time).
- A **REQUEST** authorizer receives the documented request event (`type`,
  `methodArn`, `resource`, `path`, `httpMethod`, `headers`,
  `multiValueHeaders`, `queryStringParameters`,
  `multiValueQueryStringParameters`, `pathParameters`, `stageVariables`,
  `requestContext`, `body`, `isBase64Encoded`). Its identity sources are the
  comma-separated `method.request.header.*`, `method.request.querystring.*` and
  `method.request.path.*` expressions in configured order; with caching enabled
  every value is part of the cache key, in that order.
- With caching on, a missing, null or empty identity source is refused with 401
  **without invoking the authorizer**. `AuthorizerResultTtlInSeconds` is applied
  on the run clock (CloudFormation's default is 300; `0` disables the cache), so
  `--clock test` plus `clock.advance` expires a cached decision.
- The returned policy is matched against the request's method ARN with the same
  narrow Allow/Deny match the `$connect` authorizer uses. An Allow invokes the
  method, a Deny is **403** outside the API Gateway test environment, the
  authorizer's documented `{"errorMessage":"Unauthorized"}` response is **401**
  and any other response shape is **500**.
- `context` values reach a proxy integration as
  `requestContext.authorizer.<key>` (also usable as `$context.authorizer.<key>`
  in mapping templates) with the documented stringified scalars; a nested object
  in the context is refused with 500 because API Gateway accepts strings only.

**HTTP API Lambda authorizers that return an IAM policy.** An
`AWS::ApiGatewayV2::Authorizer` with `AuthorizerType: REQUEST` and
`EnableSimpleResponses: false` (the default) runs with
`AuthorizerPayloadFormatVersion` `1.0` or `2.0`, as
[Control access to HTTP APIs with Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html)
describes. Payload format 1.0 receives the REST-shaped event with `methodArn`;
2.0 receives the HTTP API v2 event with `routeArn`, `routeKey` and
`identitySource`. Either way the returned policy is matched against the route
ARN, the identity sources are the cache key when
`AuthorizerResultTtlInSeconds` is set, and `$context.routeKey` can be listed to
cache per route. A missing identity source is 401, an invalid response is 500
and the documented `{"errorMessage":"Unauthorized"}` response is 401. The
authorizer context reaches the integration as `requestContext.authorizer`.

**Still refused.** IAM authorization (`AuthorizationType: AWS_IAM`), other
`$context`/`$stageVariables` identity sources, and any authorizer kind the
runner does not name above fail closed at plan time with the kind named.

## CloudFront distributions

A distribution in the cloud assembly is served on its own `http://127.0.0.1:<port>`
URL, printed on the `serving cloudfront …` line. The local gateway is the
delivery path a FaceTheory or AppTheory site is tested through; it is **not a
CloudFront emulator: no caching, no edge network, no TLS**.

### What is read

The gateway reads `AWS::CloudFront::Distribution` `DistributionConfig` from the
same assembly the Lambda surface comes from: origins and origin groups, the
default cache behavior and every cache behavior in listed order, and the
`AWS::CloudFront::Function` associations. It resolves the referenced
`AWS::CloudFront::CachePolicy`, `AWS::CloudFront::OriginRequestPolicy`,
`AWS::CloudFront::ResponseHeadersPolicy` and `AWS::CloudFront::OriginAccessControl`
resources. There is no second hand-written routing definition.

A behavior is selected by the **original** viewer URI: cache behaviors in the
order the template lists them, using CloudFront's path-pattern rules (an
optional leading slash, case-sensitive matching, `*` for any run of characters
and `?` for exactly one character), then the default behavior. A viewer-request
function that rewrites the URI does not change the behavior the request uses,
as CloudFront documents.

### Request phases

1. The **viewer-request function**, when the selected cache behavior has one,
   runs before any origin dispatch. If it returns a response, that response is
   sent to the viewer and the origin is not called.
2. `AllowedMethods` is enforced on the (unchanged) request method; a method the
   behavior does not allow is a 403, the status CloudFront documents for an
   invalid method. CloudFront does not document the relative order of the
   [viewer-request trigger](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html)
   and the [403 invalid-method response](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/http-403-invalid-method.html).
   The local gateway runs the viewer-request function first by choice: a
   function can answer a request whose method the behavior does not allow (a
   CORS preflight or an authentication rejection) instead of being pre-empted by
   the local 403.
3. `DefaultRootObject` replaces a request for `/` with the declared object.
4. The cache policy and the **origin request policy** decide which headers,
   cookies and query strings reach the origin. Managed policies are pinned by
   ID; `AllViewer` forwards the viewer Host, `AllViewerExceptHostHeader` sets the
   Host to the origin domain, and `AllViewerAndCloudFrontHeaders-2022-06` also
   receives the locally derivable CloudFront headers. The **origin receives**
   the policy-filtered request plus the origin path; the selected behavior's
   target origin is then called.
5. The **viewer-response function**, when the behavior has one, runs on the
   origin's response and may change its status, headers, cookies or body. It
   never sees the origin body.
6. The **response headers policy** is applied last: remove headers, CORS,
   security headers and custom headers, with each entry's override flag.

### CloudFront Functions

The executor runs the **exact `FunctionCode` string** from the template, never a
re-implementation. Each invocation gets a fresh Node `vm` context with the
documented version 1.0 event: `context` (`distributionDomainName`,
`distributionId`, `eventType`, `requestId`), `viewer.ip`, `request` (`method`,
`uri`, `querystring`, lower-cased `headers`, `cookies`) and, for
viewer-response, `response`. `distributionId` is a local placeholder derived
from the distribution's logical id; `distributionDomainName` is the loopback
host the viewer used.

`cloudfront-js-2.0` functions get `crypto`, `querystring`, `Buffer`,
`TextEncoder`, `TextDecoder` and the `cloudfront` module. `cloudfront-js-1.0`
functions get `crypto` and `querystring` and are rejected if they use `const`,
`let`, `async` or `await`. Both runtimes are strict, have a fixed `Date` for the
whole invocation, and have no network, file system, `process`, timers, `eval` or
`Function` constructor. `require` accepts only the documented modules.

A thrown error, a rejected return shape, a changed `request.method`, a
`Set-Cookie` header in a viewer-request, a Promise return or a base64 body that
does not decode is a **503-class failure**: the gateway logs the function and
the reason and never passes the request through. `console.log` accepts one
string, as CloudFront documents.

### Edge policies

The origin request policy is applied to the viewer request; the response headers
policy is applied after the viewer-response function. The four conditional
request headers (`If-Match`, `If-None-Match`, `If-Modified-Since` and
`If-Unmodified-Since`) are always forwarded to the origin for it to evaluate,
as CloudFront forwards them, so a policy that does not list them does not drop
them. Caching is not emulated: every request is forwarded to the origin as a
cache miss, and a cache policy is used only for the values it contributes to the
origin request. The
`ViewerProtocolPolicy` is reported, not enforced, because the local URL is plain
HTTP; the same is true for compression, access logging, aliases, the viewer
certificate and the distribution's HTTP/IPv6/price-class settings.

The pinned managed policy table and the exact property inventory are in the
[configuration reference](/reference/local-runner-configuration/#cloudfront-distributions).

### Origins

The gateway builds one origin implementation per servable distribution from the
same assembly:

- **S3.** The origin reaches the bucket `provisionBuckets` created and the
  objects `provisionDeployments` copied from every `Custom::CDKBucketDeployment`
  source (the assembly's asset directories and zips, with the deployment's
  destination prefix and declared content-type/cache-control metadata; the
  content-type is inferred from the extension otherwise). GET and HEAD pass
  `Content-Type`, `ETag`, `Last-Modified`, `Content-Length`, `Cache-Control`,
  `Content-Range` and user metadata through. A ranged GET returns 206. A HEAD
  with a single satisfiable byte `Range` returns 206 with
  `Content-Range: bytes <first>-<last>/<total>`, the ranged `Content-Length`
  and no body: AWS documents HeadObject as the GetObject response without a
  body and a satisfiable GetObject range as 206
  ([HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html),
  [GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)).
  The pinned s3proxy backend ignores `Range` on HEAD (it answers 200 with the
  full length and no `Content-Range`), so the local origin requests the full
  metadata and derives the ranged answer from it. An unsatisfiable single range
  on a HEAD is 416 with `Content-Range: bytes */<total>`, as HeadObject
  documents, while a ranged GET's 416 comes from the backend and carries no
  `Content-Range`; a multi-range or unparseable `Range` is ignored and the full
  object is returned, because S3 does not support multiple ranges per request
  and RFC 9110 permits ignoring a `Range`
  ([RFC 9110 §14.2](https://www.rfc-editor.org/rfc/rfc9110#section-14.2)).
  CloudFront forwards `If-Match`, `If-None-Match`, `If-Modified-Since` and
  `If-Unmodified-Since` to the origin, and the origin evaluates them
  ([request headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html),
  [S3 conditional GET](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorS3Origin.html)).
  The local gateway forwards those four headers even when the behavior's origin
  request policy does not list them, so a conditional GET or HEAD passes S3's
  304 Not Modified (or 412 Precondition Failed for
  `If-Match`/`If-Unmodified-Since`) through with the validators the origin
  attached and no body; the local response carries exactly what the origin
  supplied. The pinned s3proxy attaches `ETag` to a `GET` 304 and to the 412 of
  either method, attaches no validator to a `HEAD` 304, and attaches
  `Last-Modified` to none of them. OPTIONS follows S3's CORS
  behavior: a bucket with no CORS configuration returns 403 `AccessForbidden`,
  and a bucket that declares CORS rules is refused with a named local gap
  because bucket CORS is not provisioned. An OAC/OAI origin has no
  `s3:ListBucket`, so a missing object is **403 `AccessDenied`**; a public S3
  origin returns 404 `NoSuchKey`. A method other than GET/HEAD/OPTIONS is a
  named error.
- **Function URL.** The origin builds the Lambda Function URL payload format
  2.0 event from the origin request (method, origin path, raw path, query,
  cookies, headers, viewer IP and request id), invokes the real function through
  the same runtime container `run` starts, and maps `statusCode`, `headers`,
  `cookies`, `isBase64Encoded` and `body` back. A `RESPONSE_STREAM` function is
  **buffered by the RIE**: the body is complete and its chunk timing is never
  reproduced. A `NONE` URL is invoked directly. An `AWS_IAM` URL is signed with
  SigV4 over the method, path, query, Host, body hash and date; the gateway's
  in-process verifier checks that locally signed request before it invokes the
  handler, and the event reports `requestContext.authorizer.iam` with a loopback
  identity. IAM policy evaluation is not emulated.
- **Origin group.** GET and HEAD always fail over. OPTIONS fails over only when
  the behavior's `CachedMethods` includes OPTIONS; otherwise CloudFront tries the
  primary only
  ([origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)).
  CloudFront retries the secondary member when the primary returns a status in
  `FailoverCriteria`, when it fails to connect and 503 is configured, or when it
  times out and 504 is configured; each attempt uses that member's `OriginPath`
  and Host. Other methods go to the primary only. If both members fail, the
  secondary's response is returned.
- **Other origins.** A literal external custom origin is refused with a named
  503; the gateway never makes an external network request.

The `ssr-site`, `ssr-only-provided-assets-site`, `path-routed-frontend` and
`media-cdn` example rows run through these origins in the harness; the private
media distribution stays refused with the named signed-URL reason.

Distributions that use Lambda@Edge, a CloudFront KeyValueStore association,
trusted key groups or signed URLs, field-level encryption, geo restriction, a
WAF web ACL, custom error responses, a gRPC config or a legacy `ForwardedValues`
cache policy are refused with a named reason; they are listed under `skipped`
and no listener is started. Real-time logs, access logging and the properties
that only affect caching or edge placement are reported instead.

## Invoking one function

`plan` and `run` are about HTTP surfaces. `invoke` starts one function and
sends it events, which is how the harness exercises event-source handlers and
handler-only examples. It prepares the run in the same order as `run` — images,
scratch, network, backends, provisioning, environment resolution and preflight
— before it starts only the requested function:

```bash
# One CDK function with one event.
apptheory-local invoke --app examples/cdk/lesser-parity \
  --function WorkerFn847949AF --profile scripts/local/examples-local.json \
  --event sqs-event.json

# A warm container driven over stdin: one JSON event per line in, one JSON
# result per line out. The container keeps its in-memory state across requests.
apptheory-local invoke --handler-dir ~/.cache/mcp-tools-only \
  --runtime provided.al2023 --handler bootstrap \
  --profile scripts/local/examples-local.json --stdio
```

The result is one JSON object per event:

```json
{"proxy":true,"statusCode":200,"headers":{"content-type":["application/json"]},"body":"{\"ok\":true}"}
```

`proxy` is `true` when the handler returned a Lambda proxy response. Otherwise
`raw` carries the handler's JSON result unchanged, and `handlerError` names a
handler that crashed. `--handler-dir` mode derives no routes: it starts the
built handler and the caller supplies every event. It exists because the Go MCP
examples ship a handler but no CDK definition. A handler-only row is never
described as CDK-routed.

Streaming over a warm container is still buffered by the RIE: a tool call's
complete SSE body arrives after the handler finishes, and `streamed` marks the
framed response. The MCP rows assert session creation, event ids and
Last-Event-ID replay content; they never claim incremental delivery.

## Automation sessions

`session` is the machine interface behind `make examples-local`. It prepares the
same environment as `run`, starts every function the CDK definition targets
(HTTP routes, Function URLs, authorizers, event-source consumers and
EventBridge rule targets), serves the HTTP listeners, prints `local-run: ready`
on stderr, and then reads one JSON command per line on stdin. Every command
writes one JSON response per line on stdout: `{"ok":true,"result":…}` or
`{"ok":false,"error":"…"}`. Progress stays on stderr. The protocol is how the
harness receives real messages, writes real items, and builds the event an
event-source mapping would deliver; it is not a second routing definition.

```bash
apptheory-local session --app examples/cdk/sqs-queue \
  --profile scripts/local/examples-local.json --backend sqs \
  --target ProducerFn29855005
{"op":"describe"}
{"op":"invoke","function":"ProducerFn29855005","event":{…}}
{"op":"sqs.receive","queue":"ContractQueue3874DDBD","max":1,"waitSeconds":2}
```

`--target <logical-id>` starts one additional CDK function that no route, event
source or rule targets. It is how the harness runs a producer that the CDK
defines but a deployment caller invokes.

The operations, in the order the examples use them:

- `describe` — the started functions (with resolved environment and RIE port),
  HTTP listener URLs, event-source mappings, EventBridge rules, subscriptions,
  provisioned resources (name, URL, ARN, stream ARN), local secrets and the live
  delivery-engine state.
- `clock.now` — the run's clock mode and current instant.
- `clock.advance` — move a test clock forward by a Go duration; the real clock
  refuses.
- `invoke` — send one Lambda event to a started function and return the same
  decoded result as `invoke`.
- `sqs.send` — send one body to a provisioned ElasticMQ queue through the
  runner's host-side SQS client. `messageGroupId` and `messageDeduplicationId`
  are passed through for a FIFO queue.
- `sqs.receive` — receive up to `max` messages with the requested wait and
  visibility, optionally deleting them after receipt. Each message carries its
  SQS system attributes under `attributes` and its message attributes under
  `messageAttributes`; the latter is how an SNS raw delivery's published
  attributes are observed.
- `sqs.event` — receive messages and build the `Records` event the SQS mapping
  delivers, from the messages actually returned by ElasticMQ.
- `sqs.attributes` — read a queue's counts and attributes: `visible`,
  `notVisible`, `delayed` and the raw `attributes` map. The pinned ElasticMQ
  answers a named attribute subset with an empty map, so the operation asks for
  `All`.
- `ddb.put` — write one JSON item to a provisioned table; the previous image is
  cached for a later stream record.
- `ddb.get` — read one item by its key.
- `ddb.scan` — read every item in a provisioned table.
- `ddb.stream-event` — build a DynamoDB stream record from the stored image (and
  the previous image when one is cached), using the table's stream ARN, view
  type and the real key schema.
- `s3.put` — write one object to a provisioned s3proxy bucket.
- `eventbridge.event` — build the event an `AWS::Events::Rule` delivers,
  deriving a scheduled envelope from `ScheduleExpression` or the source and
  detail-type from the rule's declared `EventPattern`.
- `kinesis.event` — build a Kinesis event from explicit base64 record data.
- `kinesis.cloudwatch-event` — gzip a CloudWatch Logs subscription payload from
  local log events and wrap it in the Kinesis record AWS delivers.
- `shutdown` — stop the session and run the normal cleanup.

The `ddb.*` and `sqs.*` operations use the loopback endpoints the runner
published; function containers use the run-network aliases. Neither can reach a
real AWS endpoint. `describe` is the only operation that returns local secrets
or resolved environment values; `run`, `plan` and `invoke` never print them.

## Event delivery

`run` and `session` start a delivery engine. Every event-source mapping,
EventBridge rule, CloudWatch Logs subscription filter and SNS subscription the
assembly derives is registered with it before the run reports ready. The engine
owns:

- the registry of deliverers, one per source kind;
- the lifecycle: start, drain and stop on `Ctrl-C`/`SIGTERM` or the `shutdown`
  session command;
- a bounded concurrency for the handler invocations it performs;
- the per-source delivery state that `plan` and `session describe` report.

An SQS mapping has a deliverer: it polls ElasticMQ, invokes the function and
deletes or leaves each message exactly as Lambda documents. A DynamoDB Streams
mapping reads the table's stream on DynamoDB Local and invokes the function with
the documented records. An EventBridge schedule fires on the run clock and a
pattern rule receives every matching `PutEvents` call on the runner's own bus,
including the S3 events the runner publishes itself. A Kinesis mapping polls
moto's stream, and a CloudWatch Logs subscription filter delivers the log events
written through the real Logs API. An SNS subscription has a deliverer: the
runner observes every publish on moto and performs the fan-out to the
subscription's target. A bucket notification configuration has a deliverer: the
runner watches the real bucket and delivers the documented record to its Lambda,
SQS and SNS destinations, and publishes the `aws.s3` EventBridge event for a
bucket that enables EventBridge notifications. A kind without a deliverer is
registered and reported as `not-delivered` with the task that will implement it.
Nothing is silent: `plan` prints the state next to every derived source, and a
session reports the same source list live.

| Source kind | Local delivery |
| --- | --- |
| SQS event source mapping | Delivered (E1b); see [SQS event-source delivery](#sqs-event-source-delivery) |
| DynamoDB Streams event source mapping | Delivered (E2); see [DynamoDB Streams delivery](#dynamodb-streams-delivery) |
| SNS subscription | Delivered (E6); see [SNS subscription delivery](#sns-subscription-delivery) |
| S3 bucket notification | Delivered (E4); see [S3 event notification delivery](#s3-event-notification-delivery) |
| EventBridge schedule and pattern rule | Delivered (E3); see [EventBridge delivery](#eventbridge-delivery) |
| CloudWatch Logs subscription filter | Delivered (E5); see [CloudWatch Logs subscription delivery](#cloudwatch-logs-subscription-delivery) |
| Kinesis event source mapping | Delivered (E5); see [Kinesis event-source delivery](#kinesis-event-source-delivery) |

### SQS event-source delivery

The SQS deliverer reproduces the documented Lambda poller for an SQS event
source mapping. The rules are those in
[Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html),
[Creating and configuring an Amazon SQS event source mapping](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html),
[Handling errors for an SQS event source](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html),
[EventSourceMappingConfiguration](https://docs.aws.amazon.com/lambda/latest/dg/API_EventSourceMappingConfiguration.html)
and [Lambda event filtering](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html).

**Batching.** `BatchSize` defaults to 10. With no batch window (the default, and
the only form FIFO supports), one receive call closes the batch: the function is
invoked with whatever that receive returned, up to `BatchSize`, without waiting
for more messages. With a batch window (`MaximumBatchingWindowInSeconds`, 0–300
seconds), the batch is closed when the run clock reaches the window or the batch
reaches `BatchSize`; the deliverer keeps receiving within the window while
messages are available and stops waiting when the window closes. A standard
queue may declare a batch size above 10 only with a window of at least one
second. A FIFO queue's maximum batch size is 10 and AWS does not support a batch
window on FIFO queues; a mapping that violates either rule is refused at plan
time with the mapping named, rather than being passed to ElasticMQ.

**Visibility.** Messages are received with the queue's own visibility timeout.
The deliverer never lengthens a visibility timeout while a batch is in flight.
A batch that has not been deleted when the run clock reaches the timeout is
AWS's redelivery case: the deliverer makes those messages visible again with
`ChangeMessageVisibility(0)` and they can be received again. A successful
invocation deletes every record; a failed invocation deletes none, so the
messages return after the visibility timeout.

**Partial batch failure.** With `ReportBatchItemFailures`, only the records
named in `batchItemFailures` stay in the queue. An empty list, a null list, an
empty response and a null response are complete success. Invalid JSON, a bad
key name, an empty or null `itemIdentifier`, and an identifier that is not in
the batch are complete failure, as AWS documents. The `left` counter in
`session describe` records how many records the deliverer left for redelivery.

**FIFO ordering.** One batch is in flight per message group. A failed record
and every later record of the same message group stay in the queue, even when
the handler reports only the first one, so a later record cannot overtake its
failure. ElasticMQ enforces the per-group receive order;
`MessageGroupId`, `MessageDeduplicationId` and `SequenceNumber` are passed
through on the record's `attributes`. A FIFO mapping runs one receive loop
locally, so one batch per queue is in flight and message groups are not
processed in parallel; AWS preserves per-group order while processing different
groups concurrently.

**Redrive.** The queue's redrive policy is read from ElasticMQ. When a message
has been received `maxReceiveCount` times, the next receive attempt moves it to
the dead-letter queue. The DLQ's own mapping then delivers it normally; the
deliverer never deletes a message it did not successfully process.

**Filter criteria.** `FilterCriteria` is evaluated with Amazon EventBridge
event-pattern syntax against the record's metadata fields and its parsed
`body`. Multiple filters are ORed. A message that matches no filter is deleted
from the queue without invoking the function, as Lambda does.

The pattern is validated when the mapping is derived, as AWS validates it when
the event source mapping is created, so a malformed pattern fails at plan time
with the mapping, the filter index and the offending key and value named
instead of silently matching nothing. The accepted set is the documented
EventBridge grammar: a pattern-object key is always a field name, so a field
named `numeric`, `prefix` or `exists` is matched as ordinary data, and an
operator is read only from an object inside a rule list; a field holds a
non-empty list of rules or a nested pattern object, and a rule is a scalar or
one single-key operator object. The operators are `prefix`, `suffix` and
`equals-ignore-case` with a string value; `numeric` with `=`, `<` or `<=` and
one number, or `>`/`>=` and one number or a second `<`/`<=` bound; `exists`
with `true` or `false`; and `anything-but` with a string, a number, a non-empty
all-string or all-number list, or a `prefix`/`suffix` object whose value is a
string or a non-empty list of strings. `$or` takes a non-empty list of objects.
Empty lists, unknown operators (including `wildcard` and `cidr`, which Lambda
event filtering does not document), a scalar where a list is required,
`anything-but` with `equals-ignore-case`, and a pattern longer than the
documented 4096-character maximum are refused at plan time.

`exists` works only on leaf nodes, as AWS documents:
`{"body":{"address":[{"exists":true}]}}` does not match when `address` is an
object with children, even though the field is present. When a field's value is
an array, the pattern matches if the intersection of the pattern array and the
event array is non-empty, as AWS documents:
https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-arrays.html.
A nested pattern object applied to an array of objects is applied to each
element and matches when any element matches, and a pattern never matches
across elements, as AWS's event-ruler documents in
[JSON Array Matching](https://github.com/aws/event-ruler#json-array-matching).

**Maximum concurrency.** `ScalingConfig.MaximumConcurrency` (2–1000) bounds the
number of batches the mapping starts concurrently, within
`--delivery-concurrency`. `session describe` reports the current `inflight`
batch count and its observed `peakInflight`, which is how the local rows prove
the bound. The runner starts one container per function, so invocations to the
same function serialize at the container even when two batches are in flight;
that is the documented local one-container limit, not an AWS semantic.

#### What the test clock controls

`--clock test` governs the deliverer's batching window and its visibility
deadlines. When the clock reaches a message's visibility deadline, the
deliverer calls `ChangeMessageVisibility(0)` so the redelivery happens at that
deterministic instant. The clock does **not** slow or replace ElasticMQ's own
wall-clock timers: ElasticMQ's visibility sweep, `ReceiveMessage`
`WaitTimeSeconds` long polling, handler execution time inside the runtime
image, and container startup all remain real-time. A test that advances the
clock therefore redelivers immediately; a test that leaves a queue's
visibility timeout shorter than its wall-clock runtime can still see
ElasticMQ return a message early. The local rows use five-minute queue
timeouts and advance the clock explicitly, so wall-clock expiry does not race
them.

#### ElasticMQ behaviour the deliverer normalizes

Observed against `softwaremill/elasticmq-native@sha256:e4580ab9` (ElasticMQ
1.7.1):

| Observed ElasticMQ behaviour | How the runner implements AWS's behaviour |
| --- | --- |
| `CreateQueue`/`GetQueueUrl` answer with `http://localhost:9324/...` | The queue URL is rewritten to the published loopback endpoint (and to the run-network alias inside function containers). |
| Queue ARNs use region `elasticmq` and account `000000000000` | The record's `eventSourceARN` is the CDK-resolved local ARN, so a handler comparing it with `Ref`/`Fn::GetAtt` sees the same value. |
| A named `GetQueueAttributes` subset returns an empty map | The deliverer asks for `All`, the request ElasticMQ answers. |
| FIFO `SequenceNumber` values are small decimals starting at `"0"` | The value is passed through as an opaque string, as AWS's attribute is documented to be. |
| A receipt handle rotates on every receive; the previous handle is rejected | The deliverer deletes with the handle of that receipt and forgets it on success; it never deletes with a stale handle. |
| Redrive happens when the next receive would exceed `maxReceiveCount`; the DLQ copy carries `DeadLetterQueueSourceArn` and a higher `ApproximateReceiveCount` | The deliverer reads the queue's redrive policy and treats a receive that ElasticMQ redrives as a message that is no longer in the source queue. |
| A FIFO group is blocked while an earlier message of the group is in flight | Per-group ordering is preserved; the deliverer additionally protects every later record of a failed group within a batch. |

### DynamoDB Streams delivery

The DynamoDB Streams deliverer reads the table's stream on DynamoDB Local and
invokes the mapping's function with the documented record. The rules are those
in [Using AWS Lambda with Amazon DynamoDB](https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html),
[Configuring partial batch response with DynamoDB and Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-batchfailurereporting.html),
[Lambda event filtering](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html)
and [DynamoDB Streams and Time to Live](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/time-to-live-ttl-streams.html).

**Polling and batching.** The deliverer describes the stream, takes a shard
iterator per shard and reads records with `GetRecords`. `BatchSize` defaults to
100. A positive `MaximumBatchingWindowInSeconds` (0–300) closes the batch when
the run clock reaches the window or the batch is full; with the default window
of zero a single read closes the batch. A closed batch is invoked once; the
handler receives `{"Records":[...]}` with the documented `eventID`, `eventName`,
`eventVersion`, `eventSourceARN`, `awsRegion` and `dynamodb` fields (`Keys`,
`NewImage`, `OldImage`, `SequenceNumber`, `SizeBytes`, `StreamViewType`, and
`ApproximateCreationDateTime` as epoch seconds). A record that matches no
`FilterCriteria` is dropped and the iterator advances past it; Lambda does not
invoke the function for it.

**Starting positions.** `StartingPosition` is `TRIM_HORIZON` or `LATEST`.
`AT_TIMESTAMP` is a Kinesis starting position; DynamoDB Streams returns an
internal failure for it on the pinned image, so a mapping that declares it is
refused at plan time with the mapping named.

**Partial failure and retries.** With `ReportBatchItemFailures`, the handler
returns `{"batchItemFailures":[{"itemIdentifier":"<sequence number>"}]}`. Lambda
checkpoints at the lowest failed sequence number and retries from there, so the
prefix before that checkpoint is not re-delivered. `BisectBatchOnFunctionError`
splits a failed batch in half and retries each half; with a partial batch
response the batch is bisected at the returned sequence number. Invalid
responses (malformed JSON, a bad key name, an empty or null identifier) are a
complete failure. `MaximumRetryAttempts` (`-1` unlimited, the AWS default) and
`MaximumRecordAgeInSeconds` (`-1` unlimited, otherwise 60–604800) are evaluated
on the run clock; the local retry backoff is a clock timer, so a test clock
drives retries deterministically. When a batch is discarded, the runner sends
the documented invocation record to `DestinationConfig.OnFailure`: an SQS
message or an SNS message carrying `requestContext` (`requestId`,
`functionArn`, `condition`, `approximateInvokeCount`), `responseContext`,
`version`, `timestamp` and `DDBStreamBatchInfo` (shard id, start and end
sequence numbers, arrival times, batch size and stream ARN). The destination is
the local ElasticMQ queue or the local SNS fan-out; no AWS call is made.

**Parallelization.** `ParallelizationFactor` (1–10) runs several pollers per
shard; records are assigned to a lane by the table's partition key, so records
that share a key stay in one lane and keep their order. Each lane reads the
shard from the same starting position and processes only its own keys.

**Shard lifecycle.** An expired shard iterator is re-seeked after the last
consumed sequence number (`AFTER_SEQUENCE_NUMBER`). A closed shard stops once
its records are exhausted, and the deliverer re-reads the stream description to
pick up child shards and start their pollers.

**Time to Live.** DynamoDB Local accepts `TimeToLiveSpecification` but never
expires an item. The runner performs the expiry on the run clock: it scans every
provisioned table that enabled TTL, deletes an item whose TTL attribute is at or
before the clock's current instant through DynamoDB Local (which produces the
real stream record), and attaches the documented service identity to that
record:

```json
"userIdentity": {"type": "Service", "principalId": "dynamodb.amazonaws.com"}
```

On the real clock the sweep runs about once a second, so an item expires within
a second of its due time; the wall-clock timing of AWS's background TTL process
is a docs/125 true limit and is not reproduced. A scan that has not yet seen a
newly written item is retried on the next sweep.

**DynamoDB Local behaviour the deliverer normalizes.** Observed against
`amazon/dynamodb-local@sha256:7ef4a2c4` (3.1.0):

| Observed DynamoDB Local behaviour | How the runner implements AWS's behaviour |
| --- | --- |
| `ListStreams` returns `Streams`; AWS returns `StreamDescriptions` | The client accepts both and exposes only the AWS field. |
| Stream ARNs and `awsRegion` use region `ddblocal` and account `000000000000` | The event carries the CDK-resolved stream ARN (`GetAtt StreamArn`, normalized to the local region and account) and `awsRegion` `us-east-1`. |
| `ApproximateCreationDateTime` is an ISO string; AWS returns epoch seconds | The record carries epoch seconds, as the Lambda event documents. |
| `GetShardIterator` with `AT_TIMESTAMP` returns an internal failure | `AT_TIMESTAMP` is refused at plan time for DynamoDB with a named reason. |
| TTL never expires an item | The runner deletes the expired item through DynamoDB Local on the run clock and attaches the service `userIdentity`. |
| A shard ID has the form `shardId-<digits>-<hex>` | The value is passed through as an opaque string, as the stream record does. |

The `session` operations that build a stream record by hand
(`ddb.stream-event`) keep working unchanged; they are a convenience, not the
delivery path.

### EventBridge delivery

The runner serves the EventBridge `PutEvents` JSON protocol itself on an
ephemeral port injected into every function as `AWS_ENDPOINT_URL_EVENTS` and
`AWS_ENDPOINT_URL_EVENTBRIDGE` (the SDKs and Tools reference names the override
from EventBridge's API-model serviceId; both spellings point at the same
endpoint). Function containers reach it as `host.docker.internal:<port>` with
the `host-gateway` entry the runner adds. The listener binds every interface so
that entry works on Linux, where it resolves to the bridge address; the session
reports and the harness uses `http://127.0.0.1:<port>`. The endpoint is
unauthenticated and reachable from any interface on the host while a session
runs; it and the WebSocket `@connections` management listener are the runner's
non-loopback listeners, and the backends publish on `127.0.0.1`. A handler's
real SDK client and the harness's AWS CLI reach the same endpoint. A rule's
pattern is matched by the validated EventBridge evaluator E1b uses, and the
runner performs input shaping, target delivery, retry and dead-letter handling.

The own bus was chosen over the pinned moto events service after probing
`motoserver/moto@sha256:59a1965d` (5.2.5):

| Probe | moto 5.2.5 | Runner |
| --- | --- | --- |
| `PutEvents` on a custom bus matches a simple pattern rule to a moto SQS target | Yes | Yes |
| `InputPath` on an SQS target | Accepted and ignored; the full event is delivered | Implemented |
| `Input` on a target | Accepted and ignored | Implemented |
| `InputTransformer` | Not applied | Implemented |
| Retry policy and `DeadLetterConfig` | Accepted, no retry or DLQ behavior | Implemented on the run clock |
| Lambda target delivery to the RIE | Cannot reach the local function containers | Invokes the real container |
| ElasticMQ target | moto's SQS is a different queue service | Sends to the application's ElasticMQ queue |
| Schedules | Never fire | Fire on the run clock |

**Schedules.** A `ScheduleExpression` of the form `rate(value unit)` or
`cron(minutes hours day-of-month month day-of-week year)` fires on `env.Clock`.
The test clock fires exactly the due occurrences: advancing 15 minutes over a
`rate(5 minutes)` rule fires it three times. On the real clock a rule fires at
its due minute. The rate units are `minute(s)`, `hour(s)` and `day(s)` with the
documented singular/plural rule. The cron parser supports `*`, `?`, lists,
ranges, steps, month and weekday names, and a year range; the `L`, `W` and `#`
forms are refused at plan time with the rule named. A scheduled rule is only
valid on the default bus, as AWS documents. The target receives:

```json
{
  "version": "0",
  "id": "<uuid>",
  "detail-type": "Scheduled Event",
  "source": "aws.events",
  "account": "123456789012",
  "time": "<scheduled instant>",
  "region": "us-east-1",
  "resources": ["<the CDK rule ARN>"],
  "detail": {}
}
```

**Buses and rules.** Every `AWS::Events::Rule` with an `EventPattern` registers
on its bus: the `default` bus when `EventBusName` is omitted, or the
`AWS::Events::EventBus` the rule references. `PutEvents` accepts up to ten
entries; each entry becomes the documented envelope (`version`, `id`,
`detail-type`, `source`, `account`, `time`, `region`, `resources`, `detail`) and
is matched against every enabled rule on its bus. Matching is the documented
EventBridge pattern grammar over top-level fields and `detail`, including
`prefix`, `suffix`, `anything-but`, `numeric`, `exists`,
`equals-ignore-case` and `$or`. A `State: DISABLED` rule registers paused and
never fires. A malformed entry is reported in the PutEvents response with
`ErrorCode` `MalformedDetail` and does not reach a rule.

**Targets and input shaping.** A rule target may be a Lambda function, an SQS
queue or an SNS topic:

- Lambda receives the shaped input as its invocation payload.
- SQS receives it as the message body; a FIFO queue receives
  `SqsParameters.MessageGroupId`, which may be a literal or a JSON path such as
  `$.detail.group`.
- SNS is published through the same local fan-out an SDK publish uses, so the
  subscription policies and targets documented in
  [SNS subscription delivery](#sns-subscription-delivery) apply.

`Input` must be valid JSON, `InputPath` must start with `$.`, and an
`InputTransformer` needs an `InputTemplate`; the three are mutually exclusive.
The template supports the configured `InputPathsMap` variables and the
predefined variables `aws.events.rule-arn`, `aws.events.rule-name`,
`aws.events.event.ingestion-time`, `aws.events.event` and
`aws.events.event.json`. A path that has no value removes its variable, and a
variable used inside a JSON string is inserted as the string's content.

**Retry and dead-letter queue.** A failed target is retried on the run clock:
the first retry is after ten seconds, the delay doubles and is capped at five
minutes. `RetryPolicy.MaximumRetryAttempts` (`-1` through 185; `-1` disables
retries) and `MaximumEventAgeInSeconds` (60–86400) bound the attempts and the
event age. When the budget is exhausted, the shaped input goes to the target's
standard SQS dead-letter queue with the documented message attributes
`RULE_ARN`, `TARGET_ARN`, `ERROR_CODE`, `ERROR_MESSAGE`,
`EXHAUSTED_RETRY_CONDITION` (`MaximumRetryAttempts` or
`MaximumEventAgeInSeconds`) and `RETRY_ATTEMPTS`. A target without a DLQ records
the failure and drops the event. AWS invokes a Lambda target asynchronously, so
the Lambda service accepts the call before the handler runs; the local runner
counts a handler error as the target's failure so the EventBridge retry and DLQ
path is observable on a real row.

**EventBridge Scheduler.** No example in this repository synthesizes an
`AWS::Scheduler::Schedule` (`grep -R AWS::Scheduler examples` is empty), so the
runner does not serve Scheduler schedules. A scheduled rule is the legacy
EventBridge form the examples declare.

**Proving rows.** The multilang example proves a `rate(5 minutes)` schedule and
a pattern rule for Go, TypeScript and Python. The `import-pipeline` row puts the
S3 event shape through the real bus and asserts the ingest handler's effect. The
`sqs-queue` row proves four rule target shapes on a custom bus and the default
bus: an SQS target with `InputPath`, an SNS target with an `InputTransformer`
(an L1 `CfnRule`, because this CDK version does not expose the transformer on
the L2 SNS target), a Lambda target with static `Input`, and a failing Lambda
target with a retry policy and an SQS DLQ.

**Delivery state.** `plan` reports every schedule and pattern rule `registered`
with its bus name. `session describe` reports per-rule `fired`, `delivered`,
`failed`, `deadLettered` and `lastError`. The existing `eventbridge.event`
session operation still builds the envelope for a rule by hand; it is a
convenience, not the delivery path.

### Kinesis event-source delivery

The Kinesis deliverer reads moto's stream and invokes the mapping's function
with the documented record. It shares the stream poller core with DynamoDB
Streams: batching, the batching window on the run clock, filter criteria,
partial failures, bisect on error, retry attempts, record age, the on-failure
invocation record and iterator re-seek. The differences are the Kinesis record
shape, the three starting positions and the partition-key lane rule.
Sources: [Using Lambda to process records from Amazon Kinesis Data Streams](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html)
and [Configuring partial batch response with Kinesis Data Streams and Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-batchfailurereporting.html).

**Polling.** `BatchSize` defaults to 100; a positive
`MaximumBatchingWindowInSeconds` (0–300) closes the batch on the run clock.
`StartingPosition` is `TRIM_HORIZON`, `LATEST` or `AT_TIMESTAMP` with a
`StartingPositionTimestamp` in Unix seconds. A record carries the base64 `data`,
`partitionKey`, `sequenceNumber`, `approximateArrivalTimestamp`,
`eventSourceARN` (the CDK stream ARN), `eventSource` `aws:kinesis`,
`eventName` `aws:kinesis:record` and the local invocation identity ARN.
`FilterCriteria` is evaluated against the record's metadata and the top-level
`data` key, whose value is the base64-decoded payload when that payload is valid
JSON; a record that matches no filter advances the iterator without an
invocation. A non-JSON payload leaves `data` absent, so a filter with a data
property drops the record while a metadata-only filter still matches
([Using event filtering with a Kinesis event source](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis-filtering.html)).

**Partial failure and retries.** The response is
`{"batchItemFailures":[{"itemIdentifier":"<sequence number>"}]}`; the lowest
reported sequence number is the checkpoint. `BisectBatchOnFunctionError`,
`MaximumRetryAttempts`, `MaximumRecordAgeInSeconds` and
`DestinationConfig.OnFailure` follow the same rules as
[DynamoDB Streams delivery](#dynamodb-streams-delivery); the on-failure record
carries `KinesisBatchInfo` instead of `DDBStreamBatchInfo`.

**Parallelization.** `ParallelizationFactor` (1–10) assigns a partition key to a
lane; records with the same key stay in one lane and keep their order. Each lane
reads the shard from the same starting position and processes only its keys.

**Shard lifecycle.** An expired iterator is re-seeked after the last consumed
sequence number. A closed shard stops once drained, and the deliverer re-reads
the shard list to start new shards.

**moto behaviour the deliverer normalizes.** Observed against
`motoserver/moto@sha256:59a1965d` (5.2.5):

| Observed moto behaviour | How the runner implements AWS's behaviour |
| --- | --- |
| Sequence numbers are small decimals starting at `"1"` | The value is passed through as an opaque string, as the event documents. |
| A stream never splits or merges | The shard list is re-read; the local stream keeps its provisioned shards. |
| `NextShardIterator` may carry a trailing newline | The iterator is passed back verbatim; it is never exposed to a handler. |
| The stream ARN is already `arn:aws:kinesis:<region>:<account>:stream/<name>` | The event uses the CDK-resolved ARN, which matches it. |

### CloudWatch Logs subscription delivery

**Function log capture.** Every started function's stdout and stderr are
followed from its container and written to the CloudWatch Logs group
`/aws/lambda/<function name>` through the real `PutLogEvents` API on moto, one
log stream per container (`<yyyy>/<mm>/<dd>/<container>`). A subscription filter
on that group therefore carries real invocation output. Captured: every line the
runtime process writes to standard out or standard error, including handler
logging, runtime initialisation output and the platform-style lines the
official runtime image prints itself (`START`, `END`, `REPORT` and the
rapid-runtime `INIT`/`INVOKE` lines). Not captured: anything the AWS Lambda
service records outside the container; there is no separate service-side
request log locally.
Timestamps are the wall-clock ingestion times moto accepts (it rejects an event
older than its retention window) and are monotonic per stream; the test clock
does not move log ingestion. The group is created before the function is
invoked; a function without the Logs backend simply has no capture.

**Subscription filters.** An `AWS::Logs::SubscriptionFilter` on a log group is
registered with the delivery engine. The runner polls the group with
`FilterLogEvents`, honours the filter pattern and delivers the documented
payload: gzip-compressed JSON with `messageType` `DATA_MESSAGE`, `owner`,
`logGroup`, `logStream`, `subscriptionFilters` and `logEvents` (each with `id`,
`timestamp` and `message`). A Lambda destination receives it base64-encoded in
`awslogs.data`; a CloudWatch Logs destination is followed to its Kinesis stream,
and the runner puts the same gzip bytes as the Kinesis record data (partition
key from `Distribution`: `ByLogStream` uses the log stream name, `Random` uses a
generated key), so the Kinesis mapping delivers the record through the normal
stream path. `Distribution` is validated when the filter is derived.

**Filter patterns.** The runner implements the forms a local application uses:
the blank pattern matches every event; a term pattern ANDs bare terms, matches a
`"quoted phrase"`, ORs `?alternative` terms and excludes `-term` terms; a JSON
pattern supports `$.path = value`, `$.path != value`, `&&`, `||` and
parentheses with string, number and boolean values. Regex patterns (`%...%`),
array and wildcard selectors, space-delimited field selectors and the `L`/`W`/`#`
cron-style forms are refused at plan time with the filter and the construct
named, never accepted and silently matched against nothing.

**Delivery state.** `plan` reports a subscription `registered`; `session
describe` reports `delivered`, `filtered` and `failed` for it. The existing
`kinesis.cloudwatch-event` and `kinesis.event` session operations still build an
event by hand; they are a convenience, not the delivery path.

**moto behaviour the deliverer normalizes.** Observed against
`motoserver/moto@sha256:59a1965d` (5.2.5): moto stores and serves log events but
does not run subscription filters; the runner polls the group and performs the
delivery. `FilterLogEvents` returns `eventId`, `logStreamName`, `timestamp`,
`message` and `ingestionTime`; the payload uses them directly.

### SNS subscription delivery

A handler publishes through the real AWS SDK to the topic the runner
provisioned on moto. The runner observes the publish and performs the fan-out
itself because moto cannot reach the Runtime Interface Emulator or ElasticMQ.
The handler's `Publish` call is never replaced by a runner shortcut.

**Observation.** At provisioning the runner creates one drain queue on moto's
own SQS for every topic with a subscription and subscribes it without raw
message delivery. moto then writes the documented notification envelope, so the
runner sees the SNS message id, subject, timestamp and message attributes
exactly as the target would. A FIFO topic uses a FIFO drain queue with
content-based deduplication, which also carries `MessageGroupId` and
`MessageDeduplicationId` as SQS system attributes and makes a publish that
relies on topic content-based deduplication succeed. The runner polls the drain
queue, evaluates each subscription and delivers every target itself.

A drain queue was chosen over an HTTP observer for two reasons. SNS FIFO topics
cannot deliver to HTTP(S) endpoints at all, and moto's HTTP fan-out drops the
message group and deduplication ids, so an HTTP observer could not reproduce
FIFO delivery ([FIFO message delivery](https://docs.aws.amazon.com/sns/latest/dg/fifo-message-delivery.html)).
A drain queue also keeps the run loopback-only: it uses the same runner-to-moto
path as every other local client instead of requiring moto to reach a listener
on the host. On the pinned Colima host `host.docker.internal` did resolve to
the host (`192.168.5.2`) and could reach a `127.0.0.1`-bound listener, but that
is a container-to-host dependency the drain queue does not need.

**Targets.**

- **Lambda** receives the documented SNS event record
  ([sample event](https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html)):
  `Records[0].EventSource`, `EventVersion`, `EventSubscriptionArn`, and `Sns`
  with `Type`, `MessageId`, `TopicArn`, `Subject`, `Message`, `Timestamp`,
  `MessageAttributes` and `SignatureVersion`. The runner emits
  `UnsubscribeUrl` (the Lambda spelling) and `SigningCertURL`. The local
  signature is deterministic over the subscription ARN and message; it is not
  verifiable against an AWS certificate, and the local runner has no SNS
  signing key.
- **SQS** receives the documented JSON notification when `RawMessageDelivery`
  is false, or the message body when it is true, with the published attributes
  carried as SQS message attributes. The envelope names `UnsubscribeURL` and
  `SigningCertURL`
  ([message formats](https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html),
  [raw message delivery](https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html)).
  A raw delivery with more than 10 message attributes is discarded, as SNS
  documents. A FIFO queue receives the message group and deduplication ids.
- **HTTP/HTTPS** receives a POST to a loopback endpoint with the documented JSON
  body and `Content-Type: text/plain; charset=UTF-8`, `x-amz-sns-message-type`,
  `x-amz-sns-message-id`, `x-amz-sns-topic-arn` and
  `x-amz-sns-subscription-arn`; a raw delivery adds
  `x-amz-sns-rawdelivery: true` and sends no attributes. The subscription is
  already registered, so no `SubscriptionConfirmation` message is sent. A
  non-loopback endpoint is refused at plan time, and delivery re-checks the
  endpoint so the run never contacts the network.

**FIFO topics.** Delivery preserves order within a message group; different
groups may interleave, as AWS documents. A deduplication id seen within the
five-minute interval is suppressed for every subscription, whether the
publisher supplied it or SNS computed it from the message body. The ids are
passed to a FIFO SQS subscription so the queue sees the same group and
deduplication values. Lambda and HTTP(S) subscriptions to a FIFO topic are
refused at plan time with a named reason, because SNS cannot deliver to those
endpoints
([FIFO message delivery](https://docs.aws.amazon.com/sns/latest/dg/fifo-message-delivery.html),
[FIFO topics](https://docs.aws.amazon.com/sns/latest/dg/sns-fifo-topics.html)).

**Filter policies.** `FilterPolicy` is evaluated per subscription with
`FilterPolicyScope` `MessageAttributes` (the default) or `MessageBody`, and the
documented rule is "AND across keys, OR within a key"
([subscription filter policies](https://docs.aws.amazon.com/sns/latest/dg/sns-subscription-filter-policies.html),
[message filtering](https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html)).
The `$or` operator is supported in both scopes exactly as AWS documents it: SNS
recognizes `$or` only when its value is an array of at least two objects and
none of those objects has a reserved keyword (`numeric`, `prefix` and the other
operators) as a field name; otherwise `$or` is an ordinary attribute or
property name matched like any other string in the policy
([OR logic](https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html)).
`$or` nests inside a branch and inside a nested body key, and its combination
count is the sum of its branches; the documented 150-combination and 256 KB
limits are enforced at plan time
([filter policy constraints](https://docs.aws.amazon.com/sns/latest/dg/subscription-filter-policy-constraints.html)).
Attribute-scope policies match only top-level attributes and honour the
`String`, `String.Array` (each element is a candidate) and `Number` data types;
a `Binary` attribute matches only `exists`. An exact-value rule compares a
`Number` attribute's textual form; use `numeric` for numeric comparison, because
AWS does not pin the exact-value form. Body-scope policies require a JSON
object body, and a non-JSON body matches nothing. The supported rules are exact
string, `prefix`, `suffix`, `anything-but` (scalar, list and prefix forms),
`numeric` (one comparison or a two-sided range), `exists` and
`equals-ignore-case`. The syntax coincides with the EventBridge pattern
evaluator E1b uses for `FilterCriteria`, so the validators and single-value
operator primitives are shared; the SNS walker adds presence-based `exists`,
array element matching and the array form of `anything-but`. The `cidr` operator
is not implemented locally: it is refused at plan time with the subscription and
the offending key named, never accepted and silently matched against nothing.

**Delivery state and the local publish path.** Each subscription reports
`delivered`, `filtered` and `failed` counts plus `lastError` in
`session describe`; `plan` reports it as `registered`. A target failure is a
single attempt: AWS applies the subscription's delivery policy and dead-letter
queue, while the local runner does not retry and reports the error. The same
fan-out is available in-process as `Runner.PublishLocal(topicARN, message)` and
`Runner.PublishLocalMessage(topicARN, LocalSNSMessage)` for E3 and E4 targets
that must publish without going through moto; both take the same filter and
target path as an observed SDK publish.

**moto deviations the runner normalizes.** Observed against
`motoserver/moto@sha256:59a1965d` (5.2.5):

| Observed moto behaviour | How the runner implements AWS's behaviour |
| --- | --- |
| Moto's SNS fan-out only reaches moto's own SQS and cannot reach the RIE or ElasticMQ | The runner creates a drain queue on moto's SQS and performs the application fan-out itself. |
| A non-raw FIFO delivery reports the SHA-256 of the SNS envelope as `MessageDeduplicationId` | The runner detects the envelope hash, recomputes the documented content-based deduplication id from the message body, and forwards that to FIFO queues and the deduplication window. |
| The envelope's `UnsubscribeURL` names a placeholder subscription ARN | The runner builds `UnsubscribeUrl`/`UnsubscribeURL` from the subscription ARN it registered; the local runner does not serve the unsubscribe action. |
| FIFO topic content-based deduplication is enforced by the drain queue, whose deduplication window ends when the drain message is deleted | The runner keeps its own five-minute deduplication window on the run clock, so a duplicate publish after the drain message is consumed is still suppressed. |
| Moto's HTTP fan-out drops `MessageGroupId`/`MessageDeduplicationId` and SNS forbids HTTP targets on FIFO topics | The runner does not use an HTTP observer; the drain queue carries the FIFO ids. |
| Moto accepts a FIFO queue subscription only on a FIFO topic | The runner registers subscriptions itself and follows AWS: a FIFO queue is accepted on either topic; the SNS FIFO restriction applies to Lambda and HTTP targets. |

| s3proxy deviation | How the runner normalizes it |
| --- | --- |
| s3proxy has no server-side notification hook | The runner observes the bucket with the real `ListObjectsV2` API and derives the documented record from the observed object state. |
| The observation cannot tell which S3 API made the change | An observed create is reported as `ObjectCreated:Put` (multipart complete and copy included) and an observed delete as `ObjectRemoved:Delete`. |
| An object created and deleted inside one 250 ms poll is invisible | The poll interval is documented; a row that needs both changes separates them in time. |
| The listing carries no request id or source IP | The runner generates the request id and reports its own loopback source address, the way S3 generates them for its own record. |

### S3 event notification delivery

Two template shapes declare a bucket's notification configuration, and the
runner reads both:

- `AWS::S3::Bucket.NotificationConfiguration`, the CloudFormation property, with
  one `Event` per entry (`s3:ObjectCreated:*`, `s3:ObjectRemoved:Delete`, …) and
  an optional `Filter.S3Key` prefix/suffix rule list;
- `Custom::S3BucketNotifications.NotificationConfiguration`, the shape
  `Bucket.addEventNotification` emits. That custom resource calls
  `PutBucketNotificationConfiguration` at deploy time, so the configuration
  never appears on the bucket resource itself; the runner reads the custom
  resource's properties, which are the bucket API's shape.

The destinations are Lambda functions, SQS queues, SNS topics and the bucket's
EventBridge configuration (`EventBridgeConfiguration: {}`), as
[Event notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html)
documents. Event names in the configuration carry AWS's `s3:` prefix; the record
`eventName` does not (`ObjectCreated:Put`), exactly as
[Event message structure](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html)
shows.

**Observing the object change.** s3proxy, the profile's S3 backend, has no
server-side event hook. The runner therefore watches each bucket that declares a
notification with the real `ListObjectsV2` API and compares each listing with
the previous one. A new key, an overwrite (ETag, size or `LastModified`
changed) and a removed key each become the documented record. The first listing
after the run starts is the baseline, so objects that existed before the run
never produce an event. The watcher polls every 250 ms.

**What the destinations receive.**

- A Lambda, SQS or SNS destination receives `{"Records":[…]}` with
  `eventVersion: "2.6"`, `eventSource: "aws:s3"`, `eventName`, the response
  elements, and `s3.bucket`/`s3.object` including the URL-encoded key
  (space becomes `+`, `/` is kept), `size`, `eTag`, `sequencer` and the
  configuration's `configurationId`.
- An SNS destination is published through the runner's own SNS fan-out, so a
  subscriber sees the documented SNS envelope whose `Message` is that JSON
  (or the JSON itself under raw message delivery).
- A bucket with EventBridge notifications publishes the
  [S3 → EventBridge](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html)
  event: `source: "aws.s3"`, `detail-type: "Object Created"` or
  `"Object Deleted"`, and a `detail` with the bucket, the object, the request id
  and the `reason` (`PutObject`/`DeleteObject`). It is published on the runner's
  own bus, so a matching rule reaches its targets with no `PutEvents` call from
  the test.

**The test message.** When the configuration is applied S3 sends the
`s3:TestEvent` message to every SQS and SNS destination (never to a Lambda
destination). The runner sends it once, after the baseline listing, so a row can
use it as the signal that the watcher is ready. The message has the simplified
shape the content-structure page shows (`Service`, `Event`, `Time`, `Bucket`,
`RequestId`, `HostId`), not the `Records` envelope.

**What the record reports.** The watcher cannot see which S3 API made the
change, so an observed create is reported as `ObjectCreated:Put` and an observed
delete as `ObjectRemoved:Delete`; a multipart upload and a copy are likewise
reported as `Put`. A create and a delete of the same key inside one 250 ms poll
is not observed. The `size` and `eTag` come from the listing; the `sequencer` is
the observation instant.

**The producible event set.** The watcher observes creates and deletes only, so
a configuration may name only `s3:ObjectCreated:*`, `s3:ObjectCreated:Put`,
`s3:ObjectRemoved:*` or `s3:ObjectRemoved:Delete`. `plan` refuses every other
`s3:` event name by name — including `s3:ObjectCreated:Copy`,
`s3:ObjectCreated:CompleteMultipartUpload`, `s3:ObjectCreated:Post`,
`s3:ObjectRemoved:DeleteMarkerCreated`, `s3:ObjectRestore:*`,
`s3:ObjectTagging:*`, `s3:ObjectAcl:Put`, `s3:LifecycleExpiration:*`,
`s3:LifecycleTransition`, `s3:IntelligentTiering`, `s3:Replication:*` and
`s3:ReducedRedundancyLostObject` — with the reason "the local watcher observes
creates and deletes only"; a configuration that mixes a producible and an
unproducible name is refused the same way, never silently narrowed. These four
names are the part of the
[S3 event notification types](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html)
list the observation can reproduce.

**Overlapping filters are refused like AWS.** AWS's
`PutBucketNotificationConfiguration` rejects two configurations on one bucket
that have overlapping prefixes for the same event types unless the suffixes
don't overlap, as
[object key name filtering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-filtering.html)
documents. `plan` applies the same rule before anything starts: two
configurations whose event types intersect may not have both overlapping
prefixes (one is a prefix of the other, or either configuration has no prefix
rule) and overlapping suffixes (one is a suffix of the other, or either
configuration has no suffix rule). The refusal names both configurations and the
event type. Pairs with disjoint event types, or with non-overlapping suffixes,
are registered, exactly as the page's valid examples show.

`plan` prints one line per destination with `delivery=registered`; `session
describe` returns a `notifications` array with each destination's
`configurationId`, `state`, `delivered`, `filtered` and `failed` counts, and the
same counters appear in the delivery engine's per-source state.

### Delivery state

The vocabulary follows the Lambda event source mapping API. AWS reports a
mapping's lifecycle in `State` (`Creating`, `Enabling`, `Enabled`, `Disabling`,
`Disabled`, `Updating`, `Deleting`) and its processing outcome in
`LastProcessingResult`, with `StateTransitionReason` naming the last change; see
[EventSourceMappingConfiguration](https://docs.aws.amazon.com/lambda/latest/dg/API_EventSourceMappingConfiguration.html)
and [How Lambda processes records from stream and queue-based event sources](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventsourcemapping.html).
The runner keeps the same shape in a smaller vocabulary:

| Local state | AWS equivalent | Meaning |
| --- | --- | --- |
| `registered` | `Creating` | The kind has a deliverer; the source is registered and the deliverer is starting. |
| `polling` | `Enabled` | A queue or stream deliverer is polling the backend. |
| `armed` | `Enabled` | A schedule or rule deliverer is waiting for the clock, or an SNS subscription is attached to its topic hub. |
| `paused` | `Disabled` | Registered, not delivering. |
| `stopped` | `Deleting` | The deliverer stopped at shutdown. |
| `failed` | `LastProcessingResult` reports a problem | The deliverer could not start or deliver; `lastError` carries the cause. |
| `not-delivered` | no mapping exists | The source kind has no deliverer yet; `task` and `reason` name the task that will implement it. |

Every entry reports its `delivered` and `failed` counts, `lastError` and
`paused`; an SNS subscription and an S3 notification destination also report
`filtered` (messages its policy or key filter did not match); an SQS source
reports `left` (records left for redelivery),
`inflight` and `peakInflight`; a DynamoDB Streams mapping reports `discarded`
(records sent to its on-failure destination); an EventBridge rule reports
`fired`, `delivered`, `failed` and `deadLettered`; a Kinesis mapping also
reports `discarded`; a CloudWatch Logs subscription reports `filtered`. The engine also reports its
clock mode and current instant and its concurrency bound.

`plan` prints the state the engine would register without starting a container;
`plan --json` carries the same list under `delivery`. Every derived SQS,
DynamoDB Streams, Kinesis, EventBridge, CloudWatch Logs or SNS source is
`registered` because the kind has a deliverer; a kind without one is
`not-delivered` with its task. `session describe` returns the live engine state
under `delivery`:

```json
{"running":true,"clock":{"mode":"test","now":"2026-01-01T00:00:00Z"},"concurrency":4,"sources":[{"id":"WorkerFnEventSourceMapping","kind":"sqs","state":"polling","delivered":12,"failed":0,"inflight":0,"peakInflight":2,"left":0,"paused":false}]}
```

### Deterministic test clock

`--clock real` is the default. `--clock test[=<RFC3339 start>]` replaces the
wall clock with a deterministic one that starts at the given instant, or at
`2026-01-01T00:00:00Z` when no instant is given. The delivery engine, every
future schedule, TTL expiry and visibility deadline take their time from this
clock, never from `time.Now()`; the events a session builds carry it too. Real
time stays the default, so every existing command keeps its behaviour. The
clock does not slow the emulators' own wall-clock timers or the runtime
images; [What the test clock controls](#what-the-test-clock-controls) states
the exact boundary for SQS delivery.

A `session` exposes the clock with two commands:

- `clock.now` — `{"mode":"real"|"test","now":"<RFC3339Nano>"}`.
- `clock.advance` — move a test clock forward by a Go duration:
  `{"op":"clock.advance","duration":"90m"}` returns the new `now`, the accepted
  `advanced` duration and `timersFired`. The real clock is never advanced; the
  command fails with a named reason instead.

### Delivery concurrency

`--delivery-concurrency` bounds the concurrent handler invocations the engine
performs: `1..32`, default `4`. The default is sized for the documented Colima
host — four CPUs and about 6 GB shared by the runtime images, the emulator
containers and the HTTP transport. One in-flight delivery per CPU leaves a core
for everything else; a larger bound only queues inside the one container per
function. See [Requirements](#requirements).

### Lifecycle

The engine drains in-flight deliveries for up to five seconds, then cancels the
deliverers and stops them. `Ctrl-C`/`SIGTERM` take that path, as does the
`shutdown` session command. `apptheory-local down` removes containers and
networks left by a killed process; it cannot drain a process that is already
gone.

## Capability matrix

Classes follow the repository's local-execution convention: **L1** runs fully
locally, **L2** runs locally with an emulator and documented limits, and **L3**
is exercised as fully as possible with a named cloud gap. `apptheory local`
serving a surface is not by itself a class: the class belongs to an example, and
the harness records it.

| Capability | Local runner | Notes |
| --- | --- | --- |
| HTTP API v2 (`AWS::ApiGatewayV2::Api`, HTTP) | Supported (L1) | v2.0 events with `routeKey`, `rawPath`, `requestContext.http`, cookies and path parameters. The `cookie` header is removed when `cookies` is populated, as AWS does. |
| REST API v1 (`AWS::ApiGateway::RestApi`) | Supported (L1) | v1 events with `resource`, `multiValueHeaders`, `multiValueQueryStringParameters` and the stage. |
| Lambda Function URL | Supported (L1) | Function URL events carry `routeKey: "$default"` (top-level and in `requestContext`, with `requestContext.stage`) and a `.lambda-url.<region>.on.aws` domain, which the runtime uses to tell them apart from HTTP API v2. A URL with an auth type other than `NONE` is reported under `skipped`, not served as a standalone URL; a distribution can still reference it as an origin. |
| Response streaming (`awslambda.streamifyResponse`, SSE) | Supported, **buffered** (L3) | The RIE buffers the whole response and returns metadata JSON + eight NUL bytes + body. The transport reproduces status, headers and complete bytes; it never reproduces chunk timing. |
| Inline `Code.ZipFile` | Supported (Node, Python) | Materialized under the run scratch directory before the container starts. |
| arm64 `provided.al2023` | Supported (L1) | Uses the host-arch image; a bootstrap built for the other architecture fails closed with a clear error. |
| DynamoDB Local | Supported (L2) | `--backend dynamodb` starts the profile's digest-pinned `amazon/dynamodb-local` on the run network; SDK clients resolve through `AWS_ENDPOINT_URL_DYNAMODB`. Tables are created from the CDK key schema, GSIs, streams and TTL. SSE, PITR and deletion protection are not provisioned. |
| SQS (ElasticMQ) | Supported (L2) | `--backend sqs` starts the digest-pinned `softwaremill/elasticmq-native` container, creates the CDK queues with visibility, retention and redrive policy, and resolves `QueueUrl`/`Arn` from the created queues. Every SQS event-source mapping polls automatically with batching, visibility, delete-on-success, partial batch failure, FIFO group ordering, redrive, filter criteria and maximum concurrency; see [SQS event-source delivery](#sqs-event-source-delivery). A session also exposes `sqs.send`, `sqs.receive`, `sqs.event` and `sqs.attributes` for explicit work. |
| KMS and STS (moto) | Supported (L2) | `--backend moto` starts the profile's digest-pinned moto container and injects `AWS_ENDPOINT_URL_KMS`/`_STS` (and the profile's aliases). Symmetric, RSA (2048/3072/4096) and ECC (P256/P384/P521) `SIGN_VERIFY` keys declared by the assembly are created, with aliases; `Ref`/`Fn::GetAtt Arn` resolve to the created key and alias. No HSM, key policies or grants. |
| SSM Parameter Store (moto) | Supported (L2) | `AWS::SSM::Parameter` String, StringList and SecureString are created; `Ref` returns the name and `Fn::GetAtt Type`/`Value` the declared type and value. `AWS_ENDPOINT_URL_SSM` is injected. SecureString is stored in moto's memory without envelope encryption. |
| Secrets Manager (moto) | Supported (L2) | `AWS::SecretsManager::Secret` with `SecretString` or `GenerateSecretString` is created; `Ref` is the ARN and runtime `GetSecretValue` works. A `ResourcePolicy` is reported skipped (IAM is a docs/125 true limit). `AWS_ENDPOINT_URL_SECRETS_MANAGER` is injected. |
| SNS topics and subscriptions (moto) | Supported (L2) | Standard and FIFO `AWS::SNS::Topic` are created with `FifoTopic`/`ContentBasedDeduplication`; `Ref` is the ARN and `GetAtt TopicName`/`TopicArn` resolve. `AWS::SNS::Subscription` and inline `Subscription` entries are delivered automatically to Lambda, SQS and loopback HTTP targets, with filter policies, raw message delivery and FIFO ordering/deduplication; see [SNS subscription delivery](#sns-subscription-delivery). `TopicPolicy` is reported skipped (IAM is a docs/125 true limit). |
| Kinesis streams (moto) | Provisioned (L2); mapping delivered (E5) | `AWS::Kinesis::Stream` is created with `ShardCount` or `StreamModeDetails`, and `RetentionPeriodHours`; `Ref` is the name and `GetAtt Arn` the stream ARN. `AWS_ENDPOINT_URL_KINESIS` is injected. A mapping on the stream is delivered automatically; see [Kinesis event-source delivery](#kinesis-event-source-delivery). |
| Cognito user pools (moto) | Supported (L2) | `AWS::Cognito::UserPool` and `UserPoolClient` are created; `Ref` returns the pool/client id and `GetAtt Arn`/`ProviderName`/`ProviderURL` the pool provider values. The runner serves the pool's JWKS and an OIDC discovery document at `http://127.0.0.1:<port>/cognito-idp/<region>/<poolId>`. A `UserPoolDomain` is reported skipped (no hosted UI). |
| S3 (s3proxy) | Supported (L2) | `--backend s3proxy` starts the digest-pinned s3proxy container, creates the assembly's buckets, and injects the S3 endpoint as the container address so the SDK uses path-style addressing. No bucket policies or IAM. A bucket notification configuration is delivered from the real object state; see [S3 event notification delivery](#s3-event-notification-delivery). |
| Event source mappings (SQS, DynamoDB Streams and Kinesis delivered) | SQS delivered (E1b), DynamoDB Streams delivered (E2), Kinesis delivered (E5) | The mapping's function, source, batch options, filter criteria and scaling configuration are read from the assembly. Every supported mapping is delivered automatically: an SQS queue, a DynamoDB stream or a Kinesis stream; see [SQS event-source delivery](#sqs-event-source-delivery), [DynamoDB Streams delivery](#dynamodb-streams-delivery) and [Kinesis event-source delivery](#kinesis-event-source-delivery). A session can still build a stream record from a real local write and invoke the handler. |
| EventBridge rules (schedule and pattern) | Delivered (E3) | A rule is registered per kind (schedule or pattern) and delivered: a schedule fires on the run clock and a pattern rule receives every matching `PutEvents` entry; see [EventBridge delivery](#eventbridge-delivery). A session can still build the `Scheduled Event` envelope or the pattern's source/detail-type from the CDK rule and invoke its Lambda target. EventBridge Scheduler (`AWS::Scheduler::Schedule`) is not served because no example declares one. |
| Kinesis / CloudWatch Logs subscription events | Delivered (E5) | A `AWS::Logs::SubscriptionFilter` is derived with its log group and destination (a Lambda function, or a CloudWatch Logs destination followed to its Kinesis stream) and delivered: function log capture writes the real `PutLogEvents` output, and a stream destination puts the same gzip bytes as the Kinesis record data, which the mapping delivers; see [CloudWatch Logs subscription delivery](#cloudwatch-logs-subscription-delivery) and [Kinesis event-source delivery](#kinesis-event-source-delivery). A session can still build a CloudWatch Logs subscription payload from local log events and wrap it in a Kinesis record, or accept explicit base64 record data. |
| Delivery engine and test clock | Supported | `run` and `session` start the engine; `plan` and `session describe` report per-source state, including an SNS subscription's `filtered` count. SQS batching windows, visibility deadlines, schedules, TTL expiry and the SNS FIFO deduplication window take their time from `--clock test[=<RFC3339>]`; the `clock.now`/`clock.advance` session commands read and move it. ElasticMQ's and moto's own wall-clock timers and the runtime images are not slowed. `--delivery-concurrency` bounds concurrent deliveries (default 4); an SQS mapping's `MaximumConcurrency` bounds its batches within that. |
| Deploy-time Secrets Manager dynamic references | Supported | A `{{resolve:secretsmanager:…}}` environment value resolves to the provisioned secret's value (the same JSON key) when the assembly declares that secret, and otherwise keeps the wave-1 deterministic local placeholder. The session's `describe` returns it to the harness; `run` and `plan` never print it. No secret is created in a cloud. |
| Other emulators | Endpoint injection only | Pass `--endpoint service=url` and `--add-host name=address`; the profile names the environment variables. The checked-in profile binds `ssm`, `secretsmanager`, `sns`, `kinesis` and `cognito-idp` to moto, and `kms`/`sts` as before. |
| WebSocket APIs (`AWS::ApiGatewayV2::Api`, WEBSOCKET) | Served (L2) | A real RFC 6455 listener serves `$connect`, `$disconnect`, `$default` and custom routes selected by the route selection expression, with the documented proxy event, two-way route responses, the `$connect` policy authorizer, the `@connections` management API and the documented idle/lifetime close; see [WebSocket APIs](#websocket-apis). No custom domains and no IAM authorization. |
| CloudFront distributions and CloudFront Functions | Served (L2) | The distribution is served on its own loopback URL. Cache behaviors, allowed methods, viewer-request/viewer-response functions, origin request policies and response headers policies are applied; the generated function code runs in a restricted Node sandbox. S3 origins read the app's deployments from s3proxy, Function URL origins invoke the real handler container, and origin groups fail over with CloudFront's rules. No caching, no edge network, no TLS. |
| REST `MOCK` integrations | Supported (L1) | The transport returns the `IntegrationResponses` status and headers the template declares and invokes no function. CDK emits these for CORS preflight. |
| HTTP API `REQUEST` authorizers with simple responses | Supported | The transport invokes the real authorizer function with the API Gateway v2 REQUEST event, carrying every configured `$request.header.*` or `$request.querystring.*` identity source in order; a request missing one is refused with 401 before the authorizer runs. A false `isAuthorized` is a 401, the authorizer context is carried to the handler, and a malformed response fails closed. `$context`/`$stageVariables` sources fail closed at plan time. |
| HTTP API JWT authorizers | Supported (L2) | RSA-based algorithms only (`RS256`, `RS384`, `RS512`); the signature is verified with the `kid` key from the issuer's JWKS, and `iss`, `aud` (or `client_id` only when `aud` is absent), `exp`, `nbf` and `iat` are checked against the run clock. `AuthorizationScopes` is an any-of match; the claims reach the integration in `requestContext.authorizer.jwt`; see [Authorizers](#authorizers). |
| REST API Cognito user-pool authorizers | Supported (L2) | The token is validated against the pool's JWKS through the local issuer with the same RSA-only algorithm and claim checks as the HTTP JWT authorizer; `AuthorizationScopes` is an any-of match and the claims reach the integration in `requestContext.authorizer.claims`; see [Authorizers](#authorizers). |
| REST/HTTP Lambda authorizers with IAM-policy responses | Supported (L2) | A REST `TOKEN` or `REQUEST` `AWS::ApiGateway::Authorizer` and an HTTP API `REQUEST` authorizer with `EnableSimpleResponses: false` run the real function and match its returned policy narrowly against the method/route ARN. Identity sources are 401 before invocation when missing; `AuthorizerResultTtlInSeconds` caches on the run clock with the documented cache key; Allow invokes, Deny is 403, the `Unauthorized` error is 401 and an invalid response is 500; the stringified context reaches `requestContext.authorizer`; see [Authorizers](#authorizers). |
| Lambda layers, container-image functions | Not served | Fail closed when a served function needs them. |
| CloudFormation-expression environment values | Supported for `Ref`/`Fn::GetAtt`/`Fn::Join` | Tables and stream ARNs, queues, rules, buckets, KMS keys and aliases, SSM parameters, Secrets Manager ARNs, SNS topics, Kinesis streams, Cognito pool/client values, IAM/MicroVM-image/S3 Vectors ARNs and functions resolve to local values (moto/S3 require their backend). An unsupported expression fails with the function and variable named. |
| CloudFormation-expression `MemorySize`/`Timeout` | Not resolved | A served function whose limit is `Ref`/`GetAtt`/`Fn::If` fails with the property named; the AWS defaults apply only when the property is absent. |
| One function, explicit events (`invoke`) | Supported | Starts one function and sends newline-delimited JSON events to a warm container; `--handler-dir` runs a handler that has no CDK definition and derives no routes. |
| Every target, explicit commands (`session`) | Supported | Starts every CDK-targeted function, serves the HTTP surface, and answers a JSON-line command protocol for invocation, SQS, DynamoDB, S3, EventBridge and Kinesis operations. `--target` adds a function no route or event source targets. |
| Stage-prefixed URLs (`/prod/...`) | Not honoured | The stage is reported in the event; URLs are served at the root, as API Gateway does for custom domains. |
| Multiple APIs in one stack | Supported | Each API gets its own listener and route table, so `ANY /` surfaces never shadow each other. |

## Known gaps

- **Streaming is buffered.** A handler that streams is not incremental under the
  Runtime Interface Emulator. Tests can assert the complete bytes and the status
  and headers, never the timing of individual chunks.
- **WebSocket domains and IAM authorization** are out of scope. The API is
  served on a loopback `ws://` URL, so a custom domain name and its certificate
  are not modelled; `AWS_IAM` route authorization and REST-style Lambda
  authorizers on WebSocket routes fail closed. The `@connections` management
  endpoint is TLS with a per-run self-signed certificate, which the runner
  mounts into the function containers; a client outside those containers must
  trust that certificate to call it. Binary media types are refused with 1003,
  as API Gateway documents.
- **CloudFront is an edge-path gateway, not an emulator.** The distribution's
  cache behavior, generated CloudFront Functions, edge policies and origins are
  applied, but there is no cache, no edge network, no TLS and no viewer protocol
  enforcement. S3-origin bucket CORS rules and IAM/bucket policies are not
  emulated; the local S3 origin returns the S3 status the OAC/OAI access model
  produces. `If-Range` is not forwarded to the S3 origin (CloudFront forwards
  it by default), so a conditional range is served as an unconditional
  range. A Function URL `RESPONSE_STREAM` body is buffered. An `AWS_IAM`
  Function URL's SigV4 signing and the gateway's in-process check of that
  locally signed request are reproduced, but IAM policy evaluation is not.
  A literal external custom origin is refused rather than reached. Lambda@Edge,
  KeyValueStore, signed URLs, field-level encryption, geo restriction, WAF and
  custom error responses refuse the distribution; caching, compression, logging
  and placement settings are reported. The Node `vm` executor matches the
  CloudFront Functions API and globals but is not a hardened security boundary,
  does not enforce CloudFront's 1 ms CPU budget, and cannot reproduce
  CloudFront-only device, location or TLS headers.
- **Kinesis and CloudWatch Logs are emulated by moto.** The stream mapping,
  the subscription filter, partial failure and the function-log capture are
  real, but a moto stream never splits or merges and its sequence numbers are
  opaque. Log ingestion uses wall-clock timestamps because moto rejects an
  event outside its retention window.
- **Kinesis shard topology is fixed.** The stream is created on moto from
  `AWS::Kinesis::Stream`, and `Ref`/`GetAtt Arn` resolve to it; the runner reads
  its shards and delivers each, but moto does not reshard.
- **Authorizers cover five kinds.** An HTTP API `REQUEST` authorizer with
  simple responses runs the real function and carries every configured
  `$request.header.*` or `$request.querystring.*` identity source in order; an
  HTTP API JWT authorizer and a REST Cognito user-pool authorizer validate the
  token against the issuer's JWKS; a REST TOKEN or REQUEST Lambda authorizer and
  an HTTP API IAM-policy Lambda authorizer run the real function and match its
  returned policy against the method or route ARN. IAM authorization and
  `$context`/`$stageVariables` identity sources fail closed rather than
  bypassing a real authorization decision. Cognito's hosted UI/OAuth flows are
  not served, so a token must come from the pool's API (`InitiateAuth`) or a
  local test issuer.
- **IAM policy evaluation** remains a docs/125 true limit. SSM parameters,
  Secrets Manager secrets and their resource policies, SNS topic policies,
  Cognito user pools and KMS keys are provisioned, but a policy attached to
  them is not evaluated. A `ResourcePolicy` or `TopicPolicy` is reported under
  `skipped`.
- **Cognito hosted UI/OAuth domain** is not served. The runner serves the user
  pool issuer and JWKS (for JWT validation) but a `UserPoolDomain` is reported
  under `skipped`.
- **SNS delivery is a single attempt.** A publish fans out to every matching
  Lambda, SQS and loopback HTTP subscription, but a failed target is reported
  with its error and is not retried; AWS applies the subscription's delivery
  policy and dead-letter queue. SMS, email and mobile push remain out of scope,
  and a Lambda or HTTP(S) subscription to a FIFO topic is refused because SNS
  itself does not support it. A subscription filter policy is evaluated when
  the publish is observed, so the local runner does not model SNS's eventual
  consistency for a policy changed while messages are in flight.
- **S3 event notifications are observed, not emitted by the store.** s3proxy
  has no server-side event hook, so the runner watches the bucket with
  `ListObjectsV2` and derives the record from the observed object state. An
  observed create is reported as `ObjectCreated:Put` and an observed delete as
  `ObjectRemoved:Delete`; a create and a delete inside one 250 ms poll is not
  observed. S3 → EventBridge emission is delivered by the runner and proven by
  the import-pipeline row.
- **Managed services** remain L3 gaps where the examples use them: the MicroVM
  provider in the controller and conformance rows, and S3 Vectors/Bedrock in
  the semantic-search row. The runner stops at those boundaries; it never fakes
  a success.
- **One container per function.** In-flight invocations are bounded to 32 and
  queue behind the function's container; delivery batches for the same
  function also serialize there, even when a mapping's `MaximumConcurrency`
  allows two batches to be in flight. The local runner is not a load test.

## Requirements

- Go 1.27+ to build or run the `apptheory-local` command. TypeScript and Python
  handlers never need Go: they run in their own runtime images.
- Node.js 24+ when a served CloudFront distribution has CloudFront Functions.
  The function code runs in the host Node `vm`; the runner refuses to start that
  distribution if Node is not on `PATH`.
- Docker (on macOS, colima) with the daemon running. The runner creates one
  private network per run and publishes the RIE port on `127.0.0.1` only.
- The app's CDK CLI installed in the app directory
  (`node_modules/.bin/cdk`); run `npm install` there once, or `npm ci` when the
  app has a lockfile. The runner does not install packages.
- Bind-mounted code must live under `$HOME` or the working directory (the
  checkout): colima does not share `/private/tmp`. The runner refuses a mount
  outside those roots.
- **Delivery sizing.** The reference host is colima with 4 CPUs and about 6 GB,
  shared by the runtime images, the emulator containers and the HTTP transport.
  `--delivery-concurrency` defaults to `4`: one in-flight delivery per CPU
  leaves a core for the emulators and the transport, and a larger bound only
  queues behind the one container per function. Raise it only on a larger host;
  values above 32 are refused because the runtime interface emulator and
  Docker's port allocation become unreliable.

## Where to next

- [Local examples harness](/examples/local-harness/) — the classification
  manifest and `make examples-local`.
- [Local runner configuration](/reference/local-runner-configuration/) — flags,
  profile schema and the exact container environment and events the runner
  generates.
