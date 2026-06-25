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
function assertCloudFrontHostedZoneCertificateRegion(scope) {
    const region = aws_cdk_lib_1.Stack.of(scope).region;
    if (!aws_cdk_lib_1.Token.isUnresolved(region) && region === "us-east-1") {
        return;
    }
    const regionDescription = aws_cdk_lib_1.Token.isUnresolved(region) ? "unresolved" : region;
    throw new Error(`AppTheorySsrSite cannot create a hosted-zone CloudFront certificate unless the stack region is explicitly us-east-1; stack region is ${regionDescription}. Provide props.certificateArn for stacks in other or environment-agnostic regions.`);
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
        const maxBearerFunctionUrlCacheKeyHeaders = 10;
        const bearerFunctionUrlOriginForwardHeaders = Array.from(new Set([...baseSsrForwardHeaders, "content-type"]));
        const isBlockedBearerFunctionUrlCacheKeyHeader = (header) => header === "host" ||
            header === "forwarded" ||
            header === "x-real-ip" ||
            header.startsWith("x-forwarded-") ||
            isTenantHeaderName(header);
        const bearerFunctionUrlCacheKeyHeaders = Array.from(new Set([
            "authorization",
            "accept",
            "origin",
            "access-control-request-method",
            "access-control-request-headers",
            ...extraSsrForwardHeaders.filter((header) => !isBlockedBearerFunctionUrlCacheKeyHeader(header) &&
                !bearerFunctionUrlOriginForwardHeaders.includes(header)),
        ].filter((header) => header.length > 0)));
        if (!props.htmlCachePolicy && htmlCacheKeyHeaders.length > maxDefaultCacheKeyHeaders) {
            throw new Error(`AppTheorySsrSite default htmlCachePolicy supports at most ${maxDefaultCacheKeyHeaders} cache-key headers; received ${htmlCacheKeyHeaders.length}`);
        }
        if (bearerFunctionUrlOriginConfigs.length > 0 &&
            bearerFunctionUrlCacheKeyHeaders.length > maxBearerFunctionUrlCacheKeyHeaders) {
            throw new Error(`AppTheorySsrSite bearerFunctionUrlOrigins support at most ${maxBearerFunctionUrlCacheKeyHeaders} cache-key forwarded headers; received ${bearerFunctionUrlCacheKeyHeaders.length}`);
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
        const staticAssetsCachePolicy = new cloudfront.CachePolicy(this, "StaticAssetsCachePolicy", {
            comment: "AppTheory direct S3 asset/data cache policy: origin Cache-Control bounded by no viewer header forwarding",
            minTtl: aws_cdk_lib_1.Duration.seconds(0),
            defaultTtl: aws_cdk_lib_1.Duration.days(1),
            maxTtl: aws_cdk_lib_1.Duration.days(365),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            enableAcceptEncodingBrotli: true,
            enableAcceptEncodingGzip: true,
        });
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
        const bearerFunctionUrlOriginRequestPolicy = bearerFunctionUrlOriginConfigs.length > 0
            ? new cloudfront.OriginRequestPolicy(this, "BearerFunctionUrlOriginRequestPolicy", {
                queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
                cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
                headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...bearerFunctionUrlOriginForwardHeaders),
            })
            : undefined;
        const bearerFunctionUrlCachePolicy = bearerFunctionUrlOriginConfigs.length > 0
            ? new cloudfront.CachePolicy(this, "BearerFunctionUrlCachePolicy", {
                comment: "AppTheory bearer Function URL API cache policy: caching disabled while forwarding bearer/CORS app headers",
                minTtl: aws_cdk_lib_1.Duration.seconds(0),
                defaultTtl: aws_cdk_lib_1.Duration.seconds(0),
                maxTtl: aws_cdk_lib_1.Duration.seconds(0),
                cookieBehavior: cloudfront.CacheCookieBehavior.none(),
                headerBehavior: cloudfront.CacheHeaderBehavior.allowList(...bearerFunctionUrlCacheKeyHeaders),
                queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            })
            : undefined;
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
                assertCloudFrontHostedZoneCertificateRegion(this);
                distributionCertificate = new acm.Certificate(this, "Certificate", {
                    domainName,
                    validation: acm.CertificateValidation.fromDns(props.hostedZone),
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
            cachePolicy: staticAssetsCachePolicy,
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
                cachePolicy: bearerFunctionUrlCachePolicy,
                originRequestPolicy: bearerFunctionUrlOriginRequestPolicy,
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
AppTheorySsrSite[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "1.15.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFvRTtBQUNwRSwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUU5RCwyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyREFBMkQ7QUFDM0QseUNBQXlDO0FBQ3pDLDBEQUEwRDtBQUMxRCwyQ0FBdUM7QUFFdkMseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLHlCQUF5QixDQUFDO0FBQzNELE1BQU0sNEJBQTRCLEdBQUcsS0FBSyxDQUFDO0FBQzNDLE1BQU0seUJBQXlCLEdBQUcsRUFBRSxDQUFDO0FBQ3JDLE1BQU0seUJBQXlCLEdBQUcsYUFBYSxDQUFDO0FBRWhELElBQVksb0JBWVg7QUFaRCxXQUFZLG9CQUFvQjtJQUM5Qjs7O09BR0c7SUFDSCw2Q0FBcUIsQ0FBQTtJQUVyQjs7O09BR0c7SUFDSCwyQ0FBbUIsQ0FBQTtBQUNyQixDQUFDLEVBWlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFZL0I7QUFFRCxTQUFTLHNCQUFzQixDQUFDLE9BQWU7SUFDN0MsTUFBTSxVQUFVLEdBQUcsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLENBQUMsT0FBTyxD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QUFjLENBQUMsY0FBYyxDQUFDLHVCQUF1QixFQUFFLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1lBQ2xGLENBQUM7WUFDRCxJQUFJLG9CQUFvQixFQUFFLENBQUM7Z0JBQ3pCLGNBQWMsQ0FBQyxjQUFjLENBQUMsNEJBQTRCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztnQkFDbEYsY0FBYyxDQUFDLGNBQWMsQ0FBQyw2QkFBNkIsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO2dCQUNuRixjQUFjLENBQUMsY0FBYyxDQUFDLGtCQUFrQixFQUFFLG9CQUFvQixDQUFDLENBQUM7Z0JBQ3hFLGNBQWMsQ0FBQyxjQUFjLENBQUMsYUFBYSxFQUFFLG9CQUFvQixDQUFDLENBQUM7WUFDckUsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLFVBQVUsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDbkMsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQ3ZDLElBQUksRUFBRSxLQUFLLENBQUMsVUFBVTtnQkFDdEIsVUFBVSxFQUFFLFVBQVU7Z0JBQ3RCLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7YUFDeEYsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUVILENBQUM7O0FBM2pCSCw0Q0E0akJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnRcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIsIHRyaW1SZXBlYXRlZENoYXJTdGFydCB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5cbmNvbnN0IGFwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW5hbC11cmlcIjtcbmNvbnN0IGZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciA9IFwieC1mYWNldGhlb3J5LW9yaWdpbmFsLXVyaVwiO1xuY29uc3QgYXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW5hbC1ob3N0XCI7XG5jb25zdCBmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyID0gXCJ4LWZhY2V0aGVvcnktb3JpZ2luYWwtaG9zdFwiO1xuY29uc3Qgc3NyT3JpZ2luYWxVcmlIZWFkZXJzID0gW2FwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyLCBmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJdIGFzIGNvbnN0O1xuY29uc3Qgc3NyT3JpZ2luYWxIb3N0SGVhZGVycyA9IFthcHB0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIsIGZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJdIGFzIGNvbnN0O1xuY29uc3Qgc3NnSXNySHlkcmF0aW9uUGF0aFBhdHRlcm4gPSBcIi9fZmFjZXRoZW9yeS9kYXRhLypcIjtcbmNvbnN0IHNzZ0lzclNzckRhdGFQYXRoUGF0dGVybiA9IFwiL19mYWNldGhlb3J5L3Nzci1kYXRhLypcIjtcbmNvbnN0IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXggPSBcImlzclwiO1xuY29uc3QgbWF4RGVmYXVsdENhY2hlS2V5SGVhZGVycyA9IDEwO1xuY29uc3QgZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciA9IFwieC10ZW5hbnQtaWRcIjtcblxuZXhwb3J0IGVudW0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUge1xuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpcyB0aGUgZGVmYXVsdCBvcmlnaW4uIERpcmVjdCBTMyBiZWhhdmlvcnMgYXJlIHVzZWQgb25seSBmb3JcbiAgICogaW1tdXRhYmxlIGFzc2V0cyBhbmQgYW55IGV4cGxpY2l0bHkgY29uZmlndXJlZCBzdGF0aWMgcGF0aCBwYXR0ZXJucy5cbiAgICovXG4gIFNTUl9PTkxZID0gXCJzc3Itb25seVwiLFxuXG4gIC8qKlxuICAgKiBTMyBpcyB0aGUgcHJpbWFyeSBIVE1MIG9yaWdpbiBhbmQgTGFtYmRhIFNTUi9JU1IgaXMgdGhlIGZhbGxiYWNrLiBGYWNlVGhlb3J5IGh5ZHJhdGlvblxuICAgKiBkYXRhIHJvdXRlcyBhcmUga2VwdCBvbiBTMyBhbmQgdGhlIGVkZ2UgcmV3cml0ZXMgZXh0ZW5zaW9ubGVzcyBwYXRocyB0byBgL2luZGV4Lmh0bWxgLlxuICAgKi9cbiAgU1NHX0lTUiA9IFwic3NnLWlzclwiLFxufVxuXG5mdW5jdGlvbiBwYXRoUGF0dGVyblRvVXJpUHJlZml4KHBhdHRlcm46IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSB0cmltUmVwZWF0ZWRDaGFyU3RhcnQoU3RyaW5nKHBhdHRlcm4pLnRyaW0oKSwgXCIvXCIpLnJlcGxhY2UoL1xcL1xcKiQvLCBcIlwiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQgPyBgLyR7bm9ybWFsaXplZH1gIDogXCIvXCI7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBBcnJheS5mcm9tKFxuICAgIG5ldyBTZXQoXG4gICAgICAoQXJyYXkuaXNBcnJheShwYXR0ZXJucykgPyBwYXR0ZXJucyA6IFtdKVxuICAgICAgICAubWFwKChwYXR0ZXJuKSA9PiB0cmltUmVwZWF0ZWRDaGFyU3RhcnQoU3RyaW5nKHBhdHRlcm4pLnRyaW0oKSwgXCIvXCIpKVxuICAgICAgICAuZmlsdGVyKChwYXR0ZXJuKSA9PiBwYXR0ZXJuLmxlbmd0aCA+IDApLFxuICAgICksXG4gICk7XG59XG5cbmZ1bmN0aW9uIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZXhwYW5kZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgcGF0dGVybnMpIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWQpIGNvbnRpbnVlO1xuXG4gICAgZXhwYW5kZWQuYWRkKG5vcm1hbGl6ZWQpO1xuICAgIGlmIChub3JtYWxpemVkLmVuZHNXaXRoKFwiLypcIikpIHtcbiAgICAgIGNvbnN0IHJvb3RQYXR0ZXJuID0gbm9ybWFsaXplZC5zbGljZSgwLCAtMik7XG4gICAgICBpZiAocm9vdFBhdHRlcm4pIHtcbiAgICAgICAgZXhwYW5kZWQuYWRkKHJvb3RQYXR0ZXJuKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gQXJyYXkuZnJvbShleHBhbmRlZCk7XG59XG5cbmludGVyZmFjZSBTZWVuQmVoYXZpb3JQYXR0ZXJuIHtcbiAgcmVhZG9ubHkgcGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBsYWJlbDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUGF0aFBhdHRlcm5UcmFuc2l0aW9uIHtcbiAgcmVhZG9ubHkgdGFyZ2V0OiBudW1iZXI7XG4gIHJlYWRvbmx5IGFueTogYm9vbGVhbjtcbiAgcmVhZG9ubHkgbGl0ZXJhbD86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5FcHNpbG9uQ2xvc3VyZShwYXR0ZXJuOiBzdHJpbmcsIGluZGV4OiBudW1iZXIpOiBudW1iZXJbXSB7XG4gIGNvbnN0IGNsb3N1cmU6IG51bWJlcltdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgY29uc3Qgc3RhY2sgPSBbaW5kZXhdO1xuXG4gIHdoaWxlIChzdGFjay5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY3VycmVudCA9IHN0YWNrLnBvcCgpID8/IDA7XG4gICAgaWYgKHNlZW4uaGFzKGN1cnJlbnQpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgc2Vlbi5hZGQoY3VycmVudCk7XG4gICAgY2xvc3VyZS5wdXNoKGN1cnJlbnQpO1xuXG4gICAgaWYgKHBhdHRlcm5bY3VycmVudF0gPT09IFwiKlwiKSB7XG4gICAgICBzdGFjay5wdXNoKGN1cnJlbnQgKyAxKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gY2xvc3VyZTtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5UcmFuc2l0aW9ucyhwYXR0ZXJuOiBzdHJpbmcsIGluZGV4OiBudW1iZXIpOiBQYXRoUGF0dGVyblRyYW5zaXRpb25bXSB7XG4gIGNvbnN0IHRva2VuID0gcGF0dGVybltpbmRleF07XG4gIGlmICh0b2tlbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgaWYgKHRva2VuID09PSBcIipcIikge1xuICAgIHJldHVybiBbeyB0YXJnZXQ6IGluZGV4LCBhbnk6IHRydWUgfV07XG4gIH1cblxuICBpZiAodG9rZW4gPT09IFwiP1wiKSB7XG4gICAgcmV0dXJuIFt7IHRhcmdldDogaW5kZXggKyAxLCBhbnk6IHRydWUgfV07XG4gIH1cblxuICByZXR1cm4gW3sgdGFyZ2V0OiBpbmRleCArIDEsIGFueTogZmFsc2UsIGxpdGVyYWw6IHRva2VuIH1dO1xufVxuXG5mdW5jdGlvbiBwYXRoUGF0dGVyblRyYW5zaXRpb25zQ2FuU2hhcmVDaGFyYWN0ZXIobGVmdDogUGF0aFBhdHRlcm5UcmFuc2l0aW9uLCByaWdodDogUGF0aFBhdHRlcm5UcmFuc2l0aW9uKTogYm9vbGVhbiB7XG4gIHJldHVybiBsZWZ0LmFueSB8fCByaWdodC5hbnkgfHwgbGVmdC5saXRlcmFsID09PSByaWdodC5saXRlcmFsO1xufVxuXG5mdW5jdGlvbiBwYXRoUGF0dGVybnNDYW5PdmVybGFwKGxlZnQ6IHN0cmluZywgcmlnaHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBzZWVuU3RhdGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHF1ZXVlOiBBcnJheTxbbnVtYmVyLCBudW1iZXJdPiA9IFtdO1xuXG4gIGNvbnN0IGVucXVldWVDbG9zdXJlUGFpcnMgPSAobGVmdEluZGV4OiBudW1iZXIsIHJpZ2h0SW5kZXg6IG51bWJlcik6IHZvaWQgPT4ge1xuICAgIGZvciAoY29uc3QgbGVmdENsb3NlZCBvZiBwYXRoUGF0dGVybkVwc2lsb25DbG9zdXJlKGxlZnQsIGxlZnRJbmRleCkpIHtcbiAgICAgIGZvciAoY29uc3QgcmlnaHRDbG9zZWQgb2YgcGF0aFBhdHRlcm5FcHNpbG9uQ2xvc3VyZShyaWdodCwgcmlnaHRJbmRleCkpIHtcbiAgICAgICAgY29uc3Qga2V5ID0gYCR7bGVmdENsb3NlZH06JHtyaWdodENsb3NlZH1gO1xuICAgICAgICBpZiAoc2VlblN0YXRlcy5oYXMoa2V5KSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIHNlZW5TdGF0ZXMuYWRkKGtleSk7XG4gICAgICAgIHF1ZXVlLnB1c2goW2xlZnRDbG9zZWQsIHJpZ2h0Q2xvc2VkXSk7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIGVucXVldWVDbG9zdXJlUGFpcnMoMCwgMCk7XG5cbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBbbGVmdEluZGV4LCByaWdodEluZGV4XSA9IHF1ZXVlLnNoaWZ0KCkgPz8gWzAsIDBdO1xuICAgIGlmIChsZWZ0SW5kZXggPT09IGxlZnQubGVuZ3RoICYmIHJpZ2h0SW5kZXggPT09IHJpZ2h0Lmxlbmd0aCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBsZWZ0VHJhbnNpdGlvbiBvZiBwYXRoUGF0dGVyblRyYW5zaXRpb25zKGxlZnQsIGxlZnRJbmRleCkpIHtcbiAgICAgIGZvciAoY29uc3QgcmlnaHRUcmFuc2l0aW9uIG9mIHBhdGhQYXR0ZXJuVHJhbnNpdGlvbnMocmlnaHQsIHJpZ2h0SW5kZXgpKSB7XG4gICAgICAgIGlmICghcGF0aFBhdHRlcm5UcmFuc2l0aW9uc0NhblNoYXJlQ2hhcmFjdGVyKGxlZnRUcmFuc2l0aW9uLCByaWdodFRyYW5zaXRpb24pKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBlbnF1ZXVlQ2xvc3VyZVBhaXJzKGxlZnRUcmFuc2l0aW9uLnRhcmdldCwgcmlnaHRUcmFuc2l0aW9uLnRhcmdldCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgbGFiZWw6IHN0cmluZyxcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBzZWVuT3duZXJzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxuICBzZWVuUGF0dGVybnM6IFNlZW5CZWhhdmlvclBhdHRlcm5bXSxcbik6IHZvaWQge1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnMpKSB7XG4gICAgY29uc3Qgb3duZXIgPSBzZWVuT3duZXJzLmdldChwYXR0ZXJuKTtcbiAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IGxhYmVsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJuIFwiJHtwYXR0ZXJufVwiIGZvciAke293bmVyfSBhbmQgJHtsYWJlbH1gKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHNlZW5QYXR0ZXJuIG9mIHNlZW5QYXR0ZXJucykge1xuICAgICAgaWYgKHNlZW5QYXR0ZXJuLmxhYmVsICE9PSBsYWJlbCAmJiBwYXRoUGF0dGVybnNDYW5PdmVybGFwKHNlZW5QYXR0ZXJuLnBhdHRlcm4sIHBhdHRlcm4pKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBvdmVybGFwcGluZyBwYXRoIHBhdHRlcm5zIFwiJHtzZWVuUGF0dGVybi5wYXR0ZXJufVwiIGFuZCBcIiR7cGF0dGVybn1cIiBmb3IgJHtzZWVuUGF0dGVybi5sYWJlbH0gYW5kICR7bGFiZWx9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzZWVuT3duZXJzLnNldChwYXR0ZXJuLCBsYWJlbCk7XG4gICAgc2VlblBhdHRlcm5zLnB1c2goeyBwYXR0ZXJuLCBsYWJlbCB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5vbmljYWxpemVIZWFkZXJOYW1lKGhlYWRlcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyhoZWFkZXIpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5mdW5jdGlvbiBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IGNhbm9uaWNhbGl6ZUhlYWRlck5hbWUoaGVhZGVyKS5yZXBsYWNlKC9bXmEtejAtOV0rL2csIFwiLVwiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQgPT09IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgfHwgLyhefC0pdGVuYW50KC18JCkvLnRlc3Qobm9ybWFsaXplZCk7XG59XG5cbmZ1bmN0aW9uIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24oc2NvcGU6IENvbnN0cnVjdCk6IHZvaWQge1xuICBjb25zdCByZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pICYmIHJlZ2lvbiA9PT0gXCJ1cy1lYXN0LTFcIikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHJlZ2lvbkRlc2NyaXB0aW9uID0gVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgPyBcInVucmVzb2x2ZWRcIiA6IHJlZ2lvbjtcbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIGBBcHBUaGVvcnlTc3JTaXRlIGNhbm5vdCBjcmVhdGUgYSBob3N0ZWQtem9uZSBDbG91ZEZyb250IGNlcnRpZmljYXRlIHVubGVzcyB0aGUgc3RhY2sgcmVnaW9uIGlzIGV4cGxpY2l0bHkgdXMtZWFzdC0xOyBzdGFjayByZWdpb24gaXMgJHtyZWdpb25EZXNjcmlwdGlvbn0uIFByb3ZpZGUgcHJvcHMuY2VydGlmaWNhdGVBcm4gZm9yIHN0YWNrcyBpbiBvdGhlciBvciBlbnZpcm9ubWVudC1hZ25vc3RpYyByZWdpb25zLmAsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVxdWVzdEZ1bmN0aW9uQ29kZShcbiAgbW9kZTogQXBwVGhlb3J5U3NyU2l0ZU1vZGUsXG4gIHJhd1MzUGF0aFBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgbGFtYmRhUGFzc3Rocm91Z2hQYXRoUGF0dGVybnM6IHN0cmluZ1tdLFxuICBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyczogc3RyaW5nW10sXG4pOiBzdHJpbmcge1xuICBjb25zdCByYXdTM1ByZWZpeGVzID0gcmF3UzNQYXRoUGF0dGVybnMubWFwKHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgpLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpO1xuICBjb25zdCByYXdTM1ByZWZpeExpc3QgPSByYXdTM1ByZWZpeGVzLm1hcCgocHJlZml4KSA9PiBgJyR7cHJlZml4fSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zXG4gICAgLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG4gIGNvbnN0IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJMaXN0ID0gYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMubWFwKChoZWFkZXIpID0+IGAnJHtoZWFkZXJ9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuXG4gIHJldHVybiBgXG5cdGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcblx0ICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG5cdCAgcmVxdWVzdC5oZWFkZXJzID0gcmVxdWVzdC5oZWFkZXJzIHx8IHt9O1xuXHQgIHZhciBoZWFkZXJzID0gcmVxdWVzdC5oZWFkZXJzO1xuXHQgIHZhciB1cmkgPSByZXF1ZXN0LnVyaSB8fCAnLyc7XG5cdCAgdmFyIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzID0gW1xuXHQgICAgJHtibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyTGlzdH1cblx0ICBdO1xuXG5cdCAgZm9yICh2YXIgYmxvY2tlZEluZGV4ID0gMDsgYmxvY2tlZEluZGV4IDwgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMubGVuZ3RoOyBibG9ja2VkSW5kZXgrKykge1xuXHQgICAgZGVsZXRlIGhlYWRlcnNbYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnNbYmxvY2tlZEluZGV4XV07XG5cdCAgfVxuXG5cdCAgdmFyIHJlcXVlc3RJZEhlYWRlciA9IGhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddO1xuXHQgIHZhciByZXF1ZXN0SWQgPSByZXF1ZXN0SWRIZWFkZXIgJiYgcmVxdWVzdElkSGVhZGVyLnZhbHVlID8gcmVxdWVzdElkSGVhZGVyLnZhbHVlLnRyaW0oKSA6ICcnO1xuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9IGV2ZW50LmNvbnRleHQgJiYgZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQgPyBTdHJpbmcoZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQpLnRyaW0oKSA6ICcnO1xuXHQgIH1cblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSAncmVxXycgKyBEYXRlLm5vdygpLnRvU3RyaW5nKDM2KSArICdfJyArIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDEwKTtcblx0ICB9XG5cblx0ICBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSA9IHsgdmFsdWU6IHJlcXVlc3RJZCB9O1xuXHQgIGhlYWRlcnNbJyR7YXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblx0ICBoZWFkZXJzWycke2ZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcn0nXSA9IHsgdmFsdWU6IHVyaSB9O1xuXG5cdCAgaWYgKGhlYWRlcnMuaG9zdCAmJiBoZWFkZXJzLmhvc3QudmFsdWUpIHtcblx0ICAgIGhlYWRlcnNbJyR7YXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgICBoZWFkZXJzWycke2ZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJ9J10gPSB7IHZhbHVlOiBoZWFkZXJzLmhvc3QudmFsdWUgfTtcblx0ICB9XG5cblx0ICBpZiAoJyR7bW9kZX0nID09PSAnJHtBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSfScpIHtcblx0ICAgIHZhciByYXdTM1ByZWZpeGVzID0gW1xuXHQgICAgICAke3Jhd1MzUHJlZml4TGlzdH1cblx0ICAgIF07XG5cdCAgICB2YXIgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtsYW1iZGFQYXNzdGhyb3VnaFByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGlzTGFtYmRhUGFzc3Rocm91Z2hQYXRoID0gZmFsc2U7XG5cblx0ICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5sZW5ndGg7IGkrKykge1xuXHQgICAgICB2YXIgcHJlZml4ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlc1tpXTtcblx0ICAgICAgaWYgKHVyaSA9PT0gcHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHByZWZpeCArICcvJykpIHtcblx0ICAgICAgICBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IHRydWU7XG5cdCAgICAgICAgYnJlYWs7XG5cdCAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgaWYgKCFpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCkge1xuXHQgICAgICB2YXIgaXNSYXdTM1BhdGggPSBmYWxzZTtcblxuXHQgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IHJhd1MzUHJlZml4ZXMubGVuZ3RoOyBqKyspIHtcblx0ICAgICAgICB2YXIgcmF3UHJlZml4ID0gcmF3UzNQcmVmaXhlc1tqXTtcblx0ICAgICAgICBpZiAodXJpID09PSByYXdQcmVmaXggfHwgdXJpLnN0YXJ0c1dpdGgocmF3UHJlZml4ICsgJy8nKSkge1xuXHQgICAgICAgICAgaXNSYXdTM1BhdGggPSB0cnVlO1xuXHQgICAgICAgICAgYnJlYWs7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cblx0ICAgICAgdmFyIGxhc3RTbGFzaCA9IHVyaS5sYXN0SW5kZXhPZignLycpO1xuXHQgICAgICB2YXIgbGFzdFNlZ21lbnQgPSBsYXN0U2xhc2ggPj0gMCA/IHVyaS5zdWJzdHJpbmcobGFzdFNsYXNoICsgMSkgOiB1cmk7XG5cblx0ICAgICAgaWYgKCFpc1Jhd1MzUGF0aCAmJiBsYXN0U2VnbWVudC5pbmRleE9mKCcuJykgPT09IC0xKSB7XG5cdCAgICAgICAgcmVxdWVzdC51cmkgPSB1cmkuZW5kc1dpdGgoJy8nKSA/IHVyaSArICdpbmRleC5odG1sJyA6IHVyaSArICcvaW5kZXguaHRtbCc7XG5cdCAgICAgIH1cblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVxdWVzdDtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uQ29kZSgpOiBzdHJpbmcge1xuICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHZhciByZXNwb25zZSA9IGV2ZW50LnJlc3BvbnNlO1xuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSByZXF1ZXN0LmhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddO1xuXHQgIHZhciByZXF1ZXN0SWQgPSByZXF1ZXN0SWRIZWFkZXIgJiYgcmVxdWVzdElkSGVhZGVyLnZhbHVlID8gcmVxdWVzdElkSGVhZGVyLnZhbHVlLnRyaW0oKSA6ICcnO1xuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9IGV2ZW50LmNvbnRleHQgJiYgZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQgPyBTdHJpbmcoZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQpLnRyaW0oKSA6ICcnO1xuXHQgIH1cblxuXHQgIGlmIChyZXF1ZXN0SWQpIHtcblx0ICAgIHJlc3BvbnNlLmhlYWRlcnMgPSByZXNwb25zZS5oZWFkZXJzIHx8IHt9O1xuXHQgICAgaWYgKCFyZXNwb25zZS5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSkge1xuXHQgICAgICByZXNwb25zZS5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSA9IHsgdmFsdWU6IHJlcXVlc3RJZCB9O1xuXHQgICAgfVxuXHQgIH1cblxuXHQgIHJldHVybiByZXNwb25zZTtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTc3JTaXRlUHJvcHMge1xuICByZWFkb25seSBzc3JGdW5jdGlvbjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogRXhwbGljaXQgZGVwbG95bWVudCBtb2RlIGZvciB0aGUgc2l0ZSB0b3BvbG9neS5cbiAgICpcbiAgICogLSBgc3NyLW9ubHlgOiBMYW1iZGEgRnVuY3Rpb24gVVJMIGlzIHRoZSBkZWZhdWx0IG9yaWdpblxuICAgKiAtIGBzc2ctaXNyYDogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBpcyB0aGUgZmFsbGJhY2tcbiAgICpcbiAgICogRXhpc3RpbmcgaW1wbGljaXQgYmVoYXZpb3IgbWFwcyB0byBgc3NyLW9ubHlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU1JfT05MWVxuICAgKi9cbiAgcmVhZG9ubHkgbW9kZT86IEFwcFRoZW9yeVNzclNpdGVNb2RlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGludm9rZSBtb2RlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkludm9rZU1vZGUuUkVTUE9OU0VfU1RSRUFNXG4gICAqL1xuICByZWFkb25seSBpbnZva2VNb2RlPzogbGFtYmRhLkludm9rZU1vZGU7XG5cbiAgLyoqXG4gICAqIEZ1bmN0aW9uIFVSTCBhdXRoIHR5cGUgZm9yIHRoZSBTU1Igb3JpZ2luLlxuICAgKlxuICAgKiBJZiBvbWl0dGVkLCBBcHBUaGVvcnkgZmFpbHMgY2xvc2VkIHRvIGBBV1NfSUFNYCBhbmQgc2lnbnMgQ2xvdWRGcm9udC10by1MYW1iZGFcbiAgICogdHJhZmZpYyB3aXRoIGxhbWJkYSBPcmlnaW4gQWNjZXNzIENvbnRyb2wuXG4gICAqXG4gICAqIFNldCB0aGlzIGV4cGxpY2l0bHkgdG8gYE5PTkVgIG9ubHkgd2hlbiB5b3UgaW50ZW50aW9uYWxseSByZXF1aXJlIHB1YmxpY1xuICAgKiBkaXJlY3QgRnVuY3Rpb24gVVJMIGFjY2VzcyBhcyBhIGRlbGliZXJhdGUgY29tcGF0aWJpbGl0eSBjaG9pY2UuXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICovXG4gIHJlYWRvbmx5IHNzclVybEF1dGhUeXBlPzogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGU7XG5cbiAgcmVhZG9ubHkgYXNzZXRzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcmVhZG9ubHkgYXNzZXRzUGF0aD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4Pzogc3RyaW5nO1xuICByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgUzMgYnVja2V0IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlIChgUzNIdG1sU3RvcmVgKS5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlczpcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfQlVDS0VUYFxuICAgKiAtIGBGQUNFVEhFT1JZX0lTUl9QUkVGSVhgXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBTMyBrZXkgcHJlZml4IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlLlxuICAgKiBAZGVmYXVsdCBpc3JcbiAgICovXG4gIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBleHRlbnNpb25sZXNzIEhUTUwgc2VjdGlvbiBwYXRoIHBhdHRlcm5zIHRvIHJvdXRlIGRpcmVjdGx5IHRvIHRoZSBwcmltYXJ5IEhUTUwgUzMgb3JpZ2luLlxuICAgKlxuICAgKiBSZXF1ZXN0cyBsaWtlIGAvbWFya2V0aW5nYCBhbmQgYC9tYXJrZXRpbmcvLi4uYCBhcmUgcmV3cml0dGVuIHRvIGAvaW5kZXguaHRtbGBcbiAgICogd2l0aGluIHRoZSBzZWN0aW9uIGFuZCBzdGF5IG9uIFMzIGluc3RlYWQgb2YgZmFsbGluZyBiYWNrIHRvIExhbWJkYS5cbiAgICpcbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgSFRNTCBzZWN0aW9uIHBhdGg6IFwiL21hcmtldGluZy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YXRpY1BhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIHJhdyBTMyBvYmplY3QvZGF0YSBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBleHRlbnNpb25sZXNzIEhUTUwgcmV3cml0ZXMuXG4gICAqXG4gICAqIEluIGBzc2ctaXNyYCBtb2RlLCBgL19mYWNldGhlb3J5L2RhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseS5cbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgb2JqZWN0IHBhdGg6IFwiL2ZlZWRzLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgZGlyZWN0UzNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyB0aGUgYHNzZy1pc3JgIG9yaWdpbiBncm91cCBhbmQgcm91dGUgZGlyZWN0bHlcbiAgICogdG8gdGhlIExhbWJkYSBGdW5jdGlvbiBVUkwgd2l0aCBmdWxsIG1ldGhvZCBzdXBwb3J0LlxuICAgKlxuICAgKiBJbiBgc3NnLWlzcmAgbW9kZSwgYC9fZmFjZXRoZW9yeS9zc3ItZGF0YS8qYCBpcyBhZGRlZCBhdXRvbWF0aWNhbGx5IGZvciBGYWNlVGhlb3J5XG4gICAqIHN0cmljdCBuby1pbmxpbmUtQ1NQIFNTUiBoeWRyYXRpb24gc2lkZWNhcnMuXG4gICAqXG4gICAqIFVzZSB0aGlzIGZvciBzYW1lLW9yaWdpbiBkeW5hbWljIHBhdGhzIHN1Y2ggYXMgYXV0aCBjYWxsYmFja3MsIGFjdGlvbnMsIG9yIGZvcm0gcG9zdHMuXG4gICAqIEV4YW1wbGUgZGlyZWN0LVNTUiBwYXRoOiBcIi9hY3Rpb25zLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3NyUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgYmVhcmVyLWF1dGggTGFtYmRhIEZ1bmN0aW9uIFVSTCBjby1vcmlnaW5zIHRvIGF0dGFjaCB0byB0aGUgc2FtZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgZWFjaCBjby1vcmlnaW4gRnVuY3Rpb24gVVJMIHdpdGggYEF1dGhUeXBlLk5PTkVgIGFuZCByb3V0ZXMgdGhlIHN1cHBsaWVkXG4gICAqIHBhdGggcGF0dGVybnMgdG8gaXQgd2l0aG91dCBMYW1iZGEgT3JpZ2luIEFjY2VzcyBDb250cm9sLiBUaGUgU1NSIG9yaWdpbiByZW1haW5zIGdvdmVybmVkIGJ5XG4gICAqIGBzc3JVcmxBdXRoVHlwZWAgYW5kIHN0aWxsIGRlZmF1bHRzIHRvIGBBV1NfSUFNYCBwbHVzIExhbWJkYSBPQUMuXG4gICAqXG4gICAqIENvLW9yaWdpbiBwYXRocyBwYXJ0aWNpcGF0ZSBpbiBBcHBUaGVvcnkncyBiZWhhdmlvciBwYXRoIGNvbGxpc2lvbiBjaGVja3MgYW5kIGJ5cGFzcyBgc3NnLWlzcmBcbiAgICogSFRNTCByZXdyaXRlcy4gVGhpcyBpcyB0aGUgc3VwcG9ydGVkIEFwcFRoZW9yeSBwYXRoIGZvciBtaXhlZC1hdXRoIGRpc3RyaWJ1dGlvbnM7IGRvIG5vdCBoYW5kLXdpcmVcbiAgICogcmF3IGBkaXN0cmlidXRpb24uYWRkQmVoYXZpb3IoLi4uKWAgY2FsbHMgd2hlbiBBcHBUaGVvcnkgc2hvdWxkIG93biBwYXRoIGFuZCBlZGdlLWNvbnRleHQgcG9saWN5LlxuICAgKlxuICAgKiBFeGFtcGxlIGJlYXJlciBBUEkgcGF0aHM6IGBbXCIvYXBpLypcIiwgXCIvYXV0aC8qXCJdYC5cbiAgICovXG4gIHJlYWRvbmx5IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucz86IEFwcFRoZW9yeVNzclNpdGVCZWFyZXJGdW5jdGlvblVybE9yaWdpbltdO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBUYWJsZVRoZW9yeS9EeW5hbW9EQiB0YWJsZSB1c2VkIGZvciBGYWNlVGhlb3J5IElTUiBtZXRhZGF0YSBhbmQgbGVhc2UgY29vcmRpbmF0aW9uLlxuICAgKlxuICAgKiBXaGVuIHByb3ZpZGVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBTU1IgZnVuY3Rpb24gcmVhZC93cml0ZSBhY2Nlc3MgYW5kIHdpcmVzIHRoZVxuICAgKiBtZXRhZGF0YSB0YWJsZSBhbGlhc2VzIGV4cGVjdGVkIGJ5IHRoZSBkb2N1bWVudGVkIEZhY2VUaGVvcnkgZGVwbG95bWVudCBzaGFwZS5cbiAgICovXG4gIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIElTUi9jYWNoZSBtZXRhZGF0YSB0YWJsZSBuYW1lIHRvIHdpcmUgd2hlbiB5b3UgYXJlIG5vdCBwYXNzaW5nIGBpc3JNZXRhZGF0YVRhYmxlYC5cbiAgICpcbiAgICogUHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCB3aGVuIEFwcFRoZW9yeSBzaG91bGQgYWxzbyBncmFudCBhY2Nlc3MgdG8gdGhlIFNTUiBMYW1iZGEuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGVnYWN5IGFsaWFzIGZvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgLlxuICAgKiBAZGVwcmVjYXRlZCBwcmVmZXIgYGlzck1ldGFkYXRhVGFibGVgIG9yIGBpc3JNZXRhZGF0YVRhYmxlTmFtZWBcbiAgICovXG4gIHJlYWRvbmx5IGNhY2hlVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8vIFdoZW4gdHJ1ZSAoZGVmYXVsdCksIEFwcFRoZW9yeSB3aXJlcyByZWNvbW1lbmRlZCBydW50aW1lIGVudmlyb25tZW50IHZhcmlhYmxlcyBvbnRvIHRoZSBTU1IgZnVuY3Rpb24uXG4gIHJlYWRvbmx5IHdpcmVSdW50aW1lRW52PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBoZWFkZXJzIHRvIGZvcndhcmQgdG8gdGhlIFNTUiBvcmlnaW4gKExhbWJkYSBGdW5jdGlvbiBVUkwpIHZpYSB0aGUgb3JpZ2luIHJlcXVlc3QgcG9saWN5LlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBBcHBUaGVvcnkvRmFjZVRoZW9yeS1zYWZlIGVkZ2UgY29udHJhY3QgZm9yd2FyZHMgb25seTpcbiAgICogLSBgY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9gXG4gICAqIC0gYGNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NgXG4gICAqIC0gYHgtYXBwdGhlb3J5LW9yaWdpbmFsLWhvc3RgXG4gICAqIC0gYHgtYXBwdGhlb3J5LW9yaWdpbmFsLXVyaWBcbiAgICogLSBgeC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtcmVxdWVzdC1pZGBcbiAgICpcbiAgICogVXNlIHRoaXMgdG8gb3B0IGluIHRvIGFkZGl0aW9uYWwgYXBwLXNwZWNpZmljIGhlYWRlcnMgc3VjaCBhc1xuICAgKiBgeC1mYWNldGhlb3J5LXNlZ21lbnRgLiBUZW5hbnQtbGlrZSB2aWV3ZXIgaGVhZGVycyBhcmUgcmVqZWN0ZWQgdW5sZXNzXG4gICAqIGBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNgIGlzIGV4cGxpY2l0bHkgZW5hYmxlZCBhcyBhIGNvbXBhdGliaWxpdHkgbW9kZS5cbiAgICogYGhvc3RgIGFuZCBgeC1mb3J3YXJkZWQtcHJvdG9gIGFyZSByZWplY3RlZCBiZWNhdXNlIHRoZXkgYnJlYWsgb3IgYnlwYXNzIHRoZVxuICAgKiBzdXBwb3J0ZWQgb3JpZ2luIG1vZGVsLlxuICAgKi9cbiAgcmVhZG9ubHkgc3NyRm9yd2FyZEhlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQ29tcGF0aWJpbGl0eSBlc2NhcGUgaGF0Y2ggZm9yIGxlZ2FjeSB2aWV3ZXItc3VwcGxpZWQgdGVuYW50IGhlYWRlcnMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UgKGRlZmF1bHQpLCBBcHBUaGVvcnkgc3RyaXBzIGB4LXRlbmFudC1pZGAgYXQgdGhlIGVkZ2UgYW5kIHJlamVjdHNcbiAgICogdGVuYW50LWxpa2UgZW50cmllcyBpbiBgc3NyRm9yd2FyZEhlYWRlcnNgIHNvIHZpZXdlci1zdXBwbGllZCB0ZW5hbnQgaGVhZGVyc1xuICAgKiBjYW5ub3QgaW5mbHVlbmNlIG9yaWdpbiByb3V0aW5nIG9yIEhUTUwgY2FjaGUgcGFydGl0aW9uaW5nLiBXaGVuIHRydWUsXG4gICAqIEFwcFRoZW9yeSByZXN0b3JlcyBsZWdhY3kgcGFzc3Rocm91Z2ggYmVoYXZpb3IgZm9yIGB4LXRlbmFudC1pZGAgYW5kIGFueVxuICAgKiB0ZW5hbnQtbGlrZSBgc3NyRm9yd2FyZEhlYWRlcnNgLlxuICAgKlxuICAgKiBQcmVmZXIgZGVyaXZpbmcgdGVuYW50IGZyb20gdHJ1c3RlZCBob3N0IG1hcHBpbmcgdXNpbmcgdGhlIG9yaWdpbmFsLWhvc3RcbiAgICogZWRnZSBoZWFkZXJzIGluc3RlYWQgb2YgZW5hYmxpbmcgcGFzc3Rocm91Z2guXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnM/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogQ2xvdWRGcm9udCByZXNwb25zZSBoZWFkZXJzIHBvbGljeSBhcHBsaWVkIHRvIFNTUiBhbmQgZGlyZWN0LVMzIGJlaGF2aW9ycy5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IHByb3Zpc2lvbnMgYSBGYWNlVGhlb3J5LWFsaWduZWQgYmFzZWxpbmUgcG9saWN5IGF0IHRoZSBDRE5cbiAgICogbGF5ZXI6IEhTVFMsIG5vc25pZmYsIGZyYW1lLW9wdGlvbnMsIHJlZmVycmVyLXBvbGljeSwgWFNTIHByb3RlY3Rpb24sIGFuZCBhXG4gICAqIHJlc3RyaWN0aXZlIHBlcm1pc3Npb25zLXBvbGljeS4gQ29udGVudC1TZWN1cml0eS1Qb2xpY3kgcmVtYWlucyBvcmlnaW4tZGVmaW5lZC5cbiAgICovXG4gIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAvKipcbiAgICogQ2FjaGUgcG9saWN5IGFwcGxpZWQgdG8gZGlyZWN0IExhbWJkYS1iYWNrZWQgU1NSIGJlaGF2aW9ycy5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgaXMgYENBQ0hJTkdfRElTQUJMRURgIHNvIGR5bmFtaWMgTGFtYmRhIHJvdXRlcyBzdGF5IHNhZmUgdW5sZXNzIHlvdVxuICAgKiBpbnRlbnRpb25hbGx5IG9wdCBpbnRvIGEgY2FjaGUgcG9saWN5IHRoYXQgbWF0Y2hlcyB5b3VyIGFwcCdzIHZhcmlhbmNlIG1vZGVsLlxuICAgKiBAZGVmYXVsdCBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRURcbiAgICovXG4gIHJlYWRvbmx5IHNzckNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgLyoqXG4gICAqIENhY2hlIHBvbGljeSBhcHBsaWVkIHRvIHRoZSBjYWNoZWFibGUgSFRNTCBiZWhhdmlvciBpbiBgc3NnLWlzcmAgbW9kZS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5IHBvbGljeSBrZXlzIG9uIHF1ZXJ5IHN0cmluZ3MgcGx1cyB0aGUgc3RhYmxlIHB1YmxpYyBIVE1MXG4gICAqIHZhcmlhbnQgaGVhZGVycyAoYHgtKi1vcmlnaW5hbC1ob3N0YCBhbmQgYW55IG5vbi10ZW5hbnQgZXh0cmEgZm9yd2FyZGVkXG4gICAqIGhlYWRlcnMgeW91IG9wdCBpbnRvKSB3aGlsZSBsZWF2aW5nIGNvb2tpZXMgb3V0IG9mIHRoZSBjYWNoZSBrZXkuIFRlbmFudC1saWtlXG4gICAqIHZpZXdlciBoZWFkZXJzIGpvaW4gdGhlIGNhY2hlIGtleSBvbmx5IHdoZW4gYGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc2AgaXNcbiAgICogZXhwbGljaXRseSBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbENhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICByZWFkb25seSBkb21haW5OYW1lPzogc3RyaW5nO1xuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZHMgYW5kIG9wdGlvbmFsIGNlcnRpZmljYXRlIHZhbGlkYXRpb24uXG4gICAqXG4gICAqIFdoZW4gYGRvbWFpbk5hbWVgIGlzIHNldCB3aXRob3V0IGBjZXJ0aWZpY2F0ZUFybmAsIGhvc3RlZC16b25lIGNlcnRpZmljYXRlXG4gICAqIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvbiBpcyBleHBsaWNpdGx5IGB1cy1lYXN0LTFgLlxuICAgKiBDbG91ZEZyb250IHJlcXVpcmVzIHZpZXdlciBjZXJ0aWZpY2F0ZXMgaW4gYHVzLWVhc3QtMWA7IGVudmlyb25tZW50LWFnbm9zdGljXG4gICAqIG9yIG90aGVyLXJlZ2lvbiBzdGFja3MgbXVzdCBwcm92aWRlIGBjZXJ0aWZpY2F0ZUFybmAuXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcbiAgLyoqXG4gICAqIEV4aXN0aW5nIEFDTSBjZXJ0aWZpY2F0ZSBBUk4gZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogVGhlIGNlcnRpZmljYXRlIG11c3QgYmUgaW4gYHVzLWVhc3QtMWAgZm9yIENsb3VkRnJvbnQuXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTc3JTaXRlQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW4ge1xuICAvKipcbiAgICogTGFtYmRhIGZ1bmN0aW9uIHRoYXQgQXBwVGhlb3J5IGV4cG9zZXMgYXMgYSBiZWFyZXItYXV0aCBGdW5jdGlvbiBVUkwgY28tb3JpZ2luLlxuICAgKlxuICAgKiBBcHBUaGVvcnkgY3JlYXRlcyB0aGUgRnVuY3Rpb24gVVJMIHdpdGggYGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLk5PTkVgOyBhdXRoZW50aWNhdGlvbiByZW1haW5zXG4gICAqIHRoZSByZXNwb25zaWJpbGl0eSBvZiB0aGUgTGFtYmRhIGhhbmRsZXIuXG4gICAqL1xuICByZWFkb25seSBmdW5jdGlvbjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogQ2xvdWRGcm9udCBwYXRoIHBhdHRlcm5zIHRoYXQgcm91dGUgdG8gdGhpcyBjby1vcmlnaW4uXG4gICAqXG4gICAqIFBhdHRlcm5zIGFyZSBub3JtYWxpemVkIHRoZSBzYW1lIHdheSBhcyBgc3NyUGF0aFBhdHRlcm5zYC4gQSBwYXR0ZXJuIGVuZGluZyBpbiBgLypgIGFsc28gY3JlYXRlc1xuICAgKiBhIHJvb3QgYmVoYXZpb3Igd2l0aG91dCB0aGUgd2lsZGNhcmQgc28gYC9hcGkvKmAgY292ZXJzIGJvdGggYC9hcGlgIGFuZCBgL2FwaS8uLi5gLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0aFBhdHRlcm5zOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpbnZva2UgbW9kZSBmb3IgdGhpcyBjby1vcmlnaW4uXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5JbnZva2VNb2RlLkJVRkZFUkVEXG4gICAqL1xuICByZWFkb25seSBpbnZva2VNb2RlPzogbGFtYmRhLkludm9rZU1vZGU7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlTc3JTaXRlIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c0J1Y2tldDogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c0tleVByZWZpeDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzTWFuaWZlc3RLZXk6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGh0bWxTdG9yZUJ1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBodG1sU3RvcmVLZXlQcmVmaXg/OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBzc3JVcmw6IGxhbWJkYS5GdW5jdGlvblVybDtcbiAgcHVibGljIHJlYWRvbmx5IGJlYXJlckZ1bmN0aW9uVXJsczogbGFtYmRhLkZ1bmN0aW9uVXJsW107XG4gIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVNzclNpdGVQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAoIXByb3BzPy5zc3JGdW5jdGlvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBzaXRlTW9kZSA9IHByb3BzLm1vZGUgPz8gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFk7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICBjb25zdCB3aXJlUnVudGltZUVudiA9IHByb3BzLndpcmVSdW50aW1lRW52ID8/IHRydWU7XG5cbiAgICB0aGlzLmFzc2V0c0J1Y2tldCA9XG4gICAgICBwcm9wcy5hc3NldHNCdWNrZXQgPz9cbiAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJBc3NldHNCdWNrZXRcIiwge1xuICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgfSk7XG5cbiAgICBjb25zdCBlbmFibGVMb2dnaW5nID0gcHJvcHMuZW5hYmxlTG9nZ2luZyA/PyB0cnVlO1xuICAgIGlmIChlbmFibGVMb2dnaW5nKSB7XG4gICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGFzc2V0c1ByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKHByb3BzLmFzc2V0c0tleVByZWZpeCA/PyBcImFzc2V0c1wiKS50cmltKCksIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNLZXlQcmVmaXggPSBhc3NldHNQcmVmaXhSYXcgfHwgXCJhc3NldHNcIjtcblxuICAgIGNvbnN0IG1hbmlmZXN0UmF3ID0gU3RyaW5nKHByb3BzLmFzc2V0c01hbmlmZXN0S2V5ID8/IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmApLnRyaW0oKTtcbiAgICBjb25zdCBtYW5pZmVzdEtleSA9IHRyaW1SZXBlYXRlZENoYXIobWFuaWZlc3RSYXcsIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNNYW5pZmVzdEtleSA9IG1hbmlmZXN0S2V5IHx8IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmA7XG5cbiAgICB0aGlzLmFzc2V0c0tleVByZWZpeCA9IGFzc2V0c0tleVByZWZpeDtcbiAgICB0aGlzLmFzc2V0c01hbmlmZXN0S2V5ID0gYXNzZXRzTWFuaWZlc3RLZXk7XG5cbiAgICBjb25zdCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dCA9IFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHNob3VsZENvbmZpZ3VyZUh0bWxTdG9yZSA9IEJvb2xlYW4ocHJvcHMuaHRtbFN0b3JlQnVja2V0KSB8fCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dC5sZW5ndGggPiAwO1xuICAgIGlmIChzaG91bGRDb25maWd1cmVIdG1sU3RvcmUpIHtcbiAgICAgIGNvbnN0IGh0bWxTdG9yZVByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoXG4gICAgICAgIFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeCkudHJpbSgpLFxuICAgICAgICBcIi9cIixcbiAgICAgICk7XG4gICAgICB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCA9IGh0bWxTdG9yZVByZWZpeFJhdyB8fCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4O1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQgPVxuICAgICAgICBwcm9wcy5odG1sU3RvcmVCdWNrZXQgPz9cbiAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkh0bWxTdG9yZUJ1Y2tldFwiLCB7XG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLmlzck1ldGFkYXRhVGFibGUgPSBwcm9wcy5pc3JNZXRhZGF0YVRhYmxlO1xuXG4gICAgY29uc3QgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSA9IFN0cmluZyhwcm9wcy5pc3JNZXRhZGF0YVRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgbGVnYWN5Q2FjaGVUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuY2FjaGVUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHJlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcodGhpcy5pc3JNZXRhZGF0YVRhYmxlPy50YWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgY29uc3QgY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbcmVzb3VyY2VJc3JNZXRhZGF0YVRhYmxlTmFtZSwgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSwgbGVnYWN5Q2FjaGVUYWJsZU5hbWVdLmZpbHRlcihcbiAgICAgICAgICAobmFtZSkgPT4gU3RyaW5nKG5hbWUpLnRyaW0oKS5sZW5ndGggPiAwLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICApO1xuXG4gICAgaWYgKGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMubGVuZ3RoID4gMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBjb25mbGljdGluZyBJU1IgbWV0YWRhdGEgdGFibGUgbmFtZXM6ICR7Y29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgaXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzWzBdID8/IFwiXCI7XG5cbiAgICBpZiAocHJvcHMuYXNzZXRzUGF0aCkge1xuICAgICAgbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgXCJBc3NldHNEZXBsb3ltZW50XCIsIHtcbiAgICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldChwcm9wcy5hc3NldHNQYXRoKV0sXG4gICAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLmFzc2V0c0J1Y2tldCxcbiAgICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6IGFzc2V0c0tleVByZWZpeCxcbiAgICAgICAgcHJ1bmU6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGF0aWNQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMocHJvcHMuc3RhdGljUGF0aFBhdHRlcm5zKTtcbiAgICBjb25zdCBkaXJlY3RTM1BhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhbXG4gICAgICAuLi4oc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBbc3NnSXNySHlkcmF0aW9uUGF0aFBhdHRlcm5dIDogW10pLFxuICAgICAgLi4uKEFycmF5LmlzQXJyYXkocHJvcHMuZGlyZWN0UzNQYXRoUGF0dGVybnMpID8gcHJvcHMuZGlyZWN0UzNQYXRoUGF0dGVybnMgOiBbXSksXG4gICAgXSk7XG4gICAgY29uc3Qgc3NyUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKFtcbiAgICAgIC4uLihzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IFtzc2dJc3JTc3JEYXRhUGF0aFBhdHRlcm5dIDogW10pLFxuICAgICAgLi4uKEFycmF5LmlzQXJyYXkocHJvcHMuc3NyUGF0aFBhdHRlcm5zKSA/IHByb3BzLnNzclBhdGhQYXR0ZXJucyA6IFtdKSxcbiAgICBdKTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMgPSBBcnJheS5pc0FycmF5KHByb3BzLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucylcbiAgICAgID8gcHJvcHMuYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zXG4gICAgICA6IFtdO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncyA9IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucy5tYXAoKG9yaWdpbiwgaW5kZXgpID0+IHtcbiAgICAgIGlmICghb3JpZ2luPy5mdW5jdGlvbikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zWyR7aW5kZXh9XSByZXF1aXJlcyBmdW5jdGlvbmApO1xuICAgICAgfVxuICAgICAgY29uc3QgcGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKG9yaWdpbi5wYXRoUGF0dGVybnMpO1xuICAgICAgaWYgKHBhdGhQYXR0ZXJucy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1ske2luZGV4fV0gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHBhdGggcGF0dGVybmApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHsgb3JpZ2luLCBwYXRoUGF0dGVybnMgfTtcbiAgICB9KTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybFBhdGhQYXR0ZXJucyA9IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mbGF0TWFwKChjb25maWcpID0+IGNvbmZpZy5wYXRoUGF0dGVybnMpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybk93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgY29uc3QgYmVoYXZpb3JQYXR0ZXJuczogU2VlbkJlaGF2aW9yUGF0dGVybltdID0gW107XG4gICAgY29uc3Qgc3NyVXJsQXV0aFR5cGUgPSBwcm9wcy5zc3JVcmxBdXRoVHlwZSA/PyBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNO1xuICAgIGNvbnN0IGFsbG93Vmlld2VyVGVuYW50SGVhZGVycyA9IHByb3BzLmFsbG93Vmlld2VyVGVuYW50SGVhZGVycyA/PyBmYWxzZTtcblxuICAgIHRoaXMuc3NyVXJsID0gbmV3IGxhbWJkYS5GdW5jdGlvblVybCh0aGlzLCBcIlNzclVybFwiLCB7XG4gICAgICBmdW5jdGlvbjogcHJvcHMuc3NyRnVuY3Rpb24sXG4gICAgICBhdXRoVHlwZTogc3NyVXJsQXV0aFR5cGUsXG4gICAgICBpbnZva2VNb2RlOiBwcm9wcy5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNzck9yaWdpbiA9XG4gICAgICBzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTVxuICAgICAgICA/IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5zc3JVcmwpXG4gICAgICAgIDogbmV3IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4odGhpcy5zc3JVcmwpO1xuXG4gICAgY29uc3QgYXNzZXRzT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCh0aGlzLmFzc2V0c0J1Y2tldCk7XG4gICAgY29uc3QgaHRtbE9yaWdpbkJ1Y2tldCA9IHRoaXMuaHRtbFN0b3JlQnVja2V0ID8/IHRoaXMuYXNzZXRzQnVja2V0O1xuICAgIGNvbnN0IGh0bWxPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKFxuICAgICAgaHRtbE9yaWdpbkJ1Y2tldCxcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4XG4gICAgICAgID8ge1xuICAgICAgICAgICAgb3JpZ2luUGF0aDogYC8ke3RoaXMuaHRtbFN0b3JlS2V5UHJlZml4fWAsXG4gICAgICAgICAgfVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICApO1xuXG4gICAgY29uc3QgYmFzZVNzckZvcndhcmRIZWFkZXJzID0gW1xuICAgICAgXCJjbG91ZGZyb250LWZvcndhcmRlZC1wcm90b1wiLFxuICAgICAgXCJjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzXCIsXG4gICAgICAuLi5zc3JPcmlnaW5hbEhvc3RIZWFkZXJzLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdO1xuXG4gICAgY29uc3QgZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzID0gbmV3IFNldChbXCJob3N0XCIsIFwieC1mb3J3YXJkZWQtcHJvdG9cIl0pO1xuXG4gICAgY29uc3QgZXh0cmFTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmlzQXJyYXkocHJvcHMuc3NyRm9yd2FyZEhlYWRlcnMpXG4gICAgICA/IHByb3BzLnNzckZvcndhcmRIZWFkZXJzLm1hcChjYW5vbmljYWxpemVIZWFkZXJOYW1lKS5maWx0ZXIoKGhlYWRlcikgPT4gaGVhZGVyLmxlbmd0aCA+IDApXG4gICAgICA6IFtdO1xuXG4gICAgY29uc3QgcmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmhhcyhoZWFkZXIpKSksXG4gICAgKS5zb3J0KCk7XG5cbiAgICBpZiAocmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgZGlzYWxsb3dzIHNzckZvcndhcmRIZWFkZXJzOiAke3JlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChleHRyYVNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyKSkpLFxuICAgICkuc29ydCgpO1xuXG4gICAgaWYgKHJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzLmxlbmd0aCA+IDAgJiYgIWFsbG93Vmlld2VyVGVuYW50SGVhZGVycykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnM9dHJ1ZSBmb3IgdGVuYW50LWxpa2Ugc3NyRm9yd2FyZEhlYWRlcnM6ICR7cmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHRlbmFudFBhc3N0aHJvdWdoSGVhZGVycyA9IGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc1xuICAgICAgPyBBcnJheS5mcm9tKG5ldyBTZXQoW2RlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIsIC4uLnJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzXSkpXG4gICAgICA6IFtdO1xuICAgIGNvbnN0IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzID0gYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzXG4gICAgICA/IFtdXG4gICAgICA6IEFycmF5LmZyb20obmV3IFNldChbZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciwgLi4ucmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnNdKSkuc29ydCgpO1xuXG4gICAgY29uc3Qgc3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgWy4uLmJhc2VTc3JGb3J3YXJkSGVhZGVycywgLi4udGVuYW50UGFzc3Rocm91Z2hIZWFkZXJzLCAuLi5leHRyYVNzckZvcndhcmRIZWFkZXJzXS5maWx0ZXIoXG4gICAgICAgICAgKGhlYWRlcikgPT4gIWRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMgPSBuZXcgU2V0KFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoc3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+ICFodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMuaGFzKGhlYWRlcikpKSxcbiAgICApO1xuICAgIGNvbnN0IG1heEJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXJzID0gMTA7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Gb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20obmV3IFNldChbLi4uYmFzZVNzckZvcndhcmRIZWFkZXJzLCBcImNvbnRlbnQtdHlwZVwiXSkpO1xuICAgIGNvbnN0IGlzQmxvY2tlZEJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXIgPSAoaGVhZGVyOiBzdHJpbmcpOiBib29sZWFuID0+XG4gICAgICBoZWFkZXIgPT09IFwiaG9zdFwiIHx8XG4gICAgICBoZWFkZXIgPT09IFwiZm9yd2FyZGVkXCIgfHxcbiAgICAgIGhlYWRlciA9PT0gXCJ4LXJlYWwtaXBcIiB8fFxuICAgICAgaGVhZGVyLnN0YXJ0c1dpdGgoXCJ4LWZvcndhcmRlZC1cIikgfHxcbiAgICAgIGlzVGVuYW50SGVhZGVyTmFtZShoZWFkZXIpO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIFtcbiAgICAgICAgICBcImF1dGhvcml6YXRpb25cIixcbiAgICAgICAgICBcImFjY2VwdFwiLFxuICAgICAgICAgIFwib3JpZ2luXCIsXG4gICAgICAgICAgXCJhY2Nlc3MtY29udHJvbC1yZXF1ZXN0LW1ldGhvZFwiLFxuICAgICAgICAgIFwiYWNjZXNzLWNvbnRyb2wtcmVxdWVzdC1oZWFkZXJzXCIsXG4gICAgICAgICAgLi4uZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoXG4gICAgICAgICAgICAoaGVhZGVyKSA9PlxuICAgICAgICAgICAgICAhaXNCbG9ja2VkQmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcihoZWFkZXIpICYmXG4gICAgICAgICAgICAgICFiZWFyZXJGdW5jdGlvblVybE9yaWdpbkZvcndhcmRIZWFkZXJzLmluY2x1ZGVzKGhlYWRlciksXG4gICAgICAgICAgKSxcbiAgICAgICAgXS5maWx0ZXIoKGhlYWRlcikgPT4gaGVhZGVyLmxlbmd0aCA+IDApLFxuICAgICAgKSxcbiAgICApO1xuXG4gICAgaWYgKCFwcm9wcy5odG1sQ2FjaGVQb2xpY3kgJiYgaHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGggPiBtYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRlZmF1bHQgaHRtbENhY2hlUG9saWN5IHN1cHBvcnRzIGF0IG1vc3QgJHttYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzfSBjYWNoZS1rZXkgaGVhZGVyczsgcmVjZWl2ZWQgJHtodG1sQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aH1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmxlbmd0aCA+IDAgJiZcbiAgICAgIGJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aCA+IG1heEJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXJzXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucyBzdXBwb3J0IGF0IG1vc3QgJHttYXhCZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVyc30gY2FjaGUta2V5IGZvcndhcmRlZCBoZWFkZXJzOyByZWNlaXZlZCAke2JlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aH1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIlNzck9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIkh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5zc3JGb3J3YXJkSGVhZGVycyksXG4gICAgfSk7XG4gICAgY29uc3Qgc3NyQ2FjaGVQb2xpY3kgPSBwcm9wcy5zc3JDYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQ7XG4gICAgY29uc3Qgc3RhdGljQXNzZXRzQ2FjaGVQb2xpY3kgPSBuZXcgY2xvdWRmcm9udC5DYWNoZVBvbGljeSh0aGlzLCBcIlN0YXRpY0Fzc2V0c0NhY2hlUG9saWN5XCIsIHtcbiAgICAgIGNvbW1lbnQ6XG4gICAgICAgIFwiQXBwVGhlb3J5IGRpcmVjdCBTMyBhc3NldC9kYXRhIGNhY2hlIHBvbGljeTogb3JpZ2luIENhY2hlLUNvbnRyb2wgYm91bmRlZCBieSBubyB2aWV3ZXIgaGVhZGVyIGZvcndhcmRpbmdcIixcbiAgICAgIG1pblR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgIGRlZmF1bHRUdGw6IER1cmF0aW9uLmRheXMoMSksXG4gICAgICBtYXhUdGw6IER1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlQ29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVIZWFkZXJCZWhhdmlvci5ub25lKCksXG4gICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5ub25lKCksXG4gICAgICBlbmFibGVBY2NlcHRFbmNvZGluZ0Jyb3RsaTogdHJ1ZSxcbiAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nR3ppcDogdHJ1ZSxcbiAgICB9KTtcbiAgICBjb25zdCBodG1sQ2FjaGVQb2xpY3kgPVxuICAgICAgcHJvcHMuaHRtbENhY2hlUG9saWN5ID8/XG4gICAgICBuZXcgY2xvdWRmcm9udC5DYWNoZVBvbGljeSh0aGlzLCBcIkh0bWxDYWNoZVBvbGljeVwiLCB7XG4gICAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSBIVE1MIGNhY2hlIHBvbGljeSBrZXllZCBieSBxdWVyeSBzdHJpbmdzIGFuZCBzdGFibGUgcHVibGljIHZhcmlhbnQgaGVhZGVyc1wiLFxuICAgICAgICBtaW5UdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgIGRlZmF1bHRUdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgIG1heFR0bDogRHVyYXRpb24uZGF5cygzNjUpLFxuICAgICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUNvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uaHRtbENhY2hlS2V5SGVhZGVycyksXG4gICAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgICBlbmFibGVBY2NlcHRFbmNvZGluZ0Jyb3RsaTogdHJ1ZSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdHemlwOiB0cnVlLFxuICAgICAgfSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5SZXF1ZXN0UG9saWN5ID1cbiAgICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5sZW5ndGggPiAwXG4gICAgICAgID8gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIkJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luUmVxdWVzdFBvbGljeVwiLCB7XG4gICAgICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLmFsbCgpLFxuICAgICAgICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdChcbiAgICAgICAgICAgICAgLi4uYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Gb3J3YXJkSGVhZGVycyxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgfSlcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxDYWNoZVBvbGljeSA9XG4gICAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MubGVuZ3RoID4gMFxuICAgICAgICA/IG5ldyBjbG91ZGZyb250LkNhY2hlUG9saWN5KHRoaXMsIFwiQmVhcmVyRnVuY3Rpb25VcmxDYWNoZVBvbGljeVwiLCB7XG4gICAgICAgICAgICBjb21tZW50OlxuICAgICAgICAgICAgICBcIkFwcFRoZW9yeSBiZWFyZXIgRnVuY3Rpb24gVVJMIEFQSSBjYWNoZSBwb2xpY3k6IGNhY2hpbmcgZGlzYWJsZWQgd2hpbGUgZm9yd2FyZGluZyBiZWFyZXIvQ09SUyBhcHAgaGVhZGVyc1wiLFxuICAgICAgICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICAgICAgZGVmYXVsdFR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgICAgIG1heFR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlQ29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uYmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcnMpLFxuICAgICAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZVF1ZXJ5U3RyaW5nQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgICAgIH0pXG4gICAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gICAgICBcImRpcmVjdCBTMyBwYXRoc1wiLFxuICAgICAgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSxcbiAgICAgIGJlaGF2aW9yUGF0dGVybk93bmVycyxcbiAgICAgIGJlaGF2aW9yUGF0dGVybnMsXG4gICAgKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcInN0YXRpYyBIVE1MIHBhdGhzXCIsIHN0YXRpY1BhdGhQYXR0ZXJucywgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLCBiZWhhdmlvclBhdHRlcm5zKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcImRpcmVjdCBTU1IgcGF0aHNcIiwgc3NyUGF0aFBhdHRlcm5zLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMsIGJlaGF2aW9yUGF0dGVybnMpO1xuICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mb3JFYWNoKChjb25maWcsIGluZGV4KSA9PiB7XG4gICAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgICAgICAgYGJlYXJlciBGdW5jdGlvbiBVUkwgY28tb3JpZ2luICR7aW5kZXggKyAxfWAsXG4gICAgICAgIGNvbmZpZy5wYXRoUGF0dGVybnMsXG4gICAgICAgIGJlaGF2aW9yUGF0dGVybk93bmVycyxcbiAgICAgICAgYmVoYXZpb3JQYXR0ZXJucyxcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXF1ZXN0RnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlcXVlc3RGdW5jdGlvblwiLCB7XG4gICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKFxuICAgICAgICBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoXG4gICAgICAgICAgc2l0ZU1vZGUsXG4gICAgICAgICAgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSxcbiAgICAgICAgICBbLi4uc3NyUGF0aFBhdHRlcm5zLCAuLi5iZWFyZXJGdW5jdGlvblVybFBhdGhQYXR0ZXJuc10sXG4gICAgICAgICAgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMsXG4gICAgICAgICksXG4gICAgICApLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDpcbiAgICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgICA/IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgYW5kIEhUTUwgcmV3cml0ZSBmb3IgU1NSIHNpdGVcIlxuICAgICAgICAgIDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXF1ZXN0IGVkZ2UgY29udGV4dCBmb3IgU1NSIHNpdGVcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShnZW5lcmF0ZVNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25Db2RlKCkpLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXNwb25zZSByZXF1ZXN0LWlkIGVjaG8gZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMgPSAoKTogY2xvdWRmcm9udC5GdW5jdGlvbkFzc29jaWF0aW9uW10gPT4gW1xuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVxdWVzdEZ1bmN0aW9uLFxuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVzcG9uc2VGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVNQT05TRSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCk7XG5cbiAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcbiAgICAgIGNvbnN0IGNlcnRBcm4gPSBTdHJpbmcocHJvcHMuY2VydGlmaWNhdGVBcm4gPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGNlcnRBcm4pIHtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwgY2VydEFybik7XG4gICAgICB9IGVsc2UgaWYgKHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbih0aGlzKTtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBuZXcgYWNtLkNlcnRpZmljYXRlKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwge1xuICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHByb3BzLmhvc3RlZFpvbmUpLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgcHJvcHMuY2VydGlmaWNhdGVBcm4gb3IgcHJvcHMuaG9zdGVkWm9uZSB3aGVuIHByb3BzLmRvbWFpbk5hbWUgaXMgc2V0XCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgIHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuUmVzcG9uc2VIZWFkZXJzUG9saWN5KHRoaXMsIFwiUmVzcG9uc2VIZWFkZXJzUG9saWN5XCIsIHtcbiAgICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IGJhc2VsaW5lIHNlY3VyaXR5IGhlYWRlcnMgKENTUCBzdGF5cyBvcmlnaW4tZGVmaW5lZClcIixcbiAgICAgICAgc2VjdXJpdHlIZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICBzdHJpY3RUcmFuc3BvcnRTZWN1cml0eToge1xuICAgICAgICAgICAgYWNjZXNzQ29udHJvbE1heEFnZTogRHVyYXRpb24uZGF5cygzNjUgKiAyKSxcbiAgICAgICAgICAgIGluY2x1ZGVTdWJkb21haW5zOiB0cnVlLFxuICAgICAgICAgICAgcHJlbG9hZDogdHJ1ZSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgY29udGVudFR5cGVPcHRpb25zOiB7IG92ZXJyaWRlOiB0cnVlIH0sXG4gICAgICAgICAgZnJhbWVPcHRpb25zOiB7XG4gICAgICAgICAgICBmcmFtZU9wdGlvbjogY2xvdWRmcm9udC5IZWFkZXJzRnJhbWVPcHRpb24uREVOWSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IHtcbiAgICAgICAgICAgIHJlZmVycmVyUG9saWN5OiBjbG91ZGZyb250LkhlYWRlcnNSZWZlcnJlclBvbGljeS5TVFJJQ1RfT1JJR0lOX1dIRU5fQ1JPU1NfT1JJR0lOLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB4c3NQcm90ZWN0aW9uOiB7XG4gICAgICAgICAgICBwcm90ZWN0aW9uOiB0cnVlLFxuICAgICAgICAgICAgbW9kZUJsb2NrOiB0cnVlLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgY3VzdG9tSGVhZGVyc0JlaGF2aW9yOiB7XG4gICAgICAgICAgY3VzdG9tSGVhZGVyczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBoZWFkZXI6IFwicGVybWlzc2lvbnMtcG9saWN5XCIsXG4gICAgICAgICAgICAgIHZhbHVlOiBcImNhbWVyYT0oKSwgbWljcm9waG9uZT0oKSwgZ2VvbG9jYXRpb249KClcIixcbiAgICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZVN0YXRpY0JlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGFzc2V0c09yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgIGNhY2hlUG9saWN5OiBzdGF0aWNBc3NldHNDYWNoZVBvbGljeSxcbiAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcbiAgICBjb25zdCBjcmVhdGVTdGF0aWNIdG1sQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogaHRtbE9yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgIGNhY2hlUG9saWN5OiBodG1sQ2FjaGVQb2xpY3ksXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcbiAgICBjb25zdCBjcmVhdGVTc3JCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBzc3JPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgIGNhY2hlUG9saWN5OiBzc3JDYWNoZVBvbGljeSxcbiAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IHNzck9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYWRkaXRpb25hbEJlaGF2aW9yczogUmVjb3JkPHN0cmluZywgY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnM+ID0ge307XG4gICAgY29uc3QgYWRkRXhwYW5kZWRCZWhhdmlvciA9IChwYXR0ZXJuczogc3RyaW5nW10sIGZhY3Rvcnk6ICgpID0+IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zKTogdm9pZCA9PiB7XG4gICAgICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnMpKSB7XG4gICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbcGF0dGVybl0gPSBmYWN0b3J5KCk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoW2Ake2Fzc2V0c0tleVByZWZpeH0vKmBdLCBjcmVhdGVTdGF0aWNCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihkaXJlY3RTM1BhdGhQYXR0ZXJucywgY3JlYXRlU3RhdGljQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3Ioc3RhdGljUGF0aFBhdHRlcm5zLCBjcmVhdGVTdGF0aWNIdG1sQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3Ioc3NyUGF0aFBhdHRlcm5zLCBjcmVhdGVTc3JCZWhhdmlvcik7XG4gICAgdGhpcy5iZWFyZXJGdW5jdGlvblVybHMgPSBbXTtcbiAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZm9yRWFjaCgoY29uZmlnLCBpbmRleCkgPT4ge1xuICAgICAgY29uc3QgZnVuY3Rpb25VcmwgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uVXJsKHRoaXMsIGBCZWFyZXJGdW5jdGlvblVybCR7aW5kZXggKyAxfWAsIHtcbiAgICAgICAgZnVuY3Rpb246IGNvbmZpZy5vcmlnaW4uZnVuY3Rpb24sXG4gICAgICAgIGF1dGhUeXBlOiBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5OT05FLFxuICAgICAgICBpbnZva2VNb2RlOiBjb25maWcub3JpZ2luLmludm9rZU1vZGUgPz8gbGFtYmRhLkludm9rZU1vZGUuQlVGRkVSRUQsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuYmVhcmVyRnVuY3Rpb25VcmxzLnB1c2goZnVuY3Rpb25VcmwpO1xuICAgICAgY29uc3QgZnVuY3Rpb25VcmxPcmlnaW4gPSBuZXcgb3JpZ2lucy5GdW5jdGlvblVybE9yaWdpbihmdW5jdGlvblVybCk7XG4gICAgICBjb25zdCBjcmVhdGVCZWFyZXJGdW5jdGlvblVybEJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICAgIG9yaWdpbjogZnVuY3Rpb25VcmxPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgIGNhY2hlUG9saWN5OiBiZWFyZXJGdW5jdGlvblVybENhY2hlUG9saWN5LFxuICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBiZWFyZXJGdW5jdGlvblVybE9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICAgIH0pO1xuICAgICAgYWRkRXhwYW5kZWRCZWhhdmlvcihjb25maWcucGF0aFBhdHRlcm5zLCBjcmVhdGVCZWFyZXJGdW5jdGlvblVybEJlaGF2aW9yKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IGRlZmF1bHRPcmlnaW4gPVxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgPyBuZXcgb3JpZ2lucy5PcmlnaW5Hcm91cCh7XG4gICAgICAgICAgICBwcmltYXJ5T3JpZ2luOiBodG1sT3JpZ2luLFxuICAgICAgICAgICAgZmFsbGJhY2tPcmlnaW46IHNzck9yaWdpbixcbiAgICAgICAgICAgIGZhbGxiYWNrU3RhdHVzQ29kZXM6IFs0MDMsIDQwNF0sXG4gICAgICAgICAgfSlcbiAgICAgICAgOiBzc3JPcmlnaW47XG4gICAgY29uc3QgZGVmYXVsdEFsbG93ZWRNZXRob2RzID1cbiAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgID8gY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TXG4gICAgICAgIDogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEw7XG5cbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICAuLi4oZW5hYmxlTG9nZ2luZyAmJiB0aGlzLmxvZ3NCdWNrZXRcbiAgICAgICAgPyB7IGVuYWJsZUxvZ2dpbmc6IHRydWUsIGxvZ0J1Y2tldDogdGhpcy5sb2dzQnVja2V0LCBsb2dGaWxlUHJlZml4OiBcImNsb3VkZnJvbnQvXCIgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICA/IHsgZG9tYWluTmFtZXM6IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIGRlZmF1bHRCZWhhdmlvcjoge1xuICAgICAgICBvcmlnaW46IGRlZmF1bHRPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogZGVmYXVsdEFsbG93ZWRNZXRob2RzLFxuICAgICAgICBjYWNoZVBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sQ2FjaGVQb2xpY3kgOiBzc3JDYWNoZVBvbGljeSxcbiAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA6IHNzck9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICAgIH0sXG4gICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICB9KTtcblxuICAgIGlmIChzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTSkge1xuICAgICAgcHJvcHMuc3NyRnVuY3Rpb24uYWRkUGVybWlzc2lvbihcIkFsbG93Q2xvdWRGcm9udEludm9rZUZ1bmN0aW9uVmlhVXJsXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLFxuICAgICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImNsb3VkZnJvbnQuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgc291cmNlQXJuOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Bcm4sXG4gICAgICAgIGludm9rZWRWaWFGdW5jdGlvblVybDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmh0bWxTdG9yZUJ1Y2tldCkge1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQuZ3JhbnRSZWFkV3JpdGUocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmlzck1ldGFkYXRhVGFibGUpIHtcbiAgICAgIHRoaXMuaXNyTWV0YWRhdGFUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh3aXJlUnVudGltZUVudikge1xuICAgICAgdGhpcy5hc3NldHNCdWNrZXQuZ3JhbnRSZWFkKHByb3BzLnNzckZ1bmN0aW9uKTtcblxuICAgICAgY29uc3Qgc3NyRnVuY3Rpb25BbnkgPSBwcm9wcy5zc3JGdW5jdGlvbiBhcyBhbnk7XG4gICAgICBpZiAodHlwZW9mIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZSB3aXJlUnVudGltZUVudiByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvbiB0byBzdXBwb3J0IGFkZEVudmlyb25tZW50OyBwYXNzIGEgbGFtYmRhLkZ1bmN0aW9uIG9yIHNldCB3aXJlUnVudGltZUVudj1mYWxzZSBhbmQgc2V0IGVudiB2YXJzIG1hbnVhbGx5XCIsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19CVUNLRVRcIiwgdGhpcy5hc3NldHNCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfUFJFRklYXCIsIGFzc2V0c0tleVByZWZpeCk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfTUFOSUZFU1RfS0VZXCIsIGFzc2V0c01hbmlmZXN0S2V5KTtcblxuICAgICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KSB7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfQlVDS0VUXCIsIHRoaXMuaHRtbFN0b3JlQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkZBQ0VUSEVPUllfSVNSX1BSRUZJWFwiLCB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCk7XG4gICAgICB9XG4gICAgICBpZiAoaXNyTWV0YWRhdGFUYWJsZU5hbWUpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQ0FDSEVfVEFCTEVfTkFNRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRvbWFpbk5hbWUgJiYgcHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogZG9tYWluTmFtZSxcbiAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gIH1cbn1cbiJdfQ==