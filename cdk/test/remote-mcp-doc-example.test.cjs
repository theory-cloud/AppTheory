// Executes the Remote MCP CDK wiring published in
// docs/cdk/mcp-server-remote-mcp.md. The guide's own snippet runs against the
// real construct, then synthesis proves the configured function is the one
// every MCP integration invokes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const assertions = require("aws-cdk-lib/assertions");

const apptheory = require("../lib");

function documentedSnippet() {
  const doc = fs.readFileSync(
    path.resolve(__dirname, "../../docs/cdk/mcp-server-remote-mcp.md"),
    "utf8",
  );
  const match = doc.match(/Adopter's CDK[\s\S]*?```ts\n([\s\S]*?)```/);
  assert.ok(match, "the Remote MCP guide must keep an executable Adopter's CDK example");
  return match[1];
}

test("the documented Remote MCP wiring configures the function every integration targets", () => {
  const snippet = documentedSnippet();
  assert.doesNotMatch(
    snippet,
    /new Function\b/,
    "the guide must configure the handler it passes to the construct, not create a second function",
  );
  assert.match(
    snippet,
    /handler\.addEnvironment\(\s*"RESOURCE_METADATA_URL_TEMPLATE"\s*,\s*mcp\.protectedResourceMetadataUrl\s*\)/,
  );

  const app = new cdk.App();
  const stack = new cdk.Stack(app, "RemoteMcpDocExampleStack");
  const handler = new lambda.Function(stack, "McpHandler", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
  });
  const executable = snippet
    .split("\n")
    .filter((line) => !/^\s*import\s/.test(line))
    .join("\n");
  const run = new Function(
    "stack",
    "handler",
    "AppTheoryRemoteMcpServer",
    `${executable}\nreturn mcp;`,
  );
  const mcp = run(stack, handler, apptheory.AppTheoryRemoteMcpServer);
  assert.ok(mcp instanceof apptheory.AppTheoryRemoteMcpServer);
  assert.match(
    mcp.protectedResourceMetadataUrl,
    /\/\.well-known\/oauth-protected-resource\/mcp\/\{actor\}$/,
    "the example keeps the per-actor metadata template",
  );

  const template = assertions.Template.fromStack(stack).toJSON();
  const functions = Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === "AWS::Lambda::Function");
  assert.equal(
    functions.length,
    1,
    "the example must configure exactly the handler it passes to the construct",
  );
  const [handlerId, handlerResource] = functions[0];
  assert.match(handlerId, /McpHandler/);
  const configured = handlerResource.Properties.Environment.Variables.RESOURCE_METADATA_URL_TEMPLATE;
  assert.ok(configured, "the real handler must receive the documented template");
  assert.deepEqual(configured, stack.resolve(mcp.protectedResourceMetadataUrl));

  const methods = Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === "AWS::ApiGateway::Method");
  assert.ok(methods.length > 0, "the construct must synthesize MCP methods");
  for (const [id, method] of methods) {
    const integration = method.Properties.Integration;
    assert.equal(integration.Type, "AWS_PROXY", `${id} must invoke a Lambda proxy`);
    assert.match(
      JSON.stringify(integration.Uri),
      /McpHandler/,
      `${id} must target the documented handler`,
    );
  }
});
