"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheorySsrSite = exports.AppTheorySsrSiteMode = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
const constructs_1 = require("constructs");
const logical_name_1 = require("./private/logical-name");
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
const standard_logging_1 = require("./private/standard-logging");
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "7.4.0" };
    assetsBucket;
    assetsKeyPrefix;
    assetsManifestKey;
    htmlStoreBucket;
    htmlStoreKeyPrefix;
    isrMetadataTable;
    logsBucket;
    ssrUrl;
    bearerFunctionUrls;
    distribution;
    certificate;
    responseHeadersPolicy;
    constructor(scope, id, props) {
        super(scope, id);
        if (!props?.ssrFunction) {
            throw new Error("AppTheorySsrSite requires props.ssrFunction");
        }
        const siteMode = props.mode ?? AppTheorySsrSiteMode.SSR_ONLY;
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const autoDeleteObjects = props.autoDeleteObjects ?? false;
        const wireRuntimeEnv = props.wireRuntimeEnv ?? true;
        const namingContext = props.namingContext;
        const logical = props.logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        const enableLogging = props.enableLogging ?? true;
        const isrMetadataLogical = logical ? `${logical}-isr-metadata` : undefined;
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheorySsrSite", "isrMetadataTableName", "dynamodb_table", isrMetadataLogical, props.isrMetadataTableName !== undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheorySsrSite", "cacheTableName", "dynamodb_table", isrMetadataLogical, props.cacheTableName !== undefined);
        if (namingContext?.standardLogging === true && props.logsBucket !== undefined) {
            throw new Error("AppTheorySsrSite cannot honor props.logsBucket under the standard logging profile; CloudFront access logs go to the contract log group, so remove props.logsBucket or use the legacy logging profile");
        }
        const standardLogging = namingContext?.standardLogging === true && enableLogging;
        this.assetsBucket =
            props.assetsBucket ??
                new s3.Bucket(this, "AssetsBucket", {
                    ...(namingContext && logical ? (0, standard_logging_1.bucketNamingProps)(namingContext, `${logical}-assets`) : {}),
                    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                    encryption: s3.BucketEncryption.S3_MANAGED,
                    enforceSSL: true,
                    removalPolicy,
                    autoDeleteObjects,
                });
        if (enableLogging && !standardLogging) {
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
                        ...(namingContext && logical ? (0, standard_logging_1.bucketNamingProps)(namingContext, `${logical}-html-store`) : {}),
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
        let isrMetadataTableName = configuredIsrMetadataTableNames[0] ?? "";
        // Under a naming context the ISR/cache metadata table is named through the
        // contract only when the construct wires a name the caller did not supply.
        // `ssg-isr` needs a table, so it consumes the `{logical}-isr-metadata`
        // entry. An external table passed through `isrMetadataTable` is the
        // caller's resource: it consumes no entry, so an entry naming it is an
        // orphan (r3, ADV-1312-2; M2 residual).
        if (namingContext &&
            logical &&
            props.isrMetadataTable === undefined &&
            siteMode === AppTheorySsrSiteMode.SSG_ISR) {
            const composed = namingContext.physicalName("dynamodb_table", `${logical}-isr-metadata`);
            if (isrMetadataTableName === "" && !composed.generated && composed.name !== undefined) {
                isrMetadataTableName = composed.name;
            }
        }
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
        if (standardLogging && namingContext && logical) {
            (0, standard_logging_1.enableCloudFrontStandardLogging)({
                scope: this,
                id: "CdnLogging",
                context: namingContext,
                distribution: this.distribution,
                logical: `logs/access/cdn/${logical}`,
                format: props.cloudFrontLogFormat,
            });
        }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQW9FO0FBQ3BFLHdFQUEwRDtBQUMxRCx1RUFBeUQ7QUFDekQsNEVBQThEO0FBRTlELHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsd0VBQTBEO0FBQzFELDJDQUF1QztBQUd2Qyx5REFBNEQ7QUFDNUQseUVBQW9FO0FBQ3BFLGlFQUFnRztBQUdoRyx5REFBaUY7QUFFakYsTUFBTSwwQkFBMEIsR0FBRywwQkFBMEIsQ0FBQztBQUM5RCxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sMkJBQTJCLEdBQUcsMkJBQTJCLENBQUM7QUFDaEUsTUFBTSw0QkFBNEIsR0FBRyw0QkFBNEIsQ0FBQztBQUNsRSxNQUFNLHFCQUFxQixHQUFHLENBQUMsMEJBQTBCLEVBQUUsMkJBQTJCLENBQVUsQ0FBQztBQUNqRyxNQUFNLHNCQUFzQixHQUFHLENBQUMsMkJBQTJCLEVBQUUsNEJBQTRCLENBQVUsQ0FBQztBQUNwRyxNQUFNLDBCQUEwQixHQUFHLHFCQUFxQixDQUFDO0FBQ3pELE1BQU0sd0JBQXdCLEdBQUcseUJBQXlCLENBQUM7QUFDM0QsTUFBTSw0QkFBNEIsR0FBRyxLQUFLLENBQUM7QUFDM0MsTUFBTSx5QkFBeUIsR0FBRyxFQUFFLENBQUM7QUFDckMsTUFBTSx5QkFBeUIsR0FBRyxhQUFhLENBQUM7QUFFaEQsSUFBWSxvQkFZWDtBQVpELFdBQVksb0JBQW9CO0lBQzlCOzs7T0FHRztJQUNILDZDQUFxQixDQUFBO0lBRXJCOzs7T0FHRztJQUNILDJDQUFtQixDQUFBO0FBQ3JCLENBQUMsRUFaVyxvQkFBb0Isb0NBQXBCLG9CQUFvQixRQVkvQjtBQUVELFNBQVMs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Z0JBQ3BELGNBQWMsQ0FBQyxjQUFjLENBQUMsdUJBQXVCLEVBQUUsSUFBSSxDQUFDLGVBQWUsQ0FBQyxVQUFVLENBQUMsQ0FBQztnQkFDeEYsY0FBYyxDQUFDLGNBQWMsQ0FBQyx1QkFBdUIsRUFBRSxJQUFJLENBQUMsa0JBQWtCLENBQUMsQ0FBQztZQUNsRixDQUFDO1lBQ0QsSUFBSSxvQkFBb0IsRUFBRSxDQUFDO2dCQUN6QixjQUFjLENBQUMsY0FBYyxDQUFDLDRCQUE0QixFQUFFLG9CQUFvQixDQUFDLENBQUM7Z0JBQ2xGLGNBQWMsQ0FBQyxjQUFjLENBQUMsNkJBQTZCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztnQkFDbkYsY0FBYyxDQUFDLGNBQWMsQ0FBQyxrQkFBa0IsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO2dCQUN4RSxjQUFjLENBQUMsY0FBYyxDQUFDLGFBQWEsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO1lBQ3JFLENBQUM7UUFDSCxDQUFDO1FBRUQsSUFBSSxVQUFVLElBQUksS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ25DLElBQUksT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO2dCQUN2QyxJQUFJLEVBQUUsS0FBSyxDQUFDLFVBQVU7Z0JBQ3RCLFVBQVUsRUFBRSxVQUFVO2dCQUN0QixNQUFNLEVBQUUsT0FBTyxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUMsSUFBSSxPQUFPLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO2FBQ3hGLENBQUMsQ0FBQztRQUNMLENBQUM7SUFFSCxDQUFDOztBQW5uQkgsNENBb25CQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uLCBSZW1vdmFsUG9saWN5LCBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50XCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0IH0gZnJvbSBcIi4vbG9nZ2luZ1wiO1xuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IHJlZnVzZUV4cGxpY2l0TmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvcmVmdXNlLWV4cGxpY2l0LW5hbWVcIjtcbmltcG9ydCB7IGJ1Y2tldE5hbWluZ1Byb3BzLCBlbmFibGVDbG91ZEZyb250U3RhbmRhcmRMb2dnaW5nIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuXG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyLCB0cmltUmVwZWF0ZWRDaGFyU3RhcnQgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuXG5jb25zdCBhcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtdXJpXCI7XG5jb25zdCBmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIgPSBcIngtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlcIjtcbmNvbnN0IGFwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtaG9zdFwiO1xuY29uc3QgZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RcIjtcbmNvbnN0IHNzck9yaWdpbmFsVXJpSGVhZGVycyA9IFthcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciwgZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzck9yaWdpbmFsSG9zdEhlYWRlcnMgPSBbYXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyLCBmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuID0gXCIvX2ZhY2V0aGVvcnkvZGF0YS8qXCI7XG5jb25zdCBzc2dJc3JTc3JEYXRhUGF0aFBhdHRlcm4gPSBcIi9fZmFjZXRoZW9yeS9zc3ItZGF0YS8qXCI7XG5jb25zdCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4ID0gXCJpc3JcIjtcbmNvbnN0IG1heERlZmF1bHRDYWNoZUtleUhlYWRlcnMgPSAxMDtcbmNvbnN0IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgPSBcIngtdGVuYW50LWlkXCI7XG5cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeVNzclNpdGVNb2RlIHtcbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaXMgdGhlIGRlZmF1bHQgb3JpZ2luLiBEaXJlY3QgUzMgYmVoYXZpb3JzIGFyZSB1c2VkIG9ubHkgZm9yXG4gICAqIGltbXV0YWJsZSBhc3NldHMgYW5kIGFueSBleHBsaWNpdGx5IGNvbmZpZ3VyZWQgc3RhdGljIHBhdGggcGF0dGVybnMuXG4gICAqL1xuICBTU1JfT05MWSA9IFwic3NyLW9ubHlcIixcblxuICAvKipcbiAgICogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBTU1IvSVNSIGlzIHRoZSBmYWxsYmFjay4gRmFjZVRoZW9yeSBoeWRyYXRpb25cbiAgICogZGF0YSByb3V0ZXMgYXJlIGtlcHQgb24gUzMgYW5kIHRoZSBlZGdlIHJld3JpdGVzIGV4dGVuc2lvbmxlc3MgcGF0aHMgdG8gYC9pbmRleC5odG1sYC5cbiAgICovXG4gIFNTR19JU1IgPSBcInNzZy1pc3JcIixcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5Ub1VyaVByZWZpeChwYXR0ZXJuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKS5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gIHJldHVybiBub3JtYWxpemVkID8gYC8ke25vcm1hbGl6ZWR9YCA6IFwiL1wiO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoUGF0dGVybnMocGF0dGVybnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICByZXR1cm4gQXJyYXkuZnJvbShcbiAgICBuZXcgU2V0KFxuICAgICAgKEFycmF5LmlzQXJyYXkocGF0dGVybnMpID8gcGF0dGVybnMgOiBbXSlcbiAgICAgICAgLm1hcCgocGF0dGVybikgPT4gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKSlcbiAgICAgICAgLmZpbHRlcigocGF0dGVybikgPT4gcGF0dGVybi5sZW5ndGggPiAwKSxcbiAgICApLFxuICApO1xufVxuXG5mdW5jdGlvbiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4cGFuZGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIik7XG4gICAgaWYgKCFub3JtYWxpemVkKSBjb250aW51ZTtcblxuICAgIGV4cGFuZGVkLmFkZChub3JtYWxpemVkKTtcbiAgICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICBjb25zdCByb290UGF0dGVybiA9IG5vcm1hbGl6ZWQuc2xpY2UoMCwgLTIpO1xuICAgICAgaWYgKHJvb3RQYXR0ZXJuKSB7XG4gICAgICAgIGV4cGFuZGVkLmFkZChyb290UGF0dGVybik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIEFycmF5LmZyb20oZXhwYW5kZWQpO1xufVxuXG5pbnRlcmZhY2UgU2VlbkJlaGF2aW9yUGF0dGVybiB7XG4gIHJlYWRvbmx5IHBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbGFiZWw6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFBhdGhQYXR0ZXJuVHJhbnNpdGlvbiB7XG4gIHJlYWRvbmx5IHRhcmdldDogbnVtYmVyO1xuICByZWFkb25seSBhbnk6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxpdGVyYWw/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuRXBzaWxvbkNsb3N1cmUocGF0dGVybjogc3RyaW5nLCBpbmRleDogbnVtYmVyKTogbnVtYmVyW10ge1xuICBjb25zdCBjbG9zdXJlOiBudW1iZXJbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IHN0YWNrID0gW2luZGV4XTtcblxuICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBzdGFjay5wb3AoKSA/PyAwO1xuICAgIGlmIChzZWVuLmhhcyhjdXJyZW50KSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZW4uYWRkKGN1cnJlbnQpO1xuICAgIGNsb3N1cmUucHVzaChjdXJyZW50KTtcblxuICAgIGlmIChwYXR0ZXJuW2N1cnJlbnRdID09PSBcIipcIikge1xuICAgICAgc3RhY2sucHVzaChjdXJyZW50ICsgMSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGNsb3N1cmU7XG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuVHJhbnNpdGlvbnMocGF0dGVybjogc3RyaW5nLCBpbmRleDogbnVtYmVyKTogUGF0aFBhdHRlcm5UcmFuc2l0aW9uW10ge1xuICBjb25zdCB0b2tlbiA9IHBhdHRlcm5baW5kZXhdO1xuICBpZiAodG9rZW4gPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGlmICh0b2tlbiA9PT0gXCIqXCIpIHtcbiAgICByZXR1cm4gW3sgdGFyZ2V0OiBpbmRleCwgYW55OiB0cnVlIH1dO1xuICB9XG5cbiAgaWYgKHRva2VuID09PSBcIj9cIikge1xuICAgIHJldHVybiBbeyB0YXJnZXQ6IGluZGV4ICsgMSwgYW55OiB0cnVlIH1dO1xuICB9XG5cbiAgcmV0dXJuIFt7IHRhcmdldDogaW5kZXggKyAxLCBhbnk6IGZhbHNlLCBsaXRlcmFsOiB0b2tlbiB9XTtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5UcmFuc2l0aW9uc0NhblNoYXJlQ2hhcmFjdGVyKGxlZnQ6IFBhdGhQYXR0ZXJuVHJhbnNpdGlvbiwgcmlnaHQ6IFBhdGhQYXR0ZXJuVHJhbnNpdGlvbik6IGJvb2xlYW4ge1xuICByZXR1cm4gbGVmdC5hbnkgfHwgcmlnaHQuYW55IHx8IGxlZnQubGl0ZXJhbCA9PT0gcmlnaHQubGl0ZXJhbDtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5zQ2FuT3ZlcmxhcChsZWZ0OiBzdHJpbmcsIHJpZ2h0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgc2VlblN0YXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBxdWV1ZTogQXJyYXk8W251bWJlciwgbnVtYmVyXT4gPSBbXTtcblxuICBjb25zdCBlbnF1ZXVlQ2xvc3VyZVBhaXJzID0gKGxlZnRJbmRleDogbnVtYmVyLCByaWdodEluZGV4OiBudW1iZXIpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGxlZnRDbG9zZWQgb2YgcGF0aFBhdHRlcm5FcHNpbG9uQ2xvc3VyZShsZWZ0LCBsZWZ0SW5kZXgpKSB7XG4gICAgICBmb3IgKGNvbnN0IHJpZ2h0Q2xvc2VkIG9mIHBhdGhQYXR0ZXJuRXBzaWxvbkNsb3N1cmUocmlnaHQsIHJpZ2h0SW5kZXgpKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke2xlZnRDbG9zZWR9OiR7cmlnaHRDbG9zZWR9YDtcbiAgICAgICAgaWYgKHNlZW5TdGF0ZXMuaGFzKGtleSkpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBzZWVuU3RhdGVzLmFkZChrZXkpO1xuICAgICAgICBxdWV1ZS5wdXNoKFtsZWZ0Q2xvc2VkLCByaWdodENsb3NlZF0pO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBlbnF1ZXVlQ2xvc3VyZVBhaXJzKDAsIDApO1xuXG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgW2xlZnRJbmRleCwgcmlnaHRJbmRleF0gPSBxdWV1ZS5zaGlmdCgpID8/IFswLCAwXTtcbiAgICBpZiAobGVmdEluZGV4ID09PSBsZWZ0Lmxlbmd0aCAmJiByaWdodEluZGV4ID09PSByaWdodC5sZW5ndGgpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgbGVmdFRyYW5zaXRpb24gb2YgcGF0aFBhdHRlcm5UcmFuc2l0aW9ucyhsZWZ0LCBsZWZ0SW5kZXgpKSB7XG4gICAgICBmb3IgKGNvbnN0IHJpZ2h0VHJhbnNpdGlvbiBvZiBwYXRoUGF0dGVyblRyYW5zaXRpb25zKHJpZ2h0LCByaWdodEluZGV4KSkge1xuICAgICAgICBpZiAoIXBhdGhQYXR0ZXJuVHJhbnNpdGlvbnNDYW5TaGFyZUNoYXJhY3RlcihsZWZ0VHJhbnNpdGlvbiwgcmlnaHRUcmFuc2l0aW9uKSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZW5xdWV1ZUNsb3N1cmVQYWlycyhsZWZ0VHJhbnNpdGlvbi50YXJnZXQsIHJpZ2h0VHJhbnNpdGlvbi50YXJnZXQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgc2Vlbk93bmVyczogTWFwPHN0cmluZywgc3RyaW5nPixcbiAgc2VlblBhdHRlcm5zOiBTZWVuQmVoYXZpb3JQYXR0ZXJuW10sXG4pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgIGNvbnN0IG93bmVyID0gc2Vlbk93bmVycy5nZXQocGF0dGVybik7XG4gICAgaWYgKG93bmVyICYmIG93bmVyICE9PSBsYWJlbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIHJlY2VpdmVkIG92ZXJsYXBwaW5nIHBhdGggcGF0dGVybiBcIiR7cGF0dGVybn1cIiBmb3IgJHtvd25lcn0gYW5kICR7bGFiZWx9YCk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBzZWVuUGF0dGVybiBvZiBzZWVuUGF0dGVybnMpIHtcbiAgICAgIGlmIChzZWVuUGF0dGVybi5sYWJlbCAhPT0gbGFiZWwgJiYgcGF0aFBhdHRlcm5zQ2FuT3ZlcmxhcChzZWVuUGF0dGVybi5wYXR0ZXJuLCBwYXR0ZXJuKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJucyBcIiR7c2VlblBhdHRlcm4ucGF0dGVybn1cIiBhbmQgXCIke3BhdHRlcm59XCIgZm9yICR7c2VlblBhdHRlcm4ubGFiZWx9IGFuZCAke2xhYmVsfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgc2Vlbk93bmVycy5zZXQocGF0dGVybiwgbGFiZWwpO1xuICAgIHNlZW5QYXR0ZXJucy5wdXNoKHsgcGF0dGVybiwgbGFiZWwgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2Fub25pY2FsaXplSGVhZGVyTmFtZShoZWFkZXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcoaGVhZGVyKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuZnVuY3Rpb24gaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBjYW5vbmljYWxpemVIZWFkZXJOYW1lKGhlYWRlcikucmVwbGFjZSgvW15hLXowLTldKy9nLCBcIi1cIik7XG4gIHJldHVybiBub3JtYWxpemVkID09PSBkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyIHx8IC8oXnwtKXRlbmFudCgtfCQpLy50ZXN0KG5vcm1hbGl6ZWQpO1xufVxuXG5mdW5jdGlvbiBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHNjb3BlOiBDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgY29uc3QgcmVnaW9uID0gU3RhY2sub2Yoc2NvcGUpLnJlZ2lvbjtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQocmVnaW9uKSAmJiByZWdpb24gPT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5U3NyU2l0ZSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIHByb3BzLmNlcnRpZmljYXRlQXJuIGZvciBzdGFja3MgaW4gb3RoZXIgb3IgZW52aXJvbm1lbnQtYWdub3N0aWMgcmVnaW9ucy5gLFxuICApO1xufVxuXG5mdW5jdGlvbiBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoXG4gIG1vZGU6IEFwcFRoZW9yeVNzclNpdGVNb2RlLFxuICByYXdTM1BhdGhQYXR0ZXJuczogc3RyaW5nW10sXG4gIGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnM6IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3UzNQcmVmaXhlcyA9IHJhd1MzUGF0aFBhdHRlcm5zLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KS5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgcmF3UzNQcmVmaXhMaXN0ID0gcmF3UzNQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG4gIGNvbnN0IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBsYW1iZGFQYXNzdGhyb3VnaFBhdGhQYXR0ZXJuc1xuICAgIC5tYXAocGF0aFBhdHRlcm5Ub1VyaVByZWZpeClcbiAgICAuc29ydCgoYSwgYikgPT4gYi5sZW5ndGggLSBhLmxlbmd0aCk7XG4gIGNvbnN0IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4TGlzdCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubWFwKChwcmVmaXgpID0+IGAnJHtwcmVmaXh9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuICBjb25zdCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyTGlzdCA9IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLm1hcCgoaGVhZGVyKSA9PiBgJyR7aGVhZGVyfSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcblxuICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHJlcXVlc3QuaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycyB8fCB7fTtcblx0ICB2YXIgaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycztcblx0ICB2YXIgdXJpID0gcmVxdWVzdC51cmkgfHwgJy8nO1xuXHQgIHZhciBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyA9IFtcblx0ICAgICR7YmxvY2tlZFZpZXdlclRlbmFudEhlYWRlckxpc3R9XG5cdCAgXTtcblxuXHQgIGZvciAodmFyIGJsb2NrZWRJbmRleCA9IDA7IGJsb2NrZWRJbmRleCA8IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLmxlbmd0aDsgYmxvY2tlZEluZGV4KyspIHtcblx0ICAgIGRlbGV0ZSBoZWFkZXJzW2Jsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzW2Jsb2NrZWRJbmRleF1dO1xuXHQgIH1cblxuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gJ3JlcV8nICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyAnXycgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCk7XG5cdCAgfVxuXG5cdCAgaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyfSddID0geyB2YWx1ZTogdXJpIH07XG5cdCAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblxuXHQgIGlmIChoZWFkZXJzLmhvc3QgJiYgaGVhZGVycy5ob3N0LnZhbHVlKSB7XG5cdCAgICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcn0nXSA9IHsgdmFsdWU6IGhlYWRlcnMuaG9zdC52YWx1ZSB9O1xuXHQgICAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgfVxuXG5cdCAgaWYgKCcke21vZGV9JyA9PT0gJyR7QXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUn0nKSB7XG5cdCAgICB2YXIgcmF3UzNQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtyYXdTM1ByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBbXG5cdCAgICAgICR7bGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0fVxuXHQgICAgXTtcblx0ICAgIHZhciBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IGZhbHNlO1xuXG5cdCAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubGVuZ3RoOyBpKyspIHtcblx0ICAgICAgdmFyIHByZWZpeCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXNbaV07XG5cdCAgICAgIGlmICh1cmkgPT09IHByZWZpeCB8fCB1cmkuc3RhcnRzV2l0aChwcmVmaXggKyAnLycpKSB7XG5cdCAgICAgICAgaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGggPSB0cnVlO1xuXHQgICAgICAgIGJyZWFrO1xuXHQgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIGlmICghaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGgpIHtcblx0ICAgICAgdmFyIGlzUmF3UzNQYXRoID0gZmFsc2U7XG5cblx0ICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCByYXdTM1ByZWZpeGVzLmxlbmd0aDsgaisrKSB7XG5cdCAgICAgICAgdmFyIHJhd1ByZWZpeCA9IHJhd1MzUHJlZml4ZXNbal07XG5cdCAgICAgICAgaWYgKHVyaSA9PT0gcmF3UHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHJhd1ByZWZpeCArICcvJykpIHtcblx0ICAgICAgICAgIGlzUmF3UzNQYXRoID0gdHJ1ZTtcblx0ICAgICAgICAgIGJyZWFrO1xuXHQgICAgICAgIH1cblx0ICAgICAgfVxuXG5cdCAgICAgIHZhciBsYXN0U2xhc2ggPSB1cmkubGFzdEluZGV4T2YoJy8nKTtcblx0ICAgICAgdmFyIGxhc3RTZWdtZW50ID0gbGFzdFNsYXNoID49IDAgPyB1cmkuc3Vic3RyaW5nKGxhc3RTbGFzaCArIDEpIDogdXJpO1xuXG5cdCAgICAgIGlmICghaXNSYXdTM1BhdGggJiYgbGFzdFNlZ21lbnQuaW5kZXhPZignLicpID09PSAtMSkge1xuXHQgICAgICAgIHJlcXVlc3QudXJpID0gdXJpLmVuZHNXaXRoKCcvJykgPyB1cmkgKyAnaW5kZXguaHRtbCcgOiB1cmkgKyAnL2luZGV4Lmh0bWwnO1xuXHQgICAgICB9XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlcXVlc3Q7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvbkNvZGUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgcmVzcG9uc2UgPSBldmVudC5yZXNwb25zZTtcblx0ICB2YXIgcmVxdWVzdElkSGVhZGVyID0gcmVxdWVzdC5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAocmVxdWVzdElkKSB7XG5cdCAgICByZXNwb25zZS5oZWFkZXJzID0gcmVzcG9uc2UuaGVhZGVycyB8fCB7fTtcblx0ICAgIGlmICghcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10pIHtcblx0ICAgICAgcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVzcG9uc2U7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZVByb3BzIHtcbiAgcmVhZG9ubHkgc3NyRnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IGRlcGxveW1lbnQgbW9kZSBmb3IgdGhlIHNpdGUgdG9wb2xvZ3kuXG4gICAqXG4gICAqIC0gYHNzci1vbmx5YDogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpcyB0aGUgZGVmYXVsdCBvcmlnaW5cbiAgICogLSBgc3NnLWlzcmA6IFMzIGlzIHRoZSBwcmltYXJ5IEhUTUwgb3JpZ2luIGFuZCBMYW1iZGEgaXMgdGhlIGZhbGxiYWNrXG4gICAqXG4gICAqIEV4aXN0aW5nIGltcGxpY2l0IGJlaGF2aW9yIG1hcHMgdG8gYHNzci1vbmx5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFlcbiAgICovXG4gIHJlYWRvbmx5IG1vZGU/OiBBcHBUaGVvcnlTc3JTaXRlTW9kZTtcblxuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpbnZva2UgbW9kZSBmb3IgdGhlIFNTUiBvcmlnaW4uXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTVxuICAgKi9cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xuXG4gIC8qKlxuICAgKiBGdW5jdGlvbiBVUkwgYXV0aCB0eXBlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IGZhaWxzIGNsb3NlZCB0byBgQVdTX0lBTWAgYW5kIHNpZ25zIENsb3VkRnJvbnQtdG8tTGFtYmRhXG4gICAqIHRyYWZmaWMgd2l0aCBsYW1iZGEgT3JpZ2luIEFjY2VzcyBDb250cm9sLlxuICAgKlxuICAgKiBTZXQgdGhpcyBleHBsaWNpdGx5IHRvIGBOT05FYCBvbmx5IHdoZW4geW91IGludGVudGlvbmFsbHkgcmVxdWlyZSBwdWJsaWNcbiAgICogZGlyZWN0IEZ1bmN0aW9uIFVSTCBhY2Nlc3MgYXMgYSBkZWxpYmVyYXRlIGNvbXBhdGliaWxpdHkgY2hvaWNlLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNXG4gICAqL1xuICByZWFkb25seSBzc3JVcmxBdXRoVHlwZT86IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlO1xuXG4gIHJlYWRvbmx5IGFzc2V0c0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHJlYWRvbmx5IGFzc2V0c1BhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFzc2V0c0tleVByZWZpeD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzTWFuaWZlc3RLZXk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCB1c2VkIGJ5IEZhY2VUaGVvcnkgSVNSIEhUTUwgc3RvcmFnZSAoYFMzSHRtbFN0b3JlYCkuXG4gICAqXG4gICAqIFdoZW4gcHJvdmlkZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIFNTUiBmdW5jdGlvbiByZWFkL3dyaXRlIGFjY2VzcyBhbmQgd2lyZXM6XG4gICAqIC0gYEZBQ0VUSEVPUllfSVNSX0JVQ0tFVGBcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfUFJFRklYYFxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbFN0b3JlQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogUzMga2V5IHByZWZpeCB1c2VkIGJ5IEZhY2VUaGVvcnkgSVNSIEhUTUwgc3RvcmFnZS5cbiAgICogQGRlZmF1bHQgaXNyXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVLZXlQcmVmaXg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgZXh0ZW5zaW9ubGVzcyBIVE1MIHNlY3Rpb24gcGF0aCBwYXR0ZXJucyB0byByb3V0ZSBkaXJlY3RseSB0byB0aGUgcHJpbWFyeSBIVE1MIFMzIG9yaWdpbi5cbiAgICpcbiAgICogUmVxdWVzdHMgbGlrZSBgL21hcmtldGluZ2AgYW5kIGAvbWFya2V0aW5nLy4uLmAgYXJlIHJld3JpdHRlbiB0byBgL2luZGV4Lmh0bWxgXG4gICAqIHdpdGhpbiB0aGUgc2VjdGlvbiBhbmQgc3RheSBvbiBTMyBpbnN0ZWFkIG9mIGZhbGxpbmcgYmFjayB0byBMYW1iZGEuXG4gICAqXG4gICAqIEV4YW1wbGUgZGlyZWN0LVMzIEhUTUwgc2VjdGlvbiBwYXRoOiBcIi9tYXJrZXRpbmcvKlwiXG4gICAqL1xuICByZWFkb25seSBzdGF0aWNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCByYXcgUzMgb2JqZWN0L2RhdGEgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgZXh0ZW5zaW9ubGVzcyBIVE1MIHJld3JpdGVzLlxuICAgKlxuICAgKiBJbiBgc3NnLWlzcmAgbW9kZSwgYC9fZmFjZXRoZW9yeS9kYXRhLypgIGlzIGFkZGVkIGF1dG9tYXRpY2FsbHkuXG4gICAqIEV4YW1wbGUgZGlyZWN0LVMzIG9iamVjdCBwYXRoOiBcIi9mZWVkcy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IGRpcmVjdFMzUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgdGhlIGBzc2ctaXNyYCBvcmlnaW4gZ3JvdXAgYW5kIHJvdXRlIGRpcmVjdGx5XG4gICAqIHRvIHRoZSBMYW1iZGEgRnVuY3Rpb24gVVJMIHdpdGggZnVsbCBtZXRob2Qgc3VwcG9ydC5cbiAgICpcbiAgICogSW4gYHNzZy1pc3JgIG1vZGUsIGAvX2ZhY2V0aGVvcnkvc3NyLWRhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseSBmb3IgRmFjZVRoZW9yeVxuICAgKiBzdHJpY3Qgbm8taW5saW5lLUNTUCBTU1IgaHlkcmF0aW9uIHNpZGVjYXJzLlxuICAgKlxuICAgKiBVc2UgdGhpcyBmb3Igc2FtZS1vcmlnaW4gZHluYW1pYyBwYXRocyBzdWNoIGFzIGF1dGggY2FsbGJhY2tzLCBhY3Rpb25zLCBvciBmb3JtIHBvc3RzLlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TU1IgcGF0aDogXCIvYWN0aW9ucy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHNzclBhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGJlYXJlci1hdXRoIExhbWJkYSBGdW5jdGlvbiBVUkwgY28tb3JpZ2lucyB0byBhdHRhY2ggdG8gdGhlIHNhbWUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIGVhY2ggY28tb3JpZ2luIEZ1bmN0aW9uIFVSTCB3aXRoIGBBdXRoVHlwZS5OT05FYCBhbmQgcm91dGVzIHRoZSBzdXBwbGllZFxuICAgKiBwYXRoIHBhdHRlcm5zIHRvIGl0IHdpdGhvdXQgTGFtYmRhIE9yaWdpbiBBY2Nlc3MgQ29udHJvbC4gVGhlIFNTUiBvcmlnaW4gcmVtYWlucyBnb3Zlcm5lZCBieVxuICAgKiBgc3NyVXJsQXV0aFR5cGVgIGFuZCBzdGlsbCBkZWZhdWx0cyB0byBgQVdTX0lBTWAgcGx1cyBMYW1iZGEgT0FDLlxuICAgKlxuICAgKiBDby1vcmlnaW4gcGF0aHMgcGFydGljaXBhdGUgaW4gQXBwVGhlb3J5J3MgYmVoYXZpb3IgcGF0aCBjb2xsaXNpb24gY2hlY2tzIGFuZCBieXBhc3MgYHNzZy1pc3JgXG4gICAqIEhUTUwgcmV3cml0ZXMuIFRoaXMgaXMgdGhlIHN1cHBvcnRlZCBBcHBUaGVvcnkgcGF0aCBmb3IgbWl4ZWQtYXV0aCBkaXN0cmlidXRpb25zOyBkbyBub3QgaGFuZC13aXJlXG4gICAqIHJhdyBgZGlzdHJpYnV0aW9uLmFkZEJlaGF2aW9yKC4uLilgIGNhbGxzIHdoZW4gQXBwVGhlb3J5IHNob3VsZCBvd24gcGF0aCBhbmQgZWRnZS1jb250ZXh0IHBvbGljeS5cbiAgICpcbiAgICogRXhhbXBsZSBiZWFyZXIgQVBJIHBhdGhzOiBgW1wiL2FwaS8qXCIsIFwiL2F1dGgvKlwiXWAuXG4gICAqL1xuICByZWFkb25seSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnM/OiBBcHBUaGVvcnlTc3JTaXRlQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5bXTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgVGFibGVUaGVvcnkvRHluYW1vREIgdGFibGUgdXNlZCBmb3IgRmFjZVRoZW9yeSBJU1IgbWV0YWRhdGEgYW5kIGxlYXNlIGNvb3JkaW5hdGlvbi5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlcyB0aGVcbiAgICogbWV0YWRhdGEgdGFibGUgYWxpYXNlcyBleHBlY3RlZCBieSB0aGUgZG9jdW1lbnRlZCBGYWNlVGhlb3J5IGRlcGxveW1lbnQgc2hhcGUuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBJU1IvY2FjaGUgbWV0YWRhdGEgdGFibGUgbmFtZSB0byB3aXJlIHdoZW4geW91IGFyZSBub3QgcGFzc2luZyBgaXNyTWV0YWRhdGFUYWJsZWAuXG4gICAqXG4gICAqIFByZWZlciBgaXNyTWV0YWRhdGFUYWJsZWAgd2hlbiBBcHBUaGVvcnkgc2hvdWxkIGFsc28gZ3JhbnQgYWNjZXNzIHRvIHRoZSBTU1IgTGFtYmRhLlxuICAgKi9cbiAgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExlZ2FjeSBhbGlhcyBmb3IgYGlzck1ldGFkYXRhVGFibGVOYW1lYC5cbiAgICogQGRlcHJlY2F0ZWQgcHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCBvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgXG4gICAqL1xuICByZWFkb25seSBjYWNoZVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvLyBXaGVuIHRydWUgKGRlZmF1bHQpLCBBcHBUaGVvcnkgd2lyZXMgcmVjb21tZW5kZWQgcnVudGltZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgb250byB0aGUgU1NSIGZ1bmN0aW9uLlxuICByZWFkb25seSB3aXJlUnVudGltZUVudj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgaGVhZGVycyB0byBmb3J3YXJkIHRvIHRoZSBTU1Igb3JpZ2luIChMYW1iZGEgRnVuY3Rpb24gVVJMKSB2aWEgdGhlIG9yaWdpbiByZXF1ZXN0IHBvbGljeS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5L0ZhY2VUaGVvcnktc2FmZSBlZGdlIGNvbnRyYWN0IGZvcndhcmRzIG9ubHk6XG4gICAqIC0gYGNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvYFxuICAgKiAtIGBjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzYFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWZhY2V0aGVvcnktb3JpZ2luYWwtdXJpYFxuICAgKiAtIGB4LXJlcXVlc3QtaWRgXG4gICAqXG4gICAqIFVzZSB0aGlzIHRvIG9wdCBpbiB0byBhZGRpdGlvbmFsIGFwcC1zcGVjaWZpYyBoZWFkZXJzIHN1Y2ggYXNcbiAgICogYHgtZmFjZXRoZW9yeS1zZWdtZW50YC4gVGVuYW50LWxpa2Ugdmlld2VyIGhlYWRlcnMgYXJlIHJlamVjdGVkIHVubGVzc1xuICAgKiBgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzYCBpcyBleHBsaWNpdGx5IGVuYWJsZWQgYXMgYSBjb21wYXRpYmlsaXR5IG1vZGUuXG4gICAqIGBob3N0YCBhbmQgYHgtZm9yd2FyZGVkLXByb3RvYCBhcmUgcmVqZWN0ZWQgYmVjYXVzZSB0aGV5IGJyZWFrIG9yIGJ5cGFzcyB0aGVcbiAgICogc3VwcG9ydGVkIG9yaWdpbiBtb2RlbC5cbiAgICovXG4gIHJlYWRvbmx5IHNzckZvcndhcmRIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIENvbXBhdGliaWxpdHkgZXNjYXBlIGhhdGNoIGZvciBsZWdhY3kgdmlld2VyLXN1cHBsaWVkIHRlbmFudCBoZWFkZXJzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlIChkZWZhdWx0KSwgQXBwVGhlb3J5IHN0cmlwcyBgeC10ZW5hbnQtaWRgIGF0IHRoZSBlZGdlIGFuZCByZWplY3RzXG4gICAqIHRlbmFudC1saWtlIGVudHJpZXMgaW4gYHNzckZvcndhcmRIZWFkZXJzYCBzbyB2aWV3ZXItc3VwcGxpZWQgdGVuYW50IGhlYWRlcnNcbiAgICogY2Fubm90IGluZmx1ZW5jZSBvcmlnaW4gcm91dGluZyBvciBIVE1MIGNhY2hlIHBhcnRpdGlvbmluZy4gV2hlbiB0cnVlLFxuICAgKiBBcHBUaGVvcnkgcmVzdG9yZXMgbGVnYWN5IHBhc3N0aHJvdWdoIGJlaGF2aW9yIGZvciBgeC10ZW5hbnQtaWRgIGFuZCBhbnlcbiAgICogdGVuYW50LWxpa2UgYHNzckZvcndhcmRIZWFkZXJzYC5cbiAgICpcbiAgICogUHJlZmVyIGRlcml2aW5nIHRlbmFudCBmcm9tIHRydXN0ZWQgaG9zdCBtYXBwaW5nIHVzaW5nIHRoZSBvcmlnaW5hbC1ob3N0XG4gICAqIGVkZ2UgaGVhZGVycyBpbnN0ZWFkIG9mIGVuYWJsaW5nIHBhc3N0aHJvdWdoLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSB0aGUgYnVja2V0cyB0aGlzIGNvbnN0cnVjdCBjcmVhdGVzIHRha2VcbiAgICogdGhlaXIgbmFtZXMgZnJvbSB0aGUgY29udHJhY3QgYW5kIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG9cbiAgICogYGxvZ3MvYWNjZXNzL2Nkbi97bG9naWNhbE5hbWV9YCB0aHJvdWdoIENsb3VkV2F0Y2ggTG9ncyB2ZW5kZWQgZGVsaXZlcnkuXG4gICAqIFBhc3MgYGVuYWJsZUxvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0IG9mIHRoZSBkZWxpdmVyeS5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBzaXRlJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW4gYVxuICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDbG91ZEZyb250IHN0YW5kYXJkLWxvZ2dpbmcgb3V0cHV0IGZvcm1hdCBmb3IgYSBDbG91ZFdhdGNoIExvZ3NcbiAgICogZGVzdGluYXRpb24uIE9ubHkgdXNlZCB1bmRlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LkpTT05cbiAgICovXG4gIHJlYWRvbmx5IGNsb3VkRnJvbnRMb2dGb3JtYXQ/OiBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0O1xuXG4gIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogQ2xvdWRGcm9udCByZXNwb25zZSBoZWFkZXJzIHBvbGljeSBhcHBsaWVkIHRvIFNTUiBhbmQgZGlyZWN0LVMzIGJlaGF2aW9ycy5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IHByb3Zpc2lvbnMgYSBGYWNlVGhlb3J5LWFsaWduZWQgYmFzZWxpbmUgcG9saWN5IGF0IHRoZSBDRE5cbiAgICogbGF5ZXI6IEhTVFMsIG5vc25pZmYsIGZyYW1lLW9wdGlvbnMsIHJlZmVycmVyLXBvbGljeSwgWFNTIHByb3RlY3Rpb24sIGFuZCBhXG4gICAqIHJlc3RyaWN0aXZlIHBlcm1pc3Npb25zLXBvbGljeS4gQ29udGVudC1TZWN1cml0eS1Qb2xpY3kgcmVtYWlucyBvcmlnaW4tZGVmaW5lZC5cbiAgICovXG4gIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAvKipcbiAgICogQ2FjaGUgcG9saWN5IGFwcGxpZWQgdG8gZGlyZWN0IExhbWJkYS1iYWNrZWQgU1NSIGJlaGF2aW9ycy5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgaXMgYENBQ0hJTkdfRElTQUJMRURgIHNvIGR5bmFtaWMgTGFtYmRhIHJvdXRlcyBzdGF5IHNhZmUgdW5sZXNzIHlvdVxuICAgKiBpbnRlbnRpb25hbGx5IG9wdCBpbnRvIGEgY2FjaGUgcG9saWN5IHRoYXQgbWF0Y2hlcyB5b3VyIGFwcCdzIHZhcmlhbmNlIG1vZGVsLlxuICAgKiBAZGVmYXVsdCBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRURcbiAgICovXG4gIHJlYWRvbmx5IHNzckNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgLyoqXG4gICAqIENhY2hlIHBvbGljeSBhcHBsaWVkIHRvIHRoZSBjYWNoZWFibGUgSFRNTCBiZWhhdmlvciBpbiBgc3NnLWlzcmAgbW9kZS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5IHBvbGljeSBrZXlzIG9uIHF1ZXJ5IHN0cmluZ3MgcGx1cyB0aGUgc3RhYmxlIHB1YmxpYyBIVE1MXG4gICAqIHZhcmlhbnQgaGVhZGVycyAoYHgtKi1vcmlnaW5hbC1ob3N0YCBhbmQgYW55IG5vbi10ZW5hbnQgZXh0cmEgZm9yd2FyZGVkXG4gICAqIGhlYWRlcnMgeW91IG9wdCBpbnRvKSB3aGlsZSBsZWF2aW5nIGNvb2tpZXMgb3V0IG9mIHRoZSBjYWNoZSBrZXkuIFRlbmFudC1saWtlXG4gICAqIHZpZXdlciBoZWFkZXJzIGpvaW4gdGhlIGNhY2hlIGtleSBvbmx5IHdoZW4gYGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc2AgaXNcbiAgICogZXhwbGljaXRseSBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbENhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICByZWFkb25seSBkb21haW5OYW1lPzogc3RyaW5nO1xuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZHMgYW5kIG9wdGlvbmFsIGNlcnRpZmljYXRlIHZhbGlkYXRpb24uXG4gICAqXG4gICAqIFdoZW4gYGRvbWFpbk5hbWVgIGlzIHNldCB3aXRob3V0IGBjZXJ0aWZpY2F0ZUFybmAsIGhvc3RlZC16b25lIGNlcnRpZmljYXRlXG4gICAqIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvbiBpcyBleHBsaWNpdGx5IGB1cy1lYXN0LTFgLlxuICAgKiBDbG91ZEZyb250IHJlcXVpcmVzIHZpZXdlciBjZXJ0aWZpY2F0ZXMgaW4gYHVzLWVhc3QtMWA7IGVudmlyb25tZW50LWFnbm9zdGljXG4gICAqIG9yIG90aGVyLXJlZ2lvbiBzdGFja3MgbXVzdCBwcm92aWRlIGBjZXJ0aWZpY2F0ZUFybmAuXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcbiAgLyoqXG4gICAqIEV4aXN0aW5nIEFDTSBjZXJ0aWZpY2F0ZSBBUk4gZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogVGhlIGNlcnRpZmljYXRlIG11c3QgYmUgaW4gYHVzLWVhc3QtMWAgZm9yIENsb3VkRnJvbnQuXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTc3JTaXRlQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW4ge1xuICAvKipcbiAgICogTGFtYmRhIGZ1bmN0aW9uIHRoYXQgQXBwVGhlb3J5IGV4cG9zZXMgYXMgYSBiZWFyZXItYXV0aCBGdW5jdGlvbiBVUkwgY28tb3JpZ2luLlxuICAgKlxuICAgKiBBcHBUaGVvcnkgY3JlYXRlcyB0aGUgRnVuY3Rpb24gVVJMIHdpdGggYGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLk5PTkVgOyBhdXRoZW50aWNhdGlvbiByZW1haW5zXG4gICAqIHRoZSByZXNwb25zaWJpbGl0eSBvZiB0aGUgTGFtYmRhIGhhbmRsZXIuXG4gICAqL1xuICByZWFkb25seSBmdW5jdGlvbjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogQ2xvdWRGcm9udCBwYXRoIHBhdHRlcm5zIHRoYXQgcm91dGUgdG8gdGhpcyBjby1vcmlnaW4uXG4gICAqXG4gICAqIFBhdHRlcm5zIGFyZSBub3JtYWxpemVkIHRoZSBzYW1lIHdheSBhcyBgc3NyUGF0aFBhdHRlcm5zYC4gQSBwYXR0ZXJuIGVuZGluZyBpbiBgLypgIGFsc28gY3JlYXRlc1xuICAgKiBhIHJvb3QgYmVoYXZpb3Igd2l0aG91dCB0aGUgd2lsZGNhcmQgc28gYC9hcGkvKmAgY292ZXJzIGJvdGggYC9hcGlgIGFuZCBgL2FwaS8uLi5gLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0aFBhdHRlcm5zOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpbnZva2UgbW9kZSBmb3IgdGhpcyBjby1vcmlnaW4uXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5JbnZva2VNb2RlLkJVRkZFUkVEXG4gICAqL1xuICByZWFkb25seSBpbnZva2VNb2RlPzogbGFtYmRhLkludm9rZU1vZGU7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlTc3JTaXRlIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c0J1Y2tldDogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c0tleVByZWZpeDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzTWFuaWZlc3RLZXk6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGh0bWxTdG9yZUJ1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBodG1sU3RvcmVLZXlQcmVmaXg/OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBzc3JVcmw6IGxhbWJkYS5GdW5jdGlvblVybDtcbiAgcHVibGljIHJlYWRvbmx5IGJlYXJlckZ1bmN0aW9uVXJsczogbGFtYmRhLkZ1bmN0aW9uVXJsW107XG4gIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVNzclNpdGVQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAoIXByb3BzPy5zc3JGdW5jdGlvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBzaXRlTW9kZSA9IHByb3BzLm1vZGUgPz8gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFk7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICBjb25zdCB3aXJlUnVudGltZUVudiA9IHByb3BzLndpcmVSdW50aW1lRW52ID8/IHRydWU7XG4gICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgY29uc3QgbG9naWNhbCA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICBjb25zdCBlbmFibGVMb2dnaW5nID0gcHJvcHMuZW5hYmxlTG9nZ2luZyA/PyB0cnVlO1xuICAgIGNvbnN0IGlzck1ldGFkYXRhTG9naWNhbCA9IGxvZ2ljYWwgPyBgJHtsb2dpY2FsfS1pc3ItbWV0YWRhdGFgIDogdW5kZWZpbmVkO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShcbiAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICBcIkFwcFRoZW9yeVNzclNpdGVcIixcbiAgICAgIFwiaXNyTWV0YWRhdGFUYWJsZU5hbWVcIixcbiAgICAgIFwiZHluYW1vZGJfdGFibGVcIixcbiAgICAgIGlzck1ldGFkYXRhTG9naWNhbCxcbiAgICAgIHByb3BzLmlzck1ldGFkYXRhVGFibGVOYW1lICE9PSB1bmRlZmluZWQsXG4gICAgKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgXCJBcHBUaGVvcnlTc3JTaXRlXCIsXG4gICAgICBcImNhY2hlVGFibGVOYW1lXCIsXG4gICAgICBcImR5bmFtb2RiX3RhYmxlXCIsXG4gICAgICBpc3JNZXRhZGF0YUxvZ2ljYWwsXG4gICAgICBwcm9wcy5jYWNoZVRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkLFxuICAgICk7XG4gICAgaWYgKG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBwcm9wcy5sb2dzQnVja2V0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlTc3JTaXRlIGNhbm5vdCBob25vciBwcm9wcy5sb2dzQnVja2V0IHVuZGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGU7IENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG8gdGhlIGNvbnRyYWN0IGxvZyBncm91cCwgc28gcmVtb3ZlIHByb3BzLmxvZ3NCdWNrZXQgb3IgdXNlIHRoZSBsZWdhY3kgbG9nZ2luZyBwcm9maWxlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBzdGFuZGFyZExvZ2dpbmcgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgZW5hYmxlTG9nZ2luZztcblxuICAgIHRoaXMuYXNzZXRzQnVja2V0ID1cbiAgICAgIHByb3BzLmFzc2V0c0J1Y2tldCA/P1xuICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkFzc2V0c0J1Y2tldFwiLCB7XG4gICAgICAgIC4uLihuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgPyBidWNrZXROYW1pbmdQcm9wcyhuYW1pbmdDb250ZXh0LCBgJHtsb2dpY2FsfS1hc3NldHNgKSA6IHt9KSxcbiAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgIH0pO1xuXG4gICAgaWYgKGVuYWJsZUxvZ2dpbmcgJiYgIXN0YW5kYXJkTG9nZ2luZykge1xuICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBhc3NldHNQcmVmaXhSYXcgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhwcm9wcy5hc3NldHNLZXlQcmVmaXggPz8gXCJhc3NldHNcIikudHJpbSgpLCBcIi9cIik7XG4gICAgY29uc3QgYXNzZXRzS2V5UHJlZml4ID0gYXNzZXRzUHJlZml4UmF3IHx8IFwiYXNzZXRzXCI7XG5cbiAgICBjb25zdCBtYW5pZmVzdFJhdyA9IFN0cmluZyhwcm9wcy5hc3NldHNNYW5pZmVzdEtleSA/PyBgJHthc3NldHNLZXlQcmVmaXh9L21hbmlmZXN0Lmpzb25gKS50cmltKCk7XG4gICAgY29uc3QgbWFuaWZlc3RLZXkgPSB0cmltUmVwZWF0ZWRDaGFyKG1hbmlmZXN0UmF3LCBcIi9cIik7XG4gICAgY29uc3QgYXNzZXRzTWFuaWZlc3RLZXkgPSBtYW5pZmVzdEtleSB8fCBgJHthc3NldHNLZXlQcmVmaXh9L21hbmlmZXN0Lmpzb25gO1xuXG4gICAgdGhpcy5hc3NldHNLZXlQcmVmaXggPSBhc3NldHNLZXlQcmVmaXg7XG4gICAgdGhpcy5hc3NldHNNYW5pZmVzdEtleSA9IGFzc2V0c01hbmlmZXN0S2V5O1xuXG4gICAgY29uc3QgaHRtbFN0b3JlS2V5UHJlZml4SW5wdXQgPSBTdHJpbmcocHJvcHMuaHRtbFN0b3JlS2V5UHJlZml4ID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBzaG91bGRDb25maWd1cmVIdG1sU3RvcmUgPSBCb29sZWFuKHByb3BzLmh0bWxTdG9yZUJ1Y2tldCkgfHwgaHRtbFN0b3JlS2V5UHJlZml4SW5wdXQubGVuZ3RoID4gMDtcbiAgICBpZiAoc2hvdWxkQ29uZmlndXJlSHRtbFN0b3JlKSB7XG4gICAgICBjb25zdCBodG1sU3RvcmVQcmVmaXhSYXcgPSB0cmltUmVwZWF0ZWRDaGFyKFxuICAgICAgICBTdHJpbmcocHJvcHMuaHRtbFN0b3JlS2V5UHJlZml4ID8/IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXgpLnRyaW0oKSxcbiAgICAgICAgXCIvXCIsXG4gICAgICApO1xuICAgICAgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXggPSBodG1sU3RvcmVQcmVmaXhSYXcgfHwgZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeDtcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0ID1cbiAgICAgICAgcHJvcHMuaHRtbFN0b3JlQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJIdG1sU3RvcmVCdWNrZXRcIiwge1xuICAgICAgICAgIC4uLihuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgPyBidWNrZXROYW1pbmdQcm9wcyhuYW1pbmdDb250ZXh0LCBgJHtsb2dpY2FsfS1odG1sLXN0b3JlYCkgOiB7fSksXG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLmlzck1ldGFkYXRhVGFibGUgPSBwcm9wcy5pc3JNZXRhZGF0YVRhYmxlO1xuXG4gICAgY29uc3QgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSA9IFN0cmluZyhwcm9wcy5pc3JNZXRhZGF0YVRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgbGVnYWN5Q2FjaGVUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuY2FjaGVUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHJlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcodGhpcy5pc3JNZXRhZGF0YVRhYmxlPy50YWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgY29uc3QgY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbcmVzb3VyY2VJc3JNZXRhZGF0YVRhYmxlTmFtZSwgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSwgbGVnYWN5Q2FjaGVUYWJsZU5hbWVdLmZpbHRlcihcbiAgICAgICAgICAobmFtZSkgPT4gU3RyaW5nKG5hbWUpLnRyaW0oKS5sZW5ndGggPiAwLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICApO1xuXG4gICAgaWYgKGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMubGVuZ3RoID4gMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBjb25mbGljdGluZyBJU1IgbWV0YWRhdGEgdGFibGUgbmFtZXM6ICR7Y29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgbGV0IGlzck1ldGFkYXRhVGFibGVOYW1lID0gY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lc1swXSA/PyBcIlwiO1xuXG4gICAgLy8gVW5kZXIgYSBuYW1pbmcgY29udGV4dCB0aGUgSVNSL2NhY2hlIG1ldGFkYXRhIHRhYmxlIGlzIG5hbWVkIHRocm91Z2ggdGhlXG4gICAgLy8gY29udHJhY3Qgb25seSB3aGVuIHRoZSBjb25zdHJ1Y3Qgd2lyZXMgYSBuYW1lIHRoZSBjYWxsZXIgZGlkIG5vdCBzdXBwbHkuXG4gICAgLy8gYHNzZy1pc3JgIG5lZWRzIGEgdGFibGUsIHNvIGl0IGNvbnN1bWVzIHRoZSBge2xvZ2ljYWx9LWlzci1tZXRhZGF0YWBcbiAgICAvLyBlbnRyeS4gQW4gZXh0ZXJuYWwgdGFibGUgcGFzc2VkIHRocm91Z2ggYGlzck1ldGFkYXRhVGFibGVgIGlzIHRoZVxuICAgIC8vIGNhbGxlcidzIHJlc291cmNlOiBpdCBjb25zdW1lcyBubyBlbnRyeSwgc28gYW4gZW50cnkgbmFtaW5nIGl0IGlzIGFuXG4gICAgLy8gb3JwaGFuIChyMywgQURWLTEzMTItMjsgTTIgcmVzaWR1YWwpLlxuICAgIGlmIChcbiAgICAgIG5hbWluZ0NvbnRleHQgJiZcbiAgICAgIGxvZ2ljYWwgJiZcbiAgICAgIHByb3BzLmlzck1ldGFkYXRhVGFibGUgPT09IHVuZGVmaW5lZCAmJlxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICApIHtcbiAgICAgIGNvbnN0IGNvbXBvc2VkID0gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJkeW5hbW9kYl90YWJsZVwiLCBgJHtsb2dpY2FsfS1pc3ItbWV0YWRhdGFgKTtcbiAgICAgIGlmIChpc3JNZXRhZGF0YVRhYmxlTmFtZSA9PT0gXCJcIiAmJiAhY29tcG9zZWQuZ2VuZXJhdGVkICYmIGNvbXBvc2VkLm5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpc3JNZXRhZGF0YVRhYmxlTmFtZSA9IGNvbXBvc2VkLm5hbWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmFzc2V0c1BhdGgpIHtcbiAgICAgIG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsIFwiQXNzZXRzRGVwbG95bWVudFwiLCB7XG4gICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQocHJvcHMuYXNzZXRzUGF0aCldLFxuICAgICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5hc3NldHNCdWNrZXQsXG4gICAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiBhc3NldHNLZXlQcmVmaXgsXG4gICAgICAgIHBydW5lOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhdGljUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKHByb3BzLnN0YXRpY1BhdGhQYXR0ZXJucyk7XG4gICAgY29uc3QgZGlyZWN0UzNQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMoW1xuICAgICAgLi4uKHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gW3NzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zKSA/IHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IHNzclBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhbXG4gICAgICAuLi4oc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBbc3NnSXNyU3NyRGF0YVBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLnNzclBhdGhQYXR0ZXJucykgPyBwcm9wcy5zc3JQYXRoUGF0dGVybnMgOiBbXSksXG4gICAgXSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zID0gQXJyYXkuaXNBcnJheShwcm9wcy5iZWFyZXJGdW5jdGlvblVybE9yaWdpbnMpXG4gICAgICA/IHByb3BzLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1xuICAgICAgOiBbXTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MgPSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMubWFwKChvcmlnaW4sIGluZGV4KSA9PiB7XG4gICAgICBpZiAoIW9yaWdpbj8uZnVuY3Rpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1ske2luZGV4fV0gcmVxdWlyZXMgZnVuY3Rpb25gKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhvcmlnaW4ucGF0aFBhdHRlcm5zKTtcbiAgICAgIGlmIChwYXRoUGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5U3NyU2l0ZSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnNbJHtpbmRleH1dIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBwYXRoIHBhdHRlcm5gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IG9yaWdpbiwgcGF0aFBhdHRlcm5zIH07XG4gICAgfSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxQYXRoUGF0dGVybnMgPSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZmxhdE1hcCgoY29uZmlnKSA9PiBjb25maWcucGF0aFBhdHRlcm5zKTtcbiAgICBjb25zdCBiZWhhdmlvclBhdHRlcm5Pd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybnM6IFNlZW5CZWhhdmlvclBhdHRlcm5bXSA9IFtdO1xuICAgIGNvbnN0IHNzclVybEF1dGhUeXBlID0gcHJvcHMuc3NyVXJsQXV0aFR5cGUgPz8gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTTtcbiAgICBjb25zdCBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMgPSBwcm9wcy5hbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMgPz8gZmFsc2U7XG5cbiAgICB0aGlzLnNzclVybCA9IG5ldyBsYW1iZGEuRnVuY3Rpb25VcmwodGhpcywgXCJTc3JVcmxcIiwge1xuICAgICAgZnVuY3Rpb246IHByb3BzLnNzckZ1bmN0aW9uLFxuICAgICAgYXV0aFR5cGU6IHNzclVybEF1dGhUeXBlLFxuICAgICAgaW52b2tlTW9kZTogcHJvcHMuaW52b2tlTW9kZSA/PyBsYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzc3JPcmlnaW4gPVxuICAgICAgc3NyVXJsQXV0aFR5cGUgPT09IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICAgICAgPyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuc3NyVXJsKVxuICAgICAgICA6IG5ldyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luKHRoaXMuc3NyVXJsKTtcblxuICAgIGNvbnN0IGFzc2V0c09yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5hc3NldHNCdWNrZXQpO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5CdWNrZXQgPSB0aGlzLmh0bWxTdG9yZUJ1Y2tldCA/PyB0aGlzLmFzc2V0c0J1Y2tldDtcbiAgICBjb25zdCBodG1sT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChcbiAgICAgIGh0bWxPcmlnaW5CdWNrZXQsXG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldCAmJiB0aGlzLmh0bWxTdG9yZUtleVByZWZpeFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIG9yaWdpblBhdGg6IGAvJHt0aGlzLmh0bWxTdG9yZUtleVByZWZpeH1gLFxuICAgICAgICAgIH1cbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgKTtcblxuICAgIGNvbnN0IGJhc2VTc3JGb3J3YXJkSGVhZGVycyA9IFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxIb3N0SGVhZGVycyxcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgXTtcblxuICAgIGNvbnN0IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IG5ldyBTZXQoW1wiaG9zdFwiLCBcIngtZm9yd2FyZGVkLXByb3RvXCJdKTtcblxuICAgIGNvbnN0IGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5pc0FycmF5KHByb3BzLnNzckZvcndhcmRIZWFkZXJzKVxuICAgICAgPyBwcm9wcy5zc3JGb3J3YXJkSGVhZGVycy5tYXAoY2Fub25pY2FsaXplSGVhZGVyTmFtZSkuZmlsdGVyKChoZWFkZXIpID0+IGhlYWRlci5sZW5ndGggPiAwKVxuICAgICAgOiBbXTtcblxuICAgIGNvbnN0IHJlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSkpLFxuICAgICkuc29ydCgpO1xuXG4gICAgaWYgKHJlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRpc2FsbG93cyBzc3JGb3J3YXJkSGVhZGVyczogJHtyZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcikpKSxcbiAgICApLnNvcnQoKTtcblxuICAgIGlmIChyZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVycy5sZW5ndGggPiAwICYmICFhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPXRydWUgZm9yIHRlbmFudC1saWtlIHNzckZvcndhcmRIZWFkZXJzOiAke3JlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB0ZW5hbnRQYXNzdGhyb3VnaEhlYWRlcnMgPSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNcbiAgICAgID8gQXJyYXkuZnJvbShuZXcgU2V0KFtkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyLCAuLi5yZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVyc10pKVxuICAgICAgOiBbXTtcbiAgICBjb25zdCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyA9IGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc1xuICAgICAgPyBbXVxuICAgICAgOiBBcnJheS5mcm9tKG5ldyBTZXQoW2RlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIsIC4uLnJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzXSkpLnNvcnQoKTtcblxuICAgIGNvbnN0IHNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIFsuLi5iYXNlU3NyRm9yd2FyZEhlYWRlcnMsIC4uLnRlbmFudFBhc3N0aHJvdWdoSGVhZGVycywgLi4uZXh0cmFTc3JGb3J3YXJkSGVhZGVyc10uZmlsdGVyKFxuICAgICAgICAgIChoZWFkZXIpID0+ICFkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuaGFzKGhlYWRlciksXG4gICAgICAgICksXG4gICAgICApLFxuICAgICk7XG4gICAgY29uc3QgaHRtbENhY2hlS2V5RXhjbHVkZWRIZWFkZXJzID0gbmV3IFNldChbXG4gICAgICBcImNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvXCIsXG4gICAgICBcImNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NcIixcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgXSk7XG4gICAgY29uc3QgaHRtbENhY2hlS2V5SGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KHNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiAhaHRtbENhY2hlS2V5RXhjbHVkZWRIZWFkZXJzLmhhcyhoZWFkZXIpKSksXG4gICAgKTtcbiAgICBjb25zdCBtYXhCZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycyA9IDEwO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKG5ldyBTZXQoWy4uLmJhc2VTc3JGb3J3YXJkSGVhZGVycywgXCJjb250ZW50LXR5cGVcIl0pKTtcbiAgICBjb25zdCBpc0Jsb2NrZWRCZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVyID0gKGhlYWRlcjogc3RyaW5nKTogYm9vbGVhbiA9PlxuICAgICAgaGVhZGVyID09PSBcImhvc3RcIiB8fFxuICAgICAgaGVhZGVyID09PSBcImZvcndhcmRlZFwiIHx8XG4gICAgICBoZWFkZXIgPT09IFwieC1yZWFsLWlwXCIgfHxcbiAgICAgIGhlYWRlci5zdGFydHNXaXRoKFwieC1mb3J3YXJkZWQtXCIpIHx8XG4gICAgICBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyKTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbXG4gICAgICAgICAgXCJhdXRob3JpemF0aW9uXCIsXG4gICAgICAgICAgXCJhY2NlcHRcIixcbiAgICAgICAgICBcIm9yaWdpblwiLFxuICAgICAgICAgIFwiYWNjZXNzLWNvbnRyb2wtcmVxdWVzdC1tZXRob2RcIixcbiAgICAgICAgICBcImFjY2Vzcy1jb250cm9sLXJlcXVlc3QtaGVhZGVyc1wiLFxuICAgICAgICAgIC4uLmV4dHJhU3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKFxuICAgICAgICAgICAgKGhlYWRlcikgPT5cbiAgICAgICAgICAgICAgIWlzQmxvY2tlZEJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXIoaGVhZGVyKSAmJlxuICAgICAgICAgICAgICAhYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Gb3J3YXJkSGVhZGVycy5pbmNsdWRlcyhoZWFkZXIpLFxuICAgICAgICAgICksXG4gICAgICAgIF0uZmlsdGVyKChoZWFkZXIpID0+IGhlYWRlci5sZW5ndGggPiAwKSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIGlmICghcHJvcHMuaHRtbENhY2hlUG9saWN5ICYmIGh0bWxDYWNoZUtleUhlYWRlcnMubGVuZ3RoID4gbWF4RGVmYXVsdENhY2hlS2V5SGVhZGVycykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBkZWZhdWx0IGh0bWxDYWNoZVBvbGljeSBzdXBwb3J0cyBhdCBtb3N0ICR7bWF4RGVmYXVsdENhY2hlS2V5SGVhZGVyc30gY2FjaGUta2V5IGhlYWRlcnM7IHJlY2VpdmVkICR7aHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGh9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5sZW5ndGggPiAwICYmXG4gICAgICBiZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycy5sZW5ndGggPiBtYXhCZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVyc1xuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMgc3VwcG9ydCBhdCBtb3N0ICR7bWF4QmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcnN9IGNhY2hlLWtleSBmb3J3YXJkZWQgaGVhZGVyczsgcmVjZWl2ZWQgJHtiZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycy5sZW5ndGh9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3NyT3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJTc3JPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsKCksXG4gICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLnNzckZvcndhcmRIZWFkZXJzKSxcbiAgICB9KTtcbiAgICBjb25zdCBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJIdG1sT3JpZ2luUmVxdWVzdFBvbGljeVwiLCB7XG4gICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IHNzckNhY2hlUG9saWN5ID0gcHJvcHMuc3NyQ2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVEO1xuICAgIGNvbnN0IHN0YXRpY0Fzc2V0c0NhY2hlUG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJTdGF0aWNBc3NldHNDYWNoZVBvbGljeVwiLCB7XG4gICAgICBjb21tZW50OlxuICAgICAgICBcIkFwcFRoZW9yeSBkaXJlY3QgUzMgYXNzZXQvZGF0YSBjYWNoZSBwb2xpY3k6IG9yaWdpbiBDYWNoZS1Db250cm9sIGJvdW5kZWQgYnkgbm8gdmlld2VyIGhlYWRlciBmb3J3YXJkaW5nXCIsXG4gICAgICBtaW5UdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgbWF4VHRsOiBEdXJhdGlvbi5kYXlzKDM2NSksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUNvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZVF1ZXJ5U3RyaW5nQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICBlbmFibGVBY2NlcHRFbmNvZGluZ0d6aXA6IHRydWUsXG4gICAgfSk7XG4gICAgY29uc3QgaHRtbENhY2hlUG9saWN5ID1cbiAgICAgIHByb3BzLmh0bWxDYWNoZVBvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJIdG1sQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgSFRNTCBjYWNoZSBwb2xpY3kga2V5ZWQgYnkgcXVlcnkgc3RyaW5ncyBhbmQgc3RhYmxlIHB1YmxpYyB2YXJpYW50IGhlYWRlcnNcIixcbiAgICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBtYXhUdGw6IER1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmh0bWxDYWNoZUtleUhlYWRlcnMpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nR3ppcDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luUmVxdWVzdFBvbGljeSA9XG4gICAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MubGVuZ3RoID4gMFxuICAgICAgICA/IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJCZWFyZXJGdW5jdGlvblVybE9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoXG4gICAgICAgICAgICAgIC4uLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luRm9yd2FyZEhlYWRlcnMsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIH0pXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVQb2xpY3kgPVxuICAgICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmxlbmd0aCA+IDBcbiAgICAgICAgPyBuZXcgY2xvdWRmcm9udC5DYWNoZVBvbGljeSh0aGlzLCBcIkJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICAgICAgY29tbWVudDpcbiAgICAgICAgICAgICAgXCJBcHBUaGVvcnkgYmVhcmVyIEZ1bmN0aW9uIFVSTCBBUEkgY2FjaGUgcG9saWN5OiBjYWNoaW5nIGRpc2FibGVkIHdoaWxlIGZvcndhcmRpbmcgYmVhcmVyL0NPUlMgYXBwIGhlYWRlcnNcIixcbiAgICAgICAgICAgIG1pblR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgICAgIGRlZmF1bHRUdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgICAgICBtYXhUdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUNvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXJzKSxcbiAgICAgICAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVRdWVyeVN0cmluZ0JlaGF2aW9yLm5vbmUoKSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IHVuZGVmaW5lZDtcblxuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFxuICAgICAgXCJkaXJlY3QgUzMgcGF0aHNcIixcbiAgICAgIFtgJHthc3NldHNLZXlQcmVmaXh9LypgLCAuLi5kaXJlY3RTM1BhdGhQYXR0ZXJuc10sXG4gICAgICBiZWhhdmlvclBhdHRlcm5Pd25lcnMsXG4gICAgICBiZWhhdmlvclBhdHRlcm5zLFxuICAgICk7XG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJzdGF0aWMgSFRNTCBwYXRoc1wiLCBzdGF0aWNQYXRoUGF0dGVybnMsIGJlaGF2aW9yUGF0dGVybk93bmVycywgYmVoYXZpb3JQYXR0ZXJucyk7XG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJkaXJlY3QgU1NSIHBhdGhzXCIsIHNzclBhdGhQYXR0ZXJucywgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLCBiZWhhdmlvclBhdHRlcm5zKTtcbiAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZm9yRWFjaCgoY29uZmlnLCBpbmRleCkgPT4ge1xuICAgICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gICAgICAgIGBiZWFyZXIgRnVuY3Rpb24gVVJMIGNvLW9yaWdpbiAke2luZGV4ICsgMX1gLFxuICAgICAgICBjb25maWcucGF0aFBhdHRlcm5zLFxuICAgICAgICBiZWhhdmlvclBhdHRlcm5Pd25lcnMsXG4gICAgICAgIGJlaGF2aW9yUGF0dGVybnMsXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgdmlld2VyUmVxdWVzdEZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShcbiAgICAgICAgZ2VuZXJhdGVTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25Db2RlKFxuICAgICAgICAgIHNpdGVNb2RlLFxuICAgICAgICAgIFtgJHthc3NldHNLZXlQcmVmaXh9LypgLCAuLi5kaXJlY3RTM1BhdGhQYXR0ZXJuc10sXG4gICAgICAgICAgWy4uLnNzclBhdGhQYXR0ZXJucywgLi4uYmVhcmVyRnVuY3Rpb25VcmxQYXRoUGF0dGVybnNdLFxuICAgICAgICAgIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgIGNvbW1lbnQ6XG4gICAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgICAgPyBcIkZhY2VUaGVvcnkgdmlld2VyLXJlcXVlc3QgZWRnZSBjb250ZXh0IGFuZCBIVE1MIHJld3JpdGUgZm9yIFNTUiBzaXRlXCJcbiAgICAgICAgICA6IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXNwb25zZUZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uXCIsIHtcbiAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoZ2VuZXJhdGVTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uQ29kZSgpKSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVzcG9uc2UgcmVxdWVzdC1pZCBlY2hvIGZvciBTU1Igc2l0ZVwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zID0gKCk6IGNsb3VkZnJvbnQuRnVuY3Rpb25Bc3NvY2lhdGlvbltdID0+IFtcbiAgICAgIHtcbiAgICAgICAgZnVuY3Rpb246IHZpZXdlclJlcXVlc3RGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgZnVuY3Rpb246IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24sXG4gICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVTUE9OU0UsXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuICAgIGxldCBkaXN0cmlidXRpb25Eb21haW5OYW1lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG4gICAgICBjb25zdCBjZXJ0QXJuID0gU3RyaW5nKHByb3BzLmNlcnRpZmljYXRlQXJuID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmIChjZXJ0QXJuKSB7XG4gICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkNlcnRpZmljYXRlXCIsIGNlcnRBcm4pO1xuICAgICAgfSBlbHNlIGlmIChwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICAgIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24odGhpcyk7XG4gICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgIHZhbGlkYXRpb246IGFjbS5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucyhwcm9wcy5ob3N0ZWRab25lKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIHByb3BzLmNlcnRpZmljYXRlQXJuIG9yIHByb3BzLmhvc3RlZFpvbmUgd2hlbiBwcm9wcy5kb21haW5OYW1lIGlzIHNldFwiKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA9XG4gICAgICBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgIG5ldyBjbG91ZGZyb250LlJlc3BvbnNlSGVhZGVyc1BvbGljeSh0aGlzLCBcIlJlc3BvbnNlSGVhZGVyc1BvbGljeVwiLCB7XG4gICAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSBiYXNlbGluZSBzZWN1cml0eSBoZWFkZXJzIChDU1Agc3RheXMgb3JpZ2luLWRlZmluZWQpXCIsXG4gICAgICAgIHNlY3VyaXR5SGVhZGVyc0JlaGF2aW9yOiB7XG4gICAgICAgICAgc3RyaWN0VHJhbnNwb3J0U2VjdXJpdHk6IHtcbiAgICAgICAgICAgIGFjY2Vzc0NvbnRyb2xNYXhBZ2U6IER1cmF0aW9uLmRheXMoMzY1ICogMiksXG4gICAgICAgICAgICBpbmNsdWRlU3ViZG9tYWluczogdHJ1ZSxcbiAgICAgICAgICAgIHByZWxvYWQ6IHRydWUsXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGNvbnRlbnRUeXBlT3B0aW9uczogeyBvdmVycmlkZTogdHJ1ZSB9LFxuICAgICAgICAgIGZyYW1lT3B0aW9uczoge1xuICAgICAgICAgICAgZnJhbWVPcHRpb246IGNsb3VkZnJvbnQuSGVhZGVyc0ZyYW1lT3B0aW9uLkRFTlksXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHJlZmVycmVyUG9saWN5OiB7XG4gICAgICAgICAgICByZWZlcnJlclBvbGljeTogY2xvdWRmcm9udC5IZWFkZXJzUmVmZXJyZXJQb2xpY3kuU1RSSUNUX09SSUdJTl9XSEVOX0NST1NTX09SSUdJTixcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgeHNzUHJvdGVjdGlvbjoge1xuICAgICAgICAgICAgcHJvdGVjdGlvbjogdHJ1ZSxcbiAgICAgICAgICAgIG1vZGVCbG9jazogdHJ1ZSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGN1c3RvbUhlYWRlcnNCZWhhdmlvcjoge1xuICAgICAgICAgIGN1c3RvbUhlYWRlcnM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgaGVhZGVyOiBcInBlcm1pc3Npb25zLXBvbGljeVwiLFxuICAgICAgICAgICAgICB2YWx1ZTogXCJjYW1lcmE9KCksIG1pY3JvcGhvbmU9KCksIGdlb2xvY2F0aW9uPSgpXCIsXG4gICAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVTdGF0aWNCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBhc3NldHNPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogc3RhdGljQXNzZXRzQ2FjaGVQb2xpY3ksXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogaHRtbENhY2hlUG9saWN5LFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogaHRtbE9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3NyQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICBjYWNoZVBvbGljeTogc3NyQ2FjaGVQb2xpY3ksXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuICAgIGNvbnN0IGFkZEV4cGFuZGVkQmVoYXZpb3IgPSAocGF0dGVybnM6IHN0cmluZ1tdLCBmYWN0b3J5OiAoKSA9PiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyk6IHZvaWQgPT4ge1xuICAgICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW3BhdHRlcm5dID0gZmFjdG9yeSgpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKFtgJHthc3NldHNLZXlQcmVmaXh9LypgXSwgY3JlYXRlU3RhdGljQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoZGlyZWN0UzNQYXRoUGF0dGVybnMsIGNyZWF0ZVN0YXRpY0JlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHN0YXRpY1BhdGhQYXR0ZXJucywgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHNzclBhdGhQYXR0ZXJucywgY3JlYXRlU3NyQmVoYXZpb3IpO1xuICAgIHRoaXMuYmVhcmVyRnVuY3Rpb25VcmxzID0gW107XG4gICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmZvckVhY2goKGNvbmZpZywgaW5kZXgpID0+IHtcbiAgICAgIGNvbnN0IGZ1bmN0aW9uVXJsID0gbmV3IGxhbWJkYS5GdW5jdGlvblVybCh0aGlzLCBgQmVhcmVyRnVuY3Rpb25Vcmwke2luZGV4ICsgMX1gLCB7XG4gICAgICAgIGZ1bmN0aW9uOiBjb25maWcub3JpZ2luLmZ1bmN0aW9uLFxuICAgICAgICBhdXRoVHlwZTogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuTk9ORSxcbiAgICAgICAgaW52b2tlTW9kZTogY29uZmlnLm9yaWdpbi5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLkJVRkZFUkVELFxuICAgICAgfSk7XG4gICAgICB0aGlzLmJlYXJlckZ1bmN0aW9uVXJscy5wdXNoKGZ1bmN0aW9uVXJsKTtcbiAgICAgIGNvbnN0IGZ1bmN0aW9uVXJsT3JpZ2luID0gbmV3IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4oZnVuY3Rpb25VcmwpO1xuICAgICAgY29uc3QgY3JlYXRlQmVhcmVyRnVuY3Rpb25VcmxCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgICBvcmlnaW46IGZ1bmN0aW9uVXJsT3JpZ2luLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICBjYWNoZVBvbGljeTogYmVhcmVyRnVuY3Rpb25VcmxDYWNoZVBvbGljeSxcbiAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgICB9KTtcbiAgICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoY29uZmlnLnBhdGhQYXR0ZXJucywgY3JlYXRlQmVhcmVyRnVuY3Rpb25VcmxCZWhhdmlvcik7XG4gICAgfSk7XG5cbiAgICBjb25zdCBkZWZhdWx0T3JpZ2luID1cbiAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgID8gbmV3IG9yaWdpbnMuT3JpZ2luR3JvdXAoe1xuICAgICAgICAgICAgcHJpbWFyeU9yaWdpbjogaHRtbE9yaWdpbixcbiAgICAgICAgICAgIGZhbGxiYWNrT3JpZ2luOiBzc3JPcmlnaW4sXG4gICAgICAgICAgICBmYWxsYmFja1N0YXR1c0NvZGVzOiBbNDAzLCA0MDRdLFxuICAgICAgICAgIH0pXG4gICAgICAgIDogc3NyT3JpZ2luO1xuICAgIGNvbnN0IGRlZmF1bHRBbGxvd2VkTWV0aG9kcyA9XG4gICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICA/IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OU1xuICAgICAgICA6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMO1xuXG4gICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgLi4uKGVuYWJsZUxvZ2dpbmcgJiYgdGhpcy5sb2dzQnVja2V0XG4gICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgOiB7fSksXG4gICAgICAuLi4oZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgJiYgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGVcbiAgICAgICAgPyB7IGRvbWFpbk5hbWVzOiBkaXN0cmlidXRpb25Eb21haW5OYW1lcywgY2VydGlmaWNhdGU6IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlIH1cbiAgICAgICAgOiB7fSksXG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgb3JpZ2luOiBkZWZhdWx0T3JpZ2luLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGRlZmF1bHRBbGxvd2VkTWV0aG9kcyxcbiAgICAgICAgY2FjaGVQb2xpY3k6IHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gaHRtbENhY2hlUG9saWN5IDogc3NyQ2FjaGVQb2xpY3ksXG4gICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gaHRtbE9yaWdpblJlcXVlc3RQb2xpY3kgOiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgICB9LFxuICAgICAgYWRkaXRpb25hbEJlaGF2aW9ycyxcbiAgICAgIC4uLihwcm9wcy53ZWJBY2xJZCA/IHsgd2ViQWNsSWQ6IHByb3BzLndlYkFjbElkIH0gOiB7fSksXG4gICAgfSk7XG5cbiAgICBpZiAoc3RhbmRhcmRMb2dnaW5nICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyh7XG4gICAgICAgIHNjb3BlOiB0aGlzLFxuICAgICAgICBpZDogXCJDZG5Mb2dnaW5nXCIsXG4gICAgICAgIGNvbnRleHQ6IG5hbWluZ0NvbnRleHQsXG4gICAgICAgIGRpc3RyaWJ1dGlvbjogdGhpcy5kaXN0cmlidXRpb24sXG4gICAgICAgIGxvZ2ljYWw6IGBsb2dzL2FjY2Vzcy9jZG4vJHtsb2dpY2FsfWAsXG4gICAgICAgIGZvcm1hdDogcHJvcHMuY2xvdWRGcm9udExvZ0Zvcm1hdCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTSkge1xuICAgICAgcHJvcHMuc3NyRnVuY3Rpb24uYWRkUGVybWlzc2lvbihcIkFsbG93Q2xvdWRGcm9udEludm9rZUZ1bmN0aW9uVmlhVXJsXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLFxuICAgICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImNsb3VkZnJvbnQuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgc291cmNlQXJuOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Bcm4sXG4gICAgICAgIGludm9rZWRWaWFGdW5jdGlvblVybDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmh0bWxTdG9yZUJ1Y2tldCkge1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQuZ3JhbnRSZWFkV3JpdGUocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmlzck1ldGFkYXRhVGFibGUpIHtcbiAgICAgIHRoaXMuaXNyTWV0YWRhdGFUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh3aXJlUnVudGltZUVudikge1xuICAgICAgdGhpcy5hc3NldHNCdWNrZXQuZ3JhbnRSZWFkKHByb3BzLnNzckZ1bmN0aW9uKTtcblxuICAgICAgY29uc3Qgc3NyRnVuY3Rpb25BbnkgPSBwcm9wcy5zc3JGdW5jdGlvbiBhcyBhbnk7XG4gICAgICBpZiAodHlwZW9mIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZSB3aXJlUnVudGltZUVudiByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvbiB0byBzdXBwb3J0IGFkZEVudmlyb25tZW50OyBwYXNzIGEgbGFtYmRhLkZ1bmN0aW9uIG9yIHNldCB3aXJlUnVudGltZUVudj1mYWxzZSBhbmQgc2V0IGVudiB2YXJzIG1hbnVhbGx5XCIsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19CVUNLRVRcIiwgdGhpcy5hc3NldHNCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfUFJFRklYXCIsIGFzc2V0c0tleVByZWZpeCk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfTUFOSUZFU1RfS0VZXCIsIGFzc2V0c01hbmlmZXN0S2V5KTtcblxuICAgICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KSB7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfQlVDS0VUXCIsIHRoaXMuaHRtbFN0b3JlQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkZBQ0VUSEVPUllfSVNSX1BSRUZJWFwiLCB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCk7XG4gICAgICB9XG4gICAgICBpZiAoaXNyTWV0YWRhdGFUYWJsZU5hbWUpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQ0FDSEVfVEFCTEVfTkFNRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRvbWFpbk5hbWUgJiYgcHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogZG9tYWluTmFtZSxcbiAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gIH1cbn1cbiJdfQ==