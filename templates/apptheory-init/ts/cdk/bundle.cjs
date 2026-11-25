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
// once.
//
// Installed path means the slot a dependent reaches, which is not always the
// directory that slot points at: `npm install` links a workspace package and a
// `file:` dependency into `node_modules/<name>` instead of copying them, and
// dependents import through that name. Such a package is staged under the link
// name — the slot it is reached through — never under the real directory behind
// it, which nothing in the project imports from.
//
// Every slot is chosen in Node's own terms. Node's walk is not a plain
// `dirname` climb: it never looks in `node_modules/node_modules`, so a link
// whose name is scoped (`node_modules/@scope/pkg`, three path segments) reaches
// the project root in one hop fewer than its real directory does. A slot is
// therefore computed from the *staged* path's own depth — the directories Node
// would search from the dependent's staged directory — and a copy the project
// reaches through a directory the asset cannot reproduce (a link's real
// location, an intermediate `node_modules` inside the project) is staged where
// that dependent's own walk looks first: its own `node_modules`.
//
// Placement is a means, not the guarantee. After the asset is staged it is
// verified with Node's own resolver: every declared production edge of every
// staged package, and the handler entry, is resolved from the actual staged
// directory, and the result must be the same copy the project resolves. Any
// miss, any copy the project does not resolve, and any different copy refuses
// the synth instead of emitting an asset that fails at load — or, worse, loads a
// version the project never tested.
//
// The file is plain CommonJS with no dependencies, because it runs twice: from
// the CDK app during local bundling, and inside the Node bundling image where
// the CDK mounts the project at /asset-input and collects the asset from
// /asset-output.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

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

// The directories Node searches for a bare package name from `dir`, in order:
// this directory's `node_modules`, then each parent's — skipping any directory
// that is itself named `node_modules`. Node never looks in
// `node_modules/node_modules`, and reproducing that skip is what keeps a scoped
// link slot (`node_modules/@scope/pkg`) one hop from the project root instead of
// two.
function searchBases(dir) {
  const bases = [];
  let current = path.resolve(dir);
  for (;;) {
    if (path.basename(current) !== "node_modules") {
      bases.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return bases;
    }
    current = parent;
  }
}

// The same walk, over a directory inside the asset, whose entries are the
// closure's staged paths: the dependent's own directory, then each ancestor up
// to the asset root (`""`).
function stagedBases(destination) {
  const bases = [];
  let current = destination;
  for (;;) {
    if (current === "" || path.basename(current) !== "node_modules") {
      bases.push(current);
    }
    if (current === "") {
      return bases;
    }
    const parent = path.dirname(current);
    current = parent === "." ? "" : parent;
  }
}

// Locate an installed package the way Node does: the nearest directory on
// `searchBases(fromDir)` that carries `node_modules/<name>`.
//
// Returns the slot the dependency is reached through together with the directory
// that slot resolves to, which is what is read and copied. The two differ
// whenever the slot is a symlink, which is how npm installs a workspace package
// or a `file:` dependency. `fromDir` is the real directory of the package that
// declared the dependency, so a linked package resolves through its own install
// rather than through the project's.
function resolvePackage(fromDir, name) {
  for (const base of searchBases(fromDir)) {
    const candidate = path.join(base, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return { placement: candidate, source: fs.realpathSync(candidate) };
    }
  }
  return null;
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

// Whether `candidate` sits inside `root` (absolute paths).
function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function isInsideRelative(relative) {
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Where one package must sit inside the asset so that Node's own walk finds it
// there from every dependent that resolved it.
//
// A package installed inside the project takes the slot the project reaches it
// through, projected into the asset's own search: the closure starts from the
// dependent's staged directory and walks Node's candidate directories, reusing
// an already-staged copy of the same source, and placing the copy at the
// mirrored slot when the dependent's walk reaches it. For a plain install that
// is the installed path itself, which makes the asset mirror the tree the
// project resolved in: each dependent walks its own `node_modules`, then each
// ancestor's, then the project's, and lands on the same copy it landed on
// before. Nothing is hoisted to a free `node_modules` slot, because a slot that
// is free today is exactly the slot another dependent resolves through.
//
// The project's mirrored slot is out of reach when the project resolved the copy
// through a directory the asset has no counterpart for: a link's real location
// (nothing imports `pkgs/<name>`) or an intermediate `node_modules` inside the
// project. Such a copy is staged where that dependent's own walk looks first —
// its own `node_modules` — which shadows nothing else and keeps the dependent on
// the copy the project gave it.
//
// A package installed outside the project — inside a linked checkout, or hoisted
// above the project root — is anchored under the placed package that contains
// it when there is one, so a linked tree keeps its own layout; otherwise it is
// a hoist shared above the project, which the asset represents at its root.
function installedDestination(root, destination, placement, source, name, placedAt, closure) {
  const installed = path.relative(root, placement);
  if (isInsideRelative(installed)) {
    for (const base of stagedBases(destination)) {
      const slot = path.join(base, "node_modules", name);
      const staged = closure.get(slot);
      if (staged !== undefined) {
        // The dependent would resolve this copy: reuse it when it is the copy
        // the project resolved, and stop when a nearer copy shadows the rest.
        return staged === source ? slot : path.join(destination, "node_modules", name);
      }
      if (slot === installed) {
        return slot;
      }
    }
    return path.join(destination, "node_modules", name);
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

// Every package in the project's production dependency closure, as a map from
// the path it must occupy inside the asset to the directory it is read from.
//
// Two dependents that resolved two different copies of one name keep both, at
// their installed paths, and a dependent that resolved a copy already staged for
// it reuses that copy — reuse is decided by destination, never by package name
// or by "this source was already copied somewhere". A dependent whose copy's
// installed path is claimed by a different copy gets that copy nested where its
// own walk looks first.
//
// This decides placement only. Whether the staged tree really resolves like the
// project is decided by Node itself, in verifyStaged, on the copied asset.
function productionClosure(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const manifest = readManifest(root);
  if (manifest === null) {
    throw new Error(`bundling: ${root} has no readable package.json to read dependencies from`);
  }

  const closure = new Map();
  const placedAt = new Map();
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
      const { placement, source } = resolved;

      let target = installedDestination(root, destination, placement, source, name, placedAt, closure);
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
    }
  }

  return closure;
}

// Ask Node itself where `name` resolves from a file or directory: the first
// existing `node_modules/<name>` on the resolver's own search path for that
// anchor. Returns the real directory of the package, or null.
function resolveWithNode(anchor, name) {
  const request = createRequire(anchor);
  const searchPaths = request.resolve.paths(name);
  if (!searchPaths) {
    // A core module name: Node loads the builtin, never a package.
    return null;
  }
  for (const dir of searchPaths) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }
  }
  return null;
}

