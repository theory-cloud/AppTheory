"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheorySsrSite = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const origins = require("aws-cdk-lib/aws-cloudfront-origins");
const lambda = require("aws-cdk-lib/aws-lambda");
const route53 = require("aws-cdk-lib/aws-route53");
const targets = require("aws-cdk-lib/aws-route53-targets");
const s3 = require("aws-cdk-lib/aws-s3");
const s3deploy = require("aws-cdk-lib/aws-s3-deployment");
const constructs_1 = require("constructs");
class AppTheorySsrSite extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        if (!props?.ssrFunction) {
            throw new Error("AppTheorySsrSite requires props.ssrFunction");
        }
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const autoDeleteObjects = props.autoDeleteObjects ?? false;
        this.assetsBucket =
            props.assetsBucket ??
                new s3.Bucket(this, "AssetsBucket", {
                    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                    encryption: s3.BucketEncryption.S3_MANAGED,
                    enforceSSL: true,
                    removalPolicy,
                    autoDeleteObjects,
                });
        const enableLogging = props.enableLogging ?? true;
        if (enableLogging) {
            this.logsBucket =
                props.logsBucket ??
                    new s3.Bucket(this, "CloudFrontLogsBucket", {
                        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                        encryption: s3.BucketEncryption.S3_MANAGED,
                        enforceSSL: true,
                        removalPolicy,
                        autoDeleteObjects,
                    });
        }
        const assetsPrefixRaw = String(props.assetsKeyPrefix ?? "assets").trim().replace(/^\/+/, "").replace(/\/+$/, "");
        const assetsKeyPrefix = assetsPrefixRaw || "assets";
        const manifestRaw = String(props.assetsManifestKey ?? `${assetsKeyPrefix}/manifest.json`)
            .trim()
            .replace(/^\/+/, "")
            .replace(/\/+$/, "");
        const assetsManifestKey = manifestRaw || `${assetsKeyPrefix}/manifest.json`;
        this.assetsKeyPrefix = assetsKeyPrefix;
        this.assetsManifestKey = assetsManifestKey;
        if (props.assetsPath) {
            new s3deploy.BucketDeployment(this, "AssetsDeployment", {
                sources: [s3deploy.Source.asset(props.assetsPath)],
                destinationBucket: this.assetsBucket,
                destinationKeyPrefix: assetsKeyPrefix,
                prune: true,
            });
        }
        this.ssrUrl = new lambda.FunctionUrl(this, "SsrUrl", {
            function: props.ssrFunction,
            authType: lambda.FunctionUrlAuthType.NONE,
            invokeMode: props.invokeMode ?? lambda.InvokeMode.RESPONSE_STREAM,
        });
        const ssrDomainName = aws_cdk_lib_1.Fn.select(2, aws_cdk_lib_1.Fn.split("/", this.ssrUrl.url));
        const ssrOrigin = new origins.HttpOrigin(ssrDomainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        });
        const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.assetsBucket);
        const baseSsrForwardHeaders = [
            "accept",
            "accept-language",
            "cache-control",
            "host",
            "if-none-match",
            "user-agent",
            "x-forwarded-for",
            "x-forwarded-proto",
            "cloudfront-forwarded-proto",
            "cloudfront-viewer-address",
        ];
        const extraSsrForwardHeaders = Array.isArray(props.ssrForwardHeaders)
            ? props.ssrForwardHeaders
                .map((header) => String(header).trim().toLowerCase())
                .filter((header) => header.length > 0)
            : [];
        const ssrForwardHeaders = Array.from(new Set([...baseSsrForwardHeaders, ...extraSsrForwardHeaders]));
        const ssrOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "SsrOriginRequestPolicy", {
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...ssrForwardHeaders),
        });
        const domainName = String(props.domainName ?? "").trim();
        let distributionCertificate;
        let distributionDomainNames;
        if (domainName) {
            distributionDomainNames = [domainName];
            const certArn = String(props.certificateArn ?? "").trim();
            if (certArn) {
                distributionCertificate = acm.Certificate.fromCertificateArn(this, "Certificate", certArn);
            }
            else if (props.hostedZone) {
                distributionCertificate = new acm.DnsValidatedCertificate(this, "Certificate", {
                    domainName,
                    hostedZone: props.hostedZone,
                    region: "us-east-1",
                });
            }
            else {
                throw new Error("AppTheorySsrSite requires props.certificateArn or props.hostedZone when props.domainName is set");
            }
        }
        this.certificate = distributionCertificate;
        const createStaticBehavior = () => ({
            origin: assetsOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            compress: true,
        });
        const staticPathPatterns = Array.from(new Set(Array.isArray(props.staticPathPatterns)
            ? props.staticPathPatterns
                .map((pattern) => String(pattern).trim().replace(/^\/+/, ""))
                .filter((pattern) => pattern.length > 0)
            : []));
        const additionalBehaviors = {
            [`${assetsKeyPrefix}/*`]: createStaticBehavior(),
        };
        for (const pattern of staticPathPatterns) {
            additionalBehaviors[pattern] = createStaticBehavior();
        }
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            ...(enableLogging && this.logsBucket
                ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
                : {}),
            ...(distributionDomainNames && distributionCertificate
                ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
                : {}),
            defaultBehavior: {
                origin: ssrOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: ssrOriginRequestPolicy,
            },
            additionalBehaviors,
            ...(props.webAclId ? { webAclId: props.webAclId } : {}),
        });
        if (props.wireRuntimeEnv ?? true) {
            this.assetsBucket.grantRead(props.ssrFunction);
            const ssrFunctionAny = props.ssrFunction;
            if (typeof ssrFunctionAny.addEnvironment !== "function") {
                throw new Error("AppTheorySsrSite wireRuntimeEnv requires props.ssrFunction to support addEnvironment; pass a lambda.Function or set wireRuntimeEnv=false and set env vars manually");
            }
            ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_BUCKET", this.assetsBucket.bucketName);
            ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_PREFIX", assetsKeyPrefix);
            ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_MANIFEST_KEY", assetsManifestKey);
            const cacheTableName = String(props.cacheTableName ?? "").trim();
            if (cacheTableName) {
                ssrFunctionAny.addEnvironment("APPTHEORY_CACHE_TABLE_NAME", cacheTableName);
                ssrFunctionAny.addEnvironment("FACETHEORY_CACHE_TABLE_NAME", cacheTableName);
                ssrFunctionAny.addEnvironment("CACHE_TABLE_NAME", cacheTableName);
                ssrFunctionAny.addEnvironment("CACHE_TABLE", cacheTableName);
            }
        }
        if (domainName && props.hostedZone) {
            new route53.ARecord(this, "AliasRecord", {
                zone: props.hostedZone,
                recordName: domainName,
                target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
            });
        }
    }
}
exports.AppTheorySsrSite = AppTheorySsrSite;
_a = JSII_RTTI_SYMBOL_1;
AppTheorySsrSite[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "0.10.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFnRDtBQUNoRCwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUM5RCxpREFBaUQ7QUFDakQsbURBQW1EO0FBQ25ELDJEQUEyRDtBQUMzRCx5Q0FBeUM7QUFDekMsMERBQTBEO0FBQzFELDJDQUF1QztBQXdDdkMsTUFBYSxnQkFBaUIsU0FBUSxzQkFBUztJQVM3QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLEtBQUssRUFBRSxXQUFXLEVBQUUsQ0FBQztZQUN4QixNQUFNLElBQUksS0FBSyxDQUFDLDZDQUE2QyxDQUFDLENBQUM7UUFDakUsQ0FBQztRQUVELE1BQU0sYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLElBQUksMkJBQWEsQ0FBQyxNQUFNLENBQUM7UUFDbEUsTUFBTSxpQkFBaUIsR0FBRyxLQUFLLENBQUMsaUJBQWlCLElBQUksS0FBSyxDQUFDO1FBRTNELElBQUksQ0FBQyxZQUFZO1lBQ2YsS0FBSyxDQUFDLFlBQVk7Z0JBQ2xCLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO29CQUNsQyxpQkFBaUIsRUFBRSxFQUFFLENBQUMsaUJBQWlCLENBQUMsU0FBUztvQkFDakQsVUFBVSxFQUFFLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxVQUFVO29CQUMxQyxVQUFVLEVBQUUsSUFBSTtvQkFDaEIsYUFBYTtvQkFDYixpQkFBaUI7aUJBQ2xCLENBQUMsQ0FBQztRQUVMLE1BQU0sYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLElBQUksSUFBSSxDQUFDO1FBQ2xELElBQUksYUFBYSxFQUFFLENBQUM7WUFDbEIsSUFBSSxDQUFDLFVBQVU7Z0JB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QUMsVUFBVTtnQkFDdEIsVUFBVSxFQUFFLFVBQVU7Z0JBQ3RCLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7YUFDeEYsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUVILENBQUM7O0FBek1ILDRDQTBNQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEZuLCBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnRcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZVByb3BzIHtcbiAgcmVhZG9ubHkgc3NyRnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xuXG4gIHJlYWRvbmx5IGFzc2V0c0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHJlYWRvbmx5IGFzc2V0c1BhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFzc2V0c0tleVByZWZpeD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzTWFuaWZlc3RLZXk/OiBzdHJpbmc7XG5cbiAgLy8gQWRkaXRpb25hbCBDbG91ZEZyb250IHBhdGggcGF0dGVybnMgdG8gcm91dGUgdG8gdGhlIHN0YXRpYyBTMyBvcmlnaW4uXG4gIC8vIEV4YW1wbGUgKEZhY2VUaGVvcnkgU1NHIGh5ZHJhdGlvbik6IFwiL19mYWNldGhlb3J5L2RhdGEvKlwiXG4gIHJlYWRvbmx5IHN0YXRpY1BhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8vIE9wdGlvbmFsIER5bmFtb0RCIHRhYmxlIG5hbWUgZm9yIElTUi9jYWNoZSBtZXRhZGF0YSBvd25lZCBieSBhcHAgY29kZSAoVGFibGVUaGVvcnkpLlxuICAvLyBXaGVuIHNldCwgQXBwVGhlb3J5IHdpbGwgd2lyZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgb24gdGhlIFNTUiBmdW5jdGlvbi5cbiAgcmVhZG9ubHkgY2FjaGVUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLy8gV2hlbiB0cnVlIChkZWZhdWx0KSwgQXBwVGhlb3J5IHdpcmVzIHJlY29tbWVuZGVkIHJ1bnRpbWUgZW52aXJvbm1lbnQgdmFyaWFibGVzIG9udG8gdGhlIFNTUiBmdW5jdGlvbi5cbiAgcmVhZG9ubHkgd2lyZVJ1bnRpbWVFbnY/OiBib29sZWFuO1xuXG4gIC8vIEFkZGl0aW9uYWwgaGVhZGVycyB0byBmb3J3YXJkIHRvIHRoZSBTU1Igb3JpZ2luIChMYW1iZGEgRnVuY3Rpb24gVVJMKSB2aWEgdGhlIG9yaWdpbiByZXF1ZXN0IHBvbGljeS5cbiAgLy8gRXhhbXBsZSAoRmFjZVRoZW9yeSBtdWx0aS10ZW5hbnQpOiBcIngtZmFjZXRoZW9yeS10ZW5hbnRcIlxuICByZWFkb25seSBzc3JGb3J3YXJkSGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgYXV0b0RlbGV0ZU9iamVjdHM/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVNzclNpdGUgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzQnVja2V0OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleTogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBzc3JVcmw6IGxhbWJkYS5GdW5jdGlvblVybDtcbiAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG4gIHB1YmxpYyByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVNzclNpdGVQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAoIXByb3BzPy5zc3JGdW5jdGlvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCBhdXRvRGVsZXRlT2JqZWN0cyA9IHByb3BzLmF1dG9EZWxldGVPYmplY3RzID8/IGZhbHNlO1xuXG4gICAgdGhpcy5hc3NldHNCdWNrZXQgPVxuICAgICAgcHJvcHMuYXNzZXRzQnVja2V0ID8/XG4gICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQXNzZXRzQnVja2V0XCIsIHtcbiAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcbiAgICBpZiAoZW5hYmxlTG9nZ2luZykge1xuICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3QgYXNzZXRzUHJlZml4UmF3ID0gU3RyaW5nKHByb3BzLmFzc2V0c0tleVByZWZpeCA/PyBcImFzc2V0c1wiKS50cmltKCkucmVwbGFjZSgvXlxcLysvLCBcIlwiKS5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xuICAgIGNvbnN0IGFzc2V0c0tleVByZWZpeCA9IGFzc2V0c1ByZWZpeFJhdyB8fCBcImFzc2V0c1wiO1xuXG4gICAgY29uc3QgbWFuaWZlc3RSYXcgPSBTdHJpbmcocHJvcHMuYXNzZXRzTWFuaWZlc3RLZXkgPz8gYCR7YXNzZXRzS2V5UHJlZml4fS9tYW5pZmVzdC5qc29uYClcbiAgICAgIC50cmltKClcbiAgICAgIC5yZXBsYWNlKC9eXFwvKy8sIFwiXCIpXG4gICAgICAucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgICBjb25zdCBhc3NldHNNYW5pZmVzdEtleSA9IG1hbmlmZXN0UmF3IHx8IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmA7XG5cbiAgICB0aGlzLmFzc2V0c0tleVByZWZpeCA9IGFzc2V0c0tleVByZWZpeDtcbiAgICB0aGlzLmFzc2V0c01hbmlmZXN0S2V5ID0gYXNzZXRzTWFuaWZlc3RLZXk7XG5cbiAgICBpZiAocHJvcHMuYXNzZXRzUGF0aCkge1xuICAgICAgbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgXCJBc3NldHNEZXBsb3ltZW50XCIsIHtcbiAgICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldChwcm9wcy5hc3NldHNQYXRoKV0sXG4gICAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLmFzc2V0c0J1Y2tldCxcbiAgICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6IGFzc2V0c0tleVByZWZpeCxcbiAgICAgICAgcHJ1bmU6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLnNzclVybCA9IG5ldyBsYW1iZGEuRnVuY3Rpb25VcmwodGhpcywgXCJTc3JVcmxcIiwge1xuICAgICAgZnVuY3Rpb246IHByb3BzLnNzckZ1bmN0aW9uLFxuICAgICAgYXV0aFR5cGU6IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLk5PTkUsXG4gICAgICBpbnZva2VNb2RlOiBwcm9wcy5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNzckRvbWFpbk5hbWUgPSBGbi5zZWxlY3QoMiwgRm4uc3BsaXQoXCIvXCIsIHRoaXMuc3NyVXJsLnVybCkpO1xuICAgIGNvbnN0IHNzck9yaWdpbiA9IG5ldyBvcmlnaW5zLkh0dHBPcmlnaW4oc3NyRG9tYWluTmFtZSwge1xuICAgICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUFNfT05MWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFzc2V0c09yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5hc3NldHNCdWNrZXQpO1xuXG4gICAgY29uc3QgYmFzZVNzckZvcndhcmRIZWFkZXJzID0gW1xuICAgICAgXCJhY2NlcHRcIixcbiAgICAgIFwiYWNjZXB0LWxhbmd1YWdlXCIsXG4gICAgICBcImNhY2hlLWNvbnRyb2xcIixcbiAgICAgIFwiaG9zdFwiLFxuICAgICAgXCJpZi1ub25lLW1hdGNoXCIsXG4gICAgICBcInVzZXItYWdlbnRcIixcbiAgICAgIFwieC1mb3J3YXJkZWQtZm9yXCIsXG4gICAgICBcIngtZm9yd2FyZGVkLXByb3RvXCIsXG4gICAgICBcImNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvXCIsXG4gICAgICBcImNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NcIixcbiAgICBdO1xuXG4gICAgY29uc3QgZXh0cmFTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmlzQXJyYXkocHJvcHMuc3NyRm9yd2FyZEhlYWRlcnMpXG4gICAgICA/IHByb3BzLnNzckZvcndhcmRIZWFkZXJzXG4gICAgICAgICAgLm1hcCgoaGVhZGVyKSA9PiBTdHJpbmcoaGVhZGVyKS50cmltKCkudG9Mb3dlckNhc2UoKSlcbiAgICAgICAgICAuZmlsdGVyKChoZWFkZXIpID0+IGhlYWRlci5sZW5ndGggPiAwKVxuICAgICAgOiBbXTtcblxuICAgIGNvbnN0IHNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShuZXcgU2V0KFsuLi5iYXNlU3NyRm9yd2FyZEhlYWRlcnMsIC4uLmV4dHJhU3NyRm9yd2FyZEhlYWRlcnNdKSk7XG5cbiAgICBjb25zdCBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIlNzck9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZG9tYWluTmFtZSA9IFN0cmluZyhwcm9wcy5kb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKTtcblxuICAgIGxldCBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuXG4gICAgaWYgKGRvbWFpbk5hbWUpIHtcbiAgICAgIGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzID0gW2RvbWFpbk5hbWVdO1xuICAgICAgY29uc3QgY2VydEFybiA9IFN0cmluZyhwcm9wcy5jZXJ0aWZpY2F0ZUFybiA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoY2VydEFybikge1xuICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCBjZXJ0QXJuKTtcbiAgICAgIH0gZWxzZSBpZiAocHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IG5ldyBhY20uRG5zVmFsaWRhdGVkQ2VydGlmaWNhdGUodGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCB7XG4gICAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgICAgICBob3N0ZWRab25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICAgIHJlZ2lvbjogXCJ1cy1lYXN0LTFcIixcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIHByb3BzLmNlcnRpZmljYXRlQXJuIG9yIHByb3BzLmhvc3RlZFpvbmUgd2hlbiBwcm9wcy5kb21haW5OYW1lIGlzIHNldFwiKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICBjb25zdCBjcmVhdGVTdGF0aWNCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBhc3NldHNPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcbiAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhdGljUGF0aFBhdHRlcm5zID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIEFycmF5LmlzQXJyYXkocHJvcHMuc3RhdGljUGF0aFBhdHRlcm5zKVxuICAgICAgICAgID8gcHJvcHMuc3RhdGljUGF0aFBhdHRlcm5zXG4gICAgICAgICAgICAgIC5tYXAoKHBhdHRlcm4pID0+IFN0cmluZyhwYXR0ZXJuKS50cmltKCkucmVwbGFjZSgvXlxcLysvLCBcIlwiKSlcbiAgICAgICAgICAgICAgLmZpbHRlcigocGF0dGVybikgPT4gcGF0dGVybi5sZW5ndGggPiAwKVxuICAgICAgICAgIDogW10sXG4gICAgICApLFxuICAgICk7XG5cbiAgICBjb25zdCBhZGRpdGlvbmFsQmVoYXZpb3JzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucz4gPSB7XG4gICAgICBbYCR7YXNzZXRzS2V5UHJlZml4fS8qYF06IGNyZWF0ZVN0YXRpY0JlaGF2aW9yKCksXG4gICAgfTtcblxuICAgIGZvciAoY29uc3QgcGF0dGVybiBvZiBzdGF0aWNQYXRoUGF0dGVybnMpIHtcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbcGF0dGVybl0gPSBjcmVhdGVTdGF0aWNCZWhhdmlvcigpO1xuICAgIH1cblxuICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICA/IHsgZW5hYmxlTG9nZ2luZzogdHJ1ZSwgbG9nQnVja2V0OiB0aGlzLmxvZ3NCdWNrZXQsIGxvZ0ZpbGVQcmVmaXg6IFwiY2xvdWRmcm9udC9cIiB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgIDoge30pLFxuICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgIG9yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnMsXG4gICAgICAuLi4ocHJvcHMud2ViQWNsSWQgPyB7IHdlYkFjbElkOiBwcm9wcy53ZWJBY2xJZCB9IDoge30pLFxuICAgIH0pO1xuXG4gICAgaWYgKHByb3BzLndpcmVSdW50aW1lRW52ID8/IHRydWUpIHtcbiAgICAgIHRoaXMuYXNzZXRzQnVja2V0LmdyYW50UmVhZChwcm9wcy5zc3JGdW5jdGlvbik7XG5cbiAgICAgIGNvbnN0IHNzckZ1bmN0aW9uQW55ID0gcHJvcHMuc3NyRnVuY3Rpb24gYXMgYW55O1xuICAgICAgaWYgKHR5cGVvZiBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudCAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeVNzclNpdGUgd2lyZVJ1bnRpbWVFbnYgcmVxdWlyZXMgcHJvcHMuc3NyRnVuY3Rpb24gdG8gc3VwcG9ydCBhZGRFbnZpcm9ubWVudDsgcGFzcyBhIGxhbWJkYS5GdW5jdGlvbiBvciBzZXQgd2lyZVJ1bnRpbWVFbnY9ZmFsc2UgYW5kIHNldCBlbnYgdmFycyBtYW51YWxseVwiLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfQlVDS0VUXCIsIHRoaXMuYXNzZXRzQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQVNTRVRTX1BSRUZJWFwiLCBhc3NldHNLZXlQcmVmaXgpO1xuICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQVNTRVRTX01BTklGRVNUX0tFWVwiLCBhc3NldHNNYW5pZmVzdEtleSk7XG5cbiAgICAgIGNvbnN0IGNhY2hlVGFibGVOYW1lID0gU3RyaW5nKHByb3BzLmNhY2hlVGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmIChjYWNoZVRhYmxlTmFtZSkge1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGNhY2hlVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0NBQ0hFX1RBQkxFX05BTUVcIiwgY2FjaGVUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFX05BTUVcIiwgY2FjaGVUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFXCIsIGNhY2hlVGFibGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBkb21haW5OYW1lLFxuICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgfVxufVxuIl19