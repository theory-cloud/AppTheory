import { App, CfnResource, Stack, Stage, Token } from "aws-cdk-lib";
import { IConstruct, Construct } from "constructs";

import {
  AppTheoryDerivedName,
  AppTheoryDerivedNameInput,
  AppTheoryDerivedNames,
  AppTheoryLoggingProfile,
  AppTheoryNamingProfile,
  AppTheoryNamingContextValues,
  AppTheoryPhysicalName,
  AppTheoryResourceNaming,
  DERIVED_NAMES_METADATA_KEY,
  DERIVED_NAMES_SCHEMA,
  RESOURCE_NAMING_CONTRACT,
} from "./naming";
import { LAMBDA_LOG_GROUP_LEAD, LOG_SOURCE_REMAINDER_RE } from "./private/log-source-grammar";

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
   *
   * This is the account the derived-name artifact claims. AppTheory does not
   * compare it with the account of the stack that declares a resource;
   * TheoryCloud.ai's installer validates the artifact's account against the
   * stack it deploys.
   */
  readonly account: string;

  /**
   * Full Region code, for example `us-east-1`.
   *
   * This is the Region the derived-name artifact claims. AppTheory does not
   * compare it with the Region of the stack that declares a resource;
   * TheoryCloud.ai's installer validates it against the stack it deploys.
   */
  readonly region: string;

  /**
   * Physical pins keyed `{type}:{logical}`, used verbatim under a legacy
   * naming profile.
   * @default {}
   */
  readonly pins?: { [key: string]: string };

  /**
   * Generated-name entries keyed `{type}:{logical}`. An entry means
   * CloudFormation generates the name today, so the construct sets no
   * physical-name property. Valid only under the legacy naming profile.
   * @default []
   */
  readonly generated?: string[];

  /**
   * `true` for a deployment TheoryCloud.ai places on a tenant's behalf
   * (contract section 1, r5): a pooled, isolated or dedicated managed-account
   * placement.
   *
   * TheoryCloud.ai sets this flag and the tenant `namespace` on every deployment
   * it places, and injects `account` and `region` from its own placement logic.
   * Only first-party platform apps omit it; for them the platform default
   * (namespace `theorycloud`, the r4 forms) is unchanged.
   *
   * A hosted context always supplies a `namespace`, never uses the reserved
   * platform namespace, carries the namespace in every derived name, and takes
   * no legacy naming profile and no generated entries. A context that breaks any
   * of these fails synthesis.
   * @default false
   */
  readonly hosted?: boolean;

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
 * One declared physically named resource: the composed name, and the construct
 * whose CloudFormation resource carries it.
 */
interface AppTheoryNameDeclaration {
  readonly type: string;
  readonly logical: string;
  readonly name?: string;
  readonly generated: boolean;
  readonly resource: IConstruct;
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
   * Twelve-digit account id. The derived-name artifact claims this account; it
   * is not compared with any declaring stack's account.
   */
  public readonly account: string;

  /**
   * Full Region code. The derived-name artifact claims this Region; it is not
   * compared with any declaring stack's Region.
   */
  public readonly region: string;

  /**
   * Physical pins keyed `{type}:{logical}`.
   */
  public readonly pins: { [key: string]: string };

  /**
   * Generated-name entries keyed `{type}:{logical}`.
   */
  public readonly generated: string[];

  /**
   * The naming entries a construct has consumed at synthesis.
   */
  private readonly consumed = new Set<string>();

  /**
   * The physically named resources a construct has declared (contract section
   * 11.4). Each declaration ties one composed name to the CloudFormation
   * resource that carries it, so synthesis can refuse a collision and emit the
   * derived-name artifact the reservation index reserves.
   */
  private readonly declared: AppTheoryNameDeclaration[] = [];

  /**
   * Whether this context is a hosted deployment TheoryCloud.ai places
   * (contract section 1, r5).
   */
  public readonly hosted: boolean;

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

    this.hosted = props.hosted === true;
    // r5 rev1: a hosted deployment always supplies its namespace; it never
    // defaults to the platform form. Refused here rather than after defaulting,
    // because an absent namespace and the reserved one are different mistakes.
    if (this.hosted && !props.namespace) {
      throw new Error(
        "AppTheoryNamingContext requires a namespace for a hosted deployment; a hosted deployment never defaults to the platform namespace",
      );
    }
    this.namespace = props.namespace ?? "theorycloud";
    this.app = props.app;
    this.stage = props.stage;
    this.account = props.account;
    this.region = props.region;
    this.pins = { ...(props.pins ?? {}) };
    this.generated = [...(props.generated ?? [])];
    this.namingProfile = props.namingProfile ?? AppTheoryNamingProfile.DERIVED;
    this.loggingProfile = props.loggingProfile ?? AppTheoryLoggingProfile.LEGACY;
    this.retentionDays = props.retentionDays ?? 30;

    AppTheoryResourceNaming.validateContext(this.values());

    if (!ACCEPTED_RETENTION_DAYS.includes(this.retentionDays)) {
      throw new Error(
        `AppTheoryNamingContext retentionDays must be one of ${ACCEPTED_RETENTION_DAYS.join(", ")}; CloudWatch Logs rejects other values`,
      );
    }

