# CDK Core Patterns

## Pattern: keep compute packaging separate from infra

✅ CORRECT:
- Build your Lambda code into `dist/` (or a dedicated artifact directory).
- Point the construct at the artifact directory (`lambda.Code.fromAsset("dist")`).

❌ INCORRECT:
- Having CDK run `npm install`/`pip install` for your app as part of synth (slow, non-deterministic).

## Pattern: proxy routing (HTTP APIs)

✅ CORRECT: for typical REST-style apps, configure a single Lambda handler behind proxy routes (`/` and `/{proxy+}`) and route inside AppTheory.

## Pattern: enable streaming intentionally

Streaming behavior depends on the AWS integration and infra configuration. Prefer constructs that expose streaming configuration explicitly, and test behavior via contract fixtures/examples.

