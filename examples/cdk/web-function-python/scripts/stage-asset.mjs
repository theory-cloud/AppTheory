#!/usr/bin/env node
// Build the deployment package the stack stages.
//
// A Python Web Function's archive root is the import root: Lambda loads `main:app` (or the entry
// point the revision names), so the entry module and everything it imports have to sit at the top of
// the package. `app/` holds the application, and `py/src/apptheory` holds the AppTheory runtime this
// checkout builds — staging the two together is what makes the synthesized asset the thing that
// would actually run, instead of a package that fails at init on an import nobody shipped.
//
// The directory is rebuilt from scratch on every run and byte-code caches are never copied, so the
// result depends only on those two source trees. That is what lets the synthesized template's hash
// be pinned, and it is why the doc tells you to run with `PYTHONDONTWRITEBYTECODE=1` when you serve
// the application by hand.
//
// Usage: node scripts/stage-asset.mjs      # prints the staged directory

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(EXAMPLE_DIR, "..", "..", "..");
const APP_DIR = path.join(EXAMPLE_DIR, "app");
const RUNTIME_DIR = path.join(REPO_ROOT, "py", "src", "apptheory");
const STAGE_DIR = path.join(EXAMPLE_DIR, ".cdk-asset-stage", "python-app");

const SKIPPED_NAMES = new Set(["__pycache__", ".venv", "node_modules"]);
const SKIPPED_SUFFIXES = [".pyc", ".pyo", ".egg-info"];

function skipped(name) {
  return SKIPPED_NAMES.has(name) || SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (skipped(entry.name)) {
      continue;
    }
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(from, to);
      continue;
    }
    throw new Error(`refusing to stage ${from}: only regular files and directories belong in the package`);
  }
}

/** Rebuild the deployment package and return its directory. */
export function stagePythonApp() {
  if (!existsSync(path.join(APP_DIR, "main.py")) || !existsSync(path.join(APP_DIR, "main_wsgi.py"))) {
    throw new Error(`missing the ASGI and WSGI entry modules under ${APP_DIR}`);
  }
  // The runtime is vendored from this checkout rather than installed, so synthesis stays offline and
  // the package matches the source the contract tests pin.
  if (!existsSync(path.join(RUNTIME_DIR, "__init__.py"))) {
    throw new Error(`missing the AppTheory runtime at ${RUNTIME_DIR}`);
  }
  rmSync(STAGE_DIR, { force: true, recursive: true });
  copyTree(APP_DIR, STAGE_DIR);
  copyTree(RUNTIME_DIR, path.join(STAGE_DIR, "apptheory"));
  return STAGE_DIR;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${stagePythonApp()}\n`);
}
