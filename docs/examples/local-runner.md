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
CloudFront emulator: there is no edge network and no TLS.

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

A fresh checkout needs the repository's two dependency trees before a CDK
example synthesizes. The examples import `cdk/` as a file dependency and their
bundling steps use the TypeScript runtime, so without them `cdk synth` fails
with a bare `ts-node` error:

```bash
(cd cdk && npm ci)
(cd ts && npm ci)
```

`make examples-local` installs both through the repository's own contract; the
commands above run from this repository. An app that lives anywhere else uses
the same command; `--app` is the app's CDK directory and `--profile` pins the
runtime images:

```bash
# Run a released module without checking out AppTheory.
go run github.com/theory-cloud/apptheory/v7/cmd/apptheory-local@<version> \
  --app ~/code/my-app --profile ~/code/my-app/local-profile.json

# Or install the command once.
go install github.com/theory-cloud/apptheory/v7/cmd/apptheory-local@<version>
apptheory-local --app ~/code/my-app --profile ~/code/my-app/local-profile.json
```

`<version>` is a release that contains the command (v7.0.0 or later; the module
path is `/v7`); `go list -m -versions github.com/theory-cloud/apptheory/v7`
lists released versions. v7.0.0 is the first release that contains
`apptheory-local`.

Run the command from a sibling AppTheory checkout when developing the runner
itself (the same model as FaceTheory Phase 3):

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
function Handler… (nodejs24.x, public.ecr.aws/lambda/nodejs:24@sha256:…) ready on the runner's Runtime API at http://127.0.0.1:49xxx
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