    this.node.addValidation({
      validate: () => {
        const orphans = [...new Set([...Object.keys(this.pins), ...this.generated])].filter(
          (key) => !this.consumed.has(key),
        );
        const errors: string[] = [];
        if (orphans.length > 0) {
          errors.push(
            `AppTheoryNamingContext naming entries match no resource in the stack: ${orphans.join(", ")}; remove them or pass the matching logical name to the construct that owns the resource`,
          );
        }

        const declaredOnce = new Set<string>();
        const declarations = this.declared
          .map((entry) => {
            const resource = this.cloudFormationResource(entry);
            const owner = Stack.of(resource);
            const logicalId = String(owner.resolve(resource.logicalId));
            return {
              owner,
              // A CloudFormation logical id is unique only inside one template,
              // so the comparison runs on an identity that is unique across the
              // whole context: the owning stack's construct path and the
              // template-local logical id (SANITY-AT-N3-05). The artifact row
              // keeps the template-local id, which is what the installer joins
              // on.
              identity: `${owner.node.path}/${logicalId}`,
              input: {
                ...(entry.name !== undefined ? { name: entry.name } : {}),
                type: entry.type,
                logicalId,
                ...(entry.generated ? { generated: true } : {}),
              } as AppTheoryDerivedNameInput,
            };
          })
          // A resource declared twice is one resource: it is admitted, and the
          // artifact lists it once.
          .filter((declaration) => {
            const key = [
              declaration.identity,
              declaration.input.type,
              declaration.input.name ?? "",
              declaration.input.generated === true ? "generated" : "named",
            ].join("\u0000");
            if (declaredOnce.has(key)) return false;
            declaredOnce.add(key);
            return true;
          });

        let artifact: AppTheoryDerivedName[] = [];
        try {
          artifact = AppTheoryResourceNaming.synthCheck(
            declarations.map((declaration) => ({ ...declaration.input, logicalId: declaration.identity })),
          );
        } catch (error) {
          errors.push(
            `AppTheoryNamingContext ${String((error as Error).message)}; two different logical resources in one naming context cannot share a physical name in the same scope`,
          );
        }
        if (errors.length > 0) return errors;

        // Every entry is attributable to the stack whose template holds its
        // logical id, so a context shared across stacks emits one document per
        // stack in that stack's own `{stack}.metadata.json` (contract section
        // 11.4). The refusal above still spans the whole context: two stacks in
        // one context that derive the same name in one scope are one collision.
        const byStack = new Map<Stack, AppTheoryDerivedName[]>();
        declarations.forEach((declaration, index) => {
          const rows = byStack.get(declaration.owner) ?? [];
          const row = artifact[index] as AppTheoryDerivedName;
          rows.push({ ...row, logicalId: (declaration.input as AppTheoryDerivedNameInput).logicalId });
          byStack.set(declaration.owner, rows);
        });

        // Scenario 4: every synth with a naming context emits the artifact, so a
        // context whose declarations all attribute to other stacks still leaves
        // an explicit (empty) document on its own stack, and the installer can
        // tell "declares nothing" from "no naming context at all" (scenario 5).
        const ownStack = this.owningStack();
        if (ownStack !== undefined && !byStack.has(ownStack)) {
          byStack.set(ownStack, []);
        }

        for (const [owner, entries] of byStack) {
          const document: AppTheoryDerivedNames = {
            contract: RESOURCE_NAMING_CONTRACT,
            schema: DERIVED_NAMES_SCHEMA,
            context: this.values(),
            entries,
          };
          owner.node.addMetadata(DERIVED_NAMES_METADATA_KEY, JSON.parse(AppTheoryResourceNaming.derivedNamesJson(document)));
        }
        return [];
      },
    });
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
      generated: this.generated,
      hosted: this.hosted,
      namingProfile: this.namingProfile,
      loggingProfile: this.loggingProfile,
      retentionDays: this.retentionDays,
    };
  }

  /**
   * Compose the physical name of one resource under this context.
   */
  public physicalName(resourceType: string, logical: string): AppTheoryPhysicalName {
    const composed = AppTheoryResourceNaming.physicalName(this.values(), resourceType, logical);
    this.consumed.add(`${resourceType}:${logical}`);
    return composed;
  }

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
   *
   * The emitted derived-name artifact carries the hosted names of a hosted
   * context verbatim, because every declaration composes through this context
   * (contract section 11.4, r5). The artifact's `context.namespace` is the
   * tenant namespace for a hosted deployment and `theorycloud` for a platform
   * app, so the reader can tell the two apart; the wire schema is unchanged and
   * a platform app's artifact stays byte-identical.
   */
  public declareName(resourceType: string, logical: string, resource: IConstruct): void {
    this.assertSameStage(resourceType, resource);
    if (resourceType === "log_group") {
      const name = AppTheoryResourceNaming.logGroupName(this.values(), logical);
      this.declared.push({ type: resourceType, logical, name, generated: false, resource });
      return;
    }
    const composed = this.physicalName(resourceType, logical);
    this.declared.push({
      type: resourceType,
      logical,
      ...(composed.generated ? {} : { name: composed.name }),
      generated: composed.generated === true,
      resource,
    });
  }

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
   *
   * A fixed `log_group` name is narrowed further, because a log-group name is
   * either this context's own log source or the Lambda service path and nothing
   * else: the structural check in `validatePhysicalName` cannot know the bound
   * prefix, so the context completes it here (see
   * `assertFixedLogGroupName`).
   */
  public declareFixedName(resourceType: string, name: string, resource: IConstruct): void {
    // A type outside contract section 2 has no stated scope, so it cannot be
    // reserved: declare it and synthesis fails closed.
    AppTheoryResourceNaming.namingScope(resourceType);
    if (Token.isUnresolved(name)) {
      throw new Error(
        `AppTheoryNamingContext cannot declare ${resourceType} because the name is an unresolved token; a name the artifact reserves must be resolvable at synthesis`,
      );
    }
    AppTheoryResourceNaming.validatePhysicalName(resourceType, name);
    this.assertSameStage(resourceType, resource);
    if (resourceType === "log_group") {
      this.assertFixedLogGroupName(name);
    }
    this.declared.push({ type: resourceType, logical: name, name, generated: false, resource });
  }

  /**
   * The CloudFormation resource a declaration names. The construct's default
   * child is the L1 resource a construct creates for itself, so an L2 construct
   * is the expected argument.
   */
  private cloudFormationResource(declaration: AppTheoryNameDeclaration): CfnResource {
    const resource: IConstruct = declaration.resource;
    const candidate: IConstruct | undefined =
      resource instanceof CfnResource ? resource : resource.node.defaultChild;
    if (!(candidate instanceof CfnResource)) {
      throw new Error(
        `AppTheoryNamingContext cannot declare ${declaration.type}:${declaration.logical} because ${resource.node.path} has no CloudFormation resource as its default child; declare the construct that owns the named resource`,
      );
    }
    return candidate;
  }

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
  private assertSameStage(resourceType: string, resource: IConstruct): void {
    const ownerStage = Stage.of(Stack.of(resource));
    const contextStage = Stage.of(this);
    if (ownerStage === contextStage) return;
    // `App` is a `Stage` in CDK, so a construct above the stacks reports the App
    // itself as its Stage; that is the App root, not a Stage the caller named.
    const describe = (stage: Stage | undefined): string =>
      stage === undefined || App.isApp(stage) ? "the App root" : `Stage ${stage.node.path}`;
    throw new Error(
      `AppTheoryNamingContext cannot declare ${resourceType} in ${Stack.of(resource).node.path} because the owning stack is in ${describe(ownerStage)} while the naming context is in ${describe(contextStage)}; a naming context and every stack that declares through it must sit in the same Stage, because each Stage is a separate cloud assembly whose derived-name artifact the synth check cannot compare with another Stage's`,
    );
  }

  /**
   * Admit only the two fixed log-group shapes contract section 3 states for a
   * log group this context owns (SANITY-AT-N3-08, round 4).
   *
   * A log group is either a log source of this context —
   * `theorycloud_{namespace}_{app}_{stage}_{logical}`, built from this
   * context's own namespace, app and stage — or the Lambda service path
   * `/aws/lambda/{function name}`. `validatePhysicalName` already refused every
   * other `/`-bearing shape, but it is structural: it holds no context values,
   * so it admits any `/`-free name, including one that is no log source at all
   * (`orders`) or one shaped for another context
   * (`theorycloud_other_app_lab_x`). Both would enter the artifact as names the
   * installer reserves and this app's logging never writes, so the context
   * completes the rule where the bound prefix is known.
   */
  private assertFixedLogGroupName(name: string): void {
    // The Lambda service path is the one shape that carries a `/`: its function
    // name was already checked against the lambda_function row.
    if (name.startsWith(LAMBDA_LOG_GROUP_LEAD)) return;
    const prefix = this.logSourcePrefix();
    const remainder = name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
    if (remainder !== undefined && LOG_SOURCE_REMAINDER_RE.test(remainder)) return;
    const quoted = JSON.stringify(name);
    throw new Error(
      `AppTheoryNamingContext cannot declare log_group ${quoted} because a fixed log-group name is either this context's section 3 log source, ${JSON.stringify(prefix)} followed by "logs" and the logical source's segments joined with "_", or the Lambda service path ${JSON.stringify(LAMBDA_LOG_GROUP_LEAD)} followed by a name that satisfies the lambda_function row (app ${this.app}, stage ${this.stage}, namespace ${this.namespace}); got ${quoted}`,
    );
  }

  /**
   * The nearest stack above the context, if it has one. A context created above
   * the stacks has none: its artifact then appears on the stacks its
   * declarations attribute to.
   */
  private owningStack(): Stack | undefined {
    let scope: IConstruct | undefined = this;
    while (scope !== undefined) {
      if (Stack.isStack(scope)) return scope;
      scope = scope.node.scope;
    }
    return undefined;
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
