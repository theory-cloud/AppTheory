// Security Hub-aligned secure defaults (Factory docs/146 AT-N4).
//
// Every default in this file applies only when a construct receives an
// AppTheoryNamingContext. A consumer with no context keeps the pre-contract
// template, which the byte-identity and snapshot tests prove.

const assert = require("node:assert/strict");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const assertions = require("aws-cdk-lib/assertions");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const apigw = require("aws-cdk-lib/aws-apigateway");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const lambda = require("aws-cdk-lib/aws-lambda");
const s3 = require("aws-cdk-lib/aws-s3");

const apptheory = require("../lib");

const ACCOUNT = "998115851393";

function handler(stack, id = "Fn") {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
  });
}

function labContext(stack, overrides = {}) {
  return new apptheory.AppTheoryNamingContext(stack, "Naming", {
    app: "autheory",
    stage: "lab",
    account: ACCOUNT,
    region: "us-east-1",
    loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
    ...overrides,
  });
}

// A naming context and every stack that declares through it must resolve to one
// environment (SANITY-AT-N3-06), so the legacy-profile test builds its stack in
// the live account too.
const LAB_ENV = { account: ACCOUNT, region: "us-east-1" };
const LIVE_ENV = { account: "784055308075", region: "us-east-1" };

function synth(build, env = LAB_ENV) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env });
  build(stack);
  return assertions.Template.fromStack(stack).toJSON();
}

function resourcesOfType(template, type) {
  return Object.values(template.Resources ?? {}).filter((resource) => resource.Type === type);
}

function tables(template) {
  return resourcesOfType(template, "AWS::DynamoDB::Table");
}

function renderedString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderedString).join("");
  if (value && typeof value === "object" && Array.isArray(value["Fn::Join"])) {
    return renderedString(value["Fn::Join"][1]);
  }
  return JSON.stringify(value);
}

function tableNamed(template, name) {
  const found = tables(template).filter((table) => renderedString(table.Properties?.TableName) === name);
  assert.equal(found.length, 1, `expected exactly one table named ${name}`);
  return found[0];
}

function appBuild(overrides = {}, options = {}) {
  const withContext = options.withContext ?? true;
  return synth((stack) =>
    new apptheory.AppTheoryApp(stack, "App", {
      appName: "autheory-lab",
      runtime: lambda.Runtime.NODEJS_24_X,
      code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
      enableDatabase: true,
      enableRateLimiting: true,
      ...(withContext ? { namingContext: labContext(stack) } : {}),
      ...overrides,
    }),
  );
}

function microvmControllerBuild(stack, context, overrides = {}) {
  return new apptheory.AppTheoryMicrovmController(stack, "Controller", {
    namingContext: context,
    controller: {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
    },
    authorizer: handler(stack, "Authorizer"),
    microvmImage: {
      microvmImageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image/imported",
      logging: { disabled: true },
    },
    ingressNetworkConnectors: [apptheory.AppTheoryMicrovmNetworkConnector.allIngress(stack, "Ingress")],
    egressNetworkConnectors: [apptheory.AppTheoryMicrovmNetworkConnector.internetEgress(stack, "Egress")],
    shellIngressNetworkConnector: apptheory.AppTheoryMicrovmNetworkConnector.shellIngress(stack, "ShellIngress"),
    ...overrides,
  });
}

// ---- S1: DynamoDB ---------------------------------------------------------
//
// DynamoDB.2 (point-in-time recovery) and DynamoDB.6 (deletion protection):
// https://docs.aws.amazon.com/securityhub/latest/userguide/dynamodb-controls.html

// Each builder creates exactly one AppTheory-owned table and takes the naming
// context plus the removal policy the construct resolves for that table.
const tableBuilders = {
  AppTheoryDynamoTable: (stack, context, props = {}) =>
    new apptheory.AppTheoryDynamoTable(stack, "Table", {
      tableName: "apptheory-lab-table",
      partitionKeyName: "pk",
      sortKeyName: "sk",
      namingContext: context,
      ...props,
    }),
  AppTheoryJobsTable: (stack, context, props = {}) =>
    new apptheory.AppTheoryJobsTable(stack, "Table", { namingContext: context, ...props }),
  AppTheoryEventBusTable: (stack, context, props = {}) =>
    new apptheory.AppTheoryEventBusTable(stack, "Table", { namingContext: context, ...props }),
  AppTheoryWebSocketApi: (stack, context, props = {}) =>
    new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
      handler: handler(stack),
      namingContext: context,
      enableConnectionTable: true,
      ...props,
    }),
  AppTheoryMcpServer: (stack, context, props = {}) =>
    new apptheory.AppTheoryMcpServer(stack, "Mcp", {
      handler: handler(stack),
      namingContext: context,
      sessionState: { enabled: true },
      ...props,
    }),
  AppTheoryMicrovmController: (stack, context, props = {}) => microvmControllerBuild(stack, context, props),
};

