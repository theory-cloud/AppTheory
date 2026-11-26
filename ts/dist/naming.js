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
/** The longest hosted namespace label, in characters (contract section 1, r5 rev1). */
export const HOSTED_NAMESPACE_MAX = 12;
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
/**
 * The rules of one contract type, or `undefined` when the contract states none
 * (contract section 2). The lookup is an own-property check, so an inherited
 * name such as `constructor`, `toString`, `__proto__` or `hasOwnProperty` is an
 * unknown type, never a type with rules.
 */
function namingRule(resourceType) {
    if (!Object.hasOwn(RESOURCE_NAME_RULES, resourceType))
        return undefined;
    return RESOURCE_NAME_RULES[resourceType];
}
/**
 * API name types. The CDK defaults an API Name today, so a name for one is
 * explicit and takes a pin, never a generated entry (r3, ADV-1312-3).
 */
const API_TYPES = new Set(["api_rest", "api_http", "api_websocket"]);
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
    // r5 rev1: a hosted deployment always supplies its namespace; it never
    // defaults to the platform form.
    if (context.hosted === true && !context.namespace) {
        fail("a hosted deployment must supply its namespace");
    }
    const namespace = context.namespace ?? LOG_SOURCE_PREFIX;
    if (!NAMESPACE_RE.test(namespace))
        fail("namespace");
    // r5 rev1: `theorycloud` is reserved for first-party platform apps. A hosted
    // deployment may never use it, because its names would then collide with the
    // platform app's in a pooled account.
    if (context.hosted === true && namespace === LOG_SOURCE_PREFIX) {
        fail(`namespace ${LOG_SOURCE_PREFIX} is reserved for first-party platform apps`);
    }
    validateHostedNamespace(namespace);
}
/**
 * Apply the hosted namespace label rule (contract section 1, r5 rev1): a
 * namespace other than the reserved platform one is at most
 * `HOSTED_NAMESPACE_MAX` characters and never starts with `aws` or `ssm`. Those
 * two prefixes are reserved by AWS, so a name carrying them cannot be created.
 */
export function validateHostedNamespace(namespace) {
    if (namespace === LOG_SOURCE_PREFIX)
        return;
    if (namespace.length > HOSTED_NAMESPACE_MAX) {
        fail("hosted namespace longer than 12 characters");
    }
    if (namespace.startsWith("aws") || namespace.startsWith("ssm")) {
        fail("hosted namespace must not start with aws or ssm");
    }
}
/**
 * Whether every derived name carries the namespace (contract section 2, r5):
 * true for a hosted deployment and for any namespace other than the reserved
 * platform one. The platform namespace keeps the compatibility form byte for
 * byte, so the live hard gate (contract section 4) is unchanged.
 */
export function namespacedContext(context) {
    return (context.hosted === true ||
        (context.namespace ?? LOG_SOURCE_PREFIX) !== LOG_SOURCE_PREFIX);
}
/**
 * The `{namespace}-{app}-{stage}-{logical}` stem of a `dash` name or an S3
 * account-regional prefix, with `/` in the logical name replaced by `-`.
 */
