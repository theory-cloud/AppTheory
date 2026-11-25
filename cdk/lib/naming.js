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
    dynamodb_table: { kind: "dash", max: 255, charset: "[A-Za-z0-9_.-]" },
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
 * API name types. The CDK defaults an API Name today, so a name for one is
 * explicit and takes a pin, never a generated entry (r3, ADV-1312-3).
 */
const API_TYPES = new Set(["api_rest", "api_http", "api_websocket"]);
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
        const rule = RULES[resourceType];
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
        if (!(resourceType in RULES))
            fail(UNKNOWN_NAMING_SCOPE);
        if (NOT_UNIQUE_TYPES.has(resourceType))
            return AppTheoryNamingScope.NOT_UNIQUE;
        if (ACCOUNT_GLOBAL_TYPES.has(resourceType))
            return AppTheoryNamingScope.ACCOUNT;
        return AppTheoryNamingScope.ACCOUNT_REGION;
    }
    /**
     * Refuse two different logical resources in one naming context that derive the
     * same name in the same naming scope, and return the derived-name artifact
     * (contract section 11.4). A Lambda function and its IAM role may share a name
     * because their scopes differ, and two APIs may share one because AWS does not
     * keep API names unique. Rows keep the order of the entries.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekM7O0dBRUc7QUFDVSxRQUFBLHdCQUF3QixHQUFHLGtDQUFrQyxDQUFDO0FBRTNFOztHQUVHO0FBQ1UsUUFBQSxvQkFBb0IsR0FBRyw0Q0FBNEMsQ0FBQztBQUVqRjs7O0dBR0c7QUFDVSxRQUFBLDBCQUEwQixHQUFHLHlDQUF5QyxDQUFDO0FBRXBGOztHQUVHO0FBQ0gsSUFBWSxzQkFTWDtBQVRELFdBQVksc0JBQXNCO0lBQ2hDOztPQUVHO0lBQ0gsNkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCwyQ0FBaUIsQ0FBQTtBQUNuQixDQUFDLEVBVFcsc0JBQXNCLHNDQUF0QixzQkFBc0IsUUFTakM7QUFFRDs7R0FFRztBQUNILElBQVksdUJBU1g7QUFURCxXQUFZLHVCQUF1QjtJQUNqQzs7T0FFRztJQUNILGdEQUFxQixDQUFBO0lBQ3JCOztPQUVHO0lBQ0gsNENBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBU2xDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHFCQWFYO0FBYkQsV0FBWSxxQkFBcUI7SUFDL0I7O09BRUc7SUFDSCwwQ0FBaUIsQ0FBQTtJQUNqQjs7T0FFRztJQUNILGdFQUF1QyxDQUFBO0lBQ3ZDOztPQUVHO0lBQ0gsa0RBQXlCLENBQUE7QUFDM0IsQ0FBQyxFQWJXLHFCQUFxQixxQ0FBckIscUJBQXFCLFFBYWhDO0FBK0xEOztHQUVHO0FBQ0gsSUFBWSxvQkFhWDtBQWJELFdBQVksb0JBQW9CO0lBQzlCOztPQUVHO0lBQ0gsMkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCx5REFBaUMsQ0FBQTtJQUNqQzs7T0FFRztJQUNILGlEQUF5QixDQUFBO0FBQzNCLENBQUMsRUFiVyxvQkFBb0Isb0NBQXBCLG9CQUFvQixRQWEvQjtBQWdFRCxNQUFN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dCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuLyoqXG4gKiBUaGUgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0IHRoaXMgbW9kdWxlIGltcGxlbWVudHMuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVNPVVJDRV9OQU1JTkdfQ09OVFJBQ1QgPSBcInRoZW9yeWNsb3VkX3Jlc291cmNlX25hbWluZy52MC4xXCI7XG5cbi8qKlxuICogVGhlIHNjaGVtYSBpZGVudGlmaWVyIG9mIHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgYSBuYW1pbmcgY29udGV4dCBlbWl0cy5cbiAqL1xuZXhwb3J0IGNvbnN0IERFUklWRURfTkFNRVNfU0NIRU1BID0gXCJhcHB0aGVvcnlfcmVzb3VyY2VfbmFtaW5nLmRlcml2ZWRfbmFtZXMudjFcIjtcblxuLyoqXG4gKiBUaGUgY2xvdWQtYXNzZW1ibHkgbWV0YWRhdGEgdHlwZSB0aGF0IGNhcnJpZXMgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdC4gVGhlXG4gKiBhcnRpZmFjdCBsYW5kcyBpbiBge3N0YWNrfS5tZXRhZGF0YS5qc29uYCBpbiBgY2RrLm91dGAuXG4gKi9cbmV4cG9ydCBjb25zdCBERVJJVkVEX05BTUVTX01FVEFEQVRBX0tFWSA9IFwiYXBwdGhlb3J5OnJlc291cmNlLW5hbWluZy9kZXJpdmVkLW5hbWVzXCI7XG5cbi8qKlxuICogTmFtaW5nIHByb2ZpbGVzIGFjY2VwdGVkIGJ5IGEgbmFtaW5nIGNvbnRleHQuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUge1xuICAvKipcbiAgICogTmFtZXMgZGVyaXZlIGZyb20gdGhlIG5hbWluZyBjb250ZXh0LlxuICAgKi9cbiAgREVSSVZFRCA9IFwiZGVyaXZlZFwiLFxuICAvKipcbiAgICogRXZlcnkgbmFtZSBjb21lcyBmcm9tIGEgcGluLlxuICAgKi9cbiAgTEVHQUNZID0gXCJsZWdhY3lcIixcbn1cblxuLyoqXG4gKiBMb2dnaW5nIHByb2ZpbGVzIGFjY2VwdGVkIGJ5IGEgbmFtaW5nIGNvbnRleHQuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlIHtcbiAgLyoqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIHN0YW5kYXJkIGxvZyBncm91cHMgYW5kIGFjY2VzcyBsb2dnaW5nLlxuICAgKi9cbiAgU1RBTkRBUkQgPSBcInN0YW5kYXJkXCIsXG4gIC8qKlxuICAgKiBFYWNoIGNvbnN0cnVjdCBrZWVwcyBpdHMgcHJlLWNvbnRyYWN0IGxvZ2dpbmcgYmVoYXZpb3VyLlxuICAgKi9cbiAgTEVHQUNZID0gXCJsZWdhY3lcIixcbn1cblxuLyoqXG4gKiBLZWVwZXIncyBhbnN3ZXIgdG8gYSByZWFkZXIgcmVxdWVzdC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5S2VlcGVyQW5zd2VyIHtcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgc2hhcmVkIGFuZCB0aGUgcmVhZCByZXR1cm5lZCBldmVudHMuXG4gICAqL1xuICBFVkVOVFMgPSBcImV2ZW50c1wiLFxuICAvKipcbiAgICogVGhlIHNvdXJjZSBpcyBzaGFyZWQgYW5kIHRoZSByZWFkIHJldHVybmVkIG5vIGV2ZW50cy5cbiAgICovXG4gIEFMTE9XRURfTk9fRVZFTlRTID0gXCJhbGxvd2VkX25vX2V2ZW50c1wiLFxuICAvKipcbiAgICogVGhlIHNvdXJjZSBpcyBub3Qgc2hhcmVkLCBvciB0aGUgcmVhZCBmYWlsZWQgY2xvc2VkLlxuICAgKi9cbiAgTk9UX1NIQVJFRCA9IFwibm90X3NoYXJlZFwiLFxufVxuXG4vKipcbiAqIEJvdW5kIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0IHZhbHVlcyBmcm9tIHN0YWdlIGNvbmZpZy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzIHtcbiAgLyoqXG4gICAqIE5hbWVzcGFjZSBzZWdtZW50LlxuICAgKiBAZGVmYXVsdCBcInRoZW9yeWNsb3VkXCJcbiAgICovXG4gIHJlYWRvbmx5IG5hbWVzcGFjZT86IHN0cmluZztcblxuICAvKipcbiAgICogQXBwIGluc3RhbmNlIGlkLlxuICAgKi9cbiAgcmVhZG9ubHkgYXBwOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGlkLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U6IHN0cmluZztcblxuICAvKipcbiAgICogVHdlbHZlLWRpZ2l0IGFjY291bnQgaWQuIEFuIHVucmVzb2x2ZWQgdG9rZW4gZmFpbHMgc3ludGhlc2lzLlxuICAgKi9cbiAgcmVhZG9ubHkgYWNjb3VudDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGdWxsIFJlZ2lvbiBjb2RlLCBmb3IgZXhhbXBsZSBgdXMtZWFzdC0xYC5cbiAgICovXG4gIHJlYWRvbmx5IHJlZ2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBQaHlzaWNhbCBwaW5zIGtleWVkIGB7dHlwZX06e2xvZ2ljYWx9YC5cbiAgICogQGRlZmF1bHQge31cbiAgICovXG4gIHJlYWRvbmx5IHBpbnM/OiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9O1xuXG4gIC8qKlxuICAgKiBHZW5lcmF0ZWQtbmFtZSBlbnRyaWVzIGtleWVkIGB7dHlwZX06e2xvZ2ljYWx9YC4gQW4gZW50cnkgbWVhbnNcbiAgICogQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lIHRvZGF5LCBzbyB0aGUgY29uc3RydWN0IHNldHMgbm9cbiAgICogcGh5c2ljYWwtbmFtZSBwcm9wZXJ0eS4gVmFsaWQgb25seSB1bmRlciB0aGUgbGVnYWN5IG5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRURcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU/OiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU/OiBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nIHJldGVudGlvbiBpbiBkYXlzIGZvciBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cHMuXG4gICAqIEBkZWZhdWx0IDMwXG4gICAqL1xuICByZWFkb25seSByZXRlbnRpb25EYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRoZSBjb21wb3NlZCBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAvKipcbiAgICogVGhlIGZ1bGwgcGh5c2ljYWwgbmFtZS4gQWJzZW50IHdoZW4gQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBhY2NvdW50LXJlZ2lvbmFsIGJ1Y2tldC1uYW1lIHByZWZpeCwgd2hlbiB0aGUgdHlwZSB1c2VzIG9uZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBidWNrZXROYW1lUHJlZml4Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYnVja2V0IG5hbWVzcGFjZSwgd2hlbiB0aGUgdHlwZSB1c2VzIG9uZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBidWNrZXROYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIG5hbWUgY2FtZSBmcm9tIGEgcGluLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcGlubmVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUsIHNvIG5vIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkgaXNcbiAgICogc2V0LlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBPbmUgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSBhIHN0YWNrIGRlY2xhcmVzLCBhcyB0aGUgc3ludGggY2hlY2sgKGNvbnRyYWN0XG4gKiBzZWN0aW9uIDExLjQpIGNvbnN1bWVzIGl0LiBBIGdlbmVyYXRlZCBlbnRyeSBjYXJyaWVzIG5vIG5hbWU6IENsb3VkRm9ybWF0aW9uXG4gKiBvd25zIHRoZSBuYW1lLCBzbyB0aGVyZSBpcyBub3RoaW5nIHRvIHJlc2VydmUuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dCB7XG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWwgbmFtZS4gQWJzZW50IGZvciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJhY3QgcmVzb3VyY2UgdHlwZSwgZm9yIGV4YW1wbGUgYGxhbWJkYV9mdW5jdGlvbmAuXG4gICAqL1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxJZDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSwgc28gbm90aGluZyBpcyByZXNlcnZlZC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogT25lIHJvdyBvZiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0OiB0aGUgY29tcGxldGUgc2V0IHRoZSBuYW1lIHJlc2VydmF0aW9uXG4gKiBpbmRleCAoY29udHJhY3Qgc2VjdGlvbiAxMS4yKSByZXNlcnZlcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlEZXJpdmVkTmFtZSB7XG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWwgbmFtZS4gQWJzZW50IGZvciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJhY3QgcmVzb3VyY2UgdHlwZS5cbiAgICovXG4gIHJlYWRvbmx5IHR5cGU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHNjb3BlIGluIHdoaWNoIEFXUyByZXF1aXJlcyB0aGUgbmFtZSB0byBiZSB1bmlxdWU6IGBhY2NvdW50YCxcbiAgICogYGFjY291bnRfcmVnaW9uYCwgb3IgYG5vdF91bmlxdWVgLlxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIENsb3VkRm9ybWF0aW9uIGxvZ2ljYWwgaWQgb2YgdGhlIHJlc291cmNlIGNhcnJ5aW5nIHRoZSBuYW1lLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbElkOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lLCBzbyBub3RoaW5nIGlzIHJlc2VydmVkLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBUaGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGEgbmFtaW5nIGNvbnRleHQgZW1pdHMgYXQgc3ludGhlc2lzIChjb250cmFjdFxuICogc2VjdGlvbiAxMS40KSwga2V5ZWQgYHtzdGFja30ubWV0YWRhdGEuanNvbmAgaW4gdGhlIGNsb3VkIGFzc2VtYmx5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeURlcml2ZWROYW1lcyB7XG4gIC8qKlxuICAgKiBUaGUgY29udHJhY3QgaWRlbnRpZmllci5cbiAgICovXG4gIHJlYWRvbmx5IGNvbnRyYWN0OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBhcnRpZmFjdCBzY2hlbWEgaWRlbnRpZmllci5cbiAgICovXG4gIHJlYWRvbmx5IHNjaGVtYTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbmFtaW5nIGNvbnRleHQgdGhhdCBwcm9kdWNlZCB0aGUgYXJ0aWZhY3QuXG4gICAqL1xuICByZWFkb25seSBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzO1xuXG4gIC8qKlxuICAgKiBFdmVyeSBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlIHRoZSBjb250ZXh0IGRlY2xhcmVzLCBzb3J0ZWQgYnkgYHNjb3BlYCxcbiAgICogYHR5cGVgLCBgbmFtZWAgYW5kIGBsb2dpY2FsSWRgLlxuICAgKi9cbiAgcmVhZG9ubHkgZW50cmllczogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtaW5nIHNjb3BlcyBvZiBjb250cmFjdCBzZWN0aW9uIDExLjEuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU5hbWluZ1Njb3BlIHtcbiAgLyoqXG4gICAqIEFXUyBrZWVwcyB0aGUgbmFtZSB1bmlxdWUgYWNyb3NzIHRoZSB3aG9sZSBhY2NvdW50LCB3aGF0ZXZlciB0aGUgUmVnaW9uLlxuICAgKi9cbiAgQUNDT1VOVCA9IFwiYWNjb3VudFwiLFxuICAvKipcbiAgICogQVdTIGtlZXBzIHRoZSBuYW1lIHVuaXF1ZSBwZXIgYWNjb3VudCBhbmQgUmVnaW9uLlxuICAgKi9cbiAgQUNDT1VOVF9SRUdJT04gPSBcImFjY291bnRfcmVnaW9uXCIsXG4gIC8qKlxuICAgKiBBV1MgZG9lcyBub3Qga2VlcCB0aGUgbmFtZSB1bmlxdWUsIHNvIG5vdGhpbmcgaXMgcmVzZXJ2ZWQgZm9yIGl0LlxuICAgKi9cbiAgTk9UX1VOSVFVRSA9IFwibm90X3VuaXF1ZVwiLFxufVxuXG4vKipcbiAqIEluY2x1ZGUgYW5kIGV4Y2x1ZGUgdmlzaWJpbGl0eSBzZWxlY3RvcnMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzIHtcbiAgLyoqXG4gICAqIFNlbGVjdG9ycyB3aG9zZSBzb3VyY2VzIGFyZSBzaGFyZWQuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBpbmNsdWRlPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFNlbGVjdG9ycyB3aG9zZSBzb3VyY2VzIGFyZSBuZXZlciBzaGFyZWQuIEV4Y2x1c2lvbnMgd2luLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZXhjbHVkZT86IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIFRoZSBzeW50aC10aW1lIHZpc2liaWxpdHkgcHJldmlldy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gIC8qKlxuICAgKiBGaXJzdCAxMiBoZXggY2hhcmFjdGVycyBvZiB0aGUgY2Fub25pY2FsIHJ1bGVzIGhhc2guXG4gICAqL1xuICByZWFkb25seSBydWxlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgZG8gbm90IHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbm90TWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBzZWxlY3RvcnMsIGFzIHRoZSBzdGF0ZW1lbnQgb2Ygd2hhdCBmdXR1cmUgc291cmNlcyB3aWxsIG1hdGNoLlxuICAgKi9cbiAgcmVhZG9ubHkgZnV0dXJlOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXM7XG59XG5cbi8qKlxuICogVGhlIHB1Ymxpc2hlZCBTU00gbWFuaWZlc3Q6IHRoZSBwcmV2aWV3IG1pbnVzIGBub3RNYXRjaGVkTm93YC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3Qge1xuICAvKipcbiAgICogRmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgdGhlIGNhbm9uaWNhbCBydWxlcyBoYXNoLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgc2VsZWN0b3JzLCBhcyB0aGUgc3RhdGVtZW50IG9mIHdoYXQgZnV0dXJlIHNvdXJjZXMgd2lsbCBtYXRjaC5cbiAgICovXG4gIHJlYWRvbmx5IGZ1dHVyZTogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xufVxuXG5jb25zdCBTRUdNRU5UX1BBVFRFUk4gPSBcIlthLXowLTldKyg/Oi1bYS16MC05XSspKlwiO1xuY29uc3QgTE9HSUNBTF9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0oPzovJHtTRUdNRU5UX1BBVFRFUk59KSokYCk7XG5jb25zdCBBUFBfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59JGApO1xuY29uc3QgU1RBR0VfUkUgPSAvXlthLXpdW2EtejAtOV17MCw3fSQvO1xuY29uc3QgTkFNRVNQQUNFX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSRgKTtcbmNvbnN0IEFDQ09VTlRfUkUgPSAvXlswLTldezEyfSQvO1xuY29uc3QgUkVHSU9OX1JFID0gL15bYS16XXsyfSg/Oi1bYS16XSspKy1bMC05XSQvO1xuY29uc3QgU0VDUkVUX1RBSUxfUkUgPSAvLVtBLVphLXowLTldezZ9JC87XG5jb25zdCBTM19FREdFU19SRSA9IC9eW2EtejAtOV0uKlthLXowLTldJC87XG5jb25zdCBMT0dfUFJFRklYID0gXCJ0aGVvcnljbG91ZFwiO1xuY29uc3QgUk9MRV9QT0xJQ1lfTUFYID0gMTAyNDA7XG5jb25zdCBCQVNFMzIgPSBcImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MjM0NTY3XCI7XG5cbmludGVyZmFjZSBSdWxlIHtcbiAgcmVhZG9ubHkga2luZDogXCJkYXNoXCIgfCBcInBhdGhcIiB8IFwiczNhclwiIHwgXCJsb2dcIjtcbiAgcmVhZG9ubHkgbWF4OiBudW1iZXI7XG4gIHJlYWRvbmx5IGNoYXJzZXQ6IHN0cmluZztcbiAgcmVhZG9ubHkgbGVhZD86IHN0cmluZztcbn1cblxuY29uc3QgUlVMRVM6IHsgW3R5cGU6IHN0cmluZ106IFJ1bGUgfSA9IHtcbiAgczNfYnVja2V0OiB7IGtpbmQ6IFwiczNhclwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIHMzX3ZlY3Rvcl9idWNrZXQ6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgczNfdmVjdG9yX2luZGV4OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIGR5bmFtb2RiX3RhYmxlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGxhbWJkYV9mdW5jdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc3FzX3F1ZXVlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDgwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzbnNfdG9waWM6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzZWNyZXQ6IHsga2luZDogXCJwYXRoXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTkvXys9LkAtXVwiIH0sXG4gIHNzbV9wYXJhbWV0ZXI6IHsga2luZDogXCJwYXRoXCIsIG1heDogOTAwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLi8tXVwiLCBsZWFkOiBcIi9cIiB9LFxuICBrbXNfYWxpYXM6IHsga2luZDogXCJwYXRoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTkvXy1dXCIsIGxlYWQ6IFwiYWxpYXMvXCIgfSxcbiAgZXZlbnRfYnVzOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGV2ZW50X3J1bGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBzY2hlZHVsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGFsYXJtOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGRhc2hib2FyZDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGlhbV9yb2xlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkrPSwuQF8tXVwiIH0sXG4gIGlhbV9tYW5hZ2VkX3BvbGljeTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOSs9LC5AXy1dXCIgfSxcbiAgc3RhdGVfbWFjaGluZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA4MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgY29kZWJ1aWxkX3Byb2plY3Q6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTUwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfcmVzdDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV9odHRwOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgYXBpX3dlYnNvY2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9zb3VyY2U6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9kZXN0aW5hdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2dyb3VwOiB7IGtpbmQ6IFwibG9nXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxufTtcblxuLyoqXG4gKiBBUEkgbmFtZSB0eXBlcy4gVGhlIENESyBkZWZhdWx0cyBhbiBBUEkgTmFtZSB0b2RheSwgc28gYSBuYW1lIGZvciBvbmUgaXNcbiAqIGV4cGxpY2l0IGFuZCB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnkgKHIzLCBBRFYtMTMxMi0zKS5cbiAqL1xuY29uc3QgQVBJX1RZUEVTID0gbmV3IFNldChbXCJhcGlfcmVzdFwiLCBcImFwaV9odHRwXCIsIFwiYXBpX3dlYnNvY2tldFwiXSk7XG5cbi8qKlxuICogVHlwZXMgQVdTIGtlZXBzIHVuaXF1ZSBhY3Jvc3MgUmVnaW9ucyAoY29udHJhY3Qgc2VjdGlvbiAxMS4xKS5cbiAqL1xuY29uc3QgQUNDT1VOVF9HTE9CQUxfVFlQRVMgPSBuZXcgU2V0KFtcImlhbV9yb2xlXCIsIFwiaWFtX21hbmFnZWRfcG9saWN5XCIsIFwiZGFzaGJvYXJkXCJdKTtcblxuLyoqXG4gKiBBUEkgZGlzcGxheSBuYW1lcyBBV1MgZG9lcyBub3Qga2VlcCB1bmlxdWUsIHNvIG5vdGhpbmcgaXMgcmVzZXJ2ZWQgZm9yIHRoZW0uXG4gKi9cbmNvbnN0IE5PVF9VTklRVUVfVFlQRVMgPSBuZXcgU2V0KFtcImFwaV9yZXN0XCIsIFwiYXBpX2h0dHBcIiwgXCJhcGlfd2Vic29ja2V0XCJdKTtcblxuLyoqXG4gKiBUaGUgcmVmdXNhbCBmb3IgYSB0eXBlIHRoZSBjb250cmFjdCBzdGF0ZXMgbm8gbmFtaW5nIHNjb3BlIGZvcjogaXQgY2Fubm90IGJlXG4gKiByZXNlcnZlZCwgc28gaXQgY2Fubm90IGJlIGRlcGxveWVkIHRocm91Z2ggdGhlIGluZGV4IHVudGlsIGEgcmV2aXNpb24gc3RhdGVzXG4gKiBpdHMgc2NvcGUuXG4gKi9cbmNvbnN0IFVOS05PV05fTkFNSU5HX1NDT1BFID0gXCJhIHR5cGUgd2l0aCBubyBzdGF0ZWQgbmFtaW5nIHNjb3BlIGNhbm5vdCBiZSByZXNlcnZlZFwiO1xuXG5jb25zdCBLRUVQRVJfQUNUSU9OU19HUk9VUCA9IFtcImxvZ3M6RmlsdGVyTG9nRXZlbnRzXCIsIFwibG9nczpEZXNjcmliZUxvZ1N0cmVhbXNcIl07XG5jb25zdCBLRUVQRVJfQUNUSU9OU19TVFJFQU0gPSBbXCJsb2dzOkdldExvZ0V2ZW50c1wiXTtcblxuZnVuY3Rpb24gZmFpbChtZXNzYWdlOiBzdHJpbmcpOiBuZXZlciB7XG4gIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gc2hhMjU2SGV4KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZSh0ZXh0LCBcInV0ZjhcIikuZGlnZXN0KFwiaGV4XCIpO1xufVxuXG5mdW5jdGlvbiBiYXNlMzJMb3dlcih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBieXRlcyA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHRleHQsIFwidXRmOFwiKS5kaWdlc3QoKTtcbiAgbGV0IGJpdHMgPSAwO1xuICBsZXQgdmFsdWUgPSAwO1xuICBsZXQgb3V0ID0gXCJcIjtcbiAgZm9yIChjb25zdCBieXRlIG9mIGJ5dGVzKSB7XG4gICAgdmFsdWUgPSAodmFsdWUgPDwgOCkgfCBieXRlO1xuICAgIGJpdHMgKz0gODtcbiAgICB3aGlsZSAoYml0cyA+PSA1KSB7XG4gICAgICBvdXQgKz0gQkFTRTMyWyh2YWx1ZSA+Pj4gKGJpdHMgLSA1KSkgJiAzMV07XG4gICAgICBiaXRzIC09IDU7XG4gICAgfVxuICB9XG4gIGlmIChiaXRzID4gMCkgb3V0ICs9IEJBU0UzMlsodmFsdWUgPDwgKDUgLSBiaXRzKSkgJiAzMV07XG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIHNob3J0ZW4oZnVsbDogc3RyaW5nLCBsaW1pdDogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKGZ1bGwubGVuZ3RoIDw9IGxpbWl0KSByZXR1cm4gZnVsbDtcbiAgY29uc3QgaGVhZCA9IGZ1bGwuc2xpY2UoMCwgbGltaXQgLSA5KS5yZXBsYWNlKC9bLV8uL10rJC8sIFwiXCIpO1xuICByZXR1cm4gYCR7aGVhZH0tJHtiYXNlMzJMb3dlcihmdWxsKS5zbGljZSgwLCA4KX1gO1xufVxuXG5mdW5jdGlvbiBuYW1lc3BhY2VPZih2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWVzLm5hbWVzcGFjZSA/PyBMT0dfUFJFRklYO1xufVxuXG5mdW5jdGlvbiBzb3J0ZWRDb3B5KHZhbHVlczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbLi4ubmV3IFNldCh2YWx1ZXMgPz8gW10pXS5zb3J0KCk7XG59XG5cbmZ1bmN0aW9uIGxvZ1ByZWZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gW0xPR19QUkVGSVgsIG5hbWVzcGFjZU9mKHZhbHVlcyksIHZhbHVlcy5hcHAsIHZhbHVlcy5zdGFnZV0uam9pbihcIl9cIikgKyBcIl9cIjtcbn1cblxuLyoqXG4gKiBUaGUgYHRoZW9yeWNsb3VkX3Jlc291cmNlX25hbWluZy52MC4xYCBwcmltaXRpdmVzLCBleHBvc2VkIGZvciBqc2lpIHNvIHRoZSBHb1xuICogYW5kIFB5dGhvbiBDREsgYmluZGluZ3Mgc2hhcmUgb25lIGltcGxlbWVudGF0aW9uLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcge1xuICBwcml2YXRlIGNvbnN0cnVjdG9yKCkge31cblxuICAvKipcbiAgICogVmFsaWRhdGUgdGhlIGJvdW5kIGNvbnRleHQgZ3JhbW1hci4gVGhyb3dzIG9uIGFuIGludmFsaWQgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVDb250ZXh0KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHZvaWQge1xuICAgIGlmICghQVBQX1JFLnRlc3QodmFsdWVzLmFwcCkpIGZhaWwoXCJhcHBcIik7XG4gICAgaWYgKCFTVEFHRV9SRS50ZXN0KHZhbHVlcy5zdGFnZSkpIGZhaWwoXCJzdGFnZVwiKTtcbiAgICBpZiAoIUFDQ09VTlRfUkUudGVzdCh2YWx1ZXMuYWNjb3VudCkpIGZhaWwoXCJhY2NvdW50XCIpO1xuICAgIGlmICghUkVHSU9OX1JFLnRlc3QodmFsdWVzLnJlZ2lvbikpIGZhaWwoXCJyZWdpb25cIik7XG4gICAgaWYgKCFOQU1FU1BBQ0VfUkUudGVzdChuYW1lc3BhY2VPZih2YWx1ZXMpKSkgZmFpbChcIm5hbWVzcGFjZVwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgQ2xvdWRGb3JtYXRpb24tYXBwZW5kZWQgYWNjb3VudC1yZWdpb25hbCBidWNrZXQgc3VmZml4LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzM0FjY291bnRSZWdpb25hbFN1ZmZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICAgIHJldHVybiBgLSR7dmFsdWVzLmFjY291bnR9LSR7dmFsdWVzLnJlZ2lvbn0tYW5gO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBib3VuZCBwcmVmaXggc2hhcmVkIGJ5IGV2ZXJ5IGxvZyBzb3VyY2Ugb2YgdGhlIGFwcC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbG9nU291cmNlUHJlZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGxvZ1ByZWZpeCh2YWx1ZXMpO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hcCBhIGxvZ2ljYWwgbG9nIHNvdXJjZSB0byBpdHMgcGh5c2ljYWwgbG9nLWdyb3VwIG5hbWUuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGxvZ0dyb3VwTmFtZSh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsIGxvZ2ljYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKCFsb2dpY2FsLnN0YXJ0c1dpdGgoXCJsb2dzL1wiKSkgZmFpbChcImxvZyBsb2dpY2FsIG11c3Qgc3RhcnQgd2l0aCBsb2dzL1wiKTtcbiAgICByZXR1cm4gbG9nUHJlZml4KHZhbHVlcykgKyBsb2dpY2FsLnJlcGxhY2UoL1xcLy9nLCBcIl9cIik7XG4gIH1cblxuICAvKipcbiAgICogQ29tcG9zZSB0aGUgcGh5c2ljYWwgbmFtZSBvZiBvbmUgcmVzb3VyY2UuIEEgcGluIGFsd2F5cyB3aW5zLiBBIGdlbmVyYXRlZFxuICAgKiBlbnRyeSBtZWFucyBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgdG9kYXkgYW5kIHRoZSBjb25zdHJ1Y3Qgc2V0c1xuICAgKiBubyBwaHlzaWNhbC1uYW1lIHByb3BlcnR5LiBHZW5lcmF0ZWQgZW50cmllcyBhcmUgbGVnYWN5LW9ubHk7IGEgbGVnYWN5XG4gICAqIHByb2ZpbGUgbmVlZHMgZXhhY3RseSBvbmUgb2YgYSBwaW4gb3IgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHBoeXNpY2FsTmFtZShcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcmVzb3VyY2VUeXBlOiBzdHJpbmcsXG4gICAgbG9naWNhbDogc3RyaW5nLFxuICApOiBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh2YWx1ZXMpO1xuICAgIGlmICghTE9HSUNBTF9SRS50ZXN0KGxvZ2ljYWwpKSBmYWlsKFwibG9naWNhbFwiKTtcbiAgICBjb25zdCBydWxlID0gUlVMRVNbcmVzb3VyY2VUeXBlXTtcbiAgICBpZiAoIXJ1bGUpIGZhaWwoYHJlc291cmNlIHR5cGUgJHtyZXNvdXJjZVR5cGV9YCk7XG4gICAgY29uc3QgZ2VuZXJhdGVkID0gdmFsdWVzLmdlbmVyYXRlZCA/PyBbXTtcbiAgICBjb25zdCBsZWdhY3kgPSAodmFsdWVzLm5hbWluZ1Byb2ZpbGUgPz8gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5ERVJJVkVEKSA9PT0gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5MRUdBQ1k7XG4gICAgaWYgKGdlbmVyYXRlZC5sZW5ndGggPiAwICYmICFsZWdhY3kpIHtcbiAgICAgIGZhaWwoXCJnZW5lcmF0ZWQgZW50cmllcyBhcmUgb25seSB2YWxpZCB1bmRlciB0aGUgbGVnYWN5IG5hbWluZyBwcm9maWxlXCIpO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSBgJHtyZXNvdXJjZVR5cGV9OiR7bG9naWNhbH1gO1xuICAgIGNvbnN0IHBpbiA9IHZhbHVlcy5waW5zPy5ba2V5XTtcbiAgICBjb25zdCBrZWVwR2VuZXJhdGVkID0gZ2VuZXJhdGVkLmluY2x1ZGVzKGtleSk7XG4gICAgLy8gcjMsIEFEVi0xMzEyLTM6IENESyBkZWZhdWx0cyBhbiBBUEkgTmFtZSB0b2RheSwgc28gaXQgaXMgYW4gZXhwbGljaXQgbmFtZVxuICAgIC8vIGFuZCB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAgaWYgKGtlZXBHZW5lcmF0ZWQgJiYgQVBJX1RZUEVTLmhhcyhyZXNvdXJjZVR5cGUpKSB7XG4gICAgICBmYWlsKFwiYW4gQVBJIG5hbWUgdGFrZXMgYSBwaW4sIG5ldmVyIGEgZ2VuZXJhdGVkIGVudHJ5XCIpO1xuICAgIH1cbiAgICBpZiAocGluICE9PSB1bmRlZmluZWQgJiYga2VlcEdlbmVyYXRlZCkgZmFpbChcImEgcmVzb3VyY2UgaGFzIGJvdGggYSBwaW4gYW5kIGEgZ2VuZXJhdGVkIGVudHJ5XCIpO1xuICAgIGlmIChwaW4gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgbmFtZTogcGluLCBwaW5uZWQ6IHRydWUgfTtcbiAgICBpZiAoa2VlcEdlbmVyYXRlZCkgcmV0dXJuIHsgZ2VuZXJhdGVkOiB0cnVlIH07XG4gICAgaWYgKGxlZ2FjeSkge1xuICAgICAgZmFpbChgbGVnYWN5IG5hbWluZyBwcm9maWxlIHJlcXVpcmVzIGEgcGluIG9yIGEgZ2VuZXJhdGVkIGVudHJ5IGZvciAke2tleX1gKTtcbiAgICB9XG5cbiAgICBsZXQgb3V0OiBBcHBUaGVvcnlQaHlzaWNhbE5hbWU7XG4gICAgaWYgKHJ1bGUua2luZCA9PT0gXCJzM2FyXCIpIHtcbiAgICAgIGNvbnN0IHN1ZmZpeCA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnMzQWNjb3VudFJlZ2lvbmFsU3VmZml4KHZhbHVlcyk7XG4gICAgICBjb25zdCBidWRnZXQgPSBydWxlLm1heCAtIHN1ZmZpeC5sZW5ndGg7XG4gICAgICBjb25zdCBwcmVmaXggPSBzaG9ydGVuKGAke3ZhbHVlcy5hcHB9LSR7dmFsdWVzLnN0YWdlfS0ke2xvZ2ljYWwucmVwbGFjZSgvXFwvL2csIFwiLVwiKX1gLCBidWRnZXQpO1xuICAgICAgb3V0ID0geyBuYW1lOiBwcmVmaXggKyBzdWZmaXgsIGJ1Y2tldE5hbWVQcmVmaXg6IHByZWZpeCwgYnVja2V0TmFtZXNwYWNlOiBcImFjY291bnQtcmVnaW9uYWxcIiB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcImRhc2hcIikge1xuICAgICAgb3V0ID0geyBuYW1lOiBzaG9ydGVuKGAke3ZhbHVlcy5hcHB9LSR7dmFsdWVzLnN0YWdlfS0ke2xvZ2ljYWwucmVwbGFjZSgvXFwvL2csIFwiLVwiKX1gLCBydWxlLm1heCkgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJwYXRoXCIpIHtcbiAgICAgIGNvbnN0IGZ1bGwgPSBgJHtydWxlLmxlYWQgPz8gXCJcIn0ke3ZhbHVlcy5hcHB9LyR7dmFsdWVzLnN0YWdlfS8ke2xvZ2ljYWx9YDtcbiAgICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwic2VjcmV0XCIgJiYgU0VDUkVUX1RBSUxfUkUudGVzdChmdWxsKSkge1xuICAgICAgICBmYWlsKFwic2VjcmV0IG5hbWUgbXVzdCBub3QgZW5kIHdpdGggYSBoeXBoZW4gYW5kIHNpeCBjaGFyYWN0ZXJzXCIpO1xuICAgICAgfVxuICAgICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzc21fcGFyYW1ldGVyXCIgJiYgKGZ1bGwubWF0Y2goL1xcLy9nKT8ubGVuZ3RoID8/IDApID4gMTUpIHtcbiAgICAgICAgZmFpbChcInNzbSBoaWVyYXJjaHkgZGVlcGVyIHRoYW4gMTVcIik7XG4gICAgICB9XG4gICAgICBpZiAoZnVsbC5sZW5ndGggPiBydWxlLm1heCkgZmFpbChcInBhdGggbmFtZSBvdmVyIGxpbWl0XCIpO1xuICAgICAgb3V0ID0geyBuYW1lOiBmdWxsIH07XG4gICAgfSBlbHNlIGlmIChydWxlLmtpbmQgPT09IFwibG9nXCIpIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5sb2dHcm91cE5hbWUodmFsdWVzLCBsb2dpY2FsKTtcbiAgICAgIGlmIChuYW1lLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwibG9nIGdyb3VwIG92ZXIgbGltaXRcIik7XG4gICAgICBvdXQgPSB7IG5hbWUgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZmFpbChgdW5zdXBwb3J0ZWQga2luZCAke1N0cmluZyhydWxlLmtpbmQpfWApO1xuICAgIH1cblxuICAgIGNvbnN0IG5hbWUgPSBvdXQubmFtZSBhcyBzdHJpbmc7XG4gICAgaWYgKCFuZXcgUmVnRXhwKGBeKD86JHtydWxlLmNoYXJzZXR9KSskYCkudGVzdChuYW1lKSkgZmFpbChcImNoYXJzZXRcIik7XG4gICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJsZW5ndGhcIik7XG4gICAgaWYgKFtcInMzX2J1Y2tldFwiLCBcInMzX3ZlY3Rvcl9idWNrZXRcIiwgXCJzM192ZWN0b3JfaW5kZXhcIl0uaW5jbHVkZXMocmVzb3VyY2VUeXBlKSAmJiAhUzNfRURHRVNfUkUudGVzdChuYW1lKSkge1xuICAgICAgZmFpbChcInMzIHN0YXJ0L2VuZFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgc2NvcGUgaW4gd2hpY2ggQVdTIHJlcXVpcmVzIGEgdHlwZSdzIG5hbWVzIHRvIGJlIHVuaXF1ZSAoY29udHJhY3RcbiAgICogc2VjdGlvbiAxMS4xKS4gQSB0eXBlIHRoZSBjb250cmFjdCBzdGF0ZXMgbm8gc2NvcGUgZm9yIGlzIHJlZnVzZWQ6IGl0IGNhbm5vdFxuICAgKiBiZSByZXNlcnZlZCwgc28gaXQgY2Fubm90IGJlIGRlcGxveWVkIHRocm91Z2ggdGhlIGluZGV4IHVudGlsIGEgcmV2aXNpb25cbiAgICogc3RhdGVzIGl0cyBzY29wZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbmFtaW5nU2NvcGUocmVzb3VyY2VUeXBlOiBzdHJpbmcpOiBBcHBUaGVvcnlOYW1pbmdTY29wZSB7XG4gICAgaWYgKCEocmVzb3VyY2VUeXBlIGluIFJVTEVTKSkgZmFpbChVTktOT1dOX05BTUlOR19TQ09QRSk7XG4gICAgaWYgKE5PVF9VTklRVUVfVFlQRVMuaGFzKHJlc291cmNlVHlwZSkpIHJldHVybiBBcHBUaGVvcnlOYW1pbmdTY29wZS5OT1RfVU5JUVVFO1xuICAgIGlmIChBQ0NPVU5UX0dMT0JBTF9UWVBFUy5oYXMocmVzb3VyY2VUeXBlKSkgcmV0dXJuIEFwcFRoZW9yeU5hbWluZ1Njb3BlLkFDQ09VTlQ7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU5hbWluZ1Njb3BlLkFDQ09VTlRfUkVHSU9OO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlZnVzZSB0d28gZGlmZmVyZW50IGxvZ2ljYWwgcmVzb3VyY2VzIGluIG9uZSBuYW1pbmcgY29udGV4dCB0aGF0IGRlcml2ZSB0aGVcbiAgICogc2FtZSBuYW1lIGluIHRoZSBzYW1lIG5hbWluZyBzY29wZSwgYW5kIHJldHVybiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0XG4gICAqIChjb250cmFjdCBzZWN0aW9uIDExLjQpLiBBIExhbWJkYSBmdW5jdGlvbiBhbmQgaXRzIElBTSByb2xlIG1heSBzaGFyZSBhIG5hbWVcbiAgICogYmVjYXVzZSB0aGVpciBzY29wZXMgZGlmZmVyLCBhbmQgdHdvIEFQSXMgbWF5IHNoYXJlIG9uZSBiZWNhdXNlIEFXUyBkb2VzIG5vdFxuICAgKiBrZWVwIEFQSSBuYW1lcyB1bmlxdWUuIFJvd3Mga2VlcCB0aGUgb3JkZXIgb2YgdGhlIGVudHJpZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHN5bnRoQ2hlY2soZW50cmllczogQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dFtdKTogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXSB7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgY29uc3QgYXJ0aWZhY3Q6IEFwcFRoZW9yeURlcml2ZWROYW1lW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGNvbnN0IHNjb3BlID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubmFtaW5nU2NvcGUoZW50cnkudHlwZSk7XG4gICAgICBjb25zdCBnZW5lcmF0ZWQgPSBlbnRyeS5nZW5lcmF0ZWQgPT09IHRydWU7XG4gICAgICBhcnRpZmFjdC5wdXNoKHtcbiAgICAgICAgLi4uKGVudHJ5Lm5hbWUgIT09IHVuZGVmaW5lZCAmJiAhZ2VuZXJhdGVkID8geyBuYW1lOiBlbnRyeS5uYW1lIH0gOiB7fSksXG4gICAgICAgIHR5cGU6IGVudHJ5LnR5cGUsXG4gICAgICAgIHNjb3BlLFxuICAgICAgICBsb2dpY2FsSWQ6IGVudHJ5LmxvZ2ljYWxJZCxcbiAgICAgICAgLi4uKGdlbmVyYXRlZCA/IHsgZ2VuZXJhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICAgIGlmIChzY29wZSA9PT0gQXBwVGhlb3J5TmFtaW5nU2NvcGUuTk9UX1VOSVFVRSB8fCBnZW5lcmF0ZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYCR7c2NvcGV9XFx1MDAwMCR7ZW50cnkudHlwZX1cXHUwMDAwJHtlbnRyeS5uYW1lID8/IFwiXCJ9YDtcbiAgICAgIGNvbnN0IGhlbGQgPSBzZWVuLmdldChrZXkpO1xuICAgICAgaWYgKGhlbGQgIT09IHVuZGVmaW5lZCAmJiBoZWxkICE9PSBlbnRyeS5sb2dpY2FsSWQpIHtcbiAgICAgICAgZmFpbChgJHtoZWxkfSBhbmQgJHtlbnRyeS5sb2dpY2FsSWR9IGRlcml2ZSAke2VudHJ5Lm5hbWUgPz8gXCJcIn0gaW4gc2NvcGUgJHtzY29wZX1gKTtcbiAgICAgIH1cbiAgICAgIHNlZW4uc2V0KGtleSwgZW50cnkubG9naWNhbElkKTtcbiAgICB9XG4gICAgcmV0dXJuIGFydGlmYWN0O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgYXMgdGhlIGNsb3VkLWFzc2VtYmx5IG1ldGFkYXRhIGRvY3VtZW50LCB3aXRoIHRoZVxuICAgKiBjb250cmFjdCdzIHNuYWtlX2Nhc2Ugd2lyZSBrZXlzIGFuZCBhIGRldGVybWluaXN0aWMgZW50cnkgb3JkZXIuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGRlcml2ZWROYW1lc0pzb24oYXJ0aWZhY3Q6IEFwcFRoZW9yeURlcml2ZWROYW1lcyk6IHN0cmluZyB7XG4gICAgY29uc3QgZW50cmllcyA9IFsuLi5hcnRpZmFjdC5lbnRyaWVzXVxuICAgICAgLm1hcCgoZW50cnkpID0+ICh7XG4gICAgICAgIC4uLihlbnRyeS5uYW1lICE9PSB1bmRlZmluZWQgJiYgIWVudHJ5LmdlbmVyYXRlZCA/IHsgbmFtZTogZW50cnkubmFtZSB9IDoge30pLFxuICAgICAgICB0eXBlOiBlbnRyeS50eXBlLFxuICAgICAgICBzY29wZTogZW50cnkuc2NvcGUsXG4gICAgICAgIGxvZ2ljYWxfaWQ6IGVudHJ5LmxvZ2ljYWxJZCxcbiAgICAgICAgLi4uKGVudHJ5LmdlbmVyYXRlZCA/IHsgZ2VuZXJhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICB9KSlcbiAgICAgIC5zb3J0KChhLCBiKSA9PiB7XG4gICAgICAgIGNvbnN0IGtleSA9IChyb3c6IHR5cGVvZiBhKTogc3RyaW5nID0+XG4gICAgICAgICAgW3Jvdy5zY29wZSwgcm93LnR5cGUsIHJvdy5uYW1lID8/IFwiXCIsIHJvdy5sb2dpY2FsX2lkXS5qb2luKFwiXFx1MDAwMFwiKTtcbiAgICAgICAgY29uc3QgbGVmdCA9IGtleShhKTtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBrZXkoYik7XG4gICAgICAgIHJldHVybiBsZWZ0IDwgcmlnaHQgPyAtMSA6IGxlZnQgPiByaWdodCA/IDEgOiAwO1xuICAgICAgfSk7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGNvbnRyYWN0OiBhcnRpZmFjdC5jb250cmFjdCxcbiAgICAgIHNjaGVtYTogYXJ0aWZhY3Quc2NoZW1hLFxuICAgICAgY29udGV4dDoge1xuICAgICAgICBuYW1lc3BhY2U6IGFydGlmYWN0LmNvbnRleHQubmFtZXNwYWNlID8/IExPR19QUkVGSVgsXG4gICAgICAgIGFwcDogYXJ0aWZhY3QuY29udGV4dC5hcHAsXG4gICAgICAgIHN0YWdlOiBhcnRpZmFjdC5jb250ZXh0LnN0YWdlLFxuICAgICAgICBhY2NvdW50OiBhcnRpZmFjdC5jb250ZXh0LmFjY291bnQsXG4gICAgICAgIHJlZ2lvbjogYXJ0aWZhY3QuY29udGV4dC5yZWdpb24sXG4gICAgICB9LFxuICAgICAgZW50cmllcyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSBvbmUgc2VsZWN0b3IuIFRocm93cyBvbiBhIHNlbGVjdG9yIG91dHNpZGUgdGhlIGdyYW1tYXIuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlU2VsZWN0b3Ioc2VsZWN0b3I6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGJhc2UgPSBzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpID8gc2VsZWN0b3Iuc2xpY2UoMCwgLTIpIDogc2VsZWN0b3I7XG4gICAgaWYgKCFMT0dJQ0FMX1JFLnRlc3QoYmFzZSkgfHwgYmFzZS5zcGxpdChcIi9cIilbMF0gIT09IFwibG9nc1wiIHx8IChiYXNlID09PSBcImxvZ3NcIiAmJiAhc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSkpIHtcbiAgICAgIGZhaWwoYHNlbGVjdG9yICR7c2VsZWN0b3J9YCk7XG4gICAgfVxuICAgIGlmIChiYXNlLmluY2x1ZGVzKFwiKlwiKSkgZmFpbChcIndpbGRjYXJkIG9ubHkgYXMgdHJhaWxpbmcgLypcIik7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBhIHNlbGVjdG9yIG1hdGNoZXMgYSBsb2dpY2FsIHNvdXJjZS4gQSB0cmFpbGluZyBgLypgIG1hdGNoZXNcbiAgICogZGVzY2VuZGFudHMgb25seS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yOiBzdHJpbmcsIGxvZ2ljYWw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGlmIChzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSByZXR1cm4gbG9naWNhbC5zdGFydHNXaXRoKHNlbGVjdG9yLnNsaWNlKDAsIC0xKSk7XG4gICAgcmV0dXJuIGxvZ2ljYWwgPT09IHNlbGVjdG9yO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgYSBzb3VyY2UgaXMgdmlzaWJsZTogYW4gaW5jbHVkZSBtYXRjaGVzIGFuZCBubyBleGNsdWRlIGRvZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHNvdXJjZVZpc2libGUocnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcywgbG9naWNhbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgaW5jbHVkZWQgPSAocnVsZXMuaW5jbHVkZSA/PyBbXSkuc29tZSgoc2VsZWN0b3IpID0+IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNlbGVjdG9yTWF0Y2hlcyhzZWxlY3RvciwgbG9naWNhbCkpO1xuICAgIGlmICghaW5jbHVkZWQpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gIShydWxlcy5leGNsdWRlID8/IFtdKS5zb21lKChzZWxlY3RvcikgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yLCBsb2dpY2FsKSk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGZpcnN0IDEyIGhleCBjaGFyYWN0ZXJzIG9mIFNIQS0yNTYgb3ZlciB0aGUgY2Fub25pY2FsIHJ1bGVzLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBydWxlVmVyc2lvbihydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzKTogc3RyaW5nIHtcbiAgICBjb25zdCBjYW5vbmljYWwgPSBge1wiZXhjbHVkZVwiOiR7SlNPTi5zdHJpbmdpZnkoc29ydGVkQ29weShydWxlcy5leGNsdWRlKSl9LFwiaW5jbHVkZVwiOiR7SlNPTi5zdHJpbmdpZnkoc29ydGVkQ29weShydWxlcy5pbmNsdWRlKSl9fWA7XG4gICAgcmV0dXJuIHNoYTI1NkhleChjYW5vbmljYWwpLnNsaWNlKDAsIDEyKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21waWxlIHRoZSBydWxlcyBpbnRvIHRoZSByZWFkZXItcm9sZSBpbmxpbmUgcG9saWN5IGRvY3VtZW50LiBUaGUgcmV0dXJuXG4gICAqIHZhbHVlIGlzIHRoZSBjb250cmFjdCBKU09OLCBzbyBhIGNvbnN1bWVyIGNhbiBjb21wYXJlIGl0IGJ5dGUgZm9yIGJ5dGUuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGNvbXBpbGVWaXNpYmlsaXR5UG9saWN5SnNvbihcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIFsuLi4ocnVsZXMuaW5jbHVkZSA/PyBbXSksIC4uLihydWxlcy5leGNsdWRlID8/IFtdKV0pIHtcbiAgICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuICAgIH1cbiAgICBjb25zdCBiYXNlID0gYGFybjphd3M6bG9nczoke3ZhbHVlcy5yZWdpb259OiR7dmFsdWVzLmFjY291bnR9OmxvZy1ncm91cDpgO1xuICAgIGNvbnN0IGFybnNGb3IgPSAoc2VsZWN0b3I6IHN0cmluZyk6IHN0cmluZ1tdID0+IHtcbiAgICAgIGlmIChzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICAgIHJldHVybiBbYmFzZSArIGxvZ1ByZWZpeCh2YWx1ZXMpICsgc2VsZWN0b3Iuc2xpY2UoMCwgLTEpLnJlcGxhY2UoL1xcLy9nLCBcIl9cIikgKyBcIipcIl07XG4gICAgICB9XG4gICAgICBjb25zdCBuYW1lID0gbG9nUHJlZml4KHZhbHVlcykgKyBzZWxlY3Rvci5yZXBsYWNlKC9cXC8vZywgXCJfXCIpO1xuICAgICAgcmV0dXJuIFtiYXNlICsgbmFtZSwgYmFzZSArIG5hbWUgKyBcIjoqXCJdO1xuICAgIH07XG4gICAgY29uc3QgYWN0aW9ucyA9IFsuLi5LRUVQRVJfQUNUSU9OU19HUk9VUCwgLi4uS0VFUEVSX0FDVElPTlNfU1RSRUFNXTtcbiAgICBjb25zdCBzdGF0ZW1lbnRzOiB7IFNpZDogc3RyaW5nOyBFZmZlY3Q6IHN0cmluZzsgQWN0aW9uOiBzdHJpbmdbXTsgUmVzb3VyY2U6IHN0cmluZ1tdIH1bXSA9IFtcbiAgICAgIHtcbiAgICAgICAgU2lkOiBcIlJlYWRNYW5pZmVzdFwiLFxuICAgICAgICBFZmZlY3Q6IFwiQWxsb3dcIixcbiAgICAgICAgQWN0aW9uOiBbXCJzc206R2V0UGFyYW1ldGVyXCJdLFxuICAgICAgICBSZXNvdXJjZTogW1xuICAgICAgICAgIGBhcm46YXdzOnNzbToke3ZhbHVlcy5yZWdpb259OiR7dmFsdWVzLmFjY291bnR9OnBhcmFtZXRlci8ke0xPR19QUkVGSVh9L3Zpc2liaWxpdHkvJHt2YWx1ZXMuYXBwfS8ke3ZhbHVlcy5zdGFnZX0vbWFuaWZlc3RgLFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGNvbnN0IGluY2x1ZGVkID0gc29ydGVkQ29weShydWxlcy5pbmNsdWRlKS5mbGF0TWFwKGFybnNGb3IpO1xuICAgIGNvbnN0IGV4Y2x1ZGVkID0gc29ydGVkQ29weShydWxlcy5leGNsdWRlKS5mbGF0TWFwKGFybnNGb3IpO1xuICAgIGlmIChpbmNsdWRlZC5sZW5ndGggPiAwKSBzdGF0ZW1lbnRzLnB1c2goeyBTaWQ6IFwiUmVhZEluY2x1ZGVkXCIsIEVmZmVjdDogXCJBbGxvd1wiLCBBY3Rpb246IGFjdGlvbnMsIFJlc291cmNlOiBpbmNsdWRlZCB9KTtcbiAgICBpZiAoZXhjbHVkZWQubGVuZ3RoID4gMCkgc3RhdGVtZW50cy5wdXNoKHsgU2lkOiBcIkRlbnlFeGNsdWRlZFwiLCBFZmZlY3Q6IFwiRGVueVwiLCBBY3Rpb246IGFjdGlvbnMsIFJlc291cmNlOiBleGNsdWRlZCB9KTtcbiAgICBjb25zdCBkb2N1bWVudCA9IEpTT04uc3RyaW5naWZ5KHsgVmVyc2lvbjogXCIyMDEyLTEwLTE3XCIsIFN0YXRlbWVudDogc3RhdGVtZW50cyB9KTtcbiAgICBpZiAoZG9jdW1lbnQubGVuZ3RoID4gUk9MRV9QT0xJQ1lfTUFYKSBmYWlsKFwiY29tcGlsZWQgcG9saWN5IG92ZXIgcm9sZSBwb2xpY3kgc2l6ZVwiKTtcbiAgICByZXR1cm4gZG9jdW1lbnQ7XG4gIH1cblxuICAvKipcbiAgICogQXNzZW1ibGUgdGhlIHN5bnRoLXRpbWUgdmlzaWJpbGl0eSBwcmV2aWV3LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2aXNpYmlsaXR5UHJldmlldyhcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBzb3VyY2VzOiBzdHJpbmdbXSxcbiAgKTogQXBwVGhlb3J5VmlzaWJpbGl0eVByZXZpZXcge1xuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh2YWx1ZXMpO1xuICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgWy4uLihydWxlcy5pbmNsdWRlID8/IFtdKSwgLi4uKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pXSkge1xuICAgICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBydWxlVmVyc2lvbjogQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcucnVsZVZlcnNpb24ocnVsZXMpLFxuICAgICAgbWF0Y2hlZE5vdzogc291cmNlcy5maWx0ZXIoKHNvdXJjZSkgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgc291cmNlKSkuc29ydCgpLFxuICAgICAgbm90TWF0Y2hlZE5vdzogc291cmNlcy5maWx0ZXIoKHNvdXJjZSkgPT4gIUFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIHNvdXJjZSkpLnNvcnQoKSxcbiAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpLCBleGNsdWRlOiBzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBc3NlbWJsZSB0aGUgcHVibGlzaGVkIG1hbmlmZXN0ICh0aGUgcHJldmlldyBtaW51cyBgbm90TWF0Y2hlZE5vd2ApLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2aXNpYmlsaXR5TWFuaWZlc3QoXG4gICAgdmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICAgc291cmNlczogc3RyaW5nW10sXG4gICk6IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdCB7XG4gICAgY29uc3QgcHJldmlldyA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZpc2liaWxpdHlQcmV2aWV3KHZhbHVlcywgcnVsZXMsIHNvdXJjZXMpO1xuICAgIHJldHVybiB7IHJ1bGVWZXJzaW9uOiBwcmV2aWV3LnJ1bGVWZXJzaW9uLCBtYXRjaGVkTm93OiBwcmV2aWV3Lm1hdGNoZWROb3csIGZ1dHVyZTogcHJldmlldy5mdXR1cmUgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXJpYWxpemUgYSBtYW5pZmVzdCB0byB0aGUgY29udHJhY3QgSlNPTiBzaGFwZSB3cml0dGVuIHRvIFNTTS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbWFuaWZlc3RKc29uKG1hbmlmZXN0OiBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3QpOiBzdHJpbmcge1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBydWxlX3ZlcnNpb246IG1hbmlmZXN0LnJ1bGVWZXJzaW9uLFxuICAgICAgbWF0Y2hlZF9ub3c6IG1hbmlmZXN0Lm1hdGNoZWROb3csXG4gICAgICBmdXR1cmU6IHsgaW5jbHVkZTogbWFuaWZlc3QuZnV0dXJlLmluY2x1ZGUgPz8gW10sIGV4Y2x1ZGU6IG1hbmlmZXN0LmZ1dHVyZS5leGNsdWRlID8/IFtdIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogS2VlcGVyJ3MgcmVhZCBkZWNpc2lvbiwgaW4gdGhlIHJ1bnRpbWVzJyBwYXJhbWV0ZXIgb3JkZXIuIEZhaWxzIGNsb3NlZCBvbiBhXG4gICAqIGRlbmlhbCBvciBhbiB1bnJlYWNoYWJsZSBhY2NvdW50LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBrZWVwZXJEZWNpc2lvbihcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIGxvZ2ljYWw6IHN0cmluZyxcbiAgICBhd3NSZXN1bHQ6IHN0cmluZyxcbiAgKTogQXBwVGhlb3J5S2VlcGVyQW5zd2VyIHtcbiAgICBpZiAoIXJ1bGVzIHx8ICFBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBsb2dpY2FsKSkge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5OT1RfU0hBUkVEO1xuICAgIH1cbiAgICBpZiAoYXdzUmVzdWx0ID09PSBcImV2ZW50c1wiKSByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLkVWRU5UUztcbiAgICBpZiAoYXdzUmVzdWx0ID09PSBcImVtcHR5XCIgfHwgYXdzUmVzdWx0ID09PSBcIm5vdF9mb3VuZFwiKSByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLkFMTE9XRURfTk9fRVZFTlRTO1xuICAgIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuTk9UX1NIQVJFRDtcbiAgfVxufVxuIl19