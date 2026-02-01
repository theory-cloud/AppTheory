# Media CDN Pattern

The `AppTheoryMediaCdn` construct provides a CloudFront distribution optimized for serving media assets from S3. It supports custom domains, private media access via signed URLs/cookies, and flexible caching configurations.

## Use Cases

- **Public media CDN**: Images, videos, documents served with edge caching
- **Private media access**: Protected content requiring signed URLs or cookies
- **Stage-specific media subdomains**: `media.staging.example.com`, `media.prod.example.com`
- **Separate media domain**: Keep media assets on a dedicated subdomain for better cache management

## Basic Usage

### Public Media CDN

```typescript
import { AppTheoryMediaCdn } from '@theory-cloud/apptheory-cdk';

// Creates a new S3 bucket and CloudFront distribution
const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    comment: 'Media CDN for public assets',
});

// Access the bucket for deployments
console.log('Bucket:', mediaCdn.bucket.bucketName);
console.log('CDN:', mediaCdn.distribution.distributionDomainName);
```

### With Existing S3 Bucket

```typescript
const existingBucket = s3.Bucket.fromBucketName(this, 'MediaBucket', 'my-media-bucket');

const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    bucket: existingBucket,
    comment: 'Media CDN using existing bucket',
});
```

## Custom Domain Configuration

### With Certificate and Route53

```typescript
import { AppTheoryMediaCdn, AppTheoryCertificate } from '@theory-cloud/apptheory-cdk';

const zone = route53.HostedZone.fromLookup(this, 'Zone', {
    domainName: 'example.com',
});

const cert = new AppTheoryCertificate(this, 'Cert', {
    domainName: 'media.example.com',
    hostedZone: zone,
});

const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    domain: {
        domainName: 'media.example.com',
        certificate: cert.certificate,
        hostedZone: zone, // Creates Route53 A record
    },
});
```

### With Certificate ARN

```typescript
const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    domain: {
        domainName: 'media.example.com',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/...',
        hostedZone: zone,
    },
});
```

## Private Media Access

Private media access uses CloudFront signed URLs or signed cookies to restrict access to authenticated users.

### Using an Existing Key Group

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const keyGroup = cloudfront.KeyGroup.fromKeyGroupId(this, 'KeyGroup', 'existing-key-group-id');

