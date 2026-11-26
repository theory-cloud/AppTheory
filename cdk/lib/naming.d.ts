/**
 * The resource-naming contract this module implements.
 */
export declare const RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1";
/**
 * The schema identifier of the derived-name artifact a naming context emits.
 */
export declare const DERIVED_NAMES_SCHEMA = "apptheory_resource_naming.derived_names.v1";
/**
 * The cloud-assembly metadata type that carries the derived-name artifact. The
 * artifact lands in `{stack}.metadata.json` in `cdk.out`.
 */
export declare const DERIVED_NAMES_METADATA_KEY = "apptheory:resource-naming/derived-names";
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
     * Generated-name entries keyed `{type}:{logical}`. An entry means
     * CloudFormation generates the name today, so the construct sets no
     * physical-name property. Valid only under the legacy naming profile.
     * @default []
     */
    readonly generated?: string[];
    /**
     * `true` for a deployment TheoryCloud.ai places on a tenant's behalf
     * (contract section 1, r5). A hosted deployment always supplies its
     * namespace, never uses the reserved platform namespace, and carries the
     * namespace in every derived name (contract section 2). Only first-party
     * platform apps omit it.
     * @default false
     */
    readonly hosted?: boolean;
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
     * The full physical name. Absent when CloudFormation generates the name.
     * @default undefined
     */
    readonly name?: string;
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
    /**
     * Whether CloudFormation generates the name, so no physical-name property is
     * set.
     * @default false
     */
    readonly generated?: boolean;
}
/**
 * One physically named resource a stack declares, as the synth check (contract
 * section 11.4) consumes it. A generated entry carries no name: CloudFormation
 * owns the name, so there is nothing to reserve.
 */
export interface AppTheoryDerivedNameInput {
    /**
     * The physical name. Absent for a generated entry.
     * @default undefined
     */
    readonly name?: string;
    /**
     * The contract resource type, for example `lambda_function`.
     */
    readonly type: string;
    /**
     * The CloudFormation logical id of the resource carrying the name, or — when
     * the caller's naming context spans several stacks — the owning stack's
     * construct path plus that logical id, because a logical id is unique only
     * within one template.
     */
    readonly logicalId: string;
    /**
     * Whether CloudFormation generates the name, so nothing is reserved.
     * @default false
     */
    readonly generated?: boolean;
}
/**
 * One row of the derived-name artifact: the complete set the name reservation
 * index (contract section 11.2) reserves.
 */
export interface AppTheoryDerivedName {
    /**
     * The physical name. Absent for a generated entry.
     * @default undefined
     */
    readonly name?: string;
    /**
     * The contract resource type.
     */
    readonly type: string;
    /**
     * The scope in which AWS requires the name to be unique: `account`,
     * `account_region`, or `not_unique`.
     */
    readonly scope: string;
    /**
     * The CloudFormation logical id of the resource carrying the name.
     */
    readonly logicalId: string;
    /**
     * Whether CloudFormation generates the name, so nothing is reserved.
     * @default false
     */
    readonly generated?: boolean;
}
/**
 * The derived-name artifact a naming context emits at synthesis (contract
 * section 11.4), keyed `{stack}.metadata.json` in the cloud assembly.
 */
export interface AppTheoryDerivedNames {
    /**
     * The contract identifier.
     */
    readonly contract: string;
    /**
     * The artifact schema identifier.
     */
    readonly schema: string;
    /**
     * The naming context that produced the artifact.
     */
    readonly context: AppTheoryNamingContextValues;
    /**
     * Every physically named resource the context declares, sorted by `scope`,
     * `type`, `name` and `logicalId`.
     */
    readonly entries: AppTheoryDerivedName[];
}
/**
 * The naming scopes of contract section 11.1.
 */
export declare enum AppTheoryNamingScope {
    /**
     * AWS keeps the name unique across the whole account, whatever the Region.
     */
    ACCOUNT = "account",
    /**
     * AWS keeps the name unique per account and Region.
     */
    ACCOUNT_REGION = "account_region",
    /**
     * AWS does not keep the name unique, so nothing is reserved for it.
     */
    NOT_UNIQUE = "not_unique"
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
     *
     * The naming profile and the context's own generated entries are properties of
     * the context, so a namespaced context that carries either is refused here —
     * when the context is validated, at construction — and not only as a side
     * effect of composing a physical name (contract sections 1 and 4, r5;
     * SAN-AT-N5-01). A hosted context that declares nothing yet would otherwise
     * stand as a valid context whose every future name could carry no namespace.
     */
    static validateContext(values: AppTheoryNamingContextValues): void;
    /**
     * Apply the hosted namespace label rule to one namespace (contract section 1,
     * r5 rev1): a namespace other than the reserved platform one is at most 12
     * characters and never starts with `aws` or `ssm`. Throws on a namespace
     * outside it.
     */
    static validateHostedNamespace(namespace: string): void;
    /**
     * Whether every derived name under these values carries the namespace
     * (contract section 2, r5): true for a hosted deployment and for any namespace
     * other than the reserved platform one.
     */
    static namespaced(values: AppTheoryNamingContextValues): boolean;
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
     *
     * The context is validated first, so resolving one log-source name is enough
     * to refuse a context that breaks a rule: a forbidden naming profile must not
     * survive on the log-only path (contract sections 1 and 4, r5; SAN-AT-N5-01).
     */
    static logGroupName(values: AppTheoryNamingContextValues, logical: string): string;
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
    static physicalName(values: AppTheoryNamingContextValues, resourceType: string, logical: string): AppTheoryPhysicalName;
    /**
     * The scope in which AWS requires a type's names to be unique (contract
     * section 11.1). A type the contract states no scope for is refused: it cannot
     * be reserved, so it cannot be deployed through the index until a revision
     * states its scope.
     */
    static namingScope(resourceType: string): AppTheoryNamingScope;
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
    static validatePhysicalName(resourceType: string, name: string): void;
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
    static synthCheck(entries: AppTheoryDerivedNameInput[]): AppTheoryDerivedName[];
    /**
     * The derived-name artifact as the cloud-assembly metadata document, with the
     * contract's snake_case wire keys and a deterministic entry order.
     */
    static derivedNamesJson(artifact: AppTheoryDerivedNames): string;
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
     * Keeper's read decision, in the runtimes' parameter order. Fails closed on a
     * denial or an unreachable account.
     */
    static keeperDecision(rules: AppTheoryVisibilityRules, logical: string, awsResult: string): AppTheoryKeeperAnswer;
}
