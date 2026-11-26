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
// Verification is by file, not by folder. Two of these package layouts resolve a
// declared edge to the right *directory* while loading a different *file* — or
// no file at all — so comparing installed paths is not enough. Every declared
// edge is asked for its exact entry file on both sides, and the file the project
// loads must be the file the asset loads, at the same path inside the same
// staged copy. Both layouts an asset cannot reproduce are refused by name, with
// the package and the path: a package whose entry point (`main` or `exports`)
// resolves outside its own directory, and a `node_modules` directory below a
// package's root that the asset does not carry. Neither is a shape `npm install`
// produces — npm installs a dependency at its dependent's `node_modules` root,
// never deeper, and the registry ships a package's own files — but an author can
// build either by hand and a published tarball can ship the second, and staging
// them would emit an asset that resolves differently from the project.
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

// Ask Node itself which *file* it loads for `name` from a file or directory: the
// exact entry point behind `main`/`exports`, not the folder that holds it.
// Returns null when Node loads no file from the tree — a core module name — or
// cannot resolve one at all.
function resolveFileWithNode(anchor, name) {
  const request = createRequire(anchor);
  if (request.resolve.paths(name) === null) {
    return null;
  }
  try {
    return fs.realpathSync(request.resolve(name));
  } catch {
    return null;
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// The entry points a manifest declares: `main`, and every string in `exports`
// (conditions, arrays and patterns alike).
function entryTargets(manifest) {
  const targets = [];
  if (typeof manifest.main === "string" && manifest.main.length > 0) {
    targets.push({ field: "main", target: manifest.main });
  }
  const collect = (value, field) => {
    if (typeof value === "string") {
      targets.push({ field, target: value });
    } else if (Array.isArray(value)) {
      for (const item of value) {
        collect(item, field);
      }
    } else if (value !== null && typeof value === "object") {
      for (const key of Object.keys(value)) {
        collect(value[key], field);
      }
    }
  };
  if (manifest.exports !== undefined) {
    collect(manifest.exports, "exports");
  }
  return targets;
}

// Every `node_modules` directory below a package's own root, topmost only: the
// packages inside one are closure entries of their own, and are checked when
// they are staged.
function nestedNodeModules(source) {
  const found = [];
  const seen = new Set();
  const walk = (dir, relative) => {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) {
      return;
    }
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      const childRelative = relative === "" ? entry.name : path.join(relative, entry.name);
      if (entry.name === "node_modules") {
        if (isDirectory(child)) {
          found.push(childRelative);
        }
        continue;
      }
      if (isDirectory(child)) {
        walk(child, childRelative);
      }
    }
  };
  walk(source, "");
  return found;
}

// The production edges one package contributes: what its manifest declares, in
// declaration order.
function manifestEdges(manifest) {
  const { required, optional } = declaredDependencies(manifest);
  return [...required, ...optional];
}

// The packages one `node_modules` directory holds, by their install name: a
// scoped directory is not a package, and an entry without a manifest is not
// resolvable by name, so neither is a copy the asset has to carry.
function heldPackages(dir) {
  const held = [];
  const collect = (parent, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      return held;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const candidate = path.join(parent, entry.name);
      if (!isDirectory(candidate)) {
        continue;
      }
      if (prefix === "" && entry.name.startsWith("@")) {
        collect(candidate, `${entry.name}${path.sep}`);
        continue;
      }
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        held.push({ name: `${prefix}${entry.name}`, path: candidate });
      }
    }
    return held;
  };
  return collect(dir, "");
}

