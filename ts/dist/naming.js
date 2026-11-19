import { createHash } from "node:crypto";
import { trimRepeatedChar } from "./internal/string-utils.js";
function sanitizeNamePart(value) {
    let out = String(value ?? "")
        .trim()
        .toLowerCase();
    if (!out)
        return "";
    out = out.replace(/[_ ]+/g, "-");
    out = out.replace(/[^a-z0-9-]+/g, "-");
    out = out.replace(/-+/g, "-");
    out = trimRepeatedChar(out, "-");
    return out;
}
export function normalizeStage(stage) {
    const value = String(stage ?? "")
        .trim()
        .toLowerCase();
    switch (value) {
        case "prod":
        case "production":
        case "live":
            return "live";
        case "dev":
        case "development":
            return "dev";
        case "stg":
        case "stage":
        case "staging":
            return "stage";
        case "test":
        case "testing":
            return "test";
        case "local":
            return "local";
        default:
            return sanitizeNamePart(value);
    }
}
export function baseName(appName, stage, tenant = "") {
    const app = sanitizeNamePart(appName);
    const ten = sanitizeNamePart(tenant);
    const stg = normalizeStage(stage);
    return ten ? `${app}-${ten}-${stg}` : `${app}-${stg}`;
}
export function resourceName(appName, resource, stage, tenant = "") {
    const app = sanitizeNamePart(appName);
    const ten = sanitizeNamePart(tenant);
    const res = sanitizeNamePart(resource);
    const stg = normalizeStage(stage);
    return ten ? `${app}-${ten}-${res}-${stg}` : `${app}-${res}-${stg}`;
}
// ---- theorycloud_resource_naming.v0.1 --------------------------------------
/** The resource-naming contract this module implements. */
export const RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1";
/** The leading segment of every log-source name. */
export const LOG_SOURCE_PREFIX = "theorycloud";
/** The aggregate inline role policy quota, in characters. */
export const ROLE_POLICY_MAX = 10240;
const SEGMENT_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";
const LOGICAL_RE = new RegExp(`^${SEGMENT_PATTERN}(?:/${SEGMENT_PATTERN})*$`);
const APP_RE = new RegExp(`^${SEGMENT_PATTERN}$`);
const STAGE_RE = /^[a-z][a-z0-9]{0,7}$/;
const NAMESPACE_RE = new RegExp(`^${SEGMENT_PATTERN}$`);
const ACCOUNT_RE = /^[0-9]{12}$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;
const SECRET_TAIL_RE = /-[A-Za-z0-9]{6}$/;
const S3_EDGES_RE = /^[a-z0-9].*[a-z0-9]$/;
/** The per-type composition table (contract section 2). */
export const RESOURCE_NAME_RULES = {
    s3_bucket: { kind: "s3ar", max: 63, charset: "[a-z0-9-]" },
    s3_vector_bucket: { kind: "dash", max: 63, charset: "[a-z0-9-]" },
    s3_vector_index: { kind: "dash", max: 63, charset: "[a-z0-9-]" },
    dynamodb_table: { kind: "dash", max: 255, charset: "[A-Za-z0-9_.-]" },
    lambda_function: { kind: "dash", max: 64, charset: "[A-Za-z0-9_-]" },
    sqs_queue: { kind: "dash", max: 80, charset: "[A-Za-z0-9_-]" },
    sns_topic: { kind: "dash", max: 256, charset: "[A-Za-z0-9_-]" },
    secret: { kind: "path", max: 512, charset: "[A-Za-z0-9/_+=.@-]" },
    ssm_parameter: {
        kind: "path",
        max: 900,
        charset: "[A-Za-z0-9_./-]",
        lead: "/",
    },
    kms_alias: {
        kind: "path",
        max: 256,
        charset: "[A-Za-z0-9/_-]",
        lead: "alias/",
    },
    event_bus: { kind: "dash", max: 256, charset: "[A-Za-z0-9._-]" },
    event_rule: { kind: "dash", max: 64, charset: "[A-Za-z0-9._-]" },
    schedule: { kind: "dash", max: 64, charset: "[A-Za-z0-9._-]" },
    alarm: { kind: "dash", max: 255, charset: "[A-Za-z0-9_.-]" },
    dashboard: { kind: "dash", max: 255, charset: "[A-Za-z0-9_-]" },
    iam_role: { kind: "dash", max: 64, charset: "[A-Za-z0-9+=,.@_-]" },
    iam_managed_policy: { kind: "dash", max: 128, charset: "[A-Za-z0-9+=,.@_-]" },
    state_machine: { kind: "dash", max: 80, charset: "[A-Za-z0-9_-]" },
    codebuild_project: { kind: "dash", max: 150, charset: "[A-Za-z0-9_-]" },
    api_rest: { kind: "dash", max: 128, charset: "[A-Za-z0-9_-]" },
    api_http: { kind: "dash", max: 128, charset: "[A-Za-z0-9_-]" },
    api_websocket: { kind: "dash", max: 128, charset: "[A-Za-z0-9_-]" },
    log_delivery_source: { kind: "dash", max: 60, charset: "[A-Za-z0-9_-]" },
    log_delivery_destination: { kind: "dash", max: 60, charset: "[A-Za-z0-9_-]" },
    log_group: { kind: "log", max: 512, charset: "[A-Za-z0-9_-]" },
};
/** The only log actions a reader role is granted. */
export const KEEPER_ACTIONS_GROUP = [
    "logs:FilterLogEvents",
    "logs:DescribeLogStreams",
];
export const KEEPER_ACTIONS_STREAM = ["logs:GetLogEvents"];
function fail(message) {
    throw new Error(message);
}
/** Enforce the bound-context grammar. */
export function validateNamingContext(context) {
    if (!APP_RE.test(context.app))
        fail("app");
    if (!STAGE_RE.test(context.stage))
        fail("stage");
    if (!ACCOUNT_RE.test(context.account))
        fail("account");
    if (!REGION_RE.test(context.region))
        fail("region");
    if (!NAMESPACE_RE.test(context.namespace ?? LOG_SOURCE_PREFIX))
        fail("namespace");
}
function sha256Hex(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function base32Lower(text) {
    const bytes = createHash("sha256").update(text, "utf8").digest();
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return out;
}
/** Apply the deterministic over-budget form (contract section 2.2). */
export function shortenResourceName(full, limit) {
    if (full.length <= limit)
        return full;
    const head = full.slice(0, limit - 9).replace(/[-_./]+$/, "");
    return `${head}-${base32Lower(full).slice(0, 8)}`;
}
/** The CloudFormation-appended account-regional suffix. */
export function s3AccountRegionalSuffix(context) {
    return `-${context.account}-${context.region}-an`;
}
/** The bound prefix shared by every log source of the app. */
export function logSourcePrefix(context) {
    return `${[LOG_SOURCE_PREFIX, context.namespace ?? LOG_SOURCE_PREFIX, context.app, context.stage].join("_")}_`;
}
/** Map a logical log source to its physical log-group name. */
export function logGroupName(context, logical) {
    if (!logical.startsWith("logs/"))
        fail("log logical must start with logs/");
    return logSourcePrefix(context) + logical.replace(/\//g, "_");
}
/** Compose the physical name of one resource. Pins are returned verbatim. */
export function physicalResourceName(context, resourceType, logical, pins = {}, generated = []) {
    validateNamingContext(context);
    if (!LOGICAL_RE.test(logical))
        fail("logical");
    const rule = RESOURCE_NAME_RULES[resourceType];
    if (!rule)
        fail(`resource type ${resourceType}`);
    const legacy = (context.naming_profile ?? "derived") === "legacy";
    if (generated.length > 0 && !legacy) {
        fail("generated entries are only valid under the legacy naming profile");
    }
    const key = `${resourceType}:${logical}`;
    const pin = pins[key];
    const keepGenerated = generated.includes(key);
    if (pin !== undefined && keepGenerated) {
        fail("a resource has both a pin and a generated entry");
    }
    if (pin !== undefined)
        return { name: pin, pinned: true };
    if (keepGenerated)
        return { generated: true };
    if (legacy) {
        fail("legacy naming profile requires a pin or a generated entry for every resource");
    }
    let out;
    if (rule.kind === "s3ar") {
        const suffix = s3AccountRegionalSuffix(context);
        const budget = rule.max - suffix.length;
        const prefix = shortenResourceName(`${context.app}-${context.stage}-${logical.replace(/\//g, "-")}`, budget);
        out = {
            name: prefix + suffix,
            bucket_name_prefix: prefix,
            bucket_namespace: "account-regional",
        };
    }
    else if (rule.kind === "dash") {
        out = {
            name: shortenResourceName(`${context.app}-${context.stage}-${logical.replace(/\//g, "-")}`, rule.max),
        };
    }
    else if (rule.kind === "path") {
        const full = `${rule.lead ?? ""}${context.app}/${context.stage}/${logical}`;
        if (resourceType === "secret" && SECRET_TAIL_RE.test(full)) {
            fail("secret name must not end with a hyphen and six characters");
        }
        if (resourceType === "ssm_parameter" &&
            (full.match(/\//g)?.length ?? 0) > 15) {
            fail("ssm hierarchy deeper than 15");
        }
        if (full.length > rule.max)
            fail("path name over limit");
        out = { name: full };
    }
    else if (rule.kind === "log") {
        const name = logGroupName(context, logical);
        if (name.length > rule.max)
            fail("log group over limit");
        out = { name };
    }
    else {
        fail(`unsupported kind ${String(rule.kind)}`);
    }
    const name = out.name;
    if (!new RegExp(`^(?:${rule.charset})+$`).test(name))
        fail("charset");
    if (name.length > rule.max)
        fail("length");
    if (["s3_bucket", "s3_vector_bucket", "s3_vector_index"].includes(resourceType) &&
        !S3_EDGES_RE.test(name)) {
        fail("s3 start/end");
    }
    return out;
}
function sortedCopy(values) {
    return [...new Set(values ?? [])].sort();
}
/** Enforce the selector grammar (contract section 5). */
export function validateVisibilitySelector(selector) {
    const base = selector.endsWith("/*") ? selector.slice(0, -2) : selector;
    const bareLogs = base === "logs" && !selector.endsWith("/*");
    if (!LOGICAL_RE.test(base) || base.split("/")[0] !== "logs" || bareLogs) {
        fail(`selector ${selector}`);
    }
    if (base.includes("*"))
        fail("wildcard only as trailing /*");
}
/** Whether a selector matches a logical source. `/*` matches descendants only. */
export function visibilitySelectorMatches(selector, logical) {
    if (selector.endsWith("/*"))
        return logical.startsWith(selector.slice(0, -1));
    return logical === selector;
}
/** Whether a source is visible: an include matches and no exclude does. */
export function sourceVisible(rules, logical) {
    const included = (rules.include ?? []).some((selector) => visibilitySelectorMatches(selector, logical));
    if (!included)
        return false;
    return !(rules.exclude ?? []).some((selector) => visibilitySelectorMatches(selector, logical));
}
/** Expand a selector to the log-group ARNs it covers. */
export function visibilitySelectorArns(context, selector) {
    const base = `arn:aws:logs:${context.region}:${context.account}:log-group:`;
    if (selector.endsWith("/*")) {
        const mapped = selector.slice(0, -1).replace(/\//g, "_");
        return [`${base}${logSourcePrefix(context)}${mapped}*`];
    }
    const name = logSourcePrefix(context) + selector.replace(/\//g, "_");
    return [base + name, `${base}${name}:*`];
}
/** The first 12 hex characters of SHA-256 over the canonical rules. */
export function visibilityRuleVersion(rules) {
    const canonical = `{"exclude":${JSON.stringify(sortedCopy(rules.exclude))},"include":${JSON.stringify(sortedCopy(rules.include))}}`;
    return sha256Hex(canonical).slice(0, 12);
}
/** Compile the rules into the reader-role inline policy. */
export function compileVisibilityPolicy(context, rules) {
    for (const selector of [...(rules.include ?? []), ...(rules.exclude ?? [])]) {
        validateVisibilitySelector(selector);
    }
    const actions = [...KEEPER_ACTIONS_GROUP, ...KEEPER_ACTIONS_STREAM];
    const statements = [
        {
            Sid: "ReadManifest",
            Effect: "Allow",
            Action: ["ssm:GetParameter"],
            Resource: [
                `arn:aws:ssm:${context.region}:${context.account}:parameter/${LOG_SOURCE_PREFIX}/visibility/${context.app}/${context.stage}/manifest`,
            ],
        },
    ];
    const included = sortedCopy(rules.include).flatMap((selector) => visibilitySelectorArns(context, selector));
    const excluded = sortedCopy(rules.exclude).flatMap((selector) => visibilitySelectorArns(context, selector));
    if (included.length > 0) {
        statements.push({
            Sid: "ReadIncluded",
            Effect: "Allow",
            Action: actions,
            Resource: included,
        });
    }
    if (excluded.length > 0) {
        statements.push({
            Sid: "DenyExcluded",
            Effect: "Deny",
            Action: actions,
            Resource: excluded,
        });
    }
    const policy = {
        Version: "2012-10-17",
        Statement: statements,
    };
    if (JSON.stringify(policy).length > ROLE_POLICY_MAX)
        fail("compiled policy over role policy size");
    return policy;
}
function futureRules(rules) {
    return {
        include: sortedCopy(rules.include),
        exclude: sortedCopy(rules.exclude),
    };
}
/** Assemble the synth-time preview. */
export function visibilityPreview(rules, sources) {
    for (const selector of [...(rules.include ?? []), ...(rules.exclude ?? [])]) {
        validateVisibilitySelector(selector);
    }
    const matched = sources
        .filter((source) => sourceVisible(rules, source))
        .sort();
    const notMatched = sources
        .filter((source) => !sourceVisible(rules, source))
        .sort();
    return {
        rule_version: visibilityRuleVersion(rules),
        matched_now: matched,
        not_matched_now: notMatched,
        future: futureRules(rules),
    };
}
/** Assemble the published manifest (no `not_matched_now`). */
export function visibilityManifest(rules, sources) {
    const preview = visibilityPreview(rules, sources);
    return {
        rule_version: preview.rule_version,
        matched_now: preview.matched_now,
        future: preview.future,
    };
}
/** Keeper's answer to a read request. Fails closed on denial or unreachable. */
export function keeperDecision(rules, logical, awsResult) {
    if (!rules || !sourceVisible(rules, logical))
        return "not_shared";
    if (awsResult === "events")
        return "events";
    if (awsResult === "empty" || awsResult === "not_found")
        return "allowed_no_events";
    return "not_shared";
}
//# sourceMappingURL=naming.js.map