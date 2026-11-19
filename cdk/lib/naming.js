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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryResourceNaming", version: "7.4.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekM7O0dBRUc7QUFDVSxRQUFBLHdCQUF3QixHQUFHLGtDQUFrQyxDQUFDO0FBRTNFOztHQUVHO0FBQ0gsSUFBWSxzQkFTWDtBQVRELFdBQVksc0JBQXNCO0lBQ2hDOztPQUVHO0lBQ0gsNkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCwyQ0FBaUIsQ0FBQTtBQUNuQixDQUFDLEVBVFcsc0JBQXNCLHNDQUF0QixzQkFBc0IsUUFTakM7QUFFRDs7R0FFRztBQUNILElBQVksdUJBU1g7QUFURCxXQUFZLHVCQUF1QjtJQUNqQzs7T0FFRztJQUNILGdEQUFxQixDQUFBO0lBQ3JCOztPQUVHO0lBQ0gsNENBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBU2xDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHFCQWFYO0FBYkQsV0FBWSxxQkFBcUI7SUFDL0I7O09BRUc7SUFDSCwwQ0FBaUIsQ0FBQTtJQUNqQjs7T0FFRztJQUNILGdFQUF1QyxDQUFBO0lBQ3ZDOztPQUVHO0lBQ0gsa0RBQXlCLENBQUE7QUFDM0IsQ0FBQyxFQWJXLHFCQUFxQixxQ0FBckIscUJBQXFCLFFBYWhDO0FBbUtELE1BQU0sZUFBZSxHQUFHLDBCQUEwQixDQUFDO0FBQ25ELE1BQU0sVUFBVSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksZUFBZSxPQUFPLGVBQWUsS0FBSyxDQUFDLENBQUM7QUFDOUUsTUFBTSxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxlQUFlLEdBQUcsQ0FBQyxDQUFDO0FBQ2xELE1BQU0sUUFBUSxHQUFHLHNCQUFzQixDQUFDO0FBQ3hDLE1BQU0sWUFBWSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksZUFBZSxHQUFHLENBQUMsQ0FBQztBQUN4RCxNQUFNLFVBQVUsR0FB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LEtBQUssT0FBTyxJQUFJLFNBQVMsS0FBSyxXQUFXO1lBQUUsT0FBTyxxQkFBcUIsQ0FBQyxpQkFBaUIsQ0FBQztRQUN2RyxPQUFPLHFCQUFxQixDQUFDLFVBQVUsQ0FBQztJQUMxQyxDQUFDOztBQTNPSCwwREE0T0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbi8qKlxuICogVGhlIHJlc291cmNlLW5hbWluZyBjb250cmFjdCB0aGlzIG1vZHVsZSBpbXBsZW1lbnRzLlxuICovXG5leHBvcnQgY29uc3QgUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNUID0gXCJ0aGVvcnljbG91ZF9yZXNvdXJjZV9uYW1pbmcudjAuMVwiO1xuXG4vKipcbiAqIE5hbWluZyBwcm9maWxlcyBhY2NlcHRlZCBieSBhIG5hbWluZyBjb250ZXh0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlIHtcbiAgLyoqXG4gICAqIE5hbWVzIGRlcml2ZSBmcm9tIHRoZSBuYW1pbmcgY29udGV4dC5cbiAgICovXG4gIERFUklWRUQgPSBcImRlcml2ZWRcIixcbiAgLyoqXG4gICAqIEV2ZXJ5IG5hbWUgY29tZXMgZnJvbSBhIHBpbi5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG59XG5cbi8qKlxuICogTG9nZ2luZyBwcm9maWxlcyBhY2NlcHRlZCBieSBhIG5hbWluZyBjb250ZXh0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZSB7XG4gIC8qKlxuICAgKiBBcHBUaGVvcnkgY3JlYXRlcyBzdGFuZGFyZCBsb2cgZ3JvdXBzIGFuZCBhY2Nlc3MgbG9nZ2luZy5cbiAgICovXG4gIFNUQU5EQVJEID0gXCJzdGFuZGFyZFwiLFxuICAvKipcbiAgICogRWFjaCBjb25zdHJ1Y3Qga2VlcHMgaXRzIHByZS1jb250cmFjdCBsb2dnaW5nIGJlaGF2aW91ci5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG59XG5cbi8qKlxuICogS2VlcGVyJ3MgYW5zd2VyIHRvIGEgcmVhZGVyIHJlcXVlc3QuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUtlZXBlckFuc3dlciB7XG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIHNoYXJlZCBhbmQgdGhlIHJlYWQgcmV0dXJuZWQgZXZlbnRzLlxuICAgKi9cbiAgRVZFTlRTID0gXCJldmVudHNcIixcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgc2hhcmVkIGFuZCB0aGUgcmVhZCByZXR1cm5lZCBubyBldmVudHMuXG4gICAqL1xuICBBTExPV0VEX05PX0VWRU5UUyA9IFwiYWxsb3dlZF9ub19ldmVudHNcIixcbiAgLyoqXG4gICAqIFRoZSBzb3VyY2UgaXMgbm90IHNoYXJlZCwgb3IgdGhlIHJlYWQgZmFpbGVkIGNsb3NlZC5cbiAgICovXG4gIE5PVF9TSEFSRUQgPSBcIm5vdF9zaGFyZWRcIixcbn1cblxuLyoqXG4gKiBCb3VuZCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dCB2YWx1ZXMgZnJvbSBzdGFnZSBjb25maWcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICogQGRlZmF1bHQgXCJ0aGVvcnljbG91ZFwiXG4gICAqL1xuICByZWFkb25seSBuYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFwcCBpbnN0YW5jZSBpZC5cbiAgICovXG4gIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZC5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFR3ZWx2ZS1kaWdpdCBhY2NvdW50IGlkLiBBbiB1bnJlc29sdmVkIHRva2VuIGZhaWxzIHN5bnRoZXNpcy5cbiAgICovXG4gIHJlYWRvbmx5IGFjY291bnQ6IHN0cmluZztcblxuICAvKipcbiAgICogRnVsbCBSZWdpb24gY29kZSwgZm9yIGV4YW1wbGUgYHVzLWVhc3QtMWAuXG4gICAqL1xuICByZWFkb25seSByZWdpb246IHN0cmluZztcblxuICAvKipcbiAgICogUGh5c2ljYWwgcGlucyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuXG4gICAqIEBkZWZhdWx0IHt9XG4gICAqL1xuICByZWFkb25seSBwaW5zPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAvKipcbiAgICogR2VuZXJhdGVkLW5hbWUgZW50cmllcyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuIEFuIGVudHJ5IG1lYW5zXG4gICAqIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSB0b2RheSwgc28gdGhlIGNvbnN0cnVjdCBzZXRzIG5vXG4gICAqIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkuIFZhbGlkIG9ubHkgdW5kZXIgdGhlIGxlZ2FjeSBuYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBOYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5ERVJJVkVEXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdQcm9maWxlPzogQXBwVGhlb3J5TmFtaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nZ2luZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZS5MRUdBQ1lcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2dpbmdQcm9maWxlPzogQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZyByZXRlbnRpb24gaW4gZGF5cyBmb3Igc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXBzLlxuICAgKiBAZGVmYXVsdCAzMFxuICAgKi9cbiAgcmVhZG9ubHkgcmV0ZW50aW9uRGF5cz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBUaGUgY29tcG9zZWQgcGh5c2ljYWwgbmFtZSBvZiBvbmUgcmVzb3VyY2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UGh5c2ljYWxOYW1lIHtcbiAgLyoqXG4gICAqIFRoZSBmdWxsIHBoeXNpY2FsIG5hbWUuIEFic2VudCB3aGVuIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYWNjb3VudC1yZWdpb25hbCBidWNrZXQtbmFtZSBwcmVmaXgsIHdoZW4gdGhlIHR5cGUgdXNlcyBvbmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYnVja2V0TmFtZVByZWZpeD86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGJ1Y2tldCBuYW1lc3BhY2UsIHdoZW4gdGhlIHR5cGUgdXNlcyBvbmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYnVja2V0TmFtZXNwYWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBuYW1lIGNhbWUgZnJvbSBhIHBpbi5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHBpbm5lZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lLCBzbyBubyBwaHlzaWNhbC1uYW1lIHByb3BlcnR5IGlzXG4gICAqIHNldC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogSW5jbHVkZSBhbmQgZXhjbHVkZSB2aXNpYmlsaXR5IHNlbGVjdG9ycy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMge1xuICAvKipcbiAgICogU2VsZWN0b3JzIHdob3NlIHNvdXJjZXMgYXJlIHNoYXJlZC5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGluY2x1ZGU/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogU2VsZWN0b3JzIHdob3NlIHNvdXJjZXMgYXJlIG5ldmVyIHNoYXJlZC4gRXhjbHVzaW9ucyB3aW4uXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBleGNsdWRlPzogc3RyaW5nW107XG59XG5cbi8qKlxuICogVGhlIHN5bnRoLXRpbWUgdmlzaWJpbGl0eSBwcmV2aWV3LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVZpc2liaWxpdHlQcmV2aWV3IHtcbiAgLyoqXG4gICAqIEZpcnN0IDEyIGhleCBjaGFyYWN0ZXJzIG9mIHRoZSBjYW5vbmljYWwgcnVsZXMgaGFzaC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bGVWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgc2hhcmUuXG4gICAqL1xuICByZWFkb25seSBtYXRjaGVkTm93OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBkbyBub3Qgc2hhcmUuXG4gICAqL1xuICByZWFkb25seSBub3RNYXRjaGVkTm93OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIHNlbGVjdG9ycywgYXMgdGhlIHN0YXRlbWVudCBvZiB3aGF0IGZ1dHVyZSBzb3VyY2VzIHdpbGwgbWF0Y2guXG4gICAqL1xuICByZWFkb25seSBmdXR1cmU6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcztcbn1cblxuLyoqXG4gKiBUaGUgcHVibGlzaGVkIFNTTSBtYW5pZmVzdDogdGhlIHByZXZpZXcgbWludXMgYG5vdE1hdGNoZWROb3dgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdCB7XG4gIC8qKlxuICAgKiBGaXJzdCAxMiBoZXggY2hhcmFjdGVycyBvZiB0aGUgY2Fub25pY2FsIHJ1bGVzIGhhc2guXG4gICAqL1xuICByZWFkb25seSBydWxlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBzZWxlY3RvcnMsIGFzIHRoZSBzdGF0ZW1lbnQgb2Ygd2hhdCBmdXR1cmUgc291cmNlcyB3aWxsIG1hdGNoLlxuICAgKi9cbiAgcmVhZG9ubHkgZnV0dXJlOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXM7XG59XG5cbmNvbnN0IFNFR01FTlRfUEFUVEVSTiA9IFwiW2EtejAtOV0rKD86LVthLXowLTldKykqXCI7XG5jb25zdCBMT0dJQ0FMX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSg/Oi8ke1NFR01FTlRfUEFUVEVSTn0pKiRgKTtcbmNvbnN0IEFQUF9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0kYCk7XG5jb25zdCBTVEFHRV9SRSA9IC9eW2Etel1bYS16MC05XXswLDd9JC87XG5jb25zdCBOQU1FU1BBQ0VfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59JGApO1xuY29uc3QgQUNDT1VOVF9SRSA9IC9eWzAtOV17MTJ9JC87XG5jb25zdCBSRUdJT05fUkUgPSAvXlthLXpdezJ9KD86LVthLXpdKykrLVswLTldJC87XG5jb25zdCBTRUNSRVRfVEFJTF9SRSA9IC8tW0EtWmEtejAtOV17Nn0kLztcbmNvbnN0IFMzX0VER0VTX1JFID0gL15bYS16MC05XS4qW2EtejAtOV0kLztcbmNvbnN0IExPR19QUkVGSVggPSBcInRoZW9yeWNsb3VkXCI7XG5jb25zdCBST0xFX1BPTElDWV9NQVggPSAxMDI0MDtcbmNvbnN0IEJBU0UzMiA9IFwiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoyMzQ1NjdcIjtcblxuaW50ZXJmYWNlIFJ1bGUge1xuICByZWFkb25seSBraW5kOiBcImRhc2hcIiB8IFwicGF0aFwiIHwgXCJzM2FyXCIgfCBcImxvZ1wiO1xuICByZWFkb25seSBtYXg6IG51bWJlcjtcbiAgcmVhZG9ubHkgY2hhcnNldDogc3RyaW5nO1xuICByZWFkb25seSBsZWFkPzogc3RyaW5nO1xufVxuXG5jb25zdCBSVUxFUzogeyBbdHlwZTogc3RyaW5nXTogUnVsZSB9ID0ge1xuICBzM19idWNrZXQ6IHsga2luZDogXCJzM2FyXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgczNfdmVjdG9yX2J1Y2tldDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MywgY2hhcnNldDogXCJbYS16MC05LV1cIiB9LFxuICBzM192ZWN0b3JfaW5kZXg6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgZHluYW1vZGJfdGFibGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU1LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLi1dXCIgfSxcbiAgbGFtYmRhX2Z1bmN0aW9uOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzcXNfcXVldWU6IHsga2luZDogXCJkYXNoXCIsIG1heDogODAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIHNuc190b3BpYzogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTYsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIHNlY3JldDogeyBraW5kOiBcInBhdGhcIiwgbWF4OiA1MTIsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS9fKz0uQC1dXCIgfSxcbiAgc3NtX3BhcmFtZXRlcjogeyBraW5kOiBcInBhdGhcIiwgbWF4OiA5MDAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8uLy1dXCIsIGxlYWQ6IFwiL1wiIH0sXG4gIGttc19hbGlhczogeyBraW5kOiBcInBhdGhcIiwgbWF4OiAyNTYsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS9fLV1cIiwgbGVhZDogXCJhbGlhcy9cIiB9LFxuICBldmVudF9idXM6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTkuXy1dXCIgfSxcbiAgZXZlbnRfcnVsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIHNjaGVkdWxlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkuXy1dXCIgfSxcbiAgYWxhcm06IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU1LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLi1dXCIgfSxcbiAgZGFzaGJvYXJkOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgaWFtX3JvbGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOSs9LC5AXy1dXCIgfSxcbiAgaWFtX21hbmFnZWRfcG9saWN5OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Kz0sLkBfLV1cIiB9LFxuICBzdGF0ZV9tYWNoaW5lOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDgwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBjb2RlYnVpbGRfcHJvamVjdDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxNTAsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV9yZXN0OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgYXBpX2h0dHA6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTI4LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfd2Vic29ja2V0OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2RlbGl2ZXJ5X3NvdXJjZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2RlbGl2ZXJ5X2Rlc3RpbmF0aW9uOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBsb2dfZ3JvdXA6IHsga2luZDogXCJsb2dcIiwgbWF4OiA1MTIsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG59O1xuXG5jb25zdCBLRUVQRVJfQUNUSU9OU19HUk9VUCA9IFtcImxvZ3M6RmlsdGVyTG9nRXZlbnRzXCIsIFwibG9nczpEZXNjcmliZUxvZ1N0cmVhbXNcIl07XG5jb25zdCBLRUVQRVJfQUNUSU9OU19TVFJFQU0gPSBbXCJsb2dzOkdldExvZ0V2ZW50c1wiXTtcblxuZnVuY3Rpb24gZmFpbChtZXNzYWdlOiBzdHJpbmcpOiBuZXZlciB7XG4gIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gc2hhMjU2SGV4KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZSh0ZXh0LCBcInV0ZjhcIikuZGlnZXN0KFwiaGV4XCIpO1xufVxuXG5mdW5jdGlvbiBiYXNlMzJMb3dlcih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBieXRlcyA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHRleHQsIFwidXRmOFwiKS5kaWdlc3QoKTtcbiAgbGV0IGJpdHMgPSAwO1xuICBsZXQgdmFsdWUgPSAwO1xuICBsZXQgb3V0ID0gXCJcIjtcbiAgZm9yIChjb25zdCBieXRlIG9mIGJ5dGVzKSB7XG4gICAgdmFsdWUgPSAodmFsdWUgPDwgOCkgfCBieXRlO1xuICAgIGJpdHMgKz0gODtcbiAgICB3aGlsZSAoYml0cyA+PSA1KSB7XG4gICAgICBvdXQgKz0gQkFTRTMyWyh2YWx1ZSA+Pj4gKGJpdHMgLSA1KSkgJiAzMV07XG4gICAgICBiaXRzIC09IDU7XG4gICAgfVxuICB9XG4gIGlmIChiaXRzID4gMCkgb3V0ICs9IEJBU0UzMlsodmFsdWUgPDwgKDUgLSBiaXRzKSkgJiAzMV07XG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIHNob3J0ZW4oZnVsbDogc3RyaW5nLCBsaW1pdDogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKGZ1bGwubGVuZ3RoIDw9IGxpbWl0KSByZXR1cm4gZnVsbDtcbiAgY29uc3QgaGVhZCA9IGZ1bGwuc2xpY2UoMCwgbGltaXQgLSA5KS5yZXBsYWNlKC9bLV8uL10rJC8sIFwiXCIpO1xuICByZXR1cm4gYCR7aGVhZH0tJHtiYXNlMzJMb3dlcihmdWxsKS5zbGljZSgwLCA4KX1gO1xufVxuXG5mdW5jdGlvbiBuYW1lc3BhY2VPZih2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWVzLm5hbWVzcGFjZSA/PyBMT0dfUFJFRklYO1xufVxuXG5mdW5jdGlvbiBzb3J0ZWRDb3B5KHZhbHVlczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbLi4ubmV3IFNldCh2YWx1ZXMgPz8gW10pXS5zb3J0KCk7XG59XG5cbmZ1bmN0aW9uIGxvZ1ByZWZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gW0xPR19QUkVGSVgsIG5hbWVzcGFjZU9mKHZhbHVlcyksIHZhbHVlcy5hcHAsIHZhbHVlcy5zdGFnZV0uam9pbihcIl9cIikgKyBcIl9cIjtcbn1cblxuLyoqXG4gKiBUaGUgYHRoZW9yeWNsb3VkX3Jlc291cmNlX25hbWluZy52MC4xYCBwcmltaXRpdmVzLCBleHBvc2VkIGZvciBqc2lpIHNvIHRoZSBHb1xuICogYW5kIFB5dGhvbiBDREsgYmluZGluZ3Mgc2hhcmUgb25lIGltcGxlbWVudGF0aW9uLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcge1xuICBwcml2YXRlIGNvbnN0cnVjdG9yKCkge31cblxuICAvKipcbiAgICogVmFsaWRhdGUgdGhlIGJvdW5kIGNvbnRleHQgZ3JhbW1hci4gVGhyb3dzIG9uIGFuIGludmFsaWQgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVDb250ZXh0KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHZvaWQge1xuICAgIGlmICghQVBQX1JFLnRlc3QodmFsdWVzLmFwcCkpIGZhaWwoXCJhcHBcIik7XG4gICAgaWYgKCFTVEFHRV9SRS50ZXN0KHZhbHVlcy5zdGFnZSkpIGZhaWwoXCJzdGFnZVwiKTtcbiAgICBpZiAoIUFDQ09VTlRfUkUudGVzdCh2YWx1ZXMuYWNjb3VudCkpIGZhaWwoXCJhY2NvdW50XCIpO1xuICAgIGlmICghUkVHSU9OX1JFLnRlc3QodmFsdWVzLnJlZ2lvbikpIGZhaWwoXCJyZWdpb25cIik7XG4gICAgaWYgKCFOQU1FU1BBQ0VfUkUudGVzdChuYW1lc3BhY2VPZih2YWx1ZXMpKSkgZmFpbChcIm5hbWVzcGFjZVwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgQ2xvdWRGb3JtYXRpb24tYXBwZW5kZWQgYWNjb3VudC1yZWdpb25hbCBidWNrZXQgc3VmZml4LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzM0FjY291bnRSZWdpb25hbFN1ZmZpeCh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICAgIHJldHVybiBgLSR7dmFsdWVzLmFjY291bnR9LSR7dmFsdWVzLnJlZ2lvbn0tYW5gO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBib3VuZCBwcmVmaXggc2hhcmVkIGJ5IGV2ZXJ5IGxvZyBzb3VyY2Ugb2YgdGhlIGFwcC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbG9nU291cmNlUHJlZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGxvZ1ByZWZpeCh2YWx1ZXMpO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hcCBhIGxvZ2ljYWwgbG9nIHNvdXJjZSB0byBpdHMgcGh5c2ljYWwgbG9nLWdyb3VwIG5hbWUuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGxvZ0dyb3VwTmFtZSh2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsIGxvZ2ljYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKCFsb2dpY2FsLnN0YXJ0c1dpdGgoXCJsb2dzL1wiKSkgZmFpbChcImxvZyBsb2dpY2FsIG11c3Qgc3RhcnQgd2l0aCBsb2dzL1wiKTtcbiAgICByZXR1cm4gbG9nUHJlZml4KHZhbHVlcykgKyBsb2dpY2FsLnJlcGxhY2UoL1xcLy9nLCBcIl9cIik7XG4gIH1cblxuICAvKipcbiAgICogQ29tcG9zZSB0aGUgcGh5c2ljYWwgbmFtZSBvZiBvbmUgcmVzb3VyY2UuIEEgcGluIGFsd2F5cyB3aW5zLiBBIGdlbmVyYXRlZFxuICAgKiBlbnRyeSBtZWFucyBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgdG9kYXkgYW5kIHRoZSBjb25zdHJ1Y3Qgc2V0c1xuICAgKiBubyBwaHlzaWNhbC1uYW1lIHByb3BlcnR5LiBHZW5lcmF0ZWQgZW50cmllcyBhcmUgbGVnYWN5LW9ubHk7IGEgbGVnYWN5XG4gICAqIHByb2ZpbGUgbmVlZHMgZXhhY3RseSBvbmUgb2YgYSBwaW4gb3IgYSBnZW5lcmF0ZWQgZW50cnkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHBoeXNpY2FsTmFtZShcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcmVzb3VyY2VUeXBlOiBzdHJpbmcsXG4gICAgbG9naWNhbDogc3RyaW5nLFxuICApOiBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh2YWx1ZXMpO1xuICAgIGlmICghTE9HSUNBTF9SRS50ZXN0KGxvZ2ljYWwpKSBmYWlsKFwibG9naWNhbFwiKTtcbiAgICBjb25zdCBydWxlID0gUlVMRVNbcmVzb3VyY2VUeXBlXTtcbiAgICBpZiAoIXJ1bGUpIGZhaWwoYHJlc291cmNlIHR5cGUgJHtyZXNvdXJjZVR5cGV9YCk7XG4gICAgY29uc3QgZ2VuZXJhdGVkID0gdmFsdWVzLmdlbmVyYXRlZCA/PyBbXTtcbiAgICBjb25zdCBsZWdhY3kgPSAodmFsdWVzLm5hbWluZ1Byb2ZpbGUgPz8gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5ERVJJVkVEKSA9PT0gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5MRUdBQ1k7XG4gICAgaWYgKGdlbmVyYXRlZC5sZW5ndGggPiAwICYmICFsZWdhY3kpIHtcbiAgICAgIGZhaWwoXCJnZW5lcmF0ZWQgZW50cmllcyBhcmUgb25seSB2YWxpZCB1bmRlciB0aGUgbGVnYWN5IG5hbWluZyBwcm9maWxlXCIpO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSBgJHtyZXNvdXJjZVR5cGV9OiR7bG9naWNhbH1gO1xuICAgIGNvbnN0IHBpbiA9IHZhbHVlcy5waW5zPy5ba2V5XTtcbiAgICBjb25zdCBrZWVwR2VuZXJhdGVkID0gZ2VuZXJhdGVkLmluY2x1ZGVzKGtleSk7XG4gICAgaWYgKHBpbiAhPT0gdW5kZWZpbmVkICYmIGtlZXBHZW5lcmF0ZWQpIGZhaWwoXCJhIHJlc291cmNlIGhhcyBib3RoIGEgcGluIGFuZCBhIGdlbmVyYXRlZCBlbnRyeVwiKTtcbiAgICBpZiAocGluICE9PSB1bmRlZmluZWQpIHJldHVybiB7IG5hbWU6IHBpbiwgcGlubmVkOiB0cnVlIH07XG4gICAgaWYgKGtlZXBHZW5lcmF0ZWQpIHJldHVybiB7IGdlbmVyYXRlZDogdHJ1ZSB9O1xuICAgIGlmIChsZWdhY3kpIHtcbiAgICAgIGZhaWwoYGxlZ2FjeSBuYW1pbmcgcHJvZmlsZSByZXF1aXJlcyBhIHBpbiBvciBhIGdlbmVyYXRlZCBlbnRyeSBmb3IgJHtrZXl9YCk7XG4gICAgfVxuXG4gICAgbGV0IG91dDogQXBwVGhlb3J5UGh5c2ljYWxOYW1lO1xuICAgIGlmIChydWxlLmtpbmQgPT09IFwiczNhclwiKSB7XG4gICAgICBjb25zdCBzdWZmaXggPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zM0FjY291bnRSZWdpb25hbFN1ZmZpeCh2YWx1ZXMpO1xuICAgICAgY29uc3QgYnVkZ2V0ID0gcnVsZS5tYXggLSBzdWZmaXgubGVuZ3RoO1xuICAgICAgY29uc3QgcHJlZml4ID0gc2hvcnRlbihgJHt2YWx1ZXMuYXBwfS0ke3ZhbHVlcy5zdGFnZX0tJHtsb2dpY2FsLnJlcGxhY2UoL1xcLy9nLCBcIi1cIil9YCwgYnVkZ2V0KTtcbiAgICAgIG91dCA9IHsgbmFtZTogcHJlZml4ICsgc3VmZml4LCBidWNrZXROYW1lUHJlZml4OiBwcmVmaXgsIGJ1Y2tldE5hbWVzcGFjZTogXCJhY2NvdW50LXJlZ2lvbmFsXCIgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJkYXNoXCIpIHtcbiAgICAgIG91dCA9IHsgbmFtZTogc2hvcnRlbihgJHt2YWx1ZXMuYXBwfS0ke3ZhbHVlcy5zdGFnZX0tJHtsb2dpY2FsLnJlcGxhY2UoL1xcLy9nLCBcIi1cIil9YCwgcnVsZS5tYXgpIH07XG4gICAgfSBlbHNlIGlmIChydWxlLmtpbmQgPT09IFwicGF0aFwiKSB7XG4gICAgICBjb25zdCBmdWxsID0gYCR7cnVsZS5sZWFkID8/IFwiXCJ9JHt2YWx1ZXMuYXBwfS8ke3ZhbHVlcy5zdGFnZX0vJHtsb2dpY2FsfWA7XG4gICAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcInNlY3JldFwiICYmIFNFQ1JFVF9UQUlMX1JFLnRlc3QoZnVsbCkpIHtcbiAgICAgICAgZmFpbChcInNlY3JldCBuYW1lIG11c3Qgbm90IGVuZCB3aXRoIGEgaHlwaGVuIGFuZCBzaXggY2hhcmFjdGVyc1wiKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwic3NtX3BhcmFtZXRlclwiICYmIChmdWxsLm1hdGNoKC9cXC8vZyk/Lmxlbmd0aCA/PyAwKSA+IDE1KSB7XG4gICAgICAgIGZhaWwoXCJzc20gaGllcmFyY2h5IGRlZXBlciB0aGFuIDE1XCIpO1xuICAgICAgfVxuICAgICAgaWYgKGZ1bGwubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJwYXRoIG5hbWUgb3ZlciBsaW1pdFwiKTtcbiAgICAgIG91dCA9IHsgbmFtZTogZnVsbCB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcImxvZ1wiKSB7XG4gICAgICBjb25zdCBuYW1lID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nR3JvdXBOYW1lKHZhbHVlcywgbG9naWNhbCk7XG4gICAgICBpZiAobmFtZS5sZW5ndGggPiBydWxlLm1heCkgZmFpbChcImxvZyBncm91cCBvdmVyIGxpbWl0XCIpO1xuICAgICAgb3V0ID0geyBuYW1lIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZhaWwoYHVuc3VwcG9ydGVkIGtpbmQgJHtTdHJpbmcocnVsZS5raW5kKX1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBuYW1lID0gb3V0Lm5hbWUgYXMgc3RyaW5nO1xuICAgIGlmICghbmV3IFJlZ0V4cChgXig/OiR7cnVsZS5jaGFyc2V0fSkrJGApLnRlc3QobmFtZSkpIGZhaWwoXCJjaGFyc2V0XCIpO1xuICAgIGlmIChuYW1lLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwibGVuZ3RoXCIpO1xuICAgIGlmIChbXCJzM19idWNrZXRcIiwgXCJzM192ZWN0b3JfYnVja2V0XCIsIFwiczNfdmVjdG9yX2luZGV4XCJdLmluY2x1ZGVzKHJlc291cmNlVHlwZSkgJiYgIVMzX0VER0VTX1JFLnRlc3QobmFtZSkpIHtcbiAgICAgIGZhaWwoXCJzMyBzdGFydC9lbmRcIik7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICAvKipcbiAgICogVmFsaWRhdGUgb25lIHNlbGVjdG9yLiBUaHJvd3Mgb24gYSBzZWxlY3RvciBvdXRzaWRlIHRoZSBncmFtbWFyLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZVNlbGVjdG9yKHNlbGVjdG9yOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBiYXNlID0gc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSA/IHNlbGVjdG9yLnNsaWNlKDAsIC0yKSA6IHNlbGVjdG9yO1xuICAgIGlmICghTE9HSUNBTF9SRS50ZXN0KGJhc2UpIHx8IGJhc2Uuc3BsaXQoXCIvXCIpWzBdICE9PSBcImxvZ3NcIiB8fCAoYmFzZSA9PT0gXCJsb2dzXCIgJiYgIXNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpKSB7XG4gICAgICBmYWlsKGBzZWxlY3RvciAke3NlbGVjdG9yfWApO1xuICAgIH1cbiAgICBpZiAoYmFzZS5pbmNsdWRlcyhcIipcIikpIGZhaWwoXCJ3aWxkY2FyZCBvbmx5IGFzIHRyYWlsaW5nIC8qXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgYSBzZWxlY3RvciBtYXRjaGVzIGEgbG9naWNhbCBzb3VyY2UuIEEgdHJhaWxpbmcgYC8qYCBtYXRjaGVzXG4gICAqIGRlc2NlbmRhbnRzIG9ubHkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHNlbGVjdG9yTWF0Y2hlcyhzZWxlY3Rvcjogc3RyaW5nLCBsb2dpY2FsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBpZiAoc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSkgcmV0dXJuIGxvZ2ljYWwuc3RhcnRzV2l0aChzZWxlY3Rvci5zbGljZSgwLCAtMSkpO1xuICAgIHJldHVybiBsb2dpY2FsID09PSBzZWxlY3RvcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGEgc291cmNlIGlzIHZpc2libGU6IGFuIGluY2x1ZGUgbWF0Y2hlcyBhbmQgbm8gZXhjbHVkZSBkb2VzLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzb3VyY2VWaXNpYmxlKHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsIGxvZ2ljYWw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGluY2x1ZGVkID0gKHJ1bGVzLmluY2x1ZGUgPz8gW10pLnNvbWUoKHNlbGVjdG9yKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3IsIGxvZ2ljYWwpKTtcbiAgICBpZiAoIWluY2x1ZGVkKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuICEocnVsZXMuZXhjbHVkZSA/PyBbXSkuc29tZSgoc2VsZWN0b3IpID0+IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNlbGVjdG9yTWF0Y2hlcyhzZWxlY3RvciwgbG9naWNhbCkpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBmaXJzdCAxMiBoZXggY2hhcmFjdGVycyBvZiBTSEEtMjU2IG92ZXIgdGhlIGNhbm9uaWNhbCBydWxlcy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcnVsZVZlcnNpb24ocnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyk6IHN0cmluZyB7XG4gICAgY29uc3QgY2Fub25pY2FsID0gYHtcImV4Y2x1ZGVcIjoke0pTT04uc3RyaW5naWZ5KHNvcnRlZENvcHkocnVsZXMuZXhjbHVkZSkpfSxcImluY2x1ZGVcIjoke0pTT04uc3RyaW5naWZ5KHNvcnRlZENvcHkocnVsZXMuaW5jbHVkZSkpfX1gO1xuICAgIHJldHVybiBzaGEyNTZIZXgoY2Fub25pY2FsKS5zbGljZSgwLCAxMik7XG4gIH1cblxuICAvKipcbiAgICogQ29tcGlsZSB0aGUgcnVsZXMgaW50byB0aGUgcmVhZGVyLXJvbGUgaW5saW5lIHBvbGljeSBkb2N1bWVudC4gVGhlIHJldHVyblxuICAgKiB2YWx1ZSBpcyB0aGUgY29udHJhY3QgSlNPTiwgc28gYSBjb25zdW1lciBjYW4gY29tcGFyZSBpdCBieXRlIGZvciBieXRlLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBjb21waWxlVmlzaWJpbGl0eVBvbGljeUpzb24oXG4gICAgdmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICk6IHN0cmluZyB7XG4gICAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBbLi4uKHJ1bGVzLmluY2x1ZGUgPz8gW10pLCAuLi4ocnVsZXMuZXhjbHVkZSA/PyBbXSldKSB7XG4gICAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgICB9XG4gICAgY29uc3QgYmFzZSA9IGBhcm46YXdzOmxvZ3M6JHt2YWx1ZXMucmVnaW9ufToke3ZhbHVlcy5hY2NvdW50fTpsb2ctZ3JvdXA6YDtcbiAgICBjb25zdCBhcm5zRm9yID0gKHNlbGVjdG9yOiBzdHJpbmcpOiBzdHJpbmdbXSA9PiB7XG4gICAgICBpZiAoc2VsZWN0b3IuZW5kc1dpdGgoXCIvKlwiKSkge1xuICAgICAgICByZXR1cm4gW2Jhc2UgKyBsb2dQcmVmaXgodmFsdWVzKSArIHNlbGVjdG9yLnNsaWNlKDAsIC0xKS5yZXBsYWNlKC9cXC8vZywgXCJfXCIpICsgXCIqXCJdO1xuICAgICAgfVxuICAgICAgY29uc3QgbmFtZSA9IGxvZ1ByZWZpeCh2YWx1ZXMpICsgc2VsZWN0b3IucmVwbGFjZSgvXFwvL2csIFwiX1wiKTtcbiAgICAgIHJldHVybiBbYmFzZSArIG5hbWUsIGJhc2UgKyBuYW1lICsgXCI6KlwiXTtcbiAgICB9O1xuICAgIGNvbnN0IGFjdGlvbnMgPSBbLi4uS0VFUEVSX0FDVElPTlNfR1JPVVAsIC4uLktFRVBFUl9BQ1RJT05TX1NUUkVBTV07XG4gICAgY29uc3Qgc3RhdGVtZW50czogeyBTaWQ6IHN0cmluZzsgRWZmZWN0OiBzdHJpbmc7IEFjdGlvbjogc3RyaW5nW107IFJlc291cmNlOiBzdHJpbmdbXSB9W10gPSBbXG4gICAgICB7XG4gICAgICAgIFNpZDogXCJSZWFkTWFuaWZlc3RcIixcbiAgICAgICAgRWZmZWN0OiBcIkFsbG93XCIsXG4gICAgICAgIEFjdGlvbjogW1wic3NtOkdldFBhcmFtZXRlclwiXSxcbiAgICAgICAgUmVzb3VyY2U6IFtcbiAgICAgICAgICBgYXJuOmF3czpzc206JHt2YWx1ZXMucmVnaW9ufToke3ZhbHVlcy5hY2NvdW50fTpwYXJhbWV0ZXIvJHtMT0dfUFJFRklYfS92aXNpYmlsaXR5LyR7dmFsdWVzLmFwcH0vJHt2YWx1ZXMuc3RhZ2V9L21hbmlmZXN0YCxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBjb25zdCBpbmNsdWRlZCA9IHNvcnRlZENvcHkocnVsZXMuaW5jbHVkZSkuZmxhdE1hcChhcm5zRm9yKTtcbiAgICBjb25zdCBleGNsdWRlZCA9IHNvcnRlZENvcHkocnVsZXMuZXhjbHVkZSkuZmxhdE1hcChhcm5zRm9yKTtcbiAgICBpZiAoaW5jbHVkZWQubGVuZ3RoID4gMCkgc3RhdGVtZW50cy5wdXNoKHsgU2lkOiBcIlJlYWRJbmNsdWRlZFwiLCBFZmZlY3Q6IFwiQWxsb3dcIiwgQWN0aW9uOiBhY3Rpb25zLCBSZXNvdXJjZTogaW5jbHVkZWQgfSk7XG4gICAgaWYgKGV4Y2x1ZGVkLmxlbmd0aCA+IDApIHN0YXRlbWVudHMucHVzaCh7IFNpZDogXCJEZW55RXhjbHVkZWRcIiwgRWZmZWN0OiBcIkRlbnlcIiwgQWN0aW9uOiBhY3Rpb25zLCBSZXNvdXJjZTogZXhjbHVkZWQgfSk7XG4gICAgY29uc3QgZG9jdW1lbnQgPSBKU09OLnN0cmluZ2lmeSh7IFZlcnNpb246IFwiMjAxMi0xMC0xN1wiLCBTdGF0ZW1lbnQ6IHN0YXRlbWVudHMgfSk7XG4gICAgaWYgKGRvY3VtZW50Lmxlbmd0aCA+IFJPTEVfUE9MSUNZX01BWCkgZmFpbChcImNvbXBpbGVkIHBvbGljeSBvdmVyIHJvbGUgcG9saWN5IHNpemVcIik7XG4gICAgcmV0dXJuIGRvY3VtZW50O1xuICB9XG5cbiAgLyoqXG4gICAqIEFzc2VtYmxlIHRoZSBzeW50aC10aW1lIHZpc2liaWxpdHkgcHJldmlldy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmlzaWJpbGl0eVByZXZpZXcoXG4gICAgdmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICAgIHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG4gICAgc291cmNlczogc3RyaW5nW10sXG4gICk6IEFwcFRoZW9yeVZpc2liaWxpdHlQcmV2aWV3IHtcbiAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZUNvbnRleHQodmFsdWVzKTtcbiAgICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIFsuLi4ocnVsZXMuaW5jbHVkZSA/PyBbXSksIC4uLihydWxlcy5leGNsdWRlID8/IFtdKV0pIHtcbiAgICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgcnVsZVZlcnNpb246IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnJ1bGVWZXJzaW9uKHJ1bGVzKSxcbiAgICAgIG1hdGNoZWROb3c6IHNvdXJjZXMuZmlsdGVyKChzb3VyY2UpID0+IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIHNvdXJjZSkpLnNvcnQoKSxcbiAgICAgIG5vdE1hdGNoZWROb3c6IHNvdXJjZXMuZmlsdGVyKChzb3VyY2UpID0+ICFBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBzb3VyY2UpKS5zb3J0KCksXG4gICAgICBmdXR1cmU6IHsgaW5jbHVkZTogc29ydGVkQ29weShydWxlcy5pbmNsdWRlKSwgZXhjbHVkZTogc29ydGVkQ29weShydWxlcy5leGNsdWRlKSB9LFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogQXNzZW1ibGUgdGhlIHB1Ymxpc2hlZCBtYW5pZmVzdCAodGhlIHByZXZpZXcgbWludXMgYG5vdE1hdGNoZWROb3dgKS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmlzaWJpbGl0eU1hbmlmZXN0KFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIHNvdXJjZXM6IHN0cmluZ1tdLFxuICApOiBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3Qge1xuICAgIGNvbnN0IHByZXZpZXcgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52aXNpYmlsaXR5UHJldmlldyh2YWx1ZXMsIHJ1bGVzLCBzb3VyY2VzKTtcbiAgICByZXR1cm4geyBydWxlVmVyc2lvbjogcHJldmlldy5ydWxlVmVyc2lvbiwgbWF0Y2hlZE5vdzogcHJldmlldy5tYXRjaGVkTm93LCBmdXR1cmU6IHByZXZpZXcuZnV0dXJlIH07XG4gIH1cblxuICAvKipcbiAgICogU2VyaWFsaXplIGEgbWFuaWZlc3QgdG8gdGhlIGNvbnRyYWN0IEpTT04gc2hhcGUgd3JpdHRlbiB0byBTU00uXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIG1hbmlmZXN0SnNvbihtYW5pZmVzdDogQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0KTogc3RyaW5nIHtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcnVsZV92ZXJzaW9uOiBtYW5pZmVzdC5ydWxlVmVyc2lvbixcbiAgICAgIG1hdGNoZWRfbm93OiBtYW5pZmVzdC5tYXRjaGVkTm93LFxuICAgICAgZnV0dXJlOiB7IGluY2x1ZGU6IG1hbmlmZXN0LmZ1dHVyZS5pbmNsdWRlID8/IFtdLCBleGNsdWRlOiBtYW5pZmVzdC5mdXR1cmUuZXhjbHVkZSA/PyBbXSB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIEtlZXBlcidzIHJlYWQgZGVjaXNpb24sIGluIHRoZSBydW50aW1lcycgcGFyYW1ldGVyIG9yZGVyLiBGYWlscyBjbG9zZWQgb24gYVxuICAgKiBkZW5pYWwgb3IgYW4gdW5yZWFjaGFibGUgYWNjb3VudC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMga2VlcGVyRGVjaXNpb24oXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBsb2dpY2FsOiBzdHJpbmcsXG4gICAgYXdzUmVzdWx0OiBzdHJpbmcsXG4gICk6IEFwcFRoZW9yeUtlZXBlckFuc3dlciB7XG4gICAgaWYgKCFydWxlcyB8fCAhQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgbG9naWNhbCkpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuTk9UX1NIQVJFRDtcbiAgICB9XG4gICAgaWYgKGF3c1Jlc3VsdCA9PT0gXCJldmVudHNcIikgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5FVkVOVFM7XG4gICAgaWYgKGF3c1Jlc3VsdCA9PT0gXCJlbXB0eVwiIHx8IGF3c1Jlc3VsdCA9PT0gXCJub3RfZm91bmRcIikgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5BTExPV0VEX05PX0VWRU5UUztcbiAgICByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLk5PVF9TSEFSRUQ7XG4gIH1cbn1cbiJdfQ==