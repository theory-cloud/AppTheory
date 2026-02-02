# REST API v1 Router Example

This example demonstrates the `AppTheoryRestApiRouter` construct for multi-Lambda routing with SSE streaming support.

## Features Demonstrated

- **Multi-Lambda routing**: Different Lambda functions handling different routes
- **SSE streaming**: Response streaming with proper URI/timeout configuration
- **Stage controls**: Access logging, metrics, and throttling
- **Path-based routing**: GraphQL, SSE, inventory, and catch-all proxy routes

## Structure

```
restv1-router/
├── bin/
│   └── app.ts           # CDK app entry point
├── lib/
│   └── restv1-stack.ts  # Stack definition
├── handlers/
│   ├── sse.mjs          # SSE streaming handler
│   ├── graphql.mjs      # GraphQL handler
│   ├── api.mjs          # General API handler
│   └── inventory.mjs    # Inventory handler
├── cdk.json
├── package.json
└── tsconfig.json
```

## Deploy

```bash
npm install
npx cdk deploy
```

## Test SSE Endpoint

```bash
curl -N https://<api-id>.execute-api.<region>.amazonaws.com/prod/sse
```

## Acceptance Criteria

This example proves:

1. ✅ SSE paths → `sse` Lambda with streaming enabled
2. ✅ `/api/graphql` → `graphql` Lambda
3. ✅ `/{proxy+}` → `api` Lambda (catch-all)
4. ✅ `/inventory/{id}` → `inventory` Lambda (inventory-driven path)
5. ✅ Streaming routes synthesize with `STREAM` + `/response-streaming-invocations` + `900000`
