import test from "node:test";
import assert from "node:assert/strict";

import {
  HOSTED_NAMESPACE_MAX,
  compileVisibilityPolicy,
  keeperDecision,
  logGroupName,
  namingScope,
  namespacedContext,
  physicalResourceName,
  sourceVisible,
  synthCheck,
  validateHostedNamespace,
  validateNamingContext,
  visibilityManifest,
  visibilityPreview,
} from "../dist/index.js";

function labContext(overrides = {}) {
  return {
    namespace: "theorycloud",
    app: "autheory",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
    ...overrides,
  };
}

test("naming context validates its bound grammar", () => {
  validateNamingContext(labContext());
  for (const context of [
    labContext({ app: "Autheory" }),
    labContext({ stage: "Lab" }),
    labContext({ account: "99811585" }),
    labContext({ region: "useast1" }),
  ]) {
    assert.throws(() => validateNamingContext(context));
  }
});

test("s3 bucket uses the account-regional namespace", () => {
  const composed = physicalResourceName(labContext(), "s3_bucket", "audit-events");
  assert.equal(composed.bucket_namespace, "account-regional");
  assert.equal(composed.bucket_name_prefix, "autheory-lab-audit-events");
  assert.equal(composed.name, "autheory-lab-audit-events-998115851393-us-east-1-an");
});

test("over-budget dash names are shortened deterministically", () => {
  const composed = physicalResourceName(
    labContext({ app: "theory-mcp-server", account: "191637461429" }),
    "lambda_function",
    "namespace-vending/request-claim-handler-version-two",
  );
  assert.equal(composed.name, "theory-mcp-server-lab-namespace-vending-request-claim-h-5mcmmerw");
  assert.ok(composed.name.length <= 64);
});

test("legacy profile requires a pin and uses it verbatim", () => {
  const context = labContext({ stage: "live", naming_profile: "legacy" });
  assert.throws(() => physicalResourceName(context, "dynamodb_table", "events"));
  const composed = physicalResourceName(context, "dynamodb_table", "events", {
    "dynamodb_table:events": "autheory-autheory-live-events",
  });
  assert.deepEqual(composed, { name: "autheory-autheory-live-events", pinned: true });
});

test("generated entries are legacy-only and keep CloudFormation's name", () => {
  const legacy = labContext({ stage: "live", naming_profile: "legacy" });
  assert.deepEqual(
    physicalResourceName(legacy, "s3_bucket", "audit-events", {}, ["s3_bucket:audit-events"]),
    { generated: true },
  );
  assert.throws(
    () => physicalResourceName(labContext(), "s3_bucket", "audit-events", {}, ["s3_bucket:audit-events"]),
    /legacy naming profile/,
  );
  assert.throws(
    () =>
      physicalResourceName(
        legacy,
        "dynamodb_table",
        "events",
        { "dynamodb_table:events": "autheory-autheory-live-events" },
        ["dynamodb_table:events"],
      ),
    /both a pin and a generated entry/,
  );
});

test("a generated entry for an API name is rejected", () => {
  const legacy = labContext({ stage: "live", naming_profile: "legacy" });
  for (const type of ["api_rest", "api_http", "api_websocket"]) {
    assert.throws(
      () => physicalResourceName(legacy, type, "main", {}, [`${type}:main`]),
      /API name takes a pin/,
      type,
    );
  }
});

test("a pin takes precedence over derivation under either profile", () => {
  const composed = physicalResourceName(labContext(), "dynamodb_table", "events", {
    "dynamodb_table:events": "autheory-lab-events",
  });
  assert.deepEqual(composed, { name: "autheory-lab-events", pinned: true });
});

test("api_websocket composes like the other API name types", () => {
  const composed = physicalResourceName(
    labContext({ app: "theory-mcp-server", account: "191637461429" }),
    "api_websocket",
    "agent-sessions",
  );
  assert.equal(composed.name, "theory-mcp-server-lab-agent-sessions");
});

