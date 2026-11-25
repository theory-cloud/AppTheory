const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const apptheory = require("../lib");

// The apptheory-init scaffold ships one bundling module per language, and both
// the CDK app and the bundling image run it. These tests prove what it stages:
// the handler sources, the project manifest and the project's complete
// *production* dependency closure — never a partial one, which is what produced
// an asset whose handler could not import `@aws-sdk/client-s3`.

const TS_BUNDLE = path.join("templates", "apptheory-init", "ts", "cdk", "bundle.cjs");
const PY_BUNDLE = path.join("templates", "apptheory-init", "py", "cdk", "bundle.cjs");

const tsBundle = () => require(path.join(REPO_ROOT, TS_BUNDLE));

function writePackage(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeSources(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "handler.mjs"), "export const handler = () => 1;\n");
  fs.writeFileSync(
    path.join(projectRoot, "src", "app.mjs"),
    'import { x } from "hoisted";\nexport const app = x;\n',
  );
}

// An installed package with a CommonJS entry point, written directly into the
// tree the way `npm install` leaves it.
function installPackage(dir, name, version, { dependencies, code, manifest } = {}) {
  const target = path.join(dir, "node_modules", name);
  writePackage(target, {
    name,
    version,
    dependencies,
    main: "index.cjs",
    ...manifest,
  });
  if (code) {
    fs.writeFileSync(path.join(target, "index.cjs"), `${code}\n`);
  }
  return target;
}

// Ask Node itself what a directory inside the staged asset resolves a name to,
// and the version it finds there. This is the resolution the Lambda runtime
// performs, not an approximation of it.
function resolveInAsset(outputDir, from, name) {
  const script = `
    const { createRequire } = require("node:module");
    const path = require("node:path");
    const from = createRequire(path.join(${JSON.stringify(outputDir)}, ${JSON.stringify(from)}, "noop.js"));
    const manifest = from.resolve(${JSON.stringify(`${name}/package.json`)});
    process.stdout.write(JSON.stringify({
      resolved: path.relative(${JSON.stringify(outputDir)}, path.dirname(manifest)).split(path.sep).join("/"),
      version: from(manifest).version,
    }));
  `;
  const probe = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(
    probe.status,
    0,
    `resolving ${name} from ${from || "the asset root"} failed:\n${probe.stderr}`,
  );
  return JSON.parse(probe.stdout);
}

// Interpreters the asset is additionally loaded from. The running Node line is
// always the first one; `APPTHEORY_BUNDLE_INTERPRETERS` lets an evidence run add
// the other supported line, and CI proves the default line on every commit.
function assetInterpreters() {
  const extra = (process.env.APPTHEORY_BUNDLE_INTERPRETERS ?? "")
    .split(/\s+/)
    .filter((entry) => entry.length > 0);
  return [process.execPath, ...extra];
}

// Load the staged asset's handler from inside the asset directory, invoke it and
// return what it resolved, under every interpreter the run proves.
function invokeFromAsset(outputDir, expected, handlerFile = "handler.mjs") {
  const script = `
    import assert from "node:assert/strict";
    const { handler } = await import(${JSON.stringify(pathToFileURL(path.join(outputDir, handlerFile)).href)});
    const result = handler();
    assert.deepEqual(result, ${JSON.stringify(expected)}, "the asset resolved " + JSON.stringify(result));
    process.stdout.write(JSON.stringify(result));
  `;
  const results = [];
  for (const interpreter of assetInterpreters()) {
    const loaded = spawnSync(interpreter, ["--input-type=module", "-e", script], {
      cwd: outputDir,
      encoding: "utf8",
    });
    assert.equal(
      loaded.status,
      0,
      `the staged asset did not load under ${interpreter}:\n${loaded.stderr}`,
    );
    results.push({ interpreter, resolved: JSON.parse(loaded.stdout) });
  }
  return results;
}

// The resolution layout the closed finding pinned: one dependency keeps a
// nested copy, two dependents share the root copy.
function loadFromAsset(outputDir, handlerFile = "handler.mjs") {
  return invokeFromAsset(outputDir, { a: 1, b: 2, c: 2 }, handlerFile);
}

// Sanity's resolution layout, as a generated app leaves it: one dependency keeps
// a nested copy of the shared package it needs, and two dependents share the
// copy installed at the project root. `npm ls` reports both shared edges — the
// second one deduped — and the unbundled handler resolves 1, 2 and 2.
function writeMixedResolutionLayout(root) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "handler.mjs"),
    [
      'import a from "review-addon-a";',
      'import b from "review-addon-b";',
      'import c from "review-addon-c";',
      "",
      "export const handler = () => ({ a, b, c });",
      "",
    ].join("\n"),
  );
  writePackage(root, {
    name: "project",
    version: "0.0.0",
    type: "module",
    dependencies: { "review-addon-a": "1.0.0", "review-addon-b": "1.0.0", "review-addon-c": "1.0.0" },
  });
  const addonA = installPackage(root, "review-addon-a", "1.0.0", {
    dependencies: { "review-shared": "1.0.0" },
    code: 'module.exports = require("review-shared").v1()',
  });
  installPackage(root, "review-addon-b", "1.0.0", {
    dependencies: { "review-shared": "2.0.0" },
    code: 'module.exports = require("review-shared").v2()',
  });
  installPackage(root, "review-addon-c", "1.0.0", {
    dependencies: { "review-shared": "2.0.0" },
    code: 'module.exports = require("review-shared").v2()',
  });
  installPackage(root, "review-shared", "2.0.0", { code: "module.exports.v2 = () => 2" });
  installPackage(addonA, "review-shared", "1.0.0", { code: "module.exports.v1 = () => 1" });
}

