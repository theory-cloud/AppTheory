// Purpose: prove that an asset the CDK bundles through AppTheory's own construct
// is a *runnable* handler on the newest supported Lambda lines.
//
// `consumer.cjs` proves the selectors, the bundling images and the synthesized
// runtimes; it deploys inline code, so it never shows that bundling an asset
// produces something that loads. This file closes that gap without a deploy: it
// builds one asset per line through `AppTheoryFunction`, lets the CDK run the
// project's real local bundling, and then loads and invokes the handler that
// landed in the emitted asset directory under the interpreter for that line.
//
// The runtime-provided-SDK assumption is deliberately *not* relied on. The
// bundling module stages the project's complete production dependency closure,
// so the asset under test carries its own `@aws-sdk/client-s3` and its own
// `@theory-cloud/tabletheory-ts`; the child process asserts both resolve from
// the asset before it invokes the handler. A handler that only works because
// the Lambda runtime happens to provide a package would fail here.
//
// argv: <runtime tarball> <python wheel>
// stdin/stdout: nothing is interactive; the gate is the process exit code.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const { AppTheoryFunction, AppTheoryHttpApi } = require("@theory-cloud/apptheory-cdk");

const [runtimeTarball, pythonWheel] = process.argv.slice(2);
if (!runtimeTarball || !pythonWheel) {
  throw new Error("bundling: usage: node bundling.cjs <runtime tarball> <python wheel>");
}

// The interpreter that runs this file is the Node line being proved, and the
// Python line is proved by the interpreter the gate selected. Both must be the
// line the asset declares, or the proof would be about some other runtime.
const nodeMajor = Number(process.versions.node.split(".")[0]);
const nodeRuntimeName = `NODEJS_${nodeMajor}_X`;
const nodeRuntime = lambda.Runtime[nodeRuntimeName];
assert.ok(nodeRuntime, `bundling: aws-cdk-lib has no ${nodeRuntimeName} for the running Node ${process.versions.node}`);
assert.equal(nodeRuntime.name, `nodejs${nodeMajor}.x`, `${nodeRuntimeName} is ${nodeRuntime.name}`);

const python = process.env.APPTHEORY_PYTHON ?? "python3";
const pythonVersion = spawnSync(python, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], {
  encoding: "utf8",
});
assert.equal(pythonVersion.status, 0, `bundling: ${python} --version failed: ${pythonVersion.stderr}`);
const pythonMicro = pythonVersion.stdout.trim();
const pythonMinor = Number(pythonMicro.split(".")[1]);
const pythonRuntimeName = `PYTHON_3_${pythonMinor}`;
const pythonRuntime = lambda.Runtime[pythonRuntimeName];
assert.ok(pythonRuntime, `bundling: aws-cdk-lib has no ${pythonRuntimeName} for the running Python ${pythonMicro}`);
assert.equal(pythonRuntime.name, `python3.${pythonMinor}`, `${pythonRuntimeName} is ${pythonRuntime.name}`);

// The project the bundling modules are read from is this repository's own
// scaffold source, copied in by the gate next to this fixture, so the proof runs
// the bundler the scaffold actually ships rather than a copy of its behaviour.
const { assetBundling: nodeBundling } = require("./bundle-ts.cjs");
const { assetBundling: pythonBundling } = require("./bundle-py.cjs");

// The API Gateway v2 request both handlers are invoked with.
const REQUEST = {
  version: "2.0",
  routeKey: "GET /hello/AppTheory",
  rawPath: "/hello/AppTheory",
  rawQueryString: "",
  headers: { host: "example.com" },
  requestContext: {
    accountId: "000000000000",
    apiId: "bundlingproof",
    domainName: "example.com",
    domainPrefix: "bundlingproof",
    http: {
      method: "GET",
      path: "/hello/AppTheory",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "apptheory-bundling-proof",
    },
    requestId: "bundling-proof-request",
    routeKey: "GET /hello/AppTheory",
    stage: "$default",
    time: "01/Jan/2026:00:00:00 +0000",
    timeEpoch: 1767225600000,
  },
  isBase64Encoded: false,
};

