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
/**
 * The refusal contract sections 1 and 4 state for the two live-compatibility
 * naming tools on a namespaced context: a deployment whose names carry the
 * tenant namespace takes neither the legacy profile nor a generated entry,
 * because either would produce a name with no namespace and collide across
 * tenants in a pooled account.
 */
const HOSTED_PROFILE_FAILURE = "a hosted deployment takes no legacy profile or generated entries";
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
     *
     * The naming profile and the context's own generated entries are properties of
     * the context, so a namespaced context that carries either is refused here —
     * when the context is validated, at construction — and not only as a side
     * effect of composing a physical name (contract sections 1 and 4, r5;
     * SAN-AT-N5-01). A hosted context that declares nothing yet would otherwise
     * stand as a valid context whose every future name could carry no namespace.
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
        if (namespaced(values)) {
            const legacy = (values.namingProfile ?? AppTheoryNamingProfile.DERIVED) === AppTheoryNamingProfile.LEGACY;
            if (legacy || (values.generated ?? []).length > 0) {
                fail(HOSTED_PROFILE_FAILURE);
            }
        }
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
     *
     * The context is validated first, so resolving one log-source name is enough
     * to refuse a context that breaks a rule: a forbidden naming profile must not
     * survive on the log-only path (contract sections 1 and 4, r5; SAN-AT-N5-01).
     */
    static logGroupName(values, logical) {
        AppTheoryResourceNaming.validateContext(values);
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
            fail(HOSTED_PROFILE_FAILURE);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekMscUVBQThGO0FBRTlGOztHQUVHO0FBQ1UsUUFBQSx3QkFBd0IsR0FBRyxrQ0FBa0MsQ0FBQztBQUUzRTs7R0FFRztBQUNVLFFBQUEsb0JBQW9CLEdBQUcsNENBQTRDLENBQUM7QUFFakY7OztHQUdHO0FBQ1UsUUFBQSwwQkFBMEIsR0FBRyx5Q0FBeUMsQ0FBQztBQUVwRjs7R0FFRztBQUNILElBQVksc0JBU1g7QUFURCxXQUFZLHNCQUFzQjtJQUNoQzs7T0FFRztJQUNILDZDQUFtQixDQUFBO0lBQ25COztPQUVHO0lBQ0gsMkNBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHNCQUFzQixzQ0FBdEIsc0JBQXNCLFFBU2pDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHVCQVNYO0FBVEQsV0FBWSx1QkFBdUI7SUFDakM7O09BRUc7SUFDSCxnREFBcUIsQ0FBQTtJQUNyQjs7T0FFRztJQUNILDRDQUFpQixDQUFBO0FBQ25CLENBQUMsRUFUVyx1QkFBdUIsdUNBQXZCLHVCQUF1QixRQVNsQztBQUVEOztHQUVHO0FBQ0gsSUFBWSxxQkFhWDtBQWJELFdBQVkscUJBQXFCO0lBQy9COztPQUVHO0lBQ0gsMENBQWlCLENBQUE7SUFDakI7O09BRUc7SUFDSCxnRUFBdUMsQ0FBQTtJQUN2Qzs7T0FFRztJQUNILGtEQUF5QixDQUFBO0FBQzNCLENBQUMsRUFiVyxxQkFBcUIscUNBQXJCLHFCQUFxQixRQWFoQztBQTRNRDs7R0FFRztBQUNILElBQVksb0JBYVg7QUFiRCxXQUFZLG9CQUFvQjtJQUM5Qjs7T0FFRztJQUNILDJDQUFtQixDQUFBO0lBQ25COztPQUVHO0lBQ0gseURBQWlDLENBQUE7SUFDakM7O09BRUc7SUFDSCxpREFBeUIsQ0FBQTtBQUMzQixDQUFDLEVBYlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFh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QUFNLEVBQUUsQ0FBQztJQUN0RyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxNQUFNLENBQUMsWUFBWSxDQUFDLFFBQXFDO1FBQzlELE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUNwQixZQUFZLEVBQUUsUUFBUSxDQUFDLFdBQVc7WUFDbEMsV0FBVyxFQUFFLFFBQVEsQ0FBQyxVQUFVO1lBQ2hDLE1BQU0sRUFBRSxFQUFFLE9BQU8sRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLE9BQU8sSUFBSSxFQUFFLEVBQUUsT0FBTyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsT0FBTyxJQUFJLEVBQUUsRUFBRTtTQUMzRixDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQ7OztPQUdHO0lBQ0ksTUFBTSxDQUFDLGNBQWMsQ0FDMUIsS0FBK0IsRUFDL0IsT0FBZSxFQUNmLFNBQWlCO1FBRWpCLElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxhQUFhLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDckUsT0FBTyxxQkFBcUIsQ0FBQyxVQUFVLENBQUM7UUFDMUMsQ0FBQztRQUNELElBQUksU0FBUyxLQUFLLFFBQVE7WUFBRSxPQUFPLHFCQUFxQixDQUFDLE1BQU0sQ0FBQztRQUNoRSxJQUFJLFNBQVMsS0FBSyxPQUFPLElBQUksU0FBUyxLQUFLLFdBQVc7WUFBRSxPQUFPLHFCQUFxQixDQUFDLGlCQUFpQixDQUFDO1FBQ3ZHLE9BQU8scUJBQXFCLENBQUMsVUFBVSxDQUFDO0lBQzFDLENBQUM7O0FBamVILDBEQWtlQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHsgTEFNQkRBX0xPR19HUk9VUF9MRUFELCBMT0dJQ0FMX1NFR01FTlRfUEFUVEVSTiB9IGZyb20gXCIuL3ByaXZhdGUvbG9nLXNvdXJjZS1ncmFtbWFyXCI7XG5cbi8qKlxuICogVGhlIHJlc291cmNlLW5hbWluZyBjb250cmFjdCB0aGlzIG1vZHVsZSBpbXBsZW1lbnRzLlxuICovXG5leHBvcnQgY29uc3QgUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNUID0gXCJ0aGVvcnljbG91ZF9yZXNvdXJjZV9uYW1pbmcudjAuMVwiO1xuXG4vKipcbiAqIFRoZSBzY2hlbWEgaWRlbnRpZmllciBvZiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGEgbmFtaW5nIGNvbnRleHQgZW1pdHMuXG4gKi9cbmV4cG9ydCBjb25zdCBERVJJVkVEX05BTUVTX1NDSEVNQSA9IFwiYXBwdGhlb3J5X3Jlc291cmNlX25hbWluZy5kZXJpdmVkX25hbWVzLnYxXCI7XG5cbi8qKlxuICogVGhlIGNsb3VkLWFzc2VtYmx5IG1ldGFkYXRhIHR5cGUgdGhhdCBjYXJyaWVzIHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QuIFRoZVxuICogYXJ0aWZhY3QgbGFuZHMgaW4gYHtzdGFja30ubWV0YWRhdGEuanNvbmAgaW4gYGNkay5vdXRgLlxuICovXG5leHBvcnQgY29uc3QgREVSSVZFRF9OQU1FU19NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTpyZXNvdXJjZS1uYW1pbmcvZGVyaXZlZC1uYW1lc1wiO1xuXG4vKipcbiAqIE5hbWluZyBwcm9maWxlcyBhY2NlcHRlZCBieSBhIG5hbWluZyBjb250ZXh0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlIHtcbiAgLyoqXG4gICAqIE5hbWVzIGRlcml2ZSBmcm9tIHRoZSBuYW1pbmcgY29udGV4dC5cbiAgICovXG4gIERFUklWRUQgPSBcImRlcml2ZWRcIixcbiAgLyoqXG4gICAqIEV2ZXJ5IG5hbWUgY29tZXMgZnJvbSBhIHBpbi5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG59XG5cbi8qKlxuICogTG9nZ2luZyBwcm9maWxlcyBhY2NlcHRlZCBieSBhIG5hbWluZyBjb250ZXh0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZSB7XG4gIC8qKlxuICAgKiBBcHBUaGVvcnkgY3JlYXRlcyBzdGFuZGFyZCBsb2cgZ3JvdXBzIGFuZCBhY2Nlc3MgbG9nZ2luZy5cbiAgICovXG4gIFNUQU5EQVJEID0gXCJzdGFuZGFyZFwiLFxuICAvKipcbiAgICogRWFjaCBjb25zdHJ1Y3Qga2VlcHMgaXRzIHByZS1jb250cmFjdCBsb2dnaW5nIGJlaGF2aW91ci5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG59XG5cbi8qKlxuICogS2VlcGVyJ3MgYW5zd2VyIHRvIGEgcmVhZGVyIHJlcXVlc3QuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUtlZXBlckFuc3dlciB7XG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIHNoYXJlZCBhbmQgdGhlIHJlYWQgcmV0dXJuZWQgZXZlbnRzLlxuICAgKi9cbiAgRVZFTlRTID0gXCJldmVudHNcIixcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgc2hhcmVkIGFuZCB0aGUgcmVhZCByZXR1cm5lZCBubyBldmVudHMuXG4gICAqL1xuICBBTExPV0VEX05PX0VWRU5UUyA9IFwiYWxsb3dlZF9ub19ldmVudHNcIixcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgbm90IHNoYXJlZCwgb3IgdGhlIHJlYWQgZmFpbGVkIGNsb3NlZC5cbiAgICovXG4gIE5PVF9TSEFSRUQgPSBcIm5vdF9zaGFyZWRcIixcbn1cblxuLyoqXG4gKiBCb3VuZCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dCB2YWx1ZXMgZnJvbSBzdGFnZSBjb25maWcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICogQGRlZmF1bHQgXCJ0aGVvcnljbG91ZFwiXG4gICAqL1xuICByZWFkb25seSBuYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFwcCBpbnN0YW5jZSBpZC5cbiAgICovXG4gIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZC5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFR3ZWx2ZS1kaWdpdCBhY2NvdW50IGlkLiBBbiB1bnJlc29sdmVkIHRva2VuIGZhaWxzIHN5bnRoZXNpcy5cbiAgICovXG4gIHJlYWRvbmx5IGFjY291bnQ6IHN0cmluZztcblxuICAvKipcbiAgICogRnVsbCBSZWdpb24gY29kZSwgZm9yIGV4YW1wbGUgYHVzLWVhc3QtMWAuXG4gICAqL1xuICByZWFkb25seSByZWdpb246IHN0cmluZztcblxuICAvKipcbiAgICogUGh5c2ljYWwgcGlucyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuXG4gICAqIEBkZWZhdWx0IHt9XG4gICAqL1xuICByZWFkb25seSBwaW5zPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAvKipcbiAgICogR2VuZXJhdGVkLW5hbWUgZW50cmllcyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuIEFuIGVudHJ5IG1lYW5zXG4gICAqIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSB0b2RheSwgc28gdGhlIGNvbnN0cnVjdCBzZXRzIG5vXG4gICAqIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkuIFZhbGlkIG9ubHkgdW5kZXIgdGhlIGxlZ2FjeSBuYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBgdHJ1ZWAgZm9yIGEgZGVwbG95bWVudCBUaGVvcnlDbG91ZC5haSBwbGFjZXMgb24gYSB0ZW5hbnQncyBiZWhhbGZcbiAgICogKGNvbnRyYWN0IHNlY3Rpb24gMSwgcjUpLiBBIGhvc3RlZCBkZXBsb3ltZW50IGFsd2F5cyBzdXBwbGllcyBpdHNcbiAgICogbmFtZXNwYWNlLCBuZXZlciB1c2VzIHRoZSByZXNlcnZlZCBwbGF0Zm9ybSBuYW1lc3BhY2UsIGFuZCBjYXJyaWVzIHRoZVxuICAgKiBuYW1lc3BhY2UgaW4gZXZlcnkgZGVyaXZlZCBuYW1lIChjb250cmFjdCBzZWN0aW9uIDIpLiBPbmx5IGZpcnN0LXBhcnR5XG4gICAqIHBsYXRmb3JtIGFwcHMgb21pdCBpdC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRURcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU/OiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU/OiBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nIHJldGVudGlvbiBpbiBkYXlzIGZvciBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cHMuXG4gICAqIEBkZWZhdWx0IDMwXG4gICAqL1xuICByZWFkb25seSByZXRlbnRpb25EYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRoZSBjb21wb3NlZCBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAvKipcbiAgICogVGhlIGZ1bGwgcGh5c2ljYWwgbmFtZS4gQWJzZW50IHdoZW4gQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBhY2NvdW50LXJlZ2lvbmFsIGJ1Y2tldC1uYW1lIHByZWZpeCwgd2hlbiB0aGUgdHlwZSB1c2VzIG9uZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBidWNrZXROYW1lUHJlZml4Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYnVja2V0IG5hbWVzcGFjZSwgd2hlbiB0aGUgdHlwZSB1c2VzIG9uZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBidWNrZXROYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIG5hbWUgY2FtZSBmcm9tIGEgcGluLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcGlubmVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUsIHNvIG5vIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkgaXNcbiAgICogc2V0LlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBPbmUgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSBhIHN0YWNrIGRlY2xhcmVzLCBhcyB0aGUgc3ludGggY2hlY2sgKGNvbnRyYWN0XG4gKiBzZWN0aW9uIDExLjQpIGNvbnN1bWVzIGl0LiBBIGdlbmVyYXRlZCBlbnRyeSBjYXJyaWVzIG5vIG5hbWU6IENsb3VkRm9ybWF0aW9uXG4gKiBvd25zIHRoZSBuYW1lLCBzbyB0aGVyZSBpcyBub3RoaW5nIHRvIHJlc2VydmUuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dCB7XG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWwgbmFtZS4gQWJzZW50IGZvciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJhY3QgcmVzb3VyY2UgdHlwZSwgZm9yIGV4YW1wbGUgYGxhbWJkYV9mdW5jdGlvbmAuXG4gICAqL1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbmFtZSwgb3Ig4oCUIHdoZW5cbiAgICogdGhlIGNhbGxlcidzIG5hbWluZyBjb250ZXh0IHNwYW5zIHNldmVyYWwgc3RhY2tzIOKAlCB0aGUgb3duaW5nIHN0YWNrJ3NcbiAgICogY29uc3RydWN0IHBhdGggcGx1cyB0aGF0IGxvZ2ljYWwgaWQsIGJlY2F1c2UgYSBsb2dpY2FsIGlkIGlzIHVuaXF1ZSBvbmx5XG4gICAqIHdpdGhpbiBvbmUgdGVtcGxhdGUuXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsSWQ6IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUsIHNvIG5vdGhpbmcgaXMgcmVzZXJ2ZWQuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9uZSByb3cgb2YgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdDogdGhlIGNvbXBsZXRlIHNldCB0aGUgbmFtZSByZXNlcnZhdGlvblxuICogaW5kZXggKGNvbnRyYWN0IHNlY3Rpb24gMTEuMikgcmVzZXJ2ZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RGVyaXZlZE5hbWUge1xuICAvKipcbiAgICogVGhlIHBoeXNpY2FsIG5hbWUuIEFic2VudCBmb3IgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IHJlc291cmNlIHR5cGUuXG4gICAqL1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBzY29wZSBpbiB3aGljaCBBV1MgcmVxdWlyZXMgdGhlIG5hbWUgdG8gYmUgdW5pcXVlOiBgYWNjb3VudGAsXG4gICAqIGBhY2NvdW50X3JlZ2lvbmAsIG9yIGBub3RfdW5pcXVlYC5cbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxJZDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSwgc28gbm90aGluZyBpcyByZXNlcnZlZC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogVGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBhIG5hbWluZyBjb250ZXh0IGVtaXRzIGF0IHN5bnRoZXNpcyAoY29udHJhY3RcbiAqIHNlY3Rpb24gMTEuNCksIGtleWVkIGB7c3RhY2t9Lm1ldGFkYXRhLmpzb25gIGluIHRoZSBjbG91ZCBhc3NlbWJseS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlEZXJpdmVkTmFtZXMge1xuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IGlkZW50aWZpZXIuXG4gICAqL1xuICByZWFkb25seSBjb250cmFjdDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYXJ0aWZhY3Qgc2NoZW1hIGlkZW50aWZpZXIuXG4gICAqL1xuICByZWFkb25seSBzY2hlbWE6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5hbWluZyBjb250ZXh0IHRoYXQgcHJvZHVjZWQgdGhlIGFydGlmYWN0LlxuICAgKi9cbiAgcmVhZG9ubHkgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcztcblxuICAvKipcbiAgICogRXZlcnkgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSB0aGUgY29udGV4dCBkZWNsYXJlcywgc29ydGVkIGJ5IGBzY29wZWAsXG4gICAqIGB0eXBlYCwgYG5hbWVgIGFuZCBgbG9naWNhbElkYC5cbiAgICovXG4gIHJlYWRvbmx5IGVudHJpZXM6IEFwcFRoZW9yeURlcml2ZWROYW1lW107XG59XG5cbi8qKlxuICogVGhlIG5hbWluZyBzY29wZXMgb2YgY29udHJhY3Qgc2VjdGlvbiAxMS4xLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlOYW1pbmdTY29wZSB7XG4gIC8qKlxuICAgKiBBV1Mga2VlcHMgdGhlIG5hbWUgdW5pcXVlIGFjcm9zcyB0aGUgd2hvbGUgYWNjb3VudCwgd2hhdGV2ZXIgdGhlIFJlZ2lvbi5cbiAgICovXG4gIEFDQ09VTlQgPSBcImFjY291bnRcIixcbiAgLyoqXG4gICAqIEFXUyBrZWVwcyB0aGUgbmFtZSB1bmlxdWUgcGVyIGFjY291bnQgYW5kIFJlZ2lvbi5cbiAgICovXG4gIEFDQ09VTlRfUkVHSU9OID0gXCJhY2NvdW50X3JlZ2lvblwiLFxuICAvKipcbiAgICogQVdTIGRvZXMgbm90IGtlZXAgdGhlIG5hbWUgdW5pcXVlLCBzbyBub3RoaW5nIGlzIHJlc2VydmVkIGZvciBpdC5cbiAgICovXG4gIE5PVF9VTklRVUUgPSBcIm5vdF91bmlxdWVcIixcbn1cblxuLyoqXG4gKiBJbmNsdWRlIGFuZCBleGNsdWRlIHZpc2liaWxpdHkgc2VsZWN0b3JzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyB7XG4gIC8qKlxuICAgKiBTZWxlY3RvcnMgd2hvc2Ugc291cmNlcyBhcmUgc2hhcmVkLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgaW5jbHVkZT86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBTZWxlY3RvcnMgd2hvc2Ugc291cmNlcyBhcmUgbmV2ZXIgc2hhcmVkLiBFeGNsdXNpb25zIHdpbi5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGV4Y2x1ZGU/OiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBUaGUgc3ludGgtdGltZSB2aXNpYmlsaXR5IHByZXZpZXcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eVByZXZpZXcge1xuICAvKipcbiAgICogRmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgdGhlIGNhbm9uaWNhbCBydWxlcyBoYXNoLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIGRvIG5vdCBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG5vdE1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgc2VsZWN0b3JzLCBhcyB0aGUgc3RhdGVtZW50IG9mIHdoYXQgZnV0dXJlIHNvdXJjZXMgd2lsbCBtYXRjaC5cbiAgICovXG4gIHJlYWRvbmx5IGZ1dHVyZTogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xufVxuXG4vKipcbiAqIFRoZSBwdWJsaXNoZWQgU1NNIG1hbmlmZXN0OiB0aGUgcHJldmlldyBtaW51cyBgbm90TWF0Y2hlZE5vd2AuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0IHtcbiAgLyoqXG4gICAqIEZpcnN0IDEyIGhleCBjaGFyYWN0ZXJzIG9mIHRoZSBjYW5vbmljYWwgcnVsZXMgaGFzaC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bGVWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgc2hhcmUuXG4gICAqL1xuICByZWFkb25seSBtYXRjaGVkTm93OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIHNlbGVjdG9ycywgYXMgdGhlIHN0YXRlbWVudCBvZiB3aGF0IGZ1dHVyZSBzb3VyY2VzIHdpbGwgbWF0Y2guXG4gICAqL1xuICByZWFkb25seSBmdXR1cmU6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcztcbn1cblxuY29uc3QgU0VHTUVOVF9QQVRURVJOID0gTE9HSUNBTF9TRUdNRU5UX1BBVFRFUk47XG5jb25zdCBMT0dJQ0FMX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSg/Oi8ke1NFR01FTlRfUEFUVEVSTn0pKiRgKTtcbmNvbnN0IEFQUF9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0kYCk7XG5jb25zdCBTVEFHRV9SRSA9IC9eW2Etel1bYS16MC05XXswLDd9JC87XG5jb25zdCBOQU1FU1BBQ0VfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59JGApO1xuY29uc3QgQUNDT1VOVF9SRSA9IC9eWzAtOV17MTJ9JC87XG5jb25zdCBSRUdJT05fUkUgPSAvXlthLXpdezJ9KD86LVthLXpdKykrLVswLTldJC87XG5jb25zdCBTRUNSRVRfVEFJTF9SRSA9IC8tW0EtWmEtejAtOV17Nn0kLztcbmNvbnN0IFMzX0VER0VTX1JFID0gL15bYS16MC05XS4qW2EtejAtOV0kLztcbmNvbnN0IExPR19QUkVGSVggPSBcInRoZW9yeWNsb3VkXCI7XG5jb25zdCBST0xFX1BPTElDWV9NQVggPSAxMDI0MDtcbi8qKiBUaGUgbG9uZ2VzdCBob3N0ZWQgbmFtZXNwYWNlIGxhYmVsLCBpbiBjaGFyYWN0ZXJzIChjb250cmFjdCBzZWN0aW9uIDEsIHI1IHJldjEpLiAqL1xuY29uc3QgSE9TVEVEX05BTUVTUEFDRV9NQVggPSAxMjtcbmNvbnN0IEJBU0UzMiA9IFwiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoyMzQ1NjdcIjtcblxuaW50ZXJmYWNlIFJ1bGUge1xuICByZWFkb25seSBraW5kOiBcImRhc2hcIiB8IFwicGF0aFwiIHwgXCJzM2FyXCIgfCBcImxvZ1wiO1xuICByZWFkb25seSBtYXg6IG51bWJlcjtcbiAgLyoqXG4gICAqIFRoZSBsb3dlciBib3VuZCBjb250cmFjdCBzZWN0aW9uIDIgc3RhdGVzIGZvciB0aGUgdHlwZSwgd2hlbiBpdCBzdGF0ZXMgb25lLlxuICAgKiBBIHJvdyB0aGF0IHN0YXRlcyBvbmx5IGFuIHVwcGVyIGxpbWl0IGhhcyBub25lIGhlcmUsIHNvIHRoZSB0YWJsZSBzdGF5cyB0aGVcbiAgICogc2VjdGlvbiAyIHRhYmxlIGFuZCBub3QgYSBzdHJpY3RlciBwcml2YXRlIG9uZS5cbiAgICovXG4gIHJlYWRvbmx5IG1pbj86IG51bWJlcjtcbiAgcmVhZG9ubHkgY2hhcnNldDogc3RyaW5nO1xuICByZWFkb25seSBsZWFkPzogc3RyaW5nO1xufVxuXG5jb25zdCBSVUxFUzogeyBbdHlwZTogc3RyaW5nXTogUnVsZSB9ID0ge1xuICBzM19idWNrZXQ6IHsga2luZDogXCJzM2FyXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgczNfdmVjdG9yX2J1Y2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MywgY2hhcnNldDogXCJbYS16MC05LV1cIiB9LFxuICBzM192ZWN0b3JfaW5kZXg6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgLy8gU2VjdGlvbiAyOiBcIjI1NSAocGxhaW4tbmFtZSBsaW1pdCAz4oCTMjU1OyB0aGUgMTAyNCBsaW1pdCBhcHBsaWVzIHRvIHRoZSBBUk5cbiAgLy8gZm9ybSlcIi4gVGhlIGxvd2VyIGJvdW5kIGlzIHBhcnQgb2YgdGhlIHJvdywgc28gYSBmaXhlZCBuYW1lIG9mIG9uZSBvciB0d29cbiAgLy8gY2hhcmFjdGVycyBpcyByZWZ1c2VkIChTQU5JVFktQVQtTjMtMDgpLlxuICBkeW5hbW9kYl90YWJsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIG1pbjogMywgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGxhbWJkYV9mdW5jdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc3FzX3F1ZXVlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDgwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzbnNfdG9waWM6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzZWNyZXQ6IHsga2luZDogXCJwYXRoXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTkvXys9LkAtXVwiIH0sXG4gIHNzbV9wYXJhbWV0ZXI6IHsga2luZDogXCJwYXRoXCIsIG1heDogOTAwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLi8tXVwiLCBsZWFkOiBcIi9cIiB9LFxuICBrbXNfYWxpYXM6IHsga2luZDogXCJwYXRoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTkvXy1dXCIsIGxlYWQ6IFwiYWxpYXMvXCIgfSxcbiAgZXZlbnRfYnVzOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGV2ZW50X3J1bGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBzY2hlZHVsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGFsYXJtOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGRhc2hib2FyZDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGlhbV9yb2xlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkrPSwuQF8tXVwiIH0sXG4gIGlhbV9tYW5hZ2VkX3BvbGljeTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOSs9LC5AXy1dXCIgfSxcbiAgc3RhdGVfbWFjaGluZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA4MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgY29kZWJ1aWxkX3Byb2plY3Q6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTUwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfcmVzdDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV9odHRwOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgYXBpX3dlYnNvY2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9zb3VyY2U6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9kZXN0aW5hdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2dyb3VwOiB7IGtpbmQ6IFwibG9nXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxufTtcblxuLyoqXG4gKiBUaGUgcnVsZXMgb2Ygb25lIGNvbnRyYWN0IHR5cGUsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlIGNvbnRyYWN0IHN0YXRlcyBub25lXG4gKiAoY29udHJhY3Qgc2VjdGlvbiAyKS4gVGhlIGxvb2t1cCBpcyBhbiBvd24tcHJvcGVydHkgY2hlY2ssIHNvIGFuIGluaGVyaXRlZFxuICogbmFtZSBzdWNoIGFzIGBjb25zdHJ1Y3RvcmAsIGB0b1N0cmluZ2AsIGBfX3Byb3RvX19gIG9yIGBoYXNPd25Qcm9wZXJ0eWAgaXMgYW5cbiAqIHVua25vd24gdHlwZSwgbmV2ZXIgYSB0eXBlIHdpdGggcnVsZXMuXG4gKi9cbmZ1bmN0aW9uIG5hbWluZ1J1bGUocmVzb3VyY2VUeXBlOiBzdHJpbmcpOiBSdWxlIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFPYmplY3QuaGFzT3duKFJVTEVTLCByZXNvdXJjZVR5cGUpKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gUlVMRVNbcmVzb3VyY2VUeXBlXTtcbn1cblxuLyoqXG4gKiBBUEkgbmFtZSB0eXBlcy4gVGhlIENESyBkZWZhdWx0cyBhbiBBUEkgTmFtZSB0b2RheSwgc28gYSBuYW1lIGZvciBvbmUgaXNcbiAqIGV4cGxpY2l0IGFuZCB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnkgKHIzLCBBRFYtMTMxMi0zKS5cbiAqL1xuY29uc3QgQVBJX1RZUEVTID0gbmV3IFNldChbXCJhcGlfcmVzdFwiLCBcImFwaV9odHRwXCIsIFwiYXBpX3dlYnNvY2tldFwiXSk7XG5cbi8qKlxuICogVHlwZXMgd2hvc2Ugc2VjdGlvbiAyIHJvdyBhZGRzIHRoZSBTMyBzdGFydC9lbmQtYWxwaGFudW1lcmljIHJ1bGUuXG4gKi9cbmNvbnN0IFMzX1RZUEVTID0gbmV3IFNldChbXCJzM19idWNrZXRcIiwgXCJzM192ZWN0b3JfYnVja2V0XCIsIFwiczNfdmVjdG9yX2luZGV4XCJdKTtcblxuLyoqXG4gKiBUeXBlcyB3aG9zZSBmaXhlZC1uYW1lIGNoYXJzZXQgZGlmZmVycyBmcm9tIHRoZSBkZXJpdmVkLW5hbWUgY2hhcnNldCBvZiB0aGVpclxuICogc2VjdGlvbiAyIHJvdy4gQSBsb2cgZ3JvdXAgaXMgdGhlIG9ubHkgb25lOiBvbmUgb2YgaXRzIHR3byBmaXhlZCBzaGFwZXMgaXMgdGhlXG4gKiBMYW1iZGEgc2VydmljZSBwYXRoIGAvYXdzL2xhbWJkYS97ZnVuY3Rpb24gbmFtZX1gIChzZWN0aW9uIDMpLCBzbyBgL2AgaXMgcGFydFxuICogb2YgdGhlIGNoYXJzZXQgZXZlbiB0aG91Z2ggbm8gZGVyaXZlZCBsb2ctZ3JvdXAgbmFtZSBjb250YWlucyBvbmUuIFRoZSBzaGFwZVxuICogcnVsZSBiZWxvdyBpcyB3aGF0IG5hcnJvd3MgaXQgYWdhaW46IGV2ZXJ5IG90aGVyIGAvYC1iZWFyaW5nIGxvZyBncm91cCBpc1xuICogcmVmdXNlZC5cbiAqL1xuY29uc3QgRklYRURfTkFNRV9DSEFSU0VUUyA9IG5ldyBNYXAoW1tcImxvZ19ncm91cFwiLCBcIltBLVphLXowLTlfLy1dXCJdXSk7XG5cbi8qKlxuICogVGhlIEtNUyBhbGlhcyBwYXRoIGxlYWQgKGNvbnRyYWN0IHNlY3Rpb24gMikuXG4gKi9cbmNvbnN0IEtNU19BTElBU19MRUFEID0gXCJhbGlhcy9cIjtcblxuLyoqXG4gKiBBbiBhYnNvbHV0ZSBTU00gcGFyYW1ldGVyIHBhdGg6IGEgbGVhZCBgL2AsIHRoZW4gYXQgbGVhc3Qgb25lIG5vbi1lbXB0eVxuICogc2VnbWVudCwgd2l0aCBubyBlbXB0eSBzZWdtZW50IGFueXdoZXJlIChjb250cmFjdCBzZWN0aW9uIDIpLlxuICovXG5jb25zdCBTU01fUEFUSF9SRSA9IC9eXFwvW14vXSsoPzpcXC9bXi9dKykqJC87XG5cbi8qKlxuICogV2hldGhlciBhIGZpeGVkIGxvZy1ncm91cCBuYW1lIGlzIG9uZSBvZiB0aGUgdHdvIHNoYXBlcyBjb250cmFjdCBzZWN0aW9uIDNcbiAqIHN0YXRlcywgYW5kIG5vdGhpbmcgZWxzZTpcbiAqXG4gKiAtIGEgbG9nLXNvdXJjZSBuYW1lLCBgdGhlb3J5Y2xvdWRfe25hbWVzcGFjZX1fe2FwcH1fe3N0YWdlfV97bG9naWNhbH1gLiBJdHNcbiAqICAgc2VnbWVudHMgYXJlIGpvaW5lZCB3aXRoIGBfYCBwcmVjaXNlbHkgc28gdGhlIG9uZSBncmFtbWFyIGFsc28gc2F0aXNmaWVzXG4gKiAgIENsb3VkRnJvbnQncyBgW1xcdy1dYCBkZXN0aW5hdGlvbiwgc28gc3VjaCBhIG5hbWUgY2FycmllcyBubyBgL2AgYXQgYWxsO1xuICogLSB0aGUgTGFtYmRhIHNlcnZpY2UgcGF0aCBgL2F3cy9sYW1iZGEve2Z1bmN0aW9uIG5hbWV9YCwgd2hvc2UgZnVuY3Rpb24gbmFtZVxuICogICBzYXRpc2ZpZXMgdGhlIGBsYW1iZGFfZnVuY3Rpb25gIHJvdyBvZiBzZWN0aW9uIDIgKGxlbmd0aCBhbmQgY2hhcnNldCkuXG4gKlxuICogQW55IG90aGVyIGAvYC1iZWFyaW5nIG5hbWUgaXMgcmVmdXNlZDogYGFyYml0cmFyeS9wYXRoYCBpcyBuZWl0aGVyIHNoYXBlXG4gKiAoU0FOSVRZLUFULU4zLTA4KS5cbiAqXG4gKiBUaGUgbG9nLXNvdXJjZSBicmFuY2ggaGVyZSBpcyBhIHNoYXBlIHRlc3Qgb25seSwgbm90IGFuIGlkZW50aXR5IHRlc3Q6IGl0XG4gKiBjYW5ub3QgdGVsbCB3aG9zZSBjb250ZXh0IGEgbmFtZSBiZWxvbmdzIHRvLiBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dGBcbiAqIG5hcnJvd3MgaXQgdG8gdGhlIGNvbnRleHQncyBvd24gYHRoZW9yeWNsb3VkX3tuYW1lc3BhY2V9X3thcHB9X3tzdGFnZX1fYFxuICogcHJlZml4IGFuZCByZW1haW5kZXIgZ3JhbW1hciB3aGVuIGl0IGRlY2xhcmVzIGEgZml4ZWQgbmFtZS5cbiAqL1xuZnVuY3Rpb24gaXNGaXhlZExvZ0dyb3VwU2hhcGUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghbmFtZS5pbmNsdWRlcyhcIi9cIikpIHJldHVybiB0cnVlO1xuICBpZiAoIW5hbWUuc3RhcnRzV2l0aChMQU1CREFfTE9HX0dST1VQX0xFQUQpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGZ1bmN0aW9uTmFtZSA9IG5hbWUuc2xpY2UoTEFNQkRBX0xPR19HUk9VUF9MRUFELmxlbmd0aCk7XG4gIGNvbnN0IGxhbWJkYSA9IFJVTEVTLmxhbWJkYV9mdW5jdGlvbjtcbiAgaWYgKGZ1bmN0aW9uTmFtZS5sZW5ndGggPiBsYW1iZGEubWF4KSByZXR1cm4gZmFsc2U7XG4gIGlmIChsYW1iZGEubWluICE9PSB1bmRlZmluZWQgJiYgZnVuY3Rpb25OYW1lLmxlbmd0aCA8IGxhbWJkYS5taW4pIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIG5ldyBSZWdFeHAoYF4oPzoke2xhbWJkYS5jaGFyc2V0fSkrJGApLnRlc3QoZnVuY3Rpb25OYW1lKTtcbn1cblxuLyoqXG4gKiBUeXBlcyBBV1Mga2VlcHMgdW5pcXVlIGFjcm9zcyBSZWdpb25zIChjb250cmFjdCBzZWN0aW9uIDExLjEpLlxuICovXG5jb25zdCBBQ0NPVU5UX0dMT0JBTF9UWVBFUyA9IG5ldyBTZXQoW1wiaWFtX3JvbGVcIiwgXCJpYW1fbWFuYWdlZF9wb2xpY3lcIiwgXCJkYXNoYm9hcmRcIl0pO1xuXG4vKipcbiAqIEFQSSBkaXNwbGF5IG5hbWVzIEFXUyBkb2VzIG5vdCBrZWVwIHVuaXF1ZSwgc28gbm90aGluZyBpcyByZXNlcnZlZCBmb3IgdGhlbS5cbiAqL1xuY29uc3QgTk9UX1VOSVFVRV9UWVBFUyA9IG5ldyBTZXQoW1wiYXBpX3Jlc3RcIiwgXCJhcGlfaHR0cFwiLCBcImFwaV93ZWJzb2NrZXRcIl0pO1xuXG4vKipcbiAqIFRoZSByZWZ1c2FsIGZvciBhIHR5cGUgdGhlIGNvbnRyYWN0IHN0YXRlcyBubyBuYW1pbmcgc2NvcGUgZm9yOiBpdCBjYW5ub3QgYmVcbiAqIHJlc2VydmVkLCBzbyBpdCBjYW5ub3QgYmUgZGVwbG95ZWQgdGhyb3VnaCB0aGUgaW5kZXggdW50aWwgYSByZXZpc2lvbiBzdGF0ZXNcbiAqIGl0cyBzY29wZS5cbiAqL1xuY29uc3QgVU5LTk9XTl9OQU1JTkdfU0NPUEUgPSBcImEgdHlwZSB3aXRoIG5vIHN0YXRlZCBuYW1pbmcgc2NvcGUgY2Fubm90IGJlIHJlc2VydmVkXCI7XG5cbmNvbnN0IEtFRVBFUl9BQ1RJT05TX0dST1VQID0gW1wibG9nczpGaWx0ZXJMb2dFdmVudHNcIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiXTtcbmNvbnN0IEtFRVBFUl9BQ1RJT05TX1NUUkVBTSA9IFtcImxvZ3M6R2V0TG9nRXZlbnRzXCJdO1xuXG5mdW5jdGlvbiBmYWlsKG1lc3NhZ2U6IHN0cmluZyk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xufVxuXG4vKipcbiAqIFRoZSByZWZ1c2FsIGNvbnRyYWN0IHNlY3Rpb25zIDEgYW5kIDQgc3RhdGUgZm9yIHRoZSB0d28gbGl2ZS1jb21wYXRpYmlsaXR5XG4gKiBuYW1pbmcgdG9vbHMgb24gYSBuYW1lc3BhY2VkIGNvbnRleHQ6IGEgZGVwbG95bWVudCB3aG9zZSBuYW1lcyBjYXJyeSB0aGVcbiAqIHRlbmFudCBuYW1lc3BhY2UgdGFrZXMgbmVpdGhlciB0aGUgbGVnYWN5IHByb2ZpbGUgbm9yIGEgZ2VuZXJhdGVkIGVudHJ5LFxuICogYmVjYXVzZSBlaXRoZXIgd291bGQgcHJvZHVjZSBhIG5hbWUgd2l0aCBubyBuYW1lc3BhY2UgYW5kIGNvbGxpZGUgYWNyb3NzXG4gKiB0ZW5hbnRzIGluIGEgcG9vbGVkIGFjY291bnQuXG4gKi9cbmNvbnN0IEhPU1RFRF9QUk9GSUxFX0ZBSUxVUkUgPVxuICBcImEgaG9zdGVkIGRlcGxveW1lbnQgdGFrZXMgbm8gbGVnYWN5IHByb2ZpbGUgb3IgZ2VuZXJhdGVkIGVudHJpZXNcIjtcblxuZnVuY3Rpb24gc2hhMjU2SGV4KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZSh0ZXh0LCBcInV0ZjhcIikuZGlnZXN0KFwiaGV4XCIpO1xufVxuXG5mdW5jdGlvbiBiYXNlMzJMb3dlcih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBieXRlcyA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHRleHQsIFwidXRmOFwiKS5kaWdlc3QoKTtcbiAgbGV0IGJpdHMgPSAwO1xuICBsZXQgdmFsdWUgPSAwO1xuICBsZXQgb3V0ID0gXCJcIjtcbiAgZm9yIChjb25zdCBieXRlIG9mIGJ5dGVzKSB7XG4gICAgdmFsdWUgPSAodmFsdWUgPDwgOCkgfCBieXRlO1xuICAgIGJpdHMgKz0gODtcbiAgICB3aGlsZSAoYml0cyA+PSA1KSB7XG4gICAgICBvdXQgKz0gQkFTRTMyWyh2YWx1ZSA+Pj4gKGJpdHMgLSA1KSkgJiAzMV07XG4gICAgICBiaXRzIC09IDU7XG4gICAgfVxuICB9XG4gIGlmIChiaXRzID4gMCkgb3V0ICs9IEJBU0UzMlsodmFsdWUgPDwgKDUgLSBiaXRzKSkgJiAzMV07XG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIHNob3J0ZW4oZnVsbDogc3RyaW5nLCBsaW1pdDogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKGZ1bGwubGVuZ3RoIDw9IGxpbWl0KSByZXR1cm4gZnVsbDtcbiAgY29uc3QgaGVhZCA9IGZ1bGwuc2xpY2UoMCwgbGltaXQgLSA5KS5yZXBsYWNlKC9bLV8uL10rJC8sIFwiXCIpO1xuICByZXR1cm4gYCR7aGVhZH0tJHtiYXNlMzJMb3dlcihmdWxsKS5zbGljZSgwLCA4KX1gO1xufVxuXG5mdW5jdGlvbiBuYW1lc3BhY2VPZih2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWVzLm5hbWVzcGFjZSA/PyBMT0dfUFJFRklYO1xufVxuXG4vKipcbiAqIEFwcGx5IHRoZSBob3N0ZWQgbmFtZXNwYWNlIGxhYmVsIHJ1bGUgKGNvbnRyYWN0IHNlY3Rpb24gMSwgcjUgcmV2MSk6IGFcbiAqIG5hbWVzcGFjZSBvdGhlciB0aGFuIHRoZSByZXNlcnZlZCBwbGF0Zm9ybSBvbmUgaXMgYXQgbW9zdFxuICogYEhPU1RFRF9OQU1FU1BBQ0VfTUFYYCBjaGFyYWN0ZXJzIGFuZCBuZXZlciBzdGFydHMgd2l0aCBgYXdzYCBvciBgc3NtYC4gVGhvc2VcbiAqIHR3byBwcmVmaXhlcyBhcmUgcmVzZXJ2ZWQgYnkgQVdTLCBzbyBhIG5hbWUgY2FycnlpbmcgdGhlbSBjYW5ub3QgYmUgY3JlYXRlZC5cbiAqL1xuZnVuY3Rpb24gdmFsaWRhdGVIb3N0ZWROYW1lc3BhY2UobmFtZXNwYWNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKG5hbWVzcGFjZSA9PT0gTE9HX1BSRUZJWCkgcmV0dXJuO1xuICBpZiAobmFtZXNwYWNlLmxlbmd0aCA+IEhPU1RFRF9OQU1FU1BBQ0VfTUFYKSB7XG4gICAgZmFpbChcImhvc3RlZCBuYW1lc3BhY2UgbG9uZ2VyIHRoYW4gMTIgY2hhcmFjdGVyc1wiKTtcbiAgfVxuICBpZiAobmFtZXNwYWNlLnN0YXJ0c1dpdGgoXCJhd3NcIikgfHwgbmFtZXNwYWNlLnN0YXJ0c1dpdGgoXCJzc21cIikpIHtcbiAgICBmYWlsKFwiaG9zdGVkIG5hbWVzcGFjZSBtdXN0IG5vdCBzdGFydCB3aXRoIGF3cyBvciBzc21cIik7XG4gIH1cbn1cblxuLyoqXG4gKiBXaGV0aGVyIGV2ZXJ5IGRlcml2ZWQgbmFtZSBjYXJyaWVzIHRoZSBuYW1lc3BhY2UgKGNvbnRyYWN0IHNlY3Rpb24gMiwgcjUpOlxuICogdHJ1ZSBmb3IgYSBob3N0ZWQgZGVwbG95bWVudCBhbmQgZm9yIGFueSBuYW1lc3BhY2Ugb3RoZXIgdGhhbiB0aGUgcmVzZXJ2ZWRcbiAqIHBsYXRmb3JtIG9uZS4gVGhlIHBsYXRmb3JtIG5hbWVzcGFjZSBrZWVwcyB0aGUgY29tcGF0aWJpbGl0eSBmb3JtIGJ5dGUgZm9yXG4gKiBieXRlLCBzbyB0aGUgbGl2ZSBoYXJkIGdhdGUgKGNvbnRyYWN0IHNlY3Rpb24gNCkgaXMgdW5jaGFuZ2VkLlxuICovXG5mdW5jdGlvbiBuYW1lc3BhY2VkKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IGJvb2xlYW4ge1xuICByZXR1cm4gdmFsdWVzLmhvc3RlZCA9PT0gdHJ1ZSB8fCBuYW1lc3BhY2VPZih2YWx1ZXMpICE9PSBMT0dfUFJFRklYO1xufVxuXG4vKipcbiAqIFRoZSBge25hbWVzcGFjZX0te2FwcH0te3N0YWdlfS17bG9naWNhbH1gIHN0ZW0gb2YgYSBgZGFzaGAgbmFtZSBvciBhbiBTM1xuICogYWNjb3VudC1yZWdpb25hbCBwcmVmaXgsIHdpdGggYC9gIGluIHRoZSBsb2dpY2FsIG5hbWUgcmVwbGFjZWQgYnkgYC1gLlxuICovXG5mdW5jdGlvbiBkYXNoU3RlbSh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsIGxvZ2ljYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzID0gW3ZhbHVlcy5hcHAsIHZhbHVlcy5zdGFnZSwgbG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCItXCIpXTtcbiAgaWYgKG5hbWVzcGFjZWQodmFsdWVzKSkgcGFydHMudW5zaGlmdChuYW1lc3BhY2VPZih2YWx1ZXMpKTtcbiAgcmV0dXJuIHBhcnRzLmpvaW4oXCItXCIpO1xufVxuXG4vKipcbiAqIFRoZSBge25hbWVzcGFjZX0ve2FwcH0ve3N0YWdlfS97bG9naWNhbH1gIHN0ZW0gb2YgYSBgcGF0aGAgbmFtZS5cbiAqL1xuZnVuY3Rpb24gcGF0aFN0ZW0odmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLCBsb2dpY2FsOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0cyA9IFt2YWx1ZXMuYXBwLCB2YWx1ZXMuc3RhZ2UsIGxvZ2ljYWxdO1xuICBpZiAobmFtZXNwYWNlZCh2YWx1ZXMpKSBwYXJ0cy51bnNoaWZ0KG5hbWVzcGFjZU9mKHZhbHVlcykpO1xuICByZXR1cm4gcGFydHMuam9pbihcIi9cIik7XG59XG5cbi8qKlxuICogVGhlIGxlYWRpbmcgbmFtZXNwYWNlIGNvbXBvbmVudCBhIGhvc3RlZCBwaW4gbXVzdCBjYXJyeSwgZXhhY3RseSB3aGVyZSB0aGVcbiAqIGRlcml2ZWQgZm9ybSBwdXRzIGl0IChjb250cmFjdCBzZWN0aW9uIDQsIHI1IHJldjEsIHJldjIpLiBDb250YWluaW5nIHRoZVxuICogbmFtZXNwYWNlIGVsc2V3aGVyZSBpcyBub3QgZW5vdWdoOiBgc2hvcC1sYWItZXZlbnRzYCBpcyBub3QgYSBwaW4gZm9yXG4gKiBuYW1lc3BhY2UgYGhvcGAuXG4gKi9cbmZ1bmN0aW9uIGhvc3RlZFBpbkxlYWQodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLCBydWxlOiBSdWxlKTogc3RyaW5nIHtcbiAgY29uc3QgbmFtZXNwYWNlID0gbmFtZXNwYWNlT2YodmFsdWVzKTtcbiAgaWYgKHJ1bGUua2luZCA9PT0gXCJwYXRoXCIpIHJldHVybiBgJHtydWxlLmxlYWQgPz8gXCJcIn0ke25hbWVzcGFjZX0vYDtcbiAgaWYgKHJ1bGUua2luZCA9PT0gXCJsb2dcIikgcmV0dXJuIGAke0xPR19QUkVGSVh9XyR7bmFtZXNwYWNlfV9gO1xuICByZXR1cm4gYCR7bmFtZXNwYWNlfS1gO1xufVxuXG5mdW5jdGlvbiBzb3J0ZWRDb3B5KHZhbHVlczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbLi4ubmV3IFNldCh2YWx1ZXMgPz8gW10pXS5zb3J0KCk7XG59XG5cbmZ1bmN0aW9uIGxvZ1ByZWZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gW0xPR19QUkVGSVgsIG5hbWVzcGFjZU9mKHZhbHVlcyksIHZhbHVlcy5hcHAsIHZhbHVlcy5zdGFnZV0uam9pbihcIl9cIikgKyBcIl9cIjtcbn1cblxuLyoqXG4gKiBUaGUgYHRoZW9yeWNsb3VkX3Jlc291cmNlX25hbWluZy52MC4xYCBwcmltaXRpdmVzLCBleHBvc2VkIGZvciBqc2lpIHNvIHRoZSBHb1xuICogYW5kIFB5dGhvbiBDREsgYmluZGluZ3Mgc2hhcmUgb25lIGltcGxlbWVudGF0aW9uLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcge1xuICBwcml2YXRlIGNvbnN0cnVjdG9yKCkge31cblxuICAvKipcbiAgICogVmFsaWRhdGUgdGhlIGJvdW5kIGNvbnRleHQgZ3JhbW1hci4gVGhyb3dzIG9uIGFuIGludmFsaWQgY29udGV4dC5cbiAgICpcbiAgICogVGhlIG5hbWluZyBwcm9maWxlIGFuZCB0aGUgY29udGV4dCdzIG93biBnZW5lcmF0ZWQgZW50cmllcyBhcmUgcHJvcGVydGllcyBvZlxuICAgKiB0aGUgY29udGV4dCwgc28gYSBuYW1lc3BhY2VkIGNvbnRleHQgdGhhdCBjYXJyaWVzIGVpdGhlciBpcyByZWZ1c2VkIGhlcmUg4oCUXG4gICAqIHdoZW4gdGhlIGNvbnRleHQgaXMgdmFsaWRhdGVkLCBhdCBjb25zdHJ1Y3Rpb24g4oCUIGFuZCBub3Qgb25seSBhcyBhIHNpZGVcbiAgICogZWZmZWN0IG9mIGNvbXBvc2luZyBhIHBoeXNpY2FsIG5hbWUgKGNvbnRyYWN0IHNlY3Rpb25zIDEgYW5kIDQsIHI1O1xuICAgKiBTQU4tQVQtTjUtMDEpLiBBIGhvc3RlZCBjb250ZXh0IHRoYXQgZGVjbGFyZXMgbm90aGluZyB5ZXQgd291bGQgb3RoZXJ3aXNlXG4gICAqIHN0YW5kIGFzIGEgdmFsaWQgY29udGV4dCB3aG9zZSBldmVyeSBmdXR1cmUgbmFtZSBjb3VsZCBjYXJyeSBubyBuYW1lc3BhY2UuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlQ29udGV4dCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiB2b2lkIHtcbiAgICBpZiAoIUFQUF9SRS50ZXN0KHZhbHVlcy5hcHApKSBmYWlsKFwiYXBwXCIpO1xuICAgIGlmICghU1RBR0VfUkUudGVzdCh2YWx1ZXMuc3RhZ2UpKSBmYWlsKFwic3RhZ2VcIik7XG4gICAgaWYgKCFBQ0NPVU5UX1JFLnRlc3QodmFsdWVzLmFjY291bnQpKSBmYWlsKFwiYWNjb3VudFwiKTtcbiAgICBpZiAoIVJFR0lPTl9SRS50ZXN0KHZhbHVlcy5yZWdpb24pKSBmYWlsKFwicmVnaW9uXCIpO1xuICAgIC8vIHI1IHJldjE6IGEgaG9zdGVkIGRlcGxveW1lbnQgYWx3YXlzIHN1cHBsaWVzIGl0cyBuYW1lc3BhY2U7IGl0IG5ldmVyXG4gICAgLy8gZGVmYXVsdHMgdG8gdGhlIHBsYXRmb3JtIGZvcm0uXG4gICAgaWYgKHZhbHVlcy5ob3N0ZWQgPT09IHRydWUgJiYgIXZhbHVlcy5uYW1lc3BhY2UpIHtcbiAgICAgIGZhaWwoXCJhIGhvc3RlZCBkZXBsb3ltZW50IG11c3Qgc3VwcGx5IGl0cyBuYW1lc3BhY2VcIik7XG4gICAgfVxuICAgIGNvbnN0IG5hbWVzcGFjZSA9IG5hbWVzcGFjZU9mKHZhbHVlcyk7XG4gICAgaWYgKCFOQU1FU1BBQ0VfUkUudGVzdChuYW1lc3BhY2UpKSBmYWlsKFwibmFtZXNwYWNlXCIpO1xuICAgIC8vIHI1IHJldjE6IGB0aGVvcnljbG91ZGAgaXMgcmVzZXJ2ZWQgZm9yIGZpcnN0LXBhcnR5IHBsYXRmb3JtIGFwcHMuIEEgaG9zdGVkXG4gICAgLy8gZGVwbG95bWVudCBtYXkgbmV2ZXIgdXNlIGl0LCBiZWNhdXNlIGl0cyBuYW1lcyB3b3VsZCB0aGVuIGNvbGxpZGUgd2l0aCB0aGVcbiAgICAvLyBwbGF0Zm9ybSBhcHAncyBpbiBhIHBvb2xlZCBhY2NvdW50LlxuICAgIGlmICh2YWx1ZXMuaG9zdGVkID09PSB0cnVlICYmIG5hbWVzcGFjZSA9PT0gTE9HX1BSRUZJWCkge1xuICAgICAgZmFpbChgbmFtZXNwYWNlICR7TE9HX1BSRUZJWH0gaXMgcmVzZXJ2ZWQgZm9yIGZpcnN0LXBhcnR5IHBsYXRmb3JtIGFwcHNgKTtcbiAgICB9XG4gICAgdmFsaWRhdGVIb3N0ZWROYW1lc3BhY2UobmFtZXNwYWNlKTtcbiAgICBpZiAobmFtZXNwYWNlZCh2YWx1ZXMpKSB7XG4gICAgICBjb25zdCBsZWdhY3kgPSAodmFsdWVzLm5hbWluZ1Byb2ZpbGUgPz8gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5ERVJJVkVEKSA9PT0gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5MRUdBQ1k7XG4gICAgICBpZiAobGVnYWN5IHx8ICh2YWx1ZXMuZ2VuZXJhdGVkID8/IFtdKS5sZW5ndGggPiAwKSB7XG4gICAgICAgIGZhaWwoSE9TVEVEX1BST0ZJTEVfRkFJTFVSRSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEFwcGx5IHRoZSBob3N0ZWQgbmFtZXNwYWNlIGxhYmVsIHJ1bGUgdG8gb25lIG5hbWVzcGFjZSAoY29udHJhY3Qgc2VjdGlvbiAxLFxuICAgKiByNSByZXYxKTogYSBuYW1lc3BhY2Ugb3RoZXIgdGhhbiB0aGUgcmVzZXJ2ZWQgcGxhdGZvcm0gb25lIGlzIGF0IG1vc3QgMTJcbiAgICogY2hhcmFjdGVycyBhbmQgbmV2ZXIgc3RhcnRzIHdpdGggYGF3c2Agb3IgYHNzbWAuIFRocm93cyBvbiBhIG5hbWVzcGFjZVxuICAgKiBvdXRzaWRlIGl0LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZUhvc3RlZE5hbWVzcGFjZShuYW1lc3BhY2U6IHN0cmluZyk6IHZvaWQge1xuICAgIHZhbGlkYXRlSG9zdGVkTmFtZXNwYWNlKG5hbWVzcGFjZSk7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBldmVyeSBkZXJpdmVkIG5hbWUgdW5kZXIgdGhlc2UgdmFsdWVzIGNhcnJpZXMgdGhlIG5hbWVzcGFjZVxuICAgKiAoY29udHJhY3Qgc2VjdGlvbiAyLCByNSk6IHRydWUgZm9yIGEgaG9zdGVkIGRlcGxveW1lbnQgYW5kIGZvciBhbnkgbmFtZXNwYWNlXG4gICAqIG90aGVyIHRoYW4gdGhlIHJlc2VydmVkIHBsYXRmb3JtIG9uZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbmFtZXNwYWNlZCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBib29sZWFuIHtcbiAgICByZXR1cm4gbmFtZXNwYWNlZCh2YWx1ZXMpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbi1hcHBlbmRlZCBhY2NvdW50LXJlZ2lvbmFsIGJ1Y2tldCBzdWZmaXguXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHMzQWNjb3VudFJlZ2lvbmFsU3VmZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAtJHt2YWx1ZXMuYWNjb3VudH0tJHt2YWx1ZXMucmVnaW9ufS1hbmA7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGJvdW5kIHByZWZpeCBzaGFyZWQgYnkgZXZlcnkgbG9nIHNvdXJjZSBvZiB0aGUgYXBwLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBsb2dTb3VyY2VQcmVmaXgodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogc3RyaW5nIHtcbiAgICByZXR1cm4gbG9nUHJlZml4KHZhbHVlcyk7XG4gIH1cblxuICAvKipcbiAgICogTWFwIGEgbG9naWNhbCBsb2cgc291cmNlIHRvIGl0cyBwaHlzaWNhbCBsb2ctZ3JvdXAgbmFtZS5cbiAgICpcbiAgICogVGhlIGNvbnRleHQgaXMgdmFsaWRhdGVkIGZpcnN0LCBzbyByZXNvbHZpbmcgb25lIGxvZy1zb3VyY2UgbmFtZSBpcyBlbm91Z2hcbiAgICogdG8gcmVmdXNlIGEgY29udGV4dCB0aGF0IGJyZWFrcyBhIHJ1bGU6IGEgZm9yYmlkZGVuIG5hbWluZyBwcm9maWxlIG11c3Qgbm90XG4gICAqIHN1cnZpdmUgb24gdGhlIGxvZy1vbmx5IHBhdGggKGNvbnRyYWN0IHNlY3Rpb25zIDEgYW5kIDQsIHI1OyBTQU4tQVQtTjUtMDEpLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBsb2dHcm91cE5hbWUodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLCBsb2dpY2FsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh2YWx1ZXMpO1xuICAgIGlmICghbG9naWNhbC5zdGFydHNXaXRoKFwibG9ncy9cIikpIGZhaWwoXCJsb2cgbG9naWNhbCBtdXN0IHN0YXJ0IHdpdGggbG9ncy9cIik7XG4gICAgcmV0dXJuIGxvZ1ByZWZpeCh2YWx1ZXMpICsgbG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCJfXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBvc2UgdGhlIHBoeXNpY2FsIG5hbWUgb2Ygb25lIHJlc291cmNlLiBBIHBpbiBhbHdheXMgd2lucy4gQSBnZW5lcmF0ZWRcbiAgICogZW50cnkgbWVhbnMgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lIHRvZGF5IGFuZCB0aGUgY29uc3RydWN0IHNldHNcbiAgICogbm8gcGh5c2ljYWwtbmFtZSBwcm9wZXJ0eS4gR2VuZXJhdGVkIGVudHJpZXMgYXJlIGxlZ2FjeS1vbmx5OyBhIGxlZ2FjeVxuICAgKiBwcm9maWxlIG5lZWRzIGV4YWN0bHkgb25lIG9mIGEgcGluIG9yIGEgZ2VuZXJhdGVkIGVudHJ5LlxuICAgKlxuICAgKiBBIGhvc3RlZCBkZXBsb3ltZW50IChgaG9zdGVkOiB0cnVlYCwgb3IgYW55IG5hbWVzcGFjZSBvdGhlciB0aGFuIHRoZVxuICAgKiBwbGF0Zm9ybSBvbmUpIGNhcnJpZXMgdGhlIG5hbWVzcGFjZSBhcyB0aGUgZmlyc3QgY29tcG9uZW50IG9mIGV2ZXJ5IGRlcml2ZWRcbiAgICogbmFtZSwgaXRzIFMzIGJ1Y2tldC1uYW1lIHByZWZpeCBpbmNsdWRlZCwgc28gaXQgcmVhY2hlcyB0aGUgc2hvcnRlbmVkXG4gICAqIG92ZXItYnVkZ2V0IGZvcm0gc29vbmVyIChjb250cmFjdCBzZWN0aW9uIDIuNCkuIEl0IHRha2VzIG5vIGdlbmVyYXRlZCBlbnRyeVxuICAgKiBhbmQgbm8gbGVnYWN5IHByb2ZpbGUsIGFuZCBhIHBpbiBtdXN0IHN0YXJ0IHdpdGggaXRzIG5hbWVzcGFjZSBjb21wb25lbnRcbiAgICogKGNvbnRyYWN0IHNlY3Rpb25zIDIgYW5kIDQsIHI1KS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcGh5c2ljYWxOYW1lKFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICByZXNvdXJjZVR5cGU6IHN0cmluZyxcbiAgICBsb2dpY2FsOiBzdHJpbmcsXG4gICk6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZSB7XG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHZhbHVlcyk7XG4gICAgaWYgKCFMT0dJQ0FMX1JFLnRlc3QobG9naWNhbCkpIGZhaWwoXCJsb2dpY2FsXCIpO1xuICAgIGNvbnN0IHJ1bGUgPSBuYW1pbmdSdWxlKHJlc291cmNlVHlwZSk7XG4gICAgaWYgKCFydWxlKSBmYWlsKGByZXNvdXJjZSB0eXBlICR7cmVzb3VyY2VUeXBlfWApO1xuICAgIGNvbnN0IGdlbmVyYXRlZCA9IHZhbHVlcy5nZW5lcmF0ZWQgPz8gW107XG4gICAgY29uc3QgbGVnYWN5ID0gKHZhbHVlcy5uYW1pbmdQcm9maWxlID8/IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRCkgPT09IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuTEVHQUNZO1xuICAgIC8vIHI1IHJldjI6IHRoZSBsZWdhY3kgcHJvZmlsZSBhbmQgZ2VuZXJhdGVkIGVudHJpZXMgYXJlIGZpcnN0LXBhcnR5XG4gICAgLy8gbGl2ZS1jb21wYXRpYmlsaXR5IHRvb2xzIG9ubHkuIEEgaG9zdGVkIGRlcGxveW1lbnQgdGFrZXMgbmVpdGhlciwgYmVjYXVzZSBhXG4gICAgLy8gcGlubmVkIG9yIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZCBuYW1lIGNhcnJpZXMgbm8gbmFtZXNwYWNlIGFuZCB3b3VsZFxuICAgIC8vIGNvbGxpZGUgYWNyb3NzIHRlbmFudHMgaW4gYSBwb29sZWQgYWNjb3VudC5cbiAgICBpZiAobmFtZXNwYWNlZCh2YWx1ZXMpICYmIChsZWdhY3kgfHwgZ2VuZXJhdGVkLmxlbmd0aCA+IDApKSB7XG4gICAgICBmYWlsKEhPU1RFRF9QUk9GSUxFX0ZBSUxVUkUpO1xuICAgIH1cbiAgICBpZiAoZ2VuZXJhdGVkLmxlbmd0aCA+IDAgJiYgIWxlZ2FjeSkge1xuICAgICAgZmFpbChcImdlbmVyYXRlZCBlbnRyaWVzIGFyZSBvbmx5IHZhbGlkIHVuZGVyIHRoZSBsZWdhY3kgbmFtaW5nIHByb2ZpbGVcIik7XG4gICAgfVxuICAgIGNvbnN0IGtleSA9IGAke3Jlc291cmNlVHlwZX06JHtsb2dpY2FsfWA7XG4gICAgY29uc3QgcGluID0gdmFsdWVzLnBpbnM/LltrZXldO1xuICAgIGNvbnN0IGtlZXBHZW5lcmF0ZWQgPSBnZW5lcmF0ZWQuaW5jbHVkZXMoa2V5KTtcbiAgICAvLyByMywgQURWLTEzMTItMzogQ0RLIGRlZmF1bHRzIGFuIEFQSSBOYW1lIHRvZGF5LCBzbyBpdCBpcyBhbiBleHBsaWNpdCBuYW1lXG4gICAgLy8gYW5kIHRha2VzIGEgcGluLCBuZXZlciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICBpZiAoa2VlcEdlbmVyYXRlZCAmJiBBUElfVFlQRVMuaGFzKHJlc291cmNlVHlwZSkpIHtcbiAgICAgIGZhaWwoXCJhbiBBUEkgbmFtZSB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnlcIik7XG4gICAgfVxuICAgIGlmIChwaW4gIT09IHVuZGVmaW5lZCAmJiBrZWVwR2VuZXJhdGVkKSBmYWlsKFwiYSByZXNvdXJjZSBoYXMgYm90aCBhIHBpbiBhbmQgYSBnZW5lcmF0ZWQgZW50cnlcIik7XG4gICAgaWYgKHBpbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyByNSByZXYyOiBhIGhvc3RlZCBwaW4gc3RhcnRzIHdpdGggaXRzIG5hbWVzcGFjZSBjb21wb25lbnQsIGFzIHRoZVxuICAgICAgLy8gZGVyaXZlZCBmb3JtIGRvZXMuIEEgbmFtZXNwYWNlIHRoYXQgbWVyZWx5IGFwcGVhcnMgc29tZXdoZXJlIGluIHRoZSBuYW1lXG4gICAgICAvLyBpcyBub3QgdGhlIG5hbWVzcGFjZSBjb21wb25lbnQuXG4gICAgICBpZiAobmFtZXNwYWNlZCh2YWx1ZXMpICYmICFwaW4uc3RhcnRzV2l0aChob3N0ZWRQaW5MZWFkKHZhbHVlcywgcnVsZSkpKSB7XG4gICAgICAgIGZhaWwoXCJhIGhvc3RlZCBwaW4gbXVzdCBzdGFydCB3aXRoIHRoZSBuYW1lc3BhY2UgY29tcG9uZW50XCIpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHsgbmFtZTogcGluLCBwaW5uZWQ6IHRydWUgfTtcbiAgICB9XG4gICAgaWYgKGtlZXBHZW5lcmF0ZWQpIHJldHVybiB7IGdlbmVyYXRlZDogdHJ1ZSB9O1xuICAgIGlmIChsZWdhY3kpIHtcbiAgICAgIGZhaWwoYGxlZ2FjeSBuYW1pbmcgcHJvZmlsZSByZXF1aXJlcyBhIHBpbiBvciBhIGdlbmVyYXRlZCBlbnRyeSBmb3IgJHtrZXl9YCk7XG4gICAgfVxuXG4gICAgbGV0IG91dDogQXBwVGhlb3J5UGh5c2ljYWxOYW1lO1xuICAgIGlmIChydWxlLmtpbmQgPT09IFwiczNhclwiKSB7XG4gICAgICBjb25zdCBzdWZmaXggPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zM0FjY291bnRSZWdpb25hbFN1ZmZpeCh2YWx1ZXMpO1xuICAgICAgY29uc3QgYnVkZ2V0ID0gcnVsZS5tYXggLSBzdWZmaXgubGVuZ3RoO1xuICAgICAgY29uc3QgcHJlZml4ID0gc2hvcnRlbihkYXNoU3RlbSh2YWx1ZXMsIGxvZ2ljYWwpLCBidWRnZXQpO1xuICAgICAgb3V0ID0geyBuYW1lOiBwcmVmaXggKyBzdWZmaXgsIGJ1Y2tldE5hbWVQcmVmaXg6IHByZWZpeCwgYnVja2V0TmFtZXNwYWNlOiBcImFjY291bnQtcmVnaW9uYWxcIiB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcImRhc2hcIikge1xuICAgICAgb3V0ID0geyBuYW1lOiBzaG9ydGVuKGRhc2hTdGVtKHZhbHVlcywgbG9naWNhbCksIHJ1bGUubWF4KSB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcInBhdGhcIikge1xuICAgICAgY29uc3QgZnVsbCA9IGAke3J1bGUubGVhZCA/PyBcIlwifSR7cGF0aFN0ZW0odmFsdWVzLCBsb2dpY2FsKX1gO1xuICAgICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzZWNyZXRcIiAmJiBTRUNSRVRfVEFJTF9SRS50ZXN0KGZ1bGwpKSB7XG4gICAgICAgIGZhaWwoXCJzZWNyZXQgbmFtZSBtdXN0IG5vdCBlbmQgd2l0aCBhIGh5cGhlbiBhbmQgc2l4IGNoYXJhY3RlcnNcIik7XG4gICAgICB9XG4gICAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcInNzbV9wYXJhbWV0ZXJcIiAmJiAoZnVsbC5tYXRjaCgvXFwvL2cpPy5sZW5ndGggPz8gMCkgPiAxNSkge1xuICAgICAgICBmYWlsKFwic3NtIGhpZXJhcmNoeSBkZWVwZXIgdGhhbiAxNVwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChmdWxsLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwicGF0aCBuYW1lIG92ZXIgbGltaXRcIik7XG4gICAgICBvdXQgPSB7IG5hbWU6IGZ1bGwgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJsb2dcIikge1xuICAgICAgY29uc3QgbmFtZSA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ0dyb3VwTmFtZSh2YWx1ZXMsIGxvZ2ljYWwpO1xuICAgICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJsb2cgZ3JvdXAgb3ZlciBsaW1pdFwiKTtcbiAgICAgIG91dCA9IHsgbmFtZSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBmYWlsKGB1bnN1cHBvcnRlZCBraW5kICR7U3RyaW5nKHJ1bGUua2luZCl9YCk7XG4gICAgfVxuXG4gICAgY29uc3QgbmFtZSA9IG91dC5uYW1lIGFzIHN0cmluZztcbiAgICBpZiAoIW5ldyBSZWdFeHAoYF4oPzoke3J1bGUuY2hhcnNldH0pKyRgKS50ZXN0KG5hbWUpKSBmYWlsKFwiY2hhcnNldFwiKTtcbiAgICBpZiAobmFtZS5sZW5ndGggPiBydWxlLm1heCkgZmFpbChcImxlbmd0aFwiKTtcbiAgICBpZiAocnVsZS5taW4gIT09IHVuZGVmaW5lZCAmJiBuYW1lLmxlbmd0aCA8IHJ1bGUubWluKSBmYWlsKFwibGVuZ3RoXCIpO1xuICAgIGlmIChbXCJzM19idWNrZXRcIiwgXCJzM192ZWN0b3JfYnVja2V0XCIsIFwiczNfdmVjdG9yX2luZGV4XCJdLmluY2x1ZGVzKHJlc291cmNlVHlwZSkgJiYgIVMzX0VER0VTX1JFLnRlc3QobmFtZSkpIHtcbiAgICAgIGZhaWwoXCJzMyBzdGFydC9lbmRcIik7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIHNjb3BlIGluIHdoaWNoIEFXUyByZXF1aXJlcyBhIHR5cGUncyBuYW1lcyB0byBiZSB1bmlxdWUgKGNvbnRyYWN0XG4gICAqIHNlY3Rpb24gMTEuMSkuIEEgdHlwZSB0aGUgY29udHJhY3Qgc3RhdGVzIG5vIHNjb3BlIGZvciBpcyByZWZ1c2VkOiBpdCBjYW5ub3RcbiAgICogYmUgcmVzZXJ2ZWQsIHNvIGl0IGNhbm5vdCBiZSBkZXBsb3llZCB0aHJvdWdoIHRoZSBpbmRleCB1bnRpbCBhIHJldmlzaW9uXG4gICAqIHN0YXRlcyBpdHMgc2NvcGUuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIG5hbWluZ1Njb3BlKHJlc291cmNlVHlwZTogc3RyaW5nKTogQXBwVGhlb3J5TmFtaW5nU2NvcGUge1xuICAgIGlmIChuYW1pbmdSdWxlKHJlc291cmNlVHlwZSkgPT09IHVuZGVmaW5lZCkgZmFpbChVTktOT1dOX05BTUlOR19TQ09QRSk7XG4gICAgaWYgKE5PVF9VTklRVUVfVFlQRVMuaGFzKHJlc291cmNlVHlwZSkpIHJldHVybiBBcHBUaGVvcnlOYW1pbmdTY29wZS5OT1RfVU5JUVVFO1xuICAgIGlmIChBQ0NPVU5UX0dMT0JBTF9UWVBFUy5oYXMocmVzb3VyY2VUeXBlKSkgcmV0dXJuIEFwcFRoZW9yeU5hbWluZ1Njb3BlLkFDQ09VTlQ7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU5hbWluZ1Njb3BlLkFDQ09VTlRfUkVHSU9OO1xuICB9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlIGEgcGh5c2ljYWwgbmFtZSB0aGUgY29udHJhY3QgZml4ZXMgcmF0aGVyIHRoYW4gZGVyaXZlcyBhZ2FpbnN0IHRoZVxuICAgKiBjaGFyYWN0ZXIgYW5kIHNoYXBlIHJ1bGVzIG9mIHRoZSB0eXBlJ3Mgc2VjdGlvbiAyIHJvdzogY2hhcnNldCwgdGhlIGxlbmd0aFxuICAgKiByYW5nZSAoKipib3RoKiogYm91bmRzIHdoZW4gdGhlIHJvdyBzdGF0ZXMgYSBsb3dlciBvbmUsIG5vdCBvbmx5IHRoZSB1cHBlciksXG4gICAqIHRoZSBTMyBzdGFydC9lbmQgcnVsZSwgdGhlIHBhdGggcnVsZXMgKGxlYWQsIG5vbi1lbXB0eSBzZWdtZW50cywgZGVwdGgsXG4gICAqIHJlc2VydmVkIHByZWZpeGVzLCB0aGUgYGFsaWFzL2F3cy9gIG5hbWVzcGFjZSkgYW5kIHRoZSBzZWNyZXQgQVJOLXN1ZmZpeFxuICAgKiBydWxlLiBUaHJvd3Mgb24gYSBuYW1lIG91dHNpZGUgdGhlbS5cbiAgICpcbiAgICogVGhpcyBpcyB0aGUgc2VjdGlvbiAyIHRhYmxlLCBub3QgYSBzZWNvbmQgb25lOiBpdCByZWFkcyB0aGUgc2FtZSBydWxlIHJvd3NcbiAgICogdGhlIGRlcml2YXRpb24gdXNlcy4gQSBgbG9nX2dyb3VwYCBhY2NlcHRzIGAvYCBpbiBhZGRpdGlvbiB0byB0aGUgc2VjdGlvbiAyXG4gICAqIGNoYXJzZXQsIGJ1dCBvbmx5IGZvciB0aGUgdHdvIGZpeGVkIHNoYXBlcyBjb250cmFjdCBzZWN0aW9uIDMgc3RhdGVzOiBhXG4gICAqIGxvZy1zb3VyY2UgbmFtZSAod2hpY2ggY2FycmllcyBubyBgL2AgYXQgYWxsLCBiZWNhdXNlIHNlY3Rpb24gMyBqb2lucyBpdHNcbiAgICogc2VnbWVudHMgd2l0aCBgX2ApIG9yIHRoZSBMYW1iZGEgc2VydmljZSBwYXRoIGAvYXdzL2xhbWJkYS97ZnVuY3Rpb24gbmFtZX1gLFxuICAgKiB3aG9zZSBmdW5jdGlvbiBuYW1lIHNhdGlzZmllcyB0aGUgYGxhbWJkYV9mdW5jdGlvbmAgcm93LiBBbnkgb3RoZXJcbiAgICogYC9gLWJlYXJpbmcgbG9nIGdyb3VwIGlzIHJlZnVzZWQgKFNBTklUWS1BVC1OMy0wOCkuXG4gICAqXG4gICAqIFRoZSBjaGVjayBpcyAqKnN0cnVjdHVyYWwqKjogaXQgaG9sZHMgbm8gY29udGV4dCB2YWx1ZXMsIHNvIGl0IGNhbm5vdCB0ZWxsXG4gICAqIHdoZXRoZXIgYSBsb2ctc291cmNlLXNoYXBlZCBuYW1lIGlzIHRoaXMgbmFtaW5nIGNvbnRleHQncyBvd24gc291cmNlLiBUaGVcbiAgICogY29udGV4dCBjb21wbGV0ZXMgdGhhdCBydWxlIGluIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LmRlY2xhcmVGaXhlZE5hbWVgLFxuICAgKiB3aGljaCBvd25zIHRoZSBib3VuZCBgdGhlb3J5Y2xvdWRfe25hbWVzcGFjZX1fe2FwcH1fe3N0YWdlfV9gIHByZWZpeFxuICAgKiAoU0FOSVRZLUFULU4zLTA4LCByb3VuZCA0KS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVQaHlzaWNhbE5hbWUocmVzb3VyY2VUeXBlOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHJ1bGUgPSBuYW1pbmdSdWxlKHJlc291cmNlVHlwZSk7XG4gICAgaWYgKHJ1bGUgPT09IHVuZGVmaW5lZCkgZmFpbChVTktOT1dOX05BTUlOR19TQ09QRSk7XG4gICAgY29uc3QgY2hhcnNldCA9IEZJWEVEX05BTUVfQ0hBUlNFVFMuZ2V0KHJlc291cmNlVHlwZSkgPz8gcnVsZS5jaGFyc2V0O1xuICAgIGNvbnN0IHF1b3RlZCA9IEpTT04uc3RyaW5naWZ5KG5hbWUpO1xuICAgIGlmIChuYW1lLmxlbmd0aCA9PT0gMCB8fCAhbmV3IFJlZ0V4cChgXig/OiR7Y2hhcnNldH0pKyRgKS50ZXN0KG5hbWUpKSB7XG4gICAgICBmYWlsKGBhIGZpeGVkICR7cmVzb3VyY2VUeXBlfSBuYW1lIG11c3QgbWF0Y2ggJHtjaGFyc2V0fSAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWApO1xuICAgIH1cbiAgICBpZiAobmFtZS5sZW5ndGggPiBydWxlLm1heCkge1xuICAgICAgZmFpbChgYSBmaXhlZCAke3Jlc291cmNlVHlwZX0gbmFtZSBtdXN0IGJlIGF0IG1vc3QgJHtydWxlLm1heH0gY2hhcmFjdGVycywgZ290ICR7bmFtZS5sZW5ndGh9YCk7XG4gICAgfVxuICAgIGlmIChydWxlLm1pbiAhPT0gdW5kZWZpbmVkICYmIG5hbWUubGVuZ3RoIDwgcnVsZS5taW4pIHtcbiAgICAgIGZhaWwoYGEgZml4ZWQgJHtyZXNvdXJjZVR5cGV9IG5hbWUgbXVzdCBiZSBhdCBsZWFzdCAke3J1bGUubWlufSBjaGFyYWN0ZXJzIChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtuYW1lLmxlbmd0aH1gKTtcbiAgICB9XG4gICAgaWYgKHJ1bGUubGVhZCAhPT0gdW5kZWZpbmVkICYmICFuYW1lLnN0YXJ0c1dpdGgocnVsZS5sZWFkKSkge1xuICAgICAgZmFpbChgYSBmaXhlZCAke3Jlc291cmNlVHlwZX0gbmFtZSBtdXN0IHN0YXJ0IHdpdGggJHtKU09OLnN0cmluZ2lmeShydWxlLmxlYWQpfSAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWApO1xuICAgIH1cbiAgICBpZiAoUzNfVFlQRVMuaGFzKHJlc291cmNlVHlwZSkgJiYgIVMzX0VER0VTX1JFLnRlc3QobmFtZSkpIHtcbiAgICAgIGZhaWwoYGEgZml4ZWQgJHtyZXNvdXJjZVR5cGV9IG5hbWUgbXVzdCBzdGFydCBhbmQgZW5kIHdpdGggYSBsZXR0ZXIgb3IgZGlnaXQgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICB9XG4gICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzZWNyZXRcIiAmJiBTRUNSRVRfVEFJTF9SRS50ZXN0KG5hbWUpKSB7XG4gICAgICBmYWlsKGBhIGZpeGVkIHNlY3JldCBuYW1lIG11c3Qgbm90IGVuZCB3aXRoIGEgaHlwaGVuIGFuZCBzaXggY2hhcmFjdGVycyAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWApO1xuICAgIH1cbiAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcInNzbV9wYXJhbWV0ZXJcIikge1xuICAgICAgLy8gQSBwYXRoIG5hbWUgY2FycmllcyBhdCBsZWFzdCBvbmUgbm9uLWVtcHR5IHNlZ21lbnQgYWZ0ZXIgaXRzIGxlYWQgYC9gLFxuICAgICAgLy8gYW5kIG5vIGVtcHR5IHNlZ21lbnQ6IGAvYCBhbmQgYC9hLy9iYCBuYW1lIG5vdGhpbmcgQVdTIGNhbiBjcmVhdGUuXG4gICAgICBpZiAoIVNTTV9QQVRIX1JFLnRlc3QobmFtZSkpIHtcbiAgICAgICAgZmFpbChcbiAgICAgICAgICBgYSBmaXhlZCBzc21fcGFyYW1ldGVyIG5hbWUgbXVzdCBjYXJyeSBhdCBsZWFzdCBvbmUgbm9uLWVtcHR5IHNlZ21lbnQgYWZ0ZXIgaXRzIGxlYWQgXCIvXCIgYW5kIG5vIGVtcHR5IHNlZ21lbnQgKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKChuYW1lLm1hdGNoKC9cXC8vZyk/Lmxlbmd0aCA/PyAwKSA+IDE1KSB7XG4gICAgICAgIGZhaWwoYGEgZml4ZWQgc3NtX3BhcmFtZXRlciBuYW1lIG11c3QgaGF2ZSBhdCBtb3N0IDE1IGxldmVscyAoY29udHJhY3Qgc2VjdGlvbiAyKSwgZ290ICR7cXVvdGVkfWApO1xuICAgICAgfVxuICAgICAgaWYgKC9eXFwvPyg/OmF3c3xzc20pKD86XFwvfCQpL2kudGVzdChuYW1lKSkge1xuICAgICAgICBmYWlsKGBhIGZpeGVkIHNzbV9wYXJhbWV0ZXIgbmFtZSBtdXN0IG5vdCBiZWdpbiB3aXRoIGF3cyBvciBzc20gKGNvbnRyYWN0IHNlY3Rpb24gMiksIGdvdCAke3F1b3RlZH1gKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJrbXNfYWxpYXNcIikge1xuICAgICAgLy8gYGFsaWFzL2AgYWxvbmUgbmFtZXMgbm8gYWxpYXM6IHRoZSBuYW1lIGFmdGVyIHRoZSBsZWFkIGlzIHRoZSBhbGlhcy5cbiAgICAgIGlmIChuYW1lLmxlbmd0aCA8PSBLTVNfQUxJQVNfTEVBRC5sZW5ndGgpIHtcbiAgICAgICAgZmFpbChcbiAgICAgICAgICBgYSBmaXhlZCBrbXNfYWxpYXMgbmFtZSBtdXN0IGNhcnJ5IGEgbm9uLWVtcHR5IG5hbWUgYWZ0ZXIgaXRzICR7SlNPTi5zdHJpbmdpZnkoS01TX0FMSUFTX0xFQUQpfSBsZWFkIChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCJhbGlhcy9hd3MvXCIpKSB7XG4gICAgICAgIGZhaWwoYGEgZml4ZWQga21zX2FsaWFzIG5hbWUgbXVzdCBub3QgYmUgaW4gdGhlIGFsaWFzL2F3cy8gbmFtZXNwYWNlIChjb250cmFjdCBzZWN0aW9uIDIpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwibG9nX2dyb3VwXCIpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCJhd3MvXCIpKSB7XG4gICAgICAgIGZhaWwoYGEgZml4ZWQgbG9nX2dyb3VwIG5hbWUgbXVzdCBub3QgYmVnaW4gd2l0aCBhd3MvIChjb250cmFjdCBzZWN0aW9uIDMpLCBnb3QgJHtxdW90ZWR9YCk7XG4gICAgICB9IGVsc2UgaWYgKCFpc0ZpeGVkTG9nR3JvdXBTaGFwZShuYW1lKSkge1xuICAgICAgICBmYWlsKFxuICAgICAgICAgIGBhIGZpeGVkIGxvZ19ncm91cCBuYW1lIG11c3QgYmUgZWl0aGVyIGEgc2VjdGlvbiAzIGxvZy1zb3VyY2UgbmFtZSAobm8gXCIvXCIpIG9yIHRoZSBMYW1iZGEgc2VydmljZSBwYXRoICR7SlNPTi5zdHJpbmdpZnkoTEFNQkRBX0xPR19HUk9VUF9MRUFEKX0gZm9sbG93ZWQgYnkgYSBuYW1lIHRoYXQgc2F0aXNmaWVzIHRoZSBsYW1iZGFfZnVuY3Rpb24gcm93IChjb250cmFjdCBzZWN0aW9uIDMpLCBnb3QgJHtxdW90ZWR9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVmdXNlIHR3byBkaWZmZXJlbnQgbG9naWNhbCByZXNvdXJjZXMgaW4gb25lIG5hbWluZyBjb250ZXh0IHRoYXQgZGVyaXZlIHRoZVxuICAgKiBzYW1lIG5hbWUgaW4gdGhlIHNhbWUgbmFtaW5nIHNjb3BlLCBhbmQgcmV0dXJuIHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3RcbiAgICogKGNvbnRyYWN0IHNlY3Rpb24gMTEuNCkuIEEgTGFtYmRhIGZ1bmN0aW9uIGFuZCBpdHMgSUFNIHJvbGUgbWF5IHNoYXJlIGEgbmFtZVxuICAgKiBiZWNhdXNlIHRoZWlyIHNjb3BlcyBkaWZmZXIsIGFuZCB0d28gQVBJcyBtYXkgc2hhcmUgb25lIGJlY2F1c2UgQVdTIGRvZXMgbm90XG4gICAqIGtlZXAgQVBJIG5hbWVzIHVuaXF1ZS4gUm93cyBrZWVwIHRoZSBvcmRlciBvZiB0aGUgZW50cmllcy5cbiAgICpcbiAgICogYGxvZ2ljYWxJZGAgaXMgdGhlIHJlc291cmNlJ3MgaWRlbnRpdHkgaW5zaWRlIHRoZSBuYW1pbmcgY29udGV4dDogaXRzXG4gICAqIENsb3VkRm9ybWF0aW9uIGxvZ2ljYWwgaWQsIG9yIHRoZSBvd25pbmcgc3RhY2sncyBjb25zdHJ1Y3QgcGF0aCBwbHVzIHRoYXRcbiAgICogbG9naWNhbCBpZCB3aGVuIHRoZSBjb250ZXh0IHNwYW5zIHNldmVyYWwgc3RhY2tzLiBBIENsb3VkRm9ybWF0aW9uIGxvZ2ljYWwgaWRcbiAgICogaXMgdW5pcXVlIG9ubHkgaW5zaWRlIG9uZSB0ZW1wbGF0ZSwgc28gYSBjYWxsZXIgdGhhdCBvd25zIG1vcmUgdGhhbiBvbmVcbiAgICogdGVtcGxhdGUgbXVzdCBwYXNzIHRoZSBxdWFsaWZpZWQgZm9ybTsgb3RoZXJ3aXNlIHR3byByZXNvdXJjZXMgaW4gZGlmZmVyZW50XG4gICAqIHN0YWNrcyB3aXRoIHRoZSBzYW1lIGxvY2FsIGxvZ2ljYWwgaWQgbG9vayBsaWtlIG9uZSByZS1kZWNsYXJlZCByZXNvdXJjZVxuICAgKiAoU0FOSVRZLUFULU4zLTA1KS4gVGhlIHJldHVybmVkIHJvdyBlY2hvZXMgdGhlIGlkZW50aXR5IGl0IHdhcyBnaXZlbi5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc3ludGhDaGVjayhlbnRyaWVzOiBBcHBUaGVvcnlEZXJpdmVkTmFtZUlucHV0W10pOiBBcHBUaGVvcnlEZXJpdmVkTmFtZVtdIHtcbiAgICBjb25zdCBzZWVuID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBjb25zdCBhcnRpZmFjdDogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgY29uc3Qgc2NvcGUgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5uYW1pbmdTY29wZShlbnRyeS50eXBlKTtcbiAgICAgIGNvbnN0IGdlbmVyYXRlZCA9IGVudHJ5LmdlbmVyYXRlZCA9PT0gdHJ1ZTtcbiAgICAgIGFydGlmYWN0LnB1c2goe1xuICAgICAgICAuLi4oZW50cnkubmFtZSAhPT0gdW5kZWZpbmVkICYmICFnZW5lcmF0ZWQgPyB7IG5hbWU6IGVudHJ5Lm5hbWUgfSA6IHt9KSxcbiAgICAgICAgdHlwZTogZW50cnkudHlwZSxcbiAgICAgICAgc2NvcGUsXG4gICAgICAgIGxvZ2ljYWxJZDogZW50cnkubG9naWNhbElkLFxuICAgICAgICAuLi4oZ2VuZXJhdGVkID8geyBnZW5lcmF0ZWQ6IHRydWUgfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHNjb3BlID09PSBBcHBUaGVvcnlOYW1pbmdTY29wZS5OT1RfVU5JUVVFIHx8IGdlbmVyYXRlZCkgY29udGludWU7XG4gICAgICBjb25zdCBrZXkgPSBgJHtzY29wZX1cXHUwMDAwJHtlbnRyeS50eXBlfVxcdTAwMDAke2VudHJ5Lm5hbWUgPz8gXCJcIn1gO1xuICAgICAgY29uc3QgaGVsZCA9IHNlZW4uZ2V0KGtleSk7XG4gICAgICBpZiAoaGVsZCAhPT0gdW5kZWZpbmVkICYmIGhlbGQgIT09IGVudHJ5LmxvZ2ljYWxJZCkge1xuICAgICAgICBmYWlsKGAke2hlbGR9IGFuZCAke2VudHJ5LmxvZ2ljYWxJZH0gZGVyaXZlICR7ZW50cnkubmFtZSA/PyBcIlwifSBpbiBzY29wZSAke3Njb3BlfWApO1xuICAgICAgfVxuICAgICAgc2Vlbi5zZXQoa2V5LCBlbnRyeS5sb2dpY2FsSWQpO1xuICAgIH1cbiAgICByZXR1cm4gYXJ0aWZhY3Q7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBhcyB0aGUgY2xvdWQtYXNzZW1ibHkgbWV0YWRhdGEgZG9jdW1lbnQsIHdpdGggdGhlXG4gICAqIGNvbnRyYWN0J3Mgc25ha2VfY2FzZSB3aXJlIGtleXMgYW5kIGEgZGV0ZXJtaW5pc3RpYyBlbnRyeSBvcmRlci5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgZGVyaXZlZE5hbWVzSnNvbihhcnRpZmFjdDogQXBwVGhlb3J5RGVyaXZlZE5hbWVzKTogc3RyaW5nIHtcbiAgICBjb25zdCBlbnRyaWVzID0gWy4uLmFydGlmYWN0LmVudHJpZXNdXG4gICAgICAubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgICAgLi4uKGVudHJ5Lm5hbWUgIT09IHVuZGVmaW5lZCAmJiAhZW50cnkuZ2VuZXJhdGVkID8geyBuYW1lOiBlbnRyeS5uYW1lIH0gOiB7fSksXG4gICAgICAgIHR5cGU6IGVudHJ5LnR5cGUsXG4gICAgICAgIHNjb3BlOiBlbnRyeS5zY29wZSxcbiAgICAgICAgbG9naWNhbF9pZDogZW50cnkubG9naWNhbElkLFxuICAgICAgICAuLi4oZW50cnkuZ2VuZXJhdGVkID8geyBnZW5lcmF0ZWQ6IHRydWUgfSA6IHt9KSxcbiAgICAgIH0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgICAgY29uc3Qga2V5ID0gKHJvdzogdHlwZW9mIGEpOiBzdHJpbmcgPT5cbiAgICAgICAgICBbcm93LnNjb3BlLCByb3cudHlwZSwgcm93Lm5hbWUgPz8gXCJcIiwgcm93LmxvZ2ljYWxfaWRdLmpvaW4oXCJcXHUwMDAwXCIpO1xuICAgICAgICBjb25zdCBsZWZ0ID0ga2V5KGEpO1xuICAgICAgICBjb25zdCByaWdodCA9IGtleShiKTtcbiAgICAgICAgcmV0dXJuIGxlZnQgPCByaWdodCA/IC0xIDogbGVmdCA+IHJpZ2h0ID8gMSA6IDA7XG4gICAgICB9KTtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgY29udHJhY3Q6IGFydGlmYWN0LmNvbnRyYWN0LFxuICAgICAgc2NoZW1hOiBhcnRpZmFjdC5zY2hlbWEsXG4gICAgICBjb250ZXh0OiB7XG4gICAgICAgIG5hbWVzcGFjZTogYXJ0aWZhY3QuY29udGV4dC5uYW1lc3BhY2UgPz8gTE9HX1BSRUZJWCxcbiAgICAgICAgYXBwOiBhcnRpZmFjdC5jb250ZXh0LmFwcCxcbiAgICAgICAgc3RhZ2U6IGFydGlmYWN0LmNvbnRleHQuc3RhZ2UsXG4gICAgICAgIGFjY291bnQ6IGFydGlmYWN0LmNvbnRleHQuYWNjb3VudCxcbiAgICAgICAgcmVnaW9uOiBhcnRpZmFjdC5jb250ZXh0LnJlZ2lvbixcbiAgICAgIH0sXG4gICAgICBlbnRyaWVzLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlIG9uZSBzZWxlY3Rvci4gVGhyb3dzIG9uIGEgc2VsZWN0b3Igb3V0c2lkZSB0aGUgZ3JhbW1hci5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcjogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgYmFzZSA9IHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikgPyBzZWxlY3Rvci5zbGljZSgwLCAtMikgOiBzZWxlY3RvcjtcbiAgICBpZiAoIUxPR0lDQUxfUkUudGVzdChiYXNlKSB8fCBiYXNlLnNwbGl0KFwiL1wiKVswXSAhPT0gXCJsb2dzXCIgfHwgKGJhc2UgPT09IFwibG9nc1wiICYmICFzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSkge1xuICAgICAgZmFpbChgc2VsZWN0b3IgJHtzZWxlY3Rvcn1gKTtcbiAgICB9XG4gICAgaWYgKGJhc2UuaW5jbHVkZXMoXCIqXCIpKSBmYWlsKFwid2lsZGNhcmQgb25seSBhcyB0cmFpbGluZyAvKlwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGEgc2VsZWN0b3IgbWF0Y2hlcyBhIGxvZ2ljYWwgc291cmNlLiBBIHRyYWlsaW5nIGAvKmAgbWF0Y2hlc1xuICAgKiBkZXNjZW5kYW50cyBvbmx5LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3I6IHN0cmluZywgbG9naWNhbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpIHJldHVybiBsb2dpY2FsLnN0YXJ0c1dpdGgoc2VsZWN0b3Iuc2xpY2UoMCwgLTEpKTtcbiAgICByZXR1cm4gbG9naWNhbCA9PT0gc2VsZWN0b3I7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBhIHNvdXJjZSBpcyB2aXNpYmxlOiBhbiBpbmNsdWRlIG1hdGNoZXMgYW5kIG5vIGV4Y2x1ZGUgZG9lcy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc291cmNlVmlzaWJsZShydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLCBsb2dpY2FsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBjb25zdCBpbmNsdWRlZCA9IChydWxlcy5pbmNsdWRlID8/IFtdKS5zb21lKChzZWxlY3RvcikgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yLCBsb2dpY2FsKSk7XG4gICAgaWYgKCFpbmNsdWRlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiAhKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pLnNvbWUoKHNlbGVjdG9yKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3IsIGxvZ2ljYWwpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgU0hBLTI1NiBvdmVyIHRoZSBjYW5vbmljYWwgcnVsZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHJ1bGVWZXJzaW9uKHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMpOiBzdHJpbmcge1xuICAgIGNvbnN0IGNhbm9uaWNhbCA9IGB7XCJleGNsdWRlXCI6JHtKU09OLnN0cmluZ2lmeShzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpKX0sXCJpbmNsdWRlXCI6JHtKU09OLnN0cmluZ2lmeShzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpKX19YDtcbiAgICByZXR1cm4gc2hhMjU2SGV4KGNhbm9uaWNhbCkuc2xpY2UoMCwgMTIpO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBpbGUgdGhlIHJ1bGVzIGludG8gdGhlIHJlYWRlci1yb2xlIGlubGluZSBwb2xpY3kgZG9jdW1lbnQuIFRoZSByZXR1cm5cbiAgICogdmFsdWUgaXMgdGhlIGNvbnRyYWN0IEpTT04sIHNvIGEgY29uc3VtZXIgY2FuIGNvbXBhcmUgaXQgYnl0ZSBmb3IgYnl0ZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgY29tcGlsZVZpc2liaWxpdHlQb2xpY3lKc29uKFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICApOiBzdHJpbmcge1xuICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgWy4uLihydWxlcy5pbmNsdWRlID8/IFtdKSwgLi4uKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pXSkge1xuICAgICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgfVxuICAgIGNvbnN0IGJhc2UgPSBgYXJuOmF3czpsb2dzOiR7dmFsdWVzLnJlZ2lvbn06JHt2YWx1ZXMuYWNjb3VudH06bG9nLWdyb3VwOmA7XG4gICAgY29uc3QgYXJuc0ZvciA9IChzZWxlY3Rvcjogc3RyaW5nKTogc3RyaW5nW10gPT4ge1xuICAgICAgaWYgKHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpIHtcbiAgICAgICAgcmV0dXJuIFtiYXNlICsgbG9nUHJlZml4KHZhbHVlcykgKyBzZWxlY3Rvci5zbGljZSgwLCAtMSkucmVwbGFjZSgvXFwvL2csIFwiX1wiKSArIFwiKlwiXTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG5hbWUgPSBsb2dQcmVmaXgodmFsdWVzKSArIHNlbGVjdG9yLnJlcGxhY2UoL1xcLy9nLCBcIl9cIik7XG4gICAgICByZXR1cm4gW2Jhc2UgKyBuYW1lLCBiYXNlICsgbmFtZSArIFwiOipcIl07XG4gICAgfTtcbiAgICBjb25zdCBhY3Rpb25zID0gWy4uLktFRVBFUl9BQ1RJT05TX0dST1VQLCAuLi5LRUVQRVJfQUNUSU9OU19TVFJFQU1dO1xuICAgIGNvbnN0IHN0YXRlbWVudHM6IHsgU2lkOiBzdHJpbmc7IEVmZmVjdDogc3RyaW5nOyBBY3Rpb246IHN0cmluZ1tdOyBSZXNvdXJjZTogc3RyaW5nW10gfVtdID0gW1xuICAgICAge1xuICAgICAgICBTaWQ6IFwiUmVhZE1hbmlmZXN0XCIsXG4gICAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgICBBY3Rpb246IFtcInNzbTpHZXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgIFJlc291cmNlOiBbXG4gICAgICAgICAgYGFybjphd3M6c3NtOiR7dmFsdWVzLnJlZ2lvbn06JHt2YWx1ZXMuYWNjb3VudH06cGFyYW1ldGVyLyR7TE9HX1BSRUZJWH0vdmlzaWJpbGl0eS8ke3ZhbHVlcy5hcHB9LyR7dmFsdWVzLnN0YWdlfS9tYW5pZmVzdGAsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3QgaW5jbHVkZWQgPSBzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpLmZsYXRNYXAoYXJuc0Zvcik7XG4gICAgY29uc3QgZXhjbHVkZWQgPSBzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpLmZsYXRNYXAoYXJuc0Zvcik7XG4gICAgaWYgKGluY2x1ZGVkLmxlbmd0aCA+IDApIHN0YXRlbWVudHMucHVzaCh7IFNpZDogXCJSZWFkSW5jbHVkZWRcIiwgRWZmZWN0OiBcIkFsbG93XCIsIEFjdGlvbjogYWN0aW9ucywgUmVzb3VyY2U6IGluY2x1ZGVkIH0pO1xuICAgIGlmIChleGNsdWRlZC5sZW5ndGggPiAwKSBzdGF0ZW1lbnRzLnB1c2goeyBTaWQ6IFwiRGVueUV4Y2x1ZGVkXCIsIEVmZmVjdDogXCJEZW55XCIsIEFjdGlvbjogYWN0aW9ucywgUmVzb3VyY2U6IGV4Y2x1ZGVkIH0pO1xuICAgIGNvbnN0IGRvY3VtZW50ID0gSlNPTi5zdHJpbmdpZnkoeyBWZXJzaW9uOiBcIjIwMTItMTAtMTdcIiwgU3RhdGVtZW50OiBzdGF0ZW1lbnRzIH0pO1xuICAgIGlmIChkb2N1bWVudC5sZW5ndGggPiBST0xFX1BPTElDWV9NQVgpIGZhaWwoXCJjb21waWxlZCBwb2xpY3kgb3ZlciByb2xlIHBvbGljeSBzaXplXCIpO1xuICAgIHJldHVybiBkb2N1bWVudDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBc3NlbWJsZSB0aGUgc3ludGgtdGltZSB2aXNpYmlsaXR5IHByZXZpZXcuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZpc2liaWxpdHlQcmV2aWV3KFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIHNvdXJjZXM6IHN0cmluZ1tdLFxuICApOiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHZhbHVlcyk7XG4gICAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBbLi4uKHJ1bGVzLmluY2x1ZGUgPz8gW10pLCAuLi4ocnVsZXMuZXhjbHVkZSA/PyBbXSldKSB7XG4gICAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHJ1bGVWZXJzaW9uOiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5ydWxlVmVyc2lvbihydWxlcyksXG4gICAgICBtYXRjaGVkTm93OiBzb3VyY2VzLmZpbHRlcigoc291cmNlKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBzb3VyY2UpKS5zb3J0KCksXG4gICAgICBub3RNYXRjaGVkTm93OiBzb3VyY2VzLmZpbHRlcigoc291cmNlKSA9PiAhQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgc291cmNlKSkuc29ydCgpLFxuICAgICAgZnV0dXJlOiB7IGluY2x1ZGU6IHNvcnRlZENvcHkocnVsZXMuaW5jbHVkZSksIGV4Y2x1ZGU6IHNvcnRlZENvcHkocnVsZXMuZXhjbHVkZSkgfSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEFzc2VtYmxlIHRoZSBwdWJsaXNoZWQgbWFuaWZlc3QgKHRoZSBwcmV2aWV3IG1pbnVzIGBub3RNYXRjaGVkTm93YCkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZpc2liaWxpdHlNYW5pZmVzdChcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBzb3VyY2VzOiBzdHJpbmdbXSxcbiAgKTogQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0IHtcbiAgICBjb25zdCBwcmV2aWV3ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmlzaWJpbGl0eVByZXZpZXcodmFsdWVzLCBydWxlcywgc291cmNlcyk7XG4gICAgcmV0dXJuIHsgcnVsZVZlcnNpb246IHByZXZpZXcucnVsZVZlcnNpb24sIG1hdGNoZWROb3c6IHByZXZpZXcubWF0Y2hlZE5vdywgZnV0dXJlOiBwcmV2aWV3LmZ1dHVyZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFNlcmlhbGl6ZSBhIG1hbmlmZXN0IHRvIHRoZSBjb250cmFjdCBKU09OIHNoYXBlIHdyaXR0ZW4gdG8gU1NNLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBtYW5pZmVzdEpzb24obWFuaWZlc3Q6IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHJ1bGVfdmVyc2lvbjogbWFuaWZlc3QucnVsZVZlcnNpb24sXG4gICAgICBtYXRjaGVkX25vdzogbWFuaWZlc3QubWF0Y2hlZE5vdyxcbiAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBtYW5pZmVzdC5mdXR1cmUuaW5jbHVkZSA/PyBbXSwgZXhjbHVkZTogbWFuaWZlc3QuZnV0dXJlLmV4Y2x1ZGUgPz8gW10gfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBLZWVwZXIncyByZWFkIGRlY2lzaW9uLCBpbiB0aGUgcnVudGltZXMnIHBhcmFtZXRlciBvcmRlci4gRmFpbHMgY2xvc2VkIG9uIGFcbiAgICogZGVuaWFsIG9yIGFuIHVucmVhY2hhYmxlIGFjY291bnQuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGtlZXBlckRlY2lzaW9uKFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICAgbG9naWNhbDogc3RyaW5nLFxuICAgIGF3c1Jlc3VsdDogc3RyaW5nLFxuICApOiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIge1xuICAgIGlmICghcnVsZXMgfHwgIUFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIGxvZ2ljYWwpKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLk5PVF9TSEFSRUQ7XG4gICAgfVxuICAgIGlmIChhd3NSZXN1bHQgPT09IFwiZXZlbnRzXCIpIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuRVZFTlRTO1xuICAgIGlmIChhd3NSZXN1bHQgPT09IFwiZW1wdHlcIiB8fCBhd3NSZXN1bHQgPT09IFwibm90X2ZvdW5kXCIpIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuQUxMT1dFRF9OT19FVkVOVFM7XG4gICAgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5OT1RfU0hBUkVEO1xuICB9XG59XG4iXX0=