test("duplicate selectors are treated as a set", () => {
  const duplicated = {
    include: ["logs/runtime/*", "logs/runtime/*"],
    exclude: ["logs/runtime/debug/*", "logs/runtime/debug/*"],
  };
  const policy = compileVisibilityPolicy(labContext(), duplicated);
  assert.equal(policy.Statement[1].Resource.length, 1);
  assert.equal(policy.Statement[2].Resource.length, 1);
  const preview = visibilityPreview(duplicated, ["logs/runtime/api"]);
  assert.equal(preview.rule_version, visibilityPreview(rules, ["logs/runtime/api"]).rule_version);
  assert.deepEqual(preview.future.include, ["logs/runtime/*"]);
  assert.deepEqual(preview.future.exclude, ["logs/runtime/debug/*"]);
});

test("preview and manifest reject an invalid selector", () => {
  const invalid = { include: ["logs/run*time"] };
  assert.throws(() => visibilityPreview(invalid, ["logs/runtime/api"]), /selector/);
  assert.throws(() => visibilityManifest(invalid, ["logs/runtime/api"]), /selector/);
});

test("log group names map the logical path", () => {
  assert.equal(
    logGroupName(labContext(), "logs/runtime/api"),
    "theorycloud_theorycloud_autheory_lab_logs_runtime_api",
  );
  assert.throws(() => logGroupName(labContext(), "runtime/api"));
});

const rules = { include: ["logs/runtime/*"], exclude: ["logs/runtime/debug/*"] };

test("visibility: exclusions win and lookalikes do not match", () => {
  assert.equal(sourceVisible(rules, "logs/runtime/api"), true);
  assert.equal(sourceVisible(rules, "logs/runtime/debug/fulfillment"), false);
  assert.equal(sourceVisible(rules, "logs/runtime-shadow/api"), false);
});

test("compiled policy never grants discovery or insights", () => {
  const policy = compileVisibilityPolicy(labContext(), rules);
  const rendered = JSON.stringify(policy);
  for (const banned of ["DescribeLogGroups", "StartQuery", "StartLiveTail"]) {
    assert.equal(rendered.includes(banned), false);
  }
  assert.deepEqual(
    policy.Statement.map((statement) => statement.Effect),
    ["Allow", "Allow", "Deny"],
  );
});

test("preview and manifest match the contract vector", () => {
  const sources = ["logs/runtime/api", "logs/runtime/debug/fulfillment", "logs/access/api/main"];
  const preview = visibilityPreview(rules, sources);
  assert.equal(preview.rule_version, "ccfcb6ec1e50");
  assert.deepEqual(preview.matched_now, ["logs/runtime/api"]);
  assert.deepEqual(preview.not_matched_now, ["logs/access/api/main", "logs/runtime/debug/fulfillment"]);
  const manifest = visibilityManifest(rules, sources);
  assert.equal("not_matched_now" in manifest, false);
});

test("keeper decisions fail closed", () => {
  assert.equal(keeperDecision(rules, "logs/runtime/api", "events"), "events");
  assert.equal(keeperDecision(rules, "logs/runtime/api", "empty"), "allowed_no_events");
  assert.equal(keeperDecision(rules, "logs/runtime/api", "not_found"), "allowed_no_events");
  assert.equal(keeperDecision(rules, "logs/runtime/api", "denied"), "not_shared");
  assert.equal(keeperDecision(rules, "logs/runtime/api", "unreachable"), "not_shared");
  assert.equal(keeperDecision(rules, "logs/access/api/main", "events"), "not_shared");
  assert.equal(keeperDecision(undefined, "logs/runtime/api", "events"), "not_shared");
});

test("naming scopes follow contract section 11", () => {
  assert.equal(namingScope("iam_role"), "account");
  assert.equal(namingScope("iam_managed_policy"), "account");
  assert.equal(namingScope("dashboard"), "account");
  assert.equal(namingScope("api_rest"), "not_unique");
  assert.equal(namingScope("api_http"), "not_unique");
  assert.equal(namingScope("api_websocket"), "not_unique");
  assert.equal(namingScope("lambda_function"), "account_region");
  assert.equal(namingScope("log_group"), "account_region");
  assert.throws(() => namingScope("opensearch_domain"), /no stated naming scope/);
});

