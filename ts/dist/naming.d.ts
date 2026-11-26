export declare function normalizeStage(stage: string): string;
export declare function baseName(appName: string, stage: string, tenant?: string): string;
export declare function resourceName(appName: string, resource: string, stage: string, tenant?: string): string;
/** The resource-naming contract this module implements. */
export declare const RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1";
/** The leading segment of every log-source name. */
export declare const LOG_SOURCE_PREFIX = "theorycloud";
/** The aggregate inline role policy quota, in characters. */
export declare const ROLE_POLICY_MAX = 10240;
/** The longest hosted namespace label, in characters (contract section 1, r5 rev1). */
export declare const HOSTED_NAMESPACE_MAX = 12;
/** Naming profile values accepted by a naming context. */
export type NamingProfile = "derived" | "legacy";
/** Logging profile values accepted by a naming context. */
export type LoggingProfile = "standard" | "legacy";
/** The bound naming context (contract section 1). */
export interface NamingContext {
    /** Namespace segment; defaults to `theorycloud`. */
    readonly namespace?: string;
    /** App instance id. */
    readonly app: string;
    /** Stage id. */
    readonly stage: string;
    /** Twelve-digit account id. */
    readonly account: string;
    /** Full Region code. */
    readonly region: string;
    /** `derived` (default) or `legacy`. */
    readonly naming_profile?: NamingProfile;
    /**
     * `true` for a deployment TheoryCloud.ai places on a tenant's behalf
     * (contract section 1, r5). A hosted deployment always supplies its
     * namespace, never uses the reserved platform namespace, and carries the
     * namespace in every derived name (contract section 2). Only first-party
     * platform apps omit it.
     * @default false
     */
    readonly hosted?: boolean;
    /** Generated-name entries keyed `{type}:{logical}`; valid only under `legacy`. */
    readonly generated?: string[];
}
/** Physical pins keyed `{type}:{logical}`. */
export type NamingPins = {
    [key: string]: string;
};
/** The composition kind of one resource-type row. */
export type ResourceNameKind = "dash" | "path" | "s3ar" | "log";
/** One row of the per-type composition table. */
export interface ResourceNameRule {
    readonly kind: ResourceNameKind;
    readonly max: number;
    readonly charset: string;
    readonly lead?: string;
}
/** The per-type composition table (contract section 2). */
export declare const RESOURCE_NAME_RULES: {
    [type: string]: ResourceNameRule;
};
/** The result of composing a logical name (contract JSON shape). */
export interface ComposedName {
    readonly name?: string;
    readonly bucket_name_prefix?: string;
    readonly bucket_namespace?: string;
    readonly pinned?: boolean;
    readonly generated?: boolean;
}
/** The only log actions a reader role is granted. */
export declare const KEEPER_ACTIONS_GROUP: string[];
export declare const KEEPER_ACTIONS_STREAM: string[];
/** A consumer's include/exclude visibility selectors. */
export interface VisibilityRules {
    readonly include?: string[];
    readonly exclude?: string[];
}
/** One IAM policy statement. */
export interface VisibilityStatement {
    readonly Sid: string;
    readonly Effect: string;
    readonly Action: string[];
    readonly Resource: string[];
}
/** The compiled reader-role inline policy. */
export interface VisibilityPolicy {
    readonly Version: string;
    readonly Statement: VisibilityStatement[];
}
/** The selector statement of the preview. */
export interface VisibilityFutureRules {
    readonly include: string[];
    readonly exclude: string[];
}
/** The synth-time visibility preview. */
export interface VisibilityPreview {
    readonly rule_version: string;
    readonly matched_now: string[];
    readonly not_matched_now: string[];
    readonly future: VisibilityFutureRules;
}
/** The published SSM manifest: the preview minus `not_matched_now`. */
export interface VisibilityManifest {
    readonly rule_version: string;
    readonly matched_now: string[];
    readonly future: VisibilityFutureRules;
}
/** Keeper answers for a read request (contract section 7). */
export type KeeperAnswer = "events" | "allowed_no_events" | "not_shared";
/** Enforce the bound-context grammar. */
export declare function validateNamingContext(context: NamingContext): void;
/**
 * Apply the hosted namespace label rule (contract section 1, r5 rev1): a
 * namespace other than the reserved platform one is at most
 * `HOSTED_NAMESPACE_MAX` characters and never starts with `aws` or `ssm`. Those
 * two prefixes are reserved by AWS, so a name carrying them cannot be created.
 */
export declare function validateHostedNamespace(namespace: string): void;
/**
 * Whether every derived name carries the namespace (contract section 2, r5):
 * true for a hosted deployment and for any namespace other than the reserved
 * platform one. The platform namespace keeps the compatibility form byte for
 * byte, so the live hard gate (contract section 4) is unchanged.
 */