test("S1: every AppTheory table enables point-in-time recovery and deletion protection under a naming context", () => {
  for (const [name, build] of Object.entries(tableBuilders)) {
    const template = synth((stack) => build(stack, labContext(stack)));
    const owned = tables(template);
    assert.equal(owned.length, 1, `${name} should create one table`);
    assert.equal(
      owned[0].Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled,
      true,
      `${name} should enable point-in-time recovery (DynamoDB.2)`,
    );
    assert.equal(owned[0].Properties?.DeletionProtectionEnabled, true, `${name} should enable deletion protection (DynamoDB.6)`);
  }
});

test("S1: the app construct protects its database and rate-limit tables", () => {
  const template = synth(
    (stack) =>
      new apptheory.AppTheoryApp(stack, "App", {
        appName: "autheory-lab",
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
        enableDatabase: true,
        enableRateLimiting: true,
        namingContext: labContext(stack),
      }),
  );
  const owned = tables(template);
  assert.equal(owned.length, 2);
  for (const table of owned) {
    assert.equal(table.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled, true);
    assert.equal(table.Properties?.DeletionProtectionEnabled, true);
  }
});

test("S1: the app construct's table deletion protection has an explicit override", () => {
  const database = (template) => tableNamed(template, "autheory-lab-table");
  const rateLimits = (template) => tableNamed(template, "autheory-lab-rate-limits");

  const databaseOff = appBuild({ databaseTableDeletionProtection: false });
  assert.notEqual(database(databaseOff).Properties?.DeletionProtectionEnabled, true);
  assert.equal(rateLimits(databaseOff).Properties?.DeletionProtectionEnabled, true);

  const rateLimitsOff = appBuild({ rateLimitTableDeletionProtection: false });
  assert.equal(database(rateLimitsOff).Properties?.DeletionProtectionEnabled, true);
  assert.notEqual(rateLimits(rateLimitsOff).Properties?.DeletionProtectionEnabled, true);

  const bothOff = appBuild({
    databaseTableDeletionProtection: false,
    rateLimitTableDeletionProtection: false,
  });
  assert.notEqual(database(bothOff).Properties?.DeletionProtectionEnabled, true);
  assert.notEqual(rateLimits(bothOff).Properties?.DeletionProtectionEnabled, true);
});

test("S1: an explicit true protects the app tables with no naming context", () => {
  const template = appBuild(
    {
      databaseTableDeletionProtection: true,
      rateLimitTableDeletionProtection: true,
    },
    { withContext: false },
  );
  assert.equal(tableNamed(template, "autheory-lab-table").Properties?.DeletionProtectionEnabled, true);
  assert.equal(tableNamed(template, "autheory-lab-rate-limits").Properties?.DeletionProtectionEnabled, true);
});

test("S1: no naming context and no props keeps the app template unchanged", () => {
  const template = appBuild({}, { withContext: false });
  for (const table of tables(template)) {
    assert.equal(table.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled, true);
    assert.equal(table.Properties?.DeletionProtectionEnabled, undefined);
  }
});

test("S1: a DESTROY removal policy keeps deletion protection off", () => {
  const cases = {
    AppTheoryDynamoTable: { removalPolicy: cdk.RemovalPolicy.DESTROY },
    AppTheoryJobsTable: { removalPolicy: cdk.RemovalPolicy.DESTROY },
    AppTheoryEventBusTable: { removalPolicy: cdk.RemovalPolicy.DESTROY },
    AppTheoryWebSocketApi: { connectionTableRemovalPolicy: cdk.RemovalPolicy.DESTROY },
    AppTheoryMcpServer: { sessionState: { enabled: true, removalPolicy: cdk.RemovalPolicy.DESTROY } },
    AppTheoryMicrovmController: { sessionTableRemovalPolicy: cdk.RemovalPolicy.DESTROY },
  };

  for (const [name, props] of Object.entries(cases)) {
    const template = synth((stack) => tableBuilders[name](stack, labContext(stack), props));
    const owned = tables(template);
    assert.equal(owned.length, 1, `${name} should create one table`);
    assert.notEqual(owned[0].Properties?.DeletionProtectionEnabled, true, `${name} must not protect a DESTROY table`);
    assert.equal(
      owned[0].Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled,
      true,
      `${name} keeps point-in-time recovery under DESTROY`,
    );
  }
});

