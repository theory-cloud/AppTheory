"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryResourceNaming = exports.AppTheoryKeeperAnswer = exports.AppTheoryLoggingProfile = exports.AppTheoryNamingProfile = exports.RESOURCE_NAMING_CONTRACT = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const node_crypto_1 = require("node:crypto");
/**
 * The resource-naming contract this module implements.
 */
exports.RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1";
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryResourceNaming", version: "7.5.0-rc.1" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekM7O0dBRUc7QUFDVSxRQUFBLHdCQUF3QixHQUFHLGtDQUFrQyxDQUFDO0FBRTNFOztHQUVHO0FBQ0gsSUFBWSxzQkFTWDtBQVRELFdBQVksc0JBQXNCO0lBQ2hDOztPQUVHO0lBQ0gsNkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCwyQ0FBaUIsQ0FBQTtBQUNuQixDQUFDLEVBVFcsc0JBQXNCLHNDQUF0QixzQkFBc0IsUUFTakM7QUFFRDs7R0FFRztBQUNILElBQVksdUJBU1g7QUFURCxXQUFZLHVCQUF1QjtJQUNqQzs7T0FFRztJQUNILGdEQUFxQixDQUFBO0lBQ3JCOztPQUVHO0lBQ0gsNENBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBU2xDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHFCQWFYO0FBYkQsV0FBWSxxQkFBcUI7SUFDL0I7O09BRUc7SUFDSCwwQ0FBaUIsQ0FBQTtJQUNqQjs7T0FFRztJQUNILGdFQUF1QyxDQUFBO0lBQ3ZDOztPQUVHO0lBQ0gsa0RBQXlCLENBQUE7QUFDM0IsQ0FBQyxFQWJXLHFCQUFxQixxQ0FBckIscUJBQXFCLFFBYWhDO0FBbUtELE1BQU0sZUFBZSxHQUFHLDBCQUEwQixDQUFDO0FBQ25ELE1BQU0sVUFBVSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksZUFBZSxPQUFPLGVBQWUsS0FBSyxDQUFDLENBQUM7QUFDOUUsTUFBTSxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxlQUFlLEdBQUcsQ0FBQyxDQUFDO0FBQ2xELE1BQU0sUUFBUSxHQUFHLHNCQUFzQixDQUFDO0FBQ3hDLE1BQU0sWUFBWSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksZUFBZSxHQUFHLENBQUMsQ0FBQztBQUN4RCxNQUFNLFVBQVUsR0FBRyxhQUFhLENBQUM7QUFDakMsTUFBTSxTQUFTLEdBQUcsOEJBQThCLENBQUM7QUFDakQsTUFBTSxjQUFjLEdBQUcsa0JBQWtCLENBQUM7QUFDMUMsTUFBTSxXQUFXLEdBQUcsc0JBQXNCLENBQUM7QUFDM0MsTUFBTSxVQUFVLEdBQUcsYUFBYSxDQUFDO0FBQ2pDLE1BQU0sZUFBZSxHQUFHLEtBQUssQ0FBQztBQUM5QixNQUFNLE1BQU0sR0FBRyxrQ0FBa0MsQ0FBQztBQVNsRCxNQUFNLEtBQUssR0FBNkI7SUFDdEMsU0FBUyxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUU7SUFDMUQsZ0JBQWdCLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxFQUFFLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRTtJQUNqRSxlQUFlLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxFQUFFLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRTtJQUNoRSxjQUFjLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsT0FBTyxFQUFFLGdCQUFnQixFQUFFO0lBQ3JFLGVBQWUsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFO0lBQ3BFLFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFO0lBQzlELFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFO0lBQy9ELE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUU7SUFDakUsYUFBYSxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxJQUFJLEVBQUUsR0FBRyxFQUFFO0lBQ2hGLFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRTtJQUNoRixTQUFTLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsT0FBTyxFQUFFLGdCQUFnQixFQUFFO0lBQ2hFLFVBQVUsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsZ0JBQWdCLEVBQUU7SUFDaEUsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRTtJQUM5RCxLQUFLLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsT0FBTyxFQUFFLGdCQUFnQixFQUFFO0lBQzVELFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFO0lBQy9ELFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUU7SUFDbEUsa0JBQWtCLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsT0FBTyxFQUFFLG9CQUFvQixFQUFFO0lBQzdFLGFBQWEsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFO0lBQ2xFLGlCQUFpQixFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxlQUFlLEVBQUU7SUFDdkUsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxlQUFlLEVBQUU7SUFDOUQsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxlQUFlLEVBQUU7SUFDOUQsYUFBYSxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxlQUFlLEVBQUU7SUFDbkUsbUJBQW1CLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxFQUFFLEVBQUUsT0FBTyxFQUFFLGVBQWUsRUFBRTtJQUN4RSx3QkFBd0IsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFO0lBQzdFLFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFO0NBQy9ELENBQUM7QUFFRjs7O0dBR0c7QUFDSCxNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLFVBQVUsRUFBRSxVQUFVLEVBQUUsZUFBZSxDQUFDLENBQUMsQ0FBQztBQUVyRSxNQUFNLG9CQUFvQixHQUFHLENBQUMsc0JBQXNCLEVBQUUseUJBQXlCLENBQUMsQ0FBQztBQUNqRixNQUFNLHFCQUFxQixHQUFHLENBQUMsbUJBQW1CLENBQUMsQ0FBQztBQUVwRCxTQUFTLElBQUksQ0FBQyxPQUFlO0lBQzNCLE1BQU0sSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDM0IsQ0FBQztBQUVELFNBQVMsU0FBUyxDQUFDLElBQVk7SUFDN0IsT0FBTyxJQUFBLHdCQUFVLEVBQUMsUUFBUSxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxNQUFNLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDakUsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQVk7SUFDL0IsTUFBTSxLQUFLLEdBQUcsSUFBQSx3QkFBVSxFQUFDLFFBQVEsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUM7SUFDakUsSUFBSSxJQUFJLEdBQUcsQ0FBQyxDQUFDO0lBQ2IsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2QsSUFBSSxHQUFHLEdBQUcsRUFBRSxDQUFDO0lBQ2IsS0FBSyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQztRQUN6QixLQUFLLEdBQUcsQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDO1FBQzVCLElBQUksSUFBSSxDQUFDLENBQUM7UUFDVixPQUFPLElBQUksSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUNqQixHQUFHLElBQUksTUFBTSxDQUFDLENBQUMsS0FBSyxLQUFLLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7WUFDM0MsSUFBSSxJQUFJLENBQUMsQ0FBQztRQUNaLENBQUM7SUFDSCxDQUFDO0lBQ0QsSUFBSSxJQUFJLEdBQUcsQ0FBQztRQUFFLEdBQUcsSUFBSSxNQUFNLENBQUMsQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztJQUN4RCxPQUFPLEdBQUcsQ0FBQztBQUNiLENBQUM7QUFFRCxTQUFTLE9BQU8sQ0FBQyxJQUFZLEVBQUUsS0FBYTtJQUMxQyxJQUFJLElBQUksQ0FBQyxNQUFNLElBQUksS0FBSztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3RDLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQzlELE9BQU8sR0FBRyxJQUFJLElBQUksV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUNwRCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBb0M7SUFDdkQsT0FBTyxNQUFNLENBQUMsU0FBUyxJQUFJLFVBQVUsQ0FBQztBQUN4QyxDQUFDO0FBRUQsU0FBUyxVQUFVLENBQUMsTUFBNEI7SUFDOUMsT0FBTyxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsU0FBUyxDQUFDLE1BQW9DO0lBQ3JELE9BQU8sQ0FBQyxVQUFVLEVBQUUsV0FBVyxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQU0sQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUM7QUFDckYsQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQWEsdUJBQXVCOztJQUNsQyxnQkFBdUIsQ0FBQztJQUV4Qjs7T0FFRztJQUNJLE1BQU0sQ0FBQyxlQUFlLENBQUMsTUFBb0M7UUFDaEUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQztZQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMxQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDO1lBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2hELElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUM7WUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDdEQsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQztZQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUNuRCxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUM7WUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDakUsQ0FBQztJQUVEOztPQUVHO0lBQ0ksTUFBTSxDQUFDLHVCQUF1QixDQUFDLE1BQW9DO1FBQ3hFLE9BQU8sSUFBSSxNQUFNLENBQUMsT0FBTyxJQUFJLE1BQU0sQ0FBQyxNQUFNLEtBQUssQ0FBQztJQUNsRCxDQUFDO0lBRUQ7O09BRUc7SUFDSSxNQUFNLENBQUMsZUFBZSxDQUFDLE1BQW9DO1FBQ2hFLE9BQU8sU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzNCLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxZQUFZLENBQUMsTUFBb0MsRUFBRSxPQUFlO1FBQzlFLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQztZQUFFLElBQUksQ0FBQyxtQ0FBbUMsQ0FBQyxDQUFDO1FBQzVFLE9BQU8sU0FBUyxDQUFDLE1BQU0sQ0FBQyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQ3pELENBQUM7SUFFRDs7Ozs7T0FLRztJQUNJLE1BQU0sQ0FBQyxZQUFZLENBQ3hCLE1BQW9DLEVBQ3BDLFlBQW9CLEVBQ3BCLE9BQWU7UUFFZix1QkFBdUIsQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDaEQsSUFBSSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDO1lBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQy9DLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUNqQyxJQUFJLENBQUMsSUFBSTtZQUFFLElBQUksQ0FBQyxpQkFBaUIsWUFBWSxFQUFFLENBQUMsQ0FBQztRQUNqRCxNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsU0FBUyxJQUFJLEVBQUUsQ0FBQztRQUN6QyxNQUFNLE1BQU0sR0FBRyxDQUFDLE1BQU0sQ0FBQyxhQUFhLElBQUksc0JBQXNCLENBQUMsT0FBTyxDQUFDLEtBQUssc0JBQXNCLENBQUMsTUFBTSxDQUFDO1FBQzFHLElBQUksU0FBUyxDQUFDLE1BQU0sR0FBRyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNwQyxJQUFJLENBQUMsa0VBQWtFLENBQUMsQ0FBQztRQUMzRSxDQUFDO1FBQ0QsTUFBTSxHQUFHLEdBQUcsR0FBRyxZQUFZLElBQUksT0FBTyxFQUFFLENBQUM7UUFDekMsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQy9CLE1BQU0sYUFBYSxHQUFHLFNBQVMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDOUMsNEVBQTRFO1FBQzVFLDRDQUE0QztRQUM1QyxJQUFJLGFBQWEsSUFBSSxTQUFTLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUM7WUFDakQsSUFBSSxDQUFDLGtEQUFrRCxDQUFDLENBQUM7UUFDM0QsQ0FBQztRQUNELElBQUksR0FBRyxLQUFLLFNBQVMsSUFBSSxhQUFhO1lBQUUsSUFBSSxDQUFDLGlEQUFpRCxDQUFDLENBQUM7UUFDaEcsSUFBSSxHQUFHLEtBQUssU0FBUztZQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsR0FBRyxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsQ0FBQztRQUMxRCxJQUFJLGFBQWE7WUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDO1FBQzlDLElBQUksTUFBTSxFQUFFLENBQUM7WUFDWCxJQUFJLENBQUMsaUVBQWlFLEdBQUcsRUFBRSxDQUFDLENBQUM7UUFDL0UsQ0FBQztRQUVELElBQUksR0FBMEIsQ0FBQztRQUMvQixJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7WUFDekIsTUFBTSxNQUFNLEdBQUcsdUJBQXVCLENBQUMsdUJBQXVCLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDdkUsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEdBQUcsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDO1lBQ3hDLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxHQUFHLE1BQU0sQ0FBQyxHQUFHLElBQUksTUFBTSxDQUFDLEtBQUssSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsRUFBRSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQy9GLEdBQUcsR0FBRyxFQUFFLElBQUksRUFBRSxNQUFNLEdBQUcsTUFBTSxFQUFFLGdCQUFnQixFQUFFLE1BQU0sRUFBRSxlQUFlLEVBQUUsa0JBQWtCLEVBQUUsQ0FBQztRQUNqRyxDQUFDO2FBQU0sSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU0sRUFBRSxDQUFDO1lBQ2hDLEdBQUcsR0FBRyxFQUFFLElBQUksRUFBRSxPQUFPLENBQUMsR0FBRyxNQUFNLENBQUMsR0FBRyxJQUFJLE1BQU0sQ0FBQyxLQUFLLElBQUksT0FBTyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLEVBQUUsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNwRyxDQUFDO2FBQU0sSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU0sRUFBRSxDQUFDO1lBQ2hDLE1BQU0sSUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDLElBQUksSUFBSSxFQUFFLEdBQUcsTUFBTSxDQUFDLEdBQUcsSUFBSSxNQUFNLENBQUMsS0FBSyxJQUFJLE9BQU8sRUFBRSxDQUFDO1lBQzFFLElBQUksWUFBWSxLQUFLLFFBQVEsSUFBSSxjQUFjLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7Z0JBQzNELElBQUksQ0FBQywyREFBMkQsQ0FBQyxDQUFDO1lBQ3BFLENBQUM7WUFDRCxJQUFJLFlBQVksS0FBSyxlQUFlLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxFQUFFLE1BQU0sSUFBSSxDQUFDLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQztnQkFDOUUsSUFBSSxDQUFDLDhCQUE4QixDQUFDLENBQUM7WUFDdkMsQ0FBQztZQUNELElBQUksSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRztnQkFBRSxJQUFJLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUN6RCxHQUFHLEdBQUcsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7UUFDdkIsQ0FBQzthQUFNLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxLQUFLLEVBQUUsQ0FBQztZQUMvQixNQUFNLElBQUksR0FBRyx1QkFBdUIsQ0FBQyxZQUFZLENBQUMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxDQUFDO1lBQ25FLElBQUksSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRztnQkFBRSxJQUFJLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUN6RCxHQUFHLEdBQUcsRUFBRSxJQUFJLEVBQUUsQ0FBQztRQUNqQixDQUFDO2FBQU0sQ0FBQztZQUNOLElBQUksQ0FBQyxvQkFBb0IsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDaEQsQ0FBQztRQUVELE1BQU0sSUFBSSxHQUFHLEdBQUcsQ0FBQyxJQUFjLENBQUM7UUFDaEMsSUFBSSxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sSUFBSSxDQUFDLE9BQU8sS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztZQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUN0RSxJQUFJLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLEdBQUc7WUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDM0MsSUFBSSxDQUFDLFdBQVcsRUFBRSxrQkFBa0IsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUMzRyxJQUFJLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDdkIsQ0FBQztRQUNELE9BQU8sR0FBRyxDQUFDO0lBQ2IsQ0FBQztJQUVEOztPQUVHO0lBQ0ksTUFBTSxDQUFDLGdCQUFnQixDQUFDLFFBQWdCO1FBQzdDLE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUN4RSxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLE1BQU0sSUFBSSxDQUFDLElBQUksS0FBSyxNQUFNLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUM3RyxJQUFJLENBQUMsWUFBWSxRQUFRLEVBQUUsQ0FBQyxDQUFDO1FBQy9CLENBQUM7UUFDRCxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDO1lBQUUsSUFBSSxDQUFDLDhCQUE4QixDQUFDLENBQUM7SUFDL0QsQ0FBQztJQUVEOzs7T0FHRztJQUNJLE1BQU0sQ0FBQyxlQUFlLENBQUMsUUFBZ0IsRUFBRSxPQUFlO1FBQzdELElBQUksUUFBUSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUM7WUFBRSxPQUFPLE9BQU8sQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzlFLE9BQU8sT0FBTyxLQUFLLFFBQVEsQ0FBQztJQUM5QixDQUFDO0lBRUQ7O09BRUc7SUFDSSxNQUFNLENBQUMsYUFBYSxDQUFDLEtBQStCLEVBQUUsT0FBZTtRQUMxRSxNQUFNLFFBQVEsR0FBRyxDQUFDLEtBQUssQ0FBQyxPQUFPLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxlQUFlLENBQUMsUUFBUSxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUM7UUFDdEgsSUFBSSxDQUFDLFFBQVE7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUM1QixPQUFPLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUMsdUJBQXVCLENBQUMsZUFBZSxDQUFDLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQy9HLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxXQUFXLENBQUMsS0FBK0I7UUFDdkQsTUFBTSxTQUFTLEdBQUcsY0FBYyxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsY0FBYyxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxDQUFDO1FBQ3BJLE9BQU8sU0FBUyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDM0MsQ0FBQztJQUVEOzs7T0FHRztJQUNJLE1BQU0sQ0FBQywyQkFBMkIsQ0FDdkMsTUFBb0MsRUFDcEMsS0FBK0I7UUFFL0IsS0FBSyxNQUFNLFFBQVEsSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUM1RSx1QkFBdUIsQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUNyRCxDQUFDO1FBQ0QsTUFBTSxJQUFJLEdBQUcsZ0JBQWdCLE1BQU0sQ0FBQyxNQUFNLElBQUksTUFBTSxDQUFDLE9BQU8sYUFBYSxDQUFDO1FBQzFFLE1BQU0sT0FBTyxHQUFHLENBQUMsUUFBZ0IsRUFBWSxFQUFFO1lBQzdDLElBQUksUUFBUSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO2dCQUM1QixPQUFPLENBQUMsSUFBSSxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUMsR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUM7WUFDdEYsQ0FBQztZQUNELE1BQU0sSUFBSSxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUMsR0FBRyxRQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztZQUM5RCxPQUFPLENBQUMsSUFBSSxHQUFHLElBQUksRUFBRSxJQUFJLEdBQUcsSUFBSSxHQUFHLElBQUksQ0FBQyxDQUFDO1FBQzNDLENBQUMsQ0FBQztRQUNGLE1BQU0sT0FBTyxHQUFHLENBQUMsR0FBRyxvQkFBb0IsRUFBRSxHQUFHLHFCQUFxQixDQUFDLENBQUM7UUFDcEUsTUFBTSxVQUFVLEdBQTRFO1lBQzFGO2dCQUNFLEdBQUcsRUFBRSxjQUFjO2dCQUNuQixNQUFNLEVBQUUsT0FBTztnQkFDZixNQUFNLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQztnQkFDNUIsUUFBUSxFQUFFO29CQUNSLGVBQWUsTUFBTSxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUMsT0FBTyxjQUFjLFVBQVUsZUFBZSxNQUFNLENBQUMsR0FBRyxJQUFJLE1BQU0sQ0FBQyxLQUFLLFdBQVc7aUJBQzNIO2FBQ0Y7U0FDRixDQUFDO1FBQ0YsTUFBTSxRQUFRLEdBQUcsVUFBVSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDNUQsTUFBTSxRQUFRLEdBQUcsVUFBVSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDNUQsSUFBSSxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUM7WUFBRSxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLGNBQWMsRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLE1BQU0sRUFBRSxPQUFPLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFDeEgsSUFBSSxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUM7WUFBRSxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLGNBQWMsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxPQUFPLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFDdkgsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLE9BQU8sRUFBRSxZQUFZLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxDQUFDLENBQUM7UUFDbEYsSUFBSSxRQUFRLENBQUMsTUFBTSxHQUFHLGVBQWU7WUFBRSxJQUFJLENBQUMsdUNBQXVDLENBQUMsQ0FBQztRQUNyRixPQUFPLFFBQVEsQ0FBQztJQUNsQixDQUFDO0lBRUQ7O09BRUc7SUFDSSxNQUFNLENBQUMsaUJBQWlCLENBQzdCLE1BQW9DLEVBQ3BDLEtBQStCLEVBQy9CLE9BQWlCO1FBRWpCLHVCQUF1QixDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUNoRCxLQUFLLE1BQU0sUUFBUSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxPQUFPLElBQUksRUFBRSxDQUFDLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxPQUFPLElBQUksRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQzVFLHVCQUF1QixDQUFDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ3JELENBQUM7UUFDRCxPQUFPO1lBQ0wsV0FBVyxFQUFFLHVCQUF1QixDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUM7WUFDdkQsVUFBVSxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLHVCQUF1QixDQUFDLGFBQWEsQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUU7WUFDbkcsYUFBYSxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsdUJBQXVCLENBQUMsYUFBYSxDQUFDLEtBQUssRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRTtZQUN2RyxNQUFNLEVBQUUsRUFBRSxPQUFPLEVBQUUsVUFBVSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsRUFBRSxPQUFPLEVBQUUsVUFBVSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsRUFBRTtTQUNuRixDQUFDO0lBQ0osQ0FBQztJQUVEOztPQUVHO0lBQ0ksTUFBTSxDQUFDLGtCQUFrQixDQUM5QixNQUFvQyxFQUNwQyxLQUErQixFQUMvQixPQUFpQjtRQUVqQixNQUFNLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQyxpQkFBaUIsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBQ2xGLE9BQU8sRUFBRSxXQUFXLEVBQUUsT0FBTyxDQUFDLFdBQVcsRUFBRSxVQUFVLEVBQUUsT0FBTyxDQUFDLFVBQVUsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDO0lBQ3RHLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxZQUFZLENBQUMsUUFBcUM7UUFDOUQsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDO1lBQ3BCLFlBQVksRUFBRSxRQUFRLENBQUMsV0FBVztZQUNsQyxXQUFXLEVBQUUsUUFBUSxDQUFDLFVBQVU7WUFDaEMsTUFBTSxFQUFFLEVBQUUsT0FBTyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsT0FBTyxJQUFJLEVBQUUsRUFBRSxPQUFPLEVBQUUsUUFBUSxDQUFDLE1BQU0sQ0FBQyxPQUFPLElBQUksRUFBRSxFQUFFO1NBQzNGLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRDs7O09BR0c7SUFDSSxNQUFNLENBQUMsY0FBYyxDQUMxQixLQUErQixFQUMvQixPQUFlLEVBQ2YsU0FBaUI7UUFFakIsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLHVCQUF1QixDQUFDLGFBQWEsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNyRSxPQUFPLHFCQUFxQixDQUFDLFVBQVUsQ0FBQztRQUMxQyxDQUFDO1FBQ0QsSUFBSSxTQUFTLEtBQUssUUFBUTtZQUFFLE9BQU8scUJBQXFCLENBQUMsTUFBTSxDQUFDO1FBQ2hFLElBQUksU0FBUyxLQUFLLE9BQU8sSUFBSSxTQUFTLEtBQUssV0FBVztZQUFFLE9BQU8scUJBQXFCLENBQUMsaUJBQWlCLENBQUM7UUFDdkcsT0FBTyxxQkFBcUIsQ0FBQyxVQUFVLENBQUM7SUFDMUMsQ0FBQzs7QUFoUEgsMERBaVBDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuXG4vKipcbiAqIFRoZSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3QgdGhpcyBtb2R1bGUgaW1wbGVtZW50cy5cbiAqL1xuZXhwb3J0IGNvbnN0IFJFU09VUkNFX05BTUlOR19DT05UUkFDVCA9IFwidGhlb3J5Y2xvdWRfcmVzb3VyY2VfbmFtaW5nLnYwLjFcIjtcblxuLyoqXG4gKiBOYW1pbmcgcHJvZmlsZXMgYWNjZXB0ZWQgYnkgYSBuYW1pbmcgY29udGV4dC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZSB7XG4gIC8qKlxuICAgKiBOYW1lcyBkZXJpdmUgZnJvbSB0aGUgbmFtaW5nIGNvbnRleHQuXG4gICAqL1xuICBERVJJVkVEID0gXCJkZXJpdmVkXCIsXG4gIC8qKlxuICAgKiBFdmVyeSBuYW1lIGNvbWVzIGZyb20gYSBwaW4uXG4gICAqL1xuICBMRUdBQ1kgPSBcImxlZ2FjeVwiLFxufVxuXG4vKipcbiAqIExvZ2dpbmcgcHJvZmlsZXMgYWNjZXB0ZWQgYnkgYSBuYW1pbmcgY29udGV4dC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUge1xuICAvKipcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgc3RhbmRhcmQgbG9nIGdyb3VwcyBhbmQgYWNjZXNzIGxvZ2dpbmcuXG4gICAqL1xuICBTVEFOREFSRCA9IFwic3RhbmRhcmRcIixcbiAgLyoqXG4gICAqIEVhY2ggY29uc3RydWN0IGtlZXBzIGl0cyBwcmUtY29udHJhY3QgbG9nZ2luZyBiZWhhdmlvdXIuXG4gICAqL1xuICBMRUdBQ1kgPSBcImxlZ2FjeVwiLFxufVxuXG4vKipcbiAqIEtlZXBlcidzIGFuc3dlciB0byBhIHJlYWRlciByZXF1ZXN0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIge1xuICAvKipcbiAgICogVGhlIHNvdXJjZSBpcyBzaGFyZWQgYW5kIHRoZSByZWFkIHJldHVybmVkIGV2ZW50cy5cbiAgICovXG4gIEVWRU5UUyA9IFwiZXZlbnRzXCIsXG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIHNoYXJlZCBhbmQgdGhlIHJlYWQgcmV0dXJuZWQgbm8gZXZlbnRzLlxuICAgKi9cbiAgQUxMT1dFRF9OT19FVkVOVFMgPSBcImFsbG93ZWRfbm9fZXZlbnRzXCIsXG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIG5vdCBzaGFyZWQsIG9yIHRoZSByZWFkIGZhaWxlZCBjbG9zZWQuXG4gICAqL1xuICBOT1RfU0hBUkVEID0gXCJub3Rfc2hhcmVkXCIsXG59XG5cbi8qKlxuICogQm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQgdmFsdWVzIGZyb20gc3RhZ2UgY29uZmlnLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMge1xuICAvKipcbiAgICogTmFtZXNwYWNlIHNlZ21lbnQuXG4gICAqIEBkZWZhdWx0IFwidGhlb3J5Y2xvdWRcIlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZXNwYWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBcHAgaW5zdGFuY2UgaWQuXG4gICAqL1xuICByZWFkb25seSBhcHA6IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgaWQuXG4gICAqL1xuICByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZC4gQW4gdW5yZXNvbHZlZCB0b2tlbiBmYWlscyBzeW50aGVzaXMuXG4gICAqL1xuICByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUsIGZvciBleGFtcGxlIGB1cy1lYXN0LTFgLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKiBAZGVmYXVsdCB7fVxuICAgKi9cbiAgcmVhZG9ubHkgcGlucz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlZC1uYW1lIGVudHJpZXMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLiBBbiBlbnRyeSBtZWFuc1xuICAgKiBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgdG9kYXksIHNvIHRoZSBjb25zdHJ1Y3Qgc2V0cyBub1xuICAgKiBwaHlzaWNhbC1uYW1lIHByb3BlcnR5LiBWYWxpZCBvbmx5IHVuZGVyIHRoZSBsZWdhY3kgbmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nUHJvZmlsZT86IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZ2dpbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuTEVHQUNZXG4gICAqL1xuICByZWFkb25seSBsb2dnaW5nUHJvZmlsZT86IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2cgcmV0ZW50aW9uIGluIGRheXMgZm9yIHN0YW5kYXJkLXByb2ZpbGUgbG9nIGdyb3Vwcy5cbiAgICogQGRlZmF1bHQgMzBcbiAgICovXG4gIHJlYWRvbmx5IHJldGVudGlvbkRheXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogVGhlIGNvbXBvc2VkIHBoeXNpY2FsIG5hbWUgb2Ygb25lIHJlc291cmNlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVBoeXNpY2FsTmFtZSB7XG4gIC8qKlxuICAgKiBUaGUgZnVsbCBwaHlzaWNhbCBuYW1lLiBBYnNlbnQgd2hlbiBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFjY291bnQtcmVnaW9uYWwgYnVja2V0LW5hbWUgcHJlZml4LCB3aGVuIHRoZSB0eXBlIHVzZXMgb25lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGJ1Y2tldE5hbWVQcmVmaXg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBidWNrZXQgbmFtZXNwYWNlLCB3aGVuIHRoZSB0eXBlIHVzZXMgb25lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGJ1Y2tldE5hbWVzcGFjZT86IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgbmFtZSBjYW1lIGZyb20gYSBwaW4uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBwaW5uZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSwgc28gbm8gcGh5c2ljYWwtbmFtZSBwcm9wZXJ0eSBpc1xuICAgKiBzZXQuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEluY2x1ZGUgYW5kIGV4Y2x1ZGUgdmlzaWJpbGl0eSBzZWxlY3RvcnMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzIHtcbiAgLyoqXG4gICAqIFNlbGVjdG9ycyB3aG9zZSBzb3VyY2VzIGFyZSBzaGFyZWQuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBpbmNsdWRlPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFNlbGVjdG9ycyB3aG9zZSBzb3VyY2VzIGFyZSBuZXZlciBzaGFyZWQuIEV4Y2x1c2lvbnMgd2luLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZXhjbHVkZT86IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIFRoZSBzeW50aC10aW1lIHZpc2liaWxpdHkgcHJldmlldy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gIC8qKlxuICAgKiBGaXJzdCAxMiBoZXggY2hhcmFjdGVycyBvZiB0aGUgY2Fub25pY2FsIHJ1bGVzIGhhc2guXG4gICAqL1xuICByZWFkb25seSBydWxlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgZG8gbm90IHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbm90TWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBzZWxlY3RvcnMsIGFzIHRoZSBzdGF0ZW1lbnQgb2Ygd2hhdCBmdXR1cmUgc291cmNlcyB3aWxsIG1hdGNoLlxuICAgKi9cbiAgcmVhZG9ubHkgZnV0dXJlOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXM7XG59XG5cbi8qKlxuICogVGhlIHB1Ymxpc2hlZCBTU00gbWFuaWZlc3Q6IHRoZSBwcmV2aWV3IG1pbnVzIGBub3RNYXRjaGVkTm93YC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3Qge1xuICAvKipcbiAgICogRmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgdGhlIGNhbm9uaWNhbCBydWxlcyBoYXNoLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgc2VsZWN0b3JzLCBhcyB0aGUgc3RhdGVtZW50IG9mIHdoYXQgZnV0dXJlIHNvdXJjZXMgd2lsbCBtYXRjaC5cbiAgICovXG4gIHJlYWRvbmx5IGZ1dHVyZTogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xufVxuXG5jb25zdCBTRUdNRU5UX1BBVFRFUk4gPSBcIlthLXowLTldKyg/Oi1bYS16MC05XSspKlwiO1xuY29uc3QgTE9HSUNBTF9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0oPzovJHtTRUdNRU5UX1BBVFRFUk59KSokYCk7XG5jb25zdCBBUFBfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59JGApO1xuY29uc3QgU1RBR0VfUkUgPSAvXlthLXpdW2EtejAtOV17MCw3fSQvO1xuY29uc3QgTkFNRVNQQUNFX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSRgKTtcbmNvbnN0IEFDQ09VTlRfUkUgPSAvXlswLTldezEyfSQvO1xuY29uc3QgUkVHSU9OX1JFID0gL15bYS16XXsyfSg/Oi1bYS16XSspKy1bMC05XSQvO1xuY29uc3QgU0VDUkVUX1RBSUxfUkUgPSAvLVtBLVphLXowLTldezZ9JC87XG5jb25zdCBTM19FREdFU19SRSA9IC9eW2EtejAtOV0uKlthLXowLTldJC87XG5jb25zdCBMT0dfUFJFRklYID0gXCJ0aGVvcnljbG91ZFwiO1xuY29uc3QgUk9MRV9QT0xJQ1lfTUFYID0gMTAyNDA7XG5jb25zdCBCQVNFMzIgPSBcImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MjM0NTY3XCI7XG5cbmludGVyZmFjZSBSdWxlIHtcbiAgcmVhZG9ubHkga2luZDogXCJkYXNoXCIgfCBcInBhdGhcIiB8IFwiczNhclwiIHwgXCJsb2dcIjtcbiAgcmVhZG9ubHkgbWF4OiBudW1iZXI7XG4gIHJlYWRvbmx5IGNoYXJzZXQ6IHN0cmluZztcbiAgcmVhZG9ubHkgbGVhZD86IHN0cmluZztcbn1cblxuY29uc3QgUlVMRVM6IHsgW3R5cGU6IHN0cmluZ106IFJ1bGUgfSA9IHtcbiAgczNfYnVja2V0OiB7IGtpbmQ6IFwiczNhclwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIHMzX3ZlY3Rvcl9idWNrZXQ6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgczNfdmVjdG9yX2luZGV4OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIGR5bmFtb2RiX3RhYmxlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGxhbWJkYV9mdW5jdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc3FzX3F1ZXVlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDgwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzbnNfdG9waWM6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzZWNyZXQ6IHsga2luZDogXCJwYXRoXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTkvXys9LkAtXVwiIH0sXG4gIHNzbV9wYXJhbWV0ZXI6IHsga2luZDogXCJwYXRoXCIsIG1heDogOTAwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLi8tXVwiLCBsZWFkOiBcIi9cIiB9LFxuICBrbXNfYWxpYXM6IHsga2luZDogXCJwYXRoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTkvXy1dXCIsIGxlYWQ6IFwiYWxpYXMvXCIgfSxcbiAgZXZlbnRfYnVzOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGV2ZW50X3J1bGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBzY2hlZHVsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGFsYXJtOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGRhc2hib2FyZDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGlhbV9yb2xlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkrPSwuQF8tXVwiIH0sXG4gIGlhbV9tYW5hZ2VkX3BvbGljeTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOSs9LC5AXy1dXCIgfSxcbiAgc3RhdGVfbWFjaGluZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA4MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgY29kZWJ1aWxkX3Byb2plY3Q6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTUwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfcmVzdDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV9odHRwOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgYXBpX3dlYnNvY2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9zb3VyY2U6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGxvZ19kZWxpdmVyeV9kZXN0aW5hdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2dyb3VwOiB7IGtpbmQ6IFwibG9nXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxufTtcblxuLyoqXG4gKiBBUEkgbmFtZSB0eXBlcy4gVGhlIENESyBkZWZhdWx0cyBhbiBBUEkgTmFtZSB0b2RheSwgc28gYSBuYW1lIGZvciBvbmUgaXNcbiAqIGV4cGxpY2l0IGFuZCB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnkgKHIzLCBBRFYtMTMxMi0zKS5cbiAqL1xuY29uc3QgQVBJX1RZUEVTID0gbmV3IFNldChbXCJhcGlfcmVzdFwiLCBcImFwaV9odHRwXCIsIFwiYXBpX3dlYnNvY2tldFwiXSk7XG5cbmNvbnN0IEtFRVBFUl9BQ1RJT05TX0dST1VQID0gW1wibG9nczpGaWx0ZXJMb2dFdmVudHNcIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiXTtcbmNvbnN0IEtFRVBFUl9BQ1RJT05TX1NUUkVBTSA9IFtcImxvZ3M6R2V0TG9nRXZlbnRzXCJdO1xuXG5mdW5jdGlvbiBmYWlsKG1lc3NhZ2U6IHN0cmluZyk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBzaGEyNTZIZXgodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHRleHQsIFwidXRmOFwiKS5kaWdlc3QoXCJoZXhcIik7XG59XG5cbmZ1bmN0aW9uIGJhc2UzMkxvd2VyKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJ5dGVzID0gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUodGV4dCwgXCJ1dGY4XCIpLmRpZ2VzdCgpO1xuICBsZXQgYml0cyA9IDA7XG4gIGxldCB2YWx1ZSA9IDA7XG4gIGxldCBvdXQgPSBcIlwiO1xuICBmb3IgKGNvbnN0IGJ5dGUgb2YgYnl0ZXMpIHtcbiAgICB2YWx1ZSA9ICh2YWx1ZSA8PCA4KSB8IGJ5dGU7XG4gICAgYml0cyArPSA4O1xuICAgIHdoaWxlIChiaXRzID49IDUpIHtcbiAgICAgIG91dCArPSBCQVNFMzJbKHZhbHVlID4+PiAoYml0cyAtIDUpKSAmIDMxXTtcbiAgICAgIGJpdHMgLT0gNTtcbiAgICB9XG4gIH1cbiAgaWYgKGJpdHMgPiAwKSBvdXQgKz0gQkFTRTMyWyh2YWx1ZSA8PCAoNSAtIGJpdHMpKSAmIDMxXTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gc2hvcnRlbihmdWxsOiBzdHJpbmcsIGxpbWl0OiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoZnVsbC5sZW5ndGggPD0gbGltaXQpIHJldHVybiBmdWxsO1xuICBjb25zdCBoZWFkID0gZnVsbC5zbGljZSgwLCBsaW1pdCAtIDkpLnJlcGxhY2UoL1stXy4vXSskLywgXCJcIik7XG4gIHJldHVybiBgJHtoZWFkfS0ke2Jhc2UzMkxvd2VyKGZ1bGwpLnNsaWNlKDAsIDgpfWA7XG59XG5cbmZ1bmN0aW9uIG5hbWVzcGFjZU9mKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZXMubmFtZXNwYWNlID8/IExPR19QUkVGSVg7XG59XG5cbmZ1bmN0aW9uIHNvcnRlZENvcHkodmFsdWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KHZhbHVlcyA/PyBbXSldLnNvcnQoKTtcbn1cblxuZnVuY3Rpb24gbG9nUHJlZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gIHJldHVybiBbTE9HX1BSRUZJWCwgbmFtZXNwYWNlT2YodmFsdWVzKSwgdmFsdWVzLmFwcCwgdmFsdWVzLnN0YWdlXS5qb2luKFwiX1wiKSArIFwiX1wiO1xufVxuXG4vKipcbiAqIFRoZSBgdGhlb3J5Y2xvdWRfcmVzb3VyY2VfbmFtaW5nLnYwLjFgIHByaW1pdGl2ZXMsIGV4cG9zZWQgZm9yIGpzaWkgc28gdGhlIEdvXG4gKiBhbmQgUHl0aG9uIENESyBiaW5kaW5ncyBzaGFyZSBvbmUgaW1wbGVtZW50YXRpb24uXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZyB7XG4gIHByaXZhdGUgY29uc3RydWN0b3IoKSB7fVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSB0aGUgYm91bmQgY29udGV4dCBncmFtbWFyLiBUaHJvd3Mgb24gYW4gaW52YWxpZCBjb250ZXh0LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZUNvbnRleHQodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogdm9pZCB7XG4gICAgaWYgKCFBUFBfUkUudGVzdCh2YWx1ZXMuYXBwKSkgZmFpbChcImFwcFwiKTtcbiAgICBpZiAoIVNUQUdFX1JFLnRlc3QodmFsdWVzLnN0YWdlKSkgZmFpbChcInN0YWdlXCIpO1xuICAgIGlmICghQUNDT1VOVF9SRS50ZXN0KHZhbHVlcy5hY2NvdW50KSkgZmFpbChcImFjY291bnRcIik7XG4gICAgaWYgKCFSRUdJT05fUkUudGVzdCh2YWx1ZXMucmVnaW9uKSkgZmFpbChcInJlZ2lvblwiKTtcbiAgICBpZiAoIU5BTUVTUEFDRV9SRS50ZXN0KG5hbWVzcGFjZU9mKHZhbHVlcykpKSBmYWlsKFwibmFtZXNwYWNlXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbi1hcHBlbmRlZCBhY2NvdW50LXJlZ2lvbmFsIGJ1Y2tldCBzdWZmaXguXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHMzQWNjb3VudFJlZ2lvbmFsU3VmZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAtJHt2YWx1ZXMuYWNjb3VudH0tJHt2YWx1ZXMucmVnaW9ufS1hbmA7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGJvdW5kIHByZWZpeCBzaGFyZWQgYnkgZXZlcnkgbG9nIHNvdXJjZSBvZiB0aGUgYXBwLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBsb2dTb3VyY2VQcmVmaXgodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogc3RyaW5nIHtcbiAgICByZXR1cm4gbG9nUHJlZml4KHZhbHVlcyk7XG4gIH1cblxuICAvKipcbiAgICogTWFwIGEgbG9naWNhbCBsb2cgc291cmNlIHRvIGl0cyBwaHlzaWNhbCBsb2ctZ3JvdXAgbmFtZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbG9nR3JvdXBOYW1lKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcywgbG9naWNhbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAoIWxvZ2ljYWwuc3RhcnRzV2l0aChcImxvZ3MvXCIpKSBmYWlsKFwibG9nIGxvZ2ljYWwgbXVzdCBzdGFydCB3aXRoIGxvZ3MvXCIpO1xuICAgIHJldHVybiBsb2dQcmVmaXgodmFsdWVzKSArIGxvZ2ljYWwucmVwbGFjZSgvXFwvL2csIFwiX1wiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21wb3NlIHRoZSBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZS4gQSBwaW4gYWx3YXlzIHdpbnMuIEEgZ2VuZXJhdGVkXG4gICAqIGVudHJ5IG1lYW5zIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSB0b2RheSBhbmQgdGhlIGNvbnN0cnVjdCBzZXRzXG4gICAqIG5vIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkuIEdlbmVyYXRlZCBlbnRyaWVzIGFyZSBsZWdhY3ktb25seTsgYSBsZWdhY3lcbiAgICogcHJvZmlsZSBuZWVkcyBleGFjdGx5IG9uZSBvZiBhIHBpbiBvciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcGh5c2ljYWxOYW1lKFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICByZXNvdXJjZVR5cGU6IHN0cmluZyxcbiAgICBsb2dpY2FsOiBzdHJpbmcsXG4gICk6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZSB7XG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHZhbHVlcyk7XG4gICAgaWYgKCFMT0dJQ0FMX1JFLnRlc3QobG9naWNhbCkpIGZhaWwoXCJsb2dpY2FsXCIpO1xuICAgIGNvbnN0IHJ1bGUgPSBSVUxFU1tyZXNvdXJjZVR5cGVdO1xuICAgIGlmICghcnVsZSkgZmFpbChgcmVzb3VyY2UgdHlwZSAke3Jlc291cmNlVHlwZX1gKTtcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSB2YWx1ZXMuZ2VuZXJhdGVkID8/IFtdO1xuICAgIGNvbnN0IGxlZ2FjeSA9ICh2YWx1ZXMubmFtaW5nUHJvZmlsZSA/PyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQpID09PSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkxFR0FDWTtcbiAgICBpZiAoZ2VuZXJhdGVkLmxlbmd0aCA+IDAgJiYgIWxlZ2FjeSkge1xuICAgICAgZmFpbChcImdlbmVyYXRlZCBlbnRyaWVzIGFyZSBvbmx5IHZhbGlkIHVuZGVyIHRoZSBsZWdhY3kgbmFtaW5nIHByb2ZpbGVcIik7XG4gICAgfVxuICAgIGNvbnN0IGtleSA9IGAke3Jlc291cmNlVHlwZX06JHtsb2dpY2FsfWA7XG4gICAgY29uc3QgcGluID0gdmFsdWVzLnBpbnM/LltrZXldO1xuICAgIGNvbnN0IGtlZXBHZW5lcmF0ZWQgPSBnZW5lcmF0ZWQuaW5jbHVkZXMoa2V5KTtcbiAgICAvLyByMywgQURWLTEzMTItMzogQ0RLIGRlZmF1bHRzIGFuIEFQSSBOYW1lIHRvZGF5LCBzbyBpdCBpcyBhbiBleHBsaWNpdCBuYW1lXG4gICAgLy8gYW5kIHRha2VzIGEgcGluLCBuZXZlciBhIGdlbmVyYXRlZCBlbnRyeS5cbiAgICBpZiAoa2VlcEdlbmVyYXRlZCAmJiBBUElfVFlQRVMuaGFzKHJlc291cmNlVHlwZSkpIHtcbiAgICAgIGZhaWwoXCJhbiBBUEkgbmFtZSB0YWtlcyBhIHBpbiwgbmV2ZXIgYSBnZW5lcmF0ZWQgZW50cnlcIik7XG4gICAgfVxuICAgIGlmIChwaW4gIT09IHVuZGVmaW5lZCAmJiBrZWVwR2VuZXJhdGVkKSBmYWlsKFwiYSByZXNvdXJjZSBoYXMgYm90aCBhIHBpbiBhbmQgYSBnZW5lcmF0ZWQgZW50cnlcIik7XG4gICAgaWYgKHBpbiAhPT0gdW5kZWZpbmVkKSByZXR1cm4geyBuYW1lOiBwaW4sIHBpbm5lZDogdHJ1ZSB9O1xuICAgIGlmIChrZWVwR2VuZXJhdGVkKSByZXR1cm4geyBnZW5lcmF0ZWQ6IHRydWUgfTtcbiAgICBpZiAobGVnYWN5KSB7XG4gICAgICBmYWlsKGBsZWdhY3kgbmFtaW5nIHByb2ZpbGUgcmVxdWlyZXMgYSBwaW4gb3IgYSBnZW5lcmF0ZWQgZW50cnkgZm9yICR7a2V5fWApO1xuICAgIH1cblxuICAgIGxldCBvdXQ6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZTtcbiAgICBpZiAocnVsZS5raW5kID09PSBcInMzYXJcIikge1xuICAgICAgY29uc3Qgc3VmZml4ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuczNBY2NvdW50UmVnaW9uYWxTdWZmaXgodmFsdWVzKTtcbiAgICAgIGNvbnN0IGJ1ZGdldCA9IHJ1bGUubWF4IC0gc3VmZml4Lmxlbmd0aDtcbiAgICAgIGNvbnN0IHByZWZpeCA9IHNob3J0ZW4oYCR7dmFsdWVzLmFwcH0tJHt2YWx1ZXMuc3RhZ2V9LSR7bG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCItXCIpfWAsIGJ1ZGdldCk7XG4gICAgICBvdXQgPSB7IG5hbWU6IHByZWZpeCArIHN1ZmZpeCwgYnVja2V0TmFtZVByZWZpeDogcHJlZml4LCBidWNrZXROYW1lc3BhY2U6IFwiYWNjb3VudC1yZWdpb25hbFwiIH07XG4gICAgfSBlbHNlIGlmIChydWxlLmtpbmQgPT09IFwiZGFzaFwiKSB7XG4gICAgICBvdXQgPSB7IG5hbWU6IHNob3J0ZW4oYCR7dmFsdWVzLmFwcH0tJHt2YWx1ZXMuc3RhZ2V9LSR7bG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCItXCIpfWAsIHJ1bGUubWF4KSB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcInBhdGhcIikge1xuICAgICAgY29uc3QgZnVsbCA9IGAke3J1bGUubGVhZCA/PyBcIlwifSR7dmFsdWVzLmFwcH0vJHt2YWx1ZXMuc3RhZ2V9LyR7bG9naWNhbH1gO1xuICAgICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzZWNyZXRcIiAmJiBTRUNSRVRfVEFJTF9SRS50ZXN0KGZ1bGwpKSB7XG4gICAgICAgIGZhaWwoXCJzZWNyZXQgbmFtZSBtdXN0IG5vdCBlbmQgd2l0aCBhIGh5cGhlbiBhbmQgc2l4IGNoYXJhY3RlcnNcIik7XG4gICAgICB9XG4gICAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcInNzbV9wYXJhbWV0ZXJcIiAmJiAoZnVsbC5tYXRjaCgvXFwvL2cpPy5sZW5ndGggPz8gMCkgPiAxNSkge1xuICAgICAgICBmYWlsKFwic3NtIGhpZXJhcmNoeSBkZWVwZXIgdGhhbiAxNVwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChmdWxsLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwicGF0aCBuYW1lIG92ZXIgbGltaXRcIik7XG4gICAgICBvdXQgPSB7IG5hbWU6IGZ1bGwgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJsb2dcIikge1xuICAgICAgY29uc3QgbmFtZSA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ0dyb3VwTmFtZSh2YWx1ZXMsIGxvZ2ljYWwpO1xuICAgICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJsb2cgZ3JvdXAgb3ZlciBsaW1pdFwiKTtcbiAgICAgIG91dCA9IHsgbmFtZSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBmYWlsKGB1bnN1cHBvcnRlZCBraW5kICR7U3RyaW5nKHJ1bGUua2luZCl9YCk7XG4gICAgfVxuXG4gICAgY29uc3QgbmFtZSA9IG91dC5uYW1lIGFzIHN0cmluZztcbiAgICBpZiAoIW5ldyBSZWdFeHAoYF4oPzoke3J1bGUuY2hhcnNldH0pKyRgKS50ZXN0KG5hbWUpKSBmYWlsKFwiY2hhcnNldFwiKTtcbiAgICBpZiAobmFtZS5sZW5ndGggPiBydWxlLm1heCkgZmFpbChcImxlbmd0aFwiKTtcbiAgICBpZiAoW1wiczNfYnVja2V0XCIsIFwiczNfdmVjdG9yX2J1Y2tldFwiLCBcInMzX3ZlY3Rvcl9pbmRleFwiXS5pbmNsdWRlcyhyZXNvdXJjZVR5cGUpICYmICFTM19FREdFU19SRS50ZXN0KG5hbWUpKSB7XG4gICAgICBmYWlsKFwiczMgc3RhcnQvZW5kXCIpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlIG9uZSBzZWxlY3Rvci4gVGhyb3dzIG9uIGEgc2VsZWN0b3Igb3V0c2lkZSB0aGUgZ3JhbW1hci5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcjogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgYmFzZSA9IHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikgPyBzZWxlY3Rvci5zbGljZSgwLCAtMikgOiBzZWxlY3RvcjtcbiAgICBpZiAoIUxPR0lDQUxfUkUudGVzdChiYXNlKSB8fCBiYXNlLnNwbGl0KFwiL1wiKVswXSAhPT0gXCJsb2dzXCIgfHwgKGJhc2UgPT09IFwibG9nc1wiICYmICFzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSkge1xuICAgICAgZmFpbChgc2VsZWN0b3IgJHtzZWxlY3Rvcn1gKTtcbiAgICB9XG4gICAgaWYgKGJhc2UuaW5jbHVkZXMoXCIqXCIpKSBmYWlsKFwid2lsZGNhcmQgb25seSBhcyB0cmFpbGluZyAvKlwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGEgc2VsZWN0b3IgbWF0Y2hlcyBhIGxvZ2ljYWwgc291cmNlLiBBIHRyYWlsaW5nIGAvKmAgbWF0Y2hlc1xuICAgKiBkZXNjZW5kYW50cyBvbmx5LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3I6IHN0cmluZywgbG9naWNhbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpIHJldHVybiBsb2dpY2FsLnN0YXJ0c1dpdGgoc2VsZWN0b3Iuc2xpY2UoMCwgLTEpKTtcbiAgICByZXR1cm4gbG9naWNhbCA9PT0gc2VsZWN0b3I7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBhIHNvdXJjZSBpcyB2aXNpYmxlOiBhbiBpbmNsdWRlIG1hdGNoZXMgYW5kIG5vIGV4Y2x1ZGUgZG9lcy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc291cmNlVmlzaWJsZShydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLCBsb2dpY2FsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBjb25zdCBpbmNsdWRlZCA9IChydWxlcy5pbmNsdWRlID8/IFtdKS5zb21lKChzZWxlY3RvcikgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yLCBsb2dpY2FsKSk7XG4gICAgaWYgKCFpbmNsdWRlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiAhKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pLnNvbWUoKHNlbGVjdG9yKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3IsIGxvZ2ljYWwpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgU0hBLTI1NiBvdmVyIHRoZSBjYW5vbmljYWwgcnVsZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHJ1bGVWZXJzaW9uKHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMpOiBzdHJpbmcge1xuICAgIGNvbnN0IGNhbm9uaWNhbCA9IGB7XCJleGNsdWRlXCI6JHtKU09OLnN0cmluZ2lmeShzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpKX0sXCJpbmNsdWRlXCI6JHtKU09OLnN0cmluZ2lmeShzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpKX19YDtcbiAgICByZXR1cm4gc2hhMjU2SGV4KGNhbm9uaWNhbCkuc2xpY2UoMCwgMTIpO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBpbGUgdGhlIHJ1bGVzIGludG8gdGhlIHJlYWRlci1yb2xlIGlubGluZSBwb2xpY3kgZG9jdW1lbnQuIFRoZSByZXR1cm5cbiAgICogdmFsdWUgaXMgdGhlIGNvbnRyYWN0IEpTT04sIHNvIGEgY29uc3VtZXIgY2FuIGNvbXBhcmUgaXQgYnl0ZSBmb3IgYnl0ZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgY29tcGlsZVZpc2liaWxpdHlQb2xpY3lKc29uKFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICApOiBzdHJpbmcge1xuICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgWy4uLihydWxlcy5pbmNsdWRlID8/IFtdKSwgLi4uKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pXSkge1xuICAgICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgfVxuICAgIGNvbnN0IGJhc2UgPSBgYXJuOmF3czpsb2dzOiR7dmFsdWVzLnJlZ2lvbn06JHt2YWx1ZXMuYWNjb3VudH06bG9nLWdyb3VwOmA7XG4gICAgY29uc3QgYXJuc0ZvciA9IChzZWxlY3Rvcjogc3RyaW5nKTogc3RyaW5nW10gPT4ge1xuICAgICAgaWYgKHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpIHtcbiAgICAgICAgcmV0dXJuIFtiYXNlICsgbG9nUHJlZml4KHZhbHVlcykgKyBzZWxlY3Rvci5zbGljZSgwLCAtMSkucmVwbGFjZSgvXFwvL2csIFwiX1wiKSArIFwiKlwiXTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG5hbWUgPSBsb2dQcmVmaXgodmFsdWVzKSArIHNlbGVjdG9yLnJlcGxhY2UoL1xcLy9nLCBcIl9cIik7XG4gICAgICByZXR1cm4gW2Jhc2UgKyBuYW1lLCBiYXNlICsgbmFtZSArIFwiOipcIl07XG4gICAgfTtcbiAgICBjb25zdCBhY3Rpb25zID0gWy4uLktFRVBFUl9BQ1RJT05TX0dST1VQLCAuLi5LRUVQRVJfQUNUSU9OU19TVFJFQU1dO1xuICAgIGNvbnN0IHN0YXRlbWVudHM6IHsgU2lkOiBzdHJpbmc7IEVmZmVjdDogc3RyaW5nOyBBY3Rpb246IHN0cmluZ1tdOyBSZXNvdXJjZTogc3RyaW5nW10gfVtdID0gW1xuICAgICAge1xuICAgICAgICBTaWQ6IFwiUmVhZE1hbmlmZXN0XCIsXG4gICAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgICBBY3Rpb246IFtcInNzbTpHZXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgIFJlc291cmNlOiBbXG4gICAgICAgICAgYGFybjphd3M6c3NtOiR7dmFsdWVzLnJlZ2lvbn06JHt2YWx1ZXMuYWNjb3VudH06cGFyYW1ldGVyLyR7TE9HX1BSRUZJWH0vdmlzaWJpbGl0eS8ke3ZhbHVlcy5hcHB9LyR7dmFsdWVzLnN0YWdlfS9tYW5pZmVzdGAsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3QgaW5jbHVkZWQgPSBzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpLmZsYXRNYXAoYXJuc0Zvcik7XG4gICAgY29uc3QgZXhjbHVkZWQgPSBzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpLmZsYXRNYXAoYXJuc0Zvcik7XG4gICAgaWYgKGluY2x1ZGVkLmxlbmd0aCA+IDApIHN0YXRlbWVudHMucHVzaCh7IFNpZDogXCJSZWFkSW5jbHVkZWRcIiwgRWZmZWN0OiBcIkFsbG93XCIsIEFjdGlvbjogYWN0aW9ucywgUmVzb3VyY2U6IGluY2x1ZGVkIH0pO1xuICAgIGlmIChleGNsdWRlZC5sZW5ndGggPiAwKSBzdGF0ZW1lbnRzLnB1c2goeyBTaWQ6IFwiRGVueUV4Y2x1ZGVkXCIsIEVmZmVjdDogXCJEZW55XCIsIEFjdGlvbjogYWN0aW9ucywgUmVzb3VyY2U6IGV4Y2x1ZGVkIH0pO1xuICAgIGNvbnN0IGRvY3VtZW50ID0gSlNPTi5zdHJpbmdpZnkoeyBWZXJzaW9uOiBcIjIwMTItMTAtMTdcIiwgU3RhdGVtZW50OiBzdGF0ZW1lbnRzIH0pO1xuICAgIGlmIChkb2N1bWVudC5sZW5ndGggPiBST0xFX1BPTElDWV9NQVgpIGZhaWwoXCJjb21waWxlZCBwb2xpY3kgb3ZlciByb2xlIHBvbGljeSBzaXplXCIpO1xuICAgIHJldHVybiBkb2N1bWVudDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBc3NlbWJsZSB0aGUgc3ludGgtdGltZSB2aXNpYmlsaXR5IHByZXZpZXcuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZpc2liaWxpdHlQcmV2aWV3KFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIHNvdXJjZXM6IHN0cmluZ1tdLFxuICApOiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHZhbHVlcyk7XG4gICAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBbLi4uKHJ1bGVzLmluY2x1ZGUgPz8gW10pLCAuLi4ocnVsZXMuZXhjbHVkZSA/PyBbXSldKSB7XG4gICAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHJ1bGVWZXJzaW9uOiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5ydWxlVmVyc2lvbihydWxlcyksXG4gICAgICBtYXRjaGVkTm93OiBzb3VyY2VzLmZpbHRlcigoc291cmNlKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBzb3VyY2UpKS5zb3J0KCksXG4gICAgICBub3RNYXRjaGVkTm93OiBzb3VyY2VzLmZpbHRlcigoc291cmNlKSA9PiAhQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgc291cmNlKSkuc29ydCgpLFxuICAgICAgZnV0dXJlOiB7IGluY2x1ZGU6IHNvcnRlZENvcHkocnVsZXMuaW5jbHVkZSksIGV4Y2x1ZGU6IHNvcnRlZENvcHkocnVsZXMuZXhjbHVkZSkgfSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEFzc2VtYmxlIHRoZSBwdWJsaXNoZWQgbWFuaWZlc3QgKHRoZSBwcmV2aWV3IG1pbnVzIGBub3RNYXRjaGVkTm93YCkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZpc2liaWxpdHlNYW5pZmVzdChcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBzb3VyY2VzOiBzdHJpbmdbXSxcbiAgKTogQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0IHtcbiAgICBjb25zdCBwcmV2aWV3ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmlzaWJpbGl0eVByZXZpZXcodmFsdWVzLCBydWxlcywgc291cmNlcyk7XG4gICAgcmV0dXJuIHsgcnVsZVZlcnNpb246IHByZXZpZXcucnVsZVZlcnNpb24sIG1hdGNoZWROb3c6IHByZXZpZXcubWF0Y2hlZE5vdywgZnV0dXJlOiBwcmV2aWV3LmZ1dHVyZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFNlcmlhbGl6ZSBhIG1hbmlmZXN0IHRvIHRoZSBjb250cmFjdCBKU09OIHNoYXBlIHdyaXR0ZW4gdG8gU1NNLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBtYW5pZmVzdEpzb24obWFuaWZlc3Q6IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHJ1bGVfdmVyc2lvbjogbWFuaWZlc3QucnVsZVZlcnNpb24sXG4gICAgICBtYXRjaGVkX25vdzogbWFuaWZlc3QubWF0Y2hlZE5vdyxcbiAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBtYW5pZmVzdC5mdXR1cmUuaW5jbHVkZSA/PyBbXSwgZXhjbHVkZTogbWFuaWZlc3QuZnV0dXJlLmV4Y2x1ZGUgPz8gW10gfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBLZWVwZXIncyByZWFkIGRlY2lzaW9uLCBpbiB0aGUgcnVudGltZXMnIHBhcmFtZXRlciBvcmRlci4gRmFpbHMgY2xvc2VkIG9uIGFcbiAgICogZGVuaWFsIG9yIGFuIHVucmVhY2hhYmxlIGFjY291bnQuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGtlZXBlckRlY2lzaW9uKFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICAgbG9naWNhbDogc3RyaW5nLFxuICAgIGF3c1Jlc3VsdDogc3RyaW5nLFxuICApOiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIge1xuICAgIGlmICghcnVsZXMgfHwgIUFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIGxvZ2ljYWwpKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLk5PVF9TSEFSRUQ7XG4gICAgfVxuICAgIGlmIChhd3NSZXN1bHQgPT09IFwiZXZlbnRzXCIpIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuRVZFTlRTO1xuICAgIGlmIChhd3NSZXN1bHQgPT09IFwiZW1wdHlcIiB8fCBhd3NSZXN1bHQgPT09IFwibm90X2ZvdW5kXCIpIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuQUxMT1dFRF9OT19FVkVOVFM7XG4gICAgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5OT1RfU0hBUkVEO1xuICB9XG59XG4iXX0=