# AppTheory AWS Touchpoints (Inventory)

This document is the inventory for `SR-MOCKS` milestone **K0**.

It lists any **AWS SDK clients AppTheory wraps directly** (per language). Any wrapped client **must** have strict
fakes/mocks shipped in the language testkits.

## AWS SDK clients wrapped by AppTheory

None today.

| Language | Wrapped AWS clients | Notes |
| --- | --- | --- |
| Go | (none) | AppTheory runtime/testkit do not create AWS SDK clients or make network calls. |
| TypeScript | (none) | AppTheory runtime/testkit do not create AWS SDK clients or make network calls. |
| Python | (none) | AppTheory runtime/testkit do not create AWS SDK clients or make network calls. |

## AWS surfaces supported (not SDK clients)

AppTheory targets AWS Lambda HTTP sources as event formats:

- AWS Lambda Function URL
- API Gateway v2 (HTTP API)

These are **event shapes**, not AWS SDK clients.

## User-space AWS clients

All AWS SDK usage (DynamoDB, SQS, SNS, EventBridge, etc.) is currently **user-space**.

If AppTheory starts wrapping any AWS clients in the future (for example, portable rate limiting backed by DynamoDB via
TableTheory), this file must be updated and strict fakes must be added to all testkits.