test("S1: an explicit deletionProtection prop overrides the default both ways", () => {
  const off = synth((stack) =>
    tableBuilders.AppTheoryDynamoTable(stack, labContext(stack), { deletionProtection: false }),
  );
  assert.notEqual(tables(off)[0].Properties?.DeletionProtectionEnabled, true);

  const on = synth((stack) =>
    tableBuilders.AppTheoryDynamoTable(stack, labContext(stack), {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: true,
    }),
  );
  assert.equal(tables(on)[0].Properties?.DeletionProtectionEnabled, true);
});

test("S1: with no naming context no table gains deletion protection", () => {
  for (const [name, build] of Object.entries(tableBuilders)) {
    const template = synth((stack) => build(stack, undefined));
    const owned = tables(template);
    assert.equal(owned.length, 1, `${name} should create one table`);
    assert.equal(owned[0].Properties?.DeletionProtectionEnabled, undefined, `${name} must not change without a context`);
  }
  const appTemplate = synth(
    (stack) =>
      new apptheory.AppTheoryApp(stack, "App", {
        appName: "autheory-live",
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
        enableDatabase: true,
        enableRateLimiting: true,
      }),
  );
  for (const table of tables(appTemplate)) {
    assert.equal(table.Properties?.DeletionProtectionEnabled, undefined);
  }
});

test("S1: a legacy naming context keeps the pinned template and gains no protection", () => {
  for (const name of ["AppTheoryDynamoTable", "AppTheoryJobsTable", "AppTheoryEventBusTable"]) {
    const template = synth((stack) =>
      tableBuilders[name](
        stack,
        new apptheory.AppTheoryNamingContext(stack, "Naming", {
          app: "autheory",
          stage: "live",
          account: "784055308075",
          region: "us-east-1",
          namingProfile: apptheory.AppTheoryNamingProfile.LEGACY,
          loggingProfile: apptheory.AppTheoryLoggingProfile.LEGACY,
        }),
      ),
    );
    const owned = tables(template);
    assert.equal(owned.length, 1, `${name} should create one table`);
    assert.equal(owned[0].Properties?.DeletionProtectionEnabled, undefined, `${name} must keep the live template`);
  }
});

// An attached API does not receive a derived session-table name, but the
// secure-defaults decision is independent of naming: the table AppTheory
// creates is still covered by DynamoDB.6 under a derived context.
function attachMcpServer(stack, context, overrides = {}) {
  const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "AttachedApi", {
    httpApiId: "api-attached",
    apiEndpoint: "https://attached.execute-api.us-east-1.amazonaws.com",
  });
  return new apptheory.AppTheoryMcpServer(stack, "Mcp", {
    handler: handler(stack),
    api: importedApi,
    sessionState: { enabled: true },
    ...(context ? { namingContext: context } : {}),
    ...overrides,
  });
}

test("S1: an attached-API session table takes the derived deletion-protection default", () => {
  const template = synth((stack) => attachMcpServer(stack, labContext(stack)));
  const owned = tables(template);
  assert.equal(owned.length, 1, "attach mode still creates the session table");
  assert.equal(owned[0].Properties?.DeletionProtectionEnabled, true, "DynamoDB.6 must protect the attached-API table");
  assert.equal(owned[0].Properties?.TableName, undefined, "attach mode must not derive the session-table name");
});

test("S1: an attached-API session table keeps an explicit deletionProtection override", () => {
  const off = synth((stack) =>
    attachMcpServer(stack, labContext(stack), { sessionState: { enabled: true, deletionProtection: false } }),
  );
  assert.notEqual(tables(off)[0].Properties?.DeletionProtectionEnabled, true);

  const on = synth((stack) =>
    attachMcpServer(stack, labContext(stack), {
      sessionState: { enabled: true, removalPolicy: cdk.RemovalPolicy.DESTROY, deletionProtection: true },
    }),
  );
  assert.equal(tables(on)[0].Properties?.DeletionProtectionEnabled, true);
});

test("S1: an attached-API session table with DESTROY keeps deletion protection off", () => {
  const template = synth((stack) =>
    attachMcpServer(stack, labContext(stack), {
      sessionState: { enabled: true, removalPolicy: cdk.RemovalPolicy.DESTROY },
    }),
  );
  assert.notEqual(tables(template)[0].Properties?.DeletionProtectionEnabled, true);
});

test("S1: an attached-API session table is unchanged without a derived context", () => {
  const noContext = synth((stack) => attachMcpServer(stack, undefined));
  assert.equal(tables(noContext)[0].Properties?.DeletionProtectionEnabled, undefined);

  const legacy = synth((stack) =>
    attachMcpServer(
      stack,
      new apptheory.AppTheoryNamingContext(stack, "Naming", {
        app: "autheory",
        stage: "live",
        account: "784055308075",
        region: "us-east-1",
        namingProfile: apptheory.AppTheoryNamingProfile.LEGACY,
        loggingProfile: apptheory.AppTheoryLoggingProfile.LEGACY,
      }),
    ),
  );
  assert.equal(tables(legacy)[0].Properties?.DeletionProtectionEnabled, undefined);
});

