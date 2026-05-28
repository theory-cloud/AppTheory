---
title: Event Shape Dispatch
description: How HandleLambda detects each AWS event shape and dispatches to the right adapter.
---

# Event Shape Dispatch

`HandleLambda` is the single Lambda entrypoint for AppTheory. It inspects the incoming event, classifies it by shape, and dispatches to the right adapter. The same handler code in all three runtimes makes the same decisions — pinned by contract fixtures.

## The dispatcher

```go
func handler(ctx context.Context, event json.RawMessage) (any, error) {
    return app.HandleLambda(ctx, event)
}
```

```ts
export const handler = async (event: unknown, ctx: unknown) =>
  app.handleLambda(event, ctx);
```

```python
def handler(event, ctx):
    return app.handle_lambda(event, ctx)
```

You do not import a different entrypoint for SQS vs HTTP vs MCP. The runtime does the dispatch.

## Detection table

| Event shape | Detection heuristic | Dispatched to |
| --- | --- | --- |
| SQS | `Records[0].eventSource == "aws:sqs"` | `ServeSQS` / `serveSQSEvent` / `serve_sqs` |
| DynamoDB Streams | `Records[0].eventSource == "aws:dynamodb"` | `ServeDynamoDBStream` / `serveDynamoDBStream` / `serve_dynamodb_stream` |
| Kinesis | `Records[0].eventSource == "aws:kinesis"` | `ServeKinesis` / `serveKinesisEvent` / `serve_kinesis` |
| SNS | `Records[0].Sns` or `EventSource == "aws:sns"` | `ServeSNS` / `serveSNSEvent` / `serve_sns` |
| EventBridge | top-level `detail-type` or `detailType` | `ServeEventBridge` / `serveEventBridge` / `serve_eventbridge` |
| AppSync resolver | `info.fieldName` + `info.parentTypeName` + `arguments` | `ServeAppSync` / `serveAppSync` / `serve_appsync` |
| WebSocket (APIGW v2) | `requestContext.connectionId` | `ServeWebSocket` / `serveWebSocket` / `serve_websocket` |
| API Gateway v2 (HTTP API) | `requestContext.http` + `routeKey` | `ServeAPIGatewayV2` / `serveAPIGatewayV2` / `serve_apigw_v2` |
| Lambda Function URL | `requestContext.http` + no `routeKey` | `ServeLambdaFunctionURL` / `serveLambdaFunctionURL` / `serve_lambda_function_url` |
| ALB target group | `requestContext.elb.targetGroupArn` | `ServeALB` / `serveALB` / `serve_alb` |
| API Gateway v1 (REST proxy) | `httpMethod` (top-level) | `ServeAPIGatewayProxy` / `serveAPIGatewayProxy` / `serve_apigw_proxy` |

## Detection rules

- **Exact field casing matters.** `detail-type` (hyphen) and `detailType` (camel) both detect EventBridge, but only those two. Variants do not.
- **Detection is positive.** If no heuristic matches, the dispatcher fails closed — it does not guess.
- **Order is deterministic.** The runtime evaluates heuristics in a fixed order; ambiguous events resolve identically across languages.

## Fail-closed behavior

Unknown event shapes return an error. There is no "default to HTTP" fallback. If you see an unknown-shape failure, the right answer is one of:

1. The event has the right shape but a fixture-pinned field is missing — fix the upstream producer.
2. The event is a new AWS shape AppTheory doesn't yet detect — add the heuristic + a fixture and converge all three runtimes.
3. You're invoking AppTheory with a non-AWS event — wrap it in a deterministic event builder from the testkit, or use a dedicated entrypoint.

## Deterministic event builders

Use the testkit builders in unit tests rather than hand-rolling event JSON — they produce identical shapes across languages and are guaranteed to satisfy the dispatcher's detection rules.

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| API Gateway v2 | `testkit.APIGatewayV2Request(...)` | `buildAPIGatewayV2Request(...)` | `build_apigw_v2_request(...)` |
| Lambda Function URL | `testkit.LambdaFunctionURLRequest(...)` | `buildLambdaFunctionURLRequest(...)` | `build_lambda_function_url_request(...)` |
| AppSync resolver | `testkit.AppSyncEvent(...)` | `buildAppSyncEvent(...)` | `build_appsync_event(...)` |
| Kinesis | `testkit.KinesisEvent(...)` | `buildKinesisEvent(...)` | `build_kinesis_event(...)` |
| CloudWatch Logs subscription | `testkit.KinesisCloudWatchLogsSubscriptionRecord(...)` | `kinesisCloudWatchLogsSubscriptionRecord(...)` | `kinesis_cloudwatch_logs_subscription_record(...)` |

## AppSync request adaptation

When an AppSync resolver event is detected, the dispatcher synthesizes an HTTP request from it before invoking the registered handler:

| GraphQL operation | Synthesized HTTP |
| --- | --- |
| `Mutation` | `POST /{fieldName}` |
| `Query` | `GET /{fieldName}` |
| `Subscription` | `GET /{fieldName}` |

- Top-level `arguments` become the JSON request body.
- `request.headers` from the resolver event are forwarded.
- `content-type: application/json` is synthesized when absent.

Response projection:

| Handler returns | AppSync receives |
| --- | --- |
| JSON body | Native resolver payload |
| Empty body | `null` |
| Non-empty non-JSON body | UTF-8 string |
| Binary or streaming body | **Fail closed** with deterministic AppSync system error |

## Partial-batch responses

SQS, DynamoDB Streams, and Kinesis use the standard AWS Lambda partial-batch failure protocol. Handler failures are returned by record identifier; successful records are omitted from the failure list.

- SQS: by `messageId`
- DynamoDB Streams: by `eventID`
- Kinesis: by `eventID` (failures only; successes are omitted)

For Kinesis specifically, **unregistered stream names fail closed** by returning every record ID as a failure. There is no "default stream handler."

## Related

- [HTTP Runtime](../features/http-runtime.md) — the HTTP side of the dispatcher
- [Event Workloads](../features/event-workloads.md) — SQS/EventBridge/DynamoDB/Kinesis details
- [MCP Method Surface](../integrations/mcp.md) — how MCP rides over HTTP
- [Contract Fixtures](contract-fixtures.md) — the dispatch fixtures
