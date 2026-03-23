import { Token } from "aws-cdk-lib";
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
export class AppTheoryEventBridgeBus extends Construct {
  public readonly eventBus: events.EventBus;
  public readonly policies: events.CfnEventBusPolicy[] = [];

  private readonly allowedAccounts = new Set<string>();

  constructor(scope: Construct, id: string, props: AppTheoryEventBridgeBusProps = {}) {
    super(scope, id);

    this.eventBus = new events.EventBus(this, "Bus", {
      eventBusName: props.eventBusName,
      description: props.description,
    });

    for (const accountId of props.allowedAccountIds ?? []) {
      this.allowAccount(accountId);
    }
  }

  /**
   * Adds a single account ID to the cross-account publish allowlist.
   */
  public allowAccount(accountId: string): events.CfnEventBusPolicy {
    const normalized = normalizeAccountId(accountId);
    validateAccountId(normalized);

    if (this.allowedAccounts.has(normalized)) {
      throw new Error(`AppTheoryEventBridgeBus: duplicate allowed account ID ${normalized}`);
    }

    const index = this.policies.length + 1;
    const policy = new events.CfnEventBusPolicy(this, `AllowAccount${index}`, {
      eventBusName: this.eventBus.eventBusName,
      statementId: `AllowPutEvents${index}`,
      statement: {
        Effect: "Allow",
        Action: "events:PutEvents",
        Principal: { AWS: normalized },
        Resource: this.eventBus.eventBusArn,
      },
    });

    this.allowedAccounts.add(normalized);
    this.policies.push(policy);
    return policy;
  }
}

function normalizeAccountId(raw: string): string {
  return String(raw ?? "").trim();
}

function validateAccountId(accountId: string): void {
  if (!accountId) {
    throw new Error("AppTheoryEventBridgeBus: allowedAccountIds cannot contain empty values");
  }
  if (Token.isUnresolved(accountId)) {
    return;
  }
  if (!/^\d{12}$/.test(accountId)) {
    throw new Error("AppTheoryEventBridgeBus: allowedAccountIds must be 12-digit AWS account IDs");
  }
}
