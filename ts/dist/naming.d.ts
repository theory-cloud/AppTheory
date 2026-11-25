export declare function normalizeStage(stage: string): string;
export declare function baseName(appName: string, stage: string, tenant?: string): string;
export declare function resourceName(appName: string, resource: string, stage: string, tenant?: string): string;
/** The resource-naming contract this module implements. */
export declare const RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1";
/** The leading segment of every log-source name. */
export declare const LOG_SOURCE_PREFIX = "theorycloud";
/** The aggregate inline role policy quota, in characters. */
export declare const ROLE_POLICY_MAX = 10240;
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
/** Apply the deterministic over-budget form (contract section 2.2). */
export declare function shortenResourceName(full: string, limit: number): string;
/** The CloudFormation-appended account-regional suffix. */
export declare function s3AccountRegionalSuffix(context: NamingContext): string;
/** The bound prefix shared by every log source of the app. */
export declare function logSourcePrefix(context: NamingContext): string;
/** Map a logical log source to its physical log-group name. */
export declare function logGroupName(context: NamingContext, logical: string): string;
/** Compose the physical name of one resource. Pins are returned verbatim. */
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
//# sourceMappingURL=naming.d.ts.map