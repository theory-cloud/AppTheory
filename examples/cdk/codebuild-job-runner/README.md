# CodeBuild Job Runner Example

This example demonstrates `AppTheoryCodeBuildJobRunner`, a CodeBuild construct intended for batch steps in import pipelines.

## What it deploys

- A CodeBuild project with an inline buildspec
- An opinionated Jobs table (`AppTheoryJobsTable`)
- Sample resources (S3 bucket + Secrets Manager secret) to demonstrate grant helpers
- An optional EventBridge rule for CodeBuild build state changes

## Commands

```bash
npm install
npm run synth
```

