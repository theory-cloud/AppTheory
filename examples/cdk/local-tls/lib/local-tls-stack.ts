import { execSync } from "node:child_process";
import * as path from "node:path";

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

// The local-TLS example declares every public listener the local runner
// serves: an HTTP API, a REST API, a Function URL, a WebSocket API and a
// CloudFront distribution. One Node function is the OIDC issuer and the
// CloudFront page; three callers (Go, Node, Python) fetch its discovery
// document and JWKS from their own container over verified TLS.
export class LocalTlsStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const issuer = new lambda.Function(this, "Issuer", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "Local OIDC issuer and CloudFront page; the issuer is the URL it was reached at",
      timeout: Duration.seconds(10),
      code: lambda.Code.fromInline(issuerCode),
    });
    const issuerUrl = issuer.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const restEcho = new lambda.Function(this, "RestEcho", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "REST API v1 surface probe",
      timeout: Duration.seconds(10),
      code: lambda.Code.fromInline(restEchoCode),
    });

    const webSocketEcho = new lambda.Function(this, "WebSocketEcho", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "WebSocket API echo handler",
      timeout: Duration.seconds(10),
      code: lambda.Code.fromInline(webSocketEchoCode),
    });

    // The role environment names each caller for the harness row, which finds
    // the function in the plan instead of hard-coding a synthesized logical id.
    const callerGo = new lambda.Function(this, "CallerGo", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      environment: { APPTHEORY_LOCAL_TLS_ROLE: "caller-go" },
      description: "Go caller: fetches discovery and JWKS over verified TLS",
      timeout: Duration.seconds(20),
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "go"), {
        bundling: {
          image: lambda.Runtime.PROVIDED_AL2023.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "set -euo pipefail",
              "cd /asset-input",
              "GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /asset-output/bootstrap .",
            ].join(" && "),
          ],
          local: {
            tryBundle(outputDir: string) {
              execSync(
                `go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o ${JSON.stringify(path.join(outputDir, "bootstrap"))} .`,
                {
                  cwd: path.join(__dirname, "..", "handlers", "go"),
                  stdio: "inherit",
                  env: { ...process.env, GOOS: "linux", GOARCH: "arm64", CGO_ENABLED: "0" },
                },
              );
              return true;
            },
          },
        },
      }),
    });

    const callerNode = new lambda.Function(this, "CallerNode", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "Node caller: OIDC fetch over verified TLS and two AWS SDK calls",
      timeout: Duration.seconds(20),
      // The nodejs24.x image carries the AWS SDK for JavaScript v3 under
      // /var/runtime/node_modules, which is not on the resolution path of a
      // handler shipped in /var/task. NODE_PATH is how the image exposes it in
      // Lambda too, so the handler imports the SDK the runtime ships.
      environment: {
        APPTHEORY_LOCAL_TLS_ROLE: "caller-node",
        NODE_PATH: "/var/runtime/node_modules",
      },
      code: lambda.Code.fromInline(callerNodeCode),
    });

    const callerPython = new lambda.Function(this, "CallerPython", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "caller.handler",
      description: "Python caller: fetches discovery and JWKS over verified TLS",
      timeout: Duration.seconds(20),
      environment: { APPTHEORY_LOCAL_TLS_ROLE: "caller-py" },
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "python"), {
        exclude: ["__pycache__", "**/__pycache__", "*.pyc", "**/*.pyc"],
      }),
    });

    // The AWS SDK rows read a table the run provisions, so the DynamoDB call
    // proves runner-served state rather than an empty list.
    new dynamodb.Table(this, "Probe", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const issuerApi = new apigwv2.HttpApi(this, "IssuerApi", {
      apiName: "apptheory-local-tls-issuer",
    });
    const issuerIntegration = new apigwv2integrations.HttpLambdaIntegration("IssuerIntegration", issuer);
    issuerApi.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration: issuerIntegration });
    issuerApi.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration: issuerIntegration });

    const restApi = new apigateway.RestApi(this, "Rest", {
      restApiName: "apptheory-local-tls-rest",
      deployOptions: { stageName: "dev" },
      endpointTypes: [apigateway.EndpointType.REGIONAL],
    });
    const echo = restApi.root.addResource("echo");
    echo.addMethod("GET", new apigateway.LambdaIntegration(restEcho, { proxy: true }), {
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    const webSocketApi = new apigwv2.WebSocketApi(this, "EchoWebSocket", {
      apiName: "apptheory-local-tls-ws",
      routeSelectionExpression: "$request.body.action",
    });
    new apigwv2.WebSocketStage(this, "EchoWebSocketStage", {
      webSocketApi,
      stageName: "dev",
      autoDeploy: true,
    });
    const webSocketIntegration = new apigwv2integrations.WebSocketLambdaIntegration("EchoIntegration", webSocketEcho);
    for (const routeKey of ["$connect", "$disconnect", "$default", "chat"]) {
      webSocketApi.addRoute(routeKey, { integration: webSocketIntegration });
    }

    const noCache = new cloudfront.CachePolicy(this, "NoCache", {
      cachePolicyName: "apptheory-local-tls-no-cache",
      comment: "The local CloudFront page always reaches its origin",
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList("host"),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: false,
    });
    const site = new cloudfront.Distribution(this, "Site", {
      comment: "The local TLS browser surface",
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(issuerUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.ALLOW_ALL,
        cachePolicy: noCache,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
    });

    // A hosted-auth shape: the distribution forwards the discovery document,
    // the authorization and token paths and their form POSTs to the app's own
    // API origin. The origin declares HTTPS_ONLY, which is what a deployed
    // CloudFront uses in front of an API Gateway endpoint, and its declared
    // domain is the name the origin certificate must carry.
    //
    // The local stage maps that domain to the runner's own API listener:
    //   --origin auth-api.localhost=https://app.localhost:<api port>
    // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html#DownloadDistValuesOriginProtocolPolicy
    // The hosted-auth origin receives its own declared domain as the Host
    // header: CloudFront forwards the viewer Host only when the cache policy
    // allows it, and an API origin routes by its own domain. A policy that
    // allowed the viewer host here would make the API derive its issuer from
    // the distribution's name instead of the origin's.
    //
    // The policy forwards cookies because the hosted-auth face sets them:
    // CloudFront forwards a Set-Cookie header to clients when the distribution
    // forwards cookies.
    // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
    const hostedAuthCache = new cloudfront.CachePolicy(this, "HostedAuthNoCache", {
      cachePolicyName: "apptheory-local-tls-hosted-auth-no-cache",
      comment: "The local hosted-auth origin is always reached, and it sees its own domain",
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      cookieBehavior: cloudfront.CacheCookieBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: false,
    });
    const hostedAuthOrigin = new origins.HttpOrigin("auth-api.localhost", {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    const hostedAuth = new cloudfront.Distribution(this, "HostedAuth", {
      comment: "The local TLS hosted-auth surface",
      defaultBehavior: {
        origin: hostedAuthOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: hostedAuthCache,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      additionalBehaviors: {
        "/.well-known/*": {
          origin: hostedAuthOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: hostedAuthCache,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        "/auth/*": {
          origin: hostedAuthOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: hostedAuthCache,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
    });

    new CfnOutput(this, "IssuerApiUrl", { value: issuerApi.apiEndpoint });
    new CfnOutput(this, "RestApiUrl", { value: restApi.url });
    new CfnOutput(this, "IssuerFunctionUrl", { value: issuerUrl.url });
    new CfnOutput(this, "WebSocketUrl", { value: webSocketApi.apiEndpoint });
    new CfnOutput(this, "SiteUrl", { value: `https://${site.distributionDomainName}` });
    new CfnOutput(this, "HostedAuthUrl", { value: `https://${hostedAuth.distributionDomainName}` });
  }
}

const issuerCode = `
"use strict";
const crypto = require("node:crypto");
let keys;
function keyMaterial() {
  if (!keys) {
    const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: "jwk" });
    jwk.kid = "local-tls";
    jwk.use = "sig";
    jwk.alg = "RS256";
    keys = { jwk, privateKey: pair.privateKey };
  }
  return keys;
}
function baseUrl(event) {
  const host = (event.headers && event.headers.host) || "";
  return host ? "https://" + host : "";
}
function json(statusCode, value) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}
exports.handler = async (event) => {
  const path = event.rawPath || event.path || "/";
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || "GET";
  const base = baseUrl(event);
  if (path === "/.well-known/openid-configuration" || path === "/.well-known/oauth-authorization-server") {
    return json(200, {
      issuer: base,
      jwks_uri: base + "/jwks",
      token_endpoint: base + "/token",
      authorization_endpoint: base + "/authorize",
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }
  if (path === "/jwks") {
    return json(200, { keys: [keyMaterial().jwk] });
  }
  if (path === "/health") {
    return json(200, { ok: true, surface: "issuer", host: base.replace("https://", "") });
  }
  if (path === "/token") {
    return json(200, { token_type: "Bearer", access_token: "local-access-token" });
  }
  if (path === "/auth/token") {
    // A hosted-auth form POST: the distribution must forward the method, the
    // content type and the body unchanged. The answer echoes what the API
    // parsed so the caller can assert the body survived the origin hop.
    let body = event.body || "";
    if (event.isBase64Encoded) {
      body = Buffer.from(body, "base64").toString("utf8");
    }
    const form = new URLSearchParams(body);
    const fields = {};
    for (const [name, value] of form.entries()) {
      fields[name] = value;
    }
    return json(200, {
      ok: true,
      method,
      host: (event.headers && event.headers.host) || "",
      contentType: (event.headers && event.headers["content-type"]) || "",
      form: fields,
    });
  }
  if (path === "/auth/authorize") {
    // The hosted-auth SSO hand-off: the app answers the form POST with the 303
    // See Other the SSO flow redirects the browser with. The example takes the
    // identity provider's authorize URL from the form (idp_authorize) so the
    // row can point it at the auxiliary idp.localhost certificate; a real app
    // reads that URL from its configuration. Two Set-Cookie headers ride along
    // so the row can prove their multiplicity survives the origin hop.
    let body = event.body || "";
    if (event.isBase64Encoded) {
      body = Buffer.from(body, "base64").toString("utf8");
    }
    const form = new URLSearchParams(body);
    const target = String(form.get("idp_authorize") || "");
    const state = String(form.get("state") || "");
    const separator = target.includes("?") ? "&" : "?";
    return {
      statusCode: 303,
      headers: { location: target + separator + "state=" + encodeURIComponent(state) + "&code=local-code" },
      cookies: ["sso=first; Path=/; HttpOnly", "sso=second; Path=/; SameSite=Lax"],
      body: "",
    };
  }
  return { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: page };
};
const page = [
  "<!doctype html>",
  "<html><head><meta charset=\\"utf-8\\"><title>AppTheory local TLS</title></head>",
  "<body><h1>AppTheory local TLS</h1>",
  "<p id=\\"origin\\"></p>",
  "<script>",
  "document.getElementById(\\"origin\\").textContent = location.origin;",
  "window.__apptheoryRegister = async function () {",
  "  const challenge = new Uint8Array(32); crypto.getRandomValues(challenge);",
  "  const user = { id: new Uint8Array(16), name: \\"local\\", displayName: \\"Local\\" };",
  "  const credential = await navigator.credentials.create({ publicKey: {",
  "    challenge, rp: { id: location.hostname, name: \\"AppTheory local\\" }, user,",
  "    pubKeyCredParams: [{ type: \\"public-key\\", alg: -7 }, { type: \\"public-key\\", alg: -257 }],",
  "    authenticatorSelection: { residentKey: \\"required\\", userVerification: \\"preferred\\" },",
  "    timeout: 30000, attestation: \\"none\\"",
  "  } });",
  "  const assertion = await navigator.credentials.get({ publicKey: {",
  "    challenge, rpId: location.hostname, allowCredentials: [{ type: \\"public-key\\", id: credential.rawId }],",
  "    userVerification: \\"preferred\\", timeout: 30000",
  "  } });",
  "  const encode = (value) => btoa(String.fromCharCode(...new Uint8Array(value)));",
  "  return { origin: location.origin, rpId: location.hostname, credentialId: encode(credential.rawId), assertionId: encode(assertion.rawId) };",
  "};",
  "</script></body></html>",
  ""
].join("\\n");
`;

const restEchoCode = `
"use strict";
exports.handler = async (event) => {
  const host = (event.headers && (event.headers.host || event.headers.Host)) || "";
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, surface: "rest-v1", method: event.httpMethod, path: event.path, host }),
  };
};
`;

const webSocketEchoCode = `
"use strict";
exports.handler = async (event) => {
  const route = (event.requestContext && event.requestContext.routeKey) || "$default";
  if (route === "$connect" || route === "$disconnect") {
    return { statusCode: 200 };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, route, message: event.body || "" }) };
};
`;

const callerNodeCode = `
"use strict";
const https = require("node:https");
const { DynamoDBClient, ListTablesCommand } = require("@aws-sdk/client-dynamodb");
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error("GET " + url + ": " + response.statusCode));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(10000, () => request.destroy(new Error("timeout")));
  });
}

// One SDK call per runner-served endpoint. The @connections endpoint is TLS,
// so reaching 410 GONE for an unknown connection proves the SDK verified the
// run CA presented by the management listener.
async function exerciseAWS() {
  const tables = await new DynamoDBClient({}).send(new ListTablesCommand({}));
  const client = new ApiGatewayManagementApiClient({});
  try {
    await client.send(new PostToConnectionCommand({
      ConnectionId: "apptheory-local-tls-probe",
      Data: Buffer.from("probe"),
    }));
  } catch (error) {
    const status = error && error.$metadata && error.$metadata.httpStatusCode;
    if (status !== 410) {
      throw new Error("the @connections call did not reach the run's TLS endpoint: " + error);
    }
    return { tables: (tables.TableNames || []).length, management: status };
  }
  throw new Error("the @connections call to an unknown connection must answer 410 GONE");
}

exports.handler = async (event) => {
  const base = String((event && event.url) || "");
  if (!base) { throw new Error("url is required"); }
  const discovery = await getJSON(base + "/.well-known/openid-configuration");
  if (discovery.issuer !== base) { throw new Error("issuer " + discovery.issuer + " != " + base); }
  const jwks = await getJSON(discovery.jwks_uri);
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) { throw new Error("jwks has no keys"); }
  const result = { ok: true, issuer: discovery.issuer, keys: jwks.keys.length };
  if (event && event.aws) {
    const aws = await exerciseAWS();
    result.tables = aws.tables;
    result.management = aws.management;
  }
  return result;
};
`;
