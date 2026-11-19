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
    return [...(values ?? [])].sort();
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
     * Compose the physical name of one resource. A pin always wins; a legacy
     * profile without a pin fails synthesis.
     */
    static physicalName(values, resourceType, logical) {
        AppTheoryResourceNaming.validateContext(values);
        if (!LOGICAL_RE.test(logical))
            fail("logical");
        const rule = RULES[resourceType];
        if (!rule)
            fail(`resource type ${resourceType}`);
        const pin = values.pins?.[`${resourceType}:${logical}`];
        if (pin !== undefined)
            return { name: pin, pinned: true };
        if ((values.namingProfile ?? AppTheoryNamingProfile.DERIVED) === AppTheoryNamingProfile.LEGACY) {
            fail(`legacy naming profile requires a pin for ${resourceType}:${logical}`);
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
        if (!new RegExp(`^${rule.charset}+$`).test(out.name))
            fail("charset");
        if (out.name.length > rule.max)
            fail("length");
        if (["s3_bucket", "s3_vector_bucket", "s3_vector_index"].includes(resourceType) && !S3_EDGES_RE.test(out.name)) {
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
     * Keeper's read decision. Fails closed on a denial or an unreachable account.
     */
    static keeperDecision(logical, awsResult, rules) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibmFtaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSw2Q0FBeUM7QUFFekM7O0dBRUc7QUFDVSxRQUFBLHdCQUF3QixHQUFHLGtDQUFrQyxDQUFDO0FBRTNFOztHQUVHO0FBQ0gsSUFBWSxzQkFTWDtBQVRELFdBQVksc0JBQXNCO0lBQ2hDOztPQUVHO0lBQ0gsNkNBQW1CLENBQUE7SUFDbkI7O09BRUc7SUFDSCwyQ0FBaUIsQ0FBQTtBQUNuQixDQUFDLEVBVFcsc0JBQXNCLHNDQUF0QixzQkFBc0IsUUFTakM7QUFFRDs7R0FFRztBQUNILElBQVksdUJBU1g7QUFURCxXQUFZLHVCQUF1QjtJQUNqQzs7T0FFRztJQUNILGdEQUFxQixDQUFBO0lBQ3JCOztPQUVHO0lBQ0gsNENBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQVRXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBU2xDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHFCQWFYO0FBYkQsV0FBWSxxQkFBcUI7SUFDL0I7O09BRUc7SUFDSCwwQ0FBaUIsQ0FBQTtJQUNqQjs7T0FFRztJQUNILGdFQUF1QyxDQUFBO0lBQ3ZDOztPQUVHO0lBQ0gsa0RBQXlCLENBQUE7QUFDM0IsQ0FBQyxFQWJXLHFCQUFxQixxQ0FBckIscUJBQXFCLFFBYWhDO0FBbUpELE1BQU0sZUFBZSxHQUFHLDBCQUEwQixDQUFDO0FBQ25ELE1BQU0sVUFBVSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksZUFBZSxPQUFPLGVBQWUsS0FBSyxDQUFDLENBQUM7QUFDOUUsTUFBTSxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxlQUFlLEdBQUcsQ0FBQyxDQUFDO0FBQ2xELE1BQU0sUUFBUSxHQUFHLHNCQUFzQixDQUFDO0FBQ3hDLE1BQU0sWUFBWSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksZUFBZSxHQUFHLENBQUMsQ0FBQztBQUN4RCxNQUFNLFVBQVUsR0FB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Q2hDLE1BQU0sRUFBRSxFQUFFLE9BQU8sRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLE9BQU8sSUFBSSxFQUFFLEVBQUUsT0FBTyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsT0FBTyxJQUFJLEVBQUUsRUFBRTtTQUMzRixDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQ7O09BRUc7SUFDSSxNQUFNLENBQUMsY0FBYyxDQUMxQixPQUFlLEVBQ2YsU0FBaUIsRUFDakIsS0FBZ0M7UUFFaEMsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLHVCQUF1QixDQUFDLGFBQWEsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNyRSxPQUFPLHFCQUFxQixDQUFDLFVBQVUsQ0FBQztRQUMxQyxDQUFDO1FBQ0QsSUFBSSxTQUFTLEtBQUssUUFBUTtZQUFFLE9BQU8scUJBQXFCLENBQUMsTUFBTSxDQUFDO1FBQ2hFLElBQUksU0FBUyxLQUFLLE9BQU8sSUFBSSxTQUFTLEtBQUssV0FBVztZQUFFLE9BQU8scUJBQXFCLENBQUMsaUJBQWlCLENBQUM7UUFDdkcsT0FBTyxxQkFBcUIsQ0FBQyxVQUFVLENBQUM7SUFDMUMsQ0FBQzs7QUE5TkgsMERBK05DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuXG4vKipcbiAqIFRoZSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3QgdGhpcyBtb2R1bGUgaW1wbGVtZW50cy5cbiAqL1xuZXhwb3J0IGNvbnN0IFJFU09VUkNFX05BTUlOR19DT05UUkFDVCA9IFwidGhlb3J5Y2xvdWRfcmVzb3VyY2VfbmFtaW5nLnYwLjFcIjtcblxuLyoqXG4gKiBOYW1pbmcgcHJvZmlsZXMgYWNjZXB0ZWQgYnkgYSBuYW1pbmcgY29udGV4dC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZSB7XG4gIC8qKlxuICAgKiBOYW1lcyBkZXJpdmUgZnJvbSB0aGUgbmFtaW5nIGNvbnRleHQuXG4gICAqL1xuICBERVJJVkVEID0gXCJkZXJpdmVkXCIsXG4gIC8qKlxuICAgKiBFdmVyeSBuYW1lIGNvbWVzIGZyb20gYSBwaW4uXG4gICAqL1xuICBMRUdBQ1kgPSBcImxlZ2FjeVwiLFxufVxuXG4vKipcbiAqIExvZ2dpbmcgcHJvZmlsZXMgYWNjZXB0ZWQgYnkgYSBuYW1pbmcgY29udGV4dC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUge1xuICAvKipcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgc3RhbmRhcmQgbG9nIGdyb3VwcyBhbmQgYWNjZXNzIGxvZ2dpbmcuXG4gICAqL1xuICBTVEFOREFSRCA9IFwic3RhbmRhcmRcIixcbiAgLyoqXG4gICAqIEVhY2ggY29uc3RydWN0IGtlZXBzIGl0cyBwcmUtY29udHJhY3QgbG9nZ2luZyBiZWhhdmlvdXIuXG4gICAqL1xuICBMRUdBQ1kgPSBcImxlZ2FjeVwiLFxufVxuXG4vKipcbiAqIEtlZXBlcidzIGFuc3dlciB0byBhIHJlYWRlciByZXF1ZXN0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIge1xuICAvKipcbiAgICogVGhlIHNvdXJjZSBpcyBzaGFyZWQgYW5kIHRoZSByZWFkIHJldHVybmVkIGV2ZW50cy5cbiAgICovXG4gIEVWRU5UUyA9IFwiZXZlbnRzXCIsXG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIHNoYXJlZCBhbmQgdGhlIHJlYWQgcmV0dXJuZWQgbm8gZXZlbnRzLlxuICAgKi9cbiAgQUxMT1dFRF9OT19FVkVOVFMgPSBcImFsbG93ZWRfbm9fZXZlbnRzXCIsXG4gIC8qKlxuICAgKiBUaGUgc291cmNlIGlzIG5vdCBzaGFyZWQsIG9yIHRoZSByZWFkIGZhaWxlZCBjbG9zZWQuXG4gICAqL1xuICBOT1RfU0hBUkVEID0gXCJub3Rfc2hhcmVkXCIsXG59XG5cbi8qKlxuICogQm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQgdmFsdWVzIGZyb20gc3RhZ2UgY29uZmlnLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMge1xuICAvKipcbiAgICogTmFtZXNwYWNlIHNlZ21lbnQuXG4gICAqIEBkZWZhdWx0IFwidGhlb3J5Y2xvdWRcIlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZXNwYWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBcHAgaW5zdGFuY2UgaWQuXG4gICAqL1xuICByZWFkb25seSBhcHA6IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgaWQuXG4gICAqL1xuICByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZC4gQW4gdW5yZXNvbHZlZCB0b2tlbiBmYWlscyBzeW50aGVzaXMuXG4gICAqL1xuICByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUsIGZvciBleGFtcGxlIGB1cy1lYXN0LTFgLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKiBAZGVmYXVsdCB7fVxuICAgKi9cbiAgcmVhZG9ubHkgcGlucz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRURcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU/OiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU/OiBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nIHJldGVudGlvbiBpbiBkYXlzIGZvciBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cHMuXG4gICAqIEBkZWZhdWx0IDMwXG4gICAqL1xuICByZWFkb25seSByZXRlbnRpb25EYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRoZSBjb21wb3NlZCBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAvKipcbiAgICogVGhlIGZ1bGwgcGh5c2ljYWwgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFjY291bnQtcmVnaW9uYWwgYnVja2V0LW5hbWUgcHJlZml4LCB3aGVuIHRoZSB0eXBlIHVzZXMgb25lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGJ1Y2tldE5hbWVQcmVmaXg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBidWNrZXQgbmFtZXNwYWNlLCB3aGVuIHRoZSB0eXBlIHVzZXMgb25lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGJ1Y2tldE5hbWVzcGFjZT86IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgbmFtZSBjYW1lIGZyb20gYSBwaW4uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBwaW5uZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEluY2x1ZGUgYW5kIGV4Y2x1ZGUgdmlzaWJpbGl0eSBzZWxlY3RvcnMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzIHtcbiAgLyoqXG4gICAqIFNlbGVjdG9ycyB3aG9zZSBzb3VyY2VzIGFyZSBzaGFyZWQuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBpbmNsdWRlPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFNlbGVjdG9ycyB3aG9zZSBzb3VyY2VzIGFyZSBuZXZlciBzaGFyZWQuIEV4Y2x1c2lvbnMgd2luLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZXhjbHVkZT86IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIFRoZSBzeW50aC10aW1lIHZpc2liaWxpdHkgcHJldmlldy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gIC8qKlxuICAgKiBGaXJzdCAxMiBoZXggY2hhcmFjdGVycyBvZiB0aGUgY2Fub25pY2FsIHJ1bGVzIGhhc2guXG4gICAqL1xuICByZWFkb25seSBydWxlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDdXJyZW50IHN5bnRoZXNpemVkIHNvdXJjZXMgdGhlIHJ1bGVzIHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEN1cnJlbnQgc3ludGhlc2l6ZWQgc291cmNlcyB0aGUgcnVsZXMgZG8gbm90IHNoYXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgbm90TWF0Y2hlZE5vdzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBzZWxlY3RvcnMsIGFzIHRoZSBzdGF0ZW1lbnQgb2Ygd2hhdCBmdXR1cmUgc291cmNlcyB3aWxsIG1hdGNoLlxuICAgKi9cbiAgcmVhZG9ubHkgZnV0dXJlOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXM7XG59XG5cbi8qKlxuICogVGhlIHB1Ymxpc2hlZCBTU00gbWFuaWZlc3Q6IHRoZSBwcmV2aWV3IG1pbnVzIGBub3RNYXRjaGVkTm93YC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3Qge1xuICAvKipcbiAgICogRmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgdGhlIGNhbm9uaWNhbCBydWxlcyBoYXNoLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogQ3VycmVudCBzeW50aGVzaXplZCBzb3VyY2VzIHRoZSBydWxlcyBzaGFyZS5cbiAgICovXG4gIHJlYWRvbmx5IG1hdGNoZWROb3c6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgc2VsZWN0b3JzLCBhcyB0aGUgc3RhdGVtZW50IG9mIHdoYXQgZnV0dXJlIHNvdXJjZXMgd2lsbCBtYXRjaC5cbiAgICovXG4gIHJlYWRvbmx5IGZ1dHVyZTogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xufVxuXG5jb25zdCBTRUdNRU5UX1BBVFRFUk4gPSBcIlthLXowLTldKyg/Oi1bYS16MC05XSspKlwiO1xuY29uc3QgTE9HSUNBTF9SRSA9IG5ldyBSZWdFeHAoYF4ke1NFR01FTlRfUEFUVEVSTn0oPzovJHtTRUdNRU5UX1BBVFRFUk59KSokYCk7XG5jb25zdCBBUFBfUkUgPSBuZXcgUmVnRXhwKGBeJHtTRUdNRU5UX1BBVFRFUk59JGApO1xuY29uc3QgU1RBR0VfUkUgPSAvXlthLXpdW2EtejAtOV17MCw3fSQvO1xuY29uc3QgTkFNRVNQQUNFX1JFID0gbmV3IFJlZ0V4cChgXiR7U0VHTUVOVF9QQVRURVJOfSRgKTtcbmNvbnN0IEFDQ09VTlRfUkUgPSAvXlswLTldezEyfSQvO1xuY29uc3QgUkVHSU9OX1JFID0gL15bYS16XXsyfSg/Oi1bYS16XSspKy1bMC05XSQvO1xuY29uc3QgU0VDUkVUX1RBSUxfUkUgPSAvLVtBLVphLXowLTldezZ9JC87XG5jb25zdCBTM19FREdFU19SRSA9IC9eW2EtejAtOV0uKlthLXowLTldJC87XG5jb25zdCBMT0dfUFJFRklYID0gXCJ0aGVvcnljbG91ZFwiO1xuY29uc3QgUk9MRV9QT0xJQ1lfTUFYID0gMTAyNDA7XG5jb25zdCBCQVNFMzIgPSBcImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MjM0NTY3XCI7XG5cbmludGVyZmFjZSBSdWxlIHtcbiAgcmVhZG9ubHkga2luZDogXCJkYXNoXCIgfCBcInBhdGhcIiB8IFwiczNhclwiIHwgXCJsb2dcIjtcbiAgcmVhZG9ubHkgbWF4OiBudW1iZXI7XG4gIHJlYWRvbmx5IGNoYXJzZXQ6IHN0cmluZztcbiAgcmVhZG9ubHkgbGVhZD86IHN0cmluZztcbn1cblxuY29uc3QgUlVMRVM6IHsgW3R5cGU6IHN0cmluZ106IFJ1bGUgfSA9IHtcbiAgczNfYnVja2V0OiB7IGtpbmQ6IFwiczNhclwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIHMzX3ZlY3Rvcl9idWNrZXQ6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjMsIGNoYXJzZXQ6IFwiW2EtejAtOS1dXCIgfSxcbiAgczNfdmVjdG9yX2luZGV4OiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYzLCBjaGFyc2V0OiBcIlthLXowLTktXVwiIH0sXG4gIGR5bmFtb2RiX3RhYmxlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGxhbWJkYV9mdW5jdGlvbjogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgc3FzX3F1ZXVlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDgwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzbnNfdG9waWM6IHsga2luZDogXCJkYXNoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBzZWNyZXQ6IHsga2luZDogXCJwYXRoXCIsIG1heDogNTEyLCBjaGFyc2V0OiBcIltBLVphLXowLTkvXys9LkAtXVwiIH0sXG4gIHNzbV9wYXJhbWV0ZXI6IHsga2luZDogXCJwYXRoXCIsIG1heDogOTAwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLi8tXVwiLCBsZWFkOiBcIi9cIiB9LFxuICBrbXNfYWxpYXM6IHsga2luZDogXCJwYXRoXCIsIG1heDogMjU2LCBjaGFyc2V0OiBcIltBLVphLXowLTkvXy1dXCIsIGxlYWQ6IFwiYWxpYXMvXCIgfSxcbiAgZXZlbnRfYnVzOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NiwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGV2ZW50X3J1bGU6IHsga2luZDogXCJkYXNoXCIsIG1heDogNjQsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOS5fLV1cIiB9LFxuICBzY2hlZHVsZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2NCwgY2hhcnNldDogXCJbQS1aYS16MC05Ll8tXVwiIH0sXG4gIGFsYXJtOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDI1NSwgY2hhcnNldDogXCJbQS1aYS16MC05Xy4tXVwiIH0sXG4gIGRhc2hib2FyZDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAyNTUsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGlhbV9yb2xlOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDY0LCBjaGFyc2V0OiBcIltBLVphLXowLTkrPSwuQF8tXVwiIH0sXG4gIGlhbV9tYW5hZ2VkX3BvbGljeTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOSs9LC5AXy1dXCIgfSxcbiAgc3RhdGVfbWFjaGluZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA4MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgY29kZWJ1aWxkX3Byb2plY3Q6IHsga2luZDogXCJkYXNoXCIsIG1heDogMTUwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBhcGlfcmVzdDogeyBraW5kOiBcImRhc2hcIiwgbWF4OiAxMjgsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG4gIGFwaV9odHRwOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDEyOCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2RlbGl2ZXJ5X3NvdXJjZTogeyBraW5kOiBcImRhc2hcIiwgbWF4OiA2MCwgY2hhcnNldDogXCJbQS1aYS16MC05Xy1dXCIgfSxcbiAgbG9nX2RlbGl2ZXJ5X2Rlc3RpbmF0aW9uOiB7IGtpbmQ6IFwiZGFzaFwiLCBtYXg6IDYwLCBjaGFyc2V0OiBcIltBLVphLXowLTlfLV1cIiB9LFxuICBsb2dfZ3JvdXA6IHsga2luZDogXCJsb2dcIiwgbWF4OiA1MTIsIGNoYXJzZXQ6IFwiW0EtWmEtejAtOV8tXVwiIH0sXG59O1xuXG5jb25zdCBLRUVQRVJfQUNUSU9OU19HUk9VUCA9IFtcImxvZ3M6RmlsdGVyTG9nRXZlbnRzXCIsIFwibG9nczpEZXNjcmliZUxvZ1N0cmVhbXNcIl07XG5jb25zdCBLRUVQRVJfQUNUSU9OU19TVFJFQU0gPSBbXCJsb2dzOkdldExvZ0V2ZW50c1wiXTtcblxuZnVuY3Rpb24gZmFpbChtZXNzYWdlOiBzdHJpbmcpOiBuZXZlciB7XG4gIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gc2hhMjU2SGV4KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZSh0ZXh0LCBcInV0ZjhcIikuZGlnZXN0KFwiaGV4XCIpO1xufVxuXG5mdW5jdGlvbiBiYXNlMzJMb3dlcih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBieXRlcyA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHRleHQsIFwidXRmOFwiKS5kaWdlc3QoKTtcbiAgbGV0IGJpdHMgPSAwO1xuICBsZXQgdmFsdWUgPSAwO1xuICBsZXQgb3V0ID0gXCJcIjtcbiAgZm9yIChjb25zdCBieXRlIG9mIGJ5dGVzKSB7XG4gICAgdmFsdWUgPSAodmFsdWUgPDwgOCkgfCBieXRlO1xuICAgIGJpdHMgKz0gODtcbiAgICB3aGlsZSAoYml0cyA+PSA1KSB7XG4gICAgICBvdXQgKz0gQkFTRTMyWyh2YWx1ZSA+Pj4gKGJpdHMgLSA1KSkgJiAzMV07XG4gICAgICBiaXRzIC09IDU7XG4gICAgfVxuICB9XG4gIGlmIChiaXRzID4gMCkgb3V0ICs9IEJBU0UzMlsodmFsdWUgPDwgKDUgLSBiaXRzKSkgJiAzMV07XG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIHNob3J0ZW4oZnVsbDogc3RyaW5nLCBsaW1pdDogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKGZ1bGwubGVuZ3RoIDw9IGxpbWl0KSByZXR1cm4gZnVsbDtcbiAgY29uc3QgaGVhZCA9IGZ1bGwuc2xpY2UoMCwgbGltaXQgLSA5KS5yZXBsYWNlKC9bLV8uL10rJC8sIFwiXCIpO1xuICByZXR1cm4gYCR7aGVhZH0tJHtiYXNlMzJMb3dlcihmdWxsKS5zbGljZSgwLCA4KX1gO1xufVxuXG5mdW5jdGlvbiBuYW1lc3BhY2VPZih2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWVzLm5hbWVzcGFjZSA/PyBMT0dfUFJFRklYO1xufVxuXG5mdW5jdGlvbiBzb3J0ZWRDb3B5KHZhbHVlczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbLi4uKHZhbHVlcyA/PyBbXSldLnNvcnQoKTtcbn1cblxuZnVuY3Rpb24gbG9nUHJlZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gIHJldHVybiBbTE9HX1BSRUZJWCwgbmFtZXNwYWNlT2YodmFsdWVzKSwgdmFsdWVzLmFwcCwgdmFsdWVzLnN0YWdlXS5qb2luKFwiX1wiKSArIFwiX1wiO1xufVxuXG4vKipcbiAqIFRoZSBgdGhlb3J5Y2xvdWRfcmVzb3VyY2VfbmFtaW5nLnYwLjFgIHByaW1pdGl2ZXMsIGV4cG9zZWQgZm9yIGpzaWkgc28gdGhlIEdvXG4gKiBhbmQgUHl0aG9uIENESyBiaW5kaW5ncyBzaGFyZSBvbmUgaW1wbGVtZW50YXRpb24uXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZyB7XG4gIHByaXZhdGUgY29uc3RydWN0b3IoKSB7fVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSB0aGUgYm91bmQgY29udGV4dCBncmFtbWFyLiBUaHJvd3Mgb24gYW4gaW52YWxpZCBjb250ZXh0LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZUNvbnRleHQodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogdm9pZCB7XG4gICAgaWYgKCFBUFBfUkUudGVzdCh2YWx1ZXMuYXBwKSkgZmFpbChcImFwcFwiKTtcbiAgICBpZiAoIVNUQUdFX1JFLnRlc3QodmFsdWVzLnN0YWdlKSkgZmFpbChcInN0YWdlXCIpO1xuICAgIGlmICghQUNDT1VOVF9SRS50ZXN0KHZhbHVlcy5hY2NvdW50KSkgZmFpbChcImFjY291bnRcIik7XG4gICAgaWYgKCFSRUdJT05fUkUudGVzdCh2YWx1ZXMucmVnaW9uKSkgZmFpbChcInJlZ2lvblwiKTtcbiAgICBpZiAoIU5BTUVTUEFDRV9SRS50ZXN0KG5hbWVzcGFjZU9mKHZhbHVlcykpKSBmYWlsKFwibmFtZXNwYWNlXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbi1hcHBlbmRlZCBhY2NvdW50LXJlZ2lvbmFsIGJ1Y2tldCBzdWZmaXguXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHMzQWNjb3VudFJlZ2lvbmFsU3VmZml4KHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAtJHt2YWx1ZXMuYWNjb3VudH0tJHt2YWx1ZXMucmVnaW9ufS1hbmA7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGJvdW5kIHByZWZpeCBzaGFyZWQgYnkgZXZlcnkgbG9nIHNvdXJjZSBvZiB0aGUgYXBwLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBsb2dTb3VyY2VQcmVmaXgodmFsdWVzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzKTogc3RyaW5nIHtcbiAgICByZXR1cm4gbG9nUHJlZml4KHZhbHVlcyk7XG4gIH1cblxuICAvKipcbiAgICogTWFwIGEgbG9naWNhbCBsb2cgc291cmNlIHRvIGl0cyBwaHlzaWNhbCBsb2ctZ3JvdXAgbmFtZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbG9nR3JvdXBOYW1lKHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcywgbG9naWNhbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAoIWxvZ2ljYWwuc3RhcnRzV2l0aChcImxvZ3MvXCIpKSBmYWlsKFwibG9nIGxvZ2ljYWwgbXVzdCBzdGFydCB3aXRoIGxvZ3MvXCIpO1xuICAgIHJldHVybiBsb2dQcmVmaXgodmFsdWVzKSArIGxvZ2ljYWwucmVwbGFjZSgvXFwvL2csIFwiX1wiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21wb3NlIHRoZSBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZS4gQSBwaW4gYWx3YXlzIHdpbnM7IGEgbGVnYWN5XG4gICAqIHByb2ZpbGUgd2l0aG91dCBhIHBpbiBmYWlscyBzeW50aGVzaXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHBoeXNpY2FsTmFtZShcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcmVzb3VyY2VUeXBlOiBzdHJpbmcsXG4gICAgbG9naWNhbDogc3RyaW5nLFxuICApOiBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh2YWx1ZXMpO1xuICAgIGlmICghTE9HSUNBTF9SRS50ZXN0KGxvZ2ljYWwpKSBmYWlsKFwibG9naWNhbFwiKTtcbiAgICBjb25zdCBydWxlID0gUlVMRVNbcmVzb3VyY2VUeXBlXTtcbiAgICBpZiAoIXJ1bGUpIGZhaWwoYHJlc291cmNlIHR5cGUgJHtyZXNvdXJjZVR5cGV9YCk7XG4gICAgY29uc3QgcGluID0gdmFsdWVzLnBpbnM/LltgJHtyZXNvdXJjZVR5cGV9OiR7bG9naWNhbH1gXTtcbiAgICBpZiAocGluICE9PSB1bmRlZmluZWQpIHJldHVybiB7IG5hbWU6IHBpbiwgcGlubmVkOiB0cnVlIH07XG4gICAgaWYgKCh2YWx1ZXMubmFtaW5nUHJvZmlsZSA/PyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQpID09PSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkxFR0FDWSkge1xuICAgICAgZmFpbChgbGVnYWN5IG5hbWluZyBwcm9maWxlIHJlcXVpcmVzIGEgcGluIGZvciAke3Jlc291cmNlVHlwZX06JHtsb2dpY2FsfWApO1xuICAgIH1cblxuICAgIGxldCBvdXQ6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZTtcbiAgICBpZiAocnVsZS5raW5kID09PSBcInMzYXJcIikge1xuICAgICAgY29uc3Qgc3VmZml4ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuczNBY2NvdW50UmVnaW9uYWxTdWZmaXgodmFsdWVzKTtcbiAgICAgIGNvbnN0IGJ1ZGdldCA9IHJ1bGUubWF4IC0gc3VmZml4Lmxlbmd0aDtcbiAgICAgIGNvbnN0IHByZWZpeCA9IHNob3J0ZW4oYCR7dmFsdWVzLmFwcH0tJHt2YWx1ZXMuc3RhZ2V9LSR7bG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCItXCIpfWAsIGJ1ZGdldCk7XG4gICAgICBvdXQgPSB7IG5hbWU6IHByZWZpeCArIHN1ZmZpeCwgYnVja2V0TmFtZVByZWZpeDogcHJlZml4LCBidWNrZXROYW1lc3BhY2U6IFwiYWNjb3VudC1yZWdpb25hbFwiIH07XG4gICAgfSBlbHNlIGlmIChydWxlLmtpbmQgPT09IFwiZGFzaFwiKSB7XG4gICAgICBvdXQgPSB7IG5hbWU6IHNob3J0ZW4oYCR7dmFsdWVzLmFwcH0tJHt2YWx1ZXMuc3RhZ2V9LSR7bG9naWNhbC5yZXBsYWNlKC9cXC8vZywgXCItXCIpfWAsIHJ1bGUubWF4KSB9O1xuICAgIH0gZWxzZSBpZiAocnVsZS5raW5kID09PSBcInBhdGhcIikge1xuICAgICAgY29uc3QgZnVsbCA9IGAke3J1bGUubGVhZCA/PyBcIlwifSR7dmFsdWVzLmFwcH0vJHt2YWx1ZXMuc3RhZ2V9LyR7bG9naWNhbH1gO1xuICAgICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJzZWNyZXRcIiAmJiBTRUNSRVRfVEFJTF9SRS50ZXN0KGZ1bGwpKSB7XG4gICAgICAgIGZhaWwoXCJzZWNyZXQgbmFtZSBtdXN0IG5vdCBlbmQgd2l0aCBhIGh5cGhlbiBhbmQgc2l4IGNoYXJhY3RlcnNcIik7XG4gICAgICB9XG4gICAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcInNzbV9wYXJhbWV0ZXJcIiAmJiAoZnVsbC5tYXRjaCgvXFwvL2cpPy5sZW5ndGggPz8gMCkgPiAxNSkge1xuICAgICAgICBmYWlsKFwic3NtIGhpZXJhcmNoeSBkZWVwZXIgdGhhbiAxNVwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChmdWxsLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwicGF0aCBuYW1lIG92ZXIgbGltaXRcIik7XG4gICAgICBvdXQgPSB7IG5hbWU6IGZ1bGwgfTtcbiAgICB9IGVsc2UgaWYgKHJ1bGUua2luZCA9PT0gXCJsb2dcIikge1xuICAgICAgY29uc3QgbmFtZSA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ0dyb3VwTmFtZSh2YWx1ZXMsIGxvZ2ljYWwpO1xuICAgICAgaWYgKG5hbWUubGVuZ3RoID4gcnVsZS5tYXgpIGZhaWwoXCJsb2cgZ3JvdXAgb3ZlciBsaW1pdFwiKTtcbiAgICAgIG91dCA9IHsgbmFtZSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBmYWlsKGB1bnN1cHBvcnRlZCBraW5kICR7U3RyaW5nKHJ1bGUua2luZCl9YCk7XG4gICAgfVxuXG4gICAgaWYgKCFuZXcgUmVnRXhwKGBeJHtydWxlLmNoYXJzZXR9KyRgKS50ZXN0KG91dC5uYW1lKSkgZmFpbChcImNoYXJzZXRcIik7XG4gICAgaWYgKG91dC5uYW1lLmxlbmd0aCA+IHJ1bGUubWF4KSBmYWlsKFwibGVuZ3RoXCIpO1xuICAgIGlmIChbXCJzM19idWNrZXRcIiwgXCJzM192ZWN0b3JfYnVja2V0XCIsIFwiczNfdmVjdG9yX2luZGV4XCJdLmluY2x1ZGVzKHJlc291cmNlVHlwZSkgJiYgIVMzX0VER0VTX1JFLnRlc3Qob3V0Lm5hbWUpKSB7XG4gICAgICBmYWlsKFwiczMgc3RhcnQvZW5kXCIpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlIG9uZSBzZWxlY3Rvci4gVGhyb3dzIG9uIGEgc2VsZWN0b3Igb3V0c2lkZSB0aGUgZ3JhbW1hci5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcjogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgYmFzZSA9IHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikgPyBzZWxlY3Rvci5zbGljZSgwLCAtMikgOiBzZWxlY3RvcjtcbiAgICBpZiAoIUxPR0lDQUxfUkUudGVzdChiYXNlKSB8fCBiYXNlLnNwbGl0KFwiL1wiKVswXSAhPT0gXCJsb2dzXCIgfHwgKGJhc2UgPT09IFwibG9nc1wiICYmICFzZWxlY3Rvci5lbmRzV2l0aChcIi8qXCIpKSkge1xuICAgICAgZmFpbChgc2VsZWN0b3IgJHtzZWxlY3Rvcn1gKTtcbiAgICB9XG4gICAgaWYgKGJhc2UuaW5jbHVkZXMoXCIqXCIpKSBmYWlsKFwid2lsZGNhcmQgb25seSBhcyB0cmFpbGluZyAvKlwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGEgc2VsZWN0b3IgbWF0Y2hlcyBhIGxvZ2ljYWwgc291cmNlLiBBIHRyYWlsaW5nIGAvKmAgbWF0Y2hlc1xuICAgKiBkZXNjZW5kYW50cyBvbmx5LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3I6IHN0cmluZywgbG9naWNhbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpIHJldHVybiBsb2dpY2FsLnN0YXJ0c1dpdGgoc2VsZWN0b3Iuc2xpY2UoMCwgLTEpKTtcbiAgICByZXR1cm4gbG9naWNhbCA9PT0gc2VsZWN0b3I7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBhIHNvdXJjZSBpcyB2aXNpYmxlOiBhbiBpbmNsdWRlIG1hdGNoZXMgYW5kIG5vIGV4Y2x1ZGUgZG9lcy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc291cmNlVmlzaWJsZShydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLCBsb2dpY2FsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBjb25zdCBpbmNsdWRlZCA9IChydWxlcy5pbmNsdWRlID8/IFtdKS5zb21lKChzZWxlY3RvcikgPT4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc2VsZWN0b3JNYXRjaGVzKHNlbGVjdG9yLCBsb2dpY2FsKSk7XG4gICAgaWYgKCFpbmNsdWRlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiAhKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pLnNvbWUoKHNlbGVjdG9yKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zZWxlY3Rvck1hdGNoZXMoc2VsZWN0b3IsIGxvZ2ljYWwpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZmlyc3QgMTIgaGV4IGNoYXJhY3RlcnMgb2YgU0hBLTI1NiBvdmVyIHRoZSBjYW5vbmljYWwgcnVsZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHJ1bGVWZXJzaW9uKHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMpOiBzdHJpbmcge1xuICAgIGNvbnN0IGNhbm9uaWNhbCA9IGB7XCJleGNsdWRlXCI6JHtKU09OLnN0cmluZ2lmeShzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpKX0sXCJpbmNsdWRlXCI6JHtKU09OLnN0cmluZ2lmeShzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpKX19YDtcbiAgICByZXR1cm4gc2hhMjU2SGV4KGNhbm9uaWNhbCkuc2xpY2UoMCwgMTIpO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBpbGUgdGhlIHJ1bGVzIGludG8gdGhlIHJlYWRlci1yb2xlIGlubGluZSBwb2xpY3kgZG9jdW1lbnQuIFRoZSByZXR1cm5cbiAgICogdmFsdWUgaXMgdGhlIGNvbnRyYWN0IEpTT04sIHNvIGEgY29uc3VtZXIgY2FuIGNvbXBhcmUgaXQgYnl0ZSBmb3IgYnl0ZS5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgY29tcGlsZVZpc2liaWxpdHlQb2xpY3lKc29uKFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICApOiBzdHJpbmcge1xuICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgWy4uLihydWxlcy5pbmNsdWRlID8/IFtdKSwgLi4uKHJ1bGVzLmV4Y2x1ZGUgPz8gW10pXSkge1xuICAgICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgfVxuICAgIGNvbnN0IGJhc2UgPSBgYXJuOmF3czpsb2dzOiR7dmFsdWVzLnJlZ2lvbn06JHt2YWx1ZXMuYWNjb3VudH06bG9nLWdyb3VwOmA7XG4gICAgY29uc3QgYXJuc0ZvciA9IChzZWxlY3Rvcjogc3RyaW5nKTogc3RyaW5nW10gPT4ge1xuICAgICAgaWYgKHNlbGVjdG9yLmVuZHNXaXRoKFwiLypcIikpIHtcbiAgICAgICAgcmV0dXJuIFtiYXNlICsgbG9nUHJlZml4KHZhbHVlcykgKyBzZWxlY3Rvci5zbGljZSgwLCAtMSkucmVwbGFjZSgvXFwvL2csIFwiX1wiKSArIFwiKlwiXTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG5hbWUgPSBsb2dQcmVmaXgodmFsdWVzKSArIHNlbGVjdG9yLnJlcGxhY2UoL1xcLy9nLCBcIl9cIik7XG4gICAgICByZXR1cm4gW2Jhc2UgKyBuYW1lLCBiYXNlICsgbmFtZSArIFwiOipcIl07XG4gICAgfTtcbiAgICBjb25zdCBhY3Rpb25zID0gWy4uLktFRVBFUl9BQ1RJT05TX0dST1VQLCAuLi5LRUVQRVJfQUNUSU9OU19TVFJFQU1dO1xuICAgIGNvbnN0IHN0YXRlbWVudHM6IHsgU2lkOiBzdHJpbmc7IEVmZmVjdDogc3RyaW5nOyBBY3Rpb246IHN0cmluZ1tdOyBSZXNvdXJjZTogc3RyaW5nW10gfVtdID0gW1xuICAgICAge1xuICAgICAgICBTaWQ6IFwiUmVhZE1hbmlmZXN0XCIsXG4gICAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgICBBY3Rpb246IFtcInNzbTpHZXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgIFJlc291cmNlOiBbXG4gICAgICAgICAgYGFybjphd3M6c3NtOiR7dmFsdWVzLnJlZ2lvbn06JHt2YWx1ZXMuYWNjb3VudH06cGFyYW1ldGVyLyR7TE9HX1BSRUZJWH0vdmlzaWJpbGl0eS8ke3ZhbHVlcy5hcHB9LyR7dmFsdWVzLnN0YWdlfS9tYW5pZmVzdGAsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3QgaW5jbHVkZWQgPSBzb3J0ZWRDb3B5KHJ1bGVzLmluY2x1ZGUpLmZsYXRNYXAoYXJuc0Zvcik7XG4gICAgY29uc3QgZXhjbHVkZWQgPSBzb3J0ZWRDb3B5KHJ1bGVzLmV4Y2x1ZGUpLmZsYXRNYXAoYXJuc0Zvcik7XG4gICAgaWYgKGluY2x1ZGVkLmxlbmd0aCA+IDApIHN0YXRlbWVudHMucHVzaCh7IFNpZDogXCJSZWFkSW5jbHVkZWRcIiwgRWZmZWN0OiBcIkFsbG93XCIsIEFjdGlvbjogYWN0aW9ucywgUmVzb3VyY2U6IGluY2x1ZGVkIH0pO1xuICAgIGlmIChleGNsdWRlZC5sZW5ndGggPiAwKSBzdGF0ZW1lbnRzLnB1c2goeyBTaWQ6IFwiRGVueUV4Y2x1ZGVkXCIsIEVmZmVjdDogXCJEZW55XCIsIEFjdGlvbjogYWN0aW9ucywgUmVzb3VyY2U6IGV4Y2x1ZGVkIH0pO1xuICAgIGNvbnN0IGRvY3VtZW50ID0gSlNPTi5zdHJpbmdpZnkoeyBWZXJzaW9uOiBcIjIwMTItMTAtMTdcIiwgU3RhdGVtZW50OiBzdGF0ZW1lbnRzIH0pO1xuICAgIGlmIChkb2N1bWVudC5sZW5ndGggPiBST0xFX1BPTElDWV9NQVgpIGZhaWwoXCJjb21waWxlZCBwb2xpY3kgb3ZlciByb2xlIHBvbGljeSBzaXplXCIpO1xuICAgIHJldHVybiBkb2N1bWVudDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBc3NlbWJsZSB0aGUgc3ludGgtdGltZSB2aXNpYmlsaXR5IHByZXZpZXcuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZpc2liaWxpdHlQcmV2aWV3KFxuICAgIHZhbHVlczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgICBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICAgIHNvdXJjZXM6IHN0cmluZ1tdLFxuICApOiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHZhbHVlcyk7XG4gICAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBbLi4uKHJ1bGVzLmluY2x1ZGUgPz8gW10pLCAuLi4ocnVsZXMuZXhjbHVkZSA/PyBbXSldKSB7XG4gICAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHJ1bGVWZXJzaW9uOiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5ydWxlVmVyc2lvbihydWxlcyksXG4gICAgICBtYXRjaGVkTm93OiBzb3VyY2VzLmZpbHRlcigoc291cmNlKSA9PiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zb3VyY2VWaXNpYmxlKHJ1bGVzLCBzb3VyY2UpKS5zb3J0KCksXG4gICAgICBub3RNYXRjaGVkTm93OiBzb3VyY2VzLmZpbHRlcigoc291cmNlKSA9PiAhQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc291cmNlVmlzaWJsZShydWxlcywgc291cmNlKSkuc29ydCgpLFxuICAgICAgZnV0dXJlOiB7IGluY2x1ZGU6IHNvcnRlZENvcHkocnVsZXMuaW5jbHVkZSksIGV4Y2x1ZGU6IHNvcnRlZENvcHkocnVsZXMuZXhjbHVkZSkgfSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEFzc2VtYmxlIHRoZSBwdWJsaXNoZWQgbWFuaWZlc3QgKHRoZSBwcmV2aWV3IG1pbnVzIGBub3RNYXRjaGVkTm93YCkuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHZpc2liaWxpdHlNYW5pZmVzdChcbiAgICB2YWx1ZXM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gICAgcnVsZXM6IEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbiAgICBzb3VyY2VzOiBzdHJpbmdbXSxcbiAgKTogQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0IHtcbiAgICBjb25zdCBwcmV2aWV3ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmlzaWJpbGl0eVByZXZpZXcodmFsdWVzLCBydWxlcywgc291cmNlcyk7XG4gICAgcmV0dXJuIHsgcnVsZVZlcnNpb246IHByZXZpZXcucnVsZVZlcnNpb24sIG1hdGNoZWROb3c6IHByZXZpZXcubWF0Y2hlZE5vdywgZnV0dXJlOiBwcmV2aWV3LmZ1dHVyZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFNlcmlhbGl6ZSBhIG1hbmlmZXN0IHRvIHRoZSBjb250cmFjdCBKU09OIHNoYXBlIHdyaXR0ZW4gdG8gU1NNLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBtYW5pZmVzdEpzb24obWFuaWZlc3Q6IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHJ1bGVfdmVyc2lvbjogbWFuaWZlc3QucnVsZVZlcnNpb24sXG4gICAgICBtYXRjaGVkX25vdzogbWFuaWZlc3QubWF0Y2hlZE5vdyxcbiAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBtYW5pZmVzdC5mdXR1cmUuaW5jbHVkZSA/PyBbXSwgZXhjbHVkZTogbWFuaWZlc3QuZnV0dXJlLmV4Y2x1ZGUgPz8gW10gfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBLZWVwZXIncyByZWFkIGRlY2lzaW9uLiBGYWlscyBjbG9zZWQgb24gYSBkZW5pYWwgb3IgYW4gdW5yZWFjaGFibGUgYWNjb3VudC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMga2VlcGVyRGVjaXNpb24oXG4gICAgbG9naWNhbDogc3RyaW5nLFxuICAgIGF3c1Jlc3VsdDogc3RyaW5nLFxuICAgIHJ1bGVzPzogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzLFxuICApOiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIge1xuICAgIGlmICghcnVsZXMgfHwgIUFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnNvdXJjZVZpc2libGUocnVsZXMsIGxvZ2ljYWwpKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5S2VlcGVyQW5zd2VyLk5PVF9TSEFSRUQ7XG4gICAgfVxuICAgIGlmIChhd3NSZXN1bHQgPT09IFwiZXZlbnRzXCIpIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuRVZFTlRTO1xuICAgIGlmIChhd3NSZXN1bHQgPT09IFwiZW1wdHlcIiB8fCBhd3NSZXN1bHQgPT09IFwibm90X2ZvdW5kXCIpIHJldHVybiBBcHBUaGVvcnlLZWVwZXJBbnN3ZXIuQUxMT1dFRF9OT19FVkVOVFM7XG4gICAgcmV0dXJuIEFwcFRoZW9yeUtlZXBlckFuc3dlci5OT1RfU0hBUkVEO1xuICB9XG59XG4iXX0=