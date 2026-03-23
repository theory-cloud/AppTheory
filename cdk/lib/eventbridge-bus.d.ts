import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";
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
}
/**
 * Opinionated custom EventBridge bus with explicit cross-account publish allowlist.
 */
export declare class AppTheoryEventBridgeBus extends Construct {
    readonly eventBus: events.EventBus;
    readonly policies: events.CfnEventBusPolicy[];
    private readonly allowedAccounts;
    constructor(scope: Construct, id: string, props?: AppTheoryEventBridgeBusProps);
    /**
     * Adds a single account ID to the cross-account publish allowlist.
     */
    allowAccount(accountId: string): events.CfnEventBusPolicy;
}
