const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The apptheory-init scaffold templates are rendered from *.tmpl and executed by the CDK CLI, so
// their local-bundle path is real code. These tests render each template, load it with stub CDK
// modules, capture the bundling `tryBundle`, and run it against a stubbed toolchain to prove the
// build command is passed as an argv array rather than a shell-interpolated string.

const TEMPLATES = [
  {
    name: "python",
    file: path.join("templates", "apptheory-init", "py", "cdk", "app.cjs.tmpl"),
    tool: "python3",
    expectedArgv: (projectRoot, outputDir) => [
      "-m",
      "pip",
      "install",
      "-r",
      path.join(projectRoot, "requirements.txt"),
      "-t",
      outputDir,
    ],
    // The Python template copies these project files into the bundle after installing requirements.
    copies: ["app.py", "handler.py"],
  },
  {
    name: "go",
    file: path.join("templates", "apptheory-init", "go", "cdk", "app.cjs.tmpl"),
    tool: "go",
    expectedArgv: (projectRoot, outputDir) => [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w -buildid=",
      "-o",
      path.join(outputDir, "bootstrap"),
      ".",
    ],
    copies: [],
  },
];

function renderTemplate(relPath) {
  const source = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return source.replace(/__APP_CLASS__/g, "ScaffoldStack").replace(/__APP_PACKAGE__/g, "scaffold");
}

function captureTryBundle(renderedSource, filename) {
  let tryBundle = null;

  const awsCdkLib = {
    App: class App {},
    Stack: class Stack {},
    CfnOutput: class CfnOutput {},
    DockerImage: { fromRegistry: () => ({}) },
  };
  const awsCdkLambda = {
    Runtime: {
      PYTHON_3_14: { name: "python3.14", bundlingImage: {} },
      PROVIDED_AL2023: { name: "provided.al2023" },
    },
    Code: {
      fromAsset: (_assetPath, props) => {
        tryBundle = props.bundling.local.tryBundle;
        return { isAsset: true };
      },
    },
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

  const requireStub = (id) => {
    switch (id) {
      case "aws-cdk-lib":
        return awsCdkLib;
      case "aws-cdk-lib/aws-lambda":
        return awsCdkLambda;
      case "@theory-cloud/apptheory-cdk":
        return apptheoryCdk;
      default:
        return require(id);
    }
  };

  const moduleObj = { exports: {} };
  vm.runInNewContext(
    renderedSource,
    {
      require: requireStub,
      module: moduleObj,
      exports: moduleObj.exports,
      __dirname: path.dirname(filename),
      __filename: filename,
      process,
      console,
      Buffer,
      setTimeout,
      clearTimeout,
    },
    { filename },
  );

  assert.equal(typeof tryBundle, "function", "template must register a local tryBundle");
  return tryBundle;
}

function writeToolStub(dir, name, logPath) {
  fs.writeFileSync(
    path.join(dir, name),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(logPath)}\n`,
  );
  fs.chmodSync(path.join(dir, name), 0o755);
}

function withStubbedPath(toolDir, fn) {
  const previousPath = process.env.PATH;
  process.env.PATH = `${toolDir}${path.delimiter}${previousPath ?? ""}`;
  try {
    return fn();
  } finally {
    process.env.PATH = previousPath;
  }
}

function scaffoldProject(rootDir, template) {
  // rootDir plays the role of the generated project; its parent path can carry shell
  // metacharacters, which must survive as a literal argv element.
  const cdkDir = path.join(rootDir, "cdk");
  fs.mkdirSync(cdkDir, { recursive: true });
  fs.writeFileSync(path.join(cdkDir, "app.cjs"), renderTemplate(template.file));
  fs.writeFileSync(path.join(rootDir, "requirements.txt"), "apptheory\n");
  for (const name of template.copies) {
    fs.writeFileSync(path.join(rootDir, name), `# ${name}\n`);
  }
  return cdkDir;
}

function readRecordedArgv(logPath) {
  const raw = fs.readFileSync(logPath, "utf8");
  return raw.split("\n").slice(0, -1);
}

function runTemplateBundling(template, rootDir) {
  const cdkDir = scaffoldProject(rootDir, template);
  const tryBundle = captureTryBundle(fs.readFileSync(path.join(cdkDir, "app.cjs"), "utf8"), path.join(cdkDir, "app.cjs"));

  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-stub-"));
  const logPath = path.join(toolDir, "argv.log");
  writeToolStub(toolDir, template.tool, logPath);

  // The output directory sits under the project root so its path inherits the project root's
  // shell metacharacters. The Go template interpolated only this output path (the project root
  // was its cwd), so the hostile-path control must reach it here, not just in the project root.
  const outputDir = path.join(rootDir, "cdk.out");
  let returned;
  withStubbedPath(toolDir, () => {
    returned = tryBundle(outputDir);
  });

  return { returned, argv: readRecordedArgv(logPath), outputDir, toolDir };
}

for (const template of TEMPLATES) {
  test(`apptheory-init ${template.name} template passes the build path as one argv element`, () => {
    // A directory name full of shell metacharacters: if the path were interpolated into a shell
    // string, the shell would split it and run `touch INJECTED` instead of passing the literal
    // path as a single argument.
    const marker = "INJECTED";
    const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-meta-"));
    const projectRoot = path.join(metaRoot, `scaffold ;touch ${marker} #`);
    const injected = [
      path.join(process.cwd(), marker),
      path.join(projectRoot, marker),
    ];

    let result;
    try {
      result = runTemplateBundling(template, projectRoot);

      assert.equal(result.returned, true, "local bundling must succeed");
      assert.deepEqual(
        result.argv,
        template.expectedArgv(projectRoot, result.outputDir),
        "the build path must arrive as a single literal argv element",
      );
      for (const name of template.copies) {
        assert.ok(
          fs.existsSync(path.join(result.outputDir, name)),
          `the bundle must contain ${name}`,
        );
      }
      for (const markerPath of injected) {
        assert.equal(fs.existsSync(markerPath), false, `shell metacharacters must stay inert (${markerPath})`);
      }
    } finally {
      for (const markerPath of injected) {
        fs.rmSync(markerPath, { force: true });
      }
      fs.rmSync(metaRoot, { recursive: true, force: true });
      if (result) {
        fs.rmSync(result.toolDir, { recursive: true, force: true });
      }
    }
  });

  test(`apptheory-init ${template.name} template synthesizes a normal bundle path`, () => {
    const rootDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-plain-")), "project");
    let result;
    try {
      result = runTemplateBundling(template, rootDir);

      assert.equal(result.returned, true, "local bundling must succeed");
      assert.deepEqual(
        result.argv,
        template.expectedArgv(rootDir, result.outputDir),
        "an ordinary project path must still produce the exact build argv",
      );
      assert.ok(!JSON.stringify(result.argv).includes("*"), "the build argv must not smuggle a wildcard");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      if (result) {
        fs.rmSync(result.toolDir, { recursive: true, force: true });
      }
    }
  });
}
