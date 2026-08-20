import { Aws, CfnParameter, CfnRule, Fn } from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * Governed CloudFormation install-parameter contract for a Theory Cloud namespace.
 *
 * The construct keeps templates account-agnostic: every per-install identity
 * value enters through one of the ten required stack parameters and is exposed
 * as a string token for consuming constructs. Parameter patterns and allowed
 * values are evaluated by CloudFormation, not duplicated as synthesis-time
 * validation.
 *
 * CloudFormation Rules cannot use `Fn::Join`, so this construct cannot assert
 * that `DnsHost` equals
 * `cloud-keeper.<NamespaceSlug>.theorycloud.app`. The governed install-profile
 * validator owns that relational check; the `DnsHost` parameter pattern still
 * enforces the `theorycloud.app` suffix during stack evaluation.
 */
export class AppTheoryInstallParameters extends Construct {
  /** Exact 12-digit namespace AWS account token. */
  public readonly targetAccountId: string;

  /** Theory Cloud namespace slug token. */
  public readonly namespaceSlug: string;

  /** Installed AWS account class token. */
  public readonly accountClass: string;

  /** Target Theory Cloud application identifier token. */
  public readonly targetApplicationId: string;

  /** Autheory tenant identifier token. */
  public readonly tenantId: string;

  /** Exact Cloud Keeper DNS host token. */
  public readonly dnsHost: string;

  /** Namespace install stage token. */
  public readonly stage: string;

  /** Route 53 public hosted-zone identifier token. */
  public readonly publicHostedZoneId: string;

  /** Autheory HTTPS authorization-server origin token. */
  public readonly authorizationServerOrigin: string;

  /** Autheory HTTPS JWKS URL token. */
  public readonly autheoryJwksUrl: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.targetAccountId = this.stringParameter(
      "TargetAccountId",
      "Exact 12-digit namespace AWS account. Required at install; no default.",
      "^[0-9]{12}$",
    ).valueAsString;
    this.namespaceSlug = this.stringParameter(
      "NamespaceSlug",
      "Theory Cloud namespace slug.",
      "^[a-z0-9][a-z0-9-]{1,62}$",
    ).valueAsString;
    this.accountClass = this.stringParameter(
      "AccountClass",
      "Installed AWS account class.",
      undefined,
      ["namespace_dedicated"],
    ).valueAsString;
    this.targetApplicationId = this.stringParameter(
      "TargetApplicationId",
      "Target Theory Cloud application identifier.",
      "^app-[a-z0-9][a-z0-9-]{0,62}$",
    ).valueAsString;
    this.tenantId = this.stringParameter(
      "TenantId",
      "Autheory tenant identifier for the namespace install.",
      "^[A-Za-z0-9_.:-]{3,160}$",
    ).valueAsString;
    this.dnsHost = this.stringParameter(
      "DnsHost",
      "Exact Cloud Keeper DNS host under <namespace_slug>.theorycloud.app.",
      "^[a-z0-9][a-z0-9.-]{2,252}\\.theorycloud\\.app$",
    ).valueAsString;
    this.stage = this.stringParameter(
      "Stage",
      "Namespace install stage.",
      undefined,
      ["lab", "live"],
    ).valueAsString;
    this.publicHostedZoneId = this.stringParameter(
      "PublicHostedZoneId",
      "Exact Route 53 hosted-zone ID for <namespace_slug>.theorycloud.app.",
      "^[A-Z0-9]{8,32}$",
    ).valueAsString;
    this.authorizationServerOrigin = this.stringParameter(
      "AuthorizationServerOrigin",
      "Exact Autheory HTTPS authorization-server origin.",
      "^https://[A-Za-z0-9.-]+$",
    ).valueAsString;
    this.autheoryJwksUrl = this.stringParameter(
      "AutheoryJwksUrl",
      "Exact Autheory HTTPS JWKS URL.",
      "^https://[A-Za-z0-9.-]+/[^?#]+$",
    ).valueAsString;

    const accountRule = new CfnRule(this, "TargetAccountMatchesCaller");
    accountRule.overrideLogicalId("TargetAccountMatchesCaller");
    accountRule.addAssertion(
      Fn.conditionEquals(this.targetAccountId, Aws.ACCOUNT_ID),
      "TargetAccountId must equal the AWS account evaluating this stack",
    );
  }

  private stringParameter(
    id: string,
    description: string,
    allowedPattern?: string,
    allowedValues?: string[],
  ): CfnParameter {
    const parameter = new CfnParameter(this, id, {
      type: "String",
      description,
      allowedPattern,
      allowedValues,
    });
    parameter.overrideLogicalId(id);
    return parameter;
  }
}
