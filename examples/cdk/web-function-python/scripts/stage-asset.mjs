#!/usr/bin/env node
// Build the deployment package the stack stages.
//
// A Python Web Function's archive root is the import root: Lambda loads `main:app` (or the entry
// point the revision names), so the entry module and everything it imports have to sit at the top of
// the package. `app/` holds the application, and `py/src/apptheory` holds the AppTheory runtime this
// checkout builds — staging the two together is what makes the synthesized asset the thing that
// would actually run, instead of a package that fails at init on an import nobody shipped.
//
// The package is defined by what it is allowed to contain, not by what it excludes. `PACKAGE_TREES`
// below names every file that ships: the application's modules and the runtime's importable modules
// plus its declared package data. Local-only files that happen to be lying in either tree — a
// `.env`, a `.pytest_cache`, an editor swap file, a note — are not named, so they stay on the
// author's machine and out of the CDK asset, and the asset's hash depends only on files that belong
// in the package. A list of names to skip cannot promise that: it has to anticipate every kind of
// local residue, and each kind nobody thought of changes what gets deployed.
//
// The allow-list cannot quietly fall behind the source trees either. `verifyTree` fails the build
// when a declared file is missing, or when a tree carries an importable unit the list does not name
// — at any depth, in any of the three shapes Python makes importable: a `.py` module, a package
// directory with `__init__.py`, or a namespace package directory (Python 3 imports a directory with
// no `__init__.py` too, as long as it holds modules). Every one of them belongs in the package, so
// growing the runtime is a deliberate one-line act here rather than a silently incomplete archive.
//
// That rule is deliberately total, and it is why a local *Python* test tree cannot live inside
// these two trees while a `.env` can: a directory of test modules is importable from the archive
// root, so it is indistinguishable from code the package needs, and the guard refuses it by name
// instead of guessing which unnamed importable unit was meant to ship. Nothing unnamed reaches the
// asset either way — the residue that stays out silently is exactly the residue that Python cannot
// import.
//
// The walk classifies each entry by its own type, so it can only be trusted on trees that hold the
// two types it knows: every entry in either tree has to be a regular file or a regular directory.
// A symbolic link — to a file or to a directory — is neither, so a `.py` module reached through a
// link, or a package directory reached through a link, would be invisible here: classified as
// nothing, named by nothing, checked by nothing, copied by nothing, and Python would import it from
// the source tree while the archive it synthesized into could not. That is the same silent omission
// the recursive walk exists to prevent, so links are refused by name instead of followed, at any
// depth, whatever they point at. Following them is not the gentle option it looks like: the guard
// would then be judging a target that is not in the tree it guards, and a link that points outside
// the tree, at a missing file, or in a cycle has no answer the allow-list can state.
//
// The directory is rebuilt from scratch on every run, so the result depends only on the named files
// in those two source trees. That is what lets the synthesized template's hash be pinned, and it is
// why the doc tells you to run with `PYTHONDONTWRITEBYTECODE=1` when you serve the application by
// hand.
//
// Usage: node scripts/stage-asset.mjs      # prints the staged directory

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(EXAMPLE_DIR, "..", "..", "..");
const APP_DIR = path.join(EXAMPLE_DIR, "app");
const RUNTIME_DIR = path.join(REPO_ROOT, "py", "src", "apptheory");
const STAGE_DIR = path.join(EXAMPLE_DIR, ".cdk-asset-stage", "python-app");

/**
 * The package, one named file at a time.
 *
 * `destination` is where the tree lands in the archive: the application at the archive root, because
 * that is the import root Lambda loads its entry module from, and the runtime under `apptheory/`,
 * because that is the name the application imports.
 *
 * `modules` is every file that ships as code or as declared package data — whatever the tree's shape,
 * nothing else joins the package. A directory is not a unit of the allow-list: it is walked, and the
 * files it contributes are named individually, because a directory that ships (a local `tests/`, a
 * `.pytest_cache/`, a namespace directory) is exactly what a list of directories cannot distinguish
 * from a package. `data` is package data that is not a module: the runtime declares `py.typed` in
 * `py/pyproject.toml`, so it ships with the modules that carry the annotations.
 */
const PACKAGE_TREES = [
  {
    label: "application",
    source: APP_DIR,
    destination: "",
    modules: ["main.py", "main_wsgi.py", "lib/application.py"],
    data: [],
  },
  {
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
  },
];

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

/** The module names directly inside one directory of a tree, sorted. */
function modulesIn(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
    .map((entry) => entry.name)
    .sort();
}

/** Every `.py` file anywhere beneath a directory, as paths relative to it, sorted. */
function pythonFilesBelow(directory, prefix = "") {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...pythonFilesBelow(path.join(directory, entry.name), relative));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".py")) {
      found.push(relative);
    }
  }
  return found.sort();
}

/**
 * Every importable unit in a tree that the allow-list does not name, at any depth.
 *
 * Python imports three shapes, and all three are walked here, because all three would deploy
 * incomplete if they were left out: a `.py` module, a package directory holding `__init__.py`, and a
 * namespace package — a directory with no `__init__.py` that Python still imports because it holds
 * modules. Depth is irrelevant to importability: `apptheory.oauth.newsub` imports from
 * `apptheory/oauth/newsub/` just as `apptheory.router` imports from `apptheory/router.py`, so a walk
 * that stops at the directories somebody thought to list is a walk that misses growth. (A directory
 * with no Python beneath it is not importable, which is what keeps `__pycache__` and a local
 * `.pytest_cache` out of the findings.)
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

  const walk = (relative) => {
    const absolute = relative ? path.join(tree.source, relative) : tree.source;
    for (const name of modulesIn(absolute)) {
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
      if (namesInside(childRelative)) {
        walk(childRelative);
        continue;
      }
      const below = pythonFilesBelow(path.join(absolute, entry.name));
      if (!below.length) {
        continue;
      }
      const kind = existsSync(path.join(absolute, entry.name, "__init__.py"))
        ? "a package"
        : "a namespace package";
      found.push(`${childRelative}/ (${kind} the allow-list does not walk: ${below.join(", ")})`);
    }
  };

  walk("");
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
        "Every entry in these two trees has to be a regular file or a regular directory, so a symbolic link to a " +
        "file or a directory is refused by name rather than followed: a linked module or a linked package " +
        "directory imports from the source tree but cannot be checked against the allow-list or shipped in the " +
        "archive, which is exactly how the package used to deploy incomplete. Replace the link with the file or " +
        "the directory itself, name it in PACKAGE_TREES in scripts/stage-asset.mjs if it ships, or keep it " +
        "outside these two trees.",
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
        "Name them in PACKAGE_TREES in scripts/stage-asset.mjs if they ship with the package; a module, test " +
        "tree or scratch package that is local-only does not ship, so keep it outside these two trees.",
    );
  }
}

/** Rebuild the deployment package and return its directory. */
export function stagePythonApp() {
  for (const tree of PACKAGE_TREES) {
    verifyTree(tree);
  }
  rmSync(STAGE_DIR, { force: true, recursive: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  for (const tree of PACKAGE_TREES) {
    for (const relative of [...tree.modules, ...tree.data]) {
      const to = path.join(STAGE_DIR, tree.destination, relative);
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(path.join(tree.source, relative), to);
    }
  }
  return STAGE_DIR;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${stagePythonApp()}\n`);
}
