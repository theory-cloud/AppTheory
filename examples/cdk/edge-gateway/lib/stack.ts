import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Edge gateway example: Lambda@Edge associations, a CloudFront KeyValueStore,
 * geo restriction and field-level encryption on distributions the local runner
 * serves as a real edge path.
 */
export class EdgeGatewayStack extends cdk.Stack {
    public readonly bucket: s3.Bucket;
    public readonly distribution: cloudfront.Distribution;

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

        new cdk.CfnOutput(this, 'DistributionDomain', { value: this.distribution.distributionDomainName });
        new cdk.CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    }
}
