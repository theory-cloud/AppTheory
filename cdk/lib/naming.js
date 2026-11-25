"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryResourceNaming = exports.AppTheoryNamingScope = exports.AppTheoryKeeperAnswer = exports.AppTheoryLoggingProfile = exports.AppTheoryNamingProfile = exports.DERIVED_NAMES_METADATA_KEY = exports.DERIVED_NAMES_SCHEMA = exports.RESOURCE_NAMING_CONTRACT = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const node_crypto_1 = require("node:crypto");
/**
 * The resource-naming contract this module implements.
 */
exports.RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1";
/**
 * The schema identifier of the derived-name artifact a naming context emits.
 */
exports.DERIVED_NAMES_SCHEMA = "apptheory_resource_naming.derived_names.v1";
/**
 * The cloud-assembly metadata type that carries the derived-name artifact. The
 * artifact lands in `{stack}.metadata.json` in `cdk.out`.
 */
exports.DERIVED_NAMES_METADATA_KEY = "apptheory:resource-naming/derived-names";
/**
 * Naming profiles accepted by a naming context.
 */
var AppTheoryNamingProfile;
(function (AppTheoryNamingProfile) {
    /**
     * Names derive from the naming context.
     */
    AppTheoryNamingProfile["DERIVED"] = "derived";
    /**
     * Every name comes from a pin.
     */
    AppTheoryNamingProfile["LEGACY"] = "legacy";
})(AppTheoryNamingProfile || (exports.AppTheoryNamingProfile = AppTheoryNamingProfile = {}));
/**
 * Logging profiles accepted by a naming context.
 */
var AppTheoryLoggingProfile;
(function (AppTheoryLoggingProfile) {
    /**
     * AppTheory creates standard log groups and access logging.
     */
    AppTheoryLoggingProfile["STANDARD"] = "standard";
    /**
     * Each construct keeps its pre-contract logging behaviour.
     */
    AppTheoryLoggingProfile["LEGACY"] = "legacy";
})(AppTheoryLoggingProfile || (exports.AppTheoryLoggingProfile = AppTheoryLoggingProfile = {}));
/**
 * Keeper's answer to a reader request.
 */
var AppTheoryKeeperAnswer;
(function (AppTheoryKeeperAnswer) {
    /**
     * The source is shared and the read returned events.
     */
    AppTheoryKeeperAnswer["EVENTS"] = "events";
    /**
     * The source is shared and the read returned no events.
     */
    AppTheoryKeeperAnswer["ALLOWED_NO_EVENTS"] = "allowed_no_events";
    /**
     * The source is not shared, or the read failed closed.
     */
    AppTheoryKeeperAnswer["NOT_SHARED"] = "not_shared";
})(AppTheoryKeeperAnswer || (exports.AppTheoryKeeperAnswer = AppTheoryKeeperAnswer = {}));
/**
 * The naming scopes of contract section 11.1.
 */
var AppTheoryNamingScope;
(function (AppTheoryNamingScope) {
    /**
     * AWS keeps the name unique across the whole account, whatever the Region.
     */
    AppTheoryNamingScope["ACCOUNT"] = "account";
    /**
     * AWS keeps the name unique per account and Region.
     */
    AppTheoryNamingScope["ACCOUNT_REGION"] = "account_region";
    /**
     * AWS does not keep the name unique, so nothing is reserved for it.
     */
    AppTheoryNamingScope["NOT_UNIQUE"] = "not_unique";
})(AppTheoryNamingScope || (exports.AppTheoryNamingScope = AppTheoryNamingScope = {}));
const SEGMENT_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";
const LOGICAL_RE = new RegExp(`^${SEGMENT_PATTERN}(?:/${SEGMENT_PATTERN})*$`);
const APP_RE = new RegExp(`^${SEGMENT_PATTERN}$`);
const STAGE_RE = /^[a-z][a-z0-9]{0,7}$/;
const NAMESPACE_RE = new RegExp(`^${SEGMENT_PATTERN}$`);
const ACCOUNT_RE = /^[0-9]{12}$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;
const SECRET_TAIL_RE = /-[A-Za-z0-9]{6}$/;
const S3_EDGES_RE = /^[a-z0-9].*[a-z0-9]$/;
const LOG_PREFIX = "theorycloud";
const ROLE_POLICY_MAX = 10240;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const RULES = {
    s3_bucket: { kind: "s3ar", max: 63, charset: "[a-z0-9-]" },
    s3_vector_bucket: { kind: "dash", max: 63, charset: "[a-z0-9-]" },
    s3_vector_index: { kind: "dash", max: 63, charset: "[a-z0-9-]" },
    // Section 2: "255 (plain-name limit 3–255; the 1024 limit applies to the ARN
    // form)". The lower bound is part of the row, so a fixed name of one or two
    // characters is refused (SANITY-AT-N3-08).
    dynamodb_table: { kind: "dash", max: 255, min: 3, charset: "[A-Za-z0-9_.-]" },
    lambda_function: { kind: "dash", max: 64, charset: "[A-Za-z0-9_-]" },
    sqs_queue: { kind: "dash", max: 80, charset: "[A-Za-z0-9_-]" },
    sns_topic: { kind: "dash", max: 256, charset: "[A-Za-z0-9_-]" },
    secret: { kind: "path", max: 512, charset: "[A-Za-z0-9/_+=.@-]" },
    ssm_parameter: { kind: "path", max: 900, charset: "[A-Za-z0-9_./-]", lead: "/" },
    kms_alias: { kind: "path", max: 256, charset: "[A-Za-z0-9/_-]", lead: "alias/" },
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
    if (!Object.hasOwn(RULES, resourceType))
        return undefined;
    return RULES[resourceType];
}
/**
 * API name types. The CDK defaults an API Name today, so a name for one is
 * explicit and takes a pin, never a generated entry (r3, ADV-1312-3).
 */
const API_TYPES = new Set(["api_rest", "api_http", "api_websocket"]);
/**
 * Types whose section 2 row adds the S3 start/end-alphanumeric rule.
 */
const S3_TYPES = new Set(["s3_bucket", "s3_vector_bucket", "s3_vector_index"]);
/**
 * Types whose fixed-name charset differs from the derived-name charset of their
 * section 2 row. A log group is the only one: one of its two fixed shapes is the
 * Lambda service path `/aws/lambda/{function name}` (section 3), so `/` is part
 * of the charset even though no derived log-group name contains one. The shape
 * rule below is what narrows it again: every other `/`-bearing log group is
 * refused.
 */
const FIXED_NAME_CHARSETS = new Map([["log_group", "[A-Za-z0-9_/-]"]]);
/**
 * The Lambda service log-group path lead (contract section 3).
 */
const LAMBDA_LOG_GROUP_LEAD = "/aws/lambda/";
/**
 * The KMS alias path lead (contract section 2).
 */
const KMS_ALIAS_LEAD = "alias/";
/**
 * An absolute SSM parameter path: a lead `/`, then at least one non-empty
 * segment, with no empty segment anywhere (contract section 2).
 */
const SSM_PATH_RE = /^\/[^/]+(?:\/[^/]+)*$/;
/**
 * Whether a fixed log-group name is one of the two shapes contract section 3
 * states, and nothing else:
 *
 * - a log-source name, `theorycloud_{namespace}_{app}_{stage}_{logical}`. Its
 *   segments are joined with `_` precisely so the one grammar also satisfies
 *   CloudFront's `[\w-]` destination, so such a name carries no `/` at all;
 * - the Lambda service path `/aws/lambda/{function name}`, whose function name
 *   satisfies the `lambda_function` row of section 2 (length and charset).
 *
 * Any other `/`-bearing name is refused: `arbitrary/path` is neither shape
 * (SANITY-AT-N3-08).
 */
function isFixedLogGroupShape(name) {
    if (!name.includes("/"))
        return true;
    if (!name.startsWith(LAMBDA_LOG_GROUP_LEAD))
        return false;
    const functionName = name.slice(LAMBDA_LOG_GROUP_LEAD.length);
    const lambda = RULES.lambda_function;
    if (functionName.length > lambda.max)
        return false;
    if (lambda.min !== undefined && functionName.length < lambda.min)
        return false;
    return new RegExp(`^(?:${lambda.charset})+$`).test(functionName);
}
/**
 * Types AWS keeps unique across Regions (contract section 11.1).
 */
const ACCOUNT_GLOBAL_TYPES = new Set(["iam_role", "iam_managed_policy", "dashboard"]);
/**
 * API display names AWS does not keep unique, so nothing is reserved for them.
 */
const NOT_UNIQUE_TYPES = new Set(["api_rest", "api_http", "api_websocket"]);
/**
 * The refusal for a type the contract states no naming scope for: it cannot be
 * reserved, so it cannot be deployed through the index until a revision states
 * its scope.
 */
const UNKNOWN_NAMING_SCOPE = "a type with no stated naming scope cannot be reserved";
const KEEPER_ACTIONS_GROUP = ["logs:FilterLogEvents", "logs:DescribeLogStreams"];
const KEEPER_ACTIONS_STREAM = ["logs:GetLogEvents"];
function fail(message) {
    throw new Error(message);
}
function sha256Hex(text) {
    return (0, node_crypto_1.createHash)("sha256").update(text, "utf8").digest("hex");
}
function base32Lower(text) {
    const bytes = (0, node_crypto_1.createHash)("sha256").update(text, "utf8").digest();
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += BASE32[(value << (5 - bits)) & 31];
    return out;
}
function shorten(full, limit) {
    if (full.length <= limit)
        return full;
    const head = full.slice(0, limit - 9).replace(/[-_./]+$/, "");
    return `${head}-${base32Lower(full).slice(0, 8)}`;
}
function namespaceOf(values) {
    return values.namespace ?? LOG_PREFIX;
}
function sortedCopy(values) {
    return [...new Set(values ?? [])].sort();
}
function logPrefix(values) {
    return [LOG_PREFIX, namespaceOf(values), values.app, values.stage].join("_") + "_";
}
/**
 * The `theorycloud_resource_naming.v0.1` primitives, exposed for jsii so the Go
 * and Python CDK bindings share one implementation.
 */
