import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
import { AppTheoryMediaCdn } from '@theory-cloud/apptheory-cdk';

/**
 * Example stack demonstrating AppTheoryMediaCdn for media asset delivery.
 *
 * This creates:
 * - S3 bucket for media assets (with auto-cleanup for dev)
 * - CloudFront distribution optimized for media delivery
 * - Optional: Private media access with signed URLs
 *
 * Use cases:
 * - Public media CDN (images, videos, documents)
 * - Private/authenticated media access
 * - Stage-specific media subdomains
 */
export class MediaCdnStack extends cdk.Stack {
    public readonly mediaCdn: AppTheoryMediaCdn;
    public readonly privateMediaCdn: AppTheoryMediaCdn;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // =====================================================================
        // Example 1: Basic Public Media CDN
        // =====================================================================
        // Creates a new S3 bucket with CloudFront distribution for public media
        this.mediaCdn = new AppTheoryMediaCdn(this, 'PublicMediaCdn', {
            comment: 'Public media CDN for images and documents',

            // Use economical price class for development
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,

            // Auto-cleanup for development (use RETAIN for production)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // =====================================================================
        // Example 2: Private Media CDN with Signed URLs
        // =====================================================================
        // Creates a CDN that requires signed URLs/cookies for access
        // 
        // Note: In production, you would either:
        // 1. Use an existing key group: privateMedia: { keyGroup: existingKeyGroup }
        // 2. Provide real RSA public key PEM content
        //
        // This example uses a sample public key for demonstration.
        // Generate your own key pair:
        //   openssl genrsa -out private_key.pem 2048
        //   openssl rsa -pubout -in private_key.pem -out public_key.pem
        this.privateMediaCdn = new AppTheoryMediaCdn(this, 'PrivateMediaCdn', {
            privateMedia: {
                // Sample RSA-2048 public key (DO NOT USE IN PRODUCTION)
                publicKeyPem: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAudf8/iNkQgdvjEdm6xYS
JAyxd/kGTbJfQNg9YhInb7TSm0dGu0yx8yZ3fnpmH2FBYXZ+NFVW/yfM8xU3FO+e
bykZ3JCsmEbHMEqDnDqPWy1x7a/0XN1+0R/v6bPQ7EHLa6k7VlZjP+zLBbt2T2V0
O0cv9LVGFG/rpwB3g7OXI8DKMc4m50eDFyZN/1lCvF5oIGlgm4pjdD48sUBk3X9S
kSvhVXPl0JNHoGg+Gn4FPK0xQTSzv0r4EfxXPw0fU6zfFHclm0k+K6B9Lb/k0z5d
8Yn8c3JqtXu3F/EzLxVjfWQ2pRHlI9E0q9EuS7UOFD4FD0D3sLfXd8ZNpQ/hdnT1
7wIDAQAB
-----END PUBLIC KEY-----`,
                publicKeyName: 'example-media-key',
                keyGroupName: 'example-media-key-group',
                keyGroupComment: 'Key group for private media access (example)',
            },

            comment: 'Private media CDN requiring signed URLs',
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // =====================================================================
        // Stack Outputs
        // =====================================================================

        // Public media CDN outputs
        new cdk.CfnOutput(this, 'PublicMediaBucketName', {
            description: 'S3 bucket for public media assets',
            value: this.mediaCdn.bucket.bucketName,
        });

        new cdk.CfnOutput(this, 'PublicMediaCdnDomain', {
            description: 'Public media CDN domain',
            value: this.mediaCdn.distribution.distributionDomainName,
        });

        new cdk.CfnOutput(this, 'PublicMediaCdnId', {
            description: 'Public media CDN distribution ID',
            value: this.mediaCdn.distribution.distributionId,
        });

        // Private media CDN outputs
        new cdk.CfnOutput(this, 'PrivateMediaBucketName', {
            description: 'S3 bucket for private media assets',
            value: this.privateMediaCdn.bucket.bucketName,
        });

        new cdk.CfnOutput(this, 'PrivateMediaCdnDomain', {
            description: 'Private media CDN domain',
            value: this.privateMediaCdn.distribution.distributionDomainName,
        });

        new cdk.CfnOutput(this, 'PrivateMediaKeyGroupId', {
            description: 'Key group ID for signed URL generation',
            value: this.privateMediaCdn.keyGroup?.keyGroupId ?? 'N/A',
        });

        // Deployment instructions
        new cdk.CfnOutput(this, 'DeployPublicMedia', {
            description: 'Command to deploy public media assets',
            value: `aws s3 sync ./media s3://\${PublicMediaBucketName}/`,
        });

        new cdk.CfnOutput(this, 'InvalidateCache', {
            description: 'Command to invalidate CloudFront cache',
            value: `aws cloudfront create-invalidation --distribution-id \${PublicMediaCdnId} --paths "/*"`,
        });
    }
}