function writeNodeProject(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "apptheory-bundled-node",
        private: true,
        version: "0.0.0",
        type: "module",
        dependencies: { "@theory-cloud/apptheory": `file:${path.resolve(runtimeTarball)}` },
      },
      null,
      2,
    )}\n`,
  );
  // The scaffold's own app and handler shape.
  fs.writeFileSync(
    path.join(projectRoot, "src", "app.mjs"),
    [
      'import { createApp, json } from "@theory-cloud/apptheory";',
      "",
      "export function buildApp(deps = { createApp, json }, env = process.env) {",
      '  const tier = env.APPTHEORY_TIER ?? "p2";',
      "  const app = deps.createApp({ tier });",
      "  const hello = (ctx, name) =>",
      "    deps.json(200, {",
      "      message: `hello ${name}`,",
      '      runtime: "ts",',
      "      request_id: ctx.requestId,",
      "      tenant_id: ctx.tenantId,",
      "    });",
      '  app.get("/", (ctx) => hello(ctx, "world"));',
      '  app.get("/hello/{name}", (ctx) => hello(ctx, ctx.param("name")));',
      "  return app;",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(projectRoot, "src", "handler.mjs"),
    [
      'import { buildApp } from "./app.mjs";',
      "",
      "const app = buildApp();",
      "",
      "export const handler = async (event, context) => app.handleLambda(event, context);",
      "",
    ].join("\n"),
  );
  const installed = spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(installed.status, 0, `bundling: npm install failed in ${projectRoot}: ${installed.stderr}`);
}

function writePythonProject(projectRoot) {
  fs.writeFileSync(
    path.join(projectRoot, "requirements.txt"),
    `${path.resolve(pythonWheel)}\n`,
  );
  // The Python scaffold's own app and handler shape.
  fs.writeFileSync(
    path.join(projectRoot, "app.py"),
    [
      "import os",
      "",
      "from apptheory import create_app, json",
      "",
      "",
      "def build_app(environ=None):",
      "    env = environ if environ is not None else os.environ",
      '    tier = env.get("APPTHEORY_TIER", "p2")',
      "    app = create_app(tier=tier)",
      "",
      "    def hello(ctx, name):",
      "        return json(",
      "            200,",
      "            {",
      '                "message": f"hello {name}",',
      '                "runtime": "py",',
      '                "request_id": ctx.request_id,',
      '                "tenant_id": ctx.tenant_id,',
      "            },",
      "        )",
      "",
      '    app.get("/", lambda ctx: hello(ctx, "world"))',
      '    app.get("/hello/{name}", lambda ctx: hello(ctx, ctx.param("name")))',
      "    return app",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(projectRoot, "handler.py"),
    [
      "from app import build_app",
      "",
      "_app = build_app()",
      "",
      "",
      "def handler(event, context):",
      "    return _app.handle_lambda(event, context)",
      "",
    ].join("\n"),
  );
}

// Ask the CDK for the asset it emitted for one function and prove it is the
// asset the bundler staged, not a copy of the project.
function emittedAssets(outdir) {
  const assets = [];
  for (const entry of fs.readdirSync(outdir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("asset.")) continue;
    const dir = path.join(outdir, entry.name);
    const files = fs.readdirSync(dir);
    assets.push({ dir, name: entry.name, files });
  }
  return assets;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-cdk-bundling-"));
const nodeProject = path.join(workDir, "project-node");
const pythonProject = path.join(workDir, "project-python");
const outdir = path.join(workDir, "cdk.out");

fs.mkdirSync(nodeProject, { recursive: true });
fs.mkdirSync(pythonProject, { recursive: true });
writeNodeProject(nodeProject);
writePythonProject(pythonProject);

class BundlingStack extends cdk.Stack {
  constructor(scope, id) {
    super(scope, id);

    const nodeHandler = new AppTheoryFunction(this, "NodeHandler", {
      runtime: nodeRuntime,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(nodeProject, { bundling: nodeBundling(nodeRuntime, nodeProject) }),
    });
    new AppTheoryHttpApi(this, "NodeApi", { handler: nodeHandler.fn });

    const pythonHandler = new AppTheoryFunction(this, "PythonHandler", {
      runtime: pythonRuntime,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(pythonProject, {
        bundling: pythonBundling(pythonRuntime, pythonProject),
      }),
    });
    new AppTheoryHttpApi(this, "PythonApi", { handler: pythonHandler.fn });
  }
}

const app = new cdk.App({ outdir });
const stack = new BundlingStack(app, "AppTheoryBundlingProof");
const assembly = app.synth();

const template = fs.readFileSync(assembly.getStackByName(stack.stackName).templateFullPath, "utf8");
const runtimes = Object.values(JSON.parse(template).Resources || {})
  .filter((resource) => resource && resource.Type === "AWS::Lambda::Function")
  .map((resource) => resource.Properties && resource.Properties.Runtime)
  .sort();
assert.deepEqual(
  runtimes,
  [nodeRuntime.name, pythonRuntime.name].sort(),
  `the synthesized template declares runtimes ${JSON.stringify(runtimes)}`,
);

const assets = emittedAssets(outdir);
const nodeAsset = assets.find((asset) => asset.files.includes("handler.mjs"));
const pythonAsset = assets.find((asset) => asset.files.includes("handler.py"));
assert.ok(nodeAsset, `bundling: no emitted asset carries handler.mjs (assets: ${assets.map((a) => a.name)})`);
assert.ok(pythonAsset, `bundling: no emitted asset carries handler.py (assets: ${assets.map((a) => a.name)})`);
assert.notEqual(nodeAsset.dir, pythonAsset.dir, "both lines must get their own asset");

// --- Node.js: load and invoke the emitted asset under the running Node --------
const nodeProof = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
import assert from "node:assert/strict";

// The asset must carry its own copies: a handler that only loads because the
// Lambda runtime provides a package is not proven to run.
const s3 = await import("@aws-sdk/client-s3");
assert.ok(s3.S3Client, "@aws-sdk/client-s3 did not load from the asset");
const tabletheory = await import("@theory-cloud/tabletheory-ts");
assert.ok(Object.keys(tabletheory).length > 0, "@theory-cloud/tabletheory-ts did not load from the asset");

const { handler } = await import("./handler.mjs");
const ok = await handler(${JSON.stringify(REQUEST)}, { awsRequestId: "bundling-proof" });
assert.equal(ok.statusCode, 200, "expected 200, got " + ok.statusCode);
const body = JSON.parse(ok.body);
assert.equal(body.message, "hello AppTheory");
assert.equal(body.runtime, "ts");
// The runtime's own request-id middleware, not the Lambda context, names the
// request: the handler ran through the full AppTheory request path.
assert.ok(typeof body.request_id === "string" && body.request_id.length > 0, "no request id");

const missing = await handler(
  { ...${JSON.stringify(REQUEST)}, rawPath: "/absent", routeKey: "GET /absent" },
  { awsRequestId: "bundling-proof" },
);
assert.equal(missing.statusCode, 404, "expected the fail-closed 404 envelope, got " + missing.statusCode);

console.log(JSON.stringify({ status: ok.statusCode, body: body.message, missing: missing.statusCode }));
`,
  ],
  { cwd: nodeAsset.dir, encoding: "utf8" },
);
assert.equal(
  nodeProof.status,
  0,
  `bundling: the bundled Node handler failed under Node ${process.versions.node}:\n${nodeProof.stderr}`,
);
const nodeResult = JSON.parse(nodeProof.stdout.trim().split("\n").pop());

