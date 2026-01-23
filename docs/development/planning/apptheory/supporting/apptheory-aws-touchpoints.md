# AppTheory AWS Touchpoints (Inventory)

This document is the inventory for `SR-MOCKS` milestone **K0**.

It lists any **AWS SDK clients AppTheory wraps directly** (per language). Any wrapped client **must** have strict
fakes/mocks shipped in the language testkits.

## AWS SDK clients wrapped by AppTheory

Current (implemented for Lift parity):

- API Gateway Management API (WebSockets): equivalent to Lift `pkg/streamer`
- SNS (error notifications): optional replacement for Lift `observability/zap` SNS alerts

| Language | Wrapped AWS clients | Notes |
| --- | --- | --- |
| Go | `apigatewaymanagementapi` (AWS SDK v2) | Wrapped by `pkg/streamer` with strict fakes in `testkit`. |
| Go | `sns` (AWS SDK v2) | Used by `pkg/observability/zap` for optional error notifications; strict fake exists in `testkit`. |
| TypeScript | HTTP+SigV4 wrapper (no AWS SDK dependency) | `WebSocketManagementClient` signs requests and uses `fetch`; strict fake exists. |
| Python | `boto3.client("apigatewaymanagementapi")` (optional dependency) | `streamer.Client` uses boto3 when installed; strict fake exists. |

## AWS surfaces supported (not SDK clients)

AppTheory targets AWS Lambda HTTP sources as event formats:

- AWS Lambda Function URL
- API Gateway v2 (HTTP API)

These are **event shapes**, not AWS SDK clients.

## User-space AWS clients

All AWS SDK usage (DynamoDB, SQS, SNS, EventBridge, etc.) is **user-space** unless AppTheory explicitly owns a wrapper as
part of Lift parity (notably: WebSocket management API for message delivery).

Data access should use **TableTheory** as the companion framework for AppTheory across Go/TypeScript/Python.

If AppTheory starts wrapping any AWS clients in the future (for example, portable rate limiting backed by DynamoDB via
TableTheory), this file must be updated and strict fakes must be added to all testkits.