test("an inherited property name is an unknown type, never a scope", () => {
  // The contract states a scope per declared type. A name JavaScript inherits
  // from Object.prototype is not one of them, so the refusal has to fire
  // instead of accepting the key as an account-region type (r4, SANITY-AT-N3-03).
  for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => namingScope(inherited), /no stated naming scope/, inherited);
    assert.throws(
      () => physicalResourceName(labContext(), inherited, "audit-events"),
      /resource type/,
      inherited,
    );
    assert.throws(
      () => synthCheck([{ name: "autheory-lab-audit-events", type: inherited, logical_id: "Audit" }]),
      /no stated naming scope/,
      inherited,
    );
  }
});

test("the synth check refuses one name in one scope and keeps types apart", () => {
  const shared = synthCheck([
    { name: "shop-lab-worker", type: "lambda_function", logical_id: "Worker" },
    { name: "shop-lab-worker", type: "iam_role", logical_id: "WorkerRole" },
  ]);
  assert.deepEqual(shared, [
    { name: "shop-lab-worker", type: "lambda_function", scope: "account_region", logical_id: "Worker" },
    { name: "shop-lab-worker", type: "iam_role", scope: "account", logical_id: "WorkerRole" },
  ]);

  assert.doesNotThrow(() =>
    synthCheck([
      { name: "shop-lab-api", type: "api_http", logical_id: "First" },
      { name: "shop-lab-api", type: "api_http", logical_id: "Second" },
    ]),
  );

  assert.throws(
    () =>
      synthCheck([
        { name: "shop-lab-lab-site-status", type: "dashboard", logical_id: "LabSiteStatus" },
        { name: "shop-lab-lab-site-status", type: "dashboard", logical_id: "SiteStatus" },
      ]),
    /LabSiteStatus and SiteStatus derive shop-lab-lab-site-status in scope account/,
  );

  assert.deepEqual(synthCheck([{ type: "lambda_function", logical_id: "Worker", generated: true }]), [
    { type: "lambda_function", scope: "account_region", logical_id: "Worker", generated: true },
  ]);
});

test("the synth check keeps the same name apart across types and admits a re-declaration", () => {
  // Same name, same scope, different types: each type is its own namespace, so
  // one name may belong to a Lambda function and a DynamoDB table at once
  // (contract section 11.2, SANITY-NAMING-R4-06).
  const sharedAcrossTypes = synthCheck([
    { name: "shop-lab-worker", type: "lambda_function", logical_id: "Worker" },
    { name: "shop-lab-worker", type: "dynamodb_table", logical_id: "WorkerStore" },
  ]);
  assert.deepEqual(
    sharedAcrossTypes.map((row) => [row.type, row.scope]),
    [
      ["lambda_function", "account_region"],
      ["dynamodb_table", "account_region"],
    ],
  );

  // The same logical id declaring the same name twice is one resource, not a
  // collision: the reference synth_check compares the held logical id
  // (ADV-N3-R0-R1-04).
  assert.doesNotThrow(() =>
    synthCheck([
      { name: "shop-lab-worker", type: "lambda_function", logical_id: "Worker" },
      { name: "shop-lab-worker", type: "lambda_function", logical_id: "Worker" },
    ]),
  );
  assert.deepEqual(
    synthCheck([
      { name: "shop-lab-worker", type: "lambda_function", logical_id: "Worker" },
      { name: "shop-lab-worker", type: "lambda_function", logical_id: "Worker" },
    ]).map((row) => row.logical_id),
    ["Worker", "Worker"],
  );
});

// ---- hosted namespaces (contract sections 1, 2, 2.4 and 4, r5) -------------
//
// The five actor/state scenarios of the AT-N5 milestone, one test per scenario,
// so every runtime surface can be compared line for line.

function hostedContext(overrides = {}) {
  return {
    namespace: "acme",
    app: "shop",
    stage: "lab",
    account: "123456789012",
    region: "us-east-1",
    hosted: true,
    ...overrides,
  };
}