// --- Python: load and invoke the emitted asset under the running Python -------
const pythonProof = spawnSync(
  python,
  [
    "-c",
    `
import importlib
import json

# The asset must carry its own data layer for the same reason as the Node asset.
import tabletheory_py  # noqa: F401 - the import itself is the assertion

handler = importlib.import_module("handler").handler
request = json.loads(${JSON.stringify(JSON.stringify(REQUEST))})
ok = handler(request, {})
assert ok.get("statusCode") == 200, "expected 200, got %r" % (ok.get("statusCode"),)
body = json.loads(ok.get("body"))
assert body["message"] == "hello AppTheory", body
assert body["runtime"] == "py", body
assert isinstance(body["request_id"], str) and body["request_id"], body

missing_request = dict(request)
missing_request["rawPath"] = "/absent"
missing_request["routeKey"] = "GET /absent"
missing = handler(missing_request, {})
assert missing.get("statusCode") == 404, "expected the fail-closed 404 envelope, got %r" % (missing.get("statusCode"),)

print(json.dumps({"status": ok.get("statusCode"), "body": body["message"], "missing": missing.get("statusCode")}))
`,
  ],
  { cwd: pythonAsset.dir, encoding: "utf8" },
);
assert.equal(
  pythonProof.status,
  0,
  `bundling: the bundled Python handler failed under Python ${pythonMicro}:\n${pythonProof.stderr}`,
);
const pythonResult = JSON.parse(pythonProof.stdout.trim().split("\n").pop());

fs.rmSync(workDir, { recursive: true, force: true });

console.log(
  `consumer-install(cdk bundling): ${nodeRuntime.name} asset ${nodeAsset.name} loaded and invoked under node ${process.versions.node} ` +
    `-> ${nodeResult.status}/${nodeResult.body}, 404 -> ${nodeResult.missing}`,
);
console.log(
  `consumer-install(cdk bundling): ${pythonRuntime.name} asset ${pythonAsset.name} loaded and invoked under Python ${pythonMicro} ` +
    `-> ${pythonResult.status}/${pythonResult.body}, 404 -> ${pythonResult.missing}`,
);
