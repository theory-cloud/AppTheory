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
// Staging preserves the *installed layout*, and never dedupes by package name.
// Two dependents can resolve two different copies of one name — one on a nested
// install, one on the hoisted copy every other dependent shares — and a copy is
// only reusable for a dependent that can still reach it. Keeping each installed
// package at its installed path inside the asset means every dependent's walk
// lands on the same copy it landed on in the project, for all dependents at
// once. The closure is then verified by re-running that walk inside the staged
// layout and refusing to emit an asset whose resolution differs from the
// project's.
//
// Installed path means the slot a dependent reaches, which is not always the
// directory that slot points at: `npm install` links a workspace package and a
// `file:` dependency into `node_modules/<name>` instead of copying them, and
// dependents import through that name. Such a package is staged under the link
// name — the slot it is reached through — never under the real directory behind
// it, which nothing in the project imports from.
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
// `peerDependencies` belong here: a peer is not a build-time opinion, it is a
// package the dependency imports and the consumer installs instead of nesting a
// copy. `@theory-cloud/tabletheory-ts`, for one, imports its AWS SDK clients that
// way, and npm installs them, so an asset without them fails at load.
const REQUIRED_DEPENDENCIES = ["dependencies", "peerDependencies"];
const OPTIONAL_DEPENDENCIES = ["optionalDependencies"];

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
//
// Returns the slot the dependency is reached through — `levels` directories
// above `fromDir` — together with the directory that slot resolves to, which is
// what is read and copied. The two differ whenever the slot is a symlink, which
// is how npm installs a workspace package or a `file:` dependency.
function resolvePackage(fromDir, name) {
  let dir = path.resolve(fromDir);
  for (let levels = 0; ; levels += 1) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return { placement: candidate, source: fs.realpathSync(candidate), levels };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// Whether a peer dependency is declared optional through `peerDependenciesMeta`.
function peerIsOptional(manifest, name) {
  const meta = manifest.peerDependenciesMeta;
  return Boolean(meta && typeof meta === "object" && meta[name] && meta[name].optional === true);
}

// The names one manifest imports at run time: required first, then optional, so
// a required peer is never demoted by also appearing in `optionalDependencies`.
function declaredDependencies(manifest) {
  const required = [];
  const optional = [];
  for (const field of REQUIRED_DEPENDENCIES) {
    const value = manifest[field];
    if (!value || typeof value !== "object") {
      continue;
    }
    for (const name of Object.keys(value)) {
      if (field === "peerDependencies" && peerIsOptional(manifest, name)) {
        if (!optional.includes(name)) optional.push(name);
      } else if (!required.includes(name) && !optional.includes(name)) {
        required.push(name);
      }
    }
  }
  for (const field of OPTIONAL_DEPENDENCIES) {
    const value = manifest[field];
    if (!value || typeof value !== "object") {
      continue;
    }
    for (const name of Object.keys(value)) {
      if (!required.includes(name) && !optional.includes(name)) {
        optional.push(name);
      }
    }
  }
  return { required, optional };
}

// The staged path `levels` directories above a staged path, clamped at the asset
// root. A copy the project resolves above its own root is represented by a slot
// of the asset root, which is the directory every dependent that resolved it
// walks to.
function slotAbove(destination, levels) {
  let staged = destination;
  for (let level = 0; level < levels; level += 1) {
    if (staged === "") {
      return "";
    }
    const parent = path.dirname(staged);
    staged = parent === "." ? "" : parent;
  }
  return staged;
}

// Where one package must sit inside the asset so that Node's own walk finds it
// there from every dependent that resolved it.
//
// A package installed inside the project is staged at the slot its dependents
// reached, projected into the asset by walking the dependent's staged path up
// the same number of levels. For a plain install that is the installed path
// itself, which makes the asset mirror the tree the project resolved in: each
// dependent walks its own `node_modules`, then each ancestor's, then the
// project's, and lands on the same copy it landed on before. Nothing is hoisted
// to a free `node_modules` slot, because a slot that is free today is exactly
// the slot another dependent resolves through.
//
// The slot, not the directory behind it, is what an install contributes: a
// workspace package and a `file:` dependency are symlinks named by the dependent
// that imports them, so the asset carries them under that name. Staging the
// real directory would put the package where nothing imports it from, and the
// re-resolution check would refuse the asset.
//
// A package installed outside the project — inside a linked checkout, or hoisted
// above the project root — is anchored under the placed package that contains
// it when there is one, so a linked tree keeps its own layout; otherwise it is
// a hoist shared above the project, which the asset represents at its root.
function installedDestination(root, destination, levels, placement, source, name, placedAt) {
  const installed = path.relative(root, placement);
  if (
    source !== root &&
    installed !== "" &&
    !installed.startsWith("..") &&
    !path.isAbsolute(installed)
  ) {
    return path.join(slotAbove(destination, levels), "node_modules", name);
  }
  for (let dir = path.dirname(source); ; dir = path.dirname(dir)) {
    const anchor = placedAt.get(dir);
    if (anchor !== undefined) {
      return path.join(anchor, path.relative(dir, source));
    }
    if (path.dirname(dir) === dir) {
      return path.join("node_modules", name);
    }
  }
}

// Resolve `name` from a staged path the way Node resolves it from a directory:
// this directory's `node_modules` first, then each parent's, up to the asset
// root (`""`). Reuse of a staged copy is only correct when this finds it.
function resolveStaged(from, name, closure) {
  for (let dir = from; ; dir = path.dirname(dir) === "." ? "" : path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (closure.has(candidate)) {
      return candidate;
    }
    if (dir === "") {
      return null;
    }
  }
}

// Every package in the project's production dependency closure, as a map from
// the path it must occupy inside the asset to the directory it is read from.
//
// Two dependents that resolved two different copies of one name keep both, at
// their installed paths, and a dependent that resolved a copy already staged for
// it reuses that copy — reuse is decided by destination, never by package name
// or by "this source was already copied somewhere". A dependent whose copy's
// installed path is claimed by a different copy gets that copy nested where its
// own walk looks first. Finally the whole closure is re-resolved inside the
// staged layout, and a layout that would resolve anything differently from the
// project is refused rather than emitted.
function productionClosure(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const manifest = readManifest(root);
  if (manifest === null) {
    throw new Error(`bundling: ${root} has no readable package.json to read dependencies from`);
  }

  const closure = new Map();
  const placedAt = new Map();
  const edges = [];
  const expanded = new Set();
  const queue = [{ dir: root, destination: "" }];

  while (queue.length > 0) {
    const { dir, destination } = queue.shift();
    if (expanded.has(destination)) {
      continue;
    }
    expanded.add(destination);
    const parentManifest = readManifest(dir);
    if (parentManifest === null) {
      continue;
    }
    const { required, optional } = declaredDependencies(parentManifest);

    for (const name of [...required, ...optional]) {
      const resolved = resolvePackage(dir, name);
      if (resolved === null) {
        if (optional.includes(name)) {
          continue;
        }
        throw new Error(`bundling: ${dir} declares ${name} but it is not installed; run npm install`);
      }
      const { placement, source, levels } = resolved;

      let target = installedDestination(root, destination, levels, placement, source, name, placedAt);
      if (closure.has(target) && closure.get(target) !== source) {
        target = path.join(destination, "node_modules", name);
        const nested = closure.get(target);
        if (nested !== undefined && nested !== source) {
          throw new Error(
            `bundling: ${target} is claimed by both ${nested} and ${source}; the asset cannot carry both`,
          );
        }
      }

      if (!closure.has(target)) {
        closure.set(target, source);
        queue.push({ dir: source, destination: target });
      }
      if (!placedAt.has(source)) {
        placedAt.set(source, target);
      }
      edges.push({ dependent: destination, name, dependency: target });
    }
  }

  for (const { dependent, name, dependency } of edges) {
    const found = resolveStaged(dependent, name, closure);
    if (found !== dependency) {
      throw new Error(
        `bundling: the asset cannot reproduce the project's resolution: ` +
          `${name} resolves to ${dependency} in the project but ` +
          `${found === null ? "nothing" : found} would be found from ` +
          `${dependent === "" ? "the asset root" : dependent}`,
      );
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

module.exports = { assetBundling, productionClosure, resolveStaged, stage };

if (require.main === module) {
  const [projectRoot, outputDir] = process.argv.slice(2);
  if (!projectRoot || !outputDir) {
    console.error("bundling: usage: bundle.cjs <project-root> <output-dir>");
    process.exit(1);
  }
  const result = stage(projectRoot, outputDir);
  console.log(`bundling: staged ${result.packages} packages into ${result.outputDir}`);
}
