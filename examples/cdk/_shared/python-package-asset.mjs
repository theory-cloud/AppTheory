// Build every Python deployment asset an example's stack stages.
//
// A Lambda's archive root is the import root: the entry module and everything it imports have to sit
// at the top of the package. A Python example stages two kinds of thing — its own modules, and, when
// its handler imports the runtime this checkout builds, that runtime under `apptheory/`. Either way
// the rule that decides what a package may contain is one rule, stated once, here: each example
// contributes only its declaration of which assets it stages, which trees each asset is built from,
// and which files in them ship.
//
// Every Python asset under `examples/cdk/` is built here. That is deliberate: the defect this file
// closes was a deny-list, `lambda.Code.fromAsset(handlerDir, { exclude: ["__pycache__", "*.pyc"] })`,
// and it left one copy of the same broken idea in lambda-packaging, local-iam and local-tls — an
// example that excludes a list of names still deploys whatever kind of residue nobody predicted, and
// a `.env`, a `.pytest_cache` and a note planted in those trees reached their synthesized assets. A
// second asset (lambda-packaging's layer) and an asset that ships no runtime (the local-* callers are
// stdlib-and-botocore handlers) are declarations in the registry below, not a second rule.
//
// The package is defined by what it is allowed to contain, not by what it excludes. `EXAMPLE_PACKAGES`
// and `RUNTIME_TREE` below name every file that ships: an example's own modules, the runtime's
// importable modules and its declared package data. Local-only files that happen to be lying in a
// tree — a `.env`, a `.pytest_cache`, an editor swap file, a note — are not named, so they stay on
// the author's machine and out of the CDK asset, and the asset's hash depends only on files that
// belong in the package. A list of names to skip cannot promise that: it has to anticipate every
// kind of local residue, and each kind nobody thought of changes what gets deployed. That is what
// the hello-world and multilang examples used to do, and a `.env`, a local `tests/` tree and a
// `.pytest_cache` planted in either of their trees reached the synthesized asset.
//
// The allow-list cannot quietly fall behind the source trees either. `verifyTree` fails the build
// when a declared file is missing, or when a tree carries an importable unit the list does not name
// — at any depth, in every shape the import system loads: a `.py` module, a sourceless module (a
// `<module>.pyc` compiled and kept beside its siblings, which Python imports with no `.py` there at
// all), an extension module (`.so` or `.pyd`), a package directory with `__init__.py`, and a
// namespace package directory (Python 3 imports a directory with no `__init__.py` too, as long as it
// holds modules). Every one of them belongs in the package, so growing any of these trees is a
// deliberate act of naming the file here rather than a silently incomplete archive. A sourceless
// module is the shape that used to fall between the two halves of the rule: the walk listed `.py`
// files, so a `helper.pyc` was not declared, not refused, and not copied — staging exited 0 and the
// deployed function could not import a module its own source tree could.
//
// Byte-code *caches* are the one thing inside a `__pycache__` that is residue, and only there. The
// interpreter writes them beside the source it compiles — never as something a later import of that
// directory can load, because a cache is named `<module>.<tag>.pyc` and the import system only looks
// for `<module>.pyc` — so a `<module>.pyc` inside a `__pycache__` is dropped in silence, at any
// depth, and a `__pycache__` holding nothing else is not an importable directory at all. A source
// file or an extension module *inside* a `__pycache__` is not something the interpreter writes
// there, and a directory named `__pycache__` is importable exactly like any other, so those stay
// importable units: named or refused, never dropped on the assumption that a cache directory is
// harmless.
//
// That rule is deliberately total, and it is why a local *Python* test tree cannot live inside these
// trees while a `.env` can: a directory of test modules is importable from the archive root, so it is
// indistinguishable from code the package needs, and the guard refuses it by name instead of guessing
// which unnamed importable unit was meant to ship. Nothing unnamed reaches the asset either way — the
// residue that stays out silently is exactly the residue that Python cannot import. A handler's
// local test therefore lives outside the packaged tree (`examples/cdk/<example>/tests/`), and the
// handler tree holds exactly the modules that ship and nothing else.
//
// The walk classifies each entry by its own type, so it can only be trusted on trees that hold the
// two types it knows: every entry in a tree has to be a regular file or a regular directory. A
// symbolic link — to a file or to a directory — is neither, so a `.py` module reached through a
// link, or a package directory reached through a link, would be invisible here: classified as
// nothing, named by nothing, checked by nothing, copied by nothing, and Python would import it from
// the source tree while the archive it synthesized into could not. That is the same silent omission
// the recursive walk exists to prevent, so links are refused by name instead of followed, at any
// depth, whatever they point at. Following them is not the gentle option it looks like: the guard
// would then be judging a target that is not in the tree it guards, and a link that points outside
// the tree, at a missing file, or in a cycle has no answer the allow-list can state.
//
// The directory is rebuilt from scratch on every run, so the result depends only on the named files
// in those trees. That is what lets the synthesized template's hash be pinned, and it is why a
// hand-run of a Python example needs `PYTHONDONTWRITEBYTECODE=1` (a `__pycache__` is not residue a
// package ships, but leaving one to be walked is still leaving one to be walked).
//
// Usage:
//   node examples/cdk/_shared/python-package-asset.mjs <example-dir> [asset]          # stages, prints the dir
//   node examples/cdk/_shared/python-package-asset.mjs --trees <example-dir> [asset]  # prints one tree per line
//   node examples/cdk/_shared/python-package-asset.mjs --assets <example-dir>         # prints one asset per line

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUNTIME_DIR = path.join(REPO_ROOT, "py", "src", "apptheory");
const STAGE_PARENT = ".cdk-asset-stage";

