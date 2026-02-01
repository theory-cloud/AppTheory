# AppTheoryLambdaRole

The `AppTheoryLambdaRole` construct creates an IAM execution role optimized for AWS Lambda functions. It provides baseline Lambda execution permissions with optional enhancements for X-Ray tracing, KMS encryption, and custom policy statements.

This construct is designed as a replacement for `LiftLambdaRole` usage in projects migrating from Lift CDK to AppTheory.

## Features

- **Baseline Lambda Execution**: Automatically attaches `AWSLambdaBasicExecutionRole` managed policy for CloudWatch Logs permissions
- **Optional X-Ray Tracing**: Easily enable X-Ray tracing with the `AWSXRayDaemonWriteAccess` managed policy
- **Environment Variable Encryption**: Grant KMS decrypt permissions for encrypted Lambda environment variables
- **Application-Level KMS**: Grant encrypt/decrypt permissions for runtime data encryption
- **Escape Hatch**: Add arbitrary IAM policy statements for custom permissions
- **Tagging**: Consistent tagging with AppTheory framework tags and custom tags

## Basic Usage

```typescript
import { AppTheoryLambdaRole } from '@theory-cloud/apptheory-cdk';

// Basic role with just CloudWatch Logs permissions
const basicRole = new AppTheoryLambdaRole(this, 'BasicRole', {
  roleName: 'my-lambda-role',
  description: 'Basic Lambda execution role',
});

// Use with a Lambda function
new lambda.Function(this, 'MyFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
  role: basicRole.role,
});
```

## X-Ray Tracing

Enable X-Ray tracing by setting `enableXRay: true`:

```typescript
const tracingRole = new AppTheoryLambdaRole(this, 'TracingRole', {
  enableXRay: true,
});

new lambda.Function(this, 'TracedFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
  role: tracingRole.role,
  tracing: lambda.Tracing.ACTIVE,
});
```

## KMS Encryption

### Environment Variable Encryption

For Lambda functions with encrypted environment variables, grant the role permission to decrypt:

```typescript
import { AppTheoryKmsKey, AppTheoryLambdaRole } from '@theory-cloud/apptheory-cdk';

const envKey = new AppTheoryKmsKey(this, 'EnvKey', {
  description: 'Key for Lambda environment encryption',
});

const role = new AppTheoryLambdaRole(this, 'Role', {
  environmentEncryptionKeys: [envKey.key],
});

new lambda.Function(this, 'Function', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
  role: role.role,
  environmentEncryption: envKey.key,
  environment: {
    API_KEY: 'secret-value',
  },
});
```

### Application-Level Encryption

For Lambda functions that need to encrypt/decrypt data at runtime:

```typescript
const dataKey = new AppTheoryKmsKey(this, 'DataKey', {
  description: 'Key for application data encryption',
});

const role = new AppTheoryLambdaRole(this, 'Role', {
  applicationKmsKeys: [dataKey.key],
});

// The function can now use the KMS SDK to encrypt/decrypt data
new lambda.Function(this, 'Function', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
  role: role.role,
  environment: {
    DATA_KEY_ARN: dataKey.keyArn,
  },
});
```

## Additional Policy Statements

Use the `additionalStatements` prop as an escape hatch for any custom permissions:

```typescript
import * as iam from 'aws-cdk-lib/aws-iam';

const role = new AppTheoryLambdaRole(this, 'Role', {
  additionalStatements: [
    new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: ['arn:aws:s3:::my-bucket/*'],
    }),
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
      resources: ['arn:aws:dynamodb:*:*:table/my-table'],
    }),
    new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: ['arn:aws:sqs:*:*:my-queue'],
    }),
  ],
});
```

You can also add statements after construction:

```typescript
const role = new AppTheoryLambdaRole(this, 'Role');

role.addToPolicy(new iam.PolicyStatement({
  actions: ['secretsmanager:GetSecretValue'],
  resources: ['arn:aws:secretsmanager:*:*:secret:my-secret-*'],
}));
```

## Full Options Example

```typescript
import { AppTheoryLambdaRole, AppTheoryKmsKey } from '@theory-cloud/apptheory-cdk';
import * as iam from 'aws-cdk-lib/aws-iam';

const envKey = new AppTheoryKmsKey(this, 'EnvKey', {
  description: 'Environment encryption key',
});

const dataKey = new AppTheoryKmsKey(this, 'DataKey', {
  description: 'Application data encryption key',
});

const role = new AppTheoryLambdaRole(this, 'FullRole', {
  roleName: 'my-production-lambda-role',
  description: 'Production Lambda execution role with full encryption support',
  enableXRay: true,
  environmentEncryptionKeys: [envKey.key],
  applicationKmsKeys: [dataKey.key],
  additionalStatements: [
    new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::config-bucket/*'],
    }),
  ],
  tags: {
    Environment: 'production',
    Team: 'platform',
  },
});
```

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `role` | `iam.Role` | The underlying IAM Role construct |
| `roleArn` | `string` | The ARN of the IAM Role |
| `roleName` | `string` | The name of the IAM Role |

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `roleName` | `string` | Auto-generated | Optional IAM role name |
| `description` | `string` | "Lambda execution role created by AppTheory" | Description for the IAM role |
| `enableXRay` | `boolean` | `false` | Enable X-Ray tracing permissions |
| `environmentEncryptionKeys` | `kms.IKey[]` | - | KMS keys for environment variable decryption |
| `applicationKmsKeys` | `kms.IKey[]` | - | KMS keys for application encrypt/decrypt |
| `additionalStatements` | `iam.PolicyStatement[]` | - | Additional inline policy statements |
| `tags` | `Record<string, string>` | - | Custom tags to apply to the role |

## Methods

| Method | Description |
|--------|-------------|
| `addManagedPolicy(policy)` | Add a managed policy to the role |
| `addToPolicy(statement)` | Add an inline policy statement to the role |
| `grantAssumeRole(principal)` | Grant a principal permission to assume this role |
| `grantPassRole(principal)` | Grant a principal permission to pass this role |

## Migration from LiftLambdaRole

If migrating from Lift CDK's `LiftLambdaRole`:

```typescript
// Before (Lift CDK)
import { LiftLambdaRole } from '@lift/cdk';

const role = new LiftLambdaRole(this, 'Role', {
  xrayEnabled: true,
  kmsKeyArn: 'arn:aws:kms:...',
});

// After (AppTheory)
import { AppTheoryLambdaRole } from '@theory-cloud/apptheory-cdk';
import * as kms from 'aws-cdk-lib/aws-kms';

const key = kms.Key.fromKeyArn(this, 'Key', 'arn:aws:kms:...');

const role = new AppTheoryLambdaRole(this, 'Role', {
  enableXRay: true,
  applicationKmsKeys: [key],
});
```

## Best Practices

1. **Least Privilege**: Only grant the permissions your function actually needs
2. **X-Ray in Production**: Enable X-Ray tracing for observability in production
3. **Separate Keys**: Use different KMS keys for environment encryption vs application data
4. **Tag Consistently**: Add environment and owner tags for cost tracking and governance
5. **Role Naming**: Use descriptive role names that indicate the function's purpose
