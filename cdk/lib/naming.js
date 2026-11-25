"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryResourceNaming = exports.AppTheoryNamingScope = exports.AppTheoryKeeperAnswer = exports.AppTheoryLoggingProfile = exports.AppTheoryNamingProfile = exports.DERIVED_NAMES_METADATA_KEY = exports.DERIVED_NAMES_SCHEMA = exports.RESOURCE_NAMING_CONTRACT = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const node_crypto_1 = require("node:crypto");
const log_source_grammar_1 = require("./private/log-source-grammar");
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
const SEGMENT_PATTERN = log_source_grammar_1.LOGICAL_SEGMENT_PATTERN;
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
 *
 * The log-source branch here is a shape test only, not an identity test: it
 * cannot tell whose context a name belongs to. `AppTheoryNamingContext`
 * narrows it to the context's own `theorycloud_{namespace}_{app}_{stage}_`
 * prefix and remainder grammar when it declares a fixed name.
 */
function isFixedLogGroupShape(name) {
    if (!name.includes("/"))
        return true;
    if (!name.startsWith(log_source_grammar_1.LAMBDA_LOG_GROUP_LEAD))
        return false;
    const functionName = name.slice(log_source_grammar_1.LAMBDA_LOG_GROUP_LEAD.length);
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
     *
     * The check is **structural**: it holds no context values, so it cannot tell
     * whether a log-source-shaped name is this naming context's own source. The
     * context completes that rule in `AppTheoryNamingContext.declareFixedName`,
     * which owns the bound `theorycloud_{namespace}_{app}_{stage}_` prefix
     * (SANITY-AT-N3-08, round 4).
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
                fail(`a fixed log_group name must be either a section 3 log-source name (no "/") or the Lambda service path ${JSON.stringify(log_source_grammar_1.LAMBDA_LOG_GROUP_LEAD)} followed by a name that satisfies the lambda_function row (contract section 3), got ${quoted}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekMscUVBQThGO0FBRTlGOztHQUVHO0FBQ1UsUUFBQSx3QkFBd0IsR0FBRyxrQ0FBa0MsQ0FBQztBQUUzRTs7R0FFRztBQUNVLFFBQUEsb0JBQW9CLEdBQUcsNENBQTRDLENBQUM7QUFFakY7OztHQUdHO0FBQ1UsUUFBQSwwQkFBMEIsR0FBRyx5Q0FBeUMsQ0FBQztBQUVwRjs7R0FFRztBQUNILElBQVksc0JBU1g7QUFURCxXQUFZLHNCQUFzQjtJQUNoQzs7T0FFRztJQUNILDZDQUFtQixDQUFBO0lBQ25COztPQUVHO0lBQ0gsMkNBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHNCQUFzQixzQ0FBdEIsc0JBQXNCLFFBU2pDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHVCQVNYO0FBVEQsV0FBWSx1QkFBdUI7SUFDakM7O09BRUc7SUFDSCxnREFBcUIsQ0FBQTtJQUNyQjs7T0FFRztJQUNILDRDQUFpQixDQUFBO0FBQ25CLENBQUMsRUFUVyx1QkFBdUIsdUNBQXZCLHVCQUF1QixRQVNsQztBQUVEOztHQUVHO0FBQ0gsSUFBWSxxQkFhWDtBQWJELFdBQVkscUJBQXFCO0lBQy9COztPQUVHO0lBQ0gsMENBQWlCLENBQUE7SUFDakI7O09BRUc7SUFDSCxnRUFBdUMsQ0FBQTtJQUN2Qzs7T0FFRztJQUNILGtEQUF5QixDQUFBO0FBQzNCLENBQUMsRUFiVyxxQkFBcUIscUNBQXJCLHFCQUFxQixRQWFoQztBQWtNRDs7R0FFRztBQUNILElBQVksb0JBYVg7QUFiRCxXQUFZLG9CQUFvQjtJQUM5Qjs7T0FFRztJQUNILDJDQUFtQixDQUFBO0lBQ25COztPQUVHO0lBQ0gseURBQWlDLENBQUE7SUFDakM7O09BRUc7SUFDSCxpREFBeUIsQ0FBQTtBQUMzQixDQUFDLEVBYlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFh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bXBvcnQgeyBMQU1CREFfTE9HX0dST1VQX0xFQUQsIExPR0lDQUxfU0VHTUVOVF9QQVRURVJOIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2ctc291cmNlLWdyYW1tYXJcIjtcblxuLyoqXG4gKiBUaGUgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0IHRoaXMgbW9kdWxlIGltcGxlbWVudHMuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVNPVVJDRV9OQU1JTkdfQ09OVFJBQ1QgPSBcInRoZW9yeWNsb3VkX3Jlc291cmNlX25hbWluZy52MC4xXCI7XG5cbi8qKlxuICogVGhlIHNjaGVtYSBpZGVudGlmaWVyIG9mIHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgYSBuYW1pbmcgY29udGV4dCBlbWl0cy5cbiAqL1xuZXhwb3J0IGNvbnN0IERFUklWRURfTkFNRVNfU0NIRU1BID0gXCJhcHB0aGVvcnlfcmVzb3VyY2VfbmFtaW5nLmRlcml2ZWRfbmFtZXMudjFcIjtcblxuLyoqXG4gKiBUaGUgY2xvdWQtYXNzZW1ibHkgbWV0YWRhdGEgdHlwZSB0aGF0IGNhcnJpZXMgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdC4gVGhlXG4gKiBhcnRpZmFjdCBsYW5kcyBpbiBge3N0YWNrfS5tZXRhZGF0YS5qc29uYCBpbiBgY2RrLm91dGAuXG4gKi9cbmV4cG9ydCBjb25zdCBERVJJVkVEX05BTUVTX01FVEFEQVRBX0tFWSA9IFwiYXBwdGhlb3J5OnJlc291cmNlLW5hbWluZy9kZXJpdmVkLW5hbWVzXCI7XG5cbi8qKlxuICogTmFtaW5nIHByb2ZpbGVzIGFjY2VwdGVkIGJ5IGEgbmFtaW5nIGNvbnRleHQuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUge1xuICAvKipcbiAgICogTmFtZXMgZGVyaXZlIGZyb20gdGhlIG5hbWluZyBjb250ZXh0LlxuICAgKi9cbiAgREVSSVZFRCA9IFwiZGVyaXZlZFwiLFxuICAvKipcbiAgICogRXZlcnkgbmFtZSBjb21lcyBmcm9tIGEgcGluLlxuICAgKi9cbiAgTEVHQUNZID0gXCJsZWdhY3lcIixcbn1cblxuLyoqXG4gKiBMb2dnaW5nIHByb2ZpbGVzIGFjY2VwdGVkIGJ5IGEgbmFtaW5nIGNvbnRleHQuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlIHtcbiAgLyoqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIHN0YW5kYXJkIGxvZyBncm91cHMgYW5kIGFjY2VzcyBsb2dnaW5nLlxuICAgKi9cbiAgU1RBTkRBUkQgPSBcInN0YW5kYXJkXCIsXG4gIC8qKlxuICAgKiBFYWNoIGNvbnN0cnVjdCBrZWVwcyBpdHMgcHJlLWNvbnRyYWN0IGxvZ2dpbmcgYmVoYXZpb3VyLlxuICAgKi9cbiAgTEVHQUNZID0gXCJsZWdhY3lcIixcbn1cblxuLyoqXG4gKiBLZWVwZXIncyBhbnN3ZXIgdG8gYSByZWFkZXIgcmVxdWVzdC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5S2VlcGVyQW5zd2VyIHtcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgc2hhcmVkIGFuZCB0aGUgcmVhZCByZXR1cm5lZCBldmVudHMuXG4gICAqL1xuICBFVkVOVFMgPSBcImV2ZW50c1wiLFxuICAvKipcbiAgICogVGhlIHNvdXJjZSBpcyBzaGFyZWQgYW5kIHRoZSByZWFkIHJldHVybmVkIG5vIGV2ZW50cy5cbiAgICovXG4gIEFMTE9XRURfTk9fRVZFTlRTID0gXCJhbGxvd2VkX25vX2V2ZW50c1wiLFxuICAvKipcbiAgICogVGhlIHNvdXJjZSBpcyBub3Qgc2hhcmVkLCBvciB0aGUgcmVhZCBmYWlsZWQgY2xvc2VkLlxuICAgKi9cbiAgTk9UX1NIQVJFRCA9IFwibm90X3NoYXJlZFwiLFxufVxuXG4vKipcbiAqIEJvdW5kIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0IHZhbHVlcyBmcm9tIHN0YWdlIGNvbmZpZy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzIHtcbiAgLyoqXG4gICAqIE5hbWVzcGFjZSBzZWdtZW50LlxuICAgKiBAZGVmYXVsdCBcInRoZW9yeWNsb3VkXCJcbiAgICovXG4gIHJlYWRvbmx5IG5hbWVzcGFjZT86IHN0cmluZztcblxuICAvKipcbiAgICogQXBwIGluc3RhbmNlIGlkLlxuICAgKi9cbiAgcmVhZG9ubHkgYXBwOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGlkLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U6IHN0cmluZztcblxuICAvKipcbiAgICogVHdlbHZlLWRpZ2l0IGFjY291bnQgaWQuIEFuIHVucmVzb2x2ZWQgdG9rZW4gZmFpbHMgc3ludGhlc2lzLlxuICAgKi9cbiAgcmVhZG9ubHkgYWNjb3VudDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGdWxsIFJlZ2lvbiBjb2RlLCBmb3IgZXhhbXBsZSBgdXMtZWFzdC0xYC5cbiAgICovXG4gIHJlYWRvbmx5IHJlZ2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBQaHlzaWNhbCBwaW5zIGtleWVkIGB7dHlwZX06e2xvZ2ljYWx9YC5cbiAgICogQGRlZmF1bHQge31cbiAgICovXG4gIHJlYWRvbmx5IHBpbnM/OiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9O1xuXG4gIC8qKlxuICAgKiBHZW5lcmF0ZWQtbmFtZSBlbnRyaWVzIGtleWVkIGB7dHlwZX06e2xvZ2ljYWx9YC4gQW4gZW50cnkgbWVhbnNcbiAgICogQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lIHRvZGF5LCBzbyB0aGUgY29uc3RydWN0IHNldHMgbm9cbiAgICogcGh5c2ljYWwtbmFtZSBwcm9wZXJ0eS4gVmFsaWQgb25seSB1bmRlciB0aGUgbGVnYWN5IG5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRURcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU/OiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU/OiBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nIHJldGVudGlvbiBpbiBkYXlzIGZvciBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cHMuXG4gICAqIEBkZWZhdWx0IDMwXG4gICAqL1xuICByZWFkb25seSByZXRlbnRpb25EYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRoZSBjb21wb3NlZCBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAvKipcbiAgICogVGhlIGZ1bGwgcGh5c2ljYWwgbmFtZS4gQWJzZW50IHdoZW4gQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBhY2NvdW50LXJlZ2lvbmFsIGJ1Y2tldC1uYW1lIHByZWZpeCwgd2hlbiB0aGUgdHlwZSB1c2VzIG9uZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBidWNrZXROYW1lUHJlZml4Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYnVja2V0IG5hbWVzcGFjZSwgd2hlbiB0aGUgdHlwZSB1c2VzIG9uZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBidWNrZXROYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIG5hbWUgY2FtZSBmcm9tIGEgcGluLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcGlubmVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUsIHNvIG5vIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkgaXNcbiAgICogc2V0LlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBPbmUgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSBhIHN0YWNrIGRlY2xhcmVzLCBhcyB0aGUgc3ludGggY2hlY2sgKGNvbnRyYWN0XG4gKiBzZWN0aW9uIDExLjQpIGNvbnN1bWVzIGl0LiBBIGdlbmVyYXRlZCBlbnRyeSBjYXJyaWVzIG5vIG5hbWU6IENsb3VkRm9ybWF0aW9uXG4gKiBvd25zIHRoZSBuYW1lLCBzbyB0aGVyZSBpcyBub3RoaW5nIHRvIHJlc2VydmUuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dCB7XG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWwgbmFtZS4gQWJzZW50IGZvciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJhY3QgcmVzb3VyY2UgdHlwZSwgZm9yIGV4YW1wbGUgYGxhbWJkYV9mdW5jdGlvbmAuXG4gICAqL1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbmFtZSwgb3Ig4oCUIHdoZW5cbiAgICogdGhlIGNhbGxlcidzIG5hbWluZyBjb250ZXh0IHNwYW5zIHNldmVyYWwgc3RhY2tzIOKAlCB0aGUgb3duaW5nIHN0YWNrJ3NcbiAgICogY29uc3RydWN0IHBhdGggcGx1cyB0aGF0IGxvZ2ljYWwgaWQsIGJlY2F1c2UgYSBsb2dpY2FsIGlkIGlzIHVuaXF1ZSBvbmx5XG4gICAqIHdpdGhpbiBvbmUgdGVtcGxhdGUuXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsSWQ6IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUsIHNvIG5vdGhpbmcgaXMgcmVzZXJ2ZWQuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9uZSByb3cgb2YgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdDogdGhlIGNvbXBsZXRlIHNldCB0aGUgbmFtZSByZXNlcnZhdGlvblxuICogaW5kZXggKGNvbnRyYWN0IHNlY3Rpb24gMTEuMikgcmVzZXJ2ZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RGVyaXZlZE5hbWUge1xuICAvKipcbiAgICogVGhlIHBoeXNpY2FsIG5hbWUuIEFic2VudCBmb3IgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IHJlc291cmNlIHR5cGUuXG4gICAqL1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBzY29wZSBpbiB3aGljaCBBV1MgcmVxdWlyZXMgdGhlIG5hbWUgdG8gYmUgdW5pcXVlOiBgYWNjb3VudGAsXG4gICAqIGBhY2NvdW50X3JlZ2lvbmAsIG9yIGBub3RfdW5pcXVlYC5cbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxJZDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSwgc28gbm90aGluZyBpcyByZXNlcnZlZC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogVGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBhIG5hbWluZyBjb250ZXh0IGVtaXRzIGF0IHN5bnRoZXNpcyAoY29udHJhY3RcbiAqIHNlY3Rpb24gMTEuNCksIGtleWVkIGB7c3RhY2t9Lm1ldGFkYXRhLmpzb25gIGluIHRoZSBjbG91ZCBhc3NlbWJseS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlEZXJpdmVkTmFtZXMge1xuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IGlkZW50aWZpZXIuXG4gICAqL1xuICByZWFkb25seSBjb250cmFjdDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYXJ0aWZhY3Qgc2NoZW1hIGlkZW50aWZpZXIuXG4gICAqL1xuICByZWFkb25seSBzY2hlbWE6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5hbWluZyBjb250ZXh0IHRoYXQgcHJvZHVjZWQgdGhlIGFydGlmYWN0LlxuICAgKi9cbiAgcmVhZG9ubHkgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcztcblxuICAvKipcbiAgICogRXZlcnkgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSB0aGUgY29udGV4dCBkZWNsYXJlcywgc29ydGVkIGJ5IGBzY29wZWAsXG4gICAqIGB0eXBlYCwgYG5hbWVgIGFuZCBgbG9naWNhbElkYC5cbiAgICovXG4gIHJlYWRvbmx5IGVudHJpZXM6IEFwcFRoZW9yeURlcml2ZWROYW1lW107XG59XG5cbi8qKlxuICogVGhlIG5hbWluZyBzY29wZXMgb2YgY29udHJhY3Qgc2VjdGlvbiAxMS4xLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlOYW1pbmdTY29wZSB7XG4gIC8qKlxuICAgKiBBV1Mga2VlcHMgdGhlIG5hbWUgdW5pcXVlIGFjcm9zcyB0aGUgd2hvbGUgYWNjb3VudCwgd2hhdGV2ZXIgdGhlIFJlZ2lvbi5cbiAgICovXG4gIEFDQ09VTlQgPSBcImFjY291bnRcIixcbiAgLyoqXG4gICAqIEFXUyBrZWVwcyB0aGUgbmFtZSB1bmlxdWUgcGVyIGFjY291bnQgYW5kIFJlZ2lvbi5cbiAgICovXG4gIEFDQ09VTlRfUkVHSU9OID0gXCJhY2NvdW50X3JlZ2lvblwiLFxuICAvKipcbiAgICogQVdTIGRvZXMgbm90IGtlZXAgdGhlIG5hbWUgdW5pcXVlLCBzbyBub3RoaW5nIGlzIHJlc2VydmVkIGZvciBpdC5cbiAgICovXG4gIE5PVF9VTklRVUUgPSBcIm5vdF91bmlxdWVcIixcbn1cblxuLyoqXG4gKiBJbmNsdWRlIGFuZCBleGNsdWRlIHZpc2liaWxpdHkgc2VsZWN0b3JzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyB7XG4gIC8qKlxuICAgKiBTZWxlY3RvcnMgd2hvc2Ugc291cmNlcyBhcmUgc2hhcmVkLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgaW5jbHVkZT86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBTZWxlY3RvcnMgd2hvc2Ugc291cmNlcyBhcmUgbmV2ZXIgc2hhcmVkLiBFeGNsdXNpb25zIHdpbi5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGV4Y2x1ZGU/OiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBUaGUgc3ludGgtdGltZSB2aXNpYmlsaXR5IHByZXZpZXcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eVByZXZpZXcge1xuICAvKipcbiAgICogRmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgdGhlIGNhbm9uaWNhbCBydWxlcyBoYXNoLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIGRvIG5vdCBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG5vdE1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgc2VsZWN0b3JzLCBhcyB0aGUgc3RhdGVtZW50IG9mIHdoYXQgZnV0dXJlIHNvdXJjZXMgd2lsbCBtYXRjaC5cbiAgICovXG4gIHJlYWRvbmx5IGZ1dHVyZTogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xufVxuXG4vKipcbiAqIFRoZSBwdWJsaXNoZWQgU1NNIG1hbmlmZXN0OiB0aGUgcHJldmlldyBtaW51cyBgbm90TWF0Y2hlZE5vd2AuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0IHtcbiAgLyoqXG4gICAqIEZpcnN0IDEyIGhleCBjaGFyYWN0ZXJzIG9mIHRoZSBjYW5vbmljYWwgcnVsZXMgaGFzaC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bGVWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgc2hhcmUuXG4gICAqL1xuICByZWFkb25seSBtYXRjaGVkTm93OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIHNlbGVjdG9ycywgYXMgdGhlIHN0YXRlbWVudCBvZiB3aGF0IGZ1dHVyZSBzb3VyY2VzIHdpbGwgbWF0Y2guXG4gICAqL1xuICByZWFkb25seSBmdXR1cmU6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcztcbn1cblxuY29uc3QgU0VHTUVOVF9QQVRURVJOID0gTE9HSUNBTF9TRUdNRU5UX1BBVFRFUk47XG5jb25zdCBMT0dJQ0FMX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSg/Oi8ke1NFR01FTlRfUEFUVEVSTn0pKiRgKTtcbmNvbnN0IEFQUF9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0kYCk7XG5jb25zdCBTVEFHRV9SRSA9IC9eW2Etel1bYS16MC05XXswLDd9JC87XG5jb25zdCBOQU1FU1BBQ0VfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59JGApO1xuY29uc3QgQUNDT1VOVF9SRSA9IC9eWzAtOV17MTJ9JC87XG5jb25zdCBSRUdJT05fUkUgPSAvXlthLXpdezJ9KD86LVthLXpdKykrLVswLTldJC87XG5jb25zdCBTRUNSRVRfVEFJTF9SRSA9IC8tW0EtWmEtejAtOV17Nn0kLztcbmNvbnN0IFMzX0VER0VTX1JFID0gL15bYS16MC05XS4qW2EtejAtOV0kLztcbmNvbnN0IExPR19QUkVGSVggPSBcInRoZW9yeWNsb3VkXCI7XG5jb25zdCBST0xFX1BPTElDWV9NQVggPSAxMDI0MDtcbmNvbnN0IEJBU0UzMiA9IFwiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoyMzQ1NjdcIjtcblxuaW50ZXJmYWNlIFJ1bGUge1xuICByZWFkb25seSBraW5kOiBcImRhc2hcIiB8IFwicGF0aFwiIHwgXCJzM2FyXCIgfCBcImxvZ1wiO1xuICByZWFkb25seSBtYXg6IG51bWJlcjtcbiAgLyoqXG4gICAqIFRoZSBsb3dlciBib3VuZCBjb250cmFjdCBzZWN0aW9uIDIgc3RhdGVzIGZvciB0aGUgdHlwZSwgd2hlbiBpdCBzdGF0ZXMgb25lLlxuICAgKiBBIHJvdyB0aGF0IHN0YXRlcyBvbmx5IGFuIHVwcGVyIGxpbWl0IGhhcyBub25lIGhlcmUsIHNvIHRoZSB0YWJsZSBzdGF5cyB0aGVcbiAgICogc2VjdGlvbiAyIHRhYmxlIGFuZCBub3QgYSBzdHJpY3RlciBwcml2YXRlIG9uZS5cbiAgICovXG4gIHJlYWRvbmx5IG1pbj86IG51bWJlcjtcbiAgcmVhZG9ubHkgY2hhcnNldDogc3RyaW5nO1xuICByZWFkb25seSBsZWFkPzogc3RyaW5nO1xufVxuXG5jb25zdCBSVUxFUzogeyBbdHlwZTogc3RyaW5nXTogUnVsZSB9ID0ge1xuICBzM19idWNrZXQ6IHsga2luZDogXCJzM2FyXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgczNfdmVjdG9yX2J1Y2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MywgY2hhcnNldDogXCJbYS16MC05LV1cIiB9LFxuICBzM192ZWN0b3JfaW5kZXg6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgLy8gU2VjdGlvbiAyOiBcIjI1NSAocGxhaW4tbmFtZSBsaW1pdCAz4oCTMjU1OyB0aGUgMTAyNCBsaW1pdCBhcHBsaWVzIHRvIHRoZSBBUk5cbiAgLy8gZm9ybSlcIi4gVGhlIGxvd2VyIGJvdW5kIGlzIHBhcnQgb2YgdGhlIHJvdywgc28gYSBmaXhlZCBuYW1lIG9mIG9uZSBvciB0d29cbiAgLy8gY2hhcmFjdGVycyBpcyByZWZ1c2VkIChTQU5JVFktQVQtTjMtMDgpLlxuICBkeW5hbW9kYl90YWJsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIG1pbjogMywgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGxhbWJkYV9mdW5jdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc3FzX3F1ZXVlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDgwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzbnNfdG9waWM6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzZWNyZXQ6IHsga2luZDogXCJwYXRoXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTkvXys9LkAtXVwiIH0sXG4gIHNzbV9wYXJhbWV0ZXI6IHsga2luZDogXCJwYXRoXCIsIG1heDogOTAwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLi8tXVwiLCBsZWFkOiBcIi9cIiB9LFxuICBrbXNfYWxpYXM6IHsga2luZDogXCJwYXRoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTkvXy1dXCIsIGxlYWQ6IFwiYWxpYXMvXCIgfSxcbiAgZXZlbnRfYnVzOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGV2ZW50X3J1bGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBzY2hlZHVsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGFsYXJtOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGRhc2hib2FyZDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGlhbV9yb2xlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkrPSwuQF8tXVwiIH0sXG4gIGlhbV9tYW5hZ2VkX3BvbGljeTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOSs9LC5AXy1dXCIgfSxcbiAgc3RhdGVfbWFjaGluZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA4MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgY29kZWJ1aWxkX3Byb2plY3Q6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTUwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfcmVzdDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV9odHRwOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgYXBpX3dlYnNvY2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9zb3VyY2U6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9kZXN0aW5hdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2dyb3VwOiB7IGtpbmQ6IFwibG9nXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxufTtcblxuLyoqXG4gKiBUaGUgcnVsZXMgb2Ygb25lIGNvbnRyYWN0IHR5cGUsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlIGNvbnRyYWN0IHN0YXRlcyBub25lXG4gKiAoY29udHJhY3Qgc2VjdGlvbiAyKS4gVGhlIGxvb2t1cCBpcyBhbiBvd24tcHJvcGVydHkgY2hlY2ssIHNvIGFuIGluaGVyaXRlZFxuICogbmFtZSBzdWNoIGFzIGBjb25zdHJ1Y3RvcmAsIGB0b1N0cmluZ2AsIGBfX3Byb3RvX19gIG9yIGBoYXNPd25Qcm9wZXJ0eWAgaXMgYW5cbiAqIHVua25vd24gdHlwZSwgbmV2ZXIgYSB0eXBlIHdpdGggcnVsZXMuXG4gKi9cbmZ1bmN0aW9uIG5hbWluZ1J1bGUocmVzb3VyY2VUeXBlOiBzdHJpbmcpOiBSdWxlIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFPYmplY3QuaGFzT3duKFJVTEVTLCByZXNvdXJjZVR5cGUpKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gUlVMRVNbcmVzb3VyY2VUeXBlXTtcbn1cblxuLyoqXG4gKiBBUEkgbmFtZSB0eXBlcy4gVGhlIENESyBkZWZhdWx0cyBhbiBBUEkgTmFtZSB0b2RheSwgc28gYSBuYW1lIGZvciBvbmUgaXNcbiAqIGV4cGxpY2l0IGFuZCB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnkgKHIzLCBBRFYtMTMxMi0zKS5cbiAqL1xuY29uc3QgQVBJX1RZUEVTID0gbmV3IFNldChbXCJhcGlfcmVzdFwiLCBcImFwaV9odHRwXCIsIFwiYXBpX3dlYnNvY2tldFwiXSk7XG5cbi8qKlxuICogVHlwZXMgd2hvc2Ugc2VjdGlvbiAyIHJvdyBhZGRzIHRoZSBTMyBzdGFydC9lbmQtYWxwaGFudW1lcmljIHJ1bGUuXG4gKi9cbmNvbnN0IFMzX1RZUEVTID0gbmV3IFNldChbXCJzM19idWNrZXRcIiwgXCJzM192ZWN0b3JfYnVja2V0XCIsIFwiczNfdmVjdG9yX2luZGV4XCJdKTtcblxuLyoqXG4gKiBUeXBlcyB3aG9zZSBmaXhlZC1uYW1lIGNoYXJzZXQgZGlmZmVycyBmcm9tIHRoZSBkZXJpdmVkLW5hbWUgY2hhcnNldCBvZiB0aGVpclxuICogc2VjdGlvbiAyIHJvdy4gQSBsb2cgZ3JvdXAgaXMgdGhlIG9ubHkgb25lOiBvbmUgb2YgaXRzIHR3byBmaXhlZCBzaGFwZXMgaXMgdGhlXG4gKiBMYW1iZGEgc2VydmljZSBwYXRoIGAvYXdzL2xhbWJkYS97ZnVuY3Rpb24gbmFtZX1gIChzZWN0aW9uIDMpLCBzbyBgL2AgaXMgcGFydFxuICogb2YgdGhlIGNoYXJzZXQgZXZlbiB0aG91Z2ggbm8gZGVyaXZlZCBsb2ctZ3JvdXAgbmFtZSBjb250YWlucyBvbmUuIFRoZSBzaGFwZVxuICogcnVsZSBiZWxvdyBpcyB3aGF0IG5hcnJvd3MgaXQgYWdhaW46IGV2ZXJ5IG90aGVyIGAvYC1iZWFyaW5nIGxvZyBncm91cCBpc1xuICogcmVmdXNlZC5cbiAqL1xuY29uc3QgRklYRURfTkFNRV9DSEFSU0VUUyA9IG5ldyBNYXAoW1tcImxvZ19ncm91cFwiLCBcIltBLVphLXowLTlfLy1dXCJdXSk7XG5cbi8qKlxuICogVGhlIEtNUyBhbGlhcyBwYXRoIGxlYWQgKGNvbnRyYWN0IHNlY3Rpb24gMikuXG4gKi9cbmNvbnN0IEtNU19BTElBU19MRUFEID0gXCJhbGlhcy9cIjtcblxuLyoqXG4gKiBBbiBhYnNvbHV0ZSBTU00gcGFyYW1ldGVyIHBhdGg6IGEgbGVhZCBgL2AsIHRoZW4gYXQgbGVhc3Qgb25lIG5vbi1lbXB0eVxuICogc2VnbWVudCwgd2l0aCBubyBlbXB0eSBzZWdtZW50IGFueXdoZXJlIChjb250cmFjdCBzZWN0aW9uIDIpLlxuICovXG5jb25zdCBTU01fUEFUSF9SRSA9IC9eXFwvW14vXSsoPzpcXC9bXi9dKykqJC87XG5cbi8qKlxuICogV2hldGhlciBhIGZpeGVkIGxvZy1ncm91cCBuYW1lIGlzIG9uZSBvZiB0aGUgdHdvIHNoYXBlcyBjb250cmFjdCBzZWN0aW9uIDNcbiAqIHN0YXRlcywgYW5kIG5vdGhpbmcgZWxzZTpcbiAqXG4gKiAtIGEgbG9nLXNvdXJjZSBuYW1lLCBgdGhlb3J5Y2xvdWRfe25hbWVzcGFjZX1fe2FwcH1fe3N0YWdlfV97bG9naWNhbH1gLiBJdHNcbiAqICAgc2VnbWVudHMgYXJlIGpvaW5lZCB3aXRoIGBfYCBwcmVjaXNlbHkgc28gdGhlIG9uZSBncmFtbWFyIGFsc28gc2F0aXNmaWVzXG4gKiAgIENsb3VkRnJvbnQncyBgW1xcdy1dYCBkZXN0aW5hdGlvbiwgc28gc3VjaCBhIG5hbWUgY2FycmllcyBubyBgL2AgYXQgYWxsO1xuICogLSB0aGUgTGFtYmRhIHNlcnZpY2UgcGF0aCBgL2F3cy9sYW1iZGEve2Z1bmN0aW9uIG5hbWV9YCwgd2hvc2UgZnVuY3Rpb24gbmFtZVxuICogICBzYXRpc2ZpZXMgdGhlIGBsYW1iZGFfZnVuY3Rpb25gIHJvdyBvZiBzZWN0aW9uIDIgKGxlbmd0aCBhbmQgY2hhcnNldCkuXG4gKlxuICogQW55IG90aGVyIGAvYC1iZWFyaW5nIG5hbWUgaXMgcmVmdXNlZDogYGFyYml0cmFyeS9wYXRoYCBpcyBuZWl0aGVyIHNoYXBlXG4gKiAoU0FOSVRZLUFULU4zLTA4KS5cbiAqXG4gKiBUaGUgbG9nLXNvdXJjZSBicmFuY2ggaGVyZSBpcyBhIHNoYXBlIHRlc3Qgb25seSwgbm90IGFuIGlkZW50aXR5IHRlc3Q6IGl0XG4gKiBjYW5ub3QgdGVsbCB3aG9zZSBjb250ZXh0IGEgbmFtZSBiZWxvbmdzIHRvLiBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dGBcbiAqIG5hcnJvd3MgaXQgdG8gdGhlIGNvbnRleHQncyBvd24gYHRoZW9yeWNsb3VkX3tuYW1lc3BhY2V9X3thcHB9X3tzdGFnZX1fYFxuICogcHJlZml4IGFuZCByZW1haW5kZXIgZ3JhbW1hciB3aGVuIGl0IGRlY2xhcmVzIGEgZml4ZWQgbmFtZS5cbiAqL1xuZnVuY3Rpb24gaXNGaXhlZExvZ0dyb3VwU2hhcGUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghbmFtZS5pbmNsdWRlcyhcIi9cIikpIHJldHVybiB0cnVlO1xuICBpZiAoIW5hbWUuc3RhcnRzV2l0aChMQU1CREFfTE9HX0dST1VQX0xFQUQpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGZ1bmN0aW9uTmFtZSA9IG5hbWUuc2xpY2UoTEFNQkRBX0xPR19HUk9VUF9MRUFELmxlbmd0aCk7XG4gIGNvbnN0IGxhbWJkYSA9IFJVTEVTLmxhbWJkYV9mdW5jdGlvbjtcbiAgaWYgKGZ1bmN0aW9uTmFtZS5sZW5ndGggPiBsYW1iZGEubWF4KSByZXR1cm4gZmFsc2U7XG4gIGlmIChsYW1iZGEubWluICE9PSB1bmRlZmluZWQgJiYgZnVuY3Rpb25OYW1lLmxlbmd0aCA8IGxhbWJkYS5taW4pIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIG5ldyBSZWdFeHAoYF4oPzoke2xhbWJkYS5jaGFyc2V0fSkrJGApLnRlc3QoZnVuY3Rpb25OYW1lKTtcbn1cblxuLyoqXG4gKiBUeXBlcyBBV1Mga2VlcHMgdW5pcXVlIGFjcm9zcyBSZWdpb25zIChjb250cmFjdCBzZWN0aW9uIDExLjEpLlxuICovXG5jb25zdCBBQ0NPVU5UX0dMT0JBTF9UWVBFUyA9IG5ldyBTZXQoW1wiaWFtX3JvbGVcIiwgXCJpYW1fbWFuYWdlZF9wb2xpY3lcIiwgXCJkYXNoYm9hcmRcIl0pO1xuXG4vKipcbiAqIEFQSSBkaXNwbGF5IG5hbWVzIEFXUyBkb2VzIG5vdCBrZWVwIHVuaXF1ZSwgc28gbm90aGluZyBpcyByZXNlcnZlZCBmb3IgdGhlbS5cbiAqL1xuY29uc3QgTk9UX1VOSVFVRV9UWVBFUyA9IG5ldyBTZXQoW1wiYXBpX3Jlc3RcIiwgXCJhcGlfaHR0cFwiLCBcImFwaV93ZWJzb2NrZXRcIl0pO1xuXG4vKipcbiAqIFRoZSByZWZ1c2FsIGZvciBhIHR5cGUgdGhlIGNvbnRyYWN0IHN0YXRlcyBubyBuYW1pbmcgc2NvcGUgZm9yOiBpdCBjYW5ub3QgYmVcbiAqIHJlc2VydmVkLCBzbyBpdCBjYW5ub3QgYmUgZGVwbG95ZWQgdGhyb3VnaCB0aGUgaW5kZXggdW50aWwgYSByZXZpc2lvbiBzdGF0ZXNcbiAqIGl0cyBzY29wZS5cbiAqL1xuY29uc3QgVU5LTk9XTl9OQU1JTkdfU0NPUEUgPSBcImEgdHlwZSB3aXRoIG5vIHN0YXRlZCBuYW1pbmcgc2NvcGUgY2Fubm90IGJlIHJlc2VydmVkXCI7XG5cbmNvbnN0IEtFRVBFUl9BQ1RJT05TX0dST1VQID0gW1wibG9nczpGaWx0ZXJMb2dFdmVudHNcIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiXTtcbmNvbnN0IEtFRVBFUl9BQ1RJT05TX1NUUkVBTSA9IFtcImxvZ3M6R2V0TG9nRXZlbnRzXCJdO1xuXG5mdW5jdGlvbiBmYWlsKG1lc3NhZ2U6IHN0cmluZyk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBzaGEyNTZIZXgodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHRleHQsIFwidXRmOFwiKS5kaWdlc3QoXCJoZXhcIik7XG59XG5cbmZ1bmN0aW9uIGJhc2UzMkxvd2VyKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJ5dGVzID0gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUodGV4dCwgXCJ1dGY4XCIpLmRpZ2VzdCgpO1xuICBsZXQgYml0cyA9IDA7XG4gIGxldCB2YWx1ZSA9IDA7XG4gIGxldCBvdXQgPSBcIlwiO1xuICBmb3IgKGNvbnN0IGJ5dGUgb2YgYnl0ZXMpIHtcbiAgICB2YWx1ZSA9ICh2YWx1ZSA8PCA4KSB8IGJ5dGU7XG4gICAgYml0cyArPSA4O1xuICAgIHdoaWxlIChiaXRzID49IDUpIHtcbiAgICAgIG91dCArPSBCQVNFMzJbKHZhbHVlID4+PiAoYml0cyAtIDUpKSAmIDMxXTtcbiAgICAgIGJpdHMgLT0gNTtcbiAgICB9XG4gIH1cbiAgaWYgKGJpdHMgPiAwKSBvdXQgKz0gQkFTRTMyWyh2YWx1ZSA8PCAoNSAtIGJpdHMpKSAmIDMxXTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gc2hvcnRlbihmdWxsOiBzdHJpbmcsIGxpbWl0OiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoZnVsbC5sZW5ndGggPD0gbGltaXQpIHJldHVybiBmdWxsO1xuICBjb25zdCBoZWFkID0gZnVsbC5zbGljZSgwLCBsaW1pdCAtIDkpLnJlcGxhY2UoL1stXy4vXSskLywgXCJcIik7XG4gIHJldHVybiBgJHtoZWFkfS0ke2Jhc2UzMkxvd2VyKGZ1bGwpLnNsaWNlKDAsIDgpfWA7XG59XG5cbmZ1bmN0aW9uIG5hbWVzcGFjZU9mKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZXMubmFtZXNwYWNlID8/IExPR19QUkVGSVg7XG59XG5cbmZ1bmN0aW9uIHNvcnRlZENvcHkodmFsdWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KHZhbHVlcyA/PyBbXSldLnNvcnQoKTtcbn1cblxuZnVuY3Rpb24gbG9nUHJlZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gIHJldHVybiBbTE9HX1BSRUZJWCwgbmFtZXNwYWNlT2YodmFsdWVzKSwgdmFsdWVzLmFwcCwgdmFsdWVzLnN0YWdlXS5qb2luKFwiX1wiKSArIFwiX1wiO1xufVxuXG4vKipcbiAqIFRoZSBgdGhlb3J5Y2xvdWRfcmVzb3VyY2VfbmFtaW5nLnYwLjFgIHByaW1pdGl2ZXMsIGV4cG9zZWQgZm9yIGpzaWkgc28gdGhlIEdvXG4gKiBhbmQgUHl0aG9uIENESyBiaW5kaW5ncyBzaGFyZSBvbmUgaW1wbGVtZW50YXRpb24uXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZyB7XG4gIHByaXZhdGUgY29uc3RydWN0b3IoKSB7fVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSB0aGUgYm91bmQgY29udGV4dCBncmFtbWFyLiBUaHJvd3Mgb24gYW4gaW52YWxpZCBjb250ZXh0LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZUNvbnRleHQodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogdm9pZCB7XG4gICAgaWYgKCFBUFBfUkUudGVzdCh2YWx1ZXMuYXBwKSkgZmFpbChcImFwcFwiKTtcbiAgICBpZiAoIVNUQUdFX1JFLnRlc3QodmFsdWVzLnN0YWdlKSkgZmFpbChcInN0YWdlXCIpO1xuICAgIGlmICghQUNDT1VOVF9SRS50ZXN0KHZhbHVlcy5hY2NvdW50KSkgZmFpbChcImFjY291bnRcIik7XG4gICAgaWYgKCFSRUdJT05fUkUudGVzdCh2YWx1ZXMucmVnaW9uKSkgZmFpbChcInJlZ2lvblwiKTtcbiAgICBpZiAoIU5BTUVTUEFDRV9SRS50ZXN0KG5hbWVzcGFjZU9mKHZhbHVlcykpKSBmYWlsKFwibmFtZXNwYWNlXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbi1hcHBlbmRlZCBhY2NvdW50LXJlZ2lvbmFsIGJ1Y2tldCBzdWZmaXguXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHMzQWNjb3VudFJlZ2lvbmFsU3VmZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAtJHt2YWx1ZXMuYWNjb3VudH0tJHt2YWx1ZXMucmVnaW9ufS1hbmA7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGJvdW5kIHByZWZpeCBzaGFyZWQgYnkgZXZlcnkgbG9nIHNvdXJjZSBvZiB0aGUgYXBwLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBsb2dTb3VyY2VQcmVmaXgodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogc3RyaW5nIHtcbiAgICByZXR1cm4gbG9nUHJlZml4KHZhbHVlcyk7XG4gIH1cblxuICAvKipcbiAgICogTWFwIGEgbG9naWNhbCBsb2cgc291cmNlIHRvIGl0cyBwaHlzaWNhbCBsb2ctZ3JvdXAgbmFtZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbG9nR3JvdXBOYW1lKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcywgbG9naWNhbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAoIWxvZ2ljYWwuc3RhcnRzV2l0aChcImxvZ3MvXCIpKSBmYWlsKFwibG9nIGxvZ2ljYWwgbXVzdCBzdGFydCB3aXRoIGxvZ3MvXCIpO1xuICAgIHJldHVybiBsb2dQcmVmaXgodmFsdWVzKSArIGxvZ2ljYWwucmVwbGFjZSgvXFwvL2csIFwiX1wiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21wb3NlIHRoZSBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZS4gQSBwaW4gYWx3YXlzIHdpbnMuIEEgZ2VuZXJhdGVkXG4gICAqIGVudHJ5IG1lYW5zIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSB0b2RheSBhbmQgdGhlIGNvbnN0cnVjdCBzZXRzXG4gICAqIG5vIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkuIEdlbmVyYXRlZCBlbnRyaWVzIGFyZSBsZWdhY3ktb25seTsgYSBsZWdhY3lcbiAgICogcHJvZmlsZSBuZWVkcyBleGFjdGx5IG9uZSBvZiBhIHBpbiBvciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcGh5c2ljYWxOYW1lKFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICByZXNvdXJjZVR5cGU6IHN0cmluZyxcbiAgICBsb2dpY2FsOiBzdHJpbmcsXG4gICk6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZSB7XG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHZhbHVlcyk7XG4gICAgaWYgKCFMT0dJQ0FMX1JFLnRlc3QobG9naWNhbCkpIGZhaWwoXCJsb2dpY2FsXCIpO1xuICAgIGNvbnN0IHJ1bGUgPSBuYW1pbmdSdWxlKHJlc291cmNlVHlwZSk7XG4gICAgaWYgKCFydWxlKSBmYWlsKGByZXNvdXJjZSB0eXBlICR7cmVzb3VyY2VUeXBlfWApO1xuICAgIGNvbnN0IGdlbmVyYXRlZCA9IHZhbHVlcy5nZW5lcmF0ZWQgPz8gW107XG4gICAgY29uc3QgbGVnYWN5ID0gKHZhbHVlcy5uYW1pbmdQcm9maWxlID8/IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRCkgPT09IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuTEVHQUNZO1xuICAgIGlmIChnZW5lcmF0ZWQubGVuZ3RoID4gMCAmJiAhbGVnYWN5KSB7XG4gICAgICBmYWlsKFwiZ2VuZXJhdGVkIGVudHJpZXMgYXJlIG9ubHkgdmFsaWQgdW5kZXIgdGhlIGxlZ2FjeSBuYW1pbmcgcHJvZmlsZVwiKTtcbiAgICB9XG4gICAgY29uc3Qga2V5ID0gYCR7cmVzb3VyY2VUeXBlfToke2xvZ2ljYWx9YDtcbiAgICBjb25zdCBwaW4gPSB2YWx1ZXMucGlucz8uW2tleV07XG4gICAgY29uc3Qga2VlcEdlbmVyYXRlZCA9IGdlbmVyYXRlZC5pbmNsdWRlcyhrZXkpO1xuICAgIC8vIHIzLCBBRFYtMTMxMi0zOiBDREsgZGVmYXVsdHMgYW4gQVBJIE5hbWUgdG9kYXksIHNvIGl0IGlzIGFuIGV4cGxpY2l0IG5hbWVcbiAgICAvLyBhbmQgdGFrZXMgYSBwaW4sIG5ldmVyIGEgZ2VuZXJhdGVkIGVudHJ5LlxuICAgIGlmIChrZWVwR2VuZXJhdGVkICYmIEFQSV9UWVBFUy5oYXMocmVzb3VyY2VUeXBlKSkge1xuICAgICAgZmFpbChcImFuIEFQSSBuYW1lIHRha2VzIGEgcGluLCBuZXZlciBhIGdlbmVyYXRlZCBlbnRyeVwiKTtcbiAgICB9XG4gICAgaWYgKHBpbiAhPT0gdW5kZWZpbmVkICYmIGtlZXBHZW5lcmF0ZWQpIGZhaWwoXCJhIHJlc291cmNlIGhhcyBib3RoIGEgcGluIGFuZCBhIGdlbmVyYXRlZCBlbnRyeVwiKTtcbiAgICBpZiAocGluICE9PSB1bmRlZmluZWQpIHJldHVybiB7IG5hbWU6IHBpbiwgcGlubmVkOiB0cnVlIH07XG4gICAgaWYgKGtlZXBHZW5lcmF0ZWQpIHJldHVybiB7IGdlbmVyYXRlZDogdHJ1ZSB9O1xuICAgIGlmIChsZWdhY3kpIHtcbiAgICAgIGZhaWwoYGxlZ2FjeSBuYW1pbmcgcHJvZmlsZSByZXF1aXJlcyBhIHBpbiBvciBhIGdlbmVyYXRlZCBlbnRyeSBmb3IgJHtrZXl9YCk7XG4gICAgfVxuXG4gICAgbGV0IG91dDogQXBwVGhlb3J5UGh5c2ljYWxOYW1lO1xuICAgIGlmIChydWxlLmtpbmQgPT09IFwiczNhclwiKSB7XG4gICAgICBjb25zdCBzdWZmaXggPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zM0FjY291bnRSZWdpb25hbFN1ZmZpeCh2YWx1ZXMpO1xuICAgICAgY29uc3QgYnVkZ2V0ID0gcnVsZS5tYXggLSBzdWZmaXgubGVuZ3RoO1xuICAgICAgY29uc3QgcHJlZml4ID0gc2hvcnRlbihgJHt2YWx1ZXMuYXBwfS0ke3ZhbHVlcy5zdGFnZX0tJHtsb2dpY2FsLnJlcGxhY2UoL1xcLy9nLCBcIi1cIil9YCwgYnVkZ2V0KTtcbiAgICAgIG91dCA9IHsgbmFtZTogcHJlZml4ICsgc3VmZml4LCBidWNrZXROYW1lUHJlZml4OiBwcmVmaXgsIGJ1Y2tldE5hbWVzcGFjZTogXCJhY2NvdW50LXJlZ2lvbmFsXCIgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJkYXNoXCIpIHtcbiAgICAgIG91dCA9IHsgbmFtZTogc2hvcnRlbihgJHt2YWx1ZXMuYXBwfS0ke3ZhbHVlcy5zdGFnZX0tJHtsb2dpY2FsLnJlcGxhY2UoL1xcLy9nLCBcIi1cIil9YCwgcnVsZS5tYXgpIH07XG4gICAgfSBlbHNlIGlmIChydWxlLmtpbmQgPT09IFwicGF0aFwiKSB7XG4gICAgICBjb25zdCBmdWxsID0gYCR7cnVsZS5sZWFkID8/IFwiXCJ9JHt2YWx1ZXMuYXBwfS8ke3ZhbHVlcy5zdGFnZX0vJHtsb2dpY2FsfWA7XG4gICAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcInNlY3JldFwiICYmIFNFQ1JFVF9UQUlMX1JFLnRlc3QoZnVsbCkpIHtcbiAgICAgICAgZmFpbChcInNlY3JldCBuYW1lIG11c3Qgbm90IGVuZCB3aXRoIGEgaHlwaGVuIGFuZCBzaXggY2hhcmFjdGVyc1wiKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwic3NtX3BhcmFtZXRlclwiICYmIChmdWxsLm1hdGNoKC9cXC8vZyk/Lmxlbmd0aCA/PyAwKSA+IDE1KSB7XG4gICAgICAgIGZhaWwoXCJzc20gaGllcmFyY2h5IGRlZXBlciB0aGFuIDE1XCIpO1xuICAgICAgfVxuICAgICAgaWYgKGZ1bGwubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJwYXRoIG5hbWUgb3ZlciBsaW1pdFwiKTtcbiAgICAgIG91dCA9IHsgbmFtZTogZnVsbCB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcImxvZ1wiKSB7XG4gICAgICBjb25zdCBuYW1lID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nR3JvdXBOYW1lKHZhbHVlcywgbG9naWNhbCk7XG4gICAgICBpZiAobmFtZS5sZW5ndGggPiBydWxlLm1heCkgZmFpbChcImxvZyBncm91cCBvdmVyIGxpbWl0XCIpO1xuICAgICAgb3V0ID0geyBuYW1lIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZhaWwoYHVuc3VwcG9ydGVkIGtpbmQgJHtTdHJpbmcocnVsZS5raW5kKX1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBuYW1lID0gb3V0Lm5hbWUgYXMgc3RyaW5nO1xuICAgIGlmICghbmV3IFJlZ0V4cChgXig/OiR7cnVsZS5jaGFyc2V0fSkrJGApLnRlc3QobmFtZSkpIGZhaWwoXCJjaGFyc2V0XCIpO1xuICAgIGlmIChuYW1lLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwibGVuZ3RoXCIpO1xuICAgIGlmIChydWxlLm1pbiAhPT0gdW5kZWZpbmVkICYmIG5hbWUubGVuZ3RoIDwgcnVsZS5taW4pIGZhaWwoXCJsZW5ndGhcIik7XG4gICAgaWYgKFtcInMzX2J1Y2tldFwiLCBcInMzX3ZlY3Rvcl9idWNrZXRcIiwgXCJzM192ZWN0b3JfaW5kZXhcIl0uaW5jbHVkZXMocmVzb3VyY2VUeXBlKSAmJiAhUzNfRURHRVNfUkUudGVzdChuYW1lKSkge1xuICAgICAgZmFpbChcInMzIHN0YXJ0L2VuZFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgc2NvcGUgaW4gd2hpY2ggQVdTIHJlcXVpcmVzIGEgdHlwZSdzIG5hbWVzIHRvIGJlIHVuaXF1ZSAoY29udHJhY3RcbiAgICogc2VjdGlvbiAxMS4xKS4gQSB0eXBlIHRoZSBjb250cmFjdCBzdGF0ZXMgbm8gc2NvcGUgZm9yIGlzIHJlZnVzZWQ6IGl0IGNhbm5vdFxuICAgKiBiZSByZXNlcnZlZCwgc28gaXQgY2Fubm90IGJlIGRlcGxveWVkIHRocm91Z2ggdGhlIGluZGV4IHVudGlsIGEgcmV2aXNpb25cbiAgICogc3RhdGVzIGl0cyBzY29wZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbmFtaW5nU2NvcGUocmVzb3VyY2VUeXBlOiBzdHJpbmcpOiBBcHBUaGVvcnlOYW1pbmdTY29wZSB7XG4gICAgaWYgKG5hbWluZ1J1bGUocmVzb3VyY2VUeXBlKSA9PT0gdW5kZWZpbmVkKSBmYWlsKFVOS05PV05fTkFNSU5HX1NDT1BFKTtcbiAgICBpZiAoTk9UX1VOSVFVRV9UWVBFUy5oYXMocmVzb3VyY2VUeXBlKSkgcmV0dXJuIEFwcFRoZW9yeU5hbWluZ1Njb3BlLk5PVF9VTklRVUU7XG4gICAgaWYgKEFDQ09VTlRfR0xPQkFMX1RZUEVTLmhhcyhyZXNvdXJjZVR5cGUpKSByZXR1cm4gQXBwVGhlb3J5TmFtaW5nU2NvcGUuQUNDT1VOVDtcbiAgICByZXR1cm4gQXBwVGhlb3J5TmFtaW5nU2NvcGUuQUNDT1VOVF9SRUdJT047XG4gIH1cblxuICAvKipcbiAgICogVmFsaWRhdGUgYSBwaHlzaWNhbCBuYW1lIHRoZSBjb250cmFjdCBmaXhlcyByYXRoZXIgdGhhbiBkZXJpdmVzIGFnYWluc3QgdGhlXG4gICAqIGNoYXJhY3RlciBhbmQgc2hhcGUgcnVsZXMgb2YgdGhlIHR5cGUncyBzZWN0aW9uIDIgcm93OiBjaGFyc2V0LCB0aGUgbGVuZ3RoXG4gICAqIHJhbmdlICgqKmJvdGgqKiBib3VuZHMgd2hlbiB0aGUgcm93IHN0YXRlcyBhIGxvd2VyIG9uZSwgbm90IG9ubHkgdGhlIHVwcGVyKSxcbiAgICogdGhlIFMzIHN0YXJ0L2VuZCBydWxlLCB0aGUgcGF0aCBydWxlcyAobGVhZCwgbm9uLWVtcHR5IHNlZ21lbnRzLCBkZXB0aCxcbiAgICogcmVzZXJ2ZWQgcHJlZml4ZXMsIHRoZSBgYWxpYXMvYXdzL2AgbmFtZXNwYWNlKSBhbmQgdGhlIHNlY3JldCBBUk4tc3VmZml4XG4gICAqIHJ1bGUuIFRocm93cyBvbiBhIG5hbWUgb3V0c2lkZSB0aGVtLlxuICAgKlxuICAgKiBUaGlzIGlzIHRoZSBzZWN0aW9uIDIgdGFibGUsIG5vdCBhIHNlY29uZCBvbmU6IGl0IHJlYWRzIHRoZSBzYW1lIHJ1bGUgcm93c1xuICAgKiB0aGUgZGVyaXZhdGlvbiB1c2VzLiBBIGBsb2dfZ3JvdXBgIGFjY2VwdHMgYC9gIGluIGFkZGl0aW9uIHRvIHRoZSBzZWN0aW9uIDJcbiAgICogY2hhcnNldCwgYnV0IG9ubHkgZm9yIHRoZSB0d28gZml4ZWQgc2hhcGVzIGNvbnRyYWN0IHNlY3Rpb24gMyBzdGF0ZXM6IGFcbiAgICogbG9nLXNvdXJjZSBuYW1lICh3aGljaCBjYXJyaWVzIG5vIGAvYCBhdCBhbGwsIGJlY2F1c2Ugc2VjdGlvbiAzIGpvaW5zIGl0c1xuICAgKiBzZWdtZW50cyB3aXRoIGBfYCkgb3IgdGhlIExhbWJkYSBzZXJ2aWNlIHBhdGggYC9hd3MvbGFtYmRhL3tmdW5jdGlvbiBuYW1lfWAsXG4gICAqIHdob3NlIGZ1bmN0aW9uIG5hbWUgc2F0aXNmaWVzIHRoZSBgbGFtYmRhX2Z1bmN0aW9uYCByb3cuIEFueSBvdGhlclxuICAgKiBgL2AtYmVhcmluZyBsb2cgZ3JvdXAgaXMgcmVmdXNlZCAoU0FOSVRZLUFULU4zLTA4KS5cbiAgICpcbiAgICogVGhlIGNoZWNrIGlzICoqc3RydWN0dXJhbCoqOiBpdCBob2xkcyBubyBjb250ZXh0IHZhbHVlcywgc28gaXQgY2Fubm90IHRlbGxcbiAgICogd2hldGhlciBhIGxvZy1zb3VyY2Utc2hhcGVkIG5hbWUgaXMgdGhpcyBuYW1pbmcgY29udGV4dCdzIG93biBzb3VyY2UuIFRoZVxuICAgKiBjb250ZXh0IGNvbXBsZXRlcyB0aGF0IHJ1bGUgaW4gYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQuZGVjbGFyZUZpeGVkTmFtZWAsXG4gICAqIHdoaWNoIG93bnMgdGhlIGJvdW5kIGB0aGVvcnljbG91ZF97bmFtZXNwYWNlfV97YXBwfV97c3RhZ2V9X2AgcHJlZml4XG4gICAqIChTQU5JVFktQVQtTjMtMDgsIHJvdW5kIDQpLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZVBoeXNpY2FsTmFtZShyZXNvdXJjZVR5cGU6IHN0cmluZywgbmFtZTogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgcnVsZSA9IG5hbWluZ1J1bGUocmVzb3VyY2VUeXBlKTtcbiAgICBpZiAocnVsZSA9PT0gdW5kZWZpbmVkKSBmYWlsKFVOS05PV05fTkFNSU5HX1NDT1BFKTtcbiAgICBjb25zdCBjaGFyc2V0ID0gRklYRURfTkFNRV9DSEFSU0VUUy5nZXQocmVzb3VyY2VUeXBlKSA/PyBydWxlLmNoYXJzZXQ7XG4gICAgY29uc3QgcXVvdGVkID0gSlNPTi5zdHJpbmdpZnkobmFtZSk7XG4gICAgaWYgKG5hbWUubGVuZ3RoID09PSAwIHx8ICFuZXcgUmVnRXhwKGBeKD86JHtjaGFyc2V0fSkrJGApLnRlc3QobmFtZSkpIHtcbiAgICAgIGZhaWwoYGEgZml4ZWQgJHtyZXNvdXJjZVR5cGV9IG5hbWUgbXVzdCBtYXRjaCAke2NoYXJzZXR9IChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgfVxuICAgIGlmIChuYW1lLmxlbmd0aCA+IHJ1bGUubWF4KSB7XG4gICAgICBmYWlsKGBhIGZpeGVkICR7cmVzb3VyY2VUeXBlfSBuYW1lIG11c3QgYmUgYXQgbW9zdCAke3J1bGUubWF4fSBjaGFyYWN0ZXJzLCBnb3QgJHtuYW1lLmxlbmd0aH1gKTtcbiAgICB9XG4gICAgaWYgKHJ1bGUubWluICE9PSB1bmRlZmluZWQgJiYgbmFtZS5sZW5ndGggPCBydWxlLm1pbikge1xuICAgICAgZmFpbChgYSBmaXhlZCAke3Jlc291cmNlVHlwZX0gbmFtZSBtdXN0IGJlIGF0IGxlYXN0ICR7cnVsZS5taW59IGNoYXJhY3RlcnMgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke25hbWUubGVuZ3RofWApO1xuICAgIH1cbiAgICBpZiAocnVsZS5sZWFkICE9PSB1bmRlZmluZWQgJiYgIW5hbWUuc3RhcnRzV2l0aChydWxlLmxlYWQpKSB7XG4gICAgICBmYWlsKGBhIGZpeGVkICR7cmVzb3VyY2VUeXBlfSBuYW1lIG11c3Qgc3RhcnQgd2l0aCAke0pTT04uc3RyaW5naWZ5KHJ1bGUubGVhZCl9IChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgfVxuICAgIGlmIChTM19UWVBFUy5oYXMocmVzb3VyY2VUeXBlKSAmJiAhUzNfRURHRVNfUkUudGVzdChuYW1lKSkge1xuICAgICAgZmFpbChgYSBmaXhlZCAke3Jlc291cmNlVHlwZX0gbmFtZSBtdXN0IHN0YXJ0IGFuZCBlbmQgd2l0aCBhIGxldHRlciBvciBkaWdpdCAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWApO1xuICAgIH1cbiAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcInNlY3JldFwiICYmIFNFQ1JFVF9UQUlMX1JFLnRlc3QobmFtZSkpIHtcbiAgICAgIGZhaWwoYGEgZml4ZWQgc2VjcmV0IG5hbWUgbXVzdCBub3QgZW5kIHdpdGggYSBoeXBoZW4gYW5kIHNpeCBjaGFyYWN0ZXJzIChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgfVxuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwic3NtX3BhcmFtZXRlclwiKSB7XG4gICAgICAvLyBBIHBhdGggbmFtZSBjYXJyaWVzIGF0IGxlYXN0IG9uZSBub24tZW1wdHkgc2VnbWVudCBhZnRlciBpdHMgbGVhZCBgL2AsXG4gICAgICAvLyBhbmQgbm8gZW1wdHkgc2VnbWVudDogYC9gIGFuZCBgL2EvL2JgIG5hbWUgbm90aGluZyBBV1MgY2FuIGNyZWF0ZS5cbiAgICAgIGlmICghU1NNX1BBVEhfUkUudGVzdChuYW1lKSkge1xuICAgICAgICBmYWlsKFxuICAgICAgICAgIGBhIGZpeGVkIHNzbV9wYXJhbWV0ZXIgbmFtZSBtdXN0IGNhcnJ5IGF0IGxlYXN0IG9uZSBub24tZW1wdHkgc2VnbWVudCBhZnRlciBpdHMgbGVhZCBcIi9cIiBhbmQgbm8gZW1wdHkgc2VnbWVudCAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoKG5hbWUubWF0Y2goL1xcLy9nKT8ubGVuZ3RoID8/IDApID4gMTUpIHtcbiAgICAgICAgZmFpbChgYSBmaXhlZCBzc21fcGFyYW1ldGVyIG5hbWUgbXVzdCBoYXZlIGF0IG1vc3QgMTUgbGV2ZWxzIChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgICB9XG4gICAgICBpZiAoL15cXC8/KD86YXdzfHNzbSkoPzpcXC98JCkvaS50ZXN0KG5hbWUpKSB7XG4gICAgICAgIGZhaWwoYGEgZml4ZWQgc3NtX3BhcmFtZXRlciBuYW1lIG11c3Qgbm90IGJlZ2luIHdpdGggYXdzIG9yIHNzbSAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWApO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcImttc19hbGlhc1wiKSB7XG4gICAgICAvLyBgYWxpYXMvYCBhbG9uZSBuYW1lcyBubyBhbGlhczogdGhlIG5hbWUgYWZ0ZXIgdGhlIGxlYWQgaXMgdGhlIGFsaWFzLlxuICAgICAgaWYgKG5hbWUubGVuZ3RoIDw9IEtNU19BTElBU19MRUFELmxlbmd0aCkge1xuICAgICAgICBmYWlsKFxuICAgICAgICAgIGBhIGZpeGVkIGttc19hbGlhcyBuYW1lIG11c3QgY2FycnkgYSBub24tZW1wdHkgbmFtZSBhZnRlciBpdHMgJHtKU09OLnN0cmluZ2lmeShLTVNfQUxJQVNfTEVBRCl9IGxlYWQgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcImFsaWFzL2F3cy9cIikpIHtcbiAgICAgICAgZmFpbChgYSBmaXhlZCBrbXNfYWxpYXMgbmFtZSBtdXN0IG5vdCBiZSBpbiB0aGUgYWxpYXMvYXdzLyBuYW1lc3BhY2UgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJsb2dfZ3JvdXBcIikge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcImF3cy9cIikpIHtcbiAgICAgICAgZmFpbChgYSBmaXhlZCBsb2dfZ3JvdXAgbmFtZSBtdXN0IG5vdCBiZWdpbiB3aXRoIGF3cy8gKGNvbnRyYWN0IHNlY3Rpb24gMyksIGdvdCAke3F1b3RlZH1gKTtcbiAgICAgIH0gZWxzZSBpZiAoIWlzRml4ZWRMb2dHcm91cFNoYXBlKG5hbWUpKSB7XG4gICAgICAgIGZhaWwoXG4gICAgICAgICAgYGEgZml4ZWQgbG9nX2dyb3VwIG5hbWUgbXVzdCBiZSBlaXRoZXIgYSBzZWN0aW9uIDMgbG9nLXNvdXJjZSBuYW1lIChubyBcIi9cIikgb3IgdGhlIExhbWJkYSBzZXJ2aWNlIHBhdGggJHtKU09OLnN0cmluZ2lmeShMQU1CREFfTE9HX0dST1VQX0xFQUQpfSBmb2xsb3dlZCBieSBhIG5hbWUgdGhhdCBzYXRpc2ZpZXMgdGhlIGxhbWJkYV9mdW5jdGlvbiByb3cgKGNvbnRyYWN0IHNlY3Rpb24gMyksIGdvdCAke3F1b3RlZH1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZWZ1c2UgdHdvIGRpZmZlcmVudCBsb2dpY2FsIHJlc291cmNlcyBpbiBvbmUgbmFtaW5nIGNvbnRleHQgdGhhdCBkZXJpdmUgdGhlXG4gICAqIHNhbWUgbmFtZSBpbiB0aGUgc2FtZSBuYW1pbmcgc2NvcGUsIGFuZCByZXR1cm4gdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdFxuICAgKiAoY29udHJhY3Qgc2VjdGlvbiAxMS40KS4gQSBMYW1iZGEgZnVuY3Rpb24gYW5kIGl0cyBJQU0gcm9sZSBtYXkgc2hhcmUgYSBuYW1lXG4gICAqIGJlY2F1c2UgdGhlaXIgc2NvcGVzIGRpZmZlciwgYW5kIHR3byBBUElzIG1heSBzaGFyZSBvbmUgYmVjYXVzZSBBV1MgZG9lcyBub3RcbiAgICoga2VlcCBBUEkgbmFtZXMgdW5pcXVlLiBSb3dzIGtlZXAgdGhlIG9yZGVyIG9mIHRoZSBlbnRyaWVzLlxuICAgKlxuICAgKiBgbG9naWNhbElkYCBpcyB0aGUgcmVzb3VyY2UncyBpZGVudGl0eSBpbnNpZGUgdGhlIG5hbWluZyBjb250ZXh0OiBpdHNcbiAgICogQ2xvdWRGb3JtYXRpb24gbG9naWNhbCBpZCwgb3IgdGhlIG93bmluZyBzdGFjaydzIGNvbnN0cnVjdCBwYXRoIHBsdXMgdGhhdFxuICAgKiBsb2dpY2FsIGlkIHdoZW4gdGhlIGNvbnRleHQgc3BhbnMgc2V2ZXJhbCBzdGFja3MuIEEgQ2xvdWRGb3JtYXRpb24gbG9naWNhbCBpZFxuICAgKiBpcyB1bmlxdWUgb25seSBpbnNpZGUgb25lIHRlbXBsYXRlLCBzbyBhIGNhbGxlciB0aGF0IG93bnMgbW9yZSB0aGFuIG9uZVxuICAgKiB0ZW1wbGF0ZSBtdXN0IHBhc3MgdGhlIHF1YWxpZmllZCBmb3JtOyBvdGhlcndpc2UgdHdvIHJlc291cmNlcyBpbiBkaWZmZXJlbnRcbiAgICogc3RhY2tzIHdpdGggdGhlIHNhbWUgbG9jYWwgbG9naWNhbCBpZCBsb29rIGxpa2Ugb25lIHJlLWRlY2xhcmVkIHJlc291cmNlXG4gICAqIChTQU5JVFktQVQtTjMtMDUpLiBUaGUgcmV0dXJuZWQgcm93IGVjaG9lcyB0aGUgaWRlbnRpdHkgaXQgd2FzIGdpdmVuLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzeW50aENoZWNrKGVudHJpZXM6IEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXRbXSk6IEFwcFRoZW9yeURlcml2ZWROYW1lW10ge1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGNvbnN0IGFydGlmYWN0OiBBcHBUaGVvcnlEZXJpdmVkTmFtZVtdID0gW107XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICBjb25zdCBzY29wZSA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLm5hbWluZ1Njb3BlKGVudHJ5LnR5cGUpO1xuICAgICAgY29uc3QgZ2VuZXJhdGVkID0gZW50cnkuZ2VuZXJhdGVkID09PSB0cnVlO1xuICAgICAgYXJ0aWZhY3QucHVzaCh7XG4gICAgICAgIC4uLihlbnRyeS5uYW1lICE9PSB1bmRlZmluZWQgJiYgIWdlbmVyYXRlZCA/IHsgbmFtZTogZW50cnkubmFtZSB9IDoge30pLFxuICAgICAgICB0eXBlOiBlbnRyeS50eXBlLFxuICAgICAgICBzY29wZSxcbiAgICAgICAgbG9naWNhbElkOiBlbnRyeS5sb2dpY2FsSWQsXG4gICAgICAgIC4uLihnZW5lcmF0ZWQgPyB7IGdlbmVyYXRlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgfSk7XG4gICAgICBpZiAoc2NvcGUgPT09IEFwcFRoZW9yeU5hbWluZ1Njb3BlLk5PVF9VTklRVUUgfHwgZ2VuZXJhdGVkKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGtleSA9IGAke3Njb3BlfVxcdTAwMDAke2VudHJ5LnR5cGV9XFx1MDAwMCR7ZW50cnkubmFtZSA/PyBcIlwifWA7XG4gICAgICBjb25zdCBoZWxkID0gc2Vlbi5nZXQoa2V5KTtcbiAgICAgIGlmIChoZWxkICE9PSB1bmRlZmluZWQgJiYgaGVsZCAhPT0gZW50cnkubG9naWNhbElkKSB7XG4gICAgICAgIGZhaWwoYCR7aGVsZH0gYW5kICR7ZW50cnkubG9naWNhbElkfSBkZXJpdmUgJHtlbnRyeS5uYW1lID8/IFwiXCJ9IGluIHNjb3BlICR7c2NvcGV9YCk7XG4gICAgICB9XG4gICAgICBzZWVuLnNldChrZXksIGVudHJ5LmxvZ2ljYWxJZCk7XG4gICAgfVxuICAgIHJldHVybiBhcnRpZmFjdDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGFzIHRoZSBjbG91ZC1hc3NlbWJseSBtZXRhZGF0YSBkb2N1bWVudCwgd2l0aCB0aGVcbiAgICogY29udHJhY3QncyBzbmFrZV9jYXNlIHdpcmUga2V5cyBhbmQgYSBkZXRlcm1pbmlzdGljIGVudHJ5IG9yZGVyLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBkZXJpdmVkTmFtZXNKc29uKGFydGlmYWN0OiBBcHBUaGVvcnlEZXJpdmVkTmFtZXMpOiBzdHJpbmcge1xuICAgIGNvbnN0IGVudHJpZXMgPSBbLi4uYXJ0aWZhY3QuZW50cmllc11cbiAgICAgIC5tYXAoKGVudHJ5KSA9PiAoe1xuICAgICAgICAuLi4oZW50cnkubmFtZSAhPT0gdW5kZWZpbmVkICYmICFlbnRyeS5nZW5lcmF0ZWQgPyB7IG5hbWU6IGVudHJ5Lm5hbWUgfSA6IHt9KSxcbiAgICAgICAgdHlwZTogZW50cnkudHlwZSxcbiAgICAgICAgc2NvcGU6IGVudHJ5LnNjb3BlLFxuICAgICAgICBsb2dpY2FsX2lkOiBlbnRyeS5sb2dpY2FsSWQsXG4gICAgICAgIC4uLihlbnRyeS5nZW5lcmF0ZWQgPyB7IGdlbmVyYXRlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgfSkpXG4gICAgICAuc29ydCgoYSwgYikgPT4ge1xuICAgICAgICBjb25zdCBrZXkgPSAocm93OiB0eXBlb2YgYSk6IHN0cmluZyA9PlxuICAgICAgICAgIFtyb3cuc2NvcGUsIHJvdy50eXBlLCByb3cubmFtZSA/PyBcIlwiLCByb3cubG9naWNhbF9pZF0uam9pbihcIlxcdTAwMDBcIik7XG4gICAgICAgIGNvbnN0IGxlZnQgPSBrZXkoYSk7XG4gICAgICAgIGNvbnN0IHJpZ2h0ID0ga2V5KGIpO1xuICAgICAgICByZXR1cm4gbGVmdCA8IHJpZ2h0ID8gLTEgOiBsZWZ0ID4gcmlnaHQgPyAxIDogMDtcbiAgICAgIH0pO1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBjb250cmFjdDogYXJ0aWZhY3QuY29udHJhY3QsXG4gICAgICBzY2hlbWE6IGFydGlmYWN0LnNjaGVtYSxcbiAgICAgIGNvbnRleHQ6IHtcbiAgICAgICAgbmFtZXNwYWNlOiBhcnRpZmFjdC5jb250ZXh0Lm5hbWVzcGFjZSA/PyBMT0dfUFJFRklYLFxuICAgICAgICBhcHA6IGFydGlmYWN0LmNvbnRleHQuYXBwLFxuICAgICAgICBzdGFnZTogYXJ0aWZhY3QuY29udGV4dC5zdGFnZSxcbiAgICAgICAgYWNjb3VudDogYXJ0aWZhY3QuY29udGV4dC5hY2NvdW50LFxuICAgICAgICByZWdpb246IGFydGlmYWN0LmNvbnRleHQucmVnaW9uLFxuICAgICAgfSxcbiAgICAgIGVudHJpZXMsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogVmFsaWRhdGUgb25lIHNlbGVjdG9yLiBUaHJvd3Mgb24gYSBzZWxlY3RvciBvdXRzaWRlIHRoZSBncmFtbWFyLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZVNlbGVjdG9yKHNlbGVjdG9yOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBiYXNlID0gc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSA/IHNlbGVjdG9yLnNsaWNlKDAsIC0yKSA6IHNlbGVjdG9yO1xuICAgIGlmICghTE9HSUNBTF9SRS50ZXN0KGJhc2UpIHx8IGJhc2Uuc3BsaXQoXCIvXCIpWzBdICE9PSBcImxvZ3NcIiB8fCAoYmFzZSA9PT0gXCJsb2dzXCIgJiYgIXNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpKSB7XG4gICAgICBmYWlsKGBzZWxlY3RvciAke3NlbGVjdG9yfWApO1xuICAgIH1cbiAgICBpZiAoYmFzZS5pbmNsdWRlcyhcIipcIikpIGZhaWwoXCJ3aWxkY2FyZCBvbmx5IGFzIHRyYWlsaW5nIC8qXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgYSBzZWxlY3RvciBtYXRjaGVzIGEgbG9naWNhbCBzb3VyY2UuIEEgdHJhaWxpbmcgYC8qYCBtYXRjaGVzXG4gICAqIGRlc2NlbmRhbnRzIG9ubHkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHNlbGVjdG9yTWF0Y2hlcyhzZWxlY3Rvcjogc3RyaW5nLCBsb2dpY2FsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBpZiAoc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSkgcmV0dXJuIGxvZ2ljYWwuc3RhcnRzV2l0aChzZWxlY3Rvci5zbGljZSgwLCAtMSkpO1xuICAgIHJldHVybiBsb2dpY2FsID09PSBzZWxlY3RvcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGEgc291cmNlIGlzIHZpc2libGU6IGFuIGluY2x1ZGUgbWF0Y2hlcyBhbmQgbm8gZXhjbHVkZSBkb2VzLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzb3VyY2VWaXNpYmxlKHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsIGxvZ2ljYWw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGluY2x1ZGVkID0gKHJ1bGVzLmluY2x1ZGUgPz8gW10pLnNvbWUoKHNlbGVjdG9yKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3IsIGxvZ2ljYWwpKTtcbiAgICBpZiAoIWluY2x1ZGVkKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuICEocnVsZXMuZXhjbHVkZSA/PyBbXSkuc29tZSgoc2VsZWN0b3IpID0+IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNlbGVjdG9yTWF0Y2hlcyhzZWxlY3RvciwgbG9naWNhbCkpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBmaXJzdCAxMiBoZXggY2hhcmFjdGVycyBvZiBTSEEtMjU2IG92ZXIgdGhlIGNhbm9uaWNhbCBydWxlcy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcnVsZVZlcnNpb24ocnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyk6IHN0cmluZyB7XG4gICAgY29uc3QgY2Fub25pY2FsID0gYHtcImV4Y2x1ZGVcIjoke0pTT04uc3RyaW5naWZ5KHNvcnRlZENvcHkocnVsZXMuZXhjbHVkZSkpfSxcImluY2x1ZGVcIjoke0pTT04uc3RyaW5naWZ5KHNvcnRlZENvcHkocnVsZXMuaW5jbHVkZSkpfX1gO1xuICAgIHJldHVybiBzaGEyNTZIZXgoY2Fub25pY2FsKS5zbGljZSgwLCAxMik7XG4gIH1cblxuICAvKipcbiAgICogQ29tcGlsZSB0aGUgcnVsZXMgaW50byB0aGUgcmVhZGVyLXJvbGUgaW5saW5lIHBvbGljeSBkb2N1bWVudC4gVGhlIHJldHVyblxuICAgKiB2YWx1ZSBpcyB0aGUgY29udHJhY3QgSlNPTiwgc28gYSBjb25zdW1lciBjYW4gY29tcGFyZSBpdCBieXRlIGZvciBieXRlLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBjb21waWxlVmlzaWJpbGl0eVBvbGljeUpzb24oXG4gICAgdmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICk6IHN0cmluZyB7XG4gICAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBbLi4uKHJ1bGVzLmluY2x1ZGUgPz8gW10pLCAuLi4ocnVsZXMuZXhjbHVkZSA/PyBbXSldKSB7XG4gICAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgICB9XG4gICAgY29uc3QgYmFzZSA9IGBhcm46YXdzOmxvZ3M6JHt2YWx1ZXMucmVnaW9ufToke3ZhbHVlcy5hY2NvdW50fTpsb2ctZ3JvdXA6YDtcbiAgICBjb25zdCBhcm5zRm9yID0gKHNlbGVjdG9yOiBzdHJpbmcpOiBzdHJpbmdbXSA9PiB7XG4gICAgICBpZiAoc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSkge1xuICAgICAgICByZXR1cm4gW2Jhc2UgKyBsb2dQcmVmaXgodmFsdWVzKSArIHNlbGVjdG9yLnNsaWNlKDAsIC0xKS5yZXBsYWNlKC9cXC8vZywgXCJfXCIpICsgXCIqXCJdO1xuICAgICAgfVxuICAgICAgY29uc3QgbmFtZSA9IGxvZ1ByZWZpeCh2YWx1ZXMpICsgc2VsZWN0b3IucmVwbGFjZSgvXFwvL2csIFwiX1wiKTtcbiAgICAgIHJldHVybiBbYmFzZSArIG5hbWUsIGJhc2UgKyBuYW1lICsgXCI6KlwiXTtcbiAgICB9O1xuICAgIGNvbnN0IGFjdGlvbnMgPSBbLi4uS0VFUEVSX0FDVElPTlNfR1JPVVAsIC4uLktFRVBFUl9BQ1RJT05TX1NUUkVBTV07XG4gICAgY29uc3Qgc3RhdGVtZW50czogeyBTaWQ6IHN0cmluZzsgRWZmZWN0OiBzdHJpbmc7IEFjdGlvbjogc3RyaW5nW107IFJlc291cmNlOiBzdHJpbmdbXSB9W10gPSBbXG4gICAgICB7XG4gICAgICAgIFNpZDogXCJSZWFkTWFuaWZlc3RcIixcbiAgICAgICAgRWZmZWN0OiBcIkFsbG93XCIsXG4gICAgICAgIEFjdGlvbjogW1wic3NtOkdldFBhcmFtZXRlclwiXSxcbiAgICAgICAgUmVzb3VyY2U6IFtcbiAgICAgICAgICBgYXJuOmF3czpzc206JHt2YWx1ZXMucmVnaW9ufToke3ZhbHVlcy5hY2NvdW50fTpwYXJhbWV0ZXIvJHtMT0dfUFJFRklYfS92aXNpYmlsaXR5LyR7dmFsdWVzLmFwcH0vJHt2YWx1ZXMuc3RhZ2V9L21hbmlmZXN0YCxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBjb25zdCBpbmNsdWRlZCA9IHNvcnRlZENvcHkocnVsZXMuaW5jbHVkZSkuZmxhdE1hcChhcm5zRm9yKTtcbiAgICBjb25zdCBleGNsdWRlZCA9IHNvcnRlZENvcHkocnVsZXMuZXhjbHVkZSkuZmxhdE1hcChhcm5zRm9yKTtcbiAgICBpZiAoaW5jbHVkZWQubGVuZ3RoID4gMCkgc3RhdGVtZW50cy5wdXNoKHsgU2lkOiBcIlJlYWRJbmNsdWRlZFwiLCBFZmZlY3Q6IFwiQWxsb3dcIiwgQWN0aW9uOiBhY3Rpb25zLCBSZXNvdXJjZTogaW5jbHVkZWQgfSk7XG4gICAgaWYgKGV4Y2x1ZGVkLmxlbmd0aCA+IDApIHN0YXRlbWVudHMucHVzaCh7IFNpZDogXCJEZW55RXhjbHVkZWRcIiwgRWZmZWN0OiBcIkRlbnlcIiwgQWN0aW9uOiBhY3Rpb25zLCBSZXNvdXJjZTogZXhjbHVkZWQgfSk7XG4gICAgY29uc3QgZG9jdW1lbnQgPSBKU09OLnN0cmluZ2lmeSh7IFZlcnNpb246IFwiMjAxMi0xMC0xN1wiLCBTdGF0ZW1lbnQ6IHN0YXRlbWVudHMgfSk7XG4gICAgaWYgKGRvY3VtZW50Lmxlbmd0aCA+IFJPTEVfUE9MSUNZX01BWCkgZmFpbChcImNvbXBpbGVkIHBvbGljeSBvdmVyIHJvbGUgcG9saWN5IHNpemVcIik7XG4gICAgcmV0dXJuIGRvY3VtZW50O1xuICB9XG5cbiAgLyoqXG4gICAqIEFzc2VtYmxlIHRoZSBzeW50aC10aW1lIHZpc2liaWxpdHkgcHJldmlldy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmlzaWJpbGl0eVByZXZpZXcoXG4gICAgdmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICAgc291cmNlczogc3RyaW5nW10sXG4gICk6IEFwcFRoZW9yeVZpc2liaWxpdHlQcmV2aWV3IHtcbiAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZUNvbnRleHQodmFsdWVzKTtcbiAgICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIFsuLi4ocnVsZXMuaW5jbHVkZSA/PyBbXSksIC4uLihydWxlcy5leGNsdWRlID8/IFtdKV0pIHtcbiAgICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgcnVsZVZlcnNpb246IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnJ1bGVWZXJzaW9uKHJ1bGVzKSxcbiAgICAgIG1hdGNoZWROb3c6IHNvdXJjZXMuZmlsdGVyKChzb3VyY2UpID0+IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIHNvdXJjZSkpLnNvcnQoKSxcbiAgICAgIG5vdE1hdGNoZWROb3c6IHNvdXJjZXMuZmlsdGVyKChzb3VyY2UpID0+ICFBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBzb3VyY2UpKS5zb3J0KCksXG4gICAgICBmdXR1cmU6IHsgaW5jbHVkZTogc29ydGVkQ29weShydWxlcy5pbmNsdWRlKSwgZXhjbHVkZTogc29ydGVkQ29weShydWxlcy5leGNsdWRlKSB9LFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogQXNzZW1ibGUgdGhlIHB1Ymxpc2hlZCBtYW5pZmVzdCAodGhlIHByZXZpZXcgbWludXMgYG5vdE1hdGNoZWROb3dgKS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmlzaWJpbGl0eU1hbmlmZXN0KFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIHNvdXJjZXM6IHN0cmluZ1tdLFxuICApOiBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3Qge1xuICAgIGNvbnN0IHByZXZpZXcgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52aXNpYmlsaXR5UHJldmlldyh2YWx1ZXMsIHJ1bGVzLCBzb3VyY2VzKTtcbiAgICByZXR1cm4geyBydWxlVmVyc2lvbjogcHJldmlldy5ydWxlVmVyc2lvbiwgbWF0Y2hlZE5vdzogcHJldmlldy5tYXRjaGVkTm93LCBmdXR1cmU6IHByZXZpZXcuZnV0dXJlIH07XG4gIH1cblxuICAvKipcbiAgICogU2VyaWFsaXplIGEgbWFuaWZlc3QgdG8gdGhlIGNvbnRyYWN0IEpTT04gc2hhcGUgd3JpdHRlbiB0byBTU00uXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIG1hbmlmZXN0SnNvbihtYW5pZmVzdDogQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0KTogc3RyaW5nIHtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcnVsZV92ZXJzaW9uOiBtYW5pZmVzdC5ydWxlVmVyc2lvbixcbiAgICAgIG1hdGNoZWRfbm93OiBtYW5pZmVzdC5tYXRjaGVkTm93LFxuICAgICAgZnV0dXJlOiB7IGluY2x1ZGU6IG1hbmlmZXN0LmZ1dHVyZS5pbmNsdWRlID8/IFtdLCBleGNsdWRlOiBtYW5pZmVzdC5mdXR1cmUuZXhjbHVkZSA/PyBbXSB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIEtlZXBlcidzIHJlYWQgZGVjaXNpb24sIGluIHRoZSBydW50aW1lcycgcGFyYW1ldGVyIG9yZGVyLiBGYWlscyBjbG9zZWQgb24gYVxuICAgKiBkZW5pYWwgb3IgYW4gdW5yZWFjaGFibGUgYWNjb3VudC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMga2VlcGVyRGVjaXNpb24oXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBsb2dpY2FsOiBzdHJpbmcsXG4gICAgYXdzUmVzdWx0OiBzdHJpbmcsXG4gICk6IEFwcFRoZW9yeUtlZXBlckFuc3dlciB7XG4gICAgaWYgKCFydWxlcyB8fCAhQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgbG9naWNhbCkpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuTk9UX1NIQVJFRDtcbiAgICB9XG4gICAgaWYgKGF3c1Jlc3VsdCA9PT0gXCJldmVudHNcIikgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5FVkVOVFM7XG4gICAgaWYgKGF3c1Jlc3VsdCA9PT0gXCJlbXB0eVwiIHx8IGF3c1Jlc3VsdCA9PT0gXCJub3RfZm91bmRcIikgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5BTExPV0VEX05PX0VWRU5UUztcbiAgICByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLk5PVF9TSEFSRUQ7XG4gIH1cbn1cbiJdfQ==