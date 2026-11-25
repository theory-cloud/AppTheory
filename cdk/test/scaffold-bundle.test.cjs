const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The apptheory-init scaffold ships one bundling module per language, and both
// the CDK app and the bundling image run it. These tests prove what it stages:
// the handler sources, the project manifest and the project's complete
// *production* dependency closure — never a partial one, which is what produced
// an asset whose handler could not import `@aws-sdk/client-s3`.

const TS_BUNDLE = path.join("templates", "apptheory-init", "ts", "cdk", "bundle.cjs");
const PY_BUNDLE = path.join("templates", "apptheory-init", "py", "cdk", "bundle.cjs");

// A stand-in npm that answers the closure query with the tree the test wrote, so
// the test controls the closure instead of reading it out of a real install.
function stubNpm(dir, lines) {
  const log = path.join(dir, "npm-argv.log");
  fs.writeFileSync(
    path.join(dir, "npm"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\ncat <<'LIST'\n${lines.join("\n")}\nLIST\n`,
  );
  fs.chmodSync(path.join(dir, "npm"), 0o755);
  return log;
}

function withPathPrefix(dir, fn) {
  const previous = process.env.PATH;
  const previousNpm = process.env.APPTHEORY_NPM;
  process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
  process.env.APPTHEORY_NPM = path.join(dir, "npm");
  try {
    return fn();
  } finally {
    process.env.PATH = previous;
    if (previousNpm === undefined) delete process.env.APPTHEORY_NPM;
    else process.env.APPTHEORY_NPM = previousNpm;
  }
}

function writePackage(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `{"name":${JSON.stringify(name)},"version":"1.0.0"}\n`);
}

// A project with a hoisted package, a scoped package, a nested duplicate and a
// package linked in from outside the project tree.
function project(root, linked) {
  writePackage(root, "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "handler.mjs"), "export const handler = () => 1;\n");
  fs.writeFileSync(
    path.join(root, "src", "app.mjs"),
    'import { x } from "hoisted";\nexport const app = x;\n',
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"project","version":"0.0.0"}\n');

  writePackage(path.join(root, "node_modules", "hoisted"), "hoisted");
  writePackage(path.join(root, "node_modules", "@scope", "scoped"), "@scope/scoped");
  writePackage(path.join(root, "node_modules", "parent"), "parent");
  writePackage(path.join(root, "node_modules", "parent", "node_modules", "nested"), "nested");
  // A dependency of the linked package: it lives outside the project tree.
  writePackage(path.join(linked, "node_modules", "@scope", "linked-dep"), "@scope/linked-dep");

  const closure = [
    root,
    path.join(root, "node_modules", "hoisted"),
    path.join(root, "node_modules", "@scope", "scoped"),
    path.join(root, "node_modules", "parent"),
    path.join(root, "node_modules", "parent", "node_modules", "nested"),
    path.join(root, "node_modules", "@theory-cloud", "linked"),
    path.join(linked, "node_modules", "@scope", "linked-dep"),
  ];
  writePackage(path.join(root, "node_modules", "@theory-cloud", "linked"), "@theory-cloud/linked");
  // `linked` is a sibling checkout: the project links it in, its dependency
  // resolves from that checkout, not from the project.
  fs.rmSync(path.join(root, "node_modules", "@theory-cloud", "linked"), { recursive: true, force: true });
  fs.symlinkSync(linked, path.join(root, "node_modules", "@theory-cloud", "linked"));
  return closure;
}

test("the TypeScript bundler stages the whole production closure", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-ts-"));
  const root = path.join(workspace, "project");
  const linked = path.join(workspace, "linked");
  writePackage(linked, "@theory-cloud/linked");
  const closure = project(root, linked);
  const stubDir = path.join(workspace, "stubs");
  fs.mkdirSync(stubDir, { recursive: true });
  const log = stubNpm(stubDir, closure);

  try {
    const { stage } = require(path.join(REPO_ROOT, TS_BUNDLE));
    const outputDir = path.join(workspace, "asset");
    const result = withPathPrefix(stubDir, () => stage(root, outputDir));

    assert.equal(result.packages, 6, `expected the whole closure, staged ${result.packages}`);
    for (const destination of [
      "node_modules/hoisted/package.json",
      "node_modules/@scope/scoped/package.json",
      "node_modules/parent/package.json",
      "node_modules/parent/node_modules/nested/package.json",
      "node_modules/@theory-cloud/linked/package.json",
      // A dependency of the linked checkout resolves through the project's
      // node_modules at deploy time, so the asset has to carry it there.
      "node_modules/@scope/linked-dep/package.json",
    ]) {
      assert.ok(
        fs.existsSync(path.join(outputDir, destination)),
        `the bundle must contain ${destination}`,
      );
    }
    // The sources sit at the root of the asset, which is where the Lambda
    // Node.js runtime resolves `handler.handler`.
    for (const name of ["handler.mjs", "app.mjs"]) {
      assert.ok(
        fs.existsSync(path.join(outputDir, name)),
        `the bundle must contain the handler source ${name}`,
      );
    }
    assert.ok(
      fs.existsSync(path.join(outputDir, "package.json")),
      "the bundle must contain the project manifest",
    );
    assert.deepEqual(
      fs.readFileSync(log, "utf8").split("\n").slice(0, -1),
      ["ls", "--omit=dev", "--all", "--parseable"],
      "the closure must be read for production dependencies only",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler refuses a closure it cannot name", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-bad-"));
  try {
    const { productionClosure } = require(path.join(REPO_ROOT, TS_BUNDLE));
    const root = path.join(workspace, "project");
    writePackage(root, "project");
    const stubDir = path.join(workspace, "stubs");
    fs.mkdirSync(stubDir, { recursive: true });

    // A listing that does not start at the project cannot be trusted: the
    // closure would be read out of some other tree.
    stubNpm(stubDir, [path.join(workspace, "elsewhere"), path.join(workspace, "elsewhere", "node_modules", "x")]);
    assert.throws(
      () => withPathPrefix(stubDir, () => productionClosure(root)),
      /did not report .* as the root of the production dependency closure/,
    );

    // A project with no production dependencies stages nothing and says so.
    stubNpm(stubDir, [root]);
    assert.equal(withPathPrefix(stubDir, () => productionClosure(root)).size, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler refuses to let two sources claim one destination", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-clash-"));
  try {
    const { productionClosure } = require(path.join(REPO_ROOT, TS_BUNDLE));
    const root = path.join(workspace, "project");
    writePackage(root, "project");
    const first = path.join(workspace, "first");
    const second = path.join(workspace, "second");
    writePackage(path.join(first, "node_modules", "shared"), "shared");
    writePackage(path.join(second, "node_modules", "shared"), "shared");
    const stubDir = path.join(workspace, "stubs");
    fs.mkdirSync(stubDir, { recursive: true });
    stubNpm(stubDir, [
      root,
      path.join(first, "node_modules", "shared"),
      path.join(second, "node_modules", "shared"),
    ]);
    assert.throws(
      () => withPathPrefix(stubDir, () => productionClosure(root)),
      /is claimed by both/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// The template must pass the runtime's own bundling image and register both
// bundling paths, or the asset is built for a neighbouring runtime.
for (const template of [
  { name: "ts", file: path.join("templates", "apptheory-init", "ts", "cdk", "app.cjs.tmpl"), runtime: "NODEJS_24_X", line: "nodejs24.x" },
  { name: "py", file: path.join("templates", "apptheory-init", "py", "cdk", "app.cjs.tmpl"), runtime: "PYTHON_3_14", line: "python3.14" },
]) {
  test(`the ${template.name} scaffold bundles through the construct with its own runtime image`, () => {
    const captured = [];
    const runtime = { name: template.line, bundlingImage: { image: `bundling-image-for-${template.line}` } };
    const lambda = {
      Runtime: { [template.runtime]: runtime },
      Code: {
        fromAsset: (_assetPath, props) => {
          captured.push(props);
          return { isAsset: true };
        },
      },
    };
    const cdk = {
      App: class App {},
      Stack: class Stack {},
      CfnOutput: class CfnOutput {},
    };
    const apptheoryCdk = {
      AppTheoryFunction: class AppTheoryFunction {
        constructor() {
          this.fn = {};
        }
      },
      AppTheoryHttpApi: class AppTheoryHttpApi {
        constructor() {
          this.api = { apiEndpoint: "https://example.execute-api.us-east-1.amazonaws.com" };
        }
      },
    };

    const source = fs.readFileSync(path.join(REPO_ROOT, template.file), "utf8");
    const moduleObj = { exports: {} };
    vm.runInNewContext(
      source,
      {
        require: (id) => {
          if (id === "aws-cdk-lib") return cdk;
          if (id === "aws-cdk-lib/aws-lambda") return lambda;
          if (id === "@theory-cloud/apptheory-cdk") return apptheoryCdk;
          if (id.startsWith("./")) return require(path.join(REPO_ROOT, path.dirname(template.file), id));
          return require(id);
        },
        module: moduleObj,
        exports: moduleObj.exports,
        __dirname: path.join(REPO_ROOT, path.dirname(template.file)),
        __filename: path.join(REPO_ROOT, template.file),
        process,
        console,
        Buffer,
        setTimeout,
        clearTimeout,
      },
      { filename: path.join(REPO_ROOT, template.file) },
    );

    assert.equal(captured.length, 1, "the template must build its handler from an asset");
    const bundling = captured[0].bundling;
    assert.equal(
      bundling.image.image,
      `bundling-image-for-${template.line}`,
      "the asset must be bundled by the runtime's own image",
    );
    assert.equal(typeof bundling.local.tryBundle, "function", "the local bundling path must be registered");
    assert.deepEqual(
      [bundling.command[0], bundling.command[1]],
      ["bash", "-c"],
      "the image path must run one shell command",
    );
  });
}

test("the Python bundler stages the requirements and the handler sources", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-py-"));
  const projectRoot = path.join(workspace, "project");
  const outputDir = path.join(workspace, "asset");
  try {
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "requirements.txt"), "apptheory==0.0.0\n");
    fs.writeFileSync(path.join(projectRoot, "app.py"), "def build_app():\n    return None\n");
    fs.writeFileSync(path.join(projectRoot, "handler.py"), "from app import build_app\n");
    const stubDir = path.join(workspace, "stubs");
    fs.mkdirSync(stubDir, { recursive: true });
    const log = path.join(stubDir, "argv.log");
    // A stand-in interpreter that records its argv and stages nothing, standing
    // in for `pip install --target`.
    fs.writeFileSync(
      path.join(stubDir, "python3"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`,
    );
    fs.chmodSync(path.join(stubDir, "python3"), 0o755);

    const { stage } = require(path.join(REPO_ROOT, PY_BUNDLE));
    withPathPrefix(stubDir, () => stage(projectRoot, outputDir));

    assert.deepEqual(
      fs.readFileSync(log, "utf8").split("\n").slice(0, -1),
      ["-m", "pip", "install", "-r", path.join(projectRoot, "requirements.txt"), "-t", outputDir],
      "the requirements must be installed into the asset root by one argv",
    );
    for (const name of ["app.py", "handler.py"]) {
      assert.ok(fs.existsSync(path.join(outputDir, name)), `the bundle must contain ${name}`);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the Python bundler refuses a project with nothing to install", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-py-bad-"));
  try {
    const { stage } = require(path.join(REPO_ROOT, PY_BUNDLE));
    assert.throws(
      () => stage(workspace, path.join(workspace, "asset")),
      /has no requirements\.txt to bundle/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
