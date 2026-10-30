// Focused controls for the M5 direct-origin posture on AppTheoryMcpServer.
// DISABLED must be the actual owned-API default-endpoint disablement, not an
// assertion; LOCKED must add real mutual-TLS evidence on every mapped domain.
const assert = require("node:assert/strict");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const lambda = require("aws-cdk-lib/aws-lambda");
const s3 = require("aws-cdk-lib/aws-s3");
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

function mtlsDomain(stack, id = "McpMtlsDomain", version = "1") {
  return {
    domainName: "mcp.example.com",
    certificate: certificate(stack, `${id}Certificate`),
    mutualTlsAuthentication: {
      bucket: s3.Bucket.fromBucketName(stack, `${id}Truststore`, "truststore-bucket"),
      key: "truststore.pem",
      version,
    },
  };
}

function mtlsConfig(stack, id = "ExtraMtls") {
  return {
    bucket: s3.Bucket.fromBucketName(stack, `${id}Truststore`, "truststore-bucket"),
    key: "truststore.pem",
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

test("owned LOCKED requires mutual TLS on the mapped domain and is not a DISABLED alias", () => {
  const lockedStack = new cdk.Stack(new cdk.App(), "OwnedLockedStack");
  const locked = new apptheory.AppTheoryMcpServer(lockedStack, "McpServer", {
    handler: handler(lockedStack),
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    ...runtimeBearerFloor({
      ownedApi: { stage: { throttlingEnabled: true }, domain: mtlsDomain(lockedStack) },
    }),
  });
  const lockedTemplate = assertions.Template.fromStack(lockedStack).toJSON();

  const [lockedApi] = resourcesOfType(lockedTemplate, "AWS::ApiGatewayV2::Api");
  assert.equal(lockedApi.Properties.DisableExecuteApiEndpoint, true);
  const [lockedDomain] = resourcesOfType(lockedTemplate, "AWS::ApiGatewayV2::DomainName");
  const authentication = lockedDomain.Properties.DomainNameConfigurations[0].MutualTlsAuthentication
    ?? lockedDomain.Properties.MutualTlsAuthentication;
  assert.ok(authentication, "LOCKED must emit MutualTlsAuthentication");
  assert.ok(authentication.TruststoreUri, "LOCKED must carry a truststore URI");
  assert.equal(authentication.TruststoreVersion, "1");
  assert.equal(resourcesOfType(lockedTemplate, "AWS::ApiGatewayV2::ApiMapping").length, 1);
  for (const endpoint of locked.endpoints) {
    assert.match(endpoint, /^https:\/\/mcp\.example\.com\//);
    assert.doesNotMatch(endpoint, /execute-api/);
  }
  for (const route of routeAuthorizations(lockedTemplate)) {
    assert.equal(route.authorizationType, "NONE");
  }

  const disabledStack = new cdk.Stack(new cdk.App(), "OwnedDisabledCompareStack");
  new apptheory.AppTheoryMcpServer(disabledStack, "McpServer", {
    handler: handler(disabledStack),
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    ...runtimeBearerFloor({
      ownedApi: { stage: { throttlingEnabled: true }, domain: ordinaryDomain(disabledStack) },
    }),
  });
  const disabledTemplate = assertions.Template.fromStack(disabledStack).toJSON();
  const [disabledDomain] = resourcesOfType(disabledTemplate, "AWS::ApiGatewayV2::DomainName");
  assert.equal(
    disabledDomain.Properties.DomainNameConfigurations[0].MutualTlsAuthentication
      ?? disabledDomain.Properties.MutualTlsAuthentication,
    undefined,
    "DISABLED stays an ordinary domain; the postures are enforcement-distinct",
  );
});

test("none-public LOCKED keeps its three transport routes public but locks ingress", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "NonePublicLockedStack");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    routeFamily: { patterns: ["/mcp"] },
    transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true }, domain: mtlsDomain(stack) },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(
    routeAuthorizations(template).map((route) => route.key),
    ["DELETE /mcp", "GET /mcp", "POST /mcp"],
  );
  for (const route of routeAuthorizations(template)) {
    assert.equal(route.authorizationType, "NONE");
  }
  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::Api")[0].Properties.DisableExecuteApiEndpoint, true);
});

test("enum-only and ordinary-domain LOCKED fail before emission", () => {
  const cases = [
    {
      name: "no domain",
      ownedApi: { stage: { throttlingEnabled: true } },
      error: /LOCKED requires an effective ownedApi\.domain with mutualTlsAuthentication/,
    },
    {
      name: "ordinary domain",
      ownedApi: { stage: { throttlingEnabled: true }, domain: ordinaryDomain },
      error: /LOCKED requires ownedApi\.domain\.mutualTlsAuthentication/,
    },
  ];
  for (const item of cases) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `LockedInvalid${item.name.replace(/[^A-Za-z0-9]/g, "")}`);
    const domain = typeof item.ownedApi.domain === "function"
      ? item.ownedApi.domain(stack)
      : item.ownedApi.domain;
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
        ...runtimeBearerFloor({
          ownedApi: { stage: { throttlingEnabled: true }, domain },
        }),
      }),
      item.error,
      item.name,
    );
  }
});