test("hosted scenario 1: a platform app keeps every r4 name byte for byte", () => {
  const platform = { app: "theory-mcp-server", stage: "lab", account: "191637461429", region: "us-east-1" };
  const expected = {
    "lambda_function:worker": { name: "theory-mcp-server-lab-worker" },
    "dynamodb_table:events": { name: "theory-mcp-server-lab-events" },
    "s3_bucket:media": {
      name: "theory-mcp-server-lab-media-191637461429-us-east-1-an",
      bucket_name_prefix: "theory-mcp-server-lab-media",
      bucket_namespace: "account-regional",
    },
    "secret:provider/stripe": { name: "theory-mcp-server/lab/provider/stripe" },
    "ssm_parameter:config": { name: "/theory-mcp-server/lab/config" },
    "kms_alias:data": { name: "alias/theory-mcp-server/lab/data" },
    "log_group:logs/runtime/api": {
      name: "theorycloud_theorycloud_theory-mcp-server_lab_logs_runtime_api",
    },
  };
  for (const [key, want] of Object.entries(expected)) {
    const [resourceType, logical] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    assert.deepEqual(physicalResourceName(platform, resourceType, logical, {}, []), want, key);
  }

  // An explicit platform namespace and an omitted one are the same context.
  assert.equal(namespacedContext(platform), false);
  assert.equal(namespacedContext({ ...platform, namespace: "theorycloud" }), false);
  assert.deepEqual(
    physicalResourceName({ ...platform, namespace: "theorycloud" }, "lambda_function", "worker", {}, []),
    physicalResourceName(platform, "lambda_function", "worker", {}, []),
  );

  // The pins and generated entries a platform app relies on today still apply.
  assert.deepEqual(
    physicalResourceName({ ...platform, namespace: "theorycloud" }, "lambda_function", "worker",
      { "lambda_function:worker": "theory-mcp-server-lab-worker-v1" }, []),
    { name: "theory-mcp-server-lab-worker-v1", pinned: true },
  );
  assert.deepEqual(
    physicalResourceName({ ...platform, namespace: "theorycloud", naming_profile: "legacy" },
      "dynamodb_table", "events", {}, ["dynamodb_table:events"]),
    { generated: true },
  );
});

test("hosted scenario 2: hosted names carry the namespace in every form", () => {
  const cases = [
    [hostedContext(), "lambda_function", "worker", { name: "acme-shop-lab-worker" }],
    [hostedContext(), "dynamodb_table", "orders", { name: "acme-shop-lab-orders" }],
    [
      hostedContext(),
      "s3_bucket",
      "uploads",
      {
        name: "acme-shop-lab-uploads-123456789012-us-east-1-an",
        bucket_name_prefix: "acme-shop-lab-uploads",
        bucket_namespace: "account-regional",
      },
    ],
    [
      hostedContext({ app: "storefront-checkout" }),
      "s3_bucket",
      "customer-uploads-archive",
      {
        name: "acme-storefront-checkout-lab-5cs2pek2-123456789012-us-east-1-an",
        bucket_name_prefix: "acme-storefront-checkout-lab-5cs2pek2",
        bucket_namespace: "account-regional",
      },
    ],
    [
      hostedContext({ namespace: "northwind", app: "customer-portal-analytics" }),
      "iam_role",
      "keeper-reader-cross-account",
      { name: "northwind-customer-portal-analytics-lab-keeper-reader-c-r3njssl4" },
    ],
    [hostedContext(), "secret", "provider/stripe", { name: "acme/shop/lab/provider/stripe" }],
    [hostedContext(), "ssm_parameter", "config/feature-flags", { name: "/acme/shop/lab/config/feature-flags" }],
    [hostedContext(), "kms_alias", "data", { name: "alias/acme/shop/lab/data" }],
    [hostedContext(), "log_group", "logs/runtime/api", { name: "theorycloud_acme_shop_lab_logs_runtime_api" }],
  ];
  for (const [context, resourceType, logical, want] of cases) {
    assert.deepEqual(physicalResourceName(context, resourceType, logical, {}, []), want, `${resourceType}:${logical}`);
  }

  // A hosted pin is returned verbatim when it starts with its namespace
  // component, exactly where the derived form puts it.
  assert.deepEqual(
    physicalResourceName(hostedContext(), "dynamodb_table", "events",
      { "dynamodb_table:events": "acme-shop-lab-events-v1" }, []),
    { name: "acme-shop-lab-events-v1", pinned: true },
  );
  for (const [resourceType, logical, pin] of [
    ["ssm_parameter", "config", "/acme/shop/lab/config-v2"],
    ["kms_alias", "data", "alias/acme/shop/lab/data-v2"],
    ["log_group", "logs/runtime/api", "theorycloud_acme_shop_lab_logs_runtime_api"],
  ]) {
    assert.doesNotThrow(() =>
      physicalResourceName(hostedContext(), resourceType, logical, { [`${resourceType}:${logical}`]: pin }, []),
    );
  }
});

