# Lambda Role Example

This example demonstrates how to use `AppTheoryLambdaRole` to create Lambda execution roles with various permission configurations.

## What This Creates

1. **Basic Role** - Minimal Lambda execution role with only CloudWatch Logs permissions
2. **Tracing Role** - Lambda role with X-Ray tracing enabled
3. **Encrypted Role** - Lambda role with KMS permissions for environment encryption and application-level data encryption
4. **Custom Role** - Lambda role with custom S3, SSM, and Secrets Manager permissions
5. **Dynamic Role** - Lambda role demonstrating dynamic policy additions

## Prerequisites

- AWS CDK CLI installed (`npm install -g aws-cdk`)
- AWS credentials configured
- Node.js 18+

## Deployment

```bash
# Install dependencies
npm install

# Synthesize CloudFormation template
npm run synth

# Deploy to AWS
npm run deploy
```

## Patterns Demonstrated

### Pattern 1: Basic Role

The simplest Lambda role with just CloudWatch Logs permissions:

```typescript
const basicRole = new AppTheoryLambdaRole(this, 'BasicRole', {
    roleName: 'my-lambda-role',
    description: 'Basic Lambda execution role',
});

new lambda.Function(this, 'MyFunction', {
    // ...
    role: basicRole.role,
});
```

### Pattern 2: X-Ray Tracing

Enable X-Ray for distributed tracing:

```typescript
const tracingRole = new AppTheoryLambdaRole(this, 'TracingRole', {
    enableXRay: true,
    tags: {
        Environment: 'production',
    },
});

new lambda.Function(this, 'TracedFunction', {
    // ...
    role: tracingRole.role,
    tracing: lambda.Tracing.ACTIVE,
});
```

### Pattern 3: KMS Encryption

Grant KMS permissions for encrypted environment variables and application data:

```typescript
const encryptedRole = new AppTheoryLambdaRole(this, 'EncryptedRole', {
    environmentEncryptionKeys: [envKey.key],  // For Lambda env vars
    applicationKmsKeys: [dataKey.key],         // For runtime encrypt/decrypt
});

new lambda.Function(this, 'EncryptedFunction', {
    // ...
    role: encryptedRole.role,
    environmentEncryption: envKey.key,
});
```

### Pattern 4: Custom Permissions

Use `additionalStatements` for arbitrary IAM permissions:

```typescript
const customRole = new AppTheoryLambdaRole(this, 'CustomRole', {
    additionalStatements: [
        new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:PutObject'],
            resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
        }),
        new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: ['arn:aws:ssm:*:*:parameter/app/*'],
        }),
    ],
});
```

### Pattern 5: Dynamic Permissions

Add permissions after role creation:

```typescript
const role = new AppTheoryLambdaRole(this, 'Role');

// Add inline policy
role.addToPolicy(new iam.PolicyStatement({
    actions: ['sqs:SendMessage'],
    resources: ['*'],
}));

// Add managed policy
role.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSQSReadOnlyAccess'),
);
```

## Migration from LiftLambdaRole

If you're migrating from Lift CDK:

```typescript
// Before (Lift CDK)
const role = new LiftLambdaRole(this, 'Role', {
    xrayEnabled: true,
    kmsKeyArn: 'arn:aws:kms:...',
});

// After (AppTheory)
const key = kms.Key.fromKeyArn(this, 'Key', 'arn:aws:kms:...');

const role = new AppTheoryLambdaRole(this, 'Role', {
    enableXRay: true,
    applicationKmsKeys: [key],
});
```

## Cleanup

```bash
# Destroy the stack and all resources
cdk destroy
```

## Notes

- The example uses `RemovalPolicy.DESTROY` for easy cleanup. Use `RETAIN` for production.
- X-Ray tracing adds latency but provides valuable observability. Enable in production.
- Use separate KMS keys for environment encryption vs application data for better security isolation.
- The `additionalStatements` escape hatch should follow least-privilege principles.