/**
 * The directory the interpreter writes byte-code caches into, at any depth.
 *
 * Its contents are the one shape that is residue where it stands: the import system never loads
 * `<dir>/__pycache__/<module>.<tag>.pyc`, it loads `<dir>/<module>.py`, `<dir>/<module>.pyc` and
 * `<dir>/<module>.so`. A cache is therefore dropped in silence; a source file or an extension module
 * that happens to sit inside a `__pycache__` is a unit like any other (see `importableUnit`).
 */
const CACHE_DIRECTORY = "__pycache__";

/**
 * The file shapes the import system loads whatever the directory is.
 *
 * `.py` is a source module, `.so` and `.pyd` are extension modules (same module, one per platform's
 * loader), and each is importable from any directory on `sys.path`.
 */
const IMPORTABLE_SUFFIXES = [".py", ".so", ".pyd"];

/**
 * The file shapes the import system loads only outside a `__pycache__`: `<module>.pyc` is the
 * sourceless module Python 3 imports when the source is gone, and `.pyo` is its optimised
 * predecessor, kept here so a tree that still carries one is named rather than dropped.
 */
const BYTE_CODE_SUFFIXES = [".pyc", ".pyo"];

/**
 * The AppTheory runtime, one named file at a time — the same package in every example that ships it.
 *
 * `destination` is where the tree lands in the archive: under `apptheory/`, because that is the
 * name an application imports. `modules` is every file that ships as code or as declared package
 * data; `py.typed` is package data rather than a module, and the runtime declares it in
 * `py/pyproject.toml`, so it ships with the modules that carry the annotations. A directory is not
 * a unit of this list: it is walked, and the files it contributes are named individually.
 */
const RUNTIME_TREE = {
  label: "AppTheory runtime",
  source: RUNTIME_DIR,
  destination: "apptheory",
  modules: [
    "__init__.py",
    "_safe_log.py",
    "app.py",
    "aws_events.py",
    "aws_http.py",
    "bind_handler.py",
    "cache.py",
    "clock.py",
    "cloudfront.py",
    "context.py",
    "emf.py",
    "errors.py",
    "event_workloads.py",
    "ids.py",
    "jobs.py",
    "kinesis_cloudwatch_logs.py",
    "kinesis_producer.py",
    "limited/__init__.py",
    "limited/errors.py",
    "limited/limiter.py",
    "limited/models.py",
    "limited/strategies.py",
    "limited/types.py",
    "logger.py",
    "logging_profile.py",
    "mcp/__init__.py",
    "mcpfacade.py",
    "mcproutes.py",
    "microvm/__init__.py",
    "microvm/aws_provider.py",
    "microvm/contracts.py",
    "microvm/controller.py",
    "microvm/fake.py",
    "microvm/foundation.py",
    "microvm/model.py",
    "microvm/registry.py",
    "microvm/session.py",
    "microvm/shared.py",
    "middleware.py",
    "naming.py",
    "oauth/__init__.py",
    "oauth/autheory.py",
    "oauth/fake_provider.py",
    "oauth/jwks.py",
    "oauth/provider.py",
    "oauth/store.py",
    "objectstore.py",
    "openapi.py",
    "request.py",
    "request_id_source.py",
    "response.py",
    "router.py",
    "sanitization.py",
    "secure_openapi.py",
    "secure_types.py",
    "serving.py",
    "source_provenance.py",
    "sse.py",
    "streamer.py",
    "testkit.py",
    "trace_context.py",
    "util.py",
    "validate.py",
    "vectorstore.py",
  ],
  data: ["py.typed"],
};

