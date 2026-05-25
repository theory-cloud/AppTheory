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
function pathPatternEpsilonClosure(pattern, index) {
    const closure = [];
    const seen = new Set();
    const stack = [index];
    while (stack.length > 0) {
        const current = stack.pop() ?? 0;
        if (seen.has(current)) {
            continue;
        }
        seen.add(current);
        closure.push(current);
        if (pattern[current] === "*") {
            stack.push(current + 1);
        }
    }
    return closure;
}
function pathPatternTransitions(pattern, index) {
    const token = pattern[index];
    if (token === undefined) {
        return [];
    }
    if (token === "*") {
        return [{ target: index, any: true }];
    }
    if (token === "?") {
        return [{ target: index + 1, any: true }];
    }
    return [{ target: index + 1, any: false, literal: token }];
}
function pathPatternTransitionsCanShareCharacter(left, right) {
    return left.any || right.any || left.literal === right.literal;
}
function pathPatternsCanOverlap(left, right) {
    const seenStates = new Set();
    const queue = [];
    const enqueueClosurePairs = (leftIndex, rightIndex) => {
        for (const leftClosed of pathPatternEpsilonClosure(left, leftIndex)) {
            for (const rightClosed of pathPatternEpsilonClosure(right, rightIndex)) {
                const key = `${leftClosed}:${rightClosed}`;
                if (seenStates.has(key)) {
                    continue;
                }
                seenStates.add(key);
                queue.push([leftClosed, rightClosed]);
            }
        }
    };
    enqueueClosurePairs(0, 0);
    while (queue.length > 0) {
        const [leftIndex, rightIndex] = queue.shift() ?? [0, 0];
        if (leftIndex === left.length && rightIndex === right.length) {
            return true;
        }
        for (const leftTransition of pathPatternTransitions(left, leftIndex)) {
            for (const rightTransition of pathPatternTransitions(right, rightIndex)) {
                if (!pathPatternTransitionsCanShareCharacter(leftTransition, rightTransition)) {
                    continue;
                }
                enqueueClosurePairs(leftTransition.target, rightTransition.target);
            }
        }
    }
    return false;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFzRDtBQUN0RCwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUU5RCwyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyREFBMkQ7QUFDM0QseUNBQXlDO0FBQ3pDLDBEQUEwRDtBQUMxRCwyQ0FBdUM7QUFFdkMseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLHlCQUF5QixDQUFDO0FBQzNELE1BQU0sNEJBQTRCLEdBQUcsS0FBSyxDQUFDO0FBQzNDLE1BQU0seUJBQXlCLEdBQUcsRUFBRSxDQUFDO0FBQ3JDLE1BQU0seUJBQXlCLEdBQUcsYUFBYSxDQUFDO0FBRWhELElBQVksb0JBWVg7QUFaRCxXQUFZLG9CQUFvQjtJQUM5Qjs7O09BR0c7SUFDSCw2Q0FBcUIsQ0FBQTtJQUVyQjs7O09BR0c7SUFDSCwyQ0FBbUIsQ0FBQTtBQUNyQixDQUFDLEVBWlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFZL0I7QUFFRCxTQUFTLHNCQUFzQixDQUFDLE9BQWU7SUFDN0MsTUFBTSxVQUFVLEdBQUcsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLENBQUMsT0FBTyxD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O0lBRUgsQ0FBQzs7QUF4ZkgsNENBeWZDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50XCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyLCB0cmltUmVwZWF0ZWRDaGFyU3RhcnQgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuXG5jb25zdCBhcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtdXJpXCI7XG5jb25zdCBmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIgPSBcIngtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlcIjtcbmNvbnN0IGFwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtaG9zdFwiO1xuY29uc3QgZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RcIjtcbmNvbnN0IHNzck9yaWdpbmFsVXJpSGVhZGVycyA9IFthcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciwgZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzck9yaWdpbmFsSG9zdEhlYWRlcnMgPSBbYXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyLCBmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuID0gXCIvX2ZhY2V0aGVvcnkvZGF0YS8qXCI7XG5jb25zdCBzc2dJc3JTc3JEYXRhUGF0aFBhdHRlcm4gPSBcIi9fZmFjZXRoZW9yeS9zc3ItZGF0YS8qXCI7XG5jb25zdCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4ID0gXCJpc3JcIjtcbmNvbnN0IG1heERlZmF1bHRDYWNoZUtleUhlYWRlcnMgPSAxMDtcbmNvbnN0IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgPSBcIngtdGVuYW50LWlkXCI7XG5cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeVNzclNpdGVNb2RlIHtcbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaXMgdGhlIGRlZmF1bHQgb3JpZ2luLiBEaXJlY3QgUzMgYmVoYXZpb3JzIGFyZSB1c2VkIG9ubHkgZm9yXG4gICAqIGltbXV0YWJsZSBhc3NldHMgYW5kIGFueSBleHBsaWNpdGx5IGNvbmZpZ3VyZWQgc3RhdGljIHBhdGggcGF0dGVybnMuXG4gICAqL1xuICBTU1JfT05MWSA9IFwic3NyLW9ubHlcIixcblxuICAvKipcbiAgICogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBTU1IvSVNSIGlzIHRoZSBmYWxsYmFjay4gRmFjZVRoZW9yeSBoeWRyYXRpb25cbiAgICogZGF0YSByb3V0ZXMgYXJlIGtlcHQgb24gUzMgYW5kIHRoZSBlZGdlIHJld3JpdGVzIGV4dGVuc2lvbmxlc3MgcGF0aHMgdG8gYC9pbmRleC5odG1sYC5cbiAgICovXG4gIFNTR19JU1IgPSBcInNzZy1pc3JcIixcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5Ub1VyaVByZWZpeChwYXR0ZXJuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKS5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gIHJldHVybiBub3JtYWxpemVkID8gYC8ke25vcm1hbGl6ZWR9YCA6IFwiL1wiO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoUGF0dGVybnMocGF0dGVybnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICByZXR1cm4gQXJyYXkuZnJvbShcbiAgICBuZXcgU2V0KFxuICAgICAgKEFycmF5LmlzQXJyYXkocGF0dGVybnMpID8gcGF0dGVybnMgOiBbXSlcbiAgICAgICAgLm1hcCgocGF0dGVybikgPT4gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKSlcbiAgICAgICAgLmZpbHRlcigocGF0dGVybikgPT4gcGF0dGVybi5sZW5ndGggPiAwKSxcbiAgICApLFxuICApO1xufVxuXG5mdW5jdGlvbiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4cGFuZGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIik7XG4gICAgaWYgKCFub3JtYWxpemVkKSBjb250aW51ZTtcblxuICAgIGV4cGFuZGVkLmFkZChub3JtYWxpemVkKTtcbiAgICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICBjb25zdCByb290UGF0dGVybiA9IG5vcm1hbGl6ZWQuc2xpY2UoMCwgLTIpO1xuICAgICAgaWYgKHJvb3RQYXR0ZXJuKSB7XG4gICAgICAgIGV4cGFuZGVkLmFkZChyb290UGF0dGVybik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIEFycmF5LmZyb20oZXhwYW5kZWQpO1xufVxuXG5pbnRlcmZhY2UgU2VlbkJlaGF2aW9yUGF0dGVybiB7XG4gIHJlYWRvbmx5IHBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbGFiZWw6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFBhdGhQYXR0ZXJuVHJhbnNpdGlvbiB7XG4gIHJlYWRvbmx5IHRhcmdldDogbnVtYmVyO1xuICByZWFkb25seSBhbnk6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxpdGVyYWw/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuRXBzaWxvbkNsb3N1cmUocGF0dGVybjogc3RyaW5nLCBpbmRleDogbnVtYmVyKTogbnVtYmVyW10ge1xuICBjb25zdCBjbG9zdXJlOiBudW1iZXJbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IHN0YWNrID0gW2luZGV4XTtcblxuICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBzdGFjay5wb3AoKSA/PyAwO1xuICAgIGlmIChzZWVuLmhhcyhjdXJyZW50KSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZW4uYWRkKGN1cnJlbnQpO1xuICAgIGNsb3N1cmUucHVzaChjdXJyZW50KTtcblxuICAgIGlmIChwYXR0ZXJuW2N1cnJlbnRdID09PSBcIipcIikge1xuICAgICAgc3RhY2sucHVzaChjdXJyZW50ICsgMSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGNsb3N1cmU7XG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuVHJhbnNpdGlvbnMocGF0dGVybjogc3RyaW5nLCBpbmRleDogbnVtYmVyKTogUGF0aFBhdHRlcm5UcmFuc2l0aW9uW10ge1xuICBjb25zdCB0b2tlbiA9IHBhdHRlcm5baW5kZXhdO1xuICBpZiAodG9rZW4gPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGlmICh0b2tlbiA9PT0gXCIqXCIpIHtcbiAgICByZXR1cm4gW3sgdGFyZ2V0OiBpbmRleCwgYW55OiB0cnVlIH1dO1xuICB9XG5cbiAgaWYgKHRva2VuID09PSBcIj9cIikge1xuICAgIHJldHVybiBbeyB0YXJnZXQ6IGluZGV4ICsgMSwgYW55OiB0cnVlIH1dO1xuICB9XG5cbiAgcmV0dXJuIFt7IHRhcmdldDogaW5kZXggKyAxLCBhbnk6IGZhbHNlLCBsaXRlcmFsOiB0b2tlbiB9XTtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5UcmFuc2l0aW9uc0NhblNoYXJlQ2hhcmFjdGVyKGxlZnQ6IFBhdGhQYXR0ZXJuVHJhbnNpdGlvbiwgcmlnaHQ6IFBhdGhQYXR0ZXJuVHJhbnNpdGlvbik6IGJvb2xlYW4ge1xuICByZXR1cm4gbGVmdC5hbnkgfHwgcmlnaHQuYW55IHx8IGxlZnQubGl0ZXJhbCA9PT0gcmlnaHQubGl0ZXJhbDtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5zQ2FuT3ZlcmxhcChsZWZ0OiBzdHJpbmcsIHJpZ2h0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgc2VlblN0YXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBxdWV1ZTogQXJyYXk8W251bWJlciwgbnVtYmVyXT4gPSBbXTtcblxuICBjb25zdCBlbnF1ZXVlQ2xvc3VyZVBhaXJzID0gKGxlZnRJbmRleDogbnVtYmVyLCByaWdodEluZGV4OiBudW1iZXIpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGxlZnRDbG9zZWQgb2YgcGF0aFBhdHRlcm5FcHNpbG9uQ2xvc3VyZShsZWZ0LCBsZWZ0SW5kZXgpKSB7XG4gICAgICBmb3IgKGNvbnN0IHJpZ2h0Q2xvc2VkIG9mIHBhdGhQYXR0ZXJuRXBzaWxvbkNsb3N1cmUocmlnaHQsIHJpZ2h0SW5kZXgpKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke2xlZnRDbG9zZWR9OiR7cmlnaHRDbG9zZWR9YDtcbiAgICAgICAgaWYgKHNlZW5TdGF0ZXMuaGFzKGtleSkpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBzZWVuU3RhdGVzLmFkZChrZXkpO1xuICAgICAgICBxdWV1ZS5wdXNoKFtsZWZ0Q2xvc2VkLCByaWdodENsb3NlZF0pO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBlbnF1ZXVlQ2xvc3VyZVBhaXJzKDAsIDApO1xuXG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgW2xlZnRJbmRleCwgcmlnaHRJbmRleF0gPSBxdWV1ZS5zaGlmdCgpID8/IFswLCAwXTtcbiAgICBpZiAobGVmdEluZGV4ID09PSBsZWZ0Lmxlbmd0aCAmJiByaWdodEluZGV4ID09PSByaWdodC5sZW5ndGgpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgbGVmdFRyYW5zaXRpb24gb2YgcGF0aFBhdHRlcm5UcmFuc2l0aW9ucyhsZWZ0LCBsZWZ0SW5kZXgpKSB7XG4gICAgICBmb3IgKGNvbnN0IHJpZ2h0VHJhbnNpdGlvbiBvZiBwYXRoUGF0dGVyblRyYW5zaXRpb25zKHJpZ2h0LCByaWdodEluZGV4KSkge1xuICAgICAgICBpZiAoIXBhdGhQYXR0ZXJuVHJhbnNpdGlvbnNDYW5TaGFyZUNoYXJhY3RlcihsZWZ0VHJhbnNpdGlvbiwgcmlnaHRUcmFuc2l0aW9uKSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZW5xdWV1ZUNsb3N1cmVQYWlycyhsZWZ0VHJhbnNpdGlvbi50YXJnZXQsIHJpZ2h0VHJhbnNpdGlvbi50YXJnZXQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgc2Vlbk93bmVyczogTWFwPHN0cmluZywgc3RyaW5nPixcbiAgc2VlblBhdHRlcm5zOiBTZWVuQmVoYXZpb3JQYXR0ZXJuW10sXG4pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgIGNvbnN0IG93bmVyID0gc2Vlbk93bmVycy5nZXQocGF0dGVybik7XG4gICAgaWYgKG93bmVyICYmIG93bmVyICE9PSBsYWJlbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIHJlY2VpdmVkIG92ZXJsYXBwaW5nIHBhdGggcGF0dGVybiBcIiR7cGF0dGVybn1cIiBmb3IgJHtvd25lcn0gYW5kICR7bGFiZWx9YCk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBzZWVuUGF0dGVybiBvZiBzZWVuUGF0dGVybnMpIHtcbiAgICAgIGlmIChzZWVuUGF0dGVybi5sYWJlbCAhPT0gbGFiZWwgJiYgcGF0aFBhdHRlcm5zQ2FuT3ZlcmxhcChzZWVuUGF0dGVybi5wYXR0ZXJuLCBwYXR0ZXJuKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJucyBcIiR7c2VlblBhdHRlcm4ucGF0dGVybn1cIiBhbmQgXCIke3BhdHRlcm59XCIgZm9yICR7c2VlblBhdHRlcm4ubGFiZWx9IGFuZCAke2xhYmVsfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgc2Vlbk93bmVycy5zZXQocGF0dGVybiwgbGFiZWwpO1xuICAgIHNlZW5QYXR0ZXJucy5wdXNoKHsgcGF0dGVybiwgbGFiZWwgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2Fub25pY2FsaXplSGVhZGVyTmFtZShoZWFkZXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcoaGVhZGVyKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuZnVuY3Rpb24gaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBjYW5vbmljYWxpemVIZWFkZXJOYW1lKGhlYWRlcikucmVwbGFjZSgvW15hLXowLTldKy9nLCBcIi1cIik7XG4gIHJldHVybiBub3JtYWxpemVkID09PSBkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyIHx8IC8oXnwtKXRlbmFudCgtfCQpLy50ZXN0KG5vcm1hbGl6ZWQpO1xufVxuXG5mdW5jdGlvbiBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoXG4gIG1vZGU6IEFwcFRoZW9yeVNzclNpdGVNb2RlLFxuICByYXdTM1BhdGhQYXR0ZXJuczogc3RyaW5nW10sXG4gIGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnM6IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3UzNQcmVmaXhlcyA9IHJhd1MzUGF0aFBhdHRlcm5zLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KS5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgcmF3UzNQcmVmaXhMaXN0ID0gcmF3UzNQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG4gIGNvbnN0IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBsYW1iZGFQYXNzdGhyb3VnaFBhdGhQYXR0ZXJuc1xuICAgIC5tYXAocGF0aFBhdHRlcm5Ub1VyaVByZWZpeClcbiAgICAuc29ydCgoYSwgYikgPT4gYi5sZW5ndGggLSBhLmxlbmd0aCk7XG4gIGNvbnN0IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4TGlzdCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubWFwKChwcmVmaXgpID0+IGAnJHtwcmVmaXh9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuICBjb25zdCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyTGlzdCA9IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLm1hcCgoaGVhZGVyKSA9PiBgJyR7aGVhZGVyfSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcblxuICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHJlcXVlc3QuaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycyB8fCB7fTtcblx0ICB2YXIgaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycztcblx0ICB2YXIgdXJpID0gcmVxdWVzdC51cmkgfHwgJy8nO1xuXHQgIHZhciBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyA9IFtcblx0ICAgICR7YmxvY2tlZFZpZXdlclRlbmFudEhlYWRlckxpc3R9XG5cdCAgXTtcblxuXHQgIGZvciAodmFyIGJsb2NrZWRJbmRleCA9IDA7IGJsb2NrZWRJbmRleCA8IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLmxlbmd0aDsgYmxvY2tlZEluZGV4KyspIHtcblx0ICAgIGRlbGV0ZSBoZWFkZXJzW2Jsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzW2Jsb2NrZWRJbmRleF1dO1xuXHQgIH1cblxuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gJ3JlcV8nICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyAnXycgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCk7XG5cdCAgfVxuXG5cdCAgaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyfSddID0geyB2YWx1ZTogdXJpIH07XG5cdCAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblxuXHQgIGlmIChoZWFkZXJzLmhvc3QgJiYgaGVhZGVycy5ob3N0LnZhbHVlKSB7XG5cdCAgICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcn0nXSA9IHsgdmFsdWU6IGhlYWRlcnMuaG9zdC52YWx1ZSB9O1xuXHQgICAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgfVxuXG5cdCAgaWYgKCcke21vZGV9JyA9PT0gJyR7QXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUn0nKSB7XG5cdCAgICB2YXIgcmF3UzNQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtyYXdTM1ByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBbXG5cdCAgICAgICR7bGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0fVxuXHQgICAgXTtcblx0ICAgIHZhciBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IGZhbHNlO1xuXG5cdCAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubGVuZ3RoOyBpKyspIHtcblx0ICAgICAgdmFyIHByZWZpeCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXNbaV07XG5cdCAgICAgIGlmICh1cmkgPT09IHByZWZpeCB8fCB1cmkuc3RhcnRzV2l0aChwcmVmaXggKyAnLycpKSB7XG5cdCAgICAgICAgaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGggPSB0cnVlO1xuXHQgICAgICAgIGJyZWFrO1xuXHQgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIGlmICghaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGgpIHtcblx0ICAgICAgdmFyIGlzUmF3UzNQYXRoID0gZmFsc2U7XG5cblx0ICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCByYXdTM1ByZWZpeGVzLmxlbmd0aDsgaisrKSB7XG5cdCAgICAgICAgdmFyIHJhd1ByZWZpeCA9IHJhd1MzUHJlZml4ZXNbal07XG5cdCAgICAgICAgaWYgKHVyaSA9PT0gcmF3UHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHJhd1ByZWZpeCArICcvJykpIHtcblx0ICAgICAgICAgIGlzUmF3UzNQYXRoID0gdHJ1ZTtcblx0ICAgICAgICAgIGJyZWFrO1xuXHQgICAgICAgIH1cblx0ICAgICAgfVxuXG5cdCAgICAgIHZhciBsYXN0U2xhc2ggPSB1cmkubGFzdEluZGV4T2YoJy8nKTtcblx0ICAgICAgdmFyIGxhc3RTZWdtZW50ID0gbGFzdFNsYXNoID49IDAgPyB1cmkuc3Vic3RyaW5nKGxhc3RTbGFzaCArIDEpIDogdXJpO1xuXG5cdCAgICAgIGlmICghaXNSYXdTM1BhdGggJiYgbGFzdFNlZ21lbnQuaW5kZXhPZignLicpID09PSAtMSkge1xuXHQgICAgICAgIHJlcXVlc3QudXJpID0gdXJpLmVuZHNXaXRoKCcvJykgPyB1cmkgKyAnaW5kZXguaHRtbCcgOiB1cmkgKyAnL2luZGV4Lmh0bWwnO1xuXHQgICAgICB9XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlcXVlc3Q7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvbkNvZGUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgcmVzcG9uc2UgPSBldmVudC5yZXNwb25zZTtcblx0ICB2YXIgcmVxdWVzdElkSGVhZGVyID0gcmVxdWVzdC5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAocmVxdWVzdElkKSB7XG5cdCAgICByZXNwb25zZS5oZWFkZXJzID0gcmVzcG9uc2UuaGVhZGVycyB8fCB7fTtcblx0ICAgIGlmICghcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10pIHtcblx0ICAgICAgcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVzcG9uc2U7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZVByb3BzIHtcbiAgcmVhZG9ubHkgc3NyRnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IGRlcGxveW1lbnQgbW9kZSBmb3IgdGhlIHNpdGUgdG9wb2xvZ3kuXG4gICAqXG4gICAqIC0gYHNzci1vbmx5YDogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpcyB0aGUgZGVmYXVsdCBvcmlnaW5cbiAgICogLSBgc3NnLWlzcmA6IFMzIGlzIHRoZSBwcmltYXJ5IEhUTUwgb3JpZ2luIGFuZCBMYW1iZGEgaXMgdGhlIGZhbGxiYWNrXG4gICAqXG4gICAqIEV4aXN0aW5nIGltcGxpY2l0IGJlaGF2aW9yIG1hcHMgdG8gYHNzci1vbmx5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFlcbiAgICovXG4gIHJlYWRvbmx5IG1vZGU/OiBBcHBUaGVvcnlTc3JTaXRlTW9kZTtcblxuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpbnZva2UgbW9kZSBmb3IgdGhlIFNTUiBvcmlnaW4uXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTVxuICAgKi9cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xuXG4gIC8qKlxuICAgKiBGdW5jdGlvbiBVUkwgYXV0aCB0eXBlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IGZhaWxzIGNsb3NlZCB0byBgQVdTX0lBTWAgYW5kIHNpZ25zIENsb3VkRnJvbnQtdG8tTGFtYmRhXG4gICAqIHRyYWZmaWMgd2l0aCBsYW1iZGEgT3JpZ2luIEFjY2VzcyBDb250cm9sLlxuICAgKlxuICAgKiBTZXQgdGhpcyBleHBsaWNpdGx5IHRvIGBOT05FYCBvbmx5IHdoZW4geW91IGludGVudGlvbmFsbHkgcmVxdWlyZSBwdWJsaWNcbiAgICogZGlyZWN0IEZ1bmN0aW9uIFVSTCBhY2Nlc3MgYXMgYSBkZWxpYmVyYXRlIGNvbXBhdGliaWxpdHkgY2hvaWNlLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNXG4gICAqL1xuICByZWFkb25seSBzc3JVcmxBdXRoVHlwZT86IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlO1xuXG4gIHJlYWRvbmx5IGFzc2V0c0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHJlYWRvbmx5IGFzc2V0c1BhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFzc2V0c0tleVByZWZpeD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzTWFuaWZlc3RLZXk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCB1c2VkIGJ5IEZhY2VUaGVvcnkgSVNSIEhUTUwgc3RvcmFnZSAoYFMzSHRtbFN0b3JlYCkuXG4gICAqXG4gICAqIFdoZW4gcHJvdmlkZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIFNTUiBmdW5jdGlvbiByZWFkL3dyaXRlIGFjY2VzcyBhbmQgd2lyZXM6XG4gICAqIC0gYEZBQ0VUSEVPUllfSVNSX0JVQ0tFVGBcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfUFJFRklYYFxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbFN0b3JlQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogUzMga2V5IHByZWZpeCB1c2VkIGJ5IEZhY2VUaGVvcnkgSVNSIEhUTUwgc3RvcmFnZS5cbiAgICogQGRlZmF1bHQgaXNyXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVLZXlQcmVmaXg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgZXh0ZW5zaW9ubGVzcyBIVE1MIHNlY3Rpb24gcGF0aCBwYXR0ZXJucyB0byByb3V0ZSBkaXJlY3RseSB0byB0aGUgcHJpbWFyeSBIVE1MIFMzIG9yaWdpbi5cbiAgICpcbiAgICogUmVxdWVzdHMgbGlrZSBgL21hcmtldGluZ2AgYW5kIGAvbWFya2V0aW5nLy4uLmAgYXJlIHJld3JpdHRlbiB0byBgL2luZGV4Lmh0bWxgXG4gICAqIHdpdGhpbiB0aGUgc2VjdGlvbiBhbmQgc3RheSBvbiBTMyBpbnN0ZWFkIG9mIGZhbGxpbmcgYmFjayB0byBMYW1iZGEuXG4gICAqXG4gICAqIEV4YW1wbGUgZGlyZWN0LVMzIEhUTUwgc2VjdGlvbiBwYXRoOiBcIi9tYXJrZXRpbmcvKlwiXG4gICAqL1xuICByZWFkb25seSBzdGF0aWNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCByYXcgUzMgb2JqZWN0L2RhdGEgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgZXh0ZW5zaW9ubGVzcyBIVE1MIHJld3JpdGVzLlxuICAgKlxuICAgKiBJbiBgc3NnLWlzcmAgbW9kZSwgYC9fZmFjZXRoZW9yeS9kYXRhLypgIGlzIGFkZGVkIGF1dG9tYXRpY2FsbHkuXG4gICAqIEV4YW1wbGUgZGlyZWN0LVMzIG9iamVjdCBwYXRoOiBcIi9mZWVkcy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IGRpcmVjdFMzUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgdGhlIGBzc2ctaXNyYCBvcmlnaW4gZ3JvdXAgYW5kIHJvdXRlIGRpcmVjdGx5XG4gICAqIHRvIHRoZSBMYW1iZGEgRnVuY3Rpb24gVVJMIHdpdGggZnVsbCBtZXRob2Qgc3VwcG9ydC5cbiAgICpcbiAgICogSW4gYHNzZy1pc3JgIG1vZGUsIGAvX2ZhY2V0aGVvcnkvc3NyLWRhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseSBmb3IgRmFjZVRoZW9yeVxuICAgKiBzdHJpY3Qgbm8taW5saW5lLUNTUCBTU1IgaHlkcmF0aW9uIHNpZGVjYXJzLlxuICAgKlxuICAgKiBVc2UgdGhpcyBmb3Igc2FtZS1vcmlnaW4gZHluYW1pYyBwYXRocyBzdWNoIGFzIGF1dGggY2FsbGJhY2tzLCBhY3Rpb25zLCBvciBmb3JtIHBvc3RzLlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TU1IgcGF0aDogXCIvYWN0aW9ucy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHNzclBhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGJlYXJlci1hdXRoIExhbWJkYSBGdW5jdGlvbiBVUkwgY28tb3JpZ2lucyB0byBhdHRhY2ggdG8gdGhlIHNhbWUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIGVhY2ggY28tb3JpZ2luIEZ1bmN0aW9uIFVSTCB3aXRoIGBBdXRoVHlwZS5OT05FYCBhbmQgcm91dGVzIHRoZSBzdXBwbGllZFxuICAgKiBwYXRoIHBhdHRlcm5zIHRvIGl0IHdpdGhvdXQgTGFtYmRhIE9yaWdpbiBBY2Nlc3MgQ29udHJvbC4gVGhlIFNTUiBvcmlnaW4gcmVtYWlucyBnb3Zlcm5lZCBieVxuICAgKiBgc3NyVXJsQXV0aFR5cGVgIGFuZCBzdGlsbCBkZWZhdWx0cyB0byBgQVdTX0lBTWAgcGx1cyBMYW1iZGEgT0FDLlxuICAgKlxuICAgKiBDby1vcmlnaW4gcGF0aHMgcGFydGljaXBhdGUgaW4gQXBwVGhlb3J5J3MgYmVoYXZpb3IgcGF0aCBjb2xsaXNpb24gY2hlY2tzIGFuZCBieXBhc3MgYHNzZy1pc3JgXG4gICAqIEhUTUwgcmV3cml0ZXMuIFRoaXMgaXMgdGhlIHN1cHBvcnRlZCBBcHBUaGVvcnkgcGF0aCBmb3IgbWl4ZWQtYXV0aCBkaXN0cmlidXRpb25zOyBkbyBub3QgaGFuZC13aXJlXG4gICAqIHJhdyBgZGlzdHJpYnV0aW9uLmFkZEJlaGF2aW9yKC4uLilgIGNhbGxzIHdoZW4gQXBwVGhlb3J5IHNob3VsZCBvd24gcGF0aCBhbmQgZWRnZS1jb250ZXh0IHBvbGljeS5cbiAgICpcbiAgICogRXhhbXBsZSBiZWFyZXIgQVBJIHBhdGhzOiBgW1wiL2FwaS8qXCIsIFwiL2F1dGgvKlwiXWAuXG4gICAqL1xuICByZWFkb25seSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnM/OiBBcHBUaGVvcnlTc3JTaXRlQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5bXTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgVGFibGVUaGVvcnkvRHluYW1vREIgdGFibGUgdXNlZCBmb3IgRmFjZVRoZW9yeSBJU1IgbWV0YWRhdGEgYW5kIGxlYXNlIGNvb3JkaW5hdGlvbi5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlcyB0aGVcbiAgICogbWV0YWRhdGEgdGFibGUgYWxpYXNlcyBleHBlY3RlZCBieSB0aGUgZG9jdW1lbnRlZCBGYWNlVGhlb3J5IGRlcGxveW1lbnQgc2hhcGUuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBJU1IvY2FjaGUgbWV0YWRhdGEgdGFibGUgbmFtZSB0byB3aXJlIHdoZW4geW91IGFyZSBub3QgcGFzc2luZyBgaXNyTWV0YWRhdGFUYWJsZWAuXG4gICAqXG4gICAqIFByZWZlciBgaXNyTWV0YWRhdGFUYWJsZWAgd2hlbiBBcHBUaGVvcnkgc2hvdWxkIGFsc28gZ3JhbnQgYWNjZXNzIHRvIHRoZSBTU1IgTGFtYmRhLlxuICAgKi9cbiAgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExlZ2FjeSBhbGlhcyBmb3IgYGlzck1ldGFkYXRhVGFibGVOYW1lYC5cbiAgICogQGRlcHJlY2F0ZWQgcHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCBvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgXG4gICAqL1xuICByZWFkb25seSBjYWNoZVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvLyBXaGVuIHRydWUgKGRlZmF1bHQpLCBBcHBUaGVvcnkgd2lyZXMgcmVjb21tZW5kZWQgcnVudGltZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgb250byB0aGUgU1NSIGZ1bmN0aW9uLlxuICByZWFkb25seSB3aXJlUnVudGltZUVudj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgaGVhZGVycyB0byBmb3J3YXJkIHRvIHRoZSBTU1Igb3JpZ2luIChMYW1iZGEgRnVuY3Rpb24gVVJMKSB2aWEgdGhlIG9yaWdpbiByZXF1ZXN0IHBvbGljeS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5L0ZhY2VUaGVvcnktc2FmZSBlZGdlIGNvbnRyYWN0IGZvcndhcmRzIG9ubHk6XG4gICAqIC0gYGNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvYFxuICAgKiAtIGBjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzYFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWZhY2V0aGVvcnktb3JpZ2luYWwtdXJpYFxuICAgKiAtIGB4LXJlcXVlc3QtaWRgXG4gICAqXG4gICAqIFVzZSB0aGlzIHRvIG9wdCBpbiB0byBhZGRpdGlvbmFsIGFwcC1zcGVjaWZpYyBoZWFkZXJzIHN1Y2ggYXNcbiAgICogYHgtZmFjZXRoZW9yeS1zZWdtZW50YC4gVGVuYW50LWxpa2Ugdmlld2VyIGhlYWRlcnMgYXJlIHJlamVjdGVkIHVubGVzc1xuICAgKiBgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzYCBpcyBleHBsaWNpdGx5IGVuYWJsZWQgYXMgYSBjb21wYXRpYmlsaXR5IG1vZGUuXG4gICAqIGBob3N0YCBhbmQgYHgtZm9yd2FyZGVkLXByb3RvYCBhcmUgcmVqZWN0ZWQgYmVjYXVzZSB0aGV5IGJyZWFrIG9yIGJ5cGFzcyB0aGVcbiAgICogc3VwcG9ydGVkIG9yaWdpbiBtb2RlbC5cbiAgICovXG4gIHJlYWRvbmx5IHNzckZvcndhcmRIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIENvbXBhdGliaWxpdHkgZXNjYXBlIGhhdGNoIGZvciBsZWdhY3kgdmlld2VyLXN1cHBsaWVkIHRlbmFudCBoZWFkZXJzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlIChkZWZhdWx0KSwgQXBwVGhlb3J5IHN0cmlwcyBgeC10ZW5hbnQtaWRgIGF0IHRoZSBlZGdlIGFuZCByZWplY3RzXG4gICAqIHRlbmFudC1saWtlIGVudHJpZXMgaW4gYHNzckZvcndhcmRIZWFkZXJzYCBzbyB2aWV3ZXItc3VwcGxpZWQgdGVuYW50IGhlYWRlcnNcbiAgICogY2Fubm90IGluZmx1ZW5jZSBvcmlnaW4gcm91dGluZyBvciBIVE1MIGNhY2hlIHBhcnRpdGlvbmluZy4gV2hlbiB0cnVlLFxuICAgKiBBcHBUaGVvcnkgcmVzdG9yZXMgbGVnYWN5IHBhc3N0aHJvdWdoIGJlaGF2aW9yIGZvciBgeC10ZW5hbnQtaWRgIGFuZCBhbnlcbiAgICogdGVuYW50LWxpa2UgYHNzckZvcndhcmRIZWFkZXJzYC5cbiAgICpcbiAgICogUHJlZmVyIGRlcml2aW5nIHRlbmFudCBmcm9tIHRydXN0ZWQgaG9zdCBtYXBwaW5nIHVzaW5nIHRoZSBvcmlnaW5hbC1ob3N0XG4gICAqIGVkZ2UgaGVhZGVycyBpbnN0ZWFkIG9mIGVuYWJsaW5nIHBhc3N0aHJvdWdoLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPzogYm9vbGVhbjtcblxuICByZWFkb25seSBlbmFibGVMb2dnaW5nPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgLyoqXG4gICAqIENsb3VkRnJvbnQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgYXBwbGllZCB0byBTU1IgYW5kIGRpcmVjdC1TMyBiZWhhdmlvcnMuXG4gICAqXG4gICAqIElmIG9taXR0ZWQsIEFwcFRoZW9yeSBwcm92aXNpb25zIGEgRmFjZVRoZW9yeS1hbGlnbmVkIGJhc2VsaW5lIHBvbGljeSBhdCB0aGUgQ0ROXG4gICAqIGxheWVyOiBIU1RTLCBub3NuaWZmLCBmcmFtZS1vcHRpb25zLCByZWZlcnJlci1wb2xpY3ksIFhTUyBwcm90ZWN0aW9uLCBhbmQgYVxuICAgKiByZXN0cmljdGl2ZSBwZXJtaXNzaW9ucy1wb2xpY3kuIENvbnRlbnQtU2VjdXJpdHktUG9saWN5IHJlbWFpbnMgb3JpZ2luLWRlZmluZWQuXG4gICAqL1xuICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgLyoqXG4gICAqIENhY2hlIHBvbGljeSBhcHBsaWVkIHRvIGRpcmVjdCBMYW1iZGEtYmFja2VkIFNTUiBiZWhhdmlvcnMuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IGlzIGBDQUNISU5HX0RJU0FCTEVEYCBzbyBkeW5hbWljIExhbWJkYSByb3V0ZXMgc3RheSBzYWZlIHVubGVzcyB5b3VcbiAgICogaW50ZW50aW9uYWxseSBvcHQgaW50byBhIGNhY2hlIHBvbGljeSB0aGF0IG1hdGNoZXMgeW91ciBhcHAncyB2YXJpYW5jZSBtb2RlbC5cbiAgICogQGRlZmF1bHQgY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVEXG4gICAqL1xuICByZWFkb25seSBzc3JDYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gIC8qKlxuICAgKiBDYWNoZSBwb2xpY3kgYXBwbGllZCB0byB0aGUgY2FjaGVhYmxlIEhUTUwgYmVoYXZpb3IgaW4gYHNzZy1pc3JgIG1vZGUuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IEFwcFRoZW9yeSBwb2xpY3kga2V5cyBvbiBxdWVyeSBzdHJpbmdzIHBsdXMgdGhlIHN0YWJsZSBwdWJsaWMgSFRNTFxuICAgKiB2YXJpYW50IGhlYWRlcnMgKGB4LSotb3JpZ2luYWwtaG9zdGAgYW5kIGFueSBub24tdGVuYW50IGV4dHJhIGZvcndhcmRlZFxuICAgKiBoZWFkZXJzIHlvdSBvcHQgaW50bykgd2hpbGUgbGVhdmluZyBjb29raWVzIG91dCBvZiB0aGUgY2FjaGUga2V5LiBUZW5hbnQtbGlrZVxuICAgKiB2aWV3ZXIgaGVhZGVycyBqb2luIHRoZSBjYWNoZSBrZXkgb25seSB3aGVuIGBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNgIGlzXG4gICAqIGV4cGxpY2l0bHkgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IGh0bWxDYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZG9tYWluTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVNzclNpdGVCZWFyZXJGdW5jdGlvblVybE9yaWdpbiB7XG4gIC8qKlxuICAgKiBMYW1iZGEgZnVuY3Rpb24gdGhhdCBBcHBUaGVvcnkgZXhwb3NlcyBhcyBhIGJlYXJlci1hdXRoIEZ1bmN0aW9uIFVSTCBjby1vcmlnaW4uXG4gICAqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIHRoZSBGdW5jdGlvbiBVUkwgd2l0aCBgbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuTk9ORWA7IGF1dGhlbnRpY2F0aW9uIHJlbWFpbnNcbiAgICogdGhlIHJlc3BvbnNpYmlsaXR5IG9mIHRoZSBMYW1iZGEgaGFuZGxlci5cbiAgICovXG4gIHJlYWRvbmx5IGZ1bmN0aW9uOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBDbG91ZEZyb250IHBhdGggcGF0dGVybnMgdGhhdCByb3V0ZSB0byB0aGlzIGNvLW9yaWdpbi5cbiAgICpcbiAgICogUGF0dGVybnMgYXJlIG5vcm1hbGl6ZWQgdGhlIHNhbWUgd2F5IGFzIGBzc3JQYXRoUGF0dGVybnNgLiBBIHBhdHRlcm4gZW5kaW5nIGluIGAvKmAgYWxzbyBjcmVhdGVzXG4gICAqIGEgcm9vdCBiZWhhdmlvciB3aXRob3V0IHRoZSB3aWxkY2FyZCBzbyBgL2FwaS8qYCBjb3ZlcnMgYm90aCBgL2FwaWAgYW5kIGAvYXBpLy4uLmAuXG4gICAqL1xuICByZWFkb25seSBwYXRoUGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGludm9rZSBtb2RlIGZvciB0aGlzIGNvLW9yaWdpbi5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkludm9rZU1vZGUuQlVGRkVSRURcbiAgICovXG4gIHJlYWRvbmx5IGludm9rZU1vZGU/OiBsYW1iZGEuSW52b2tlTW9kZTtcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVNzclNpdGUgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzQnVja2V0OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleTogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaHRtbFN0b3JlQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IHNzclVybDogbGFtYmRhLkZ1bmN0aW9uVXJsO1xuICBwdWJsaWMgcmVhZG9ubHkgYmVhcmVyRnVuY3Rpb25VcmxzOiBsYW1iZGEuRnVuY3Rpb25VcmxbXTtcbiAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG4gIHB1YmxpYyByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG4gIHB1YmxpYyByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k6IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5U3NyU2l0ZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmICghcHJvcHM/LnNzckZ1bmN0aW9uKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIHByb3BzLnNzckZ1bmN0aW9uXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IHNpdGVNb2RlID0gcHJvcHMubW9kZSA/PyBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU1JfT05MWTtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCBhdXRvRGVsZXRlT2JqZWN0cyA9IHByb3BzLmF1dG9EZWxldGVPYmplY3RzID8/IGZhbHNlO1xuICAgIGNvbnN0IHdpcmVSdW50aW1lRW52ID0gcHJvcHMud2lyZVJ1bnRpbWVFbnYgPz8gdHJ1ZTtcblxuICAgIHRoaXMuYXNzZXRzQnVja2V0ID1cbiAgICAgIHByb3BzLmFzc2V0c0J1Y2tldCA/P1xuICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkFzc2V0c0J1Y2tldFwiLCB7XG4gICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICB9KTtcblxuICAgIGNvbnN0IGVuYWJsZUxvZ2dpbmcgPSBwcm9wcy5lbmFibGVMb2dnaW5nID8/IHRydWU7XG4gICAgaWYgKGVuYWJsZUxvZ2dpbmcpIHtcbiAgICAgIHRoaXMubG9nc0J1Y2tldCA9XG4gICAgICAgIHByb3BzLmxvZ3NCdWNrZXQgPz9cbiAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkNsb3VkRnJvbnRMb2dzQnVja2V0XCIsIHtcbiAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuT0JKRUNUX1dSSVRFUixcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3QgYXNzZXRzUHJlZml4UmF3ID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcocHJvcHMuYXNzZXRzS2V5UHJlZml4ID8/IFwiYXNzZXRzXCIpLnRyaW0oKSwgXCIvXCIpO1xuICAgIGNvbnN0IGFzc2V0c0tleVByZWZpeCA9IGFzc2V0c1ByZWZpeFJhdyB8fCBcImFzc2V0c1wiO1xuXG4gICAgY29uc3QgbWFuaWZlc3RSYXcgPSBTdHJpbmcocHJvcHMuYXNzZXRzTWFuaWZlc3RLZXkgPz8gYCR7YXNzZXRzS2V5UHJlZml4fS9tYW5pZmVzdC5qc29uYCkudHJpbSgpO1xuICAgIGNvbnN0IG1hbmlmZXN0S2V5ID0gdHJpbVJlcGVhdGVkQ2hhcihtYW5pZmVzdFJhdywgXCIvXCIpO1xuICAgIGNvbnN0IGFzc2V0c01hbmlmZXN0S2V5ID0gbWFuaWZlc3RLZXkgfHwgYCR7YXNzZXRzS2V5UHJlZml4fS9tYW5pZmVzdC5qc29uYDtcblxuICAgIHRoaXMuYXNzZXRzS2V5UHJlZml4ID0gYXNzZXRzS2V5UHJlZml4O1xuICAgIHRoaXMuYXNzZXRzTWFuaWZlc3RLZXkgPSBhc3NldHNNYW5pZmVzdEtleTtcblxuICAgIGNvbnN0IGh0bWxTdG9yZUtleVByZWZpeElucHV0ID0gU3RyaW5nKHByb3BzLmh0bWxTdG9yZUtleVByZWZpeCA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3Qgc2hvdWxkQ29uZmlndXJlSHRtbFN0b3JlID0gQm9vbGVhbihwcm9wcy5odG1sU3RvcmVCdWNrZXQpIHx8IGh0bWxTdG9yZUtleVByZWZpeElucHV0Lmxlbmd0aCA+IDA7XG4gICAgaWYgKHNob3VsZENvbmZpZ3VyZUh0bWxTdG9yZSkge1xuICAgICAgY29uc3QgaHRtbFN0b3JlUHJlZml4UmF3ID0gdHJpbVJlcGVhdGVkQ2hhcihcbiAgICAgICAgU3RyaW5nKHByb3BzLmh0bWxTdG9yZUtleVByZWZpeCA/PyBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4KS50cmltKCksXG4gICAgICAgIFwiL1wiLFxuICAgICAgKTtcbiAgICAgIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4ID0gaHRtbFN0b3JlUHJlZml4UmF3IHx8IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXg7XG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldCA9XG4gICAgICAgIHByb3BzLmh0bWxTdG9yZUJ1Y2tldCA/P1xuICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiSHRtbFN0b3JlQnVja2V0XCIsIHtcbiAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHRoaXMuaXNyTWV0YWRhdGFUYWJsZSA9IHByb3BzLmlzck1ldGFkYXRhVGFibGU7XG5cbiAgICBjb25zdCBleHBsaWNpdElzck1ldGFkYXRhVGFibGVOYW1lID0gU3RyaW5nKHByb3BzLmlzck1ldGFkYXRhVGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBsZWdhY3lDYWNoZVRhYmxlTmFtZSA9IFN0cmluZyhwcm9wcy5jYWNoZVRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgcmVzb3VyY2VJc3JNZXRhZGF0YVRhYmxlTmFtZSA9IFN0cmluZyh0aGlzLmlzck1ldGFkYXRhVGFibGU/LnRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG5cbiAgICBjb25zdCBjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIFtyZXNvdXJjZUlzck1ldGFkYXRhVGFibGVOYW1lLCBleHBsaWNpdElzck1ldGFkYXRhVGFibGVOYW1lLCBsZWdhY3lDYWNoZVRhYmxlTmFtZV0uZmlsdGVyKFxuICAgICAgICAgIChuYW1lKSA9PiBTdHJpbmcobmFtZSkudHJpbSgpLmxlbmd0aCA+IDAsXG4gICAgICAgICksXG4gICAgICApLFxuICAgICk7XG5cbiAgICBpZiAoY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcy5sZW5ndGggPiAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIHJlY2VpdmVkIGNvbmZsaWN0aW5nIElTUiBtZXRhZGF0YSB0YWJsZSBuYW1lczogJHtjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBpc3JNZXRhZGF0YVRhYmxlTmFtZSA9IGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXNbMF0gPz8gXCJcIjtcblxuICAgIGlmIChwcm9wcy5hc3NldHNQYXRoKSB7XG4gICAgICBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCBcIkFzc2V0c0RlcGxveW1lbnRcIiwge1xuICAgICAgICBzb3VyY2VzOiBbczNkZXBsb3kuU291cmNlLmFzc2V0KHByb3BzLmFzc2V0c1BhdGgpXSxcbiAgICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IHRoaXMuYXNzZXRzQnVja2V0LFxuICAgICAgICBkZXN0aW5hdGlvbktleVByZWZpeDogYXNzZXRzS2V5UHJlZml4LFxuICAgICAgICBwcnVuZTogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YXRpY1BhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhwcm9wcy5zdGF0aWNQYXRoUGF0dGVybnMpO1xuICAgIGNvbnN0IGRpcmVjdFMzUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKFtcbiAgICAgIC4uLihzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IFtzc2dJc3JIeWRyYXRpb25QYXRoUGF0dGVybl0gOiBbXSksXG4gICAgICAuLi4oQXJyYXkuaXNBcnJheShwcm9wcy5kaXJlY3RTM1BhdGhQYXR0ZXJucykgPyBwcm9wcy5kaXJlY3RTM1BhdGhQYXR0ZXJucyA6IFtdKSxcbiAgICBdKTtcbiAgICBjb25zdCBzc3JQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMoW1xuICAgICAgLi4uKHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gW3NzZ0lzclNzckRhdGFQYXRoUGF0dGVybl0gOiBbXSksXG4gICAgICAuLi4oQXJyYXkuaXNBcnJheShwcm9wcy5zc3JQYXRoUGF0dGVybnMpID8gcHJvcHMuc3NyUGF0aFBhdHRlcm5zIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucyA9IEFycmF5LmlzQXJyYXkocHJvcHMuYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zKVxuICAgICAgPyBwcm9wcy5iZWFyZXJGdW5jdGlvblVybE9yaWdpbnNcbiAgICAgIDogW107XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzID0gYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zLm1hcCgob3JpZ2luLCBpbmRleCkgPT4ge1xuICAgICAgaWYgKCFvcmlnaW4/LmZ1bmN0aW9uKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5U3NyU2l0ZSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnNbJHtpbmRleH1dIHJlcXVpcmVzIGZ1bmN0aW9uYCk7XG4gICAgICB9XG4gICAgICBjb25zdCBwYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMob3JpZ2luLnBhdGhQYXR0ZXJucyk7XG4gICAgICBpZiAocGF0aFBhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zWyR7aW5kZXh9XSByZXF1aXJlcyBhdCBsZWFzdCBvbmUgcGF0aCBwYXR0ZXJuYCk7XG4gICAgICB9XG4gICAgICByZXR1cm4geyBvcmlnaW4sIHBhdGhQYXR0ZXJucyB9O1xuICAgIH0pO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsUGF0aFBhdHRlcm5zID0gYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmZsYXRNYXAoKGNvbmZpZykgPT4gY29uZmlnLnBhdGhQYXR0ZXJucyk7XG4gICAgY29uc3QgYmVoYXZpb3JQYXR0ZXJuT3duZXJzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBjb25zdCBiZWhhdmlvclBhdHRlcm5zOiBTZWVuQmVoYXZpb3JQYXR0ZXJuW10gPSBbXTtcbiAgICBjb25zdCBzc3JVcmxBdXRoVHlwZSA9IHByb3BzLnNzclVybEF1dGhUeXBlID8/IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU07XG4gICAgY29uc3QgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzID0gcHJvcHMuYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzID8/IGZhbHNlO1xuXG4gICAgdGhpcy5zc3JVcmwgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uVXJsKHRoaXMsIFwiU3NyVXJsXCIsIHtcbiAgICAgIGZ1bmN0aW9uOiBwcm9wcy5zc3JGdW5jdGlvbixcbiAgICAgIGF1dGhUeXBlOiBzc3JVcmxBdXRoVHlwZSxcbiAgICAgIGludm9rZU1vZGU6IHByb3BzLmludm9rZU1vZGUgPz8gbGFtYmRhLkludm9rZU1vZGUuUkVTUE9OU0VfU1RSRUFNLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3NyT3JpZ2luID1cbiAgICAgIHNzclVybEF1dGhUeXBlID09PSBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNXG4gICAgICAgID8gb3JpZ2lucy5GdW5jdGlvblVybE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCh0aGlzLnNzclVybClcbiAgICAgICAgOiBuZXcgb3JpZ2lucy5GdW5jdGlvblVybE9yaWdpbih0aGlzLnNzclVybCk7XG5cbiAgICBjb25zdCBhc3NldHNPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuYXNzZXRzQnVja2V0KTtcbiAgICBjb25zdCBodG1sT3JpZ2luQnVja2V0ID0gdGhpcy5odG1sU3RvcmVCdWNrZXQgPz8gdGhpcy5hc3NldHNCdWNrZXQ7XG4gICAgY29uc3QgaHRtbE9yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2woXG4gICAgICBodG1sT3JpZ2luQnVja2V0LFxuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQgJiYgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXhcbiAgICAgICAgPyB7XG4gICAgICAgICAgICBvcmlnaW5QYXRoOiBgLyR7dGhpcy5odG1sU3RvcmVLZXlQcmVmaXh9YCxcbiAgICAgICAgICB9XG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgICk7XG5cbiAgICBjb25zdCBiYXNlU3NyRm9yd2FyZEhlYWRlcnMgPSBbXG4gICAgICBcImNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvXCIsXG4gICAgICBcImNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NcIixcbiAgICAgIC4uLnNzck9yaWdpbmFsSG9zdEhlYWRlcnMsXG4gICAgICAuLi5zc3JPcmlnaW5hbFVyaUhlYWRlcnMsXG4gICAgICBcIngtcmVxdWVzdC1pZFwiLFxuICAgIF07XG5cbiAgICBjb25zdCBkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMgPSBuZXcgU2V0KFtcImhvc3RcIiwgXCJ4LWZvcndhcmRlZC1wcm90b1wiXSk7XG5cbiAgICBjb25zdCBleHRyYVNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuaXNBcnJheShwcm9wcy5zc3JGb3J3YXJkSGVhZGVycylcbiAgICAgID8gcHJvcHMuc3NyRm9yd2FyZEhlYWRlcnMubWFwKGNhbm9uaWNhbGl6ZUhlYWRlck5hbWUpLmZpbHRlcigoaGVhZGVyKSA9PiBoZWFkZXIubGVuZ3RoID4gMClcbiAgICAgIDogW107XG5cbiAgICBjb25zdCByZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChleHRyYVNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiBkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuaGFzKGhlYWRlcikpKSxcbiAgICApLnNvcnQoKTtcblxuICAgIGlmIChyZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBkaXNhbGxvd3Mgc3NyRm9yd2FyZEhlYWRlcnM6ICR7cmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+IGlzVGVuYW50SGVhZGVyTmFtZShoZWFkZXIpKSksXG4gICAgKS5zb3J0KCk7XG5cbiAgICBpZiAocmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMubGVuZ3RoID4gMCAmJiAhYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIGFsbG93Vmlld2VyVGVuYW50SGVhZGVycz10cnVlIGZvciB0ZW5hbnQtbGlrZSBzc3JGb3J3YXJkSGVhZGVyczogJHtyZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVycy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdGVuYW50UGFzc3Rocm91Z2hIZWFkZXJzID0gYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzXG4gICAgICA/IEFycmF5LmZyb20obmV3IFNldChbZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciwgLi4ucmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnNdKSlcbiAgICAgIDogW107XG4gICAgY29uc3QgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMgPSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNcbiAgICAgID8gW11cbiAgICAgIDogQXJyYXkuZnJvbShuZXcgU2V0KFtkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyLCAuLi5yZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVyc10pKS5zb3J0KCk7XG5cbiAgICBjb25zdCBzc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbLi4uYmFzZVNzckZvcndhcmRIZWFkZXJzLCAuLi50ZW5hbnRQYXNzdGhyb3VnaEhlYWRlcnMsIC4uLmV4dHJhU3NyRm9yd2FyZEhlYWRlcnNdLmZpbHRlcihcbiAgICAgICAgICAoaGVhZGVyKSA9PiAhZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmhhcyhoZWFkZXIpLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICApO1xuICAgIGNvbnN0IGh0bWxDYWNoZUtleUV4Y2x1ZGVkSGVhZGVycyA9IG5ldyBTZXQoW1xuICAgICAgXCJjbG91ZGZyb250LWZvcndhcmRlZC1wcm90b1wiLFxuICAgICAgXCJjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzXCIsXG4gICAgICAuLi5zc3JPcmlnaW5hbFVyaUhlYWRlcnMsXG4gICAgICBcIngtcmVxdWVzdC1pZFwiLFxuICAgIF0pO1xuICAgIGNvbnN0IGh0bWxDYWNoZUtleUhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChzc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gIWh0bWxDYWNoZUtleUV4Y2x1ZGVkSGVhZGVycy5oYXMoaGVhZGVyKSkpLFxuICAgICk7XG5cbiAgICBpZiAoIXByb3BzLmh0bWxDYWNoZVBvbGljeSAmJiBodG1sQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aCA+IG1heERlZmF1bHRDYWNoZUtleUhlYWRlcnMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgZGVmYXVsdCBodG1sQ2FjaGVQb2xpY3kgc3VwcG9ydHMgYXQgbW9zdCAke21heERlZmF1bHRDYWNoZUtleUhlYWRlcnN9IGNhY2hlLWtleSBoZWFkZXJzOyByZWNlaXZlZCAke2h0bWxDYWNoZUtleUhlYWRlcnMubGVuZ3RofWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHNzck9yaWdpblJlcXVlc3RQb2xpY3kgPSBuZXcgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5KHRoaXMsIFwiU3NyT3JpZ2luUmVxdWVzdFBvbGljeVwiLCB7XG4gICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLmFsbCgpLFxuICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5zc3JGb3J3YXJkSGVhZGVycyksXG4gICAgfSk7XG4gICAgY29uc3QgaHRtbE9yaWdpblJlcXVlc3RQb2xpY3kgPSBuZXcgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5KHRoaXMsIFwiSHRtbE9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLnNzckZvcndhcmRIZWFkZXJzKSxcbiAgICB9KTtcbiAgICBjb25zdCBzc3JDYWNoZVBvbGljeSA9IHByb3BzLnNzckNhY2hlUG9saWN5ID8/IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRDtcbiAgICBjb25zdCBodG1sQ2FjaGVQb2xpY3kgPVxuICAgICAgcHJvcHMuaHRtbENhY2hlUG9saWN5ID8/XG4gICAgICBuZXcgY2xvdWRmcm9udC5DYWNoZVBvbGljeSh0aGlzLCBcIkh0bWxDYWNoZVBvbGljeVwiLCB7XG4gICAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSBIVE1MIGNhY2hlIHBvbGljeSBrZXllZCBieSBxdWVyeSBzdHJpbmdzIGFuZCBzdGFibGUgcHVibGljIHZhcmlhbnQgaGVhZGVyc1wiLFxuICAgICAgICBtaW5UdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgIGRlZmF1bHRUdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgIG1heFR0bDogRHVyYXRpb24uZGF5cygzNjUpLFxuICAgICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUNvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uaHRtbENhY2hlS2V5SGVhZGVycyksXG4gICAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgICBlbmFibGVBY2NlcHRFbmNvZGluZ0Jyb3RsaTogdHJ1ZSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdHemlwOiB0cnVlLFxuICAgICAgfSk7XG5cbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgICAgIFwiZGlyZWN0IFMzIHBhdGhzXCIsXG4gICAgICBbYCR7YXNzZXRzS2V5UHJlZml4fS8qYCwgLi4uZGlyZWN0UzNQYXRoUGF0dGVybnNdLFxuICAgICAgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLFxuICAgICAgYmVoYXZpb3JQYXR0ZXJucyxcbiAgICApO1xuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFwic3RhdGljIEhUTUwgcGF0aHNcIiwgc3RhdGljUGF0aFBhdHRlcm5zLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMsIGJlaGF2aW9yUGF0dGVybnMpO1xuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFwiZGlyZWN0IFNTUiBwYXRoc1wiLCBzc3JQYXRoUGF0dGVybnMsIGJlaGF2aW9yUGF0dGVybk93bmVycywgYmVoYXZpb3JQYXR0ZXJucyk7XG4gICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmZvckVhY2goKGNvbmZpZywgaW5kZXgpID0+IHtcbiAgICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFxuICAgICAgICBgYmVhcmVyIEZ1bmN0aW9uIFVSTCBjby1vcmlnaW4gJHtpbmRleCArIDF9YCxcbiAgICAgICAgY29uZmlnLnBhdGhQYXR0ZXJucyxcbiAgICAgICAgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLFxuICAgICAgICBiZWhhdmlvclBhdHRlcm5zLFxuICAgICAgKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IHZpZXdlclJlcXVlc3RGdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LkZ1bmN0aW9uKHRoaXMsIFwiU3NyVmlld2VyUmVxdWVzdEZ1bmN0aW9uXCIsIHtcbiAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoXG4gICAgICAgIGdlbmVyYXRlU3NyVmlld2VyUmVxdWVzdEZ1bmN0aW9uQ29kZShcbiAgICAgICAgICBzaXRlTW9kZSxcbiAgICAgICAgICBbYCR7YXNzZXRzS2V5UHJlZml4fS8qYCwgLi4uZGlyZWN0UzNQYXRoUGF0dGVybnNdLFxuICAgICAgICAgIFsuLi5zc3JQYXRoUGF0dGVybnMsIC4uLmJlYXJlckZ1bmN0aW9uVXJsUGF0aFBhdHRlcm5zXSxcbiAgICAgICAgICBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgICBydW50aW1lOiBjbG91ZGZyb250LkZ1bmN0aW9uUnVudGltZS5KU18yXzAsXG4gICAgICBjb21tZW50OlxuICAgICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICAgID8gXCJGYWNlVGhlb3J5IHZpZXdlci1yZXF1ZXN0IGVkZ2UgY29udGV4dCBhbmQgSFRNTCByZXdyaXRlIGZvciBTU1Igc2l0ZVwiXG4gICAgICAgICAgOiBcIkZhY2VUaGVvcnkgdmlld2VyLXJlcXVlc3QgZWRnZSBjb250ZXh0IGZvciBTU1Igc2l0ZVwiLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgdmlld2VyUmVzcG9uc2VGdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LkZ1bmN0aW9uKHRoaXMsIFwiU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvblwiLCB7XG4gICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKGdlbmVyYXRlU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvbkNvZGUoKSksXG4gICAgICBydW50aW1lOiBjbG91ZGZyb250LkZ1bmN0aW9uUnVudGltZS5KU18yXzAsXG4gICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgdmlld2VyLXJlc3BvbnNlIHJlcXVlc3QtaWQgZWNobyBmb3IgU1NSIHNpdGVcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucyA9ICgpOiBjbG91ZGZyb250LkZ1bmN0aW9uQXNzb2NpYXRpb25bXSA9PiBbXG4gICAgICB7XG4gICAgICAgIGZ1bmN0aW9uOiB2aWV3ZXJSZXF1ZXN0RnVuY3Rpb24sXG4gICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVRVUVTVCxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGZ1bmN0aW9uOiB2aWV3ZXJSZXNwb25zZUZ1bmN0aW9uLFxuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFU1BPTlNFLFxuICAgICAgfSxcbiAgICBdO1xuXG4gICAgY29uc3QgZG9tYWluTmFtZSA9IFN0cmluZyhwcm9wcy5kb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKTtcblxuICAgIGxldCBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuXG4gICAgaWYgKGRvbWFpbk5hbWUpIHtcbiAgICAgIGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzID0gW2RvbWFpbk5hbWVdO1xuICAgICAgY29uc3QgY2VydEFybiA9IFN0cmluZyhwcm9wcy5jZXJ0aWZpY2F0ZUFybiA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoY2VydEFybikge1xuICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCBjZXJ0QXJuKTtcbiAgICAgIH0gZWxzZSBpZiAocHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IG5ldyBhY20uRG5zVmFsaWRhdGVkQ2VydGlmaWNhdGUodGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCB7XG4gICAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgICAgICBob3N0ZWRab25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICAgIHJlZ2lvbjogXCJ1cy1lYXN0LTFcIixcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIHByb3BzLmNlcnRpZmljYXRlQXJuIG9yIHByb3BzLmhvc3RlZFpvbmUgd2hlbiBwcm9wcy5kb21haW5OYW1lIGlzIHNldFwiKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA9XG4gICAgICBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgIG5ldyBjbG91ZGZyb250LlJlc3BvbnNlSGVhZGVyc1BvbGljeSh0aGlzLCBcIlJlc3BvbnNlSGVhZGVyc1BvbGljeVwiLCB7XG4gICAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSBiYXNlbGluZSBzZWN1cml0eSBoZWFkZXJzIChDU1Agc3RheXMgb3JpZ2luLWRlZmluZWQpXCIsXG4gICAgICAgIHNlY3VyaXR5SGVhZGVyc0JlaGF2aW9yOiB7XG4gICAgICAgICAgc3RyaWN0VHJhbnNwb3J0U2VjdXJpdHk6IHtcbiAgICAgICAgICAgIGFjY2Vzc0NvbnRyb2xNYXhBZ2U6IER1cmF0aW9uLmRheXMoMzY1ICogMiksXG4gICAgICAgICAgICBpbmNsdWRlU3ViZG9tYWluczogdHJ1ZSxcbiAgICAgICAgICAgIHByZWxvYWQ6IHRydWUsXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGNvbnRlbnRUeXBlT3B0aW9uczogeyBvdmVycmlkZTogdHJ1ZSB9LFxuICAgICAgICAgIGZyYW1lT3B0aW9uczoge1xuICAgICAgICAgICAgZnJhbWVPcHRpb246IGNsb3VkZnJvbnQuSGVhZGVyc0ZyYW1lT3B0aW9uLkRFTlksXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHJlZmVycmVyUG9saWN5OiB7XG4gICAgICAgICAgICByZWZlcnJlclBvbGljeTogY2xvdWRmcm9udC5IZWFkZXJzUmVmZXJyZXJQb2xpY3kuU1RSSUNUX09SSUdJTl9XSEVOX0NST1NTX09SSUdJTixcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgeHNzUHJvdGVjdGlvbjoge1xuICAgICAgICAgICAgcHJvdGVjdGlvbjogdHJ1ZSxcbiAgICAgICAgICAgIG1vZGVCbG9jazogdHJ1ZSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGN1c3RvbUhlYWRlcnNCZWhhdmlvcjoge1xuICAgICAgICAgIGN1c3RvbUhlYWRlcnM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgaGVhZGVyOiBcInBlcm1pc3Npb25zLXBvbGljeVwiLFxuICAgICAgICAgICAgICB2YWx1ZTogXCJjYW1lcmE9KCksIG1pY3JvcGhvbmU9KCksIGdlb2xvY2F0aW9uPSgpXCIsXG4gICAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVTdGF0aWNCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBhc3NldHNPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5VU0VfT1JJR0lOX0NBQ0hFX0NPTlRST0xfSEVBREVSUyxcbiAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcbiAgICBjb25zdCBjcmVhdGVTdGF0aWNIdG1sQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogaHRtbE9yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgIGNhY2hlUG9saWN5OiBodG1sQ2FjaGVQb2xpY3ksXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcbiAgICBjb25zdCBjcmVhdGVTc3JCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBzc3JPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgIGNhY2hlUG9saWN5OiBzc3JDYWNoZVBvbGljeSxcbiAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IHNzck9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYWRkaXRpb25hbEJlaGF2aW9yczogUmVjb3JkPHN0cmluZywgY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnM+ID0ge307XG4gICAgY29uc3QgYWRkRXhwYW5kZWRCZWhhdmlvciA9IChwYXR0ZXJuczogc3RyaW5nW10sIGZhY3Rvcnk6ICgpID0+IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zKTogdm9pZCA9PiB7XG4gICAgICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnMpKSB7XG4gICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbcGF0dGVybl0gPSBmYWN0b3J5KCk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoW2Ake2Fzc2V0c0tleVByZWZpeH0vKmBdLCBjcmVhdGVTdGF0aWNCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihkaXJlY3RTM1BhdGhQYXR0ZXJucywgY3JlYXRlU3RhdGljQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3Ioc3RhdGljUGF0aFBhdHRlcm5zLCBjcmVhdGVTdGF0aWNIdG1sQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3Ioc3NyUGF0aFBhdHRlcm5zLCBjcmVhdGVTc3JCZWhhdmlvcik7XG4gICAgdGhpcy5iZWFyZXJGdW5jdGlvblVybHMgPSBbXTtcbiAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZm9yRWFjaCgoY29uZmlnLCBpbmRleCkgPT4ge1xuICAgICAgY29uc3QgZnVuY3Rpb25VcmwgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uVXJsKHRoaXMsIGBCZWFyZXJGdW5jdGlvblVybCR7aW5kZXggKyAxfWAsIHtcbiAgICAgICAgZnVuY3Rpb246IGNvbmZpZy5vcmlnaW4uZnVuY3Rpb24sXG4gICAgICAgIGF1dGhUeXBlOiBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5OT05FLFxuICAgICAgICBpbnZva2VNb2RlOiBjb25maWcub3JpZ2luLmludm9rZU1vZGUgPz8gbGFtYmRhLkludm9rZU1vZGUuQlVGRkVSRUQsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuYmVhcmVyRnVuY3Rpb25VcmxzLnB1c2goZnVuY3Rpb25VcmwpO1xuICAgICAgY29uc3QgZnVuY3Rpb25VcmxPcmlnaW4gPSBuZXcgb3JpZ2lucy5GdW5jdGlvblVybE9yaWdpbihmdW5jdGlvblVybCk7XG4gICAgICBjb25zdCBjcmVhdGVCZWFyZXJGdW5jdGlvblVybEJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICAgIG9yaWdpbjogZnVuY3Rpb25VcmxPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeS5BTExfVklFV0VSX0VYQ0VQVF9IT1NUX0hFQURFUixcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgICAgfSk7XG4gICAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKGNvbmZpZy5wYXRoUGF0dGVybnMsIGNyZWF0ZUJlYXJlckZ1bmN0aW9uVXJsQmVoYXZpb3IpO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZGVmYXVsdE9yaWdpbiA9XG4gICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICA/IG5ldyBvcmlnaW5zLk9yaWdpbkdyb3VwKHtcbiAgICAgICAgICAgIHByaW1hcnlPcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICAgICAgICBmYWxsYmFja09yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgICAgICAgZmFsbGJhY2tTdGF0dXNDb2RlczogWzQwMywgNDA0XSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IHNzck9yaWdpbjtcbiAgICBjb25zdCBkZWZhdWx0QWxsb3dlZE1ldGhvZHMgPVxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgPyBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlNcbiAgICAgICAgOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTDtcblxuICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICA/IHsgZW5hYmxlTG9nZ2luZzogdHJ1ZSwgbG9nQnVja2V0OiB0aGlzLmxvZ3NCdWNrZXQsIGxvZ0ZpbGVQcmVmaXg6IFwiY2xvdWRmcm9udC9cIiB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgIDoge30pLFxuICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgIG9yaWdpbjogZGVmYXVsdE9yaWdpbixcbiAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgIGFsbG93ZWRNZXRob2RzOiBkZWZhdWx0QWxsb3dlZE1ldGhvZHMsXG4gICAgICAgIGNhY2hlUG9saWN5OiBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IGh0bWxDYWNoZVBvbGljeSA6IHNzckNhY2hlUG9saWN5LFxuICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5IDogc3NyT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnMsXG4gICAgICAuLi4ocHJvcHMud2ViQWNsSWQgPyB7IHdlYkFjbElkOiBwcm9wcy53ZWJBY2xJZCB9IDoge30pLFxuICAgIH0pO1xuXG4gICAgaWYgKHNzclVybEF1dGhUeXBlID09PSBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNKSB7XG4gICAgICBwcm9wcy5zc3JGdW5jdGlvbi5hZGRQZXJtaXNzaW9uKFwiQWxsb3dDbG91ZEZyb250SW52b2tlRnVuY3Rpb25WaWFVcmxcIiwge1xuICAgICAgICBhY3Rpb246IFwibGFtYmRhOkludm9rZUZ1bmN0aW9uXCIsXG4gICAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiY2xvdWRmcm9udC5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgICBzb3VyY2VBcm46IHRoaXMuZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkFybixcbiAgICAgICAgaW52b2tlZFZpYUZ1bmN0aW9uVXJsOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0KSB7XG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldC5ncmFudFJlYWRXcml0ZShwcm9wcy5zc3JGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaXNyTWV0YWRhdGFUYWJsZSkge1xuICAgICAgdGhpcy5pc3JNZXRhZGF0YVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5zc3JGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHdpcmVSdW50aW1lRW52KSB7XG4gICAgICB0aGlzLmFzc2V0c0J1Y2tldC5ncmFudFJlYWQocHJvcHMuc3NyRnVuY3Rpb24pO1xuXG4gICAgICBjb25zdCBzc3JGdW5jdGlvbkFueSA9IHByb3BzLnNzckZ1bmN0aW9uIGFzIGFueTtcbiAgICAgIGlmICh0eXBlb2Ygc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlTc3JTaXRlIHdpcmVSdW50aW1lRW52IHJlcXVpcmVzIHByb3BzLnNzckZ1bmN0aW9uIHRvIHN1cHBvcnQgYWRkRW52aXJvbm1lbnQ7IHBhc3MgYSBsYW1iZGEuRnVuY3Rpb24gb3Igc2V0IHdpcmVSdW50aW1lRW52PWZhbHNlIGFuZCBzZXQgZW52IHZhcnMgbWFudWFsbHlcIixcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQVNTRVRTX0JVQ0tFVFwiLCB0aGlzLmFzc2V0c0J1Y2tldC5idWNrZXROYW1lKTtcbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19QUkVGSVhcIiwgYXNzZXRzS2V5UHJlZml4KTtcbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19NQU5JRkVTVF9LRVlcIiwgYXNzZXRzTWFuaWZlc3RLZXkpO1xuXG4gICAgICBpZiAodGhpcy5odG1sU3RvcmVCdWNrZXQgJiYgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXgpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0lTUl9CVUNLRVRcIiwgdGhpcy5odG1sU3RvcmVCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfUFJFRklYXCIsIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KTtcbiAgICAgIH1cbiAgICAgIGlmIChpc3JNZXRhZGF0YVRhYmxlTmFtZSkge1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0NBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBkb21haW5OYW1lLFxuICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgfVxufVxuIl19