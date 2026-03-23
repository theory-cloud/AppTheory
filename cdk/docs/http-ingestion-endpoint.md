# HTTP Ingestion Endpoint

`AppTheoryHttpIngestionEndpoint` provisions an authenticated HTTPS endpoint for server-to-server submissions. It uses an
HTTP API v2 route backed by Lambda and a Lambda request authorizer whose identity source defaults to the
`Authorization` header to mirror the backoffice-api-authorizer pattern.

## Key behavior

- creates a `POST` endpoint for ingestion traffic
- uses a Lambda request authorizer with simple responses
- disables authorizer caching by default (`0s`) to match the upstream secret-key validation pattern
- supports stage throttling and access logging
- supports optional custom domains

## Example

```typescript
import { AppTheoryHttpIngestionEndpoint } from "@theory-cloud/apptheory-cdk";

const endpoint = new AppTheoryHttpIngestionEndpoint(stack, "Endpoint", {
  handler: ingestionLambda,
  authorizer: secretKeyAuthorizerLambda,
  endpointPath: "/evidence",
  stage: {
    throttlingRateLimit: 50,
    throttlingBurstLimit: 100,
  },
});
```

The generated authorizer uses `Authorization` as its identity source by default:

```text
$request.header.Authorization
```

This is an inference from the backoffice-api-authorizer infrastructure, which wires its HTTP API request authorizer to
that same header.

## Validation and throttling

- request authentication happens at the edge through the Lambda request authorizer
- request body/schema validation remains application-specific and should be enforced in the ingestion Lambda
- stage-level throttling is available through `stage.throttlingRateLimit` and `stage.throttlingBurstLimit`

## Related

- `AppTheoryEventBridgeBus` and `AppTheoryEventBridgeRuleTarget` cover the cross-account EventBridge relay path
- `AppTheoryEventBusTable` covers durable storage and replay after ingestion
