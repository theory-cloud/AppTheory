import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AppTheoryPathRoutedFrontend } from '@theory-cloud/apptheory-cdk';

/**
 * Example stack demonstrating AppTheoryPathRoutedFrontend for multi-SPA + API deployments.
 *
 * This creates:
 * - S3 buckets for two SPAs (client and auth)
 * - CloudFront distribution with path-based routing
 * - CloudFront Function for SPA viewer-request rewrite
 *
 * Path routing:
 * - Default (/*) → API origin
 * - /l/* → Client SPA bucket
 * - /auth/* → Auth SPA bucket
 * - /auth/wallet/* → API origin (bypasses auth SPA)
 */
export class PathRoutedFrontendStack extends cdk.Stack {
    public readonly clientBucket: s3.Bucket;
    public readonly authBucket: s3.Bucket;
    public readonly frontend: AppTheoryPathRoutedFrontend;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Create S3 buckets for SPA assets
        this.clientBucket = new s3.Bucket(this, 'ClientBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        this.authBucket = new s3.Bucket(this, 'AuthBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Create the path-routed frontend distribution
        // Note: In production, you would provide a real apiOriginUrl and domain configuration
        this.frontend = new AppTheoryPathRoutedFrontend(this, 'Frontend', {
            // API origin - in production this would be your API Gateway or Lambda Function URL
            apiOriginUrl: 'https://example.execute-api.us-east-1.amazonaws.com/prod',

            // SPA origins with path patterns
            spaOrigins: [
                {
                    bucket: this.clientBucket,
                    pathPattern: '/l/*',
                },
                {
                    bucket: this.authBucket,
                    pathPattern: '/auth/*',
                },
            ],

            // Paths that should bypass SPA routing and go to API
            apiBypassPaths: [
                { pathPattern: '/auth/wallet/*' },
            ],

            // Optional: Custom domain configuration (uncomment to use)
            // domain: {
            //   domainName: 'app.example.com',
            //   certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/...',
            //   // Or provide hostedZone for Route53 A record creation
            // },

            comment: 'Path-routed frontend example (client + auth SPAs)',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Outputs
        new cdk.CfnOutput(this, 'DistributionDomainName', {
            description: 'CloudFront distribution domain name',
            value: this.frontend.distribution.distributionDomainName,
        });

        new cdk.CfnOutput(this, 'DistributionId', {
            description: 'CloudFront distribution ID',
            value: this.frontend.distribution.distributionId,
        });

        new cdk.CfnOutput(this, 'ClientBucketName', {
            description: 'S3 bucket for client SPA assets (deploy to /l/)',
            value: this.clientBucket.bucketName,
        });

        new cdk.CfnOutput(this, 'AuthBucketName', {
            description: 'S3 bucket for auth SPA assets (deploy to /auth/)',
            value: this.authBucket.bucketName,
        });

        // Instructions for deployment
        new cdk.CfnOutput(this, 'DeployClientAssets', {
            description: 'Command to deploy client SPA assets',
            value: `aws s3 sync ./client/dist s3://\${ClientBucketName}/l`,
        });

        new cdk.CfnOutput(this, 'DeployAuthAssets', {
            description: 'Command to deploy auth SPA assets',
            value: `aws s3 sync ./auth/dist s3://\${AuthBucketName}/auth`,
        });
    }
}