The `http://127.0.0.1:<port>` on the `function …` line is the runner's own
Runtime API address for that function — how the container reaches the runner,
not the app URL. Under `--rie` the runner starts the image's Runtime Interface
Emulator instead and the same line reads `ready on 127.0.0.1:<port> (Runtime
Interface Emulator mode)`; that port is the emulator's. Stop the run with
`Ctrl-C` (`SIGINT`) or `SIGTERM`; the command closes the listeners, removes its
containers and network, deletes the scratch directory and exits 0.

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
   under the run scratch directory, every function's layers are merged into one
   `/opt` directory in the template's listed order, then the run's private
   Docker network is created. An opted-in run (`--tls`) then loads or creates
   its local CA and prepares the public certificate it will serve; a run
   without the opt-in starts no CA. See
   [Local HTTPS, OIDC issuers and passkeys](#local-https-oidc-issuers-and-passkeys).
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
   published host port is reported ready without this wait. When moto and
   s3proxy are up, the runner also starts its two service fronts: the KMS front
   (the key families it owns, DIGEST signing and `--data-dir` material) and the
   S3 front (SSE-S3), both on loopback listeners the function containers reach
   through `host.docker.internal`; see
   [KMS signing and key material](#kms-signing-and-key-material) and
   [S3 objects and server-side encryption](#s3-objects-and-server-side-encryption).
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
   EventBridge rule targets and Lambda log-subscription destinations. A zip
   function uses the official image for its runtime, digest-pinned in the
   profile; a container-image function is built from its CDK `DockerImageAsset`
   by the real `docker build` before any listener starts serving. Handlers talk
   to the runner's Lambda Runtime API (`AWS_LAMBDA_RUNTIME_API` points at it);
   `--rie` runs them under the image's embedded emulator instead. See
   [Lambda Runtime API](#lambda-runtime-api).
10. **Serve, invoke or session.** One loopback listener per API (and per
    Function URL) builds the provider event for the matched route, runs a
    CUSTOM request authorizer first when the route declares one, invokes the
    handler and decodes the response. A streamed response is forwarded as the
    runtime writes it, including the metadata prelude for a Function URL or a
    REST API proxy integration. One gateway listener per servable CloudFront distribution serves the
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

### Stage-prefixed URLs

A REST API's execute-api base URL is
`https://{restapi_id}.execute-api.{region}.amazonaws.com/{stage_name}/`
([invoke a REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-call-api.html)).
An HTTP API's "$default stage ... is served from the base of your API's URL";
a named stage is part of the URL, so it is served under `/{stage}`
([HTTP API stages](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-stages.html)).
The runner serves both forms on the same listener:

| Request | Served as |
| --- | --- |
| `GET /hello` on a named-stage API | The root (custom-domain) form. |
| `GET /prod/hello` on a REST API with stage `prod` | The `prod` stage form; the route table matches `/hello`. |
| `GET /dev/hello` on an HTTP API with stage `dev` | The `dev` stage form; the route table matches `/hello`. |
| `GET /hello` on an HTTP API with the `$default` stage | The root; `/$default/hello` is not served. |

The `/{stage}` form is tried first: a path that matches both the stage
remainder and a literal root route resolves to the stage form, and the root
form is matched only when the remainder matches no route. The event the
handler sees carries exactly the documented fields:

- REST v1: `path` and `resource` are the resource path without the stage, while
  `requestContext.path` includes it (`/prod/hello`); `requestContext.stage` is
  the stage name.
- HTTP API v2: `rawPath` and `requestContext.http.path` include the stage
  (`/dev/hello`); `requestContext.stage` is the stage name. The payload-format
  page says "Format 2.0 has rawPath" and, for a custom-domain API mapping,
  "rawPath won't provide the API mapping value"
  ([HTTP API Lambda integrations](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)).
- The REST proxy-integration event fields are the ones the page defines:
  `path` is "The request path" and `requestContext.path` is the path API
  Gateway used, with the stage for a stage-prefixed URL
  ([REST proxy integrations](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html)).

`plan` prints both forms on the route line, for example
`GET /hello (also /prod/hello) -> Handler`.

## Local HTTPS, OIDC issuers and passkeys

An OAuth 2.0 authorization server's issuer identifier is "a URL that uses the
`https` scheme and has no query or fragment components", and its JWK set URI
must use `https` ([RFC 8414 §2](https://www.rfc-editor.org/rfc/rfc8414#section-2)).
OpenID Connect Discovery publishes the same issuer in the metadata
([OpenID Connect Discovery §3](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata)).
A WebAuthn RP ID is a valid domain string, and it must be equal to the caller
origin's effective domain or a registrable suffix of it
([WebAuthn Level 3 §5.1.3](https://www.w3.org/TR/webauthn-3/#rp-id)). Both rules
are why a plain-HTTP listener cannot serve a real OIDC issuer or a passkey
ceremony, and why Autheory (the first application consumer) correctly refuses a
non-`https` issuer.

`--tls` makes the runner serve every public listener over HTTPS. It is off by
default: an existing caller keeps the same `http://127.0.0.1:<port>` URLs,
ports, listeners and outputs.

### Opt in

The opt-in is committed configuration, never an operator environment variable:

- `--tls` on `run` or `session`; or
- `"tls": {"enabled": true}` in the checked-in local profile the run loads
  (`scripts/local/examples-local.json` in this repository; an app can ship its
  own profile). `"host"` sets the public name (default `app.localhost`).

`--tls-host <name>` overrides the public name for one run. The name must be
`localhost` or a single `*.localhost` label. It is the OIDC issuer host and the
WebAuthn RP ID, so the runner refuses any other domain instead of producing a
certificate a browser would not scope correctly.

A `*.localhost` name is a potentially trustworthy origin by specification: the
Secure Contexts algorithm treats `localhost` and names ending in `.localhost` as
potentially trustworthy, and `https`/`wss` origins unconditionally
([Secure Contexts §3.1](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)).
Resolution is the operating system's job: macOS resolves the whole
`.localhost` tree to loopback, and systems using systemd-resolved do the same on
Linux ([RFC 6761 §6.3](https://www.rfc-editor.org/rfc/rfc6761#section-6.3)).
Browsers resolve `.localhost` internally. Inside a function container the runner
adds the public name to the container's hosts file through the same
`host.docker.internal` helper it uses for every control endpoint.

### What changes

With the opt-in, every public listener serves HTTPS and reports an `https://`
(or `wss://`) URL on its `serving …` line:

| Surface | Opted-in URL |
| --- | --- |
| HTTP API v2 | `https://app.localhost:<port>` |
| REST API v1 | `https://app.localhost:<port>` (and `/<stage>/…`) |
| Function URL | `https://app.localhost:<port>` |
| WebSocket API | `wss://app.localhost:<port>/<stage>` |
| CloudFront distribution | `https://app.localhost:<port>` |

The TLS listener offers HTTP/1.1 and, when the client offers it, HTTP/2 (ALPN
`h2`); a WebSocket upgrade stays on HTTP/1.1 as RFC 6455 requires. The
certificate names the run's public host and both loopback addresses, and the
listener presents it for that host only: a client that connects with another
name fails certificate verification, which is the SNI-correct behaviour. The
runner's internal control endpoints (the EventBridge bus, the KMS and S3 fronts,
the CloudFront invalidation API, the CodeBuild API) stay on loopback HTTP; the
`@connections` management API was already TLS and now uses the run CA.

### The CA and where it lives

The runner generates an ECDSA P-256 key and a self-signed X.509 v3 CA on first
use, then issues one server certificate per run:

- the CA sets `basicConstraints` CA and `keyUsage` keyCertSign/cRLSign, as
  RFC 5280 requires ([§4.2.1.9](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.9),
  [§4.2.1.3](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.3));
- the server certificate carries the DNS names and loopback IP addresses in
  `subjectAltName` (browsers ignore a Common Name) and the `serverAuth` extended
  key usage; Apple documents all three requirements for TLS server certificates
  ([Apple support 103769](https://support.apple.com/en-us/103769));
- the CA lives 825 days; the server certificate lives 197 days, under the
  200-day cap the CA/Browser Forum Baseline Requirements set for subscriber
  certificates from 2026-03-15
  ([§6.3.2](https://cabforum.org/working-groups/server/baseline-requirements/requirements/)).

Nothing prints private key material. The runner logs the CA path, the trust
bundle path and whether the CA is persistent; a session reports the same values
under `tls` in `describe`:

```json
"tls": {"enabled": true, "host": "app.localhost",
        "caFile": "/…/tls/ca.pem", "trustBundle": "/…/tls/trust-bundle.pem"}
```

With `--data-dir`, the CA is persistent and byte-for-byte stable across runs:

```
<data-dir>/tls/ca.pem        0644
<data-dir>/tls/ca-key.pem    0600
<data-dir>/tls/trust-bundle.pem 0644
```

The `tls` directory is `0700`. A browser or identity provider that trusted run 1
trusts run 2. Without `--data-dir` the CA lives under the run's scratch
directory and is deleted with it, like every other piece of run state.

### Trust it from the host

A client verifies the run's certificate when it trusts the CA. Point the client
at the CA (or at `trust-bundle.pem`, which contains it):

```bash
# curl
curl --cacert <data-dir>/tls/ca.pem https://app.localhost:<port>/health
# or: export CURL_CA_BUNDLE=<data-dir>/tls/ca.pem

# Go: the default transport reads SSL_CERT_FILE through crypto/x509
SSL_CERT_FILE=<data-dir>/tls/ca.pem go run ./client
# https://pkg.go.dev/crypto/x509#SystemCertPool

# Node: the extra CA is added to the default trust store at startup
NODE_EXTRA_CA_CERTS=<data-dir>/tls/ca.pem node client.mjs
# https://nodejs.org/api/cli.html#node_extra_ca_certsfile

# Python: ssl.create_default_context() reads SSL_CERT_FILE; requests reads
# REQUESTS_CA_BUNDLE
SSL_CERT_FILE=<data-dir>/tls/ca.pem python3 client.py
REQUESTS_CA_BUNDLE=<data-dir>/tls/ca.pem python3 requests_client.py
# https://docs.python.org/3/library/ssl.html#ssl.create_default_context
# https://requests.readthedocs.io/en/latest/user/advanced/#ssl-cert-verification
```

Playwright/Chromium needs no system trust-store change. Launch Chromium with
the run leaf's SPKI allowlisted, which is Chromium's per-key certificate-error
override
([command-line flags](https://www.chromium.org/developers/how-tos/run-chromium-with-flags/)):

```bash
SPKI="$(openssl s_client -connect app.localhost:<port> -servername app.localhost </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | base64)"
# Playwright: chromium.launch(args=[f"--ignore-certificate-errors-spki-list={SPKI}"])
```

The pin covers exactly the run's leaf key: another key still fails, and no
store is modified. `ignoreHTTPSErrors` is a broader alternative; the harness's
browser row uses the SPKI pin so the row proves the run's own certificate.

### Inside the function containers

Every function container mounts the run CA at
`/etc/apptheory-local/ca.pem`. The runner exports only the variables the
container's runtime actually reads, because one of them is not interchangeable:

| Runtime | Variables | How the runtime reads them |
| --- | --- | --- |
| Go (`provided.al2023`) | `SSL_CERT_FILE`, `CURL_CA_BUNDLE` | `crypto/x509` loads `SSL_CERT_FILE` into the system pool, which is the pool a default transport — and therefore a handler's own `&http.Client{}` — verifies against ([`x509.SystemCertPool`](https://pkg.go.dev/crypto/x509#SystemCertPool)). |
| Node (`nodejs24.x`) | `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE` | Node adds `NODE_EXTRA_CA_CERTS` to its default trust store at startup ([Node CLI](https://nodejs.org/api/cli.html#node_extra_ca_certsfile)); the AWS SDK for JavaScript v3 uses Node's TLS stack and reads no CA-bundle variable of its own. |
| Python (`python3.14`) | `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`, `CURL_CA_BUNDLE` | OpenSSL's default verify paths read `SSL_CERT_FILE` ([`ssl.create_default_context`](https://docs.python.org/3/library/ssl.html#ssl.create_default_context)), `requests` reads `REQUESTS_CA_BUNDLE`, and boto3/botocore read `AWS_CA_BUNDLE` and apply it through their own session ([custom trust store](https://docs.aws.amazon.com/sdkref/latest/guide/feature-custom-trust-store.html)). |

A **container-image function** declares no runtime — it brings its own — so it
receives the union of those sets. The runner cannot know which runtime the image
speaks, and handing every variable to an image that ignores some of them is the
only fail-safe choice.

**A Go container never receives `AWS_CA_BUNDLE`.** The AWS SDK for Go v2 reads
that variable during config loading and can only apply it through its own
`*awshttp.BuildableClient`. A handler that supplies its own `*http.Client` — the
shape a table mapper such as TableTheory or DynamORM uses — fails before any
call:

```
unable to add custom RootCAs HTTPClient, has no WithTransportOptions, *http.Client
```

That is `resolveCustomCABundle` in the SDK
([`config/resolve.go`](https://github.com/aws/aws-sdk-go-v2/blob/config/v1.33.13/config/resolve.go)).
Go does not need the variable: `SSL_CERT_FILE` is the mechanism Go reads, and the
same file is already the bundle every other variable points at. A Go handler
that builds an SDK client with its own `*http.Client` therefore initializes and
verifies the app's https URL with no code of its own.

`CURL_CA_BUNDLE` is in every set because curl is a subprocess a handler can
start on any runtime
([curl `--cacert`](https://curl.se/docs/manpage.html#--cacert)). The runner maps
the public name into the container with the one add-host helper; on Linux, where
the host owns the run network's gateway, the public listener also binds that
gateway, so the container reaches the same `https://app.localhost:<port>` URL a
browser uses. The TLS example's Go, Node and Python callers are the proving
rows, and each of them makes an AWS SDK call in the same invocation.

### CloudFront in front of the run's own API

A distribution in front of the app's own API origin is the second composition
the listener rows do not cover on their own. Deployed CloudFront reaches a
custom origin with the protocol its `OriginProtocolPolicy` declares, and with
`https-only` — the policy an API Gateway origin uses, since API Gateway serves
HTTPS only — **one of the domain names in the certificate must match the origin
domain name**; otherwise CloudFront answers the viewer with 502
([origin settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html#DownloadDistValuesOriginProtocolPolicy)).
The local runner reproduces that rule.

Declare the origin in the app's local CDK branch as a `*.localhost` name and
declare it https-only:

```ts
const apiOrigin = new origins.HttpOrigin("auth-api.localhost", {
  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
});
new cloudfront.Distribution(this, "HostedAuth", {
  defaultBehavior: { origin: apiOrigin, cachePolicy: noCache, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL },
  additionalBehaviors: {
    "/.well-known/*": { origin: apiOrigin, cachePolicy: noCache, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL },
    "/auth/*": { origin: apiOrigin, cachePolicy: noCache, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL },
  },
});
```

Map that domain to the run's own listener. The run's port is the one its
`serving … at https://app.localhost:<port>` line reports:

```bash
apptheory-local run --tls --app ./cdk \
  --origin auth-api.localhost=https://app.localhost:<port>
```

The origin hop then does exactly what the deployed edge does:

- it dials the mapped address, presents the declared origin domain as the TLS
  SNI name, and verifies the chain against the run CA (on top of the system
  roots), so the name it verifies is the one the certificate carries;
- it forwards `Host: auth-api.localhost` — the declared origin domain — unless
  the behavior's cache policy forwards the viewer host, in which case the
  viewer's host travels and the certificate must name it instead;
- the run certificate names every declared custom-origin domain that is a
  `*.localhost` name, so `auth-api.localhost` verifies even though the listener
  is `app.localhost`. A declared origin domain outside that namespace (a real
  host name the local branch kept) is verified against the mapped host instead,
  which is the only name a local certificate can carry.

A plain `http://` mapping to a listener the run serves over TLS is refused
before the distribution starts, naming the declared policy and the mapping to
use, instead of leaving Go's bare `400 Client sent an HTTP request to an HTTPS
server` for the first viewer. If such a request reaches an https listener
anyway, the origin error names the same fix. Existing `http://` mappings to
non-TLS local services keep working exactly as before.

Declare `HTTPS_ONLY` and map `https://`: that is the pair a deployed
distribution in front of an API Gateway endpoint uses, and the pair the runner
verifies. A `HTTP_ONLY` declaration mapped over `http://` to the run's own
listener is refused before the distribution starts — the case that used to
answer a bare `400 Client sent an HTTP request to an HTTPS server` — with the
`HTTPS_ONLY` recovery named. Mapping that declaration over `https://` connects,
because the mapping names the scheme the local hop uses, but it no longer
describes what would deploy.

### Auxiliary services

An app-supplied auxiliary service, such as a local OIDC test IdP, can get its
own certificate from the same CA with a documented command:

```bash
# Create or report the CA that `run --tls --data-dir <dir>` will use.
apptheory-local tls ca --data-dir <data-dir>

# Issue a server certificate for an auxiliary *.localhost name.
apptheory-local tls leaf --data-dir <data-dir> --name idp.localhost --out <dir>/idp
# cert: <dir>/idp/cert.pem
# key:  <dir>/idp/key.pem   (0600)
```

Start the service with those files. The browser reaches it at
`https://idp.localhost:<port>` and trusts it through the same CA; a function
container reaches it when the run maps the name with
`--tls-aux idp.localhost`. On Linux the service must listen on an address the
container can reach: the run network's gateway, or all interfaces. A service
bound to host loopback only is reachable from the host, not from the container.

### Limits

- **No public CA.** The certificate chains to the runner's CA, not a
  publicly-trusted root. It verifies where you install or pin the CA, and
  nowhere else.
- **No edge TLS.** The local CloudFront gateway is not the edge network and has
  no ACM certificate, security policy, minimum protocol version or viewer
  protocol enforcement. Edge TLS certificates are a docs/125 "Real network
  properties" limit; the opt-in secures the listener in front of you, not an
  imagined edge.
- **Origin names are local names.** The run certificate carries the run host,
  the loopback addresses and every declared custom-origin domain that is a
  `localhost` or `*.localhost` name. A distribution that declares a real origin
  domain and maps it locally verifies the mapped host instead; a watch reload
  that adds a new declared origin name keeps the leaf it started with, so
  restart the run to pick it up.
- **One trust set per runtime.** A Go container deliberately gets no
  `AWS_CA_BUNDLE`, because the AWS SDK for Go v2 cannot apply that bundle to a
  caller-supplied client. A Go handler that sets `AWS_CA_BUNDLE` itself, or a
  custom client with its own `RootCAs`, is trusting on its own terms; use
  `SSL_CERT_FILE` or add the run CA to that pool.
- **`@connections` keeps its own certificate in a non-TLS run.** A run without
  `--tls` that serves a WebSocket API still exports `AWS_CA_BUNDLE`,
  `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` for the management endpoint's
  self-signed certificate. That is the pre-existing behaviour and is unchanged
  here; opting in to TLS replaces it with the per-runtime set above.
- **`*.localhost` resolution is the host's.** The specification says such a name
  is potentially trustworthy and RFC 6761 says resolvers should map it to
  loopback, but a host whose resolver does not do so needs an entry (the browser
  and the function container are covered by the browser and the runner).
- **The management and control endpoints keep their own contracts.** The
  `@connections` API is TLS; the EventBridge, KMS, S3, CloudFront invalidation
  and CodeBuild endpoints are loopback HTTP and are not exposed as public
  listeners.

## Lambda Runtime API

Every function container talks to the runner over the Lambda Runtime API. The
runner starts the container with `AWS_LAMBDA_RUNTIME_API` set to its own
listener, so the base image's entry script takes the branch that execs the
runtime interface client and the embedded Runtime Interface Emulator never
runs:

> "`AWS_LAMBDA_RUNTIME_API` – The host and port of the runtime API."
> ([custom runtime requirements](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html))

> The base image entry script "checks for the presence of the
> `AWS_LAMBDA_RUNTIME_API` environment variable": when it is set the script
> execs the runtime interface client directly, otherwise it runs the emulator.
> ([Runtime Interface Emulator](https://github.com/aws/aws-lambda-runtime-interface-emulator))

The listener implements the 2018-06-01 API:

- `GET /2018-06-01/runtime/invocation/next` is a blocking long poll that
  carries `Lambda-Runtime-Aws-Request-Id`, `Lambda-Runtime-Deadline-Ms` ("The
  date that the function times out in Unix time milliseconds"),
  `Lambda-Runtime-Invoked-Function-Arn` (`arn:aws:lambda:<region>:<account>:function:<logical-id>`),
  `Lambda-Runtime-Trace-Id` and `Lambda-Runtime-Invocation-Id`. The GET has no
  timeout: "Do not set a timeout on the GET request as the response may be
  delayed"
  ([runtime API](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html)).
  The client-context and cognito-identity headers are omitted because the runner
  never makes an AWS Mobile SDK invocation.
- `POST /2018-06-01/runtime/invocation/{AwsRequestId}/response` accepts a
  buffered body and a chunked streaming body. The invocation id is optional:
  "The header is optional for backward compatibility with existing
  runtimes—omitting it does not trigger a rejection. Lambda only rejects with
  400 InvalidInvocationId when the header is present but its value does not
  match the active invocation" (same page).
- `POST /2018-06-01/runtime/invocation/{AwsRequestId}/error` is accepted only
  before the response starts: "The runtime can use this endpoint to report
  function or runtime errors to Lambda, which also accepts the
  `Transfer-Encoding` header. This endpoint can only be called before the
  runtime begins sending an invocation response"
  ([custom runtime](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html)).
  Its body is the `ErrorRequest` object
  (`{errorMessage, errorType, stackTrace}`), and the error type carries through
  the `Lambda-Runtime-Function-Error-Type` header.
- `POST /2018-06-01/runtime/init/error` records an initialization failure.
  The `Lambda-Runtime-Function-Error-Type` header is normalized on both
  `/init/error` and `/error`: the page recommends the format
  "`<Category.Reason>`, where `Category` is `Runtime` or `Function` and
  `Reason` starts with an uppercase letter", and "Values that do not match this
  pattern are normalized to `Runtime.Unknown` or `Function.Unknown`"
  ([runtime API](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html)).
  The error type in the runtime's own JSON body is kept as the runtime sent it.
- The response codes are the documented ones: `202 Accepted`, `400 Bad
  Request` (`InvalidInvocationId`), `403 Forbidden` (an answer for an
  invocation that is no longer active) and `500` ("Container error.
  Non-recoverable state. Runtime should exit promptly"). A request the runtime
  would answer twice is a 500 because only one answer per attempt is accepted.
- `GET /runtime/restore/next` and `POST /runtime/restore/error` answer `404`
  with "SnapStart is not enabled for this function": SnapStart is not
  emulated.

One invocation runs at a time per container, which is the default-capacity
contract: "the runtime processes one invocation at a time" outside Lambda
Managed Instances
([custom runtime](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html)).
The runner serializes invocations to a container, so a delivery batch and an
HTTP request for the same function queue rather than racing.

### Lifecycle

The runtime's first `next` request is the end of the Init phase: "The Init
phase ends when the runtime and all extensions signal that they are ready by
sending a Next API request"
([execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)).
A timeout, a crash and an initialization failure end the execution environment,
and the runner replaces it for the next invocation, as the page describes:

> "If the Lambda function crashes or times out during the Invoke phase, Lambda
> resets the execution environment." The reset "behaves like a Shutdown event".
> If the environment is used again, "Lambda re-initializes the extension and
> runtime together with the next invocation."
> ([execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html))

The documented shapes the invoker sees:

- **Timeout.** The invocation fails with `errorType: Sandbox.Timedout` and the
  page's message form: `Task timed out after 3.00 seconds`, prefixed with the
  invocation's timestamp and request id (the form of the logged line on the
  troubleshooting page).
- **Initialization failure.** A module that throws during initialization calls
  `/runtime/init/error` and exits; the invocation fails with that error's type
  and message. "If an error occurs, call the initialization error API and exit
  immediately" ([custom runtime](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html)).
  A runtime process that exits before calling `next` is reported as
  `Runtime.ExitError` with `Runtime exited with error: exit status N`, the
  documented `Runtime.ExitError` type from the troubleshooting page.
- **Handler error.** A `/error` post reaches the invoker with the error type
  and body, and the runner's existing handler-error contract is unchanged for
  every caller (Function URL, API Gateway, WebSocket, the delivery engine and
  `apptheory-local invoke`).
- **Midstream error.** A streamed response may end with the
  `Lambda-Runtime-Function-Error-Type` and `Lambda-Runtime-Function-Error-Body`
  trailers. "Lambda treats this as a successful response and forwards the error
  metadata that the runtime provides to the client"
  ([custom runtime](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html)).
  The local transports forward the bytes and log the error metadata.

The reserved runtime environment variables are set as the configuration page
lists them
([defined runtime environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html#configuration-envvars-runtime)):
`_HANDLER`, `AWS_LAMBDA_RUNTIME_API`, `AWS_LAMBDA_FUNCTION_NAME`,
`AWS_LAMBDA_FUNCTION_VERSION` (`$LATEST`), `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`
(the function's memory), `AWS_LAMBDA_LOG_GROUP_NAME` (`/aws/lambda/<name>`),
`AWS_LAMBDA_LOG_STREAM_NAME`, `AWS_LAMBDA_INITIALIZATION_TYPE` (`on-demand`),
`LAMBDA_TASK_ROOT`, `LAMBDA_RUNTIME_DIR`, `AWS_REGION`/`AWS_DEFAULT_REGION`
and `TZ`. The image itself supplies `LANG`, `PATH` and `LD_LIBRARY_PATH`.

### Response streaming

A response is streamed when the runtime sends a chunked body; the documented
signal is both the response-mode header and the transfer encoding:

> "Set the `Lambda-Runtime-Function-Response-Mode` HTTP header to `streaming`."
> "Set the `Transfer-Encoding` header to `chunked`."
> ([custom runtime](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html))

The runner accepts either. The Node.js runtime sets both. The Go runtime client
(`aws-lambda-go`) sends only `Transfer-Encoding: chunked`; treating that as a
stream is what lets a Go handler stream through the same listener.

A streamed `/response` body is forwarded to the invoker chunk by chunk as the
runtime writes it. For a Function URL and for a REST API proxy integration the
public format is a metadata JSON prelude, the 8-null-byte delimiter and the
payload; the transport applies the status, headers and cookies as soon as the
prelude is complete:

- Function URL: the prelude uses the same `statusCode`/`headers`/`cookies`
  fields as the buffered response payload
  ([Function URL payloads](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html)).
  A prelude that omits `statusCode` is a `200` with the prelude's headers and
  the payload, the same answer the standalone listener gives a buffered frame.
  A stream without a valid prelude is delivered as a raw `200` body with the
  runtime's `Content-Type`; the Function URL pages do not define that case, so
  the local rule is documented here.
- REST API: "API Gateway begins the payload stream after it receives the valid
  metadata and delimiter from Lambda"; the format is
  `{headers, multiValueHeaders, cookies, statusCode}<DELIMITER>payload`, "The
  delimiter must be 8 null bytes and it must appear within the first 16KB of
  stream data", and "If your function doesn't return either of these headers,
  API Gateway appends `Transfer-Encoding: chunked` to the response header". A
  function whose output does not adhere is a `500`: "API Gateway invokes your
  Lambda function and return a 500 error response"
  ([response transfer mode](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html)).
- CloudFront: when the Function URL origin returns a chunked response,
  "CloudFront returns the object to the client as the object is received at the
  edge location, and caches the object in chunked format for subsequent
  requests"; "If your origin returns this header field, CloudFront sets the
  value to `chunked` before returning the response to the viewer"; a Range GET
  against a chunked response "returns the entire object to the viewer instead
  of the requested range"; and "if the chunked response is not complete,
  CloudFront does not cache the object". The origin response timeout applies
  "after receiving a packet of a response from the origin and before receiving
  the next packet"
  ([custom origin behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html)).
  The local gateway implements those rules: it flushes each chunk, caches the
  object only after the stream completes, does not cache an incomplete stream,
  returns the whole object for a Range GET, and applies the between-packet
  timeout from the origin's `CustomOriginConfig.OriginReadTimeout` (default 30
  seconds, as the page states).
  The Lambda@Edge viewer-response function runs at the prelude, once the status
  and headers are known: its event carries `headers`, `status` and
  `statusDescription`, not the body, so it cannot change the status
  ([event structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html)).
  A Function URL whose `InvokeMode` is `BUFFERED` (the template default)
  returns a complete, non-chunked response, so the origin takes the unchanged
  buffered path and every buffered rule above applies.
  A stream that ends with the `Lambda-Runtime-Function-Error-Type` and
  `Lambda-Runtime-Function-Error-Body` trailers is forwarded to the viewer but
  not cached; the gateway logs the trailer metadata and treats the object as
  incomplete.

Response streaming is available on the Node.js managed runtime and, for other
languages, "you can use a custom runtime with a custom Runtime API
integration"; Python therefore buffers, and the Python conformance case
compares buffered responses only
([response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)).

**Documented deviations.** The runner forwards at the origin's pace; Lambda's
"first 6 MB of your function's response payload has uncapped bandwidth. After
this initial burst, Lambda streams your response at a maximum rate of 2 MBps"
is not reproduced. The maximum response sizes (6 MB buffered, 200 MB streamed)
are not enforced, because enforcing them could fail a local call that succeeds
today.

### Runtime Interface Emulator mode

`--rie` runs each function under the image's embedded Runtime Interface
Emulator instead of the runner's Runtime API. It exists for two cases: comparing
a handler against the emulator, and an image whose entry script ignores
`AWS_LAMBDA_RUNTIME_API`. The mode is reported in `plan` (`runtime: rie …`), in
`plan --json` (`runtimeMode`) and in `session describe` (`runtimeMode` and, per
function, the emulator `port`). It cannot stream incrementally: the emulator
buffers every response, which is why the streaming rows run in the default
mode.

### Conformance suite

`scripts/local/runtime_api_conformance.py` builds one handler set per language
on the real, digest-pinned runtime images (Go on `provided.al2023` via a
`bootstrap`, Node and Python) and runs each case twice through the runner's own
`invoke` path: once with `--rie` and once with the default Runtime API. It
compares status, headers, body bytes, handler error type and message, the
timeout outcome and the initialization-failure outcome, and it reports every
remaining difference with the page that decides which mode is right. The suite
is also a harness row (`make examples-local`), class L2:

```bash
python3 scripts/local/runtime_api_conformance.py \
  --runner ~/.cache/apptheory-examples-local/bin/apptheory-local \
  --profile scripts/local/examples-local.json
```

Cases: a buffered JSON response, a proxy response with headers and cookies, a
handler error, an initialization failure, a timeout, a Node.js
`streamifyResponse` stream and a Go `io.Reader` stream; Python is buffered only
for the reason quoted above.

Observed emulator deviations (the runner follows the page, not the emulator):

- a timeout is a `200` plain-text `Task timed out after N.NN seconds` body in
  the emulator; the page's client-visible shape is an error with
  `errorType: Sandbox.Timedout`;
- an initialization failure is a `502` with the raw error body in the emulator;
  the runner reports the `init/error` type and message (or `Runtime.ExitError`
  when the runtime exits before `next`);
- the emulator buffers every response, so it has no chunk timing to compare;
- the emulator does not implement `/runtime/restore/*`; both modes answer 404.

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
  `GetSecretValue` reads the secret the runner created. `KmsKeyId` is a
  CloudFormation string property: a literal is passed through, and a `Ref` or
  `Fn::GetAtt` naming a provisioned key is resolved to that key's ARN or id
  before `CreateSecret`.
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
  `KeyUsage SIGN_VERIFY` support `Sign`, `Verify` and `GetPublicKey`; symmetric
  `SYMMETRIC_DEFAULT` keys support `Encrypt`, `Decrypt`, `GenerateDataKey` and
  `ReEncrypt`. See [KMS signing and key material](#kms-signing-and-key-material)
  for the DIGEST rule and `--data-dir` persistence.

### KMS signing and key material

The runner serves a small KMS front at the injected `AWS_ENDPOINT_URL_KMS`.
It owns the material for the two key families applications create in practice
and proxies every other operation, and every other key type, to moto
unchanged:

| Key family | Operations the front serves |
| --- | --- |
| `SYMMETRIC_DEFAULT` with `ENCRYPT_DECRYPT` | `CreateKey`, `Encrypt`, `Decrypt`, `ReEncrypt`, `GenerateDataKey`, `GenerateDataKeyWithoutPlaintext` |
| `RSA_2048/3072/4096` and `ECC_NIST_P256/P384/P521` with `SIGN_VERIFY` | `CreateKey`, `Sign`, `Verify`, `GetPublicKey` |

`CreateKey`, `DescribeKey`, aliases, tags, key policy, rotation, grants and
every operation on a key the front does not own still go to moto, so
`KeyMetadata` is what v7.0.0 returned; under `--data-dir` the front substitutes
the persisted `KeyId` and `Arn` for an owned key (see below).

**`MessageType: DIGEST`.** AWS defines `DIGEST` as "the message is a digest,
and KMS signs it as-is", and `RAW` as a message KMS hashes with the signing
algorithm's digest
([Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html),
[Verify](https://docs.aws.amazon.com/kms/latest/APIReference/API_Verify.html)).
The pinned moto 5.2.5 ignores `MessageType` in both calls and hashes the
supplied value again; every moto release through master still does (its
`verify` docstring says the parameter is "not yet implemented"), so no image
bump can fix it. The front therefore signs the digest as-is and hashes a `RAW`
message exactly as before. It covers `RSASSA_PKCS1_V1_5_SHA_256/384/512`,
`RSASSA_PSS_SHA_256/384/512` and `ECDSA_SHA_256/384/512` with the curve AWS
pairs with each digest. A `DIGEST` of the wrong length is a
`ValidationException`.

**`--data-dir` key material and identity.** Ciphertext is bound to the key that
produced it, and a KMS key's material is part of the key; AWS never rotates it
implicitly
([Decrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html),
[key material](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#key-material)).
moto is memory-only, so without help a key re-created from the CDK definition
on the next start would have new material and the previous run's ciphertext
could not be decrypted. With `--data-dir`, the front persists the material
under `<dir>/kms/keys.json` (mode `0600`) and reuses it for the same
`stack/logicalId`. It also keeps the key's public identity: moto re-creates the
key, but the front reports the `KeyId` and `Arn` recorded in run 1, because a
KMS key's id and ARN are permanent for the key's lifetime
([key identifiers](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#key-id)).
A caller that pins either (Autheory derives its JWKS `kid` from the key) keeps
working after a restart. The material, `GetPublicKey`, `KeyId` and `Arn` are
stable; the rest of moto's metadata, notably `CreationDate`, reflects the
current run. Without `--data-dir` the front keeps the material in memory,
exactly as before. The ciphertext envelope binds the stable key id and the
encryption context, so a ciphertext written in run 1 decrypts in run 2 and a
different context does not. Deleting the data directory discards the material
and makes old ciphertext unreadable, as deleting a key would.

The runner tags each key it provisions with the reserved local tag
`apptheory-local:key-identity`; the front consumes it before moto sees the
request, so `ListResourceTags` and the template's own tags are unchanged. With
a caller-supplied `--endpoint kms=…` no front runs, so the tag is not sent and
the endpoint stores exactly the template's tags, as v7.0.0 did.

**Documented local deviations.**

- The front's ciphertext is its own opaque envelope (magic, stable key id,
  GCM nonce, tag and ciphertext). Callers pass it back to `Decrypt`; it is not
  an AWS-format blob and cannot be decrypted by AWS.
- Key types outside the two families above are not owned: `HMAC_*`,
  `RSA_*` with `ENCRYPT_DECRYPT`, and `ECC_SECG_P256K1`/`SM2` signing keys keep
  moto's behavior. Their material is not persisted, and `DIGEST` is not served
  for them.
- A persisted key keeps its `KeyId` and `Arn`, so the run-1 id or ARN is a
  valid identifier in a later run; `Decrypt` also accepts no `KeyId` (the
  ciphertext names the stable key). moto's own per-run id is an internal
  detail and is not a supported cross-run identifier. The remaining moto
  metadata, notably `CreationDate`, still reflects the current run. A key
  created at runtime (no CDK definition) is memory-only and is not persisted,
  as docs/125 records.
- A `--data-dir` that names a key with a different `KeySpec` or `KeyUsage` than
  the definition now fails at start with the identity and both pairs named,
  rather than silently reusing incompatible material.
- A persisted key resolves from its raw id or from a key ARN in the local
  partition, Region and account
  (`arn:aws:kms:us-east-1:123456789012:key/<id>`), as AWS accepts a key ARN
  only for a key that exists in the named account and Region
  ([key identifiers](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#key-id)).
  A foreign ARN with the same `:key/` suffix does not reach the persisted key.
  The current run's moto keys keep moto's suffix-only ARN handling, which
  v7.0.0 served.
- `Sign` and `Verify` on an owned key whose `KeyUsage` is not `SIGN_VERIFY`
  answer `InvalidKeyUsageException`, as AWS documents
  ([Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html),
  [Verify](https://docs.aws.amazon.com/kms/latest/APIReference/API_Verify.html));
  moto answered `ValidationException` for the same input.

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
- `SecretStringTemplate` and `GenerateStringKey` are optional
  ([reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-secretsmanager-secret-generatesecretstring.html)).
  With both, the template must be a JSON object, the generated string is stored
  under the key and the resulting JSON is the secret string. With neither, the
  generated password is the whole secret string. A key without a template keeps
  the v7.0.0 value (the template defaults to `{}`, so the generated password is
  stored under the key) and is reported as one warning line naming the secret
  and the AWS pairing rule: "If you specify this parameter, then you must also
  specify `SecretStringTemplate`". A template without a key is refused, as
  v7.0.0 did: the generated password would have no key to be stored under.

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
- **KMS `MessageType`.** The pinned moto ignores `MessageType` in `Sign` and
  `Verify` and hashes a supplied digest a second time; every release through
  master still does. The runner's KMS front signs a `DIGEST` as-is and hashes a
  `RAW` message exactly as before; the material it owns and the deviations are
  listed under [KMS signing and key material](#kms-signing-and-key-material).
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
(`POST`/`GET`/`DELETE /{connectionId}`) that binds loopback and, when the host
owns the run network's gateway (the Linux bridge case), that address too; a
function container reaches it through `host.docker.internal` (Docker's
`host-gateway` forwards to the host loopback on Colima and Docker Desktop). The
listener never binds the unspecified address. The session reports the loopback
URL (`https://127.0.0.1:<port>`) and the harness uses that, while the
container-facing URL is `https://host.docker.internal:<port>`. The listener is
unauthenticated. The endpoint is
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
  on the run clock (CloudFormation's default is 300; `0` disables the cache; the
  documented maximum is 3600), so `--clock test` plus `clock.advance` expires a
  cached policy.
- The cache holds the authorizer's **policy**, not a per-request decision:
  "If you enable authorization caching, API Gateway caches the policy so that
  the Lambda authorizer function isn't invoked again. Ensure that your policy is
  applicable to all resources and methods across your API." On a hit the cached
  policy is matched against the current request's method ARN, so a policy that
  names only `/a` refuses `/b` with 403 without invoking the function.
- The returned policy is matched against the request's method ARN with the same
  narrow Allow/Deny match the `$connect` authorizer uses. An Allow invokes the
  method, a Deny is **403** outside the API Gateway test environment, the
  authorizer's documented `{"errorMessage":"Unauthorized"}` response is **401**
  and any other response shape is **500**. The output must include the principal
  identifier: "A Lambda authorizer function's output is a dictionary-like
  object, which must include the principal identifier (principalId) and a policy
  document (policyDocument)"; a response without it is invalid (500), and an
  invalid response is never cached.
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
cache per route. The cached value is the policy response: "By default, API
Gateway uses the cached authorizer response for all routes of an API that use
the authorizer", so a hit is re-evaluated against the current route's ARN. A
missing identity source is 401, an invalid response (including a missing
`principalId`) is 500 and never cached, and the documented
`{"errorMessage":"Unauthorized"}` response is 401. The authorizer context
reaches the integration as `requestContext.authorizer`.

**Still refused.** IAM authorization (`AuthorizationType: AWS_IAM`), other
`$context`/`$stageVariables` identity sources, and any authorizer kind the
runner does not name above fail closed at plan time with the kind named.

## CloudFront distributions

A distribution in the cloud assembly is served on its own `http://127.0.0.1:<port>`
URL, printed on the `serving cloudfront …` line. The local gateway is the
delivery path a FaceTheory or AppTheory site is tested through; it is **not a
CloudFront emulator: no edge network, no TLS**.

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
them. The
[Expiration page](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html)
TTL rules are applied to the origin response; see
[Caching and invalidation](#caching-and-invalidation). The
`ViewerProtocolPolicy` is reported, not enforced, because the local URL is plain
HTTP; the same is true for compression, access logging, aliases, the viewer
certificate and the distribution's HTTP/IPv6/price-class settings.

The pinned managed policy table and the exact property inventory are in the
[configuration reference](/reference/local-runner-configuration/#cloudfront-distributions).

### Caching and invalidation

A behavior with a cache policy caches the methods its `CachedMethods` lists
(GET and HEAD by default), and a CachingDisabled policy always reaches the
origin. The cache key is the distribution domain plus the URL path, extended by
the query strings, headers and cookies the policy names. "The OPTIONS method is
included in the cache key for OPTIONS requests. This means that responses to
OPTIONS requests are cached separately from responses to GET and HEAD requests":
GET and HEAD share one key, a HEAD is answered from the GET-stored object
without a body, and a HEAD response is never stored. `s-maxage` wins over
`max-age` and `max-age` wins over `Expires`; `no-cache`/`no-store`/`private` are
not cached unless `MinTTL` is above zero, and `MinTTL`/`MaxTTL` bound the result.
Viewer `Cache-Control` and `Pragma` are ignored. `stale-while-revalidate` serves
the stale object while the gateway refreshes it, and `stale-if-error` serves it
when the origin fails; both windows end at the behavior's `MaxTTL`: "CloudFront
will serve the stale content up to the value of the stale-while-revalidate
directive or the value of the CloudFront maximum TTL, whichever is less." A 5xx
response for an expired object also serves the stale object, for the error
caching minimum TTL (extended by `stale-if-error`), never past `MaxTTL`; a 4xx
response is returned instead of the stale object.

Error responses follow the HTTPStatusCodes page's status table, not "any 4xx or
5xx": 404, 414, 500, 501, 502, 503 and 504 are cached without a header; 400,
403, 405, 412 and 415 "only ... if your origin returns a Cache-Control max-age
or Cache-Control s-maxage header"; every other status (401, 429, ...) is not
cached. The duration is "the maximum of" the error caching minimum TTL (10
seconds by default, or the matched custom error response's `ErrorCachingMinTTL`)
and the origin response's max-age, s-maxage or `Expires` value, capped by the
behavior's Maximum TTL. For a custom error page the cap is the Maximum TTL of
the behavior the page is fetched through — the page's behavior when an explicit
behavior matches the page path, otherwise the request's behavior: "The
Cache-Control: max-age and Cache-Control: s-maxage values cannot be greater than
the Maximum TTL value set for the cache behavior for which the error page is
being fetched." An explicit `ErrorCachingMinTTL` of 0 disables error caching for
a custom origin and means one second for an S3 origin. A CachingDisabled policy
caches neither errors nor custom error pages, including when it is the page's
fetching behavior.

A hit answers `x-cache: Hit from cloudfront` with an `age` in seconds; a miss
answers `x-cache: Miss from cloudfront`. `session describe` reports each
behavior's hit and miss counts and every invalidation.

**Custom error responses.** `CustomErrorResponses` is served: the gateway finds
"the first cache behavior in your distribution that has a path pattern that
matches the path of the custom error page" and fetches `ResponsePagePath` from
"the origin that is specified in the cache behavior", with that behavior's
origin request policy, then returns the page with `ResponseCode`. When a cache
behavior (not just the default behavior) matches the page path, "CloudFront uses
the cache behavior TTL instead" of the error caching minimum. If the page is
unavailable, "the status code that CloudFront received from the origin that
contains the custom error pages" is returned, i.e. the pages origin's status. A
custom page is cached under the same status/header rule as its `ErrorCode`.

**Invalidation.** The run serves `CreateInvalidation`, `GetInvalidation` and
`ListInvalidations` on a control endpoint that binds loopback and, when the host
owns the run network's gateway, that address too; it is injected into every
function as `AWS_ENDPOINT_URL_CLOUDFRONT`; `run` prints the
`127.0.0.1` URL and `session describe` reports it. A
batch may list at most 3000 paths, every path begins with `/`, is case
sensitive, is URL-decoded before matching and is at most 4000 characters; a `~`
is refused. "The *, which replaces 0 or more characters, must be the last
character in the invalidation path"; an asterisk anywhere else is a literal
character. A path is matched against the cached path plus the query string the
cache policy forwarded, so `/a.js` does not invalidate an entry cached under
`/a.js?v=1` while `/a.js*` does. Reusing a `CallerReference` with the same paths
returns the previous invalidation; with a different path it is
`InvalidationBatchAlreadyExists`. An invalidation removes the matching objects,
so the next request is a miss.

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
  `cookies`, `isBase64Encoded` and `body` back. A return value without a
  `statusCode` follows the page's inference rule on every local Function URL
  surface: valid JSON is a `200` with `content-type: application/json` and the
  function response as the body, while an error payload stays the documented
  `502` ([Function URL payloads](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html)).
  The standalone listener (buffered, and a buffered response on a
  `RESPONSE_STREAM` URL) decodes through the same rule, and a streaming prelude
  whose metadata omits `statusCode` is a `200` with the prelude's headers and
  the framed payload. A `RESPONSE_STREAM` function's chunks reach the gateway
  as the runtime writes them; the prelude supplies the status, headers and
  cookies and the payload follows. A `NONE` URL is invoked
  directly. An `AWS_IAM` URL is signed with
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
  503; the gateway never makes an external network request. A mapped origin
  reached over `https://` is verified against the run CA (plus the system roots)
  and against the origin's declared domain when that domain is a local name; see
  [CloudFront in front of the run's own
  API](#cloudfront-in-front-of-the-runs-own-api).

The `ssr-site`, `ssr-only-provided-assets-site`, `path-routed-frontend` and
`media-cdn` example rows run through these origins in the harness; the private
media distribution requires a signed URL or signed cookie, which the row proves
against real keys generated at run time.

Distributions that use a WAF web ACL, a gRPC config or a legacy
`ForwardedValues` cache policy are refused with a named reason; they are listed
under `skipped` and no listener is started. Lambda@Edge, key value stores,
trusted key groups, signed URLs and cookies, field-level encryption and geo
restriction are served (see [Lambda@Edge, key value stores, signed access, geo
restriction and field-level
encryption](#lambdaedge-key-value-stores-signed-access-geo-restriction-and-field-level-encryption));
`TrustedSigners` (AWS-account signers), continuous deployment policies and any
`Restrictions` member other than `GeoRestriction` are refused by name. The cache
policy is applied (see [Caching and invalidation](#caching-and-invalidation));
real-time logs, access logging, `Compress`, the behavior-level legacy
`DefaultTTL`/`MinTTL`/`MaxTTL` fields and edge placement are reported instead.

## Lambda@Edge, key value stores, signed access, geo restriction and field-level encryption

**Lambda@Edge.** A behavior's `LambdaFunctionAssociations` run through the same
runtime container every other Lambda in the assembly uses. The association must
reference an `AWS::Lambda::Version` in the assembly — "The function ARN must
specify the ARN of a function version; you can't specify an alias or $LATEST"
([LambdaFunctionAssociation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-cloudfront-distribution-lambdafunctionassociation.html))
— and a `$LATEST`, alias, literal or unknown ARN is refused by name. A function
with a container image package, layers, a VPC configuration, a dead-letter
queue, provisioned or reserved concurrency, arm64, more than 512 MB of ephemeral
storage, environment variables beyond the reserved ones, or a runtime that is
not Node.js or Python is refused by name from the restrictions page
([Restrictions on Lambda@Edge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)).
`IncludeBody` on a response event is refused by name. A behavior that associates
any CloudFront Function viewer event (viewer request or viewer response) with
any Lambda@Edge viewer event is refused at plan time with both function ids and
events named: "You can't combine CloudFront Functions and Lambda@Edge in viewer
events (viewer request and viewer response)"
([Restrictions on all edge functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html)).

The four triggers run at the documented points
([CloudFront events that can trigger a Lambda@Edge function](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-cloudfront-trigger-events.html)):

- **viewer request** runs when CloudFront receives the request. It does not run
  when fetching a custom error page.
- **origin request** runs only when the request is forwarded to the origin, so
  a cache hit never runs it.
- **origin response** runs after the origin answers, even with an error status,
  and does not run for a fresh cache hit or when an origin-request function
  generated the response.
- **viewer response** runs before the response reaches the viewer, from the
  cache or the origin, and does not run when the origin returned 400 or higher,
  for a custom error page, or for a viewer-request generated response.

The event object is the documented `Records[0].cf` shape
([Lambda@Edge event structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html)):
`config` carries `distributionDomainName`, `distributionId`, `eventType` and
`requestId`; `request` carries `clientIp`, `headers` as lowercase names mapping
to arrays of `{key, value}` (a returned entry without `key` gets initial
capitalization for each part, separated by hyphens), `method`, `querystring`,
`uri` (which must begin with a forward slash and never changes the matched
behavior or origin) and — with `IncludeBody` — a base64 `body` with
`inputTruncated` and `action`. Origin events add `origin.custom` or
`origin.s3` inside `request` (`cf.request.origin`), and their `headers`,
`querystring` and Host are the policy-filtered origin request CloudFront sends,
not the viewer request. A viewer-request function that adds a `CloudFront-*`
header (including `CloudFront-Viewer-Country`) is a 502; a header the viewer
sent is shown to the viewer-request function and, when a cache or origin
request policy forwards it, replaced by the value CloudFront adds for
origin-facing functions. An origin-request function may read, edit, remove or
add the documented CloudFront headers.

A generated response must have a `status` between 200 and 599; the status may
be the documented JSON string (the form the events carry) or a number, and
`bodyEncoding` beside a string `body` selects `text` or `base64`. A viewer-request
generated response is not cached. An origin-request generated response is cached
under the behavior's normal TTL rules and later served from the cache without
running the function
([Generating HTTP responses in a Lambda@Edge trigger](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-generating-http-responses.html)).
A 204 with a body is a 502. The request body exposed with `IncludeBody` is
truncated at 40 KB for viewer events and 1 MB for origin events, and a replaced
body over the limit is a 502; a base64 replacement is limited on its encoded
length, 53.2 KB for a viewer event and 1.33 MB for an origin event. Viewer
events time out at 5 seconds and origin events at 30 seconds on the run clock
([Quotas on Lambda@Edge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-lambda-at-edge)).
An invalid returned object is a 502 and an unhandled exception or timeout is a
503 ([Resolve Lambda@Edge 502 and 503 errors](https://repost.aws/knowledge-center/lambda-edge-500-errors)).
The restrictions page's disallowed headers are stripped from every event, and a
function that adds one is a 502; a read-only header that a function adds,
changes or removes relative to the event it received is a 502, with the header
and the page named
([Restrictions on all edge functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html)).
A `viewer-response` function that changes the status code is a 502, as the
restrictions page requires.

An origin-request function may return a different `origin`; the gateway resolves
its domain to an origin the distribution declares. A domain the assembly does
not declare is a named 502 — the gateway never reaches the internet.

**CloudFront KeyValueStore.** An `AWS::CloudFront::KeyValueStore` is
materialised from its `ImportSource`: the import file is the S3 asset the cloud
assembly carries, in the documented `{"data":[{"key","value"}]}` format
([Create a key value store](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions-create-s3-kvp.html)).
A function's `KeyValueStoreAssociations` makes `cf.kvs()` return a handle whose
`get(key, {format})` (string, json or bytes), `exists(key)` and `meta()`
(`creationDateTime`, `lastUpdatedDateTime`, `keyCount`) return promises, and a
missing key rejects, exactly as the helper page states
([CloudFront Functions custom methods](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-custom-methods.html)).
The store is available only under the JavaScript 2.0 runtime; a 1.0 function
that associates one is refused by name, one store per function is enforced, and
a key over 512 bytes, a value over 1 KB or a store over 5 MB is refused at plan
time. A function without an association that calls `cf.kvs()` fails exactly as
before. `session describe` reports each store with its key count.

**Signed URLs and signed cookies.** A behavior whose `TrustedKeyGroups` is
enabled requires a valid signed URL or signed cookie for every request except
OPTIONS
([Serve private content with signed URLs and signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html)).
The signature is verified against the real public keys of the behavior's key
groups: canned (`Expires`) and custom (`Policy`) policies, SHA-1 by default and
SHA-256 through `Hash-Algorithm`, RSA and ECDSA keys, the documented base64
character replacements (`+`→`-`, `=`→`_`, `/`→`~`), the canned policy JSON with
its whitespace removed, and the `CloudFront-Expires`/`CloudFront-Signature`/
`CloudFront-Key-Pair-Id`/`CloudFront-Hash-Algorithm` (or `CloudFront-Policy`)
cookie names, which are case-sensitive
([Create a signed URL using a canned policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-creating-signed-url-canned-policy.html),
[Create a signed URL using a custom policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-creating-signed-url-custom-policy.html)).
A custom policy's `Resource` is matched against the raw request URL within the
protocol/domain/path/query section boundaries, with the four documented
exceptions (a trailing asterisk in the path also covers the query, a trailing
asterisk in the domain also covers the path and query, an omitted protocol with
a leading asterisk in the domain means a protocol wildcard, and `*` alone
matches any URL). `DateLessThan` and `DateGreaterThan` are evaluated on the run
clock and `IpAddress` is an IPv4 CIDR range; IPv6 is refused as the page states.
A missing, malformed, expired, not-yet-valid, wrong-key or wrong-IP signature is
the documented 403, which is subject to the distribution's custom error response
for 403 and its error caching. A query string added after signing invalidates
the URL. A behavior without trusted key groups stays public, and `TrustedSigners`
(the legacy AWS-account signer form) is refused by name. Each
`AWS::CloudFront::PublicKey` gets a deterministic local `Key-Pair-Id` reported by
`plan` and `session describe`, so an application can sign locally.

**Geo restriction.** `Restrictions.GeoRestriction` is applied from the run's
`--viewer-country XX` flag (ISO 3166-1 alpha-2, upper case) before any viewer
function runs. An allowlist serves only the listed countries, a denylist blocks
them, and `none` does not restrict
([Restrict the geographic distribution of your content](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/georestrictions.html)).
Without the flag the viewer's location is undetermined and the content is
served, as the page states. A blocked viewer gets 403, subject to the custom
error response for 403 and its error caching. When a cache or origin request
policy forwards `CloudFront-Viewer-Country`, the gateway adds it from the same
source
([Add CloudFront request headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html)).
Any other `Restrictions` member is refused by name.

**Field-level encryption.** A behavior linked to an
`AWS::CloudFront::FieldLevelEncryptionConfig` encrypts the fields a profile
selects for a POST whose content type is `application/x-www-form-urlencoded`.
The profile is the content-type profile, overridden by the `fle-profile` query
argument when the configuration allows it; an unknown content type or profile is
forwarded or blocked as the configuration says
([Use field-level encryption](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/field-level-encryption.html)).
Each matching field value is replaced with base64 AWS Encryption SDK ciphertext
that decrypts with the profile's public key's private key under the profile's
provider name, the public key's name and
`RSA/ECB/OAEPWithSHA-256AndMGF1Padding`; the local gateway writes the SDK's
version 1 non-framed message with the `ALG_AES_256_GCM_IV12_TAG16_HKDF_SHA256`
suite. More than ten field patterns, overlapping patterns and characters the
page does not allow are refused at plan time. The page's HTTPS viewer, all-seven
methods and origin-protocol preconditions are reported as a local deviation: the
local viewer is plain HTTP, so the behavior is applied and the requirement is
named in the distribution's report. `FieldLevelEncryptionId` on a behavior that
names no configuration in the assembly is refused by name.

## Lambda layers and container-image functions

**Layers.** A zip function's `Layers` list is resolved from the same cloud
assembly: every entry must be an `AWS::Lambda::LayerVersion` in the function's
stack whose content is a local asset (`aws:asset:path`). The runner extracts the
layers into `/opt` in the template's listed order, and a later layer's file
replaces an earlier one, as
[Adding layers to functions](https://docs.aws.amazon.com/lambda/latest/dg/adding-layers.html)
states. The merged directory is mounted read-only at `/opt`, and the container
environment carries the documented runtime paths with no extra configuration:

- `/opt/bin` is prepended to `PATH`;
- `/opt/lib` is prepended to `LD_LIBRARY_PATH`;
- a Node runtime gets `/opt/nodejs/node_modules` (and
  `/opt/nodejs/node<major>/node_modules`) on `NODE_PATH`;
- a Python runtime gets both documented layer paths on `PYTHONPATH`:
  `/opt/python` and `/opt/python/lib/python<major>.<minor>/site-packages`
  (`python3.14` becomes `/opt/python/lib/python3.14/site-packages`).

A relative symlink whose target stays inside the layer is extracted as the same
symlink, because CDK's default `SymlinkFollowMode.NEVER` stores an asset's
symlinks and `npm install` leaves `node_modules/.bin` shims as symlinks; a
symlink with an absolute target or one that escapes the layer root is refused
by name. A layer asset that is a zip file rather than an extracted directory is
refused because the runner needs the directory.

The five-layer limit is enforced with a named refusal, and a layer ARN that is
not a LayerVersion in the assembly (a cross-stack or external layer) is refused
by name because its content cannot be obtained locally. The
[layers chapter](https://docs.aws.amazon.com/lambda/latest/dg/chapter-layers.html)
advises against layers for Go and Rust because the provided runtime has no
module path to populate; the runner supports them all the same, and the
`lambda-packaging` example uses layers for Node and Python only.

**Container-image functions.** A function with `PackageType: Image` and
`Code.ImageUri` that names a CDK `DockerImageAsset` is built with the real
`docker build` from the asset's directory, Dockerfile, target, platform and
build arguments (all read from the `aws:asset:*` metadata CDK writes). The image
is built before any listener serves a request, so a broken Dockerfile fails the
run instead of failing the first request; the first build of an example takes
roughly 10–60 seconds including the base-image pull, and rebuilds are cached by
Docker's layer cache (a second build of the same asset is near-instant). The
image tag carries the run id as well as the name prefix (the app hash by
default), so two concurrent runs of one app never move each other's tag while
the layer cache still reuses unchanged build steps. The function container runs
the image's own entrypoint. In the default mode the
runner hosts the Runtime API that the image's runtime client connects to, so an
image built on an
[AWS base image](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)
serves the same invocation path as a zip function. With `--rie` the runner
starts the image's own Runtime Interface Emulator instead, and an image that
does not ship one fails with that name and the page cited. Image
functions do not take layers, as the layers chapter states, and that combination
is refused by name. The built image carries the run label and is removed when
the run shuts down.

## CodeBuild

A synthesized `AWS::CodeBuild::Project` is served through AWS's published local
CodeBuild agent. The runner implements the CodeBuild JSON 1.1 API operations an
app or test uses — `StartBuild`, `BatchGetBuilds`, `ListBuildsForProject`
(plus `BatchGetProjects` and `ListProjects`) — on a control endpoint injected
into every function as `AWS_ENDPOINT_URL_CODEBUILD`. `StartBuild` runs the
project's buildspec through the real agent, and every state transition is
published as a "CodeBuild Build State Change" event on the run's EventBridge
bus, so the app's state-change rule delivers it.

The agent and the build image are digest-pinned in the profile. The local agent
is AWS's own image ([use the CodeBuild agent](https://docs.aws.amazon.com/codebuild/latest/userguide/use-codebuild-agent.html)):

| Architecture | Agent image | Manifest digest | Compressed |
| --- | --- | --- | --- |
| aarch64 | `public.ecr.aws/codebuild/local-builds:aarch64` | `sha256:7d7b5d35d2ac4e062ae7ba8c662ffed15229a52d09bd0d664a7816c439679192` | 569 MB |
| x86_64 | `public.ecr.aws/codebuild/local-builds:latest` | `sha256:ccb19bdd7af94e4dc761e4c58c267e9455c28ec68d938086b4dc1cf8fe6b0940` | 1.31 GB |

The local agent takes the build image explicitly, so the profile's class
mapping is a local affordance: no AWS page assigns a local image to a declared
`Environment.Image`. The import-pipeline project declares the CDK default
`aws/codebuild/standard:7.0` (an Ubuntu image that AWS publishes for x86_64
only); on the documented aarch64 host the profile maps it to the Lambda-standard
aarch64 build image:

| Declared image | aarch64 pin | x86_64 pin |
| --- | --- | --- |
| `aws/codebuild/standard:7.0` | `public.ecr.aws/codebuild/amazonlinux-aarch64-lambda-standard:nodejs24` (`sha256:56d1ee8b…`, 1.28 GB compressed) | `public.ecr.aws/codebuild/amazonlinux-x86_64-lambda-standard:nodejs24` (`sha256:e198554f…`, 1.36 GB compressed) |

Both images are distributed under the Amazon Software License 1.0
([aws-codebuild-docker-images](https://github.com/aws/aws-codebuild-docker-images)).
A build that needs the full `standard:7.0` toolchain opts in with
`imageOverride: public.ecr.aws/codebuild/amazonlinux-aarch64-standard:3.0`; the
checked-in profile pins that class (`sha256:af9a0464…`, 4.68 GB compressed,
about 10.9 GB on disk, the same license). The Lambda-standard image stays the
default.

`StartBuild` creates a build id (`<project>:<uuid>`), writes the project's
inline buildspec and environment to the run scratch directory, and runs the
agent container with the Docker socket. The agent uses its own compose project
(a per-build name), starts the pinned build image, and the runner captures the
`[Container]` phase lines. `BatchGetBuilds` reports the build with its phases
(`SUBMITTED`, `QUEUED`, `PROVISIONING`, `DOWNLOAD_SOURCE`, `INSTALL`,
`PRE_BUILD`, `BUILD`, `POST_BUILD`, `COMPLETED`), the status, and the captured
log; `ListBuildsForProject` returns the project's build ids newest first. The
state-change event carries `source: aws.codebuild`,
`detail-type: CodeBuild Build State Change` and
`detail: {build-status, project-name, build-id, current-phase}`; the build id
and project name match the API response and the template's `Ref`. The
import-pipeline row starts the build through the API, observes BUILD and
COMPLETED SUCCEEDED, reads the command log, and receives the SUCCEEDED event on
the example's real SQS rule target.

Deviations, named rather than hidden:

| Feature | Local behaviour |
| --- | --- |
| CodePipeline | Not served; only the CodeBuild project and its state-change rule the example synthesizes run. |
| VPC / EFS / secondary sources | Not connected or fetched. The build container runs on the agent's own Docker network, not the run network, so a build that calls AWS fails closed at `AWS_ENDPOINT_URL=http://127.0.0.1:1`. |
| Cache, artifacts upload, report groups | No cache and no upload; the agent's artifact directory is under the run scratch directory. Report groups are not created. |
| Source | Only `NO_SOURCE` buildspecs run locally; a source type that needs a repository is reported by name. |
| Privileged mode | Reported, not enabled: the build container starts unprivileged. |
| Compute type | `BUILD_GENERAL1_SMALL` only; an override is refused by name. |
| `Environment.EnvironmentVariables` values | A literal, or a CloudFormation expression the plan can resolve, becomes the variable's value: parameters, conditions, `Fn::Join`, and a `Ref`/`Fn::GetAtt` that names a resource in the same stack resolve to the same local name the plan prints for that resource (a table name, a bucket name, a secret ARN). A value that still depends on the deployed stack — `Fn::ImportValue`, a generated key id, an SQS URL that carries the run's endpoint — is named as a deviation on the project and the variable is left out, rather than failing the plan. The `Value` property is a `String` in the AWS schema ([EnvironmentVariable](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-codebuild-project-environmentvariable.html)), which is why an intrinsic here is resolved before the agent sees it. |

**Requirements.** The CodeBuild row pulls the agent and one curated build image.
The aarch64 pair needs about 8 GB of colima disk (569 MB + 1.28 GB compressed;
about 2.2 GB + 4.9 GB on disk), and the opt-in full-toolchain image adds about
10.9 GB on disk. The row also needs the Docker socket, because the agent
launches the build container itself. Colima's disk is not a fixed limit: grow it
before the pull when it is short
([colima](https://github.com/abiosoft/colima)); a pull that fails for capacity
fails the row rather than mocking the build.

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

`--stream-chunks` makes the warm protocol carry a streamed response as it
arrives: for each streamed invocation the runner writes one
`{"event":"chunk","invocation":N,"index":I,"contentType":…,"data":"<base64>"}`
line per chunk and then exactly one result line, which is the same result object
the default protocol writes plus `"event":"result"` and `"invocation"`. A
buffered response still produces no chunk lines, so a caller that does not pass
the flag keeps the existing one-result-per-event contract. The MCP row uses the
arrival times to prove the first SSE event crossed the runner before the
countdown finished.

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

- `describe` — the started functions (with resolved environment and, per
  function, the Runtime API address or the emulator port under `--rie`), the
  run's `runtimeMode`, HTTP listener URLs, event-source mappings, EventBridge rules, subscriptions,
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
- `s3.delete` — delete one object from a provisioned s3proxy bucket.
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

## Dev loop

### Watch and rebuild

`run --watch` and `session --watch` re-synthesize the app when its sources
change and apply the new surface without restarting the session. The watcher
follows the CDK CLI's own configuration: when `cdk.json` declares a `watch`
object, its `include` and `exclude` patterns decide which files trigger a
rebuild; otherwise the app directory is watched. A path is interpreted relative
to the directory containing `cdk.json`, and `node_modules`, `cdk.out`,
`.git`, `.venv`, `__pycache__` and the examples' `.cdk-asset-stage` directory
are never watched ([watch mode](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli-watch)).

The runner polls every 300 ms and debounces a burst of edits for 500 ms. One
synthesis runs at a time; an edit made while a synthesis is running schedules
another one. A failed synthesis is logged and the previous assembly keeps
serving. A successful change re-derives the whole Spec, provisions any new
definitions, and compares each function's `FunctionSpec`; only a function
whose execution inputs changed is replaced:

- the asset hash (`aws:asset:path`) or inline code;
- the image asset, environment, memory and timeout limits, or layers;
- its runtime, handler or architecture.

A replaced function keeps its logical id, its listener behaviour and the reset
semantics of the Lambda lifecycle page: the old execution environment is
removed and a new one starts
([execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)).
A function added by the change starts; one removed stops. Routes, event
sources, rules, subscriptions and delivery wiring are re-derived, and every
`net.Listener` keeps its port and URL.

| Change | Applied live? |
| --- | --- |
| A served function's code, environment, limits, layers, image or runtime | Yes: that function's execution environment is replaced; the other functions keep theirs. |
| Routes on an existing HTTP, REST or Function URL listener | Yes: the listener's route table is swapped in place. |
| A new or removed HTTP, REST, Function URL or WebSocket listener | No: reported by name; restart the session. |
| A changed CloudFront distribution topology | No: reported; restart the session. |
| Event sources, rules and subscriptions | Yes: the delivery engine is re-derived. |
| A new resource that needs a backend this run did not start | No: reported by name with the backend; restart with `--backend`. |

The `examples/cdk/multilang/scripts/watch-two-edit.sh` row proves two successive
edits in one session: the first edit replaces the Go function, the second
replaces the TypeScript function, and the already-restarted Go function keeps
its Runtime API and keeps answering while the Python function answers
throughout.

### Persistent data (`--data-dir`)

`run`, `session` and `invoke` accept `--data-dir <dir>`. The default is still
ephemeral: without the flag the backends start exactly as before and no state
survives the run. With the flag, each persistable backend keeps its state under
one directory per backend:

| Backend | What persists | Option and path |
| --- | --- | --- |
| DynamoDB Local | Tables and items | `-dbPath /data` on `<dir>/dynamodb`; the pinned command's `-sharedDb` is kept, so the single database file is `shared-local-instance.db`. |
| s3proxy | Buckets and objects, plus each object's SSE-S3 record | The filesystem jclouds provider with `JCLOUDS_FILESYSTEM_BASEDIR=/data` on `<dir>/s3proxy`; the runner records the objects written with SSE-S3 in `<dir>/s3sse/index.json`. |
| ElasticMQ | Queues and messages | `messages-storage` with the H2 file `/data/elasticmq` on `<dir>/sqs`. Verified on the pinned 1.7.1 image: a message survived a restart. |
| moto | Nothing, except the runner's KMS key material | Server-mode state lives in the process; there is no persistence option ([moto server mode](https://docs.getmoto.org/en/latest/docs/server_mode.html)). This is the docs/125 memory-only limit, named rather than hidden. The runner's KMS front keeps the material of the key families it owns in `<dir>/kms/keys.json`, so ciphertext written in one run decrypts in the next; see [KMS signing and key material](#kms-signing-and-key-material). |

The runner widens the data root to `0755` and each backend directory to `0777`
because the pinned emulator images run as their own non-root users, and a Linux
bind mount keeps the host UID (colima maps it to the container user instead).
The ElasticMQ config file is `0644` and holds no secret. These modes assume a
single-user development machine: the backend directories are `0777` without the
sticky bit, so another user of the same host could write to or delete the
emulator store.

The DynamoDB Local page owns the options: `-dbPath` is "The directory where
DynamoDB writes its database file"; `-inMemory` writes no database file and
cannot be combined with `-dbPath`; and "If you use the -sharedDb option,
DynamoDB creates a single database file named shared-local-instance.db"
([DynamoDB Local usage notes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.UsageNotes.html)).
s3proxy's filesystem backend stores a key as a path under
`jclouds.filesystem.basedir`, so a bind-mounted base directory is the
persistent store ([s3proxy](https://github.com/gaul/s3proxy)). ElasticMQ's
`messages-storage` keeps queues and messages in an H2 in-file database and
restores them on startup ([Persisting queues and messages](https://github.com/softwaremill/elasticmq)).

Definitions are re-provisioned from the CDK definition on every start. A table,
bucket, queue, topic, stream, parameter, secret, pool or key that already
exists in the data directory is reconciled, never dropped or recreated. A KMS
key is the one shape where moto's metadata is re-created: the runner's KMS
front reuses the material persisted for the same `stack/logicalId` and reports
the persisted `KeyId`/`Arn`, so ciphertext, `GetPublicKey` and a caller's pinned
key id remain valid; the remaining metadata, notably `CreationDate`, is the
current run's. The S3 front's SSE-S3 records and the KMS material are the only
runner-owned files under the data directory; both are mode `0600` and contain
no AWS credential. A
DynamoDB key-schema change cannot be applied to existing state: the runner
fails at start with the table named and the UpdateTable page's rule,
"Modifies the provisioned throughput settings, global secondary indexes,
DynamoDB Streams settings, or global table replica settings for a given table"
([UpdateTable](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html)).
Missing or changed global secondary indexes are created or deleted, and an
existing queue's visibility, retention, wait and delay attributes are updated
without deleting its messages. A newly added global secondary index carries its
key attributes in the update's `AttributeDefinitions`
([UpdateTable](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html)),
and one keyed on an existing attribute whose declared type differs from the
table's fails by name rather than creating the index over the existing type
([AttributeDefinition](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeDefinition.html)).
Local secondary indexes are created with a new table; an existing table that
differs in one keeps starting and the run logs one warning naming the table,
the index and the difference, with the remedy (recreate the table, for example
by removing `<data-dir>/dynamodb`, or start without `--data-dir`), because a
local secondary index is created when the table is created and UpdateTable
cannot change one
([local secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html)).
An existing global secondary index whose key attribute type drifted is reported
and kept the same way, instead of being treated as unchanged.
The examples' `data-dir.sh`,
`data-dir-s3.sh` and `data-dir-sqs.sh` scripts show the two-run pattern.

### Seed hooks (`--seed`)

`run --seed <command>` and `session --seed <command>` run a shell command after
provisioning and the listener start, and before `local-run: ready`. The
command runs in the app directory with the run's host-side endpoint URLs, the
served HTTP URLs, the data directory (when set) and the dummy credentials, so
it drives the app through its own code paths — an HTTP request to the local
API, `apptheory-local invoke`, or the app's own CLI — and never writes to a
backend behind the app's back. A non-zero exit fails the run with the script's
output.

| Variable | Value |
| --- | --- |
| `APPTHEORY_LOCAL_APP` | The CDK app directory. |
| `APPTHEORY_LOCAL_DATA_DIR` | The `--data-dir` root, when set. |
| `APPTHEORY_LOCAL_APIS` | JSON array of `{"class","logicalId","url"}` for every served listener. |
| `APPTHEORY_LOCAL_URL_<LOGICALID>` | One URL per served listener. |
| `APPTHEORY_LOCAL_ENDPOINT_<SERVICE>` | Each host-side endpoint: `DYNAMODB`, `S3`, `SQS`, `EVENTS`, `KMS`, … |
| The profile's endpoint names | `AWS_ENDPOINT_URL_DYNAMODB`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL_EVENTS`, … |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_DEFAULT_REGION` | `dummy`, `dummy`, `us-east-1`, `us-east-1`. |

Every inherited `AWS_*` name is removed from the seed's environment; only the
run's dummy values are present. The committed
[`examples/cdk/restv1-router/scripts/seed-local.sh`](https://github.com/theory-cloud/AppTheory/blob/staging/examples/cdk/restv1-router/scripts/seed-local.sh)
reads `APPTHEORY_LOCAL_APIS`, PUTs an inventory item through the app's real
handler and reads it back; the harness row proves the seeded item is visible
through the same handler.

## S3 objects and server-side encryption

`--backend s3proxy` starts the profile's digest-pinned s3proxy and injects its
endpoint into every function. The runner puts a small S3 front at the injected
`AWS_ENDPOINT_URL_S3`; it proxies every object operation to s3proxy and serves
the SSE-S3 answer the store itself refuses. The endpoint is the front's
`host.docker.internal` IP literal, so SDK clients keep path-style addressing
(`bucket` in the path, as s3proxy serves it); an ordinary request is forwarded
byte-for-byte, including the SigV4-signed `Host` header. The front therefore
needs `host.docker.internal` to resolve to the run network's gateway; the
preflight resolves it before provisioning, and a host where it does not resolve
fails the run naming the front instead of serving a broken endpoint.

**SSE-S3 (`x-amz-server-side-encryption: AES256`).** AWS accepts SSE-S3 on
`PutObject`, applies it, and returns the algorithm on the put and on later
`HeadObject`/`GetObject` calls
([PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html),
[SSE-S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html)).
s3proxy's filesystem backend refuses every server-side-encryption header by
design (reporting AES256 over plaintext on a real disk would be a false claim),
and current releases still refuse it on that store
([s3proxy limitations](https://github.com/gaul/s3proxy)). The front therefore:

- accepts `AES256` on a `PutObject` whose verified header-based SigV4
  signature covers the header (below), strips the header before s3proxy sees
  it, and records the object as SSE-S3 only after the put succeeds;
- adds `x-amz-server-side-encryption: AES256` to the `PutObject` response;
- answers `HeadObject` and `GetObject` (including a part read with
  `?partNumber=`) with the same header for an object stored with it; a metadata
  subresource read (`?tagging`, `?acl`, `?attributes`, `?legal-hold`,
  `?retention`, `?torrent` or `?uploadId` for `ListParts`) gets none, because
  AWS returns none
  ([GetObjectAttributes](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectAttributes.html),
  [ListParts](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html));
- clears the record when the same key is replaced by a write that names no
  algorithm (a `PutObject` without the header, a plain `CopyObject`, or a
  `CompleteMultipartUpload` that really completed), and on `DeleteObject`,
  `DeleteObjects` and a plain `DeleteBucket`.

The operations that do not replace the object keep the record:
`CreateMultipartUpload`, `UploadPart` and `UploadPartCopy` act on the upload,
not the object; `AbortMultipartUpload` frees the upload's parts and leaves the
object in place
([AbortMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html));
a `POST` form upload is forwarded to the store unclassified; and a bucket
subresource delete (`?policy`, `?cors`, `?lifecycle`, ...) removes that
configuration, not the bucket's objects. A `CompleteMultipartUpload` answered
`2xx` with an `<Error>` body is a failed completion: the object and its record
stay
([CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)).

The SSE header is part of the SDK's SigV4 signature, so the front re-signs the
put after stripping it. S3's canonical URI is the URI-encoded path encoded
exactly once, and S3 does not normalize the path; every other service encodes
the already-encoded path a second time
([S3 SigV4](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html),
[create a signed request](https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html)).
The front signs the exact path it forwards, so object keys containing `=`, a
space, `+`, `%`, unicode or `/` segments get the same signature s3proxy
recomputes; encoding the escaped path a second time would turn `%3D` into
`%253D` and earn a `403 SignatureDoesNotMatch`.

The store never sees the caller's signature on this path: the stripped header
was part of it. Before re-signing, the front therefore checks the caller's own
header-based `SigV4` against the profile's static dummy credentials, and it
strips the header only when that signature verifies and its `SignedHeaders`
names `x-amz-server-side-encryption`. Removing a signed header invalidates the
caller's signature, and only a signature the local credentials vouch for may be
replaced by the runner's own. Every other SSE put is forwarded unchanged, so
the store answers it exactly as it did at v7.0.0:

- an unsigned raw SSE put, and a presigned put whose URL signed the SSE header,
  keep the store's `501 NotImplemented`: the filesystem store refuses the
  header itself;
- a presigned plain-PUT URL with the SSE header added at send time keeps the
  store's `403 AccessDenied`, because the query string signs only the headers
  listed in `X-Amz-SignedHeaders` and every `x-amz-*` header present in the
  request must be signed
  ([SigV4 query-string authentication](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html));
- a header-signed put that adds the SSE header after signing keeps the store's
  `403` for the same reason.

A header-signed put whose `SignedHeaders` names the SSE header but whose
signature does not verify against the profile's credentials is answered
`403 SignatureDoesNotMatch` before the store sees it, because the front cannot
re-sign it as the runner identity. The front also applies AWS's 15-minute
window for a header-signed request, refusing an `X-Amz-Date` more than 15
minutes from the local clock
([SigV4 header-based authentication](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html)).
A Signature Version 2 or other non-SigV4 request has no header signature to
verify, so its SSE put is forwarded unchanged like the cases above.

With `--data-dir`, the record lives in `<dir>/s3sse/index.json` (mode `0600`)
so it survives a restart; without the flag it is in memory.

**SSE-KMS and SSE-C stay refused.** A `aws:kms` or customer-key request is
passed through unchanged and keeps s3proxy's `501 NotImplemented`. The runner
has no way to bind an object to a KMS key or a customer key (the store would
write plaintext), and reporting `aws:kms` plus a key id without that binding
would be exactly the false claim the store refuses to make. Model those paths
against real AWS or a store that performs the encryption.

**Documented local deviations.**

- Only a verified header-signed `PutObject` sets the record. A successful plain
  `CopyObject` or `CompleteMultipartUpload` clears the destination's previous
  record, because neither names a new algorithm; a `CopyObject` with an SSE
  header keeps the store's `501`, an SSE-headed `CreateMultipartUpload` keeps
  it too, and a failed completion clears nothing. A completion answered `200`
  with an `<Error>` body is a failed completion too: the record stays.
- The operations that do not replace the object keep the record: a plain
  `POST` form upload (forwarded unclassified), `CreateMultipartUpload`,
  `UploadPart`, `UploadPartCopy`, `AbortMultipartUpload` and a bucket
  subresource delete. Replace the object with a plain `PutObject`, a plain
  `CopyObject` or a successful `CompleteMultipartUpload` to make its record
  match it.
- The record is per bucket/key, not per version, so a read naming
  `?versionId=` is answered without the header even though AWS returns it for
  a version stored with SSE-S3
  ([GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)).
  The runner keeps one record per key and does not claim per-version
  encryption.
- A `DeleteObjects` body above 1 MiB is forwarded to the store unchanged, as
  the v7.0.0 path did, so its keys are not read and their SSE-S3 records are
  left in place until a later clearing write (a plain `PutObject`, a plain
  `CopyObject`, a successful `CompleteMultipartUpload`, a `DeleteObject` or a
  plain `DeleteBucket`). AWS allows 1000 keys
  of up to 1024 bytes, about 1.05 MiB of XML
  ([DeleteObjects](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html),
  [object key names](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html));
  refusing or truncating that shape would add a failure the released runner did
  not have.
- The store maps each object-key segment to a file name, so a key with one
  segment longer than the filesystem's name limit (255 bytes on ext4 and APFS)
  gets the store's own `500`, as it did before the front; the request still
  reaches it unchanged. The proving row uses keys of exactly 1024 bytes (AWS's
  maximum) split into short segments, which AWS allows and the store serves.
- A verified header-signed `PutObject` with a streaming (`aws-chunked`) SigV4
  payload cannot be re-signed after the signed SSE header is stripped; the
  front refuses it with a clear 400 rather than forwarding a broken signature.
  An unsigned or presigned streaming SSE put is forwarded unchanged. A normal
  SDK put (the audit sink's and the proving row's form) is signed over the
  payload hash and is accepted, including keys that need URI escaping (`=`,
  spaces, `+`, `%`, unicode and `/` segments); the front signs the same
  once-encoded path it forwards.
- The re-signed put authenticates as the runner identity: the front verifies
  the caller's header-based `SigV4` against the profile's static dummy
  credentials before stripping the SSE header and re-signing, and a request
  signed with other credentials gets `403 SignatureDoesNotMatch`. Every SSE put
  the front does not verify (unsigned, presigned, or with the header unsigned)
  is forwarded unchanged and keeps the store's refusal.
- The account-wide S3 default encryption (SSE-S3 applied to objects written
  without a header) is not modelled: an object reports `AES256` only when its
  put named it.
- The store writes plaintext; `AES256` is the observable S3 answer, not
  at-rest encryption of the local file. Do not use a `--data-dir` containing
  sensitive data on a shared host.
- An object written by a runner-internal path that bypasses the front (the
  session's `s3.put`, a bucket deployment) has no SSE-S3 record, as it named no
  algorithm.

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
endpoint). Function containers reach it as `host.docker.internal:<port>`
through the host entry the runner adds: on Linux, where the host owns the run
network's gateway, the entry names that gateway address, and elsewhere the
entry keeps Docker's `host-gateway` value, which Colima and Docker Desktop
forward to the host's loopback. The listener binds loopback and, when the host
owns the run network's gateway, the same port on that address; it never binds
the unspecified address. The session reports and the harness uses
`http://127.0.0.1:<port>`. The endpoint is unauthenticated. The EventBridge
endpoint, the WebSocket `@connections` management listener, the CloudFront
control endpoint and the CodeBuild control endpoint follow the same rule; the
Runtime API listener binds loopback or, when the container cannot reach it, the
run network's gateway address (see [Requirements](#requirements)); the backends
publish on `127.0.0.1`. A
handler's real SDK client and the harness's AWS CLI reach the same endpoint. A
rule's pattern is matched by the validated EventBridge evaluator E1b uses, and
the runner performs input shaping, target delivery, retry and dead-letter
handling.

The own bus was chosen over the pinned moto events service after probing
`motoserver/moto@sha256:59a1965d` (5.2.5):

| Probe | moto 5.2.5 | Runner |
| --- | --- | --- |
| `PutEvents` on a custom bus matches a simple pattern rule to a moto SQS target | Yes | Yes |
| `InputPath` on an SQS target | Accepted and ignored; the full event is delivered | Implemented |
| `Input` on a target | Accepted and ignored | Implemented |
| `InputTransformer` | Not applied | Implemented |
| Retry policy and `DeadLetterConfig` | Accepted, no retry or DLQ behavior | Implemented on the run clock |
| Lambda target delivery to a local function | Cannot reach the local function containers | Invokes the real container |
| ElasticMQ target | moto's SQS is a different queue service | Sends to the application's ElasticMQ queue |
| Schedules | Never fire | Fire on the run clock |

**PutEvents.** The endpoint accepts the AWS JSON 1.1 body the SDKs send,
including the timestamp form they use: `PutEventsRequestEntry.Time` as epoch
seconds in a JSON number, integer or fractional (the protocol's default
timestamp encoding). The RFC3339 string form v7.0.0 accepted is still accepted,
and an omitted, empty or `null` `Time` takes the time of the PutEvents call from
the run clock, as the API documents. The delivered envelope's `time` keeps one
precision per form:

- a numeric `Time` keeps the instant it names, printed as RFC3339 with the
  fraction it supplied (whole seconds for an integer, up to nine fractional
  digits);
- an RFC3339 string keeps v7.0.0's whole-second output;
- the run clock (an omitted, empty or `null` `Time`) keeps v7.0.0's
  whole-second output.

Timestamp serialization is SDK-version dependent: botocore 1.42.97 in the
pinned Python 3.14 Lambda image sends a numeric `Time` as whole epoch seconds,
while botocore 1.43.124 on a developer host sends the fraction. Both are the
numeric form above, and the endpoint keeps whatever it receives.

An entry whose `Time` is a value the runner cannot read fails that entry, not
the request. See
[PutEventsRequestEntry.Time](https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEventsRequestEntry.html)
for the fallback rule, [Event
structure](https://docs.aws.amazon.com/eventbridge/latest/ref/events-structure.html)
for the envelope's `time` field, and [AWS JSON 1.1
timestamps](https://smithy.io/2.0/aws/protocols/aws-json-1_1-protocol.html#shape-serialization)
for the wire encoding.

Protocol errors on the endpoint use the AWS JSON 1.1 error document the SDKs
decode: an `application/x-amz-json-1.1` response whose body carries `__type`
and `message`. A body that is not JSON is `400
MalformedHttpRequestException`; an `Entries` count outside 1..10, or a `Time`
whose JSON type is neither a number nor a string, is `400 ValidationError`; an
`X-Amz-Target` other than `AWSEvents.PutEvents` is `404
UnknownOperationException`; an unencodable response is `500 InternalFailure`.
Entry-level refusals keep the documented `200` response and report
`FailedEntryCount` plus a per-entry `ErrorCode`: `InvalidArgument` for a
missing `Source`/`DetailType` or an unusable `Time`, and `MalformedDetail` for
`Detail` that is not valid JSON. See the [PutEvents
response](https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html)
and [PutEventsResultEntry error
codes](https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEventsResultEntry.html),
and [Common Error
Types](https://docs.aws.amazon.com/eventbridge/latest/APIReference/CommonErrors.html)
for the protocol errors.

**Status and placement choices.** AWS documents the error codes and statuses
but not where a member whose JSON type does not match the model is reported.
The first response below is a stated deviation; the second is pinned by
citations:

- A `Time` whose JSON type is neither a number nor a string fails the whole
  request with `400 ValidationError` instead of refusing the entry. [Smithy
  shape
  serialization](https://smithy.io/2.0/aws/protocols/aws-json-1_1-protocol.html#shape-serialization)
  defines a timestamp as a JSON number, so the member cannot be decoded at all,
  and [Common Error
  Types](https://docs.aws.amazon.com/eventbridge/latest/APIReference/CommonErrors.html)
  documents `ValidationError` as 400 for input that does not meet the required
  format. A value that decodes but names no usable instant (for example
  `"not-a-time"` or an out-of-range number) stays a per-entry `InvalidArgument`.
- An `X-Amz-Target` other than `AWSEvents.PutEvents` is `404
  UnknownOperationException`. The [AWS JSON 1.1 identification
  rule](https://smithy.io/2.0/aws/protocols/aws-json-1_1-protocol.html#identification-for-claiming)
  makes `X-Amz-Target` the `{serviceName}.{operationName}` of the request, and
  [Common Error
  Types](https://docs.aws.amazon.com/eventbridge/latest/APIReference/CommonErrors.html)
  documents `UnknownOperationException` as HTTP 404 for an operation that is not
  recognized. The endpoint's exact-match target check is how it applies that
  rule locally.

**Compatibility with v7.0.0.** Every request in this table was refused at
v7.0.0 too, so no accepted call newly fails; the bytes a caller observes can
change, and a release note should carry the codes and statuses:

| Request | v7.0.0 | This release |
| --- | --- | --- |
| a non-POST method | `405` plain text | `400 MalformedHttpRequestException` |
| an `X-Amz-Target` other than `AWSEvents.PutEvents` | `400` plain text | `404 UnknownOperationException` |
| a body that is not JSON | `400` plain text | `400 MalformedHttpRequestException` |
| a body read failure | `400` plain text | `400 MalformedHttpRequestException` |
| an `Entries` count outside 1..10 | `400` plain text | `400 ValidationError` |
| a member whose JSON type does not decode (`Time` included) | `400` plain text | `400 ValidationError` |
| an entry missing `Source` or `DetailType` | `200`, entry `MalformedDetail` | `200`, entry `InvalidArgument` |
| an entry whose `Time` cannot be read | `200`, entry `MalformedDetail` | `200`, entry `InvalidArgument` |
| an unencodable response | `500` plain text | `500 InternalFailure` |

A request that succeeded at v7.0.0 keeps succeeding with the same delivered
data: the string-form and run-clock `time` stay whole-second RFC3339, the
envelope's other members are unchanged, and the numeric `Time` form (which
failed the v7.0.0 decode) is additive. A malformed `Detail` keeps its
per-entry `MalformedDetail`.

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
`AWS::Events::EventBus` the rule references. An `AWS::Events::EventBus`
resolves like the CloudFormation reference documents: `Ref` is the bus name and
`Fn::GetAtt Arn` the
[bus ARN](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-events-eventbus.html).
`PutEvents` accepts that ARN or the bus name as `EventBusName`, as the
[API reference](https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html)
states. It accepts up to ten entries; each entry becomes the documented envelope (`version`, `id`,
`detail-type`, `source`, `account`, `time`, `region`, `resources`, `detail`) and
is matched against every enabled rule on its bus. Matching is the documented
EventBridge pattern grammar over top-level fields and `detail`, including
`prefix`, `suffix`, `anything-but`, `numeric`, `exists`,
`equals-ignore-case` and `$or`. A `State: DISABLED` rule registers paused and
never fires. An entry that fails validation is reported in the PutEvents
response with `ErrorCode` `InvalidArgument` or `MalformedDetail` and does not
reach a rule.

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
| Moto's SNS fan-out only reaches moto's own SQS and cannot reach a local function container or ElasticMQ | The runner creates a drain queue on moto's SQS and performs the application fan-out itself. |
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
| The filesystem store refuses every server-side-encryption header with `501 NotImplemented` | The runner's S3 front accepts `AES256` on `PutObject`, records it and returns the documented header on the put and on `HeadObject`/`GetObject`; `aws:kms` and customer keys stay refused. See [S3 objects and server-side encryption](#s3-objects-and-server-side-encryption). |

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
are registered, exactly as the page's valid examples show. A filter rule value
that contains a wildcard (`*.jpg`) is refused at plan time with the page cited:
S3 does not allow a wildcard in a notification filter prefix or suffix.

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
locally, **L2** runs locally with an emulator and a named fidelity limit, and
**L3** is exercised as fully as possible with a named cloud gap from the
docs/125 true-limit list. `apptheory local` serving a surface is not by itself a
class: the class belongs to an example, and the harness records it. Every row's
class and named limit is in the [harness fidelity table](/examples/local-harness/#fidelity-table).

| Capability | Local runner | Notes |
| --- | --- | --- |
| HTTP API v2 (`AWS::ApiGatewayV2::Api`, HTTP) | Supported (L1) | v2.0 events with `routeKey`, `rawPath`, `requestContext.http`, cookies and path parameters. The `cookie` header is removed when `cookies` is populated, as AWS does. |
| REST API v1 (`AWS::ApiGateway::RestApi`) | Supported (L1) | v1 events with `resource`, `multiValueHeaders`, `multiValueQueryStringParameters` and the stage. |
| Lambda Function URL | Supported (L1) | Function URL events carry `routeKey: "$default"` (top-level and in `requestContext`, with `requestContext.stage`) and a `.lambda-url.<region>.on.aws` domain, which the runtime uses to tell them apart from HTTP API v2. A `RESPONSE_STREAM` URL forwards the prelude and the payload incrementally; a `BUFFERED` URL (the template default) serves the complete response, and behind CloudFront it takes the buffered finish path. A URL with an auth type other than `NONE` is reported under `skipped`, not served as a standalone URL; a distribution can still reference it as an origin. |
| Response streaming (`awslambda.streamifyResponse`, SSE) | Supported (L2) | A chunked runtime response is forwarded to the Function URL, REST API proxy integration and CloudFront viewer as the runtime writes it; the Function URL and REST formats (metadata JSON, 8 null bytes, payload) and the midstream error trailers are implemented. Lambda's 6 MB uncapped burst and 2 MBps cap are not reproduced (documented deviation). |
| Inline `Code.ZipFile` | Supported (Node, Python) | Materialized under the run scratch directory before the container starts. |
| arm64 `provided.al2023` | Supported (L1) | Uses the host-arch image; a bootstrap built for the other architecture fails closed with a clear error. |
| DynamoDB Local | Supported (L2) | `--backend dynamodb` starts the profile's digest-pinned `amazon/dynamodb-local` on the run network; SDK clients resolve through `AWS_ENDPOINT_URL_DYNAMODB`. Tables are created from the CDK key schema, GSIs, streams and TTL. SSE, PITR and deletion protection are not provisioned. |
| SQS (ElasticMQ) | Supported (L2) | `--backend sqs` starts the digest-pinned `softwaremill/elasticmq-native` container, creates the CDK queues with visibility, retention and redrive policy, and resolves `QueueUrl`/`Arn` from the created queues. Every SQS event-source mapping polls automatically with batching, visibility, delete-on-success, partial batch failure, FIFO group ordering, redrive, filter criteria and maximum concurrency; see [SQS event-source delivery](#sqs-event-source-delivery). A session also exposes `sqs.send`, `sqs.receive`, `sqs.event` and `sqs.attributes` for explicit work. |
| KMS and STS (moto) | Supported (L2) | `--backend moto` starts the profile's digest-pinned moto container and injects `AWS_ENDPOINT_URL_KMS`/`_STS` (and the profile's aliases). Symmetric, RSA (2048/3072/4096) and ECC (P256/P384/P521) `SIGN_VERIFY` keys declared by the assembly are created, with aliases; `Ref`/`Fn::GetAtt Arn` resolve to the created key and alias. The runner's KMS front serves the owned key families' crypto (see [KMS signing and key material](#kms-signing-and-key-material)): `Sign`/`Verify` honour `MessageType: DIGEST`, and `--data-dir` keeps the material. No HSM, key policies or grants. |
| S3 (s3proxy) | Supported (L2) | `--backend s3proxy` starts the digest-pinned s3proxy container, creates the assembly's buckets, and injects the front's IP endpoint so the SDK uses path-style addressing. No bucket policies or IAM. SSE-S3 is accepted and reported (see [S3 objects and server-side encryption](#s3-objects-and-server-side-encryption)); SSE-KMS and SSE-C are refused by the store. A bucket notification configuration is delivered from the real object state; see [S3 event notification delivery](#s3-event-notification-delivery). |
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
| WebSocket APIs (`AWS::ApiGatewayV2::Api`, WEBSOCKET) | Served (L2) | A real RFC 6455 listener serves `$connect`, `$disconnect`, `$default` and custom routes selected by the route selection expression, with the documented proxy event, two-way route responses, the `$connect` policy authorizer, the `@connections` management API and the documented idle/lifetime close; see [WebSocket APIs](#websocket-apis). An opted-in run serves `wss://` at the public host. No custom domains and no IAM authorization. |
| Local HTTPS (`--tls`) | Supported (L2) | Every public listener (HTTP API, REST API, Function URL, WebSocket, CloudFront) serves HTTPS from a certificate the run's local CA signs; HTTP/2 is negotiated, SNI names outside the certificate are refused, and every function container mounts the CA for its own clients. The cert chains to a local CA, not a public one, and there is no edge TLS policy; see [Local HTTPS, OIDC issuers and passkeys](#local-https-oidc-issuers-and-passkeys). |
| CloudFront distributions and CloudFront Functions | Served (L2) | The distribution is served on its own loopback URL. Cache behaviors, allowed methods, viewer-request/viewer-response functions, origin request policies and response headers policies are applied; the generated function code runs in a restricted Node sandbox. S3 origins read the app's deployments from s3proxy, Function URL origins invoke the real handler container, and origin groups fail over with CloudFront's rules. No edge network and no edge TLS; an opted-in run serves the local listener over HTTPS from the run CA. |
| CloudFront caching | Supported (L2) | The cache key (GET and HEAD share one key, OPTIONS is separate), `CachedMethods`, `CACHING_DISABLED`, the Expiration-page TTL rules, stale-while-revalidate, stale-if-error (including a 5xx origin response for an expired object) and the HTTPStatusCodes-page error caching table are applied; hits answer `x-cache`/`age`; `session describe` reports per-behavior hit/miss counts. A viewer Range request bypasses the local cache (documented deviation); a conditional request is answered 304 from the cached validators. See [Caching and invalidation](#caching-and-invalidation). |
| CloudFront invalidation | Supported (L2) | `CreateInvalidation`, `GetInvalidation` and `ListInvalidations` are served on a control endpoint that binds loopback and, when the host owns the run gateway, that address too; it is injected as `AWS_ENDPOINT_URL_CLOUDFRONT`; the aws CLI and the SDK share it. Paths are matched against the cached path plus the selected query string, with a trailing `*` only, and `CallerReference` reuse follows the API reference. See [Caching and invalidation](#caching-and-invalidation). |
| CloudFront custom error responses | Supported (L2) | `CustomErrorResponses` is served: the page is fetched through the first cache behavior that matches its path, from that behavior's origin and with its origin request policy, with the configured status; a matching behavior's TTL wins, and an unavailable page returns the pages origin's status. |
| CloudFront external custom origins | Supported with `--origin` (L2) | An external custom origin is refused at plan time unless `--origin domain=loopback-url` maps it; a non-loopback mapping is refused. The mapped origin receives the documented origin-request shape. |
| REST `MOCK` integrations | Supported (L1) | The transport returns the `IntegrationResponses` status and headers the template declares and invokes no function. CDK emits these for CORS preflight. |
| HTTP API `REQUEST` authorizers with simple responses | Supported | The transport invokes the real authorizer function with the API Gateway v2 REQUEST event, carrying every configured `$request.header.*` or `$request.querystring.*` identity source in order; a request missing one is refused with 401 before the authorizer runs. A false `isAuthorized` is a 401, the authorizer context is carried to the handler, and a malformed response fails closed. `$context`/`$stageVariables` sources fail closed at plan time. |
| HTTP API JWT authorizers | Supported (L2) | RSA-based algorithms only (`RS256`, `RS384`, `RS512`); the signature is verified with the `kid` key from the issuer's JWKS, and `iss`, `aud` (or `client_id` only when `aud` is absent), `exp`, `nbf` and `iat` are checked against the run clock. `AuthorizationScopes` is an any-of match; the claims reach the integration in `requestContext.authorizer.jwt`; see [Authorizers](#authorizers). |
| REST API Cognito user-pool authorizers | Supported (L2) | The token is validated against the pool's JWKS through the local issuer with the same RSA-only algorithm and claim checks as the HTTP JWT authorizer; `AuthorizationScopes` is an any-of match and the claims reach the integration in `requestContext.authorizer.claims`; see [Authorizers](#authorizers). |
| REST/HTTP Lambda authorizers with IAM-policy responses | Supported (L2) | A REST `TOKEN` or `REQUEST` `AWS::ApiGateway::Authorizer` and an HTTP API `REQUEST` authorizer with `EnableSimpleResponses: false` run the real function and match its returned policy narrowly against the method/route ARN. Identity sources are 401 before invocation when missing; `AuthorizerResultTtlInSeconds` caches the policy on the run clock with the documented cache key, and a hit is re-evaluated against the current method/route ARN; a response without `principalId` is invalid; Allow invokes, Deny is 403, the `Unauthorized` error is 401 and an invalid response is 500; the stringified context reaches `requestContext.authorizer`; see [Authorizers](#authorizers). |
| Lambda layers | Supported | A function's `Layers` resolve to LayerVersions in the same assembly; their content is extracted into `/opt` in the listed order (later layers win) with `/opt/bin` on `PATH`, `/opt/lib` on `LD_LIBRARY_PATH`, `/opt/nodejs/node_modules` on `NODE_PATH` and both `/opt/python` and `/opt/python/lib/python<major>.<minor>/site-packages` on `PYTHONPATH`. A relative symlink inside the layer is kept as a symlink; an absolute or escaping one is refused by name. The five-layer limit and an external layer ARN are refused by name; see [Lambda layers and container-image functions](#lambda-layers-and-container-image-functions). |
| Container-image functions | Supported | `PackageType: Image` with a CDK `DockerImageAsset` is built by the real `docker build` (directory, Dockerfile, target, platform and build arguments from the assembly) before serving, then run through the same Runtime API invocation path as a zip function (or under the image's own emulator with `--rie`). An image function that declares layers is refused by name. |
| CloudFormation-expression environment values | Supported for `Ref`/`Fn::GetAtt`/`Fn::Join` | Tables and stream ARNs, queues, rules, buckets, KMS keys and aliases, SSM parameters, Secrets Manager ARNs, SNS topics, Kinesis streams, Cognito pool/client values, IAM/MicroVM-image/S3 Vectors ARNs and functions resolve to local values (moto/S3 require their backend). An unsupported expression fails with the function and variable named. |
| `AWS::CodeBuild::Project` | Served through AWS's local agent (L2) | `StartBuild` runs the project's buildspec in AWS's published local CodeBuild agent, with the build image mapped by the profile per architecture; `BatchGetBuilds`/`ListBuildsForProject` report the phases and log, and "CodeBuild Build State Change" events reach the app's EventBridge rules. Deviations: no CodePipeline, VPC, cache, artifact upload or report groups; see [CodeBuild](#codebuild). |
| CloudFormation-expression `MemorySize`/`Timeout` | Resolved (`Ref` parameter Default, `Fn::If` over defaults, `Fn::FindInMap`, `Fn::Join`; an `Fn::If` selecting `AWS::NoValue` omits the property) | The resolved value is validated against the Lambda page's ranges (128..32768 MB, 1..900 s); an omitted property takes the documented default (128 MB, 3 s). A parameter without a `Default`, a `Fn::GetAtt` on a deployed resource, or an unknown condition/mapping stays `unresolved (<intrinsic>)` and a served function fails closed with the parameter or intrinsic named. The restv1-router `intrinsic-limits` row proves all three forms reach the real container. |
| One function, explicit events (`invoke`) | Supported | Starts one function and sends newline-delimited JSON events to a warm container; `--handler-dir` runs a handler that has no CDK definition and derives no routes. |
| Every target, explicit commands (`session`) | Supported | Starts every CDK-targeted function, serves the HTTP surface, and answers a JSON-line command protocol for invocation, SQS, DynamoDB, S3, EventBridge and Kinesis operations. `--target` adds a function no route or event source targets. |
| Stage-prefixed URLs (`/prod/...`) | Supported | A REST API is served at `/{stage}/...` in addition to the root; an HTTP API with a named (non-`$default`) stage is served at `/{stage}/...` in addition to the root. The `$default` stage keeps the root. The root stays the custom-domain form. The events carry the documented fields: REST v1 `path`/`resource` without the stage and `requestContext.path` with it; HTTP API v2 `rawPath` and `requestContext.http.path` with it; `requestContext.stage` in both. |
| Multiple APIs in one stack | Supported | Each API gets its own listener and route table, so `ANY /` surfaces never shadow each other. |

## Known gaps

- **Streaming bandwidth.** A streamed response is forwarded at the origin's
  pace. Lambda gives the first 6 MB of a response uncapped bandwidth and then
  caps the rate at 2 MBps; the local gateway does not reproduce either number.
  The 6 MB buffered and 200 MB streamed payload limits are not enforced either,
  so a local call that works today keeps working.
- **WebSocket domains and IAM authorization** are out of scope. The API is
  served on a loopback `ws://` URL by default; an opted-in run serves
  `wss://app.localhost:<port>/<stage>` instead (see
  [Local HTTPS, OIDC issuers and passkeys](#local-https-oidc-issuers-and-passkeys)).
  A custom domain name is not modelled; `AWS_IAM` route authorization and
  REST-style Lambda authorizers on WebSocket routes fail closed. The
  `@connections` management endpoint is TLS with a per-run certificate: a
  self-signed one by default, or one the run CA signs when `--tls` is set. The
  runner mounts the trust bundle into the function containers; a client outside
  those containers must trust that certificate to call it. Binary media types
  are refused with 1003, as API Gateway documents.
- **CloudFront is an edge-path gateway, not an emulator.** The distribution's
  cache behavior, generated CloudFront Functions, edge policies and origins are
  applied; the cache is a single in-memory store on the loopback listener, and
  there is no edge network and no edge TLS policy: no ACM certificate, security
  policy, minimum protocol version or viewer protocol enforcement. An opted-in
  run serves the listener in front of you over HTTPS from the run CA, which is
  local TLS, not edge TLS (docs/125 "Real network properties").
  S3-origin bucket CORS rules and IAM/bucket policies are not
  emulated; the local S3 origin returns the S3 status the OAC/OAI access model
  produces. `If-Range` is not forwarded to the S3 origin (CloudFront forwards
  it by default), so a conditional range is served as an unconditional
  range. An `AWS_IAM`
  Function URL's SigV4 signing and the gateway's in-process check of that
  locally signed request are reproduced, but IAM policy evaluation is not.
  A literal external custom origin is refused rather than reached. A WAF web
  ACL refuses the distribution: managed rule content is owned by AWS and is a
  docs/125 true limit. Lambda@Edge associations run through the real Node or
  Python containers; a key value store is materialised from the asset the
  assembly carries; signed URLs and cookies are verified against the key
  group's real public keys; geo restriction uses the run's
  `--viewer-country`; and field-level encryption produces AWS Encryption SDK
  ciphertext. The cache policy is applied — the cache key, TTLs, stale
  directives and error caching; `Compress`, the behavior-level legacy
  `DefaultTTL`/`MinTTL`/`MaxTTL`, access and real-time logging, `PriceClass` and
  the other placement settings are reported, not emulated. The Node `vm`
  executor matches the CloudFront Functions API and globals but is not a
  hardened security boundary, does not enforce CloudFront's 1 ms CPU budget, and
  cannot reproduce CloudFront-only device headers or TLS; the viewer-country
  header is reproduced from `--viewer-country`.
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
- **Managed services** are L3 gaps where the examples use them: the MicroVM
  managed provider in the controller and conformance rows, and S3
  Vectors/Bedrock in the semantic-search row. Both are AWS-only services with
  no emulator in the docs/125 true-limit list. The runner stops at those
  boundaries; it never fakes a success.
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
- No browser is needed to run the runner. The examples harness's local-TLS
  browser row drives headless Chromium through Playwright: install
  `scripts/local/requirements-examples.txt`, then run
  `python -m playwright install chromium`. The row pins the run's leaf key in
  Chromium's certificate-error list, so no system or browser trust store is
  changed.
- Docker (on macOS, colima) with the daemon running. The runner creates one
  private network per run. In the default mode a function container reaches the
  Runtime API through `host.docker.internal:<port>` (the run network's closed
  DNS cannot resolve the name, so the host entry is added for the container).
  The listener never binds the unspecified address: it binds loopback
  (`127.0.0.1:<port>`) and, when the host owns the run network's gateway
  address (the IPAM gateway `docker network inspect <run network>` reports, the
  Linux bridge case), also binds that address and names it in the container's
  `host.docker.internal` entry. When the host does not own it (Colima, Docker
  Desktop), the container keeps Docker's `host-gateway` entry, which those
  runtimes forward to the host's loopback. The runtime's first `/next` proves
  the address and the runner logs the entry it used. In `--rie` mode the
  emulator port is published on `127.0.0.1` only.
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
