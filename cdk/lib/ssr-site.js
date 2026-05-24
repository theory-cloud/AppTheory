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
const ssgIsrSsrDataPathPattern = "/_facetheory/ssr-data/*";
const defaultIsrHtmlStoreKeyPrefix = "isr";
const maxDefaultCacheKeyHeaders = 10;
const defaultViewerTenantHeader = "x-tenant-id";
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
function canonicalizeHeaderName(header) {
    return String(header).trim().toLowerCase();
}
function isTenantHeaderName(header) {
    const normalized = canonicalizeHeaderName(header).replace(/[^a-z0-9]+/g, "-");
    return normalized === defaultViewerTenantHeader || /(^|-)tenant(-|$)/.test(normalized);
}
function generateSsrViewerRequestFunctionCode(mode, rawS3PathPatterns, lambdaPassthroughPathPatterns, blockedViewerTenantHeaders) {
    const rawS3Prefixes = rawS3PathPatterns.map(pathPatternToUriPrefix).sort((a, b) => b.length - a.length);
    const rawS3PrefixList = rawS3Prefixes.map((prefix) => `'${prefix}'`).join(",\n      ");
    const lambdaPassthroughPrefixes = lambdaPassthroughPathPatterns
        .map(pathPatternToUriPrefix)
        .sort((a, b) => b.length - a.length);
    const lambdaPassthroughPrefixList = lambdaPassthroughPrefixes.map((prefix) => `'${prefix}'`).join(",\n      ");
    const blockedViewerTenantHeaderList = blockedViewerTenantHeaders.map((header) => `'${header}'`).join(",\n      ");
    return `
	function handler(event) {
	  var request = event.request;
	  request.headers = request.headers || {};
	  var headers = request.headers;
	  var uri = request.uri || '/';
	  var blockedViewerTenantHeaders = [
	    ${blockedViewerTenantHeaderList}
	  ];

	  for (var blockedIndex = 0; blockedIndex < blockedViewerTenantHeaders.length; blockedIndex++) {
	    delete headers[blockedViewerTenantHeaders[blockedIndex]];
	  }

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
        const staticPathPatterns = normalizePathPatterns(props.staticPathPatterns);
        const directS3PathPatterns = normalizePathPatterns([
            ...(siteMode === AppTheorySsrSiteMode.SSG_ISR ? [ssgIsrHydrationPathPattern] : []),
            ...(Array.isArray(props.directS3PathPatterns) ? props.directS3PathPatterns : []),
        ]);
        const ssrPathPatterns = normalizePathPatterns([
            ...(siteMode === AppTheorySsrSiteMode.SSG_ISR ? [ssgIsrSsrDataPathPattern] : []),
            ...(Array.isArray(props.ssrPathPatterns) ? props.ssrPathPatterns : []),
        ]);
        const bearerFunctionUrlOrigins = Array.isArray(props.bearerFunctionUrlOrigins)
            ? props.bearerFunctionUrlOrigins
            : [];
        const bearerFunctionUrlOriginConfigs = bearerFunctionUrlOrigins.map((origin, index) => {
            if (!origin?.function) {
                throw new Error(`AppTheorySsrSite bearerFunctionUrlOrigins[${index}] requires function`);
            }
            const pathPatterns = normalizePathPatterns(origin.pathPatterns);
            if (pathPatterns.length === 0) {
                throw new Error(`AppTheorySsrSite bearerFunctionUrlOrigins[${index}] requires at least one path pattern`);
            }
            return { origin, pathPatterns };
        });
        const bearerFunctionUrlPathPatterns = bearerFunctionUrlOriginConfigs.flatMap((config) => config.pathPatterns);
        const behaviorPatternOwners = new Map();
        const ssrUrlAuthType = props.ssrUrlAuthType ?? lambda.FunctionUrlAuthType.AWS_IAM;
        const allowViewerTenantHeaders = props.allowViewerTenantHeaders ?? false;
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
        ];
        const disallowedSsrForwardHeaders = new Set(["host", "x-forwarded-proto"]);
        const extraSsrForwardHeaders = Array.isArray(props.ssrForwardHeaders)
            ? props.ssrForwardHeaders.map(canonicalizeHeaderName).filter((header) => header.length > 0)
            : [];
        const requestedDisallowedSsrForwardHeaders = Array.from(new Set(extraSsrForwardHeaders.filter((header) => disallowedSsrForwardHeaders.has(header)))).sort();
        if (requestedDisallowedSsrForwardHeaders.length > 0) {
            throw new Error(`AppTheorySsrSite disallows ssrForwardHeaders: ${requestedDisallowedSsrForwardHeaders.join(", ")}`);
        }
        const requestedTenantSsrForwardHeaders = Array.from(new Set(extraSsrForwardHeaders.filter((header) => isTenantHeaderName(header)))).sort();
        if (requestedTenantSsrForwardHeaders.length > 0 && !allowViewerTenantHeaders) {
            throw new Error(`AppTheorySsrSite requires allowViewerTenantHeaders=true for tenant-like ssrForwardHeaders: ${requestedTenantSsrForwardHeaders.join(", ")}`);
        }
        const tenantPassthroughHeaders = allowViewerTenantHeaders
            ? Array.from(new Set([defaultViewerTenantHeader, ...requestedTenantSsrForwardHeaders]))
            : [];
        const blockedViewerTenantHeaders = allowViewerTenantHeaders
            ? []
            : Array.from(new Set([defaultViewerTenantHeader, ...requestedTenantSsrForwardHeaders])).sort();
        const ssrForwardHeaders = Array.from(new Set([...baseSsrForwardHeaders, ...tenantPassthroughHeaders, ...extraSsrForwardHeaders].filter((header) => !disallowedSsrForwardHeaders.has(header))));
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
        assertNoConflictingBehaviorPatterns("direct S3 paths", [`${assetsKeyPrefix}/*`, ...directS3PathPatterns], behaviorPatternOwners);
        assertNoConflictingBehaviorPatterns("static HTML paths", staticPathPatterns, behaviorPatternOwners);
        assertNoConflictingBehaviorPatterns("direct SSR paths", ssrPathPatterns, behaviorPatternOwners);
        bearerFunctionUrlOriginConfigs.forEach((config, index) => {
            assertNoConflictingBehaviorPatterns(`bearer Function URL co-origin ${index + 1}`, config.pathPatterns, behaviorPatternOwners);
        });
        const viewerRequestFunction = new cloudfront.Function(this, "SsrViewerRequestFunction", {
            code: cloudfront.FunctionCode.fromInline(generateSsrViewerRequestFunctionCode(siteMode, [`${assetsKeyPrefix}/*`, ...directS3PathPatterns], [...ssrPathPatterns, ...bearerFunctionUrlPathPatterns], blockedViewerTenantHeaders)),
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
        this.bearerFunctionUrls = [];
        bearerFunctionUrlOriginConfigs.forEach((config, index) => {
            const functionUrl = new lambda.FunctionUrl(this, `BearerFunctionUrl${index + 1}`, {
                function: config.origin.function,
                authType: lambda.FunctionUrlAuthType.NONE,
                invokeMode: config.origin.invokeMode ?? lambda.InvokeMode.BUFFERED,
            });
            this.bearerFunctionUrls.push(functionUrl);
            const functionUrlOrigin = new origins.FunctionUrlOrigin(functionUrl);
            const createBearerFunctionUrlBehavior = () => ({
                origin: functionUrlOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                responseHeadersPolicy: this.responseHeadersPolicy,
                functionAssociations: createEdgeFunctionAssociations(),
            });
            addExpandedBehavior(config.pathPatterns, createBearerFunctionUrlBehavior);
        });
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
AppTheorySsrSite[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "1.8.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFzRDtBQUN0RCwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUU5RCwyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyREFBMkQ7QUFDM0QseUNBQXlDO0FBQ3pDLDBEQUEwRDtBQUMxRCwyQ0FBdUM7QUFFdkMseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLHlCQUF5QixDQUFDO0FBQzNELE1BQU0sNEJBQTRCLEdBQUcsS0FBSyxDQUFDO0FBQzNDLE1BQU0seUJBQXlCLEdBQUcsRUFBRSxDQUFDO0FBQ3JDLE1BQU0seUJBQXlCLEdBQUcsYUFBYSxDQUFDO0FBRWhELElBQVksb0JBWVg7QUFaRCxXQUFZLG9CQUFvQjtJQUM5Qjs7O09BR0c7SUFDSCw2Q0FBcUIsQ0FBQTtJQUVyQjs7O09BR0c7SUFDSCwyQ0FBbUIsQ0FBQTtBQUNyQixDQUFDLEVBWlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFZL0I7QUFFRCxTQUFTLHNCQUFzQixDQUFDLE9BQWU7SUFDN0MsTUFBTSxVQUFVLEdBQUcsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLENBQUMsT0FBTyxD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K0IsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO1lBRWxGLElBQUksSUFBSSxDQUFDLGVBQWUsSUFBSSxJQUFJLENBQUMsa0JBQWtCLEVBQUUsQ0FBQztnQkFDcEQsY0FBYyxDQUFDLGNBQWMsQ0FBQyx1QkFBdUIsRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUN4RixjQUFjLENBQUMsY0FBYyxDQUFDLHVCQUF1QixFQUFFLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1lBQ2xGLENBQUM7WUFDRCxJQUFJLG9CQUFvQixFQUFFLENBQUM7Z0JBQ3pCLGNBQWMsQ0FBQyxjQUFjLENBQUMsNEJBQTRCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztnQkFDbEYsY0FBYyxDQUFDLGNBQWMsQ0FBQyw2QkFBNkIsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO2dCQUNuRixjQUFjLENBQUMsY0FBYyxDQUFDLGtCQUFrQixFQUFFLG9CQUFvQixDQUFDLENBQUM7Z0JBQ3hFLGNBQWMsQ0FBQyxjQUFjLENBQUMsYUFBYSxFQUFFLG9CQUFvQixDQUFDLENBQUM7WUFDckUsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLFVBQVUsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDbkMsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQ3ZDLElBQUksRUFBRSxLQUFLLENBQUMsVUFBVTtnQkFDdEIsVUFBVSxFQUFFLFVBQVU7Z0JBQ3RCLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7YUFDeEYsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUVILENBQUM7O0FBamZILDRDQWtmQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uLCBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudFwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciwgdHJpbVJlcGVhdGVkQ2hhclN0YXJ0IH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuY29uc3QgYXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIgPSBcIngtYXBwdGhlb3J5LW9yaWdpbmFsLXVyaVwiO1xuY29uc3QgZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyID0gXCJ4LWZhY2V0aGVvcnktb3JpZ2luYWwtdXJpXCI7XG5jb25zdCBhcHB0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIgPSBcIngtYXBwdGhlb3J5LW9yaWdpbmFsLWhvc3RcIjtcbmNvbnN0IGZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIgPSBcIngtZmFjZXRoZW9yeS1vcmlnaW5hbC1ob3N0XCI7XG5jb25zdCBzc3JPcmlnaW5hbFVyaUhlYWRlcnMgPSBbYXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIsIGZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcl0gYXMgY29uc3Q7XG5jb25zdCBzc3JPcmlnaW5hbEhvc3RIZWFkZXJzID0gW2FwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciwgZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcl0gYXMgY29uc3Q7XG5jb25zdCBzc2dJc3JIeWRyYXRpb25QYXRoUGF0dGVybiA9IFwiL19mYWNldGhlb3J5L2RhdGEvKlwiO1xuY29uc3Qgc3NnSXNyU3NyRGF0YVBhdGhQYXR0ZXJuID0gXCIvX2ZhY2V0aGVvcnkvc3NyLWRhdGEvKlwiO1xuY29uc3QgZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeCA9IFwiaXNyXCI7XG5jb25zdCBtYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzID0gMTA7XG5jb25zdCBkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyID0gXCJ4LXRlbmFudC1pZFwiO1xuXG5leHBvcnQgZW51bSBBcHBUaGVvcnlTc3JTaXRlTW9kZSB7XG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGlzIHRoZSBkZWZhdWx0IG9yaWdpbi4gRGlyZWN0IFMzIGJlaGF2aW9ycyBhcmUgdXNlZCBvbmx5IGZvclxuICAgKiBpbW11dGFibGUgYXNzZXRzIGFuZCBhbnkgZXhwbGljaXRseSBjb25maWd1cmVkIHN0YXRpYyBwYXRoIHBhdHRlcm5zLlxuICAgKi9cbiAgU1NSX09OTFkgPSBcInNzci1vbmx5XCIsXG5cbiAgLyoqXG4gICAqIFMzIGlzIHRoZSBwcmltYXJ5IEhUTUwgb3JpZ2luIGFuZCBMYW1iZGEgU1NSL0lTUiBpcyB0aGUgZmFsbGJhY2suIEZhY2VUaGVvcnkgaHlkcmF0aW9uXG4gICAqIGRhdGEgcm91dGVzIGFyZSBrZXB0IG9uIFMzIGFuZCB0aGUgZWRnZSByZXdyaXRlcyBleHRlbnNpb25sZXNzIHBhdGhzIHRvIGAvaW5kZXguaHRtbGAuXG4gICAqL1xuICBTU0dfSVNSID0gXCJzc2ctaXNyXCIsXG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgocGF0dGVybjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIikucmVwbGFjZSgvXFwvXFwqJC8sIFwiXCIpO1xuICByZXR1cm4gbm9ybWFsaXplZCA/IGAvJHtub3JtYWxpemVkfWAgOiBcIi9cIjtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUGF0aFBhdHRlcm5zKHBhdHRlcm5zOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIEFycmF5LmZyb20oXG4gICAgbmV3IFNldChcbiAgICAgIChBcnJheS5pc0FycmF5KHBhdHRlcm5zKSA/IHBhdHRlcm5zIDogW10pXG4gICAgICAgIC5tYXAoKHBhdHRlcm4pID0+IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIikpXG4gICAgICAgIC5maWx0ZXIoKHBhdHRlcm4pID0+IHBhdHRlcm4ubGVuZ3RoID4gMCksXG4gICAgKSxcbiAgKTtcbn1cblxuZnVuY3Rpb24gZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBleHBhbmRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBwYXR0ZXJucykge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSB0cmltUmVwZWF0ZWRDaGFyU3RhcnQoU3RyaW5nKHBhdHRlcm4pLnRyaW0oKSwgXCIvXCIpO1xuICAgIGlmICghbm9ybWFsaXplZCkgY29udGludWU7XG5cbiAgICBleHBhbmRlZC5hZGQobm9ybWFsaXplZCk7XG4gICAgaWYgKG5vcm1hbGl6ZWQuZW5kc1dpdGgoXCIvKlwiKSkge1xuICAgICAgY29uc3Qgcm9vdFBhdHRlcm4gPSBub3JtYWxpemVkLnNsaWNlKDAsIC0yKTtcbiAgICAgIGlmIChyb290UGF0dGVybikge1xuICAgICAgICBleHBhbmRlZC5hZGQocm9vdFBhdHRlcm4pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBBcnJheS5mcm9tKGV4cGFuZGVkKTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgc2Vlbk93bmVyczogTWFwPHN0cmluZywgc3RyaW5nPixcbik6IHZvaWQge1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnMpKSB7XG4gICAgY29uc3Qgb3duZXIgPSBzZWVuT3duZXJzLmdldChwYXR0ZXJuKTtcbiAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IGxhYmVsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJuIFwiJHtwYXR0ZXJufVwiIGZvciAke293bmVyfSBhbmQgJHtsYWJlbH1gKTtcbiAgICB9XG4gICAgc2Vlbk93bmVycy5zZXQocGF0dGVybiwgbGFiZWwpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNhbm9uaWNhbGl6ZUhlYWRlck5hbWUoaGVhZGVyOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKGhlYWRlcikudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG59XG5cbmZ1bmN0aW9uIGlzVGVuYW50SGVhZGVyTmFtZShoZWFkZXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBub3JtYWxpemVkID0gY2Fub25pY2FsaXplSGVhZGVyTmFtZShoZWFkZXIpLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpO1xuICByZXR1cm4gbm9ybWFsaXplZCA9PT0gZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciB8fCAvKF58LSl0ZW5hbnQoLXwkKS8udGVzdChub3JtYWxpemVkKTtcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25Db2RlKFxuICBtb2RlOiBBcHBUaGVvcnlTc3JTaXRlTW9kZSxcbiAgcmF3UzNQYXRoUGF0dGVybnM6IHN0cmluZ1tdLFxuICBsYW1iZGFQYXNzdGhyb3VnaFBhdGhQYXR0ZXJuczogc3RyaW5nW10sXG4gIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzOiBzdHJpbmdbXSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHJhd1MzUHJlZml4ZXMgPSByYXdTM1BhdGhQYXR0ZXJucy5tYXAocGF0aFBhdHRlcm5Ub1VyaVByZWZpeCkuc29ydCgoYSwgYikgPT4gYi5sZW5ndGggLSBhLmxlbmd0aCk7XG4gIGNvbnN0IHJhd1MzUHJlZml4TGlzdCA9IHJhd1MzUHJlZml4ZXMubWFwKChwcmVmaXgpID0+IGAnJHtwcmVmaXh9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuICBjb25zdCBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzID0gbGFtYmRhUGFzc3Rocm91Z2hQYXRoUGF0dGVybnNcbiAgICAubWFwKHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgpXG4gICAgLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpO1xuICBjb25zdCBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeExpc3QgPSBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzLm1hcCgocHJlZml4KSA9PiBgJyR7cHJlZml4fSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcbiAgY29uc3QgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlckxpc3QgPSBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycy5tYXAoKGhlYWRlcikgPT4gYCcke2hlYWRlcn0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG5cbiAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICByZXF1ZXN0LmhlYWRlcnMgPSByZXF1ZXN0LmhlYWRlcnMgfHwge307XG5cdCAgdmFyIGhlYWRlcnMgPSByZXF1ZXN0LmhlYWRlcnM7XG5cdCAgdmFyIHVyaSA9IHJlcXVlc3QudXJpIHx8ICcvJztcblx0ICB2YXIgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMgPSBbXG5cdCAgICAke2Jsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJMaXN0fVxuXHQgIF07XG5cblx0ICBmb3IgKHZhciBibG9ja2VkSW5kZXggPSAwOyBibG9ja2VkSW5kZXggPCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycy5sZW5ndGg7IGJsb2NrZWRJbmRleCsrKSB7XG5cdCAgICBkZWxldGUgaGVhZGVyc1tibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyc1tibG9ja2VkSW5kZXhdXTtcblx0ICB9XG5cblx0ICB2YXIgcmVxdWVzdElkSGVhZGVyID0gaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ107XG5cdCAgdmFyIHJlcXVlc3RJZCA9IHJlcXVlc3RJZEhlYWRlciAmJiByZXF1ZXN0SWRIZWFkZXIudmFsdWUgPyByZXF1ZXN0SWRIZWFkZXIudmFsdWUudHJpbSgpIDogJyc7XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gZXZlbnQuY29udGV4dCAmJiBldmVudC5jb250ZXh0LnJlcXVlc3RJZCA/IFN0cmluZyhldmVudC5jb250ZXh0LnJlcXVlc3RJZCkudHJpbSgpIDogJyc7XG5cdCAgfVxuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9ICdyZXFfJyArIERhdGUubm93KCkudG9TdHJpbmcoMzYpICsgJ18nICsgTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTApO1xuXHQgIH1cblxuXHQgIGhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddID0geyB2YWx1ZTogcmVxdWVzdElkIH07XG5cdCAgaGVhZGVyc1snJHthcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcn0nXSA9IHsgdmFsdWU6IHVyaSB9O1xuXHQgIGhlYWRlcnNbJyR7ZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyfSddID0geyB2YWx1ZTogdXJpIH07XG5cblx0ICBpZiAoaGVhZGVycy5ob3N0ICYmIGhlYWRlcnMuaG9zdC52YWx1ZSkge1xuXHQgICAgaGVhZGVyc1snJHthcHB0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJ9J10gPSB7IHZhbHVlOiBoZWFkZXJzLmhvc3QudmFsdWUgfTtcblx0ICAgIGhlYWRlcnNbJyR7ZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcn0nXSA9IHsgdmFsdWU6IGhlYWRlcnMuaG9zdC52YWx1ZSB9O1xuXHQgIH1cblxuXHQgIGlmICgnJHttb2RlfScgPT09ICcke0FwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1J9Jykge1xuXHQgICAgdmFyIHJhd1MzUHJlZml4ZXMgPSBbXG5cdCAgICAgICR7cmF3UzNQcmVmaXhMaXN0fVxuXHQgICAgXTtcblx0ICAgIHZhciBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzID0gW1xuXHQgICAgICAke2xhbWJkYVBhc3N0aHJvdWdoUHJlZml4TGlzdH1cblx0ICAgIF07XG5cdCAgICB2YXIgaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGggPSBmYWxzZTtcblxuXHQgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzLmxlbmd0aDsgaSsrKSB7XG5cdCAgICAgIHZhciBwcmVmaXggPSBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzW2ldO1xuXHQgICAgICBpZiAodXJpID09PSBwcmVmaXggfHwgdXJpLnN0YXJ0c1dpdGgocHJlZml4ICsgJy8nKSkge1xuXHQgICAgICAgIGlzTGFtYmRhUGFzc3Rocm91Z2hQYXRoID0gdHJ1ZTtcblx0ICAgICAgICBicmVhaztcblx0ICAgICAgfVxuXHQgICAgfVxuXG5cdCAgICBpZiAoIWlzTGFtYmRhUGFzc3Rocm91Z2hQYXRoKSB7XG5cdCAgICAgIHZhciBpc1Jhd1MzUGF0aCA9IGZhbHNlO1xuXG5cdCAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgcmF3UzNQcmVmaXhlcy5sZW5ndGg7IGorKykge1xuXHQgICAgICAgIHZhciByYXdQcmVmaXggPSByYXdTM1ByZWZpeGVzW2pdO1xuXHQgICAgICAgIGlmICh1cmkgPT09IHJhd1ByZWZpeCB8fCB1cmkuc3RhcnRzV2l0aChyYXdQcmVmaXggKyAnLycpKSB7XG5cdCAgICAgICAgICBpc1Jhd1MzUGF0aCA9IHRydWU7XG5cdCAgICAgICAgICBicmVhaztcblx0ICAgICAgICB9XG5cdCAgICAgIH1cblxuXHQgICAgICB2YXIgbGFzdFNsYXNoID0gdXJpLmxhc3RJbmRleE9mKCcvJyk7XG5cdCAgICAgIHZhciBsYXN0U2VnbWVudCA9IGxhc3RTbGFzaCA+PSAwID8gdXJpLnN1YnN0cmluZyhsYXN0U2xhc2ggKyAxKSA6IHVyaTtcblxuXHQgICAgICBpZiAoIWlzUmF3UzNQYXRoICYmIGxhc3RTZWdtZW50LmluZGV4T2YoJy4nKSA9PT0gLTEpIHtcblx0ICAgICAgICByZXF1ZXN0LnVyaSA9IHVyaS5lbmRzV2l0aCgnLycpID8gdXJpICsgJ2luZGV4Lmh0bWwnIDogdXJpICsgJy9pbmRleC5odG1sJztcblx0ICAgICAgfVxuXHQgICAgfVxuXHQgIH1cblxuXHQgIHJldHVybiByZXF1ZXN0O1xuXHR9XG5cdGAudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBnZW5lcmF0ZVNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25Db2RlKCk6IHN0cmluZyB7XG4gIHJldHVybiBgXG5cdGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcblx0ICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG5cdCAgdmFyIHJlc3BvbnNlID0gZXZlbnQucmVzcG9uc2U7XG5cdCAgdmFyIHJlcXVlc3RJZEhlYWRlciA9IHJlcXVlc3QuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ107XG5cdCAgdmFyIHJlcXVlc3RJZCA9IHJlcXVlc3RJZEhlYWRlciAmJiByZXF1ZXN0SWRIZWFkZXIudmFsdWUgPyByZXF1ZXN0SWRIZWFkZXIudmFsdWUudHJpbSgpIDogJyc7XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gZXZlbnQuY29udGV4dCAmJiBldmVudC5jb250ZXh0LnJlcXVlc3RJZCA/IFN0cmluZyhldmVudC5jb250ZXh0LnJlcXVlc3RJZCkudHJpbSgpIDogJyc7XG5cdCAgfVxuXG5cdCAgaWYgKHJlcXVlc3RJZCkge1xuXHQgICAgcmVzcG9uc2UuaGVhZGVycyA9IHJlc3BvbnNlLmhlYWRlcnMgfHwge307XG5cdCAgICBpZiAoIXJlc3BvbnNlLmhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddKSB7XG5cdCAgICAgIHJlc3BvbnNlLmhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddID0geyB2YWx1ZTogcmVxdWVzdElkIH07XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlc3BvbnNlO1xuXHR9XG5cdGAudHJpbSgpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVNzclNpdGVQcm9wcyB7XG4gIHJlYWRvbmx5IHNzckZ1bmN0aW9uOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCBkZXBsb3ltZW50IG1vZGUgZm9yIHRoZSBzaXRlIHRvcG9sb2d5LlxuICAgKlxuICAgKiAtIGBzc3Itb25seWA6IExhbWJkYSBGdW5jdGlvbiBVUkwgaXMgdGhlIGRlZmF1bHQgb3JpZ2luXG4gICAqIC0gYHNzZy1pc3JgOiBTMyBpcyB0aGUgcHJpbWFyeSBIVE1MIG9yaWdpbiBhbmQgTGFtYmRhIGlzIHRoZSBmYWxsYmFja1xuICAgKlxuICAgKiBFeGlzdGluZyBpbXBsaWNpdCBiZWhhdmlvciBtYXBzIHRvIGBzc3Itb25seWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTUl9PTkxZXG4gICAqL1xuICByZWFkb25seSBtb2RlPzogQXBwVGhlb3J5U3NyU2l0ZU1vZGU7XG5cbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaW52b2tlIG1vZGUgZm9yIHRoZSBTU1Igb3JpZ2luLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU1cbiAgICovXG4gIHJlYWRvbmx5IGludm9rZU1vZGU/OiBsYW1iZGEuSW52b2tlTW9kZTtcblxuICAvKipcbiAgICogRnVuY3Rpb24gVVJMIGF1dGggdHlwZSBmb3IgdGhlIFNTUiBvcmlnaW4uXG4gICAqXG4gICAqIElmIG9taXR0ZWQsIEFwcFRoZW9yeSBmYWlscyBjbG9zZWQgdG8gYEFXU19JQU1gIGFuZCBzaWducyBDbG91ZEZyb250LXRvLUxhbWJkYVxuICAgKiB0cmFmZmljIHdpdGggbGFtYmRhIE9yaWdpbiBBY2Nlc3MgQ29udHJvbC5cbiAgICpcbiAgICogU2V0IHRoaXMgZXhwbGljaXRseSB0byBgTk9ORWAgb25seSB3aGVuIHlvdSBpbnRlbnRpb25hbGx5IHJlcXVpcmUgcHVibGljXG4gICAqIGRpcmVjdCBGdW5jdGlvbiBVUkwgYWNjZXNzIGFzIGEgZGVsaWJlcmF0ZSBjb21wYXRpYmlsaXR5IGNob2ljZS5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTVxuICAgKi9cbiAgcmVhZG9ubHkgc3NyVXJsQXV0aFR5cGU/OiBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZTtcblxuICByZWFkb25seSBhc3NldHNCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICByZWFkb25seSBhc3NldHNQYXRoPzogc3RyaW5nO1xuICByZWFkb25seSBhc3NldHNLZXlQcmVmaXg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFzc2V0c01hbmlmZXN0S2V5Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBTMyBidWNrZXQgdXNlZCBieSBGYWNlVGhlb3J5IElTUiBIVE1MIHN0b3JhZ2UgKGBTM0h0bWxTdG9yZWApLlxuICAgKlxuICAgKiBXaGVuIHByb3ZpZGVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBTU1IgZnVuY3Rpb24gcmVhZC93cml0ZSBhY2Nlc3MgYW5kIHdpcmVzOlxuICAgKiAtIGBGQUNFVEhFT1JZX0lTUl9CVUNLRVRgXG4gICAqIC0gYEZBQ0VUSEVPUllfSVNSX1BSRUZJWGBcbiAgICovXG4gIHJlYWRvbmx5IGh0bWxTdG9yZUJ1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgLyoqXG4gICAqIFMzIGtleSBwcmVmaXggdXNlZCBieSBGYWNlVGhlb3J5IElTUiBIVE1MIHN0b3JhZ2UuXG4gICAqIEBkZWZhdWx0IGlzclxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbFN0b3JlS2V5UHJlZml4Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGV4dGVuc2lvbmxlc3MgSFRNTCBzZWN0aW9uIHBhdGggcGF0dGVybnMgdG8gcm91dGUgZGlyZWN0bHkgdG8gdGhlIHByaW1hcnkgSFRNTCBTMyBvcmlnaW4uXG4gICAqXG4gICAqIFJlcXVlc3RzIGxpa2UgYC9tYXJrZXRpbmdgIGFuZCBgL21hcmtldGluZy8uLi5gIGFyZSByZXdyaXR0ZW4gdG8gYC9pbmRleC5odG1sYFxuICAgKiB3aXRoaW4gdGhlIHNlY3Rpb24gYW5kIHN0YXkgb24gUzMgaW5zdGVhZCBvZiBmYWxsaW5nIGJhY2sgdG8gTGFtYmRhLlxuICAgKlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TMyBIVE1MIHNlY3Rpb24gcGF0aDogXCIvbWFya2V0aW5nLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhdGljUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgcmF3IFMzIG9iamVjdC9kYXRhIHBhdGggcGF0dGVybnMgdGhhdCBzaG91bGQgYnlwYXNzIGV4dGVuc2lvbmxlc3MgSFRNTCByZXdyaXRlcy5cbiAgICpcbiAgICogSW4gYHNzZy1pc3JgIG1vZGUsIGAvX2ZhY2V0aGVvcnkvZGF0YS8qYCBpcyBhZGRlZCBhdXRvbWF0aWNhbGx5LlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TMyBvYmplY3QgcGF0aDogXCIvZmVlZHMvKlwiXG4gICAqL1xuICByZWFkb25seSBkaXJlY3RTM1BhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIHBhdGggcGF0dGVybnMgdGhhdCBzaG91bGQgYnlwYXNzIHRoZSBgc3NnLWlzcmAgb3JpZ2luIGdyb3VwIGFuZCByb3V0ZSBkaXJlY3RseVxuICAgKiB0byB0aGUgTGFtYmRhIEZ1bmN0aW9uIFVSTCB3aXRoIGZ1bGwgbWV0aG9kIHN1cHBvcnQuXG4gICAqXG4gICAqIEluIGBzc2ctaXNyYCBtb2RlLCBgL19mYWNldGhlb3J5L3Nzci1kYXRhLypgIGlzIGFkZGVkIGF1dG9tYXRpY2FsbHkgZm9yIEZhY2VUaGVvcnlcbiAgICogc3RyaWN0IG5vLWlubGluZS1DU1AgU1NSIGh5ZHJhdGlvbiBzaWRlY2Fycy5cbiAgICpcbiAgICogVXNlIHRoaXMgZm9yIHNhbWUtb3JpZ2luIGR5bmFtaWMgcGF0aHMgc3VjaCBhcyBhdXRoIGNhbGxiYWNrcywgYWN0aW9ucywgb3IgZm9ybSBwb3N0cy5cbiAgICogRXhhbXBsZSBkaXJlY3QtU1NSIHBhdGg6IFwiL2FjdGlvbnMvKlwiXG4gICAqL1xuICByZWFkb25seSBzc3JQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBiZWFyZXItYXV0aCBMYW1iZGEgRnVuY3Rpb24gVVJMIGNvLW9yaWdpbnMgdG8gYXR0YWNoIHRvIHRoZSBzYW1lIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgKlxuICAgKiBBcHBUaGVvcnkgY3JlYXRlcyBlYWNoIGNvLW9yaWdpbiBGdW5jdGlvbiBVUkwgd2l0aCBgQXV0aFR5cGUuTk9ORWAgYW5kIHJvdXRlcyB0aGUgc3VwcGxpZWRcbiAgICogcGF0aCBwYXR0ZXJucyB0byBpdCB3aXRob3V0IExhbWJkYSBPcmlnaW4gQWNjZXNzIENvbnRyb2wuIFRoZSBTU1Igb3JpZ2luIHJlbWFpbnMgZ292ZXJuZWQgYnlcbiAgICogYHNzclVybEF1dGhUeXBlYCBhbmQgc3RpbGwgZGVmYXVsdHMgdG8gYEFXU19JQU1gIHBsdXMgTGFtYmRhIE9BQy5cbiAgICpcbiAgICogQ28tb3JpZ2luIHBhdGhzIHBhcnRpY2lwYXRlIGluIEFwcFRoZW9yeSdzIGJlaGF2aW9yIHBhdGggY29sbGlzaW9uIGNoZWNrcyBhbmQgYnlwYXNzIGBzc2ctaXNyYFxuICAgKiBIVE1MIHJld3JpdGVzLiBUaGlzIGlzIHRoZSBzdXBwb3J0ZWQgQXBwVGhlb3J5IHBhdGggZm9yIG1peGVkLWF1dGggZGlzdHJpYnV0aW9uczsgZG8gbm90IGhhbmQtd2lyZVxuICAgKiByYXcgYGRpc3RyaWJ1dGlvbi5hZGRCZWhhdmlvciguLi4pYCBjYWxscyB3aGVuIEFwcFRoZW9yeSBzaG91bGQgb3duIHBhdGggYW5kIGVkZ2UtY29udGV4dCBwb2xpY3kuXG4gICAqXG4gICAqIEV4YW1wbGUgYmVhcmVyIEFQSSBwYXRoczogYFtcIi9hcGkvKlwiLCBcIi9hdXRoLypcIl1gLlxuICAgKi9cbiAgcmVhZG9ubHkgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zPzogQXBwVGhlb3J5U3NyU2l0ZUJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIFRhYmxlVGhlb3J5L0R5bmFtb0RCIHRhYmxlIHVzZWQgZm9yIEZhY2VUaGVvcnkgSVNSIG1ldGFkYXRhIGFuZCBsZWFzZSBjb29yZGluYXRpb24uXG4gICAqXG4gICAqIFdoZW4gcHJvdmlkZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIFNTUiBmdW5jdGlvbiByZWFkL3dyaXRlIGFjY2VzcyBhbmQgd2lyZXMgdGhlXG4gICAqIG1ldGFkYXRhIHRhYmxlIGFsaWFzZXMgZXhwZWN0ZWQgYnkgdGhlIGRvY3VtZW50ZWQgRmFjZVRoZW9yeSBkZXBsb3ltZW50IHNoYXBlLlxuICAgKi9cbiAgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgSVNSL2NhY2hlIG1ldGFkYXRhIHRhYmxlIG5hbWUgdG8gd2lyZSB3aGVuIHlvdSBhcmUgbm90IHBhc3NpbmcgYGlzck1ldGFkYXRhVGFibGVgLlxuICAgKlxuICAgKiBQcmVmZXIgYGlzck1ldGFkYXRhVGFibGVgIHdoZW4gQXBwVGhlb3J5IHNob3VsZCBhbHNvIGdyYW50IGFjY2VzcyB0byB0aGUgU1NSIExhbWJkYS5cbiAgICovXG4gIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBMZWdhY3kgYWxpYXMgZm9yIGBpc3JNZXRhZGF0YVRhYmxlTmFtZWAuXG4gICAqIEBkZXByZWNhdGVkIHByZWZlciBgaXNyTWV0YWRhdGFUYWJsZWAgb3IgYGlzck1ldGFkYXRhVGFibGVOYW1lYFxuICAgKi9cbiAgcmVhZG9ubHkgY2FjaGVUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLy8gV2hlbiB0cnVlIChkZWZhdWx0KSwgQXBwVGhlb3J5IHdpcmVzIHJlY29tbWVuZGVkIHJ1bnRpbWUgZW52aXJvbm1lbnQgdmFyaWFibGVzIG9udG8gdGhlIFNTUiBmdW5jdGlvbi5cbiAgcmVhZG9ubHkgd2lyZVJ1bnRpbWVFbnY/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGhlYWRlcnMgdG8gZm9yd2FyZCB0byB0aGUgU1NSIG9yaWdpbiAoTGFtYmRhIEZ1bmN0aW9uIFVSTCkgdmlhIHRoZSBvcmlnaW4gcmVxdWVzdCBwb2xpY3kuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IEFwcFRoZW9yeS9GYWNlVGhlb3J5LXNhZmUgZWRnZSBjb250cmFjdCBmb3J3YXJkcyBvbmx5OlxuICAgKiAtIGBjbG91ZGZyb250LWZvcndhcmRlZC1wcm90b2BcbiAgICogLSBgY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc2BcbiAgICogLSBgeC1hcHB0aGVvcnktb3JpZ2luYWwtaG9zdGBcbiAgICogLSBgeC1hcHB0aGVvcnktb3JpZ2luYWwtdXJpYFxuICAgKiAtIGB4LWZhY2V0aGVvcnktb3JpZ2luYWwtaG9zdGBcbiAgICogLSBgeC1mYWNldGhlb3J5LW9yaWdpbmFsLXVyaWBcbiAgICogLSBgeC1yZXF1ZXN0LWlkYFxuICAgKlxuICAgKiBVc2UgdGhpcyB0byBvcHQgaW4gdG8gYWRkaXRpb25hbCBhcHAtc3BlY2lmaWMgaGVhZGVycyBzdWNoIGFzXG4gICAqIGB4LWZhY2V0aGVvcnktc2VnbWVudGAuIFRlbmFudC1saWtlIHZpZXdlciBoZWFkZXJzIGFyZSByZWplY3RlZCB1bmxlc3NcbiAgICogYGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc2AgaXMgZXhwbGljaXRseSBlbmFibGVkIGFzIGEgY29tcGF0aWJpbGl0eSBtb2RlLlxuICAgKiBgaG9zdGAgYW5kIGB4LWZvcndhcmRlZC1wcm90b2AgYXJlIHJlamVjdGVkIGJlY2F1c2UgdGhleSBicmVhayBvciBieXBhc3MgdGhlXG4gICAqIHN1cHBvcnRlZCBvcmlnaW4gbW9kZWwuXG4gICAqL1xuICByZWFkb25seSBzc3JGb3J3YXJkSGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDb21wYXRpYmlsaXR5IGVzY2FwZSBoYXRjaCBmb3IgbGVnYWN5IHZpZXdlci1zdXBwbGllZCB0ZW5hbnQgaGVhZGVycy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSAoZGVmYXVsdCksIEFwcFRoZW9yeSBzdHJpcHMgYHgtdGVuYW50LWlkYCBhdCB0aGUgZWRnZSBhbmQgcmVqZWN0c1xuICAgKiB0ZW5hbnQtbGlrZSBlbnRyaWVzIGluIGBzc3JGb3J3YXJkSGVhZGVyc2Agc28gdmlld2VyLXN1cHBsaWVkIHRlbmFudCBoZWFkZXJzXG4gICAqIGNhbm5vdCBpbmZsdWVuY2Ugb3JpZ2luIHJvdXRpbmcgb3IgSFRNTCBjYWNoZSBwYXJ0aXRpb25pbmcuIFdoZW4gdHJ1ZSxcbiAgICogQXBwVGhlb3J5IHJlc3RvcmVzIGxlZ2FjeSBwYXNzdGhyb3VnaCBiZWhhdmlvciBmb3IgYHgtdGVuYW50LWlkYCBhbmQgYW55XG4gICAqIHRlbmFudC1saWtlIGBzc3JGb3J3YXJkSGVhZGVyc2AuXG4gICAqXG4gICAqIFByZWZlciBkZXJpdmluZyB0ZW5hbnQgZnJvbSB0cnVzdGVkIGhvc3QgbWFwcGluZyB1c2luZyB0aGUgb3JpZ2luYWwtaG9zdFxuICAgKiBlZGdlIGhlYWRlcnMgaW5zdGVhZCBvZiBlbmFibGluZyBwYXNzdGhyb3VnaC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFsbG93Vmlld2VyVGVuYW50SGVhZGVycz86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZW5hYmxlTG9nZ2luZz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBDbG91ZEZyb250IHJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGFwcGxpZWQgdG8gU1NSIGFuZCBkaXJlY3QtUzMgYmVoYXZpb3JzLlxuICAgKlxuICAgKiBJZiBvbWl0dGVkLCBBcHBUaGVvcnkgcHJvdmlzaW9ucyBhIEZhY2VUaGVvcnktYWxpZ25lZCBiYXNlbGluZSBwb2xpY3kgYXQgdGhlIENETlxuICAgKiBsYXllcjogSFNUUywgbm9zbmlmZiwgZnJhbWUtb3B0aW9ucywgcmVmZXJyZXItcG9saWN5LCBYU1MgcHJvdGVjdGlvbiwgYW5kIGFcbiAgICogcmVzdHJpY3RpdmUgcGVybWlzc2lvbnMtcG9saWN5LiBDb250ZW50LVNlY3VyaXR5LVBvbGljeSByZW1haW5zIG9yaWdpbi1kZWZpbmVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gIC8qKlxuICAgKiBDYWNoZSBwb2xpY3kgYXBwbGllZCB0byBkaXJlY3QgTGFtYmRhLWJhY2tlZCBTU1IgYmVoYXZpb3JzLlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBpcyBgQ0FDSElOR19ESVNBQkxFRGAgc28gZHluYW1pYyBMYW1iZGEgcm91dGVzIHN0YXkgc2FmZSB1bmxlc3MgeW91XG4gICAqIGludGVudGlvbmFsbHkgb3B0IGludG8gYSBjYWNoZSBwb2xpY3kgdGhhdCBtYXRjaGVzIHlvdXIgYXBwJ3MgdmFyaWFuY2UgbW9kZWwuXG4gICAqIEBkZWZhdWx0IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRFxuICAgKi9cbiAgcmVhZG9ubHkgc3NyQ2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICAvKipcbiAgICogQ2FjaGUgcG9saWN5IGFwcGxpZWQgdG8gdGhlIGNhY2hlYWJsZSBIVE1MIGJlaGF2aW9yIGluIGBzc2ctaXNyYCBtb2RlLlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBBcHBUaGVvcnkgcG9saWN5IGtleXMgb24gcXVlcnkgc3RyaW5ncyBwbHVzIHRoZSBzdGFibGUgcHVibGljIEhUTUxcbiAgICogdmFyaWFudCBoZWFkZXJzIChgeC0qLW9yaWdpbmFsLWhvc3RgIGFuZCBhbnkgbm9uLXRlbmFudCBleHRyYSBmb3J3YXJkZWRcbiAgICogaGVhZGVycyB5b3Ugb3B0IGludG8pIHdoaWxlIGxlYXZpbmcgY29va2llcyBvdXQgb2YgdGhlIGNhY2hlIGtleS4gVGVuYW50LWxpa2VcbiAgICogdmlld2VyIGhlYWRlcnMgam9pbiB0aGUgY2FjaGUga2V5IG9ubHkgd2hlbiBgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzYCBpc1xuICAgKiBleHBsaWNpdGx5IGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSBodG1sQ2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgYXV0b0RlbGV0ZU9iamVjdHM/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTc3JTaXRlQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW4ge1xuICAvKipcbiAgICogTGFtYmRhIGZ1bmN0aW9uIHRoYXQgQXBwVGhlb3J5IGV4cG9zZXMgYXMgYSBiZWFyZXItYXV0aCBGdW5jdGlvbiBVUkwgY28tb3JpZ2luLlxuICAgKlxuICAgKiBBcHBUaGVvcnkgY3JlYXRlcyB0aGUgRnVuY3Rpb24gVVJMIHdpdGggYGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLk5PTkVgOyBhdXRoZW50aWNhdGlvbiByZW1haW5zXG4gICAqIHRoZSByZXNwb25zaWJpbGl0eSBvZiB0aGUgTGFtYmRhIGhhbmRsZXIuXG4gICAqL1xuICByZWFkb25seSBmdW5jdGlvbjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogQ2xvdWRGcm9udCBwYXRoIHBhdHRlcm5zIHRoYXQgcm91dGUgdG8gdGhpcyBjby1vcmlnaW4uXG4gICAqXG4gICAqIFBhdHRlcm5zIGFyZSBub3JtYWxpemVkIHRoZSBzYW1lIHdheSBhcyBgc3NyUGF0aFBhdHRlcm5zYC4gQSBwYXR0ZXJuIGVuZGluZyBpbiBgLypgIGFsc28gY3JlYXRlc1xuICAgKiBhIHJvb3QgYmVoYXZpb3Igd2l0aG91dCB0aGUgd2lsZGNhcmQgc28gYC9hcGkvKmAgY292ZXJzIGJvdGggYC9hcGlgIGFuZCBgL2FwaS8uLi5gLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0aFBhdHRlcm5zOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpbnZva2UgbW9kZSBmb3IgdGhpcyBjby1vcmlnaW4uXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5JbnZva2VNb2RlLkJVRkZFUkVEXG4gICAqL1xuICByZWFkb25seSBpbnZva2VNb2RlPzogbGFtYmRhLkludm9rZU1vZGU7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlTc3JTaXRlIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c0J1Y2tldDogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c0tleVByZWZpeDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzTWFuaWZlc3RLZXk6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGh0bWxTdG9yZUJ1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBodG1sU3RvcmVLZXlQcmVmaXg/OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBzc3JVcmw6IGxhbWJkYS5GdW5jdGlvblVybDtcbiAgcHVibGljIHJlYWRvbmx5IGJlYXJlckZ1bmN0aW9uVXJsczogbGFtYmRhLkZ1bmN0aW9uVXJsW107XG4gIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVNzclNpdGVQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAoIXByb3BzPy5zc3JGdW5jdGlvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBzaXRlTW9kZSA9IHByb3BzLm1vZGUgPz8gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFk7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICBjb25zdCB3aXJlUnVudGltZUVudiA9IHByb3BzLndpcmVSdW50aW1lRW52ID8/IHRydWU7XG5cbiAgICB0aGlzLmFzc2V0c0J1Y2tldCA9XG4gICAgICBwcm9wcy5hc3NldHNCdWNrZXQgPz9cbiAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJBc3NldHNCdWNrZXRcIiwge1xuICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgfSk7XG5cbiAgICBjb25zdCBlbmFibGVMb2dnaW5nID0gcHJvcHMuZW5hYmxlTG9nZ2luZyA/PyB0cnVlO1xuICAgIGlmIChlbmFibGVMb2dnaW5nKSB7XG4gICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGFzc2V0c1ByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKHByb3BzLmFzc2V0c0tleVByZWZpeCA/PyBcImFzc2V0c1wiKS50cmltKCksIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNLZXlQcmVmaXggPSBhc3NldHNQcmVmaXhSYXcgfHwgXCJhc3NldHNcIjtcblxuICAgIGNvbnN0IG1hbmlmZXN0UmF3ID0gU3RyaW5nKHByb3BzLmFzc2V0c01hbmlmZXN0S2V5ID8/IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmApLnRyaW0oKTtcbiAgICBjb25zdCBtYW5pZmVzdEtleSA9IHRyaW1SZXBlYXRlZENoYXIobWFuaWZlc3RSYXcsIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNNYW5pZmVzdEtleSA9IG1hbmlmZXN0S2V5IHx8IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmA7XG5cbiAgICB0aGlzLmFzc2V0c0tleVByZWZpeCA9IGFzc2V0c0tleVByZWZpeDtcbiAgICB0aGlzLmFzc2V0c01hbmlmZXN0S2V5ID0gYXNzZXRzTWFuaWZlc3RLZXk7XG5cbiAgICBjb25zdCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dCA9IFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHNob3VsZENvbmZpZ3VyZUh0bWxTdG9yZSA9IEJvb2xlYW4ocHJvcHMuaHRtbFN0b3JlQnVja2V0KSB8fCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dC5sZW5ndGggPiAwO1xuICAgIGlmIChzaG91bGRDb25maWd1cmVIdG1sU3RvcmUpIHtcbiAgICAgIGNvbnN0IGh0bWxTdG9yZVByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoXG4gICAgICAgIFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeCkudHJpbSgpLFxuICAgICAgICBcIi9cIixcbiAgICAgICk7XG4gICAgICB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCA9IGh0bWxTdG9yZVByZWZpeFJhdyB8fCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4O1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQgPVxuICAgICAgICBwcm9wcy5odG1sU3RvcmVCdWNrZXQgPz9cbiAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkh0bWxTdG9yZUJ1Y2tldFwiLCB7XG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLmlzck1ldGFkYXRhVGFibGUgPSBwcm9wcy5pc3JNZXRhZGF0YVRhYmxlO1xuXG4gICAgY29uc3QgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSA9IFN0cmluZyhwcm9wcy5pc3JNZXRhZGF0YVRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgbGVnYWN5Q2FjaGVUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuY2FjaGVUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHJlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcodGhpcy5pc3JNZXRhZGF0YVRhYmxlPy50YWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgY29uc3QgY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbcmVzb3VyY2VJc3JNZXRhZGF0YVRhYmxlTmFtZSwgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSwgbGVnYWN5Q2FjaGVUYWJsZU5hbWVdLmZpbHRlcihcbiAgICAgICAgICAobmFtZSkgPT4gU3RyaW5nKG5hbWUpLnRyaW0oKS5sZW5ndGggPiAwLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICApO1xuXG4gICAgaWYgKGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMubGVuZ3RoID4gMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBjb25mbGljdGluZyBJU1IgbWV0YWRhdGEgdGFibGUgbmFtZXM6ICR7Y29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgaXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzWzBdID8/IFwiXCI7XG5cbiAgICBpZiAocHJvcHMuYXNzZXRzUGF0aCkge1xuICAgICAgbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgXCJBc3NldHNEZXBsb3ltZW50XCIsIHtcbiAgICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldChwcm9wcy5hc3NldHNQYXRoKV0sXG4gICAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLmFzc2V0c0J1Y2tldCxcbiAgICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6IGFzc2V0c0tleVByZWZpeCxcbiAgICAgICAgcHJ1bmU6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGF0aWNQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMocHJvcHMuc3RhdGljUGF0aFBhdHRlcm5zKTtcbiAgICBjb25zdCBkaXJlY3RTM1BhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhbXG4gICAgICAuLi4oc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBbc3NnSXNySHlkcmF0aW9uUGF0aFBhdHRlcm5dIDogW10pLFxuICAgICAgLi4uKEFycmF5LmlzQXJyYXkocHJvcHMuZGlyZWN0UzNQYXRoUGF0dGVybnMpID8gcHJvcHMuZGlyZWN0UzNQYXRoUGF0dGVybnMgOiBbXSksXG4gICAgXSk7XG4gICAgY29uc3Qgc3NyUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKFtcbiAgICAgIC4uLihzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IFtzc2dJc3JTc3JEYXRhUGF0aFBhdHRlcm5dIDogW10pLFxuICAgICAgLi4uKEFycmF5LmlzQXJyYXkocHJvcHMuc3NyUGF0aFBhdHRlcm5zKSA/IHByb3BzLnNzclBhdGhQYXR0ZXJucyA6IFtdKSxcbiAgICBdKTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMgPSBBcnJheS5pc0FycmF5KHByb3BzLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucylcbiAgICAgID8gcHJvcHMuYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zXG4gICAgICA6IFtdO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncyA9IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucy5tYXAoKG9yaWdpbiwgaW5kZXgpID0+IHtcbiAgICAgIGlmICghb3JpZ2luPy5mdW5jdGlvbikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zWyR7aW5kZXh9XSByZXF1aXJlcyBmdW5jdGlvbmApO1xuICAgICAgfVxuICAgICAgY29uc3QgcGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKG9yaWdpbi5wYXRoUGF0dGVybnMpO1xuICAgICAgaWYgKHBhdGhQYXR0ZXJucy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1ske2luZGV4fV0gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHBhdGggcGF0dGVybmApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHsgb3JpZ2luLCBwYXRoUGF0dGVybnMgfTtcbiAgICB9KTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybFBhdGhQYXR0ZXJucyA9IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mbGF0TWFwKChjb25maWcpID0+IGNvbmZpZy5wYXRoUGF0dGVybnMpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybk93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgY29uc3Qgc3NyVXJsQXV0aFR5cGUgPSBwcm9wcy5zc3JVcmxBdXRoVHlwZSA/PyBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNO1xuICAgIGNvbnN0IGFsbG93Vmlld2VyVGVuYW50SGVhZGVycyA9IHByb3BzLmFsbG93Vmlld2VyVGVuYW50SGVhZGVycyA/PyBmYWxzZTtcblxuICAgIHRoaXMuc3NyVXJsID0gbmV3IGxhbWJkYS5GdW5jdGlvblVybCh0aGlzLCBcIlNzclVybFwiLCB7XG4gICAgICBmdW5jdGlvbjogcHJvcHMuc3NyRnVuY3Rpb24sXG4gICAgICBhdXRoVHlwZTogc3NyVXJsQXV0aFR5cGUsXG4gICAgICBpbnZva2VNb2RlOiBwcm9wcy5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNzck9yaWdpbiA9XG4gICAgICBzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTVxuICAgICAgICA/IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5zc3JVcmwpXG4gICAgICAgIDogbmV3IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4odGhpcy5zc3JVcmwpO1xuXG4gICAgY29uc3QgYXNzZXRzT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCh0aGlzLmFzc2V0c0J1Y2tldCk7XG4gICAgY29uc3QgaHRtbE9yaWdpbkJ1Y2tldCA9IHRoaXMuaHRtbFN0b3JlQnVja2V0ID8/IHRoaXMuYXNzZXRzQnVja2V0O1xuICAgIGNvbnN0IGh0bWxPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKFxuICAgICAgaHRtbE9yaWdpbkJ1Y2tldCxcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4XG4gICAgICAgID8ge1xuICAgICAgICAgICAgb3JpZ2luUGF0aDogYC8ke3RoaXMuaHRtbFN0b3JlS2V5UHJlZml4fWAsXG4gICAgICAgICAgfVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICApO1xuXG4gICAgY29uc3QgYmFzZVNzckZvcndhcmRIZWFkZXJzID0gW1xuICAgICAgXCJjbG91ZGZyb250LWZvcndhcmRlZC1wcm90b1wiLFxuICAgICAgXCJjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzXCIsXG4gICAgICAuLi5zc3JPcmlnaW5hbEhvc3RIZWFkZXJzLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdO1xuXG4gICAgY29uc3QgZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzID0gbmV3IFNldChbXCJob3N0XCIsIFwieC1mb3J3YXJkZWQtcHJvdG9cIl0pO1xuXG4gICAgY29uc3QgZXh0cmFTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmlzQXJyYXkocHJvcHMuc3NyRm9yd2FyZEhlYWRlcnMpXG4gICAgICA/IHByb3BzLnNzckZvcndhcmRIZWFkZXJzLm1hcChjYW5vbmljYWxpemVIZWFkZXJOYW1lKS5maWx0ZXIoKGhlYWRlcikgPT4gaGVhZGVyLmxlbmd0aCA+IDApXG4gICAgICA6IFtdO1xuXG4gICAgY29uc3QgcmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmhhcyhoZWFkZXIpKSksXG4gICAgKS5zb3J0KCk7XG5cbiAgICBpZiAocmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgZGlzYWxsb3dzIHNzckZvcndhcmRIZWFkZXJzOiAke3JlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChleHRyYVNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyKSkpLFxuICAgICkuc29ydCgpO1xuXG4gICAgaWYgKHJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzLmxlbmd0aCA+IDAgJiYgIWFsbG93Vmlld2VyVGVuYW50SGVhZGVycykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnM9dHJ1ZSBmb3IgdGVuYW50LWxpa2Ugc3NyRm9yd2FyZEhlYWRlcnM6ICR7cmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHRlbmFudFBhc3N0aHJvdWdoSGVhZGVycyA9IGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc1xuICAgICAgPyBBcnJheS5mcm9tKG5ldyBTZXQoW2RlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIsIC4uLnJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzXSkpXG4gICAgICA6IFtdO1xuICAgIGNvbnN0IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzID0gYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzXG4gICAgICA/IFtdXG4gICAgICA6IEFycmF5LmZyb20obmV3IFNldChbZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciwgLi4ucmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnNdKSkuc29ydCgpO1xuXG4gICAgY29uc3Qgc3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgWy4uLmJhc2VTc3JGb3J3YXJkSGVhZGVycywgLi4udGVuYW50UGFzc3Rocm91Z2hIZWFkZXJzLCAuLi5leHRyYVNzckZvcndhcmRIZWFkZXJzXS5maWx0ZXIoXG4gICAgICAgICAgKGhlYWRlcikgPT4gIWRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMgPSBuZXcgU2V0KFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoc3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+ICFodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMuaGFzKGhlYWRlcikpKSxcbiAgICApO1xuXG4gICAgaWYgKCFwcm9wcy5odG1sQ2FjaGVQb2xpY3kgJiYgaHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGggPiBtYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRlZmF1bHQgaHRtbENhY2hlUG9saWN5IHN1cHBvcnRzIGF0IG1vc3QgJHttYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzfSBjYWNoZS1rZXkgaGVhZGVyczsgcmVjZWl2ZWQgJHtodG1sQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aH1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIlNzck9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIkh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5zc3JGb3J3YXJkSGVhZGVycyksXG4gICAgfSk7XG4gICAgY29uc3Qgc3NyQ2FjaGVQb2xpY3kgPSBwcm9wcy5zc3JDYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQ7XG4gICAgY29uc3QgaHRtbENhY2hlUG9saWN5ID1cbiAgICAgIHByb3BzLmh0bWxDYWNoZVBvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJIdG1sQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgSFRNTCBjYWNoZSBwb2xpY3kga2V5ZWQgYnkgcXVlcnkgc3RyaW5ncyBhbmQgc3RhYmxlIHB1YmxpYyB2YXJpYW50IGhlYWRlcnNcIixcbiAgICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBtYXhUdGw6IER1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmh0bWxDYWNoZUtleUhlYWRlcnMpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nR3ppcDogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJkaXJlY3QgUzMgcGF0aHNcIiwgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSwgYmVoYXZpb3JQYXR0ZXJuT3duZXJzKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcInN0YXRpYyBIVE1MIHBhdGhzXCIsIHN0YXRpY1BhdGhQYXR0ZXJucywgYmVoYXZpb3JQYXR0ZXJuT3duZXJzKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcImRpcmVjdCBTU1IgcGF0aHNcIiwgc3NyUGF0aFBhdHRlcm5zLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMpO1xuICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mb3JFYWNoKChjb25maWcsIGluZGV4KSA9PiB7XG4gICAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgICAgICAgYGJlYXJlciBGdW5jdGlvbiBVUkwgY28tb3JpZ2luICR7aW5kZXggKyAxfWAsXG4gICAgICAgIGNvbmZpZy5wYXRoUGF0dGVybnMsXG4gICAgICAgIGJlaGF2aW9yUGF0dGVybk93bmVycyxcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXF1ZXN0RnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlcXVlc3RGdW5jdGlvblwiLCB7XG4gICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKFxuICAgICAgICBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoXG4gICAgICAgICAgc2l0ZU1vZGUsXG4gICAgICAgICAgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSxcbiAgICAgICAgICBbLi4uc3NyUGF0aFBhdHRlcm5zLCAuLi5iZWFyZXJGdW5jdGlvblVybFBhdGhQYXR0ZXJuc10sXG4gICAgICAgICAgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMsXG4gICAgICAgICksXG4gICAgICApLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDpcbiAgICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgICA/IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgYW5kIEhUTUwgcmV3cml0ZSBmb3IgU1NSIHNpdGVcIlxuICAgICAgICAgIDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXF1ZXN0IGVkZ2UgY29udGV4dCBmb3IgU1NSIHNpdGVcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShnZW5lcmF0ZVNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25Db2RlKCkpLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXNwb25zZSByZXF1ZXN0LWlkIGVjaG8gZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMgPSAoKTogY2xvdWRmcm9udC5GdW5jdGlvbkFzc29jaWF0aW9uW10gPT4gW1xuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVxdWVzdEZ1bmN0aW9uLFxuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVzcG9uc2VGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVNQT05TRSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCk7XG5cbiAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcbiAgICAgIGNvbnN0IGNlcnRBcm4gPSBTdHJpbmcocHJvcHMuY2VydGlmaWNhdGVBcm4gPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGNlcnRBcm4pIHtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwgY2VydEFybik7XG4gICAgICB9IGVsc2UgaWYgKHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBuZXcgYWNtLkRuc1ZhbGlkYXRlZENlcnRpZmljYXRlKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwge1xuICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgaG9zdGVkWm9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICByZWdpb246IFwidXMtZWFzdC0xXCIsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5jZXJ0aWZpY2F0ZUFybiBvciBwcm9wcy5ob3N0ZWRab25lIHdoZW4gcHJvcHMuZG9tYWluTmFtZSBpcyBzZXRcIik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlO1xuXG4gICAgdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICBuZXcgY2xvdWRmcm9udC5SZXNwb25zZUhlYWRlcnNQb2xpY3kodGhpcywgXCJSZXNwb25zZUhlYWRlcnNQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgYmFzZWxpbmUgc2VjdXJpdHkgaGVhZGVycyAoQ1NQIHN0YXlzIG9yaWdpbi1kZWZpbmVkKVwiLFxuICAgICAgICBzZWN1cml0eUhlYWRlcnNCZWhhdmlvcjoge1xuICAgICAgICAgIHN0cmljdFRyYW5zcG9ydFNlY3VyaXR5OiB7XG4gICAgICAgICAgICBhY2Nlc3NDb250cm9sTWF4QWdlOiBEdXJhdGlvbi5kYXlzKDM2NSAqIDIpLFxuICAgICAgICAgICAgaW5jbHVkZVN1YmRvbWFpbnM6IHRydWUsXG4gICAgICAgICAgICBwcmVsb2FkOiB0cnVlLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBjb250ZW50VHlwZU9wdGlvbnM6IHsgb3ZlcnJpZGU6IHRydWUgfSxcbiAgICAgICAgICBmcmFtZU9wdGlvbnM6IHtcbiAgICAgICAgICAgIGZyYW1lT3B0aW9uOiBjbG91ZGZyb250LkhlYWRlcnNGcmFtZU9wdGlvbi5ERU5ZLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZWZlcnJlclBvbGljeToge1xuICAgICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IGNsb3VkZnJvbnQuSGVhZGVyc1JlZmVycmVyUG9saWN5LlNUUklDVF9PUklHSU5fV0hFTl9DUk9TU19PUklHSU4sXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHhzc1Byb3RlY3Rpb246IHtcbiAgICAgICAgICAgIHByb3RlY3Rpb246IHRydWUsXG4gICAgICAgICAgICBtb2RlQmxvY2s6IHRydWUsXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBjdXN0b21IZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICBjdXN0b21IZWFkZXJzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGhlYWRlcjogXCJwZXJtaXNzaW9ucy1wb2xpY3lcIixcbiAgICAgICAgICAgICAgdmFsdWU6IFwiY2FtZXJhPSgpLCBtaWNyb3Bob25lPSgpLCBnZW9sb2NhdGlvbj0oKVwiLFxuICAgICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlU3RhdGljQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogYXNzZXRzT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuVVNFX09SSUdJTl9DQUNIRV9DT05UUk9MX0hFQURFUlMsXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogaHRtbENhY2hlUG9saWN5LFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogaHRtbE9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3NyQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICBjYWNoZVBvbGljeTogc3NyQ2FjaGVQb2xpY3ksXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuICAgIGNvbnN0IGFkZEV4cGFuZGVkQmVoYXZpb3IgPSAocGF0dGVybnM6IHN0cmluZ1tdLCBmYWN0b3J5OiAoKSA9PiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyk6IHZvaWQgPT4ge1xuICAgICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW3BhdHRlcm5dID0gZmFjdG9yeSgpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKFtgJHthc3NldHNLZXlQcmVmaXh9LypgXSwgY3JlYXRlU3RhdGljQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoZGlyZWN0UzNQYXRoUGF0dGVybnMsIGNyZWF0ZVN0YXRpY0JlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHN0YXRpY1BhdGhQYXR0ZXJucywgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHNzclBhdGhQYXR0ZXJucywgY3JlYXRlU3NyQmVoYXZpb3IpO1xuICAgIHRoaXMuYmVhcmVyRnVuY3Rpb25VcmxzID0gW107XG4gICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmZvckVhY2goKGNvbmZpZywgaW5kZXgpID0+IHtcbiAgICAgIGNvbnN0IGZ1bmN0aW9uVXJsID0gbmV3IGxhbWJkYS5GdW5jdGlvblVybCh0aGlzLCBgQmVhcmVyRnVuY3Rpb25Vcmwke2luZGV4ICsgMX1gLCB7XG4gICAgICAgIGZ1bmN0aW9uOiBjb25maWcub3JpZ2luLmZ1bmN0aW9uLFxuICAgICAgICBhdXRoVHlwZTogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuTk9ORSxcbiAgICAgICAgaW52b2tlTW9kZTogY29uZmlnLm9yaWdpbi5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLkJVRkZFUkVELFxuICAgICAgfSk7XG4gICAgICB0aGlzLmJlYXJlckZ1bmN0aW9uVXJscy5wdXNoKGZ1bmN0aW9uVXJsKTtcbiAgICAgIGNvbnN0IGZ1bmN0aW9uVXJsT3JpZ2luID0gbmV3IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4oZnVuY3Rpb25VcmwpO1xuICAgICAgY29uc3QgY3JlYXRlQmVhcmVyRnVuY3Rpb25VcmxCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgICBvcmlnaW46IGZ1bmN0aW9uVXJsT3JpZ2luLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kuQUxMX1ZJRVdFUl9FWENFUFRfSE9TVF9IRUFERVIsXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICAgIH0pO1xuICAgICAgYWRkRXhwYW5kZWRCZWhhdmlvcihjb25maWcucGF0aFBhdHRlcm5zLCBjcmVhdGVCZWFyZXJGdW5jdGlvblVybEJlaGF2aW9yKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IGRlZmF1bHRPcmlnaW4gPVxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgPyBuZXcgb3JpZ2lucy5PcmlnaW5Hcm91cCh7XG4gICAgICAgICAgICBwcmltYXJ5T3JpZ2luOiBodG1sT3JpZ2luLFxuICAgICAgICAgICAgZmFsbGJhY2tPcmlnaW46IHNzck9yaWdpbixcbiAgICAgICAgICAgIGZhbGxiYWNrU3RhdHVzQ29kZXM6IFs0MDMsIDQwNF0sXG4gICAgICAgICAgfSlcbiAgICAgICAgOiBzc3JPcmlnaW47XG4gICAgY29uc3QgZGVmYXVsdEFsbG93ZWRNZXRob2RzID1cbiAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgID8gY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TXG4gICAgICAgIDogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEw7XG5cbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICAuLi4oZW5hYmxlTG9nZ2luZyAmJiB0aGlzLmxvZ3NCdWNrZXRcbiAgICAgICAgPyB7IGVuYWJsZUxvZ2dpbmc6IHRydWUsIGxvZ0J1Y2tldDogdGhpcy5sb2dzQnVja2V0LCBsb2dGaWxlUHJlZml4OiBcImNsb3VkZnJvbnQvXCIgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICA/IHsgZG9tYWluTmFtZXM6IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIGRlZmF1bHRCZWhhdmlvcjoge1xuICAgICAgICBvcmlnaW46IGRlZmF1bHRPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogZGVmYXVsdEFsbG93ZWRNZXRob2RzLFxuICAgICAgICBjYWNoZVBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sQ2FjaGVQb2xpY3kgOiBzc3JDYWNoZVBvbGljeSxcbiAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA6IHNzck9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICAgIH0sXG4gICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICB9KTtcblxuICAgIGlmIChzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTSkge1xuICAgICAgcHJvcHMuc3NyRnVuY3Rpb24uYWRkUGVybWlzc2lvbihcIkFsbG93Q2xvdWRGcm9udEludm9rZUZ1bmN0aW9uVmlhVXJsXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLFxuICAgICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImNsb3VkZnJvbnQuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgc291cmNlQXJuOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Bcm4sXG4gICAgICAgIGludm9rZWRWaWFGdW5jdGlvblVybDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmh0bWxTdG9yZUJ1Y2tldCkge1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQuZ3JhbnRSZWFkV3JpdGUocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmlzck1ldGFkYXRhVGFibGUpIHtcbiAgICAgIHRoaXMuaXNyTWV0YWRhdGFUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh3aXJlUnVudGltZUVudikge1xuICAgICAgdGhpcy5hc3NldHNCdWNrZXQuZ3JhbnRSZWFkKHByb3BzLnNzckZ1bmN0aW9uKTtcblxuICAgICAgY29uc3Qgc3NyRnVuY3Rpb25BbnkgPSBwcm9wcy5zc3JGdW5jdGlvbiBhcyBhbnk7XG4gICAgICBpZiAodHlwZW9mIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZSB3aXJlUnVudGltZUVudiByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvbiB0byBzdXBwb3J0IGFkZEVudmlyb25tZW50OyBwYXNzIGEgbGFtYmRhLkZ1bmN0aW9uIG9yIHNldCB3aXJlUnVudGltZUVudj1mYWxzZSBhbmQgc2V0IGVudiB2YXJzIG1hbnVhbGx5XCIsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19CVUNLRVRcIiwgdGhpcy5hc3NldHNCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfUFJFRklYXCIsIGFzc2V0c0tleVByZWZpeCk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfTUFOSUZFU1RfS0VZXCIsIGFzc2V0c01hbmlmZXN0S2V5KTtcblxuICAgICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KSB7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfQlVDS0VUXCIsIHRoaXMuaHRtbFN0b3JlQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkZBQ0VUSEVPUllfSVNSX1BSRUZJWFwiLCB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCk7XG4gICAgICB9XG4gICAgICBpZiAoaXNyTWV0YWRhdGFUYWJsZU5hbWUpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQ0FDSEVfVEFCTEVfTkFNRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRvbWFpbk5hbWUgJiYgcHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogZG9tYWluTmFtZSxcbiAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gIH1cbn1cbiJdfQ==