// ---- S2: API custom domains -----------------------------------------------
//
// APIGateway.11 (recommended domain-name security policies):
// https://docs.aws.amazon.com/securityhub/latest/userguide/apigateway-controls.html
//
// The control accepts SecurityPolicy_TLS13_1_3_2025_09,
// SecurityPolicy_TLS13_1_3_FIPS_2025_09, SecurityPolicy_TLS13_1_2_PFS_PQ_2025_09,
// SecurityPolicy_TLS13_2025_EDGE and SecurityPolicy_TLS12_PFS_2025_EDGE, and
// always produces a FAILED finding for a custom domain attached to an HTTP API.

const CERT_ARN = `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/6f0a4b64-0000-0000-0000-000000000000`;

function restRouterWithDomain(stack, context, domain = {}) {
  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    namingContext: context,
    ...(context ? {} : { apiName: "apptheory-live-rest" }),
    domain: {
      domainName: "api.example.com",
      certificateArn: CERT_ARN,
      ...domain,
    },
  });
  router.addLambdaIntegration("/{proxy+}", ["ANY"], handler(stack));
  return router;
}

function restDomain(template) {
  const domains = resourcesOfType(template, "AWS::ApiGateway::DomainName");
  assert.equal(domains.length, 1);
  return domains[0].Properties;
}

test("S2: a derived context gives a REST custom domain an accepted security policy", () => {
  const template = synth((stack) => restRouterWithDomain(stack, labContext(stack)));
  const properties = restDomain(template);
  assert.equal(properties.SecurityPolicy, apigw.SecurityPolicy.TLS13_1_2_PFS_PQ_2025_09);
  assert.equal(properties.EndpointAccessMode, "STRICT");
});

test("S2: an edge REST custom domain takes the edge policy the control accepts", () => {
  const template = synth((stack) =>
    restRouterWithDomain(stack, labContext(stack), { endpointType: apigw.EndpointType.EDGE }),
  );
  assert.equal(restDomain(template).SecurityPolicy, apigw.SecurityPolicy.TLS12_PFS_2025_EDGE);
});

test("S2: an explicit REST security policy still wins", () => {
  const legacy = synth((stack) =>
    restRouterWithDomain(stack, labContext(stack), { securityPolicy: apigw.SecurityPolicy.TLS_1_2 }),
  );
  assert.equal(restDomain(legacy).SecurityPolicy, apigw.SecurityPolicy.TLS_1_2);
  assert.equal(restDomain(legacy).EndpointAccessMode, undefined);

  const enhanced = synth((stack) =>
    restRouterWithDomain(stack, labContext(stack), {
      securityPolicy: apigw.SecurityPolicy.TLS13_1_3_2025_09,
      endpointAccessMode: apigw.EndpointAccessMode.BASIC,
    }),
  );
  assert.equal(restDomain(enhanced).SecurityPolicy, apigw.SecurityPolicy.TLS13_1_3_2025_09);
  assert.equal(restDomain(enhanced).EndpointAccessMode, "BASIC");
});

test("S2: no naming context keeps the REST domain template unchanged", () => {
  const template = synth((stack) => restRouterWithDomain(stack, undefined));
  assert.equal(restDomain(template).SecurityPolicy, apigw.SecurityPolicy.TLS_1_2);
  assert.equal(restDomain(template).EndpointAccessMode, undefined);
});

test("S2: an HTTP API custom domain defaults to TLS 1.2 under a derived context", () => {
  const build = (stack, context) =>
    new apptheory.AppTheoryApiDomain(stack, "Domain", {
      domainName: "api.example.com",
      certificate: acm.Certificate.fromCertificateArn(stack, "Cert", CERT_ARN),
      httpApi: new apptheory.AppTheoryHttpApi(stack, "Api", { handler: handler(stack) }).api,
      namingContext: context,
    });

  const template = synth((stack) => build(stack, labContext(stack)));
  const domains = resourcesOfType(template, "AWS::ApiGatewayV2::DomainName");
  assert.equal(domains.length, 1);
  assert.equal(domains[0].Properties.DomainNameConfigurations[0].SecurityPolicy, apigwv2.SecurityPolicy.TLS_1_2);

  const untouched = synth((stack) => build(stack, undefined));
  const plain = resourcesOfType(untouched, "AWS::ApiGatewayV2::DomainName");
  assert.equal(plain[0].Properties.DomainNameConfigurations[0].SecurityPolicy, undefined);
});

