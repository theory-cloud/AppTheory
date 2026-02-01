# CloudFront Path-Routed Frontend Distribution

The `AppTheoryPathRoutedFrontend` construct creates a CloudFront distribution for path-routed multi-SPA + API deployments. This is the pattern used when you have:

- Multiple Single Page Applications (SPAs) served from S3, each under a different path prefix
- An API backend (API Gateway or Lambda Function URL) as the default origin
- Specific API paths that should bypass SPA routing

## Use Case

This construct is designed for the "stage domain" pattern where a single domain serves:

```
https://app.example.com/           → API origin (default)
https://app.example.com/l/*        → Client SPA (S3)
https://app.example.com/auth/*     → Auth SPA (S3)
https://app.example.com/auth/wallet/* → API origin (bypass auth SPA)
```

## Features

### 1. Multi-SPA Path Routing

Route different path prefixes to different S3 buckets containing SPA assets:

```typescript
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AppTheoryPathRoutedFrontend } from '@theory-cloud/apptheory-cdk';

const clientBucket = new s3.Bucket(stack, 'ClientBucket');
const authBucket = new s3.Bucket(stack, 'AuthBucket');

new AppTheoryPathRoutedFrontend(stack, 'Frontend', {
  apiOriginUrl: 'https://api.example.com',
  spaOrigins: [
    { bucket: clientBucket, pathPattern: '/l/*' },
    { bucket: authBucket, pathPattern: '/auth/*' },
  ],
});
```

### 2. CloudFront Function for SPA Rewrite

The construct automatically creates a CloudFront Function that:

- Rewrites requests without file extensions to `index.html` within the SPA prefix
- Preserves requests for static assets (`.js`, `.css`, `.png`, etc.)
- Handles SPA client-side routing correctly

Example rewrite behavior:
```
/l/dashboard      → /l/index.html  (no extension, SPA route)
/l/assets/app.js  → /l/assets/app.js  (has extension, served as-is)
/auth/login       → /auth/index.html  (no extension, SPA route)
```

### 3. API Bypass Paths

Some paths might match an SPA prefix but should actually route to the API. Use `apiBypassPaths`:

```typescript
new AppTheoryPathRoutedFrontend(stack, 'Frontend', {
  apiOriginUrl: 'https://api.example.com',
  spaOrigins: [
    { bucket: authBucket, pathPattern: '/auth/*' },
  ],
  apiBypassPaths: [
    { pathPattern: '/auth/wallet/*' },  // Goes to API, not auth SPA
    { pathPattern: '/auth/api/*' },
  ],
});
```

### 4. Custom Domain Configuration

Configure a custom domain with ACM certificate and Route53:

```typescript
import * as route53 from 'aws-cdk-lib/aws-route53';
import { AppTheoryCertificate, AppTheoryPathRoutedFrontend } from '@theory-cloud/apptheory-cdk';

const zone = route53.PublicHostedZone.fromLookup(stack, 'Zone', {
  domainName: 'example.com',
});

const cert = new AppTheoryCertificate(stack, 'Cert', {
  domainName: 'app.example.com',
  hostedZone: zone,
});

new AppTheoryPathRoutedFrontend(stack, 'Frontend', {
  apiOriginUrl: 'https://api.example.com',
  spaOrigins: [
    { bucket: clientBucket, pathPattern: '/l/*' },
  ],
  domain: {
    domainName: 'app.example.com',
    certificate: cert.certificate,
    hostedZone: zone,  // Creates Route53 A record
  },
});
```

### 5. Response Headers Policy

Apply a response headers policy to all behaviors:

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

new AppTheoryPathRoutedFrontend(stack, 'Frontend', {
  apiOriginUrl: 'https://api.example.com',
  spaOrigins: [
    { bucket: clientBucket, pathPattern: '/l/*' },
  ],
  responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT,
});
```

## Full Example

```typescript
import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { 
  AppTheoryCertificate,
  AppTheoryPathRoutedFrontend 
} from '@theory-cloud/apptheory-cdk';

const app = new cdk.App();
const stack = new cdk.Stack(app, 'FrontendStack');

