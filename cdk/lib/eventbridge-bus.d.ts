import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";
import type { AppTheoryNamingContext } from "./naming-context";
export interface AppTheoryEventBridgeBusProps {
    /**
     * Optional custom event bus name.
     * @default - CloudFormation-generated name
     */
    readonly eventBusName?: string;
    /**
     * Optional event bus description.
     * @default - no description
     */
    readonly description?: string;
    /**
     * Explicit cross-account allowlist for `events:PutEvents`.
     * Partners can be onboarded one account at a time by adding IDs here.
     * @default []
     */
    readonly allowedAccountIds?: string[];
    /**
     * Optional naming context. Under a derived context the bus takes a
     * resource-based policy that admits only the owning account, which is what
     * Security Hub EventBridge.3 asks for.
     *
     * With no context the construct synthesizes exactly as before.
     *
     * @default undefined
     */
    readonly namingContext?: AppTheoryNamingContext;
    /**
     * Whether to attach the owning-account resource policy.
     *
     * Attaching it closes the bus to every principal except the owning account,
     * which preserves today's same-account behaviour while satisfying
     * EventBridge.3. Set false to attach only your own statements.
     *
     * @default true under a derived naming context, otherwise undefined
     */
    readonly owningAccountResourcePolicy?: boolean;
}
/**
 * Opinionated custom EventBridge bus with explicit cross-account publish allowlist.
 */
export declare class AppTheoryEventBridgeBus extends Construct {
    readonly eventBus: events.EventBus;
    readonly policies: events.CfnEventBusPolicy[];
    /**
     * The owning-account resource policy attached under a derived naming context.
     */
    readonly owningAccountPolicy?: events.CfnEventBusPolicy;
    private readonly allowedAccounts;
    constructor(scope: Construct, id: string, props?: AppTheoryEventBridgeBusProps);
    /**
     * Attaches the owning-account resource policy.
     *
     * Security Hub EventBridge.3 requires a custom bus to carry a resource-based
     * policy. The policy grants the owning account `events:*` on this bus, so every
     * same-account principal keeps exactly the access IAM already gives it, and no
     * other account is admitted.
     *
     * Call this at most once. Under a derived naming context the constructor
     * already attaches it, so pass `owningAccountResourcePolicy: false` when you
     * want to choose the moment yourself.
     *
     * @see https://docs.aws.amazon.com/securityhub/latest/userguide/eventbridge-controls.html
     */
    allowOwningAccount(): events.CfnEventBusPolicy;
    /**
     * Adds a single account ID to the cross-account publish allowlist.
     */
    allowAccount(accountId: string): events.CfnEventBusPolicy;
}