// The two package layouts the asset cannot reproduce faithfully, refused by name
// before any edge is resolved.
//
// The first is a package whose entry point leaves its own directory: `main` or an
// `exports` target that resolves above, below or beside the package. npm packs a
// package's own files, so nothing outside its directory is published with it; the
// project can still load such a file because it only exists in the project's
// checkout, and an asset cannot.
//
// The second is a `node_modules` inside a package's own *subtree* — below its
// root, never at it. Node's walk from a file inside the package reaches one, so
// the project loads what it holds, but the closure resolves a package's
// dependencies from the package root and the asset carries no such subtree: the
// dependent would silently load whichever copy the asset's own walk reaches
// instead. `npm install` never creates one.
//
// A package's own *root-level* `node_modules` is the opposite case and stays
// supported, because npm does create it: a nested copy for a version conflict, a
// published bundled dependency, and a linked checkout's own install — including
// its development tree, which is excluded here exactly as it always has been (a
// scaffold built from a `file:` link carries that tree, and its transitive dev
// dependencies are not declared by the package itself, so nothing about the
// package's root can decide what belongs in the asset). Whatever the closure
// resolves from that root is staged from it, and each declared edge is checked by
// the rules above.
function refuseUnfaithfulLayouts(output, stagedAt, closure) {
  for (const [destination, source] of closure) {
    const manifest = readManifest(source);
    if (manifest === null) {
      continue;
    }
    const name = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : path.basename(destination);

    for (const { field, target } of entryTargets(manifest)) {
      const entry = path.resolve(source, target);
      if (!isInside(source, entry)) {
        throw new Error(
          `bundling: the staged package ${name} at ${destination} declares ${field} ${JSON.stringify(target)}, ` +
            `which resolves outside its own directory (${entry}); ` +
            `a supported layout keeps every package's entry point inside the package`,
        );
      }
    }

    for (const relative of nestedNodeModules(source)) {
      if (relative === "node_modules") {
        // The package's own root-level install: the shape npm leaves — a nested
        // copy for a conflict, a bundled dependency, a linked checkout's own
        // development tree. Whatever the closure resolves from here is staged
        // from here; the rest is not imported at run time, and the handler's own
        // edges are checked above.
        continue;
      }
      for (const held of heldPackages(path.join(source, relative))) {
        let heldSource;
        try {
          heldSource = fs.realpathSync(held.path);
        } catch {
          continue;
        }
        const carriedAt = path.join(output, destination, relative, held.name);
        const carried = fs.existsSync(carriedAt) ? stagedAt.get(fs.realpathSync(carriedAt)) : undefined;
        if (carried !== undefined && carried.source === heldSource) {
          continue;
        }
        throw new Error(
          `bundling: the staged package ${name} at ${destination} carries ${path.join(destination, relative, held.name)}, ` +
            `which the asset does not carry; ` +
            `a supported layout installs a package's dependencies through the project's own closure, ` +
            `never inside a package's own subtree`,
        );
      }
    }
  }
}