test("hosted scenario 3: every broken hosted context is refused at synth", () => {
  const cases = [
    [
      "missing namespace",
      { app: "shop", stage: "lab", account: "123456789012", region: "us-east-1", hosted: true },
      {},
      "a hosted deployment must supply its namespace",
    ],
    [
      "empty namespace",
      hostedContext({ namespace: "" }),
      {},
      "a hosted deployment must supply its namespace",
    ],
    [
      "namespace over 12 characters",
      hostedContext({ namespace: "northwind-trade" }),
      {},
      "hosted namespace longer than 12 characters",
    ],
    ["namespace starts with aws", hostedContext({ namespace: "awsome" }), {}, "hosted namespace must not start with aws or ssm"],
    ["namespace starts with ssm", hostedContext({ namespace: "ssmtools" }), {}, "hosted namespace must not start with aws or ssm"],
    [
      "reserved platform namespace",
      hostedContext({ namespace: "theorycloud" }),
      {},
      "namespace theorycloud is reserved for first-party platform apps",
    ],
    [
      "hosted pin without the namespace component",
      hostedContext(),
      { "dynamodb_table:events": "shop-lab-events" },
      "a hosted pin must start with the namespace component",
    ],
    [
      "hosted pin with the namespace as a substring only",
      hostedContext({ namespace: "hop" }),
      { "dynamodb_table:events": "shop-lab-events" },
      "a hosted pin must start with the namespace component",
    ],
  ];
  for (const [name, context, pins, want] of cases) {
    assert.throws(
      () => physicalResourceName(context, "dynamodb_table", "events", pins, []),
      (error) => error.message === want,
      name,
    );
    if (!want.includes("pin")) {
      assert.throws(() => validateNamingContext(context), name);
    }
  }

  // The two live-compatibility tools are first-party only (section 4 r5 rev2).
  const legacy = hostedContext({ naming_profile: "legacy" });
  for (const call of [
    () => physicalResourceName(legacy, "dynamodb_table", "events", { "dynamodb_table:events": "acme-shop-lab-events" }, []),
    () => physicalResourceName(legacy, "dynamodb_table", "events", {}, ["dynamodb_table:events"]),
  ]) {
    assert.throws(call, (error) => error.message === "a hosted deployment takes no legacy profile or generated entries");
  }

  // The lambda service path is not a hosted log source either.
  assert.throws(
    () => physicalResourceName(hostedContext(), "log_group", "logs/runtime/api",
      { "log_group:logs/runtime/api": "/aws/lambda/acme-shop-lab-worker" }, []),
    (error) => error.message === "a hosted pin must start with the namespace component",
  );
});