// ---- R1: AppTheoryRemoteMcpServer -----------------------------------------
//
// The construct builds its REST API through AppTheoryRestApiRouter, so a naming
// context has to reach that internal router: the REST custom domain then takes
// the APIGateway.11 policy and endpoint access mode like every other REST
// domain. Without a context the template must not move.

function remoteMcpWithDomain(stack, context, domain = {}) {
  return new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
    handler: handler(stack),
    ...(context ? { namingContext: context } : { apiName: "apptheory-live-mcp" }),
    domain: { domainName: "mcp.example.com", certificateArn: CERT_ARN, ...domain },
  });
}

test("R1: a derived context gives the Remote MCP REST domain the APIGateway.11 policy", () => {
  const template = synth((stack) => remoteMcpWithDomain(stack, labContext(stack)));
  const properties = restDomain(template);
  assert.equal(properties.SecurityPolicy, apigw.SecurityPolicy.TLS13_1_2_PFS_PQ_2025_09);
  assert.equal(properties.EndpointAccessMode, "STRICT");
});

test("R1: explicit Remote MCP domain props still override the derived policy", () => {
  const legacy = synth((stack) =>
    remoteMcpWithDomain(stack, labContext(stack), { securityPolicy: apigw.SecurityPolicy.TLS_1_2 }),
  );
  assert.equal(restDomain(legacy).SecurityPolicy, apigw.SecurityPolicy.TLS_1_2);
  assert.equal(restDomain(legacy).EndpointAccessMode, undefined);

  const enhanced = synth((stack) =>
    remoteMcpWithDomain(stack, labContext(stack), {
      securityPolicy: apigw.SecurityPolicy.TLS13_1_3_2025_09,
      endpointAccessMode: apigw.EndpointAccessMode.BASIC,
    }),
  );
  assert.equal(restDomain(enhanced).SecurityPolicy, apigw.SecurityPolicy.TLS13_1_3_2025_09);
  assert.equal(restDomain(enhanced).EndpointAccessMode, "BASIC");
});

test("R1: no naming context keeps the Remote MCP REST domain template unchanged", () => {
  const template = synth((stack) => remoteMcpWithDomain(stack, undefined));
  const properties = restDomain(template);
  assert.equal(properties.SecurityPolicy, apigw.SecurityPolicy.TLS_1_2);
  assert.equal(properties.EndpointAccessMode, undefined);
});

// ---- S3: CloudFront -------------------------------------------------------
//
// CloudFront.15 (recommended TLS security policy) accepts TLSv1.2_2025 and
// TLSv1.3_2025 and evaluates only distributions with a custom certificate:
// https://docs.aws.amazon.com/securityhub/latest/userguide/cloudfront-controls.html
// CloudFront.1 (default root object) evaluates a distribution that carries S3
// origins and fails it when no default root object is configured; it does not
// apply to a distribution with custom origins only. AppTheory sets a root
// object only where `/` already reaches the S3 default behavior, because the
// rewrite `/` -> `/<object>` must not change which origin serves the root.

const TLS_2025 = cloudfront.SecurityPolicyProtocol.TLS_V1_2_2025;

function distributions(template) {
  return resourcesOfType(template, "AWS::CloudFront::Distribution").map(
    (resource) => resource.Properties.DistributionConfig,
  );
}

function ssrSiteBuild(stack, context, props = {}) {
  return new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: handler(stack),
    namingContext: context,
    ...props,
  });
}

test("S3: an SSR site distribution takes the CloudFront.15 policy when it serves a certificate", () => {
  const template = synth((stack) =>
    ssrSiteBuild(stack, labContext(stack), { domainName: "site.example.com", certificateArn: CERT_ARN }),
  );
  const [config] = distributions(template);
  assert.equal(config.ViewerCertificate.MinimumProtocolVersion, TLS_2025);
});

test("S3: an explicit minimumProtocolVersion still wins", () => {
  const template = synth((stack) =>
    ssrSiteBuild(stack, labContext(stack), {
      domainName: "site.example.com",
      certificateArn: CERT_ARN,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025,
    }),
  );
  assert.equal(
    distributions(template)[0].ViewerCertificate.MinimumProtocolVersion,
    cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025,
  );
});

test("S3: without a certificate the distribution keeps the CloudFront default certificate", () => {
  const template = synth((stack) => ssrSiteBuild(stack, labContext(stack)));
  assert.equal(distributions(template)[0].ViewerCertificate, undefined);
});

test("S3: no naming context keeps the SSR site template unchanged", () => {
  const template = synth((stack) =>
    ssrSiteBuild(stack, undefined, { domainName: "site.example.com", certificateArn: CERT_ARN }),
  );
  const [config] = distributions(template);
  assert.equal(config.ViewerCertificate.MinimumProtocolVersion, cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021);
  assert.equal(config.DefaultRootObject, undefined);
});