test("the TypeScript bundler stages the whole production closure and no development tree", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-ts-"));
  const root = path.join(workspace, "project");
  const linked = path.join(workspace, "linked");
  try {
    writeSources(root);
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      type: "module",
      dependencies: { hoisted: "*", "@scope/linked": "file:../linked" },
      devDependencies: { eslint: "*", typescript: "*" },
    });

    // Hoisted, scoped, and a nested second copy of a name that is also hoisted.
    writePackage(path.join(root, "node_modules", "hoisted"), {
      name: "hoisted",
      version: "1.0.0",
      dependencies: { parent: "*" },
    });
    writePackage(path.join(root, "node_modules", "parent"), {
      name: "parent",
      version: "1.0.0",
      dependencies: { nested: "*" },
    });
    writePackage(path.join(root, "node_modules", "parent", "node_modules", "nested"), {
      name: "nested",
      version: "2.0.0",
    });
    // A development dependency and a dependency of that development dependency:
    // neither is imported by the handler, so neither belongs in the asset.
    writePackage(path.join(root, "node_modules", "eslint"), {
      name: "eslint",
      version: "10.0.0",
      dependencies: { ignore: "7.0.0" },
    });
    writePackage(path.join(root, "node_modules", "ignore"), { name: "ignore", version: "5.0.0" });
    writePackage(path.join(root, "node_modules", "eslint", "node_modules", "ignore"), {
      name: "ignore",
      version: "7.0.0",
    });
    writePackage(path.join(root, "node_modules", "typescript"), {
      name: "typescript",
      version: "5.9.0",
    });

    // A package linked in from a sibling checkout with its own install and its
    // own development tree.
    writePackage(linked, {
      name: "@scope/linked",
      version: "1.0.0",
      dependencies: { "@scope/linked-dep": "*" },
      devDependencies: { eslint: "*" },
    });
    writePackage(path.join(linked, "node_modules", "@scope", "linked-dep"), {
      name: "@scope/linked-dep",
      version: "3.0.0",
    });
    writePackage(path.join(linked, "node_modules", "eslint"), {
      name: "eslint",
      version: "9.0.0",
    });
    fs.mkdirSync(path.join(root, "node_modules", "@scope"), { recursive: true });
    fs.symlinkSync(linked, path.join(root, "node_modules", "@scope", "linked"));

    const outputDir = path.join(workspace, "asset");
    const result = tsBundle().stage(root, outputDir);

    assert.equal(result.packages, 5, `expected five packages, staged ${result.packages}`);
    for (const destination of [
      "node_modules/hoisted/package.json",
      "node_modules/parent/package.json",
      // `nested` keeps the path it was installed at. Hoisting it to the free
      // `node_modules/nested` slot would take a slot another dependent may
      // resolve through.
      "node_modules/parent/node_modules/nested/package.json",
      "node_modules/@scope/linked/package.json",
      // The linked checkout's own dependency: the handler can only import it if
      // the asset carries it, and it keeps the linked checkout's own layout.
      "node_modules/@scope/linked/node_modules/@scope/linked-dep/package.json",
      "handler.mjs",
      "app.mjs",
      "package.json",
    ]) {
      assert.ok(
        fs.existsSync(path.join(outputDir, destination)),
        `the bundle must contain ${destination}`,
      );
    }
    for (const absent of ["node_modules/eslint", "node_modules/typescript"]) {
      assert.equal(
        fs.existsSync(path.join(outputDir, absent)),
        false,
        `the bundle must not contain the development-only ${absent}`,
      );
    }
    // The hoisted copy wins the name; the linked checkout's dev tree did not
    // claim it, and its own `eslint` is not staged at all.
    assert.equal(
      fs.existsSync(path.join(outputDir, "node_modules", "ignore")),
      false,
      "the bundle must not carry a development dependency's dependency",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(outputDir, "node_modules/hoisted/package.json"), "utf8"))
        .version,
      "1.0.0",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler nests a second copy of a name instead of overwriting it", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-versions-"));
  const root = path.join(workspace, "project");
  try {
    writeSources(root);
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      dependencies: { a: "*", shared: "*" },
    });
    writePackage(path.join(root, "node_modules", "shared"), { name: "shared", version: "2.0.0" });
    writePackage(path.join(root, "node_modules", "a"), {
      name: "a",
      version: "1.0.0",
      dependencies: { shared: "1.0.0" },
    });
    writePackage(path.join(root, "node_modules", "a", "node_modules", "shared"), {
      name: "shared",
      version: "1.0.0",
    });

    const closure = tsBundle().productionClosure(root);
    assert.deepEqual(
      [...closure.keys()].sort(),
      ["node_modules/a", "node_modules/a/node_modules/shared", "node_modules/shared"],
      `staged ${JSON.stringify([...closure.keys()])}`,
    );
    // The project's own version keeps the hoisted name; the nested requirement
    // is staged where `a` resolves it first.
    assert.match(closure.get("node_modules/shared"), /\/node_modules\/shared$/);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(closure.get("node_modules/shared"), "package.json"), "utf8"),
      ).version,
      "2.0.0",
    );
    assert.match(closure.get("node_modules/a/node_modules/shared"), /\/a\/node_modules\/shared$/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// The regression this pins: a nested copy staged into a free hoisted slot used
// to shadow the project's own copy, and the second dependent that shared that
// copy was skipped because its source directory had "already been copied". The
// asset loaded and then threw `TypeError: require(...).v2 is not a function`.
test("the TypeScript bundler keeps the copy every dependent resolves, nested and shared", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-resolution-"));
  const root = path.join(workspace, "project");
  const outputDir = path.join(workspace, "asset");
  try {
    writeMixedResolutionLayout(root);

    const closure = tsBundle().productionClosure(root);
    assert.deepEqual(
      [...closure.keys()].sort(),
      [
        "node_modules/review-addon-a",
        "node_modules/review-addon-a/node_modules/review-shared",
        "node_modules/review-addon-b",
        "node_modules/review-addon-c",
        "node_modules/review-shared",
      ],
      `staged ${JSON.stringify([...closure.keys()])}`,
    );
    // The nested copy stays nested, so the project's copy keeps the root slot
    // both remaining dependents resolve through.
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(closure.get("node_modules/review-addon-a/node_modules/review-shared"), "package.json"),
          "utf8",
        ),
      ).version,
      "1.0.0",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(closure.get("node_modules/review-shared"), "package.json"), "utf8"))
        .version,
      "2.0.0",
    );

    const result = tsBundle().stage(root, outputDir);
    assert.equal(result.packages, 5, `expected five packages, staged ${result.packages}`);

    // Both dependents that share the root copy see it, from their own directory
    // inside the asset, and the nested dependency still sees its own copy.
    const expectations = [
      ["node_modules/review-addon-a", "review-shared", "node_modules/review-addon-a/node_modules/review-shared", "1.0.0"],
      ["node_modules/review-addon-b", "review-shared", "node_modules/review-shared", "2.0.0"],
      ["node_modules/review-addon-c", "review-shared", "node_modules/review-shared", "2.0.0"],
    ];
    for (const [from, name, resolved, version] of expectations) {
      const found = resolveInAsset(outputDir, from, name);
      assert.deepEqual(found, { resolved, version }, `${from} resolved ${JSON.stringify(found)}`);
    }

    // And the whole handler loads and runs from the asset, not from the project.
    const loaded = loadFromAsset(outputDir);
    assert.deepEqual(
      loaded.map((entry) => entry.resolved),
      loaded.map(() => ({ a: 1, b: 2, c: 2 })),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler keeps a three-way conflict apart, one copy per dependent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-three-way-"));
  const root = path.join(workspace, "project");
  const outputDir = path.join(workspace, "asset");
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "handler.mjs"),
      [
        'import a from "addon-a";',
        'import b from "addon-b";',
        'import c from "addon-c";',
        "",
        "export const handler = () => ({ a: a(), b: b(), c: c() });",
        "",
      ].join("\n"),
    );
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      type: "module",
      dependencies: { "addon-a": "1.0.0", "addon-b": "1.0.0", "addon-c": "1.0.0", shared: "3.0.0" },
    });
    const a = installPackage(root, "addon-a", "1.0.0", {
      dependencies: { shared: "1.0.0" },
      code: 'module.exports = () => require("shared").version()',
    });
    const b = installPackage(root, "addon-b", "1.0.0", {
      dependencies: { shared: "2.0.0" },
      code: 'module.exports = () => require("shared").version()',
    });
    installPackage(root, "addon-c", "1.0.0", {
      dependencies: { shared: "3.0.0" },
      code: 'module.exports = () => require("shared").version()',
    });
    installPackage(a, "shared", "1.0.0", { code: "module.exports.version = () => 1" });
    installPackage(b, "shared", "2.0.0", { code: "module.exports.version = () => 2" });
    installPackage(root, "shared", "3.0.0", { code: "module.exports.version = () => 3" });

    const closure = tsBundle().productionClosure(root);
    assert.deepEqual(
      [...closure.keys()].sort(),
      [
        "node_modules/addon-a",
        "node_modules/addon-a/node_modules/shared",
        "node_modules/addon-b",
        "node_modules/addon-b/node_modules/shared",
        "node_modules/addon-c",
        "node_modules/shared",
      ],
      `staged ${JSON.stringify([...closure.keys()])}`,
    );

    tsBundle().stage(root, outputDir);
    for (const [from, version] of [
      ["node_modules/addon-a", "1.0.0"],
      ["node_modules/addon-b", "2.0.0"],
      ["node_modules/addon-c", "3.0.0"],
    ]) {
      assert.equal(resolveInAsset(outputDir, from, "shared").version, version, `${from} resolved ${version}`);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler stages a hoist above the project root at the asset root", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-hoist-"));
  // A workspace whose packages are hoisted above the project: Node resolves
  // `gateway` and `requests` from `<workspace>/node_modules`, not from inside
  // the project at all.
  const root = path.join(workspace, "packages", "project");
  const outputDir = path.join(workspace, "asset");
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "handler.mjs"),
      'import gateway from "gateway";\nexport const handler = () => gateway;\n',
    );
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      type: "module",
      dependencies: { gateway: "1.0.0" },
    });
    installPackage(workspace, "gateway", "1.0.0", {
      dependencies: { requests: "4.0.0" },
      code: 'module.exports = require("requests").version()',
    });
    installPackage(workspace, "requests", "4.0.0", { code: "module.exports.version = () => 4" });

    const closure = tsBundle().productionClosure(root);
    assert.deepEqual(
      [...closure.keys()].sort(),
      ["node_modules/gateway", "node_modules/requests"],
      `staged ${JSON.stringify([...closure.keys()])}`,
    );

    tsBundle().stage(root, outputDir);
    assert.equal(resolveInAsset(outputDir, "node_modules/gateway", "requests").version, "4.0.0");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler stages an npm alias under the name it is imported by", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-alias-"));
  const root = path.join(workspace, "project");
  const outputDir = path.join(workspace, "asset");
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "handler.mjs"),
      'import alias from "shared-alias";\nexport const handler = () => alias;\n',
    );
    // `npm install shared-alias@npm:shared@1.0.0` installs the package under the
    // alias directory while its manifest keeps the real name.
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      type: "module",
      dependencies: { "shared-alias": "npm:shared@1.0.0" },
    });
    const aliased = path.join(root, "node_modules", "shared-alias");
    writePackage(aliased, { name: "shared", version: "1.0.0", main: "index.cjs" });
    fs.writeFileSync(path.join(aliased, "index.cjs"), "module.exports = 1;\n");

    const closure = tsBundle().productionClosure(root);
    assert.deepEqual([...closure.keys()].sort(), ["node_modules/shared-alias"]);
    tsBundle().stage(root, outputDir);
    assert.equal(resolveInAsset(outputDir, "", "shared-alias").version, "1.0.0");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler nests a linked checkout's copy where the project's copy owns the name", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-link-conflict-"));
  // A linked checkout and the project resolve two different copies of one name:
  // the project's own install inside the project, the linked checkout's from the
  // workspace hoist above it. The asset cannot put both at `node_modules/shared`,
  // so the linked checkout's copy goes where only it looks first.
  const root = path.join(workspace, "packages", "project");
  const linked = path.join(workspace, "linked");
  const outputDir = path.join(workspace, "asset");
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "handler.mjs"),
      'import local from "@scope/local";\nexport const handler = () => local;\n',
    );
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      type: "module",
      dependencies: { "@scope/local": "file:../../linked", shared: "2.0.0" },
    });
    installPackage(root, "shared", "2.0.0", { code: "module.exports = 2" });
    writePackage(linked, {
      name: "@scope/local",
      version: "1.0.0",
      main: "index.cjs",
      dependencies: { shared: "1.0.0" },
    });
    fs.writeFileSync(path.join(linked, "index.cjs"), 'module.exports = require("shared");\n');
    installPackage(workspace, "shared", "1.0.0", { code: "module.exports = 1" });
    fs.mkdirSync(path.join(root, "node_modules", "@scope"), { recursive: true });
    fs.symlinkSync(linked, path.join(root, "node_modules", "@scope", "local"));

    const closure = tsBundle().productionClosure(root);
    assert.deepEqual(
      [...closure.keys()].sort(),
      [
        "node_modules/@scope/local",
        "node_modules/@scope/local/node_modules/shared",
        "node_modules/shared",
      ],
      `staged ${JSON.stringify([...closure.keys()])}`,
    );

    tsBundle().stage(root, outputDir);
    assert.equal(resolveInAsset(outputDir, "", "shared").version, "2.0.0");
    assert.equal(resolveInAsset(outputDir, "node_modules/@scope/local", "shared").version, "1.0.0");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// The two shapes npm leaves when a declared dependency lives *inside* the
