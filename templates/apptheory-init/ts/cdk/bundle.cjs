// Purpose: the one supported way to bundle an apptheory-init TypeScript project
// into a Lambda code asset.
//
// `@theory-cloud/apptheory` re-exports modules that import its declared runtime
// dependencies — the AWS SDK v3 clients and `@theory-cloud/tabletheory-ts` — so
// an asset that carries only the runtime package loads and then fails with
// `ERR_MODULE_NOT_FOUND`. The Lambda Node.js runtime provides `@aws-sdk/*`, but
// it does not provide `@theory-cloud/tabletheory-ts`, and a bundle that leans on
// the runtime's SDK copy silently runs a different SDK version than the one the
// project resolved. This module therefore stages the project's complete
// *production* dependency closure: what you tested is what the asset contains.
//
// The closure is the project's declared `dependencies` (and `optionalDependencies`)
// followed transitively, resolved the way Node itself resolves them — each
// package's own directory first, then its parent's `node_modules`, up to the
// project root — and staged at the path that same walk would find them at inside
// the asset. Development dependencies and a linked package's development tree
// are never part of it, because they are not part of what the handler imports.
//
// The file is plain CommonJS with no dependencies, because it runs twice: from
// the CDK app during local bundling, and inside the Node bundling image where
// the CDK mounts the project at /asset-input and collects the asset from
// /asset-output.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// The paths the CDK mounts the asset input and collects the asset output at
// inside the bundling image.
const ASSET_INPUT = "/asset-input";
const ASSET_OUTPUT = "/asset-output";

// What the Lambda Node.js runtime expects to find at the root of the asset.
const SOURCE_DIR = "src";
const PROJECT_FILES = ["package.json"];

// The manifest fields that describe what the handler imports at run time.
const RUNTIME_DEPENDENCIES = ["dependencies", "optionalDependencies"];

function readManifest(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Locate an installed package the way Node does: the nearest `node_modules` from
// `fromDir` upwards that carries it. `fromDir` is the real directory of the
// package that declared the dependency, so a linked package resolves through its
// own install rather than through the project's.
function resolvePackageDir(fromDir, name) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// Every package in the project's production dependency closure, as a map from
// the path it must occupy inside the asset to the directory it is read from.
//
// The first package to claim `node_modules/<name>` keeps it, in breadth-first
// order from the project itself, which is the hoist npm performs. A later
// package that resolved a *different* copy of the same name is staged under its
// parent instead, which is also where Node will look first. A name two sources
// claim at the same destination is refused: the asset cannot carry both.
function productionClosure(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const manifest = readManifest(root);
  if (manifest === null) {
    throw new Error(`bundling: ${root} has no readable package.json to read dependencies from`);
  }

  const closure = new Map();
  const staged = new Set();
  const queue = [{ dir: root, destination: null }];

  while (queue.length > 0) {
    const parent = queue.shift();
    const parentManifest = readManifest(parent.dir);
    if (parentManifest === null) {
      continue;
    }
    const declared = [];
    for (const field of RUNTIME_DEPENDENCIES) {
      const value = parentManifest[field];
      if (value && typeof value === "object") {
        for (const name of Object.keys(value)) {
          if (!declared.includes(name)) {
            declared.push(name);
          }
        }
      }
    }

    for (const name of declared) {
      const source = resolvePackageDir(parent.dir, name);
      if (source === null) {
        throw new Error(
          `bundling: ${parent.dir} declares ${name} but it is not installed; run npm install`,
        );
      }
      if (staged.has(source)) {
        continue;
      }

      const hoisted = path.join("node_modules", name);
      let destination = hoisted;
      const hoistedSource = closure.get(hoisted);
      if (hoistedSource !== undefined && hoistedSource !== source) {
        if (parent.destination === null) {
          throw new Error(
            `bundling: ${hoisted} is claimed by both ${hoistedSource} and ${source}; the asset cannot carry both`,
          );
        }
        destination = path.join(parent.destination, "node_modules", name);
      }
      const existing = closure.get(destination);
      if (existing !== undefined && existing !== source) {
        throw new Error(
          `bundling: ${destination} is claimed by both ${existing} and ${source}; the asset cannot carry both`,
        );
      }

      closure.set(destination, source);
      staged.add(source);
      queue.push({ dir: source, destination });
    }
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
// install for production, and nothing is left out that it imports.
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
