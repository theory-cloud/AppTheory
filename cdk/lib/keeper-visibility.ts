import { Annotations, Aspects, IAspect, Lazy, Stack, Token } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct, IConstruct } from "constructs";

import {
  AppTheoryResourceNaming,
  type AppTheoryVisibilityPreview,
  type AppTheoryVisibilityRules,
} from "./naming";
import type { AppTheoryNamingContext } from "./naming-context";

/**
 * The SSM parameter tier of the published visibility manifest.
 */
export enum AppTheoryVisibilityManifestTier {
  /**
   * Standard tier: a 4096-character value limit.
   */
  STANDARD = "standard",

  /**
   * Advanced tier: an 8192-character value limit.
   */
  ADVANCED = "advanced",
}

const MANIFEST_VALUE_LIMIT: { [tier: string]: number } = {
  [AppTheoryVisibilityManifestTier.STANDARD]: 4096,
  [AppTheoryVisibilityManifestTier.ADVANCED]: 8192,
};

/**
 * Properties for an `AppTheoryKeeperVisibility`.
 */
export interface AppTheoryKeeperVisibilityProps {
  /**
   * The naming context. Its app, stage and log-source prefix bind every rule.
   */
  readonly namingContext: AppTheoryNamingContext;

  /**
   * The principal allowed to assume the reader role: Keeper's runtime role ARN.
   */
  readonly readerPrincipalArn: string;

  /**
   * The consumer's include and exclude selectors.
   */
  readonly rules: AppTheoryVisibilityRules;

  /**
   * Explicit logical sources. When omitted the stack's declared log groups are
   * discovered at synthesis.
   * @default undefined
   */
  readonly sources?: string[];

  /**
   * The SSM parameter tier of the manifest.
   * @default AppTheoryVisibilityManifestTier.STANDARD
   */
  readonly manifestTier?: AppTheoryVisibilityManifestTier;
}

/**
 * The reader role, compiled policy and manifest a consumer shares with Keeper.
 *
 * Create this construct only when the consumer passes a reader principal and
 * rules; with no visibility block no role, policy or manifest is created.
 */
export class AppTheoryKeeperVisibility extends Construct {
  /**
   * The reader role Keeper assumes.
   */
  public readonly readerRole: iam.Role;

  /**
   * The SSM parameter holding the manifest.
   */
  public readonly manifestParameter: ssm.StringParameter;

  private readonly previewProvider: () => AppTheoryVisibilityPreview;

  constructor(scope: Construct, id: string, props: AppTheoryKeeperVisibilityProps) {
    super(scope, id);

    const context = props.namingContext;
    const rules = props.rules;

    // Validate the selectors and fail synthesis before creating anything.
    AppTheoryResourceNaming.visibilityPreview(context.values(), rules, []);

    const policyJson = AppTheoryResourceNaming.compileVisibilityPolicyJson(context.values(), rules);
    const document = iam.PolicyDocument.fromJson(JSON.parse(policyJson) as { [key: string]: unknown });
    const readerAccount = readerAccountFromArn(props.readerPrincipalArn);

    this.readerRole = new iam.Role(this, "ReaderRole", {
      roleName: context.physicalName("iam_role", "keeper-reader").name,
      // r3 (contract section 6): name the reader's account as the principal and
      // restrict it with `aws:PrincipalArn`. AWS rewrites a role ARN in a trust
      // Principal to the role's unique ID, so a direct role-ARN principal breaks
      // when Keeper deletes and recreates its role. The condition key is not
      // rewritten, so the trust survives that cycle and deploys before Keeper's
      // role exists.
      assumedBy: new ReaderRolePrincipal(readerAccount, props.readerPrincipalArn),
      description: `Keeper reader role for ${context.app}/${context.stage}`,
      inlinePolicies: { Visibility: document },
    });
    // Contract section 11.4: declare the resource carrying the composed name.
    context.declareName("iam_role", "keeper-reader", this.readerRole);

    const memo: { preview?: AppTheoryVisibilityPreview } = {};
    this.previewProvider = () => {
      if (!memo.preview) {
        const sources = props.sources ?? discoverSources(this, context);
        memo.preview = AppTheoryResourceNaming.visibilityPreview(context.values(), rules, sources);
      }
      return memo.preview;
    };

    Aspects.of(Stack.of(this)).add(
      new VisibilityPreviewAnnotation(this, () => {
        const preview = this.previewProvider();
        return [
          `AppTheory keeper visibility preview for ${context.app}/${context.stage}:`,
          JSON.stringify({
            rule_version: preview.ruleVersion,
            matched_now: preview.matchedNow,
            not_matched_now: preview.notMatchedNow,
            future: { include: preview.future.include ?? [], exclude: preview.future.exclude ?? [] },
          }),
        ].join(" ");
      }),
    );

    const tier = props.manifestTier ?? AppTheoryVisibilityManifestTier.STANDARD;
    const limit = MANIFEST_VALUE_LIMIT[tier];
    const parameterName = manifestParameterName(context);
    this.manifestParameter = new ssm.StringParameter(this, "ManifestParameter", {
      parameterName,
      tier: tier === AppTheoryVisibilityManifestTier.ADVANCED ? ssm.ParameterTier.ADVANCED : ssm.ParameterTier.STANDARD,
      stringValue: Lazy.string({
        produce: () => {
          const preview = this.previewProvider();
          const json = AppTheoryResourceNaming.manifestJson({
            ruleVersion: preview.ruleVersion,
            matchedNow: preview.matchedNow,
            future: preview.future,
          });
          if (json.length > limit) {
            throw new Error(
              `AppTheoryKeeperVisibility manifest is ${json.length} characters, over the ${tier} SSM parameter value limit of ${limit}; reduce the rule set or use the advanced tier`,
            );
          }
          return json;
        },
      }),
    });
    // Contract section 11.4: the manifest parameter's name is the fixed section
    // 6 path, not a derived one, so it declares through the fixed-name path and
    // the artifact carries it. Two visibility constructs in one context would
    // otherwise contend for one parameter with no synth-time sign.
    context.declareFixedName("ssm_parameter", parameterName, this.manifestParameter);
  }