class AppTheoryResourceNaming {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryResourceNaming", version: "7.5.0" };
    constructor() { }
    /**
     * Validate the bound context grammar. Throws on an invalid context.
     */
    static validateContext(values) {
        if (!APP_RE.test(values.app))
            fail("app");
        if (!STAGE_RE.test(values.stage))
            fail("stage");
        if (!ACCOUNT_RE.test(values.account))
            fail("account");
        if (!REGION_RE.test(values.region))
            fail("region");
        if (!NAMESPACE_RE.test(namespaceOf(values)))
            fail("namespace");
    }
    /**
     * The CloudFormation-appended account-regional bucket suffix.
     */
    static s3AccountRegionalSuffix(values) {
        return `-${values.account}-${values.region}-an`;
    }
    /**
     * The bound prefix shared by every log source of the app.
     */
    static logSourcePrefix(values) {
        return logPrefix(values);
    }
    /**
     * Map a logical log source to its physical log-group name.
     */
    static logGroupName(values, logical) {
        if (!logical.startsWith("logs/"))
            fail("log logical must start with logs/");
        return logPrefix(values) + logical.replace(/\//g, "_");
    }
    /**
     * Compose the physical name of one resource. A pin always wins. A generated
     * entry means CloudFormation generates the name today and the construct sets
     * no physical-name property. Generated entries are legacy-only; a legacy
     * profile needs exactly one of a pin or a generated entry.
     */
    static physicalName(values, resourceType, logical) {
        AppTheoryResourceNaming.validateContext(values);
        if (!LOGICAL_RE.test(logical))
            fail("logical");
        const rule = namingRule(resourceType);
        if (!rule)
            fail(`resource type ${resourceType}`);
        const generated = values.generated ?? [];
        const legacy = (values.namingProfile ?? AppTheoryNamingProfile.DERIVED) === AppTheoryNamingProfile.LEGACY;
        if (generated.length > 0 && !legacy) {
            fail("generated entries are only valid under the legacy naming profile");
        }
        const key = `${resourceType}:${logical}`;
        const pin = values.pins?.[key];
        const keepGenerated = generated.includes(key);
        // r3, ADV-1312-3: CDK defaults an API Name today, so it is an explicit name
        // and takes a pin, never a generated entry.
        if (keepGenerated && API_TYPES.has(resourceType)) {
            fail("an API name takes a pin, never a generated entry");
        }
        if (pin !== undefined && keepGenerated)
            fail("a resource has both a pin and a generated entry");
        if (pin !== undefined)
            return { name: pin, pinned: true };
        if (keepGenerated)
            return { generated: true };
        if (legacy) {
            fail(`legacy naming profile requires a pin or a generated entry for ${key}`);
        }
        let out;
        if (rule.kind === "s3ar") {
            const suffix = AppTheoryResourceNaming.s3AccountRegionalSuffix(values);
            const budget = rule.max - suffix.length;
            const prefix = shorten(`${values.app}-${values.stage}-${logical.replace(/\//g, "-")}`, budget);
            out = { name: prefix + suffix, bucketNamePrefix: prefix, bucketNamespace: "account-regional" };
        }
        else if (rule.kind === "dash") {
            out = { name: shorten(`${values.app}-${values.stage}-${logical.replace(/\//g, "-")}`, rule.max) };
        }
        else if (rule.kind === "path") {
            const full = `${rule.lead ?? ""}${values.app}/${values.stage}/${logical}`;
            if (resourceType === "secret" && SECRET_TAIL_RE.test(full)) {
                fail("secret name must not end with a hyphen and six characters");
            }
            if (resourceType === "ssm_parameter" && (full.match(/\//g)?.length ?? 0) > 15) {
                fail("ssm hierarchy deeper than 15");
            }
            if (full.length > rule.max)
                fail("path name over limit");
            out = { name: full };
        }
        else if (rule.kind === "log") {
            const name = AppTheoryResourceNaming.logGroupName(values, logical);
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
        if (rule.min !== undefined && name.length < rule.min)
            fail("length");
        if (["s3_bucket", "s3_vector_bucket", "s3_vector_index"].includes(resourceType) && !S3_EDGES_RE.test(name)) {
            fail("s3 start/end");
        }
        return out;
    }
    /**
     * The scope in which AWS requires a type's names to be unique (contract
     * section 11.1). A type the contract states no scope for is refused: it cannot
     * be reserved, so it cannot be deployed through the index until a revision
     * states its scope.
     */
    static namingScope(resourceType) {
        if (namingRule(resourceType) === undefined)
            fail(UNKNOWN_NAMING_SCOPE);
        if (NOT_UNIQUE_TYPES.has(resourceType))
            return AppTheoryNamingScope.NOT_UNIQUE;
        if (ACCOUNT_GLOBAL_TYPES.has(resourceType))
            return AppTheoryNamingScope.ACCOUNT;
        return AppTheoryNamingScope.ACCOUNT_REGION;
    }
    /**
     * Validate a physical name the contract fixes rather than derives against the
     * character and shape rules of the type's section 2 row: charset, the length
     * range (**both** bounds when the row states a lower one, not only the upper),
     * the S3 start/end rule, the path rules (lead, non-empty segments, depth,
     * reserved prefixes, the `alias/aws/` namespace) and the secret ARN-suffix
     * rule. Throws on a name outside them.
     *
     * This is the section 2 table, not a second one: it reads the same rule rows
     * the derivation uses. A `log_group` accepts `/` in addition to the section 2
     * charset, but only for the two fixed shapes contract section 3 states: a
     * log-source name (which carries no `/` at all, because section 3 joins its
     * segments with `_`) or the Lambda service path `/aws/lambda/{function name}`,
     * whose function name satisfies the `lambda_function` row. Any other
     * `/`-bearing log group is refused (SANITY-AT-N3-08).
     */
    static validatePhysicalName(resourceType, name) {
        const rule = namingRule(resourceType);
        if (rule === undefined)
            fail(UNKNOWN_NAMING_SCOPE);
        const charset = FIXED_NAME_CHARSETS.get(resourceType) ?? rule.charset;
        const quoted = JSON.stringify(name);
        if (name.length === 0 || !new RegExp(`^(?:${charset})+$`).test(name)) {
            fail(`a fixed ${resourceType} name must match ${charset} (contract section 2), got ${quoted}`);
        }
        if (name.length > rule.max) {
            fail(`a fixed ${resourceType} name must be at most ${rule.max} characters, got ${name.length}`);
        }
        if (rule.min !== undefined && name.length < rule.min) {
            fail(`a fixed ${resourceType} name must be at least ${rule.min} characters (contract section 2), got ${name.length}`);
        }
        if (rule.lead !== undefined && !name.startsWith(rule.lead)) {
            fail(`a fixed ${resourceType} name must start with ${JSON.stringify(rule.lead)} (contract section 2), got ${quoted}`);
        }
        if (S3_TYPES.has(resourceType) && !S3_EDGES_RE.test(name)) {
            fail(`a fixed ${resourceType} name must start and end with a letter or digit (contract section 2), got ${quoted}`);
        }
        if (resourceType === "secret" && SECRET_TAIL_RE.test(name)) {
            fail(`a fixed secret name must not end with a hyphen and six characters (contract section 2), got ${quoted}`);
        }
        if (resourceType === "ssm_parameter") {
            // A path name carries at least one non-empty segment after its lead `/`,
            // and no empty segment: `/` and `/a//b` name nothing AWS can create.
            if (!SSM_PATH_RE.test(name)) {
                fail(`a fixed ssm_parameter name must carry at least one non-empty segment after its lead "/" and no empty segment (contract section 2), got ${quoted}`);
            }
            if ((name.match(/\//g)?.length ?? 0) > 15) {
                fail(`a fixed ssm_parameter name must have at most 15 levels (contract section 2), got ${quoted}`);
            }
            if (/^\/?(?:aws|ssm)(?:\/|$)/i.test(name)) {
                fail(`a fixed ssm_parameter name must not begin with aws or ssm (contract section 2), got ${quoted}`);
            }
        }
        if (resourceType === "kms_alias") {
            // `alias/` alone names no alias: the name after the lead is the alias.
            if (name.length <= KMS_ALIAS_LEAD.length) {
                fail(`a fixed kms_alias name must carry a non-empty name after its ${JSON.stringify(KMS_ALIAS_LEAD)} lead (contract section 2), got ${quoted}`);
            }
            if (name.startsWith("alias/aws/")) {
                fail(`a fixed kms_alias name must not be in the alias/aws/ namespace (contract section 2), got ${quoted}`);
            }
        }
        if (resourceType === "log_group") {
            if (name.startsWith("aws/")) {
                fail(`a fixed log_group name must not begin with aws/ (contract section 3), got ${quoted}`);
            }
            else if (!isFixedLogGroupShape(name)) {
                fail(`a fixed log_group name must be either a section 3 log-source name (no "/") or the Lambda service path ${JSON.stringify(LAMBDA_LOG_GROUP_LEAD)} followed by a name that satisfies the lambda_function row (contract section 3), got ${quoted}`);
            }
        }
    }
    /**
     * Refuse two different logical resources in one naming context that derive the
     * same name in the same naming scope, and return the derived-name artifact
     * (contract section 11.4). A Lambda function and its IAM role may share a name
     * because their scopes differ, and two APIs may share one because AWS does not
     * keep API names unique. Rows keep the order of the entries.
     *
     * `logicalId` is the resource's identity inside the naming context: its
     * CloudFormation logical id, or the owning stack's construct path plus that
     * logical id when the context spans several stacks. A CloudFormation logical id
     * is unique only inside one template, so a caller that owns more than one
     * template must pass the qualified form; otherwise two resources in different
     * stacks with the same local logical id look like one re-declared resource
     * (SANITY-AT-N3-05). The returned row echoes the identity it was given.
     */
    static synthCheck(entries) {
        const seen = new Map();
        const artifact = [];
        for (const entry of entries) {
            const scope = AppTheoryResourceNaming.namingScope(entry.type);
            const generated = entry.generated === true;
            artifact.push({
                ...(entry.name !== undefined && !generated ? { name: entry.name } : {}),
                type: entry.type,
                scope,
                logicalId: entry.logicalId,
                ...(generated ? { generated: true } : {}),
            });
            if (scope === AppTheoryNamingScope.NOT_UNIQUE || generated)
                continue;
            const key = `${scope}\u0000${entry.type}\u0000${entry.name ?? ""}`;
            const held = seen.get(key);
            if (held !== undefined && held !== entry.logicalId) {
                fail(`${held} and ${entry.logicalId} derive ${entry.name ?? ""} in scope ${scope}`);
            }
            seen.set(key, entry.logicalId);
        }
        return artifact;
    }
    /**
     * The derived-name artifact as the cloud-assembly metadata document, with the
     * contract's snake_case wire keys and a deterministic entry order.
     */
    static derivedNamesJson(artifact) {
        const entries = [...artifact.entries]
            .map((entry) => ({
            ...(entry.name !== undefined && !entry.generated ? { name: entry.name } : {}),
            type: entry.type,
            scope: entry.scope,
            logical_id: entry.logicalId,
            ...(entry.generated ? { generated: true } : {}),
        }))
            .sort((a, b) => {
            const key = (row) => [row.scope, row.type, row.name ?? "", row.logical_id].join("\u0000");
            const left = key(a);
            const right = key(b);
            return left < right ? -1 : left > right ? 1 : 0;
        });
        return JSON.stringify({
            contract: artifact.contract,
            schema: artifact.schema,
            context: {
                namespace: artifact.context.namespace ?? LOG_PREFIX,
                app: artifact.context.app,
                stage: artifact.context.stage,
                account: artifact.context.account,
                region: artifact.context.region,
            },
            entries,
        });
    }
    /**
     * Validate one selector. Throws on a selector outside the grammar.
     */
    static validateSelector(selector) {
        const base = selector.endsWith("/*") ? selector.slice(0, -2) : selector;
        if (!LOGICAL_RE.test(base) || base.split("/")[0] !== "logs" || (base === "logs" && !selector.endsWith("/*"))) {
            fail(`selector ${selector}`);
        }
        if (base.includes("*"))
            fail("wildcard only as trailing /*");
    }
    /**
     * Whether a selector matches a logical source. A trailing `/*` matches
     * descendants only.
     */
    static selectorMatches(selector, logical) {
        if (selector.endsWith("/*"))
            return logical.startsWith(selector.slice(0, -1));
        return logical === selector;
    }
    /**
     * Whether a source is visible: an include matches and no exclude does.
     */
    static sourceVisible(rules, logical) {
        const included = (rules.include ?? []).some((selector) => AppTheoryResourceNaming.selectorMatches(selector, logical));
        if (!included)
            return false;
        return !(rules.exclude ?? []).some((selector) => AppTheoryResourceNaming.selectorMatches(selector, logical));
    }
    /**
     * The first 12 hex characters of SHA-256 over the canonical rules.
     */
    static ruleVersion(rules) {
        const canonical = `{"exclude":${JSON.stringify(sortedCopy(rules.exclude))},"include":${JSON.stringify(sortedCopy(rules.include))}}`;
        return sha256Hex(canonical).slice(0, 12);
    }
    /**
     * Compile the rules into the reader-role inline policy document. The return
     * value is the contract JSON, so a consumer can compare it byte for byte.
     */
    static compileVisibilityPolicyJson(values, rules) {
        for (const selector of [...(rules.include ?? []), ...(rules.exclude ?? [])]) {
            AppTheoryResourceNaming.validateSelector(selector);
        }
        const base = `arn:aws:logs:${values.region}:${values.account}:log-group:`;
        const arnsFor = (selector) => {
            if (selector.endsWith("/*")) {
                return [base + logPrefix(values) + selector.slice(0, -1).replace(/\//g, "_") + "*"];
            }
            const name = logPrefix(values) + selector.replace(/\//g, "_");
            return [base + name, base + name + ":*"];
        };
        const actions = [...KEEPER_ACTIONS_GROUP, ...KEEPER_ACTIONS_STREAM];
        const statements = [
            {
                Sid: "ReadManifest",
                Effect: "Allow",
                Action: ["ssm:GetParameter"],
                Resource: [
                    `arn:aws:ssm:${values.region}:${values.account}:parameter/${LOG_PREFIX}/visibility/${values.app}/${values.stage}/manifest`,
                ],
            },
        ];
        const included = sortedCopy(rules.include).flatMap(arnsFor);
        const excluded = sortedCopy(rules.exclude).flatMap(arnsFor);
        if (included.length > 0)
            statements.push({ Sid: "ReadIncluded", Effect: "Allow", Action: actions, Resource: included });
        if (excluded.length > 0)
            statements.push({ Sid: "DenyExcluded", Effect: "Deny", Action: actions, Resource: excluded });
        const document = JSON.stringify({ Version: "2012-10-17", Statement: statements });
        if (document.length > ROLE_POLICY_MAX)
            fail("compiled policy over role policy size");
        return document;
    }
    /**
     * Assemble the synth-time visibility preview.
     */
    static visibilityPreview(values, rules, sources) {
        AppTheoryResourceNaming.validateContext(values);
        for (const selector of [...(rules.include ?? []), ...(rules.exclude ?? [])]) {
            AppTheoryResourceNaming.validateSelector(selector);
        }
        return {
            ruleVersion: AppTheoryResourceNaming.ruleVersion(rules),
            matchedNow: sources.filter((source) => AppTheoryResourceNaming.sourceVisible(rules, source)).sort(),
            notMatchedNow: sources.filter((source) => !AppTheoryResourceNaming.sourceVisible(rules, source)).sort(),
            future: { include: sortedCopy(rules.include), exclude: sortedCopy(rules.exclude) },
        };
    }
    /**
     * Assemble the published manifest (the preview minus `notMatchedNow`).
     */
    static visibilityManifest(values, rules, sources) {
        const preview = AppTheoryResourceNaming.visibilityPreview(values, rules, sources);
        return { ruleVersion: preview.ruleVersion, matchedNow: preview.matchedNow, future: preview.future };
    }
    /**
     * Serialize a manifest to the contract JSON shape written to SSM.
     */
    static manifestJson(manifest) {
        return JSON.stringify({
            rule_version: manifest.ruleVersion,
            matched_now: manifest.matchedNow,
            future: { include: manifest.future.include ?? [], exclude: manifest.future.exclude ?? [] },
        });
    }
    /**
     * Keeper's read decision, in the runtimes' parameter order. Fails closed on a
     * denial or an unreachable account.
     */
    static keeperDecision(rules, logical, awsResult) {
        if (!rules || !AppTheoryResourceNaming.sourceVisible(rules, logical)) {
            return AppTheoryKeeperAnswer.NOT_SHARED;
        }
        if (awsResult === "events")
            return AppTheoryKeeperAnswer.EVENTS;
        if (awsResult === "empty" || awsResult === "not_found")
            return AppTheoryKeeperAnswer.ALLOWED_NO_EVENTS;
        return AppTheoryKeeperAnswer.NOT_SHARED;
    }
}
exports.AppTheoryResourceNaming = AppTheoryResourceNaming;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekM7O0dBRUc7QUFDVSxRQUFBLHdCQUF3QixHQUFHLGtDQUFrQyxDQUFDO0FBRTNFOztHQUVHO0FBQ1UsUUFBQSxvQkFBb0IsR0FBRyw0Q0FBNEMsQ0FBQztBQUVqRjs7O0dBR0c7QUFDVSxRQUFBLDBCQUEwQixHQUFHLHlDQUF5QyxDQUFDO0FBRXBGOztHQUVHO0FBQ0gsSUFBWSxzQkFTWDtBQVRELFdBQVksc0JBQXNCO0lBQ2hDOztPQUVHO0lBQ0gsNkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCwyQ0FBaUIsQ0FBQTtBQUNuQixDQUFDLEVBVFcsc0JBQXNCLHNDQUF0QixzQkFBc0IsUUFTakM7QUFFRDs7R0FFRztBQUNILElBQVksdUJBU1g7QUFURCxXQUFZLHVCQUF1QjtJQUNqQzs7T0FFRztJQUNILGdEQUFxQixDQUFBO0lBQ3JCOztPQUVHO0lBQ0gsNENBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBU2xDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHFCQWFYO0FBYkQsV0FBWSxxQkFBcUI7SUFDL0I7O09BRUc7SUFDSCwwQ0FBaUIsQ0FBQTtJQUNqQjs7T0FFRztJQUNILGdFQUF1QyxDQUFBO0lBQ3ZDOztPQUVHO0lBQ0gsa0RBQXlCLENBQUE7QUFDM0IsQ0FBQyxFQWJXLHFCQUFxQixxQ0FBckIscUJBQXFCLFFBYWhDO0FBa01EOztHQUVHO0FBQ0gsSUFBWSxvQkFhWDtBQWJELFdBQVksb0JBQW9CO0lBQzlCOztPQUVHO0lBQ0gsMkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCx5REFBaUMsQ0FBQTtJQUNqQzs7T0FFRztJQUNILGlEQUF5QixDQUFBO0FBQzNCLENBQUMsRUFiVyxvQkFBb0Isb0NBQXBCLG9CQUFvQixRQWEvQjtBQWdFRCxNQUFN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b2RlOmNyeXB0b1wiO1xuXG4vKipcbiAqIFRoZSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3QgdGhpcyBtb2R1bGUgaW1wbGVtZW50cy5cbiAqL1xuZXhwb3J0IGNvbnN0IFJFU09VUkNFX05BTUlOR19DT05UUkFDVCA9IFwidGhlb3J5Y2xvdWRfcmVzb3VyY2VfbmFtaW5nLnYwLjFcIjtcblxuLyoqXG4gKiBUaGUgc2NoZW1hIGlkZW50aWZpZXIgb2YgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBhIG5hbWluZyBjb250ZXh0IGVtaXRzLlxuICovXG5leHBvcnQgY29uc3QgREVSSVZFRF9OQU1FU19TQ0hFTUEgPSBcImFwcHRoZW9yeV9yZXNvdXJjZV9uYW1pbmcuZGVyaXZlZF9uYW1lcy52MVwiO1xuXG4vKipcbiAqIFRoZSBjbG91ZC1hc3NlbWJseSBtZXRhZGF0YSB0eXBlIHRoYXQgY2FycmllcyB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0LiBUaGVcbiAqIGFydGlmYWN0IGxhbmRzIGluIGB7c3RhY2t9Lm1ldGFkYXRhLmpzb25gIGluIGBjZGsub3V0YC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFUklWRURfTkFNRVNfTUVUQURBVEFfS0VZID0gXCJhcHB0aGVvcnk6cmVzb3VyY2UtbmFtaW5nL2Rlcml2ZWQtbmFtZXNcIjtcblxuLyoqXG4gKiBOYW1pbmcgcHJvZmlsZXMgYWNjZXB0ZWQgYnkgYSBuYW1pbmcgY29udGV4dC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZSB7XG4gIC8qKlxuICAgKiBOYW1lcyBkZXJpdmUgZnJvbSB0aGUgbmFtaW5nIGNvbnRleHQuXG4gICAqL1xuICBERVJJVkVEID0gXCJkZXJpdmVkXCIsXG4gIC8qKlxuICAgKiBFdmVyeSBuYW1lIGNvbWVzIGZyb20gYSBwaW4uXG4gICAqL1xuICBMRUdBQ1kgPSBcImxlZ2FjeVwiLFxufVxuXG4vKipcbiAqIExvZ2dpbmcgcHJvZmlsZXMgYWNjZXB0ZWQgYnkgYSBuYW1pbmcgY29udGV4dC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUge1xuICAvKipcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgc3RhbmRhcmQgbG9nIGdyb3VwcyBhbmQgYWNjZXNzIGxvZ2dpbmcuXG4gICAqL1xuICBTVEFOREFSRCA9IFwic3RhbmRhcmRcIixcbiAgLyoqXG4gICAqIEVhY2ggY29uc3RydWN0IGtlZXBzIGl0cyBwcmUtY29udHJhY3QgbG9nZ2luZyBiZWhhdmlvdXIuXG4gICAqL1xuICBMRUdBQ1kgPSBcImxlZ2FjeVwiLFxufVxuXG4vKipcbiAqIEtlZXBlcidzIGFuc3dlciB0byBhIHJlYWRlciByZXF1ZXN0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIge1xuICAvKipcbiAgICogVGhlIHNvdXJjZSBpcyBzaGFyZWQgYW5kIHRoZSByZWFkIHJldHVybmVkIGV2ZW50cy5cbiAgICovXG4gIEVWRU5UUyA9IFwiZXZlbnRzXCIsXG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIHNoYXJlZCBhbmQgdGhlIHJlYWQgcmV0dXJuZWQgbm8gZXZlbnRzLlxuICAgKi9cbiAgQUxMT1dFRF9OT19FVkVOVFMgPSBcImFsbG93ZWRfbm9fZXZlbnRzXCIsXG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIG5vdCBzaGFyZWQsIG9yIHRoZSByZWFkIGZhaWxlZCBjbG9zZWQuXG4gICAqL1xuICBOT1RfU0hBUkVEID0gXCJub3Rfc2hhcmVkXCIsXG59XG5cbi8qKlxuICogQm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQgdmFsdWVzIGZyb20gc3RhZ2UgY29uZmlnLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMge1xuICAvKipcbiAgICogTmFtZXNwYWNlIHNlZ21lbnQuXG4gICAqIEBkZWZhdWx0IFwidGhlb3J5Y2xvdWRcIlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZXNwYWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBcHAgaW5zdGFuY2UgaWQuXG4gICAqL1xuICByZWFkb25seSBhcHA6IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgaWQuXG4gICAqL1xuICByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZC4gQW4gdW5yZXNvbHZlZCB0b2tlbiBmYWlscyBzeW50aGVzaXMuXG4gICAqL1xuICByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUsIGZvciBleGFtcGxlIGB1cy1lYXN0LTFgLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKiBAZGVmYXVsdCB7fVxuICAgKi9cbiAgcmVhZG9ubHkgcGlucz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlZC1uYW1lIGVudHJpZXMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLiBBbiBlbnRyeSBtZWFuc1xuICAgKiBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgdG9kYXksIHNvIHRoZSBjb25zdHJ1Y3Qgc2V0cyBub1xuICAgKiBwaHlzaWNhbC1uYW1lIHByb3BlcnR5LiBWYWxpZCBvbmx5IHVuZGVyIHRoZSBsZWdhY3kgbmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nUHJvZmlsZT86IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZ2dpbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuTEVHQUNZXG4gICAqL1xuICByZWFkb25seSBsb2dnaW5nUHJvZmlsZT86IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2cgcmV0ZW50aW9uIGluIGRheXMgZm9yIHN0YW5kYXJkLXByb2ZpbGUgbG9nIGdyb3Vwcy5cbiAgICogQGRlZmF1bHQgMzBcbiAgICovXG4gIHJlYWRvbmx5IHJldGVudGlvbkRheXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogVGhlIGNvbXBvc2VkIHBoeXNpY2FsIG5hbWUgb2Ygb25lIHJlc291cmNlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVBoeXNpY2FsTmFtZSB7XG4gIC8qKlxuICAgKiBUaGUgZnVsbCBwaHlzaWNhbCBuYW1lLiBBYnNlbnQgd2hlbiBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFjY291bnQtcmVnaW9uYWwgYnVja2V0LW5hbWUgcHJlZml4LCB3aGVuIHRoZSB0eXBlIHVzZXMgb25lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGJ1Y2tldE5hbWVQcmVmaXg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBidWNrZXQgbmFtZXNwYWNlLCB3aGVuIHRoZSB0eXBlIHVzZXMgb25lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGJ1Y2tldE5hbWVzcGFjZT86IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgbmFtZSBjYW1lIGZyb20gYSBwaW4uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBwaW5uZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSwgc28gbm8gcGh5c2ljYWwtbmFtZSBwcm9wZXJ0eSBpc1xuICAgKiBzZXQuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9uZSBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlIGEgc3RhY2sgZGVjbGFyZXMsIGFzIHRoZSBzeW50aCBjaGVjayAoY29udHJhY3RcbiAqIHNlY3Rpb24gMTEuNCkgY29uc3VtZXMgaXQuIEEgZ2VuZXJhdGVkIGVudHJ5IGNhcnJpZXMgbm8gbmFtZTogQ2xvdWRGb3JtYXRpb25cbiAqIG93bnMgdGhlIG5hbWUsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gcmVzZXJ2ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlEZXJpdmVkTmFtZUlucHV0IHtcbiAgLyoqXG4gICAqIFRoZSBwaHlzaWNhbCBuYW1lLiBBYnNlbnQgZm9yIGEgZ2VuZXJhdGVkIGVudHJ5LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBjb250cmFjdCByZXNvdXJjZSB0eXBlLCBmb3IgZXhhbXBsZSBgbGFtYmRhX2Z1bmN0aW9uYC5cbiAgICovXG4gIHJlYWRvbmx5IHR5cGU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIENsb3VkRm9ybWF0aW9uIGxvZ2ljYWwgaWQgb2YgdGhlIHJlc291cmNlIGNhcnJ5aW5nIHRoZSBuYW1lLCBvciDigJQgd2hlblxuICAgKiB0aGUgY2FsbGVyJ3MgbmFtaW5nIGNvbnRleHQgc3BhbnMgc2V2ZXJhbCBzdGFja3Mg4oCUIHRoZSBvd25pbmcgc3RhY2snc1xuICAgKiBjb25zdHJ1Y3QgcGF0aCBwbHVzIHRoYXQgbG9naWNhbCBpZCwgYmVjYXVzZSBhIGxvZ2ljYWwgaWQgaXMgdW5pcXVlIG9ubHlcbiAgICogd2l0aGluIG9uZSB0ZW1wbGF0ZS5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxJZDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSwgc28gbm90aGluZyBpcyByZXNlcnZlZC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogT25lIHJvdyBvZiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0OiB0aGUgY29tcGxldGUgc2V0IHRoZSBuYW1lIHJlc2VydmF0aW9uXG4gKiBpbmRleCAoY29udHJhY3Qgc2VjdGlvbiAxMS4yKSByZXNlcnZlcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlEZXJpdmVkTmFtZSB7XG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWwgbmFtZS4gQWJzZW50IGZvciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJhY3QgcmVzb3VyY2UgdHlwZS5cbiAgICovXG4gIHJlYWRvbmx5IHR5cGU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHNjb3BlIGluIHdoaWNoIEFXUyByZXF1aXJlcyB0aGUgbmFtZSB0byBiZSB1bmlxdWU6IGBhY2NvdW50YCxcbiAgICogYGFjY291bnRfcmVnaW9uYCwgb3IgYG5vdF91bmlxdWVgLlxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIENsb3VkRm9ybWF0aW9uIGxvZ2ljYWwgaWQgb2YgdGhlIHJlc291cmNlIGNhcnJ5aW5nIHRoZSBuYW1lLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbElkOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lLCBzbyBub3RoaW5nIGlzIHJlc2VydmVkLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBUaGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGEgbmFtaW5nIGNvbnRleHQgZW1pdHMgYXQgc3ludGhlc2lzIChjb250cmFjdFxuICogc2VjdGlvbiAxMS40KSwga2V5ZWQgYHtzdGFja30ubWV0YWRhdGEuanNvbmAgaW4gdGhlIGNsb3VkIGFzc2VtYmx5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeURlcml2ZWROYW1lcyB7XG4gIC8qKlxuICAgKiBUaGUgY29udHJhY3QgaWRlbnRpZmllci5cbiAgICovXG4gIHJlYWRvbmx5IGNvbnRyYWN0OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBhcnRpZmFjdCBzY2hlbWEgaWRlbnRpZmllci5cbiAgICovXG4gIHJlYWRvbmx5IHNjaGVtYTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbmFtaW5nIGNvbnRleHQgdGhhdCBwcm9kdWNlZCB0aGUgYXJ0aWZhY3QuXG4gICAqL1xuICByZWFkb25seSBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzO1xuXG4gIC8qKlxuICAgKiBFdmVyeSBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlIHRoZSBjb250ZXh0IGRlY2xhcmVzLCBzb3J0ZWQgYnkgYHNjb3BlYCxcbiAgICogYHR5cGVgLCBgbmFtZWAgYW5kIGBsb2dpY2FsSWRgLlxuICAgKi9cbiAgcmVhZG9ubHkgZW50cmllczogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtaW5nIHNjb3BlcyBvZiBjb250cmFjdCBzZWN0aW9uIDExLjEuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU5hbWluZ1Njb3BlIHtcbiAgLyoqXG4gICAqIEFXUyBrZWVwcyB0aGUgbmFtZSB1bmlxdWUgYWNyb3NzIHRoZSB3aG9sZSBhY2NvdW50LCB3aGF0ZXZlciB0aGUgUmVnaW9uLlxuICAgKi9cbiAgQUNDT1VOVCA9IFwiYWNjb3VudFwiLFxuICAvKipcbiAgICogQVdTIGtlZXBzIHRoZSBuYW1lIHVuaXF1ZSBwZXIgYWNjb3VudCBhbmQgUmVnaW9uLlxuICAgKi9cbiAgQUNDT1VOVF9SRUdJT04gPSBcImFjY291bnRfcmVnaW9uXCIsXG4gIC8qKlxuICAgKiBBV1MgZG9lcyBub3Qga2VlcCB0aGUgbmFtZSB1bmlxdWUsIHNvIG5vdGhpbmcgaXMgcmVzZXJ2ZWQgZm9yIGl0LlxuICAgKi9cbiAgTk9UX1VOSVFVRSA9IFwibm90X3VuaXF1ZVwiLFxufVxuXG4vKipcbiAqIEluY2x1ZGUgYW5kIGV4Y2x1ZGUgdmlzaWJpbGl0eSBzZWxlY3RvcnMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzIHtcbiAgLyoqXG4gICAqIFNlbGVjdG9ycyB3aG9zZSBzb3VyY2VzIGFyZSBzaGFyZWQuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBpbmNsdWRlPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFNlbGVjdG9ycyB3aG9zZSBzb3VyY2VzIGFyZSBuZXZlciBzaGFyZWQuIEV4Y2x1c2lvbnMgd2luLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZXhjbHVkZT86IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIFRoZSBzeW50aC10aW1lIHZpc2liaWxpdHkgcHJldmlldy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gIC8qKlxuICAgKiBGaXJzdCAxMiBoZXggY2hhcmFjdGVycyBvZiB0aGUgY2Fub25pY2FsIHJ1bGVzIGhhc2guXG4gICAqL1xuICByZWFkb25seSBydWxlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgZG8gbm90IHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbm90TWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBzZWxlY3RvcnMsIGFzIHRoZSBzdGF0ZW1lbnQgb2Ygd2hhdCBmdXR1cmUgc291cmNlcyB3aWxsIG1hdGNoLlxuICAgKi9cbiAgcmVhZG9ubHkgZnV0dXJlOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXM7XG59XG5cbi8qKlxuICogVGhlIHB1Ymxpc2hlZCBTU00gbWFuaWZlc3Q6IHRoZSBwcmV2aWV3IG1pbnVzIGBub3RNYXRjaGVkTm93YC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3Qge1xuICAvKipcbiAgICogRmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgdGhlIGNhbm9uaWNhbCBydWxlcyBoYXNoLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgc2VsZWN0b3JzLCBhcyB0aGUgc3RhdGVtZW50IG9mIHdoYXQgZnV0dXJlIHNvdXJjZXMgd2lsbCBtYXRjaC5cbiAgICovXG4gIHJlYWRvbmx5IGZ1dHVyZTogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xufVxuXG5jb25zdCBTRUdNRU5UX1BBVFRFUk4gPSBcIlthLXowLTldKyg/Oi1bYS16MC05XSspKlwiO1xuY29uc3QgTE9HSUNBTF9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0oPzovJHtTRUdNRU5UX1BBVFRFUk59KSokYCk7XG5jb25zdCBBUFBfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59JGApO1xuY29uc3QgU1RBR0VfUkUgPSAvXlthLXpdW2EtejAtOV17MCw3fSQvO1xuY29uc3QgTkFNRVNQQUNFX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSRgKTtcbmNvbnN0IEFDQ09VTlRfUkUgPSAvXlswLTldezEyfSQvO1xuY29uc3QgUkVHSU9OX1JFID0gL15bYS16XXsyfSg/Oi1bYS16XSspKy1bMC05XSQvO1xuY29uc3QgU0VDUkVUX1RBSUxfUkUgPSAvLVtBLVphLXowLTldezZ9JC87XG5jb25zdCBTM19FREdFU19SRSA9IC9eW2EtejAtOV0uKlthLXowLTldJC87XG5jb25zdCBMT0dfUFJFRklYID0gXCJ0aGVvcnljbG91ZFwiO1xuY29uc3QgUk9MRV9QT0xJQ1lfTUFYID0gMTAyNDA7XG5jb25zdCBCQVNFMzIgPSBcImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MjM0NTY3XCI7XG5cbmludGVyZmFjZSBSdWxlIHtcbiAgcmVhZG9ubHkga2luZDogXCJkYXNoXCIgfCBcInBhdGhcIiB8IFwiczNhclwiIHwgXCJsb2dcIjtcbiAgcmVhZG9ubHkgbWF4OiBudW1iZXI7XG4gIC8qKlxuICAgKiBUaGUgbG93ZXIgYm91bmQgY29udHJhY3Qgc2VjdGlvbiAyIHN0YXRlcyBmb3IgdGhlIHR5cGUsIHdoZW4gaXQgc3RhdGVzIG9uZS5cbiAgICogQSByb3cgdGhhdCBzdGF0ZXMgb25seSBhbiB1cHBlciBsaW1pdCBoYXMgbm9uZSBoZXJlLCBzbyB0aGUgdGFibGUgc3RheXMgdGhlXG4gICAqIHNlY3Rpb24gMiB0YWJsZSBhbmQgbm90IGEgc3RyaWN0ZXIgcHJpdmF0ZSBvbmUuXG4gICAqL1xuICByZWFkb25seSBtaW4/OiBudW1iZXI7XG4gIHJlYWRvbmx5IGNoYXJzZXQ6IHN0cmluZztcbiAgcmVhZG9ubHkgbGVhZD86IHN0cmluZztcbn1cblxuY29uc3QgUlVMRVM6IHsgW3R5cGU6IHN0cmluZ106IFJ1bGUgfSA9IHtcbiAgczNfYnVja2V0OiB7IGtpbmQ6IFwiczNhclwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIHMzX3ZlY3Rvcl9idWNrZXQ6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgczNfdmVjdG9yX2luZGV4OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIC8vIFNlY3Rpb24gMjogXCIyNTUgKHBsYWluLW5hbWUgbGltaXQgM+KAkzI1NTsgdGhlIDEwMjQgbGltaXQgYXBwbGllcyB0byB0aGUgQVJOXG4gIC8vIGZvcm0pXCIuIFRoZSBsb3dlciBib3VuZCBpcyBwYXJ0IG9mIHRoZSByb3csIHNvIGEgZml4ZWQgbmFtZSBvZiBvbmUgb3IgdHdvXG4gIC8vIGNoYXJhY3RlcnMgaXMgcmVmdXNlZCAoU0FOSVRZLUFULU4zLTA4KS5cbiAgZHluYW1vZGJfdGFibGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU1LCBtaW46IDMsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8uLV1cIiB9LFxuICBsYW1iZGFfZnVuY3Rpb246IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIHNxc19xdWV1ZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA4MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc25zX3RvcGljOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc2VjcmV0OiB7IGtpbmQ6IFwicGF0aFwiLCBtYXg6IDUxMiwgY2hhcnNldDogXCJbQS1aYS16MC05L18rPS5ALV1cIiB9LFxuICBzc21fcGFyYW1ldGVyOiB7IGtpbmQ6IFwicGF0aFwiLCBtYXg6IDkwMCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4vLV1cIiwgbGVhZDogXCIvXCIgfSxcbiAga21zX2FsaWFzOiB7IGtpbmQ6IFwicGF0aFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05L18tXVwiLCBsZWFkOiBcImFsaWFzL1wiIH0sXG4gIGV2ZW50X2J1czogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTYsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBldmVudF9ydWxlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkuXy1dXCIgfSxcbiAgc2NoZWR1bGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBhbGFybTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8uLV1cIiB9LFxuICBkYXNoYm9hcmQ6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU1LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBpYW1fcm9sZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Kz0sLkBfLV1cIiB9LFxuICBpYW1fbWFuYWdlZF9wb2xpY3k6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTI4LCBjaGFyc2V0OiBcIltBLVphLXowLTkrPSwuQF8tXVwiIH0sXG4gIHN0YXRlX21hY2hpbmU6IHsga2luZDogXCJkYXNoXCIsIG1heDogODAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGNvZGVidWlsZF9wcm9qZWN0OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDE1MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgYXBpX3Jlc3Q6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTI4LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfaHR0cDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV93ZWJzb2NrZXQ6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTI4LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBsb2dfZGVsaXZlcnlfc291cmNlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBsb2dfZGVsaXZlcnlfZGVzdGluYXRpb246IHsga2luZDogXCJkYXNoXCIsIG1heDogNjAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19ncm91cDogeyBraW5kOiBcImxvZ1wiLCBtYXg6IDUxMiwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbn07XG5cbi8qKlxuICogVGhlIHJ1bGVzIG9mIG9uZSBjb250cmFjdCB0eXBlLCBvciBgdW5kZWZpbmVkYCB3aGVuIHRoZSBjb250cmFjdCBzdGF0ZXMgbm9uZVxuICogKGNvbnRyYWN0IHNlY3Rpb24gMikuIFRoZSBsb29rdXAgaXMgYW4gb3duLXByb3BlcnR5IGNoZWNrLCBzbyBhbiBpbmhlcml0ZWRcbiAqIG5hbWUgc3VjaCBhcyBgY29uc3RydWN0b3JgLCBgdG9TdHJpbmdgLCBgX19wcm90b19fYCBvciBgaGFzT3duUHJvcGVydHlgIGlzIGFuXG4gKiB1bmtub3duIHR5cGUsIG5ldmVyIGEgdHlwZSB3aXRoIHJ1bGVzLlxuICovXG5mdW5jdGlvbiBuYW1pbmdSdWxlKHJlc291cmNlVHlwZTogc3RyaW5nKTogUnVsZSB8IHVuZGVmaW5lZCB7XG4gIGlmICghT2JqZWN0Lmhhc093bihSVUxFUywgcmVzb3VyY2VUeXBlKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIFJVTEVTW3Jlc291cmNlVHlwZV07XG59XG5cbi8qKlxuICogQVBJIG5hbWUgdHlwZXMuIFRoZSBDREsgZGVmYXVsdHMgYW4gQVBJIE5hbWUgdG9kYXksIHNvIGEgbmFtZSBmb3Igb25lIGlzXG4gKiBleHBsaWNpdCBhbmQgdGFrZXMgYSBwaW4sIG5ldmVyIGEgZ2VuZXJhdGVkIGVudHJ5IChyMywgQURWLTEzMTItMykuXG4gKi9cbmNvbnN0IEFQSV9UWVBFUyA9IG5ldyBTZXQoW1wiYXBpX3Jlc3RcIiwgXCJhcGlfaHR0cFwiLCBcImFwaV93ZWJzb2NrZXRcIl0pO1xuXG4vKipcbiAqIFR5cGVzIHdob3NlIHNlY3Rpb24gMiByb3cgYWRkcyB0aGUgUzMgc3RhcnQvZW5kLWFscGhhbnVtZXJpYyBydWxlLlxuICovXG5jb25zdCBTM19UWVBFUyA9IG5ldyBTZXQoW1wiczNfYnVja2V0XCIsIFwiczNfdmVjdG9yX2J1Y2tldFwiLCBcInMzX3ZlY3Rvcl9pbmRleFwiXSk7XG5cbi8qKlxuICogVHlwZXMgd2hvc2UgZml4ZWQtbmFtZSBjaGFyc2V0IGRpZmZlcnMgZnJvbSB0aGUgZGVyaXZlZC1uYW1lIGNoYXJzZXQgb2YgdGhlaXJcbiAqIHNlY3Rpb24gMiByb3cuIEEgbG9nIGdyb3VwIGlzIHRoZSBvbmx5IG9uZTogb25lIG9mIGl0cyB0d28gZml4ZWQgc2hhcGVzIGlzIHRoZVxuICogTGFtYmRhIHNlcnZpY2UgcGF0aCBgL2F3cy9sYW1iZGEve2Z1bmN0aW9uIG5hbWV9YCAoc2VjdGlvbiAzKSwgc28gYC9gIGlzIHBhcnRcbiAqIG9mIHRoZSBjaGFyc2V0IGV2ZW4gdGhvdWdoIG5vIGRlcml2ZWQgbG9nLWdyb3VwIG5hbWUgY29udGFpbnMgb25lLiBUaGUgc2hhcGVcbiAqIHJ1bGUgYmVsb3cgaXMgd2hhdCBuYXJyb3dzIGl0IGFnYWluOiBldmVyeSBvdGhlciBgL2AtYmVhcmluZyBsb2cgZ3JvdXAgaXNcbiAqIHJlZnVzZWQuXG4gKi9cbmNvbnN0IEZJWEVEX05BTUVfQ0hBUlNFVFMgPSBuZXcgTWFwKFtbXCJsb2dfZ3JvdXBcIiwgXCJbQS1aYS16MC05Xy8tXVwiXV0pO1xuXG4vKipcbiAqIFRoZSBMYW1iZGEgc2VydmljZSBsb2ctZ3JvdXAgcGF0aCBsZWFkIChjb250cmFjdCBzZWN0aW9uIDMpLlxuICovXG5jb25zdCBMQU1CREFfTE9HX0dST1VQX0xFQUQgPSBcIi9hd3MvbGFtYmRhL1wiO1xuXG4vKipcbiAqIFRoZSBLTVMgYWxpYXMgcGF0aCBsZWFkIChjb250cmFjdCBzZWN0aW9uIDIpLlxuICovXG5jb25zdCBLTVNfQUxJQVNfTEVBRCA9IFwiYWxpYXMvXCI7XG5cbi8qKlxuICogQW4gYWJzb2x1dGUgU1NNIHBhcmFtZXRlciBwYXRoOiBhIGxlYWQgYC9gLCB0aGVuIGF0IGxlYXN0IG9uZSBub24tZW1wdHlcbiAqIHNlZ21lbnQsIHdpdGggbm8gZW1wdHkgc2VnbWVudCBhbnl3aGVyZSAoY29udHJhY3Qgc2VjdGlvbiAyKS5cbiAqL1xuY29uc3QgU1NNX1BBVEhfUkUgPSAvXlxcL1teL10rKD86XFwvW14vXSspKiQvO1xuXG4vKipcbiAqIFdoZXRoZXIgYSBmaXhlZCBsb2ctZ3JvdXAgbmFtZSBpcyBvbmUgb2YgdGhlIHR3byBzaGFwZXMgY29udHJhY3Qgc2VjdGlvbiAzXG4gKiBzdGF0ZXMsIGFuZCBub3RoaW5nIGVsc2U6XG4gKlxuICogLSBhIGxvZy1zb3VyY2UgbmFtZSwgYHRoZW9yeWNsb3VkX3tuYW1lc3BhY2V9X3thcHB9X3tzdGFnZX1fe2xvZ2ljYWx9YC4gSXRzXG4gKiAgIHNlZ21lbnRzIGFyZSBqb2luZWQgd2l0aCBgX2AgcHJlY2lzZWx5IHNvIHRoZSBvbmUgZ3JhbW1hciBhbHNvIHNhdGlzZmllc1xuICogICBDbG91ZEZyb250J3MgYFtcXHctXWAgZGVzdGluYXRpb24sIHNvIHN1Y2ggYSBuYW1lIGNhcnJpZXMgbm8gYC9gIGF0IGFsbDtcbiAqIC0gdGhlIExhbWJkYSBzZXJ2aWNlIHBhdGggYC9hd3MvbGFtYmRhL3tmdW5jdGlvbiBuYW1lfWAsIHdob3NlIGZ1bmN0aW9uIG5hbWVcbiAqICAgc2F0aXNmaWVzIHRoZSBgbGFtYmRhX2Z1bmN0aW9uYCByb3cgb2Ygc2VjdGlvbiAyIChsZW5ndGggYW5kIGNoYXJzZXQpLlxuICpcbiAqIEFueSBvdGhlciBgL2AtYmVhcmluZyBuYW1lIGlzIHJlZnVzZWQ6IGBhcmJpdHJhcnkvcGF0aGAgaXMgbmVpdGhlciBzaGFwZVxuICogKFNBTklUWS1BVC1OMy0wOCkuXG4gKi9cbmZ1bmN0aW9uIGlzRml4ZWRMb2dHcm91cFNoYXBlKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIW5hbWUuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKCFuYW1lLnN0YXJ0c1dpdGgoTEFNQkRBX0xPR19HUk9VUF9MRUFEKSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBmdW5jdGlvbk5hbWUgPSBuYW1lLnNsaWNlKExBTUJEQV9MT0dfR1JPVVBfTEVBRC5sZW5ndGgpO1xuICBjb25zdCBsYW1iZGEgPSBSVUxFUy5sYW1iZGFfZnVuY3Rpb247XG4gIGlmIChmdW5jdGlvbk5hbWUubGVuZ3RoID4gbGFtYmRhLm1heCkgcmV0dXJuIGZhbHNlO1xuICBpZiAobGFtYmRhLm1pbiAhPT0gdW5kZWZpbmVkICYmIGZ1bmN0aW9uTmFtZS5sZW5ndGggPCBsYW1iZGEubWluKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBuZXcgUmVnRXhwKGBeKD86JHtsYW1iZGEuY2hhcnNldH0pKyRgKS50ZXN0KGZ1bmN0aW9uTmFtZSk7XG59XG5cbi8qKlxuICogVHlwZXMgQVdTIGtlZXBzIHVuaXF1ZSBhY3Jvc3MgUmVnaW9ucyAoY29udHJhY3Qgc2VjdGlvbiAxMS4xKS5cbiAqL1xuY29uc3QgQUNDT1VOVF9HTE9CQUxfVFlQRVMgPSBuZXcgU2V0KFtcImlhbV9yb2xlXCIsIFwiaWFtX21hbmFnZWRfcG9saWN5XCIsIFwiZGFzaGJvYXJkXCJdKTtcblxuLyoqXG4gKiBBUEkgZGlzcGxheSBuYW1lcyBBV1MgZG9lcyBub3Qga2VlcCB1bmlxdWUsIHNvIG5vdGhpbmcgaXMgcmVzZXJ2ZWQgZm9yIHRoZW0uXG4gKi9cbmNvbnN0IE5PVF9VTklRVUVfVFlQRVMgPSBuZXcgU2V0KFtcImFwaV9yZXN0XCIsIFwiYXBpX2h0dHBcIiwgXCJhcGlfd2Vic29ja2V0XCJdKTtcblxuLyoqXG4gKiBUaGUgcmVmdXNhbCBmb3IgYSB0eXBlIHRoZSBjb250cmFjdCBzdGF0ZXMgbm8gbmFtaW5nIHNjb3BlIGZvcjogaXQgY2Fubm90IGJlXG4gKiByZXNlcnZlZCwgc28gaXQgY2Fubm90IGJlIGRlcGxveWVkIHRocm91Z2ggdGhlIGluZGV4IHVudGlsIGEgcmV2aXNpb24gc3RhdGVzXG4gKiBpdHMgc2NvcGUuXG4gKi9cbmNvbnN0IFVOS05PV05fTkFNSU5HX1NDT1BFID0gXCJhIHR5cGUgd2l0aCBubyBzdGF0ZWQgbmFtaW5nIHNjb3BlIGNhbm5vdCBiZSByZXNlcnZlZFwiO1xuXG5jb25zdCBLRUVQRVJfQUNUSU9OU19HUk9VUCA9IFtcImxvZ3M6RmlsdGVyTG9nRXZlbnRzXCIsIFwibG9nczpEZXNjcmliZUxvZ1N0cmVhbXNcIl07XG5jb25zdCBLRUVQRVJfQUNUSU9OU19TVFJFQU0gPSBbXCJsb2dzOkdldExvZ0V2ZW50c1wiXTtcblxuZnVuY3Rpb24gZmFpbChtZXNzYWdlOiBzdHJpbmcpOiBuZXZlciB7XG4gIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gc2hhMjU2SGV4KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZSh0ZXh0LCBcInV0ZjhcIikuZGlnZXN0KFwiaGV4XCIpO1xufVxuXG5mdW5jdGlvbiBiYXNlMzJMb3dlcih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBieXRlcyA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHRleHQsIFwidXRmOFwiKS5kaWdlc3QoKTtcbiAgbGV0IGJpdHMgPSAwO1xuICBsZXQgdmFsdWUgPSAwO1xuICBsZXQgb3V0ID0gXCJcIjtcbiAgZm9yIChjb25zdCBieXRlIG9mIGJ5dGVzKSB7XG4gICAgdmFsdWUgPSAodmFsdWUgPDwgOCkgfCBieXRlO1xuICAgIGJpdHMgKz0gODtcbiAgICB3aGlsZSAoYml0cyA+PSA1KSB7XG4gICAgICBvdXQgKz0gQkFTRTMyWyh2YWx1ZSA+Pj4gKGJpdHMgLSA1KSkgJiAzMV07XG4gICAgICBiaXRzIC09IDU7XG4gICAgfVxuICB9XG4gIGlmIChiaXRzID4gMCkgb3V0ICs9IEJBU0UzMlsodmFsdWUgPDwgKDUgLSBiaXRzKSkgJiAzMV07XG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIHNob3J0ZW4oZnVsbDogc3RyaW5nLCBsaW1pdDogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKGZ1bGwubGVuZ3RoIDw9IGxpbWl0KSByZXR1cm4gZnVsbDtcbiAgY29uc3QgaGVhZCA9IGZ1bGwuc2xpY2UoMCwgbGltaXQgLSA5KS5yZXBsYWNlKC9bLV8uL10rJC8sIFwiXCIpO1xuICByZXR1cm4gYCR7aGVhZH0tJHtiYXNlMzJMb3dlcihmdWxsKS5zbGljZSgwLCA4KX1gO1xufVxuXG5mdW5jdGlvbiBuYW1lc3BhY2VPZih2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWVzLm5hbWVzcGFjZSA/PyBMT0dfUFJFRklYO1xufVxuXG5mdW5jdGlvbiBzb3J0ZWRDb3B5KHZhbHVlczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbLi4ubmV3IFNldCh2YWx1ZXMgPz8gW10pXS5zb3J0KCk7XG59XG5cbmZ1bmN0aW9uIGxvZ1ByZWZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gW0xPR19QUkVGSVgsIG5hbWVzcGFjZU9mKHZhbHVlcyksIHZhbHVlcy5hcHAsIHZhbHVlcy5zdGFnZV0uam9pbihcIl9cIikgKyBcIl9cIjtcbn1cblxuLyoqXG4gKiBUaGUgYHRoZW9yeWNsb3VkX3Jlc291cmNlX25hbWluZy52MC4xYCBwcmltaXRpdmVzLCBleHBvc2VkIGZvciBqc2lpIHNvIHRoZSBHb1xuICogYW5kIFB5dGhvbiBDREsgYmluZGluZ3Mgc2hhcmUgb25lIGltcGxlbWVudGF0aW9uLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcge1xuICBwcml2YXRlIGNvbnN0cnVjdG9yKCkge31cblxuICAvKipcbiAgICogVmFsaWRhdGUgdGhlIGJvdW5kIGNvbnRleHQgZ3JhbW1hci4gVGhyb3dzIG9uIGFuIGludmFsaWQgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVDb250ZXh0KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHZvaWQge1xuICAgIGlmICghQVBQX1JFLnRlc3QodmFsdWVzLmFwcCkpIGZhaWwoXCJhcHBcIik7XG4gICAgaWYgKCFTVEFHRV9SRS50ZXN0KHZhbHVlcy5zdGFnZSkpIGZhaWwoXCJzdGFnZVwiKTtcbiAgICBpZiAoIUFDQ09VTlRfUkUudGVzdCh2YWx1ZXMuYWNjb3VudCkpIGZhaWwoXCJhY2NvdW50XCIpO1xuICAgIGlmICghUkVHSU9OX1JFLnRlc3QodmFsdWVzLnJlZ2lvbikpIGZhaWwoXCJyZWdpb25cIik7XG4gICAgaWYgKCFOQU1FU1BBQ0VfUkUudGVzdChuYW1lc3BhY2VPZih2YWx1ZXMpKSkgZmFpbChcIm5hbWVzcGFjZVwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgQ2xvdWRGb3JtYXRpb24tYXBwZW5kZWQgYWNjb3VudC1yZWdpb25hbCBidWNrZXQgc3VmZml4LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzM0FjY291bnRSZWdpb25hbFN1ZmZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICAgIHJldHVybiBgLSR7dmFsdWVzLmFjY291bnR9LSR7dmFsdWVzLnJlZ2lvbn0tYW5gO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBib3VuZCBwcmVmaXggc2hhcmVkIGJ5IGV2ZXJ5IGxvZyBzb3VyY2Ugb2YgdGhlIGFwcC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbG9nU291cmNlUHJlZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGxvZ1ByZWZpeCh2YWx1ZXMpO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hcCBhIGxvZ2ljYWwgbG9nIHNvdXJjZSB0byBpdHMgcGh5c2ljYWwgbG9nLWdyb3VwIG5hbWUuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGxvZ0dyb3VwTmFtZSh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsIGxvZ2ljYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKCFsb2dpY2FsLnN0YXJ0c1dpdGgoXCJsb2dzL1wiKSkgZmFpbChcImxvZyBsb2dpY2FsIG11c3Qgc3RhcnQgd2l0aCBsb2dzL1wiKTtcbiAgICByZXR1cm4gbG9nUHJlZml4KHZhbHVlcykgKyBsb2dpY2FsLnJlcGxhY2UoL1xcLy9nLCBcIl9cIik7XG4gIH1cblxuICAvKipcbiAgICogQ29tcG9zZSB0aGUgcGh5c2ljYWwgbmFtZSBvZiBvbmUgcmVzb3VyY2UuIEEgcGluIGFsd2F5cyB3aW5zLiBBIGdlbmVyYXRlZFxuICAgKiBlbnRyeSBtZWFucyBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgdG9kYXkgYW5kIHRoZSBjb25zdHJ1Y3Qgc2V0c1xuICAgKiBubyBwaHlzaWNhbC1uYW1lIHByb3BlcnR5LiBHZW5lcmF0ZWQgZW50cmllcyBhcmUgbGVnYWN5LW9ubHk7IGEgbGVnYWN5XG4gICAqIHByb2ZpbGUgbmVlZHMgZXhhY3RseSBvbmUgb2YgYSBwaW4gb3IgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHBoeXNpY2FsTmFtZShcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcmVzb3VyY2VUeXBlOiBzdHJpbmcsXG4gICAgbG9naWNhbDogc3RyaW5nLFxuICApOiBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh2YWx1ZXMpO1xuICAgIGlmICghTE9HSUNBTF9SRS50ZXN0KGxvZ2ljYWwpKSBmYWlsKFwibG9naWNhbFwiKTtcbiAgICBjb25zdCBydWxlID0gbmFtaW5nUnVsZShyZXNvdXJjZVR5cGUpO1xuICAgIGlmICghcnVsZSkgZmFpbChgcmVzb3VyY2UgdHlwZSAke3Jlc291cmNlVHlwZX1gKTtcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSB2YWx1ZXMuZ2VuZXJhdGVkID8/IFtdO1xuICAgIGNvbnN0IGxlZ2FjeSA9ICh2YWx1ZXMubmFtaW5nUHJvZmlsZSA/PyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQpID09PSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkxFR0FDWTtcbiAgICBpZiAoZ2VuZXJhdGVkLmxlbmd0aCA+IDAgJiYgIWxlZ2FjeSkge1xuICAgICAgZmFpbChcImdlbmVyYXRlZCBlbnRyaWVzIGFyZSBvbmx5IHZhbGlkIHVuZGVyIHRoZSBsZWdhY3kgbmFtaW5nIHByb2ZpbGVcIik7XG4gICAgfVxuICAgIGNvbnN0IGtleSA9IGAke3Jlc291cmNlVHlwZX06JHtsb2dpY2FsfWA7XG4gICAgY29uc3QgcGluID0gdmFsdWVzLnBpbnM/LltrZXldO1xuICAgIGNvbnN0IGtlZXBHZW5lcmF0ZWQgPSBnZW5lcmF0ZWQuaW5jbHVkZXMoa2V5KTtcbiAgICAvLyByMywgQURWLTEzMTItMzogQ0RLIGRlZmF1bHRzIGFuIEFQSSBOYW1lIHRvZGF5LCBzbyBpdCBpcyBhbiBleHBsaWNpdCBuYW1lXG4gICAgLy8gYW5kIHRha2VzIGEgcGluLCBuZXZlciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICBpZiAoa2VlcEdlbmVyYXRlZCAmJiBBUElfVFlQRVMuaGFzKHJlc291cmNlVHlwZSkpIHtcbiAgICAgIGZhaWwoXCJhbiBBUEkgbmFtZSB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnlcIik7XG4gICAgfVxuICAgIGlmIChwaW4gIT09IHVuZGVmaW5lZCAmJiBrZWVwR2VuZXJhdGVkKSBmYWlsKFwiYSByZXNvdXJjZSBoYXMgYm90aCBhIHBpbiBhbmQgYSBnZW5lcmF0ZWQgZW50cnlcIik7XG4gICAgaWYgKHBpbiAhPT0gdW5kZWZpbmVkKSByZXR1cm4geyBuYW1lOiBwaW4sIHBpbm5lZDogdHJ1ZSB9O1xuICAgIGlmIChrZWVwR2VuZXJhdGVkKSByZXR1cm4geyBnZW5lcmF0ZWQ6IHRydWUgfTtcbiAgICBpZiAobGVnYWN5KSB7XG4gICAgICBmYWlsKGBsZWdhY3kgbmFtaW5nIHByb2ZpbGUgcmVxdWlyZXMgYSBwaW4gb3IgYSBnZW5lcmF0ZWQgZW50cnkgZm9yICR7a2V5fWApO1xuICAgIH1cblxuICAgIGxldCBvdXQ6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZTtcbiAgICBpZiAocnVsZS5raW5kID09PSBcInMzYXJcIikge1xuICAgICAgY29uc3Qgc3VmZml4ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuczNBY2NvdW50UmVnaW9uYWxTdWZmaXgodmFsdWVzKTtcbiAgICAgIGNvbnN0IGJ1ZGdldCA9IHJ1bGUubWF4IC0gc3VmZml4Lmxlbmd0aDtcbiAgICAgIGNvbnN0IHByZWZpeCA9IHNob3J0ZW4oYCR7dmFsdWVzLmFwcH0tJHt2YWx1ZXMuc3RhZ2V9LSR7bG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCItXCIpfWAsIGJ1ZGdldCk7XG4gICAgICBvdXQgPSB7IG5hbWU6IHByZWZpeCArIHN1ZmZpeCwgYnVja2V0TmFtZVByZWZpeDogcHJlZml4LCBidWNrZXROYW1lc3BhY2U6IFwiYWNjb3VudC1yZWdpb25hbFwiIH07XG4gICAgfSBlbHNlIGlmIChydWxlLmtpbmQgPT09IFwiZGFzaFwiKSB7XG4gICAgICBvdXQgPSB7IG5hbWU6IHNob3J0ZW4oYCR7dmFsdWVzLmFwcH0tJHt2YWx1ZXMuc3RhZ2V9LSR7bG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCItXCIpfWAsIHJ1bGUubWF4KSB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcInBhdGhcIikge1xuICAgICAgY29uc3QgZnVsbCA9IGAke3J1bGUubGVhZCA/PyBcIlwifSR7dmFsdWVzLmFwcH0vJHt2YWx1ZXMuc3RhZ2V9LyR7bG9naWNhbH1gO1xuICAgICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzZWNyZXRcIiAmJiBTRUNSRVRfVEFJTF9SRS50ZXN0KGZ1bGwpKSB7XG4gICAgICAgIGZhaWwoXCJzZWNyZXQgbmFtZSBtdXN0IG5vdCBlbmQgd2l0aCBhIGh5cGhlbiBhbmQgc2l4IGNoYXJhY3RlcnNcIik7XG4gICAgICB9XG4gICAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcInNzbV9wYXJhbWV0ZXJcIiAmJiAoZnVsbC5tYXRjaCgvXFwvL2cpPy5sZW5ndGggPz8gMCkgPiAxNSkge1xuICAgICAgICBmYWlsKFwic3NtIGhpZXJhcmNoeSBkZWVwZXIgdGhhbiAxNVwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChmdWxsLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwicGF0aCBuYW1lIG92ZXIgbGltaXRcIik7XG4gICAgICBvdXQgPSB7IG5hbWU6IGZ1bGwgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJsb2dcIikge1xuICAgICAgY29uc3QgbmFtZSA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ0dyb3VwTmFtZSh2YWx1ZXMsIGxvZ2ljYWwpO1xuICAgICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJsb2cgZ3JvdXAgb3ZlciBsaW1pdFwiKTtcbiAgICAgIG91dCA9IHsgbmFtZSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBmYWlsKGB1bnN1cHBvcnRlZCBraW5kICR7U3RyaW5nKHJ1bGUua2luZCl9YCk7XG4gICAgfVxuXG4gICAgY29uc3QgbmFtZSA9IG91dC5uYW1lIGFzIHN0cmluZztcbiAgICBpZiAoIW5ldyBSZWdFeHAoYF4oPzoke3J1bGUuY2hhcnNldH0pKyRgKS50ZXN0KG5hbWUpKSBmYWlsKFwiY2hhcnNldFwiKTtcbiAgICBpZiAobmFtZS5sZW5ndGggPiBydWxlLm1heCkgZmFpbChcImxlbmd0aFwiKTtcbiAgICBpZiAocnVsZS5taW4gIT09IHVuZGVmaW5lZCAmJiBuYW1lLmxlbmd0aCA8IHJ1bGUubWluKSBmYWlsKFwibGVuZ3RoXCIpO1xuICAgIGlmIChbXCJzM19idWNrZXRcIiwgXCJzM192ZWN0b3JfYnVja2V0XCIsIFwiczNfdmVjdG9yX2luZGV4XCJdLmluY2x1ZGVzKHJlc291cmNlVHlwZSkgJiYgIVMzX0VER0VTX1JFLnRlc3QobmFtZSkpIHtcbiAgICAgIGZhaWwoXCJzMyBzdGFydC9lbmRcIik7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIHNjb3BlIGluIHdoaWNoIEFXUyByZXF1aXJlcyBhIHR5cGUncyBuYW1lcyB0byBiZSB1bmlxdWUgKGNvbnRyYWN0XG4gICAqIHNlY3Rpb24gMTEuMSkuIEEgdHlwZSB0aGUgY29udHJhY3Qgc3RhdGVzIG5vIHNjb3BlIGZvciBpcyByZWZ1c2VkOiBpdCBjYW5ub3RcbiAgICogYmUgcmVzZXJ2ZWQsIHNvIGl0IGNhbm5vdCBiZSBkZXBsb3llZCB0aHJvdWdoIHRoZSBpbmRleCB1bnRpbCBhIHJldmlzaW9uXG4gICAqIHN0YXRlcyBpdHMgc2NvcGUuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIG5hbWluZ1Njb3BlKHJlc291cmNlVHlwZTogc3RyaW5nKTogQXBwVGhlb3J5TmFtaW5nU2NvcGUge1xuICAgIGlmIChuYW1pbmdSdWxlKHJlc291cmNlVHlwZSkgPT09IHVuZGVmaW5lZCkgZmFpbChVTktOT1dOX05BTUlOR19TQ09QRSk7XG4gICAgaWYgKE5PVF9VTklRVUVfVFlQRVMuaGFzKHJlc291cmNlVHlwZSkpIHJldHVybiBBcHBUaGVvcnlOYW1pbmdTY29wZS5OT1RfVU5JUVVFO1xuICAgIGlmIChBQ0NPVU5UX0dMT0JBTF9UWVBFUy5oYXMocmVzb3VyY2VUeXBlKSkgcmV0dXJuIEFwcFRoZW9yeU5hbWluZ1Njb3BlLkFDQ09VTlQ7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU5hbWluZ1Njb3BlLkFDQ09VTlRfUkVHSU9OO1xuICB9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlIGEgcGh5c2ljYWwgbmFtZSB0aGUgY29udHJhY3QgZml4ZXMgcmF0aGVyIHRoYW4gZGVyaXZlcyBhZ2FpbnN0IHRoZVxuICAgKiBjaGFyYWN0ZXIgYW5kIHNoYXBlIHJ1bGVzIG9mIHRoZSB0eXBlJ3Mgc2VjdGlvbiAyIHJvdzogY2hhcnNldCwgdGhlIGxlbmd0aFxuICAgKiByYW5nZSAoKipib3RoKiogYm91bmRzIHdoZW4gdGhlIHJvdyBzdGF0ZXMgYSBsb3dlciBvbmUsIG5vdCBvbmx5IHRoZSB1cHBlciksXG4gICAqIHRoZSBTMyBzdGFydC9lbmQgcnVsZSwgdGhlIHBhdGggcnVsZXMgKGxlYWQsIG5vbi1lbXB0eSBzZWdtZW50cywgZGVwdGgsXG4gICAqIHJlc2VydmVkIHByZWZpeGVzLCB0aGUgYGFsaWFzL2F3cy9gIG5hbWVzcGFjZSkgYW5kIHRoZSBzZWNyZXQgQVJOLXN1ZmZpeFxuICAgKiBydWxlLiBUaHJvd3Mgb24gYSBuYW1lIG91dHNpZGUgdGhlbS5cbiAgICpcbiAgICogVGhpcyBpcyB0aGUgc2VjdGlvbiAyIHRhYmxlLCBub3QgYSBzZWNvbmQgb25lOiBpdCByZWFkcyB0aGUgc2FtZSBydWxlIHJvd3NcbiAgICogdGhlIGRlcml2YXRpb24gdXNlcy4gQSBgbG9nX2dyb3VwYCBhY2NlcHRzIGAvYCBpbiBhZGRpdGlvbiB0byB0aGUgc2VjdGlvbiAyXG4gICAqIGNoYXJzZXQsIGJ1dCBvbmx5IGZvciB0aGUgdHdvIGZpeGVkIHNoYXBlcyBjb250cmFjdCBzZWN0aW9uIDMgc3RhdGVzOiBhXG4gICAqIGxvZy1zb3VyY2UgbmFtZSAod2hpY2ggY2FycmllcyBubyBgL2AgYXQgYWxsLCBiZWNhdXNlIHNlY3Rpb24gMyBqb2lucyBpdHNcbiAgICogc2VnbWVudHMgd2l0aCBgX2ApIG9yIHRoZSBMYW1iZGEgc2VydmljZSBwYXRoIGAvYXdzL2xhbWJkYS97ZnVuY3Rpb24gbmFtZX1gLFxuICAgKiB3aG9zZSBmdW5jdGlvbiBuYW1lIHNhdGlzZmllcyB0aGUgYGxhbWJkYV9mdW5jdGlvbmAgcm93LiBBbnkgb3RoZXJcbiAgICogYC9gLWJlYXJpbmcgbG9nIGdyb3VwIGlzIHJlZnVzZWQgKFNBTklUWS1BVC1OMy0wOCkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlUGh5c2ljYWxOYW1lKHJlc291cmNlVHlwZTogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBydWxlID0gbmFtaW5nUnVsZShyZXNvdXJjZVR5cGUpO1xuICAgIGlmIChydWxlID09PSB1bmRlZmluZWQpIGZhaWwoVU5LTk9XTl9OQU1JTkdfU0NPUEUpO1xuICAgIGNvbnN0IGNoYXJzZXQgPSBGSVhFRF9OQU1FX0NIQVJTRVRTLmdldChyZXNvdXJjZVR5cGUpID8/IHJ1bGUuY2hhcnNldDtcbiAgICBjb25zdCBxdW90ZWQgPSBKU09OLnN0cmluZ2lmeShuYW1lKTtcbiAgICBpZiAobmFtZS5sZW5ndGggPT09IDAgfHwgIW5ldyBSZWdFeHAoYF4oPzoke2NoYXJzZXR9KSskYCkudGVzdChuYW1lKSkge1xuICAgICAgZmFpbChgYSBmaXhlZCAke3Jlc291cmNlVHlwZX0gbmFtZSBtdXN0IG1hdGNoICR7Y2hhcnNldH0gKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICB9XG4gICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIHtcbiAgICAgIGZhaWwoYGEgZml4ZWQgJHtyZXNvdXJjZVR5cGV9IG5hbWUgbXVzdCBiZSBhdCBtb3N0ICR7cnVsZS5tYXh9IGNoYXJhY3RlcnMsIGdvdCAke25hbWUubGVuZ3RofWApO1xuICAgIH1cbiAgICBpZiAocnVsZS5taW4gIT09IHVuZGVmaW5lZCAmJiBuYW1lLmxlbmd0aCA8IHJ1bGUubWluKSB7XG4gICAgICBmYWlsKGBhIGZpeGVkICR7cmVzb3VyY2VUeXBlfSBuYW1lIG11c3QgYmUgYXQgbGVhc3QgJHtydWxlLm1pbn0gY2hhcmFjdGVycyAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7bmFtZS5sZW5ndGh9YCk7XG4gICAgfVxuICAgIGlmIChydWxlLmxlYWQgIT09IHVuZGVmaW5lZCAmJiAhbmFtZS5zdGFydHNXaXRoKHJ1bGUubGVhZCkpIHtcbiAgICAgIGZhaWwoYGEgZml4ZWQgJHtyZXNvdXJjZVR5cGV9IG5hbWUgbXVzdCBzdGFydCB3aXRoICR7SlNPTi5zdHJpbmdpZnkocnVsZS5sZWFkKX0gKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICB9XG4gICAgaWYgKFMzX1RZUEVTLmhhcyhyZXNvdXJjZVR5cGUpICYmICFTM19FREdFU19SRS50ZXN0KG5hbWUpKSB7XG4gICAgICBmYWlsKGBhIGZpeGVkICR7cmVzb3VyY2VUeXBlfSBuYW1lIG11c3Qgc3RhcnQgYW5kIGVuZCB3aXRoIGEgbGV0dGVyIG9yIGRpZ2l0IChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgfVxuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwic2VjcmV0XCIgJiYgU0VDUkVUX1RBSUxfUkUudGVzdChuYW1lKSkge1xuICAgICAgZmFpbChgYSBmaXhlZCBzZWNyZXQgbmFtZSBtdXN0IG5vdCBlbmQgd2l0aCBhIGh5cGhlbiBhbmQgc2l4IGNoYXJhY3RlcnMgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICB9XG4gICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzc21fcGFyYW1ldGVyXCIpIHtcbiAgICAgIC8vIEEgcGF0aCBuYW1lIGNhcnJpZXMgYXQgbGVhc3Qgb25lIG5vbi1lbXB0eSBzZWdtZW50IGFmdGVyIGl0cyBsZWFkIGAvYCxcbiAgICAgIC8vIGFuZCBubyBlbXB0eSBzZWdtZW50OiBgL2AgYW5kIGAvYS8vYmAgbmFtZSBub3RoaW5nIEFXUyBjYW4gY3JlYXRlLlxuICAgICAgaWYgKCFTU01fUEFUSF9SRS50ZXN0KG5hbWUpKSB7XG4gICAgICAgIGZhaWwoXG4gICAgICAgICAgYGEgZml4ZWQgc3NtX3BhcmFtZXRlciBuYW1lIG11c3QgY2FycnkgYXQgbGVhc3Qgb25lIG5vbi1lbXB0eSBzZWdtZW50IGFmdGVyIGl0cyBsZWFkIFwiL1wiIGFuZCBubyBlbXB0eSBzZWdtZW50IChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICgobmFtZS5tYXRjaCgvXFwvL2cpPy5sZW5ndGggPz8gMCkgPiAxNSkge1xuICAgICAgICBmYWlsKGBhIGZpeGVkIHNzbV9wYXJhbWV0ZXIgbmFtZSBtdXN0IGhhdmUgYXQgbW9zdCAxNSBsZXZlbHMgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICAgIH1cbiAgICAgIGlmICgvXlxcLz8oPzphd3N8c3NtKSg/OlxcL3wkKS9pLnRlc3QobmFtZSkpIHtcbiAgICAgICAgZmFpbChgYSBmaXhlZCBzc21fcGFyYW1ldGVyIG5hbWUgbXVzdCBub3QgYmVnaW4gd2l0aCBhd3Mgb3Igc3NtIChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwia21zX2FsaWFzXCIpIHtcbiAgICAgIC8vIGBhbGlhcy9gIGFsb25lIG5hbWVzIG5vIGFsaWFzOiB0aGUgbmFtZSBhZnRlciB0aGUgbGVhZCBpcyB0aGUgYWxpYXMuXG4gICAgICBpZiAobmFtZS5sZW5ndGggPD0gS01TX0FMSUFTX0xFQUQubGVuZ3RoKSB7XG4gICAgICAgIGZhaWwoXG4gICAgICAgICAgYGEgZml4ZWQga21zX2FsaWFzIG5hbWUgbXVzdCBjYXJyeSBhIG5vbi1lbXB0eSBuYW1lIGFmdGVyIGl0cyAke0pTT04uc3RyaW5naWZ5KEtNU19BTElBU19MRUFEKX0gbGVhZCAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiYWxpYXMvYXdzL1wiKSkge1xuICAgICAgICBmYWlsKGBhIGZpeGVkIGttc19hbGlhcyBuYW1lIG11c3Qgbm90IGJlIGluIHRoZSBhbGlhcy9hd3MvIG5hbWVzcGFjZSAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWApO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcImxvZ19ncm91cFwiKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiYXdzL1wiKSkge1xuICAgICAgICBmYWlsKGBhIGZpeGVkIGxvZ19ncm91cCBuYW1lIG11c3Qgbm90IGJlZ2luIHdpdGggYXdzLyAoY29udHJhY3Qgc2VjdGlvbiAzKSwgZ290ICR7cXVvdGVkfWApO1xuICAgICAgfSBlbHNlIGlmICghaXNGaXhlZExvZ0dyb3VwU2hhcGUobmFtZSkpIHtcbiAgICAgICAgZmFpbChcbiAgICAgICAgICBgYSBmaXhlZCBsb2dfZ3JvdXAgbmFtZSBtdXN0IGJlIGVpdGhlciBhIHNlY3Rpb24gMyBsb2ctc291cmNlIG5hbWUgKG5vIFwiL1wiKSBvciB0aGUgTGFtYmRhIHNlcnZpY2UgcGF0aCAke0pTT04uc3RyaW5naWZ5KExBTUJEQV9MT0dfR1JPVVBfTEVBRCl9IGZvbGxvd2VkIGJ5IGEgbmFtZSB0aGF0IHNhdGlzZmllcyB0aGUgbGFtYmRhX2Z1bmN0aW9uIHJvdyAoY29udHJhY3Qgc2VjdGlvbiAzKSwgZ290ICR7cXVvdGVkfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlZnVzZSB0d28gZGlmZmVyZW50IGxvZ2ljYWwgcmVzb3VyY2VzIGluIG9uZSBuYW1pbmcgY29udGV4dCB0aGF0IGRlcml2ZSB0aGVcbiAgICogc2FtZSBuYW1lIGluIHRoZSBzYW1lIG5hbWluZyBzY29wZSwgYW5kIHJldHVybiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0XG4gICAqIChjb250cmFjdCBzZWN0aW9uIDExLjQpLiBBIExhbWJkYSBmdW5jdGlvbiBhbmQgaXRzIElBTSByb2xlIG1heSBzaGFyZSBhIG5hbWVcbiAgICogYmVjYXVzZSB0aGVpciBzY29wZXMgZGlmZmVyLCBhbmQgdHdvIEFQSXMgbWF5IHNoYXJlIG9uZSBiZWNhdXNlIEFXUyBkb2VzIG5vdFxuICAgKiBrZWVwIEFQSSBuYW1lcyB1bmlxdWUuIFJvd3Mga2VlcCB0aGUgb3JkZXIgb2YgdGhlIGVudHJpZXMuXG4gICAqXG4gICAqIGBsb2dpY2FsSWRgIGlzIHRoZSByZXNvdXJjZSdzIGlkZW50aXR5IGluc2lkZSB0aGUgbmFtaW5nIGNvbnRleHQ6IGl0c1xuICAgKiBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkLCBvciB0aGUgb3duaW5nIHN0YWNrJ3MgY29uc3RydWN0IHBhdGggcGx1cyB0aGF0XG4gICAqIGxvZ2ljYWwgaWQgd2hlbiB0aGUgY29udGV4dCBzcGFucyBzZXZlcmFsIHN0YWNrcy4gQSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkXG4gICAqIGlzIHVuaXF1ZSBvbmx5IGluc2lkZSBvbmUgdGVtcGxhdGUsIHNvIGEgY2FsbGVyIHRoYXQgb3ducyBtb3JlIHRoYW4gb25lXG4gICAqIHRlbXBsYXRlIG11c3QgcGFzcyB0aGUgcXVhbGlmaWVkIGZvcm07IG90aGVyd2lzZSB0d28gcmVzb3VyY2VzIGluIGRpZmZlcmVudFxuICAgKiBzdGFja3Mgd2l0aCB0aGUgc2FtZSBsb2NhbCBsb2dpY2FsIGlkIGxvb2sgbGlrZSBvbmUgcmUtZGVjbGFyZWQgcmVzb3VyY2VcbiAgICogKFNBTklUWS1BVC1OMy0wNSkuIFRoZSByZXR1cm5lZCByb3cgZWNob2VzIHRoZSBpZGVudGl0eSBpdCB3YXMgZ2l2ZW4uXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHN5bnRoQ2hlY2soZW50cmllczogQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dFtdKTogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXSB7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgY29uc3QgYXJ0aWZhY3Q6IEFwcFRoZW9yeURlcml2ZWROYW1lW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGNvbnN0IHNjb3BlID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubmFtaW5nU2NvcGUoZW50cnkudHlwZSk7XG4gICAgICBjb25zdCBnZW5lcmF0ZWQgPSBlbnRyeS5nZW5lcmF0ZWQgPT09IHRydWU7XG4gICAgICBhcnRpZmFjdC5wdXNoKHtcbiAgICAgICAgLi4uKGVudHJ5Lm5hbWUgIT09IHVuZGVmaW5lZCAmJiAhZ2VuZXJhdGVkID8geyBuYW1lOiBlbnRyeS5uYW1lIH0gOiB7fSksXG4gICAgICAgIHR5cGU6IGVudHJ5LnR5cGUsXG4gICAgICAgIHNjb3BlLFxuICAgICAgICBsb2dpY2FsSWQ6IGVudHJ5LmxvZ2ljYWxJZCxcbiAgICAgICAgLi4uKGdlbmVyYXRlZCA/IHsgZ2VuZXJhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICAgIGlmIChzY29wZSA9PT0gQXBwVGhlb3J5TmFtaW5nU2NvcGUuTk9UX1VOSVFVRSB8fCBnZW5lcmF0ZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYCR7c2NvcGV9XFx1MDAwMCR7ZW50cnkudHlwZX1cXHUwMDAwJHtlbnRyeS5uYW1lID8/IFwiXCJ9YDtcbiAgICAgIGNvbnN0IGhlbGQgPSBzZWVuLmdldChrZXkpO1xuICAgICAgaWYgKGhlbGQgIT09IHVuZGVmaW5lZCAmJiBoZWxkICE9PSBlbnRyeS5sb2dpY2FsSWQpIHtcbiAgICAgICAgZmFpbChgJHtoZWxkfSBhbmQgJHtlbnRyeS5sb2dpY2FsSWR9IGRlcml2ZSAke2VudHJ5Lm5hbWUgPz8gXCJcIn0gaW4gc2NvcGUgJHtzY29wZX1gKTtcbiAgICAgIH1cbiAgICAgIHNlZW4uc2V0KGtleSwgZW50cnkubG9naWNhbElkKTtcbiAgICB9XG4gICAgcmV0dXJuIGFydGlmYWN0O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgYXMgdGhlIGNsb3VkLWFzc2VtYmx5IG1ldGFkYXRhIGRvY3VtZW50LCB3aXRoIHRoZVxuICAgKiBjb250cmFjdCdzIHNuYWtlX2Nhc2Ugd2lyZSBrZXlzIGFuZCBhIGRldGVybWluaXN0aWMgZW50cnkgb3JkZXIuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGRlcml2ZWROYW1lc0pzb24oYXJ0aWZhY3Q6IEFwcFRoZW9yeURlcml2ZWROYW1lcyk6IHN0cmluZyB7XG4gICAgY29uc3QgZW50cmllcyA9IFsuLi5hcnRpZmFjdC5lbnRyaWVzXVxuICAgICAgLm1hcCgoZW50cnkpID0+ICh7XG4gICAgICAgIC4uLihlbnRyeS5uYW1lICE9PSB1bmRlZmluZWQgJiYgIWVudHJ5LmdlbmVyYXRlZCA/IHsgbmFtZTogZW50cnkubmFtZSB9IDoge30pLFxuICAgICAgICB0eXBlOiBlbnRyeS50eXBlLFxuICAgICAgICBzY29wZTogZW50cnkuc2NvcGUsXG4gICAgICAgIGxvZ2ljYWxfaWQ6IGVudHJ5LmxvZ2ljYWxJZCxcbiAgICAgICAgLi4uKGVudHJ5LmdlbmVyYXRlZCA/IHsgZ2VuZXJhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICB9KSlcbiAgICAgIC5zb3J0KChhLCBiKSA9PiB7XG4gICAgICAgIGNvbnN0IGtleSA9IChyb3c6IHR5cGVvZiBhKTogc3RyaW5nID0+XG4gICAgICAgICAgW3Jvdy5zY29wZSwgcm93LnR5cGUsIHJvdy5uYW1lID8/IFwiXCIsIHJvdy5sb2dpY2FsX2lkXS5qb2luKFwiXFx1MDAwMFwiKTtcbiAgICAgICAgY29uc3QgbGVmdCA9IGtleShhKTtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBrZXkoYik7XG4gICAgICAgIHJldHVybiBsZWZ0IDwgcmlnaHQgPyAtMSA6IGxlZnQgPiByaWdodCA/IDEgOiAwO1xuICAgICAgfSk7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGNvbnRyYWN0OiBhcnRpZmFjdC5jb250cmFjdCxcbiAgICAgIHNjaGVtYTogYXJ0aWZhY3Quc2NoZW1hLFxuICAgICAgY29udGV4dDoge1xuICAgICAgICBuYW1lc3BhY2U6IGFydGlmYWN0LmNvbnRleHQubmFtZXNwYWNlID8/IExPR19QUkVGSVgsXG4gICAgICAgIGFwcDogYXJ0aWZhY3QuY29udGV4dC5hcHAsXG4gICAgICAgIHN0YWdlOiBhcnRpZmFjdC5jb250ZXh0LnN0YWdlLFxuICAgICAgICBhY2NvdW50OiBhcnRpZmFjdC5jb250ZXh0LmFjY291bnQsXG4gICAgICAgIHJlZ2lvbjogYXJ0aWZhY3QuY29udGV4dC5yZWdpb24sXG4gICAgICB9LFxuICAgICAgZW50cmllcyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSBvbmUgc2VsZWN0b3IuIFRocm93cyBvbiBhIHNlbGVjdG9yIG91dHNpZGUgdGhlIGdyYW1tYXIuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlU2VsZWN0b3Ioc2VsZWN0b3I6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGJhc2UgPSBzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpID8gc2VsZWN0b3Iuc2xpY2UoMCwgLTIpIDogc2VsZWN0b3I7XG4gICAgaWYgKCFMT0dJQ0FMX1JFLnRlc3QoYmFzZSkgfHwgYmFzZS5zcGxpdChcIi9cIilbMF0gIT09IFwibG9nc1wiIHx8IChiYXNlID09PSBcImxvZ3NcIiAmJiAhc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSkpIHtcbiAgICAgIGZhaWwoYHNlbGVjdG9yICR7c2VsZWN0b3J9YCk7XG4gICAgfVxuICAgIGlmIChiYXNlLmluY2x1ZGVzKFwiKlwiKSkgZmFpbChcIndpbGRjYXJkIG9ubHkgYXMgdHJhaWxpbmcgLypcIik7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBhIHNlbGVjdG9yIG1hdGNoZXMgYSBsb2dpY2FsIHNvdXJjZS4gQSB0cmFpbGluZyBgLypgIG1hdGNoZXNcbiAgICogZGVzY2VuZGFudHMgb25seS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yOiBzdHJpbmcsIGxvZ2ljYWw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGlmIChzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSByZXR1cm4gbG9naWNhbC5zdGFydHNXaXRoKHNlbGVjdG9yLnNsaWNlKDAsIC0xKSk7XG4gICAgcmV0dXJuIGxvZ2ljYWwgPT09IHNlbGVjdG9yO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgYSBzb3VyY2UgaXMgdmlzaWJsZTogYW4gaW5jbHVkZSBtYXRjaGVzIGFuZCBubyBleGNsdWRlIGRvZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHNvdXJjZVZpc2libGUocnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcywgbG9naWNhbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgaW5jbHVkZWQgPSAocnVsZXMuaW5jbHVkZSA/PyBbXSkuc29tZSgoc2VsZWN0b3IpID0+IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNlbGVjdG9yTWF0Y2hlcyhzZWxlY3RvciwgbG9naWNhbCkpO1xuICAgIGlmICghaW5jbHVkZWQpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gIShydWxlcy5leGNsdWRlID8/IFtdKS5zb21lKChzZWxlY3RvcikgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yLCBsb2dpY2FsKSk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGZpcnN0IDEyIGhleCBjaGFyYWN0ZXJzIG9mIFNIQS0yNTYgb3ZlciB0aGUgY2Fub25pY2FsIHJ1bGVzLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBydWxlVmVyc2lvbihydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzKTogc3RyaW5nIHtcbiAgICBjb25zdCBjYW5vbmljYWwgPSBge1wiZXhjbHVkZVwiOiR7SlNPTi5zdHJpbmdpZnkoc29ydGVkQ29weShydWxlcy5leGNsdWRlKSl9LFwiaW5jbHVkZVwiOiR7SlNPTi5zdHJpbmdpZnkoc29ydGVkQ29weShydWxlcy5pbmNsdWRlKSl9fWA7XG4gICAgcmV0dXJuIHNoYTI1NkhleChjYW5vbmljYWwpLnNsaWNlKDAsIDEyKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21waWxlIHRoZSBydWxlcyBpbnRvIHRoZSByZWFkZXItcm9sZSBpbmxpbmUgcG9saWN5IGRvY3VtZW50LiBUaGUgcmV0dXJuXG4gICAqIHZhbHVlIGlzIHRoZSBjb250cmFjdCBKU09OLCBzbyBhIGNvbnN1bWVyIGNhbiBjb21wYXJlIGl0IGJ5dGUgZm9yIGJ5dGUuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGNvbXBpbGVWaXNpYmlsaXR5UG9saWN5SnNvbihcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIFsuLi4ocnVsZXMuaW5jbHVkZSA/PyBbXSksIC4uLihydWxlcy5leGNsdWRlID8/IFtdKV0pIHtcbiAgICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuICAgIH1cbiAgICBjb25zdCBiYXNlID0gYGFybjphd3M6bG9nczoke3ZhbHVlcy5yZWdpb259OiR7dmFsdWVzLmFjY291bnR9OmxvZy1ncm91cDpgO1xuICAgIGNvbnN0IGFybnNGb3IgPSAoc2VsZWN0b3I6IHN0cmluZyk6IHN0cmluZ1tdID0+IHtcbiAgICAgIGlmIChzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICAgIHJldHVybiBbYmFzZSArIGxvZ1ByZWZpeCh2YWx1ZXMpICsgc2VsZWN0b3Iuc2xpY2UoMCwgLTEpLnJlcGxhY2UoL1xcLy9nLCBcIl9cIikgKyBcIipcIl07XG4gICAgICB9XG4gICAgICBjb25zdCBuYW1lID0gbG9nUHJlZml4KHZhbHVlcykgKyBzZWxlY3Rvci5yZXBsYWNlKC9cXC8vZywgXCJfXCIpO1xuICAgICAgcmV0dXJuIFtiYXNlICsgbmFtZSwgYmFzZSArIG5hbWUgKyBcIjoqXCJdO1xuICAgIH07XG4gICAgY29uc3QgYWN0aW9ucyA9IFsuLi5LRUVQRVJfQUNUSU9OU19HUk9VUCwgLi4uS0VFUEVSX0FDVElPTlNfU1RSRUFNXTtcbiAgICBjb25zdCBzdGF0ZW1lbnRzOiB7IFNpZDogc3RyaW5nOyBFZmZlY3Q6IHN0cmluZzsgQWN0aW9uOiBzdHJpbmdbXTsgUmVzb3VyY2U6IHN0cmluZ1tdIH1bXSA9IFtcbiAgICAgIHtcbiAgICAgICAgU2lkOiBcIlJlYWRNYW5pZmVzdFwiLFxuICAgICAgICBFZmZlY3Q6IFwiQWxsb3dcIixcbiAgICAgICAgQWN0aW9uOiBbXCJzc206R2V0UGFyYW1ldGVyXCJdLFxuICAgICAgICBSZXNvdXJjZTogW1xuICAgICAgICAgIGBhcm46YXdzOnNzbToke3ZhbHVlcy5yZWdpb259OiR7dmFsdWVzLmFjY291bnR9OnBhcmFtZXRlci8ke0xPR19QUkVGSVh9L3Zpc2liaWxpdHkvJHt2YWx1ZXMuYXBwfS8ke3ZhbHVlcy5zdGFnZX0vbWFuaWZlc3RgLFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGNvbnN0IGluY2x1ZGVkID0gc29ydGVkQ29weShydWxlcy5pbmNsdWRlKS5mbGF0TWFwKGFybnNGb3IpO1xuICAgIGNvbnN0IGV4Y2x1ZGVkID0gc29ydGVkQ29weShydWxlcy5leGNsdWRlKS5mbGF0TWFwKGFybnNGb3IpO1xuICAgIGlmIChpbmNsdWRlZC5sZW5ndGggPiAwKSBzdGF0ZW1lbnRzLnB1c2goeyBTaWQ6IFwiUmVhZEluY2x1ZGVkXCIsIEVmZmVjdDogXCJBbGxvd1wiLCBBY3Rpb246IGFjdGlvbnMsIFJlc291cmNlOiBpbmNsdWRlZCB9KTtcbiAgICBpZiAoZXhjbHVkZWQubGVuZ3RoID4gMCkgc3RhdGVtZW50cy5wdXNoKHsgU2lkOiBcIkRlbnlFeGNsdWRlZFwiLCBFZmZlY3Q6IFwiRGVueVwiLCBBY3Rpb246IGFjdGlvbnMsIFJlc291cmNlOiBleGNsdWRlZCB9KTtcbiAgICBjb25zdCBkb2N1bWVudCA9IEpTT04uc3RyaW5naWZ5KHsgVmVyc2lvbjogXCIyMDEyLTEwLTE3XCIsIFN0YXRlbWVudDogc3RhdGVtZW50cyB9KTtcbiAgICBpZiAoZG9jdW1lbnQubGVuZ3RoID4gUk9MRV9QT0xJQ1lfTUFYKSBmYWlsKFwiY29tcGlsZWQgcG9saWN5IG92ZXIgcm9sZSBwb2xpY3kgc2l6ZVwiKTtcbiAgICByZXR1cm4gZG9jdW1lbnQ7XG4gIH1cblxuICAvKipcbiAgICogQXNzZW1ibGUgdGhlIHN5bnRoLXRpbWUgdmlzaWJpbGl0eSBwcmV2aWV3LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2aXNpYmlsaXR5UHJldmlldyhcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBzb3VyY2VzOiBzdHJpbmdbXSxcbiAgKTogQXBwVGhlb3J5VmlzaWJpbGl0eVByZXZpZXcge1xuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh2YWx1ZXMpO1xuICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgWy4uLihydWxlcy5pbmNsdWRlID8/IFtdKSwgLi4uKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pXSkge1xuICAgICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBydWxlVmVyc2lvbjogQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcucnVsZVZlcnNpb24ocnVsZXMpLFxuICAgICAgbWF0Y2hlZE5vdzogc291cmNlcy5maWx0ZXIoKHNvdXJjZSkgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgc291cmNlKSkuc29ydCgpLFxuICAgICAgbm90TWF0Y2hlZE5vdzogc291cmNlcy5maWx0ZXIoKHNvdXJjZSkgPT4gIUFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIHNvdXJjZSkpLnNvcnQoKSxcbiAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpLCBleGNsdWRlOiBzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBc3NlbWJsZSB0aGUgcHVibGlzaGVkIG1hbmlmZXN0ICh0aGUgcHJldmlldyBtaW51cyBgbm90TWF0Y2hlZE5vd2ApLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2aXNpYmlsaXR5TWFuaWZlc3QoXG4gICAgdmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICAgc291cmNlczogc3RyaW5nW10sXG4gICk6IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdCB7XG4gICAgY29uc3QgcHJldmlldyA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZpc2liaWxpdHlQcmV2aWV3KHZhbHVlcywgcnVsZXMsIHNvdXJjZXMpO1xuICAgIHJldHVybiB7IHJ1bGVWZXJzaW9uOiBwcmV2aWV3LnJ1bGVWZXJzaW9uLCBtYXRjaGVkTm93OiBwcmV2aWV3Lm1hdGNoZWROb3csIGZ1dHVyZTogcHJldmlldy5mdXR1cmUgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXJpYWxpemUgYSBtYW5pZmVzdCB0byB0aGUgY29udHJhY3QgSlNPTiBzaGFwZSB3cml0dGVuIHRvIFNTTS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbWFuaWZlc3RKc29uKG1hbmlmZXN0OiBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3QpOiBzdHJpbmcge1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBydWxlX3ZlcnNpb246IG1hbmlmZXN0LnJ1bGVWZXJzaW9uLFxuICAgICAgbWF0Y2hlZF9ub3c6IG1hbmlmZXN0Lm1hdGNoZWROb3csXG4gICAgICBmdXR1cmU6IHsgaW5jbHVkZTogbWFuaWZlc3QuZnV0dXJlLmluY2x1ZGUgPz8gW10sIGV4Y2x1ZGU6IG1hbmlmZXN0LmZ1dHVyZS5leGNsdWRlID8/IFtdIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogS2VlcGVyJ3MgcmVhZCBkZWNpc2lvbiwgaW4gdGhlIHJ1bnRpbWVzJyBwYXJhbWV0ZXIgb3JkZXIuIEZhaWxzIGNsb3NlZCBvbiBhXG4gICAqIGRlbmlhbCBvciBhbiB1bnJlYWNoYWJsZSBhY2NvdW50LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBrZWVwZXJEZWNpc2lvbihcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIGxvZ2ljYWw6IHN0cmluZyxcbiAgICBhd3NSZXN1bHQ6IHN0cmluZyxcbiAgKTogQXBwVGhlb3J5S2VlcGVyQW5zd2VyIHtcbiAgICBpZiAoIXJ1bGVzIHx8ICFBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBsb2dpY2FsKSkge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5OT1RfU0hBUkVEO1xuICAgIH1cbiAgICBpZiAoYXdzUmVzdWx0ID09PSBcImV2ZW50c1wiKSByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLkVWRU5UUztcbiAgICBpZiAoYXdzUmVzdWx0ID09PSBcImVtcHR5XCIgfHwgYXdzUmVzdWx0ID09PSBcIm5vdF9mb3VuZFwiKSByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLkFMTE9XRURfTk9fRVZFTlRTO1xuICAgIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuTk9UX1NIQVJFRDtcbiAgfVxufVxuIl19