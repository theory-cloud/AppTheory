import { Construct } from "constructs";
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
     * The physical log-group name of a logical source under this context.
     */
    logGroupName(logical: string): string;
    /**
     * The bound prefix shared by this app's log sources.
     */
    logSourcePrefix(): string;
}
