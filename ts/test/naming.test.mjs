import test from "node:test";
import assert from "node:assert/strict";

import {
  compileVisibilityPolicy,
  keeperDecision,
  logGroupName,
  namingScope,
  physicalResourceName,
  sourceVisible,
  synthCheck,
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
