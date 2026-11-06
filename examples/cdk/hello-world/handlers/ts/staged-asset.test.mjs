import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const handlerDir = path.join(repoRoot, "examples", "cdk", "hello-world", "handlers", "ts");
const distDir = path.join(repoRoot, "ts", "dist");
const runtimeDir = path.join(repoRoot, "ts");
const runtimeNodeModules = path.join(runtimeDir, "node_modules");

function stageRuntimeDependencies(destination) {
  const marker = path.join(runtimeNodeModules, "@theory-cloud", "tabletheory-ts", "package.json");
  if (!existsSync(marker)) {
    throw new Error(`missing ${marker}; run 'cd ts && npm ci --ignore-scripts' first`);
  }
  const listed = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
    cwd: runtimeDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `${runtimeNodeModules}${path.sep}`;
  for (const line of listed.split("\n")) {
    const dependency = line.trim();
    if (!dependency.startsWith(prefix)) {
      continue;
    }
    cpSync(dependency, path.join(destination, dependency.slice(prefix.length)), { recursive: true });
  }
}

// Stage the Lambda asset exactly as the stack's bundler does: the handler files,
// the complete ts/dist runtime, and the runtime's production dependency closure.
// Nothing resolves from the checkout or from a symlink, so a missing dependency
// fails here the same way it fails at init in a clean Lambda runtime.
const stage = mkdtempSync(path.join(tmpdir(), "apptheory-hello-world-ts-"));
try {
  const vendorDir = path.join(stage, "vendor", "apptheory");
  mkdirSync(vendorDir, { recursive: true });
  for (const file of ["app.mjs", "handler.mjs", "package.json"]) {
    cpSync(path.join(handlerDir, file), path.join(stage, file));
  }
  cpSync(distDir, vendorDir, { recursive: true });
  stageRuntimeDependencies(path.join(stage, "node_modules"));

  const { handler } = await import(pathToFileURL(path.join(stage, "handler.mjs")).href);
  assert.equal(typeof handler, "function", "staged handler.mjs must export a function");

  const { createTestEnv, json } = await import(pathToFileURL(path.join(vendorDir, "index.js")).href);
  const { buildHelloWorldApp } = await import(pathToFileURL(path.join(stage, "app.mjs")).href);

  const env = createTestEnv();
  const app = buildHelloWorldApp({ createApp: (options) => env.app(options), json }, {
    APPTHEORY_HELLO_LANG: "ts",
    APPTHEORY_TIER: "p0",
  });

  const resp = await env.invoke(app, { method: "GET", path: "/hello/AppTheory" });
  assert.equal(resp.status, 200, `staged app status=${resp.status} body=${new TextDecoder().decode(resp.body)}`);
  const body = JSON.parse(new TextDecoder().decode(resp.body));
  assert.equal(body.message, "hello AppTheory");
  assert.equal(body.runtime, "ts");
} finally {
  rmSync(stage, { force: true, recursive: true });
}

console.log("examples/cdk/hello-world/handlers/ts/staged-asset.test.mjs: PASS");