// project, recorded from real `npm install` runs (npm 11.19.0): a workspace
// package and a `file:` dependency are symlinked into `node_modules/<name>`
// rather than copied, and every dependent imports them by that name. Staging the
// directory the link points at instead — `pkgs/<name>` — is what made the
// fail-closed re-resolution check refuse to synth these projects at all.
function writeInProjectLinkLayout(root, { workspace }) {
  const target = path.join(root, "pkgs", "inproj-target");
  writePackage(target, { name: "inproj-target", version: "1.0.0", type: "module", main: "index.cjs" });
  fs.writeFileSync(path.join(target, "index.cjs"), "module.exports = { self: 'inproj-target@1.0.0' };\n");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });

  if (workspace) {
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      private: true,
      type: "module",
      workspaces: ["pkgs/*"],
      dependencies: { "inproj-target": "*", leafdep: "*" },
    });
    fs.writeFileSync(
      path.join(root, "src", "handler.mjs"),
      [
        'import target from "inproj-target";',
        'import leaf from "leafdep";',
        "",
        "export const handler = () => ({ t: target.self, l: leaf });",
        "",
      ].join("\n"),
    );
    const leaf = path.join(root, "pkgs", "leafdep");
    writePackage(leaf, { name: "leafdep", version: "2.0.0", type: "module", main: "index.cjs" });
    fs.writeFileSync(path.join(leaf, "index.cjs"), "module.exports = { self: 'leafdep@2.0.0' };\n");
    fs.symlinkSync("../pkgs/inproj-target", path.join(root, "node_modules", "inproj-target"));
    fs.symlinkSync("../pkgs/leafdep", path.join(root, "node_modules", "leafdep"));
    return { names: ["inproj-target", "leafdep"], expected: { t: "inproj-target@1.0.0", l: { self: "leafdep@2.0.0" } } };
  }

  writePackage(root, {
    name: "project",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { mylocal: "file:./pkgs/inproj-target" },
  });
  fs.writeFileSync(
    path.join(root, "src", "handler.mjs"),
    [
      'import target from "mylocal";',
      "",
      "export const handler = () => ({ t: target.self });",
      "",
    ].join("\n"),
  );
  fs.symlinkSync("../pkgs/inproj-target", path.join(root, "node_modules", "mylocal"));
  return { names: ["mylocal"], expected: { t: "inproj-target@1.0.0" } };
}

