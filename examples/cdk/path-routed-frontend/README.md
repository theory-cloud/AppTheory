# Path-Routed Frontend Example

This example demonstrates how to use `AppTheoryPathRoutedFrontend` to create a CloudFront distribution that routes requests to multiple SPAs and an API backend.

## Architecture

```
                        ┌─────────────────────────────────────┐
                        │      CloudFront Distribution        │
                        │                                     │
                        │  ┌─────────────────────────────────┐│
Internet ─────────────▶ │  │ CloudFront Function (SPA rewrite)│
                        │  └─────────────────────────────────┘│
                        │                                     │
                        │  Path Routing:                      │
                        │  ┌───────────────────────────────┐  │
                        │  │ /l/*        → Client S3 Bucket│  │
                        │  │ /auth/*     → Auth S3 Bucket  │  │
                        │  │ /auth/wallet/* → API Origin   │  │
                        │  │ /*          → API Origin      │  │
                        │  └───────────────────────────────┘  │
                        └─────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
            ┌───────────┐     ┌───────────┐     ┌───────────┐
            │ Client S3 │     │  Auth S3  │     │    API    │
            │   Bucket  │     │  Bucket   │     │  Gateway  │
            └───────────┘     └───────────┘     └───────────┘
```

## Features Demonstrated

1. **Multi-SPA Routing**: Two SPAs (client and auth) served from different S3 buckets
2. **CloudFront Function**: Automatic SPA rewrite for client-side routing support
3. **API Bypass Paths**: `/auth/wallet/*` routes to API even though `/auth/*` matches auth SPA
4. **S3 Origin Access Control**: Secure S3 access via OAC (no public buckets)

## Usage

### Install dependencies

```bash
npm install
```

### Synthesize the stack

```bash
npm run synth
```

### Deploy (requires AWS credentials)

```bash
npm run deploy
```

### Deploy SPA assets

After deployment, deploy your SPA assets to the buckets:

```bash
# Client SPA
aws s3 sync ./client/dist s3://<ClientBucketName>/l

# Auth SPA
aws s3 sync ./auth/dist s3://<AuthBucketName>/auth
```

## Customization

### Adding a custom domain

Update `lib/stack.ts` to include domain configuration:

```typescript
this.frontend = new AppTheoryPathRoutedFrontend(this, 'Frontend', {
  apiOriginUrl: 'https://api.example.com',
  spaOrigins: [
    { bucket: this.clientBucket, pathPattern: '/l/*' },
    { bucket: this.authBucket, pathPattern: '/auth/*' },
  ],
  domain: {
    domainName: 'app.example.com',
    certificateArn: 'arn:aws:acm:us-east-1:...',
    // Or provide hostedZone for Route53 A record creation
  },
});
```

### Adding more SPAs

Add additional SPA origins to the `spaOrigins` array:

```typescript
spaOrigins: [
  { bucket: clientBucket, pathPattern: '/l/*' },
  { bucket: authBucket, pathPattern: '/auth/*' },
  { bucket: adminBucket, pathPattern: '/admin/*' },
],
```

### Adding API bypass paths

If certain paths under an SPA prefix should route to the API:

```typescript
apiBypassPaths: [
  { pathPattern: '/auth/wallet/*' },
  { pathPattern: '/auth/api/*' },
  { pathPattern: '/l/api/*' },
],
```
