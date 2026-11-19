import { Annotations, Lazy, Stack, Token } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

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

    this.readerRole = new iam.Role(this, "ReaderRole", {
      roleName: context.physicalName("iam_role", "keeper-reader").name,
      assumedBy: new iam.ArnPrincipal(props.readerPrincipalArn),
      description: `Keeper reader role for ${context.app}/${context.stage}`,
      inlinePolicies: { Visibility: document },
    });

    const memo: { preview?: AppTheoryVisibilityPreview } = {};
    this.previewProvider = () => {
      if (!memo.preview) {
        const sources = props.sources ?? discoverSources(this, context);
        memo.preview = AppTheoryResourceNaming.visibilityPreview(context.values(), rules, sources);
      }
      return memo.preview;
    };

    Annotations.of(this).addInfo(
      Lazy.string({
        produce: () => {
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
        },
      }),
    );

    const tier = props.manifestTier ?? AppTheoryVisibilityManifestTier.STANDARD;
    const limit = MANIFEST_VALUE_LIMIT[tier];
    this.manifestParameter = new ssm.StringParameter(this, "ManifestParameter", {
      parameterName: manifestParameterName(context),
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
  }

  /**
   * The synth-time preview, including the sources the rules do not match yet.
   */
  public preview(): AppTheoryVisibilityPreview {
    return this.previewProvider();
  }
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