// S3 buckets for SPAs
const clientBucket = new s3.Bucket(stack, 'ClientBucket', {
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const authBucket = new s3.Bucket(stack, 'AuthBucket', {
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

// DNS and certificate
const zone = route53.PublicHostedZone.fromLookup(stack, 'Zone', {
  domainName: 'example.com',
});

const cert = new AppTheoryCertificate(stack, 'Cert', {
  domainName: 'app.example.com',
  hostedZone: zone,
});

// Path-routed frontend
const frontend = new AppTheoryPathRoutedFrontend(stack, 'Frontend', {
  apiOriginUrl: 'https://api.example.com',
  spaOrigins: [
    { bucket: clientBucket, pathPattern: '/l/*' },
    { bucket: authBucket, pathPattern: '/auth/*' },
  ],
  apiBypassPaths: [
    { pathPattern: '/auth/wallet/*' },
  ],
  domain: {
    domainName: 'app.example.com',
    certificate: cert.certificate,
    hostedZone: zone,
  },
  comment: 'Multi-SPA frontend distribution',
});

new cdk.CfnOutput(stack, 'DistributionDomainName', {
  value: frontend.distribution.distributionDomainName,
});

new cdk.CfnOutput(stack, 'ClientBucketName', {
  value: clientBucket.bucketName,
});

new cdk.CfnOutput(stack, 'AuthBucketName', {
  value: authBucket.bucketName,
});
```

## Props Reference

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `apiOriginUrl` | `string` | ✅ | - | The primary API origin URL |
| `spaOrigins` | `SpaOriginConfig[]` | ❌ | `[]` | SPA origins with path patterns |
| `apiBypassPaths` | `ApiBypassConfig[]` | ❌ | `[]` | Paths that bypass SPA routing |
| `domain` | `PathRoutedFrontendDomainConfig` | ❌ | - | Custom domain configuration |
| `responseHeadersPolicy` | `IResponseHeadersPolicy` | ❌ | - | Response headers policy |
| `apiOriginRequestPolicy` | `IOriginRequestPolicy` | ❌ | - | Origin request policy for API |
| `enableLogging` | `boolean` | ❌ | `true` | Enable CloudFront access logs |
| `logsBucket` | `IBucket` | ❌ | Auto-created | S3 bucket for logs |
| `removalPolicy` | `RemovalPolicy` | ❌ | `RETAIN` | Removal policy |
| `autoDeleteObjects` | `boolean` | ❌ | `false` | Auto-delete objects on removal |
| `webAclId` | `string` | ❌ | - | WAF Web ACL ID |
| `priceClass` | `PriceClass` | ❌ | `ALL` | CloudFront price class |
| `comment` | `string` | ❌ | - | Distribution comment |

## Outputs

| Property | Type | Description |
|----------|------|-------------|
| `distribution` | `cloudfront.Distribution` | The CloudFront distribution |
| `spaRewriteFunction` | `cloudfront.Function` | The SPA rewrite function (if SPAs configured) |
| `logsBucket` | `s3.IBucket` | The logs bucket (if logging enabled) |
| `certificate` | `acm.ICertificate` | The certificate (if custom domain) |

## CloudFront Behavior Precedence

CloudFront evaluates behaviors by path pattern specificity. This construct configures:

1. **API bypass paths** (most specific, e.g., `/auth/wallet/*`)
2. **SPA path patterns** (e.g., `/auth/*`, `/l/*`)
3. **Default behavior** (API origin, catches everything else)

This ensures that `/auth/wallet/callback` routes to the API even though `/auth/*` would match.

## S3 Bucket Configuration

The SPA buckets should contain your built SPA assets. Each bucket should have:

- `index.html` at the root of the bucket or in the corresponding path prefix
- Static assets in subdirectories (e.g., `/l/assets/`, `/auth/static/`)

Deploy assets using `aws-cdk-lib/aws-s3-deployment`:

```typescript
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

new s3deploy.BucketDeployment(stack, 'DeployClient', {
  sources: [s3deploy.Source.asset('./client/dist')],
  destinationBucket: clientBucket,
  destinationKeyPrefix: 'l',
});

new s3deploy.BucketDeployment(stack, 'DeployAuth', {
  sources: [s3deploy.Source.asset('./auth/dist')],
  destinationBucket: authBucket,
  destinationKeyPrefix: 'auth',
});
```

## Migration from Lift CDK

If you're migrating from Lift CDK's CloudFront patterns, this construct provides similar functionality with:

- Path-routed SPA behaviors
- CloudFront Function for SPA rewrite (viewer-request)
- API origin as default
- Custom domain + Route53 integration

The main difference is explicit configuration of SPA origins and bypass paths instead of Lift's convention-based approach.