/**
 * Each example that stages a Python asset, the assets it stages, and each asset's trees.
 *
 * `source` is relative to the example directory, and `destination` is where the tree lands in the
 * archive: the handler at the root, because that is where the runtime loads its entry module from.
 * The asset name is the staging directory under `.cdk-asset-stage/`, so two Python assets of one
 * example (a function and a layer) are two declarations rather than two packages merged into one.
 *
 * `runtime` says whether the AppTheory runtime is part of every asset this example stages. It is a
 * fact about the example, not a choice: hello-world, multilang and web-function-python handlers
 * import `apptheory`; lambda-packaging's handler and python layer, and the local-iam and local-tls
 * callers, import the standard library or botocore and nothing this checkout builds. Shipping the
 * runtime into those four would deploy code their handlers never import under a name they must not
 * depend on, so the declaration is `false`.
 *
 * The key is the example's directory name. An example with no entry here cannot be staged: the
 * alternative is guessing, and a guess is what produced a deny-list.
 */
const EXAMPLE_PACKAGES = {
  "web-function-python": {
    runtime: true,
    assets: {
      "python-package": [
        {
          label: "application",
          source: "app",
          destination: "",
          modules: ["main.py", "main_wsgi.py", "lib/application.py"],
          data: [],
        },
      ],
    },
  },
  "hello-world": {
    runtime: true,
    assets: {
      "python-package": [
        {
          label: "hello-world handler",
          source: "handlers/py",
          destination: "",
          modules: ["handler.py"],
          data: [],
        },
      ],
    },
  },
  multilang: {
    runtime: true,
    assets: {
      "python-package": [
        {
          label: "multilang handler",
          source: "handlers/py",
          destination: "",
          modules: ["handler.py"],
          data: [],
        },
      ],
    },
  },
};

/**
 * Whether a file name is a unit the import system loads, standing in the directory it sits in.
 *
 * `cached` is true only for the entries directly inside a `__pycache__`: there, byte-code is what
 * the interpreter put there and is residue, while a source file or an extension module is not
 * something the interpreter writes and stays a unit. Everywhere else byte-code is importable.
 */
function importableUnit(name, cached) {
  const lower = name.toLowerCase();
  if (IMPORTABLE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  return !cached && BYTE_CODE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Whether a directory is a package: it holds `__init__` as source or as byte-code. */
function isPackageDirectory(directory) {
  return existsSync(path.join(directory, "__init__.py")) || existsSync(path.join(directory, "__init__.pyc"));
}

/**
 * Every entry in a tree that is not a regular file or a regular directory, at any depth.
 *
 * The two checks below classify entries by their own type — `isFile()` and `isDirectory()` — and
 * both are false for anything else, so an entry the filesystem calls something other than a regular
 * file or a regular directory is an entry neither of them can see. A symbolic link is the case that
 * matters: Python imports a linked `.py` module and a linked package directory from the source tree
 * exactly as it imports the file or the directory they stand for, but the walk would classify them
 * as nothing, name nothing, copy nothing, and deploy an archive that cannot satisfy the import — the
 * silent omission this guard exists to refuse, arriving through a different door.
 *
 * So the rule is the whole shape of the tree: every entry is a regular file or a regular directory.
 * A link is reported by name and not followed, because following it would put the guard's judgement
 * outside the tree it guards — a target that is missing, that lives elsewhere in the repo, or that
 * leads back into the tree has no answer the allow-list can state. Special files (a socket, a fifo,
 * a device) are refused the same way: they are not entries a Python package is built from.
 *
 * Nothing here is residue the allow-list drops in silence: silence is for what Python cannot import,
 * and a link is not a verdict about its target, it is an absence of one.
 */
function specialEntries(directory, prefix = "") {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      found.push(`${relative} (a symbolic link)`);
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...specialEntries(path.join(directory, entry.name), relative));
      continue;
    }
    if (!entry.isFile()) {
      found.push(`${relative} (not a regular file or a regular directory)`);
    }
  }
  return found;
}