test("S3: a static SSR site root gets the CloudFront.1 default root object", () => {
  const staticSite = synth((stack) =>
    ssrSiteBuild(stack, labContext(stack), { mode: apptheory.AppTheorySsrSiteMode.SSG_ISR }),
  );
  assert.equal(distributions(staticSite)[0].DefaultRootObject, "index.html");

  const ssrOnly = synth((stack) => ssrSiteBuild(stack, labContext(stack)));
  assert.equal(
    distributions(ssrOnly)[0].DefaultRootObject,
    undefined,
    "an SSR-only root must reach the function URL, so the rewrite would change routing",
  );

  const overridden = synth((stack) =>
    ssrSiteBuild(stack, labContext(stack), {
      mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
      defaultRootObject: "home.html",
    }),
  );
  assert.equal(distributions(overridden)[0].DefaultRootObject, "home.html");
});

test("S3: the path-routed frontend takes the CloudFront.15 policy and no default root object", () => {
  const build = (stack, context) =>
    new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
      apiOriginUrl: "https://api.example.com",
      namingContext: context,
      domain: { domainName: "app.example.com", certificateArn: CERT_ARN },
    });

  const template = synth((stack) => build(stack, labContext(stack)));
  const [config] = distributions(template);
  assert.equal(config.ViewerCertificate.MinimumProtocolVersion, TLS_2025);
  assert.equal(config.DefaultRootObject, undefined, "the root is the API origin");

  const untouched = synth((stack) => build(stack, undefined));
  assert.equal(
    distributions(untouched)[0].ViewerCertificate.MinimumProtocolVersion,
    cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  );
});

test("S3: the media CDN takes the CloudFront.15 policy and keeps its explicit root object", () => {
  const build = (stack, context) =>
    new apptheory.AppTheoryMediaCdn(stack, "Media", {
      namingContext: context,
      domain: { domainName: "media.example.com", certificateArn: CERT_ARN },
      defaultRootObject: "health.txt",
    });

  const template = synth((stack) => build(stack, labContext(stack)));
  const [config] = distributions(template);
  assert.equal(config.ViewerCertificate.MinimumProtocolVersion, TLS_2025);
  assert.equal(config.DefaultRootObject, "health.txt");

  const untouched = synth((stack) => build(stack, undefined));
  assert.equal(
    distributions(untouched)[0].ViewerCertificate.MinimumProtocolVersion,
    cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  );
});

// ---- R2: CloudFront.1 per distribution ------------------------------------
//
// The control page says it "checks whether an Amazon CloudFront distribution
// with S3 origins is configured to return a specific object that is the default
// root object" and "fails if the CloudFront distribution uses S3 origins and
// doesn't have a default root object configured". AppTheory therefore takes a
// default only when `/` is already served by the S3 default behavior, and
// documents the distributions where the rewrite would change routing.

function defaultBehaviorOrigin(config) {
  return config.Origins.find((origin) => origin.Id === config.DefaultCacheBehavior.TargetOriginId);
}

test("R2: a derived context gives the media CDN a default root object", () => {
  const template = synth((stack) => new apptheory.AppTheoryMediaCdn(stack, "Media", { namingContext: labContext(stack) }));
  const [config] = distributions(template);
  assert.equal(config.DefaultRootObject, "index.html");
  assert.ok(
    defaultBehaviorOrigin(config).S3OriginConfig,
    "the media CDN root is already served by the S3 default behavior",
  );
});

test("R2: an explicit media CDN defaultRootObject still wins", () => {
  const template = synth((stack) =>
    new apptheory.AppTheoryMediaCdn(stack, "Media", {
      namingContext: labContext(stack),
      defaultRootObject: "health.txt",
    }),
  );
  assert.equal(distributions(template)[0].DefaultRootObject, "health.txt");
});

test("R2: no naming context leaves the media CDN root object unset", () => {
  const template = synth((stack) => new apptheory.AppTheoryMediaCdn(stack, "Media", {}));
  assert.equal(distributions(template)[0].DefaultRootObject, undefined);
});

