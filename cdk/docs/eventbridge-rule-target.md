# EventBridge Rule Target

`AppTheoryEventBridgeRuleTarget` standardizes the common “EventBridge rule → Lambda target” wiring without repeating the `events.Rule` + `targets.LambdaFunction` boilerplate.

## Key behavior

- Exactly one of `schedule` or `eventPattern` is required (fail closed).
- Optional `eventBus` is supported for non-default routing.
- Optional `targetProps` are passed through to `aws-events-targets.LambdaFunction` (DLQ, retries, max event age, etc).

## Schedule example

```typescript
import { AppTheoryEventBridgeRuleTarget } from "@theory-cloud/apptheory-cdk";
import { Duration } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";

new AppTheoryEventBridgeRuleTarget(stack, "NightlyJob", {
  handler: nightlyLambda,
  schedule: events.Schedule.rate(Duration.days(1)),
  ruleName: "nightly-import",
});
```

## Event pattern example

```typescript
import { AppTheoryEventBridgeRuleTarget } from "@theory-cloud/apptheory-cdk";

new AppTheoryEventBridgeRuleTarget(stack, "S3ObjectCreated", {
  handler: ingestLambda,
  eventPattern: {
    source: ["aws.s3"],
  },
});
```

## Custom event bus example

```typescript
import {
  AppTheoryEventBridgeBus,
  AppTheoryEventBridgeRuleTarget,
} from "@theory-cloud/apptheory-cdk";

const bus = new AppTheoryEventBridgeBus(stack, "Bus", {
  eventBusName: "partner-relay",
  allowedAccountIds: ["111111111111"],
});

new AppTheoryEventBridgeRuleTarget(stack, "PartnerEvents", {
  handler: partnerLambda,
  eventBus: bus.eventBus,
  eventPattern: {
    source: ["com.partner.events"],
  },
});
```

## Compliance relay example

This is the receive-side pattern for a cross-account relay bus feeding an ingestion Lambda:

```typescript
import {
  AppTheoryEventBridgeBus,
  AppTheoryEventBridgeRuleTarget,
} from "@theory-cloud/apptheory-cdk";

const relayBus = new AppTheoryEventBridgeBus(stack, "RelayBus", {
  eventBusName: "compliance-advisor-relay",
  allowedAccountIds: ["111111111111"],
});

new AppTheoryEventBridgeRuleTarget(stack, "ComplianceIngress", {
  handler: ingestionLambda,
  eventBus: relayBus.eventBus,
  ruleName: "compliance-beacon-ingress",
  eventPattern: {
    source: ["pay-theory.compliance-beacon"],
    detailType: ["compliance.beacon.submitted"],
  },
});
```

## Related

- `AppTheoryEventBridgeBus` creates the custom bus and cross-account publish allowlist.
- `AppTheoryEventBridgeHandler` remains available for schedule-only stacks (back-compat).
