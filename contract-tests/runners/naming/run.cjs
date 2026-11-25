#!/usr/bin/env node

/* eslint-disable no-console */

// Conformance runner for theorycloud_resource_naming.v0.1 fixtures.

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const util = require("node:util");
const { pathToFileURL } = require("node:url");

const CONTRACT = "theorycloud_resource_naming.v0.1";
const NON_PROOF = ["deployment_proof", "journey_proof", "aws_behaviour_proof"];

let naming = null;

async function loadNaming() {
  if (naming) return naming;
  const runtimePath = path.join(process.cwd(), "ts", "dist", "index.js");
  naming = await import(pathToFileURL(runtimePath).href);
  return naming;
}

function parseArgs(argv) {
  const args = { fixtures: path.join("contract-tests", "fixtures", "resource-naming", "v0.1") };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--fixtures") {
      args.fixtures = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function evaluate(scenario) {
  switch (scenario.type) {
    case "name": {
      const composed = naming.physicalResourceName(
        scenario.context,
        scenario.resource_type,
        scenario.logical,
        scenario.pins ?? {},
        scenario.generated ?? [],
      );
      const out = {};
      if (composed.name !== undefined) out.name = composed.name;
      if (composed.bucket_name_prefix !== undefined) out.bucket_name_prefix = composed.bucket_name_prefix;
      if (composed.bucket_namespace !== undefined) out.bucket_namespace = composed.bucket_namespace;
      if (composed.pinned) out.pinned = true;
      if (composed.generated) out.generated = true;
      return out;
    }
    case "log_group":
      naming.validateNamingContext(scenario.context);
      return { name: naming.logGroupName(scenario.context, scenario.logical) };
    case "compile":
      return naming.compileVisibilityPolicy(scenario.context, scenario.rules ?? {});
    case "preview":
      return naming.visibilityPreview(scenario.rules ?? {}, scenario.sources);
    case "manifest":
      return naming.visibilityManifest(scenario.rules ?? {}, scenario.sources);
    case "keeper":
      return { answer: naming.keeperDecision(scenario.rules, scenario.logical, scenario.aws_result) };
    case "visible":
      return { visible: naming.sourceVisible(scenario.rules ?? {}, scenario.logical) };
    case "naming_scope":
      return { scope: naming.namingScope(scenario.resource_type) };
    case "synth_check": {
      const artifact = naming.synthCheck(scenario.entries ?? []).map((row) => {
        const out = {};
        if (row.name !== undefined) out.name = row.name;
        out.type = row.type;
        out.scope = row.scope;
        out.logical_id = row.logical_id;
        if (row.generated) out.generated = true;
        return out;
      });
      return { artifact };
    }
    default:
      throw new Error(`unknown scenario type ${scenario.type}`);
  }
}

function check(fx) {
  const reasons = [];
  if (fx.contract !== CONTRACT) reasons.push("contract id");
  const declared = new Set(fx.proof?.does_not_prove ?? []);
  for (const required of NON_PROOF) {
    if (!declared.has(required)) reasons.push(`missing proof disclaimer ${required}`);
  }

  const expected = fx.expected ?? {};
  const expectsError = Boolean(expected && typeof expected === "object" && expected.error);
  let got = null;
  let gotError = null;
  try {
    got = evaluate(fx.scenario);
  } catch (error) {
    gotError = error;
  }

  if (gotError) {
    if (!expectsError) reasons.push(`contract rejects: ${gotError.message}`);
  } else if (expectsError) {
    reasons.push("fixture expects rejection but contract accepts");
  } else if (!util.isDeepStrictEqual(got, expected)) {
    reasons.push(`expected ${JSON.stringify(expected)} != required ${JSON.stringify(got)}`);
  }
  return reasons;
}

async function main() {
  const args = parseArgs(process.argv);
  await loadNaming();
  let passed = 0;
  let total = 0;
  const failures = [];
  for (const family of ["valid", "invalid"]) {
    const dir = path.join(args.fixtures, family);
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of files) {
      total += 1;
      const fixture = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      const reasons = check(fixture);
      const ok = family === "invalid" ? reasons.length > 0 : reasons.length === 0;
      if (ok) {
        passed += 1;
        console.log(`PASS ${family}/${name}${family === "invalid" ? " (rejected)" : ""}`);
      } else {
        console.log(`FAIL ${family}/${name}`);
        for (const reason of reasons.length ? reasons : ["invalid fixture passed"]) {
          failures.push(`  ${family}/${name}: ${reason}`);
        }
      }
    }
  }
  for (const failure of failures) console.error(failure);
  if (passed !== total) {
    console.error(`resource-naming(ts): FAIL (${passed}/${total} passed)`);
    return 1;
  }
  console.log(`resource-naming(ts): PASS (${total} fixtures)`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
