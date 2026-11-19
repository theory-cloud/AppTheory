import { Token } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  AppTheoryLoggingProfile,
  AppTheoryNamingProfile,
  AppTheoryNamingContextValues,
  AppTheoryPhysicalName,
  AppTheoryResourceNaming,
} from "./naming";

/**
 * Accepted CloudWatch Logs `RetentionInDays` values. AWS rejects any other
 * value, so the context fails synthesis instead of deferring a deploy-time
 * error.
 */
const ACCEPTED_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
];

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
  readonly pins?: { [key: string]: string };

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
export class AppTheoryNamingContext extends Construct {
  /**
   * Namespace segment.
   */
  public readonly namespace: string;

  /**
   * App instance id.
   */
  public readonly app: string;

  /**
   * Stage id.
   */
  public readonly stage: string;

  /**
   * Twelve-digit account id.
   */
  public readonly account: string;

  /**
   * Full Region code.
   */
  public readonly region: string;

  /**
   * Physical pins keyed `{type}:{logical}`.
   */
  public readonly pins: { [key: string]: string };

  /**
   * Naming profile.
   */
  public readonly namingProfile: AppTheoryNamingProfile;

  /**
   * Logging profile.
   */
  public readonly loggingProfile: AppTheoryLoggingProfile;

  /**
   * Retention in days for standard-profile log groups.
   */
  public readonly retentionDays: number;

  constructor(scope: Construct, id: string, props: AppTheoryNamingContextProps) {
    super(scope, id);

    if (Token.isUnresolved(props.account)) {
      throw new Error(
        "AppTheoryNamingContext requires a concrete account id; the naming contract derives physical names from it and an unresolved token cannot be validated at synthesis",
      );
    }
    if (Token.isUnresolved(props.region)) {
      throw new Error("AppTheoryNamingContext requires a concrete region; an unresolved token cannot be validated at synthesis");
    }

    this.namespace = props.namespace ?? "theorycloud";
    this.app = props.app;
    this.stage = props.stage;
    this.account = props.account;
    this.region = props.region;
    this.pins = { ...(props.pins ?? {}) };
    this.namingProfile = props.namingProfile ?? AppTheoryNamingProfile.DERIVED;
    this.loggingProfile = props.loggingProfile ?? AppTheoryLoggingProfile.LEGACY;
    this.retentionDays = props.retentionDays ?? 30;

    AppTheoryResourceNaming.validateContext(this.values());

    if (!ACCEPTED_RETENTION_DAYS.includes(this.retentionDays)) {
      throw new Error(
        `AppTheoryNamingContext retentionDays must be one of ${ACCEPTED_RETENTION_DAYS.join(", ")}; CloudWatch Logs rejects other values`,
      );
    }
  }

  /**
   * Whether the standard logging profile is active.
   */
  public get standardLogging(): boolean {
    return this.loggingProfile === AppTheoryLoggingProfile.STANDARD;
  }

  /**
   * The context values as a jsii struct.
   */
  public values(): AppTheoryNamingContextValues {
    return {
      namespace: this.namespace,
      app: this.app,
      stage: this.stage,
      account: this.account,
      region: this.region,
      pins: this.pins,
      namingProfile: this.namingProfile,
      loggingProfile: this.loggingProfile,
      retentionDays: this.retentionDays,
    };
  }

  /**
   * Compose the physical name of one resource under this context.
   */
  public physicalName(resourceType: string, logical: string): AppTheoryPhysicalName {
    return AppTheoryResourceNaming.physicalName(this.values(), resourceType, logical);
  }

  /**
   * The physical log-group name of a logical source under this context.
   */
  public logGroupName(logical: string): string {
    return AppTheoryResourceNaming.logGroupName(this.values(), logical);
  }

  /**
   * The bound prefix shared by this app's log sources.
   */
  public logSourcePrefix(): string {
    return AppTheoryResourceNaming.logSourcePrefix(this.values());
  }
}
