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

function synth(build) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env: { account: ACCOUNT, region: "us-east-1" } });
  build(stack);
  return assertions.Template.fromStack(stack).toJSON();
}

function resourcesOfType(template, type) {
  return Object.values(template.Resources ?? {}).filter((resource) => resource.Type === type);
}

function tables(template) {
  return resourcesOfType(template, "AWS::DynamoDB::Table");
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

// ---- S3: CloudFront -------------------------------------------------------
//
// CloudFront.15 (recommended TLS security policy) accepts TLSv1.2_2025 and
// TLSv1.3_2025 and evaluates only distributions with a custom certificate:
// https://docs.aws.amazon.com/securityhub/latest/userguide/cloudfront-controls.html
// CloudFront.1 (default root object) applies to S3-origin distributions and
// does not apply to custom origins.

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
    "an SSR-only root is served by the function URL, a custom origin the control does not evaluate",
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
