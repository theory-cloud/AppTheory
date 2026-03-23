# EventBus Table

`AppTheoryEventBusTable` provisions the DynamoDB schema required by AppTheory's durable EventBus runtime and now includes
a `bind(...)` helper so Lambda publishers and replay/query workers receive the right permissions plus a stable table-name
environment variable.

## Key behavior

- creates the AppTheory EventBus table schema (`pk` / `sk`)
- creates the required GSIs:
  - `event-id-index`
  - `tenant-timestamp-index`
- enables DynamoDB-backed durability with TTL and point-in-time recovery defaults
- binds Lambda functions for publish/query/replay flows

## CDK example

```typescript
import { AppTheoryEventBusTable } from "@theory-cloud/apptheory-cdk";

const table = new AppTheoryEventBusTable(stack, "Events", {
  tableName: "apptheory-events",
});

table.bind(ingestionLambda);
table.bind(replayLambda, {
  readOnly: true,
  envVarName: "COMPLIANCE_REPLAY_TABLE",
});
```

`bind(...)` sets `APPTHEORY_EVENTBUS_TABLE_NAME` by default and grants `readWrite` access unless `readOnly: true` is
requested for replay/query workers.

## Retention and replay

Infrastructure provides the durable table; runtime code configures retention and replay behavior:

```go
bus := services.NewDynamoDBEventBus(db, services.EventBusConfig{
  TableName: os.Getenv("APPTHEORY_EVENTBUS_TABLE_NAME"),
  TTL:       30 * 24 * time.Hour,
})

events, err := bus.Query(ctx, &services.EventQuery{
  TenantID:  "merchant_123",
  EventType: "compliance.beacon",
  Limit:     100,
})
```

- retention is controlled by `services.EventBusConfig.TTL`
- replay workers use `Query(...)` and `GetEvent(...)` to reprocess missed or failed events
- DynamoDB point-in-time recovery remains enabled by default for operational recovery

## Related

- `AppTheoryEventBridgeBus` handles cross-account ingress
- `AppTheoryEventBridgeRuleTarget` routes relay events to ingestion handlers