// Synth one project through the construct with the scaffold's own bundling
// props and return the asset directory the CDK emitted for it: the artifact a
// deployment uploads, produced by the same local bundling path the app uses.
function synthNodeAsset(projectRoot, workspace, id) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const runtimeName = `NODEJS_${nodeMajor}_X`;
  const runtime = lambda.Runtime[runtimeName];
  assert.ok(runtime, `aws-cdk-lib has no ${runtimeName} for Node ${process.versions.node}`);
  const outdir = path.join(workspace, `cdk.out-${id}`);
  const app = new cdk.App({ outdir });
  const stack = new cdk.Stack(app, "LinkedLayoutStack");
  new apptheory.AppTheoryFunction(stack, "Handler", {
    runtime,
    handler: "handler.handler",
    code: lambda.Code.fromAsset(projectRoot, {
      bundling: tsBundle().assetBundling(runtime, projectRoot),
    }),
  });
  app.synth();
  const assets = fs
    .readdirSync(outdir)
    .filter((entry) => entry.startsWith("asset."))
    .map((entry) => path.join(outdir, entry))
    .filter((dir) => fs.existsSync(path.join(dir, "handler.mjs")));
  assert.equal(
    assets.length,
    1,
    `the synth emitted ${assets.length} handler assets: ${JSON.stringify(fs.readdirSync(outdir))}`,
  );
  return assets[0];
}

