import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const handlerDir = path.join(repoRoot, "examples", "cdk", "hello-world", "handlers", "ts");
const distDir = path.join(repoRoot, "ts", "dist");
const nodeModulesDir = path.join(repoRoot, "ts", "node_modules");

// Stage the Lambda asset exactly as the stack's local bundler does: the handler
// files plus the complete ts/dist runtime, not a single entry file.
const stage = mkdtempSync(path.join(tmpdir(), "apptheory-hello-world-ts-"));
try {
  const vendorDir = path.join(stage, "vendor", "apptheory");
  mkdirSync(vendorDir, { recursive: true });
  for (const file of ["app.mjs", "handler.mjs", "package.json"]) {
    cpSync(path.join(handlerDir, file), path.join(stage, file));
  }
  cpSync(distDir, vendorDir, { recursive: true });
  // The deployment environment provides the runtime's declared dependencies; mirror
  // that here so the staged import surface resolves against the installed tree.
  symlinkSync(nodeModulesDir, path.join(stage, "node_modules"), "dir");

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