export declare function namespacedContext(context: NamingContext): boolean;
/**
 * The `{namespace}-{app}-{stage}-{logical}` stem of a `dash` name or an S3
 * account-regional prefix, with `/` in the logical name replaced by `-`.
 */
export declare function dashStem(context: NamingContext, logical: string): string;
/**
 * The `{namespace}/{app}/{stage}/{logical}` stem of a `path` name.
 */
export declare function pathStem(context: NamingContext, logical: string): string;
/**
 * The leading namespace component a hosted pin must carry, exactly where the
 * derived form puts it (contract section 4, r5 rev1, rev2). Containing the
 * namespace elsewhere is not enough: `shop-lab-events` is not a pin for
 * namespace `hop`.
 */
export declare function hostedPinLead(context: NamingContext, rule: ResourceNameRule): string;
/** Apply the deterministic over-budget form (contract section 2.2). */
export declare function shortenResourceName(full: string, limit: number): string;
/** The CloudFormation-appended account-regional suffix. */
export declare function s3AccountRegionalSuffix(context: NamingContext): string;
/** The bound prefix shared by every log source of the app. */
export declare function logSourcePrefix(context: NamingContext): string;
/**
 * Map a logical log source to its physical log-group name.
 *
 * The context is validated first, so a context that breaks a rule is refused
 * here as well: resolving one log-source name is enough to establish the
 * context's naming, and a forbidden naming profile must not survive on the
 * log-only path (SAN-AT-N5-01).
 */
export declare function logGroupName(context: NamingContext, logical: string): string;
/**
 * Compose the physical name of one resource. Pins are returned verbatim.
 *
 * A hosted deployment (`hosted: true`, or any namespace other than the platform
 * one) carries the namespace as the first component of every derived name, its
 * S3 prefix included, and takes no pin whose name does not start with that
 * namespace component (contract sections 2 and 4, r5).
 */
export declare function physicalResourceName(context: NamingContext, resourceType: string, logical: string, pins?: NamingPins, generated?: string[]): ComposedName;
/** Enforce the selector grammar (contract section 5). */
export declare function validateVisibilitySelector(selector: string): void;
/** Whether a selector matches a logical source. `/*` matches descendants only. */
export declare function visibilitySelectorMatches(selector: string, logical: string): boolean;
/** Whether a source is visible: an include matches and no exclude does. */
export declare function sourceVisible(rules: VisibilityRules, logical: string): boolean;
/** Expand a selector to the log-group ARNs it covers. */
export declare function visibilitySelectorArns(context: NamingContext, selector: string): string[];
/** The first 12 hex characters of SHA-256 over the canonical rules. */
export declare function visibilityRuleVersion(rules: VisibilityRules): string;
/** Compile the rules into the reader-role inline policy. */
export declare function compileVisibilityPolicy(context: NamingContext, rules: VisibilityRules): VisibilityPolicy;
/** Assemble the synth-time preview. */
export declare function visibilityPreview(rules: VisibilityRules, sources: string[]): VisibilityPreview;
/** Assemble the published manifest (no `not_matched_now`). */
export declare function visibilityManifest(rules: VisibilityRules, sources: string[]): VisibilityManifest;
/** Keeper's answer to a read request. Fails closed on denial or unreachable. */
export declare function keeperDecision(rules: VisibilityRules | undefined, logical: string, awsResult: string): KeeperAnswer;
/** The scope in which AWS requires a type's names to be unique (§11.1). */
export type NamingScope = "account" | "account_region" | "not_unique";
/**
 * The scope in which AWS requires a type's names to be unique (contract section
 * 11.1). A type the contract states no scope for is refused: it cannot be
 * reserved, so it cannot be deployed through the reservation index until a
 * revision states its scope.
 */
export declare function namingScope(resourceType: string): NamingScope;
/**
 * One physically named resource a stack declares, as the synth check consumes
 * it. A generated entry carries no name: CloudFormation owns the name, so there
 * is nothing to reserve.
 */
export interface NameEntry {
    readonly name?: string;
    readonly type: string;
    readonly logical_id: string;
    readonly generated?: boolean;
}
/** One row of the derived-name artifact (§11.4): the set §11.2 reserves. */
export interface DerivedName {
    readonly name?: string;
    readonly type: string;
    readonly scope: NamingScope;
    readonly logical_id: string;
    readonly generated?: boolean;
}
/**
 * Refuse two different logical resources in one naming context that derive the
 * same name in the same naming scope, and return the derived-name artifact
 * (contract section 11.4). A Lambda function and its IAM role may share a name
 * because their scopes differ, and two APIs may share one because AWS does not
 * keep API names unique. Rows keep the order of the entries.
 */
export declare function synthCheck(entries: NameEntry[]): DerivedName[];
//# sourceMappingURL=naming.d.ts.map