test("R2: a distribution whose root must reach a custom origin takes no default root object", () => {
  const ssrOnly = synth((stack) => ssrSiteBuild(stack, labContext(stack)));
  const ssrConfig = distributions(ssrOnly)[0];
  assert.equal(ssrConfig.DefaultRootObject, undefined);
  assert.ok(
    ssrConfig.Origins.some((origin) => origin.S3OriginConfig !== undefined),
    "ssr-only carries the assets S3 origin, so CloudFront.1 evaluates the distribution",
  );
  assert.ok(
    defaultBehaviorOrigin(ssrConfig).CustomOriginConfig !== undefined,
    "`/` must reach the function URL",
  );

  const frontend = synth((stack) =>
    new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
      apiOriginUrl: "https://api.example.com",
      namingContext: labContext(stack),
      spaOrigins: [{ bucket: new s3.Bucket(stack, "SpaBucket"), pathPattern: "/l/*" }],
    }),
  );
  const frontendConfig = distributions(frontend)[0];
  assert.equal(frontendConfig.DefaultRootObject, undefined);
  assert.ok(
    frontendConfig.Origins.some((origin) => origin.S3OriginConfig !== undefined),
    "the SPA origin is S3, so CloudFront.1 evaluates the distribution",
  );
  assert.ok(
    defaultBehaviorOrigin(frontendConfig).CustomOriginConfig !== undefined,
    "`/` must reach the API origin",
  );
});

test("S3: the REST v1 challenge-restoration front door takes the CloudFront.15 policy", () => {
  const build = (stack, context) => {
    const rest = new apigw.RestApi(stack, "Rest", {
      restApiName: "apptheory-lab-rest",
      deployOptions: { stageName: "v1" },
    });
    rest.root.addMethod("GET", new apigw.MockIntegration());
    return new apptheory.AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
      secret: "restoration-secret-value-0123456789",
      originReachability: apptheory.AppTheoryRestV1OriginReachability.DISABLED,
      disableExecuteApiEndpointAsserted: true,
      origin: rest,
      domainNames: ["api.example.com"],
      certificate: acm.Certificate.fromCertificateArn(stack, "Cert", CERT_ARN),
      namingContext: context,
    });
  };

  const template = synth((stack) => build(stack, labContext(stack)));
  assert.equal(distributions(template)[0].ViewerCertificate.MinimumProtocolVersion, TLS_2025);

  const untouched = synth((stack) => build(stack, undefined));
  assert.equal(
    distributions(untouched)[0].ViewerCertificate.MinimumProtocolVersion,
    cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  );
});

// ---- S4: EventBridge ------------------------------------------------------
//
// EventBridge.3 (a custom event bus has a resource-based policy attached):
// https://docs.aws.amazon.com/securityhub/latest/userguide/eventbridge-controls.html

function busPolicies(template) {
  return resourcesOfType(template, "AWS::Events::EventBusPolicy").map((resource) => resource.Properties);
}

test("S4: a custom bus takes an owning-account resource policy under a derived context", () => {
  const template = synth(
    (stack) => new apptheory.AppTheoryEventBridgeBus(stack, "Bus", { namingContext: labContext(stack) }),
  );
  const policies = busPolicies(template);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].Statement.Effect, "Allow");
  assert.match(renderedString(policies[0].Statement.Principal.AWS), /^arn:.+:iam::998115851393:root$/);
  assert.equal(policies[0].Statement.Action, "events:*");
  assert.equal(policies[0].StatementId, "AllowOwningAccount");
  assert.equal(policies[0].StatementId, "AllowOwningAccount");
  assert.deepEqual(policies[0].Statement.Resource, { "Fn::GetAtt": [policies[0].EventBusName["Ref"], "Arn"] });
});

test("S4: an explicit cross-account allowlist still adds its own statements", () => {
  const template = synth(
    (stack) =>
      new apptheory.AppTheoryEventBridgeBus(stack, "Bus", {
        namingContext: labContext(stack),
        allowedAccountIds: ["111122223333"],
      }),
  );
  const policies = busPolicies(template);
  assert.equal(policies.length, 2);
  const partner = policies.find((policy) => policy.StatementId !== "AllowOwningAccount");
  assert.deepEqual(partner.Statement.Principal, { AWS: "111122223333" });
  assert.equal(partner.Statement.Action, "events:PutEvents");
});

test("S4: the owning-account policy can be turned off explicitly", () => {
  const template = synth(
    (stack) =>
      new apptheory.AppTheoryEventBridgeBus(stack, "Bus", {
        namingContext: labContext(stack),
        owningAccountResourcePolicy: false,
      }),
  );
  assert.equal(busPolicies(template).length, 0);
});

test("S4: no naming context keeps the bus template unchanged", () => {
  const template = synth((stack) => new apptheory.AppTheoryEventBridgeBus(stack, "Bus", {}));
  assert.equal(busPolicies(template).length, 0);
});

// ---- S5: S3 ---------------------------------------------------------------
//
// S3.5 (buckets require TLS) and S3.9 (server access logging):
// https://docs.aws.amazon.com/securityhub/latest/userguide/s3-controls.html

function tlsDenies(template) {
  return resourcesOfType(template, "AWS::S3::BucketPolicy").filter((resource) =>
    JSON.stringify(resource.Properties?.PolicyDocument ?? {}).includes("aws:SecureTransport"),
  );
}

