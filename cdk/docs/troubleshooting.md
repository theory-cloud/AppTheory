# CDK Troubleshooting

## Issue: synth fails in CI

**Symptoms:**
- `./scripts/verify-cdk-synth.sh` fails.

**Cause:**
- Breaking change in a construct, missing dependency, or example drift.

**Solution:**
✅ CORRECT:
1. Run the synth verifier locally.
2. Fix the construct/example so synth is deterministic again.

**Verification:**
```bash
./scripts/verify-cdk-synth.sh
make rubric
```

## Issue: Lambda log group already exists during an upgrade

**Symptoms:**
- A stack update that adopts `AppTheoryFunction` explicit log groups fails with `ResourceAlreadyExistsException` for
  `/aws/lambda/<function-name>`.
- The function existed before AppTheory managed its log group, so Lambda auto-created the default group outside the
  CloudFormation stack.

**Cause:**
- CloudFormation cannot create a new `AWS::Logs::LogGroup` resource for a physical log group that already exists but is
  not part of the stack.

**Solution:**
✅ CORRECT:
1. Do not delete or recreate the function to work around the conflict.
2. Adopt the existing log group into the stack before enabling an AppTheory-managed group, or pass an imported
   `logGroup` to `AppTheoryFunction`/`AppTheoryApp`:

   ```ts
   const existingLogGroup = logs.LogGroup.fromLogGroupName(
     this,
     "ExistingFunctionLogGroup",
     "/aws/lambda/existing-handler",
   );

   new AppTheoryFunction(this, "Handler", {
     functionName: "existing-handler",
     runtime: lambda.Runtime.NODEJS_24_X,
     handler: "index.handler",
     code,
     logGroup: existingLogGroup,
   });
   ```

3. For fresh named functions, AppTheory creates the finite-retention log group and binds it through the Lambda L2
   `logGroup` path so the Lambda logging configuration points at the managed group.
4. For anonymous Lambda physical names, provide `logGroup` explicitly when upgrading an existing deployment that may
   already have `/aws/lambda/<generated-name>` in CloudWatch Logs.

🚫 INCORRECT:
- Running ad-hoc AWS CLI deletion during a framework migration without an operator-approved runbook.
- Adding a raw CDK/Lambda workaround that bypasses `AppTheoryFunction`.

**Verification:**
```bash
cd cdk && npm test
./scripts/verify-cdk-synth.sh
```