// Both link families the reviewers reproduced with real `npm install`: the asset
// must carry each package under the name its dependents import, and the handler
// must load and run from the emitted asset — not from the project.
for (const layout of [
  { id: "workspace-links", label: "an npm workspace package", workspace: true },
  { id: "inproject-file-links", label: "an in-project file: dependency", workspace: false },
]) {
  test(`the CDK emits ${layout.label} at the name it is imported by, and the asset loads`, () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `apptheory-bundle-${layout.id}-`));
    const root = path.join(workspace, "project");
    try {
      const built = writeInProjectLinkLayout(root, { workspace: layout.workspace });

      // The link name is the slot; the directory behind it is only the source.
      const closure = tsBundle().productionClosure(root);
      assert.deepEqual(
        [...closure.keys()].sort(),
        built.names.map((name) => `node_modules/${name}`).sort(),
        `staged ${JSON.stringify([...closure.keys()])}`,
      );
      assert.equal(
        closure.get(`node_modules/${built.names[0]}`),
        fs.realpathSync(path.join(root, "pkgs", "inproj-target")),
        "the link's target is what the asset is built from",
      );

      const asset = synthNodeAsset(root, workspace, layout.id);
      assert.deepEqual(
        fs.readdirSync(asset).sort(),
        ["handler.mjs", "node_modules", "package.json"],
        `the emitted asset carries ${JSON.stringify(fs.readdirSync(asset))}`,
      );
      assert.equal(
        fs.existsSync(path.join(asset, "pkgs")),
        false,
        "the directory the link points at must not be staged",
      );
      for (const name of built.names) {
        const staged = path.join(asset, "node_modules", name);
        assert.equal(
          fs.lstatSync(staged).isSymbolicLink(),
          false,
          `${name} must be a real directory inside the asset`,
        );
        // Node's own resolution, asked from the asset root, finds the same copy.
        assert.deepEqual(resolveInAsset(asset, "", name).resolved, `node_modules/${name}`);
      }

      const invoked = invokeFromAsset(asset, built.expected);
      assert.deepEqual(
        invoked.map((entry) => entry.resolved),
        invoked.map(() => built.expected),
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Round 4: the layouts the round-3 reviewers reproduced with real `npm install`.
//
// Round 3 projected a dependency's slot by counting directory hops from the
// *source* walk and replaying that count along the *staged* path. A scoped link
// slot is one segment deeper than the directory behind it
// (`node_modules/@scope/pkg` is three segments; `pkgs/pkg` is two), and Node
// never looks in `node_modules/node_modules`, so the copy landed on a slot Node
// does not search. The shipped check re-implemented the same walk, agreed with
// itself, and accepted the asset: the handler then failed with MODULE_NOT_FOUND,
// or — worse, on the unscoped variant — silently resolved a different version
// than the project.
//
// Every one of these layouts is the shape `npm install` leaves: a workspace
// package or a `file:` dependency is a symlink named after what dependents
// import, and the transitive dependencies npm hoists are plain installs at the
// project root. Placement now follows the staged path's own depth, a copy the
// project reaches through a directory the asset cannot reproduce is staged where
// its dependent looks first, and acceptance is Node's own resolver on the staged
// tree.

// A package written where npm puts it when it is not an install: the directory
// behind a workspace or `file:` link.
function writeModule(dir, manifest, code) {
  writePackage(dir, { main: "index.cjs", ...manifest });
  fs.writeFileSync(path.join(dir, "index.cjs"), `${code}\n`);
}

// The slot npm links a workspace package or a `file:` dependency into: a symlink
// named by the dependents that import it, not the directory behind it.
function linkSlot(root, slot, target) {
  const link = path.join(root, "node_modules", slot);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), target), link);
}

function writeHandler(root, lines) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "handler.mjs"), `${lines.join("\n")}\n`);
}

// Load and invoke one handler under every interpreter the run proves, from the
// directory its imports resolve from, and return what it produced.
function invokeHandlerEverywhere(handlerFile, cwd) {
  const script = `
    const { handler } = await import(${JSON.stringify(pathToFileURL(handlerFile).href)});
    process.stdout.write(JSON.stringify(handler()));
  `;
  const results = [];
  for (const interpreter of assetInterpreters()) {
    const run = spawnSync(interpreter, ["--input-type=module", "-e", script], { cwd, encoding: "utf8" });
    assert.equal(
      run.status,
      0,
      `${path.basename(handlerFile)} did not run from ${cwd} under ${interpreter}:\n${run.stderr}`,
    );
    results.push({ interpreter, resolved: JSON.parse(run.stdout) });
  }
  return results;
}

// CX1: a scoped workspace package and the transitive dependency npm hoists to
// the project root — the shape that produced `Cannot find module 'leftpad'`.
function buildScopedWorkspaceLayout(root) {
  writePackage(root, {
    name: "workspace-root",
    private: true,
    version: "0.0.0",
    type: "module",
    workspaces: ["pkgs/*"],
    dependencies: { "@corp/util": "*" },
  });
  writeModule(
    path.join(root, "pkgs", "util"),
    { name: "@corp/util", version: "1.0.0", dependencies: { leftpad: "1.0.0" } },
    'module.exports.self = "@corp/util@1.0.0";\nmodule.exports.leftpad = require("leftpad").self;',
  );
  installPackage(root, "leftpad", "1.0.0", { code: 'module.exports = { self: "leftpad@1.0.0" }' });
  linkSlot(root, "@corp/util", path.join(root, "pkgs", "util"));
  writeHandler(root, [
    'import util from "@corp/util";',
    "",
    "export const handler = () => ({ util: util.self, leftpad: util.leftpad });",
  ]);
}

// CX2: one scoped workspace package depending on another, which the project root
// does not declare — the shape that staged only a phantom `@corp/w2`.
function buildScopedCrossDependencyLayout(root) {
  writePackage(root, {
    name: "workspace-root",
    private: true,
    version: "0.0.0",
    type: "module",
    workspaces: ["pkgs/*"],
    dependencies: { "@corp/w1": "*" },
  });
  writeModule(
    path.join(root, "pkgs", "w1"),
    { name: "@corp/w1", version: "1.0.0", dependencies: { "@corp/w2": "*" } },
    'module.exports.self = "@corp/w1@1.0.0";\nmodule.exports.w2 = require("@corp/w2").self;',
  );
  writeModule(path.join(root, "pkgs", "w2"), { name: "@corp/w2", version: "2.0.0" }, 'module.exports.self = "@corp/w2@2.0.0";');
  linkSlot(root, "@corp/w1", path.join(root, "pkgs", "w1"));
  linkSlot(root, "@corp/w2", path.join(root, "pkgs", "w2"));
  writeHandler(root, [
    'import w1 from "@corp/w1";',
    "",
    'export const handler = () => ({ w1: w1.self, w2: w1["@corp/w2"] });',
  ]);
}