// The fail-closed check: from the asset that was actually staged, ask Node to
// resolve every declared production edge of every staged package and of the
// handler entry, and refuse to emit the asset unless each edge loads the same
// file the project loads.
//
// The oracle is Node's resolver, not a re-implementation of its walk: the search
// path comes from `require.resolve.paths`, so the `node_modules/node_modules`
// skip, scoped link slots and every other shape of the walk are Node's own
// rules. Identity is the copy, not the name: two copies of one version are still
// two packages, and an edge pinned to the copy the project resolved must find
// that copy (or a copy staged from the same source) inside the asset. And
// identity is the *file*: an edge is accepted only when `require.resolve` finds
// the same entry point at the same path inside the same staged copy, because a
// package directory can resolve to the project's copy while the file a dependent
// actually loads is a different copy's — or missing altogether.
//
// Before any edge is resolved, the two layouts an asset cannot reproduce are
// refused by name: a package whose entry point leaves its own directory, and a
// `node_modules` directory inside a package's subtree that the asset does not
// carry. Both would otherwise stage a package the project loads differently, and
// no edge check anchored at a package root can see the difference.
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

  // The staged copies, deepest first, for asking a staged file what it is.
  const stagedCopies = [...stagedAt.entries()]
    .map(([staged, entry]) => ({ staged, destination: entry.destination, source: entry.source }))
    .sort((a, b) => b.staged.length - a.staged.length);

  refuseUnfaithfulLayouts(output, stagedAt, closure);

  const sources = path.join(root, SOURCE_DIR);

  // What a file is: the copy it belongs to and its path inside that copy. The
  // handler sources are copied to the asset root, and every other staged file
  // sits inside a staged package, so both sides answer the same question.
  const sourcesCopy = Symbol("handler sources");
  const projectIdentity = (file) => {
    if (isInside(sources, file)) {
      return { copy: sourcesCopy, relative: path.relative(sources, file) };
    }
    let best = null;
    for (const source of new Set(closure.values())) {
      if (isInside(source, file) && (best === null || source.length > best.length)) {
        best = source;
      }
    }
    return best === null ? null : { copy: best, relative: path.relative(best, file) };
  };
  const stagedIdentity = (file) => {
    for (const copy of stagedCopies) {
      if (isInside(copy.staged, file)) {
        return { copy: copy.source, relative: path.relative(copy.staged, file) };
      }
    }
    if (isInside(realOutput, file)) {
      return { copy: sourcesCopy, relative: path.relative(realOutput, file) };
    }
    return null;
  };
  const stagedDestination = (copy) => {
    const staged = stagedCopies.find((candidate) => candidate.source === copy);
    return staged === undefined ? copy : staged.destination;
  };
  const describe = ({ copy, relative }) =>
    path.join(copy === sourcesCopy ? SOURCE_DIR : stagedDestination(copy), relative);

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

  // The handler entry itself: the file the runtime starts from must be in the
  // asset, at the asset root, as the same bytes the project runs. It is not an
  // edge, so nothing above asks Node about it.
  const handlerEntry = path.join(root, SOURCE_DIR, "handler.mjs");
  if (fs.existsSync(handlerEntry)) {
    const stagedEntry = path.join(realOutput, path.relative(sources, fs.realpathSync(handlerEntry)));
    if (!fs.existsSync(stagedEntry) || !fs.readFileSync(stagedEntry).equals(fs.readFileSync(handlerEntry))) {
      throw new Error(
        `bundling: the staged asset does not carry the handler entry: ` +
          `${handlerEntry} is not at ${stagedEntry} in the asset`,
      );
    }
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

      // The same edge, one level down: the exact file Node loads. The directory
      // is the same copy in the asset, so any difference here is a dependency
      // the project resolves from inside that copy and the asset cannot.
      const expectedFile = resolveFileWithNode(dependent.anchor, name);
      const foundFile = resolveFileWithNode(dependent.stagedAnchor, name);
      if (expectedFile !== null || foundFile !== null) {
        const expectedWhere = expectedFile === null ? null : projectIdentity(expectedFile);
        const foundWhere = foundFile === null ? null : stagedIdentity(foundFile);
        const sameFile =
          expectedFile !== null &&
          foundFile !== null &&
          expectedWhere !== null &&
          foundWhere !== null &&
          expectedWhere.copy === foundWhere.copy &&
          expectedWhere.relative === foundWhere.relative;
        if (!sameFile) {
          const projectSide =
            expectedFile === null
              ? "no file (Node cannot resolve an entry point)"
              : expectedWhere === null
                ? `${expectedFile}, which is outside every staged copy`
                : `${describe(expectedWhere)} (${expectedFile})`;
          const assetSide =
            foundFile === null
              ? "nothing (Node cannot resolve an entry point)"
              : foundWhere === null
                ? `${foundFile}, which is outside every staged copy`
                : `${describe(foundWhere)} (${foundFile})`;
          throw new Error(
            `bundling: the staged asset does not resolve like the project: ` +
              `${dependent.label} imports ${name}, which loads ${projectSide} in the project ` +
              `but ${assetSide} from the asset`,
          );
        }
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