/** The unit file names directly inside one directory of a tree, sorted. */
function unitsIn(directory, cached) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && importableUnit(entry.name, cached))
    .map((entry) => entry.name)
    .sort();
}

/** Every importable unit anywhere beneath a directory, as paths relative to it, sorted. */
function unitsBelow(directory, cached, prefix = "") {
  const found = [];
  for (const name of unitsIn(directory, cached)) {
    found.push(prefix ? `${prefix}/${name}` : name);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    found.push(...unitsBelow(path.join(directory, entry.name), entry.name === CACHE_DIRECTORY, relative));
  }
  return found.sort();
}

/**
 * Every importable unit in a tree that the allow-list does not name, at any depth.
 *
 * The import system loads several shapes, and all of them are walked here, because all of them would
 * deploy incomplete if they were left out: a `.py` module, a sourceless `<module>.pyc` beside its
 * siblings, an extension module (`.so`, `.pyd`), a package directory holding `__init__.py`, and a
 * namespace package — a directory with no `__init__.py` that Python still imports because it holds
 * modules. Depth is irrelevant to importability: `apptheory.oauth.newsub` imports from
 * `apptheory/oauth/newsub/` just as `apptheory.router` imports from `apptheory/router.py`, so a walk
 * that stops at the directories somebody thought to list is a walk that misses growth. (A directory
 * with no importable file beneath it is not importable, which is what keeps `__pycache__` and a
 * local `.pytest_cache` out of the findings.)
 *
 * A directory the allow-list names nothing inside is reported once, together with the files it would
 * have brought in; a directory it partly names is descended into, so its own undeclared units are
 * reported by name.
 */
function undeclaredUnits(tree, declared) {
  const named = new Set(declared);
  const namesInside = (relative) => {
    const prefix = relative ? `${relative}/` : "";
    return declared.some((name) => name.startsWith(prefix) && name.length > prefix.length);
  };
  const found = [];

  const walk = (relative, cached) => {
    const absolute = relative ? path.join(tree.source, relative) : tree.source;
    for (const name of unitsIn(absolute, cached)) {
      const file = relative ? `${relative}/${name}` : name;
      if (!named.has(file)) {
        found.push(`${file} (a module the allow-list does not name)`);
      }
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childCached = entry.name === CACHE_DIRECTORY;
      if (namesInside(childRelative)) {
        walk(childRelative, childCached);
        continue;
      }
      const below = unitsBelow(path.join(absolute, entry.name), childCached);
      if (!below.length) {
        continue;
      }
      const kind = isPackageDirectory(path.join(absolute, entry.name)) ? "a package" : "a namespace package";
      found.push(`${childRelative}/ (${kind} the allow-list does not walk: ${below.join(", ")})`);
    }
  };

  walk("", false);
  return found;
}

/**
 * Hold a tree to its allow-list, and fail closed when the two disagree.
 *
 * Three directions matter. An entry that is not a regular file or a regular directory is a shape
 * the walk cannot classify, so it would be checked by nothing and copied by nothing however
 * importable it is — the build stops and names every one of them before it reads the allow-list at
 * all. A declared file that is not there means the package would deploy broken — an import the
 * archive cannot satisfy — so the build stops and names it. An importable unit the list does not
 * name means the package would deploy *incomplete*, silently missing code the source tree has, so
 * the build stops and names that too.
 */
