// Purpose: the one supported way to bundle an apptheory-init TypeScript project
// into a Lambda code asset.
//
// `@theory-cloud/apptheory` re-exports modules that import its declared runtime
// dependencies — the AWS SDK v3 clients and `@theory-cloud/tabletheory-ts` — so
// an asset that carries only the runtime package loads and then fails with
// `ERR_MODULE_NOT_FOUND`. The Lambda Node.js runtime provides `@aws-sdk/*`, but
// it does not provide `@theory-cloud/tabletheory-ts`, and a bundle that depends
// on the runtime's SDK copy silently runs a different SDK version than the one
// the project resolved. This module therefore stages the project's complete
// *production* dependency closure, resolved out of the project's own installed
// tree: what you tested is what the asset contains, and neither the container
// bundler nor the local bundler needs the network.
//
// The file is plain CommonJS with no dependencies, because it runs twice: from
// the CDK app during local bundling, and inside the Node bundling image where
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

// What the Lambda Node.js runtime expects to find at the root of the asset.
const SOURCE_DIR = "src";
const PROJECT_FILES = ["package.json"];

const NPM = process.env.APPTHEORY_NPM ?? "npm";

// The package a path inside an installed tree belongs to: the segments after the
// last `node_modules`, which keeps the scope for a scoped package.
function packageName(packagePath) {
  const segments = packagePath.split(path.sep);
  const index = segments.lastIndexOf("node_modules");
  if (index < 0 || index === segments.length - 1) {
    throw new Error(`bundling: ${packagePath} is not inside a node_modules tree`);
  }
  return segments.slice(index + 1).join("/");
}

// Every package in the project's production dependency closure, as a map from
// the path it must occupy inside the asset to the directory it is read from.
//
// A package the project links in from outside its own tree (a `file:` dependency
// of a sibling checkout, which is how the framework's own scaffold gate installs
// the in-progress runtime) still resolves through the project's
// `node_modules`, so it is staged there rather than refused. Two different
// sources claiming one destination is refused: the asset cannot carry both.
function productionClosure(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  let listing;
  try {
    listing = execFileSync(NPM, ["ls", "--omit=dev", "--all", "--parseable"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr]
      .filter(Boolean)
      .map((chunk) => String(chunk).trim())
      .filter((chunk) => chunk !== "")
      .join(" ");
    throw new Error(
      `bundling: ${NPM} could not read the production dependency closure of ${root}: ${detail}`,
    );
  }

  const entries = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (entries.length === 0 || path.resolve(entries[0]) !== root) {
    throw new Error(
      `bundling: ${NPM} did not report ${root} as the root of the production dependency closure`,
    );
  }

  const closure = new Map();
  for (const entry of entries.slice(1)) {
    const resolved = path.resolve(entry);
    const relative = path.relative(root, resolved);
    const insideTree = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    const destination = insideTree
      ? relative
      : path.join("node_modules", packageName(resolved));
    const source = fs.realpathSync(resolved);
    const existing = closure.get(destination);
    if (existing !== undefined && existing !== source) {
      throw new Error(
        `bundling: ${destination} is claimed by both ${existing} and ${source}; the asset cannot carry both`,
      );
    }
    closure.set(destination, source);
  }
  return closure;
}

// Copy one package into the asset. A package's own nested dependencies are
// closure entries of their own and are staged at their own paths afterwards, so
// the subtree is not copied twice and a nested `node_modules` never rides along
// with a package that does not own it.
function copyPackage(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (candidate) => path.basename(candidate) !== "node_modules",
  });
}

// Stage the asset: the handler sources, the project manifest and the complete
// production dependency closure. Nothing is copied that the project did not
// install for production, and nothing is left out that it did.
function stage(projectRoot, outputDir) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const output = path.resolve(outputDir);
  const closure = productionClosure(root);

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const sources = path.join(root, SOURCE_DIR);
  if (!fs.existsSync(sources)) {
    throw new Error(`bundling: ${root} has no ${SOURCE_DIR}/ directory to bundle`);
  }
  fs.cpSync(sources, output, { recursive: true, dereference: true, force: true });

  for (const file of PROJECT_FILES) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) {
      throw new Error(`bundling: ${root} has no ${file} to bundle`);
    }
    fs.copyFileSync(source, path.join(output, file));
  }

  for (const [destination, source] of closure) {
    copyPackage(source, path.join(output, destination));
  }

  return { outputDir: output, packages: closure.size };
}

// The bundling props for `lambda.Code.fromAsset`. Both paths run this module, so
// the image and the local bundler stage exactly the same asset.
function assetBundling(runtime, projectRoot) {
  const root = path.resolve(projectRoot);
  return {
    image: runtime.bundlingImage,
    command: [
      "bash",
      "-c",
      `node ${path.posix.join(ASSET_INPUT, "cdk", "bundle.cjs")} ${ASSET_INPUT} ${ASSET_OUTPUT}`,
    ],
    local: {
      tryBundle(outputDir) {
        stage(root, outputDir);
        return true;
      },
    },
  };
}

module.exports = { assetBundling, productionClosure, stage };

if (require.main === module) {
  const [projectRoot, outputDir] = process.argv.slice(2);
  if (!projectRoot || !outputDir) {
    console.error("bundling: usage: bundle.cjs <project-root> <output-dir>");
    process.exit(1);
  }
  const result = stage(projectRoot, outputDir);
  console.log(`bundling: staged ${result.packages} packages into ${result.outputDir}`);
}
