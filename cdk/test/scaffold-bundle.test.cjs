const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

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

// Load the staged asset's handler from inside the asset directory and return
// what it resolved, under every interpreter the run proves.
function loadFromAsset(outputDir, handlerFile = "handler.mjs") {
  const script = `
    import assert from "node:assert/strict";
    const { handler } = await import(${JSON.stringify(pathToFileURL(path.join(outputDir, handlerFile)).href)});
    const result = handler();
    assert.deepEqual(result, { a: 1, b: 2, c: 2 }, "the asset resolved " + JSON.stringify(result));
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

test("the staged-resolution walk follows Node's own walk from a directory", () => {
  // The bundler only reuses a staged copy when this walk finds exactly that
  // copy, so the walk itself is pinned: the directory's own `node_modules`, then
  // each parent's — including the `node_modules/node_modules` step Node really
  // checks — up to the asset root.
  const { resolveStaged } = tsBundle();
  const closure = new Map([
    ["node_modules/shared", "/project/node_modules/shared"],
    ["node_modules/a/node_modules/shared", "/project/node_modules/a/node_modules/shared"],
  ]);
  assert.equal(resolveStaged("node_modules/a", "shared", closure), "node_modules/a/node_modules/shared");
  assert.equal(resolveStaged("node_modules/b", "shared", closure), "node_modules/shared");
  assert.equal(resolveStaged("", "shared", closure), "node_modules/shared");
  // A package that requires its own name resolves to itself, exactly as Node
  // does from a directory that sits under its own `node_modules`.
  assert.equal(
    resolveStaged("node_modules/a/node_modules/shared", "shared", closure),
    "node_modules/a/node_modules/shared",
  );
  assert.equal(resolveStaged("node_modules/a", "absent", closure), null);
  assert.equal(resolveStaged("vendor/tool", "shared", closure), "node_modules/shared");
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
