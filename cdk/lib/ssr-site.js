"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheorySsrSite = exports.AppTheorySsrSiteMode = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const origins = require("aws-cdk-lib/aws-cloudfront-origins");
const iam = require("aws-cdk-lib/aws-iam");
const lambda = require("aws-cdk-lib/aws-lambda");
const route53 = require("aws-cdk-lib/aws-route53");
const targets = require("aws-cdk-lib/aws-route53-targets");
const s3 = require("aws-cdk-lib/aws-s3");
const s3deploy = require("aws-cdk-lib/aws-s3-deployment");
const constructs_1 = require("constructs");
const string_utils_1 = require("./private/string-utils");
const apptheoryOriginalUriHeader = "x-apptheory-original-uri";
const facetheoryOriginalUriHeader = "x-facetheory-original-uri";
const apptheoryOriginalHostHeader = "x-apptheory-original-host";
const facetheoryOriginalHostHeader = "x-facetheory-original-host";
const ssrOriginalUriHeaders = [apptheoryOriginalUriHeader, facetheoryOriginalUriHeader];
const ssrOriginalHostHeaders = [apptheoryOriginalHostHeader, facetheoryOriginalHostHeader];
const ssgIsrHydrationPathPattern = "/_facetheory/data/*";
const defaultIsrHtmlStoreKeyPrefix = "isr";
const maxDefaultCacheKeyHeaders = 10;
var AppTheorySsrSiteMode;
(function (AppTheorySsrSiteMode) {
    /**
     * Lambda Function URL is the default origin. Direct S3 behaviors are used only for
     * immutable assets and any explicitly configured static path patterns.
     */
    AppTheorySsrSiteMode["SSR_ONLY"] = "ssr-only";
    /**
     * S3 is the primary HTML origin and Lambda SSR/ISR is the fallback. FaceTheory hydration
     * data routes are kept on S3 and the edge rewrites extensionless paths to `/index.html`.
     */
    AppTheorySsrSiteMode["SSG_ISR"] = "ssg-isr";
})(AppTheorySsrSiteMode || (exports.AppTheorySsrSiteMode = AppTheorySsrSiteMode = {}));
function pathPatternToUriPrefix(pattern) {
    const normalized = (0, string_utils_1.trimRepeatedCharStart)(String(pattern).trim(), "/").replace(/\/\*$/, "");
    return normalized ? `/${normalized}` : "/";
}
function normalizePathPatterns(patterns) {
    return Array.from(new Set((Array.isArray(patterns) ? patterns : [])
        .map((pattern) => (0, string_utils_1.trimRepeatedCharStart)(String(pattern).trim(), "/"))
        .filter((pattern) => pattern.length > 0)));
}
function expandBehaviorPathPatterns(patterns) {
    const expanded = new Set();
    for (const pattern of patterns) {
        const normalized = (0, string_utils_1.trimRepeatedCharStart)(String(pattern).trim(), "/");
        if (!normalized)
            continue;
        expanded.add(normalized);
        if (normalized.endsWith("/*")) {
            const rootPattern = normalized.slice(0, -2);
            if (rootPattern) {
                expanded.add(rootPattern);
            }
        }
    }
    return Array.from(expanded);
}
function assertNoConflictingBehaviorPatterns(label, patterns, seenOwners) {
    for (const pattern of expandBehaviorPathPatterns(patterns)) {
        const owner = seenOwners.get(pattern);
        if (owner && owner !== label) {
            throw new Error(`AppTheorySsrSite received overlapping path pattern "${pattern}" for ${owner} and ${label}`);
        }
        seenOwners.set(pattern, label);
    }
}
function generateSsrViewerRequestFunctionCode(mode, rawS3PathPatterns, lambdaPassthroughPathPatterns) {
    const rawS3Prefixes = rawS3PathPatterns.map(pathPatternToUriPrefix).sort((a, b) => b.length - a.length);
    const rawS3PrefixList = rawS3Prefixes.map((prefix) => `'${prefix}'`).join(",\n      ");
    const lambdaPassthroughPrefixes = lambdaPassthroughPathPatterns
        .map(pathPatternToUriPrefix)
        .sort((a, b) => b.length - a.length);
    const lambdaPassthroughPrefixList = lambdaPassthroughPrefixes.map((prefix) => `'${prefix}'`).join(",\n      ");
    return `
	function handler(event) {
	  var request = event.request;
	  var headers = request.headers;
	  var uri = request.uri || '/';
	  var requestIdHeader = headers['x-request-id'];
	  var requestId = requestIdHeader && requestIdHeader.value ? requestIdHeader.value.trim() : '';

	  if (!requestId) {
	    requestId = event.context && event.context.requestId ? String(event.context.requestId).trim() : '';
	  }

	  if (!requestId) {
	    requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
	  }

	  headers['x-request-id'] = { value: requestId };
	  headers['${apptheoryOriginalUriHeader}'] = { value: uri };
	  headers['${facetheoryOriginalUriHeader}'] = { value: uri };

	  if (headers.host && headers.host.value) {
	    headers['${apptheoryOriginalHostHeader}'] = { value: headers.host.value };
	    headers['${facetheoryOriginalHostHeader}'] = { value: headers.host.value };
	  }

	  if ('${mode}' === '${AppTheorySsrSiteMode.SSG_ISR}') {
	    var rawS3Prefixes = [
	      ${rawS3PrefixList}
	    ];
	    var lambdaPassthroughPrefixes = [
	      ${lambdaPassthroughPrefixList}
	    ];
	    var isLambdaPassthroughPath = false;

	    for (var i = 0; i < lambdaPassthroughPrefixes.length; i++) {
	      var prefix = lambdaPassthroughPrefixes[i];
	      if (uri === prefix || uri.startsWith(prefix + '/')) {
	        isLambdaPassthroughPath = true;
	        break;
	      }
	    }

	    if (!isLambdaPassthroughPath) {
	      var isRawS3Path = false;

	      for (var j = 0; j < rawS3Prefixes.length; j++) {
	        var rawPrefix = rawS3Prefixes[j];
	        if (uri === rawPrefix || uri.startsWith(rawPrefix + '/')) {
	          isRawS3Path = true;
	          break;
	        }
	      }

	      var lastSlash = uri.lastIndexOf('/');
	      var lastSegment = lastSlash >= 0 ? uri.substring(lastSlash + 1) : uri;

	      if (!isRawS3Path && lastSegment.indexOf('.') === -1) {
	        request.uri = uri.endsWith('/') ? uri + 'index.html' : uri + '/index.html';
	      }
	    }
	  }

	  return request;
	}
	`.trim();
}
function generateSsrViewerResponseFunctionCode() {
    return `
	function handler(event) {
	  var request = event.request;
	  var response = event.response;
	  var requestIdHeader = request.headers['x-request-id'];
	  var requestId = requestIdHeader && requestIdHeader.value ? requestIdHeader.value.trim() : '';

	  if (!requestId) {
	    requestId = event.context && event.context.requestId ? String(event.context.requestId).trim() : '';
	  }

	  if (requestId) {
	    response.headers = response.headers || {};
	    if (!response.headers['x-request-id']) {
	      response.headers['x-request-id'] = { value: requestId };
	    }
	  }

	  return response;
	}
	`.trim();
}
class AppTheorySsrSite extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        if (!props?.ssrFunction) {
            throw new Error("AppTheorySsrSite requires props.ssrFunction");
        }
        const siteMode = props.mode ?? AppTheorySsrSiteMode.SSR_ONLY;
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const autoDeleteObjects = props.autoDeleteObjects ?? false;
        const wireRuntimeEnv = props.wireRuntimeEnv ?? true;
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
                        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
                    });
        }
        const assetsPrefixRaw = (0, string_utils_1.trimRepeatedChar)(String(props.assetsKeyPrefix ?? "assets").trim(), "/");
        const assetsKeyPrefix = assetsPrefixRaw || "assets";
        const manifestRaw = String(props.assetsManifestKey ?? `${assetsKeyPrefix}/manifest.json`).trim();
        const manifestKey = (0, string_utils_1.trimRepeatedChar)(manifestRaw, "/");
        const assetsManifestKey = manifestKey || `${assetsKeyPrefix}/manifest.json`;
        this.assetsKeyPrefix = assetsKeyPrefix;
        this.assetsManifestKey = assetsManifestKey;
        const htmlStoreKeyPrefixInput = String(props.htmlStoreKeyPrefix ?? "").trim();
        const shouldConfigureHtmlStore = Boolean(props.htmlStoreBucket) || htmlStoreKeyPrefixInput.length > 0;
        if (shouldConfigureHtmlStore) {
            const htmlStorePrefixRaw = (0, string_utils_1.trimRepeatedChar)(String(props.htmlStoreKeyPrefix ?? defaultIsrHtmlStoreKeyPrefix).trim(), "/");
            this.htmlStoreKeyPrefix = htmlStorePrefixRaw || defaultIsrHtmlStoreKeyPrefix;
            this.htmlStoreBucket =
                props.htmlStoreBucket ??
                    new s3.Bucket(this, "HtmlStoreBucket", {
                        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                        encryption: s3.BucketEncryption.S3_MANAGED,
                        enforceSSL: true,
                        removalPolicy,
                        autoDeleteObjects,
                    });
        }
        this.isrMetadataTable = props.isrMetadataTable;
        const explicitIsrMetadataTableName = String(props.isrMetadataTableName ?? "").trim();
        const legacyCacheTableName = String(props.cacheTableName ?? "").trim();
        const resourceIsrMetadataTableName = String(this.isrMetadataTable?.tableName ?? "").trim();
        const configuredIsrMetadataTableNames = Array.from(new Set([resourceIsrMetadataTableName, explicitIsrMetadataTableName, legacyCacheTableName].filter((name) => String(name).trim().length > 0)));
        if (configuredIsrMetadataTableNames.length > 1) {
            throw new Error(`AppTheorySsrSite received conflicting ISR metadata table names: ${configuredIsrMetadataTableNames.join(", ")}`);
        }
        const isrMetadataTableName = configuredIsrMetadataTableNames[0] ?? "";
        if (props.assetsPath) {
            new s3deploy.BucketDeployment(this, "AssetsDeployment", {
                sources: [s3deploy.Source.asset(props.assetsPath)],
                destinationBucket: this.assetsBucket,
                destinationKeyPrefix: assetsKeyPrefix,
                prune: true,
            });
        }
        const ssrUrlAuthType = props.ssrUrlAuthType ?? lambda.FunctionUrlAuthType.AWS_IAM;
        this.ssrUrl = new lambda.FunctionUrl(this, "SsrUrl", {
            function: props.ssrFunction,
            authType: ssrUrlAuthType,
            invokeMode: props.invokeMode ?? lambda.InvokeMode.RESPONSE_STREAM,
        });
        const ssrOrigin = ssrUrlAuthType === lambda.FunctionUrlAuthType.AWS_IAM
            ? origins.FunctionUrlOrigin.withOriginAccessControl(this.ssrUrl)
            : new origins.FunctionUrlOrigin(this.ssrUrl);
        const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.assetsBucket);
        const htmlOriginBucket = this.htmlStoreBucket ?? this.assetsBucket;
        const htmlOrigin = origins.S3BucketOrigin.withOriginAccessControl(htmlOriginBucket, this.htmlStoreBucket && this.htmlStoreKeyPrefix
            ? {
                originPath: `/${this.htmlStoreKeyPrefix}`,
            }
            : undefined);
        const baseSsrForwardHeaders = [
            "cloudfront-forwarded-proto",
            "cloudfront-viewer-address",
            ...ssrOriginalHostHeaders,
            ...ssrOriginalUriHeaders,
            "x-request-id",
            "x-tenant-id",
        ];
        const disallowedSsrForwardHeaders = new Set(["host", "x-forwarded-proto"]);
        const extraSsrForwardHeaders = Array.isArray(props.ssrForwardHeaders)
            ? props.ssrForwardHeaders
                .map((header) => String(header).trim().toLowerCase())
                .filter((header) => header.length > 0)
            : [];
        const requestedDisallowedSsrForwardHeaders = Array.from(new Set(extraSsrForwardHeaders.filter((header) => disallowedSsrForwardHeaders.has(header)))).sort();
        if (requestedDisallowedSsrForwardHeaders.length > 0) {
            throw new Error(`AppTheorySsrSite disallows ssrForwardHeaders: ${requestedDisallowedSsrForwardHeaders.join(", ")}`);
        }
        const ssrForwardHeaders = Array.from(new Set([...baseSsrForwardHeaders, ...extraSsrForwardHeaders].filter((header) => !disallowedSsrForwardHeaders.has(header))));
        const htmlCacheKeyExcludedHeaders = new Set([
            "cloudfront-forwarded-proto",
            "cloudfront-viewer-address",
            ...ssrOriginalUriHeaders,
            "x-request-id",
        ]);
        const htmlCacheKeyHeaders = Array.from(new Set(ssrForwardHeaders.filter((header) => !htmlCacheKeyExcludedHeaders.has(header))));
        if (!props.htmlCachePolicy && htmlCacheKeyHeaders.length > maxDefaultCacheKeyHeaders) {
            throw new Error(`AppTheorySsrSite default htmlCachePolicy supports at most ${maxDefaultCacheKeyHeaders} cache-key headers; received ${htmlCacheKeyHeaders.length}`);
        }
        const ssrOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "SsrOriginRequestPolicy", {
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...ssrForwardHeaders),
        });
        const htmlOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "HtmlOriginRequestPolicy", {
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...ssrForwardHeaders),
        });
        const ssrCachePolicy = props.ssrCachePolicy ?? cloudfront.CachePolicy.CACHING_DISABLED;
        const htmlCachePolicy = props.htmlCachePolicy ??
            new cloudfront.CachePolicy(this, "HtmlCachePolicy", {
                comment: "FaceTheory HTML cache policy keyed by query strings and stable public variant headers",
                minTtl: aws_cdk_lib_1.Duration.seconds(0),
                defaultTtl: aws_cdk_lib_1.Duration.seconds(0),
                maxTtl: aws_cdk_lib_1.Duration.days(365),
                cookieBehavior: cloudfront.CacheCookieBehavior.none(),
                headerBehavior: cloudfront.CacheHeaderBehavior.allowList(...htmlCacheKeyHeaders),
                queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
                enableAcceptEncodingBrotli: true,
                enableAcceptEncodingGzip: true,
            });
        const staticPathPatterns = normalizePathPatterns(props.staticPathPatterns);
        const directS3PathPatterns = normalizePathPatterns([
            ...(siteMode === AppTheorySsrSiteMode.SSG_ISR ? [ssgIsrHydrationPathPattern] : []),
            ...(Array.isArray(props.directS3PathPatterns) ? props.directS3PathPatterns : []),
        ]);
        const ssrPathPatterns = normalizePathPatterns(props.ssrPathPatterns);
        const behaviorPatternOwners = new Map();
        assertNoConflictingBehaviorPatterns("direct S3 paths", [`${assetsKeyPrefix}/*`, ...directS3PathPatterns], behaviorPatternOwners);
        assertNoConflictingBehaviorPatterns("static HTML paths", staticPathPatterns, behaviorPatternOwners);
        assertNoConflictingBehaviorPatterns("direct SSR paths", ssrPathPatterns, behaviorPatternOwners);
        const viewerRequestFunction = new cloudfront.Function(this, "SsrViewerRequestFunction", {
            code: cloudfront.FunctionCode.fromInline(generateSsrViewerRequestFunctionCode(siteMode, [`${assetsKeyPrefix}/*`, ...directS3PathPatterns], ssrPathPatterns)),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            comment: siteMode === AppTheorySsrSiteMode.SSG_ISR
                ? "FaceTheory viewer-request edge context and HTML rewrite for SSR site"
                : "FaceTheory viewer-request edge context for SSR site",
        });
        const viewerResponseFunction = new cloudfront.Function(this, "SsrViewerResponseFunction", {
            code: cloudfront.FunctionCode.fromInline(generateSsrViewerResponseFunctionCode()),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            comment: "FaceTheory viewer-response request-id echo for SSR site",
        });
        const createEdgeFunctionAssociations = () => [
            {
                function: viewerRequestFunction,
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
            {
                function: viewerResponseFunction,
                eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
            },
        ];
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
        this.responseHeadersPolicy =
            props.responseHeadersPolicy ??
                new cloudfront.ResponseHeadersPolicy(this, "ResponseHeadersPolicy", {
                    comment: "FaceTheory baseline security headers (CSP stays origin-defined)",
                    securityHeadersBehavior: {
                        strictTransportSecurity: {
                            accessControlMaxAge: aws_cdk_lib_1.Duration.days(365 * 2),
                            includeSubdomains: true,
                            preload: true,
                            override: true,
                        },
                        contentTypeOptions: { override: true },
                        frameOptions: {
                            frameOption: cloudfront.HeadersFrameOption.DENY,
                            override: true,
                        },
                        referrerPolicy: {
                            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                            override: true,
                        },
                        xssProtection: {
                            protection: true,
                            modeBlock: true,
                            override: true,
                        },
                    },
                    customHeadersBehavior: {
                        customHeaders: [
                            {
                                header: "permissions-policy",
                                value: "camera=(), microphone=(), geolocation=()",
                                override: true,
                            },
                        ],
                    },
                });
        const createStaticBehavior = () => ({
            origin: assetsOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachePolicy: cloudfront.CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS,
            compress: true,
            responseHeadersPolicy: this.responseHeadersPolicy,
            functionAssociations: createEdgeFunctionAssociations(),
        });
        const createStaticHtmlBehavior = () => ({
            origin: htmlOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachePolicy: htmlCachePolicy,
            originRequestPolicy: htmlOriginRequestPolicy,
            compress: true,
            responseHeadersPolicy: this.responseHeadersPolicy,
            functionAssociations: createEdgeFunctionAssociations(),
        });
        const createSsrBehavior = () => ({
            origin: ssrOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: ssrCachePolicy,
            originRequestPolicy: ssrOriginRequestPolicy,
            responseHeadersPolicy: this.responseHeadersPolicy,
            functionAssociations: createEdgeFunctionAssociations(),
        });
        const additionalBehaviors = {};
        const addExpandedBehavior = (patterns, factory) => {
            for (const pattern of expandBehaviorPathPatterns(patterns)) {
                additionalBehaviors[pattern] = factory();
            }
        };
        addExpandedBehavior([`${assetsKeyPrefix}/*`], createStaticBehavior);
        addExpandedBehavior(directS3PathPatterns, createStaticBehavior);
        addExpandedBehavior(staticPathPatterns, createStaticHtmlBehavior);
        addExpandedBehavior(ssrPathPatterns, createSsrBehavior);
        const defaultOrigin = siteMode === AppTheorySsrSiteMode.SSG_ISR
            ? new origins.OriginGroup({
                primaryOrigin: htmlOrigin,
                fallbackOrigin: ssrOrigin,
                fallbackStatusCodes: [403, 404],
            })
            : ssrOrigin;
        const defaultAllowedMethods = siteMode === AppTheorySsrSiteMode.SSG_ISR
            ? cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS
            : cloudfront.AllowedMethods.ALLOW_ALL;
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            ...(enableLogging && this.logsBucket
                ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
                : {}),
            ...(distributionDomainNames && distributionCertificate
                ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
                : {}),
            defaultBehavior: {
                origin: defaultOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: defaultAllowedMethods,
                cachePolicy: siteMode === AppTheorySsrSiteMode.SSG_ISR ? htmlCachePolicy : ssrCachePolicy,
                originRequestPolicy: siteMode === AppTheorySsrSiteMode.SSG_ISR ? htmlOriginRequestPolicy : ssrOriginRequestPolicy,
                responseHeadersPolicy: this.responseHeadersPolicy,
                functionAssociations: createEdgeFunctionAssociations(),
            },
            additionalBehaviors,
            ...(props.webAclId ? { webAclId: props.webAclId } : {}),
        });
        if (ssrUrlAuthType === lambda.FunctionUrlAuthType.AWS_IAM) {
            props.ssrFunction.addPermission("AllowCloudFrontInvokeFunctionViaUrl", {
                action: "lambda:InvokeFunction",
                principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
                sourceArn: this.distribution.distributionArn,
                invokedViaFunctionUrl: true,
            });
        }
        if (this.htmlStoreBucket) {
            this.htmlStoreBucket.grantReadWrite(props.ssrFunction);
        }
        if (this.isrMetadataTable) {
            this.isrMetadataTable.grantReadWriteData(props.ssrFunction);
        }
        if (wireRuntimeEnv) {
            this.assetsBucket.grantRead(props.ssrFunction);
            const ssrFunctionAny = props.ssrFunction;
            if (typeof ssrFunctionAny.addEnvironment !== "function") {
                throw new Error("AppTheorySsrSite wireRuntimeEnv requires props.ssrFunction to support addEnvironment; pass a lambda.Function or set wireRuntimeEnv=false and set env vars manually");
            }
            ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_BUCKET", this.assetsBucket.bucketName);
            ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_PREFIX", assetsKeyPrefix);
            ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_MANIFEST_KEY", assetsManifestKey);
            if (this.htmlStoreBucket && this.htmlStoreKeyPrefix) {
                ssrFunctionAny.addEnvironment("FACETHEORY_ISR_BUCKET", this.htmlStoreBucket.bucketName);
                ssrFunctionAny.addEnvironment("FACETHEORY_ISR_PREFIX", this.htmlStoreKeyPrefix);
            }
            if (isrMetadataTableName) {
                ssrFunctionAny.addEnvironment("APPTHEORY_CACHE_TABLE_NAME", isrMetadataTableName);
                ssrFunctionAny.addEnvironment("FACETHEORY_CACHE_TABLE_NAME", isrMetadataTableName);
                ssrFunctionAny.addEnvironment("CACHE_TABLE_NAME", isrMetadataTableName);
                ssrFunctionAny.addEnvironment("CACHE_TABLE", isrMetadataTableName);
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
AppTheorySsrSite[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "0.24.1" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFzRDtBQUN0RCwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUU5RCwyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyREFBMkQ7QUFDM0QseUNBQXlDO0FBQ3pDLDBEQUEwRDtBQUMxRCwyQ0FBdUM7QUFFdkMseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLDRCQUE0QixHQUFHLEtBQUssQ0FBQztBQUMzQyxNQUFNLHlCQUF5QixHQUFHLEVBQUUsQ0FBQztBQUVyQyxJQUFZLG9CQVlYO0FBWkQsV0FBWSxvQkFBb0I7SUFDOUI7OztPQUdHO0lBQ0gsNkNBQXFCLENBQUE7SUFFckI7OztPQUdHO0lBQ0gsMkNBQW1CLENBQUE7QUFDckIsQ0FBQyxFQVpXLG9CQUFvQixvQ0FBcEIsb0JBQW9CLFFBWS9CO0FBRUQsU0FBUyxzQkFBc0IsQ0FBQyxPQUFlO0lBQzdDLE1BQU0sVUFBVSxHQUFHLElBQUEsb0NBQXFCLEVBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFD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QUFDO2dCQUNuRixjQUFjLENBQUMsY0FBYyxDQUFDLGtCQUFrQixFQUFFLG9CQUFvQixDQUFDLENBQUM7Z0JBQ3hFLGNBQWMsQ0FBQyxjQUFjLENBQUMsYUFBYSxFQUFFLG9CQUFvQixDQUFDLENBQUM7WUFDckUsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLFVBQVUsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDbkMsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQ3ZDLElBQUksRUFBRSxLQUFLLENBQUMsVUFBVTtnQkFDdEIsVUFBVSxFQUFFLFVBQVU7Z0JBQ3RCLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7YUFDeEYsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUVILENBQUM7O0FBamJILDRDQWtiQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uLCBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudFwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciwgdHJpbVJlcGVhdGVkQ2hhclN0YXJ0IH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuY29uc3QgYXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIgPSBcIngtYXBwdGhlb3J5LW9yaWdpbmFsLXVyaVwiO1xuY29uc3QgZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyID0gXCJ4LWZhY2V0aGVvcnktb3JpZ2luYWwtdXJpXCI7XG5jb25zdCBhcHB0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIgPSBcIngtYXBwdGhlb3J5LW9yaWdpbmFsLWhvc3RcIjtcbmNvbnN0IGZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIgPSBcIngtZmFjZXRoZW9yeS1vcmlnaW5hbC1ob3N0XCI7XG5jb25zdCBzc3JPcmlnaW5hbFVyaUhlYWRlcnMgPSBbYXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIsIGZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcl0gYXMgY29uc3Q7XG5jb25zdCBzc3JPcmlnaW5hbEhvc3RIZWFkZXJzID0gW2FwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciwgZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcl0gYXMgY29uc3Q7XG5jb25zdCBzc2dJc3JIeWRyYXRpb25QYXRoUGF0dGVybiA9IFwiL19mYWNldGhlb3J5L2RhdGEvKlwiO1xuY29uc3QgZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeCA9IFwiaXNyXCI7XG5jb25zdCBtYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzID0gMTA7XG5cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeVNzclNpdGVNb2RlIHtcbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaXMgdGhlIGRlZmF1bHQgb3JpZ2luLiBEaXJlY3QgUzMgYmVoYXZpb3JzIGFyZSB1c2VkIG9ubHkgZm9yXG4gICAqIGltbXV0YWJsZSBhc3NldHMgYW5kIGFueSBleHBsaWNpdGx5IGNvbmZpZ3VyZWQgc3RhdGljIHBhdGggcGF0dGVybnMuXG4gICAqL1xuICBTU1JfT05MWSA9IFwic3NyLW9ubHlcIixcblxuICAvKipcbiAgICogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBTU1IvSVNSIGlzIHRoZSBmYWxsYmFjay4gRmFjZVRoZW9yeSBoeWRyYXRpb25cbiAgICogZGF0YSByb3V0ZXMgYXJlIGtlcHQgb24gUzMgYW5kIHRoZSBlZGdlIHJld3JpdGVzIGV4dGVuc2lvbmxlc3MgcGF0aHMgdG8gYC9pbmRleC5odG1sYC5cbiAgICovXG4gIFNTR19JU1IgPSBcInNzZy1pc3JcIixcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5Ub1VyaVByZWZpeChwYXR0ZXJuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKS5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gIHJldHVybiBub3JtYWxpemVkID8gYC8ke25vcm1hbGl6ZWR9YCA6IFwiL1wiO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoUGF0dGVybnMocGF0dGVybnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICByZXR1cm4gQXJyYXkuZnJvbShcbiAgICBuZXcgU2V0KFxuICAgICAgKEFycmF5LmlzQXJyYXkocGF0dGVybnMpID8gcGF0dGVybnMgOiBbXSlcbiAgICAgICAgLm1hcCgocGF0dGVybikgPT4gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKSlcbiAgICAgICAgLmZpbHRlcigocGF0dGVybikgPT4gcGF0dGVybi5sZW5ndGggPiAwKSxcbiAgICApLFxuICApO1xufVxuXG5mdW5jdGlvbiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4cGFuZGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIik7XG4gICAgaWYgKCFub3JtYWxpemVkKSBjb250aW51ZTtcblxuICAgIGV4cGFuZGVkLmFkZChub3JtYWxpemVkKTtcbiAgICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICBjb25zdCByb290UGF0dGVybiA9IG5vcm1hbGl6ZWQuc2xpY2UoMCwgLTIpO1xuICAgICAgaWYgKHJvb3RQYXR0ZXJuKSB7XG4gICAgICAgIGV4cGFuZGVkLmFkZChyb290UGF0dGVybik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIEFycmF5LmZyb20oZXhwYW5kZWQpO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgbGFiZWw6IHN0cmluZyxcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBzZWVuT3duZXJzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxuKTogdm9pZCB7XG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJucykpIHtcbiAgICBjb25zdCBvd25lciA9IHNlZW5Pd25lcnMuZ2V0KHBhdHRlcm4pO1xuICAgIGlmIChvd25lciAmJiBvd25lciAhPT0gbGFiZWwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBvdmVybGFwcGluZyBwYXRoIHBhdHRlcm4gXCIke3BhdHRlcm59XCIgZm9yICR7b3duZXJ9IGFuZCAke2xhYmVsfWApO1xuICAgIH1cbiAgICBzZWVuT3duZXJzLnNldChwYXR0ZXJuLCBsYWJlbCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25Db2RlKFxuICBtb2RlOiBBcHBUaGVvcnlTc3JTaXRlTW9kZSxcbiAgcmF3UzNQYXRoUGF0dGVybnM6IHN0cmluZ1tdLFxuICBsYW1iZGFQYXNzdGhyb3VnaFBhdGhQYXR0ZXJuczogc3RyaW5nW10sXG4pOiBzdHJpbmcge1xuICBjb25zdCByYXdTM1ByZWZpeGVzID0gcmF3UzNQYXRoUGF0dGVybnMubWFwKHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgpLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpO1xuICBjb25zdCByYXdTM1ByZWZpeExpc3QgPSByYXdTM1ByZWZpeGVzLm1hcCgocHJlZml4KSA9PiBgJyR7cHJlZml4fSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zXG4gICAgLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG5cbiAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycztcblx0ICB2YXIgdXJpID0gcmVxdWVzdC51cmkgfHwgJy8nO1xuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gJ3JlcV8nICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyAnXycgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCk7XG5cdCAgfVxuXG5cdCAgaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyfSddID0geyB2YWx1ZTogdXJpIH07XG5cdCAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblxuXHQgIGlmIChoZWFkZXJzLmhvc3QgJiYgaGVhZGVycy5ob3N0LnZhbHVlKSB7XG5cdCAgICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcn0nXSA9IHsgdmFsdWU6IGhlYWRlcnMuaG9zdC52YWx1ZSB9O1xuXHQgICAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgfVxuXG5cdCAgaWYgKCcke21vZGV9JyA9PT0gJyR7QXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUn0nKSB7XG5cdCAgICB2YXIgcmF3UzNQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtyYXdTM1ByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBbXG5cdCAgICAgICR7bGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0fVxuXHQgICAgXTtcblx0ICAgIHZhciBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IGZhbHNlO1xuXG5cdCAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubGVuZ3RoOyBpKyspIHtcblx0ICAgICAgdmFyIHByZWZpeCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXNbaV07XG5cdCAgICAgIGlmICh1cmkgPT09IHByZWZpeCB8fCB1cmkuc3RhcnRzV2l0aChwcmVmaXggKyAnLycpKSB7XG5cdCAgICAgICAgaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGggPSB0cnVlO1xuXHQgICAgICAgIGJyZWFrO1xuXHQgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIGlmICghaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGgpIHtcblx0ICAgICAgdmFyIGlzUmF3UzNQYXRoID0gZmFsc2U7XG5cblx0ICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCByYXdTM1ByZWZpeGVzLmxlbmd0aDsgaisrKSB7XG5cdCAgICAgICAgdmFyIHJhd1ByZWZpeCA9IHJhd1MzUHJlZml4ZXNbal07XG5cdCAgICAgICAgaWYgKHVyaSA9PT0gcmF3UHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHJhd1ByZWZpeCArICcvJykpIHtcblx0ICAgICAgICAgIGlzUmF3UzNQYXRoID0gdHJ1ZTtcblx0ICAgICAgICAgIGJyZWFrO1xuXHQgICAgICAgIH1cblx0ICAgICAgfVxuXG5cdCAgICAgIHZhciBsYXN0U2xhc2ggPSB1cmkubGFzdEluZGV4T2YoJy8nKTtcblx0ICAgICAgdmFyIGxhc3RTZWdtZW50ID0gbGFzdFNsYXNoID49IDAgPyB1cmkuc3Vic3RyaW5nKGxhc3RTbGFzaCArIDEpIDogdXJpO1xuXG5cdCAgICAgIGlmICghaXNSYXdTM1BhdGggJiYgbGFzdFNlZ21lbnQuaW5kZXhPZignLicpID09PSAtMSkge1xuXHQgICAgICAgIHJlcXVlc3QudXJpID0gdXJpLmVuZHNXaXRoKCcvJykgPyB1cmkgKyAnaW5kZXguaHRtbCcgOiB1cmkgKyAnL2luZGV4Lmh0bWwnO1xuXHQgICAgICB9XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlcXVlc3Q7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvbkNvZGUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgcmVzcG9uc2UgPSBldmVudC5yZXNwb25zZTtcblx0ICB2YXIgcmVxdWVzdElkSGVhZGVyID0gcmVxdWVzdC5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAocmVxdWVzdElkKSB7XG5cdCAgICByZXNwb25zZS5oZWFkZXJzID0gcmVzcG9uc2UuaGVhZGVycyB8fCB7fTtcblx0ICAgIGlmICghcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10pIHtcblx0ICAgICAgcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVzcG9uc2U7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZVByb3BzIHtcbiAgcmVhZG9ubHkgc3NyRnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IGRlcGxveW1lbnQgbW9kZSBmb3IgdGhlIHNpdGUgdG9wb2xvZ3kuXG4gICAqXG4gICAqIC0gYHNzci1vbmx5YDogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpcyB0aGUgZGVmYXVsdCBvcmlnaW5cbiAgICogLSBgc3NnLWlzcmA6IFMzIGlzIHRoZSBwcmltYXJ5IEhUTUwgb3JpZ2luIGFuZCBMYW1iZGEgaXMgdGhlIGZhbGxiYWNrXG4gICAqXG4gICAqIEV4aXN0aW5nIGltcGxpY2l0IGJlaGF2aW9yIG1hcHMgdG8gYHNzci1vbmx5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFlcbiAgICovXG4gIHJlYWRvbmx5IG1vZGU/OiBBcHBUaGVvcnlTc3JTaXRlTW9kZTtcblxuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpbnZva2UgbW9kZSBmb3IgdGhlIFNTUiBvcmlnaW4uXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTVxuICAgKi9cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xuXG4gIC8qKlxuICAgKiBGdW5jdGlvbiBVUkwgYXV0aCB0eXBlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICpcbiAgICogQXBwVGhlb3J5IGRlZmF1bHRzIHRoaXMgdG8gYEFXU19JQU1gIHNvIENsb3VkRnJvbnQgcmVhY2hlcyB0aGUgU1NSIG9yaWdpblxuICAgKiB0aHJvdWdoIGEgc2lnbmVkIE9yaWdpbiBBY2Nlc3MgQ29udHJvbCBwYXRoLiBTZXQgYE5PTkVgIG9ubHkgYXMgYW4gZXhwbGljaXRcbiAgICogY29tcGF0aWJpbGl0eSBvdmVycmlkZSBmb3IgbGVnYWN5IHB1YmxpYyBGdW5jdGlvbiBVUkwgZGVwbG95bWVudHMuXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICovXG4gIHJlYWRvbmx5IHNzclVybEF1dGhUeXBlPzogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGU7XG5cbiAgcmVhZG9ubHkgYXNzZXRzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcmVhZG9ubHkgYXNzZXRzUGF0aD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4Pzogc3RyaW5nO1xuICByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgUzMgYnVja2V0IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlIChgUzNIdG1sU3RvcmVgKS5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlczpcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfQlVDS0VUYFxuICAgKiAtIGBGQUNFVEhFT1JZX0lTUl9QUkVGSVhgXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBTMyBrZXkgcHJlZml4IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlLlxuICAgKiBAZGVmYXVsdCBpc3JcbiAgICovXG4gIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBleHRlbnNpb25sZXNzIEhUTUwgc2VjdGlvbiBwYXRoIHBhdHRlcm5zIHRvIHJvdXRlIGRpcmVjdGx5IHRvIHRoZSBwcmltYXJ5IEhUTUwgUzMgb3JpZ2luLlxuICAgKlxuICAgKiBSZXF1ZXN0cyBsaWtlIGAvbWFya2V0aW5nYCBhbmQgYC9tYXJrZXRpbmcvLi4uYCBhcmUgcmV3cml0dGVuIHRvIGAvaW5kZXguaHRtbGBcbiAgICogd2l0aGluIHRoZSBzZWN0aW9uIGFuZCBzdGF5IG9uIFMzIGluc3RlYWQgb2YgZmFsbGluZyBiYWNrIHRvIExhbWJkYS5cbiAgICpcbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgSFRNTCBzZWN0aW9uIHBhdGg6IFwiL21hcmtldGluZy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YXRpY1BhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIHJhdyBTMyBvYmplY3QvZGF0YSBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBleHRlbnNpb25sZXNzIEhUTUwgcmV3cml0ZXMuXG4gICAqXG4gICAqIEluIGBzc2ctaXNyYCBtb2RlLCBgL19mYWNldGhlb3J5L2RhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseS5cbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgb2JqZWN0IHBhdGg6IFwiL2ZlZWRzLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgZGlyZWN0UzNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyB0aGUgYHNzZy1pc3JgIG9yaWdpbiBncm91cCBhbmQgcm91dGUgZGlyZWN0bHlcbiAgICogdG8gdGhlIExhbWJkYSBGdW5jdGlvbiBVUkwgd2l0aCBmdWxsIG1ldGhvZCBzdXBwb3J0LlxuICAgKlxuICAgKiBVc2UgdGhpcyBmb3Igc2FtZS1vcmlnaW4gZHluYW1pYyBwYXRocyBzdWNoIGFzIGF1dGggY2FsbGJhY2tzLCBhY3Rpb25zLCBvciBmb3JtIHBvc3RzLlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TU1IgcGF0aDogXCIvYWN0aW9ucy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHNzclBhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBUYWJsZVRoZW9yeS9EeW5hbW9EQiB0YWJsZSB1c2VkIGZvciBGYWNlVGhlb3J5IElTUiBtZXRhZGF0YSBhbmQgbGVhc2UgY29vcmRpbmF0aW9uLlxuICAgKlxuICAgKiBXaGVuIHByb3ZpZGVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBTU1IgZnVuY3Rpb24gcmVhZC93cml0ZSBhY2Nlc3MgYW5kIHdpcmVzIHRoZVxuICAgKiBtZXRhZGF0YSB0YWJsZSBhbGlhc2VzIGV4cGVjdGVkIGJ5IHRoZSBkb2N1bWVudGVkIEZhY2VUaGVvcnkgZGVwbG95bWVudCBzaGFwZS5cbiAgICovXG4gIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIElTUi9jYWNoZSBtZXRhZGF0YSB0YWJsZSBuYW1lIHRvIHdpcmUgd2hlbiB5b3UgYXJlIG5vdCBwYXNzaW5nIGBpc3JNZXRhZGF0YVRhYmxlYC5cbiAgICpcbiAgICogUHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCB3aGVuIEFwcFRoZW9yeSBzaG91bGQgYWxzbyBncmFudCBhY2Nlc3MgdG8gdGhlIFNTUiBMYW1iZGEuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGVnYWN5IGFsaWFzIGZvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgLlxuICAgKiBAZGVwcmVjYXRlZCBwcmVmZXIgYGlzck1ldGFkYXRhVGFibGVgIG9yIGBpc3JNZXRhZGF0YVRhYmxlTmFtZWBcbiAgICovXG4gIHJlYWRvbmx5IGNhY2hlVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8vIFdoZW4gdHJ1ZSAoZGVmYXVsdCksIEFwcFRoZW9yeSB3aXJlcyByZWNvbW1lbmRlZCBydW50aW1lIGVudmlyb25tZW50IHZhcmlhYmxlcyBvbnRvIHRoZSBTU1IgZnVuY3Rpb24uXG4gIHJlYWRvbmx5IHdpcmVSdW50aW1lRW52PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBoZWFkZXJzIHRvIGZvcndhcmQgdG8gdGhlIFNTUiBvcmlnaW4gKExhbWJkYSBGdW5jdGlvbiBVUkwpIHZpYSB0aGUgb3JpZ2luIHJlcXVlc3QgcG9saWN5LlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBBcHBUaGVvcnkvRmFjZVRoZW9yeS1zYWZlIGVkZ2UgY29udHJhY3QgZm9yd2FyZHMgb25seTpcbiAgICogLSBgY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9gXG4gICAqIC0gYGNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NgXG4gICAqIC0gYHgtYXBwdGhlb3J5LW9yaWdpbmFsLWhvc3RgXG4gICAqIC0gYHgtYXBwdGhlb3J5LW9yaWdpbmFsLXVyaWBcbiAgICogLSBgeC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtcmVxdWVzdC1pZGBcbiAgICogLSBgeC10ZW5hbnQtaWRgXG4gICAqXG4gICAqIFVzZSB0aGlzIHRvIG9wdCBpbiB0byBhZGRpdGlvbmFsIGFwcC1zcGVjaWZpYyBoZWFkZXJzIHN1Y2ggYXNcbiAgICogYHgtZmFjZXRoZW9yeS10ZW5hbnRgLiBgaG9zdGAgYW5kIGB4LWZvcndhcmRlZC1wcm90b2AgYXJlIHJlamVjdGVkIGJlY2F1c2VcbiAgICogdGhleSBicmVhayBvciBieXBhc3MgdGhlIHN1cHBvcnRlZCBvcmlnaW4gbW9kZWwuXG4gICAqL1xuICByZWFkb25seSBzc3JGb3J3YXJkSGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogQ2xvdWRGcm9udCByZXNwb25zZSBoZWFkZXJzIHBvbGljeSBhcHBsaWVkIHRvIFNTUiBhbmQgZGlyZWN0LVMzIGJlaGF2aW9ycy5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IHByb3Zpc2lvbnMgYSBGYWNlVGhlb3J5LWFsaWduZWQgYmFzZWxpbmUgcG9saWN5IGF0IHRoZSBDRE5cbiAgICogbGF5ZXI6IEhTVFMsIG5vc25pZmYsIGZyYW1lLW9wdGlvbnMsIHJlZmVycmVyLXBvbGljeSwgWFNTIHByb3RlY3Rpb24sIGFuZCBhXG4gICAqIHJlc3RyaWN0aXZlIHBlcm1pc3Npb25zLXBvbGljeS4gQ29udGVudC1TZWN1cml0eS1Qb2xpY3kgcmVtYWlucyBvcmlnaW4tZGVmaW5lZC5cbiAgICovXG4gIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAvKipcbiAgICogQ2FjaGUgcG9saWN5IGFwcGxpZWQgdG8gZGlyZWN0IExhbWJkYS1iYWNrZWQgU1NSIGJlaGF2aW9ycy5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgaXMgYENBQ0hJTkdfRElTQUJMRURgIHNvIGR5bmFtaWMgTGFtYmRhIHJvdXRlcyBzdGF5IHNhZmUgdW5sZXNzIHlvdVxuICAgKiBpbnRlbnRpb25hbGx5IG9wdCBpbnRvIGEgY2FjaGUgcG9saWN5IHRoYXQgbWF0Y2hlcyB5b3VyIGFwcCdzIHZhcmlhbmNlIG1vZGVsLlxuICAgKiBAZGVmYXVsdCBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRURcbiAgICovXG4gIHJlYWRvbmx5IHNzckNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgLyoqXG4gICAqIENhY2hlIHBvbGljeSBhcHBsaWVkIHRvIHRoZSBjYWNoZWFibGUgSFRNTCBiZWhhdmlvciBpbiBgc3NnLWlzcmAgbW9kZS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5IHBvbGljeSBrZXlzIG9uIHF1ZXJ5IHN0cmluZ3MgcGx1cyB0aGUgc3RhYmxlIHB1YmxpYyBIVE1MXG4gICAqIHZhcmlhbnQgaGVhZGVycyAoYHgtKi1vcmlnaW5hbC1ob3N0YCwgYHgtdGVuYW50LWlkYCwgYW5kIGFueSBleHRyYSBmb3J3YXJkZWRcbiAgICogaGVhZGVycyB5b3Ugb3B0IGludG8pIHdoaWxlIGxlYXZpbmcgY29va2llcyBvdXQgb2YgdGhlIGNhY2hlIGtleS5cbiAgICovXG4gIHJlYWRvbmx5IGh0bWxDYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZG9tYWluTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5U3NyU2l0ZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNCdWNrZXQ6IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNLZXlQcmVmaXg6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c01hbmlmZXN0S2V5OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgaHRtbFN0b3JlS2V5UHJlZml4Pzogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgc3NyVXJsOiBsYW1iZGEuRnVuY3Rpb25Vcmw7XG4gIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVNzclNpdGVQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAoIXByb3BzPy5zc3JGdW5jdGlvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBzaXRlTW9kZSA9IHByb3BzLm1vZGUgPz8gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFk7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICBjb25zdCB3aXJlUnVudGltZUVudiA9IHByb3BzLndpcmVSdW50aW1lRW52ID8/IHRydWU7XG5cbiAgICB0aGlzLmFzc2V0c0J1Y2tldCA9XG4gICAgICBwcm9wcy5hc3NldHNCdWNrZXQgPz9cbiAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJBc3NldHNCdWNrZXRcIiwge1xuICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgfSk7XG5cbiAgICBjb25zdCBlbmFibGVMb2dnaW5nID0gcHJvcHMuZW5hYmxlTG9nZ2luZyA/PyB0cnVlO1xuICAgIGlmIChlbmFibGVMb2dnaW5nKSB7XG4gICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGFzc2V0c1ByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKHByb3BzLmFzc2V0c0tleVByZWZpeCA/PyBcImFzc2V0c1wiKS50cmltKCksIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNLZXlQcmVmaXggPSBhc3NldHNQcmVmaXhSYXcgfHwgXCJhc3NldHNcIjtcblxuICAgIGNvbnN0IG1hbmlmZXN0UmF3ID0gU3RyaW5nKHByb3BzLmFzc2V0c01hbmlmZXN0S2V5ID8/IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmApLnRyaW0oKTtcbiAgICBjb25zdCBtYW5pZmVzdEtleSA9IHRyaW1SZXBlYXRlZENoYXIobWFuaWZlc3RSYXcsIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNNYW5pZmVzdEtleSA9IG1hbmlmZXN0S2V5IHx8IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmA7XG5cbiAgICB0aGlzLmFzc2V0c0tleVByZWZpeCA9IGFzc2V0c0tleVByZWZpeDtcbiAgICB0aGlzLmFzc2V0c01hbmlmZXN0S2V5ID0gYXNzZXRzTWFuaWZlc3RLZXk7XG5cbiAgICBjb25zdCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dCA9IFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHNob3VsZENvbmZpZ3VyZUh0bWxTdG9yZSA9IEJvb2xlYW4ocHJvcHMuaHRtbFN0b3JlQnVja2V0KSB8fCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dC5sZW5ndGggPiAwO1xuICAgIGlmIChzaG91bGRDb25maWd1cmVIdG1sU3RvcmUpIHtcbiAgICAgIGNvbnN0IGh0bWxTdG9yZVByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoXG4gICAgICAgIFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeCkudHJpbSgpLFxuICAgICAgICBcIi9cIixcbiAgICAgICk7XG4gICAgICB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCA9IGh0bWxTdG9yZVByZWZpeFJhdyB8fCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4O1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQgPVxuICAgICAgICBwcm9wcy5odG1sU3RvcmVCdWNrZXQgPz9cbiAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkh0bWxTdG9yZUJ1Y2tldFwiLCB7XG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLmlzck1ldGFkYXRhVGFibGUgPSBwcm9wcy5pc3JNZXRhZGF0YVRhYmxlO1xuXG4gICAgY29uc3QgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSA9IFN0cmluZyhwcm9wcy5pc3JNZXRhZGF0YVRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgbGVnYWN5Q2FjaGVUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuY2FjaGVUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHJlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcodGhpcy5pc3JNZXRhZGF0YVRhYmxlPy50YWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgY29uc3QgY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbcmVzb3VyY2VJc3JNZXRhZGF0YVRhYmxlTmFtZSwgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSwgbGVnYWN5Q2FjaGVUYWJsZU5hbWVdLmZpbHRlcihcbiAgICAgICAgICAobmFtZSkgPT4gU3RyaW5nKG5hbWUpLnRyaW0oKS5sZW5ndGggPiAwLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICApO1xuXG4gICAgaWYgKGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMubGVuZ3RoID4gMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBjb25mbGljdGluZyBJU1IgbWV0YWRhdGEgdGFibGUgbmFtZXM6ICR7Y29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgaXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzWzBdID8/IFwiXCI7XG5cbiAgICBpZiAocHJvcHMuYXNzZXRzUGF0aCkge1xuICAgICAgbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgXCJBc3NldHNEZXBsb3ltZW50XCIsIHtcbiAgICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldChwcm9wcy5hc3NldHNQYXRoKV0sXG4gICAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLmFzc2V0c0J1Y2tldCxcbiAgICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6IGFzc2V0c0tleVByZWZpeCxcbiAgICAgICAgcHJ1bmU6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBzc3JVcmxBdXRoVHlwZSA9IHByb3BzLnNzclVybEF1dGhUeXBlID8/IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU07XG5cbiAgICB0aGlzLnNzclVybCA9IG5ldyBsYW1iZGEuRnVuY3Rpb25VcmwodGhpcywgXCJTc3JVcmxcIiwge1xuICAgICAgZnVuY3Rpb246IHByb3BzLnNzckZ1bmN0aW9uLFxuICAgICAgYXV0aFR5cGU6IHNzclVybEF1dGhUeXBlLFxuICAgICAgaW52b2tlTW9kZTogcHJvcHMuaW52b2tlTW9kZSA/PyBsYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzc3JPcmlnaW4gPVxuICAgICAgc3NyVXJsQXV0aFR5cGUgPT09IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICAgICAgPyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuc3NyVXJsKVxuICAgICAgICA6IG5ldyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luKHRoaXMuc3NyVXJsKTtcblxuICAgIGNvbnN0IGFzc2V0c09yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5hc3NldHNCdWNrZXQpO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5CdWNrZXQgPSB0aGlzLmh0bWxTdG9yZUJ1Y2tldCA/PyB0aGlzLmFzc2V0c0J1Y2tldDtcbiAgICBjb25zdCBodG1sT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChcbiAgICAgIGh0bWxPcmlnaW5CdWNrZXQsXG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldCAmJiB0aGlzLmh0bWxTdG9yZUtleVByZWZpeFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIG9yaWdpblBhdGg6IGAvJHt0aGlzLmh0bWxTdG9yZUtleVByZWZpeH1gLFxuICAgICAgICAgIH1cbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgKTtcblxuICAgIGNvbnN0IGJhc2VTc3JGb3J3YXJkSGVhZGVycyA9IFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxIb3N0SGVhZGVycyxcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgICBcIngtdGVuYW50LWlkXCIsXG4gICAgXTtcblxuICAgIGNvbnN0IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IG5ldyBTZXQoW1wiaG9zdFwiLCBcIngtZm9yd2FyZGVkLXByb3RvXCJdKTtcblxuICAgIGNvbnN0IGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5pc0FycmF5KHByb3BzLnNzckZvcndhcmRIZWFkZXJzKVxuICAgICAgPyBwcm9wcy5zc3JGb3J3YXJkSGVhZGVyc1xuICAgICAgICAgIC5tYXAoKGhlYWRlcikgPT4gU3RyaW5nKGhlYWRlcikudHJpbSgpLnRvTG93ZXJDYXNlKCkpXG4gICAgICAgICAgLmZpbHRlcigoaGVhZGVyKSA9PiBoZWFkZXIubGVuZ3RoID4gMClcbiAgICAgIDogW107XG5cbiAgICBjb25zdCByZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChleHRyYVNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiBkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuaGFzKGhlYWRlcikpKSxcbiAgICApLnNvcnQoKTtcblxuICAgIGlmIChyZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBkaXNhbGxvd3Mgc3NyRm9yd2FyZEhlYWRlcnM6ICR7cmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbLi4uYmFzZVNzckZvcndhcmRIZWFkZXJzLCAuLi5leHRyYVNzckZvcndhcmRIZWFkZXJzXS5maWx0ZXIoXG4gICAgICAgICAgKGhlYWRlcikgPT4gIWRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMgPSBuZXcgU2V0KFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoc3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+ICFodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMuaGFzKGhlYWRlcikpKSxcbiAgICApO1xuXG4gICAgaWYgKCFwcm9wcy5odG1sQ2FjaGVQb2xpY3kgJiYgaHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGggPiBtYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRlZmF1bHQgaHRtbENhY2hlUG9saWN5IHN1cHBvcnRzIGF0IG1vc3QgJHttYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzfSBjYWNoZS1rZXkgaGVhZGVyczsgcmVjZWl2ZWQgJHtodG1sQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aH1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIlNzck9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIkh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5zc3JGb3J3YXJkSGVhZGVycyksXG4gICAgfSk7XG4gICAgY29uc3Qgc3NyQ2FjaGVQb2xpY3kgPSBwcm9wcy5zc3JDYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQ7XG4gICAgY29uc3QgaHRtbENhY2hlUG9saWN5ID1cbiAgICAgIHByb3BzLmh0bWxDYWNoZVBvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJIdG1sQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgSFRNTCBjYWNoZSBwb2xpY3kga2V5ZWQgYnkgcXVlcnkgc3RyaW5ncyBhbmQgc3RhYmxlIHB1YmxpYyB2YXJpYW50IGhlYWRlcnNcIixcbiAgICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBtYXhUdGw6IER1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmh0bWxDYWNoZUtleUhlYWRlcnMpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nR3ppcDogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhdGljUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKHByb3BzLnN0YXRpY1BhdGhQYXR0ZXJucyk7XG4gICAgY29uc3QgZGlyZWN0UzNQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMoW1xuICAgICAgLi4uKHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gW3NzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zKSA/IHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IHNzclBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhwcm9wcy5zc3JQYXRoUGF0dGVybnMpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybk93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcImRpcmVjdCBTMyBwYXRoc1wiLCBbYCR7YXNzZXRzS2V5UHJlZml4fS8qYCwgLi4uZGlyZWN0UzNQYXRoUGF0dGVybnNdLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMpO1xuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFwic3RhdGljIEhUTUwgcGF0aHNcIiwgc3RhdGljUGF0aFBhdHRlcm5zLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMpO1xuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFwiZGlyZWN0IFNTUiBwYXRoc1wiLCBzc3JQYXRoUGF0dGVybnMsIGJlaGF2aW9yUGF0dGVybk93bmVycyk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXF1ZXN0RnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlcXVlc3RGdW5jdGlvblwiLCB7XG4gICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKFxuICAgICAgICBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoc2l0ZU1vZGUsIFtgJHthc3NldHNLZXlQcmVmaXh9LypgLCAuLi5kaXJlY3RTM1BhdGhQYXR0ZXJuc10sIHNzclBhdGhQYXR0ZXJucyksXG4gICAgICApLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDpcbiAgICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgICA/IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgYW5kIEhUTUwgcmV3cml0ZSBmb3IgU1NSIHNpdGVcIlxuICAgICAgICAgIDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXF1ZXN0IGVkZ2UgY29udGV4dCBmb3IgU1NSIHNpdGVcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShnZW5lcmF0ZVNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25Db2RlKCkpLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXNwb25zZSByZXF1ZXN0LWlkIGVjaG8gZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMgPSAoKTogY2xvdWRmcm9udC5GdW5jdGlvbkFzc29jaWF0aW9uW10gPT4gW1xuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVxdWVzdEZ1bmN0aW9uLFxuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVzcG9uc2VGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVNQT05TRSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCk7XG5cbiAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcbiAgICAgIGNvbnN0IGNlcnRBcm4gPSBTdHJpbmcocHJvcHMuY2VydGlmaWNhdGVBcm4gPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGNlcnRBcm4pIHtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwgY2VydEFybik7XG4gICAgICB9IGVsc2UgaWYgKHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBuZXcgYWNtLkRuc1ZhbGlkYXRlZENlcnRpZmljYXRlKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwge1xuICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgaG9zdGVkWm9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICByZWdpb246IFwidXMtZWFzdC0xXCIsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5jZXJ0aWZpY2F0ZUFybiBvciBwcm9wcy5ob3N0ZWRab25lIHdoZW4gcHJvcHMuZG9tYWluTmFtZSBpcyBzZXRcIik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlO1xuXG4gICAgdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICBuZXcgY2xvdWRmcm9udC5SZXNwb25zZUhlYWRlcnNQb2xpY3kodGhpcywgXCJSZXNwb25zZUhlYWRlcnNQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgYmFzZWxpbmUgc2VjdXJpdHkgaGVhZGVycyAoQ1NQIHN0YXlzIG9yaWdpbi1kZWZpbmVkKVwiLFxuICAgICAgICBzZWN1cml0eUhlYWRlcnNCZWhhdmlvcjoge1xuICAgICAgICAgIHN0cmljdFRyYW5zcG9ydFNlY3VyaXR5OiB7XG4gICAgICAgICAgICBhY2Nlc3NDb250cm9sTWF4QWdlOiBEdXJhdGlvbi5kYXlzKDM2NSAqIDIpLFxuICAgICAgICAgICAgaW5jbHVkZVN1YmRvbWFpbnM6IHRydWUsXG4gICAgICAgICAgICBwcmVsb2FkOiB0cnVlLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBjb250ZW50VHlwZU9wdGlvbnM6IHsgb3ZlcnJpZGU6IHRydWUgfSxcbiAgICAgICAgICBmcmFtZU9wdGlvbnM6IHtcbiAgICAgICAgICAgIGZyYW1lT3B0aW9uOiBjbG91ZGZyb250LkhlYWRlcnNGcmFtZU9wdGlvbi5ERU5ZLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZWZlcnJlclBvbGljeToge1xuICAgICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IGNsb3VkZnJvbnQuSGVhZGVyc1JlZmVycmVyUG9saWN5LlNUUklDVF9PUklHSU5fV0hFTl9DUk9TU19PUklHSU4sXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHhzc1Byb3RlY3Rpb246IHtcbiAgICAgICAgICAgIHByb3RlY3Rpb246IHRydWUsXG4gICAgICAgICAgICBtb2RlQmxvY2s6IHRydWUsXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBjdXN0b21IZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICBjdXN0b21IZWFkZXJzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGhlYWRlcjogXCJwZXJtaXNzaW9ucy1wb2xpY3lcIixcbiAgICAgICAgICAgICAgdmFsdWU6IFwiY2FtZXJhPSgpLCBtaWNyb3Bob25lPSgpLCBnZW9sb2NhdGlvbj0oKVwiLFxuICAgICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlU3RhdGljQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogYXNzZXRzT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuVVNFX09SSUdJTl9DQUNIRV9DT05UUk9MX0hFQURFUlMsXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogaHRtbENhY2hlUG9saWN5LFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogaHRtbE9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3NyQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICBjYWNoZVBvbGljeTogc3NyQ2FjaGVQb2xpY3ksXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuICAgIGNvbnN0IGFkZEV4cGFuZGVkQmVoYXZpb3IgPSAocGF0dGVybnM6IHN0cmluZ1tdLCBmYWN0b3J5OiAoKSA9PiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyk6IHZvaWQgPT4ge1xuICAgICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW3BhdHRlcm5dID0gZmFjdG9yeSgpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKFtgJHthc3NldHNLZXlQcmVmaXh9LypgXSwgY3JlYXRlU3RhdGljQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoZGlyZWN0UzNQYXRoUGF0dGVybnMsIGNyZWF0ZVN0YXRpY0JlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHN0YXRpY1BhdGhQYXR0ZXJucywgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHNzclBhdGhQYXR0ZXJucywgY3JlYXRlU3NyQmVoYXZpb3IpO1xuXG4gICAgY29uc3QgZGVmYXVsdE9yaWdpbiA9XG4gICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICA/IG5ldyBvcmlnaW5zLk9yaWdpbkdyb3VwKHtcbiAgICAgICAgICAgIHByaW1hcnlPcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICAgICAgICBmYWxsYmFja09yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgICAgICAgZmFsbGJhY2tTdGF0dXNDb2RlczogWzQwMywgNDA0XSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IHNzck9yaWdpbjtcbiAgICBjb25zdCBkZWZhdWx0QWxsb3dlZE1ldGhvZHMgPVxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgPyBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlNcbiAgICAgICAgOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTDtcblxuICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICA/IHsgZW5hYmxlTG9nZ2luZzogdHJ1ZSwgbG9nQnVja2V0OiB0aGlzLmxvZ3NCdWNrZXQsIGxvZ0ZpbGVQcmVmaXg6IFwiY2xvdWRmcm9udC9cIiB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgIDoge30pLFxuICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgIG9yaWdpbjogZGVmYXVsdE9yaWdpbixcbiAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgIGFsbG93ZWRNZXRob2RzOiBkZWZhdWx0QWxsb3dlZE1ldGhvZHMsXG4gICAgICAgIGNhY2hlUG9saWN5OiBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IGh0bWxDYWNoZVBvbGljeSA6IHNzckNhY2hlUG9saWN5LFxuICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5IDogc3NyT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnMsXG4gICAgICAuLi4ocHJvcHMud2ViQWNsSWQgPyB7IHdlYkFjbElkOiBwcm9wcy53ZWJBY2xJZCB9IDoge30pLFxuICAgIH0pO1xuXG4gICAgaWYgKHNzclVybEF1dGhUeXBlID09PSBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNKSB7XG4gICAgICBwcm9wcy5zc3JGdW5jdGlvbi5hZGRQZXJtaXNzaW9uKFwiQWxsb3dDbG91ZEZyb250SW52b2tlRnVuY3Rpb25WaWFVcmxcIiwge1xuICAgICAgICBhY3Rpb246IFwibGFtYmRhOkludm9rZUZ1bmN0aW9uXCIsXG4gICAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiY2xvdWRmcm9udC5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgICBzb3VyY2VBcm46IHRoaXMuZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkFybixcbiAgICAgICAgaW52b2tlZFZpYUZ1bmN0aW9uVXJsOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0KSB7XG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldC5ncmFudFJlYWRXcml0ZShwcm9wcy5zc3JGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaXNyTWV0YWRhdGFUYWJsZSkge1xuICAgICAgdGhpcy5pc3JNZXRhZGF0YVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5zc3JGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHdpcmVSdW50aW1lRW52KSB7XG4gICAgICB0aGlzLmFzc2V0c0J1Y2tldC5ncmFudFJlYWQocHJvcHMuc3NyRnVuY3Rpb24pO1xuXG4gICAgICBjb25zdCBzc3JGdW5jdGlvbkFueSA9IHByb3BzLnNzckZ1bmN0aW9uIGFzIGFueTtcbiAgICAgIGlmICh0eXBlb2Ygc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlTc3JTaXRlIHdpcmVSdW50aW1lRW52IHJlcXVpcmVzIHByb3BzLnNzckZ1bmN0aW9uIHRvIHN1cHBvcnQgYWRkRW52aXJvbm1lbnQ7IHBhc3MgYSBsYW1iZGEuRnVuY3Rpb24gb3Igc2V0IHdpcmVSdW50aW1lRW52PWZhbHNlIGFuZCBzZXQgZW52IHZhcnMgbWFudWFsbHlcIixcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQVNTRVRTX0JVQ0tFVFwiLCB0aGlzLmFzc2V0c0J1Y2tldC5idWNrZXROYW1lKTtcbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19QUkVGSVhcIiwgYXNzZXRzS2V5UHJlZml4KTtcbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19NQU5JRkVTVF9LRVlcIiwgYXNzZXRzTWFuaWZlc3RLZXkpO1xuXG4gICAgICBpZiAodGhpcy5odG1sU3RvcmVCdWNrZXQgJiYgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXgpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0lTUl9CVUNLRVRcIiwgdGhpcy5odG1sU3RvcmVCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfUFJFRklYXCIsIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KTtcbiAgICAgIH1cbiAgICAgIGlmIChpc3JNZXRhZGF0YVRhYmxlTmFtZSkge1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0NBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBkb21haW5OYW1lLFxuICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgfVxufVxuIl19