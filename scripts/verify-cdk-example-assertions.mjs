#!/usr/bin/env node
// Focused construct assertions for the CDK examples that were never synthesized
// in CI. scripts/verify-cdk-synth.sh hashes every template; a hash alone would
// also accept a template that lost the feature the example exists to show, so
// each of these stacks is checked for the resources and properties its README
// promises. Templates are read from the synthesis output, never from a mock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [stackName, templatePath] = process.argv.slice(2);
if (!stackName || !templatePath) {
  console.error("usage: verify-cdk-example-assertions.mjs <stack-name> <template.json>");
  process.exit(2);
}

const template = JSON.parse(readFileSync(templatePath, "utf8"));
const resources = template.Resources ?? {};
const entries = Object.entries(resources);

function byType(type) {
  return entries.filter(([, resource]) => resource.Type === type);
}

function byId(id) {
  const resource = resources[id];
  assert.ok(resource, `missing resource ${id}`);
  return resource;
}

function props(id) {
  return byId(id).Properties ?? {};
}

// CloudFormation encodes generated ARNs/names as Fn::Join; flattening the
// static parts makes an assertion readable without evaluating the template.
function flat(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flat).join("");
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value["Fn::Join"])) {
      return flat(value["Fn::Join"][1]);
    }
    return Object.values(value).map(flat).join("");
  }
  return "";
}

function statementsOf(type) {
  return byType(type).flatMap(([, resource]) => {
    const document = resource.Properties?.PolicyDocument ?? resource.Properties;
    const statements = document?.Statement ?? [];
    return Array.isArray(statements) ? statements : [statements];
  });
}

function actionsOf(statements) {
  return statements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action],
  );
}

function assertHasAction(statements, action) {
  assert.ok(actionsOf(statements).includes(action), `expected an IAM statement allowing ${action}`);
}

function assertHasActionPrefix(statements, prefix) {
  assert.ok(
    actionsOf(statements).some((action) => String(action).startsWith(prefix)),
    `expected an IAM statement allowing ${prefix}*`,
  );
}