export function dashStem(context, logical) {
    const parts = [context.app, context.stage, logical.replace(/\//g, "-")];
    if (namespacedContext(context))
        parts.unshift(context.namespace);
    return parts.join("-");
}
/**
 * The `{namespace}/{app}/{stage}/{logical}` stem of a `path` name.
 */
export function pathStem(context, logical) {
    const parts = [context.app, context.stage, logical];
    if (namespacedContext(context))
        parts.unshift(context.namespace);
    return parts.join("/");
}
/**
 * The leading namespace component a hosted pin must carry, exactly where the
 * derived form puts it (contract section 4, r5 rev1, rev2). Containing the
 * namespace elsewhere is not enough: `shop-lab-events` is not a pin for
 * namespace `hop`.
 */
export function hostedPinLead(context, rule) {
    const namespace = context.namespace;
    if (rule.kind === "path")
        return `${rule.lead ?? ""}${namespace}/`;
    if (rule.kind === "log")
        return `${LOG_SOURCE_PREFIX}_${namespace}_`;
    return `${namespace}-`;
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
/**
 * Compose the physical name of one resource. Pins are returned verbatim.
 *
 * A hosted deployment (`hosted: true`, or any namespace other than the platform
 * one) carries the namespace as the first component of every derived name, its
 * S3 prefix included, and takes no pin whose name does not start with that
 * namespace component (contract sections 2 and 4, r5).
 */
export function physicalResourceName(context, resourceType, logical, pins = {}, generated = []) {
    validateNamingContext(context);
    if (!LOGICAL_RE.test(logical))
        fail("logical");
    const rule = namingRule(resourceType);
    if (!rule)
        fail(`resource type ${resourceType}`);
    const legacy = (context.naming_profile ?? "derived") === "legacy";
    // r5 rev2: the legacy profile and generated entries are first-party
    // live-compatibility tools only. A hosted deployment takes neither, because a
    // pinned or CloudFormation-generated name carries no namespace and would
    // collide across tenants in a pooled account.
    if (namespacedContext(context) && (legacy || generated.length > 0)) {
        fail("a hosted deployment takes no legacy profile or generated entries");
    }
    if (generated.length > 0 && !legacy) {
        fail("generated entries are only valid under the legacy naming profile");
    }
    const key = `${resourceType}:${logical}`;
    const pin = pins[key];
    const keepGenerated = generated.includes(key);
    // r3, ADV-1312-3: CDK defaults an API Name today, so it is an explicit name
    // and takes a pin, never a generated entry.
    if (keepGenerated && API_TYPES.has(resourceType)) {
        fail("an API name takes a pin, never a generated entry");
    }
    if (pin !== undefined && keepGenerated) {
        fail("a resource has both a pin and a generated entry");
    }
    if (pin !== undefined) {
        // r5 rev2: a hosted pin starts with its namespace component, as the derived
        // form does. A namespace that merely appears somewhere in the name is not
        // the namespace component.
        if (namespacedContext(context) &&
            !pin.startsWith(hostedPinLead(context, rule))) {
            fail("a hosted pin must start with the namespace component");
        }
        return { name: pin, pinned: true };
    }
    if (keepGenerated)
        return { generated: true };
    if (legacy) {
        fail("legacy naming profile requires a pin or a generated entry for every resource");
    }
    let out;
    if (rule.kind === "s3ar") {
        const suffix = s3AccountRegionalSuffix(context);
        const budget = rule.max - suffix.length;
        const prefix = shortenResourceName(dashStem(context, logical), budget);
        out = {
            name: prefix + suffix,
            bucket_name_prefix: prefix,
            bucket_namespace: "account-regional",
        };
    }
    else if (rule.kind === "dash") {
        out = { name: shortenResourceName(dashStem(context, logical), rule.max) };
    }
    else if (rule.kind === "path") {
        const full = `${rule.lead ?? ""}${pathStem(context, logical)}`;
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
/** The types AWS keeps unique across Regions. */
const ACCOUNT_GLOBAL_TYPES = new Set([
    "iam_role",
    "iam_managed_policy",
    "dashboard",
]);
/** The API display names AWS does not keep unique, so nothing is reserved. */
const NOT_UNIQUE_TYPES = new Set(["api_rest", "api_http", "api_websocket"]);
/**
 * The scope in which AWS requires a type's names to be unique (contract section
 * 11.1). A type the contract states no scope for is refused: it cannot be
 * reserved, so it cannot be deployed through the reservation index until a
 * revision states its scope.
 */
export function namingScope(resourceType) {
    if (namingRule(resourceType) === undefined) {
        throw new Error("a type with no stated naming scope cannot be reserved");
    }
    if (NOT_UNIQUE_TYPES.has(resourceType))
        return "not_unique";
    if (ACCOUNT_GLOBAL_TYPES.has(resourceType))
        return "account";
    return "account_region";
}
/**
 * Refuse two different logical resources in one naming context that derive the
 * same name in the same naming scope, and return the derived-name artifact
 * (contract section 11.4). A Lambda function and its IAM role may share a name
 * because their scopes differ, and two APIs may share one because AWS does not
 * keep API names unique. Rows keep the order of the entries.
 */
export function synthCheck(entries) {
    const seen = new Map();
    const artifact = [];
    for (const entry of entries) {
        const scope = namingScope(entry.type);
        const row = {
            ...(entry.name !== undefined && !entry.generated
                ? { name: entry.name }
                : {}),
            type: entry.type,
            scope,
            logical_id: entry.logical_id,
            ...(entry.generated ? { generated: true } : {}),
        };
        artifact.push(row);
        if (scope === "not_unique" || entry.generated)
            continue;
        const key = `${scope}\u0000${entry.type}\u0000${entry.name ?? ""}`;
        const held = seen.get(key);
        if (held !== undefined && held !== entry.logical_id) {
            throw new Error(`${held} and ${entry.logical_id} derive ${entry.name ?? ""} in scope ${scope}`);
        }
        seen.set(key, entry.logical_id);
    }
    return artifact;
}
//# sourceMappingURL=naming.js.map