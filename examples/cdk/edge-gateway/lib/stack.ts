import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

// Sample RSA-2048 public key for the field-level encryption profile. The
// proving row replaces it through CDK context with a key pair generated at run
// time; no private key is ever committed. The committed value keeps the
// synthesized template deployable as written.
const SAMPLE_FLE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAudf8/iNkQgdvjEdm6xYS
JAyxd/kGTbJfQNg9YhInb7TSm0dGu0yx8yZ3fnpmH2FBYXZ+NFVW/yfM8xU3FO+e
bykZ3JCsmEbHMEqDnDqPWy1x7a/0XN1+0R/v6bPQ7EHLa6k7VlZjP+zLBbt2T2V0
O0cv9LVGFG/rpwB3g7OXI8DKMc4m50eDFyZN/1lCvF5oIGlgm4pjdD48sUBk3X9S
kSvhVXPl0JNHoGg+Gn4FPK0xQTSzv0r4EfxXPw0fU6zfFHclm0k+K6B9Lb/k0z5d
8Yn8c3JqtXu3F/EzLxVjfWQ2pRHlI9E0q9EuS7UOFD4FD0D3sLfXd8ZNpQ/hdnT1
7wIDAQAB
-----END PUBLIC KEY-----`;

function contextPublicKey(scope: Construct, name: string, fallback: string): string {
    const encoded = scope.node.tryGetContext(name) as string | undefined;
    if (!encoded) {
        return fallback;
    }
    return Buffer.from(encoded, 'base64').toString('utf8');
}

/**
 * Edge gateway example: Lambda@Edge associations, a CloudFront KeyValueStore,
 * geo restriction and field-level encryption on distributions the local runner
 * serves as a real edge path.
 */
export class EdgeGatewayStack extends cdk.Stack {
    public readonly bucket: s3.Bucket;
    public readonly distribution: cloudfront.Distribution;
    public readonly geoDistribution: cloudfront.Distribution;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        this.bucket = new s3.Bucket(this, 'ContentBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const apiOrigin = new origins.HttpOrigin('api.example.com', {
            protocolPolicy: cloudfront.OriginProtocolPolicy.MATCH_VIEWER,
        });

        const edgeCode = lambda.Code.fromAsset('handlers');
        const runtime = lambda.Runtime.NODEJS_24_X;

        const viewerRequest = new lambda.Function(this, 'ViewerRequestFunction', {
            runtime,
            handler: 'viewer-request.handler',
            code: edgeCode,
            description: 'Lambda@Edge viewer-request rewrite',
        });
        const originRequest = new lambda.Function(this, 'OriginRequestFunction', {
            runtime,
            handler: 'origin-request.handler',
            code: edgeCode,
            description: 'Lambda@Edge origin-request generated response',
        });
        const originResponse = new lambda.Function(this, 'OriginResponseFunction', {
            runtime,
            handler: 'origin-response.handler',
            code: edgeCode,
            description: 'Lambda@Edge origin-response header and body change',
        });
        const viewerResponse = new lambda.Function(this, 'ViewerResponseFunction', {
            runtime,
            handler: 'viewer-response.handler',
            code: edgeCode,
            description: 'Lambda@Edge viewer-response header change',
        });

        // Lambda@Edge requires a numbered version, never $LATEST or an alias.
        const viewerRequestVersion = new lambda.Version(this, 'ViewerRequestVersion', { lambda: viewerRequest });
        const originRequestVersion = new lambda.Version(this, 'OriginRequestVersion', { lambda: originRequest });
        const originResponseVersion = new lambda.Version(this, 'OriginResponseVersion', { lambda: originResponse });
        const viewerResponseVersion = new lambda.Version(this, 'ViewerResponseVersion', { lambda: viewerResponse });

        const edgeLambdas: cloudfront.EdgeLambda[] = [
            {
                eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
                functionVersion: viewerRequestVersion,
                includeBody: true,
            },
            {
                eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
                functionVersion: originRequestVersion,
                includeBody: true,
            },
            {
                eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
                functionVersion: originResponseVersion,
            },
            {
                eventType: cloudfront.LambdaEdgeEventType.VIEWER_RESPONSE,
                functionVersion: viewerResponseVersion,
            },
        ];

        // The key value store is populated from an inline import source; the
        // assembly carries the import file as an asset.
        const store = new cloudfront.KeyValueStore(this, 'EdgeStore', {
            keyValueStoreName: 'edge-gateway-store',
            comment: 'Edge gateway key value store',
            source: cloudfront.ImportSource.fromInline(JSON.stringify({
                data: [
                    { key: 'target', value: '/edge/rewritten' },
                    { key: 'config', value: '{"variant":"b","enabled":true}' },
                ],
            })),
        });

        const kvFunction = new cloudfront.Function(this, 'KeyValueFunction', {
            code: cloudfront.FunctionCode.fromFile({ filePath: 'handlers/kvs.js' }),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            keyValueStore: store,
            comment: 'Reads the edge key value store',
        });

        const edgeBehavior = {
            origin: new origins.S3Origin(this.bucket),
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            edgeLambdas,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        };

        const apiBehavior = {
            origin: apiOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            // The origin receives only the policy-filtered request, so forward
            // the viewer headers the row asserts on (including the one the
            // viewer-request function adds with no key).
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            edgeLambdas: [edgeLambdas[0], edgeLambdas[1]],
        };

        this.distribution = new cloudfront.Distribution(this, 'EdgeDistribution', {
            comment: 'Edge gateway distribution',
            defaultBehavior: edgeBehavior as cloudfront.BehaviorOptions,
            additionalBehaviors: {
                '/api/*': apiBehavior as cloudfront.BehaviorOptions,
                '/kv/*': {
                    origin: new origins.S3Origin(this.bucket),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                    functionAssociations: [{
                        function: kvFunction,
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    }],
                },
            },
            errorResponses: [{
                httpStatus: 403,
                responseHttpStatus: 200,
                responsePagePath: '/errors/not-found.html',
                ttl: cdk.Duration.seconds(60),
            }],
        });

        // Field-level encryption. The L2 Distribution cannot express
        // FieldLevelEncryptionId (aws/aws-cdk#30203), so the configuration is
        // linked to the /api/* behavior through the L1 property override.
        const fleKey = new cloudfront.CfnPublicKey(this, 'FieldLevelEncryptionKey', {
            publicKeyConfig: {
                callerReference: 'edge-gateway-fle',
                name: 'edge-gateway-fle-key',
                encodedKey: contextPublicKey(this, 'flePublicKeyBase64', SAMPLE_FLE_PUBLIC_KEY),
            },
        });
        const fleProfile = new cloudfront.CfnFieldLevelEncryptionProfile(this, 'FieldLevelEncryptionProfile', {
            fieldLevelEncryptionProfileConfig: {
                callerReference: 'edge-gateway-fle',
                name: 'edge-gateway-fle-profile',
                encryptionEntities: [{
                    publicKeyId: fleKey.ref,
                    providerId: 'edge-gateway',
                    fieldPatterns: ['card'],
                }],
            },
        });
        const fleConfig = new cloudfront.CfnFieldLevelEncryptionConfig(this, 'FieldLevelEncryptionConfig', {
            callerReference: 'edge-gateway-fle',
            comment: 'Encrypts the card field',
            contentTypeProfileConfig: {
                // Forward unknown content types untouched so the same behavior
                // can echo non-form requests in the row.
                forwardWhenContentTypeIsUnknown: true,
                contentTypeProfiles: [{
                    contentType: 'application/x-www-form-urlencoded',
                    format: 'URLEncoded',
                    profileId: fleProfile.ref,
                }],
            },
            // The service requires the query-argument block; an empty profile
            // list with forwarding disabled keeps the content-type profile in
            // charge.
            queryArgProfileConfig: {
                forwardWhenQueryArgProfileIsUnknown: false,
                queryArgProfiles: [],
            },
        });
        // additionalBehaviors emits /api/* first, so its entry is index 0.
        (this.distribution.node.defaultChild as cloudfront.CfnDistribution).addPropertyOverride(
            'DistributionConfig.CacheBehaviors.0.FieldLevelEncryptionId',
            fleConfig.ref,
        );

        // Geo restriction: a separate distribution with an allowlist.
        this.geoDistribution = new cloudfront.Distribution(this, 'GeoDistribution', {
            comment: 'Geo restricted distribution',
            defaultBehavior: {
                origin: new origins.S3Origin(this.bucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            },
            geoRestriction: cloudfront.GeoRestriction.allowlist('US', 'DE'),
        });

        new cdk.CfnOutput(this, 'DistributionDomain', { value: this.distribution.distributionDomainName });
        new cdk.CfnOutput(this, 'GeoDistributionDomain', { value: this.geoDistribution.distributionDomainName });
        new cdk.CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
        new cdk.CfnOutput(this, 'KeyValueStoreId', { value: store.keyValueStoreId });
    }
}
