import { IConstruct, Construct } from "constructs";
import { AppTheoryLoggingProfile, AppTheoryNamingProfile, AppTheoryNamingContextValues, AppTheoryPhysicalName } from "./naming";
/**
 * Properties for an `AppTheoryNamingContext`.
 *
 * The context holds the bound naming and logging values from stage config.
 * Constructs take it as an optional prop; with no context every construct
 * synthesizes exactly as it did before this contract existed.
 */
export interface AppTheoryNamingContextProps {
    /**
     * Namespace segment.
     * @default "theorycloud"
     */
    readonly namespace?: string;
    /**
     * App instance id from stage config.
     */
    readonly app: string;
    /**
     * Stage id from stage config.
     */
    readonly stage: string;
    /**
     * Twelve-digit account id from stage config. An unresolved token fails
     * synthesis.
     */
    readonly account: string;
    /**
     * Full Region code, for example `us-east-1`.
     */
    readonly region: string;
    /**
     * Physical pins keyed `{type}:{logical}`, used verbatim under a legacy
     * naming profile.
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
     * Naming profile.
     * @default AppTheoryNamingProfile.DERIVED
     */
    readonly namingProfile?: AppTheoryNamingProfile;
    /**
     * Logging profile. `standard` opts every construct that receives the context
     * into the contract's log groups and access logging. `legacy` keeps each
     * construct's pre-contract behaviour.
     * @default AppTheoryLoggingProfile.LEGACY
     */
    readonly loggingProfile?: AppTheoryLoggingProfile;
    /**
     * Retention in days for standard-profile log groups. Must be a value
     * CloudWatch Logs accepts.
     * @default 30
     */
    readonly retentionDays?: number;
}
/**
 * The bound naming and logging context shared by AppTheory constructs.
 */
export declare class AppTheoryNamingContext extends Construct {
    /**
     * Namespace segment.
     */
    readonly namespace: string;
    /**
     * App instance id.
     */
    readonly app: string;
    /**
     * Stage id.
     */
    readonly stage: string;
    /**
     * Twelve-digit account id.
     */
    readonly account: string;
    /**
     * Full Region code.
     */
    readonly region: string;
    /**
     * Physical pins keyed `{type}:{logical}`.
     */
    readonly pins: {
        [key: string]: string;
    };
    /**
     * Generated-name entries keyed `{type}:{logical}`.
     */
    readonly generated: string[];
    /**
     * The naming entries a construct has consumed at synthesis.
     */
    private readonly consumed;
    /**
     * The physically named resources a construct has declared (contract section
     * 11.4). Each declaration ties one composed name to the CloudFormation
     * resource that carries it, so synthesis can refuse a collision and emit the
     * derived-name artifact the reservation index reserves.
     */
    private readonly declared;
    /**
     * Naming profile.
     */
    readonly namingProfile: AppTheoryNamingProfile;
    /**
     * Logging profile.
     */
    readonly loggingProfile: AppTheoryLoggingProfile;
    /**
     * Retention in days for standard-profile log groups.
     */
    readonly retentionDays: number;
    constructor(scope: Construct, id: string, props: AppTheoryNamingContextProps);
    /**
     * Whether the standard logging profile is active.
     */
    get standardLogging(): boolean;
    /**
     * The context values as a jsii struct.
     */
    values(): AppTheoryNamingContextValues;
    /**
     * Compose the physical name of one resource under this context.
     */
    physicalName(resourceType: string, logical: string): AppTheoryPhysicalName;
    /**
     * Declare the CloudFormation resource that carries one composed name
     * (contract section 11.4).
     *
     * Synthesis refuses two different logical resources in one naming context that
     * derive the same name in the same naming scope, and emits the derived-name
     * artifact the name reservation index reserves. A construct declares every
     * physically named resource it creates; an application that names its own
     * resource with `physicalName` declares it here once the resource exists, so
     * the artifact covers it too.
     *
     * A name AppTheory only wires for a resource another stack owns, such as
     * `AppTheorySsrSite`'s ISR metadata table, takes no declaration here: that
     * stack declares its own resource.
     *
     * A `log_group` type declares a log-source name (contract section 3): a log
     * group takes no pin or generated entry.
     */
    declareName(resourceType: string, logical: string, resource: IConstruct): void;
    /**
     * Declare the CloudFormation resource that carries one name the contract fixes
     * rather than derives (contract section 11.4).
     *
     * Two names AppTheory creates fall outside the derivation table: the Lambda
     * service log group `/aws/lambda/{function name}`, and the visibility manifest
     * parameter `/theorycloud/visibility/{app}/{stage}/manifest` (contract section
     * 6). They are still names the context determines and resources the stack
     * creates, so the artifact carries them; the reserved scope is the type's scope
     * from contract section 11.1.
     *
     * An application that names its own resource with a fixed contract path
     * declares it here too, so the artifact covers it.
     *
     * A fixed name is still a physical name of its type, so it must satisfy the
     * character and shape rules of the contract's section 2 rule table for that
     * type (length, charset, the S3 start/end rule, the SSM and KMS path rules,
     * the secret suffix rule). A name outside them fails synthesis instead of
     * entering the artifact as a name the installer can never create
     * (SANITY-AT-N3-08).
     */
    declareFixedName(resourceType: string, name: string, resource: IConstruct): void;
    /**
     * The CloudFormation resource a declaration names. The construct's default
     * child is the L1 resource a construct creates for itself, so an L2 construct
     * is the expected argument.
     */
    private cloudFormationResource;
    /**
     * Refuse a declaration whose owning stack is in a different CDK Stage from the
     * context (SANITY-AT-N3-02).
     *
     * Each Stage is a separate cloud assembly, and CDK validates a tree stage by
     * stage, so the synth check never sees the other assembly: a context above a
     * Stage cannot compare its names, and a document written after that assembly
     * exists is silently lost. A context and every stack declaring through it
     * therefore belong to one Stage (or to none, at the App root).
     */
    private assertSameStage;
    /**
     * Refuse a declaration whose owning stack resolves to an environment the
     * context does not claim (SANITY-AT-N3-06).
     *
     * The derived-name artifact claims the context's account and region, and the
     * reservation index keys a name by its scope in that environment, so a stack
     * in another account or Region would reserve names it cannot create while the
     * check refused or admitted them against the wrong environment. An
     * env-agnostic stack (an unresolved account or region) is admitted: it
     * deploys into the context's environment, which is what the artifact claims.
     */
    private assertSameEnvironment;
    /**
     * The nearest stack above the context, if it has one. A context created above
     * the stacks has none: its artifact then appears on the stacks its
     * declarations attribute to.
     */
    private owningStack;
    /**
     * The physical log-group name of a logical source under this context.
     */
    logGroupName(logical: string): string;
    /**
     * The bound prefix shared by this app's log sources.
     */
    logSourcePrefix(): string;
}
