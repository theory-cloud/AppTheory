# EventBridge Bus

`AppTheoryEventBridgeBus` creates a custom EventBridge bus and applies an explicit cross-account `events:PutEvents`
allowlist. This is the AppTheory CDK primitive for partner-account relay patterns where publishers are onboarded one
AWS account at a time.

## Key behavior

- creates a custom EventBridge bus
- applies one resource-policy statement per allowed AWS account ID
- fails closed on invalid or duplicate literal account IDs

## Example

```typescript
import { AppTheoryEventBridgeBus } from "@theory-cloud/apptheory-cdk";

const relayBus = new AppTheoryEventBridgeBus(stack, "RelayBus", {
  eventBusName: "compliance-advisor-relay",
  description: "Beacon relay ingress for compliance-advisor",
  allowedAccountIds: [
    "111111111111",
    "222222222222",
  ],
});
```

## Incremental onboarding

If partners are onboarded after the construct is created, call `allowAccount(...)` to add another explicit publisher:

```typescript
relayBus.allowAccount("333333333333");
```

## Related

- `AppTheoryEventBridgeRuleTarget` attaches Lambda consumers to a custom bus.
