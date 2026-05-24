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
function pathPatternWildcardPrefix(pattern) {
    const wildcardIndex = pattern.indexOf("*");
    if (wildcardIndex < 0) {
        return undefined;
    }
    return pattern.slice(0, wildcardIndex);
}
function pathPatternCoversPattern(left, right) {
    if (left === right) {
        return true;
    }
    const wildcardPrefix = pathPatternWildcardPrefix(left);
    if (wildcardPrefix === undefined) {
        return false;
    }
    if (wildcardPrefix.length === 0) {
        return true;
    }
    return right.startsWith(wildcardPrefix);
}
function pathPatternsCanOverlap(left, right) {
    return pathPatternCoversPattern(left, right) || pathPatternCoversPattern(right, left);
}
function assertNoConflictingBehaviorPatterns(label, patterns, seenOwners, seenPatterns) {
    for (const pattern of expandBehaviorPathPatterns(patterns)) {
        const owner = seenOwners.get(pattern);
        if (owner && owner !== label) {
            throw new Error(`AppTheorySsrSite received overlapping path pattern "${pattern}" for ${owner} and ${label}`);
        }
        for (const seenPattern of seenPatterns) {
            if (seenPattern.label !== label && pathPatternsCanOverlap(seenPattern.pattern, pattern)) {
                throw new Error(`AppTheorySsrSite received overlapping path patterns "${seenPattern.pattern}" and "${pattern}" for ${seenPattern.label} and ${label}`);
            }
        }
        seenOwners.set(pattern, label);
        seenPatterns.push({ pattern, label });
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
        const behaviorPatterns = [];
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
        assertNoConflictingBehaviorPatterns("direct S3 paths", [`${assetsKeyPrefix}/*`, ...directS3PathPatterns], behaviorPatternOwners, behaviorPatterns);
        assertNoConflictingBehaviorPatterns("static HTML paths", staticPathPatterns, behaviorPatternOwners, behaviorPatterns);
        assertNoConflictingBehaviorPatterns("direct SSR paths", ssrPathPatterns, behaviorPatternOwners, behaviorPatterns);
        bearerFunctionUrlOriginConfigs.forEach((config, index) => {
            assertNoConflictingBehaviorPatterns(`bearer Function URL co-origin ${index + 1}`, config.pathPatterns, behaviorPatternOwners, behaviorPatterns);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFzRDtBQUN0RCwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUU5RCwyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyREFBMkQ7QUFDM0QseUNBQXlDO0FBQ3pDLDBEQUEwRDtBQUMxRCwyQ0FBdUM7QUFFdkMseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLHlCQUF5QixDQUFDO0FBQzNELE1BQU0sNEJBQTRCLEdBQUcsS0FBSyxDQUFDO0FBQzNDLE1BQU0seUJBQXlCLEdBQUcsRUFBRSxDQUFDO0FBQ3JDLE1BQU0seUJBQXlCLEdBQUcsYUFBYSxDQUFDO0FBRWhELElBQVksb0JBWVg7QUFaRCxXQUFZLG9CQUFvQjtJQUM5Qjs7O09BR0c7SUFDSCw2Q0FBcUIsQ0FBQTtJQUVyQjs7O09BR0c7SUFDSCwyQ0FBbUIsQ0FBQTtBQUNyQixDQUFDLEVBWlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFZL0I7QUFFRCxTQUFTLHNCQUFzQixDQUFDLE9BQWU7SUFDN0MsTUFBTSxVQUFVLEdBQUcsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLENBQUMsT0FBTyxD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QUFZLENBQUMsU0FBUyxDQUFDLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQzthQUN4RixDQUFDLENBQUM7UUFDTCxDQUFDO0lBRUgsQ0FBQzs7QUF4ZkgsNENBeWZDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50XCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyLCB0cmltUmVwZWF0ZWRDaGFyU3RhcnQgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuXG5jb25zdCBhcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtdXJpXCI7XG5jb25zdCBmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIgPSBcIngtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlcIjtcbmNvbnN0IGFwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtaG9zdFwiO1xuY29uc3QgZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RcIjtcbmNvbnN0IHNzck9yaWdpbmFsVXJpSGVhZGVycyA9IFthcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciwgZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzck9yaWdpbmFsSG9zdEhlYWRlcnMgPSBbYXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyLCBmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuID0gXCIvX2ZhY2V0aGVvcnkvZGF0YS8qXCI7XG5jb25zdCBzc2dJc3JTc3JEYXRhUGF0aFBhdHRlcm4gPSBcIi9fZmFjZXRoZW9yeS9zc3ItZGF0YS8qXCI7XG5jb25zdCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4ID0gXCJpc3JcIjtcbmNvbnN0IG1heERlZmF1bHRDYWNoZUtleUhlYWRlcnMgPSAxMDtcbmNvbnN0IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgPSBcIngtdGVuYW50LWlkXCI7XG5cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeVNzclNpdGVNb2RlIHtcbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaXMgdGhlIGRlZmF1bHQgb3JpZ2luLiBEaXJlY3QgUzMgYmVoYXZpb3JzIGFyZSB1c2VkIG9ubHkgZm9yXG4gICAqIGltbXV0YWJsZSBhc3NldHMgYW5kIGFueSBleHBsaWNpdGx5IGNvbmZpZ3VyZWQgc3RhdGljIHBhdGggcGF0dGVybnMuXG4gICAqL1xuICBTU1JfT05MWSA9IFwic3NyLW9ubHlcIixcblxuICAvKipcbiAgICogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBTU1IvSVNSIGlzIHRoZSBmYWxsYmFjay4gRmFjZVRoZW9yeSBoeWRyYXRpb25cbiAgICogZGF0YSByb3V0ZXMgYXJlIGtlcHQgb24gUzMgYW5kIHRoZSBlZGdlIHJld3JpdGVzIGV4dGVuc2lvbmxlc3MgcGF0aHMgdG8gYC9pbmRleC5odG1sYC5cbiAgICovXG4gIFNTR19JU1IgPSBcInNzZy1pc3JcIixcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5Ub1VyaVByZWZpeChwYXR0ZXJuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKS5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gIHJldHVybiBub3JtYWxpemVkID8gYC8ke25vcm1hbGl6ZWR9YCA6IFwiL1wiO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoUGF0dGVybnMocGF0dGVybnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICByZXR1cm4gQXJyYXkuZnJvbShcbiAgICBuZXcgU2V0KFxuICAgICAgKEFycmF5LmlzQXJyYXkocGF0dGVybnMpID8gcGF0dGVybnMgOiBbXSlcbiAgICAgICAgLm1hcCgocGF0dGVybikgPT4gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKSlcbiAgICAgICAgLmZpbHRlcigocGF0dGVybikgPT4gcGF0dGVybi5sZW5ndGggPiAwKSxcbiAgICApLFxuICApO1xufVxuXG5mdW5jdGlvbiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4cGFuZGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIik7XG4gICAgaWYgKCFub3JtYWxpemVkKSBjb250aW51ZTtcblxuICAgIGV4cGFuZGVkLmFkZChub3JtYWxpemVkKTtcbiAgICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICBjb25zdCByb290UGF0dGVybiA9IG5vcm1hbGl6ZWQuc2xpY2UoMCwgLTIpO1xuICAgICAgaWYgKHJvb3RQYXR0ZXJuKSB7XG4gICAgICAgIGV4cGFuZGVkLmFkZChyb290UGF0dGVybik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIEFycmF5LmZyb20oZXhwYW5kZWQpO1xufVxuXG5pbnRlcmZhY2UgU2VlbkJlaGF2aW9yUGF0dGVybiB7XG4gIHJlYWRvbmx5IHBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbGFiZWw6IHN0cmluZztcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5XaWxkY2FyZFByZWZpeChwYXR0ZXJuOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCB3aWxkY2FyZEluZGV4ID0gcGF0dGVybi5pbmRleE9mKFwiKlwiKTtcbiAgaWYgKHdpbGRjYXJkSW5kZXggPCAwKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICByZXR1cm4gcGF0dGVybi5zbGljZSgwLCB3aWxkY2FyZEluZGV4KTtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5Db3ZlcnNQYXR0ZXJuKGxlZnQ6IHN0cmluZywgcmlnaHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAobGVmdCA9PT0gcmlnaHQpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGNvbnN0IHdpbGRjYXJkUHJlZml4ID0gcGF0aFBhdHRlcm5XaWxkY2FyZFByZWZpeChsZWZ0KTtcbiAgaWYgKHdpbGRjYXJkUHJlZml4ID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKHdpbGRjYXJkUHJlZml4Lmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIHJpZ2h0LnN0YXJ0c1dpdGgod2lsZGNhcmRQcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBwYXRoUGF0dGVybnNDYW5PdmVybGFwKGxlZnQ6IHN0cmluZywgcmlnaHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gcGF0aFBhdHRlcm5Db3ZlcnNQYXR0ZXJuKGxlZnQsIHJpZ2h0KSB8fCBwYXRoUGF0dGVybkNvdmVyc1BhdHRlcm4ocmlnaHQsIGxlZnQpO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgbGFiZWw6IHN0cmluZyxcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBzZWVuT3duZXJzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxuICBzZWVuUGF0dGVybnM6IFNlZW5CZWhhdmlvclBhdHRlcm5bXSxcbik6IHZvaWQge1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnMpKSB7XG4gICAgY29uc3Qgb3duZXIgPSBzZWVuT3duZXJzLmdldChwYXR0ZXJuKTtcbiAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IGxhYmVsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJuIFwiJHtwYXR0ZXJufVwiIGZvciAke293bmVyfSBhbmQgJHtsYWJlbH1gKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHNlZW5QYXR0ZXJuIG9mIHNlZW5QYXR0ZXJucykge1xuICAgICAgaWYgKHNlZW5QYXR0ZXJuLmxhYmVsICE9PSBsYWJlbCAmJiBwYXRoUGF0dGVybnNDYW5PdmVybGFwKHNlZW5QYXR0ZXJuLnBhdHRlcm4sIHBhdHRlcm4pKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBvdmVybGFwcGluZyBwYXRoIHBhdHRlcm5zIFwiJHtzZWVuUGF0dGVybi5wYXR0ZXJufVwiIGFuZCBcIiR7cGF0dGVybn1cIiBmb3IgJHtzZWVuUGF0dGVybi5sYWJlbH0gYW5kICR7bGFiZWx9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzZWVuT3duZXJzLnNldChwYXR0ZXJuLCBsYWJlbCk7XG4gICAgc2VlblBhdHRlcm5zLnB1c2goeyBwYXR0ZXJuLCBsYWJlbCB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5vbmljYWxpemVIZWFkZXJOYW1lKGhlYWRlcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyhoZWFkZXIpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5mdW5jdGlvbiBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IGNhbm9uaWNhbGl6ZUhlYWRlck5hbWUoaGVhZGVyKS5yZXBsYWNlKC9bXmEtejAtOV0rL2csIFwiLVwiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQgPT09IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgfHwgLyhefC0pdGVuYW50KC18JCkvLnRlc3Qobm9ybWFsaXplZCk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVxdWVzdEZ1bmN0aW9uQ29kZShcbiAgbW9kZTogQXBwVGhlb3J5U3NyU2l0ZU1vZGUsXG4gIHJhd1MzUGF0aFBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgbGFtYmRhUGFzc3Rocm91Z2hQYXRoUGF0dGVybnM6IHN0cmluZ1tdLFxuICBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyczogc3RyaW5nW10sXG4pOiBzdHJpbmcge1xuICBjb25zdCByYXdTM1ByZWZpeGVzID0gcmF3UzNQYXRoUGF0dGVybnMubWFwKHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgpLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpO1xuICBjb25zdCByYXdTM1ByZWZpeExpc3QgPSByYXdTM1ByZWZpeGVzLm1hcCgocHJlZml4KSA9PiBgJyR7cHJlZml4fSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zXG4gICAgLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG4gIGNvbnN0IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJMaXN0ID0gYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMubWFwKChoZWFkZXIpID0+IGAnJHtoZWFkZXJ9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuXG4gIHJldHVybiBgXG5cdGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcblx0ICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG5cdCAgcmVxdWVzdC5oZWFkZXJzID0gcmVxdWVzdC5oZWFkZXJzIHx8IHt9O1xuXHQgIHZhciBoZWFkZXJzID0gcmVxdWVzdC5oZWFkZXJzO1xuXHQgIHZhciB1cmkgPSByZXF1ZXN0LnVyaSB8fCAnLyc7XG5cdCAgdmFyIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzID0gW1xuXHQgICAgJHtibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyTGlzdH1cblx0ICBdO1xuXG5cdCAgZm9yICh2YXIgYmxvY2tlZEluZGV4ID0gMDsgYmxvY2tlZEluZGV4IDwgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMubGVuZ3RoOyBibG9ja2VkSW5kZXgrKykge1xuXHQgICAgZGVsZXRlIGhlYWRlcnNbYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnNbYmxvY2tlZEluZGV4XV07XG5cdCAgfVxuXG5cdCAgdmFyIHJlcXVlc3RJZEhlYWRlciA9IGhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddO1xuXHQgIHZhciByZXF1ZXN0SWQgPSByZXF1ZXN0SWRIZWFkZXIgJiYgcmVxdWVzdElkSGVhZGVyLnZhbHVlID8gcmVxdWVzdElkSGVhZGVyLnZhbHVlLnRyaW0oKSA6ICcnO1xuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9IGV2ZW50LmNvbnRleHQgJiYgZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQgPyBTdHJpbmcoZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQpLnRyaW0oKSA6ICcnO1xuXHQgIH1cblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSAncmVxXycgKyBEYXRlLm5vdygpLnRvU3RyaW5nKDM2KSArICdfJyArIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDEwKTtcblx0ICB9XG5cblx0ICBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSA9IHsgdmFsdWU6IHJlcXVlc3RJZCB9O1xuXHQgIGhlYWRlcnNbJyR7YXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblx0ICBoZWFkZXJzWycke2ZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcn0nXSA9IHsgdmFsdWU6IHVyaSB9O1xuXG5cdCAgaWYgKGhlYWRlcnMuaG9zdCAmJiBoZWFkZXJzLmhvc3QudmFsdWUpIHtcblx0ICAgIGhlYWRlcnNbJyR7YXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgICBoZWFkZXJzWycke2ZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJ9J10gPSB7IHZhbHVlOiBoZWFkZXJzLmhvc3QudmFsdWUgfTtcblx0ICB9XG5cblx0ICBpZiAoJyR7bW9kZX0nID09PSAnJHtBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSfScpIHtcblx0ICAgIHZhciByYXdTM1ByZWZpeGVzID0gW1xuXHQgICAgICAke3Jhd1MzUHJlZml4TGlzdH1cblx0ICAgIF07XG5cdCAgICB2YXIgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtsYW1iZGFQYXNzdGhyb3VnaFByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGlzTGFtYmRhUGFzc3Rocm91Z2hQYXRoID0gZmFsc2U7XG5cblx0ICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5sZW5ndGg7IGkrKykge1xuXHQgICAgICB2YXIgcHJlZml4ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlc1tpXTtcblx0ICAgICAgaWYgKHVyaSA9PT0gcHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHByZWZpeCArICcvJykpIHtcblx0ICAgICAgICBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IHRydWU7XG5cdCAgICAgICAgYnJlYWs7XG5cdCAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgaWYgKCFpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCkge1xuXHQgICAgICB2YXIgaXNSYXdTM1BhdGggPSBmYWxzZTtcblxuXHQgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IHJhd1MzUHJlZml4ZXMubGVuZ3RoOyBqKyspIHtcblx0ICAgICAgICB2YXIgcmF3UHJlZml4ID0gcmF3UzNQcmVmaXhlc1tqXTtcblx0ICAgICAgICBpZiAodXJpID09PSByYXdQcmVmaXggfHwgdXJpLnN0YXJ0c1dpdGgocmF3UHJlZml4ICsgJy8nKSkge1xuXHQgICAgICAgICAgaXNSYXdTM1BhdGggPSB0cnVlO1xuXHQgICAgICAgICAgYnJlYWs7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cblx0ICAgICAgdmFyIGxhc3RTbGFzaCA9IHVyaS5sYXN0SW5kZXhPZignLycpO1xuXHQgICAgICB2YXIgbGFzdFNlZ21lbnQgPSBsYXN0U2xhc2ggPj0gMCA/IHVyaS5zdWJzdHJpbmcobGFzdFNsYXNoICsgMSkgOiB1cmk7XG5cblx0ICAgICAgaWYgKCFpc1Jhd1MzUGF0aCAmJiBsYXN0U2VnbWVudC5pbmRleE9mKCcuJykgPT09IC0xKSB7XG5cdCAgICAgICAgcmVxdWVzdC51cmkgPSB1cmkuZW5kc1dpdGgoJy8nKSA/IHVyaSArICdpbmRleC5odG1sJyA6IHVyaSArICcvaW5kZXguaHRtbCc7XG5cdCAgICAgIH1cblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVxdWVzdDtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uQ29kZSgpOiBzdHJpbmcge1xuICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHZhciByZXNwb25zZSA9IGV2ZW50LnJlc3BvbnNlO1xuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSByZXF1ZXN0LmhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddO1xuXHQgIHZhciByZXF1ZXN0SWQgPSByZXF1ZXN0SWRIZWFkZXIgJiYgcmVxdWVzdElkSGVhZGVyLnZhbHVlID8gcmVxdWVzdElkSGVhZGVyLnZhbHVlLnRyaW0oKSA6ICcnO1xuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9IGV2ZW50LmNvbnRleHQgJiYgZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQgPyBTdHJpbmcoZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQpLnRyaW0oKSA6ICcnO1xuXHQgIH1cblxuXHQgIGlmIChyZXF1ZXN0SWQpIHtcblx0ICAgIHJlc3BvbnNlLmhlYWRlcnMgPSByZXNwb25zZS5oZWFkZXJzIHx8IHt9O1xuXHQgICAgaWYgKCFyZXNwb25zZS5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSkge1xuXHQgICAgICByZXNwb25zZS5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSA9IHsgdmFsdWU6IHJlcXVlc3RJZCB9O1xuXHQgICAgfVxuXHQgIH1cblxuXHQgIHJldHVybiByZXNwb25zZTtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTc3JTaXRlUHJvcHMge1xuICByZWFkb25seSBzc3JGdW5jdGlvbjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogRXhwbGljaXQgZGVwbG95bWVudCBtb2RlIGZvciB0aGUgc2l0ZSB0b3BvbG9neS5cbiAgICpcbiAgICogLSBgc3NyLW9ubHlgOiBMYW1iZGEgRnVuY3Rpb24gVVJMIGlzIHRoZSBkZWZhdWx0IG9yaWdpblxuICAgKiAtIGBzc2ctaXNyYDogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBpcyB0aGUgZmFsbGJhY2tcbiAgICpcbiAgICogRXhpc3RpbmcgaW1wbGljaXQgYmVoYXZpb3IgbWFwcyB0byBgc3NyLW9ubHlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU1JfT05MWVxuICAgKi9cbiAgcmVhZG9ubHkgbW9kZT86IEFwcFRoZW9yeVNzclNpdGVNb2RlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGludm9rZSBtb2RlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkludm9rZU1vZGUuUkVTUE9OU0VfU1RSRUFNXG4gICAqL1xuICByZWFkb25seSBpbnZva2VNb2RlPzogbGFtYmRhLkludm9rZU1vZGU7XG5cbiAgLyoqXG4gICAqIEZ1bmN0aW9uIFVSTCBhdXRoIHR5cGUgZm9yIHRoZSBTU1Igb3JpZ2luLlxuICAgKlxuICAgKiBJZiBvbWl0dGVkLCBBcHBUaGVvcnkgZmFpbHMgY2xvc2VkIHRvIGBBV1NfSUFNYCBhbmQgc2lnbnMgQ2xvdWRGcm9udC10by1MYW1iZGFcbiAgICogdHJhZmZpYyB3aXRoIGxhbWJkYSBPcmlnaW4gQWNjZXNzIENvbnRyb2wuXG4gICAqXG4gICAqIFNldCB0aGlzIGV4cGxpY2l0bHkgdG8gYE5PTkVgIG9ubHkgd2hlbiB5b3UgaW50ZW50aW9uYWxseSByZXF1aXJlIHB1YmxpY1xuICAgKiBkaXJlY3QgRnVuY3Rpb24gVVJMIGFjY2VzcyBhcyBhIGRlbGliZXJhdGUgY29tcGF0aWJpbGl0eSBjaG9pY2UuXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICovXG4gIHJlYWRvbmx5IHNzclVybEF1dGhUeXBlPzogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGU7XG5cbiAgcmVhZG9ubHkgYXNzZXRzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcmVhZG9ubHkgYXNzZXRzUGF0aD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4Pzogc3RyaW5nO1xuICByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgUzMgYnVja2V0IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlIChgUzNIdG1sU3RvcmVgKS5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlczpcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfQlVDS0VUYFxuICAgKiAtIGBGQUNFVEhFT1JZX0lTUl9QUkVGSVhgXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBTMyBrZXkgcHJlZml4IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlLlxuICAgKiBAZGVmYXVsdCBpc3JcbiAgICovXG4gIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBleHRlbnNpb25sZXNzIEhUTUwgc2VjdGlvbiBwYXRoIHBhdHRlcm5zIHRvIHJvdXRlIGRpcmVjdGx5IHRvIHRoZSBwcmltYXJ5IEhUTUwgUzMgb3JpZ2luLlxuICAgKlxuICAgKiBSZXF1ZXN0cyBsaWtlIGAvbWFya2V0aW5nYCBhbmQgYC9tYXJrZXRpbmcvLi4uYCBhcmUgcmV3cml0dGVuIHRvIGAvaW5kZXguaHRtbGBcbiAgICogd2l0aGluIHRoZSBzZWN0aW9uIGFuZCBzdGF5IG9uIFMzIGluc3RlYWQgb2YgZmFsbGluZyBiYWNrIHRvIExhbWJkYS5cbiAgICpcbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgSFRNTCBzZWN0aW9uIHBhdGg6IFwiL21hcmtldGluZy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YXRpY1BhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIHJhdyBTMyBvYmplY3QvZGF0YSBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBleHRlbnNpb25sZXNzIEhUTUwgcmV3cml0ZXMuXG4gICAqXG4gICAqIEluIGBzc2ctaXNyYCBtb2RlLCBgL19mYWNldGhlb3J5L2RhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseS5cbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgb2JqZWN0IHBhdGg6IFwiL2ZlZWRzLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgZGlyZWN0UzNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyB0aGUgYHNzZy1pc3JgIG9yaWdpbiBncm91cCBhbmQgcm91dGUgZGlyZWN0bHlcbiAgICogdG8gdGhlIExhbWJkYSBGdW5jdGlvbiBVUkwgd2l0aCBmdWxsIG1ldGhvZCBzdXBwb3J0LlxuICAgKlxuICAgKiBJbiBgc3NnLWlzcmAgbW9kZSwgYC9fZmFjZXRoZW9yeS9zc3ItZGF0YS8qYCBpcyBhZGRlZCBhdXRvbWF0aWNhbGx5IGZvciBGYWNlVGhlb3J5XG4gICAqIHN0cmljdCBuby1pbmxpbmUtQ1NQIFNTUiBoeWRyYXRpb24gc2lkZWNhcnMuXG4gICAqXG4gICAqIFVzZSB0aGlzIGZvciBzYW1lLW9yaWdpbiBkeW5hbWljIHBhdGhzIHN1Y2ggYXMgYXV0aCBjYWxsYmFja3MsIGFjdGlvbnMsIG9yIGZvcm0gcG9zdHMuXG4gICAqIEV4YW1wbGUgZGlyZWN0LVNTUiBwYXRoOiBcIi9hY3Rpb25zLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3NyUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgYmVhcmVyLWF1dGggTGFtYmRhIEZ1bmN0aW9uIFVSTCBjby1vcmlnaW5zIHRvIGF0dGFjaCB0byB0aGUgc2FtZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgZWFjaCBjby1vcmlnaW4gRnVuY3Rpb24gVVJMIHdpdGggYEF1dGhUeXBlLk5PTkVgIGFuZCByb3V0ZXMgdGhlIHN1cHBsaWVkXG4gICAqIHBhdGggcGF0dGVybnMgdG8gaXQgd2l0aG91dCBMYW1iZGEgT3JpZ2luIEFjY2VzcyBDb250cm9sLiBUaGUgU1NSIG9yaWdpbiByZW1haW5zIGdvdmVybmVkIGJ5XG4gICAqIGBzc3JVcmxBdXRoVHlwZWAgYW5kIHN0aWxsIGRlZmF1bHRzIHRvIGBBV1NfSUFNYCBwbHVzIExhbWJkYSBPQUMuXG4gICAqXG4gICAqIENvLW9yaWdpbiBwYXRocyBwYXJ0aWNpcGF0ZSBpbiBBcHBUaGVvcnkncyBiZWhhdmlvciBwYXRoIGNvbGxpc2lvbiBjaGVja3MgYW5kIGJ5cGFzcyBgc3NnLWlzcmBcbiAgICogSFRNTCByZXdyaXRlcy4gVGhpcyBpcyB0aGUgc3VwcG9ydGVkIEFwcFRoZW9yeSBwYXRoIGZvciBtaXhlZC1hdXRoIGRpc3RyaWJ1dGlvbnM7IGRvIG5vdCBoYW5kLXdpcmVcbiAgICogcmF3IGBkaXN0cmlidXRpb24uYWRkQmVoYXZpb3IoLi4uKWAgY2FsbHMgd2hlbiBBcHBUaGVvcnkgc2hvdWxkIG93biBwYXRoIGFuZCBlZGdlLWNvbnRleHQgcG9saWN5LlxuICAgKlxuICAgKiBFeGFtcGxlIGJlYXJlciBBUEkgcGF0aHM6IGBbXCIvYXBpLypcIiwgXCIvYXV0aC8qXCJdYC5cbiAgICovXG4gIHJlYWRvbmx5IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucz86IEFwcFRoZW9yeVNzclNpdGVCZWFyZXJGdW5jdGlvblVybE9yaWdpbltdO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBUYWJsZVRoZW9yeS9EeW5hbW9EQiB0YWJsZSB1c2VkIGZvciBGYWNlVGhlb3J5IElTUiBtZXRhZGF0YSBhbmQgbGVhc2UgY29vcmRpbmF0aW9uLlxuICAgKlxuICAgKiBXaGVuIHByb3ZpZGVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBTU1IgZnVuY3Rpb24gcmVhZC93cml0ZSBhY2Nlc3MgYW5kIHdpcmVzIHRoZVxuICAgKiBtZXRhZGF0YSB0YWJsZSBhbGlhc2VzIGV4cGVjdGVkIGJ5IHRoZSBkb2N1bWVudGVkIEZhY2VUaGVvcnkgZGVwbG95bWVudCBzaGFwZS5cbiAgICovXG4gIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIElTUi9jYWNoZSBtZXRhZGF0YSB0YWJsZSBuYW1lIHRvIHdpcmUgd2hlbiB5b3UgYXJlIG5vdCBwYXNzaW5nIGBpc3JNZXRhZGF0YVRhYmxlYC5cbiAgICpcbiAgICogUHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCB3aGVuIEFwcFRoZW9yeSBzaG91bGQgYWxzbyBncmFudCBhY2Nlc3MgdG8gdGhlIFNTUiBMYW1iZGEuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGVnYWN5IGFsaWFzIGZvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgLlxuICAgKiBAZGVwcmVjYXRlZCBwcmVmZXIgYGlzck1ldGFkYXRhVGFibGVgIG9yIGBpc3JNZXRhZGF0YVRhYmxlTmFtZWBcbiAgICovXG4gIHJlYWRvbmx5IGNhY2hlVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8vIFdoZW4gdHJ1ZSAoZGVmYXVsdCksIEFwcFRoZW9yeSB3aXJlcyByZWNvbW1lbmRlZCBydW50aW1lIGVudmlyb25tZW50IHZhcmlhYmxlcyBvbnRvIHRoZSBTU1IgZnVuY3Rpb24uXG4gIHJlYWRvbmx5IHdpcmVSdW50aW1lRW52PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBoZWFkZXJzIHRvIGZvcndhcmQgdG8gdGhlIFNTUiBvcmlnaW4gKExhbWJkYSBGdW5jdGlvbiBVUkwpIHZpYSB0aGUgb3JpZ2luIHJlcXVlc3QgcG9saWN5LlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBBcHBUaGVvcnkvRmFjZVRoZW9yeS1zYWZlIGVkZ2UgY29udHJhY3QgZm9yd2FyZHMgb25seTpcbiAgICogLSBgY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9gXG4gICAqIC0gYGNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NgXG4gICAqIC0gYHgtYXBwdGhlb3J5LW9yaWdpbmFsLWhvc3RgXG4gICAqIC0gYHgtYXBwdGhlb3J5LW9yaWdpbmFsLXVyaWBcbiAgICogLSBgeC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtcmVxdWVzdC1pZGBcbiAgICpcbiAgICogVXNlIHRoaXMgdG8gb3B0IGluIHRvIGFkZGl0aW9uYWwgYXBwLXNwZWNpZmljIGhlYWRlcnMgc3VjaCBhc1xuICAgKiBgeC1mYWNldGhlb3J5LXNlZ21lbnRgLiBUZW5hbnQtbGlrZSB2aWV3ZXIgaGVhZGVycyBhcmUgcmVqZWN0ZWQgdW5sZXNzXG4gICAqIGBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNgIGlzIGV4cGxpY2l0bHkgZW5hYmxlZCBhcyBhIGNvbXBhdGliaWxpdHkgbW9kZS5cbiAgICogYGhvc3RgIGFuZCBgeC1mb3J3YXJkZWQtcHJvdG9gIGFyZSByZWplY3RlZCBiZWNhdXNlIHRoZXkgYnJlYWsgb3IgYnlwYXNzIHRoZVxuICAgKiBzdXBwb3J0ZWQgb3JpZ2luIG1vZGVsLlxuICAgKi9cbiAgcmVhZG9ubHkgc3NyRm9yd2FyZEhlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQ29tcGF0aWJpbGl0eSBlc2NhcGUgaGF0Y2ggZm9yIGxlZ2FjeSB2aWV3ZXItc3VwcGxpZWQgdGVuYW50IGhlYWRlcnMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UgKGRlZmF1bHQpLCBBcHBUaGVvcnkgc3RyaXBzIGB4LXRlbmFudC1pZGAgYXQgdGhlIGVkZ2UgYW5kIHJlamVjdHNcbiAgICogdGVuYW50LWxpa2UgZW50cmllcyBpbiBgc3NyRm9yd2FyZEhlYWRlcnNgIHNvIHZpZXdlci1zdXBwbGllZCB0ZW5hbnQgaGVhZGVyc1xuICAgKiBjYW5ub3QgaW5mbHVlbmNlIG9yaWdpbiByb3V0aW5nIG9yIEhUTUwgY2FjaGUgcGFydGl0aW9uaW5nLiBXaGVuIHRydWUsXG4gICAqIEFwcFRoZW9yeSByZXN0b3JlcyBsZWdhY3kgcGFzc3Rocm91Z2ggYmVoYXZpb3IgZm9yIGB4LXRlbmFudC1pZGAgYW5kIGFueVxuICAgKiB0ZW5hbnQtbGlrZSBgc3NyRm9yd2FyZEhlYWRlcnNgLlxuICAgKlxuICAgKiBQcmVmZXIgZGVyaXZpbmcgdGVuYW50IGZyb20gdHJ1c3RlZCBob3N0IG1hcHBpbmcgdXNpbmcgdGhlIG9yaWdpbmFsLWhvc3RcbiAgICogZWRnZSBoZWFkZXJzIGluc3RlYWQgb2YgZW5hYmxpbmcgcGFzc3Rocm91Z2guXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnM/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogQ2xvdWRGcm9udCByZXNwb25zZSBoZWFkZXJzIHBvbGljeSBhcHBsaWVkIHRvIFNTUiBhbmQgZGlyZWN0LVMzIGJlaGF2aW9ycy5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IHByb3Zpc2lvbnMgYSBGYWNlVGhlb3J5LWFsaWduZWQgYmFzZWxpbmUgcG9saWN5IGF0IHRoZSBDRE5cbiAgICogbGF5ZXI6IEhTVFMsIG5vc25pZmYsIGZyYW1lLW9wdGlvbnMsIHJlZmVycmVyLXBvbGljeSwgWFNTIHByb3RlY3Rpb24sIGFuZCBhXG4gICAqIHJlc3RyaWN0aXZlIHBlcm1pc3Npb25zLXBvbGljeS4gQ29udGVudC1TZWN1cml0eS1Qb2xpY3kgcmVtYWlucyBvcmlnaW4tZGVmaW5lZC5cbiAgICovXG4gIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAvKipcbiAgICogQ2FjaGUgcG9saWN5IGFwcGxpZWQgdG8gZGlyZWN0IExhbWJkYS1iYWNrZWQgU1NSIGJlaGF2aW9ycy5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgaXMgYENBQ0hJTkdfRElTQUJMRURgIHNvIGR5bmFtaWMgTGFtYmRhIHJvdXRlcyBzdGF5IHNhZmUgdW5sZXNzIHlvdVxuICAgKiBpbnRlbnRpb25hbGx5IG9wdCBpbnRvIGEgY2FjaGUgcG9saWN5IHRoYXQgbWF0Y2hlcyB5b3VyIGFwcCdzIHZhcmlhbmNlIG1vZGVsLlxuICAgKiBAZGVmYXVsdCBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRURcbiAgICovXG4gIHJlYWRvbmx5IHNzckNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgLyoqXG4gICAqIENhY2hlIHBvbGljeSBhcHBsaWVkIHRvIHRoZSBjYWNoZWFibGUgSFRNTCBiZWhhdmlvciBpbiBgc3NnLWlzcmAgbW9kZS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5IHBvbGljeSBrZXlzIG9uIHF1ZXJ5IHN0cmluZ3MgcGx1cyB0aGUgc3RhYmxlIHB1YmxpYyBIVE1MXG4gICAqIHZhcmlhbnQgaGVhZGVycyAoYHgtKi1vcmlnaW5hbC1ob3N0YCBhbmQgYW55IG5vbi10ZW5hbnQgZXh0cmEgZm9yd2FyZGVkXG4gICAqIGhlYWRlcnMgeW91IG9wdCBpbnRvKSB3aGlsZSBsZWF2aW5nIGNvb2tpZXMgb3V0IG9mIHRoZSBjYWNoZSBrZXkuIFRlbmFudC1saWtlXG4gICAqIHZpZXdlciBoZWFkZXJzIGpvaW4gdGhlIGNhY2hlIGtleSBvbmx5IHdoZW4gYGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc2AgaXNcbiAgICogZXhwbGljaXRseSBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbENhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICByZWFkb25seSBkb21haW5OYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgcmVhZG9ubHkgd2ViQWNsSWQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZUJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luIHtcbiAgLyoqXG4gICAqIExhbWJkYSBmdW5jdGlvbiB0aGF0IEFwcFRoZW9yeSBleHBvc2VzIGFzIGEgYmVhcmVyLWF1dGggRnVuY3Rpb24gVVJMIGNvLW9yaWdpbi5cbiAgICpcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgdGhlIEZ1bmN0aW9uIFVSTCB3aXRoIGBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5OT05FYDsgYXV0aGVudGljYXRpb24gcmVtYWluc1xuICAgKiB0aGUgcmVzcG9uc2liaWxpdHkgb2YgdGhlIExhbWJkYSBoYW5kbGVyLlxuICAgKi9cbiAgcmVhZG9ubHkgZnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIENsb3VkRnJvbnQgcGF0aCBwYXR0ZXJucyB0aGF0IHJvdXRlIHRvIHRoaXMgY28tb3JpZ2luLlxuICAgKlxuICAgKiBQYXR0ZXJucyBhcmUgbm9ybWFsaXplZCB0aGUgc2FtZSB3YXkgYXMgYHNzclBhdGhQYXR0ZXJuc2AuIEEgcGF0dGVybiBlbmRpbmcgaW4gYC8qYCBhbHNvIGNyZWF0ZXNcbiAgICogYSByb290IGJlaGF2aW9yIHdpdGhvdXQgdGhlIHdpbGRjYXJkIHNvIGAvYXBpLypgIGNvdmVycyBib3RoIGAvYXBpYCBhbmQgYC9hcGkvLi4uYC5cbiAgICovXG4gIHJlYWRvbmx5IHBhdGhQYXR0ZXJuczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaW52b2tlIG1vZGUgZm9yIHRoaXMgY28tb3JpZ2luLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuSW52b2tlTW9kZS5CVUZGRVJFRFxuICAgKi9cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5U3NyU2l0ZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNCdWNrZXQ6IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNLZXlQcmVmaXg6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c01hbmlmZXN0S2V5OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgaHRtbFN0b3JlS2V5UHJlZml4Pzogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgc3NyVXJsOiBsYW1iZGEuRnVuY3Rpb25Vcmw7XG4gIHB1YmxpYyByZWFkb25seSBiZWFyZXJGdW5jdGlvblVybHM6IGxhbWJkYS5GdW5jdGlvblVybFtdO1xuICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcbiAgcHVibGljIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlTc3JTaXRlUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKCFwcm9wcz8uc3NyRnVuY3Rpb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgcHJvcHMuc3NyRnVuY3Rpb25cIik7XG4gICAgfVxuXG4gICAgY29uc3Qgc2l0ZU1vZGUgPSBwcm9wcy5tb2RlID8/IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTUl9PTkxZO1xuICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgY29uc3Qgd2lyZVJ1bnRpbWVFbnYgPSBwcm9wcy53aXJlUnVudGltZUVudiA/PyB0cnVlO1xuXG4gICAgdGhpcy5hc3NldHNCdWNrZXQgPVxuICAgICAgcHJvcHMuYXNzZXRzQnVja2V0ID8/XG4gICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQXNzZXRzQnVja2V0XCIsIHtcbiAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcbiAgICBpZiAoZW5hYmxlTG9nZ2luZykge1xuICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBhc3NldHNQcmVmaXhSYXcgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhwcm9wcy5hc3NldHNLZXlQcmVmaXggPz8gXCJhc3NldHNcIikudHJpbSgpLCBcIi9cIik7XG4gICAgY29uc3QgYXNzZXRzS2V5UHJlZml4ID0gYXNzZXRzUHJlZml4UmF3IHx8IFwiYXNzZXRzXCI7XG5cbiAgICBjb25zdCBtYW5pZmVzdFJhdyA9IFN0cmluZyhwcm9wcy5hc3NldHNNYW5pZmVzdEtleSA/PyBgJHthc3NldHNLZXlQcmVmaXh9L21hbmlmZXN0Lmpzb25gKS50cmltKCk7XG4gICAgY29uc3QgbWFuaWZlc3RLZXkgPSB0cmltUmVwZWF0ZWRDaGFyKG1hbmlmZXN0UmF3LCBcIi9cIik7XG4gICAgY29uc3QgYXNzZXRzTWFuaWZlc3RLZXkgPSBtYW5pZmVzdEtleSB8fCBgJHthc3NldHNLZXlQcmVmaXh9L21hbmlmZXN0Lmpzb25gO1xuXG4gICAgdGhpcy5hc3NldHNLZXlQcmVmaXggPSBhc3NldHNLZXlQcmVmaXg7XG4gICAgdGhpcy5hc3NldHNNYW5pZmVzdEtleSA9IGFzc2V0c01hbmlmZXN0S2V5O1xuXG4gICAgY29uc3QgaHRtbFN0b3JlS2V5UHJlZml4SW5wdXQgPSBTdHJpbmcocHJvcHMuaHRtbFN0b3JlS2V5UHJlZml4ID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBzaG91bGRDb25maWd1cmVIdG1sU3RvcmUgPSBCb29sZWFuKHByb3BzLmh0bWxTdG9yZUJ1Y2tldCkgfHwgaHRtbFN0b3JlS2V5UHJlZml4SW5wdXQubGVuZ3RoID4gMDtcbiAgICBpZiAoc2hvdWxkQ29uZmlndXJlSHRtbFN0b3JlKSB7XG4gICAgICBjb25zdCBodG1sU3RvcmVQcmVmaXhSYXcgPSB0cmltUmVwZWF0ZWRDaGFyKFxuICAgICAgICBTdHJpbmcocHJvcHMuaHRtbFN0b3JlS2V5UHJlZml4ID8/IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXgpLnRyaW0oKSxcbiAgICAgICAgXCIvXCIsXG4gICAgICApO1xuICAgICAgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXggPSBodG1sU3RvcmVQcmVmaXhSYXcgfHwgZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeDtcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0ID1cbiAgICAgICAgcHJvcHMuaHRtbFN0b3JlQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJIdG1sU3RvcmVCdWNrZXRcIiwge1xuICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5pc3JNZXRhZGF0YVRhYmxlID0gcHJvcHMuaXNyTWV0YWRhdGFUYWJsZTtcblxuICAgIGNvbnN0IGV4cGxpY2l0SXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuaXNyTWV0YWRhdGFUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IGxlZ2FjeUNhY2hlVGFibGVOYW1lID0gU3RyaW5nKHByb3BzLmNhY2hlVGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCByZXNvdXJjZUlzck1ldGFkYXRhVGFibGVOYW1lID0gU3RyaW5nKHRoaXMuaXNyTWV0YWRhdGFUYWJsZT8udGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcblxuICAgIGNvbnN0IGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgW3Jlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUsIGV4cGxpY2l0SXNyTWV0YWRhdGFUYWJsZU5hbWUsIGxlZ2FjeUNhY2hlVGFibGVOYW1lXS5maWx0ZXIoXG4gICAgICAgICAgKG5hbWUpID0+IFN0cmluZyhuYW1lKS50cmltKCkubGVuZ3RoID4gMCxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIGlmIChjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzLmxlbmd0aCA+IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgY29uZmxpY3RpbmcgSVNSIG1ldGFkYXRhIHRhYmxlIG5hbWVzOiAke2NvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGlzck1ldGFkYXRhVGFibGVOYW1lID0gY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lc1swXSA/PyBcIlwiO1xuXG4gICAgaWYgKHByb3BzLmFzc2V0c1BhdGgpIHtcbiAgICAgIG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsIFwiQXNzZXRzRGVwbG95bWVudFwiLCB7XG4gICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQocHJvcHMuYXNzZXRzUGF0aCldLFxuICAgICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5hc3NldHNCdWNrZXQsXG4gICAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiBhc3NldHNLZXlQcmVmaXgsXG4gICAgICAgIHBydW5lOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhdGljUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKHByb3BzLnN0YXRpY1BhdGhQYXR0ZXJucyk7XG4gICAgY29uc3QgZGlyZWN0UzNQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMoW1xuICAgICAgLi4uKHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gW3NzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zKSA/IHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IHNzclBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhbXG4gICAgICAuLi4oc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBbc3NnSXNyU3NyRGF0YVBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLnNzclBhdGhQYXR0ZXJucykgPyBwcm9wcy5zc3JQYXRoUGF0dGVybnMgOiBbXSksXG4gICAgXSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zID0gQXJyYXkuaXNBcnJheShwcm9wcy5iZWFyZXJGdW5jdGlvblVybE9yaWdpbnMpXG4gICAgICA/IHByb3BzLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1xuICAgICAgOiBbXTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MgPSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMubWFwKChvcmlnaW4sIGluZGV4KSA9PiB7XG4gICAgICBpZiAoIW9yaWdpbj8uZnVuY3Rpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1ske2luZGV4fV0gcmVxdWlyZXMgZnVuY3Rpb25gKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhvcmlnaW4ucGF0aFBhdHRlcm5zKTtcbiAgICAgIGlmIChwYXRoUGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5U3NyU2l0ZSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnNbJHtpbmRleH1dIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBwYXRoIHBhdHRlcm5gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IG9yaWdpbiwgcGF0aFBhdHRlcm5zIH07XG4gICAgfSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxQYXRoUGF0dGVybnMgPSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZmxhdE1hcCgoY29uZmlnKSA9PiBjb25maWcucGF0aFBhdHRlcm5zKTtcbiAgICBjb25zdCBiZWhhdmlvclBhdHRlcm5Pd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybnM6IFNlZW5CZWhhdmlvclBhdHRlcm5bXSA9IFtdO1xuICAgIGNvbnN0IHNzclVybEF1dGhUeXBlID0gcHJvcHMuc3NyVXJsQXV0aFR5cGUgPz8gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTTtcbiAgICBjb25zdCBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMgPSBwcm9wcy5hbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMgPz8gZmFsc2U7XG5cbiAgICB0aGlzLnNzclVybCA9IG5ldyBsYW1iZGEuRnVuY3Rpb25VcmwodGhpcywgXCJTc3JVcmxcIiwge1xuICAgICAgZnVuY3Rpb246IHByb3BzLnNzckZ1bmN0aW9uLFxuICAgICAgYXV0aFR5cGU6IHNzclVybEF1dGhUeXBlLFxuICAgICAgaW52b2tlTW9kZTogcHJvcHMuaW52b2tlTW9kZSA/PyBsYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzc3JPcmlnaW4gPVxuICAgICAgc3NyVXJsQXV0aFR5cGUgPT09IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICAgICAgPyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuc3NyVXJsKVxuICAgICAgICA6IG5ldyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luKHRoaXMuc3NyVXJsKTtcblxuICAgIGNvbnN0IGFzc2V0c09yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5hc3NldHNCdWNrZXQpO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5CdWNrZXQgPSB0aGlzLmh0bWxTdG9yZUJ1Y2tldCA/PyB0aGlzLmFzc2V0c0J1Y2tldDtcbiAgICBjb25zdCBodG1sT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChcbiAgICAgIGh0bWxPcmlnaW5CdWNrZXQsXG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldCAmJiB0aGlzLmh0bWxTdG9yZUtleVByZWZpeFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIG9yaWdpblBhdGg6IGAvJHt0aGlzLmh0bWxTdG9yZUtleVByZWZpeH1gLFxuICAgICAgICAgIH1cbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgKTtcblxuICAgIGNvbnN0IGJhc2VTc3JGb3J3YXJkSGVhZGVycyA9IFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxIb3N0SGVhZGVycyxcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgXTtcblxuICAgIGNvbnN0IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IG5ldyBTZXQoW1wiaG9zdFwiLCBcIngtZm9yd2FyZGVkLXByb3RvXCJdKTtcblxuICAgIGNvbnN0IGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5pc0FycmF5KHByb3BzLnNzckZvcndhcmRIZWFkZXJzKVxuICAgICAgPyBwcm9wcy5zc3JGb3J3YXJkSGVhZGVycy5tYXAoY2Fub25pY2FsaXplSGVhZGVyTmFtZSkuZmlsdGVyKChoZWFkZXIpID0+IGhlYWRlci5sZW5ndGggPiAwKVxuICAgICAgOiBbXTtcblxuICAgIGNvbnN0IHJlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSkpLFxuICAgICkuc29ydCgpO1xuXG4gICAgaWYgKHJlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRpc2FsbG93cyBzc3JGb3J3YXJkSGVhZGVyczogJHtyZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcikpKSxcbiAgICApLnNvcnQoKTtcblxuICAgIGlmIChyZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVycy5sZW5ndGggPiAwICYmICFhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPXRydWUgZm9yIHRlbmFudC1saWtlIHNzckZvcndhcmRIZWFkZXJzOiAke3JlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB0ZW5hbnRQYXNzdGhyb3VnaEhlYWRlcnMgPSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNcbiAgICAgID8gQXJyYXkuZnJvbShuZXcgU2V0KFtkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyLCAuLi5yZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVyc10pKVxuICAgICAgOiBbXTtcbiAgICBjb25zdCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyA9IGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc1xuICAgICAgPyBbXVxuICAgICAgOiBBcnJheS5mcm9tKG5ldyBTZXQoW2RlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIsIC4uLnJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzXSkpLnNvcnQoKTtcblxuICAgIGNvbnN0IHNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIFsuLi5iYXNlU3NyRm9yd2FyZEhlYWRlcnMsIC4uLnRlbmFudFBhc3N0aHJvdWdoSGVhZGVycywgLi4uZXh0cmFTc3JGb3J3YXJkSGVhZGVyc10uZmlsdGVyKFxuICAgICAgICAgIChoZWFkZXIpID0+ICFkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuaGFzKGhlYWRlciksXG4gICAgICAgICksXG4gICAgICApLFxuICAgICk7XG4gICAgY29uc3QgaHRtbENhY2hlS2V5RXhjbHVkZWRIZWFkZXJzID0gbmV3IFNldChbXG4gICAgICBcImNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvXCIsXG4gICAgICBcImNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NcIixcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgXSk7XG4gICAgY29uc3QgaHRtbENhY2hlS2V5SGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KHNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiAhaHRtbENhY2hlS2V5RXhjbHVkZWRIZWFkZXJzLmhhcyhoZWFkZXIpKSksXG4gICAgKTtcblxuICAgIGlmICghcHJvcHMuaHRtbENhY2hlUG9saWN5ICYmIGh0bWxDYWNoZUtleUhlYWRlcnMubGVuZ3RoID4gbWF4RGVmYXVsdENhY2hlS2V5SGVhZGVycykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBkZWZhdWx0IGh0bWxDYWNoZVBvbGljeSBzdXBwb3J0cyBhdCBtb3N0ICR7bWF4RGVmYXVsdENhY2hlS2V5SGVhZGVyc30gY2FjaGUta2V5IGhlYWRlcnM7IHJlY2VpdmVkICR7aHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGh9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3NyT3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJTc3JPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsKCksXG4gICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLnNzckZvcndhcmRIZWFkZXJzKSxcbiAgICB9KTtcbiAgICBjb25zdCBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJIdG1sT3JpZ2luUmVxdWVzdFBvbGljeVwiLCB7XG4gICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IHNzckNhY2hlUG9saWN5ID0gcHJvcHMuc3NyQ2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVEO1xuICAgIGNvbnN0IGh0bWxDYWNoZVBvbGljeSA9XG4gICAgICBwcm9wcy5odG1sQ2FjaGVQb2xpY3kgPz9cbiAgICAgIG5ldyBjbG91ZGZyb250LkNhY2hlUG9saWN5KHRoaXMsIFwiSHRtbENhY2hlUG9saWN5XCIsIHtcbiAgICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IEhUTUwgY2FjaGUgcG9saWN5IGtleWVkIGJ5IHF1ZXJ5IHN0cmluZ3MgYW5kIHN0YWJsZSBwdWJsaWMgdmFyaWFudCBoZWFkZXJzXCIsXG4gICAgICAgIG1pblR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgZGVmYXVsdFR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgbWF4VHRsOiBEdXJhdGlvbi5kYXlzKDM2NSksXG4gICAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlQ29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5odG1sQ2FjaGVLZXlIZWFkZXJzKSxcbiAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZVF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nQnJvdGxpOiB0cnVlLFxuICAgICAgICBlbmFibGVBY2NlcHRFbmNvZGluZ0d6aXA6IHRydWUsXG4gICAgICB9KTtcblxuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFxuICAgICAgXCJkaXJlY3QgUzMgcGF0aHNcIixcbiAgICAgIFtgJHthc3NldHNLZXlQcmVmaXh9LypgLCAuLi5kaXJlY3RTM1BhdGhQYXR0ZXJuc10sXG4gICAgICBiZWhhdmlvclBhdHRlcm5Pd25lcnMsXG4gICAgICBiZWhhdmlvclBhdHRlcm5zLFxuICAgICk7XG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJzdGF0aWMgSFRNTCBwYXRoc1wiLCBzdGF0aWNQYXRoUGF0dGVybnMsIGJlaGF2aW9yUGF0dGVybk93bmVycywgYmVoYXZpb3JQYXR0ZXJucyk7XG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJkaXJlY3QgU1NSIHBhdGhzXCIsIHNzclBhdGhQYXR0ZXJucywgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLCBiZWhhdmlvclBhdHRlcm5zKTtcbiAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZm9yRWFjaCgoY29uZmlnLCBpbmRleCkgPT4ge1xuICAgICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gICAgICAgIGBiZWFyZXIgRnVuY3Rpb24gVVJMIGNvLW9yaWdpbiAke2luZGV4ICsgMX1gLFxuICAgICAgICBjb25maWcucGF0aFBhdHRlcm5zLFxuICAgICAgICBiZWhhdmlvclBhdHRlcm5Pd25lcnMsXG4gICAgICAgIGJlaGF2aW9yUGF0dGVybnMsXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgdmlld2VyUmVxdWVzdEZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShcbiAgICAgICAgZ2VuZXJhdGVTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25Db2RlKFxuICAgICAgICAgIHNpdGVNb2RlLFxuICAgICAgICAgIFtgJHthc3NldHNLZXlQcmVmaXh9LypgLCAuLi5kaXJlY3RTM1BhdGhQYXR0ZXJuc10sXG4gICAgICAgICAgWy4uLnNzclBhdGhQYXR0ZXJucywgLi4uYmVhcmVyRnVuY3Rpb25VcmxQYXRoUGF0dGVybnNdLFxuICAgICAgICAgIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgIGNvbW1lbnQ6XG4gICAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgICAgPyBcIkZhY2VUaGVvcnkgdmlld2VyLXJlcXVlc3QgZWRnZSBjb250ZXh0IGFuZCBIVE1MIHJld3JpdGUgZm9yIFNTUiBzaXRlXCJcbiAgICAgICAgICA6IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXNwb25zZUZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uXCIsIHtcbiAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoZ2VuZXJhdGVTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uQ29kZSgpKSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVzcG9uc2UgcmVxdWVzdC1pZCBlY2hvIGZvciBTU1Igc2l0ZVwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zID0gKCk6IGNsb3VkZnJvbnQuRnVuY3Rpb25Bc3NvY2lhdGlvbltdID0+IFtcbiAgICAgIHtcbiAgICAgICAgZnVuY3Rpb246IHZpZXdlclJlcXVlc3RGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgZnVuY3Rpb246IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24sXG4gICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVTUE9OU0UsXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuICAgIGxldCBkaXN0cmlidXRpb25Eb21haW5OYW1lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG4gICAgICBjb25zdCBjZXJ0QXJuID0gU3RyaW5nKHByb3BzLmNlcnRpZmljYXRlQXJuID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmIChjZXJ0QXJuKSB7XG4gICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkNlcnRpZmljYXRlXCIsIGNlcnRBcm4pO1xuICAgICAgfSBlbHNlIGlmIChwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5EbnNWYWxpZGF0ZWRDZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgIGhvc3RlZFpvbmU6IHByb3BzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgcmVnaW9uOiBcInVzLWVhc3QtMVwiLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgcHJvcHMuY2VydGlmaWNhdGVBcm4gb3IgcHJvcHMuaG9zdGVkWm9uZSB3aGVuIHByb3BzLmRvbWFpbk5hbWUgaXMgc2V0XCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgIHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuUmVzcG9uc2VIZWFkZXJzUG9saWN5KHRoaXMsIFwiUmVzcG9uc2VIZWFkZXJzUG9saWN5XCIsIHtcbiAgICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IGJhc2VsaW5lIHNlY3VyaXR5IGhlYWRlcnMgKENTUCBzdGF5cyBvcmlnaW4tZGVmaW5lZClcIixcbiAgICAgICAgc2VjdXJpdHlIZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICBzdHJpY3RUcmFuc3BvcnRTZWN1cml0eToge1xuICAgICAgICAgICAgYWNjZXNzQ29udHJvbE1heEFnZTogRHVyYXRpb24uZGF5cygzNjUgKiAyKSxcbiAgICAgICAgICAgIGluY2x1ZGVTdWJkb21haW5zOiB0cnVlLFxuICAgICAgICAgICAgcHJlbG9hZDogdHJ1ZSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgY29udGVudFR5cGVPcHRpb25zOiB7IG92ZXJyaWRlOiB0cnVlIH0sXG4gICAgICAgICAgZnJhbWVPcHRpb25zOiB7XG4gICAgICAgICAgICBmcmFtZU9wdGlvbjogY2xvdWRmcm9udC5IZWFkZXJzRnJhbWVPcHRpb24uREVOWSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IHtcbiAgICAgICAgICAgIHJlZmVycmVyUG9saWN5OiBjbG91ZGZyb250LkhlYWRlcnNSZWZlcnJlclBvbGljeS5TVFJJQ1RfT1JJR0lOX1dIRU5fQ1JPU1NfT1JJR0lOLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB4c3NQcm90ZWN0aW9uOiB7XG4gICAgICAgICAgICBwcm90ZWN0aW9uOiB0cnVlLFxuICAgICAgICAgICAgbW9kZUJsb2NrOiB0cnVlLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgY3VzdG9tSGVhZGVyc0JlaGF2aW9yOiB7XG4gICAgICAgICAgY3VzdG9tSGVhZGVyczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBoZWFkZXI6IFwicGVybWlzc2lvbnMtcG9saWN5XCIsXG4gICAgICAgICAgICAgIHZhbHVlOiBcImNhbWVyYT0oKSwgbWljcm9waG9uZT0oKSwgZ2VvbG9jYXRpb249KClcIixcbiAgICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZVN0YXRpY0JlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGFzc2V0c09yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LlVTRV9PUklHSU5fQ0FDSEVfQ09OVFJPTF9IRUFERVJTLFxuICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZVN0YXRpY0h0bWxCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBodG1sT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgY2FjaGVQb2xpY3k6IGh0bWxDYWNoZVBvbGljeSxcbiAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZVNzckJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IHNzck9yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgY2FjaGVQb2xpY3k6IHNzckNhY2hlUG9saWN5LFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogc3NyT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG5cbiAgICBjb25zdCBhZGRpdGlvbmFsQmVoYXZpb3JzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucz4gPSB7fTtcbiAgICBjb25zdCBhZGRFeHBhbmRlZEJlaGF2aW9yID0gKHBhdHRlcm5zOiBzdHJpbmdbXSwgZmFjdG9yeTogKCkgPT4gY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMpOiB2b2lkID0+IHtcbiAgICAgIGZvciAoY29uc3QgcGF0dGVybiBvZiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJucykpIHtcbiAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1twYXR0ZXJuXSA9IGZhY3RvcnkoKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihbYCR7YXNzZXRzS2V5UHJlZml4fS8qYF0sIGNyZWF0ZVN0YXRpY0JlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKGRpcmVjdFMzUGF0aFBhdHRlcm5zLCBjcmVhdGVTdGF0aWNCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihzdGF0aWNQYXRoUGF0dGVybnMsIGNyZWF0ZVN0YXRpY0h0bWxCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihzc3JQYXRoUGF0dGVybnMsIGNyZWF0ZVNzckJlaGF2aW9yKTtcbiAgICB0aGlzLmJlYXJlckZ1bmN0aW9uVXJscyA9IFtdO1xuICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mb3JFYWNoKChjb25maWcsIGluZGV4KSA9PiB7XG4gICAgICBjb25zdCBmdW5jdGlvblVybCA9IG5ldyBsYW1iZGEuRnVuY3Rpb25VcmwodGhpcywgYEJlYXJlckZ1bmN0aW9uVXJsJHtpbmRleCArIDF9YCwge1xuICAgICAgICBmdW5jdGlvbjogY29uZmlnLm9yaWdpbi5mdW5jdGlvbixcbiAgICAgICAgYXV0aFR5cGU6IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLk5PTkUsXG4gICAgICAgIGludm9rZU1vZGU6IGNvbmZpZy5vcmlnaW4uaW52b2tlTW9kZSA/PyBsYW1iZGEuSW52b2tlTW9kZS5CVUZGRVJFRCxcbiAgICAgIH0pO1xuICAgICAgdGhpcy5iZWFyZXJGdW5jdGlvblVybHMucHVzaChmdW5jdGlvblVybCk7XG4gICAgICBjb25zdCBmdW5jdGlvblVybE9yaWdpbiA9IG5ldyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luKGZ1bmN0aW9uVXJsKTtcbiAgICAgIGNvbnN0IGNyZWF0ZUJlYXJlckZ1bmN0aW9uVXJsQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgICAgb3JpZ2luOiBmdW5jdGlvblVybE9yaWdpbixcbiAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5LkFMTF9WSUVXRVJfRVhDRVBUX0hPU1RfSEVBREVSLFxuICAgICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgICB9KTtcbiAgICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoY29uZmlnLnBhdGhQYXR0ZXJucywgY3JlYXRlQmVhcmVyRnVuY3Rpb25VcmxCZWhhdmlvcik7XG4gICAgfSk7XG5cbiAgICBjb25zdCBkZWZhdWx0T3JpZ2luID1cbiAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgID8gbmV3IG9yaWdpbnMuT3JpZ2luR3JvdXAoe1xuICAgICAgICAgICAgcHJpbWFyeU9yaWdpbjogaHRtbE9yaWdpbixcbiAgICAgICAgICAgIGZhbGxiYWNrT3JpZ2luOiBzc3JPcmlnaW4sXG4gICAgICAgICAgICBmYWxsYmFja1N0YXR1c0NvZGVzOiBbNDAzLCA0MDRdLFxuICAgICAgICAgIH0pXG4gICAgICAgIDogc3NyT3JpZ2luO1xuICAgIGNvbnN0IGRlZmF1bHRBbGxvd2VkTWV0aG9kcyA9XG4gICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICA/IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OU1xuICAgICAgICA6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMO1xuXG4gICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgLi4uKGVuYWJsZUxvZ2dpbmcgJiYgdGhpcy5sb2dzQnVja2V0XG4gICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgOiB7fSksXG4gICAgICAuLi4oZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgJiYgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGVcbiAgICAgICAgPyB7IGRvbWFpbk5hbWVzOiBkaXN0cmlidXRpb25Eb21haW5OYW1lcywgY2VydGlmaWNhdGU6IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlIH1cbiAgICAgICAgOiB7fSksXG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgb3JpZ2luOiBkZWZhdWx0T3JpZ2luLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGRlZmF1bHRBbGxvd2VkTWV0aG9kcyxcbiAgICAgICAgY2FjaGVQb2xpY3k6IHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gaHRtbENhY2hlUG9saWN5IDogc3NyQ2FjaGVQb2xpY3ksXG4gICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gaHRtbE9yaWdpblJlcXVlc3RQb2xpY3kgOiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgICB9LFxuICAgICAgYWRkaXRpb25hbEJlaGF2aW9ycyxcbiAgICAgIC4uLihwcm9wcy53ZWJBY2xJZCA/IHsgd2ViQWNsSWQ6IHByb3BzLndlYkFjbElkIH0gOiB7fSksXG4gICAgfSk7XG5cbiAgICBpZiAoc3NyVXJsQXV0aFR5cGUgPT09IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU0pIHtcbiAgICAgIHByb3BzLnNzckZ1bmN0aW9uLmFkZFBlcm1pc3Npb24oXCJBbGxvd0Nsb3VkRnJvbnRJbnZva2VGdW5jdGlvblZpYVVybFwiLCB7XG4gICAgICAgIGFjdGlvbjogXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIixcbiAgICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJjbG91ZGZyb250LmFtYXpvbmF3cy5jb21cIiksXG4gICAgICAgIHNvdXJjZUFybjogdGhpcy5kaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uQXJuLFxuICAgICAgICBpbnZva2VkVmlhRnVuY3Rpb25Vcmw6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5odG1sU3RvcmVCdWNrZXQpIHtcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0LmdyYW50UmVhZFdyaXRlKHByb3BzLnNzckZ1bmN0aW9uKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5pc3JNZXRhZGF0YVRhYmxlKSB7XG4gICAgICB0aGlzLmlzck1ldGFkYXRhVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLnNzckZ1bmN0aW9uKTtcbiAgICB9XG5cbiAgICBpZiAod2lyZVJ1bnRpbWVFbnYpIHtcbiAgICAgIHRoaXMuYXNzZXRzQnVja2V0LmdyYW50UmVhZChwcm9wcy5zc3JGdW5jdGlvbik7XG5cbiAgICAgIGNvbnN0IHNzckZ1bmN0aW9uQW55ID0gcHJvcHMuc3NyRnVuY3Rpb24gYXMgYW55O1xuICAgICAgaWYgKHR5cGVvZiBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudCAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeVNzclNpdGUgd2lyZVJ1bnRpbWVFbnYgcmVxdWlyZXMgcHJvcHMuc3NyRnVuY3Rpb24gdG8gc3VwcG9ydCBhZGRFbnZpcm9ubWVudDsgcGFzcyBhIGxhbWJkYS5GdW5jdGlvbiBvciBzZXQgd2lyZVJ1bnRpbWVFbnY9ZmFsc2UgYW5kIHNldCBlbnYgdmFycyBtYW51YWxseVwiLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfQlVDS0VUXCIsIHRoaXMuYXNzZXRzQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQVNTRVRTX1BSRUZJWFwiLCBhc3NldHNLZXlQcmVmaXgpO1xuICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQVNTRVRTX01BTklGRVNUX0tFWVwiLCBhc3NldHNNYW5pZmVzdEtleSk7XG5cbiAgICAgIGlmICh0aGlzLmh0bWxTdG9yZUJ1Y2tldCAmJiB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCkge1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkZBQ0VUSEVPUllfSVNSX0JVQ0tFVFwiLCB0aGlzLmh0bWxTdG9yZUJ1Y2tldC5idWNrZXROYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0lTUl9QUkVGSVhcIiwgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXgpO1xuICAgICAgfVxuICAgICAgaWYgKGlzck1ldGFkYXRhVGFibGVOYW1lKSB7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0NBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkZBQ0VUSEVPUllfQ0FDSEVfVEFCTEVfTkFNRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQ0FDSEVfVEFCTEVfTkFNRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQ0FDSEVfVEFCTEVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChkb21haW5OYW1lICYmIHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IHByb3BzLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWU6IGRvbWFpbk5hbWUsXG4gICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgIH0pO1xuICAgIH1cblxuICB9XG59XG4iXX0=