test("S5: every bucket AppTheory creates denies non-TLS requests under a derived context", () => {
  const builders = {
    AppTheoryBucket: (stack, context) =>
      new apptheory.AppTheoryBucket(stack, "Bucket", { namingContext: context, logical: "assets" }),
    AppTheorySsrSite: (stack, context) =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: handler(stack),
        namingContext: context,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
      }),
    AppTheoryMediaCdn: (stack, context) => new apptheory.AppTheoryMediaCdn(stack, "Media", { namingContext: context }),
    AppTheoryS3Ingest: (stack) => new apptheory.AppTheoryS3Ingest(stack, "Ingest", {}),
    AppTheoryS3VersionedIngress: (stack) => new apptheory.AppTheoryS3VersionedIngress(stack, "Ingress", {}),
  };

  for (const [name, build] of Object.entries(builders)) {
    const template = synth((stack) => build(stack, labContext(stack)));
    const buckets = resourcesOfType(template, "AWS::S3::Bucket").length;
    assert.ok(buckets > 0, `${name} should create a bucket`);
    assert.equal(tlsDenies(template).length, buckets, `${name} should deny non-TLS requests on every bucket (S3.5)`);
  }
});

test("S5: an explicit enforceSSL false still wins", () => {
  const template = synth((stack) =>
    new apptheory.AppTheoryBucket(stack, "Bucket", {
      namingContext: labContext(stack),
      logical: "assets",
      enforceSSL: false,
    }),
  );
  assert.equal(tlsDenies(template).length, 0);
});

test("S5: a legacy naming context keeps AppTheoryBucket without the TLS policy", () => {
  const template = synth((stack) =>
    new apptheory.AppTheoryBucket(stack, "Bucket", {
      namingContext: new apptheory.AppTheoryNamingContext(stack, "Naming", {
        app: "autheory",
        stage: "live",
        account: "784055308075",
        region: "us-east-1",
        namingProfile: apptheory.AppTheoryNamingProfile.LEGACY,
        loggingProfile: apptheory.AppTheoryLoggingProfile.LEGACY,
        pins: { "s3_bucket:assets": "autheory-live-assets" },
      }),
      logical: "assets",
    }),
    LIVE_ENV,
  );
  assert.equal(tlsDenies(template).length, 0);
});

test("S5: server access logging is opt-in and off by default", () => {
  const without = synth((stack) =>
    new apptheory.AppTheorySsrSite(stack, "Site", {
      ssrFunction: handler(stack),
      namingContext: labContext(stack),
      mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    }),
  );
  assert.equal(
    resourcesOfType(without, "AWS::S3::Bucket").filter(
      (bucket) => bucket.Properties?.LoggingConfiguration !== undefined,
    ).length,
    0,
  );

  const withLogs = (name, build) => {
    const template = synth((stack) => build(stack, labContext(stack)));
    const logged = resourcesOfType(template, "AWS::S3::Bucket").filter(
      (bucket) => bucket.Properties?.LoggingConfiguration !== undefined,
    );
    assert.equal(logged.length, 1, `${name} should log to the supplied bucket`);
    assert.equal(logged[0].Properties.LoggingConfiguration.LogFilePrefix, "s3-access/");
  };
  withLogs("AppTheorySsrSite", (stack, context) =>
    new apptheory.AppTheorySsrSite(stack, "Site", {
      ssrFunction: handler(stack),
      namingContext: context,
      mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
      serverAccessLogsBucket: new s3.Bucket(stack, "LogTarget"),
      serverAccessLogsPrefix: "s3-access/",
    }),
  );
  withLogs("AppTheoryMediaCdn", (stack, context) =>
    new apptheory.AppTheoryMediaCdn(stack, "Media", {
      namingContext: context,
      serverAccessLogsBucket: new s3.Bucket(stack, "LogTarget"),
      serverAccessLogsPrefix: "s3-access/",
    }),
  );
});

test("S4: the owning-account policy cannot be attached twice", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env: { account: ACCOUNT, region: "us-east-1" } });
  const bus = new apptheory.AppTheoryEventBridgeBus(stack, "Bus", { namingContext: labContext(stack) });
  assert.throws(() => bus.allowOwningAccount(), /already attaches its owning-account resource policy/);

  const optedOut = new apptheory.AppTheoryEventBridgeBus(
    new cdk.Stack(app, "Stack2", { env: { account: ACCOUNT, region: "us-east-1" } }),
    "Bus",
    { namingContext: undefined, owningAccountResourcePolicy: false },
  );
  assert.ok(optedOut.allowOwningAccount() !== undefined);
  assert.throws(() => optedOut.allowOwningAccount(), /already attaches/);
});
