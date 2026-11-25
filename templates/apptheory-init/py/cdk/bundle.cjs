// Purpose: the one supported way to bundle an apptheory-init Python project into
// a Lambda code asset.
//
// The asset is the project's handler sources plus every runtime dependency
// installed at its root, which is exactly what the Lambda Python runtime puts on
// `sys.path`. The interpreter is the one the project was tested with: set
// `APPTHEORY_PYTHON` to pin it, otherwise `python3` from `PATH` is used.
//
// The file is plain CommonJS with no dependencies, because it runs twice: from
// the CDK app during local bundling, and inside the Python bundling image where
// the CDK mounts the project at /asset-input and collects the asset from
// /asset-output.

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// The paths the CDK mounts the asset input and collects the asset output at
// inside the bundling image.
const ASSET_INPUT = "/asset-input";
const ASSET_OUTPUT = "/asset-output";

// What the Lambda Python runtime expects to find at the root of the asset.
const REQUIREMENTS = "requirements.txt";
const PROJECT_FILES = ["app.py", "handler.py"];

const PYTHON = process.env.APPTHEORY_PYTHON ?? "python3";

// Install the declared runtime dependencies and the handler sources at the root
// of the asset, so the handler imports them exactly as it does in the project.
function stage(projectRoot, outputDir) {
  const root = path.resolve(projectRoot);
  const output = path.resolve(outputDir);
  const requirements = path.join(root, REQUIREMENTS);
  if (!fs.existsSync(requirements)) {
    throw new Error(`bundling: ${root} has no ${REQUIREMENTS} to bundle`);
  }

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  execFileSync(PYTHON, ["-m", "pip", "install", "-r", requirements, "-t", output], {
    stdio: "inherit",
  });

  for (const file of PROJECT_FILES) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) {
      throw new Error(`bundling: ${root} has no ${file} to bundle`);
    }
    fs.copyFileSync(source, path.join(output, file));
  }

  return { outputDir: output, files: PROJECT_FILES.length };
}

// The bundling props for `lambda.Code.fromAsset`. Both paths install the same
// requirements the same way, so the image and the local bundler stage the same
// asset.
function assetBundling(runtime, projectRoot) {
  const root = path.resolve(projectRoot);
  return {
    image: runtime.bundlingImage,
    command: [
      "bash",
      "-c",
      `${PYTHON} -m pip install -r ${path.posix.join(ASSET_INPUT, REQUIREMENTS)} -t ${ASSET_OUTPUT}` +
        ` && cp ${PROJECT_FILES.map((file) => path.posix.join(ASSET_INPUT, file)).join(" ")} ${ASSET_OUTPUT}/`,
    ],
    local: {
      tryBundle(outputDir) {
        stage(root, outputDir);
        return true;
      },
    },
  };
}

module.exports = { assetBundling, stage };

if (require.main === module) {
  const [projectRoot, outputDir] = process.argv.slice(2);
  if (!projectRoot || !outputDir) {
    console.error("bundling: usage: bundle.cjs <project-root> <output-dir>");
    process.exit(1);
  }
  const result = stage(projectRoot, outputDir);
  console.log(`bundling: staged ${result.files} handler files into ${result.outputDir}`);
}
