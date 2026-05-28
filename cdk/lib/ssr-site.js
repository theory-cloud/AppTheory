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
AppTheorySsrSite[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "1.12.0-rc" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFvRTtBQUNwRSwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUU5RCwyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyREFBMkQ7QUFDM0QseUNBQXlDO0FBQ3pDLDBEQUEwRDtBQUMxRCwyQ0FBdUM7QUFFdkMseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLHlCQUF5QixDQUFDO0FBQzNELE1BQU0sNEJBQTRCLEdBQUcsS0FBSyxDQUFDO0FBQzNDLE1BQU0seUJBQXlCLEdBQUcsRUFBRSxDQUFDO0FBQ3JDLE1BQU0seUJBQXlCLEdBQUcsYUFBYSxDQUFDO0FBRWhELElBQVksb0JBWVg7QUFaRCxXQUFZLG9CQUFvQjtJQUM5Qjs7O09BR0c7SUFDSCw2Q0FBcUIsQ0FBQTtJQUVyQjs7O09BR0c7SUFDSCwyQ0FBbUIsQ0FBQTtBQUNyQixDQUFDLEVBWlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFZL0I7QUFFRCxTQUFTLHNCQUFzQixDQUFDLE9BQWU7SUFDN0MsTUFBTSxVQUFVLEdBQUcsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLENBQUMsT0FBTyxD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UG9saWN5LCBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50XCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyLCB0cmltUmVwZWF0ZWRDaGFyU3RhcnQgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuXG5jb25zdCBhcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtdXJpXCI7XG5jb25zdCBmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIgPSBcIngtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlcIjtcbmNvbnN0IGFwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtaG9zdFwiO1xuY29uc3QgZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RcIjtcbmNvbnN0IHNzck9yaWdpbmFsVXJpSGVhZGVycyA9IFthcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciwgZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzck9yaWdpbmFsSG9zdEhlYWRlcnMgPSBbYXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyLCBmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuID0gXCIvX2ZhY2V0aGVvcnkvZGF0YS8qXCI7XG5jb25zdCBzc2dJc3JTc3JEYXRhUGF0aFBhdHRlcm4gPSBcIi9fZmFjZXRoZW9yeS9zc3ItZGF0YS8qXCI7XG5jb25zdCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4ID0gXCJpc3JcIjtcbmNvbnN0IG1heERlZmF1bHRDYWNoZUtleUhlYWRlcnMgPSAxMDtcbmNvbnN0IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgPSBcIngtdGVuYW50LWlkXCI7XG5cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeVNzclNpdGVNb2RlIHtcbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaXMgdGhlIGRlZmF1bHQgb3JpZ2luLiBEaXJlY3QgUzMgYmVoYXZpb3JzIGFyZSB1c2VkIG9ubHkgZm9yXG4gICAqIGltbXV0YWJsZSBhc3NldHMgYW5kIGFueSBleHBsaWNpdGx5IGNvbmZpZ3VyZWQgc3RhdGljIHBhdGggcGF0dGVybnMuXG4gICAqL1xuICBTU1JfT05MWSA9IFwic3NyLW9ubHlcIixcblxuICAvKipcbiAgICogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBTU1IvSVNSIGlzIHRoZSBmYWxsYmFjay4gRmFjZVRoZW9yeSBoeWRyYXRpb25cbiAgICogZGF0YSByb3V0ZXMgYXJlIGtlcHQgb24gUzMgYW5kIHRoZSBlZGdlIHJld3JpdGVzIGV4dGVuc2lvbmxlc3MgcGF0aHMgdG8gYC9pbmRleC5odG1sYC5cbiAgICovXG4gIFNTR19JU1IgPSBcInNzZy1pc3JcIixcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5Ub1VyaVByZWZpeChwYXR0ZXJuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKS5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gIHJldHVybiBub3JtYWxpemVkID8gYC8ke25vcm1hbGl6ZWR9YCA6IFwiL1wiO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoUGF0dGVybnMocGF0dGVybnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICByZXR1cm4gQXJyYXkuZnJvbShcbiAgICBuZXcgU2V0KFxuICAgICAgKEFycmF5LmlzQXJyYXkocGF0dGVybnMpID8gcGF0dGVybnMgOiBbXSlcbiAgICAgICAgLm1hcCgocGF0dGVybikgPT4gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKSlcbiAgICAgICAgLmZpbHRlcigocGF0dGVybikgPT4gcGF0dGVybi5sZW5ndGggPiAwKSxcbiAgICApLFxuICApO1xufVxuXG5mdW5jdGlvbiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4cGFuZGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIik7XG4gICAgaWYgKCFub3JtYWxpemVkKSBjb250aW51ZTtcblxuICAgIGV4cGFuZGVkLmFkZChub3JtYWxpemVkKTtcbiAgICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICBjb25zdCByb290UGF0dGVybiA9IG5vcm1hbGl6ZWQuc2xpY2UoMCwgLTIpO1xuICAgICAgaWYgKHJvb3RQYXR0ZXJuKSB7XG4gICAgICAgIGV4cGFuZGVkLmFkZChyb290UGF0dGVybik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIEFycmF5LmZyb20oZXhwYW5kZWQpO1xufVxuXG5pbnRlcmZhY2UgU2VlbkJlaGF2aW9yUGF0dGVybiB7XG4gIHJlYWRvbmx5IHBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbGFiZWw6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFBhdGhQYXR0ZXJuVHJhbnNpdGlvbiB7XG4gIHJlYWRvbmx5IHRhcmdldDogbnVtYmVyO1xuICByZWFkb25seSBhbnk6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxpdGVyYWw/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuRXBzaWxvbkNsb3N1cmUocGF0dGVybjogc3RyaW5nLCBpbmRleDogbnVtYmVyKTogbnVtYmVyW10ge1xuICBjb25zdCBjbG9zdXJlOiBudW1iZXJbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IHN0YWNrID0gW2luZGV4XTtcblxuICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBzdGFjay5wb3AoKSA/PyAwO1xuICAgIGlmIChzZWVuLmhhcyhjdXJyZW50KSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZW4uYWRkKGN1cnJlbnQpO1xuICAgIGNsb3N1cmUucHVzaChjdXJyZW50KTtcblxuICAgIGlmIChwYXR0ZXJuW2N1cnJlbnRdID09PSBcIipcIikge1xuICAgICAgc3RhY2sucHVzaChjdXJyZW50ICsgMSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGNsb3N1cmU7XG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuVHJhbnNpdGlvbnMocGF0dGVybjogc3RyaW5nLCBpbmRleDogbnVtYmVyKTogUGF0aFBhdHRlcm5UcmFuc2l0aW9uW10ge1xuICBjb25zdCB0b2tlbiA9IHBhdHRlcm5baW5kZXhdO1xuICBpZiAodG9rZW4gPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGlmICh0b2tlbiA9PT0gXCIqXCIpIHtcbiAgICByZXR1cm4gW3sgdGFyZ2V0OiBpbmRleCwgYW55OiB0cnVlIH1dO1xuICB9XG5cbiAgaWYgKHRva2VuID09PSBcIj9cIikge1xuICAgIHJldHVybiBbeyB0YXJnZXQ6IGluZGV4ICsgMSwgYW55OiB0cnVlIH1dO1xuICB9XG5cbiAgcmV0dXJuIFt7IHRhcmdldDogaW5kZXggKyAxLCBhbnk6IGZhbHNlLCBsaXRlcmFsOiB0b2tlbiB9XTtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5UcmFuc2l0aW9uc0NhblNoYXJlQ2hhcmFjdGVyKGxlZnQ6IFBhdGhQYXR0ZXJuVHJhbnNpdGlvbiwgcmlnaHQ6IFBhdGhQYXR0ZXJuVHJhbnNpdGlvbik6IGJvb2xlYW4ge1xuICByZXR1cm4gbGVmdC5hbnkgfHwgcmlnaHQuYW55IHx8IGxlZnQubGl0ZXJhbCA9PT0gcmlnaHQubGl0ZXJhbDtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5zQ2FuT3ZlcmxhcChsZWZ0OiBzdHJpbmcsIHJpZ2h0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgc2VlblN0YXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBxdWV1ZTogQXJyYXk8W251bWJlciwgbnVtYmVyXT4gPSBbXTtcblxuICBjb25zdCBlbnF1ZXVlQ2xvc3VyZVBhaXJzID0gKGxlZnRJbmRleDogbnVtYmVyLCByaWdodEluZGV4OiBudW1iZXIpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGxlZnRDbG9zZWQgb2YgcGF0aFBhdHRlcm5FcHNpbG9uQ2xvc3VyZShsZWZ0LCBsZWZ0SW5kZXgpKSB7XG4gICAgICBmb3IgKGNvbnN0IHJpZ2h0Q2xvc2VkIG9mIHBhdGhQYXR0ZXJuRXBzaWxvbkNsb3N1cmUocmlnaHQsIHJpZ2h0SW5kZXgpKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke2xlZnRDbG9zZWR9OiR7cmlnaHRDbG9zZWR9YDtcbiAgICAgICAgaWYgKHNlZW5TdGF0ZXMuaGFzKGtleSkpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBzZWVuU3RhdGVzLmFkZChrZXkpO1xuICAgICAgICBxdWV1ZS5wdXNoKFtsZWZ0Q2xvc2VkLCByaWdodENsb3NlZF0pO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBlbnF1ZXVlQ2xvc3VyZVBhaXJzKDAsIDApO1xuXG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgW2xlZnRJbmRleCwgcmlnaHRJbmRleF0gPSBxdWV1ZS5zaGlmdCgpID8/IFswLCAwXTtcbiAgICBpZiAobGVmdEluZGV4ID09PSBsZWZ0Lmxlbmd0aCAmJiByaWdodEluZGV4ID09PSByaWdodC5sZW5ndGgpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgbGVmdFRyYW5zaXRpb24gb2YgcGF0aFBhdHRlcm5UcmFuc2l0aW9ucyhsZWZ0LCBsZWZ0SW5kZXgpKSB7XG4gICAgICBmb3IgKGNvbnN0IHJpZ2h0VHJhbnNpdGlvbiBvZiBwYXRoUGF0dGVyblRyYW5zaXRpb25zKHJpZ2h0LCByaWdodEluZGV4KSkge1xuICAgICAgICBpZiAoIXBhdGhQYXR0ZXJuVHJhbnNpdGlvbnNDYW5TaGFyZUNoYXJhY3RlcihsZWZ0VHJhbnNpdGlvbiwgcmlnaHRUcmFuc2l0aW9uKSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZW5xdWV1ZUNsb3N1cmVQYWlycyhsZWZ0VHJhbnNpdGlvbi50YXJnZXQsIHJpZ2h0VHJhbnNpdGlvbi50YXJnZXQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgc2Vlbk93bmVyczogTWFwPHN0cmluZywgc3RyaW5nPixcbiAgc2VlblBhdHRlcm5zOiBTZWVuQmVoYXZpb3JQYXR0ZXJuW10sXG4pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgIGNvbnN0IG93bmVyID0gc2Vlbk93bmVycy5nZXQocGF0dGVybik7XG4gICAgaWYgKG93bmVyICYmIG93bmVyICE9PSBsYWJlbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIHJlY2VpdmVkIG92ZXJsYXBwaW5nIHBhdGggcGF0dGVybiBcIiR7cGF0dGVybn1cIiBmb3IgJHtvd25lcn0gYW5kICR7bGFiZWx9YCk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBzZWVuUGF0dGVybiBvZiBzZWVuUGF0dGVybnMpIHtcbiAgICAgIGlmIChzZWVuUGF0dGVybi5sYWJlbCAhPT0gbGFiZWwgJiYgcGF0aFBhdHRlcm5zQ2FuT3ZlcmxhcChzZWVuUGF0dGVybi5wYXR0ZXJuLCBwYXR0ZXJuKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJucyBcIiR7c2VlblBhdHRlcm4ucGF0dGVybn1cIiBhbmQgXCIke3BhdHRlcm59XCIgZm9yICR7c2VlblBhdHRlcm4ubGFiZWx9IGFuZCAke2xhYmVsfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgc2Vlbk93bmVycy5zZXQocGF0dGVybiwgbGFiZWwpO1xuICAgIHNlZW5QYXR0ZXJucy5wdXNoKHsgcGF0dGVybiwgbGFiZWwgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2Fub25pY2FsaXplSGVhZGVyTmFtZShoZWFkZXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcoaGVhZGVyKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuZnVuY3Rpb24gaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBjYW5vbmljYWxpemVIZWFkZXJOYW1lKGhlYWRlcikucmVwbGFjZSgvW15hLXowLTldKy9nLCBcIi1cIik7XG4gIHJldHVybiBub3JtYWxpemVkID09PSBkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyIHx8IC8oXnwtKXRlbmFudCgtfCQpLy50ZXN0KG5vcm1hbGl6ZWQpO1xufVxuXG5mdW5jdGlvbiBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHNjb3BlOiBDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgY29uc3QgcmVnaW9uID0gU3RhY2sub2Yoc2NvcGUpLnJlZ2lvbjtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQocmVnaW9uKSAmJiByZWdpb24gPT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5U3NyU2l0ZSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIHByb3BzLmNlcnRpZmljYXRlQXJuIGZvciBzdGFja3MgaW4gb3RoZXIgb3IgZW52aXJvbm1lbnQtYWdub3N0aWMgcmVnaW9ucy5gLFxuICApO1xufVxuXG5mdW5jdGlvbiBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoXG4gIG1vZGU6IEFwcFRoZW9yeVNzclNpdGVNb2RlLFxuICByYXdTM1BhdGhQYXR0ZXJuczogc3RyaW5nW10sXG4gIGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnM6IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3UzNQcmVmaXhlcyA9IHJhd1MzUGF0aFBhdHRlcm5zLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KS5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgcmF3UzNQcmVmaXhMaXN0ID0gcmF3UzNQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG4gIGNvbnN0IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBsYW1iZGFQYXNzdGhyb3VnaFBhdGhQYXR0ZXJuc1xuICAgIC5tYXAocGF0aFBhdHRlcm5Ub1VyaVByZWZpeClcbiAgICAuc29ydCgoYSwgYikgPT4gYi5sZW5ndGggLSBhLmxlbmd0aCk7XG4gIGNvbnN0IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4TGlzdCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubWFwKChwcmVmaXgpID0+IGAnJHtwcmVmaXh9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuICBjb25zdCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyTGlzdCA9IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLm1hcCgoaGVhZGVyKSA9PiBgJyR7aGVhZGVyfSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcblxuICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHJlcXVlc3QuaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycyB8fCB7fTtcblx0ICB2YXIgaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycztcblx0ICB2YXIgdXJpID0gcmVxdWVzdC51cmkgfHwgJy8nO1xuXHQgIHZhciBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyA9IFtcblx0ICAgICR7YmxvY2tlZFZpZXdlclRlbmFudEhlYWRlckxpc3R9XG5cdCAgXTtcblxuXHQgIGZvciAodmFyIGJsb2NrZWRJbmRleCA9IDA7IGJsb2NrZWRJbmRleCA8IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLmxlbmd0aDsgYmxvY2tlZEluZGV4KyspIHtcblx0ICAgIGRlbGV0ZSBoZWFkZXJzW2Jsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzW2Jsb2NrZWRJbmRleF1dO1xuXHQgIH1cblxuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gJ3JlcV8nICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyAnXycgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCk7XG5cdCAgfVxuXG5cdCAgaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyfSddID0geyB2YWx1ZTogdXJpIH07XG5cdCAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblxuXHQgIGlmIChoZWFkZXJzLmhvc3QgJiYgaGVhZGVycy5ob3N0LnZhbHVlKSB7XG5cdCAgICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcn0nXSA9IHsgdmFsdWU6IGhlYWRlcnMuaG9zdC52YWx1ZSB9O1xuXHQgICAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgfVxuXG5cdCAgaWYgKCcke21vZGV9JyA9PT0gJyR7QXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUn0nKSB7XG5cdCAgICB2YXIgcmF3UzNQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtyYXdTM1ByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBbXG5cdCAgICAgICR7bGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0fVxuXHQgICAgXTtcblx0ICAgIHZhciBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IGZhbHNlO1xuXG5cdCAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubGVuZ3RoOyBpKyspIHtcblx0ICAgICAgdmFyIHByZWZpeCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXNbaV07XG5cdCAgICAgIGlmICh1cmkgPT09IHByZWZpeCB8fCB1cmkuc3RhcnRzV2l0aChwcmVmaXggKyAnLycpKSB7XG5cdCAgICAgICAgaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGggPSB0cnVlO1xuXHQgICAgICAgIGJyZWFrO1xuXHQgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIGlmICghaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGgpIHtcblx0ICAgICAgdmFyIGlzUmF3UzNQYXRoID0gZmFsc2U7XG5cblx0ICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCByYXdTM1ByZWZpeGVzLmxlbmd0aDsgaisrKSB7XG5cdCAgICAgICAgdmFyIHJhd1ByZWZpeCA9IHJhd1MzUHJlZml4ZXNbal07XG5cdCAgICAgICAgaWYgKHVyaSA9PT0gcmF3UHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHJhd1ByZWZpeCArICcvJykpIHtcblx0ICAgICAgICAgIGlzUmF3UzNQYXRoID0gdHJ1ZTtcblx0ICAgICAgICAgIGJyZWFrO1xuXHQgICAgICAgIH1cblx0ICAgICAgfVxuXG5cdCAgICAgIHZhciBsYXN0U2xhc2ggPSB1cmkubGFzdEluZGV4T2YoJy8nKTtcblx0ICAgICAgdmFyIGxhc3RTZWdtZW50ID0gbGFzdFNsYXNoID49IDAgPyB1cmkuc3Vic3RyaW5nKGxhc3RTbGFzaCArIDEpIDogdXJpO1xuXG5cdCAgICAgIGlmICghaXNSYXdTM1BhdGggJiYgbGFzdFNlZ21lbnQuaW5kZXhPZignLicpID09PSAtMSkge1xuXHQgICAgICAgIHJlcXVlc3QudXJpID0gdXJpLmVuZHNXaXRoKCcvJykgPyB1cmkgKyAnaW5kZXguaHRtbCcgOiB1cmkgKyAnL2luZGV4Lmh0bWwnO1xuXHQgICAgICB9XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlcXVlc3Q7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvbkNvZGUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgcmVzcG9uc2UgPSBldmVudC5yZXNwb25zZTtcblx0ICB2YXIgcmVxdWVzdElkSGVhZGVyID0gcmVxdWVzdC5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAocmVxdWVzdElkKSB7XG5cdCAgICByZXNwb25zZS5oZWFkZXJzID0gcmVzcG9uc2UuaGVhZGVycyB8fCB7fTtcblx0ICAgIGlmICghcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10pIHtcblx0ICAgICAgcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVzcG9uc2U7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZVByb3BzIHtcbiAgcmVhZG9ubHkgc3NyRnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IGRlcGxveW1lbnQgbW9kZSBmb3IgdGhlIHNpdGUgdG9wb2xvZ3kuXG4gICAqXG4gICAqIC0gYHNzci1vbmx5YDogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpcyB0aGUgZGVmYXVsdCBvcmlnaW5cbiAgICogLSBgc3NnLWlzcmA6IFMzIGlzIHRoZSBwcmltYXJ5IEhUTUwgb3JpZ2luIGFuZCBMYW1iZGEgaXMgdGhlIGZhbGxiYWNrXG4gICAqXG4gICAqIEV4aXN0aW5nIGltcGxpY2l0IGJlaGF2aW9yIG1hcHMgdG8gYHNzci1vbmx5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFlcbiAgICovXG4gIHJlYWRvbmx5IG1vZGU/OiBBcHBUaGVvcnlTc3JTaXRlTW9kZTtcblxuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpbnZva2UgbW9kZSBmb3IgdGhlIFNTUiBvcmlnaW4uXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTVxuICAgKi9cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xuXG4gIC8qKlxuICAgKiBGdW5jdGlvbiBVUkwgYXV0aCB0eXBlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IGZhaWxzIGNsb3NlZCB0byBgQVdTX0lBTWAgYW5kIHNpZ25zIENsb3VkRnJvbnQtdG8tTGFtYmRhXG4gICAqIHRyYWZmaWMgd2l0aCBsYW1iZGEgT3JpZ2luIEFjY2VzcyBDb250cm9sLlxuICAgKlxuICAgKiBTZXQgdGhpcyBleHBsaWNpdGx5IHRvIGBOT05FYCBvbmx5IHdoZW4geW91IGludGVudGlvbmFsbHkgcmVxdWlyZSBwdWJsaWNcbiAgICogZGlyZWN0IEZ1bmN0aW9uIFVSTCBhY2Nlc3MgYXMgYSBkZWxpYmVyYXRlIGNvbXBhdGliaWxpdHkgY2hvaWNlLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNXG4gICAqL1xuICByZWFkb25seSBzc3JVcmxBdXRoVHlwZT86IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlO1xuXG4gIHJlYWRvbmx5IGFzc2V0c0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHJlYWRvbmx5IGFzc2V0c1BhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFzc2V0c0tleVByZWZpeD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzTWFuaWZlc3RLZXk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCB1c2VkIGJ5IEZhY2VUaGVvcnkgSVNSIEhUTUwgc3RvcmFnZSAoYFMzSHRtbFN0b3JlYCkuXG4gICAqXG4gICAqIFdoZW4gcHJvdmlkZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIFNTUiBmdW5jdGlvbiByZWFkL3dyaXRlIGFjY2VzcyBhbmQgd2lyZXM6XG4gICAqIC0gYEZBQ0VUSEVPUllfSVNSX0JVQ0tFVGBcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfUFJFRklYYFxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbFN0b3JlQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogUzMga2V5IHByZWZpeCB1c2VkIGJ5IEZhY2VUaGVvcnkgSVNSIEhUTUwgc3RvcmFnZS5cbiAgICogQGRlZmF1bHQgaXNyXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVLZXlQcmVmaXg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgZXh0ZW5zaW9ubGVzcyBIVE1MIHNlY3Rpb24gcGF0aCBwYXR0ZXJucyB0byByb3V0ZSBkaXJlY3RseSB0byB0aGUgcHJpbWFyeSBIVE1MIFMzIG9yaWdpbi5cbiAgICpcbiAgICogUmVxdWVzdHMgbGlrZSBgL21hcmtldGluZ2AgYW5kIGAvbWFya2V0aW5nLy4uLmAgYXJlIHJld3JpdHRlbiB0byBgL2luZGV4Lmh0bWxgXG4gICAqIHdpdGhpbiB0aGUgc2VjdGlvbiBhbmQgc3RheSBvbiBTMyBpbnN0ZWFkIG9mIGZhbGxpbmcgYmFjayB0byBMYW1iZGEuXG4gICAqXG4gICAqIEV4YW1wbGUgZGlyZWN0LVMzIEhUTUwgc2VjdGlvbiBwYXRoOiBcIi9tYXJrZXRpbmcvKlwiXG4gICAqL1xuICByZWFkb25seSBzdGF0aWNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCByYXcgUzMgb2JqZWN0L2RhdGEgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgZXh0ZW5zaW9ubGVzcyBIVE1MIHJld3JpdGVzLlxuICAgKlxuICAgKiBJbiBgc3NnLWlzcmAgbW9kZSwgYC9fZmFjZXRoZW9yeS9kYXRhLypgIGlzIGFkZGVkIGF1dG9tYXRpY2FsbHkuXG4gICAqIEV4YW1wbGUgZGlyZWN0LVMzIG9iamVjdCBwYXRoOiBcIi9mZWVkcy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IGRpcmVjdFMzUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgdGhlIGBzc2ctaXNyYCBvcmlnaW4gZ3JvdXAgYW5kIHJvdXRlIGRpcmVjdGx5XG4gICAqIHRvIHRoZSBMYW1iZGEgRnVuY3Rpb24gVVJMIHdpdGggZnVsbCBtZXRob2Qgc3VwcG9ydC5cbiAgICpcbiAgICogSW4gYHNzZy1pc3JgIG1vZGUsIGAvX2ZhY2V0aGVvcnkvc3NyLWRhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseSBmb3IgRmFjZVRoZW9yeVxuICAgKiBzdHJpY3Qgbm8taW5saW5lLUNTUCBTU1IgaHlkcmF0aW9uIHNpZGVjYXJzLlxuICAgKlxuICAgKiBVc2UgdGhpcyBmb3Igc2FtZS1vcmlnaW4gZHluYW1pYyBwYXRocyBzdWNoIGFzIGF1dGggY2FsbGJhY2tzLCBhY3Rpb25zLCBvciBmb3JtIHBvc3RzLlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TU1IgcGF0aDogXCIvYWN0aW9ucy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHNzclBhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGJlYXJlci1hdXRoIExhbWJkYSBGdW5jdGlvbiBVUkwgY28tb3JpZ2lucyB0byBhdHRhY2ggdG8gdGhlIHNhbWUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIGVhY2ggY28tb3JpZ2luIEZ1bmN0aW9uIFVSTCB3aXRoIGBBdXRoVHlwZS5OT05FYCBhbmQgcm91dGVzIHRoZSBzdXBwbGllZFxuICAgKiBwYXRoIHBhdHRlcm5zIHRvIGl0IHdpdGhvdXQgTGFtYmRhIE9yaWdpbiBBY2Nlc3MgQ29udHJvbC4gVGhlIFNTUiBvcmlnaW4gcmVtYWlucyBnb3Zlcm5lZCBieVxuICAgKiBgc3NyVXJsQXV0aFR5cGVgIGFuZCBzdGlsbCBkZWZhdWx0cyB0byBgQVdTX0lBTWAgcGx1cyBMYW1iZGEgT0FDLlxuICAgKlxuICAgKiBDby1vcmlnaW4gcGF0aHMgcGFydGljaXBhdGUgaW4gQXBwVGhlb3J5J3MgYmVoYXZpb3IgcGF0aCBjb2xsaXNpb24gY2hlY2tzIGFuZCBieXBhc3MgYHNzZy1pc3JgXG4gICAqIEhUTUwgcmV3cml0ZXMuIFRoaXMgaXMgdGhlIHN1cHBvcnRlZCBBcHBUaGVvcnkgcGF0aCBmb3IgbWl4ZWQtYXV0aCBkaXN0cmlidXRpb25zOyBkbyBub3QgaGFuZC13aXJlXG4gICAqIHJhdyBgZGlzdHJpYnV0aW9uLmFkZEJlaGF2aW9yKC4uLilgIGNhbGxzIHdoZW4gQXBwVGhlb3J5IHNob3VsZCBvd24gcGF0aCBhbmQgZWRnZS1jb250ZXh0IHBvbGljeS5cbiAgICpcbiAgICogRXhhbXBsZSBiZWFyZXIgQVBJIHBhdGhzOiBgW1wiL2FwaS8qXCIsIFwiL2F1dGgvKlwiXWAuXG4gICAqL1xuICByZWFkb25seSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnM/OiBBcHBUaGVvcnlTc3JTaXRlQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5bXTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgVGFibGVUaGVvcnkvRHluYW1vREIgdGFibGUgdXNlZCBmb3IgRmFjZVRoZW9yeSBJU1IgbWV0YWRhdGEgYW5kIGxlYXNlIGNvb3JkaW5hdGlvbi5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlcyB0aGVcbiAgICogbWV0YWRhdGEgdGFibGUgYWxpYXNlcyBleHBlY3RlZCBieSB0aGUgZG9jdW1lbnRlZCBGYWNlVGhlb3J5IGRlcGxveW1lbnQgc2hhcGUuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBJU1IvY2FjaGUgbWV0YWRhdGEgdGFibGUgbmFtZSB0byB3aXJlIHdoZW4geW91IGFyZSBub3QgcGFzc2luZyBgaXNyTWV0YWRhdGFUYWJsZWAuXG4gICAqXG4gICAqIFByZWZlciBgaXNyTWV0YWRhdGFUYWJsZWAgd2hlbiBBcHBUaGVvcnkgc2hvdWxkIGFsc28gZ3JhbnQgYWNjZXNzIHRvIHRoZSBTU1IgTGFtYmRhLlxuICAgKi9cbiAgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExlZ2FjeSBhbGlhcyBmb3IgYGlzck1ldGFkYXRhVGFibGVOYW1lYC5cbiAgICogQGRlcHJlY2F0ZWQgcHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCBvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgXG4gICAqL1xuICByZWFkb25seSBjYWNoZVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvLyBXaGVuIHRydWUgKGRlZmF1bHQpLCBBcHBUaGVvcnkgd2lyZXMgcmVjb21tZW5kZWQgcnVudGltZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgb250byB0aGUgU1NSIGZ1bmN0aW9uLlxuICByZWFkb25seSB3aXJlUnVudGltZUVudj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgaGVhZGVycyB0byBmb3J3YXJkIHRvIHRoZSBTU1Igb3JpZ2luIChMYW1iZGEgRnVuY3Rpb24gVVJMKSB2aWEgdGhlIG9yaWdpbiByZXF1ZXN0IHBvbGljeS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5L0ZhY2VUaGVvcnktc2FmZSBlZGdlIGNvbnRyYWN0IGZvcndhcmRzIG9ubHk6XG4gICAqIC0gYGNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvYFxuICAgKiAtIGBjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzYFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWZhY2V0aGVvcnktb3JpZ2luYWwtdXJpYFxuICAgKiAtIGB4LXJlcXVlc3QtaWRgXG4gICAqXG4gICAqIFVzZSB0aGlzIHRvIG9wdCBpbiB0byBhZGRpdGlvbmFsIGFwcC1zcGVjaWZpYyBoZWFkZXJzIHN1Y2ggYXNcbiAgICogYHgtZmFjZXRoZW9yeS1zZWdtZW50YC4gVGVuYW50LWxpa2Ugdmlld2VyIGhlYWRlcnMgYXJlIHJlamVjdGVkIHVubGVzc1xuICAgKiBgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzYCBpcyBleHBsaWNpdGx5IGVuYWJsZWQgYXMgYSBjb21wYXRpYmlsaXR5IG1vZGUuXG4gICAqIGBob3N0YCBhbmQgYHgtZm9yd2FyZGVkLXByb3RvYCBhcmUgcmVqZWN0ZWQgYmVjYXVzZSB0aGV5IGJyZWFrIG9yIGJ5cGFzcyB0aGVcbiAgICogc3VwcG9ydGVkIG9yaWdpbiBtb2RlbC5cbiAgICovXG4gIHJlYWRvbmx5IHNzckZvcndhcmRIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIENvbXBhdGliaWxpdHkgZXNjYXBlIGhhdGNoIGZvciBsZWdhY3kgdmlld2VyLXN1cHBsaWVkIHRlbmFudCBoZWFkZXJzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlIChkZWZhdWx0KSwgQXBwVGhlb3J5IHN0cmlwcyBgeC10ZW5hbnQtaWRgIGF0IHRoZSBlZGdlIGFuZCByZWplY3RzXG4gICAqIHRlbmFudC1saWtlIGVudHJpZXMgaW4gYHNzckZvcndhcmRIZWFkZXJzYCBzbyB2aWV3ZXItc3VwcGxpZWQgdGVuYW50IGhlYWRlcnNcbiAgICogY2Fubm90IGluZmx1ZW5jZSBvcmlnaW4gcm91dGluZyBvciBIVE1MIGNhY2hlIHBhcnRpdGlvbmluZy4gV2hlbiB0cnVlLFxuICAgKiBBcHBUaGVvcnkgcmVzdG9yZXMgbGVnYWN5IHBhc3N0aHJvdWdoIGJlaGF2aW9yIGZvciBgeC10ZW5hbnQtaWRgIGFuZCBhbnlcbiAgICogdGVuYW50LWxpa2UgYHNzckZvcndhcmRIZWFkZXJzYC5cbiAgICpcbiAgICogUHJlZmVyIGRlcml2aW5nIHRlbmFudCBmcm9tIHRydXN0ZWQgaG9zdCBtYXBwaW5nIHVzaW5nIHRoZSBvcmlnaW5hbC1ob3N0XG4gICAqIGVkZ2UgaGVhZGVycyBpbnN0ZWFkIG9mIGVuYWJsaW5nIHBhc3N0aHJvdWdoLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPzogYm9vbGVhbjtcblxuICByZWFkb25seSBlbmFibGVMb2dnaW5nPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgLyoqXG4gICAqIENsb3VkRnJvbnQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgYXBwbGllZCB0byBTU1IgYW5kIGRpcmVjdC1TMyBiZWhhdmlvcnMuXG4gICAqXG4gICAqIElmIG9taXR0ZWQsIEFwcFRoZW9yeSBwcm92aXNpb25zIGEgRmFjZVRoZW9yeS1hbGlnbmVkIGJhc2VsaW5lIHBvbGljeSBhdCB0aGUgQ0ROXG4gICAqIGxheWVyOiBIU1RTLCBub3NuaWZmLCBmcmFtZS1vcHRpb25zLCByZWZlcnJlci1wb2xpY3ksIFhTUyBwcm90ZWN0aW9uLCBhbmQgYVxuICAgKiByZXN0cmljdGl2ZSBwZXJtaXNzaW9ucy1wb2xpY3kuIENvbnRlbnQtU2VjdXJpdHktUG9saWN5IHJlbWFpbnMgb3JpZ2luLWRlZmluZWQuXG4gICAqL1xuICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgLyoqXG4gICAqIENhY2hlIHBvbGljeSBhcHBsaWVkIHRvIGRpcmVjdCBMYW1iZGEtYmFja2VkIFNTUiBiZWhhdmlvcnMuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IGlzIGBDQUNISU5HX0RJU0FCTEVEYCBzbyBkeW5hbWljIExhbWJkYSByb3V0ZXMgc3RheSBzYWZlIHVubGVzcyB5b3VcbiAgICogaW50ZW50aW9uYWxseSBvcHQgaW50byBhIGNhY2hlIHBvbGljeSB0aGF0IG1hdGNoZXMgeW91ciBhcHAncyB2YXJpYW5jZSBtb2RlbC5cbiAgICogQGRlZmF1bHQgY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVEXG4gICAqL1xuICByZWFkb25seSBzc3JDYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gIC8qKlxuICAgKiBDYWNoZSBwb2xpY3kgYXBwbGllZCB0byB0aGUgY2FjaGVhYmxlIEhUTUwgYmVoYXZpb3IgaW4gYHNzZy1pc3JgIG1vZGUuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IEFwcFRoZW9yeSBwb2xpY3kga2V5cyBvbiBxdWVyeSBzdHJpbmdzIHBsdXMgdGhlIHN0YWJsZSBwdWJsaWMgSFRNTFxuICAgKiB2YXJpYW50IGhlYWRlcnMgKGB4LSotb3JpZ2luYWwtaG9zdGAgYW5kIGFueSBub24tdGVuYW50IGV4dHJhIGZvcndhcmRlZFxuICAgKiBoZWFkZXJzIHlvdSBvcHQgaW50bykgd2hpbGUgbGVhdmluZyBjb29raWVzIG91dCBvZiB0aGUgY2FjaGUga2V5LiBUZW5hbnQtbGlrZVxuICAgKiB2aWV3ZXIgaGVhZGVycyBqb2luIHRoZSBjYWNoZSBrZXkgb25seSB3aGVuIGBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNgIGlzXG4gICAqIGV4cGxpY2l0bHkgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IGh0bWxDYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZG9tYWluTmFtZT86IHN0cmluZztcbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIEROUyByZWNvcmRzIGFuZCBvcHRpb25hbCBjZXJ0aWZpY2F0ZSB2YWxpZGF0aW9uLlxuICAgKlxuICAgKiBXaGVuIGBkb21haW5OYW1lYCBpcyBzZXQgd2l0aG91dCBgY2VydGlmaWNhdGVBcm5gLCBob3N0ZWQtem9uZSBjZXJ0aWZpY2F0ZVxuICAgKiBjcmVhdGlvbiBpcyBhbGxvd2VkIG9ubHkgZm9yIHN0YWNrcyB3aG9zZSByZWdpb24gaXMgZXhwbGljaXRseSBgdXMtZWFzdC0xYC5cbiAgICogQ2xvdWRGcm9udCByZXF1aXJlcyB2aWV3ZXIgY2VydGlmaWNhdGVzIGluIGB1cy1lYXN0LTFgOyBlbnZpcm9ubWVudC1hZ25vc3RpY1xuICAgKiBvciBvdGhlci1yZWdpb24gc3RhY2tzIG11c3QgcHJvdmlkZSBgY2VydGlmaWNhdGVBcm5gLlxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIC8qKlxuICAgKiBFeGlzdGluZyBBQ00gY2VydGlmaWNhdGUgQVJOIGZvciB0aGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAqXG4gICAqIFRoZSBjZXJ0aWZpY2F0ZSBtdXN0IGJlIGluIGB1cy1lYXN0LTFgIGZvciBDbG91ZEZyb250LlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgcmVhZG9ubHkgd2ViQWNsSWQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZUJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luIHtcbiAgLyoqXG4gICAqIExhbWJkYSBmdW5jdGlvbiB0aGF0IEFwcFRoZW9yeSBleHBvc2VzIGFzIGEgYmVhcmVyLWF1dGggRnVuY3Rpb24gVVJMIGNvLW9yaWdpbi5cbiAgICpcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgdGhlIEZ1bmN0aW9uIFVSTCB3aXRoIGBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5OT05FYDsgYXV0aGVudGljYXRpb24gcmVtYWluc1xuICAgKiB0aGUgcmVzcG9uc2liaWxpdHkgb2YgdGhlIExhbWJkYSBoYW5kbGVyLlxuICAgKi9cbiAgcmVhZG9ubHkgZnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIENsb3VkRnJvbnQgcGF0aCBwYXR0ZXJucyB0aGF0IHJvdXRlIHRvIHRoaXMgY28tb3JpZ2luLlxuICAgKlxuICAgKiBQYXR0ZXJucyBhcmUgbm9ybWFsaXplZCB0aGUgc2FtZSB3YXkgYXMgYHNzclBhdGhQYXR0ZXJuc2AuIEEgcGF0dGVybiBlbmRpbmcgaW4gYC8qYCBhbHNvIGNyZWF0ZXNcbiAgICogYSByb290IGJlaGF2aW9yIHdpdGhvdXQgdGhlIHdpbGRjYXJkIHNvIGAvYXBpLypgIGNvdmVycyBib3RoIGAvYXBpYCBhbmQgYC9hcGkvLi4uYC5cbiAgICovXG4gIHJlYWRvbmx5IHBhdGhQYXR0ZXJuczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaW52b2tlIG1vZGUgZm9yIHRoaXMgY28tb3JpZ2luLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuSW52b2tlTW9kZS5CVUZGRVJFRFxuICAgKi9cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5U3NyU2l0ZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNCdWNrZXQ6IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNLZXlQcmVmaXg6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c01hbmlmZXN0S2V5OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgaHRtbFN0b3JlS2V5UHJlZml4Pzogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgc3NyVXJsOiBsYW1iZGEuRnVuY3Rpb25Vcmw7XG4gIHB1YmxpYyByZWFkb25seSBiZWFyZXJGdW5jdGlvblVybHM6IGxhbWJkYS5GdW5jdGlvblVybFtdO1xuICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcbiAgcHVibGljIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlTc3JTaXRlUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKCFwcm9wcz8uc3NyRnVuY3Rpb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgcHJvcHMuc3NyRnVuY3Rpb25cIik7XG4gICAgfVxuXG4gICAgY29uc3Qgc2l0ZU1vZGUgPSBwcm9wcy5tb2RlID8/IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTUl9PTkxZO1xuICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgY29uc3Qgd2lyZVJ1bnRpbWVFbnYgPSBwcm9wcy53aXJlUnVudGltZUVudiA/PyB0cnVlO1xuXG4gICAgdGhpcy5hc3NldHNCdWNrZXQgPVxuICAgICAgcHJvcHMuYXNzZXRzQnVja2V0ID8/XG4gICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQXNzZXRzQnVja2V0XCIsIHtcbiAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcbiAgICBpZiAoZW5hYmxlTG9nZ2luZykge1xuICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBhc3NldHNQcmVmaXhSYXcgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhwcm9wcy5hc3NldHNLZXlQcmVmaXggPz8gXCJhc3NldHNcIikudHJpbSgpLCBcIi9cIik7XG4gICAgY29uc3QgYXNzZXRzS2V5UHJlZml4ID0gYXNzZXRzUHJlZml4UmF3IHx8IFwiYXNzZXRzXCI7XG5cbiAgICBjb25zdCBtYW5pZmVzdFJhdyA9IFN0cmluZyhwcm9wcy5hc3NldHNNYW5pZmVzdEtleSA/PyBgJHthc3NldHNLZXlQcmVmaXh9L21hbmlmZXN0Lmpzb25gKS50cmltKCk7XG4gICAgY29uc3QgbWFuaWZlc3RLZXkgPSB0cmltUmVwZWF0ZWRDaGFyKG1hbmlmZXN0UmF3LCBcIi9cIik7XG4gICAgY29uc3QgYXNzZXRzTWFuaWZlc3RLZXkgPSBtYW5pZmVzdEtleSB8fCBgJHthc3NldHNLZXlQcmVmaXh9L21hbmlmZXN0Lmpzb25gO1xuXG4gICAgdGhpcy5hc3NldHNLZXlQcmVmaXggPSBhc3NldHNLZXlQcmVmaXg7XG4gICAgdGhpcy5hc3NldHNNYW5pZmVzdEtleSA9IGFzc2V0c01hbmlmZXN0S2V5O1xuXG4gICAgY29uc3QgaHRtbFN0b3JlS2V5UHJlZml4SW5wdXQgPSBTdHJpbmcocHJvcHMuaHRtbFN0b3JlS2V5UHJlZml4ID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBzaG91bGRDb25maWd1cmVIdG1sU3RvcmUgPSBCb29sZWFuKHByb3BzLmh0bWxTdG9yZUJ1Y2tldCkgfHwgaHRtbFN0b3JlS2V5UHJlZml4SW5wdXQubGVuZ3RoID4gMDtcbiAgICBpZiAoc2hvdWxkQ29uZmlndXJlSHRtbFN0b3JlKSB7XG4gICAgICBjb25zdCBodG1sU3RvcmVQcmVmaXhSYXcgPSB0cmltUmVwZWF0ZWRDaGFyKFxuICAgICAgICBTdHJpbmcocHJvcHMuaHRtbFN0b3JlS2V5UHJlZml4ID8/IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXgpLnRyaW0oKSxcbiAgICAgICAgXCIvXCIsXG4gICAgICApO1xuICAgICAgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXggPSBodG1sU3RvcmVQcmVmaXhSYXcgfHwgZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeDtcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0ID1cbiAgICAgICAgcHJvcHMuaHRtbFN0b3JlQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJIdG1sU3RvcmVCdWNrZXRcIiwge1xuICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5pc3JNZXRhZGF0YVRhYmxlID0gcHJvcHMuaXNyTWV0YWRhdGFUYWJsZTtcblxuICAgIGNvbnN0IGV4cGxpY2l0SXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuaXNyTWV0YWRhdGFUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IGxlZ2FjeUNhY2hlVGFibGVOYW1lID0gU3RyaW5nKHByb3BzLmNhY2hlVGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCByZXNvdXJjZUlzck1ldGFkYXRhVGFibGVOYW1lID0gU3RyaW5nKHRoaXMuaXNyTWV0YWRhdGFUYWJsZT8udGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcblxuICAgIGNvbnN0IGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgW3Jlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUsIGV4cGxpY2l0SXNyTWV0YWRhdGFUYWJsZU5hbWUsIGxlZ2FjeUNhY2hlVGFibGVOYW1lXS5maWx0ZXIoXG4gICAgICAgICAgKG5hbWUpID0+IFN0cmluZyhuYW1lKS50cmltKCkubGVuZ3RoID4gMCxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIGlmIChjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzLmxlbmd0aCA+IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgY29uZmxpY3RpbmcgSVNSIG1ldGFkYXRhIHRhYmxlIG5hbWVzOiAke2NvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGlzck1ldGFkYXRhVGFibGVOYW1lID0gY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lc1swXSA/PyBcIlwiO1xuXG4gICAgaWYgKHByb3BzLmFzc2V0c1BhdGgpIHtcbiAgICAgIG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsIFwiQXNzZXRzRGVwbG95bWVudFwiLCB7XG4gICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQocHJvcHMuYXNzZXRzUGF0aCldLFxuICAgICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5hc3NldHNCdWNrZXQsXG4gICAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiBhc3NldHNLZXlQcmVmaXgsXG4gICAgICAgIHBydW5lOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhdGljUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKHByb3BzLnN0YXRpY1BhdGhQYXR0ZXJucyk7XG4gICAgY29uc3QgZGlyZWN0UzNQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMoW1xuICAgICAgLi4uKHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gW3NzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zKSA/IHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IHNzclBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhbXG4gICAgICAuLi4oc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBbc3NnSXNyU3NyRGF0YVBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLnNzclBhdGhQYXR0ZXJucykgPyBwcm9wcy5zc3JQYXRoUGF0dGVybnMgOiBbXSksXG4gICAgXSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zID0gQXJyYXkuaXNBcnJheShwcm9wcy5iZWFyZXJGdW5jdGlvblVybE9yaWdpbnMpXG4gICAgICA/IHByb3BzLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1xuICAgICAgOiBbXTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MgPSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMubWFwKChvcmlnaW4sIGluZGV4KSA9PiB7XG4gICAgICBpZiAoIW9yaWdpbj8uZnVuY3Rpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1ske2luZGV4fV0gcmVxdWlyZXMgZnVuY3Rpb25gKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhvcmlnaW4ucGF0aFBhdHRlcm5zKTtcbiAgICAgIGlmIChwYXRoUGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5U3NyU2l0ZSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnNbJHtpbmRleH1dIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBwYXRoIHBhdHRlcm5gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IG9yaWdpbiwgcGF0aFBhdHRlcm5zIH07XG4gICAgfSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxQYXRoUGF0dGVybnMgPSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZmxhdE1hcCgoY29uZmlnKSA9PiBjb25maWcucGF0aFBhdHRlcm5zKTtcbiAgICBjb25zdCBiZWhhdmlvclBhdHRlcm5Pd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybnM6IFNlZW5CZWhhdmlvclBhdHRlcm5bXSA9IFtdO1xuICAgIGNvbnN0IHNzclVybEF1dGhUeXBlID0gcHJvcHMuc3NyVXJsQXV0aFR5cGUgPz8gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTTtcbiAgICBjb25zdCBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMgPSBwcm9wcy5hbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMgPz8gZmFsc2U7XG5cbiAgICB0aGlzLnNzclVybCA9IG5ldyBsYW1iZGEuRnVuY3Rpb25VcmwodGhpcywgXCJTc3JVcmxcIiwge1xuICAgICAgZnVuY3Rpb246IHByb3BzLnNzckZ1bmN0aW9uLFxuICAgICAgYXV0aFR5cGU6IHNzclVybEF1dGhUeXBlLFxuICAgICAgaW52b2tlTW9kZTogcHJvcHMuaW52b2tlTW9kZSA/PyBsYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzc3JPcmlnaW4gPVxuICAgICAgc3NyVXJsQXV0aFR5cGUgPT09IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICAgICAgPyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuc3NyVXJsKVxuICAgICAgICA6IG5ldyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luKHRoaXMuc3NyVXJsKTtcblxuICAgIGNvbnN0IGFzc2V0c09yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5hc3NldHNCdWNrZXQpO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5CdWNrZXQgPSB0aGlzLmh0bWxTdG9yZUJ1Y2tldCA/PyB0aGlzLmFzc2V0c0J1Y2tldDtcbiAgICBjb25zdCBodG1sT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChcbiAgICAgIGh0bWxPcmlnaW5CdWNrZXQsXG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldCAmJiB0aGlzLmh0bWxTdG9yZUtleVByZWZpeFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIG9yaWdpblBhdGg6IGAvJHt0aGlzLmh0bWxTdG9yZUtleVByZWZpeH1gLFxuICAgICAgICAgIH1cbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgKTtcblxuICAgIGNvbnN0IGJhc2VTc3JGb3J3YXJkSGVhZGVycyA9IFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxIb3N0SGVhZGVycyxcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgXTtcblxuICAgIGNvbnN0IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IG5ldyBTZXQoW1wiaG9zdFwiLCBcIngtZm9yd2FyZGVkLXByb3RvXCJdKTtcblxuICAgIGNvbnN0IGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5pc0FycmF5KHByb3BzLnNzckZvcndhcmRIZWFkZXJzKVxuICAgICAgPyBwcm9wcy5zc3JGb3J3YXJkSGVhZGVycy5tYXAoY2Fub25pY2FsaXplSGVhZGVyTmFtZSkuZmlsdGVyKChoZWFkZXIpID0+IGhlYWRlci5sZW5ndGggPiAwKVxuICAgICAgOiBbXTtcblxuICAgIGNvbnN0IHJlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSkpLFxuICAgICkuc29ydCgpO1xuXG4gICAgaWYgKHJlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRpc2FsbG93cyBzc3JGb3J3YXJkSGVhZGVyczogJHtyZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcikpKSxcbiAgICApLnNvcnQoKTtcblxuICAgIGlmIChyZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVycy5sZW5ndGggPiAwICYmICFhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPXRydWUgZm9yIHRlbmFudC1saWtlIHNzckZvcndhcmRIZWFkZXJzOiAke3JlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB0ZW5hbnRQYXNzdGhyb3VnaEhlYWRlcnMgPSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNcbiAgICAgID8gQXJyYXkuZnJvbShuZXcgU2V0KFtkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyLCAuLi5yZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVyc10pKVxuICAgICAgOiBbXTtcbiAgICBjb25zdCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyA9IGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc1xuICAgICAgPyBbXVxuICAgICAgOiBBcnJheS5mcm9tKG5ldyBTZXQoW2RlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIsIC4uLnJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzXSkpLnNvcnQoKTtcblxuICAgIGNvbnN0IHNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIFsuLi5iYXNlU3NyRm9yd2FyZEhlYWRlcnMsIC4uLnRlbmFudFBhc3N0aHJvdWdoSGVhZGVycywgLi4uZXh0cmFTc3JGb3J3YXJkSGVhZGVyc10uZmlsdGVyKFxuICAgICAgICAgIChoZWFkZXIpID0+ICFkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuaGFzKGhlYWRlciksXG4gICAgICAgICksXG4gICAgICApLFxuICAgICk7XG4gICAgY29uc3QgaHRtbENhY2hlS2V5RXhjbHVkZWRIZWFkZXJzID0gbmV3IFNldChbXG4gICAgICBcImNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvXCIsXG4gICAgICBcImNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NcIixcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgXSk7XG4gICAgY29uc3QgaHRtbENhY2hlS2V5SGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KHNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiAhaHRtbENhY2hlS2V5RXhjbHVkZWRIZWFkZXJzLmhhcyhoZWFkZXIpKSksXG4gICAgKTtcblxuICAgIGlmICghcHJvcHMuaHRtbENhY2hlUG9saWN5ICYmIGh0bWxDYWNoZUtleUhlYWRlcnMubGVuZ3RoID4gbWF4RGVmYXVsdENhY2hlS2V5SGVhZGVycykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBkZWZhdWx0IGh0bWxDYWNoZVBvbGljeSBzdXBwb3J0cyBhdCBtb3N0ICR7bWF4RGVmYXVsdENhY2hlS2V5SGVhZGVyc30gY2FjaGUta2V5IGhlYWRlcnM7IHJlY2VpdmVkICR7aHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGh9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3NyT3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJTc3JPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsKCksXG4gICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLnNzckZvcndhcmRIZWFkZXJzKSxcbiAgICB9KTtcbiAgICBjb25zdCBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJIdG1sT3JpZ2luUmVxdWVzdFBvbGljeVwiLCB7XG4gICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IHNzckNhY2hlUG9saWN5ID0gcHJvcHMuc3NyQ2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVEO1xuICAgIGNvbnN0IHN0YXRpY0Fzc2V0c0NhY2hlUG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJTdGF0aWNBc3NldHNDYWNoZVBvbGljeVwiLCB7XG4gICAgICBjb21tZW50OlxuICAgICAgICBcIkFwcFRoZW9yeSBkaXJlY3QgUzMgYXNzZXQvZGF0YSBjYWNoZSBwb2xpY3k6IG9yaWdpbiBDYWNoZS1Db250cm9sIGJvdW5kZWQgYnkgbm8gdmlld2VyIGhlYWRlciBmb3J3YXJkaW5nXCIsXG4gICAgICBtaW5UdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgbWF4VHRsOiBEdXJhdGlvbi5kYXlzKDM2NSksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUNvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZVF1ZXJ5U3RyaW5nQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICBlbmFibGVBY2NlcHRFbmNvZGluZ0d6aXA6IHRydWUsXG4gICAgfSk7XG4gICAgY29uc3QgaHRtbENhY2hlUG9saWN5ID1cbiAgICAgIHByb3BzLmh0bWxDYWNoZVBvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJIdG1sQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgSFRNTCBjYWNoZSBwb2xpY3kga2V5ZWQgYnkgcXVlcnkgc3RyaW5ncyBhbmQgc3RhYmxlIHB1YmxpYyB2YXJpYW50IGhlYWRlcnNcIixcbiAgICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBtYXhUdGw6IER1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmh0bWxDYWNoZUtleUhlYWRlcnMpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nR3ppcDogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gICAgICBcImRpcmVjdCBTMyBwYXRoc1wiLFxuICAgICAgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSxcbiAgICAgIGJlaGF2aW9yUGF0dGVybk93bmVycyxcbiAgICAgIGJlaGF2aW9yUGF0dGVybnMsXG4gICAgKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcInN0YXRpYyBIVE1MIHBhdGhzXCIsIHN0YXRpY1BhdGhQYXR0ZXJucywgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLCBiZWhhdmlvclBhdHRlcm5zKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcImRpcmVjdCBTU1IgcGF0aHNcIiwgc3NyUGF0aFBhdHRlcm5zLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMsIGJlaGF2aW9yUGF0dGVybnMpO1xuICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mb3JFYWNoKChjb25maWcsIGluZGV4KSA9PiB7XG4gICAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgICAgICAgYGJlYXJlciBGdW5jdGlvbiBVUkwgY28tb3JpZ2luICR7aW5kZXggKyAxfWAsXG4gICAgICAgIGNvbmZpZy5wYXRoUGF0dGVybnMsXG4gICAgICAgIGJlaGF2aW9yUGF0dGVybk93bmVycyxcbiAgICAgICAgYmVoYXZpb3JQYXR0ZXJucyxcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXF1ZXN0RnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlcXVlc3RGdW5jdGlvblwiLCB7XG4gICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKFxuICAgICAgICBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoXG4gICAgICAgICAgc2l0ZU1vZGUsXG4gICAgICAgICAgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSxcbiAgICAgICAgICBbLi4uc3NyUGF0aFBhdHRlcm5zLCAuLi5iZWFyZXJGdW5jdGlvblVybFBhdGhQYXR0ZXJuc10sXG4gICAgICAgICAgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMsXG4gICAgICAgICksXG4gICAgICApLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDpcbiAgICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgICA/IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgYW5kIEhUTUwgcmV3cml0ZSBmb3IgU1NSIHNpdGVcIlxuICAgICAgICAgIDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXF1ZXN0IGVkZ2UgY29udGV4dCBmb3IgU1NSIHNpdGVcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShnZW5lcmF0ZVNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25Db2RlKCkpLFxuICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IHZpZXdlci1yZXNwb25zZSByZXF1ZXN0LWlkIGVjaG8gZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMgPSAoKTogY2xvdWRmcm9udC5GdW5jdGlvbkFzc29jaWF0aW9uW10gPT4gW1xuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVxdWVzdEZ1bmN0aW9uLFxuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBmdW5jdGlvbjogdmlld2VyUmVzcG9uc2VGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVNQT05TRSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCk7XG5cbiAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcbiAgICAgIGNvbnN0IGNlcnRBcm4gPSBTdHJpbmcocHJvcHMuY2VydGlmaWNhdGVBcm4gPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGNlcnRBcm4pIHtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwgY2VydEFybik7XG4gICAgICB9IGVsc2UgaWYgKHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbih0aGlzKTtcbiAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBuZXcgYWNtLkNlcnRpZmljYXRlKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwge1xuICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHByb3BzLmhvc3RlZFpvbmUpLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgcHJvcHMuY2VydGlmaWNhdGVBcm4gb3IgcHJvcHMuaG9zdGVkWm9uZSB3aGVuIHByb3BzLmRvbWFpbk5hbWUgaXMgc2V0XCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgIHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuUmVzcG9uc2VIZWFkZXJzUG9saWN5KHRoaXMsIFwiUmVzcG9uc2VIZWFkZXJzUG9saWN5XCIsIHtcbiAgICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IGJhc2VsaW5lIHNlY3VyaXR5IGhlYWRlcnMgKENTUCBzdGF5cyBvcmlnaW4tZGVmaW5lZClcIixcbiAgICAgICAgc2VjdXJpdHlIZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICBzdHJpY3RUcmFuc3BvcnRTZWN1cml0eToge1xuICAgICAgICAgICAgYWNjZXNzQ29udHJvbE1heEFnZTogRHVyYXRpb24uZGF5cygzNjUgKiAyKSxcbiAgICAgICAgICAgIGluY2x1ZGVTdWJkb21haW5zOiB0cnVlLFxuICAgICAgICAgICAgcHJlbG9hZDogdHJ1ZSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgY29udGVudFR5cGVPcHRpb25zOiB7IG92ZXJyaWRlOiB0cnVlIH0sXG4gICAgICAgICAgZnJhbWVPcHRpb25zOiB7XG4gICAgICAgICAgICBmcmFtZU9wdGlvbjogY2xvdWRmcm9udC5IZWFkZXJzRnJhbWVPcHRpb24uREVOWSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IHtcbiAgICAgICAgICAgIHJlZmVycmVyUG9saWN5OiBjbG91ZGZyb250LkhlYWRlcnNSZWZlcnJlclBvbGljeS5TVFJJQ1RfT1JJR0lOX1dIRU5fQ1JPU1NfT1JJR0lOLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB4c3NQcm90ZWN0aW9uOiB7XG4gICAgICAgICAgICBwcm90ZWN0aW9uOiB0cnVlLFxuICAgICAgICAgICAgbW9kZUJsb2NrOiB0cnVlLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgY3VzdG9tSGVhZGVyc0JlaGF2aW9yOiB7XG4gICAgICAgICAgY3VzdG9tSGVhZGVyczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBoZWFkZXI6IFwicGVybWlzc2lvbnMtcG9saWN5XCIsXG4gICAgICAgICAgICAgIHZhbHVlOiBcImNhbWVyYT0oKSwgbWljcm9waG9uZT0oKSwgZ2VvbG9jYXRpb249KClcIixcbiAgICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZVN0YXRpY0JlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGFzc2V0c09yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgIGNhY2hlUG9saWN5OiBzdGF0aWNBc3NldHNDYWNoZVBvbGljeSxcbiAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcbiAgICBjb25zdCBjcmVhdGVTdGF0aWNIdG1sQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogaHRtbE9yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgIGNhY2hlUG9saWN5OiBodG1sQ2FjaGVQb2xpY3ksXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcbiAgICBjb25zdCBjcmVhdGVTc3JCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBzc3JPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgIGNhY2hlUG9saWN5OiBzc3JDYWNoZVBvbGljeSxcbiAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IHNzck9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYWRkaXRpb25hbEJlaGF2aW9yczogUmVjb3JkPHN0cmluZywgY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnM+ID0ge307XG4gICAgY29uc3QgYWRkRXhwYW5kZWRCZWhhdmlvciA9IChwYXR0ZXJuczogc3RyaW5nW10sIGZhY3Rvcnk6ICgpID0+IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zKTogdm9pZCA9PiB7XG4gICAgICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnMpKSB7XG4gICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbcGF0dGVybl0gPSBmYWN0b3J5KCk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoW2Ake2Fzc2V0c0tleVByZWZpeH0vKmBdLCBjcmVhdGVTdGF0aWNCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihkaXJlY3RTM1BhdGhQYXR0ZXJucywgY3JlYXRlU3RhdGljQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3Ioc3RhdGljUGF0aFBhdHRlcm5zLCBjcmVhdGVTdGF0aWNIdG1sQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3Ioc3NyUGF0aFBhdHRlcm5zLCBjcmVhdGVTc3JCZWhhdmlvcik7XG4gICAgdGhpcy5iZWFyZXJGdW5jdGlvblVybHMgPSBbXTtcbiAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZm9yRWFjaCgoY29uZmlnLCBpbmRleCkgPT4ge1xuICAgICAgY29uc3QgZnVuY3Rpb25VcmwgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uVXJsKHRoaXMsIGBCZWFyZXJGdW5jdGlvblVybCR7aW5kZXggKyAxfWAsIHtcbiAgICAgICAgZnVuY3Rpb246IGNvbmZpZy5vcmlnaW4uZnVuY3Rpb24sXG4gICAgICAgIGF1dGhUeXBlOiBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5OT05FLFxuICAgICAgICBpbnZva2VNb2RlOiBjb25maWcub3JpZ2luLmludm9rZU1vZGUgPz8gbGFtYmRhLkludm9rZU1vZGUuQlVGRkVSRUQsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuYmVhcmVyRnVuY3Rpb25VcmxzLnB1c2goZnVuY3Rpb25VcmwpO1xuICAgICAgY29uc3QgZnVuY3Rpb25VcmxPcmlnaW4gPSBuZXcgb3JpZ2lucy5GdW5jdGlvblVybE9yaWdpbihmdW5jdGlvblVybCk7XG4gICAgICBjb25zdCBjcmVhdGVCZWFyZXJGdW5jdGlvblVybEJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICAgIG9yaWdpbjogZnVuY3Rpb25VcmxPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeS5BTExfVklFV0VSX0VYQ0VQVF9IT1NUX0hFQURFUixcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgICAgfSk7XG4gICAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKGNvbmZpZy5wYXRoUGF0dGVybnMsIGNyZWF0ZUJlYXJlckZ1bmN0aW9uVXJsQmVoYXZpb3IpO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZGVmYXVsdE9yaWdpbiA9XG4gICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICA/IG5ldyBvcmlnaW5zLk9yaWdpbkdyb3VwKHtcbiAgICAgICAgICAgIHByaW1hcnlPcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICAgICAgICBmYWxsYmFja09yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgICAgICAgZmFsbGJhY2tTdGF0dXNDb2RlczogWzQwMywgNDA0XSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IHNzck9yaWdpbjtcbiAgICBjb25zdCBkZWZhdWx0QWxsb3dlZE1ldGhvZHMgPVxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgPyBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlNcbiAgICAgICAgOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTDtcblxuICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICA/IHsgZW5hYmxlTG9nZ2luZzogdHJ1ZSwgbG9nQnVja2V0OiB0aGlzLmxvZ3NCdWNrZXQsIGxvZ0ZpbGVQcmVmaXg6IFwiY2xvdWRmcm9udC9cIiB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgIDoge30pLFxuICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgIG9yaWdpbjogZGVmYXVsdE9yaWdpbixcbiAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgIGFsbG93ZWRNZXRob2RzOiBkZWZhdWx0QWxsb3dlZE1ldGhvZHMsXG4gICAgICAgIGNhY2hlUG9saWN5OiBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IGh0bWxDYWNoZVBvbGljeSA6IHNzckNhY2hlUG9saWN5LFxuICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5IDogc3NyT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnMsXG4gICAgICAuLi4ocHJvcHMud2ViQWNsSWQgPyB7IHdlYkFjbElkOiBwcm9wcy53ZWJBY2xJZCB9IDoge30pLFxuICAgIH0pO1xuXG4gICAgaWYgKHNzclVybEF1dGhUeXBlID09PSBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNKSB7XG4gICAgICBwcm9wcy5zc3JGdW5jdGlvbi5hZGRQZXJtaXNzaW9uKFwiQWxsb3dDbG91ZEZyb250SW52b2tlRnVuY3Rpb25WaWFVcmxcIiwge1xuICAgICAgICBhY3Rpb246IFwibGFtYmRhOkludm9rZUZ1bmN0aW9uXCIsXG4gICAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiY2xvdWRmcm9udC5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgICBzb3VyY2VBcm46IHRoaXMuZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkFybixcbiAgICAgICAgaW52b2tlZFZpYUZ1bmN0aW9uVXJsOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0KSB7XG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldC5ncmFudFJlYWRXcml0ZShwcm9wcy5zc3JGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaXNyTWV0YWRhdGFUYWJsZSkge1xuICAgICAgdGhpcy5pc3JNZXRhZGF0YVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5zc3JGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHdpcmVSdW50aW1lRW52KSB7XG4gICAgICB0aGlzLmFzc2V0c0J1Y2tldC5ncmFudFJlYWQocHJvcHMuc3NyRnVuY3Rpb24pO1xuXG4gICAgICBjb25zdCBzc3JGdW5jdGlvbkFueSA9IHByb3BzLnNzckZ1bmN0aW9uIGFzIGFueTtcbiAgICAgIGlmICh0eXBlb2Ygc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlTc3JTaXRlIHdpcmVSdW50aW1lRW52IHJlcXVpcmVzIHByb3BzLnNzckZ1bmN0aW9uIHRvIHN1cHBvcnQgYWRkRW52aXJvbm1lbnQ7IHBhc3MgYSBsYW1iZGEuRnVuY3Rpb24gb3Igc2V0IHdpcmVSdW50aW1lRW52PWZhbHNlIGFuZCBzZXQgZW52IHZhcnMgbWFudWFsbHlcIixcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQVNTRVRTX0JVQ0tFVFwiLCB0aGlzLmFzc2V0c0J1Y2tldC5idWNrZXROYW1lKTtcbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19QUkVGSVhcIiwgYXNzZXRzS2V5UHJlZml4KTtcbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19NQU5JRkVTVF9LRVlcIiwgYXNzZXRzTWFuaWZlc3RLZXkpO1xuXG4gICAgICBpZiAodGhpcy5odG1sU3RvcmVCdWNrZXQgJiYgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXgpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0lTUl9CVUNLRVRcIiwgdGhpcy5odG1sU3RvcmVCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfUFJFRklYXCIsIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KTtcbiAgICAgIH1cbiAgICAgIGlmIChpc3JNZXRhZGF0YVRhYmxlTmFtZSkge1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0NBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBkb21haW5OYW1lLFxuICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgfVxufVxuIl19