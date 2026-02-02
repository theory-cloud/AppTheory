# Media CDN Example

This example demonstrates how to use `AppTheoryMediaCdn` to create CloudFront distributions for serving media assets from S3.

## What This Creates

1. **Public Media CDN** - A CloudFront distribution with S3 origin for public media assets
2. **Private Media CDN** - A CloudFront distribution requiring signed URLs for authenticated access

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

## Usage

### Public Media CDN

After deployment, upload media assets to the public bucket:

```bash
# Get bucket name from stack outputs
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name MediaCdnExample \
  --query 'Stacks[0].Outputs[?OutputKey==`PublicMediaBucketName`].OutputValue' \
  --output text)

# Upload media files
aws s3 sync ./my-media-folder s3://$BUCKET_NAME/

# Get CDN domain
CDN_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name MediaCdnExample \
  --query 'Stacks[0].Outputs[?OutputKey==`PublicMediaCdnDomain`].OutputValue' \
  --output text)

# Access media
curl https://$CDN_DOMAIN/my-image.jpg
```

### Private Media CDN

Private media requires signed URLs. Here's how to generate them:

```typescript
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

const signedUrl = getSignedUrl({
    url: `https://${CDN_DOMAIN}/private-video.mp4`,
    keyPairId: 'YOUR_KEY_PAIR_ID', // From stack outputs
    privateKey: process.env.CLOUDFRONT_PRIVATE_KEY!,
    dateLessThan: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour
});

console.log('Signed URL:', signedUrl);
```

### Invalidating Cache

When you update media files, invalidate the CloudFront cache:

```bash
DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --stack-name MediaCdnExample \
  --query 'Stacks[0].Outputs[?OutputKey==`PublicMediaCdnId`].OutputValue' \
  --output text)

aws cloudfront create-invalidation \
  --distribution-id $DISTRIBUTION_ID \
  --paths "/*"
```

## Custom Domain Setup

To use a custom domain like `media.example.com`:

```typescript
import { AppTheoryMediaCdn, AppTheoryCertificate } from '@theory-cloud/apptheory-cdk';

// Get your hosted zone
const zone = route53.HostedZone.fromLookup(this, 'Zone', {
    domainName: 'example.com',
});

// Create certificate (must be in us-east-1 for CloudFront)
const cert = new AppTheoryCertificate(this, 'Cert', {
    domainName: 'media.example.com',
    hostedZone: zone,
});

// Create media CDN with custom domain
const mediaCdn = new AppTheoryMediaCdn(this, 'MediaCdn', {
    domain: {
        domainName: 'media.example.com',
        certificate: cert.certificate,
        hostedZone: zone, // Creates Route53 A record
    },
});
```

## Cleanup

```bash
# Destroy the stack and all resources
cdk destroy
```

## Notes

- The example uses `RemovalPolicy.DESTROY` for easy cleanup. Use `RETAIN` for production.
- The sample RSA key is for demonstration only. Generate your own key pair for production.
- CloudFront distributions take 15-30 minutes to deploy globally.
