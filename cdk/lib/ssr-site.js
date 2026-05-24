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
        const ssrPathPatterns = normalizePathPatterns(props.ssrPathPatterns);
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
AppTheorySsrSite[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "1.7.1" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFzRDtBQUN0RCwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUU5RCwyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyREFBMkQ7QUFDM0QseUNBQXlDO0FBQ3pDLDBEQUEwRDtBQUMxRCwyQ0FBdUM7QUFFdkMseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLDRCQUE0QixHQUFHLEtBQUssQ0FBQztBQUMzQyxNQUFNLHlCQUF5QixHQUFHLEVBQUUsQ0FBQztBQUNyQyxNQUFNLHlCQUF5QixHQUFHLGFBQWEsQ0FBQztBQUVoRCxJQUFZLG9CQVlYO0FBWkQsV0FBWSxvQkFBb0I7SUFDOUI7OztPQUdHO0lBQ0gsNkNBQXFCLENBQUE7SUFFckI7OztPQUdHO0lBQ0gsMkNBQW1CLENBQUE7QUFDckIsQ0FBQyxFQVpXLG9CQUFvQixvQ0FBcEIsb0JBQW9CLFFBWS9CO0FBRUQsU0FBUyxzQkFBc0IsQ0FBQyxPQUFlO0lBQzdDLE1BQU0sVUFBVSxHQUFHLElBQUEsb0NBQXFCLEVBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQyxD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Q0QsSUFBSSxvQkFBb0IsRUFBRSxDQUFDO2dCQUN6QixjQUFjLENBQUMsY0FBYyxDQUFDLDRCQUE0QixFQUFFLG9CQUFvQixDQUFDLENBQUM7Z0JBQ2xGLGNBQWMsQ0FBQyxjQUFjLENBQUMsNkJBQTZCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztnQkFDbkYsY0FBYyxDQUFDLGNBQWMsQ0FBQyxrQkFBa0IsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO2dCQUN4RSxjQUFjLENBQUMsY0FBYyxDQUFDLGFBQWEsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO1lBQ3JFLENBQUM7UUFDSCxDQUFDO1FBRUQsSUFBSSxVQUFVLElBQUksS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ25DLElBQUksT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO2dCQUN2QyxJQUFJLEVBQUUsS0FBSyxDQUFDLFVBQVU7Z0JBQ3RCLFVBQVUsRUFBRSxVQUFVO2dCQUN0QixNQUFNLEVBQUUsT0FBTyxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUMsSUFBSSxPQUFPLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO2FBQ3hGLENBQUMsQ0FBQztRQUNMLENBQUM7SUFFSCxDQUFDOztBQTllSCw0Q0ErZUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnRcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIsIHRyaW1SZXBlYXRlZENoYXJTdGFydCB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5cbmNvbnN0IGFwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW5hbC11cmlcIjtcbmNvbnN0IGZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciA9IFwieC1mYWNldGhlb3J5LW9yaWdpbmFsLXVyaVwiO1xuY29uc3QgYXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW5hbC1ob3N0XCI7XG5jb25zdCBmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyID0gXCJ4LWZhY2V0aGVvcnktb3JpZ2luYWwtaG9zdFwiO1xuY29uc3Qgc3NyT3JpZ2luYWxVcmlIZWFkZXJzID0gW2FwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyLCBmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJdIGFzIGNvbnN0O1xuY29uc3Qgc3NyT3JpZ2luYWxIb3N0SGVhZGVycyA9IFthcHB0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIsIGZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJdIGFzIGNvbnN0O1xuY29uc3Qgc3NnSXNySHlkcmF0aW9uUGF0aFBhdHRlcm4gPSBcIi9fZmFjZXRoZW9yeS9kYXRhLypcIjtcbmNvbnN0IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXggPSBcImlzclwiO1xuY29uc3QgbWF4RGVmYXVsdENhY2hlS2V5SGVhZGVycyA9IDEwO1xuY29uc3QgZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciA9IFwieC10ZW5hbnQtaWRcIjtcblxuZXhwb3J0IGVudW0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUge1xuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpcyB0aGUgZGVmYXVsdCBvcmlnaW4uIERpcmVjdCBTMyBiZWhhdmlvcnMgYXJlIHVzZWQgb25seSBmb3JcbiAgICogaW1tdXRhYmxlIGFzc2V0cyBhbmQgYW55IGV4cGxpY2l0bHkgY29uZmlndXJlZCBzdGF0aWMgcGF0aCBwYXR0ZXJucy5cbiAgICovXG4gIFNTUl9PTkxZID0gXCJzc3Itb25seVwiLFxuXG4gIC8qKlxuICAgKiBTMyBpcyB0aGUgcHJpbWFyeSBIVE1MIG9yaWdpbiBhbmQgTGFtYmRhIFNTUi9JU1IgaXMgdGhlIGZhbGxiYWNrLiBGYWNlVGhlb3J5IGh5ZHJhdGlvblxuICAgKiBkYXRhIHJvdXRlcyBhcmUga2VwdCBvbiBTMyBhbmQgdGhlIGVkZ2UgcmV3cml0ZXMgZXh0ZW5zaW9ubGVzcyBwYXRocyB0byBgL2luZGV4Lmh0bWxgLlxuICAgKi9cbiAgU1NHX0lTUiA9IFwic3NnLWlzclwiLFxufVxuXG5mdW5jdGlvbiBwYXRoUGF0dGVyblRvVXJpUHJlZml4KHBhdHRlcm46IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSB0cmltUmVwZWF0ZWRDaGFyU3RhcnQoU3RyaW5nKHBhdHRlcm4pLnRyaW0oKSwgXCIvXCIpLnJlcGxhY2UoL1xcL1xcKiQvLCBcIlwiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQgPyBgLyR7bm9ybWFsaXplZH1gIDogXCIvXCI7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBBcnJheS5mcm9tKFxuICAgIG5ldyBTZXQoXG4gICAgICAoQXJyYXkuaXNBcnJheShwYXR0ZXJucykgPyBwYXR0ZXJucyA6IFtdKVxuICAgICAgICAubWFwKChwYXR0ZXJuKSA9PiB0cmltUmVwZWF0ZWRDaGFyU3RhcnQoU3RyaW5nKHBhdHRlcm4pLnRyaW0oKSwgXCIvXCIpKVxuICAgICAgICAuZmlsdGVyKChwYXR0ZXJuKSA9PiBwYXR0ZXJuLmxlbmd0aCA+IDApLFxuICAgICksXG4gICk7XG59XG5cbmZ1bmN0aW9uIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZXhwYW5kZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgcGF0dGVybnMpIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWQpIGNvbnRpbnVlO1xuXG4gICAgZXhwYW5kZWQuYWRkKG5vcm1hbGl6ZWQpO1xuICAgIGlmIChub3JtYWxpemVkLmVuZHNXaXRoKFwiLypcIikpIHtcbiAgICAgIGNvbnN0IHJvb3RQYXR0ZXJuID0gbm9ybWFsaXplZC5zbGljZSgwLCAtMik7XG4gICAgICBpZiAocm9vdFBhdHRlcm4pIHtcbiAgICAgICAgZXhwYW5kZWQuYWRkKHJvb3RQYXR0ZXJuKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gQXJyYXkuZnJvbShleHBhbmRlZCk7XG59XG5cbmZ1bmN0aW9uIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFxuICBsYWJlbDogc3RyaW5nLFxuICBwYXR0ZXJuczogc3RyaW5nW10sXG4gIHNlZW5Pd25lcnM6IE1hcDxzdHJpbmcsIHN0cmluZz4sXG4pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgIGNvbnN0IG93bmVyID0gc2Vlbk93bmVycy5nZXQocGF0dGVybik7XG4gICAgaWYgKG93bmVyICYmIG93bmVyICE9PSBsYWJlbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIHJlY2VpdmVkIG92ZXJsYXBwaW5nIHBhdGggcGF0dGVybiBcIiR7cGF0dGVybn1cIiBmb3IgJHtvd25lcn0gYW5kICR7bGFiZWx9YCk7XG4gICAgfVxuICAgIHNlZW5Pd25lcnMuc2V0KHBhdHRlcm4sIGxhYmVsKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5vbmljYWxpemVIZWFkZXJOYW1lKGhlYWRlcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyhoZWFkZXIpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5mdW5jdGlvbiBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IGNhbm9uaWNhbGl6ZUhlYWRlck5hbWUoaGVhZGVyKS5yZXBsYWNlKC9bXmEtejAtOV0rL2csIFwiLVwiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQgPT09IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgfHwgLyhefC0pdGVuYW50KC18JCkvLnRlc3Qobm9ybWFsaXplZCk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVxdWVzdEZ1bmN0aW9uQ29kZShcbiAgbW9kZTogQXBwVGhlb3J5U3NyU2l0ZU1vZGUsXG4gIHJhd1MzUGF0aFBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgbGFtYmRhUGFzc3Rocm91Z2hQYXRoUGF0dGVybnM6IHN0cmluZ1tdLFxuICBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyczogc3RyaW5nW10sXG4pOiBzdHJpbmcge1xuICBjb25zdCByYXdTM1ByZWZpeGVzID0gcmF3UzNQYXRoUGF0dGVybnMubWFwKHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgpLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpO1xuICBjb25zdCByYXdTM1ByZWZpeExpc3QgPSByYXdTM1ByZWZpeGVzLm1hcCgocHJlZml4KSA9PiBgJyR7cHJlZml4fSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zXG4gICAgLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG4gIGNvbnN0IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJMaXN0ID0gYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMubWFwKChoZWFkZXIpID0+IGAnJHtoZWFkZXJ9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuXG4gIHJldHVybiBgXG5cdGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcblx0ICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG5cdCAgcmVxdWVzdC5oZWFkZXJzID0gcmVxdWVzdC5oZWFkZXJzIHx8IHt9O1xuXHQgIHZhciBoZWFkZXJzID0gcmVxdWVzdC5oZWFkZXJzO1xuXHQgIHZhciB1cmkgPSByZXF1ZXN0LnVyaSB8fCAnLyc7XG5cdCAgdmFyIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzID0gW1xuXHQgICAgJHtibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyTGlzdH1cblx0ICBdO1xuXG5cdCAgZm9yICh2YXIgYmxvY2tlZEluZGV4ID0gMDsgYmxvY2tlZEluZGV4IDwgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMubGVuZ3RoOyBibG9ja2VkSW5kZXgrKykge1xuXHQgICAgZGVsZXRlIGhlYWRlcnNbYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnNbYmxvY2tlZEluZGV4XV07XG5cdCAgfVxuXG5cdCAgdmFyIHJlcXVlc3RJZEhlYWRlciA9IGhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddO1xuXHQgIHZhciByZXF1ZXN0SWQgPSByZXF1ZXN0SWRIZWFkZXIgJiYgcmVxdWVzdElkSGVhZGVyLnZhbHVlID8gcmVxdWVzdElkSGVhZGVyLnZhbHVlLnRyaW0oKSA6ICcnO1xuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9IGV2ZW50LmNvbnRleHQgJiYgZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQgPyBTdHJpbmcoZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQpLnRyaW0oKSA6ICcnO1xuXHQgIH1cblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSAncmVxXycgKyBEYXRlLm5vdygpLnRvU3RyaW5nKDM2KSArICdfJyArIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDEwKTtcblx0ICB9XG5cblx0ICBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSA9IHsgdmFsdWU6IHJlcXVlc3RJZCB9O1xuXHQgIGhlYWRlcnNbJyR7YXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblx0ICBoZWFkZXJzWycke2ZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcn0nXSA9IHsgdmFsdWU6IHVyaSB9O1xuXG5cdCAgaWYgKGhlYWRlcnMuaG9zdCAmJiBoZWFkZXJzLmhvc3QudmFsdWUpIHtcblx0ICAgIGhlYWRlcnNbJyR7YXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgICBoZWFkZXJzWycke2ZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJ9J10gPSB7IHZhbHVlOiBoZWFkZXJzLmhvc3QudmFsdWUgfTtcblx0ICB9XG5cblx0ICBpZiAoJyR7bW9kZX0nID09PSAnJHtBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSfScpIHtcblx0ICAgIHZhciByYXdTM1ByZWZpeGVzID0gW1xuXHQgICAgICAke3Jhd1MzUHJlZml4TGlzdH1cblx0ICAgIF07XG5cdCAgICB2YXIgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtsYW1iZGFQYXNzdGhyb3VnaFByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGlzTGFtYmRhUGFzc3Rocm91Z2hQYXRoID0gZmFsc2U7XG5cblx0ICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5sZW5ndGg7IGkrKykge1xuXHQgICAgICB2YXIgcHJlZml4ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlc1tpXTtcblx0ICAgICAgaWYgKHVyaSA9PT0gcHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHByZWZpeCArICcvJykpIHtcblx0ICAgICAgICBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IHRydWU7XG5cdCAgICAgICAgYnJlYWs7XG5cdCAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgaWYgKCFpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCkge1xuXHQgICAgICB2YXIgaXNSYXdTM1BhdGggPSBmYWxzZTtcblxuXHQgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IHJhd1MzUHJlZml4ZXMubGVuZ3RoOyBqKyspIHtcblx0ICAgICAgICB2YXIgcmF3UHJlZml4ID0gcmF3UzNQcmVmaXhlc1tqXTtcblx0ICAgICAgICBpZiAodXJpID09PSByYXdQcmVmaXggfHwgdXJpLnN0YXJ0c1dpdGgocmF3UHJlZml4ICsgJy8nKSkge1xuXHQgICAgICAgICAgaXNSYXdTM1BhdGggPSB0cnVlO1xuXHQgICAgICAgICAgYnJlYWs7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cblx0ICAgICAgdmFyIGxhc3RTbGFzaCA9IHVyaS5sYXN0SW5kZXhPZignLycpO1xuXHQgICAgICB2YXIgbGFzdFNlZ21lbnQgPSBsYXN0U2xhc2ggPj0gMCA/IHVyaS5zdWJzdHJpbmcobGFzdFNsYXNoICsgMSkgOiB1cmk7XG5cblx0ICAgICAgaWYgKCFpc1Jhd1MzUGF0aCAmJiBsYXN0U2VnbWVudC5pbmRleE9mKCcuJykgPT09IC0xKSB7XG5cdCAgICAgICAgcmVxdWVzdC51cmkgPSB1cmkuZW5kc1dpdGgoJy8nKSA/IHVyaSArICdpbmRleC5odG1sJyA6IHVyaSArICcvaW5kZXguaHRtbCc7XG5cdCAgICAgIH1cblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVxdWVzdDtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uQ29kZSgpOiBzdHJpbmcge1xuICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHZhciByZXNwb25zZSA9IGV2ZW50LnJlc3BvbnNlO1xuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSByZXF1ZXN0LmhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddO1xuXHQgIHZhciByZXF1ZXN0SWQgPSByZXF1ZXN0SWRIZWFkZXIgJiYgcmVxdWVzdElkSGVhZGVyLnZhbHVlID8gcmVxdWVzdElkSGVhZGVyLnZhbHVlLnRyaW0oKSA6ICcnO1xuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9IGV2ZW50LmNvbnRleHQgJiYgZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQgPyBTdHJpbmcoZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQpLnRyaW0oKSA6ICcnO1xuXHQgIH1cblxuXHQgIGlmIChyZXF1ZXN0SWQpIHtcblx0ICAgIHJlc3BvbnNlLmhlYWRlcnMgPSByZXNwb25zZS5oZWFkZXJzIHx8IHt9O1xuXHQgICAgaWYgKCFyZXNwb25zZS5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSkge1xuXHQgICAgICByZXNwb25zZS5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSA9IHsgdmFsdWU6IHJlcXVlc3RJZCB9O1xuXHQgICAgfVxuXHQgIH1cblxuXHQgIHJldHVybiByZXNwb25zZTtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTc3JTaXRlUHJvcHMge1xuICByZWFkb25seSBzc3JGdW5jdGlvbjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogRXhwbGljaXQgZGVwbG95bWVudCBtb2RlIGZvciB0aGUgc2l0ZSB0b3BvbG9neS5cbiAgICpcbiAgICogLSBgc3NyLW9ubHlgOiBMYW1iZGEgRnVuY3Rpb24gVVJMIGlzIHRoZSBkZWZhdWx0IG9yaWdpblxuICAgKiAtIGBzc2ctaXNyYDogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBpcyB0aGUgZmFsbGJhY2tcbiAgICpcbiAgICogRXhpc3RpbmcgaW1wbGljaXQgYmVoYXZpb3IgbWFwcyB0byBgc3NyLW9ubHlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU1JfT05MWVxuICAgKi9cbiAgcmVhZG9ubHkgbW9kZT86IEFwcFRoZW9yeVNzclNpdGVNb2RlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGludm9rZSBtb2RlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkludm9rZU1vZGUuUkVTUE9OU0VfU1RSRUFNXG4gICAqL1xuICByZWFkb25seSBpbnZva2VNb2RlPzogbGFtYmRhLkludm9rZU1vZGU7XG5cbiAgLyoqXG4gICAqIEZ1bmN0aW9uIFVSTCBhdXRoIHR5cGUgZm9yIHRoZSBTU1Igb3JpZ2luLlxuICAgKlxuICAgKiBJZiBvbWl0dGVkLCBBcHBUaGVvcnkgZmFpbHMgY2xvc2VkIHRvIGBBV1NfSUFNYCBhbmQgc2lnbnMgQ2xvdWRGcm9udC10by1MYW1iZGFcbiAgICogdHJhZmZpYyB3aXRoIGxhbWJkYSBPcmlnaW4gQWNjZXNzIENvbnRyb2wuXG4gICAqXG4gICAqIFNldCB0aGlzIGV4cGxpY2l0bHkgdG8gYE5PTkVgIG9ubHkgd2hlbiB5b3UgaW50ZW50aW9uYWxseSByZXF1aXJlIHB1YmxpY1xuICAgKiBkaXJlY3QgRnVuY3Rpb24gVVJMIGFjY2VzcyBhcyBhIGRlbGliZXJhdGUgY29tcGF0aWJpbGl0eSBjaG9pY2UuXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICovXG4gIHJlYWRvbmx5IHNzclVybEF1dGhUeXBlPzogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGU7XG5cbiAgcmVhZG9ubHkgYXNzZXRzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcmVhZG9ubHkgYXNzZXRzUGF0aD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4Pzogc3RyaW5nO1xuICByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgUzMgYnVja2V0IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlIChgUzNIdG1sU3RvcmVgKS5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlczpcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfQlVDS0VUYFxuICAgKiAtIGBGQUNFVEhFT1JZX0lTUl9QUkVGSVhgXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBTMyBrZXkgcHJlZml4IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlLlxuICAgKiBAZGVmYXVsdCBpc3JcbiAgICovXG4gIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBleHRlbnNpb25sZXNzIEhUTUwgc2VjdGlvbiBwYXRoIHBhdHRlcm5zIHRvIHJvdXRlIGRpcmVjdGx5IHRvIHRoZSBwcmltYXJ5IEhUTUwgUzMgb3JpZ2luLlxuICAgKlxuICAgKiBSZXF1ZXN0cyBsaWtlIGAvbWFya2V0aW5nYCBhbmQgYC9tYXJrZXRpbmcvLi4uYCBhcmUgcmV3cml0dGVuIHRvIGAvaW5kZXguaHRtbGBcbiAgICogd2l0aGluIHRoZSBzZWN0aW9uIGFuZCBzdGF5IG9uIFMzIGluc3RlYWQgb2YgZmFsbGluZyBiYWNrIHRvIExhbWJkYS5cbiAgICpcbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgSFRNTCBzZWN0aW9uIHBhdGg6IFwiL21hcmtldGluZy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YXRpY1BhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIHJhdyBTMyBvYmplY3QvZGF0YSBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBleHRlbnNpb25sZXNzIEhUTUwgcmV3cml0ZXMuXG4gICAqXG4gICAqIEluIGBzc2ctaXNyYCBtb2RlLCBgL19mYWNldGhlb3J5L2RhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseS5cbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgb2JqZWN0IHBhdGg6IFwiL2ZlZWRzLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgZGlyZWN0UzNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyB0aGUgYHNzZy1pc3JgIG9yaWdpbiBncm91cCBhbmQgcm91dGUgZGlyZWN0bHlcbiAgICogdG8gdGhlIExhbWJkYSBGdW5jdGlvbiBVUkwgd2l0aCBmdWxsIG1ldGhvZCBzdXBwb3J0LlxuICAgKlxuICAgKiBVc2UgdGhpcyBmb3Igc2FtZS1vcmlnaW4gZHluYW1pYyBwYXRocyBzdWNoIGFzIGF1dGggY2FsbGJhY2tzLCBhY3Rpb25zLCBvciBmb3JtIHBvc3RzLlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TU1IgcGF0aDogXCIvYWN0aW9ucy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHNzclBhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGJlYXJlci1hdXRoIExhbWJkYSBGdW5jdGlvbiBVUkwgY28tb3JpZ2lucyB0byBhdHRhY2ggdG8gdGhlIHNhbWUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIGVhY2ggY28tb3JpZ2luIEZ1bmN0aW9uIFVSTCB3aXRoIGBBdXRoVHlwZS5OT05FYCBhbmQgcm91dGVzIHRoZSBzdXBwbGllZFxuICAgKiBwYXRoIHBhdHRlcm5zIHRvIGl0IHdpdGhvdXQgTGFtYmRhIE9yaWdpbiBBY2Nlc3MgQ29udHJvbC4gVGhlIFNTUiBvcmlnaW4gcmVtYWlucyBnb3Zlcm5lZCBieVxuICAgKiBgc3NyVXJsQXV0aFR5cGVgIGFuZCBzdGlsbCBkZWZhdWx0cyB0byBgQVdTX0lBTWAgcGx1cyBMYW1iZGEgT0FDLlxuICAgKlxuICAgKiBDby1vcmlnaW4gcGF0aHMgcGFydGljaXBhdGUgaW4gQXBwVGhlb3J5J3MgYmVoYXZpb3IgcGF0aCBjb2xsaXNpb24gY2hlY2tzIGFuZCBieXBhc3MgYHNzZy1pc3JgXG4gICAqIEhUTUwgcmV3cml0ZXMuIFRoaXMgaXMgdGhlIHN1cHBvcnRlZCBBcHBUaGVvcnkgcGF0aCBmb3IgbWl4ZWQtYXV0aCBkaXN0cmlidXRpb25zOyBkbyBub3QgaGFuZC13aXJlXG4gICAqIHJhdyBgZGlzdHJpYnV0aW9uLmFkZEJlaGF2aW9yKC4uLilgIGNhbGxzIHdoZW4gQXBwVGhlb3J5IHNob3VsZCBvd24gcGF0aCBhbmQgZWRnZS1jb250ZXh0IHBvbGljeS5cbiAgICpcbiAgICogRXhhbXBsZSBiZWFyZXIgQVBJIHBhdGhzOiBgW1wiL2FwaS8qXCIsIFwiL2F1dGgvKlwiXWAuXG4gICAqL1xuICByZWFkb25seSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnM/OiBBcHBUaGVvcnlTc3JTaXRlQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5bXTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgVGFibGVUaGVvcnkvRHluYW1vREIgdGFibGUgdXNlZCBmb3IgRmFjZVRoZW9yeSBJU1IgbWV0YWRhdGEgYW5kIGxlYXNlIGNvb3JkaW5hdGlvbi5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlcyB0aGVcbiAgICogbWV0YWRhdGEgdGFibGUgYWxpYXNlcyBleHBlY3RlZCBieSB0aGUgZG9jdW1lbnRlZCBGYWNlVGhlb3J5IGRlcGxveW1lbnQgc2hhcGUuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBJU1IvY2FjaGUgbWV0YWRhdGEgdGFibGUgbmFtZSB0byB3aXJlIHdoZW4geW91IGFyZSBub3QgcGFzc2luZyBgaXNyTWV0YWRhdGFUYWJsZWAuXG4gICAqXG4gICAqIFByZWZlciBgaXNyTWV0YWRhdGFUYWJsZWAgd2hlbiBBcHBUaGVvcnkgc2hvdWxkIGFsc28gZ3JhbnQgYWNjZXNzIHRvIHRoZSBTU1IgTGFtYmRhLlxuICAgKi9cbiAgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExlZ2FjeSBhbGlhcyBmb3IgYGlzck1ldGFkYXRhVGFibGVOYW1lYC5cbiAgICogQGRlcHJlY2F0ZWQgcHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCBvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgXG4gICAqL1xuICByZWFkb25seSBjYWNoZVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvLyBXaGVuIHRydWUgKGRlZmF1bHQpLCBBcHBUaGVvcnkgd2lyZXMgcmVjb21tZW5kZWQgcnVudGltZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgb250byB0aGUgU1NSIGZ1bmN0aW9uLlxuICByZWFkb25seSB3aXJlUnVudGltZUVudj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgaGVhZGVycyB0byBmb3J3YXJkIHRvIHRoZSBTU1Igb3JpZ2luIChMYW1iZGEgRnVuY3Rpb24gVVJMKSB2aWEgdGhlIG9yaWdpbiByZXF1ZXN0IHBvbGljeS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5L0ZhY2VUaGVvcnktc2FmZSBlZGdlIGNvbnRyYWN0IGZvcndhcmRzIG9ubHk6XG4gICAqIC0gYGNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvYFxuICAgKiAtIGBjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzYFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWZhY2V0aGVvcnktb3JpZ2luYWwtdXJpYFxuICAgKiAtIGB4LXJlcXVlc3QtaWRgXG4gICAqXG4gICAqIFVzZSB0aGlzIHRvIG9wdCBpbiB0byBhZGRpdGlvbmFsIGFwcC1zcGVjaWZpYyBoZWFkZXJzIHN1Y2ggYXNcbiAgICogYHgtZmFjZXRoZW9yeS1zZWdtZW50YC4gVGVuYW50LWxpa2Ugdmlld2VyIGhlYWRlcnMgYXJlIHJlamVjdGVkIHVubGVzc1xuICAgKiBgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzYCBpcyBleHBsaWNpdGx5IGVuYWJsZWQgYXMgYSBjb21wYXRpYmlsaXR5IG1vZGUuXG4gICAqIGBob3N0YCBhbmQgYHgtZm9yd2FyZGVkLXByb3RvYCBhcmUgcmVqZWN0ZWQgYmVjYXVzZSB0aGV5IGJyZWFrIG9yIGJ5cGFzcyB0aGVcbiAgICogc3VwcG9ydGVkIG9yaWdpbiBtb2RlbC5cbiAgICovXG4gIHJlYWRvbmx5IHNzckZvcndhcmRIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIENvbXBhdGliaWxpdHkgZXNjYXBlIGhhdGNoIGZvciBsZWdhY3kgdmlld2VyLXN1cHBsaWVkIHRlbmFudCBoZWFkZXJzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlIChkZWZhdWx0KSwgQXBwVGhlb3J5IHN0cmlwcyBgeC10ZW5hbnQtaWRgIGF0IHRoZSBlZGdlIGFuZCByZWplY3RzXG4gICAqIHRlbmFudC1saWtlIGVudHJpZXMgaW4gYHNzckZvcndhcmRIZWFkZXJzYCBzbyB2aWV3ZXItc3VwcGxpZWQgdGVuYW50IGhlYWRlcnNcbiAgICogY2Fubm90IGluZmx1ZW5jZSBvcmlnaW4gcm91dGluZyBvciBIVE1MIGNhY2hlIHBhcnRpdGlvbmluZy4gV2hlbiB0cnVlLFxuICAgKiBBcHBUaGVvcnkgcmVzdG9yZXMgbGVnYWN5IHBhc3N0aHJvdWdoIGJlaGF2aW9yIGZvciBgeC10ZW5hbnQtaWRgIGFuZCBhbnlcbiAgICogdGVuYW50LWxpa2UgYHNzckZvcndhcmRIZWFkZXJzYC5cbiAgICpcbiAgICogUHJlZmVyIGRlcml2aW5nIHRlbmFudCBmcm9tIHRydXN0ZWQgaG9zdCBtYXBwaW5nIHVzaW5nIHRoZSBvcmlnaW5hbC1ob3N0XG4gICAqIGVkZ2UgaGVhZGVycyBpbnN0ZWFkIG9mIGVuYWJsaW5nIHBhc3N0aHJvdWdoLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPzogYm9vbGVhbjtcblxuICByZWFkb25seSBlbmFibGVMb2dnaW5nPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgLyoqXG4gICAqIENsb3VkRnJvbnQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgYXBwbGllZCB0byBTU1IgYW5kIGRpcmVjdC1TMyBiZWhhdmlvcnMuXG4gICAqXG4gICAqIElmIG9taXR0ZWQsIEFwcFRoZW9yeSBwcm92aXNpb25zIGEgRmFjZVRoZW9yeS1hbGlnbmVkIGJhc2VsaW5lIHBvbGljeSBhdCB0aGUgQ0ROXG4gICAqIGxheWVyOiBIU1RTLCBub3NuaWZmLCBmcmFtZS1vcHRpb25zLCByZWZlcnJlci1wb2xpY3ksIFhTUyBwcm90ZWN0aW9uLCBhbmQgYVxuICAgKiByZXN0cmljdGl2ZSBwZXJtaXNzaW9ucy1wb2xpY3kuIENvbnRlbnQtU2VjdXJpdHktUG9saWN5IHJlbWFpbnMgb3JpZ2luLWRlZmluZWQuXG4gICAqL1xuICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgLyoqXG4gICAqIENhY2hlIHBvbGljeSBhcHBsaWVkIHRvIGRpcmVjdCBMYW1iZGEtYmFja2VkIFNTUiBiZWhhdmlvcnMuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IGlzIGBDQUNISU5HX0RJU0FCTEVEYCBzbyBkeW5hbWljIExhbWJkYSByb3V0ZXMgc3RheSBzYWZlIHVubGVzcyB5b3VcbiAgICogaW50ZW50aW9uYWxseSBvcHQgaW50byBhIGNhY2hlIHBvbGljeSB0aGF0IG1hdGNoZXMgeW91ciBhcHAncyB2YXJpYW5jZSBtb2RlbC5cbiAgICogQGRlZmF1bHQgY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVEXG4gICAqL1xuICByZWFkb25seSBzc3JDYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gIC8qKlxuICAgKiBDYWNoZSBwb2xpY3kgYXBwbGllZCB0byB0aGUgY2FjaGVhYmxlIEhUTUwgYmVoYXZpb3IgaW4gYHNzZy1pc3JgIG1vZGUuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IEFwcFRoZW9yeSBwb2xpY3kga2V5cyBvbiBxdWVyeSBzdHJpbmdzIHBsdXMgdGhlIHN0YWJsZSBwdWJsaWMgSFRNTFxuICAgKiB2YXJpYW50IGhlYWRlcnMgKGB4LSotb3JpZ2luYWwtaG9zdGAgYW5kIGFueSBub24tdGVuYW50IGV4dHJhIGZvcndhcmRlZFxuICAgKiBoZWFkZXJzIHlvdSBvcHQgaW50bykgd2hpbGUgbGVhdmluZyBjb29raWVzIG91dCBvZiB0aGUgY2FjaGUga2V5LiBUZW5hbnQtbGlrZVxuICAgKiB2aWV3ZXIgaGVhZGVycyBqb2luIHRoZSBjYWNoZSBrZXkgb25seSB3aGVuIGBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNgIGlzXG4gICAqIGV4cGxpY2l0bHkgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IGh0bWxDYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZG9tYWluTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVNzclNpdGVCZWFyZXJGdW5jdGlvblVybE9yaWdpbiB7XG4gIC8qKlxuICAgKiBMYW1iZGEgZnVuY3Rpb24gdGhhdCBBcHBUaGVvcnkgZXhwb3NlcyBhcyBhIGJlYXJlci1hdXRoIEZ1bmN0aW9uIFVSTCBjby1vcmlnaW4uXG4gICAqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIHRoZSBGdW5jdGlvbiBVUkwgd2l0aCBgbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuTk9ORWA7IGF1dGhlbnRpY2F0aW9uIHJlbWFpbnNcbiAgICogdGhlIHJlc3BvbnNpYmlsaXR5IG9mIHRoZSBMYW1iZGEgaGFuZGxlci5cbiAgICovXG4gIHJlYWRvbmx5IGZ1bmN0aW9uOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBDbG91ZEZyb250IHBhdGggcGF0dGVybnMgdGhhdCByb3V0ZSB0byB0aGlzIGNvLW9yaWdpbi5cbiAgICpcbiAgICogUGF0dGVybnMgYXJlIG5vcm1hbGl6ZWQgdGhlIHNhbWUgd2F5IGFzIGBzc3JQYXRoUGF0dGVybnNgLiBBIHBhdHRlcm4gZW5kaW5nIGluIGAvKmAgYWxzbyBjcmVhdGVzXG4gICAqIGEgcm9vdCBiZWhhdmlvciB3aXRob3V0IHRoZSB3aWxkY2FyZCBzbyBgL2FwaS8qYCBjb3ZlcnMgYm90aCBgL2FwaWAgYW5kIGAvYXBpLy4uLmAuXG4gICAqL1xuICByZWFkb25seSBwYXRoUGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGludm9rZSBtb2RlIGZvciB0aGlzIGNvLW9yaWdpbi5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkludm9rZU1vZGUuQlVGRkVSRURcbiAgICovXG4gIHJlYWRvbmx5IGludm9rZU1vZGU/OiBsYW1iZGEuSW52b2tlTW9kZTtcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVNzclNpdGUgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzQnVja2V0OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleTogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaHRtbFN0b3JlQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IHNzclVybDogbGFtYmRhLkZ1bmN0aW9uVXJsO1xuICBwdWJsaWMgcmVhZG9ubHkgYmVhcmVyRnVuY3Rpb25VcmxzOiBsYW1iZGEuRnVuY3Rpb25VcmxbXTtcbiAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG4gIHB1YmxpYyByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG4gIHB1YmxpYyByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k6IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5U3NyU2l0ZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmICghcHJvcHM/LnNzckZ1bmN0aW9uKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIHByb3BzLnNzckZ1bmN0aW9uXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IHNpdGVNb2RlID0gcHJvcHMubW9kZSA/PyBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU1JfT05MWTtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCBhdXRvRGVsZXRlT2JqZWN0cyA9IHByb3BzLmF1dG9EZWxldGVPYmplY3RzID8/IGZhbHNlO1xuICAgIGNvbnN0IHdpcmVSdW50aW1lRW52ID0gcHJvcHMud2lyZVJ1bnRpbWVFbnYgPz8gdHJ1ZTtcblxuICAgIHRoaXMuYXNzZXRzQnVja2V0ID1cbiAgICAgIHByb3BzLmFzc2V0c0J1Y2tldCA/P1xuICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkFzc2V0c0J1Y2tldFwiLCB7XG4gICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICB9KTtcblxuICAgIGNvbnN0IGVuYWJsZUxvZ2dpbmcgPSBwcm9wcy5lbmFibGVMb2dnaW5nID8/IHRydWU7XG4gICAgaWYgKGVuYWJsZUxvZ2dpbmcpIHtcbiAgICAgIHRoaXMubG9nc0J1Y2tldCA9XG4gICAgICAgIHByb3BzLmxvZ3NCdWNrZXQgPz9cbiAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkNsb3VkRnJvbnRMb2dzQnVja2V0XCIsIHtcbiAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuT0JKRUNUX1dSSVRFUixcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3QgYXNzZXRzUHJlZml4UmF3ID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcocHJvcHMuYXNzZXRzS2V5UHJlZml4ID8/IFwiYXNzZXRzXCIpLnRyaW0oKSwgXCIvXCIpO1xuICAgIGNvbnN0IGFzc2V0c0tleVByZWZpeCA9IGFzc2V0c1ByZWZpeFJhdyB8fCBcImFzc2V0c1wiO1xuXG4gICAgY29uc3QgbWFuaWZlc3RSYXcgPSBTdHJpbmcocHJvcHMuYXNzZXRzTWFuaWZlc3RLZXkgPz8gYCR7YXNzZXRzS2V5UHJlZml4fS9tYW5pZmVzdC5qc29uYCkudHJpbSgpO1xuICAgIGNvbnN0IG1hbmlmZXN0S2V5ID0gdHJpbVJlcGVhdGVkQ2hhcihtYW5pZmVzdFJhdywgXCIvXCIpO1xuICAgIGNvbnN0IGFzc2V0c01hbmlmZXN0S2V5ID0gbWFuaWZlc3RLZXkgfHwgYCR7YXNzZXRzS2V5UHJlZml4fS9tYW5pZmVzdC5qc29uYDtcblxuICAgIHRoaXMuYXNzZXRzS2V5UHJlZml4ID0gYXNzZXRzS2V5UHJlZml4O1xuICAgIHRoaXMuYXNzZXRzTWFuaWZlc3RLZXkgPSBhc3NldHNNYW5pZmVzdEtleTtcblxuICAgIGNvbnN0IGh0bWxTdG9yZUtleVByZWZpeElucHV0ID0gU3RyaW5nKHByb3BzLmh0bWxTdG9yZUtleVByZWZpeCA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3Qgc2hvdWxkQ29uZmlndXJlSHRtbFN0b3JlID0gQm9vbGVhbihwcm9wcy5odG1sU3RvcmVCdWNrZXQpIHx8IGh0bWxTdG9yZUtleVByZWZpeElucHV0Lmxlbmd0aCA+IDA7XG4gICAgaWYgKHNob3VsZENvbmZpZ3VyZUh0bWxTdG9yZSkge1xuICAgICAgY29uc3QgaHRtbFN0b3JlUHJlZml4UmF3ID0gdHJpbVJlcGVhdGVkQ2hhcihcbiAgICAgICAgU3RyaW5nKHByb3BzLmh0bWxTdG9yZUtleVByZWZpeCA/PyBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4KS50cmltKCksXG4gICAgICAgIFwiL1wiLFxuICAgICAgKTtcbiAgICAgIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4ID0gaHRtbFN0b3JlUHJlZml4UmF3IHx8IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXg7XG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldCA9XG4gICAgICAgIHByb3BzLmh0bWxTdG9yZUJ1Y2tldCA/P1xuICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiSHRtbFN0b3JlQnVja2V0XCIsIHtcbiAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHRoaXMuaXNyTWV0YWRhdGFUYWJsZSA9IHByb3BzLmlzck1ldGFkYXRhVGFibGU7XG5cbiAgICBjb25zdCBleHBsaWNpdElzck1ldGFkYXRhVGFibGVOYW1lID0gU3RyaW5nKHByb3BzLmlzck1ldGFkYXRhVGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBsZWdhY3lDYWNoZVRhYmxlTmFtZSA9IFN0cmluZyhwcm9wcy5jYWNoZVRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgcmVzb3VyY2VJc3JNZXRhZGF0YVRhYmxlTmFtZSA9IFN0cmluZyh0aGlzLmlzck1ldGFkYXRhVGFibGU/LnRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG5cbiAgICBjb25zdCBjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIFtyZXNvdXJjZUlzck1ldGFkYXRhVGFibGVOYW1lLCBleHBsaWNpdElzck1ldGFkYXRhVGFibGVOYW1lLCBsZWdhY3lDYWNoZVRhYmxlTmFtZV0uZmlsdGVyKFxuICAgICAgICAgIChuYW1lKSA9PiBTdHJpbmcobmFtZSkudHJpbSgpLmxlbmd0aCA+IDAsXG4gICAgICAgICksXG4gICAgICApLFxuICAgICk7XG5cbiAgICBpZiAoY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcy5sZW5ndGggPiAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIHJlY2VpdmVkIGNvbmZsaWN0aW5nIElTUiBtZXRhZGF0YSB0YWJsZSBuYW1lczogJHtjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBpc3JNZXRhZGF0YVRhYmxlTmFtZSA9IGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXNbMF0gPz8gXCJcIjtcblxuICAgIGlmIChwcm9wcy5hc3NldHNQYXRoKSB7XG4gICAgICBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCBcIkFzc2V0c0RlcGxveW1lbnRcIiwge1xuICAgICAgICBzb3VyY2VzOiBbczNkZXBsb3kuU291cmNlLmFzc2V0KHByb3BzLmFzc2V0c1BhdGgpXSxcbiAgICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IHRoaXMuYXNzZXRzQnVja2V0LFxuICAgICAgICBkZXN0aW5hdGlvbktleVByZWZpeDogYXNzZXRzS2V5UHJlZml4LFxuICAgICAgICBwcnVuZTogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YXRpY1BhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhwcm9wcy5zdGF0aWNQYXRoUGF0dGVybnMpO1xuICAgIGNvbnN0IGRpcmVjdFMzUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKFtcbiAgICAgIC4uLihzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IFtzc2dJc3JIeWRyYXRpb25QYXRoUGF0dGVybl0gOiBbXSksXG4gICAgICAuLi4oQXJyYXkuaXNBcnJheShwcm9wcy5kaXJlY3RTM1BhdGhQYXR0ZXJucykgPyBwcm9wcy5kaXJlY3RTM1BhdGhQYXR0ZXJucyA6IFtdKSxcbiAgICBdKTtcbiAgICBjb25zdCBzc3JQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMocHJvcHMuc3NyUGF0aFBhdHRlcm5zKTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMgPSBBcnJheS5pc0FycmF5KHByb3BzLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucylcbiAgICAgID8gcHJvcHMuYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zXG4gICAgICA6IFtdO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncyA9IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucy5tYXAoKG9yaWdpbiwgaW5kZXgpID0+IHtcbiAgICAgIGlmICghb3JpZ2luPy5mdW5jdGlvbikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zWyR7aW5kZXh9XSByZXF1aXJlcyBmdW5jdGlvbmApO1xuICAgICAgfVxuICAgICAgY29uc3QgcGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKG9yaWdpbi5wYXRoUGF0dGVybnMpO1xuICAgICAgaWYgKHBhdGhQYXR0ZXJucy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1ske2luZGV4fV0gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHBhdGggcGF0dGVybmApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHsgb3JpZ2luLCBwYXRoUGF0dGVybnMgfTtcbiAgICB9KTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybFBhdGhQYXR0ZXJucyA9IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mbGF0TWFwKChjb25maWcpID0+IGNvbmZpZy5wYXRoUGF0dGVybnMpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybk93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgY29uc3Qgc3NyVXJsQXV0aFR5cGUgPSBwcm9wcy5zc3JVcmxBdXRoVHlwZSA/PyBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNO1xuICAgIGNvbnN0IGFsbG93Vmlld2VyVGVuYW50SGVhZGVycyA9IHByb3BzLmFsbG93Vmlld2VyVGVuYW50SGVhZGVycyA/PyBmYWxzZTtcblxuICAgIHRoaXMuc3NyVXJsID0gbmV3IGxhbWJkYS5GdW5jdGlvblVybCh0aGlzLCBcIlNzclVybFwiLCB7XG4gICAgICBmdW5jdGlvbjogcHJvcHMuc3NyRnVuY3Rpb24sXG4gICAgICBhdXRoVHlwZTogc3NyVXJsQXV0aFR5cGUsXG4gICAgICBpbnZva2VNb2RlOiBwcm9wcy5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNzck9yaWdpbiA9XG4gICAgICBzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTVxuICAgICAgICA/IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5zc3JVcmwpXG4gICAgICAgIDogbmV3IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4odGhpcy5zc3JVcmwpO1xuXG4gICAgY29uc3QgYXNzZXRzT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCh0aGlzLmFzc2V0c0J1Y2tldCk7XG4gICAgY29uc3QgaHRtbE9yaWdpbkJ1Y2tldCA9IHRoaXMuaHRtbFN0b3JlQnVja2V0ID8/IHRoaXMuYXNzZXRzQnVja2V0O1xuICAgIGNvbnN0IGh0bWxPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKFxuICAgICAgaHRtbE9yaWdpbkJ1Y2tldCxcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4XG4gICAgICAgID8ge1xuICAgICAgICAgICAgb3JpZ2luUGF0aDogYC8ke3RoaXMuaHRtbFN0b3JlS2V5UHJlZml4fWAsXG4gICAgICAgICAgfVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICApO1xuXG4gICAgY29uc3QgYmFzZVNzckZvcndhcmRIZWFkZXJzID0gW1xuICAgICAgXCJjbG91ZGZyb250LWZvcndhcmRlZC1wcm90b1wiLFxuICAgICAgXCJjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzXCIsXG4gICAgICAuLi5zc3JPcmlnaW5hbEhvc3RIZWFkZXJzLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdO1xuXG4gICAgY29uc3QgZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzID0gbmV3IFNldChbXCJob3N0XCIsIFwieC1mb3J3YXJkZWQtcHJvdG9cIl0pO1xuXG4gICAgY29uc3QgZXh0cmFTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmlzQXJyYXkocHJvcHMuc3NyRm9yd2FyZEhlYWRlcnMpXG4gICAgICA/IHByb3BzLnNzckZvcndhcmRIZWFkZXJzLm1hcChjYW5vbmljYWxpemVIZWFkZXJOYW1lKS5maWx0ZXIoKGhlYWRlcikgPT4gaGVhZGVyLmxlbmd0aCA+IDApXG4gICAgICA6IFtdO1xuXG4gICAgY29uc3QgcmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmhhcyhoZWFkZXIpKSksXG4gICAgKS5zb3J0KCk7XG5cbiAgICBpZiAocmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgZGlzYWxsb3dzIHNzckZvcndhcmRIZWFkZXJzOiAke3JlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChleHRyYVNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyKSkpLFxuICAgICkuc29ydCgpO1xuXG4gICAgaWYgKHJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzLmxlbmd0aCA+IDAgJiYgIWFsbG93Vmlld2VyVGVuYW50SGVhZGVycykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnM9dHJ1ZSBmb3IgdGVuYW50LWxpa2Ugc3NyRm9yd2FyZEhlYWRlcnM6ICR7cmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHRlbmFudFBhc3N0aHJvdWdoSGVhZGVycyA9IGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc1xuICAgICAgPyBBcnJheS5mcm9tKG5ldyBTZXQoW2RlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIsIC4uLnJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzXSkpXG4gICAgICA6IFtdO1xuICAgIGNvbnN0IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzID0gYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzXG4gICAgICA/IFtdXG4gICAgICA6IEFycmF5LmZyb20obmV3IFNldChbZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciwgLi4ucmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnNdKSkuc29ydCgpO1xuXG4gICAgY29uc3Qgc3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgWy4uLmJhc2VTc3JGb3J3YXJkSGVhZGVycywgLi4udGVuYW50UGFzc3Rocm91Z2hIZWFkZXJzLCAuLi5leHRyYVNzckZvcndhcmRIZWFkZXJzXS5maWx0ZXIoXG4gICAgICAgICAgKGhlYWRlcikgPT4gIWRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMgPSBuZXcgU2V0KFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoc3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+ICFodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMuaGFzKGhlYWRlcikpKSxcbiAgICApO1xuXG4gICAgaWYgKCFwcm9wcy5odG1sQ2FjaGVQb2xpY3kgJiYgaHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGggPiBtYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRlZmF1bHQgaHRtbENhY2hlUG9saWN5IHN1cHBvcnRzIGF0IG1vc3QgJHttYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzfSBjYWNoZS1rZXkgaGVhZGVyczsgcmVjZWl2ZWQgJHtodG1sQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aH1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIlNzck9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIkh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5zc3JGb3J3YXJkSGVhZGVycyksXG4gICAgfSk7XG4gICAgY29uc3Qgc3NyQ2FjaGVQb2xpY3kgPSBwcm9wcy5zc3JDYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQ7XG4gICAgY29uc3QgaHRtbENhY2hlUG9saWN5ID1cbiAgICAgIHByb3BzLmh0bWxDYWNoZVBvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJIdG1sQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgSFRNTCBjYWNoZSBwb2xpY3kga2V5ZWQgYnkgcXVlcnkgc3RyaW5ncyBhbmQgc3RhYmxlIHB1YmxpYyB2YXJpYW50IGhlYWRlcnNcIixcbiAgICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBtYXhUdGw6IER1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmh0bWxDYWNoZUtleUhlYWRlcnMpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nR3ppcDogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJkaXJlY3QgUzMgcGF0aHNcIiwgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSwgYmVoYXZpb3JQYXR0ZXJuT3duZXJzKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcInN0YXRpYyBIVE1MIHBhdGhzXCIsIHN0YXRpY1BhdGhQYXR0ZXJucywgYmVoYXZpb3JQYXR0ZXJuT3duZXJzKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcImRpcmVjdCBTU1IgcGF0aHNcIiwgc3NyUGF0aFBhdHRlcm5zLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMpO1xuICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mb3JFYWNoKChjb25maWcsIGluZGV4KSA9PiB7XG4gICAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgICAgICAgYGJlYXJlciBGdW5jdGlvbiBVUkwgY28tb3JpZ2luICR7aW5kZXggKyAxfWAsXG4gICAgICAgIGNvbmZpZy5wYXRoUGF0dGVybnMsXG4gICAgICAgIGJlaGF2aW9yUGF0dGVybk93bmVycyxcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXF1ZXN0RnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlcXVlc3RGdW5jdGlvblwiLCB7XG4gICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKFxuICAgICAgICBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoXG4gICAgICAgICAgc2l0ZU1vZGUsXG4gICAgICAgICAgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSxcbiAgICAgICAgICBbLi4uc3NyUGF0aFBhdHRlcm5zLCAuLi5iZWFyZXJGdW5jdGlvblVybFBhdGhQYXR0ZXJuc10sXG4gICAgICAgICAgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMsXG4gICAgICAgICksXG4gICAgICApLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDpcbiAgICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgICA/IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgYW5kIEhUTUwgcmV3cml0ZSBmb3IgU1NSIHNpdGVcIlxuICAgICAgICAgIDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXF1ZXN0IGVkZ2UgY29udGV4dCBmb3IgU1NSIHNpdGVcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShnZW5lcmF0ZVNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25Db2RlKCkpLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXNwb25zZSByZXF1ZXN0LWlkIGVjaG8gZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMgPSAoKTogY2xvdWRmcm9udC5GdW5jdGlvbkFzc29jaWF0aW9uW10gPT4gW1xuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVxdWVzdEZ1bmN0aW9uLFxuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVzcG9uc2VGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVNQT05TRSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCk7XG5cbiAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcbiAgICAgIGNvbnN0IGNlcnRBcm4gPSBTdHJpbmcocHJvcHMuY2VydGlmaWNhdGVBcm4gPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGNlcnRBcm4pIHtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwgY2VydEFybik7XG4gICAgICB9IGVsc2UgaWYgKHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBuZXcgYWNtLkRuc1ZhbGlkYXRlZENlcnRpZmljYXRlKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwge1xuICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgaG9zdGVkWm9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICByZWdpb246IFwidXMtZWFzdC0xXCIsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5jZXJ0aWZpY2F0ZUFybiBvciBwcm9wcy5ob3N0ZWRab25lIHdoZW4gcHJvcHMuZG9tYWluTmFtZSBpcyBzZXRcIik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlO1xuXG4gICAgdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICBuZXcgY2xvdWRmcm9udC5SZXNwb25zZUhlYWRlcnNQb2xpY3kodGhpcywgXCJSZXNwb25zZUhlYWRlcnNQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgYmFzZWxpbmUgc2VjdXJpdHkgaGVhZGVycyAoQ1NQIHN0YXlzIG9yaWdpbi1kZWZpbmVkKVwiLFxuICAgICAgICBzZWN1cml0eUhlYWRlcnNCZWhhdmlvcjoge1xuICAgICAgICAgIHN0cmljdFRyYW5zcG9ydFNlY3VyaXR5OiB7XG4gICAgICAgICAgICBhY2Nlc3NDb250cm9sTWF4QWdlOiBEdXJhdGlvbi5kYXlzKDM2NSAqIDIpLFxuICAgICAgICAgICAgaW5jbHVkZVN1YmRvbWFpbnM6IHRydWUsXG4gICAgICAgICAgICBwcmVsb2FkOiB0cnVlLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBjb250ZW50VHlwZU9wdGlvbnM6IHsgb3ZlcnJpZGU6IHRydWUgfSxcbiAgICAgICAgICBmcmFtZU9wdGlvbnM6IHtcbiAgICAgICAgICAgIGZyYW1lT3B0aW9uOiBjbG91ZGZyb250LkhlYWRlcnNGcmFtZU9wdGlvbi5ERU5ZLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZWZlcnJlclBvbGljeToge1xuICAgICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IGNsb3VkZnJvbnQuSGVhZGVyc1JlZmVycmVyUG9saWN5LlNUUklDVF9PUklHSU5fV0hFTl9DUk9TU19PUklHSU4sXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHhzc1Byb3RlY3Rpb246IHtcbiAgICAgICAgICAgIHByb3RlY3Rpb246IHRydWUsXG4gICAgICAgICAgICBtb2RlQmxvY2s6IHRydWUsXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBjdXN0b21IZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICBjdXN0b21IZWFkZXJzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGhlYWRlcjogXCJwZXJtaXNzaW9ucy1wb2xpY3lcIixcbiAgICAgICAgICAgICAgdmFsdWU6IFwiY2FtZXJhPSgpLCBtaWNyb3Bob25lPSgpLCBnZW9sb2NhdGlvbj0oKVwiLFxuICAgICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlU3RhdGljQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogYXNzZXRzT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuVVNFX09SSUdJTl9DQUNIRV9DT05UUk9MX0hFQURFUlMsXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogaHRtbENhY2hlUG9saWN5LFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogaHRtbE9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3NyQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICBjYWNoZVBvbGljeTogc3NyQ2FjaGVQb2xpY3ksXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuICAgIGNvbnN0IGFkZEV4cGFuZGVkQmVoYXZpb3IgPSAocGF0dGVybnM6IHN0cmluZ1tdLCBmYWN0b3J5OiAoKSA9PiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyk6IHZvaWQgPT4ge1xuICAgICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW3BhdHRlcm5dID0gZmFjdG9yeSgpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKFtgJHthc3NldHNLZXlQcmVmaXh9LypgXSwgY3JlYXRlU3RhdGljQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoZGlyZWN0UzNQYXRoUGF0dGVybnMsIGNyZWF0ZVN0YXRpY0JlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHN0YXRpY1BhdGhQYXR0ZXJucywgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHNzclBhdGhQYXR0ZXJucywgY3JlYXRlU3NyQmVoYXZpb3IpO1xuICAgIHRoaXMuYmVhcmVyRnVuY3Rpb25VcmxzID0gW107XG4gICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmZvckVhY2goKGNvbmZpZywgaW5kZXgpID0+IHtcbiAgICAgIGNvbnN0IGZ1bmN0aW9uVXJsID0gbmV3IGxhbWJkYS5GdW5jdGlvblVybCh0aGlzLCBgQmVhcmVyRnVuY3Rpb25Vcmwke2luZGV4ICsgMX1gLCB7XG4gICAgICAgIGZ1bmN0aW9uOiBjb25maWcub3JpZ2luLmZ1bmN0aW9uLFxuICAgICAgICBhdXRoVHlwZTogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuTk9ORSxcbiAgICAgICAgaW52b2tlTW9kZTogY29uZmlnLm9yaWdpbi5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLkJVRkZFUkVELFxuICAgICAgfSk7XG4gICAgICB0aGlzLmJlYXJlckZ1bmN0aW9uVXJscy5wdXNoKGZ1bmN0aW9uVXJsKTtcbiAgICAgIGNvbnN0IGZ1bmN0aW9uVXJsT3JpZ2luID0gbmV3IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4oZnVuY3Rpb25VcmwpO1xuICAgICAgY29uc3QgY3JlYXRlQmVhcmVyRnVuY3Rpb25VcmxCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgICBvcmlnaW46IGZ1bmN0aW9uVXJsT3JpZ2luLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kuQUxMX1ZJRVdFUl9FWENFUFRfSE9TVF9IRUFERVIsXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICAgIH0pO1xuICAgICAgYWRkRXhwYW5kZWRCZWhhdmlvcihjb25maWcucGF0aFBhdHRlcm5zLCBjcmVhdGVCZWFyZXJGdW5jdGlvblVybEJlaGF2aW9yKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IGRlZmF1bHRPcmlnaW4gPVxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgPyBuZXcgb3JpZ2lucy5PcmlnaW5Hcm91cCh7XG4gICAgICAgICAgICBwcmltYXJ5T3JpZ2luOiBodG1sT3JpZ2luLFxuICAgICAgICAgICAgZmFsbGJhY2tPcmlnaW46IHNzck9yaWdpbixcbiAgICAgICAgICAgIGZhbGxiYWNrU3RhdHVzQ29kZXM6IFs0MDMsIDQwNF0sXG4gICAgICAgICAgfSlcbiAgICAgICAgOiBzc3JPcmlnaW47XG4gICAgY29uc3QgZGVmYXVsdEFsbG93ZWRNZXRob2RzID1cbiAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgID8gY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TXG4gICAgICAgIDogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEw7XG5cbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICAuLi4oZW5hYmxlTG9nZ2luZyAmJiB0aGlzLmxvZ3NCdWNrZXRcbiAgICAgICAgPyB7IGVuYWJsZUxvZ2dpbmc6IHRydWUsIGxvZ0J1Y2tldDogdGhpcy5sb2dzQnVja2V0LCBsb2dGaWxlUHJlZml4OiBcImNsb3VkZnJvbnQvXCIgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICA/IHsgZG9tYWluTmFtZXM6IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIGRlZmF1bHRCZWhhdmlvcjoge1xuICAgICAgICBvcmlnaW46IGRlZmF1bHRPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogZGVmYXVsdEFsbG93ZWRNZXRob2RzLFxuICAgICAgICBjYWNoZVBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sQ2FjaGVQb2xpY3kgOiBzc3JDYWNoZVBvbGljeSxcbiAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA6IHNzck9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICAgIH0sXG4gICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICB9KTtcblxuICAgIGlmIChzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTSkge1xuICAgICAgcHJvcHMuc3NyRnVuY3Rpb24uYWRkUGVybWlzc2lvbihcIkFsbG93Q2xvdWRGcm9udEludm9rZUZ1bmN0aW9uVmlhVXJsXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLFxuICAgICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImNsb3VkZnJvbnQuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgc291cmNlQXJuOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Bcm4sXG4gICAgICAgIGludm9rZWRWaWFGdW5jdGlvblVybDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmh0bWxTdG9yZUJ1Y2tldCkge1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQuZ3JhbnRSZWFkV3JpdGUocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmlzck1ldGFkYXRhVGFibGUpIHtcbiAgICAgIHRoaXMuaXNyTWV0YWRhdGFUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh3aXJlUnVudGltZUVudikge1xuICAgICAgdGhpcy5hc3NldHNCdWNrZXQuZ3JhbnRSZWFkKHByb3BzLnNzckZ1bmN0aW9uKTtcblxuICAgICAgY29uc3Qgc3NyRnVuY3Rpb25BbnkgPSBwcm9wcy5zc3JGdW5jdGlvbiBhcyBhbnk7XG4gICAgICBpZiAodHlwZW9mIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZSB3aXJlUnVudGltZUVudiByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvbiB0byBzdXBwb3J0IGFkZEVudmlyb25tZW50OyBwYXNzIGEgbGFtYmRhLkZ1bmN0aW9uIG9yIHNldCB3aXJlUnVudGltZUVudj1mYWxzZSBhbmQgc2V0IGVudiB2YXJzIG1hbnVhbGx5XCIsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19CVUNLRVRcIiwgdGhpcy5hc3NldHNCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfUFJFRklYXCIsIGFzc2V0c0tleVByZWZpeCk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfTUFOSUZFU1RfS0VZXCIsIGFzc2V0c01hbmlmZXN0S2V5KTtcblxuICAgICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KSB7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfQlVDS0VUXCIsIHRoaXMuaHRtbFN0b3JlQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkZBQ0VUSEVPUllfSVNSX1BSRUZJWFwiLCB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCk7XG4gICAgICB9XG4gICAgICBpZiAoaXNyTWV0YWRhdGFUYWJsZU5hbWUpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQ0FDSEVfVEFCTEVfTkFNRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRvbWFpbk5hbWUgJiYgcHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogZG9tYWluTmFtZSxcbiAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gIH1cbn1cbiJdfQ==