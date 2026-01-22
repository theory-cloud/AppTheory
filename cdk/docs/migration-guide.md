# CDK Migration Guide

AppTheory CDK is designed for “easy migration” from ad-hoc stacks to consistent, reusable constructs.

✅ CORRECT migration order:
1. Replace raw `lambda.Function` defaults with `AppTheoryFunction` (if applicable).
2. Replace hand-rolled API Gateway wiring with `AppTheoryHttpApi`/`AppTheoryRestApi`.
3. Add alarms and security defaults via the provided helper constructs.
4. Verify with `./scripts/verify-cdk-synth.sh`.

