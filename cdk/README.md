# AppTheory CDK Constructs

TS-first `jsii` constructs for deploying AppTheory apps with consistent defaults across Go/TypeScript/Python.

Status: early; start with a small “top 20%” set and grow based on real usage.

## Constructs

- `AppTheoryHttpApi` — HTTP API (APIGWv2) + Lambda proxy routes (`/` and `/{proxy+}`).
- `AppTheoryFunction` — Lambda wrapper with AppTheory-friendly defaults.
- `AppTheoryFunctionAlarms` — baseline CloudWatch alarms for a Lambda function.
- `AppTheoryQueueProcessor` — SQS queue + consumer wiring.

## Development

```bash
cd cdk
npm ci
npm test
```