// The production edges one package contributes: what its manifest declares, in
// declaration order.
function manifestEdges(manifest) {
  const { required, optional } = declaredDependencies(manifest);
  return [...required, ...optional];
}

// The fail-closed check: from the asset that was actually staged, ask Node to
// resolve every declared production edge of every staged package and of the
// handler entry, and refuse to emit the asset unless each edge lands on the same
// copy the project resolves.
//
// The oracle is Node's resolver, not a re-implementation of its walk: the search
// path comes from `require.resolve.paths`, so the `node_modules/node_modules`
// skip, scoped link slots and every other shape of the walk are Node's own
// rules. Identity is the copy, not the name: two copies of one version are still
// two packages, and an edge pinned to the copy the project resolved must find
// that copy (or a copy staged from the same source) inside the asset.
function verifyStaged(projectRoot, outputDir, closure) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const output = path.resolve(outputDir);
  const realOutput = fs.realpathSync(output);

  const stagedAt = new Map();
  const missing = [];
  for (const [destination, source] of closure) {
    const staged = path.join(output, destination);
    if (!fs.existsSync(staged)) {
      // Reported by the edge that needs it; a copy nothing resolves is reported
      // below, so a partially copied closure can never pass.
      missing.push(destination);
      continue;
    }
    stagedAt.set(fs.realpathSync(staged), { destination, source });
  }

  const dependents = [];
  const rootManifest = readManifest(root);
  if (rootManifest !== null) {
    dependents.push({
      label: `the handler entry (${SOURCE_DIR})`,
      // The handler's imports resolve from its own directory: the project keeps
      // it in `src/`, and staging copies `src/` into the asset root, so the
      // asset-side anchor is the asset root itself.
      anchor: path.join(root, SOURCE_DIR, "handler.mjs"),
      stagedAnchor: path.join(output, "handler.mjs"),
      manifest: rootManifest,
    });
  }
  for (const [destination, source] of closure) {
    const manifest = readManifest(source);
    if (manifest === null) {
      continue;
    }
    dependents.push({
      label: destination,
      anchor: path.join(source, "package.json"),
      stagedAnchor: path.join(output, destination, "package.json"),
      manifest,
    });
  }

  let verified = 0;
  for (const dependent of dependents) {
    for (const name of manifestEdges(dependent.manifest)) {
      const expected = resolveWithNode(dependent.anchor, name);
      const found = resolveWithNode(dependent.stagedAnchor, name);

      let detail = "nothing";
      let matched = false;
      if (found !== null) {
        if (!isInside(realOutput, found)) {
          // The Lambda runtime has no such directory: the asset would only load
          // during the bundling run.
          detail = `${found}, which is outside the staged asset`;
        } else {
          const staged = stagedAt.get(found);
          detail = staged === undefined ? `${found}, which the bundle did not stage` : staged.destination;
          matched = staged !== undefined && expected !== null && staged.source === expected;
        }
      } else if (expected === null) {
        continue;
      }

      if (!matched) {
        throw new Error(
          `bundling: the staged asset does not resolve like the project: ` +
            `${dependent.label} imports ${name}, which resolves to ` +
            `${expected === null ? "nothing" : expected} in the project but to ${detail} from the asset`,
        );
      }
      verified += 1;
    }
  }

  if (missing.length > 0) {
    throw new Error(`bundling: the staged asset is missing ${missing.join(", ")}, which the closure stages`);
  }

  return { verified };
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
// production dependency closure — then prove, with Node's own resolver, that the
// staged tree resolves exactly like the project. Nothing is copied that the
// project did not install for production, nothing is left out that it imports,
// and an asset that would resolve anything differently is refused rather than
// emitted.
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

  const verification = verifyStaged(root, output, closure);

  return { outputDir: output, packages: closure.size, edges: verification.verified };
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

module.exports = { assetBundling, productionClosure, stage, verifyStaged };

if (require.main === module) {
  const [projectRoot, outputDir] = process.argv.slice(2);
  if (!projectRoot || !outputDir) {
    console.error("bundling: usage: bundle.cjs <project-root> <output-dir>");
    process.exit(1);
  }
  const result = stage(projectRoot, outputDir);
  console.log(
    `bundling: staged ${result.packages} packages into ${result.outputDir} and verified ${result.edges} edges`,
  );
}