  /**
   * The synth-time preview, including the sources the rules do not match yet.
   */
  public preview(): AppTheoryVisibilityPreview {
    return this.previewProvider();
  }
}

/**
 * Render the visibility preview as a concrete info annotation once the
 * construct tree is complete. Annotations are not resolved like template
 * tokens, so a `Lazy.string` prints `${Token[...]}`. The aspect computes the
 * preview at synthesis and adds the rendered text instead.
 */
class VisibilityPreviewAnnotation implements IAspect {
  private emitted = false;

  constructor(private readonly owner: Construct, private readonly render: () => string) {}

  public visit(_node: IConstruct): void {
    if (this.emitted) return;
    this.emitted = true;
    Annotations.of(this.owner).addInfo(this.render());
  }
}

/**
 * The reader-role trust principal: the reader account as `Principal`, restricted
 * with an `aws:PrincipalArn` condition on Keeper's role ARN. Naming the account
 * rather than the role ARN keeps the trust valid across a delete-and-recreate of
 * Keeper's role, because AWS converts a role ARN in a trust `Principal` to the
 * role's unique ID but does not convert condition-key ARNs.
 */
class ReaderRolePrincipal implements iam.IAssumeRolePrincipal {
  public readonly grantPrincipal: iam.IPrincipal = this;
  public readonly assumeRoleAction = "sts:AssumeRole";
  public readonly principalAccount: string;
  private readonly delegate: iam.ArnPrincipal;

  constructor(account: string, private readonly principalArn: string) {
    this.principalAccount = account;
    // The literal `arn:aws:iam::{account}:root` matches the contract's
    // `Principal: {"AWS": ...}` shape rather than a partition token.
    this.delegate = new iam.ArnPrincipal(`arn:aws:iam::${account}:root`);
  }

  public get policyFragment(): iam.PrincipalPolicyFragment {
    return this.delegate.policyFragment;
  }

  public addToPolicy(statement: iam.PolicyStatement): boolean {
    return this.delegate.addToPolicy(statement);
  }

  public addToPrincipalPolicy(statement: iam.PolicyStatement): iam.AddToPrincipalPolicyResult {
    return this.delegate.addToPrincipalPolicy(statement);
  }

  public addToAssumeRolePolicy(document: iam.PolicyDocument): void {
    document.addStatements(
      new iam.PolicyStatement({
        actions: [this.assumeRoleAction],
        principals: [this.delegate],
        conditions: { ArnEquals: { "aws:PrincipalArn": this.principalArn } },
      }),
    );
  }
}

const READER_PRINCIPAL_ARN_RE = /^arn:aws:iam::([0-9]{12}):role\/.+$/;

/**
 * Parse the reader account from Keeper's runtime role ARN. The trust policy
 * needs the account as its principal, and an unresolved token or a malformed
 * ARN cannot be validated at synthesis.
 */
function readerAccountFromArn(arn: string): string {
  if (Token.isUnresolved(arn)) {
    throw new Error(
      "AppTheoryKeeperVisibility requires a resolved readerPrincipalArn; the reader account is parsed from it and an unresolved token cannot be validated at synthesis",
    );
  }
  // The reader trust restricts the account principal with `ArnEquals` on
  // `aws:PrincipalArn`; `ArnEquals` matches `*` and `?`, so a wildcard would
  // admit every role the pattern matches (FAC-1312-R1-1).
  if (arn.includes("*") || arn.includes("?")) {
    throw new Error(
      `AppTheoryKeeperVisibility readerPrincipalArn must not contain a wildcard (got ${JSON.stringify(arn)}); the reader trust uses ArnEquals on aws:PrincipalArn, which matches wildcards and would admit every role the pattern matches`,
    );
  }
  const match = READER_PRINCIPAL_ARN_RE.exec(arn);
  if (!match) {
    throw new Error(
      `AppTheoryKeeperVisibility readerPrincipalArn must be an arn:aws:iam::<12 digits>:role/... ARN (got ${JSON.stringify(arn)})`,
    );
  }
  return match[1];
}

/**
 * The contract's manifest parameter name.
 */
function manifestParameterName(context: AppTheoryNamingContext): string {
  return `/theorycloud/visibility/${context.app}/${context.stage}/manifest`;
}

/**
 * Discover the logical sources of the log groups this stack declares under the
 * app's bound prefix, excluding other apps' and lookalike groups.
 */
function discoverSources(scope: Construct, context: AppTheoryNamingContext): string[] {
  const prefix = context.logSourcePrefix();
  const sources = new Set<string>();
  for (const node of Stack.of(scope).node.findAll()) {
    // Read the L1 property: the L2 getter returns a token even for a concrete
    // name, because it resolves the physical name during synthesis.
    if (!(node instanceof logs.CfnLogGroup)) continue;
    const name = node.logGroupName;
    if (typeof name !== "string" || Token.isUnresolved(name) || !name.startsWith(prefix)) continue;
    sources.add(name.slice(prefix.length).replace(/_/g, "/"));
  }
  return [...sources].sort();
}