const assertions = {
  AppTheoryCodeBuildJobRunnerExample() {
    const projects = byType("AWS::CodeBuild::Project");
    assert.equal(projects.length, 1, "expected one CodeBuild project");
    const project = projects[0][1].Properties;
    const names = project.Environment.EnvironmentVariables.map((entry) => entry.Name);
    for (const name of ["APPTHEORY_JOBS_TABLE_NAME", "INGEST_BUCKET", "SECRET_ARN"]) {
      assert.ok(names.includes(name), `project is missing environment variable ${name}`);
    }

    const rules = byType("AWS::Events::Rule");
    assert.equal(rules.length, 1, "expected one state-change rule");
    const rule = rules[0][1].Properties;
    assert.equal(rule.Name, "import-job-runner-state-changes");
    assert.deepEqual(rule.EventPattern.source, ["aws.codebuild"]);
    assert.deepEqual(rule.EventPattern["detail-type"], ["CodeBuild Build State Change"]);
    assert.equal(flat(rule.EventPattern.detail["project-name"]), flat({ Ref: projects[0][0] }));

    const policies = statementsOf("AWS::IAM::Policy");
    assertHasAction(policies, "dynamodb:GetItem");
    assertHasAction(policies, "dynamodb:PutItem");
    assertHasActionPrefix(policies, "s3:GetObject");
    assertHasAction(policies, "secretsmanager:GetSecretValue");
  },

  LambdaRoleExample() {
    const roles = byType("AWS::IAM::Role");
    const roleNames = roles
      .map(([, role]) => role.Properties.RoleName)
      .filter((name) => typeof name === "string" && name.startsWith("apptheory-"));
    assert.deepEqual(roleNames.sort(), [
      "apptheory-basic-lambda-role",
      "apptheory-custom-lambda-role",
      "apptheory-dynamic-lambda-role",
      "apptheory-encrypted-lambda-role",
      "apptheory-tracing-lambda-role",
    ]);

    const functions = byType("AWS::Lambda::Function").filter(
      ([id]) => !id.includes("AutoDeleteObjects"),
    );
    assert.equal(functions.length, 7, "expected seven example functions");
    assert.ok(
      functions.some(([, fn]) => fn.Properties.Handler === "authorizer.handler"),
      "missing the authorizer echo function",
    );
    assert.ok(
      functions.some(([, fn]) => fn.Properties.Handler === "policy-authorizer.handler"),
      "missing the IAM-policy authorizer function",
    );
    // The JWT and Cognito authorizers the runner validates tokens against.
    const jwtAuthorizers = byType("AWS::ApiGatewayV2::Authorizer").filter(
      ([, authorizer]) => authorizer.Properties.AuthorizerType === "JWT",
    );
    assert.equal(jwtAuthorizers.length, 1, "missing the HTTP API JWT authorizer");
    assert.ok(
      jwtAuthorizers[0][1].Properties.JwtConfiguration?.Issuer,
      "the JWT authorizer has no issuer",
    );
    const cognitoAuthorizers = byType("AWS::ApiGateway::Authorizer").filter(
      ([, authorizer]) => authorizer.Properties.Type === "COGNITO_USER_POOLS",
    );
    assert.equal(cognitoAuthorizers.length, 1, "missing the REST Cognito authorizer");
    // The REST TOKEN/REQUEST and HTTP API IAM-policy authorizers R2b serves.
    const tokenAuthorizer = byType("AWS::ApiGateway::Authorizer").find(
      ([, authorizer]) => authorizer.Properties.Type === "TOKEN",
    );
    assert.ok(tokenAuthorizer, "missing the REST TOKEN authorizer");
    assert.equal(tokenAuthorizer[1].Properties.AuthorizerResultTtlInSeconds, 60);
    assert.equal(
      tokenAuthorizer[1].Properties.IdentitySource,
      "method.request.header.Authorization",
    );
    const requestAuthorizer = byType("AWS::ApiGateway::Authorizer").find(
      ([, authorizer]) => authorizer.Properties.Type === "REQUEST",
    );
    assert.ok(requestAuthorizer, "missing the REST REQUEST authorizer");
    assert.equal(
      requestAuthorizer[1].Properties.IdentitySource,
      "method.request.header.X-Tenant, method.request.querystring.scope",
    );
    const policyHttpAuthorizers = byType("AWS::ApiGatewayV2::Authorizer").filter(
      ([, authorizer]) => authorizer.Properties.AuthorizerType === "REQUEST",
    );
    assert.equal(policyHttpAuthorizers.length, 1, "missing the HTTP API policy authorizer");
    assert.notEqual(
      policyHttpAuthorizers[0][1].Properties.EnableSimpleResponses,
      true,
      "the HTTP API policy authorizer must not use simple responses",
    );
    const customMethods = byType("AWS::ApiGateway::Method").filter(
      ([, method]) => method.Properties.AuthorizationType === "CUSTOM",
    );
    assert.equal(customMethods.length, 3, "expected three CUSTOM-authorizer methods");
    const scopedMethods = byType("AWS::ApiGateway::Method").filter(
      ([, method]) => method.Properties.AuthorizationType === "COGNITO_USER_POOLS",
    );
    assert.equal(scopedMethods.length, 2, "expected two Cognito-protected methods");
    assert.deepEqual(
      scopedMethods.map(([, method]) => method.Properties.AuthorizationScopes).sort(),
      [["api/admin"], ["aws.cognito.signin.user.admin"]],
    );
    const tracing = functions.filter(([, fn]) => fn.Properties.TracingConfig?.Mode === "Active");
    assert.equal(tracing.length, 3, "expected three X-Ray-traced functions");
    const encrypted = functions.find(([, fn]) => fn.Properties.Handler === "encrypted.handler");
    assert.ok(encrypted, "missing encrypted handler function");
    assert.ok(encrypted[1].Properties.KmsKeyArn, "encrypted function has no KMS key");

    assert.equal(byType("AWS::KMS::Key").length, 2, "expected two KMS keys");
    assert.equal(byType("AWS::KMS::Alias").length, 2, "expected two KMS aliases");

    const policies = statementsOf("AWS::IAM::Policy");
    for (const action of [
      "xray:PutTraceSegments",
      "kms:Decrypt",
      "kms:Encrypt",
      "s3:GetObject",
      "ssm:GetParameter",
      "secretsmanager:GetSecretValue",
    ]) {
      assertHasAction(policies, action);
    }
    const managed = byType("AWS::IAM::Role").flatMap(
      ([, role]) => role.Properties.ManagedPolicyArns ?? [],
    );
    assert.ok(
      managed.some((arn) => flat(arn).includes("AmazonSQSReadOnlyAccess")),
      "missing AmazonSQSReadOnlyAccess managed policy",
    );
  },

  AppTheoryLambdaPackagingExample() {
    const layers = byType("AWS::Lambda::LayerVersion");
    assert.equal(layers.length, 2, "expected the Node and Python layers");
    const layerFunctions = byType("AWS::Lambda::Function").filter(
      ([, fn]) => Array.isArray(fn.Properties.Layers) && fn.Properties.Layers.length === 1,
    );
    assert.equal(layerFunctions.length, 2, "expected two functions that declare a layer");
    const imageFunctions = byType("AWS::Lambda::Function").filter(
      ([, fn]) => fn.Properties.PackageType === "Image",
    );
    assert.equal(imageFunctions.length, 3, "expected three container-image functions");
    const buildArgs = imageFunctions.map(
      ([, fn]) => fn.Metadata?.["aws:asset:docker-build-args"]?.["IMAGE_VALUE"],
    );
    assert.deepEqual(buildArgs.sort(), ["go-image-build", "node-image-build", "python-image-build"]);
    for (const [id, fn] of imageFunctions) {
      assert.ok(fn.Metadata?.["aws:asset:path"], `${id} has no Docker asset path`);
      assert.ok(fn.Metadata?.["aws:asset:dockerfile-path"], `${id} has no Dockerfile`);
      assert.ok(fn.Properties.Code?.ImageUri, `${id} has no ImageUri`);
    }
    const routes = byType("AWS::ApiGatewayV2::Route").map(
      ([, route]) => route.Properties.RouteKey,
    );
    assert.deepEqual(routes.sort(), [
      "GET /image/go",
      "GET /image/node",
      "GET /image/python",
      "GET /layer/node",
      "GET /layer/python",
    ]);
  },

  EdgeGatewayExample() {
    const distributions = byType("AWS::CloudFront::Distribution");
    assert.equal(distributions.length, 1, "expected the edge distribution");
    const edgeConfig = distributions[0][1].Properties.DistributionConfig;
    assert.equal(edgeConfig.Comment, "Edge gateway distribution");

    const versions = byType("AWS::Lambda::Version");
    assert.equal(versions.length, 4, "expected four Lambda@Edge versions");
    const behavior = edgeConfig.DefaultCacheBehavior;
    const associations = behavior.LambdaFunctionAssociations ?? [];
    assert.deepEqual(
      associations.map((association) => association.EventType).sort(),
      ["origin-request", "origin-response", "viewer-request", "viewer-response"],
      "the default behavior must carry all four Lambda@Edge events",
    );
    for (const association of associations) {
      assert.ok(association.LambdaFunctionARN.Ref, "a Lambda@Edge association must reference a version");
      const version = resources[association.LambdaFunctionARN.Ref];
      assert.equal(version.Type, "AWS::Lambda::Version", "the association must name a numbered version");
    }
    for (const eventType of ["viewer-request", "origin-request"]) {
      const association = associations.find((entry) => entry.EventType === eventType);
      assert.equal(association.IncludeBody, true, `${eventType} must include the body`);
    }

    const stores = byType("AWS::CloudFront::KeyValueStore");
    assert.equal(stores.length, 1, "expected one key value store");
    const functions = byType("AWS::CloudFront::Function");
    assert.equal(functions.length, 1, "expected one CloudFront Function");
    assert.equal(functions[0][1].Properties.FunctionConfig.Runtime, "cloudfront-js-2.0");
    const associationsOf = functions[0][1].Properties.FunctionConfig.KeyValueStoreAssociations ?? [];
    assert.equal(associationsOf.length, 1, "the function must be associated with the store");
    const storeRef = associationsOf[0].KeyValueStoreARN ?? {};
    const storeTarget = storeRef.Ref ?? (storeRef["Fn::GetAtt"] ?? [])[0];
    assert.equal(storeTarget, stores[0][0], "the association must name the key value store");
  },

  MediaCdnExample() {
    const distributions = byType("AWS::CloudFront::Distribution");
    assert.equal(distributions.length, 2, "expected public and private distributions");
    const configs = distributions.map(([, distribution]) => distribution.Properties.DistributionConfig);
    const publicConfig = configs.find((config) => config.Comment.startsWith("Public media"));
    const privateConfig = configs.find((config) => config.Comment.startsWith("Private media"));
    assert.ok(publicConfig, "missing public media distribution");
    assert.ok(privateConfig, "missing private media distribution");

    assert.equal(byType("AWS::CloudFront::KeyGroup").length, 1, "expected one key group");
    assert.equal(byType("AWS::CloudFront::PublicKey").length, 1, "expected one public key");
    const keyGroup = byType("AWS::CloudFront::KeyGroup")[0][0];
    assert.deepEqual(privateConfig.DefaultCacheBehavior.TrustedKeyGroups, [{ Ref: keyGroup }]);
    assert.equal(publicConfig.DefaultCacheBehavior.TrustedKeyGroups, undefined);

    for (const config of configs) {
      assert.equal(config.Origins.length, 1, "expected one S3 origin per distribution");
      assert.ok(
        config.Origins[0].OriginAccessControlId,
        "media origin must use an origin access control",
      );
    }
    const mediaBuckets = byType("AWS::S3::Bucket").filter(([id]) => id.includes("MediaBucket"));
    assert.equal(mediaBuckets.length, 2, "expected one media bucket per distribution");
  },

  PathRoutedFrontendExample() {
    const distributions = byType("AWS::CloudFront::Distribution");
    assert.equal(distributions.length, 1, "expected one distribution");
    const config = distributions[0][1].Properties.DistributionConfig;
    const apiOrigin = config.Origins.find((origin) =>
      String(origin.DomainName).includes("execute-api"),
    );
    assert.ok(apiOrigin, "missing API origin");
    assert.equal(config.DefaultCacheBehavior.TargetOriginId, apiOrigin.Id);

    const behaviors = new Map(
      (config.CacheBehaviors ?? []).map((behavior) => [behavior.PathPattern, behavior]),
    );
    assert.deepEqual([...behaviors.keys()].sort(), ["/auth/*", "/auth/wallet/*", "/l/*"]);
    assert.equal(behaviors.get("/auth/wallet/*").TargetOriginId, apiOrigin.Id);
    for (const pattern of ["/l/*", "/auth/*"]) {
      const behavior = behaviors.get(pattern);
      assert.ok(behavior.TargetOriginId.startsWith("PathRoutedFrontendExampleFrontendDistributionOrigin"), pattern);
      const events = (behavior.FunctionAssociations ?? []).map((association) => association.EventType);
      assert.deepEqual(events, ["viewer-request"], `${pattern} must rewrite viewer requests`);
    }
    assert.equal(behaviors.get("/auth/wallet/*").FunctionAssociations, undefined);

    const functions = byType("AWS::CloudFront::Function");
    assert.equal(functions.length, 1, "expected one SPA rewrite function");
    const buckets = byType("AWS::S3::Bucket").filter(([id]) => id.includes("Bucket"));
    assert.equal(buckets.length, 3, "expected two SPA buckets and the log bucket");
  },

  RestV1RouterExample() {
    assert.equal(byType("AWS::ApiGateway::RestApi").length, 1, "expected one REST API");
    assert.equal(byType("AWS::Lambda::Function").length, 4, "expected four routed functions");

    const methods = byType("AWS::ApiGateway::Method").map(([, method]) => method.Properties);
    const integrations = methods.filter(
      (method) => method.Integration?.Type === "AWS_PROXY",
    );

    const streaming = integrations.filter(
      (integration) => integration.Integration.ResponseTransferMode === "STREAM",
    );
    assert.equal(streaming.length, 1, "expected exactly one streaming integration");
    assert.equal(streaming[0].HttpMethod, "GET");
    assert.equal(
      integrations.filter((method) => method.Integration.ResponseTransferMode === "BUFFERED").length,
      5,
      "expected five buffered integrations (graphql, inventory, proxy)",
    );

    const resourceParts = byType("AWS::ApiGateway::Resource").map(
      ([, resource]) => resource.Properties.PathPart,
    );
    for (const part of ["sse", "api", "graphql", "inventory", "{id}", "{proxy+}"]) {
      assert.ok(resourceParts.includes(part), `missing REST resource part ${part}`);
    }

    const stage = byType("AWS::ApiGateway::Stage")[0][1].Properties;
    assert.equal(stage.StageName, "prod");
    assert.ok(stage.AccessLogSetting?.DestinationArn, "stage is missing access logging");
    const settings = stage.MethodSettings[0];
    assert.equal(settings.ThrottlingRateLimit, 100);
    assert.equal(settings.ThrottlingBurstLimit, 200);
    assert.equal(settings.MetricsEnabled, true);
  },

  SqsQueueExample() {
    const queues = new Map(
      byType("AWS::SQS::Queue").map(([, queue]) => [queue.Properties.QueueName, queue.Properties]),
    );
    for (const name of [
      "contract-events",
      "contract-events-dlq",
      "events-queue",
      "events-queue-dlq",
      "simple-queue",
      "simple-queue-dlq",
    ]) {
      assert.ok(queues.has(name), `missing queue ${name}`);
    }
    assert.equal(queues.get("contract-events").RedrivePolicy.maxReceiveCount, 3);
    assert.equal(queues.get("events-queue").RedrivePolicy.maxReceiveCount, 5);
    assert.equal(queues.get("simple-queue").RedrivePolicy.maxReceiveCount, 3);
    assert.equal(queues.get("contract-events").VisibilityTimeout, 60);
    assert.equal(queues.get("events-queue").VisibilityTimeout, 300);

    const mappings = byType("AWS::Lambda::EventSourceMapping").map(
      ([, mapping]) => mapping.Properties,
    );
    const worker = mappings.find((mapping) => mapping.BatchSize === 100);
    assert.ok(worker, "missing the batch-100 worker mapping");
    assert.equal(worker.MaximumBatchingWindowInSeconds, 10);
    assert.deepEqual(worker.FunctionResponseTypes, ["ReportBatchItemFailures"]);
    assert.ok(
      mappings.some((mapping) => mapping.BatchSize === 1),
      "missing the single-message DLQ mapping",
    );
    assert.ok(
      mappings.some(
        (mapping) => mapping.BatchSize === 50 && mapping.MaximumBatchingWindowInSeconds === 5,
      ),
      "missing the processor mapping",
    );

    // The S3 notification destinations are declared through CDK's
    // Bucket.addEventNotification, whose custom resource carries the bucket API
    // shape the runner reads. Losing it would silently drop the row's proof.
    const notifications = byType("Custom::S3BucketNotifications");
    assert.equal(notifications.length, 1, "missing the bucket notification configuration");
    const configuration = notifications[0][1].Properties.NotificationConfiguration;
    assert.equal(configuration.LambdaFunctionConfigurations.length, 1);
    assert.deepEqual(configuration.LambdaFunctionConfigurations[0].Events, ["s3:ObjectCreated:*"]);
    const rules = configuration.LambdaFunctionConfigurations[0].Filter.Key.FilterRules;
    assert.ok(rules.some((rule) => rule.Name === "prefix" && rule.Value === "incoming/"));
    assert.ok(rules.some((rule) => rule.Name === "suffix" && rule.Value === ".json"));
    assert.deepEqual(configuration.QueueConfigurations[0].Events, ["s3:ObjectRemoved:*"]);
    const queueRules = configuration.QueueConfigurations[0].Filter.Key.FilterRules;
    assert.ok(queueRules.some((rule) => rule.Name === "prefix" && rule.Value === "incoming/"));
    assert.deepEqual(configuration.TopicConfigurations[0].Events, ["s3:ObjectCreated:*"]);
    // The Lambda and SNS configurations share the incoming/ prefix for the same
    // event type, so their suffixes must not overlap.
    // https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-filtering.html
    const topicRules = configuration.TopicConfigurations[0].Filter.Key.FilterRules;
    assert.ok(topicRules.some((rule) => rule.Name === "prefix" && rule.Value === "incoming/"));
    assert.ok(topicRules.some((rule) => rule.Name === "suffix" && rule.Value === ".csv"));

    const policies = statementsOf("AWS::IAM::Policy");
    assertHasAction(policies, "sqs:SendMessage");
    assertHasAction(policies, "sqs:ReceiveMessage");
  },
};

const assertion = assertions[stackName];
if (!assertion) {
  console.error(`no focused assertions for stack ${stackName}`);
  process.exit(2);
}

try {
  assertion();
} catch (error) {
  console.error(`cdk-assertions: FAIL (${stackName}): ${error.message}`);
  process.exit(1);
}
console.log(`cdk-assertions: PASS (${stackName})`);
