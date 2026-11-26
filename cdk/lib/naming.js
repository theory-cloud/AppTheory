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
/** The longest hosted namespace label, in characters (contract section 1, r5 rev1). */
const HOSTED_NAMESPACE_MAX = 12;
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
/**
 * Apply the hosted namespace label rule (contract section 1, r5 rev1): a
 * namespace other than the reserved platform one is at most
 * `HOSTED_NAMESPACE_MAX` characters and never starts with `aws` or `ssm`. Those
 * two prefixes are reserved by AWS, so a name carrying them cannot be created.
 */
function validateHostedNamespace(namespace) {
    if (namespace === LOG_PREFIX)
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
function namespaced(values) {
    return values.hosted === true || namespaceOf(values) !== LOG_PREFIX;
}
/**
 * The `{namespace}-{app}-{stage}-{logical}` stem of a `dash` name or an S3
 * account-regional prefix, with `/` in the logical name replaced by `-`.
 */
function dashStem(values, logical) {
    const parts = [values.app, values.stage, logical.replace(/\//g, "-")];
    if (namespaced(values))
        parts.unshift(namespaceOf(values));
    return parts.join("-");
}
/**
 * The `{namespace}/{app}/{stage}/{logical}` stem of a `path` name.
 */
function pathStem(values, logical) {
    const parts = [values.app, values.stage, logical];
    if (namespaced(values))
        parts.unshift(namespaceOf(values));
    return parts.join("/");
}
/**
 * The leading namespace component a hosted pin must carry, exactly where the
 * derived form puts it (contract section 4, r5 rev1, rev2). Containing the
 * namespace elsewhere is not enough: `shop-lab-events` is not a pin for
 * namespace `hop`.
 */
function hostedPinLead(values, rule) {
    const namespace = namespaceOf(values);
    if (rule.kind === "path")
        return `${rule.lead ?? ""}${namespace}/`;
    if (rule.kind === "log")
        return `${LOG_PREFIX}_${namespace}_`;
    return `${namespace}-`;
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
        // r5 rev1: a hosted deployment always supplies its namespace; it never
        // defaults to the platform form.
        if (values.hosted === true && !values.namespace) {
            fail("a hosted deployment must supply its namespace");
        }
        const namespace = namespaceOf(values);
        if (!NAMESPACE_RE.test(namespace))
            fail("namespace");
        // r5 rev1: `theorycloud` is reserved for first-party platform apps. A hosted
        // deployment may never use it, because its names would then collide with the
        // platform app's in a pooled account.
        if (values.hosted === true && namespace === LOG_PREFIX) {
            fail(`namespace ${LOG_PREFIX} is reserved for first-party platform apps`);
        }
        validateHostedNamespace(namespace);
    }
    /**
     * Apply the hosted namespace label rule to one namespace (contract section 1,
     * r5 rev1): a namespace other than the reserved platform one is at most 12
     * characters and never starts with `aws` or `ssm`. Throws on a namespace
     * outside it.
     */
    static validateHostedNamespace(namespace) {
        validateHostedNamespace(namespace);
    }
    /**
     * Whether every derived name under these values carries the namespace
     * (contract section 2, r5): true for a hosted deployment and for any namespace
     * other than the reserved platform one.
     */
    static namespaced(values) {
        return namespaced(values);
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
     *
     * A hosted deployment (`hosted: true`, or any namespace other than the
     * platform one) carries the namespace as the first component of every derived
     * name, its S3 bucket-name prefix included, so it reaches the shortened
     * over-budget form sooner (contract section 2.4). It takes no generated entry
     * and no legacy profile, and a pin must start with its namespace component
     * (contract sections 2 and 4, r5).
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
        // r5 rev2: the legacy profile and generated entries are first-party
        // live-compatibility tools only. A hosted deployment takes neither, because a
        // pinned or CloudFormation-generated name carries no namespace and would
        // collide across tenants in a pooled account.
        if (namespaced(values) && (legacy || generated.length > 0)) {
            fail("a hosted deployment takes no legacy profile or generated entries");
        }
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
        if (pin !== undefined) {
            // r5 rev2: a hosted pin starts with its namespace component, as the
            // derived form does. A namespace that merely appears somewhere in the name
            // is not the namespace component.
            if (namespaced(values) && !pin.startsWith(hostedPinLead(values, rule))) {
                fail("a hosted pin must start with the namespace component");
            }
            return { name: pin, pinned: true };
        }
        if (keepGenerated)
            return { generated: true };
        if (legacy) {
            fail(`legacy naming profile requires a pin or a generated entry for ${key}`);
        }
        let out;
        if (rule.kind === "s3ar") {
            const suffix = AppTheoryResourceNaming.s3AccountRegionalSuffix(values);
            const budget = rule.max - suffix.length;
            const prefix = shorten(dashStem(values, logical), budget);
            out = { name: prefix + suffix, bucketNamePrefix: prefix, bucketNamespace: "account-regional" };
        }
        else if (rule.kind === "dash") {
            out = { name: shorten(dashStem(values, logical), rule.max) };
        }
        else if (rule.kind === "path") {
            const full = `${rule.lead ?? ""}${pathStem(values, logical)}`;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekMscUVBQThGO0FBRTlGOztHQUVHO0FBQ1UsUUFBQSx3QkFBd0IsR0FBRyxrQ0FBa0MsQ0FBQztBQUUzRTs7R0FFRztBQUNVLFFBQUEsb0JBQW9CLEdBQUcsNENBQTRDLENBQUM7QUFFakY7OztHQUdHO0FBQ1UsUUFBQSwwQkFBMEIsR0FBRyx5Q0FBeUMsQ0FBQztBQUVwRjs7R0FFRztBQUNILElBQVksc0JBU1g7QUFURCxXQUFZLHNCQUFzQjtJQUNoQzs7T0FFRztJQUNILDZDQUFtQixDQUFBO0lBQ25COztPQUVHO0lBQ0gsMkNBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHNCQUFzQixzQ0FBdEIsc0JBQXNCLFFBU2pDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHVCQVNYO0FBVEQsV0FBWSx1QkFBdUI7SUFDakM7O09BRUc7SUFDSCxnREFBcUIsQ0FBQTtJQUNyQjs7T0FFRztJQUNILDRDQUFpQixDQUFBO0FBQ25CLENBQUMsRUFUVyx1QkFBdUIsdUNBQXZCLHVCQUF1QixRQVNsQztBQUVEOztHQUVHO0FBQ0gsSUFBWSxxQkFhWDtBQWJELFdBQVkscUJBQXFCO0lBQy9COztPQUVHO0lBQ0gsMENBQWlCLENBQUE7SUFDakI7O09BRUc7SUFDSCxnRUFBdUMsQ0FBQTtJQUN2Qzs7T0FFRztJQUNILGtEQUF5QixDQUFBO0FBQzNCLENBQUMsRUFiVyxxQkFBcUIscUNBQXJCLHFCQUFxQixRQWFoQztBQTRNRDs7R0FFRztBQUNILElBQVksb0JBYVg7QUFiRCxXQUFZLG9CQUFvQjtJQUM5Qjs7T0FFRztJQUNILDJDQUFtQixDQUFBO0lBQ25COztPQUVHO0lBQ0gseURBQWlDLENBQUE7SUFDakM7O09BRUc7SUFDSCxpREFBeUIsQ0FBQTtBQUMzQixDQUFDLEVBYlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFh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QUksQ0FBQyxLQUFLLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxhQUFhLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDckUsT0FBTyxxQkFBcUIsQ0FBQyxVQUFVLENBQUM7UUFDMUMsQ0FBQztRQUNELElBQUksU0FBUyxLQUFLLFFBQVE7WUFBRSxPQUFPLHFCQUFxQixDQUFDLE1BQU0sQ0FBQztRQUNoRSxJQUFJLFNBQVMsS0FBSyxPQUFPLElBQUksU0FBUyxLQUFLLFdBQVc7WUFBRSxPQUFPLHFCQUFxQixDQUFDLGlCQUFpQixDQUFDO1FBQ3ZHLE9BQU8scUJBQXFCLENBQUMsVUFBVSxDQUFDO0lBQzFDLENBQUM7O0FBL2NILDBEQWdkQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHsgTEFNQkRBX0xPR19HUk9VUF9MRUFELCBMT0dJQ0FMX1NFR01FTlRfUEFUVEVSTiB9IGZyb20gXCIuL3ByaXZhdGUvbG9nLXNvdXJjZS1ncmFtbWFyXCI7XG5cbi8qKlxuICogVGhlIHJlc291cmNlLW5hbWluZyBjb250cmFjdCB0aGlzIG1vZHVsZSBpbXBsZW1lbnRzLlxuICovXG5leHBvcnQgY29uc3QgUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNUID0gXCJ0aGVvcnljbG91ZF9yZXNvdXJjZV9uYW1pbmcudjAuMVwiO1xuXG4vKipcbiAqIFRoZSBzY2hlbWEgaWRlbnRpZmllciBvZiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGEgbmFtaW5nIGNvbnRleHQgZW1pdHMuXG4gKi9cbmV4cG9ydCBjb25zdCBERVJJVkVEX05BTUVTX1NDSEVNQSA9IFwiYXBwdGhlb3J5X3Jlc291cmNlX25hbWluZy5kZXJpdmVkX25hbWVzLnYxXCI7XG5cbi8qKlxuICogVGhlIGNsb3VkLWFzc2VtYmx5IG1ldGFkYXRhIHR5cGUgdGhhdCBjYXJyaWVzIHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QuIFRoZVxuICogYXJ0aWZhY3QgbGFuZHMgaW4gYHtzdGFja30ubWV0YWRhdGEuanNvbmAgaW4gYGNkay5vdXRgLlxuICovXG5leHBvcnQgY29uc3QgREVSSVZFRF9OQU1FU19NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTpyZXNvdXJjZS1uYW1pbmcvZGVyaXZlZC1uYW1lc1wiO1xuXG4vKipcbiAqIE5hbWluZyBwcm9maWxlcyBhY2NlcHRlZCBieSBhIG5hbWluZyBjb250ZXh0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlIHtcbiAgLyoqXG4gICAqIE5hbWVzIGRlcml2ZSBmcm9tIHRoZSBuYW1pbmcgY29udGV4dC5cbiAgICovXG4gIERFUklWRUQgPSBcImRlcml2ZWRcIixcbiAgLyoqXG4gICAqIEV2ZXJ5IG5hbWUgY29tZXMgZnJvbSBhIHBpbi5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG59XG5cbi8qKlxuICogTG9nZ2luZyBwcm9maWxlcyBhY2NlcHRlZCBieSBhIG5hbWluZyBjb250ZXh0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZSB7XG4gIC8qKlxuICAgKiBBcHBUaGVvcnkgY3JlYXRlcyBzdGFuZGFyZCBsb2cgZ3JvdXBzIGFuZCBhY2Nlc3MgbG9nZ2luZy5cbiAgICovXG4gIFNUQU5EQVJEID0gXCJzdGFuZGFyZFwiLFxuICAvKipcbiAgICogRWFjaCBjb25zdHJ1Y3Qga2VlcHMgaXRzIHByZS1jb250cmFjdCBsb2dnaW5nIGJlaGF2aW91ci5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG59XG5cbi8qKlxuICogS2VlcGVyJ3MgYW5zd2VyIHRvIGEgcmVhZGVyIHJlcXVlc3QuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUtlZXBlckFuc3dlciB7XG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIHNoYXJlZCBhbmQgdGhlIHJlYWQgcmV0dXJuZWQgZXZlbnRzLlxuICAgKi9cbiAgRVZFTlRTID0gXCJldmVudHNcIixcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgc2hhcmVkIGFuZCB0aGUgcmVhZCByZXR1cm5lZCBubyBldmVudHMuXG4gICAqL1xuICBBTExPV0VEX05PX0VWRU5UUyA9IFwiYWxsb3dlZF9ub19ldmVudHNcIixcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgbm90IHNoYXJlZCwgb3IgdGhlIHJlYWQgZmFpbGVkIGNsb3NlZC5cbiAgICovXG4gIE5PVF9TSEFSRUQgPSBcIm5vdF9zaGFyZWRcIixcbn1cblxuLyoqXG4gKiBCb3VuZCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dCB2YWx1ZXMgZnJvbSBzdGFnZSBjb25maWcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICogQGRlZmF1bHQgXCJ0aGVvcnljbG91ZFwiXG4gICAqL1xuICByZWFkb25seSBuYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFwcCBpbnN0YW5jZSBpZC5cbiAgICovXG4gIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZC5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFR3ZWx2ZS1kaWdpdCBhY2NvdW50IGlkLiBBbiB1bnJlc29sdmVkIHRva2VuIGZhaWxzIHN5bnRoZXNpcy5cbiAgICovXG4gIHJlYWRvbmx5IGFjY291bnQ6IHN0cmluZztcblxuICAvKipcbiAgICogRnVsbCBSZWdpb24gY29kZSwgZm9yIGV4YW1wbGUgYHVzLWVhc3QtMWAuXG4gICAqL1xuICByZWFkb25seSByZWdpb246IHN0cmluZztcblxuICAvKipcbiAgICogUGh5c2ljYWwgcGlucyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuXG4gICAqIEBkZWZhdWx0IHt9XG4gICAqL1xuICByZWFkb25seSBwaW5zPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAvKipcbiAgICogR2VuZXJhdGVkLW5hbWUgZW50cmllcyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuIEFuIGVudHJ5IG1lYW5zXG4gICAqIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSB0b2RheSwgc28gdGhlIGNvbnN0cnVjdCBzZXRzIG5vXG4gICAqIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkuIFZhbGlkIG9ubHkgdW5kZXIgdGhlIGxlZ2FjeSBuYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBgdHJ1ZWAgZm9yIGEgZGVwbG95bWVudCBUaGVvcnlDbG91ZC5haSBwbGFjZXMgb24gYSB0ZW5hbnQncyBiZWhhbGZcbiAgICogKGNvbnRyYWN0IHNlY3Rpb24gMSwgcjUpLiBBIGhvc3RlZCBkZXBsb3ltZW50IGFsd2F5cyBzdXBwbGllcyBpdHNcbiAgICogbmFtZXNwYWNlLCBuZXZlciB1c2VzIHRoZSByZXNlcnZlZCBwbGF0Zm9ybSBuYW1lc3BhY2UsIGFuZCBjYXJyaWVzIHRoZVxuICAgKiBuYW1lc3BhY2UgaW4gZXZlcnkgZGVyaXZlZCBuYW1lIChjb250cmFjdCBzZWN0aW9uIDIpLiBPbmx5IGZpcnN0LXBhcnR5XG4gICAqIHBsYXRmb3JtIGFwcHMgb21pdCBpdC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRURcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU/OiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU/OiBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nIHJldGVudGlvbiBpbiBkYXlzIGZvciBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cHMuXG4gICAqIEBkZWZhdWx0IDMwXG4gICAqL1xuICByZWFkb25seSByZXRlbnRpb25EYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRoZSBjb21wb3NlZCBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAvKipcbiAgICogVGhlIGZ1bGwgcGh5c2ljYWwgbmFtZS4gQWJzZW50IHdoZW4gQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBhY2NvdW50LXJlZ2lvbmFsIGJ1Y2tldC1uYW1lIHByZWZpeCwgd2hlbiB0aGUgdHlwZSB1c2VzIG9uZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBidWNrZXROYW1lUHJlZml4Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYnVja2V0IG5hbWVzcGFjZSwgd2hlbiB0aGUgdHlwZSB1c2VzIG9uZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBidWNrZXROYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIG5hbWUgY2FtZSBmcm9tIGEgcGluLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcGlubmVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUsIHNvIG5vIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkgaXNcbiAgICogc2V0LlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBPbmUgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSBhIHN0YWNrIGRlY2xhcmVzLCBhcyB0aGUgc3ludGggY2hlY2sgKGNvbnRyYWN0XG4gKiBzZWN0aW9uIDExLjQpIGNvbnN1bWVzIGl0LiBBIGdlbmVyYXRlZCBlbnRyeSBjYXJyaWVzIG5vIG5hbWU6IENsb3VkRm9ybWF0aW9uXG4gKiBvd25zIHRoZSBuYW1lLCBzbyB0aGVyZSBpcyBub3RoaW5nIHRvIHJlc2VydmUuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dCB7XG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWwgbmFtZS4gQWJzZW50IGZvciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJhY3QgcmVzb3VyY2UgdHlwZSwgZm9yIGV4YW1wbGUgYGxhbWJkYV9mdW5jdGlvbmAuXG4gICAqL1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbmFtZSwgb3Ig4oCUIHdoZW5cbiAgICogdGhlIGNhbGxlcidzIG5hbWluZyBjb250ZXh0IHNwYW5zIHNldmVyYWwgc3RhY2tzIOKAlCB0aGUgb3duaW5nIHN0YWNrJ3NcbiAgICogY29uc3RydWN0IHBhdGggcGx1cyB0aGF0IGxvZ2ljYWwgaWQsIGJlY2F1c2UgYSBsb2dpY2FsIGlkIGlzIHVuaXF1ZSBvbmx5XG4gICAqIHdpdGhpbiBvbmUgdGVtcGxhdGUuXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsSWQ6IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUsIHNvIG5vdGhpbmcgaXMgcmVzZXJ2ZWQuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9uZSByb3cgb2YgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdDogdGhlIGNvbXBsZXRlIHNldCB0aGUgbmFtZSByZXNlcnZhdGlvblxuICogaW5kZXggKGNvbnRyYWN0IHNlY3Rpb24gMTEuMikgcmVzZXJ2ZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RGVyaXZlZE5hbWUge1xuICAvKipcbiAgICogVGhlIHBoeXNpY2FsIG5hbWUuIEFic2VudCBmb3IgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IHJlc291cmNlIHR5cGUuXG4gICAqL1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBzY29wZSBpbiB3aGljaCBBV1MgcmVxdWlyZXMgdGhlIG5hbWUgdG8gYmUgdW5pcXVlOiBgYWNjb3VudGAsXG4gICAqIGBhY2NvdW50X3JlZ2lvbmAsIG9yIGBub3RfdW5pcXVlYC5cbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxJZDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSwgc28gbm90aGluZyBpcyByZXNlcnZlZC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogVGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBhIG5hbWluZyBjb250ZXh0IGVtaXRzIGF0IHN5bnRoZXNpcyAoY29udHJhY3RcbiAqIHNlY3Rpb24gMTEuNCksIGtleWVkIGB7c3RhY2t9Lm1ldGFkYXRhLmpzb25gIGluIHRoZSBjbG91ZCBhc3NlbWJseS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlEZXJpdmVkTmFtZXMge1xuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IGlkZW50aWZpZXIuXG4gICAqL1xuICByZWFkb25seSBjb250cmFjdDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYXJ0aWZhY3Qgc2NoZW1hIGlkZW50aWZpZXIuXG4gICAqL1xuICByZWFkb25seSBzY2hlbWE6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5hbWluZyBjb250ZXh0IHRoYXQgcHJvZHVjZWQgdGhlIGFydGlmYWN0LlxuICAgKi9cbiAgcmVhZG9ubHkgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcztcblxuICAvKipcbiAgICogRXZlcnkgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSB0aGUgY29udGV4dCBkZWNsYXJlcywgc29ydGVkIGJ5IGBzY29wZWAsXG4gICAqIGB0eXBlYCwgYG5hbWVgIGFuZCBgbG9naWNhbElkYC5cbiAgICovXG4gIHJlYWRvbmx5IGVudHJpZXM6IEFwcFRoZW9yeURlcml2ZWROYW1lW107XG59XG5cbi8qKlxuICogVGhlIG5hbWluZyBzY29wZXMgb2YgY29udHJhY3Qgc2VjdGlvbiAxMS4xLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlOYW1pbmdTY29wZSB7XG4gIC8qKlxuICAgKiBBV1Mga2VlcHMgdGhlIG5hbWUgdW5pcXVlIGFjcm9zcyB0aGUgd2hvbGUgYWNjb3VudCwgd2hhdGV2ZXIgdGhlIFJlZ2lvbi5cbiAgICovXG4gIEFDQ09VTlQgPSBcImFjY291bnRcIixcbiAgLyoqXG4gICAqIEFXUyBrZWVwcyB0aGUgbmFtZSB1bmlxdWUgcGVyIGFjY291bnQgYW5kIFJlZ2lvbi5cbiAgICovXG4gIEFDQ09VTlRfUkVHSU9OID0gXCJhY2NvdW50X3JlZ2lvblwiLFxuICAvKipcbiAgICogQVdTIGRvZXMgbm90IGtlZXAgdGhlIG5hbWUgdW5pcXVlLCBzbyBub3RoaW5nIGlzIHJlc2VydmVkIGZvciBpdC5cbiAgICovXG4gIE5PVF9VTklRVUUgPSBcIm5vdF91bmlxdWVcIixcbn1cblxuLyoqXG4gKiBJbmNsdWRlIGFuZCBleGNsdWRlIHZpc2liaWxpdHkgc2VsZWN0b3JzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyB7XG4gIC8qKlxuICAgKiBTZWxlY3RvcnMgd2hvc2Ugc291cmNlcyBhcmUgc2hhcmVkLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgaW5jbHVkZT86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBTZWxlY3RvcnMgd2hvc2Ugc291cmNlcyBhcmUgbmV2ZXIgc2hhcmVkLiBFeGNsdXNpb25zIHdpbi5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGV4Y2x1ZGU/OiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBUaGUgc3ludGgtdGltZSB2aXNpYmlsaXR5IHByZXZpZXcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eVByZXZpZXcge1xuICAvKipcbiAgICogRmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgdGhlIGNhbm9uaWNhbCBydWxlcyBoYXNoLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIGRvIG5vdCBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG5vdE1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgc2VsZWN0b3JzLCBhcyB0aGUgc3RhdGVtZW50IG9mIHdoYXQgZnV0dXJlIHNvdXJjZXMgd2lsbCBtYXRjaC5cbiAgICovXG4gIHJlYWRvbmx5IGZ1dHVyZTogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xufVxuXG4vKipcbiAqIFRoZSBwdWJsaXNoZWQgU1NNIG1hbmlmZXN0OiB0aGUgcHJldmlldyBtaW51cyBgbm90TWF0Y2hlZE5vd2AuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0IHtcbiAgLyoqXG4gICAqIEZpcnN0IDEyIGhleCBjaGFyYWN0ZXJzIG9mIHRoZSBjYW5vbmljYWwgcnVsZXMgaGFzaC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bGVWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgc2hhcmUuXG4gICAqL1xuICByZWFkb25seSBtYXRjaGVkTm93OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIHNlbGVjdG9ycywgYXMgdGhlIHN0YXRlbWVudCBvZiB3aGF0IGZ1dHVyZSBzb3VyY2VzIHdpbGwgbWF0Y2guXG4gICAqL1xuICByZWFkb25seSBmdXR1cmU6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcztcbn1cblxuY29uc3QgU0VHTUVOVF9QQVRURVJOID0gTE9HSUNBTF9TRUdNRU5UX1BBVFRFUk47XG5jb25zdCBMT0dJQ0FMX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSg/Oi8ke1NFR01FTlRfUEFUVEVSTn0pKiRgKTtcbmNvbnN0IEFQUF9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0kYCk7XG5jb25zdCBTVEFHRV9SRSA9IC9eW2Etel1bYS16MC05XXswLDd9JC87XG5jb25zdCBOQU1FU1BBQ0VfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59JGApO1xuY29uc3QgQUNDT1VOVF9SRSA9IC9eWzAtOV17MTJ9JC87XG5jb25zdCBSRUdJT05fUkUgPSAvXlthLXpdezJ9KD86LVthLXpdKykrLVswLTldJC87XG5jb25zdCBTRUNSRVRfVEFJTF9SRSA9IC8tW0EtWmEtejAtOV17Nn0kLztcbmNvbnN0IFMzX0VER0VTX1JFID0gL15bYS16MC05XS4qW2EtejAtOV0kLztcbmNvbnN0IExPR19QUkVGSVggPSBcInRoZW9yeWNsb3VkXCI7XG5jb25zdCBST0xFX1BPTElDWV9NQVggPSAxMDI0MDtcbi8qKiBUaGUgbG9uZ2VzdCBob3N0ZWQgbmFtZXNwYWNlIGxhYmVsLCBpbiBjaGFyYWN0ZXJzIChjb250cmFjdCBzZWN0aW9uIDEsIHI1IHJldjEpLiAqL1xuY29uc3QgSE9TVEVEX05BTUVTUEFDRV9NQVggPSAxMjtcbmNvbnN0IEJBU0UzMiA9IFwiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoyMzQ1NjdcIjtcblxuaW50ZXJmYWNlIFJ1bGUge1xuICByZWFkb25seSBraW5kOiBcImRhc2hcIiB8IFwicGF0aFwiIHwgXCJzM2FyXCIgfCBcImxvZ1wiO1xuICByZWFkb25seSBtYXg6IG51bWJlcjtcbiAgLyoqXG4gICAqIFRoZSBsb3dlciBib3VuZCBjb250cmFjdCBzZWN0aW9uIDIgc3RhdGVzIGZvciB0aGUgdHlwZSwgd2hlbiBpdCBzdGF0ZXMgb25lLlxuICAgKiBBIHJvdyB0aGF0IHN0YXRlcyBvbmx5IGFuIHVwcGVyIGxpbWl0IGhhcyBub25lIGhlcmUsIHNvIHRoZSB0YWJsZSBzdGF5cyB0aGVcbiAgICogc2VjdGlvbiAyIHRhYmxlIGFuZCBub3QgYSBzdHJpY3RlciBwcml2YXRlIG9uZS5cbiAgICovXG4gIHJlYWRvbmx5IG1pbj86IG51bWJlcjtcbiAgcmVhZG9ubHkgY2hhcnNldDogc3RyaW5nO1xuICByZWFkb25seSBsZWFkPzogc3RyaW5nO1xufVxuXG5jb25zdCBSVUxFUzogeyBbdHlwZTogc3RyaW5nXTogUnVsZSB9ID0ge1xuICBzM19idWNrZXQ6IHsga2luZDogXCJzM2FyXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgczNfdmVjdG9yX2J1Y2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MywgY2hhcnNldDogXCJbYS16MC05LV1cIiB9LFxuICBzM192ZWN0b3JfaW5kZXg6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgLy8gU2VjdGlvbiAyOiBcIjI1NSAocGxhaW4tbmFtZSBsaW1pdCAz4oCTMjU1OyB0aGUgMTAyNCBsaW1pdCBhcHBsaWVzIHRvIHRoZSBBUk5cbiAgLy8gZm9ybSlcIi4gVGhlIGxvd2VyIGJvdW5kIGlzIHBhcnQgb2YgdGhlIHJvdywgc28gYSBmaXhlZCBuYW1lIG9mIG9uZSBvciB0d29cbiAgLy8gY2hhcmFjdGVycyBpcyByZWZ1c2VkIChTQU5JVFktQVQtTjMtMDgpLlxuICBkeW5hbW9kYl90YWJsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIG1pbjogMywgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGxhbWJkYV9mdW5jdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc3FzX3F1ZXVlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDgwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzbnNfdG9waWM6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzZWNyZXQ6IHsga2luZDogXCJwYXRoXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTkvXys9LkAtXVwiIH0sXG4gIHNzbV9wYXJhbWV0ZXI6IHsga2luZDogXCJwYXRoXCIsIG1heDogOTAwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLi8tXVwiLCBsZWFkOiBcIi9cIiB9LFxuICBrbXNfYWxpYXM6IHsga2luZDogXCJwYXRoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTkvXy1dXCIsIGxlYWQ6IFwiYWxpYXMvXCIgfSxcbiAgZXZlbnRfYnVzOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGV2ZW50X3J1bGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBzY2hlZHVsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGFsYXJtOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGRhc2hib2FyZDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGlhbV9yb2xlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkrPSwuQF8tXVwiIH0sXG4gIGlhbV9tYW5hZ2VkX3BvbGljeTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOSs9LC5AXy1dXCIgfSxcbiAgc3RhdGVfbWFjaGluZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA4MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgY29kZWJ1aWxkX3Byb2plY3Q6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTUwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfcmVzdDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV9odHRwOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgYXBpX3dlYnNvY2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9zb3VyY2U6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9kZXN0aW5hdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2dyb3VwOiB7IGtpbmQ6IFwibG9nXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxufTtcblxuLyoqXG4gKiBUaGUgcnVsZXMgb2Ygb25lIGNvbnRyYWN0IHR5cGUsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlIGNvbnRyYWN0IHN0YXRlcyBub25lXG4gKiAoY29udHJhY3Qgc2VjdGlvbiAyKS4gVGhlIGxvb2t1cCBpcyBhbiBvd24tcHJvcGVydHkgY2hlY2ssIHNvIGFuIGluaGVyaXRlZFxuICogbmFtZSBzdWNoIGFzIGBjb25zdHJ1Y3RvcmAsIGB0b1N0cmluZ2AsIGBfX3Byb3RvX19gIG9yIGBoYXNPd25Qcm9wZXJ0eWAgaXMgYW5cbiAqIHVua25vd24gdHlwZSwgbmV2ZXIgYSB0eXBlIHdpdGggcnVsZXMuXG4gKi9cbmZ1bmN0aW9uIG5hbWluZ1J1bGUocmVzb3VyY2VUeXBlOiBzdHJpbmcpOiBSdWxlIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFPYmplY3QuaGFzT3duKFJVTEVTLCByZXNvdXJjZVR5cGUpKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gUlVMRVNbcmVzb3VyY2VUeXBlXTtcbn1cblxuLyoqXG4gKiBBUEkgbmFtZSB0eXBlcy4gVGhlIENESyBkZWZhdWx0cyBhbiBBUEkgTmFtZSB0b2RheSwgc28gYSBuYW1lIGZvciBvbmUgaXNcbiAqIGV4cGxpY2l0IGFuZCB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnkgKHIzLCBBRFYtMTMxMi0zKS5cbiAqL1xuY29uc3QgQVBJX1RZUEVTID0gbmV3IFNldChbXCJhcGlfcmVzdFwiLCBcImFwaV9odHRwXCIsIFwiYXBpX3dlYnNvY2tldFwiXSk7XG5cbi8qKlxuICogVHlwZXMgd2hvc2Ugc2VjdGlvbiAyIHJvdyBhZGRzIHRoZSBTMyBzdGFydC9lbmQtYWxwaGFudW1lcmljIHJ1bGUuXG4gKi9cbmNvbnN0IFMzX1RZUEVTID0gbmV3IFNldChbXCJzM19idWNrZXRcIiwgXCJzM192ZWN0b3JfYnVja2V0XCIsIFwiczNfdmVjdG9yX2luZGV4XCJdKTtcblxuLyoqXG4gKiBUeXBlcyB3aG9zZSBmaXhlZC1uYW1lIGNoYXJzZXQgZGlmZmVycyBmcm9tIHRoZSBkZXJpdmVkLW5hbWUgY2hhcnNldCBvZiB0aGVpclxuICogc2VjdGlvbiAyIHJvdy4gQSBsb2cgZ3JvdXAgaXMgdGhlIG9ubHkgb25lOiBvbmUgb2YgaXRzIHR3byBmaXhlZCBzaGFwZXMgaXMgdGhlXG4gKiBMYW1iZGEgc2VydmljZSBwYXRoIGAvYXdzL2xhbWJkYS97ZnVuY3Rpb24gbmFtZX1gIChzZWN0aW9uIDMpLCBzbyBgL2AgaXMgcGFydFxuICogb2YgdGhlIGNoYXJzZXQgZXZlbiB0aG91Z2ggbm8gZGVyaXZlZCBsb2ctZ3JvdXAgbmFtZSBjb250YWlucyBvbmUuIFRoZSBzaGFwZVxuICogcnVsZSBiZWxvdyBpcyB3aGF0IG5hcnJvd3MgaXQgYWdhaW46IGV2ZXJ5IG90aGVyIGAvYC1iZWFyaW5nIGxvZyBncm91cCBpc1xuICogcmVmdXNlZC5cbiAqL1xuY29uc3QgRklYRURfTkFNRV9DSEFSU0VUUyA9IG5ldyBNYXAoW1tcImxvZ19ncm91cFwiLCBcIltBLVphLXowLTlfLy1dXCJdXSk7XG5cbi8qKlxuICogVGhlIEtNUyBhbGlhcyBwYXRoIGxlYWQgKGNvbnRyYWN0IHNlY3Rpb24gMikuXG4gKi9cbmNvbnN0IEtNU19BTElBU19MRUFEID0gXCJhbGlhcy9cIjtcblxuLyoqXG4gKiBBbiBhYnNvbHV0ZSBTU00gcGFyYW1ldGVyIHBhdGg6IGEgbGVhZCBgL2AsIHRoZW4gYXQgbGVhc3Qgb25lIG5vbi1lbXB0eVxuICogc2VnbWVudCwgd2l0aCBubyBlbXB0eSBzZWdtZW50IGFueXdoZXJlIChjb250cmFjdCBzZWN0aW9uIDIpLlxuICovXG5jb25zdCBTU01fUEFUSF9SRSA9IC9eXFwvW14vXSsoPzpcXC9bXi9dKykqJC87XG5cbi8qKlxuICogV2hldGhlciBhIGZpeGVkIGxvZy1ncm91cCBuYW1lIGlzIG9uZSBvZiB0aGUgdHdvIHNoYXBlcyBjb250cmFjdCBzZWN0aW9uIDNcbiAqIHN0YXRlcywgYW5kIG5vdGhpbmcgZWxzZTpcbiAqXG4gKiAtIGEgbG9nLXNvdXJjZSBuYW1lLCBgdGhlb3J5Y2xvdWRfe25hbWVzcGFjZX1fe2FwcH1fe3N0YWdlfV97bG9naWNhbH1gLiBJdHNcbiAqICAgc2VnbWVudHMgYXJlIGpvaW5lZCB3aXRoIGBfYCBwcmVjaXNlbHkgc28gdGhlIG9uZSBncmFtbWFyIGFsc28gc2F0aXNmaWVzXG4gKiAgIENsb3VkRnJvbnQncyBgW1xcdy1dYCBkZXN0aW5hdGlvbiwgc28gc3VjaCBhIG5hbWUgY2FycmllcyBubyBgL2AgYXQgYWxsO1xuICogLSB0aGUgTGFtYmRhIHNlcnZpY2UgcGF0aCBgL2F3cy9sYW1iZGEve2Z1bmN0aW9uIG5hbWV9YCwgd2hvc2UgZnVuY3Rpb24gbmFtZVxuICogICBzYXRpc2ZpZXMgdGhlIGBsYW1iZGFfZnVuY3Rpb25gIHJvdyBvZiBzZWN0aW9uIDIgKGxlbmd0aCBhbmQgY2hhcnNldCkuXG4gKlxuICogQW55IG90aGVyIGAvYC1iZWFyaW5nIG5hbWUgaXMgcmVmdXNlZDogYGFyYml0cmFyeS9wYXRoYCBpcyBuZWl0aGVyIHNoYXBlXG4gKiAoU0FOSVRZLUFULU4zLTA4KS5cbiAqXG4gKiBUaGUgbG9nLXNvdXJjZSBicmFuY2ggaGVyZSBpcyBhIHNoYXBlIHRlc3Qgb25seSwgbm90IGFuIGlkZW50aXR5IHRlc3Q6IGl0XG4gKiBjYW5ub3QgdGVsbCB3aG9zZSBjb250ZXh0IGEgbmFtZSBiZWxvbmdzIHRvLiBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dGBcbiAqIG5hcnJvd3MgaXQgdG8gdGhlIGNvbnRleHQncyBvd24gYHRoZW9yeWNsb3VkX3tuYW1lc3BhY2V9X3thcHB9X3tzdGFnZX1fYFxuICogcHJlZml4IGFuZCByZW1haW5kZXIgZ3JhbW1hciB3aGVuIGl0IGRlY2xhcmVzIGEgZml4ZWQgbmFtZS5cbiAqL1xuZnVuY3Rpb24gaXNGaXhlZExvZ0dyb3VwU2hhcGUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghbmFtZS5pbmNsdWRlcyhcIi9cIikpIHJldHVybiB0cnVlO1xuICBpZiAoIW5hbWUuc3RhcnRzV2l0aChMQU1CREFfTE9HX0dST1VQX0xFQUQpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGZ1bmN0aW9uTmFtZSA9IG5hbWUuc2xpY2UoTEFNQkRBX0xPR19HUk9VUF9MRUFELmxlbmd0aCk7XG4gIGNvbnN0IGxhbWJkYSA9IFJVTEVTLmxhbWJkYV9mdW5jdGlvbjtcbiAgaWYgKGZ1bmN0aW9uTmFtZS5sZW5ndGggPiBsYW1iZGEubWF4KSByZXR1cm4gZmFsc2U7XG4gIGlmIChsYW1iZGEubWluICE9PSB1bmRlZmluZWQgJiYgZnVuY3Rpb25OYW1lLmxlbmd0aCA8IGxhbWJkYS5taW4pIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIG5ldyBSZWdFeHAoYF4oPzoke2xhbWJkYS5jaGFyc2V0fSkrJGApLnRlc3QoZnVuY3Rpb25OYW1lKTtcbn1cblxuLyoqXG4gKiBUeXBlcyBBV1Mga2VlcHMgdW5pcXVlIGFjcm9zcyBSZWdpb25zIChjb250cmFjdCBzZWN0aW9uIDExLjEpLlxuICovXG5jb25zdCBBQ0NPVU5UX0dMT0JBTF9UWVBFUyA9IG5ldyBTZXQoW1wiaWFtX3JvbGVcIiwgXCJpYW1fbWFuYWdlZF9wb2xpY3lcIiwgXCJkYXNoYm9hcmRcIl0pO1xuXG4vKipcbiAqIEFQSSBkaXNwbGF5IG5hbWVzIEFXUyBkb2VzIG5vdCBrZWVwIHVuaXF1ZSwgc28gbm90aGluZyBpcyByZXNlcnZlZCBmb3IgdGhlbS5cbiAqL1xuY29uc3QgTk9UX1VOSVFVRV9UWVBFUyA9IG5ldyBTZXQoW1wiYXBpX3Jlc3RcIiwgXCJhcGlfaHR0cFwiLCBcImFwaV93ZWJzb2NrZXRcIl0pO1xuXG4vKipcbiAqIFRoZSByZWZ1c2FsIGZvciBhIHR5cGUgdGhlIGNvbnRyYWN0IHN0YXRlcyBubyBuYW1pbmcgc2NvcGUgZm9yOiBpdCBjYW5ub3QgYmVcbiAqIHJlc2VydmVkLCBzbyBpdCBjYW5ub3QgYmUgZGVwbG95ZWQgdGhyb3VnaCB0aGUgaW5kZXggdW50aWwgYSByZXZpc2lvbiBzdGF0ZXNcbiAqIGl0cyBzY29wZS5cbiAqL1xuY29uc3QgVU5LTk9XTl9OQU1JTkdfU0NPUEUgPSBcImEgdHlwZSB3aXRoIG5vIHN0YXRlZCBuYW1pbmcgc2NvcGUgY2Fubm90IGJlIHJlc2VydmVkXCI7XG5cbmNvbnN0IEtFRVBFUl9BQ1RJT05TX0dST1VQID0gW1wibG9nczpGaWx0ZXJMb2dFdmVudHNcIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiXTtcbmNvbnN0IEtFRVBFUl9BQ1RJT05TX1NUUkVBTSA9IFtcImxvZ3M6R2V0TG9nRXZlbnRzXCJdO1xuXG5mdW5jdGlvbiBmYWlsKG1lc3NhZ2U6IHN0cmluZyk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBzaGEyNTZIZXgodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHRleHQsIFwidXRmOFwiKS5kaWdlc3QoXCJoZXhcIik7XG59XG5cbmZ1bmN0aW9uIGJhc2UzMkxvd2VyKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJ5dGVzID0gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUodGV4dCwgXCJ1dGY4XCIpLmRpZ2VzdCgpO1xuICBsZXQgYml0cyA9IDA7XG4gIGxldCB2YWx1ZSA9IDA7XG4gIGxldCBvdXQgPSBcIlwiO1xuICBmb3IgKGNvbnN0IGJ5dGUgb2YgYnl0ZXMpIHtcbiAgICB2YWx1ZSA9ICh2YWx1ZSA8PCA4KSB8IGJ5dGU7XG4gICAgYml0cyArPSA4O1xuICAgIHdoaWxlIChiaXRzID49IDUpIHtcbiAgICAgIG91dCArPSBCQVNFMzJbKHZhbHVlID4+PiAoYml0cyAtIDUpKSAmIDMxXTtcbiAgICAgIGJpdHMgLT0gNTtcbiAgICB9XG4gIH1cbiAgaWYgKGJpdHMgPiAwKSBvdXQgKz0gQkFTRTMyWyh2YWx1ZSA8PCAoNSAtIGJpdHMpKSAmIDMxXTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gc2hvcnRlbihmdWxsOiBzdHJpbmcsIGxpbWl0OiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoZnVsbC5sZW5ndGggPD0gbGltaXQpIHJldHVybiBmdWxsO1xuICBjb25zdCBoZWFkID0gZnVsbC5zbGljZSgwLCBsaW1pdCAtIDkpLnJlcGxhY2UoL1stXy4vXSskLywgXCJcIik7XG4gIHJldHVybiBgJHtoZWFkfS0ke2Jhc2UzMkxvd2VyKGZ1bGwpLnNsaWNlKDAsIDgpfWA7XG59XG5cbmZ1bmN0aW9uIG5hbWVzcGFjZU9mKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZXMubmFtZXNwYWNlID8/IExPR19QUkVGSVg7XG59XG5cbi8qKlxuICogQXBwbHkgdGhlIGhvc3RlZCBuYW1lc3BhY2UgbGFiZWwgcnVsZSAoY29udHJhY3Qgc2VjdGlvbiAxLCByNSByZXYxKTogYVxuICogbmFtZXNwYWNlIG90aGVyIHRoYW4gdGhlIHJlc2VydmVkIHBsYXRmb3JtIG9uZSBpcyBhdCBtb3N0XG4gKiBgSE9TVEVEX05BTUVTUEFDRV9NQVhgIGNoYXJhY3RlcnMgYW5kIG5ldmVyIHN0YXJ0cyB3aXRoIGBhd3NgIG9yIGBzc21gLiBUaG9zZVxuICogdHdvIHByZWZpeGVzIGFyZSByZXNlcnZlZCBieSBBV1MsIHNvIGEgbmFtZSBjYXJyeWluZyB0aGVtIGNhbm5vdCBiZSBjcmVhdGVkLlxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZUhvc3RlZE5hbWVzcGFjZShuYW1lc3BhY2U6IHN0cmluZyk6IHZvaWQge1xuICBpZiAobmFtZXNwYWNlID09PSBMT0dfUFJFRklYKSByZXR1cm47XG4gIGlmIChuYW1lc3BhY2UubGVuZ3RoID4gSE9TVEVEX05BTUVTUEFDRV9NQVgpIHtcbiAgICBmYWlsKFwiaG9zdGVkIG5hbWVzcGFjZSBsb25nZXIgdGhhbiAxMiBjaGFyYWN0ZXJzXCIpO1xuICB9XG4gIGlmIChuYW1lc3BhY2Uuc3RhcnRzV2l0aChcImF3c1wiKSB8fCBuYW1lc3BhY2Uuc3RhcnRzV2l0aChcInNzbVwiKSkge1xuICAgIGZhaWwoXCJob3N0ZWQgbmFtZXNwYWNlIG11c3Qgbm90IHN0YXJ0IHdpdGggYXdzIG9yIHNzbVwiKTtcbiAgfVxufVxuXG4vKipcbiAqIFdoZXRoZXIgZXZlcnkgZGVyaXZlZCBuYW1lIGNhcnJpZXMgdGhlIG5hbWVzcGFjZSAoY29udHJhY3Qgc2VjdGlvbiAyLCByNSk6XG4gKiB0cnVlIGZvciBhIGhvc3RlZCBkZXBsb3ltZW50IGFuZCBmb3IgYW55IG5hbWVzcGFjZSBvdGhlciB0aGFuIHRoZSByZXNlcnZlZFxuICogcGxhdGZvcm0gb25lLiBUaGUgcGxhdGZvcm0gbmFtZXNwYWNlIGtlZXBzIHRoZSBjb21wYXRpYmlsaXR5IGZvcm0gYnl0ZSBmb3JcbiAqIGJ5dGUsIHNvIHRoZSBsaXZlIGhhcmQgZ2F0ZSAoY29udHJhY3Qgc2VjdGlvbiA0KSBpcyB1bmNoYW5nZWQuXG4gKi9cbmZ1bmN0aW9uIG5hbWVzcGFjZWQodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogYm9vbGVhbiB7XG4gIHJldHVybiB2YWx1ZXMuaG9zdGVkID09PSB0cnVlIHx8IG5hbWVzcGFjZU9mKHZhbHVlcykgIT09IExPR19QUkVGSVg7XG59XG5cbi8qKlxuICogVGhlIGB7bmFtZXNwYWNlfS17YXBwfS17c3RhZ2V9LXtsb2dpY2FsfWAgc3RlbSBvZiBhIGBkYXNoYCBuYW1lIG9yIGFuIFMzXG4gKiBhY2NvdW50LXJlZ2lvbmFsIHByZWZpeCwgd2l0aCBgL2AgaW4gdGhlIGxvZ2ljYWwgbmFtZSByZXBsYWNlZCBieSBgLWAuXG4gKi9cbmZ1bmN0aW9uIGRhc2hTdGVtKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcywgbG9naWNhbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcGFydHMgPSBbdmFsdWVzLmFwcCwgdmFsdWVzLnN0YWdlLCBsb2dpY2FsLnJlcGxhY2UoL1xcLy9nLCBcIi1cIildO1xuICBpZiAobmFtZXNwYWNlZCh2YWx1ZXMpKSBwYXJ0cy51bnNoaWZ0KG5hbWVzcGFjZU9mKHZhbHVlcykpO1xuICByZXR1cm4gcGFydHMuam9pbihcIi1cIik7XG59XG5cbi8qKlxuICogVGhlIGB7bmFtZXNwYWNlfS97YXBwfS97c3RhZ2V9L3tsb2dpY2FsfWAgc3RlbSBvZiBhIGBwYXRoYCBuYW1lLlxuICovXG5mdW5jdGlvbiBwYXRoU3RlbSh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsIGxvZ2ljYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzID0gW3ZhbHVlcy5hcHAsIHZhbHVlcy5zdGFnZSwgbG9naWNhbF07XG4gIGlmIChuYW1lc3BhY2VkKHZhbHVlcykpIHBhcnRzLnVuc2hpZnQobmFtZXNwYWNlT2YodmFsdWVzKSk7XG4gIHJldHVybiBwYXJ0cy5qb2luKFwiL1wiKTtcbn1cblxuLyoqXG4gKiBUaGUgbGVhZGluZyBuYW1lc3BhY2UgY29tcG9uZW50IGEgaG9zdGVkIHBpbiBtdXN0IGNhcnJ5LCBleGFjdGx5IHdoZXJlIHRoZVxuICogZGVyaXZlZCBmb3JtIHB1dHMgaXQgKGNvbnRyYWN0IHNlY3Rpb24gNCwgcjUgcmV2MSwgcmV2MikuIENvbnRhaW5pbmcgdGhlXG4gKiBuYW1lc3BhY2UgZWxzZXdoZXJlIGlzIG5vdCBlbm91Z2g6IGBzaG9wLWxhYi1ldmVudHNgIGlzIG5vdCBhIHBpbiBmb3JcbiAqIG5hbWVzcGFjZSBgaG9wYC5cbiAqL1xuZnVuY3Rpb24gaG9zdGVkUGluTGVhZCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsIHJ1bGU6IFJ1bGUpOiBzdHJpbmcge1xuICBjb25zdCBuYW1lc3BhY2UgPSBuYW1lc3BhY2VPZih2YWx1ZXMpO1xuICBpZiAocnVsZS5raW5kID09PSBcInBhdGhcIikgcmV0dXJuIGAke3J1bGUubGVhZCA/PyBcIlwifSR7bmFtZXNwYWNlfS9gO1xuICBpZiAocnVsZS5raW5kID09PSBcImxvZ1wiKSByZXR1cm4gYCR7TE9HX1BSRUZJWH1fJHtuYW1lc3BhY2V9X2A7XG4gIHJldHVybiBgJHtuYW1lc3BhY2V9LWA7XG59XG5cbmZ1bmN0aW9uIHNvcnRlZENvcHkodmFsdWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KHZhbHVlcyA/PyBbXSldLnNvcnQoKTtcbn1cblxuZnVuY3Rpb24gbG9nUHJlZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gIHJldHVybiBbTE9HX1BSRUZJWCwgbmFtZXNwYWNlT2YodmFsdWVzKSwgdmFsdWVzLmFwcCwgdmFsdWVzLnN0YWdlXS5qb2luKFwiX1wiKSArIFwiX1wiO1xufVxuXG4vKipcbiAqIFRoZSBgdGhlb3J5Y2xvdWRfcmVzb3VyY2VfbmFtaW5nLnYwLjFgIHByaW1pdGl2ZXMsIGV4cG9zZWQgZm9yIGpzaWkgc28gdGhlIEdvXG4gKiBhbmQgUHl0aG9uIENESyBiaW5kaW5ncyBzaGFyZSBvbmUgaW1wbGVtZW50YXRpb24uXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZyB7XG4gIHByaXZhdGUgY29uc3RydWN0b3IoKSB7fVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSB0aGUgYm91bmQgY29udGV4dCBncmFtbWFyLiBUaHJvd3Mgb24gYW4gaW52YWxpZCBjb250ZXh0LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZUNvbnRleHQodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogdm9pZCB7XG4gICAgaWYgKCFBUFBfUkUudGVzdCh2YWx1ZXMuYXBwKSkgZmFpbChcImFwcFwiKTtcbiAgICBpZiAoIVNUQUdFX1JFLnRlc3QodmFsdWVzLnN0YWdlKSkgZmFpbChcInN0YWdlXCIpO1xuICAgIGlmICghQUNDT1VOVF9SRS50ZXN0KHZhbHVlcy5hY2NvdW50KSkgZmFpbChcImFjY291bnRcIik7XG4gICAgaWYgKCFSRUdJT05fUkUudGVzdCh2YWx1ZXMucmVnaW9uKSkgZmFpbChcInJlZ2lvblwiKTtcbiAgICAvLyByNSByZXYxOiBhIGhvc3RlZCBkZXBsb3ltZW50IGFsd2F5cyBzdXBwbGllcyBpdHMgbmFtZXNwYWNlOyBpdCBuZXZlclxuICAgIC8vIGRlZmF1bHRzIHRvIHRoZSBwbGF0Zm9ybSBmb3JtLlxuICAgIGlmICh2YWx1ZXMuaG9zdGVkID09PSB0cnVlICYmICF2YWx1ZXMubmFtZXNwYWNlKSB7XG4gICAgICBmYWlsKFwiYSBob3N0ZWQgZGVwbG95bWVudCBtdXN0IHN1cHBseSBpdHMgbmFtZXNwYWNlXCIpO1xuICAgIH1cbiAgICBjb25zdCBuYW1lc3BhY2UgPSBuYW1lc3BhY2VPZih2YWx1ZXMpO1xuICAgIGlmICghTkFNRVNQQUNFX1JFLnRlc3QobmFtZXNwYWNlKSkgZmFpbChcIm5hbWVzcGFjZVwiKTtcbiAgICAvLyByNSByZXYxOiBgdGhlb3J5Y2xvdWRgIGlzIHJlc2VydmVkIGZvciBmaXJzdC1wYXJ0eSBwbGF0Zm9ybSBhcHBzLiBBIGhvc3RlZFxuICAgIC8vIGRlcGxveW1lbnQgbWF5IG5ldmVyIHVzZSBpdCwgYmVjYXVzZSBpdHMgbmFtZXMgd291bGQgdGhlbiBjb2xsaWRlIHdpdGggdGhlXG4gICAgLy8gcGxhdGZvcm0gYXBwJ3MgaW4gYSBwb29sZWQgYWNjb3VudC5cbiAgICBpZiAodmFsdWVzLmhvc3RlZCA9PT0gdHJ1ZSAmJiBuYW1lc3BhY2UgPT09IExPR19QUkVGSVgpIHtcbiAgICAgIGZhaWwoYG5hbWVzcGFjZSAke0xPR19QUkVGSVh9IGlzIHJlc2VydmVkIGZvciBmaXJzdC1wYXJ0eSBwbGF0Zm9ybSBhcHBzYCk7XG4gICAgfVxuICAgIHZhbGlkYXRlSG9zdGVkTmFtZXNwYWNlKG5hbWVzcGFjZSk7XG4gIH1cblxuICAvKipcbiAgICogQXBwbHkgdGhlIGhvc3RlZCBuYW1lc3BhY2UgbGFiZWwgcnVsZSB0byBvbmUgbmFtZXNwYWNlIChjb250cmFjdCBzZWN0aW9uIDEsXG4gICAqIHI1IHJldjEpOiBhIG5hbWVzcGFjZSBvdGhlciB0aGFuIHRoZSByZXNlcnZlZCBwbGF0Zm9ybSBvbmUgaXMgYXQgbW9zdCAxMlxuICAgKiBjaGFyYWN0ZXJzIGFuZCBuZXZlciBzdGFydHMgd2l0aCBgYXdzYCBvciBgc3NtYC4gVGhyb3dzIG9uIGEgbmFtZXNwYWNlXG4gICAqIG91dHNpZGUgaXQuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlSG9zdGVkTmFtZXNwYWNlKG5hbWVzcGFjZTogc3RyaW5nKTogdm9pZCB7XG4gICAgdmFsaWRhdGVIb3N0ZWROYW1lc3BhY2UobmFtZXNwYWNlKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGV2ZXJ5IGRlcml2ZWQgbmFtZSB1bmRlciB0aGVzZSB2YWx1ZXMgY2FycmllcyB0aGUgbmFtZXNwYWNlXG4gICAqIChjb250cmFjdCBzZWN0aW9uIDIsIHI1KTogdHJ1ZSBmb3IgYSBob3N0ZWQgZGVwbG95bWVudCBhbmQgZm9yIGFueSBuYW1lc3BhY2VcbiAgICogb3RoZXIgdGhhbiB0aGUgcmVzZXJ2ZWQgcGxhdGZvcm0gb25lLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBuYW1lc3BhY2VkKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBuYW1lc3BhY2VkKHZhbHVlcyk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIENsb3VkRm9ybWF0aW9uLWFwcGVuZGVkIGFjY291bnQtcmVnaW9uYWwgYnVja2V0IHN1ZmZpeC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgczNBY2NvdW50UmVnaW9uYWxTdWZmaXgodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYC0ke3ZhbHVlcy5hY2NvdW50fS0ke3ZhbHVlcy5yZWdpb259LWFuYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgYm91bmQgcHJlZml4IHNoYXJlZCBieSBldmVyeSBsb2cgc291cmNlIG9mIHRoZSBhcHAuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGxvZ1NvdXJjZVByZWZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICAgIHJldHVybiBsb2dQcmVmaXgodmFsdWVzKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBNYXAgYSBsb2dpY2FsIGxvZyBzb3VyY2UgdG8gaXRzIHBoeXNpY2FsIGxvZy1ncm91cCBuYW1lLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBsb2dHcm91cE5hbWUodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLCBsb2dpY2FsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICghbG9naWNhbC5zdGFydHNXaXRoKFwibG9ncy9cIikpIGZhaWwoXCJsb2cgbG9naWNhbCBtdXN0IHN0YXJ0IHdpdGggbG9ncy9cIik7XG4gICAgcmV0dXJuIGxvZ1ByZWZpeCh2YWx1ZXMpICsgbG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCJfXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBvc2UgdGhlIHBoeXNpY2FsIG5hbWUgb2Ygb25lIHJlc291cmNlLiBBIHBpbiBhbHdheXMgd2lucy4gQSBnZW5lcmF0ZWRcbiAgICogZW50cnkgbWVhbnMgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lIHRvZGF5IGFuZCB0aGUgY29uc3RydWN0IHNldHNcbiAgICogbm8gcGh5c2ljYWwtbmFtZSBwcm9wZXJ0eS4gR2VuZXJhdGVkIGVudHJpZXMgYXJlIGxlZ2FjeS1vbmx5OyBhIGxlZ2FjeVxuICAgKiBwcm9maWxlIG5lZWRzIGV4YWN0bHkgb25lIG9mIGEgcGluIG9yIGEgZ2VuZXJhdGVkIGVudHJ5LlxuICAgKlxuICAgKiBBIGhvc3RlZCBkZXBsb3ltZW50IChgaG9zdGVkOiB0cnVlYCwgb3IgYW55IG5hbWVzcGFjZSBvdGhlciB0aGFuIHRoZVxuICAgKiBwbGF0Zm9ybSBvbmUpIGNhcnJpZXMgdGhlIG5hbWVzcGFjZSBhcyB0aGUgZmlyc3QgY29tcG9uZW50IG9mIGV2ZXJ5IGRlcml2ZWRcbiAgICogbmFtZSwgaXRzIFMzIGJ1Y2tldC1uYW1lIHByZWZpeCBpbmNsdWRlZCwgc28gaXQgcmVhY2hlcyB0aGUgc2hvcnRlbmVkXG4gICAqIG92ZXItYnVkZ2V0IGZvcm0gc29vbmVyIChjb250cmFjdCBzZWN0aW9uIDIuNCkuIEl0IHRha2VzIG5vIGdlbmVyYXRlZCBlbnRyeVxuICAgKiBhbmQgbm8gbGVnYWN5IHByb2ZpbGUsIGFuZCBhIHBpbiBtdXN0IHN0YXJ0IHdpdGggaXRzIG5hbWVzcGFjZSBjb21wb25lbnRcbiAgICogKGNvbnRyYWN0IHNlY3Rpb25zIDIgYW5kIDQsIHI1KS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcGh5c2ljYWxOYW1lKFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICByZXNvdXJjZVR5cGU6IHN0cmluZyxcbiAgICBsb2dpY2FsOiBzdHJpbmcsXG4gICk6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZSB7XG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHZhbHVlcyk7XG4gICAgaWYgKCFMT0dJQ0FMX1JFLnRlc3QobG9naWNhbCkpIGZhaWwoXCJsb2dpY2FsXCIpO1xuICAgIGNvbnN0IHJ1bGUgPSBuYW1pbmdSdWxlKHJlc291cmNlVHlwZSk7XG4gICAgaWYgKCFydWxlKSBmYWlsKGByZXNvdXJjZSB0eXBlICR7cmVzb3VyY2VUeXBlfWApO1xuICAgIGNvbnN0IGdlbmVyYXRlZCA9IHZhbHVlcy5nZW5lcmF0ZWQgPz8gW107XG4gICAgY29uc3QgbGVnYWN5ID0gKHZhbHVlcy5uYW1pbmdQcm9maWxlID8/IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRCkgPT09IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuTEVHQUNZO1xuICAgIC8vIHI1IHJldjI6IHRoZSBsZWdhY3kgcHJvZmlsZSBhbmQgZ2VuZXJhdGVkIGVudHJpZXMgYXJlIGZpcnN0LXBhcnR5XG4gICAgLy8gbGl2ZS1jb21wYXRpYmlsaXR5IHRvb2xzIG9ubHkuIEEgaG9zdGVkIGRlcGxveW1lbnQgdGFrZXMgbmVpdGhlciwgYmVjYXVzZSBhXG4gICAgLy8gcGlubmVkIG9yIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZCBuYW1lIGNhcnJpZXMgbm8gbmFtZXNwYWNlIGFuZCB3b3VsZFxuICAgIC8vIGNvbGxpZGUgYWNyb3NzIHRlbmFudHMgaW4gYSBwb29sZWQgYWNjb3VudC5cbiAgICBpZiAobmFtZXNwYWNlZCh2YWx1ZXMpICYmIChsZWdhY3kgfHwgZ2VuZXJhdGVkLmxlbmd0aCA+IDApKSB7XG4gICAgICBmYWlsKFwiYSBob3N0ZWQgZGVwbG95bWVudCB0YWtlcyBubyBsZWdhY3kgcHJvZmlsZSBvciBnZW5lcmF0ZWQgZW50cmllc1wiKTtcbiAgICB9XG4gICAgaWYgKGdlbmVyYXRlZC5sZW5ndGggPiAwICYmICFsZWdhY3kpIHtcbiAgICAgIGZhaWwoXCJnZW5lcmF0ZWQgZW50cmllcyBhcmUgb25seSB2YWxpZCB1bmRlciB0aGUgbGVnYWN5IG5hbWluZyBwcm9maWxlXCIpO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSBgJHtyZXNvdXJjZVR5cGV9OiR7bG9naWNhbH1gO1xuICAgIGNvbnN0IHBpbiA9IHZhbHVlcy5waW5zPy5ba2V5XTtcbiAgICBjb25zdCBrZWVwR2VuZXJhdGVkID0gZ2VuZXJhdGVkLmluY2x1ZGVzKGtleSk7XG4gICAgLy8gcjMsIEFEVi0xMzEyLTM6IENESyBkZWZhdWx0cyBhbiBBUEkgTmFtZSB0b2RheSwgc28gaXQgaXMgYW4gZXhwbGljaXQgbmFtZVxuICAgIC8vIGFuZCB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAgaWYgKGtlZXBHZW5lcmF0ZWQgJiYgQVBJX1RZUEVTLmhhcyhyZXNvdXJjZVR5cGUpKSB7XG4gICAgICBmYWlsKFwiYW4gQVBJIG5hbWUgdGFrZXMgYSBwaW4sIG5ldmVyIGEgZ2VuZXJhdGVkIGVudHJ5XCIpO1xuICAgIH1cbiAgICBpZiAocGluICE9PSB1bmRlZmluZWQgJiYga2VlcEdlbmVyYXRlZCkgZmFpbChcImEgcmVzb3VyY2UgaGFzIGJvdGggYSBwaW4gYW5kIGEgZ2VuZXJhdGVkIGVudHJ5XCIpO1xuICAgIGlmIChwaW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgLy8gcjUgcmV2MjogYSBob3N0ZWQgcGluIHN0YXJ0cyB3aXRoIGl0cyBuYW1lc3BhY2UgY29tcG9uZW50LCBhcyB0aGVcbiAgICAgIC8vIGRlcml2ZWQgZm9ybSBkb2VzLiBBIG5hbWVzcGFjZSB0aGF0IG1lcmVseSBhcHBlYXJzIHNvbWV3aGVyZSBpbiB0aGUgbmFtZVxuICAgICAgLy8gaXMgbm90IHRoZSBuYW1lc3BhY2UgY29tcG9uZW50LlxuICAgICAgaWYgKG5hbWVzcGFjZWQodmFsdWVzKSAmJiAhcGluLnN0YXJ0c1dpdGgoaG9zdGVkUGluTGVhZCh2YWx1ZXMsIHJ1bGUpKSkge1xuICAgICAgICBmYWlsKFwiYSBob3N0ZWQgcGluIG11c3Qgc3RhcnQgd2l0aCB0aGUgbmFtZXNwYWNlIGNvbXBvbmVudFwiKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IG5hbWU6IHBpbiwgcGlubmVkOiB0cnVlIH07XG4gICAgfVxuICAgIGlmIChrZWVwR2VuZXJhdGVkKSByZXR1cm4geyBnZW5lcmF0ZWQ6IHRydWUgfTtcbiAgICBpZiAobGVnYWN5KSB7XG4gICAgICBmYWlsKGBsZWdhY3kgbmFtaW5nIHByb2ZpbGUgcmVxdWlyZXMgYSBwaW4gb3IgYSBnZW5lcmF0ZWQgZW50cnkgZm9yICR7a2V5fWApO1xuICAgIH1cblxuICAgIGxldCBvdXQ6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZTtcbiAgICBpZiAocnVsZS5raW5kID09PSBcInMzYXJcIikge1xuICAgICAgY29uc3Qgc3VmZml4ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuczNBY2NvdW50UmVnaW9uYWxTdWZmaXgodmFsdWVzKTtcbiAgICAgIGNvbnN0IGJ1ZGdldCA9IHJ1bGUubWF4IC0gc3VmZml4Lmxlbmd0aDtcbiAgICAgIGNvbnN0IHByZWZpeCA9IHNob3J0ZW4oZGFzaFN0ZW0odmFsdWVzLCBsb2dpY2FsKSwgYnVkZ2V0KTtcbiAgICAgIG91dCA9IHsgbmFtZTogcHJlZml4ICsgc3VmZml4LCBidWNrZXROYW1lUHJlZml4OiBwcmVmaXgsIGJ1Y2tldE5hbWVzcGFjZTogXCJhY2NvdW50LXJlZ2lvbmFsXCIgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJkYXNoXCIpIHtcbiAgICAgIG91dCA9IHsgbmFtZTogc2hvcnRlbihkYXNoU3RlbSh2YWx1ZXMsIGxvZ2ljYWwpLCBydWxlLm1heCkgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJwYXRoXCIpIHtcbiAgICAgIGNvbnN0IGZ1bGwgPSBgJHtydWxlLmxlYWQgPz8gXCJcIn0ke3BhdGhTdGVtKHZhbHVlcywgbG9naWNhbCl9YDtcbiAgICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwic2VjcmV0XCIgJiYgU0VDUkVUX1RBSUxfUkUudGVzdChmdWxsKSkge1xuICAgICAgICBmYWlsKFwic2VjcmV0IG5hbWUgbXVzdCBub3QgZW5kIHdpdGggYSBoeXBoZW4gYW5kIHNpeCBjaGFyYWN0ZXJzXCIpO1xuICAgICAgfVxuICAgICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzc21fcGFyYW1ldGVyXCIgJiYgKGZ1bGwubWF0Y2goL1xcLy9nKT8ubGVuZ3RoID8/IDApID4gMTUpIHtcbiAgICAgICAgZmFpbChcInNzbSBoaWVyYXJjaHkgZGVlcGVyIHRoYW4gMTVcIik7XG4gICAgICB9XG4gICAgICBpZiAoZnVsbC5sZW5ndGggPiBydWxlLm1heCkgZmFpbChcInBhdGggbmFtZSBvdmVyIGxpbWl0XCIpO1xuICAgICAgb3V0ID0geyBuYW1lOiBmdWxsIH07XG4gICAgfSBlbHNlIGlmIChydWxlLmtpbmQgPT09IFwibG9nXCIpIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5sb2dHcm91cE5hbWUodmFsdWVzLCBsb2dpY2FsKTtcbiAgICAgIGlmIChuYW1lLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwibG9nIGdyb3VwIG92ZXIgbGltaXRcIik7XG4gICAgICBvdXQgPSB7IG5hbWUgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZmFpbChgdW5zdXBwb3J0ZWQga2luZCAke1N0cmluZyhydWxlLmtpbmQpfWApO1xuICAgIH1cblxuICAgIGNvbnN0IG5hbWUgPSBvdXQubmFtZSBhcyBzdHJpbmc7XG4gICAgaWYgKCFuZXcgUmVnRXhwKGBeKD86JHtydWxlLmNoYXJzZXR9KSskYCkudGVzdChuYW1lKSkgZmFpbChcImNoYXJzZXRcIik7XG4gICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJsZW5ndGhcIik7XG4gICAgaWYgKHJ1bGUubWluICE9PSB1bmRlZmluZWQgJiYgbmFtZS5sZW5ndGggPCBydWxlLm1pbikgZmFpbChcImxlbmd0aFwiKTtcbiAgICBpZiAoW1wiczNfYnVja2V0XCIsIFwiczNfdmVjdG9yX2J1Y2tldFwiLCBcInMzX3ZlY3Rvcl9pbmRleFwiXS5pbmNsdWRlcyhyZXNvdXJjZVR5cGUpICYmICFTM19FREdFU19SRS50ZXN0KG5hbWUpKSB7XG4gICAgICBmYWlsKFwiczMgc3RhcnQvZW5kXCIpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBzY29wZSBpbiB3aGljaCBBV1MgcmVxdWlyZXMgYSB0eXBlJ3MgbmFtZXMgdG8gYmUgdW5pcXVlIChjb250cmFjdFxuICAgKiBzZWN0aW9uIDExLjEpLiBBIHR5cGUgdGhlIGNvbnRyYWN0IHN0YXRlcyBubyBzY29wZSBmb3IgaXMgcmVmdXNlZDogaXQgY2Fubm90XG4gICAqIGJlIHJlc2VydmVkLCBzbyBpdCBjYW5ub3QgYmUgZGVwbG95ZWQgdGhyb3VnaCB0aGUgaW5kZXggdW50aWwgYSByZXZpc2lvblxuICAgKiBzdGF0ZXMgaXRzIHNjb3BlLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBuYW1pbmdTY29wZShyZXNvdXJjZVR5cGU6IHN0cmluZyk6IEFwcFRoZW9yeU5hbWluZ1Njb3BlIHtcbiAgICBpZiAobmFtaW5nUnVsZShyZXNvdXJjZVR5cGUpID09PSB1bmRlZmluZWQpIGZhaWwoVU5LTk9XTl9OQU1JTkdfU0NPUEUpO1xuICAgIGlmIChOT1RfVU5JUVVFX1RZUEVTLmhhcyhyZXNvdXJjZVR5cGUpKSByZXR1cm4gQXBwVGhlb3J5TmFtaW5nU2NvcGUuTk9UX1VOSVFVRTtcbiAgICBpZiAoQUNDT1VOVF9HTE9CQUxfVFlQRVMuaGFzKHJlc291cmNlVHlwZSkpIHJldHVybiBBcHBUaGVvcnlOYW1pbmdTY29wZS5BQ0NPVU5UO1xuICAgIHJldHVybiBBcHBUaGVvcnlOYW1pbmdTY29wZS5BQ0NPVU5UX1JFR0lPTjtcbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSBhIHBoeXNpY2FsIG5hbWUgdGhlIGNvbnRyYWN0IGZpeGVzIHJhdGhlciB0aGFuIGRlcml2ZXMgYWdhaW5zdCB0aGVcbiAgICogY2hhcmFjdGVyIGFuZCBzaGFwZSBydWxlcyBvZiB0aGUgdHlwZSdzIHNlY3Rpb24gMiByb3c6IGNoYXJzZXQsIHRoZSBsZW5ndGhcbiAgICogcmFuZ2UgKCoqYm90aCoqIGJvdW5kcyB3aGVuIHRoZSByb3cgc3RhdGVzIGEgbG93ZXIgb25lLCBub3Qgb25seSB0aGUgdXBwZXIpLFxuICAgKiB0aGUgUzMgc3RhcnQvZW5kIHJ1bGUsIHRoZSBwYXRoIHJ1bGVzIChsZWFkLCBub24tZW1wdHkgc2VnbWVudHMsIGRlcHRoLFxuICAgKiByZXNlcnZlZCBwcmVmaXhlcywgdGhlIGBhbGlhcy9hd3MvYCBuYW1lc3BhY2UpIGFuZCB0aGUgc2VjcmV0IEFSTi1zdWZmaXhcbiAgICogcnVsZS4gVGhyb3dzIG9uIGEgbmFtZSBvdXRzaWRlIHRoZW0uXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIHNlY3Rpb24gMiB0YWJsZSwgbm90IGEgc2Vjb25kIG9uZTogaXQgcmVhZHMgdGhlIHNhbWUgcnVsZSByb3dzXG4gICAqIHRoZSBkZXJpdmF0aW9uIHVzZXMuIEEgYGxvZ19ncm91cGAgYWNjZXB0cyBgL2AgaW4gYWRkaXRpb24gdG8gdGhlIHNlY3Rpb24gMlxuICAgKiBjaGFyc2V0LCBidXQgb25seSBmb3IgdGhlIHR3byBmaXhlZCBzaGFwZXMgY29udHJhY3Qgc2VjdGlvbiAzIHN0YXRlczogYVxuICAgKiBsb2ctc291cmNlIG5hbWUgKHdoaWNoIGNhcnJpZXMgbm8gYC9gIGF0IGFsbCwgYmVjYXVzZSBzZWN0aW9uIDMgam9pbnMgaXRzXG4gICAqIHNlZ21lbnRzIHdpdGggYF9gKSBvciB0aGUgTGFtYmRhIHNlcnZpY2UgcGF0aCBgL2F3cy9sYW1iZGEve2Z1bmN0aW9uIG5hbWV9YCxcbiAgICogd2hvc2UgZnVuY3Rpb24gbmFtZSBzYXRpc2ZpZXMgdGhlIGBsYW1iZGFfZnVuY3Rpb25gIHJvdy4gQW55IG90aGVyXG4gICAqIGAvYC1iZWFyaW5nIGxvZyBncm91cCBpcyByZWZ1c2VkIChTQU5JVFktQVQtTjMtMDgpLlxuICAgKlxuICAgKiBUaGUgY2hlY2sgaXMgKipzdHJ1Y3R1cmFsKio6IGl0IGhvbGRzIG5vIGNvbnRleHQgdmFsdWVzLCBzbyBpdCBjYW5ub3QgdGVsbFxuICAgKiB3aGV0aGVyIGEgbG9nLXNvdXJjZS1zaGFwZWQgbmFtZSBpcyB0aGlzIG5hbWluZyBjb250ZXh0J3Mgb3duIHNvdXJjZS4gVGhlXG4gICAqIGNvbnRleHQgY29tcGxldGVzIHRoYXQgcnVsZSBpbiBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dC5kZWNsYXJlRml4ZWROYW1lYCxcbiAgICogd2hpY2ggb3ducyB0aGUgYm91bmQgYHRoZW9yeWNsb3VkX3tuYW1lc3BhY2V9X3thcHB9X3tzdGFnZX1fYCBwcmVmaXhcbiAgICogKFNBTklUWS1BVC1OMy0wOCwgcm91bmQgNCkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlUGh5c2ljYWxOYW1lKHJlc291cmNlVHlwZTogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBydWxlID0gbmFtaW5nUnVsZShyZXNvdXJjZVR5cGUpO1xuICAgIGlmIChydWxlID09PSB1bmRlZmluZWQpIGZhaWwoVU5LTk9XTl9OQU1JTkdfU0NPUEUpO1xuICAgIGNvbnN0IGNoYXJzZXQgPSBGSVhFRF9OQU1FX0NIQVJTRVRTLmdldChyZXNvdXJjZVR5cGUpID8/IHJ1bGUuY2hhcnNldDtcbiAgICBjb25zdCBxdW90ZWQgPSBKU09OLnN0cmluZ2lmeShuYW1lKTtcbiAgICBpZiAobmFtZS5sZW5ndGggPT09IDAgfHwgIW5ldyBSZWdFeHAoYF4oPzoke2NoYXJzZXR9KSskYCkudGVzdChuYW1lKSkge1xuICAgICAgZmFpbChgYSBmaXhlZCAke3Jlc291cmNlVHlwZX0gbmFtZSBtdXN0IG1hdGNoICR7Y2hhcnNldH0gKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICB9XG4gICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIHtcbiAgICAgIGZhaWwoYGEgZml4ZWQgJHtyZXNvdXJjZVR5cGV9IG5hbWUgbXVzdCBiZSBhdCBtb3N0ICR7cnVsZS5tYXh9IGNoYXJhY3RlcnMsIGdvdCAke25hbWUubGVuZ3RofWApO1xuICAgIH1cbiAgICBpZiAocnVsZS5taW4gIT09IHVuZGVmaW5lZCAmJiBuYW1lLmxlbmd0aCA8IHJ1bGUubWluKSB7XG4gICAgICBmYWlsKGBhIGZpeGVkICR7cmVzb3VyY2VUeXBlfSBuYW1lIG11c3QgYmUgYXQgbGVhc3QgJHtydWxlLm1pbn0gY2hhcmFjdGVycyAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7bmFtZS5sZW5ndGh9YCk7XG4gICAgfVxuICAgIGlmIChydWxlLmxlYWQgIT09IHVuZGVmaW5lZCAmJiAhbmFtZS5zdGFydHNXaXRoKHJ1bGUubGVhZCkpIHtcbiAgICAgIGZhaWwoYGEgZml4ZWQgJHtyZXNvdXJjZVR5cGV9IG5hbWUgbXVzdCBzdGFydCB3aXRoICR7SlNPTi5zdHJpbmdpZnkocnVsZS5sZWFkKX0gKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICB9XG4gICAgaWYgKFMzX1RZUEVTLmhhcyhyZXNvdXJjZVR5cGUpICYmICFTM19FREdFU19SRS50ZXN0KG5hbWUpKSB7XG4gICAgICBmYWlsKGBhIGZpeGVkICR7cmVzb3VyY2VUeXBlfSBuYW1lIG11c3Qgc3RhcnQgYW5kIGVuZCB3aXRoIGEgbGV0dGVyIG9yIGRpZ2l0IChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgfVxuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwic2VjcmV0XCIgJiYgU0VDUkVUX1RBSUxfUkUudGVzdChuYW1lKSkge1xuICAgICAgZmFpbChgYSBmaXhlZCBzZWNyZXQgbmFtZSBtdXN0IG5vdCBlbmQgd2l0aCBhIGh5cGhlbiBhbmQgc2l4IGNoYXJhY3RlcnMgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICB9XG4gICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzc21fcGFyYW1ldGVyXCIpIHtcbiAgICAgIC8vIEEgcGF0aCBuYW1lIGNhcnJpZXMgYXQgbGVhc3Qgb25lIG5vbi1lbXB0eSBzZWdtZW50IGFmdGVyIGl0cyBsZWFkIGAvYCxcbiAgICAgIC8vIGFuZCBubyBlbXB0eSBzZWdtZW50OiBgL2AgYW5kIGAvYS8vYmAgbmFtZSBub3RoaW5nIEFXUyBjYW4gY3JlYXRlLlxuICAgICAgaWYgKCFTU01fUEFUSF9SRS50ZXN0KG5hbWUpKSB7XG4gICAgICAgIGZhaWwoXG4gICAgICAgICAgYGEgZml4ZWQgc3NtX3BhcmFtZXRlciBuYW1lIG11c3QgY2FycnkgYXQgbGVhc3Qgb25lIG5vbi1lbXB0eSBzZWdtZW50IGFmdGVyIGl0cyBsZWFkIFwiL1wiIGFuZCBubyBlbXB0eSBzZWdtZW50IChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICgobmFtZS5tYXRjaCgvXFwvL2cpPy5sZW5ndGggPz8gMCkgPiAxNSkge1xuICAgICAgICBmYWlsKGBhIGZpeGVkIHNzbV9wYXJhbWV0ZXIgbmFtZSBtdXN0IGhhdmUgYXQgbW9zdCAxNSBsZXZlbHMgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICAgIH1cbiAgICAgIGlmICgvXlxcLz8oPzphd3N8c3NtKSg/OlxcL3wkKS9pLnRlc3QobmFtZSkpIHtcbiAgICAgICAgZmFpbChgYSBmaXhlZCBzc21fcGFyYW1ldGVyIG5hbWUgbXVzdCBub3QgYmVnaW4gd2l0aCBhd3Mgb3Igc3NtIChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwia21zX2FsaWFzXCIpIHtcbiAgICAgIC8vIGBhbGlhcy9gIGFsb25lIG5hbWVzIG5vIGFsaWFzOiB0aGUgbmFtZSBhZnRlciB0aGUgbGVhZCBpcyB0aGUgYWxpYXMuXG4gICAgICBpZiAobmFtZS5sZW5ndGggPD0gS01TX0FMSUFTX0xFQUQubGVuZ3RoKSB7XG4gICAgICAgIGZhaWwoXG4gICAgICAgICAgYGEgZml4ZWQga21zX2FsaWFzIG5hbWUgbXVzdCBjYXJyeSBhIG5vbi1lbXB0eSBuYW1lIGFmdGVyIGl0cyAke0pTT04uc3RyaW5naWZ5KEtNU19BTElBU19MRUFEKX0gbGVhZCAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiYWxpYXMvYXdzL1wiKSkge1xuICAgICAgICBmYWlsKGBhIGZpeGVkIGttc19hbGlhcyBuYW1lIG11c3Qgbm90IGJlIGluIHRoZSBhbGlhcy9hd3MvIG5hbWVzcGFjZSAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWApO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcImxvZ19ncm91cFwiKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiYXdzL1wiKSkge1xuICAgICAgICBmYWlsKGBhIGZpeGVkIGxvZ19ncm91cCBuYW1lIG11c3Qgbm90IGJlZ2luIHdpdGggYXdzLyAoY29udHJhY3Qgc2VjdGlvbiAzKSwgZ290ICR7cXVvdGVkfWApO1xuICAgICAgfSBlbHNlIGlmICghaXNGaXhlZExvZ0dyb3VwU2hhcGUobmFtZSkpIHtcbiAgICAgICAgZmFpbChcbiAgICAgICAgICBgYSBmaXhlZCBsb2dfZ3JvdXAgbmFtZSBtdXN0IGJlIGVpdGhlciBhIHNlY3Rpb24gMyBsb2ctc291cmNlIG5hbWUgKG5vIFwiL1wiKSBvciB0aGUgTGFtYmRhIHNlcnZpY2UgcGF0aCAke0pTT04uc3RyaW5naWZ5KExBTUJEQV9MT0dfR1JPVVBfTEVBRCl9IGZvbGxvd2VkIGJ5IGEgbmFtZSB0aGF0IHNhdGlzZmllcyB0aGUgbGFtYmRhX2Z1bmN0aW9uIHJvdyAoY29udHJhY3Qgc2VjdGlvbiAzKSwgZ290ICR7cXVvdGVkfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlZnVzZSB0d28gZGlmZmVyZW50IGxvZ2ljYWwgcmVzb3VyY2VzIGluIG9uZSBuYW1pbmcgY29udGV4dCB0aGF0IGRlcml2ZSB0aGVcbiAgICogc2FtZSBuYW1lIGluIHRoZSBzYW1lIG5hbWluZyBzY29wZSwgYW5kIHJldHVybiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0XG4gICAqIChjb250cmFjdCBzZWN0aW9uIDExLjQpLiBBIExhbWJkYSBmdW5jdGlvbiBhbmQgaXRzIElBTSByb2xlIG1heSBzaGFyZSBhIG5hbWVcbiAgICogYmVjYXVzZSB0aGVpciBzY29wZXMgZGlmZmVyLCBhbmQgdHdvIEFQSXMgbWF5IHNoYXJlIG9uZSBiZWNhdXNlIEFXUyBkb2VzIG5vdFxuICAgKiBrZWVwIEFQSSBuYW1lcyB1bmlxdWUuIFJvd3Mga2VlcCB0aGUgb3JkZXIgb2YgdGhlIGVudHJpZXMuXG4gICAqXG4gICAqIGBsb2dpY2FsSWRgIGlzIHRoZSByZXNvdXJjZSdzIGlkZW50aXR5IGluc2lkZSB0aGUgbmFtaW5nIGNvbnRleHQ6IGl0c1xuICAgKiBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkLCBvciB0aGUgb3duaW5nIHN0YWNrJ3MgY29uc3RydWN0IHBhdGggcGx1cyB0aGF0XG4gICAqIGxvZ2ljYWwgaWQgd2hlbiB0aGUgY29udGV4dCBzcGFucyBzZXZlcmFsIHN0YWNrcy4gQSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkXG4gICAqIGlzIHVuaXF1ZSBvbmx5IGluc2lkZSBvbmUgdGVtcGxhdGUsIHNvIGEgY2FsbGVyIHRoYXQgb3ducyBtb3JlIHRoYW4gb25lXG4gICAqIHRlbXBsYXRlIG11c3QgcGFzcyB0aGUgcXVhbGlmaWVkIGZvcm07IG90aGVyd2lzZSB0d28gcmVzb3VyY2VzIGluIGRpZmZlcmVudFxuICAgKiBzdGFja3Mgd2l0aCB0aGUgc2FtZSBsb2NhbCBsb2dpY2FsIGlkIGxvb2sgbGlrZSBvbmUgcmUtZGVjbGFyZWQgcmVzb3VyY2VcbiAgICogKFNBTklUWS1BVC1OMy0wNSkuIFRoZSByZXR1cm5lZCByb3cgZWNob2VzIHRoZSBpZGVudGl0eSBpdCB3YXMgZ2l2ZW4uXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHN5bnRoQ2hlY2soZW50cmllczogQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dFtdKTogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXSB7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgY29uc3QgYXJ0aWZhY3Q6IEFwcFRoZW9yeURlcml2ZWROYW1lW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGNvbnN0IHNjb3BlID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubmFtaW5nU2NvcGUoZW50cnkudHlwZSk7XG4gICAgICBjb25zdCBnZW5lcmF0ZWQgPSBlbnRyeS5nZW5lcmF0ZWQgPT09IHRydWU7XG4gICAgICBhcnRpZmFjdC5wdXNoKHtcbiAgICAgICAgLi4uKGVudHJ5Lm5hbWUgIT09IHVuZGVmaW5lZCAmJiAhZ2VuZXJhdGVkID8geyBuYW1lOiBlbnRyeS5uYW1lIH0gOiB7fSksXG4gICAgICAgIHR5cGU6IGVudHJ5LnR5cGUsXG4gICAgICAgIHNjb3BlLFxuICAgICAgICBsb2dpY2FsSWQ6IGVudHJ5LmxvZ2ljYWxJZCxcbiAgICAgICAgLi4uKGdlbmVyYXRlZCA/IHsgZ2VuZXJhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICAgIGlmIChzY29wZSA9PT0gQXBwVGhlb3J5TmFtaW5nU2NvcGUuTk9UX1VOSVFVRSB8fCBnZW5lcmF0ZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYCR7c2NvcGV9XFx1MDAwMCR7ZW50cnkudHlwZX1cXHUwMDAwJHtlbnRyeS5uYW1lID8/IFwiXCJ9YDtcbiAgICAgIGNvbnN0IGhlbGQgPSBzZWVuLmdldChrZXkpO1xuICAgICAgaWYgKGhlbGQgIT09IHVuZGVmaW5lZCAmJiBoZWxkICE9PSBlbnRyeS5sb2dpY2FsSWQpIHtcbiAgICAgICAgZmFpbChgJHtoZWxkfSBhbmQgJHtlbnRyeS5sb2dpY2FsSWR9IGRlcml2ZSAke2VudHJ5Lm5hbWUgPz8gXCJcIn0gaW4gc2NvcGUgJHtzY29wZX1gKTtcbiAgICAgIH1cbiAgICAgIHNlZW4uc2V0KGtleSwgZW50cnkubG9naWNhbElkKTtcbiAgICB9XG4gICAgcmV0dXJuIGFydGlmYWN0O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgYXMgdGhlIGNsb3VkLWFzc2VtYmx5IG1ldGFkYXRhIGRvY3VtZW50LCB3aXRoIHRoZVxuICAgKiBjb250cmFjdCdzIHNuYWtlX2Nhc2Ugd2lyZSBrZXlzIGFuZCBhIGRldGVybWluaXN0aWMgZW50cnkgb3JkZXIuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGRlcml2ZWROYW1lc0pzb24oYXJ0aWZhY3Q6IEFwcFRoZW9yeURlcml2ZWROYW1lcyk6IHN0cmluZyB7XG4gICAgY29uc3QgZW50cmllcyA9IFsuLi5hcnRpZmFjdC5lbnRyaWVzXVxuICAgICAgLm1hcCgoZW50cnkpID0+ICh7XG4gICAgICAgIC4uLihlbnRyeS5uYW1lICE9PSB1bmRlZmluZWQgJiYgIWVudHJ5LmdlbmVyYXRlZCA/IHsgbmFtZTogZW50cnkubmFtZSB9IDoge30pLFxuICAgICAgICB0eXBlOiBlbnRyeS50eXBlLFxuICAgICAgICBzY29wZTogZW50cnkuc2NvcGUsXG4gICAgICAgIGxvZ2ljYWxfaWQ6IGVudHJ5LmxvZ2ljYWxJZCxcbiAgICAgICAgLi4uKGVudHJ5LmdlbmVyYXRlZCA/IHsgZ2VuZXJhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICB9KSlcbiAgICAgIC5zb3J0KChhLCBiKSA9PiB7XG4gICAgICAgIGNvbnN0IGtleSA9IChyb3c6IHR5cGVvZiBhKTogc3RyaW5nID0+XG4gICAgICAgICAgW3Jvdy5zY29wZSwgcm93LnR5cGUsIHJvdy5uYW1lID8/IFwiXCIsIHJvdy5sb2dpY2FsX2lkXS5qb2luKFwiXFx1MDAwMFwiKTtcbiAgICAgICAgY29uc3QgbGVmdCA9IGtleShhKTtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBrZXkoYik7XG4gICAgICAgIHJldHVybiBsZWZ0IDwgcmlnaHQgPyAtMSA6IGxlZnQgPiByaWdodCA/IDEgOiAwO1xuICAgICAgfSk7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGNvbnRyYWN0OiBhcnRpZmFjdC5jb250cmFjdCxcbiAgICAgIHNjaGVtYTogYXJ0aWZhY3Quc2NoZW1hLFxuICAgICAgY29udGV4dDoge1xuICAgICAgICBuYW1lc3BhY2U6IGFydGlmYWN0LmNvbnRleHQubmFtZXNwYWNlID8/IExPR19QUkVGSVgsXG4gICAgICAgIGFwcDogYXJ0aWZhY3QuY29udGV4dC5hcHAsXG4gICAgICAgIHN0YWdlOiBhcnRpZmFjdC5jb250ZXh0LnN0YWdlLFxuICAgICAgICBhY2NvdW50OiBhcnRpZmFjdC5jb250ZXh0LmFjY291bnQsXG4gICAgICAgIHJlZ2lvbjogYXJ0aWZhY3QuY29udGV4dC5yZWdpb24sXG4gICAgICB9LFxuICAgICAgZW50cmllcyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSBvbmUgc2VsZWN0b3IuIFRocm93cyBvbiBhIHNlbGVjdG9yIG91dHNpZGUgdGhlIGdyYW1tYXIuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlU2VsZWN0b3Ioc2VsZWN0b3I6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGJhc2UgPSBzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpID8gc2VsZWN0b3Iuc2xpY2UoMCwgLTIpIDogc2VsZWN0b3I7XG4gICAgaWYgKCFMT0dJQ0FMX1JFLnRlc3QoYmFzZSkgfHwgYmFzZS5zcGxpdChcIi9cIilbMF0gIT09IFwibG9nc1wiIHx8IChiYXNlID09PSBcImxvZ3NcIiAmJiAhc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSkpIHtcbiAgICAgIGZhaWwoYHNlbGVjdG9yICR7c2VsZWN0b3J9YCk7XG4gICAgfVxuICAgIGlmIChiYXNlLmluY2x1ZGVzKFwiKlwiKSkgZmFpbChcIndpbGRjYXJkIG9ubHkgYXMgdHJhaWxpbmcgLypcIik7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBhIHNlbGVjdG9yIG1hdGNoZXMgYSBsb2dpY2FsIHNvdXJjZS4gQSB0cmFpbGluZyBgLypgIG1hdGNoZXNcbiAgICogZGVzY2VuZGFudHMgb25seS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yOiBzdHJpbmcsIGxvZ2ljYWw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGlmIChzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSByZXR1cm4gbG9naWNhbC5zdGFydHNXaXRoKHNlbGVjdG9yLnNsaWNlKDAsIC0xKSk7XG4gICAgcmV0dXJuIGxvZ2ljYWwgPT09IHNlbGVjdG9yO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgYSBzb3VyY2UgaXMgdmlzaWJsZTogYW4gaW5jbHVkZSBtYXRjaGVzIGFuZCBubyBleGNsdWRlIGRvZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHNvdXJjZVZpc2libGUocnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcywgbG9naWNhbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgaW5jbHVkZWQgPSAocnVsZXMuaW5jbHVkZSA/PyBbXSkuc29tZSgoc2VsZWN0b3IpID0+IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNlbGVjdG9yTWF0Y2hlcyhzZWxlY3RvciwgbG9naWNhbCkpO1xuICAgIGlmICghaW5jbHVkZWQpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gIShydWxlcy5leGNsdWRlID8/IFtdKS5zb21lKChzZWxlY3RvcikgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yLCBsb2dpY2FsKSk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGZpcnN0IDEyIGhleCBjaGFyYWN0ZXJzIG9mIFNIQS0yNTYgb3ZlciB0aGUgY2Fub25pY2FsIHJ1bGVzLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBydWxlVmVyc2lvbihydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzKTogc3RyaW5nIHtcbiAgICBjb25zdCBjYW5vbmljYWwgPSBge1wiZXhjbHVkZVwiOiR7SlNPTi5zdHJpbmdpZnkoc29ydGVkQ29weShydWxlcy5leGNsdWRlKSl9LFwiaW5jbHVkZVwiOiR7SlNPTi5zdHJpbmdpZnkoc29ydGVkQ29weShydWxlcy5pbmNsdWRlKSl9fWA7XG4gICAgcmV0dXJuIHNoYTI1NkhleChjYW5vbmljYWwpLnNsaWNlKDAsIDEyKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21waWxlIHRoZSBydWxlcyBpbnRvIHRoZSByZWFkZXItcm9sZSBpbmxpbmUgcG9saWN5IGRvY3VtZW50LiBUaGUgcmV0dXJuXG4gICAqIHZhbHVlIGlzIHRoZSBjb250cmFjdCBKU09OLCBzbyBhIGNvbnN1bWVyIGNhbiBjb21wYXJlIGl0IGJ5dGUgZm9yIGJ5dGUuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGNvbXBpbGVWaXNpYmlsaXR5UG9saWN5SnNvbihcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIFsuLi4ocnVsZXMuaW5jbHVkZSA/PyBbXSksIC4uLihydWxlcy5leGNsdWRlID8/IFtdKV0pIHtcbiAgICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuICAgIH1cbiAgICBjb25zdCBiYXNlID0gYGFybjphd3M6bG9nczoke3ZhbHVlcy5yZWdpb259OiR7dmFsdWVzLmFjY291bnR9OmxvZy1ncm91cDpgO1xuICAgIGNvbnN0IGFybnNGb3IgPSAoc2VsZWN0b3I6IHN0cmluZyk6IHN0cmluZ1tdID0+IHtcbiAgICAgIGlmIChzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICAgIHJldHVybiBbYmFzZSArIGxvZ1ByZWZpeCh2YWx1ZXMpICsgc2VsZWN0b3Iuc2xpY2UoMCwgLTEpLnJlcGxhY2UoL1xcLy9nLCBcIl9cIikgKyBcIipcIl07XG4gICAgICB9XG4gICAgICBjb25zdCBuYW1lID0gbG9nUHJlZml4KHZhbHVlcykgKyBzZWxlY3Rvci5yZXBsYWNlKC9cXC8vZywgXCJfXCIpO1xuICAgICAgcmV0dXJuIFtiYXNlICsgbmFtZSwgYmFzZSArIG5hbWUgKyBcIjoqXCJdO1xuICAgIH07XG4gICAgY29uc3QgYWN0aW9ucyA9IFsuLi5LRUVQRVJfQUNUSU9OU19HUk9VUCwgLi4uS0VFUEVSX0FDVElPTlNfU1RSRUFNXTtcbiAgICBjb25zdCBzdGF0ZW1lbnRzOiB7IFNpZDogc3RyaW5nOyBFZmZlY3Q6IHN0cmluZzsgQWN0aW9uOiBzdHJpbmdbXTsgUmVzb3VyY2U6IHN0cmluZ1tdIH1bXSA9IFtcbiAgICAgIHtcbiAgICAgICAgU2lkOiBcIlJlYWRNYW5pZmVzdFwiLFxuICAgICAgICBFZmZlY3Q6IFwiQWxsb3dcIixcbiAgICAgICAgQWN0aW9uOiBbXCJzc206R2V0UGFyYW1ldGVyXCJdLFxuICAgICAgICBSZXNvdXJjZTogW1xuICAgICAgICAgIGBhcm46YXdzOnNzbToke3ZhbHVlcy5yZWdpb259OiR7dmFsdWVzLmFjY291bnR9OnBhcmFtZXRlci8ke0xPR19QUkVGSVh9L3Zpc2liaWxpdHkvJHt2YWx1ZXMuYXBwfS8ke3ZhbHVlcy5zdGFnZX0vbWFuaWZlc3RgLFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGNvbnN0IGluY2x1ZGVkID0gc29ydGVkQ29weShydWxlcy5pbmNsdWRlKS5mbGF0TWFwKGFybnNGb3IpO1xuICAgIGNvbnN0IGV4Y2x1ZGVkID0gc29ydGVkQ29weShydWxlcy5leGNsdWRlKS5mbGF0TWFwKGFybnNGb3IpO1xuICAgIGlmIChpbmNsdWRlZC5sZW5ndGggPiAwKSBzdGF0ZW1lbnRzLnB1c2goeyBTaWQ6IFwiUmVhZEluY2x1ZGVkXCIsIEVmZmVjdDogXCJBbGxvd1wiLCBBY3Rpb246IGFjdGlvbnMsIFJlc291cmNlOiBpbmNsdWRlZCB9KTtcbiAgICBpZiAoZXhjbHVkZWQubGVuZ3RoID4gMCkgc3RhdGVtZW50cy5wdXNoKHsgU2lkOiBcIkRlbnlFeGNsdWRlZFwiLCBFZmZlY3Q6IFwiRGVueVwiLCBBY3Rpb246IGFjdGlvbnMsIFJlc291cmNlOiBleGNsdWRlZCB9KTtcbiAgICBjb25zdCBkb2N1bWVudCA9IEpTT04uc3RyaW5naWZ5KHsgVmVyc2lvbjogXCIyMDEyLTEwLTE3XCIsIFN0YXRlbWVudDogc3RhdGVtZW50cyB9KTtcbiAgICBpZiAoZG9jdW1lbnQubGVuZ3RoID4gUk9MRV9QT0xJQ1lfTUFYKSBmYWlsKFwiY29tcGlsZWQgcG9saWN5IG92ZXIgcm9sZSBwb2xpY3kgc2l6ZVwiKTtcbiAgICByZXR1cm4gZG9jdW1lbnQ7XG4gIH1cblxuICAvKipcbiAgICogQXNzZW1ibGUgdGhlIHN5bnRoLXRpbWUgdmlzaWJpbGl0eSBwcmV2aWV3LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2aXNpYmlsaXR5UHJldmlldyhcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBzb3VyY2VzOiBzdHJpbmdbXSxcbiAgKTogQXBwVGhlb3J5VmlzaWJpbGl0eVByZXZpZXcge1xuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh2YWx1ZXMpO1xuICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgWy4uLihydWxlcy5pbmNsdWRlID8/IFtdKSwgLi4uKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pXSkge1xuICAgICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBydWxlVmVyc2lvbjogQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcucnVsZVZlcnNpb24ocnVsZXMpLFxuICAgICAgbWF0Y2hlZE5vdzogc291cmNlcy5maWx0ZXIoKHNvdXJjZSkgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgc291cmNlKSkuc29ydCgpLFxuICAgICAgbm90TWF0Y2hlZE5vdzogc291cmNlcy5maWx0ZXIoKHNvdXJjZSkgPT4gIUFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIHNvdXJjZSkpLnNvcnQoKSxcbiAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpLCBleGNsdWRlOiBzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBc3NlbWJsZSB0aGUgcHVibGlzaGVkIG1hbmlmZXN0ICh0aGUgcHJldmlldyBtaW51cyBgbm90TWF0Y2hlZE5vd2ApLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2aXNpYmlsaXR5TWFuaWZlc3QoXG4gICAgdmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICAgc291cmNlczogc3RyaW5nW10sXG4gICk6IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdCB7XG4gICAgY29uc3QgcHJldmlldyA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZpc2liaWxpdHlQcmV2aWV3KHZhbHVlcywgcnVsZXMsIHNvdXJjZXMpO1xuICAgIHJldHVybiB7IHJ1bGVWZXJzaW9uOiBwcmV2aWV3LnJ1bGVWZXJzaW9uLCBtYXRjaGVkTm93OiBwcmV2aWV3Lm1hdGNoZWROb3csIGZ1dHVyZTogcHJldmlldy5mdXR1cmUgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXJpYWxpemUgYSBtYW5pZmVzdCB0byB0aGUgY29udHJhY3QgSlNPTiBzaGFwZSB3cml0dGVuIHRvIFNTTS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbWFuaWZlc3RKc29uKG1hbmlmZXN0OiBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3QpOiBzdHJpbmcge1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBydWxlX3ZlcnNpb246IG1hbmlmZXN0LnJ1bGVWZXJzaW9uLFxuICAgICAgbWF0Y2hlZF9ub3c6IG1hbmlmZXN0Lm1hdGNoZWROb3csXG4gICAgICBmdXR1cmU6IHsgaW5jbHVkZTogbWFuaWZlc3QuZnV0dXJlLmluY2x1ZGUgPz8gW10sIGV4Y2x1ZGU6IG1hbmlmZXN0LmZ1dHVyZS5leGNsdWRlID8/IFtdIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogS2VlcGVyJ3MgcmVhZCBkZWNpc2lvbiwgaW4gdGhlIHJ1bnRpbWVzJyBwYXJhbWV0ZXIgb3JkZXIuIEZhaWxzIGNsb3NlZCBvbiBhXG4gICAqIGRlbmlhbCBvciBhbiB1bnJlYWNoYWJsZSBhY2NvdW50LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBrZWVwZXJEZWNpc2lvbihcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIGxvZ2ljYWw6IHN0cmluZyxcbiAgICBhd3NSZXN1bHQ6IHN0cmluZyxcbiAgKTogQXBwVGhlb3J5S2VlcGVyQW5zd2VyIHtcbiAgICBpZiAoIXJ1bGVzIHx8ICFBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBsb2dpY2FsKSkge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5OT1RfU0hBUkVEO1xuICAgIH1cbiAgICBpZiAoYXdzUmVzdWx0ID09PSBcImV2ZW50c1wiKSByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLkVWRU5UUztcbiAgICBpZiAoYXdzUmVzdWx0ID09PSBcImVtcHR5XCIgfHwgYXdzUmVzdWx0ID09PSBcIm5vdF9mb3VuZFwiKSByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLkFMTE9XRURfTk9fRVZFTlRTO1xuICAgIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuTk9UX1NIQVJFRDtcbiAgfVxufVxuIl19