// CX3: an in-project `file:` link two directories deep whose intermediate
// `vendor/node_modules` carries the first match.
function buildVendoredIntermediateLayout(root) {
  writePackage(root, {
    name: "project",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies: { "vendor-thing": "file:./vendor/thing" },
  });
  writeModule(
    path.join(root, "vendor", "thing"),
    { name: "vendor-thing", version: "1.0.0", dependencies: { leftpad: "*" } },
    'module.exports.self = "vendor-thing@1.0.0";\nmodule.exports.leftpad = require("leftpad").self;',
  );
  writeModule(
    path.join(root, "vendor", "node_modules", "leftpad"),
    { name: "leftpad", version: "9.9.9-vendor" },
    'module.exports.self = "leftpad@9.9.9-vendor";',
  );
  linkSlot(root, "vendor-thing", path.join(root, "vendor", "thing"));
  writeHandler(root, [
    'import thing from "vendor-thing";',
    "",
    "export const handler = () => ({ thing: thing.self, leftpad: thing.leftpad });",
  ]);
}

// CX4: an unscoped link two directories deep whose intermediate first-match copy
// is a different version from the copy the project root holds — the shape that
// emitted an asset silently running `shared@1.0.0-root` instead of the project's
// `shared@2.0.0-deep`.
function buildIntermediateFirstMatchLayout(root) {
  writePackage(root, {
    name: "project",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies: { lk: "file:./pkgs/deep/l", shared: "1.0.0" },
  });
  writeModule(
    path.join(root, "pkgs", "deep", "l"),
    { name: "lk", version: "1.0.0", dependencies: { shared: "*" } },
    'module.exports.self = "lk@1.0.0";\nmodule.exports.shared = require("shared").self;',
  );
  writeModule(
    path.join(root, "pkgs", "deep", "node_modules", "shared"),
    { name: "shared", version: "2.0.0-deep" },
    'module.exports.self = "shared@2.0.0-deep";',
  );
  installPackage(root, "shared", "1.0.0", { code: 'module.exports = { self: "shared@1.0.0-root" }' });
  linkSlot(root, "lk", path.join(root, "pkgs", "deep", "l"));
  writeHandler(root, ['import lk from "lk";', 'import shared from "shared";', "", "export const handler = () => ({ lk: lk.shared, root: shared.self });"]);
}

// Sanity's first layout: a scoped workspace package whose declared workspace
// dependency npm links at the project root.
function buildReviewScopedChainLayout(root) {
  writePackage(root, {
    name: "workspace-root",
    private: true,
    version: "0.0.0",
    type: "module",
    workspaces: ["pkgs/*"],
    dependencies: { "@review/entry": "1.0.0" },
  });
  writeModule(
    path.join(root, "pkgs", "entry"),
    { name: "@review/entry", version: "1.0.0", dependencies: { "review-leaf": "1.0.0" } },
    'module.exports.self = "@review/entry@1.0.0";\nmodule.exports.leaf = require("review-leaf").self;',
  );
  writeModule(path.join(root, "pkgs", "leaf"), { name: "review-leaf", version: "1.0.0" }, 'module.exports.self = "leaf-ok";');
  linkSlot(root, "@review/entry", path.join(root, "pkgs", "entry"));
  linkSlot(root, "review-leaf", path.join(root, "pkgs", "leaf"));
  writeHandler(root, [
    'import entry from "@review/entry";',
    "",
    'export const handler = () => ({ entry: entry.self, leaf: entry["review-leaf"] });',
  ]);
}

// Sanity's second layout: two in-project `file:` aliases of one package, whose
// own declared `file:` child npm hoists to the project root.
function buildDualFileHoistedChildLayout(root) {
  writePackage(root, {
    name: "project",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies: { "lib-one": "file:./shared-lib", "lib-two": "file:./shared-lib" },
  });
  writeModule(
    path.join(root, "shared-lib"),
    { name: "shared-lib", version: "1.0.0", dependencies: { "deep-thing": "file:./deep-thing" } },
    'module.exports.self = "shared-lib@1.0.0";\nmodule.exports.deep = require("deep-thing").self;',
  );
  writeModule(
    path.join(root, "shared-lib", "deep-thing"),
    { name: "deep-thing", version: "1.0.0" },
    'module.exports.self = "deep-thing@1.0.0";',
  );
  linkSlot(root, "lib-one", path.join(root, "shared-lib"));
  linkSlot(root, "lib-two", path.join(root, "shared-lib"));
  linkSlot(root, "deep-thing", path.join(root, "shared-lib", "deep-thing"));
  writeHandler(root, [
    'import one from "lib-one";',
    'import two from "lib-two";',
    "",
    'export const handler = () => ({ one: one.self, two: two.self, deep: one["deep-thing"] });',
  ]);
}