test("attach LOCKED fails for imported and concrete APIs", () => {
  for (const kind of ["imported", "concrete"]) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `AttachLocked${kind}`);
    const api = kind === "imported"
      ? apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", { httpApiId: "api-imported" })
      : new apigwv2.HttpApi(stack, "Frontdoor", { disableExecuteApiEndpoint: true });
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        api,
        transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
        runtimePosture: { requireBearerToken: true },
        originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
        denialSignal: {},
        owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
        sessionState: { enabled: false },
      }),
      /originReachability LOCKED is unsupported in attach mode/,
      kind,
    );
  }
});

test("mutual TLS without an owned LOCKED declaration is contradictory", () => {
  const cases = [
    {
      name: "DISABLED with mTLS",
      props: {
        originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
      },
    },
    {
      name: "IAM with mTLS and no origin decision",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.IAM,
        runtimePosture: undefined,
      },
    },
  ];
  for (const item of cases) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `ContradictoryMtls${item.name.replace(/[^A-Za-z0-9]/g, "")}`);
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        sessionState: { enabled: false },
        ...runtimeBearerFloor(),
        ...item.props,
        ownedApi: { stage: { throttlingEnabled: true }, domain: mtlsDomain(stack) },
      }),
      /mutualTlsAuthentication is only valid with originReachability LOCKED/,
      item.name,
    );
  }
});

function lockedServer(stack, extra = {}) {
  return new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    ...runtimeBearerFloor({
      ownedApi: { stage: { throttlingEnabled: true }, domain: mtlsDomain(stack) },
    }),
    ...extra,
  });
}

function extraMapping(stack, server, domainName) {
  const stage = new apigwv2.HttpStage(stack, "ExtraStage", {
    httpApi: server.ownedApi,
    stageName: "extra",
    autoDeploy: true,
  });
  new apigwv2.ApiMapping(stack, "ExtraMapping", {
    api: server.ownedApi,
    domainName,
    stage,
  });
}

test("LOCKED accepts an additional mapping only when its domain also has mTLS", () => {
  const conformingStack = new cdk.Stack(new cdk.App(), "LockedAdditionalMtlsStack");
  const conforming = lockedServer(conformingStack);
  const mtlsDomainName = new apigwv2.DomainName(conformingStack, "ExtraMtlsDomain", {
    domainName: "extra.example.com",
    certificate: certificate(conformingStack, "ExtraCertificate"),
    mtls: mtlsConfig(conformingStack),
  });
  extraMapping(conformingStack, conforming, mtlsDomainName);
  assertions.Template.fromStack(conformingStack);

  const ordinaryStack = new cdk.Stack(new cdk.App(), "LockedAdditionalOrdinaryStack");
  const nonconforming = lockedServer(ordinaryStack);
  const ordinaryDomainName = new apigwv2.DomainName(ordinaryStack, "ExtraOrdinaryDomain", {
    domainName: "extra.example.com",
    certificate: certificate(ordinaryStack, "ExtraCertificate"),
  });
  extraMapping(ordinaryStack, nonconforming, ordinaryDomainName);
  assert.throws(
    () => assertions.Template.fromStack(ordinaryStack),
    /requires every mapping to target a domain with MutualTlsAuthentication\.TruststoreUri/,
  );
});

test("LOCKED fails on unresolved domain evidence and missing truststore URIs", () => {
  {
    const stack = new cdk.Stack(new cdk.App(), "LockedImportedDomainStack");
    const server = lockedServer(stack);
    const importedDomain = apigwv2.DomainName.fromDomainNameAttributes(stack, "ImportedDomain", {
      name: "imported.example.com",
      regionalDomainName: "d111111abcdef8.cloudfront.net",
      regionalHostedZoneId: "Z2FDTNDATAQYW2",
    });
    extraMapping(stack, server, importedDomain);
    assert.throws(
      () => assertions.Template.fromStack(stack),
      /cannot resolve mapping .* to an in-stack AWS::ApiGatewayV2::DomainName/,
    );
  }
  {
    const stack = new cdk.Stack(new cdk.App(), "LockedEmptyMtlsStack");
    const server = lockedServer(stack);
    server.domainName.node.defaultChild.mutualTlsAuthentication = {};
    assert.throws(
      () => assertions.Template.fromStack(stack),
      /requires every mapping to target a domain with MutualTlsAuthentication\.TruststoreUri/,
    );
  }
});

test("LOCKED rejects removing mTLS or re-enabling the default endpoint after construction", () => {
  {
    const stack = new cdk.Stack(new cdk.App(), "LockedRemoveMtlsStack");
    const server = lockedServer(stack);
    server.domainName.node.defaultChild.mutualTlsAuthentication = undefined;
    assert.throws(
      () => assertions.Template.fromStack(stack),
      /requires every mapping to target a domain with MutualTlsAuthentication\.TruststoreUri/,
    );
  }
  {
    const stack = new cdk.Stack(new cdk.App(), "LockedReenableStack");
    const server = lockedServer(stack);
    server.ownedApi.node.defaultChild.disableExecuteApiEndpoint = false;
    assert.throws(
      () => assertions.Template.fromStack(stack),
      /LOCKED requires AWS::ApiGatewayV2::Api\.Properties\.DisableExecuteApiEndpoint to resolve to true/,
    );
  }
});