function verifyTree(tree) {
  const declared = [...tree.modules, ...tree.data];

  const special = specialEntries(tree.source);
  if (special.length) {
    throw new Error(
      `the ${tree.label} tree has entries that are not a regular file or a regular directory: ${special.join(", ")}. ` +
        "Every entry in a packaged tree has to be a regular file or a regular directory, so a symbolic link to a " +
        "file or a directory is refused by name rather than followed: a linked module or a linked package " +
        "directory imports from the source tree but cannot be checked against the allow-list or shipped in the " +
        "archive, which is exactly how a package deploys incomplete. Replace the link with the file or the " +
        "directory itself, name it in EXAMPLE_PACKAGES or RUNTIME_TREE in " +
        "examples/cdk/_shared/python-package-asset.mjs if it ships, or keep it outside the packaged trees.",
    );
  }

  const missing = declared.filter((relative) => {
    const target = path.join(tree.source, relative);
    return !existsSync(target) || !statSync(target).isFile();
  });
  if (missing.length) {
    throw new Error(`the allow-list names ${tree.label} files that are not there: ${missing.join(", ")}`);
  }

  const undeclared = undeclaredUnits(tree, declared);
  if (undeclared.length) {
    throw new Error(
      `the ${tree.label} tree has importable units the allow-list does not name: ${undeclared.join(", ")}. ` +
        "Name them in EXAMPLE_PACKAGES or RUNTIME_TREE in examples/cdk/_shared/python-package-asset.mjs if " +
        "they ship with the package — a module, a sourceless module kept beside its siblings, an extension " +
        "module, a package or a namespace package directory all import from the archive root. A module, test " +
        "tree or scratch package that is local-only does not ship, so keep it outside the packaged trees (a " +
        "handler's local test lives in examples/cdk/<example>/tests/); byte-code caches belong in a " +
        "__pycache__, which is dropped in silence.",
    );
  }
}

/** The example's declaration, and the name of the asset to stage within it. */
function declaredAsset(exampleDir, assetName) {
  const example = path.resolve(exampleDir);
  const declared = EXAMPLE_PACKAGES[path.basename(example)];
  if (!declared) {
    throw new Error(
      `${path.basename(example)} declares no Python package: name the assets it stages in EXAMPLE_PACKAGES in ` +
        "examples/cdk/_shared/python-package-asset.mjs, or do not stage a Python asset for it.",
    );
  }
  const names = Object.keys(declared.assets);
  let name = assetName;
  if (name === undefined) {
    if (names.length !== 1) {
      throw new Error(
        `${path.basename(example)} declares ${names.length} Python assets (${names.join(", ")}): name the one to ` +
          "stage in the stack's staging call and in EXAMPLE_PACKAGES in " +
          "examples/cdk/_shared/python-package-asset.mjs.",
      );
    }
    [name] = names;
  }
  if (!declared.assets[name]) {
    throw new Error(
      `${path.basename(example)} declares no ${name} asset: it declares ${names.join(", ")}. ` +
        "Name it in EXAMPLE_PACKAGES in examples/cdk/_shared/python-package-asset.mjs, or stage one of the " +
        "declared assets.",
    );
  }
  return { example, declared, name };
}

/** The trees one asset is built from, with its handler trees resolved against the example directory. */
export function packageTrees(exampleDir, assetName) {
  const { example, declared, name } = declaredAsset(exampleDir, assetName);
  return [
    ...declared.assets[name].map((tree) => ({ ...tree, source: path.join(example, tree.source) })),
    ...(declared.runtime ? [RUNTIME_TREE] : []),
  ];
}

/** Rebuild one asset's deployment package and return its directory. */
export function stagePythonPackage(exampleDir, assetName) {
  const { example, name } = declaredAsset(exampleDir, assetName);
  const trees = packageTrees(example, name);
  for (const tree of trees) {
    verifyTree(tree);
  }
  const stageDir = path.join(example, STAGE_PARENT, name);
  rmSync(stageDir, { force: true, recursive: true });
  mkdirSync(stageDir, { recursive: true });
  for (const tree of trees) {
    for (const relative of [...tree.modules, ...tree.data]) {
      const to = path.join(stageDir, tree.destination, relative);
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(path.join(tree.source, relative), to);
    }
  }
  return stageDir;
}

function main(argv) {
  const [first, second, third] = argv;
  if (first === "--trees" || first === "--assets") {
    if (!second) {
      throw new Error(`${first} needs the example directory`);
    }
    if (first === "--assets") {
      const declared = EXAMPLE_PACKAGES[path.basename(path.resolve(second))];
      if (!declared) {
        throw new Error(
          `${path.basename(second)} declares no Python package: name the assets it stages in EXAMPLE_PACKAGES ` +
            "in examples/cdk/_shared/python-package-asset.mjs, or do not stage a Python asset for it.",
        );
      }
      process.stdout.write(`${Object.keys(declared.assets).join("\n")}\n`);
      return;
    }
    process.stdout.write(`${packageTrees(second, third).map((tree) => tree.source).join("\n")}\n`);
    return;
  }
  if (!first) {
    throw new Error("usage: python-package-asset.mjs [--trees|--assets] <example-dir> [asset]");
  }
  process.stdout.write(`${stagePythonPackage(first, second)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
