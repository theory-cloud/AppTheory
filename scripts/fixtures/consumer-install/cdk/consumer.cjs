// Purpose: the clean-consumer synth path for the packed AppTheory CDK construct
// library on the newest supported Lambda runtimes.
//
// This file is copied into a directory that holds nothing but the installed
// `@theory-cloud/apptheory-cdk` tarball plus its declared peer dependencies, and
// is then run with `node consumer.cjs`. It exercises the three things a consumer
// does with a Lambda runtime selector:
//
//   1. **selector** — `lambda.Runtime.NODEJS_26_X` and `lambda.Runtime.PYTHON_3_15`
//      resolve, carry the runtime name AWS expects, and are accepted by an
//      AppTheory construct as the function runtime;
//   2. **bundler** — each runtime resolves the bundling image its code asset
//      would be built in, and the image is the one for that runtime, not a
//      neighbouring one;
//   3. **synth** — the stack synthesizes, and the emitted CloudFormation
//      templates declare `nodejs26.x` and `python3.15`.
//
// Nothing here is skipped: a missing runtime constant, a bundling image that does
// not name the runtime, a synth failure or a template without the declared
// runtimes throws.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const { AppTheoryFunction, AppTheoryHttpApi } = require("@theory-cloud/apptheory-cdk");

const NODE_LINE = "nodejs26.x";
const PYTHON_LINE = "python3.15";
const NODE_BUNDLING_IMAGE = "public.ecr.aws/sam/build-nodejs26.x";
const PYTHON_BUNDLING_IMAGE = "public.ecr.aws/sam/build-python3.15";

// --- selector -------------------------------------------------------------
const nodeRuntime = lambda.Runtime.NODEJS_26_X;
const pythonRuntime = lambda.Runtime.PYTHON_3_15;

assert.equal(nodeRuntime.name, NODE_LINE, `NODEJS_26_X resolved to ${nodeRuntime.name}`);
assert.equal(pythonRuntime.name, PYTHON_LINE, `PYTHON_3_15 resolved to ${pythonRuntime.name}`);
assert.equal(nodeRuntime.family, lambda.RuntimeFamily.NODEJS, "NODEJS_26_X is not in the NodeJS family");
assert.equal(
  pythonRuntime.family,
  lambda.RuntimeFamily.PYTHON,
  "PYTHON_3_15 is not in the Python family",
);

// --- bundler --------------------------------------------------------------
assert.equal(
  nodeRuntime.bundlingImage.image,
  NODE_BUNDLING_IMAGE,
  `NODEJS_26_X bundling image is ${nodeRuntime.bundlingImage.image}`,
);
assert.equal(
  pythonRuntime.bundlingImage.image,
  PYTHON_BUNDLING_IMAGE,
  `PYTHON_3_15 bundling image is ${pythonRuntime.bundlingImage.image}`,
);
assert.notEqual(
  nodeRuntime.bundlingImage.image,
  lambda.Runtime.NODEJS_24_X.bundlingImage.image,
  "NODEJS_26_X and NODEJS_24_X resolve the same bundling image",
);
assert.notEqual(
  pythonRuntime.bundlingImage.image,
  lambda.Runtime.PYTHON_3_14.bundlingImage.image,
  "PYTHON_3_15 and PYTHON_3_14 resolve the same bundling image",
);

// --- synth ----------------------------------------------------------------
class ConsumerStack extends cdk.Stack {
  constructor(scope, id) {
    super(scope, id);

    const nodeHandler = new AppTheoryFunction(this, "NodeHandler", {
      runtime: nodeRuntime,
      handler: "index.handler",
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, body: "pong" });',
      ),
    });
    new AppTheoryHttpApi(this, "NodeApi", { handler: nodeHandler.fn });

    const pythonHandler = new AppTheoryFunction(this, "PythonHandler", {
      runtime: pythonRuntime,
      handler: "index.handler",
      code: lambda.Code.fromInline('def handler(event, context):\n    return {"statusCode": 200}\n'),
    });
    new AppTheoryHttpApi(this, "PythonApi", { handler: pythonHandler.fn });
  }
}

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-cdk-consumer-"));
const app = new cdk.App({ outdir });
const stack = new ConsumerStack(app, "AppTheoryConsumerInstall");
const assembly = app.synth();

assert.equal(assembly.stacks.length, 1, `expected one stack, got ${assembly.stacks.length}`);

const templatePath = assembly.getStackByName(stack.stackName).templateFullPath;
const template = fs.readFileSync(templatePath, "utf8");

const runtimes = [];
for (const resource of Object.values(JSON.parse(template).Resources || {})) {
  if (resource && resource.Type === "AWS::Lambda::Function") {
    runtimes.push(resource.Properties && resource.Properties.Runtime);
  }
}
runtimes.sort();
assert.deepEqual(
  runtimes,
  [NODE_LINE, PYTHON_LINE],
  `the synthesized template declares runtimes ${JSON.stringify(runtimes)}`,
);
assert.ok(
  template.includes(NODE_LINE) && template.includes(PYTHON_LINE),
  "the synthesized template does not mention both runtime lines",
);

fs.rmSync(outdir, { recursive: true, force: true });

console.log(
  `consumer-install(cdk): selectors ${nodeRuntime.name}/${pythonRuntime.name}, ` +
    `bundling images ${nodeRuntime.bundlingImage.image}/${pythonRuntime.bundlingImage.image}, ` +
    `synth ${stack.stackName} -> ${JSON.stringify(runtimes)}`,
);