// SAN-AT-N5-01: the legacy profile is a property of the context, so a hosted
// context is refused when the context is validated — with no naming declarations
// at all, and with only a log-source name — not only when a construct composes a
// physical name.
test("hosted scenario 3b: a forbidden profile is refused without a composed name", () => {
  const want = "a hosted deployment takes no legacy profile or generated entries";
  const legacy = hostedContext({ naming_profile: "legacy" });
  const same = (error) => error.message === want;

  // No declarations: the context is the only naming input, and it is refused.
  assert.throws(() => validateNamingContext(legacy), same, "no declarations");

  // A log-only declaration: the log-source path refuses too.
  assert.throws(
    () => logGroupName(legacy, "logs/runtime/api"),
    same,
    "log-only declaration",
  );

  // A composed name keeps refusing, on the same reason.
  assert.throws(
    () =>
      physicalResourceName(
        legacy,
        "dynamodb_table",
        "events",
        { "dynamodb_table:events": "acme-shop-lab-events" },
        [],
      ),
    same,
    "composed name",
  );

  // A generated entry declared on the context is a context property too, so it
  // is refused at the context rather than only where a name is composed.
  assert.throws(
    () => validateNamingContext(hostedContext({ naming_profile: "derived", generated: ["dynamodb_table:events"] })),
    same,
    "generated entry on the context",
  );

  // Control: the valid derived hosted context still validates, still resolves a
  // log source, and still composes the hosted name.
  const derived = hostedContext();
  assert.doesNotThrow(() => validateNamingContext(derived));
  assert.equal(logGroupName(derived, "logs/runtime/api"), "theorycloud_acme_shop_lab_logs_runtime_api");
  assert.deepEqual(physicalResourceName(derived, "lambda_function", "worker", {}, []), {
    name: "acme-shop-lab-worker",
  });

  // Control: the platform app keeps the legacy profile, exactly as r4 allowed, so
  // the platform path is not narrowed.
  const platform = labContext({ naming_profile: "legacy" });
  assert.doesNotThrow(() => validateNamingContext(platform));
  assert.deepEqual(
    physicalResourceName(platform, "dynamodb_table", "events", { "dynamodb_table:events": "autheory-lab-events" }, []),
    { name: "autheory-lab-events", pinned: true },
  );
});

test("hosted scenario 4: two namespaces in one account stay distinct", () => {
  const acme = physicalResourceName(hostedContext(), "lambda_function", "worker", {}, []);
  const globex = physicalResourceName(hostedContext({ namespace: "globex" }), "lambda_function", "worker", {}, []);
  assert.deepEqual(acme, { name: "acme-shop-lab-worker" });
  assert.deepEqual(globex, { name: "globex-shop-lab-worker" });
  assert.notEqual(acme.name, globex.name);

  // The section 11.4 artifact carries the hosted names, so the reservation index
  // reserves the namespaced forms and never collides.
  const artifact = synthCheck([
    { name: acme.name, type: "lambda_function", logical_id: "AcmeWorker" },
    { name: globex.name, type: "lambda_function", logical_id: "GlobexWorker" },
  ]);
  assert.deepEqual(artifact.map((row) => row.name), ["acme-shop-lab-worker", "globex-shop-lab-worker"]);
});

test("hosted scenario 5: the account and Region are caller inputs, never environment", () => {
  const saved = {};
  for (const key of ["AWS_ACCOUNT_ID", "AWS_REGION", "AWS_DEFAULT_REGION", "NAMESPACE", "APP_THEORY_NAMESPACE"]) {
    saved[key] = process.env[key];
    process.env[key] = "999999999999";
  }
  try {
    assert.deepEqual(physicalResourceName(hostedContext(), "s3_bucket", "uploads", {}, []), {
      name: "acme-shop-lab-uploads-123456789012-us-east-1-an",
      bucket_name_prefix: "acme-shop-lab-uploads",
      bucket_namespace: "account-regional",
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  // An unresolved CDK token is not a concrete account or Region, so synth fails
  // instead of deferring a deploy-time name.
  for (const context of [
    hostedContext({ account: "${Token[TOKEN.1]}" }),
    hostedContext({ region: "${Token[TOKEN.2]}" }),
    hostedContext({ account: "" }),
    hostedContext({ region: "" }),
  ]) {
    assert.throws(() => validateNamingContext(context));
  }

  // The label rule applies to any non-platform namespace, hosted or not.
  assert.throws(
    () => validateNamingContext({
      namespace: "northwind-trade", app: "shop", stage: "lab", account: "123456789012", region: "us-east-1",
    }),
    (error) => error.message === "hosted namespace longer than 12 characters",
  );

  // The exported surface agrees on the cap and the reserved prefixes.
  assert.equal(HOSTED_NAMESPACE_MAX, 12);
  assert.doesNotThrow(() => validateHostedNamespace("twelve-chars"));
  assert.doesNotThrow(() => validateHostedNamespace("theorycloud"));
  assert.throws(() => validateHostedNamespace("thirteen-char"), /12 characters/);
});