const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    privateMedia: {
        keyGroup: keyGroup,
    },
});
```

### Creating Key Group from PEM

```typescript
const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    privateMedia: {
        publicKeyPem: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
-----END PUBLIC KEY-----`,
        publicKeyName: 'my-media-key',
        keyGroupName: 'my-media-key-group',
        keyGroupComment: 'Key group for private media access',
    },
});

// The keyGroup is exposed for use in your application
console.log('Key Group ID:', mediaCdn.keyGroup?.keyGroupId);
```

### Generating Signed URLs

Once private media is configured, your application needs to generate signed URLs. Here's an example using the AWS SDK:

```typescript
// In your Lambda or server-side code
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

const signedUrl = getSignedUrl({
    url: 'https://media.example.com/private/video.mp4',
    keyPairId: 'KXXXXXXXXXXXXXXXXX', // CloudFront public key ID
    privateKey: process.env.CLOUDFRONT_PRIVATE_KEY!,
    dateLessThan: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour
});
```

## Advanced Configuration

### Response Headers Policy

```typescript
const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
    responseHeadersPolicyName: 'MediaSecurityHeaders',
    securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
    },
    customHeadersBehavior: {
        customHeaders: [
            { header: 'Cache-Control', value: 'public, max-age=31536000', override: false },
        ],
    },
});

const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    responseHeadersPolicy: securityHeaders,
});
```

### Full Configuration Example

```typescript
const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    // Bucket configuration
    bucketName: 'my-company-media',
    
    // Domain configuration
    domain: {
        domainName: 'media.example.com',
        certificate: cert.certificate,
        hostedZone: zone,
    },
    
    // CloudFront configuration
    priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US, Canada, Europe
    defaultRootObject: 'index.html',
    comment: 'Production media CDN',
    
    // Caching
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    
    // Security
    webAclId: 'arn:aws:wafv2:...',
    responseHeadersPolicy: securityHeaders,
    
    // Private access (optional)
    privateMedia: {
        keyGroup: myKeyGroup,
    },
    
    // Lifecycle
    removalPolicy: RemovalPolicy.RETAIN,
});
```

## Outputs and Access

```typescript
// Stack outputs
new cdk.CfnOutput(this, 'MediaBucketName', {
    value: mediaCdn.bucket.bucketName,
    description: 'S3 bucket for media assets',
});

new cdk.CfnOutput(this, 'MediaCdnDomain', {
    value: mediaCdn.distribution.distributionDomainName,
    description: 'CloudFront distribution domain',
});

new cdk.CfnOutput(this, 'MediaCdnId', {
    value: mediaCdn.distribution.distributionId,
    description: 'CloudFront distribution ID (for invalidations)',
});
```

## Deploying Assets

After deploying the stack, upload media assets to the S3 bucket:

```bash
# Upload assets
aws s3 sync ./media s3://BUCKET_NAME/

# Invalidate CloudFront cache (if needed)
aws cloudfront create-invalidation \
  --distribution-id DISTRIBUTION_ID \
  --paths "/*"
```

## API Reference

### AppTheoryMediaCdnProps

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `bucket` | `s3.IBucket` | - | Existing S3 bucket (new bucket created if not provided) |
| `bucketName` | `string` | - | Name for new bucket (only used if `bucket` not provided) |
| `domain` | `MediaCdnDomainConfig` | - | Custom domain configuration |
| `responseHeadersPolicy` | `IResponseHeadersPolicy` | - | Response headers policy |
| `privateMedia` | `PrivateMediaConfig` | - | Private media access configuration |
| `defaultRootObject` | `string` | - | Default root object |
| `enableLogging` | `boolean` | `true` | Enable CloudFront access logging |
| `logsBucket` | `s3.IBucket` | - | Bucket for CloudFront logs |
| `priceClass` | `PriceClass` | `PRICE_CLASS_ALL` | CloudFront price class |
| `cachePolicy` | `ICachePolicy` | `CACHING_OPTIMIZED` | Cache policy for default behavior |
| `webAclId` | `string` | - | AWS WAF web ACL ID |
| `comment` | `string` | - | Distribution comment |
| `removalPolicy` | `RemovalPolicy` | `RETAIN` | Removal policy for resources |
| `autoDeleteObjects` | `boolean` | `false` | Auto-delete bucket objects on destroy |

### MediaCdnDomainConfig

| Property | Type | Description |
|----------|------|-------------|
| `domainName` | `string` | Domain name (e.g., "media.example.com") |
| `certificate` | `ICertificate` | ACM certificate (us-east-1) |
| `certificateArn` | `string` | Certificate ARN (alternative to certificate) |
| `hostedZone` | `IHostedZone` | Route53 hosted zone for A record |

### PrivateMediaConfig

| Property | Type | Description |
|----------|------|-------------|
| `keyGroup` | `IKeyGroup` | Existing CloudFront key group |
| `publicKeyPem` | `string` | PEM content to create new key group |
| `publicKeyName` | `string` | Name for created public key |
| `keyGroupName` | `string` | Name for created key group |
| `keyGroupComment` | `string` | Comment for key group |

### Exposed Properties

| Property | Type | Description |
|----------|------|-------------|
| `distribution` | `Distribution` | The CloudFront distribution |
| `bucket` | `IBucket` | The S3 media bucket |
| `logsBucket` | `IBucket` | CloudFront logs bucket (if logging enabled) |
| `certificate` | `ICertificate` | The certificate (if custom domain) |
| `keyGroup` | `IKeyGroup` | The key group (if private media) |
| `publicKey` | `PublicKey` | Created public key (if using PEM) |
