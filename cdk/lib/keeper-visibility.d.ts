import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { type AppTheoryVisibilityPreview, type AppTheoryVisibilityRules } from "./naming";
import type { AppTheoryNamingContext } from "./naming-context";
/**
 * The SSM parameter tier of the published visibility manifest.
 */
export declare enum AppTheoryVisibilityManifestTier {
    /**
     * Standard tier: a 4096-character value limit.
     */
    STANDARD = "standard",
    /**
     * Advanced tier: an 8192-character value limit.
     */
    ADVANCED = "advanced"
}
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
export declare class AppTheoryKeeperVisibility extends Construct {
    /**
     * The reader role Keeper assumes.
     */
    readonly readerRole: iam.Role;
    /**
     * The SSM parameter holding the manifest.
     */
    readonly manifestParameter: ssm.StringParameter;
    private readonly previewProvider;
    constructor(scope: Construct, id: string, props: AppTheoryKeeperVisibilityProps);
    /**
     * The synth-time preview, including the sources the rules do not match yet.
     */
    preview(): AppTheoryVisibilityPreview;
}
