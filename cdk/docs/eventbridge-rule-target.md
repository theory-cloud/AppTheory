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
import { AppTheoryEventBridgeRuleTarget } from "@theory-cloud/apptheory-cdk";
import * as events from "aws-cdk-lib/aws-events";

const bus = new events.EventBus(stack, "Bus");

new AppTheoryEventBridgeRuleTarget(stack, "PartnerEvents", {
  handler: partnerLambda,
  eventBus: bus,
  eventPattern: {
    source: ["com.partner.events"],
  },
});
```

## Related

- `AppTheoryEventBridgeHandler` remains available for schedule-only stacks (back-compat).