for (const layout of [
  {
    id: "adv-scoped-workspace-hoisted-dep",
    label: "a scoped workspace package's hoisted dependency",
    absent: ["pkgs"],
    build: buildScopedWorkspaceLayout,
  },
  {
    id: "adv-scoped-workspace-cross-dependency",
    label: "one scoped workspace package depending on another",
    absent: ["pkgs"],
    build: buildScopedCrossDependencyLayout,
  },
  {
    id: "adv-inproject-link-vendored-intermediate",
    label: "an in-project link two directories deep with a vendored intermediate copy",
    absent: ["vendor"],
    build: buildVendoredIntermediateLayout,
  },
  {
    id: "adv-intermediate-first-match-version",
    label: "an intermediate first-match copy of a different version",
    absent: ["pkgs"],
    build: buildIntermediateFirstMatchLayout,
  },
  {
    id: "sanity-scoped-workspace-chain",
    label: "a scoped workspace package's workspace dependency",
    absent: ["pkgs"],
    build: buildReviewScopedChainLayout,
  },
  {
    id: "sanity-dual-file-links-hoisted-child",
    label: "two in-project file: aliases and their hoisted file: child",
    absent: ["shared-lib"],
    build: buildDualFileHoistedChildLayout,
  },
]) {
  test(`the CDK emits ${layout.label} and it loads the copies the project loads`, () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `apptheory-bundle-${layout.id}-`));
    const root = path.join(workspace, "project");
    try {
      layout.build(root);
      // What the project itself resolves, before any bundling.
      const project = invokeHandlerEverywhere(path.join(root, "src", "handler.mjs"), root);

      const asset = synthNodeAsset(root, workspace, layout.id);

      // The asset itself must load and run, under every interpreter the run
      // proves, and give exactly what the project gave.
      const asserted = invokeHandlerEverywhere(path.join(asset, "handler.mjs"), asset);
      assert.deepEqual(
        asserted.map((entry) => entry.resolved),
        project.map((entry) => entry.resolved),
        `the asset resolved ${JSON.stringify(asserted.map((entry) => entry.resolved))} ` +
          `where the project resolved ${JSON.stringify(project.map((entry) => entry.resolved))}`,
      );

      // Only the slots Node reaches the packages through are staged: never the
      // real directory behind a link, and never a `node_modules` below one.
      for (const absent of [...layout.absent, path.join("node_modules", "node_modules")]) {
        assert.equal(
          fs.existsSync(path.join(asset, absent)),
          false,
          `the emitted asset must not carry ${absent}: it staged ${JSON.stringify(
            fs.readdirSync(path.join(asset, "node_modules")),
          )} under node_modules`,
        );
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
}

// Part 1 of the round-4 change: acceptance is Node's resolver on the staged
// tree. Round 3's phantom slot, injected into the real bundling path, must
// refuse the synth and name the edge rather than emit an asset that cannot load.
test("the CDK refuses a wrong placement instead of emitting an asset that cannot load", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-wrong-placement-"));
  const root = path.join(workspace, "project");
  const copySync = fs.cpSync;
  try {
    buildScopedWorkspaceLayout(root);
    const staged = path.join("node_modules", "leftpad");
    const phantom = path.join("node_modules", "node_modules", "leftpad");
    fs.cpSync = (source, destination, options) =>
      copySync(
        source,
        typeof destination === "string" && destination.endsWith(staged)
          ? `${destination.slice(0, -staged.length)}${phantom}`
          : destination,
        options,
      );
    assert.throws(
      () => synthNodeAsset(root, workspace, "wrong-placement"),
      {
        message:
          /the staged asset does not resolve like the project: node_modules\/@corp\/util imports leftpad, which resolves to .*node_modules\/leftpad in the project but to nothing from the asset/,
      },
      "a copy one directory away from where Node looks must refuse the synth",
    );
  } finally {
    fs.cpSync = copySync;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler decides acceptance with Node's own resolver, not a staged copy of its walk", () => {
  // The round-3 asset was accepted by a re-implementation of Node's walk that
  // agreed with itself about a phantom `node_modules/node_modules/<dep>` slot.
  // Acceptance is now asked of Node, against the directories that were actually
  // staged: this builds the round-3 phantom by hand, and the same tree with the
  // copy where Node looks, and pins which one the check accepts.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-oracle-"));
  const root = path.join(workspace, "project");
  const outputDir = path.join(workspace, "asset");
  try {
    buildScopedWorkspaceLayout(root);
    const util = path.join(root, "pkgs", "util");
    const leftpad = path.join(root, "node_modules", "leftpad");

    // What the bundler stages, and what a hand-rolled walk would accept instead.
    const accepted = [
      ["node_modules/@corp/util", util],
      ["node_modules/leftpad", leftpad],
    ];
    const phantom = [
      ["node_modules/@corp/util", util],
      ["node_modules/node_modules/leftpad", leftpad],
    ];

    const stageByHand = (entries) => {
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.mkdirSync(outputDir, { recursive: true });
      fs.cpSync(path.join(root, "src"), outputDir, { recursive: true, dereference: true, force: true });
      fs.copyFileSync(path.join(root, "package.json"), path.join(outputDir, "package.json"));
      for (const [destination, source] of entries) {
        fs.cpSync(source, path.join(outputDir, destination), {
          recursive: true,
          dereference: true,
          force: true,
          filter: (candidate) => path.basename(candidate) !== "node_modules",
        });
      }
      return new Map(entries);
    };

    const verification = tsBundle().verifyStaged(root, outputDir, stageByHand(accepted));
    assert.ok(verification.verified >= 2, `verified ${verification.verified} edges`);

    // Same packages, same bytes, one slot over: Node finds nothing, so the check
    // refuses and names the edge instead of emitting a broken asset.
    const phantomClosure = stageByHand(phantom);
    assert.throws(
      () => tsBundle().verifyStaged(root, outputDir, phantomClosure),
      {
        message:
          /the staged asset does not resolve like the project: node_modules\/@corp\/util imports leftpad, which resolves to .*node_modules\/leftpad in the project but to nothing from the asset/,
      },
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler carries peers the handler imports and skips optional ones", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-peers-"));
  const root = path.join(workspace, "project");
  try {
    writeSources(root);
    writePackage(root, { name: "project", version: "0.0.0", dependencies: { "@scope/data": "*" } });
    // A data layer that imports its AWS SDK clients as peers, exactly like
    // `@theory-cloud/tabletheory-ts` does: npm installs them at the project, and
    // the handler cannot load without them.
    writePackage(path.join(root, "node_modules", "@scope", "data"), {
      name: "@scope/data",
      version: "1.0.0",
      peerDependencies: { "@aws-sdk/client-dynamodb": "^3", "@aws-sdk/client-kms": "^3" },
      peerDependenciesMeta: { "@aws-sdk/client-kms": { optional: true } },
      optionalDependencies: { "native-bindings": "^1" },
    });
    writePackage(path.join(root, "node_modules", "@aws-sdk", "client-dynamodb"), {
      name: "@aws-sdk/client-dynamodb",
      version: "3.0.0",
    });

    // An installed peer is staged; an optional peer and an optional dependency
    // that are not installed are skipped rather than refused.
    const closure = tsBundle().productionClosure(root);
    assert.deepEqual(
      [...closure.keys()].sort(),
      ["node_modules/@aws-sdk/client-dynamodb", "node_modules/@scope/data"],
      `staged ${JSON.stringify([...closure.keys()])}`,
    );

    // A required peer that is missing is refused by name.
    fs.rmSync(path.join(root, "node_modules", "@aws-sdk", "client-dynamodb"), {
      recursive: true,
      force: true,
    });
    assert.throws(
      () => tsBundle().productionClosure(root),
      /declares @aws-sdk\/client-dynamodb but it is not installed/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler refuses a declared dependency that is not installed", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-missing-"));
  const root = path.join(workspace, "project");
  try {
    writeSources(root);
    writePackage(root, {
      name: "project",
      version: "0.0.0",
      dependencies: { "@theory-cloud/apptheory": "*" },
    });
    assert.throws(
      () => tsBundle().productionClosure(root),
      /declares @theory-cloud\/apptheory but it is not installed/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the TypeScript bundler refuses a project it cannot read", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-nomanifest-"));
  try {
    assert.throws(
      () => tsBundle().stage(workspace, path.join(workspace, "asset")),
      /has no readable package\.json/,
    );
    writePackage(workspace, { name: "project", version: "0.0.0" });
    assert.throws(
      () => tsBundle().stage(workspace, path.join(workspace, "asset")),
      /has no src\/ directory to bundle/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// The template must pass the runtime's own bundling image and register both
// bundling paths, or the asset is built for a neighbouring runtime.
for (const template of [
  {
    name: "ts",
    file: path.join("templates", "apptheory-init", "ts", "cdk", "app.cjs.tmpl"),
    runtime: "NODEJS_24_X",
    line: "nodejs24.x",
  },
  {
    name: "py",
    file: path.join("templates", "apptheory-init", "py", "cdk", "app.cjs.tmpl"),
    runtime: "PYTHON_3_14",
    line: "python3.14",
  },
]) {
  test(`the ${template.name} scaffold bundles through the construct with its own runtime image`, () => {
    const captured = [];
    const runtime = {
      name: template.line,
      bundlingImage: { image: `bundling-image-for-${template.line}` },
    };
    const lambda = {
      Runtime: { [template.runtime]: runtime },
      Code: {
        fromAsset: (_assetPath, props) => {
          captured.push(props);
          return { isAsset: true };
        },
      },
    };
    const cdk = {
      App: class App {},
      Stack: class Stack {},
      CfnOutput: class CfnOutput {},
    };
    const apptheoryCdk = {
      AppTheoryFunction: class AppTheoryFunction {
        constructor() {
          this.fn = {};
        }
      },
      AppTheoryHttpApi: class AppTheoryHttpApi {
        constructor() {
          this.api = { apiEndpoint: "https://example.execute-api.us-east-1.amazonaws.com" };
        }
      },
    };

    const source = fs.readFileSync(path.join(REPO_ROOT, template.file), "utf8");
    const moduleObj = { exports: {} };
    vm.runInNewContext(
      source,
      {
        require: (id) => {
          if (id === "aws-cdk-lib") return cdk;
          if (id === "aws-cdk-lib/aws-lambda") return lambda;
          if (id === "@theory-cloud/apptheory-cdk") return apptheoryCdk;
          if (id.startsWith("./")) {
            return require(path.join(REPO_ROOT, path.dirname(template.file), id));
          }
          return require(id);
        },
        module: moduleObj,
        exports: moduleObj.exports,
        __dirname: path.join(REPO_ROOT, path.dirname(template.file)),
        __filename: path.join(REPO_ROOT, template.file),
        process,
        console,
        Buffer,
        setTimeout,
        clearTimeout,
      },
      { filename: path.join(REPO_ROOT, template.file) },
    );

    assert.equal(captured.length, 1, "the template must build its handler from an asset");
    const bundling = captured[0].bundling;
    assert.equal(
      bundling.image.image,
      `bundling-image-for-${template.line}`,
      "the asset must be bundled by the runtime's own image",
    );
    assert.equal(
      typeof bundling.local.tryBundle,
      "function",
      "the local bundling path must be registered",
    );
    assert.deepEqual(
      [bundling.command[0], bundling.command[1]],
      ["bash", "-c"],
      "the image path must run one shell command",
    );
  });
}

test("the Python bundler stages the requirements and the handler sources", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-py-"));
  const projectRoot = path.join(workspace, "project");
  const outputDir = path.join(workspace, "asset");
  const previous = process.env.APPTHEORY_PYTHON;
  try {
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "requirements.txt"), "apptheory==0.0.0\n");
    fs.writeFileSync(path.join(projectRoot, "app.py"), "def build_app():\n    return None\n");
    fs.writeFileSync(path.join(projectRoot, "handler.py"), "from app import build_app\n");
    const stubDir = path.join(workspace, "stubs");
    fs.mkdirSync(stubDir, { recursive: true });
    const log = path.join(stubDir, "argv.log");
    // A stand-in interpreter that records its argv and stages nothing, standing
    // in for `pip install --target`.
    fs.writeFileSync(
      path.join(stubDir, "python3"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`,
    );
    fs.chmodSync(path.join(stubDir, "python3"), 0o755);
    process.env.APPTHEORY_PYTHON = path.join(stubDir, "python3");

    require(path.join(REPO_ROOT, PY_BUNDLE)).stage(projectRoot, outputDir);

    assert.deepEqual(
      fs.readFileSync(log, "utf8").split("\n").slice(0, -1),
      ["-m", "pip", "install", "-r", path.join(projectRoot, "requirements.txt"), "-t", outputDir],
      "the requirements must be installed into the asset root by one argv",
    );
    for (const name of ["app.py", "handler.py"]) {
      assert.ok(fs.existsSync(path.join(outputDir, name)), `the bundle must contain ${name}`);
    }
  } finally {
    if (previous === undefined) delete process.env.APPTHEORY_PYTHON;
    else process.env.APPTHEORY_PYTHON = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the Python bundler refuses a project with nothing to install", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-bundle-py-bad-"));
  try {
    assert.throws(
      () => require(path.join(REPO_ROOT, PY_BUNDLE)).stage(workspace, path.join(workspace, "asset")),
      /has no requirements\.txt to bundle/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
