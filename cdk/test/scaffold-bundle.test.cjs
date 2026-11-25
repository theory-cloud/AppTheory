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

const tsBundle = () => require(path.join(REPO_ROOT, TS_BUNDLE));

function writePackage(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeSources(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "handler.mjs"), "export const handler = () => 1;\n");
  fs.writeFileSync(
    path.join(projectRoot, "src", "app.mjs"),
    'import { x } from "hoisted";\nexport const app = x;\n',
  );
}

test("the TypeScript bundler stages the whole production closure and no development tree", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-ts-"));
  const root = path.join(workspace, "project");
  const linked = path.join(workspace, "linked");
  try {
    writeSources(root);
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      type: "module",
      dependencies: { hoisted: "*", "@scope/linked": "file:../linked" },
      devDependencies: { eslint: "*", typescript: "*" },
    });

    // Hoisted, scoped, and a nested second copy of a name that is also hoisted.
    writePackage(path.join(root, "node_modules", "hoisted"), {
      name: "hoisted",
      version: "1.0.0",
      dependencies: { parent: "*" },
    });
    writePackage(path.join(root, "node_modules", "parent"), {
      name: "parent",
      version: "1.0.0",
      dependencies: { nested: "*" },
    });
    writePackage(path.join(root, "node_modules", "parent", "node_modules", "nested"), {
      name: "nested",
      version: "2.0.0",
    });
    // A development dependency and a dependency of that development dependency:
    // neither is imported by the handler, so neither belongs in the asset.
    writePackage(path.join(root, "node_modules", "eslint"), {
      name: "eslint",
      version: "10.0.0",
      dependencies: { ignore: "7.0.0" },
    });
    writePackage(path.join(root, "node_modules", "ignore"), { name: "ignore", version: "5.0.0" });
    writePackage(path.join(root, "node_modules", "eslint", "node_modules", "ignore"), {
      name: "ignore",
      version: "7.0.0",
    });
    writePackage(path.join(root, "node_modules", "typescript"), {
      name: "typescript",
      version: "5.9.0",
    });

    // A package linked in from a sibling checkout with its own install and its
    // own development tree.
    writePackage(linked, {
      name: "@scope/linked",
      version: "1.0.0",
      dependencies: { "@scope/linked-dep": "*" },
      devDependencies: { eslint: "*" },
    });
    writePackage(path.join(linked, "node_modules", "@scope", "linked-dep"), {
      name: "@scope/linked-dep",
      version: "3.0.0",
    });
    writePackage(path.join(linked, "node_modules", "eslint"), {
      name: "eslint",
      version: "9.0.0",
    });
    fs.mkdirSync(path.join(root, "node_modules", "@scope"), { recursive: true });
    fs.symlinkSync(linked, path.join(root, "node_modules", "@scope", "linked"));

    const outputDir = path.join(workspace, "asset");
    const result = tsBundle().stage(root, outputDir);

    assert.equal(result.packages, 5, `expected five packages, staged ${result.packages}`);
    for (const destination of [
      "node_modules/hoisted/package.json",
      "node_modules/parent/package.json",
      // `nested` claims the free hoisted slot, which is the first place Node
      // looks from `parent` after its own `node_modules`.
      "node_modules/nested/package.json",
      "node_modules/@scope/linked/package.json",
      // The linked checkout's own dependency: the handler can only import it if
      // the asset carries it.
      "node_modules/@scope/linked-dep/package.json",
      "handler.mjs",
      "app.mjs",
      "package.json",
    ]) {
      assert.ok(
        fs.existsSync(path.join(outputDir, destination)),
        `the bundle must contain ${destination}`,
      );
    }
    for (const absent of ["node_modules/eslint", "node_modules/typescript"]) {
      assert.equal(
        fs.existsSync(path.join(outputDir, absent)),
        false,
        `the bundle must not contain the development-only ${absent}`,
      );
    }
    // The hoisted copy wins the name; the linked checkout's dev tree did not
    // claim it, and its own `eslint` is not staged at all.
    assert.equal(
      fs.existsSync(path.join(outputDir, "node_modules", "ignore")),
      false,
      "the bundle must not carry a development dependency's dependency",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(outputDir, "node_modules/hoisted/package.json"), "utf8"))
        .version,
      "1.0.0",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler nests a second copy of a name instead of overwriting it", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-versions-"));
  const root = path.join(workspace, "project");
  try {
    writeSources(root);
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      dependencies: { a: "*", shared: "*" },
    });
    writePackage(path.join(root, "node_modules", "shared"), { name: "shared", version: "2.0.0" });
    writePackage(path.join(root, "node_modules", "a"), {
      name: "a",
      version: "1.0.0",
      dependencies: { shared: "1.0.0" },
    });
    writePackage(path.join(root, "node_modules", "a", "node_modules", "shared"), {
      name: "shared",
      version: "1.0.0",
    });

    const closure = tsBundle().productionClosure(root);
    assert.deepEqual(
      [...closure.keys()].sort(),
      ["node_modules/a", "node_modules/a/node_modules/shared", "node_modules/shared"],
      `staged ${JSON.stringify([...closure.keys()])}`,
    );
    // The project's own version keeps the hoisted name; the nested requirement
    // is staged where `a` resolves it first.
    assert.match(closure.get("node_modules/shared"), /\/node_modules\/shared$/);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(closure.get("node_modules/shared"), "package.json"), "utf8"),
      ).version,
      "2.0.0",
    );
    assert.match(closure.get("node_modules/a/node_modules/shared"), /\/a\/node_modules\/shared$/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler refuses a declared dependency that is not installed", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-missing-"));
  const root = path.join(workspace, "project");
  try {
    writeSources(root);
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      dependencies: { "@theory-cloud/apptheory": "*" },
    });
    assert.throws(
      () => tsBundle().productionClosure(root),
      /declares @theory-cloud\/apptheory but it is not installed/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler refuses a project it cannot read", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-nomanifest-"));
  try {
    assert.throws(
      () => tsBundle().stage(workspace, path.join(workspace, "asset")),
      /has no readable package\.json/,
    );
    writePackage(workspace, { name: "project", version: "0.0.0" });
    assert.throws(
      () => tsBundle().stage(workspace, path.join(workspace, "asset")),
      /has no src\/ directory to bundle/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// The template must pass the runtime's own bundling image and register both
// bundling paths, or the asset is built for a neighbouring runtime.
for (const template of [
  {
    name: "ts",
    file: path.join("templates", "apptheory-init", "ts", "cdk", "app.cjs.tmpl"),
    runtime: "NODEJS_24_X",
    line: "nodejs24.x",
  },
  {
    name: "py",
    file: path.join("templates", "apptheory-init", "py", "cdk", "app.cjs.tmpl"),
    runtime: "PYTHON_3_14",
    line: "python3.14",
  },
]) {
  test(`the ${template.name} scaffold bundles through the construct with its own runtime image`, () => {
    const captured = [];
    const runtime = {
      name: template.line,
      bundlingImage: { image: `bundling-image-for-${template.line}` },
    };
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
          if (id.startsWith("./")) {
            return require(path.join(REPO_ROOT, path.dirname(template.file), id));
          }
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
    assert.equal(
      typeof bundling.local.tryBundle,
      "function",
      "the local bundling path must be registered",
    );
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
  const previous = process.env.APPTHEORY_PYTHON;
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
    process.env.APPTHEORY_PYTHON = path.join(stubDir, "python3");

    require(path.join(REPO_ROOT, PY_BUNDLE)).stage(projectRoot, outputDir);

    assert.deepEqual(
      fs.readFileSync(log, "utf8").split("\n").slice(0, -1),
      ["-m", "pip", "install", "-r", path.join(projectRoot, "requirements.txt"), "-t", outputDir],
      "the requirements must be installed into the asset root by one argv",
    );
    for (const name of ["app.py", "handler.py"]) {
      assert.ok(fs.existsSync(path.join(outputDir, name)), `the bundle must contain ${name}`);
    }
  } finally {
    if (previous === undefined) delete process.env.APPTHEORY_PYTHON;
    else process.env.APPTHEORY_PYTHON = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the Python bundler refuses a project with nothing to install", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-py-bad-"));
  try {
    assert.throws(
      () => require(path.join(REPO_ROOT, PY_BUNDLE)).stage(workspace, path.join(workspace, "asset")),
      /has no requirements\.txt to bundle/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
