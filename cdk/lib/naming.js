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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekM7O0dBRUc7QUFDVSxRQUFBLHdCQUF3QixHQUFHLGtDQUFrQyxDQUFDO0FBRTNFOztHQUVHO0FBQ1UsUUFBQSxvQkFBb0IsR0FBRyw0Q0FBNEMsQ0FBQztBQUVqRjs7O0dBR0c7QUFDVSxRQUFBLDBCQUEwQixHQUFHLHlDQUF5QyxDQUFDO0FBRXBGOztHQUVHO0FBQ0gsSUFBWSxzQkFTWDtBQVRELFdBQVksc0JBQXNCO0lBQ2hDOztPQUVHO0lBQ0gsNkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCwyQ0FBaUIsQ0FBQTtBQUNuQixDQUFDLEVBVFcsc0JBQXNCLHNDQUF0QixzQkFBc0IsUUFTakM7QUFFRDs7R0FFRztBQUNILElBQVksdUJBU1g7QUFURCxXQUFZLHVCQUF1QjtJQUNqQzs7T0FFRztJQUNILGdEQUFxQixDQUFBO0lBQ3JCOztPQUVHO0lBQ0gsNENBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBU2xDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHFCQWFYO0FBYkQsV0FBWSxxQkFBcUI7SUFDL0I7O09BRUc7SUFDSCwwQ0FBaUIsQ0FBQTtJQUNqQjs7T0FFRztJQUNILGdFQUF1QyxDQUFBO0lBQ3ZDOztPQUVHO0lBQ0gsa0RBQXlCLENBQUE7QUFDM0IsQ0FBQyxFQWJXLHFCQUFxQixxQ0FBckIscUJBQXFCLFFBYWhDO0FBK0xEOztHQUVHO0FBQ0gsSUFBWSxvQkFhWDtBQWJELFdBQVksb0JBQW9CO0lBQzlCOztPQUVHO0lBQ0gsMkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCx5REFBaUMsQ0FBQTtJQUNqQzs7T0FFRztJQUNILGlEQUF5QixDQUFBO0FBQzNCLENBQUMsRUFiVyxvQkFBb0Isb0NBQXBCLG9CQUFvQixRQWEvQjtBQWdFRCxNQUFN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UUFDaEUsSUFBSSxTQUFTLEtBQUssT0FBTyxJQUFJLFNBQVMsS0FBSyxXQUFXO1lBQUUsT0FBTyxxQkFBcUIsQ0FBQyxpQkFBaUIsQ0FBQztRQUN2RyxPQUFPLHFCQUFxQixDQUFDLFVBQVUsQ0FBQztJQUMxQyxDQUFDOztBQTlUSCwwREErVEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbi8qKlxuICogVGhlIHJlc291cmNlLW5hbWluZyBjb250cmFjdCB0aGlzIG1vZHVsZSBpbXBsZW1lbnRzLlxuICovXG5leHBvcnQgY29uc3QgUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNUID0gXCJ0aGVvcnljbG91ZF9yZXNvdXJjZV9uYW1pbmcudjAuMVwiO1xuXG4vKipcbiAqIFRoZSBzY2hlbWEgaWRlbnRpZmllciBvZiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGEgbmFtaW5nIGNvbnRleHQgZW1pdHMuXG4gKi9cbmV4cG9ydCBjb25zdCBERVJJVkVEX05BTUVTX1NDSEVNQSA9IFwiYXBwdGhlb3J5X3Jlc291cmNlX25hbWluZy5kZXJpdmVkX25hbWVzLnYxXCI7XG5cbi8qKlxuICogVGhlIGNsb3VkLWFzc2VtYmx5IG1ldGFkYXRhIHR5cGUgdGhhdCBjYXJyaWVzIHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QuIFRoZVxuICogYXJ0aWZhY3QgbGFuZHMgaW4gYHtzdGFja30ubWV0YWRhdGEuanNvbmAgaW4gYGNkay5vdXRgLlxuICovXG5leHBvcnQgY29uc3QgREVSSVZFRF9OQU1FU19NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTpyZXNvdXJjZS1uYW1pbmcvZGVyaXZlZC1uYW1lc1wiO1xuXG4vKipcbiAqIE5hbWluZyBwcm9maWxlcyBhY2NlcHRlZCBieSBhIG5hbWluZyBjb250ZXh0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlIHtcbiAgLyoqXG4gICAqIE5hbWVzIGRlcml2ZSBmcm9tIHRoZSBuYW1pbmcgY29udGV4dC5cbiAgICovXG4gIERFUklWRUQgPSBcImRlcml2ZWRcIixcbiAgLyoqXG4gICAqIEV2ZXJ5IG5hbWUgY29tZXMgZnJvbSBhIHBpbi5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG59XG5cbi8qKlxuICogTG9nZ2luZyBwcm9maWxlcyBhY2NlcHRlZCBieSBhIG5hbWluZyBjb250ZXh0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZSB7XG4gIC8qKlxuICAgKiBBcHBUaGVvcnkgY3JlYXRlcyBzdGFuZGFyZCBsb2cgZ3JvdXBzIGFuZCBhY2Nlc3MgbG9nZ2luZy5cbiAgICovXG4gIFNUQU5EQVJEID0gXCJzdGFuZGFyZFwiLFxuICAvKipcbiAgICogRWFjaCBjb25zdHJ1Y3Qga2VlcHMgaXRzIHByZS1jb250cmFjdCBsb2dnaW5nIGJlaGF2aW91ci5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG59XG5cbi8qKlxuICogS2VlcGVyJ3MgYW5zd2VyIHRvIGEgcmVhZGVyIHJlcXVlc3QuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUtlZXBlckFuc3dlciB7XG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIHNoYXJlZCBhbmQgdGhlIHJlYWQgcmV0dXJuZWQgZXZlbnRzLlxuICAgKi9cbiAgRVZFTlRTID0gXCJldmVudHNcIixcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgc2hhcmVkIGFuZCB0aGUgcmVhZCByZXR1cm5lZCBubyBldmVudHMuXG4gICAqL1xuICBBTExPV0VEX05PX0VWRU5UUyA9IFwiYWxsb3dlZF9ub19ldmVudHNcIixcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgbm90IHNoYXJlZCwgb3IgdGhlIHJlYWQgZmFpbGVkIGNsb3NlZC5cbiAgICovXG4gIE5PVF9TSEFSRUQgPSBcIm5vdF9zaGFyZWRcIixcbn1cblxuLyoqXG4gKiBCb3VuZCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dCB2YWx1ZXMgZnJvbSBzdGFnZSBjb25maWcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICogQGRlZmF1bHQgXCJ0aGVvcnljbG91ZFwiXG4gICAqL1xuICByZWFkb25seSBuYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFwcCBpbnN0YW5jZSBpZC5cbiAgICovXG4gIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZC5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFR3ZWx2ZS1kaWdpdCBhY2NvdW50IGlkLiBBbiB1bnJlc29sdmVkIHRva2VuIGZhaWxzIHN5bnRoZXNpcy5cbiAgICovXG4gIHJlYWRvbmx5IGFjY291bnQ6IHN0cmluZztcblxuICAvKipcbiAgICogRnVsbCBSZWdpb24gY29kZSwgZm9yIGV4YW1wbGUgYHVzLWVhc3QtMWAuXG4gICAqL1xuICByZWFkb25seSByZWdpb246IHN0cmluZztcblxuICAvKipcbiAgICogUGh5c2ljYWwgcGlucyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuXG4gICAqIEBkZWZhdWx0IHt9XG4gICAqL1xuICByZWFkb25seSBwaW5zPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAvKipcbiAgICogR2VuZXJhdGVkLW5hbWUgZW50cmllcyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuIEFuIGVudHJ5IG1lYW5zXG4gICAqIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSB0b2RheSwgc28gdGhlIGNvbnN0cnVjdCBzZXRzIG5vXG4gICAqIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkuIFZhbGlkIG9ubHkgdW5kZXIgdGhlIGxlZ2FjeSBuYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBOYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5ERVJJVkVEXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdQcm9maWxlPzogQXBwVGhlb3J5TmFtaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nZ2luZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZS5MRUdBQ1lcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2dpbmdQcm9maWxlPzogQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZyByZXRlbnRpb24gaW4gZGF5cyBmb3Igc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXBzLlxuICAgKiBAZGVmYXVsdCAzMFxuICAgKi9cbiAgcmVhZG9ubHkgcmV0ZW50aW9uRGF5cz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBUaGUgY29tcG9zZWQgcGh5c2ljYWwgbmFtZSBvZiBvbmUgcmVzb3VyY2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UGh5c2ljYWxOYW1lIHtcbiAgLyoqXG4gICAqIFRoZSBmdWxsIHBoeXNpY2FsIG5hbWUuIEFic2VudCB3aGVuIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYWNjb3VudC1yZWdpb25hbCBidWNrZXQtbmFtZSBwcmVmaXgsIHdoZW4gdGhlIHR5cGUgdXNlcyBvbmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYnVja2V0TmFtZVByZWZpeD86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGJ1Y2tldCBuYW1lc3BhY2UsIHdoZW4gdGhlIHR5cGUgdXNlcyBvbmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYnVja2V0TmFtZXNwYWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBuYW1lIGNhbWUgZnJvbSBhIHBpbi5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHBpbm5lZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lLCBzbyBubyBwaHlzaWNhbC1uYW1lIHByb3BlcnR5IGlzXG4gICAqIHNldC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogT25lIHBoeXNpY2FsbHkgbmFtZWQgcmVzb3VyY2UgYSBzdGFjayBkZWNsYXJlcywgYXMgdGhlIHN5bnRoIGNoZWNrIChjb250cmFjdFxuICogc2VjdGlvbiAxMS40KSBjb25zdW1lcyBpdC4gQSBnZW5lcmF0ZWQgZW50cnkgY2FycmllcyBubyBuYW1lOiBDbG91ZEZvcm1hdGlvblxuICogb3ducyB0aGUgbmFtZSwgc28gdGhlcmUgaXMgbm90aGluZyB0byByZXNlcnZlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXQge1xuICAvKipcbiAgICogVGhlIHBoeXNpY2FsIG5hbWUuIEFic2VudCBmb3IgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IHJlc291cmNlIHR5cGUsIGZvciBleGFtcGxlIGBsYW1iZGFfZnVuY3Rpb25gLlxuICAgKi9cbiAgcmVhZG9ubHkgdHlwZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgQ2xvdWRGb3JtYXRpb24gbG9naWNhbCBpZCBvZiB0aGUgcmVzb3VyY2UgY2FycnlpbmcgdGhlIG5hbWUuXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsSWQ6IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUsIHNvIG5vdGhpbmcgaXMgcmVzZXJ2ZWQuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9uZSByb3cgb2YgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdDogdGhlIGNvbXBsZXRlIHNldCB0aGUgbmFtZSByZXNlcnZhdGlvblxuICogaW5kZXggKGNvbnRyYWN0IHNlY3Rpb24gMTEuMikgcmVzZXJ2ZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RGVyaXZlZE5hbWUge1xuICAvKipcbiAgICogVGhlIHBoeXNpY2FsIG5hbWUuIEFic2VudCBmb3IgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IHJlc291cmNlIHR5cGUuXG4gICAqL1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBzY29wZSBpbiB3aGljaCBBV1MgcmVxdWlyZXMgdGhlIG5hbWUgdG8gYmUgdW5pcXVlOiBgYWNjb3VudGAsXG4gICAqIGBhY2NvdW50X3JlZ2lvbmAsIG9yIGBub3RfdW5pcXVlYC5cbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxJZDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSwgc28gbm90aGluZyBpcyByZXNlcnZlZC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogVGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBhIG5hbWluZyBjb250ZXh0IGVtaXRzIGF0IHN5bnRoZXNpcyAoY29udHJhY3RcbiAqIHNlY3Rpb24gMTEuNCksIGtleWVkIGB7c3RhY2t9Lm1ldGFkYXRhLmpzb25gIGluIHRoZSBjbG91ZCBhc3NlbWJseS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlEZXJpdmVkTmFtZXMge1xuICAvKipcbiAgICogVGhlIGNvbnRyYWN0IGlkZW50aWZpZXIuXG4gICAqL1xuICByZWFkb25seSBjb250cmFjdDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYXJ0aWZhY3Qgc2NoZW1hIGlkZW50aWZpZXIuXG4gICAqL1xuICByZWFkb25seSBzY2hlbWE6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5hbWluZyBjb250ZXh0IHRoYXQgcHJvZHVjZWQgdGhlIGFydGlmYWN0LlxuICAgKi9cbiAgcmVhZG9ubHkgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcztcblxuICAvKipcbiAgICogRXZlcnkgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSB0aGUgY29udGV4dCBkZWNsYXJlcywgc29ydGVkIGJ5IGBzY29wZWAsXG4gICAqIGB0eXBlYCwgYG5hbWVgIGFuZCBgbG9naWNhbElkYC5cbiAgICovXG4gIHJlYWRvbmx5IGVudHJpZXM6IEFwcFRoZW9yeURlcml2ZWROYW1lW107XG59XG5cbi8qKlxuICogVGhlIG5hbWluZyBzY29wZXMgb2YgY29udHJhY3Qgc2VjdGlvbiAxMS4xLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlOYW1pbmdTY29wZSB7XG4gIC8qKlxuICAgKiBBV1Mga2VlcHMgdGhlIG5hbWUgdW5pcXVlIGFjcm9zcyB0aGUgd2hvbGUgYWNjb3VudCwgd2hhdGV2ZXIgdGhlIFJlZ2lvbi5cbiAgICovXG4gIEFDQ09VTlQgPSBcImFjY291bnRcIixcbiAgLyoqXG4gICAqIEFXUyBrZWVwcyB0aGUgbmFtZSB1bmlxdWUgcGVyIGFjY291bnQgYW5kIFJlZ2lvbi5cbiAgICovXG4gIEFDQ09VTlRfUkVHSU9OID0gXCJhY2NvdW50X3JlZ2lvblwiLFxuICAvKipcbiAgICogQVdTIGRvZXMgbm90IGtlZXAgdGhlIG5hbWUgdW5pcXVlLCBzbyBub3RoaW5nIGlzIHJlc2VydmVkIGZvciBpdC5cbiAgICovXG4gIE5PVF9VTklRVUUgPSBcIm5vdF91bmlxdWVcIixcbn1cblxuLyoqXG4gKiBJbmNsdWRlIGFuZCBleGNsdWRlIHZpc2liaWxpdHkgc2VsZWN0b3JzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyB7XG4gIC8qKlxuICAgKiBTZWxlY3RvcnMgd2hvc2Ugc291cmNlcyBhcmUgc2hhcmVkLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgaW5jbHVkZT86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBTZWxlY3RvcnMgd2hvc2Ugc291cmNlcyBhcmUgbmV2ZXIgc2hhcmVkLiBFeGNsdXNpb25zIHdpbi5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGV4Y2x1ZGU/OiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBUaGUgc3ludGgtdGltZSB2aXNpYmlsaXR5IHByZXZpZXcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eVByZXZpZXcge1xuICAvKipcbiAgICogRmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgdGhlIGNhbm9uaWNhbCBydWxlcyBoYXNoLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIGRvIG5vdCBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG5vdE1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgc2VsZWN0b3JzLCBhcyB0aGUgc3RhdGVtZW50IG9mIHdoYXQgZnV0dXJlIHNvdXJjZXMgd2lsbCBtYXRjaC5cbiAgICovXG4gIHJlYWRvbmx5IGZ1dHVyZTogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xufVxuXG4vKipcbiAqIFRoZSBwdWJsaXNoZWQgU1NNIG1hbmlmZXN0OiB0aGUgcHJldmlldyBtaW51cyBgbm90TWF0Y2hlZE5vd2AuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0IHtcbiAgLyoqXG4gICAqIEZpcnN0IDEyIGhleCBjaGFyYWN0ZXJzIG9mIHRoZSBjYW5vbmljYWwgcnVsZXMgaGFzaC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bGVWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgc2hhcmUuXG4gICAqL1xuICByZWFkb25seSBtYXRjaGVkTm93OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIHNlbGVjdG9ycywgYXMgdGhlIHN0YXRlbWVudCBvZiB3aGF0IGZ1dHVyZSBzb3VyY2VzIHdpbGwgbWF0Y2guXG4gICAqL1xuICByZWFkb25seSBmdXR1cmU6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcztcbn1cblxuY29uc3QgU0VHTUVOVF9QQVRURVJOID0gXCJbYS16MC05XSsoPzotW2EtejAtOV0rKSpcIjtcbmNvbnN0IExPR0lDQUxfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59KD86LyR7U0VHTUVOVF9QQVRURVJOfSkqJGApO1xuY29uc3QgQVBQX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSRgKTtcbmNvbnN0IFNUQUdFX1JFID0gL15bYS16XVthLXowLTldezAsN30kLztcbmNvbnN0IE5BTUVTUEFDRV9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0kYCk7XG5jb25zdCBBQ0NPVU5UX1JFID0gL15bMC05XXsxMn0kLztcbmNvbnN0IFJFR0lPTl9SRSA9IC9eW2Etel17Mn0oPzotW2Etel0rKSstWzAtOV0kLztcbmNvbnN0IFNFQ1JFVF9UQUlMX1JFID0gLy1bQS1aYS16MC05XXs2fSQvO1xuY29uc3QgUzNfRURHRVNfUkUgPSAvXlthLXowLTldLipbYS16MC05XSQvO1xuY29uc3QgTE9HX1BSRUZJWCA9IFwidGhlb3J5Y2xvdWRcIjtcbmNvbnN0IFJPTEVfUE9MSUNZX01BWCA9IDEwMjQwO1xuY29uc3QgQkFTRTMyID0gXCJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejIzNDU2N1wiO1xuXG5pbnRlcmZhY2UgUnVsZSB7XG4gIHJlYWRvbmx5IGtpbmQ6IFwiZGFzaFwiIHwgXCJwYXRoXCIgfCBcInMzYXJcIiB8IFwibG9nXCI7XG4gIHJlYWRvbmx5IG1heDogbnVtYmVyO1xuICByZWFkb25seSBjaGFyc2V0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGxlYWQ/OiBzdHJpbmc7XG59XG5cbmNvbnN0IFJVTEVTOiB7IFt0eXBlOiBzdHJpbmddOiBSdWxlIH0gPSB7XG4gIHMzX2J1Y2tldDogeyBraW5kOiBcInMzYXJcIiwgbWF4OiA2MywgY2hhcnNldDogXCJbYS16MC05LV1cIiB9LFxuICBzM192ZWN0b3JfYnVja2V0OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIHMzX3ZlY3Rvcl9pbmRleDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MywgY2hhcnNldDogXCJbYS16MC05LV1cIiB9LFxuICBkeW5hbW9kYl90YWJsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8uLV1cIiB9LFxuICBsYW1iZGFfZnVuY3Rpb246IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIHNxc19xdWV1ZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA4MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc25zX3RvcGljOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc2VjcmV0OiB7IGtpbmQ6IFwicGF0aFwiLCBtYXg6IDUxMiwgY2hhcnNldDogXCJbQS1aYS16MC05L18rPS5ALV1cIiB9LFxuICBzc21fcGFyYW1ldGVyOiB7IGtpbmQ6IFwicGF0aFwiLCBtYXg6IDkwMCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4vLV1cIiwgbGVhZDogXCIvXCIgfSxcbiAga21zX2FsaWFzOiB7IGtpbmQ6IFwicGF0aFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05L18tXVwiLCBsZWFkOiBcImFsaWFzL1wiIH0sXG4gIGV2ZW50X2J1czogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTYsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBldmVudF9ydWxlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkuXy1dXCIgfSxcbiAgc2NoZWR1bGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBhbGFybTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8uLV1cIiB9LFxuICBkYXNoYm9hcmQ6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU1LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBpYW1fcm9sZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Kz0sLkBfLV1cIiB9LFxuICBpYW1fbWFuYWdlZF9wb2xpY3k6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTI4LCBjaGFyc2V0OiBcIltBLVphLXowLTkrPSwuQF8tXVwiIH0sXG4gIHN0YXRlX21hY2hpbmU6IHsga2luZDogXCJkYXNoXCIsIG1heDogODAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGNvZGVidWlsZF9wcm9qZWN0OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDE1MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgYXBpX3Jlc3Q6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTI4LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfaHR0cDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV93ZWJzb2NrZXQ6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTI4LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBsb2dfZGVsaXZlcnlfc291cmNlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBsb2dfZGVsaXZlcnlfZGVzdGluYXRpb246IHsga2luZDogXCJkYXNoXCIsIG1heDogNjAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19ncm91cDogeyBraW5kOiBcImxvZ1wiLCBtYXg6IDUxMiwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbn07XG5cbi8qKlxuICogVGhlIHJ1bGVzIG9mIG9uZSBjb250cmFjdCB0eXBlLCBvciBgdW5kZWZpbmVkYCB3aGVuIHRoZSBjb250cmFjdCBzdGF0ZXMgbm9uZVxuICogKGNvbnRyYWN0IHNlY3Rpb24gMikuIFRoZSBsb29rdXAgaXMgYW4gb3duLXByb3BlcnR5IGNoZWNrLCBzbyBhbiBpbmhlcml0ZWRcbiAqIG5hbWUgc3VjaCBhcyBgY29uc3RydWN0b3JgLCBgdG9TdHJpbmdgLCBgX19wcm90b19fYCBvciBgaGFzT3duUHJvcGVydHlgIGlzIGFuXG4gKiB1bmtub3duIHR5cGUsIG5ldmVyIGEgdHlwZSB3aXRoIHJ1bGVzLlxuICovXG5mdW5jdGlvbiBuYW1pbmdSdWxlKHJlc291cmNlVHlwZTogc3RyaW5nKTogUnVsZSB8IHVuZGVmaW5lZCB7XG4gIGlmICghT2JqZWN0Lmhhc093bihSVUxFUywgcmVzb3VyY2VUeXBlKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIFJVTEVTW3Jlc291cmNlVHlwZV07XG59XG5cbi8qKlxuICogQVBJIG5hbWUgdHlwZXMuIFRoZSBDREsgZGVmYXVsdHMgYW4gQVBJIE5hbWUgdG9kYXksIHNvIGEgbmFtZSBmb3Igb25lIGlzXG4gKiBleHBsaWNpdCBhbmQgdGFrZXMgYSBwaW4sIG5ldmVyIGEgZ2VuZXJhdGVkIGVudHJ5IChyMywgQURWLTEzMTItMykuXG4gKi9cbmNvbnN0IEFQSV9UWVBFUyA9IG5ldyBTZXQoW1wiYXBpX3Jlc3RcIiwgXCJhcGlfaHR0cFwiLCBcImFwaV93ZWJzb2NrZXRcIl0pO1xuXG4vKipcbiAqIFR5cGVzIEFXUyBrZWVwcyB1bmlxdWUgYWNyb3NzIFJlZ2lvbnMgKGNvbnRyYWN0IHNlY3Rpb24gMTEuMSkuXG4gKi9cbmNvbnN0IEFDQ09VTlRfR0xPQkFMX1RZUEVTID0gbmV3IFNldChbXCJpYW1fcm9sZVwiLCBcImlhbV9tYW5hZ2VkX3BvbGljeVwiLCBcImRhc2hib2FyZFwiXSk7XG5cbi8qKlxuICogQVBJIGRpc3BsYXkgbmFtZXMgQVdTIGRvZXMgbm90IGtlZXAgdW5pcXVlLCBzbyBub3RoaW5nIGlzIHJlc2VydmVkIGZvciB0aGVtLlxuICovXG5jb25zdCBOT1RfVU5JUVVFX1RZUEVTID0gbmV3IFNldChbXCJhcGlfcmVzdFwiLCBcImFwaV9odHRwXCIsIFwiYXBpX3dlYnNvY2tldFwiXSk7XG5cbi8qKlxuICogVGhlIHJlZnVzYWwgZm9yIGEgdHlwZSB0aGUgY29udHJhY3Qgc3RhdGVzIG5vIG5hbWluZyBzY29wZSBmb3I6IGl0IGNhbm5vdCBiZVxuICogcmVzZXJ2ZWQsIHNvIGl0IGNhbm5vdCBiZSBkZXBsb3llZCB0aHJvdWdoIHRoZSBpbmRleCB1bnRpbCBhIHJldmlzaW9uIHN0YXRlc1xuICogaXRzIHNjb3BlLlxuICovXG5jb25zdCBVTktOT1dOX05BTUlOR19TQ09QRSA9IFwiYSB0eXBlIHdpdGggbm8gc3RhdGVkIG5hbWluZyBzY29wZSBjYW5ub3QgYmUgcmVzZXJ2ZWRcIjtcblxuY29uc3QgS0VFUEVSX0FDVElPTlNfR1JPVVAgPSBbXCJsb2dzOkZpbHRlckxvZ0V2ZW50c1wiLCBcImxvZ3M6RGVzY3JpYmVMb2dTdHJlYW1zXCJdO1xuY29uc3QgS0VFUEVSX0FDVElPTlNfU1RSRUFNID0gW1wibG9nczpHZXRMb2dFdmVudHNcIl07XG5cbmZ1bmN0aW9uIGZhaWwobWVzc2FnZTogc3RyaW5nKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIHNoYTI1NkhleCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUodGV4dCwgXCJ1dGY4XCIpLmRpZ2VzdChcImhleFwiKTtcbn1cblxuZnVuY3Rpb24gYmFzZTMyTG93ZXIodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYnl0ZXMgPSBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZSh0ZXh0LCBcInV0ZjhcIikuZGlnZXN0KCk7XG4gIGxldCBiaXRzID0gMDtcbiAgbGV0IHZhbHVlID0gMDtcbiAgbGV0IG91dCA9IFwiXCI7XG4gIGZvciAoY29uc3QgYnl0ZSBvZiBieXRlcykge1xuICAgIHZhbHVlID0gKHZhbHVlIDw8IDgpIHwgYnl0ZTtcbiAgICBiaXRzICs9IDg7XG4gICAgd2hpbGUgKGJpdHMgPj0gNSkge1xuICAgICAgb3V0ICs9IEJBU0UzMlsodmFsdWUgPj4+IChiaXRzIC0gNSkpICYgMzFdO1xuICAgICAgYml0cyAtPSA1O1xuICAgIH1cbiAgfVxuICBpZiAoYml0cyA+IDApIG91dCArPSBCQVNFMzJbKHZhbHVlIDw8ICg1IC0gYml0cykpICYgMzFdO1xuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiBzaG9ydGVuKGZ1bGw6IHN0cmluZywgbGltaXQ6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChmdWxsLmxlbmd0aCA8PSBsaW1pdCkgcmV0dXJuIGZ1bGw7XG4gIGNvbnN0IGhlYWQgPSBmdWxsLnNsaWNlKDAsIGxpbWl0IC0gOSkucmVwbGFjZSgvWy1fLi9dKyQvLCBcIlwiKTtcbiAgcmV0dXJuIGAke2hlYWR9LSR7YmFzZTMyTG93ZXIoZnVsbCkuc2xpY2UoMCwgOCl9YDtcbn1cblxuZnVuY3Rpb24gbmFtZXNwYWNlT2YodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlcy5uYW1lc3BhY2UgPz8gTE9HX1BSRUZJWDtcbn1cblxuZnVuY3Rpb24gc29ydGVkQ29weSh2YWx1ZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICByZXR1cm4gWy4uLm5ldyBTZXQodmFsdWVzID8/IFtdKV0uc29ydCgpO1xufVxuXG5mdW5jdGlvbiBsb2dQcmVmaXgodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtMT0dfUFJFRklYLCBuYW1lc3BhY2VPZih2YWx1ZXMpLCB2YWx1ZXMuYXBwLCB2YWx1ZXMuc3RhZ2VdLmpvaW4oXCJfXCIpICsgXCJfXCI7XG59XG5cbi8qKlxuICogVGhlIGB0aGVvcnljbG91ZF9yZXNvdXJjZV9uYW1pbmcudjAuMWAgcHJpbWl0aXZlcywgZXhwb3NlZCBmb3IganNpaSBzbyB0aGUgR29cbiAqIGFuZCBQeXRob24gQ0RLIGJpbmRpbmdzIHNoYXJlIG9uZSBpbXBsZW1lbnRhdGlvbi5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nIHtcbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcigpIHt9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlIHRoZSBib3VuZCBjb250ZXh0IGdyYW1tYXIuIFRocm93cyBvbiBhbiBpbnZhbGlkIGNvbnRleHQuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlQ29udGV4dCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiB2b2lkIHtcbiAgICBpZiAoIUFQUF9SRS50ZXN0KHZhbHVlcy5hcHApKSBmYWlsKFwiYXBwXCIpO1xuICAgIGlmICghU1RBR0VfUkUudGVzdCh2YWx1ZXMuc3RhZ2UpKSBmYWlsKFwic3RhZ2VcIik7XG4gICAgaWYgKCFBQ0NPVU5UX1JFLnRlc3QodmFsdWVzLmFjY291bnQpKSBmYWlsKFwiYWNjb3VudFwiKTtcbiAgICBpZiAoIVJFR0lPTl9SRS50ZXN0KHZhbHVlcy5yZWdpb24pKSBmYWlsKFwicmVnaW9uXCIpO1xuICAgIGlmICghTkFNRVNQQUNFX1JFLnRlc3QobmFtZXNwYWNlT2YodmFsdWVzKSkpIGZhaWwoXCJuYW1lc3BhY2VcIik7XG4gIH1cblxuICAvKipcbiAgICogVGhlIENsb3VkRm9ybWF0aW9uLWFwcGVuZGVkIGFjY291bnQtcmVnaW9uYWwgYnVja2V0IHN1ZmZpeC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgczNBY2NvdW50UmVnaW9uYWxTdWZmaXgodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYC0ke3ZhbHVlcy5hY2NvdW50fS0ke3ZhbHVlcy5yZWdpb259LWFuYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgYm91bmQgcHJlZml4IHNoYXJlZCBieSBldmVyeSBsb2cgc291cmNlIG9mIHRoZSBhcHAuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGxvZ1NvdXJjZVByZWZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICAgIHJldHVybiBsb2dQcmVmaXgodmFsdWVzKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBNYXAgYSBsb2dpY2FsIGxvZyBzb3VyY2UgdG8gaXRzIHBoeXNpY2FsIGxvZy1ncm91cCBuYW1lLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBsb2dHcm91cE5hbWUodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLCBsb2dpY2FsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICghbG9naWNhbC5zdGFydHNXaXRoKFwibG9ncy9cIikpIGZhaWwoXCJsb2cgbG9naWNhbCBtdXN0IHN0YXJ0IHdpdGggbG9ncy9cIik7XG4gICAgcmV0dXJuIGxvZ1ByZWZpeCh2YWx1ZXMpICsgbG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCJfXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBvc2UgdGhlIHBoeXNpY2FsIG5hbWUgb2Ygb25lIHJlc291cmNlLiBBIHBpbiBhbHdheXMgd2lucy4gQSBnZW5lcmF0ZWRcbiAgICogZW50cnkgbWVhbnMgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lIHRvZGF5IGFuZCB0aGUgY29uc3RydWN0IHNldHNcbiAgICogbm8gcGh5c2ljYWwtbmFtZSBwcm9wZXJ0eS4gR2VuZXJhdGVkIGVudHJpZXMgYXJlIGxlZ2FjeS1vbmx5OyBhIGxlZ2FjeVxuICAgKiBwcm9maWxlIG5lZWRzIGV4YWN0bHkgb25lIG9mIGEgcGluIG9yIGEgZ2VuZXJhdGVkIGVudHJ5LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBwaHlzaWNhbE5hbWUoXG4gICAgdmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICAgIHJlc291cmNlVHlwZTogc3RyaW5nLFxuICAgIGxvZ2ljYWw6IHN0cmluZyxcbiAgKTogQXBwVGhlb3J5UGh5c2ljYWxOYW1lIHtcbiAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZUNvbnRleHQodmFsdWVzKTtcbiAgICBpZiAoIUxPR0lDQUxfUkUudGVzdChsb2dpY2FsKSkgZmFpbChcImxvZ2ljYWxcIik7XG4gICAgY29uc3QgcnVsZSA9IG5hbWluZ1J1bGUocmVzb3VyY2VUeXBlKTtcbiAgICBpZiAoIXJ1bGUpIGZhaWwoYHJlc291cmNlIHR5cGUgJHtyZXNvdXJjZVR5cGV9YCk7XG4gICAgY29uc3QgZ2VuZXJhdGVkID0gdmFsdWVzLmdlbmVyYXRlZCA/PyBbXTtcbiAgICBjb25zdCBsZWdhY3kgPSAodmFsdWVzLm5hbWluZ1Byb2ZpbGUgPz8gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5ERVJJVkVEKSA9PT0gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5MRUdBQ1k7XG4gICAgaWYgKGdlbmVyYXRlZC5sZW5ndGggPiAwICYmICFsZWdhY3kpIHtcbiAgICAgIGZhaWwoXCJnZW5lcmF0ZWQgZW50cmllcyBhcmUgb25seSB2YWxpZCB1bmRlciB0aGUgbGVnYWN5IG5hbWluZyBwcm9maWxlXCIpO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSBgJHtyZXNvdXJjZVR5cGV9OiR7bG9naWNhbH1gO1xuICAgIGNvbnN0IHBpbiA9IHZhbHVlcy5waW5zPy5ba2V5XTtcbiAgICBjb25zdCBrZWVwR2VuZXJhdGVkID0gZ2VuZXJhdGVkLmluY2x1ZGVzKGtleSk7XG4gICAgLy8gcjMsIEFEVi0xMzEyLTM6IENESyBkZWZhdWx0cyBhbiBBUEkgTmFtZSB0b2RheSwgc28gaXQgaXMgYW4gZXhwbGljaXQgbmFtZVxuICAgIC8vIGFuZCB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAgaWYgKGtlZXBHZW5lcmF0ZWQgJiYgQVBJX1RZUEVTLmhhcyhyZXNvdXJjZVR5cGUpKSB7XG4gICAgICBmYWlsKFwiYW4gQVBJIG5hbWUgdGFrZXMgYSBwaW4sIG5ldmVyIGEgZ2VuZXJhdGVkIGVudHJ5XCIpO1xuICAgIH1cbiAgICBpZiAocGluICE9PSB1bmRlZmluZWQgJiYga2VlcEdlbmVyYXRlZCkgZmFpbChcImEgcmVzb3VyY2UgaGFzIGJvdGggYSBwaW4gYW5kIGEgZ2VuZXJhdGVkIGVudHJ5XCIpO1xuICAgIGlmIChwaW4gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgbmFtZTogcGluLCBwaW5uZWQ6IHRydWUgfTtcbiAgICBpZiAoa2VlcEdlbmVyYXRlZCkgcmV0dXJuIHsgZ2VuZXJhdGVkOiB0cnVlIH07XG4gICAgaWYgKGxlZ2FjeSkge1xuICAgICAgZmFpbChgbGVnYWN5IG5hbWluZyBwcm9maWxlIHJlcXVpcmVzIGEgcGluIG9yIGEgZ2VuZXJhdGVkIGVudHJ5IGZvciAke2tleX1gKTtcbiAgICB9XG5cbiAgICBsZXQgb3V0OiBBcHBUaGVvcnlQaHlzaWNhbE5hbWU7XG4gICAgaWYgKHJ1bGUua2luZCA9PT0gXCJzM2FyXCIpIHtcbiAgICAgIGNvbnN0IHN1ZmZpeCA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnMzQWNjb3VudFJlZ2lvbmFsU3VmZml4KHZhbHVlcyk7XG4gICAgICBjb25zdCBidWRnZXQgPSBydWxlLm1heCAtIHN1ZmZpeC5sZW5ndGg7XG4gICAgICBjb25zdCBwcmVmaXggPSBzaG9ydGVuKGAke3ZhbHVlcy5hcHB9LSR7dmFsdWVzLnN0YWdlfS0ke2xvZ2ljYWwucmVwbGFjZSgvXFwvL2csIFwiLVwiKX1gLCBidWRnZXQpO1xuICAgICAgb3V0ID0geyBuYW1lOiBwcmVmaXggKyBzdWZmaXgsIGJ1Y2tldE5hbWVQcmVmaXg6IHByZWZpeCwgYnVja2V0TmFtZXNwYWNlOiBcImFjY291bnQtcmVnaW9uYWxcIiB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcImRhc2hcIikge1xuICAgICAgb3V0ID0geyBuYW1lOiBzaG9ydGVuKGAke3ZhbHVlcy5hcHB9LSR7dmFsdWVzLnN0YWdlfS0ke2xvZ2ljYWwucmVwbGFjZSgvXFwvL2csIFwiLVwiKX1gLCBydWxlLm1heCkgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJwYXRoXCIpIHtcbiAgICAgIGNvbnN0IGZ1bGwgPSBgJHtydWxlLmxlYWQgPz8gXCJcIn0ke3ZhbHVlcy5hcHB9LyR7dmFsdWVzLnN0YWdlfS8ke2xvZ2ljYWx9YDtcbiAgICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwic2VjcmV0XCIgJiYgU0VDUkVUX1RBSUxfUkUudGVzdChmdWxsKSkge1xuICAgICAgICBmYWlsKFwic2VjcmV0IG5hbWUgbXVzdCBub3QgZW5kIHdpdGggYSBoeXBoZW4gYW5kIHNpeCBjaGFyYWN0ZXJzXCIpO1xuICAgICAgfVxuICAgICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzc21fcGFyYW1ldGVyXCIgJiYgKGZ1bGwubWF0Y2goL1xcLy9nKT8ubGVuZ3RoID8/IDApID4gMTUpIHtcbiAgICAgICAgZmFpbChcInNzbSBoaWVyYXJjaHkgZGVlcGVyIHRoYW4gMTVcIik7XG4gICAgICB9XG4gICAgICBpZiAoZnVsbC5sZW5ndGggPiBydWxlLm1heCkgZmFpbChcInBhdGggbmFtZSBvdmVyIGxpbWl0XCIpO1xuICAgICAgb3V0ID0geyBuYW1lOiBmdWxsIH07XG4gICAgfSBlbHNlIGlmIChydWxlLmtpbmQgPT09IFwibG9nXCIpIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5sb2dHcm91cE5hbWUodmFsdWVzLCBsb2dpY2FsKTtcbiAgICAgIGlmIChuYW1lLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwibG9nIGdyb3VwIG92ZXIgbGltaXRcIik7XG4gICAgICBvdXQgPSB7IG5hbWUgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZmFpbChgdW5zdXBwb3J0ZWQga2luZCAke1N0cmluZyhydWxlLmtpbmQpfWApO1xuICAgIH1cblxuICAgIGNvbnN0IG5hbWUgPSBvdXQubmFtZSBhcyBzdHJpbmc7XG4gICAgaWYgKCFuZXcgUmVnRXhwKGBeKD86JHtydWxlLmNoYXJzZXR9KSskYCkudGVzdChuYW1lKSkgZmFpbChcImNoYXJzZXRcIik7XG4gICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJsZW5ndGhcIik7XG4gICAgaWYgKFtcInMzX2J1Y2tldFwiLCBcInMzX3ZlY3Rvcl9idWNrZXRcIiwgXCJzM192ZWN0b3JfaW5kZXhcIl0uaW5jbHVkZXMocmVzb3VyY2VUeXBlKSAmJiAhUzNfRURHRVNfUkUudGVzdChuYW1lKSkge1xuICAgICAgZmFpbChcInMzIHN0YXJ0L2VuZFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgc2NvcGUgaW4gd2hpY2ggQVdTIHJlcXVpcmVzIGEgdHlwZSdzIG5hbWVzIHRvIGJlIHVuaXF1ZSAoY29udHJhY3RcbiAgICogc2VjdGlvbiAxMS4xKS4gQSB0eXBlIHRoZSBjb250cmFjdCBzdGF0ZXMgbm8gc2NvcGUgZm9yIGlzIHJlZnVzZWQ6IGl0IGNhbm5vdFxuICAgKiBiZSByZXNlcnZlZCwgc28gaXQgY2Fubm90IGJlIGRlcGxveWVkIHRocm91Z2ggdGhlIGluZGV4IHVudGlsIGEgcmV2aXNpb25cbiAgICogc3RhdGVzIGl0cyBzY29wZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbmFtaW5nU2NvcGUocmVzb3VyY2VUeXBlOiBzdHJpbmcpOiBBcHBUaGVvcnlOYW1pbmdTY29wZSB7XG4gICAgaWYgKG5hbWluZ1J1bGUocmVzb3VyY2VUeXBlKSA9PT0gdW5kZWZpbmVkKSBmYWlsKFVOS05PV05fTkFNSU5HX1NDT1BFKTtcbiAgICBpZiAoTk9UX1VOSVFVRV9UWVBFUy5oYXMocmVzb3VyY2VUeXBlKSkgcmV0dXJuIEFwcFRoZW9yeU5hbWluZ1Njb3BlLk5PVF9VTklRVUU7XG4gICAgaWYgKEFDQ09VTlRfR0xPQkFMX1RZUEVTLmhhcyhyZXNvdXJjZVR5cGUpKSByZXR1cm4gQXBwVGhlb3J5TmFtaW5nU2NvcGUuQUNDT1VOVDtcbiAgICByZXR1cm4gQXBwVGhlb3J5TmFtaW5nU2NvcGUuQUNDT1VOVF9SRUdJT047XG4gIH1cblxuICAvKipcbiAgICogUmVmdXNlIHR3byBkaWZmZXJlbnQgbG9naWNhbCByZXNvdXJjZXMgaW4gb25lIG5hbWluZyBjb250ZXh0IHRoYXQgZGVyaXZlIHRoZVxuICAgKiBzYW1lIG5hbWUgaW4gdGhlIHNhbWUgbmFtaW5nIHNjb3BlLCBhbmQgcmV0dXJuIHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3RcbiAgICogKGNvbnRyYWN0IHNlY3Rpb24gMTEuNCkuIEEgTGFtYmRhIGZ1bmN0aW9uIGFuZCBpdHMgSUFNIHJvbGUgbWF5IHNoYXJlIGEgbmFtZVxuICAgKiBiZWNhdXNlIHRoZWlyIHNjb3BlcyBkaWZmZXIsIGFuZCB0d28gQVBJcyBtYXkgc2hhcmUgb25lIGJlY2F1c2UgQVdTIGRvZXMgbm90XG4gICAqIGtlZXAgQVBJIG5hbWVzIHVuaXF1ZS4gUm93cyBrZWVwIHRoZSBvcmRlciBvZiB0aGUgZW50cmllcy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc3ludGhDaGVjayhlbnRyaWVzOiBBcHBUaGVvcnlEZXJpdmVkTmFtZUlucHV0W10pOiBBcHBUaGVvcnlEZXJpdmVkTmFtZVtdIHtcbiAgICBjb25zdCBzZWVuID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBjb25zdCBhcnRpZmFjdDogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgY29uc3Qgc2NvcGUgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5uYW1pbmdTY29wZShlbnRyeS50eXBlKTtcbiAgICAgIGNvbnN0IGdlbmVyYXRlZCA9IGVudHJ5LmdlbmVyYXRlZCA9PT0gdHJ1ZTtcbiAgICAgIGFydGlmYWN0LnB1c2goe1xuICAgICAgICAuLi4oZW50cnkubmFtZSAhPT0gdW5kZWZpbmVkICYmICFnZW5lcmF0ZWQgPyB7IG5hbWU6IGVudHJ5Lm5hbWUgfSA6IHt9KSxcbiAgICAgICAgdHlwZTogZW50cnkudHlwZSxcbiAgICAgICAgc2NvcGUsXG4gICAgICAgIGxvZ2ljYWxJZDogZW50cnkubG9naWNhbElkLFxuICAgICAgICAuLi4oZ2VuZXJhdGVkID8geyBnZW5lcmF0ZWQ6IHRydWUgfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHNjb3BlID09PSBBcHBUaGVvcnlOYW1pbmdTY29wZS5OT1RfVU5JUVVFIHx8IGdlbmVyYXRlZCkgY29udGludWU7XG4gICAgICBjb25zdCBrZXkgPSBgJHtzY29wZX1cXHUwMDAwJHtlbnRyeS50eXBlfVxcdTAwMDAke2VudHJ5Lm5hbWUgPz8gXCJcIn1gO1xuICAgICAgY29uc3QgaGVsZCA9IHNlZW4uZ2V0KGtleSk7XG4gICAgICBpZiAoaGVsZCAhPT0gdW5kZWZpbmVkICYmIGhlbGQgIT09IGVudHJ5LmxvZ2ljYWxJZCkge1xuICAgICAgICBmYWlsKGAke2hlbGR9IGFuZCAke2VudHJ5LmxvZ2ljYWxJZH0gZGVyaXZlICR7ZW50cnkubmFtZSA/PyBcIlwifSBpbiBzY29wZSAke3Njb3BlfWApO1xuICAgICAgfVxuICAgICAgc2Vlbi5zZXQoa2V5LCBlbnRyeS5sb2dpY2FsSWQpO1xuICAgIH1cbiAgICByZXR1cm4gYXJ0aWZhY3Q7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBhcyB0aGUgY2xvdWQtYXNzZW1ibHkgbWV0YWRhdGEgZG9jdW1lbnQsIHdpdGggdGhlXG4gICAqIGNvbnRyYWN0J3Mgc25ha2VfY2FzZSB3aXJlIGtleXMgYW5kIGEgZGV0ZXJtaW5pc3RpYyBlbnRyeSBvcmRlci5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgZGVyaXZlZE5hbWVzSnNvbihhcnRpZmFjdDogQXBwVGhlb3J5RGVyaXZlZE5hbWVzKTogc3RyaW5nIHtcbiAgICBjb25zdCBlbnRyaWVzID0gWy4uLmFydGlmYWN0LmVudHJpZXNdXG4gICAgICAubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgICAgLi4uKGVudHJ5Lm5hbWUgIT09IHVuZGVmaW5lZCAmJiAhZW50cnkuZ2VuZXJhdGVkID8geyBuYW1lOiBlbnRyeS5uYW1lIH0gOiB7fSksXG4gICAgICAgIHR5cGU6IGVudHJ5LnR5cGUsXG4gICAgICAgIHNjb3BlOiBlbnRyeS5zY29wZSxcbiAgICAgICAgbG9naWNhbF9pZDogZW50cnkubG9naWNhbElkLFxuICAgICAgICAuLi4oZW50cnkuZ2VuZXJhdGVkID8geyBnZW5lcmF0ZWQ6IHRydWUgfSA6IHt9KSxcbiAgICAgIH0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgICAgY29uc3Qga2V5ID0gKHJvdzogdHlwZW9mIGEpOiBzdHJpbmcgPT5cbiAgICAgICAgICBbcm93LnNjb3BlLCByb3cudHlwZSwgcm93Lm5hbWUgPz8gXCJcIiwgcm93LmxvZ2ljYWxfaWRdLmpvaW4oXCJcXHUwMDAwXCIpO1xuICAgICAgICBjb25zdCBsZWZ0ID0ga2V5KGEpO1xuICAgICAgICBjb25zdCByaWdodCA9IGtleShiKTtcbiAgICAgICAgcmV0dXJuIGxlZnQgPCByaWdodCA/IC0xIDogbGVmdCA+IHJpZ2h0ID8gMSA6IDA7XG4gICAgICB9KTtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgY29udHJhY3Q6IGFydGlmYWN0LmNvbnRyYWN0LFxuICAgICAgc2NoZW1hOiBhcnRpZmFjdC5zY2hlbWEsXG4gICAgICBjb250ZXh0OiB7XG4gICAgICAgIG5hbWVzcGFjZTogYXJ0aWZhY3QuY29udGV4dC5uYW1lc3BhY2UgPz8gTE9HX1BSRUZJWCxcbiAgICAgICAgYXBwOiBhcnRpZmFjdC5jb250ZXh0LmFwcCxcbiAgICAgICAgc3RhZ2U6IGFydGlmYWN0LmNvbnRleHQuc3RhZ2UsXG4gICAgICAgIGFjY291bnQ6IGFydGlmYWN0LmNvbnRleHQuYWNjb3VudCxcbiAgICAgICAgcmVnaW9uOiBhcnRpZmFjdC5jb250ZXh0LnJlZ2lvbixcbiAgICAgIH0sXG4gICAgICBlbnRyaWVzLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlIG9uZSBzZWxlY3Rvci4gVGhyb3dzIG9uIGEgc2VsZWN0b3Igb3V0c2lkZSB0aGUgZ3JhbW1hci5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcjogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgYmFzZSA9IHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikgPyBzZWxlY3Rvci5zbGljZSgwLCAtMikgOiBzZWxlY3RvcjtcbiAgICBpZiAoIUxPR0lDQUxfUkUudGVzdChiYXNlKSB8fCBiYXNlLnNwbGl0KFwiL1wiKVswXSAhPT0gXCJsb2dzXCIgfHwgKGJhc2UgPT09IFwibG9nc1wiICYmICFzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSkge1xuICAgICAgZmFpbChgc2VsZWN0b3IgJHtzZWxlY3Rvcn1gKTtcbiAgICB9XG4gICAgaWYgKGJhc2UuaW5jbHVkZXMoXCIqXCIpKSBmYWlsKFwid2lsZGNhcmQgb25seSBhcyB0cmFpbGluZyAvKlwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGEgc2VsZWN0b3IgbWF0Y2hlcyBhIGxvZ2ljYWwgc291cmNlLiBBIHRyYWlsaW5nIGAvKmAgbWF0Y2hlc1xuICAgKiBkZXNjZW5kYW50cyBvbmx5LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3I6IHN0cmluZywgbG9naWNhbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpIHJldHVybiBsb2dpY2FsLnN0YXJ0c1dpdGgoc2VsZWN0b3Iuc2xpY2UoMCwgLTEpKTtcbiAgICByZXR1cm4gbG9naWNhbCA9PT0gc2VsZWN0b3I7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBhIHNvdXJjZSBpcyB2aXNpYmxlOiBhbiBpbmNsdWRlIG1hdGNoZXMgYW5kIG5vIGV4Y2x1ZGUgZG9lcy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc291cmNlVmlzaWJsZShydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLCBsb2dpY2FsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBjb25zdCBpbmNsdWRlZCA9IChydWxlcy5pbmNsdWRlID8/IFtdKS5zb21lKChzZWxlY3RvcikgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yLCBsb2dpY2FsKSk7XG4gICAgaWYgKCFpbmNsdWRlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiAhKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pLnNvbWUoKHNlbGVjdG9yKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3IsIGxvZ2ljYWwpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgU0hBLTI1NiBvdmVyIHRoZSBjYW5vbmljYWwgcnVsZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHJ1bGVWZXJzaW9uKHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMpOiBzdHJpbmcge1xuICAgIGNvbnN0IGNhbm9uaWNhbCA9IGB7XCJleGNsdWRlXCI6JHtKU09OLnN0cmluZ2lmeShzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpKX0sXCJpbmNsdWRlXCI6JHtKU09OLnN0cmluZ2lmeShzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpKX19YDtcbiAgICByZXR1cm4gc2hhMjU2SGV4KGNhbm9uaWNhbCkuc2xpY2UoMCwgMTIpO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBpbGUgdGhlIHJ1bGVzIGludG8gdGhlIHJlYWRlci1yb2xlIGlubGluZSBwb2xpY3kgZG9jdW1lbnQuIFRoZSByZXR1cm5cbiAgICogdmFsdWUgaXMgdGhlIGNvbnRyYWN0IEpTT04sIHNvIGEgY29uc3VtZXIgY2FuIGNvbXBhcmUgaXQgYnl0ZSBmb3IgYnl0ZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgY29tcGlsZVZpc2liaWxpdHlQb2xpY3lKc29uKFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICApOiBzdHJpbmcge1xuICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgWy4uLihydWxlcy5pbmNsdWRlID8/IFtdKSwgLi4uKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pXSkge1xuICAgICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgfVxuICAgIGNvbnN0IGJhc2UgPSBgYXJuOmF3czpsb2dzOiR7dmFsdWVzLnJlZ2lvbn06JHt2YWx1ZXMuYWNjb3VudH06bG9nLWdyb3VwOmA7XG4gICAgY29uc3QgYXJuc0ZvciA9IChzZWxlY3Rvcjogc3RyaW5nKTogc3RyaW5nW10gPT4ge1xuICAgICAgaWYgKHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpIHtcbiAgICAgICAgcmV0dXJuIFtiYXNlICsgbG9nUHJlZml4KHZhbHVlcykgKyBzZWxlY3Rvci5zbGljZSgwLCAtMSkucmVwbGFjZSgvXFwvL2csIFwiX1wiKSArIFwiKlwiXTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG5hbWUgPSBsb2dQcmVmaXgodmFsdWVzKSArIHNlbGVjdG9yLnJlcGxhY2UoL1xcLy9nLCBcIl9cIik7XG4gICAgICByZXR1cm4gW2Jhc2UgKyBuYW1lLCBiYXNlICsgbmFtZSArIFwiOipcIl07XG4gICAgfTtcbiAgICBjb25zdCBhY3Rpb25zID0gWy4uLktFRVBFUl9BQ1RJT05TX0dST1VQLCAuLi5LRUVQRVJfQUNUSU9OU19TVFJFQU1dO1xuICAgIGNvbnN0IHN0YXRlbWVudHM6IHsgU2lkOiBzdHJpbmc7IEVmZmVjdDogc3RyaW5nOyBBY3Rpb246IHN0cmluZ1tdOyBSZXNvdXJjZTogc3RyaW5nW10gfVtdID0gW1xuICAgICAge1xuICAgICAgICBTaWQ6IFwiUmVhZE1hbmlmZXN0XCIsXG4gICAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgICBBY3Rpb246IFtcInNzbTpHZXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgIFJlc291cmNlOiBbXG4gICAgICAgICAgYGFybjphd3M6c3NtOiR7dmFsdWVzLnJlZ2lvbn06JHt2YWx1ZXMuYWNjb3VudH06cGFyYW1ldGVyLyR7TE9HX1BSRUZJWH0vdmlzaWJpbGl0eS8ke3ZhbHVlcy5hcHB9LyR7dmFsdWVzLnN0YWdlfS9tYW5pZmVzdGAsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3QgaW5jbHVkZWQgPSBzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpLmZsYXRNYXAoYXJuc0Zvcik7XG4gICAgY29uc3QgZXhjbHVkZWQgPSBzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpLmZsYXRNYXAoYXJuc0Zvcik7XG4gICAgaWYgKGluY2x1ZGVkLmxlbmd0aCA+IDApIHN0YXRlbWVudHMucHVzaCh7IFNpZDogXCJSZWFkSW5jbHVkZWRcIiwgRWZmZWN0OiBcIkFsbG93XCIsIEFjdGlvbjogYWN0aW9ucywgUmVzb3VyY2U6IGluY2x1ZGVkIH0pO1xuICAgIGlmIChleGNsdWRlZC5sZW5ndGggPiAwKSBzdGF0ZW1lbnRzLnB1c2goeyBTaWQ6IFwiRGVueUV4Y2x1ZGVkXCIsIEVmZmVjdDogXCJEZW55XCIsIEFjdGlvbjogYWN0aW9ucywgUmVzb3VyY2U6IGV4Y2x1ZGVkIH0pO1xuICAgIGNvbnN0IGRvY3VtZW50ID0gSlNPTi5zdHJpbmdpZnkoeyBWZXJzaW9uOiBcIjIwMTItMTAtMTdcIiwgU3RhdGVtZW50OiBzdGF0ZW1lbnRzIH0pO1xuICAgIGlmIChkb2N1bWVudC5sZW5ndGggPiBST0xFX1BPTElDWV9NQVgpIGZhaWwoXCJjb21waWxlZCBwb2xpY3kgb3ZlciByb2xlIHBvbGljeSBzaXplXCIpO1xuICAgIHJldHVybiBkb2N1bWVudDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBc3NlbWJsZSB0aGUgc3ludGgtdGltZSB2aXNpYmlsaXR5IHByZXZpZXcuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZpc2liaWxpdHlQcmV2aWV3KFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIHNvdXJjZXM6IHN0cmluZ1tdLFxuICApOiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHZhbHVlcyk7XG4gICAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBbLi4uKHJ1bGVzLmluY2x1ZGUgPz8gW10pLCAuLi4ocnVsZXMuZXhjbHVkZSA/PyBbXSldKSB7XG4gICAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHJ1bGVWZXJzaW9uOiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5ydWxlVmVyc2lvbihydWxlcyksXG4gICAgICBtYXRjaGVkTm93OiBzb3VyY2VzLmZpbHRlcigoc291cmNlKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBzb3VyY2UpKS5zb3J0KCksXG4gICAgICBub3RNYXRjaGVkTm93OiBzb3VyY2VzLmZpbHRlcigoc291cmNlKSA9PiAhQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgc291cmNlKSkuc29ydCgpLFxuICAgICAgZnV0dXJlOiB7IGluY2x1ZGU6IHNvcnRlZENvcHkocnVsZXMuaW5jbHVkZSksIGV4Y2x1ZGU6IHNvcnRlZENvcHkocnVsZXMuZXhjbHVkZSkgfSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEFzc2VtYmxlIHRoZSBwdWJsaXNoZWQgbWFuaWZlc3QgKHRoZSBwcmV2aWV3IG1pbnVzIGBub3RNYXRjaGVkTm93YCkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZpc2liaWxpdHlNYW5pZmVzdChcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBzb3VyY2VzOiBzdHJpbmdbXSxcbiAgKTogQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0IHtcbiAgICBjb25zdCBwcmV2aWV3ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmlzaWJpbGl0eVByZXZpZXcodmFsdWVzLCBydWxlcywgc291cmNlcyk7XG4gICAgcmV0dXJuIHsgcnVsZVZlcnNpb246IHByZXZpZXcucnVsZVZlcnNpb24sIG1hdGNoZWROb3c6IHByZXZpZXcubWF0Y2hlZE5vdywgZnV0dXJlOiBwcmV2aWV3LmZ1dHVyZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFNlcmlhbGl6ZSBhIG1hbmlmZXN0IHRvIHRoZSBjb250cmFjdCBKU09OIHNoYXBlIHdyaXR0ZW4gdG8gU1NNLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBtYW5pZmVzdEpzb24obWFuaWZlc3Q6IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHJ1bGVfdmVyc2lvbjogbWFuaWZlc3QucnVsZVZlcnNpb24sXG4gICAgICBtYXRjaGVkX25vdzogbWFuaWZlc3QubWF0Y2hlZE5vdyxcbiAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBtYW5pZmVzdC5mdXR1cmUuaW5jbHVkZSA/PyBbXSwgZXhjbHVkZTogbWFuaWZlc3QuZnV0dXJlLmV4Y2x1ZGUgPz8gW10gfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBLZWVwZXIncyByZWFkIGRlY2lzaW9uLCBpbiB0aGUgcnVudGltZXMnIHBhcmFtZXRlciBvcmRlci4gRmFpbHMgY2xvc2VkIG9uIGFcbiAgICogZGVuaWFsIG9yIGFuIHVucmVhY2hhYmxlIGFjY291bnQuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGtlZXBlckRlY2lzaW9uKFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICAgbG9naWNhbDogc3RyaW5nLFxuICAgIGF3c1Jlc3VsdDogc3RyaW5nLFxuICApOiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIge1xuICAgIGlmICghcnVsZXMgfHwgIUFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIGxvZ2ljYWwpKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLk5PVF9TSEFSRUQ7XG4gICAgfVxuICAgIGlmIChhd3NSZXN1bHQgPT09IFwiZXZlbnRzXCIpIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuRVZFTlRTO1xuICAgIGlmIChhd3NSZXN1bHQgPT09IFwiZW1wdHlcIiB8fCBhd3NSZXN1bHQgPT09IFwibm90X2ZvdW5kXCIpIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuQUxMT1dFRF9OT19FVkVOVFM7XG4gICAgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5OT1RfU0hBUkVEO1xuICB9XG59XG4iXX0=