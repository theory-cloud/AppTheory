/**
 * The resource-naming contract this module implements.
 */
export declare const RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1";
/**
 * Naming profiles accepted by a naming context.
 */
export declare enum AppTheoryNamingProfile {
    /**
     * Names derive from the naming context.
     */
    DERIVED = "derived",
    /**
     * Every name comes from a pin.
     */
    LEGACY = "legacy"
}
/**
 * Logging profiles accepted by a naming context.
 */
export declare enum AppTheoryLoggingProfile {
    /**
     * AppTheory creates standard log groups and access logging.
     */
    STANDARD = "standard",
    /**
     * Each construct keeps its pre-contract logging behaviour.
     */
    LEGACY = "legacy"
}
/**
 * Keeper's answer to a reader request.
 */
export declare enum AppTheoryKeeperAnswer {
    /**
     * The source is shared and the read returned events.
     */
    EVENTS = "events",
    /**
     * The source is shared and the read returned no events.
     */
    ALLOWED_NO_EVENTS = "allowed_no_events",
    /**
     * The source is not shared, or the read failed closed.
     */
    NOT_SHARED = "not_shared"
}
/**
 * Bound naming and logging context values from stage config.
 */
export interface AppTheoryNamingContextValues {
    /**
     * Namespace segment.
     * @default "theorycloud"
     */
    readonly namespace?: string;
    /**
     * App instance id.
     */
    readonly app: string;
    /**
     * Stage id.
     */
    readonly stage: string;
    /**
     * Twelve-digit account id. An unresolved token fails synthesis.
     */
    readonly account: string;
    /**
     * Full Region code, for example `us-east-1`.
     */
    readonly region: string;
    /**
     * Physical pins keyed `{type}:{logical}`.
     * @default {}
     */
    readonly pins?: {
        [key: string]: string;
    };
    /**
     * Naming profile.
     * @default AppTheoryNamingProfile.DERIVED
     */
    readonly namingProfile?: AppTheoryNamingProfile;
    /**
     * Logging profile.
     * @default AppTheoryLoggingProfile.LEGACY
     */
    readonly loggingProfile?: AppTheoryLoggingProfile;
    /**
     * Log retention in days for standard-profile log groups.
     * @default 30
     */
    readonly retentionDays?: number;
}
/**
 * The composed physical name of one resource.
 */
export interface AppTheoryPhysicalName {
    /**
     * The full physical name.
     */
    readonly name: string;
    /**
     * The account-regional bucket-name prefix, when the type uses one.
     * @default undefined
     */
    readonly bucketNamePrefix?: string;
    /**
     * The bucket namespace, when the type uses one.
     * @default undefined
     */
    readonly bucketNamespace?: string;
    /**
     * Whether the name came from a pin.
     * @default false
     */
    readonly pinned?: boolean;
}
/**
 * Include and exclude visibility selectors.
 */
export interface AppTheoryVisibilityRules {
    /**
     * Selectors whose sources are shared.
     * @default []
     */
    readonly include?: string[];
    /**
     * Selectors whose sources are never shared. Exclusions win.
     * @default []
     */
    readonly exclude?: string[];
}
/**
 * The synth-time visibility preview.
 */
export interface AppTheoryVisibilityPreview {
    /**
     * First 12 hex characters of the canonical rules hash.
     */
    readonly ruleVersion: string;
    /**
     * Current synthesized sources the rules share.
     */
    readonly matchedNow: string[];
    /**
     * Current synthesized sources the rules do not share.
     */
    readonly notMatchedNow: string[];
    /**
     * The selectors, as the statement of what future sources will match.
     */
    readonly future: AppTheoryVisibilityRules;
}
/**
 * The published SSM manifest: the preview minus `notMatchedNow`.
 */
export interface AppTheoryVisibilityManifest {
    /**
     * First 12 hex characters of the canonical rules hash.
     */
    readonly ruleVersion: string;
    /**
     * Current synthesized sources the rules share.
     */
    readonly matchedNow: string[];
    /**
     * The selectors, as the statement of what future sources will match.
     */
    readonly future: AppTheoryVisibilityRules;
}
/**
 * The `theorycloud_resource_naming.v0.1` primitives, exposed for jsii so the Go
 * and Python CDK bindings share one implementation.
 */
export declare class AppTheoryResourceNaming {
    private constructor();
    /**
     * Validate the bound context grammar. Throws on an invalid context.
     */
    static validateContext(values: AppTheoryNamingContextValues): void;
    /**
     * The CloudFormation-appended account-regional bucket suffix.
     */
    static s3AccountRegionalSuffix(values: AppTheoryNamingContextValues): string;
    /**
     * The bound prefix shared by every log source of the app.
     */
    static logSourcePrefix(values: AppTheoryNamingContextValues): string;
    /**
     * Map a logical log source to its physical log-group name.
     */
    static logGroupName(values: AppTheoryNamingContextValues, logical: string): string;
    /**
     * Compose the physical name of one resource. A pin always wins; a legacy
     * profile without a pin fails synthesis.
     */
    static physicalName(values: AppTheoryNamingContextValues, resourceType: string, logical: string): AppTheoryPhysicalName;
    /**
     * Validate one selector. Throws on a selector outside the grammar.
     */
    static validateSelector(selector: string): void;
    /**
     * Whether a selector matches a logical source. A trailing `/*` matches
     * descendants only.
     */
    static selectorMatches(selector: string, logical: string): boolean;
    /**
     * Whether a source is visible: an include matches and no exclude does.
     */
    static sourceVisible(rules: AppTheoryVisibilityRules, logical: string): boolean;
    /**
     * The first 12 hex characters of SHA-256 over the canonical rules.
     */
    static ruleVersion(rules: AppTheoryVisibilityRules): string;
    /**
     * Compile the rules into the reader-role inline policy document. The return
     * value is the contract JSON, so a consumer can compare it byte for byte.
     */
    static compileVisibilityPolicyJson(values: AppTheoryNamingContextValues, rules: AppTheoryVisibilityRules): string;
    /**
     * Assemble the synth-time visibility preview.
     */
    static visibilityPreview(values: AppTheoryNamingContextValues, rules: AppTheoryVisibilityRules, sources: string[]): AppTheoryVisibilityPreview;
    /**
     * Assemble the published manifest (the preview minus `notMatchedNow`).
     */
    static visibilityManifest(values: AppTheoryNamingContextValues, rules: AppTheoryVisibilityRules, sources: string[]): AppTheoryVisibilityManifest;
    /**
     * Serialize a manifest to the contract JSON shape written to SSM.
     */
    static manifestJson(manifest: AppTheoryVisibilityManifest): string;
    /**
     * Keeper's read decision. Fails closed on a denial or an unreachable account.
     */
    static keeperDecision(logical: string, awsResult: string, rules?: AppTheoryVisibilityRules): AppTheoryKeeperAnswer;
}
