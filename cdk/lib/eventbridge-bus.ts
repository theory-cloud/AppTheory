import { Stack, Token } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";

import type { AppTheoryNamingContext } from "./naming-context";
import { secureDefaults } from "./private/secure-defaults";

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
export class AppTheoryEventBridgeBus extends Construct {
  public readonly eventBus: events.EventBus;
  public readonly policies: events.CfnEventBusPolicy[] = [];

  /**
   * The owning-account resource policy attached under a derived naming context.
   */
  public readonly owningAccountPolicy?: events.CfnEventBusPolicy;

  private readonly allowedAccounts = new Set<string>();

  constructor(scope: Construct, id: string, props: AppTheoryEventBridgeBusProps = {}) {
    super(scope, id);

    this.eventBus = new events.EventBus(this, "Bus", {
      eventBusName: props.eventBusName,
      description: props.description,
    });

    const attachOwningAccountPolicy =
      props.owningAccountResourcePolicy ?? (secureDefaults(props.namingContext) ? true : undefined);
    if (attachOwningAccountPolicy === true) {
      this.allowOwningAccount();
    }

    for (const accountId of props.allowedAccountIds ?? []) {
      this.allowAccount(accountId);
    }
  }

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
  public allowOwningAccount(): events.CfnEventBusPolicy {
    if (this.owningAccountPolicy !== undefined) {
      throw new Error(
        "AppTheoryEventBridgeBus already attaches its owning-account resource policy; pass owningAccountResourcePolicy: false to attach it yourself",
      );
    }
    const stack = Stack.of(this);
    const policy = new events.CfnEventBusPolicy(this, "OwningAccountPolicy", {
      eventBusName: this.eventBus.eventBusName,
      statementId: "AllowOwningAccount",
      statement: {
        Effect: "Allow",
        Action: "events:*",
        Principal: {
          AWS: stack.formatArn({ service: "iam", region: "", account: stack.account, resource: "root" }),
        },
        Resource: this.eventBus.eventBusArn,
      },
    });
    (this as { owningAccountPolicy?: events.CfnEventBusPolicy }).owningAccountPolicy = policy;
    return policy;
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
