// Focused controls for the M5 direct-origin posture on AppTheoryMcpServer.
// DISABLED must be the actual owned-API default-endpoint disablement, not an
// assertion; LOCKED must add real mutual-TLS evidence on every mapped domain.
const assert = require("node:assert/strict");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const lambda = require("aws-cdk-lib/aws-lambda");
const assertions = require("aws-cdk-lib/assertions");

const apptheory = require("../lib");

const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";

function handler(stack, id = "Fn") {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
  });
}

function certificate(stack, id = "Certificate") {
  return acm.Certificate.fromCertificateArn(stack, id, CERTIFICATE_ARN);
}

function ordinaryDomain(stack, id = "McpDomain") {
  return {
    domainName: "mcp.example.com",
    certificate: certificate(stack, `${id}Certificate`),
  };
}

function resourcesOfType(template, type) {
  return Object.values(template.Resources ?? {}).filter((resource) => resource.Type === type);
}

function runtimeBearerFloor(extra = {}) {
  return {
    transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
    runtimePosture: { requireBearerToken: true },
    denialSignal: {},
    ownedApi: { stage: { throttlingEnabled: true } },
    sessionState: { enabled: false },
    ...extra,
  };
}

function routeAuthorizations(template) {
  return resourcesOfType(template, "AWS::ApiGatewayV2::Route")
    .map((route) => ({
      key: route.Properties.RouteKey,
      authorizationType: route.Properties.AuthorizationType ?? "NONE",
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

test("owned DISABLED disables execute-api and advertises only the ordinary custom domain", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OwnedDisabledStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    ...runtimeBearerFloor({ ownedApi: {
      stage: { throttlingEnabled: true },
      domain: ordinaryDomain(stack),
    } }),
  });
  const template = assertions.Template.fromStack(stack).toJSON();

  const [api] = resourcesOfType(template, "AWS::ApiGatewayV2::Api");
  assert.equal(api.Properties.DisableExecuteApiEndpoint, true);
  const domains = resourcesOfType(template, "AWS::ApiGatewayV2::DomainName");
  assert.equal(domains.length, 1);
  assert.equal(domains[0].Properties.DomainName, "mcp.example.com");
  assert.equal(
    domains[0].Properties.DomainNameConfigurations[0].MutualTlsAuthentication,
    undefined,
    "DISABLED keeps an ordinary domain, not an mTLS lock",
  );
  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::ApiMapping").length, 1);
  assert.ok(server.endpoints.length > 0);
  for (const endpoint of server.endpoints) {
    assert.match(endpoint, /^https:\/\/mcp\.example\.com\//);
    assert.doesNotMatch(endpoint, /execute-api/);
  }
  for (const route of routeAuthorizations(template)) {
    assert.equal(route.authorizationType, "NONE", `${route.key} keeps its runtime-bearer posture`);
  }
});

test("a deprecated domain prop is an effective domain for owned DISABLED", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "DeprecatedDomainStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    domain: ordinaryDomain(stack),
    ...runtimeBearerFloor(),
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::Api")[0].Properties.DisableExecuteApiEndpoint, true);
  assert.match(server.endpoint, /^https:\/\/mcp\.example\.com\//);
});

test("owned DISABLED without a domain fails before emitting an execute-api authority", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OwnedDisabledNoDomainStack");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
      ...runtimeBearerFloor(),
    }),
    /originReachability DISABLED requires an effective ownedApi\.domain/,
  );
});

test("attach DISABLED refuses an imported API with no in-stack disablement evidence", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "AttachImportedDisabledStack");
  const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
    httpApiId: "api-imported",
  });
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      api: importedApi,
      originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
      ...runtimeBearerFloor({
        ownedApi: undefined,
        owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
      }),
    }),
    /requires a same-stack concrete HttpApi/,
  );
});

test("attach DISABLED on a concrete API requires final DisableExecuteApiEndpoint=true", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "AttachConcreteDisabledStack");
  const api = new apigwv2.HttpApi(stack, "Frontdoor");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api,
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    ...runtimeBearerFloor({
      ownedApi: undefined,
      owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
    }),
  });
  assert.throws(
    () => assertions.Template.fromStack(stack),
    /requires the attached AWS::ApiGatewayV2::Api to set DisableExecuteApiEndpoint=true/,
  );
});

test("attach DISABLED on a concrete disabled API is accepted without mutating it", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "AttachConcreteDisabledProvenStack");
  const api = new apigwv2.HttpApi(stack, "Frontdoor", { disableExecuteApiEndpoint: true });
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api,
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    ...runtimeBearerFloor({
      ownedApi: undefined,
      owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
    }),
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const [cfnApi] = resourcesOfType(template, "AWS::ApiGatewayV2::Api");
  assert.equal(cfnApi.Properties.DisableExecuteApiEndpoint, true);
  assert.match(server.endpoint, /execute-api/, "attach endpoints stay execute-api origin templates");
});

test("owned DISABLED rejects a later L1 re-enable of the default endpoint", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OwnedDisabledOverrideStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    ...runtimeBearerFloor({
      ownedApi: { stage: { throttlingEnabled: true }, domain: ordinaryDomain(stack) },
    }),
  });
  const cfnApi = server.ownedApi.node.defaultChild;
  cfnApi.disableExecuteApiEndpoint = false;
  assert.throws(
    () => assertions.Template.fromStack(stack),
    /requires AWS::ApiGatewayV2::Api\.Properties\.DisableExecuteApiEndpoint to resolve to true/,
  );
});
