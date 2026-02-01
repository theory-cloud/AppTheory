# REST API v1 Router + Streaming Guide

This guide covers the `AppTheoryRestApiRouter` construct, which provides multi-Lambda routing with full response streaming parity for API Gateway REST API v1.

## Overview

`AppTheoryRestApiRouter` addresses gaps in the simpler `AppTheoryRestApi` construct by supporting:

- **Multi-Lambda routing**: Attach different Lambda functions to different routes
- **Complete streaming parity**: Proper response streaming integration with the correct URI suffix, timeout, and response transfer mode
- **Stage controls**: Access logging, detailed metrics, throttling, and CORS
- **Custom domain wiring**: Optional Route53 A record creation

## When to Use

Use `AppTheoryRestApiRouter` when you need:

1. Multiple Lambda functions handling different routes on the same API
2. Server-Sent Events (SSE) or response streaming
3. Fine-grained stage configuration (logging, metrics, throttling)
4. Custom domain with automatic DNS setup

Use the simpler `AppTheoryRestApi` when you have a single Lambda handling all routes via proxy integration.

## Streaming Enablement

### What Makes Streaming Work

When `streaming: true` is set on a route, the construct ensures:

1. **ResponseTransferMode = STREAM**: Enables chunked transfer encoding
2. **Streaming URI suffix**: The Lambda invocation URI uses `/response-streaming-invocations` (not the standard `/invocations`)
3. **15-minute timeout**: Integration timeout is set to 900,000ms (the maximum for streaming)

These are applied via L1 CFN overrides to ensure full compatibility with Lambda response streaming.

### Example: SSE Route

```typescript
import { AppTheoryRestApiRouter } from "@theory-cloud/apptheory-cdk";

const router = new AppTheoryRestApiRouter(this, "Router", {
  apiName: "my-streaming-api",
  stage: {
    stageName: "prod",
    accessLogging: true,
    detailedMetrics: true,
  },
});

// SSE streaming route
router.addLambdaIntegration("/sse", ["GET"], sseFn, { streaming: true });

// Standard routes
router.addLambdaIntegration("/api/graphql", ["POST"], graphqlFn);
router.addLambdaIntegration("/{proxy+}", ["ANY"], apiFn);
```

## Stage Settings for SSE

For SSE (Server-Sent Events), recommended stage settings include:

```typescript
const router = new AppTheoryRestApiRouter(this, "Router", {
  apiName: "sse-enabled-api",
  stage: {
    stageName: "prod",
    accessLogging: true,                    // Enable CloudWatch access logs
    accessLogRetention: RetentionDays.ONE_MONTH,
    detailedMetrics: true,                  // Per-method metrics
    throttlingRateLimit: 1000,              // Requests per second
    throttlingBurstLimit: 2000,             // Burst capacity
  },
});
```

### Access Logging

Access logging can be configured in two ways:

1. **Boolean `true`**: Auto-creates a log group with configurable retention
2. **LogGroup instance**: Use your own log group for custom configuration

```typescript
// Auto-created log group
stage: { accessLogging: true, accessLogRetention: RetentionDays.ONE_WEEK }

// Custom log group
const logGroup = new logs.LogGroup(this, "Logs", { ... });
stage: { accessLogging: logGroup }
```

## Domain Wiring

### With Route53

```typescript
const zone = route53.HostedZone.fromLookup(this, "Zone", { 
  domainName: "example.com" 
});

const cert = new AppTheoryCertificate(this, "Cert", {
  domainName: "api.example.com",
  hostedZone: zone,
});

const router = new AppTheoryRestApiRouter(this, "Router", {
  apiName: "my-api",
  domain: {
    domainName: "api.example.com",
    certificate: cert.certificate,
    hostedZone: zone,   // Creates Route53 A record automatically
  },
});
```

### With Certificate ARN (no Route53)

```typescript
const router = new AppTheoryRestApiRouter(this, "Router", {
  apiName: "my-api",
  domain: {
    domainName: "api.example.com",
    certificateArn: "arn:aws:acm:us-east-1:123456789:certificate/abc-123",
    // No hostedZone = no Route53 record created
  },
});
```

## CORS Configuration

Enable CORS with sensible defaults:

```typescript
const router = new AppTheoryRestApiRouter(this, "Router", {
  apiName: "cors-enabled-api",
  cors: true,  // Sensible defaults
});
```

Or provide custom CORS options:

```typescript
const router = new AppTheoryRestApiRouter(this, "Router", {
  apiName: "cors-custom-api",
  cors: {
    allowOrigins: ["https://app.example.com"],
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowCredentials: true,
    maxAge: Duration.hours(1),
  },
});
```

## Multi-Lambda Acceptance Criteria

Per the roadmap (M1), a single REST API v1 must support:

| Path | Handler | Streaming |
|------|---------|-----------|
| `/sse` | `sse` Lambda | ✅ Yes |
| `/api/graphql` | `graphql` Lambda | ❌ No |
| `/{proxy+}` | `api` Lambda | ❌ No |
| `/inventory/{id}` | `inventory` Lambda | ❌ No |

```typescript
// Example matching acceptance criteria
const router = new AppTheoryRestApiRouter(this, "Router", {
  apiName: "lesser-parity-api",
});

router.addLambdaIntegration("/sse", ["GET"], sseFn, { streaming: true });
router.addLambdaIntegration("/api/graphql", ["POST"], graphqlFn);
router.addLambdaIntegration("/{proxy+}", ["ANY"], apiFn);
router.addLambdaIntegration("/inventory/{id}", ["GET", "PUT", "DELETE"], inventoryFn);
```

## Synthesized CloudFormation

Streaming routes synthesize with:

- `Integration.ResponseTransferMode: STREAM`
- `Integration.Uri` ending with `/response-streaming-invocations`
- `Integration.TimeoutInMillis: 900000`

Example synthesized method (streaming):

```json
{
  "Type": "AWS::ApiGateway::Method",
  "Properties": {
    "HttpMethod": "GET",
    "Integration": {
      "ResponseTransferMode": "STREAM",
      "TimeoutInMillis": 900000,
      "Uri": {
        "Fn::Join": ["", [
          "arn:", {"Ref": "AWS::Partition"},
          ":apigateway:", {"Ref": "AWS::Region"},
          ":lambda:path/2021-11-15/functions/",
          {"Fn::GetAtt": ["SseFn", "Arn"]},
          "/response-streaming-invocations"
        ]]
      }
    }
  }
}
```

## Troubleshooting

### Streaming Not Working

1. **Verify Lambda supports streaming**: Lambda must be configured for response streaming
2. **Check timeout**: Ensure the integration timeout is set (defaults to 15min for streaming)
3. **Verify URI suffix**: Synthesized template should show `/response-streaming-invocations`

### 502 Errors on Streaming Routes

- Ensure the Lambda function handler returns a streaming response
- Check Lambda execution role has proper permissions
- Verify the Content-Type header is set correctly (e.g., `text/event-stream` for SSE)

### CORS Preflight Failures

- Ensure `cors: true` or custom CORS options are provided
- Verify the allowed origins include your frontend domain
- Check that OPTIONS methods are synthesized in the template
