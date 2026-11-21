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
const secure_defaults_1 = require("./private/secure-defaults");
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "7.5.0-rc.2" };
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
        // Security Hub S3.9 stays opt-in: the caller supplies the log target, and it
        // takes no naming entry (resource-naming contract section 4).
        const serverAccessLogs = props.serverAccessLogsBucket !== undefined
            ? {
                serverAccessLogsBucket: props.serverAccessLogsBucket,
                ...(props.serverAccessLogsPrefix !== undefined
                    ? { serverAccessLogsPrefix: props.serverAccessLogsPrefix }
                    : {}),
            }
            : {};
        this.assetsBucket =
            props.assetsBucket ??
                new s3.Bucket(this, "AssetsBucket", {
                    ...(namingContext && logical ? (0, standard_logging_1.bucketNamingProps)(namingContext, `${logical}-assets`) : {}),
                    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                    encryption: s3.BucketEncryption.S3_MANAGED,
                    enforceSSL: true,
                    ...serverAccessLogs,
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
                        ...serverAccessLogs,
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
        // Security Hub CloudFront.15 and CloudFront.1 under a derived naming context.
        const minimumProtocolVersion = (0, secure_defaults_1.defaultMinimumProtocolVersion)(namingContext, distributionCertificate !== undefined, props.minimumProtocolVersion);
        const defaultRootObject = props.defaultRootObject
            ?? ((0, secure_defaults_1.secureDefaults)(namingContext) && siteMode === AppTheorySsrSiteMode.SSG_ISR ? "index.html" : undefined);
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            ...(enableLogging && this.logsBucket
                ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
                : {}),
            ...(distributionDomainNames && distributionCertificate
                ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
                : {}),
            ...(minimumProtocolVersion !== undefined ? { minimumProtocolVersion } : {}),
            ...(defaultRootObject !== undefined ? { defaultRootObject } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQW9FO0FBQ3BFLHdFQUEwRDtBQUMxRCx1RUFBeUQ7QUFDekQsNEVBQThEO0FBRTlELHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsd0VBQTBEO0FBQzFELDJDQUF1QztBQUd2Qyx5REFBNEQ7QUFDNUQseUVBQW9FO0FBQ3BFLGlFQUFnRztBQUNoRywrREFBMEY7QUFHMUYseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLHlCQUF5QixDQUFDO0FBQzNELE1BQU0sNEJBQTRCLEdBQUcsS0FBSyxDQUFDO0FBQzNDLE1BQU0seUJBQXlCLEdBQUcsRUFBRSxDQUFDO0FBQ3JDLE1BQU0seUJBQXlCLEdBQUcsYUFBYSxDQUFDO0FBRWhELElBQVksb0JBWVg7QUFaRCxXQUFZLG9CQUFvQjtJQUM5Qjs7O09BR0c7SUFDSCw2Q0FBcUIsQ0FBQTtJQUVyQjs7O09BR0c7SUFDSCwyQ0FBbUIsQ0FBQTtBQUNyQixDQUFDLEVBWlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFZL0I7QUFFRCxTQUFTLHNCQUFzQixDQUFDLE9BQWU7SUFDN0MsTUFBTSxVQUFVLEdBQUcsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsQ0FBQztJQUMzRixPQUFPLFVBQVUsQ0FBQyxDQUFDLENBQUMsSUFBSSxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQzdDLENBQUM7QUFFRCxTQUFTLHFCQUFxQixDQUFDLFFBQThCO0lBQzNELE9BQU8sS0FBSyxDQUFDLElBQUksQ0FDZixJQUFJLEdBQUcsQ0FDTCxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1NBQ3RDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsR0FBRyxDQUFDLENBQUM7U0FDcEUsTUFBTSxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUMzQyxDQUNGLENBQUM7QUFDSixDQUFDO0FBRUQsU0FBUywwQkFBMEIsQ0FBQyxRQUFrQjtJQUNwRCxNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBRW5DLEtBQUssTUFBTSxPQUFPLElBQUksUUFBUSxFQUFFLENBQUM7UUFDL0IsTUFBTSxVQUFVLEdBQUcsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDdEUsSUFBSSxDQUFDLFVBQVU7WUFBRSxTQUFTO1FBRTFCLFFBQVEsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDekIsSUFBSSxVQUFVLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDOUIsTUFBTSxXQUFXLEdBQUcsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUM1QyxJQUFJLFdBQVcsRUFBRSxDQUFDO2dCQUNoQixRQUFRLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1lBQzVCLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVELE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUM5QixDQUFDO0FBYUQsU0FBUyx5QkFBeUIsQ0FBQyxPQUFlLEVBQUUsS0FBYTtJQUMvRCxNQUFNLE9BQU8sR0FBYSxFQUFFLENBQUM7SUFDN0IsTUFBTSxJQUFJLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUMvQixNQUFNLEtBQUssR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBRXRCLE9BQU8sS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUN4QixNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQ2pDLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ3RCLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNsQixPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBRXRCLElBQUksT0FBTyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBQzdCLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQzFCLENBQUM7SUFDSCxDQUFDO0lBRUQsT0FBTyxPQUFPLENBQUM7QUFDakIsQ0FBQztBQUVELFNBQVMsc0JBQXNCLENBQUMsT0FBZSxFQUFFLEtBQWE7SUFDNUQsTUFBTSxLQUFLLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzdCLElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3hCLE9BQU8sRUFBRSxDQUFDO0lBQ1osQ0FBQztJQUVELElBQUksS0FBSyxLQUFLLEdBQUcsRUFBRSxDQUFDO1FBQ2xCLE9BQU8sQ0FBQyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7SUFDeEMsQ0FBQztJQUVELElBQUksS0FBSyxLQUFLLEdBQUcsRUFBRSxDQUFDO1FBQ2xCLE9BQU8sQ0FBQyxFQUFFLE1BQU0sRUFBRSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFFRCxPQUFPLENBQUMsRUFBRSxNQUFNLEVBQUUsS0FBSyxHQUFHLENBQUMsRUFBRSxHQUFHLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0FBQzdELENBQUM7QUFFRCxTQUFTLHVDQUF1QyxDQUFDLElBQTJCLEVBQUUsS0FBNEI7SUFDeEcsT0FBTyxJQUFJLENBQUMsR0FBRyxJQUFJLEtBQUssQ0FBQyxHQUFHLElBQUksSUFBSSxDQUFDLE9BQU8sS0FBSyxLQUFLLENBQUMsT0FBTyxDQUFDO0FBQ2pFLENBQUM7QUFFRCxTQUFTLHNCQUFzQixDQUFDLElBQVksRUFBRSxLQUFhO0lBQ3pELE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFDckMsTUFBTSxLQUFLLEdBQTRCLEVBQUUsQ0FBQztJQUUxQyxNQUFNLG1CQUFtQixHQUFHLENBQUMsU0FBaUIsRUFBRSxVQUFrQixFQUFRLEVBQUU7UUFDMUUsS0FBSyxNQUFNLFVBQVUsSUFBSSx5QkFBeUIsQ0FBQyxJQUFJLEVBQUUsU0FBUyxDQUFDLEVBQUUsQ0FBQztZQUNwRSxLQUFLLE1BQU0sV0FBVyxJQUFJLHlCQUF5QixDQUFDLEtBQUssRUFBRSxVQUFVLENBQUMsRUFBRSxDQUFDO2dCQUN2RSxNQUFNLEdBQUcsR0FBRyxHQUFHLFVBQVUsSUFBSSxXQUFXLEVBQUUsQ0FBQztnQkFDM0MsSUFBSSxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7b0JBQ3hCLFNBQVM7Z0JBQ1gsQ0FBQztnQkFDRCxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNwQixLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsVUFBVSxFQUFFLFdBQVcsQ0FBQyxDQUFDLENBQUM7WUFDeEMsQ0FBQztRQUNILENBQUM7SUFDSCxDQUFDLENBQUM7SUFFRixtQkFBbUIsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFFMUIsT0FBTyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3hCLE1BQU0sQ0FBQyxTQUFTLEVBQUUsVUFBVSxDQUFDLEdBQUcsS0FBSyxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3hELElBQUksU0FBUyxLQUFLLElBQUksQ0FBQyxNQUFNLElBQUksVUFBVSxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUM3RCxPQUFPLElBQUksQ0FBQztRQUNkLENBQUM7UUFFRCxLQUFLLE1BQU0sY0FBYyxJQUFJLHNCQUFzQixDQUFDLElBQUksRUFBRSxTQUFTLENBQUMsRUFBRSxDQUFDO1lBQ3JFLEtBQUssTUFBTSxlQUFlLElBQUksc0JBQXNCLENBQUMsS0FBSyxFQUFFLFVBQVUsQ0FBQyxFQUFFLENBQUM7Z0JBQ3hFLElBQUksQ0FBQyx1Q0FBdUMsQ0FBQyxjQUFjLEVBQUUsZUFBZSxDQUFDLEVBQUUsQ0FBQztvQkFDOUUsU0FBUztnQkFDWCxDQUFDO2dCQUVELG1CQUFtQixDQUFDLGNBQWMsQ0FBQyxNQUFNLEVBQUUsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ3JFLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVELE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQztBQUVELFNBQVMsbUNBQW1DLENBQzFDLEtBQWEsRUFDYixRQUFrQixFQUNsQixVQUErQixFQUMvQixZQUFtQztJQUVuQyxLQUFLLE1BQU0sT0FBTyxJQUFJLDBCQUEwQixDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7UUFDM0QsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUN0QyxJQUFJLEtBQUssSUFBSSxLQUFLLEtBQUssS0FBSyxFQUFFLENBQUM7WUFDN0IsTUFBTSxJQUFJLEtBQUssQ0FBQyx1REFBdUQsT0FBTyxTQUFTLEtBQUssUUFBUSxLQUFLLEVBQUUsQ0FBQyxDQUFDO1FBQy9HLENBQUM7UUFFRCxLQUFLLE1BQU0sV0FBVyxJQUFJLFlBQVksRUFBRSxDQUFDO1lBQ3ZDLElBQUksV0FBVyxDQUFDLEtBQUssS0FBSyxLQUFLLElBQUksc0JBQXNCLENBQUMsV0FBVyxDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUMsRUFBRSxDQUFDO2dCQUN4RixNQUFNLElBQUksS0FBSyxDQUNiLHdEQUF3RCxXQUFXLENBQUMsT0FBTyxVQUFVLE9BQU8sU0FBUyxXQUFXLENBQUMsS0FBSyxRQUFRLEtBQUssRUFBRSxDQUN0SSxDQUFDO1lBQ0osQ0FBQztRQUNILENBQUM7UUFFRCxVQUFVLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsQ0FBQztRQUMvQixZQUFZLENBQUMsSUFBSSxDQUFDLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDeEMsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLHNCQUFzQixDQUFDLE1BQWM7SUFDNUMsT0FBTyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7QUFDN0MsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsTUFBYztJQUN4QyxNQUFNLFVBQVUsR0FBRyxzQkFBc0IsQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsYUFBYSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQzlFLE9BQU8sVUFBVSxLQUFLLHlCQUF5QixJQUFJLGtCQUFrQixDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUN6RixDQUFDO0FBRUQsU0FBUywyQ0FBMkMsQ0FBQyxLQUFnQjtJQUNuRSxNQUFNLE1BQU0sR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDdEMsSUFBSSxDQUFDLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUMxRCxPQUFPO0lBQ1QsQ0FBQztJQUVELE1BQU0saUJBQWlCLEdBQUcsbUJBQUssQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQzdFLE1BQU0sSUFBSSxLQUFLLENBQ2Isd0lBQXdJLGlCQUFpQixxRkFBcUYsQ0FDL08sQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLG9DQUFvQyxDQUMzQyxJQUEwQixFQUMxQixpQkFBMkIsRUFDM0IsNkJBQXVDLEVBQ3ZDLDBCQUFvQztJQUVwQyxNQUFNLGFBQWEsR0FBRyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsc0JBQXNCLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN4RyxNQUFNLGVBQWUsR0FBRyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxJQUFJLE1BQU0sR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ3ZGLE1BQU0seUJBQXlCLEdBQUcsNkJBQTZCO1NBQzVELEdBQUcsQ0FBQyxzQkFBc0IsQ0FBQztTQUMzQixJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN2QyxNQUFNLDJCQUEyQixHQUFHLHlCQUF5QixDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsSUFBSSxNQUFNLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUMvRyxNQUFNLDZCQUE2QixHQUFHLDBCQUEwQixDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsSUFBSSxNQUFNLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUVsSCxPQUFPOzs7Ozs7O09BT0YsNkJBQTZCOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O2NBbUJ0QiwwQkFBMEI7Y0FDMUIsMkJBQTJCOzs7Z0JBR3pCLDJCQUEyQjtnQkFDM0IsNEJBQTRCOzs7VUFHbEMsSUFBSSxVQUFVLG9CQUFvQixDQUFDLE9BQU87O1NBRTNDLGVBQWU7OztTQUdmLDJCQUEyQjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztFQWtDbEMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNWLENBQUM7QUFFRCxTQUFTLHFDQUFxQztJQUM1QyxPQUFPOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztFQW9CUCxDQUFDLElBQUksRUFBRSxDQUFDO0FBQ1YsQ0FBQztBQTBURCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixZQUFZLENBQWE7SUFDekIsZUFBZSxDQUFTO0lBQ3hCLGlCQUFpQixDQUFTO0lBQzFCLGVBQWUsQ0FBYztJQUM3QixrQkFBa0IsQ0FBVTtJQUM1QixnQkFBZ0IsQ0FBbUI7SUFDbkMsVUFBVSxDQUFjO0lBQ3hCLE1BQU0sQ0FBcUI7SUFDM0Isa0JBQWtCLENBQXVCO0lBQ3pDLFlBQVksQ0FBMEI7SUFDdEMsV0FBVyxDQUFvQjtJQUMvQixxQkFBcUIsQ0FBb0M7SUFFekUsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE0QjtRQUNwRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxLQUFLLEVBQUUsV0FBVyxFQUFFLENBQUM7WUFDeEIsTUFBTSxJQUFJLEtBQUssQ0FBQyw2Q0FBNkMsQ0FBQyxDQUFDO1FBQ2pFLENBQUM7UUFFRCxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsSUFBSSxJQUFJLG9CQUFvQixDQUFDLFFBQVEsQ0FBQztRQUM3RCxNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxJQUFJLDJCQUFhLENBQUMsTUFBTSxDQUFDO1FBQ2xFLE1BQU0saUJBQWlCLEdBQUcsS0FBSyxDQUFDLGlCQUFpQixJQUFJLEtBQUssQ0FBQztRQUMzRCxNQUFNLGNBQWMsR0FBRyxLQUFLLENBQUMsY0FBYyxJQUFJLElBQUksQ0FBQztRQUNwRCxNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxDQUFDO1FBQzFDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxXQUFXLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLElBQUEsaUNBQWtCLEVBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQzVGLE1BQU0sYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLElBQUksSUFBSSxDQUFDO1FBQ2xELE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLE9BQU8sZUFBZSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDM0UsSUFBQSx5Q0FBa0IsRUFDaEIsYUFBYSxFQUNiLGtCQUFrQixFQUNsQixzQkFBc0IsRUFDdEIsZ0JBQWdCLEVBQ2hCLGtCQUFrQixFQUNsQixLQUFLLENBQUMsb0JBQW9CLEtBQUssU0FBUyxDQUN6QyxDQUFDO1FBQ0YsSUFBQSx5Q0FBa0IsRUFDaEIsYUFBYSxFQUNiLGtCQUFrQixFQUNsQixnQkFBZ0IsRUFDaEIsZ0JBQWdCLEVBQ2hCLGtCQUFrQixFQUNsQixLQUFLLENBQUMsY0FBYyxLQUFLLFNBQVMsQ0FDbkMsQ0FBQztRQUNGLElBQUksYUFBYSxFQUFFLGVBQWUsS0FBSyxJQUFJLElBQUksS0FBSyxDQUFDLFVBQVUsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUM5RSxNQUFNLElBQUksS0FBSyxDQUNiLHNNQUFzTSxDQUN2TSxDQUFDO1FBQ0osQ0FBQztRQUNELE1BQU0sZUFBZSxHQUFHLGFBQWEsRUFBRSxlQUFlLEtBQUssSUFBSSxJQUFJLGFBQWEsQ0FBQztRQUVqRiw2RUFBNkU7UUFDN0UsOERBQThEO1FBQzlELE1BQU0sZ0JBQWdCLEdBQUcsS0FBSyxDQUFDLHNCQUFzQixLQUFLLFNBQVM7WUFDakUsQ0FBQyxDQUFDO2dCQUNBLHNCQUFzQixFQUFFLEtBQUssQ0FBQyxzQkFBc0I7Z0JBQ3BELEdBQUcsQ0FBQyxLQUFLLENBQUMsc0JBQXNCLEtBQUssU0FBUztvQkFDNUMsQ0FBQyxDQUFDLEVBQUUsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLHNCQUFzQixFQUFFO29CQUMxRCxDQUFDLENBQUMsRUFBRSxDQUFDO2FBQ1I7WUFDRCxDQUFDLENBQUMsRUFBRSxDQUFDO1FBRVAsSUFBSSxDQUFDLFlBQVk7WUFDZixLQUFLLENBQUMsWUFBWTtnQkFDbEIsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7b0JBQ2xDLEdBQUcsQ0FBQyxhQUFhLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFBLG9DQUFpQixFQUFDLGFBQWEsRUFBRSxHQUFHLE9BQU8sU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztvQkFDMUYsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixDQUFDLFNBQVM7b0JBQ2pELFVBQVUsRUFBRSxFQUFFLENBQUMsZ0JBQWdCLENBQUMsVUFBVTtvQkFDMUMsVUFBVSxFQUFFLElBQUk7b0JBQ2hCLEdBQUcsZ0JBQWdCO29CQUNuQixhQUFhO29CQUNiLGlCQUFpQjtpQkFDbEIsQ0FBQyxDQUFDO1FBRUwsSUFBSSxhQUFhLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztZQUN0QyxJQUFJLENBQUMsVUFBVTtnQkFDYixLQUFLLENBQUMsVUFBVTtvQkFDaEIsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTt3QkFDMUMsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixDQUFDLFNBQVM7d0JBQ2pELFVBQVUsRUFBRSxFQUFFLENBQUMsZ0JBQWdCLENBQUMsVUFBVTt3QkFDMUMsVUFBVSxFQUFFLElBQUk7d0JBQ2hCLGFBQWE7d0JBQ2IsaUJBQWlCO3dCQUNqQixlQUFlLEVBQUUsRUFBRSxDQUFDLGVBQWUsQ0FBQyxhQUFhO3FCQUNsRCxDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsTUFBTSxlQUFlLEdBQUcsSUFBQSwrQkFBZ0IsRUFBQyxNQUFNLENBQUMsS0FBSyxDQUFDLGVBQWUsSUFBSSxRQUFRLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxHQUFHLENBQUMsQ0FBQztRQUNoRyxNQUFNLGVBQWUsR0FBRyxlQUFlLElBQUksUUFBUSxDQUFDO1FBRXBELE1BQU0sV0FBVyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsaUJBQWlCLElBQUksR0FBRyxlQUFlLGdCQUFnQixDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDakcsTUFBTSxXQUFXLEdBQUcsSUFBQSwrQkFBZ0IsRUFBQyxXQUFXLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDdkQsTUFBTSxpQkFBaUIsR0FBRyxXQUFXLElBQUksR0FBRyxlQUFlLGdCQUFnQixDQUFDO1FBRTVFLElBQUksQ0FBQyxlQUFlLEdBQUcsZUFBZSxDQUFDO1FBQ3ZDLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxpQkFBaUIsQ0FBQztRQUUzQyxNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsa0JBQWtCLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDOUUsTUFBTSx3QkFBd0IsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLGVBQWUsQ0FBQyxJQUFJLHVCQUF1QixDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7UUFDdEcsSUFBSSx3QkFBd0IsRUFBRSxDQUFDO1lBQzdCLE1BQU0sa0JBQWtCLEdBQUcsSUFBQSwrQkFBZ0IsRUFDekMsTUFBTSxDQUFDLEtBQUssQ0FBQyxrQkFBa0IsSUFBSSw0QkFBNEIsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUN2RSxHQUFHLENBQ0osQ0FBQztZQUNGLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxrQkFBa0IsSUFBSSw0QkFBNEIsQ0FBQztZQUM3RSxJQUFJLENBQUMsZUFBZTtnQkFDbEIsS0FBSyxDQUFDLGVBQWU7b0JBQ3JCLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7d0JBQ3JDLEdBQUcsQ0FBQyxhQUFhLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFBLG9DQUFpQixFQUFDLGFBQWEsRUFBRSxHQUFHLE9BQU8sYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQzt3QkFDOUYsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixDQUFDLFNBQVM7d0JBQ2pELFVBQVUsRUFBRSxFQUFFLENBQUMsZ0JBQWdCLENBQUMsVUFBVTt3QkFDMUMsVUFBVSxFQUFFLElBQUk7d0JBQ2hCLEdBQUcsZ0JBQWdCO3dCQUNuQixhQUFhO3dCQUNiLGlCQUFpQjtxQkFDbEIsQ0FBQyxDQUFDO1FBQ1AsQ0FBQztRQUVELElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxLQUFLLENBQUMsZ0JBQWdCLENBQUM7UUFFL0MsTUFBTSw0QkFBNEIsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLG9CQUFvQixJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3JGLE1BQU0sb0JBQW9CLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxjQUFjLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDdkUsTUFBTSw0QkFBNEIsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLGdCQUFnQixFQUFFLFNBQVMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUUzRixNQUFNLCtCQUErQixHQUFHLEtBQUssQ0FBQyxJQUFJLENBQ2hELElBQUksR0FBRyxDQUNMLENBQUMsNEJBQTRCLEVBQUUsNEJBQTRCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQyxNQUFNLENBQ3ZGLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FDekMsQ0FDRixDQUNGLENBQUM7UUFFRixJQUFJLCtCQUErQixDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUMvQyxNQUFNLElBQUksS0FBSyxDQUNiLG1FQUFtRSwrQkFBK0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FDaEgsQ0FBQztRQUNKLENBQUM7UUFFRCxJQUFJLG9CQUFvQixHQUFHLCtCQUErQixDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUVwRSwyRUFBMkU7UUFDM0UsMkVBQTJFO1FBQzNFLHVFQUF1RTtRQUN2RSxvRUFBb0U7UUFDcEUsdUVBQXVFO1FBQ3ZFLHdDQUF3QztRQUN4QyxJQUNFLGFBQWE7WUFDYixPQUFPO1lBQ1AsS0FBSyxDQUFDLGdCQUFnQixLQUFLLFNBQVM7WUFDcEMsUUFBUSxLQUFLLG9CQUFvQixDQUFDLE9BQU8sRUFDekMsQ0FBQztZQUNELE1BQU0sUUFBUSxHQUFHLGFBQWEsQ0FBQyxZQUFZLENBQUMsZ0JBQWdCLEVBQUUsR0FBRyxPQUFPLGVBQWUsQ0FBQyxDQUFDO1lBQ3pGLElBQUksb0JBQW9CLEtBQUssRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLFNBQVMsSUFBSSxRQUFRLENBQUMsSUFBSSxLQUFLLFNBQVMsRUFBRSxDQUFDO2dCQUN0RixvQkFBb0IsR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDO1lBQ3ZDLENBQUM7UUFDSCxDQUFDO1FBRUQsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDckIsSUFBSSxRQUFRLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO2dCQUN0RCxPQUFPLEVBQUUsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUM7Z0JBQ2xELGlCQUFpQixFQUFFLElBQUksQ0FBQyxZQUFZO2dCQUNwQyxvQkFBb0IsRUFBRSxlQUFlO2dCQUNyQyxLQUFLLEVBQUUsSUFBSTthQUNaLENBQUMsQ0FBQztRQUNMLENBQUM7UUFFRCxNQUFNLGtCQUFrQixHQUFHLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1FBQzNFLE1BQU0sb0JBQW9CLEdBQUcscUJBQXFCLENBQUM7WUFDakQsR0FBRyxDQUFDLFFBQVEsS0FBSyxvQkFBb0IsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsMEJBQTBCLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ2xGLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztTQUNqRixDQUFDLENBQUM7UUFDSCxNQUFNLGVBQWUsR0FBRyxxQkFBcUIsQ0FBQztZQUM1QyxHQUFHLENBQUMsUUFBUSxLQUFLLG9CQUFvQixDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDaEYsR0FBRyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7U0FDdkUsQ0FBQyxDQUFDO1FBQ0gsTUFBTSx3QkFBd0IsR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQztZQUM1RSxDQUFDLENBQUMsS0FBSyxDQUFDLHdCQUF3QjtZQUNoQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ1AsTUFBTSw4QkFBOEIsR0FBRyx3QkFBd0IsQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEVBQUU7WUFDcEYsSUFBSSxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUUsQ0FBQztnQkFDdEIsTUFBTSxJQUFJLEtBQUssQ0FBQyw2Q0FBNkMsS0FBSyxxQkFBcUIsQ0FBQyxDQUFDO1lBQzNGLENBQUM7WUFDRCxNQUFNLFlBQVksR0FBRyxxQkFBcUIsQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDaEUsSUFBSSxZQUFZLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO2dCQUM5QixNQUFNLElBQUksS0FBSyxDQUFDLDZDQUE2QyxLQUFLLHNDQUFzQyxDQUFDLENBQUM7WUFDNUcsQ0FBQztZQUNELE9BQU8sRUFBRSxNQUFNLEVBQUUsWUFBWSxFQUFFLENBQUM7UUFDbEMsQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLDZCQUE2QixHQUFHLDhCQUE4QixDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBQzlHLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7UUFDeEQsTUFBTSxnQkFBZ0IsR0FBMEIsRUFBRSxDQUFDO1FBQ25ELE1BQU0sY0FBYyxHQUFHLEtBQUssQ0FBQyxjQUFjLElBQUksTUFBTSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sQ0FBQztRQUNsRixNQUFNLHdCQUF3QixHQUFHLEtBQUssQ0FBQyx3QkFBd0IsSUFBSSxLQUFLLENBQUM7UUFFekUsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRTtZQUNuRCxRQUFRLEVBQUUsS0FBSyxDQUFDLFdBQVc7WUFDM0IsUUFBUSxFQUFFLGNBQWM7WUFDeEIsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVLElBQUksTUFBTSxDQUFDLFVBQVUsQ0FBQyxlQUFlO1NBQ2xFLENBQUMsQ0FBQztRQUVILE1BQU0sU0FBUyxHQUNiLGNBQWMsS0FBSyxNQUFNLENBQUMsbUJBQW1CLENBQUMsT0FBTztZQUNuRCxDQUFDLENBQUMsT0FBTyxDQUFDLGlCQUFpQixDQUFDLHVCQUF1QixDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7WUFDaEUsQ0FBQyxDQUFDLElBQUksT0FBTyxDQUFDLGlCQUFpQixDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUVqRCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLHVCQUF1QixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUN2RixNQUFNLGdCQUFnQixHQUFHLElBQUksQ0FBQyxlQUFlLElBQUksSUFBSSxDQUFDLFlBQVksQ0FBQztRQUNuRSxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLHVCQUF1QixDQUMvRCxnQkFBZ0IsRUFDaEIsSUFBSSxDQUFDLGVBQWUsSUFBSSxJQUFJLENBQUMsa0JBQWtCO1lBQzdDLENBQUMsQ0FBQztnQkFDRSxVQUFVLEVBQUUsSUFBSSxJQUFJLENBQUMsa0JBQWtCLEVBQUU7YUFDMUM7WUFDSCxDQUFDLENBQUMsU0FBUyxDQUNkLENBQUM7UUFFRixNQUFNLHFCQUFxQixHQUFHO1lBQzVCLDRCQUE0QjtZQUM1QiwyQkFBMkI7WUFDM0IsR0FBRyxzQkFBc0I7WUFDekIsR0FBRyxxQkFBcUI7WUFDeEIsY0FBYztTQUNmLENBQUM7UUFFRixNQUFNLDJCQUEyQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLG1CQUFtQixDQUFDLENBQUMsQ0FBQztRQUUzRSxNQUFNLHNCQUFzQixHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLGlCQUFpQixDQUFDO1lBQ25FLENBQUMsQ0FBQyxLQUFLLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLHNCQUFzQixDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztZQUMzRixDQUFDLENBQUMsRUFBRSxDQUFDO1FBRVAsTUFBTSxvQ0FBb0MsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUNyRCxJQUFJLEdBQUcsQ0FBQyxzQkFBc0IsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLDJCQUEyQixDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQzVGLENBQUMsSUFBSSxFQUFFLENBQUM7UUFFVCxJQUFJLG9DQUFvQyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUNwRCxNQUFNLElBQUksS0FBSyxDQUNiLGlEQUFpRCxvQ0FBb0MsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FDbkcsQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLGdDQUFnQyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQ2pELElBQUksR0FBRyxDQUFDLHNCQUFzQixDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUMvRSxDQUFDLElBQUksRUFBRSxDQUFDO1FBRVQsSUFBSSxnQ0FBZ0MsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFJLENBQUMsd0JBQXdCLEVBQUUsQ0FBQztZQUM3RSxNQUFNLElBQUksS0FBSyxDQUNiLDhGQUE4RixnQ0FBZ0MsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FDNUksQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLHdCQUF3QixHQUFHLHdCQUF3QjtZQUN2RCxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLHlCQUF5QixFQUFFLEdBQUcsZ0NBQWdDLENBQUMsQ0FBQyxDQUFDO1lBQ3ZGLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDUCxNQUFNLDBCQUEwQixHQUFHLHdCQUF3QjtZQUN6RCxDQUFDLENBQUMsRUFBRTtZQUNKLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksR0FBRyxDQUFDLENBQUMseUJBQXlCLEVBQUUsR0FBRyxnQ0FBZ0MsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUVqRyxNQUFNLGlCQUFpQixHQUFHLEtBQUssQ0FBQyxJQUFJLENBQ2xDLElBQUksR0FBRyxDQUNMLENBQUMsR0FBRyxxQkFBcUIsRUFBRSxHQUFHLHdCQUF3QixFQUFFLEdBQUcsc0JBQXNCLENBQUMsQ0FBQyxNQUFNLENBQ3ZGLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLDJCQUEyQixDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FDckQsQ0FDRixDQUNGLENBQUM7UUFDRixNQUFNLDJCQUEyQixHQUFHLElBQUksR0FBRyxDQUFDO1lBQzFDLDRCQUE0QjtZQUM1QiwyQkFBMkI7WUFDM0IsR0FBRyxxQkFBcUI7WUFDeEIsY0FBYztTQUNmLENBQUMsQ0FBQztRQUNILE1BQU0sbUJBQW1CLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FDcEMsSUFBSSxHQUFHLENBQUMsaUJBQWlCLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLDJCQUEyQixDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQ3hGLENBQUM7UUFDRixNQUFNLG1DQUFtQyxHQUFHLEVBQUUsQ0FBQztRQUMvQyxNQUFNLHFDQUFxQyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLHFCQUFxQixFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM5RyxNQUFNLHdDQUF3QyxHQUFHLENBQUMsTUFBYyxFQUFXLEVBQUUsQ0FDM0UsTUFBTSxLQUFLLE1BQU07WUFDakIsTUFBTSxLQUFLLFdBQVc7WUFDdEIsTUFBTSxLQUFLLFdBQVc7WUFDdEIsTUFBTSxDQUFDLFVBQVUsQ0FBQyxjQUFjLENBQUM7WUFDakMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDN0IsTUFBTSxnQ0FBZ0MsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUNqRCxJQUFJLEdBQUcsQ0FDTDtZQUNFLGVBQWU7WUFDZixRQUFRO1lBQ1IsUUFBUTtZQUNSLCtCQUErQjtZQUMvQixnQ0FBZ0M7WUFDaEMsR0FBRyxzQkFBc0IsQ0FBQyxNQUFNLENBQzlCLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FDVCxDQUFDLHdDQUF3QyxDQUFDLE1BQU0sQ0FBQztnQkFDakQsQ0FBQyxxQ0FBcUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQzFEO1NBQ0YsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQ3hDLENBQ0YsQ0FBQztRQUVGLElBQUksQ0FBQyxLQUFLLENBQUMsZUFBZSxJQUFJLG1CQUFtQixDQUFDLE1BQU0sR0FBRyx5QkFBeUIsRUFBRSxDQUFDO1lBQ3JGLE1BQU0sSUFBSSxLQUFLLENBQ2IsNkRBQTZELHlCQUF5QixnQ0FBZ0MsbUJBQW1CLENBQUMsTUFBTSxFQUFFLENBQ25KLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFDRSw4QkFBOEIsQ0FBQyxNQUFNLEdBQUcsQ0FBQztZQUN6QyxnQ0FBZ0MsQ0FBQyxNQUFNLEdBQUcsbUNBQW1DLEVBQzdFLENBQUM7WUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLDZEQUE2RCxtQ0FBbUMsMENBQTBDLGdDQUFnQyxDQUFDLE1BQU0sRUFBRSxDQUNwTCxDQUFDO1FBQ0osQ0FBQztRQUVELE1BQU0sc0JBQXNCLEdBQUcsSUFBSSxVQUFVLENBQUMsbUJBQW1CLENBQUMsSUFBSSxFQUFFLHdCQUF3QixFQUFFO1lBQ2hHLG1CQUFtQixFQUFFLFVBQVUsQ0FBQyxnQ0FBZ0MsQ0FBQyxHQUFHLEVBQUU7WUFDdEUsY0FBYyxFQUFFLFVBQVUsQ0FBQywyQkFBMkIsQ0FBQyxHQUFHLEVBQUU7WUFDNUQsY0FBYyxFQUFFLFVBQVUsQ0FBQywyQkFBMkIsQ0FBQyxTQUFTLENBQUMsR0FBRyxpQkFBaUIsQ0FBQztTQUN2RixDQUFDLENBQUM7UUFDSCxNQUFNLHVCQUF1QixHQUFHLElBQUksVUFBVSxDQUFDLG1CQUFtQixDQUFDLElBQUksRUFBRSx5QkFBeUIsRUFBRTtZQUNsRyxtQkFBbUIsRUFBRSxVQUFVLENBQUMsZ0NBQWdDLENBQUMsR0FBRyxFQUFFO1lBQ3RFLGNBQWMsRUFBRSxVQUFVLENBQUMsMkJBQTJCLENBQUMsSUFBSSxFQUFFO1lBQzdELGNBQWMsRUFBRSxVQUFVLENBQUMsMkJBQTJCLENBQUMsU0FBUyxDQUFDLEdBQUcsaUJBQWlCLENBQUM7U0FDdkYsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxVQUFVLENBQUMsV0FBVyxDQUFDLGdCQUFnQixDQUFDO1FBQ3ZGLE1BQU0sdUJBQXVCLEdBQUcsSUFBSSxVQUFVLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSx5QkFBeUIsRUFBRTtZQUMxRixPQUFPLEVBQ0wsMEdBQTBHO1lBQzVHLE1BQU0sRUFBRSxzQkFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7WUFDM0IsVUFBVSxFQUFFLHNCQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztZQUM1QixNQUFNLEVBQUUsc0JBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDO1lBQzFCLGNBQWMsRUFBRSxVQUFVLENBQUMsbUJBQW1CLENBQUMsSUFBSSxFQUFFO1lBQ3JELGNBQWMsRUFBRSxVQUFVLENBQUMsbUJBQW1CLENBQUMsSUFBSSxFQUFFO1lBQ3JELG1CQUFtQixFQUFFLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxJQUFJLEVBQUU7WUFDL0QsMEJBQTBCLEVBQUUsSUFBSTtZQUNoQyx3QkFBd0IsRUFBRSxJQUFJO1NBQy9CLENBQUMsQ0FBQztRQUNILE1BQU0sZUFBZSxHQUNuQixLQUFLLENBQUMsZUFBZTtZQUNyQixJQUFJLFVBQVUsQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO2dCQUNsRCxPQUFPLEVBQUUsdUZBQXVGO2dCQUNoRyxNQUFNLEVBQUUsc0JBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO2dCQUMzQixVQUFVLEVBQUUsc0JBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO2dCQUMvQixNQUFNLEVBQUUsc0JBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDO2dCQUMxQixjQUFjLEVBQUUsVUFBVSxDQUFDLG1CQUFtQixDQUFDLElBQUksRUFBRTtnQkFDckQsY0FBYyxFQUFFLFVBQVUsQ0FBQyxtQkFBbUIsQ0FBQyxTQUFTLENBQUMsR0FBRyxtQkFBbUIsQ0FBQztnQkFDaEYsbUJBQW1CLEVBQUUsVUFBVSxDQUFDLHdCQUF3QixDQUFDLEdBQUcsRUFBRTtnQkFDOUQsMEJBQTBCLEVBQUUsSUFBSTtnQkFDaEMsd0JBQXdCLEVBQUUsSUFBSTthQUMvQixDQUFDLENBQUM7UUFDTCxNQUFNLG9DQUFvQyxHQUN4Qyw4QkFBOEIsQ0FBQyxNQUFNLEdBQUcsQ0FBQztZQUN2QyxDQUFDLENBQUMsSUFBSSxVQUFVLENBQUMsbUJBQW1CLENBQUMsSUFBSSxFQUFFLHNDQUFzQyxFQUFFO2dCQUMvRSxtQkFBbUIsRUFBRSxVQUFVLENBQUMsZ0NBQWdDLENBQUMsR0FBRyxFQUFFO2dCQUN0RSxjQUFjLEVBQUUsVUFBVSxDQUFDLDJCQUEyQixDQUFDLEdBQUcsRUFBRTtnQkFDNUQsY0FBYyxFQUFFLFVBQVUsQ0FBQywyQkFBMkIsQ0FBQyxTQUFTLENBQzlELEdBQUcscUNBQXFDLENBQ3pDO2FBQ0YsQ0FBQztZQUNKLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDaEIsTUFBTSw0QkFBNEIsR0FDaEMsOEJBQThCLENBQUMsTUFBTSxHQUFHLENBQUM7WUFDdkMsQ0FBQyxDQUFDLElBQUksVUFBVSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsOEJBQThCLEVBQUU7Z0JBQy9ELE9BQU8sRUFDTCwyR0FBMkc7Z0JBQzdHLE1BQU0sRUFBRSxzQkFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7Z0JBQzNCLFVBQVUsRUFBRSxzQkFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7Z0JBQy9CLE1BQU0sRUFBRSxzQkFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7Z0JBQzNCLGNBQWMsRUFBRSxVQUFVLENBQUMsbUJBQW1CLENBQUMsSUFBSSxFQUFFO2dCQUNyRCxjQUFjLEVBQUUsVUFBVSxDQUFDLG1CQUFtQixDQUFDLFNBQVMsQ0FBQyxHQUFHLGdDQUFnQyxDQUFDO2dCQUM3RixtQkFBbUIsRUFBRSxVQUFVLENBQUMsd0JBQXdCLENBQUMsSUFBSSxFQUFFO2FBQ2hFLENBQUM7WUFDSixDQUFDLENBQUMsU0FBUyxDQUFDO1FBRWhCLG1DQUFtQyxDQUNqQyxpQkFBaUIsRUFDakIsQ0FBQyxHQUFHLGVBQWUsSUFBSSxFQUFFLEdBQUcsb0JBQW9CLENBQUMsRUFDakQscUJBQXFCLEVBQ3JCLGdCQUFnQixDQUNqQixDQUFDO1FBQ0YsbUNBQW1DLENBQUMsbUJBQW1CLEVBQUUsa0JBQWtCLEVBQUUscUJBQXFCLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztRQUN0SCxtQ0FBbUMsQ0FBQyxrQkFBa0IsRUFBRSxlQUFlLEVBQUUscUJBQXFCLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztRQUNsSCw4QkFBOEIsQ0FBQyxPQUFPLENBQUMsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEVBQUU7WUFDdkQsbUNBQW1DLENBQ2pDLGlDQUFpQyxLQUFLLEdBQUcsQ0FBQyxFQUFFLEVBQzVDLE1BQU0sQ0FBQyxZQUFZLEVBQ25CLHFCQUFxQixFQUNyQixnQkFBZ0IsQ0FDakIsQ0FBQztRQUNKLENBQUMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLFVBQVUsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLDBCQUEwQixFQUFFO1lBQ3RGLElBQUksRUFBRSxVQUFVLENBQUMsWUFBWSxDQUFDLFVBQVUsQ0FDdEMsb0NBQW9DLENBQ2xDLFFBQVEsRUFDUixDQUFDLEdBQUcsZUFBZSxJQUFJLEVBQUUsR0FBRyxvQkFBb0IsQ0FBQyxFQUNqRCxDQUFDLEdBQUcsZUFBZSxFQUFFLEdBQUcsNkJBQTZCLENBQUMsRUFDdEQsMEJBQTBCLENBQzNCLENBQ0Y7WUFDRCxPQUFPLEVBQUUsVUFBVSxDQUFDLGVBQWUsQ0FBQyxNQUFNO1lBQzFDLE9BQU8sRUFDTCxRQUFRLEtBQUssb0JBQW9CLENBQUMsT0FBTztnQkFDdkMsQ0FBQyxDQUFDLHNFQUFzRTtnQkFDeEUsQ0FBQyxDQUFDLHFEQUFxRDtTQUM1RCxDQUFDLENBQUM7UUFFSCxNQUFNLHNCQUFzQixHQUFHLElBQUksVUFBVSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsMkJBQTJCLEVBQUU7WUFDeEYsSUFBSSxFQUFFLFVBQVUsQ0FBQyxZQUFZLENBQUMsVUFBVSxDQUFDLHFDQUFxQyxFQUFFLENBQUM7WUFDakYsT0FBTyxFQUFFLFVBQVUsQ0FBQyxlQUFlLENBQUMsTUFBTTtZQUMxQyxPQUFPLEVBQUUseURBQXlEO1NBQ25FLENBQUMsQ0FBQztRQUVILE1BQU0sOEJBQThCLEdBQUcsR0FBcUMsRUFBRSxDQUFDO1lBQzdFO2dCQUNFLFFBQVEsRUFBRSxxQkFBcUI7Z0JBQy9CLFNBQVMsRUFBRSxVQUFVLENBQUMsaUJBQWlCLENBQUMsY0FBYzthQUN2RDtZQUNEO2dCQUNFLFFBQVEsRUFBRSxzQkFBc0I7Z0JBQ2hDLFNBQVMsRUFBRSxVQUFVLENBQUMsaUJBQWlCLENBQUMsZUFBZTthQUN4RDtTQUNGLENBQUM7UUFFRixNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUV6RCxJQUFJLHVCQUFxRCxDQUFDO1FBQzFELElBQUksdUJBQTZDLENBQUM7UUFFbEQsSUFBSSxVQUFVLEVBQUUsQ0FBQztZQUNmLHVCQUF1QixHQUFHLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDdkMsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxjQUFjLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDMUQsSUFBSSxPQUFPLEVBQUUsQ0FBQztnQkFDWix1QkFBdUIsR0FBRyxHQUFHLENBQUMsV0FBVyxDQUFDLGtCQUFrQixDQUFDLElBQUksRUFBRSxhQUFhLEVBQUUsT0FBTyxDQUFDLENBQUM7WUFDN0YsQ0FBQztpQkFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztnQkFDNUIsMkNBQTJDLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ2xELHVCQUF1QixHQUFHLElBQUksR0FBRyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO29CQUNqRSxVQUFVO29CQUNWLFVBQVUsRUFBRSxHQUFHLENBQUMscUJBQXFCLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUM7aUJBQ2hFLENBQUMsQ0FBQztZQUNMLENBQUM7aUJBQU0sQ0FBQztnQkFDTixNQUFNLElBQUksS0FBSyxDQUFDLGlHQUFpRyxDQUFDLENBQUM7WUFDckgsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLENBQUMsV0FBVyxHQUFHLHVCQUF1QixDQUFDO1FBRTNDLElBQUksQ0FBQyxxQkFBcUI7WUFDeEIsS0FBSyxDQUFDLHFCQUFxQjtnQkFDM0IsSUFBSSxVQUFVLENBQUMscUJBQXFCLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO29CQUNsRSxPQUFPLEVBQUUsaUVBQWlFO29CQUMxRSx1QkFBdUIsRUFBRTt3QkFDdkIsdUJBQXVCLEVBQUU7NEJBQ3ZCLG1CQUFtQixFQUFFLHNCQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUM7NEJBQzNDLGlCQUFpQixFQUFFLElBQUk7NEJBQ3ZCLE9BQU8sRUFBRSxJQUFJOzRCQUNiLFFBQVEsRUFBRSxJQUFJO3lCQUNmO3dCQUNELGtCQUFrQixFQUFFLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTt3QkFDdEMsWUFBWSxFQUFFOzRCQUNaLFdBQVcsRUFBRSxVQUFVLENBQUMsa0JBQWtCLENBQUMsSUFBSTs0QkFDL0MsUUFBUSxFQUFFLElBQUk7eUJBQ2Y7d0JBQ0QsY0FBYyxFQUFFOzRCQUNkLGNBQWMsRUFBRSxVQUFVLENBQUMscUJBQXFCLENBQUMsK0JBQStCOzRCQUNoRixRQUFRLEVBQUUsSUFBSTt5QkFDZjt3QkFDRCxhQUFhLEVBQUU7NEJBQ2IsVUFBVSxFQUFFLElBQUk7NEJBQ2hCLFNBQVMsRUFBRSxJQUFJOzRCQUNmLFFBQVEsRUFBRSxJQUFJO3lCQUNmO3FCQUNGO29CQUNELHFCQUFxQixFQUFFO3dCQUNyQixhQUFhLEVBQUU7NEJBQ2I7Z0NBQ0UsTUFBTSxFQUFFLG9CQUFvQjtnQ0FDNUIsS0FBSyxFQUFFLDBDQUEwQztnQ0FDakQsUUFBUSxFQUFFLElBQUk7NkJBQ2Y7eUJBQ0Y7cUJBQ0Y7aUJBQ0YsQ0FBQyxDQUFDO1FBRUwsTUFBTSxvQkFBb0IsR0FBRyxHQUErQixFQUFFLENBQUMsQ0FBQztZQUM5RCxNQUFNLEVBQUUsWUFBWTtZQUNwQixvQkFBb0IsRUFBRSxVQUFVLENBQUMsb0JBQW9CLENBQUMsaUJBQWlCO1lBQ3ZFLGNBQWMsRUFBRSxVQUFVLENBQUMsY0FBYyxDQUFDLHNCQUFzQjtZQUNoRSxXQUFXLEVBQUUsdUJBQXVCO1lBQ3BDLFFBQVEsRUFBRSxJQUFJO1lBQ2QscUJBQXFCLEVBQUUsSUFBSSxDQUFDLHFCQUFxQjtZQUNqRCxvQkFBb0IsRUFBRSw4QkFBOEIsRUFBRTtTQUN2RCxDQUFDLENBQUM7UUFDSCxNQUFNLHdCQUF3QixHQUFHLEdBQStCLEVBQUUsQ0FBQyxDQUFDO1lBQ2xFLE1BQU0sRUFBRSxVQUFVO1lBQ2xCLG9CQUFvQixFQUFFLFVBQVUsQ0FBQyxvQkFBb0IsQ0FBQyxpQkFBaUI7WUFDdkUsY0FBYyxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsc0JBQXNCO1lBQ2hFLFdBQVcsRUFBRSxlQUFlO1lBQzVCLG1CQUFtQixFQUFFLHVCQUF1QjtZQUM1QyxRQUFRLEVBQUUsSUFBSTtZQUNkLHFCQUFxQixFQUFFLElBQUksQ0FBQyxxQkFBcUI7WUFDakQsb0JBQW9CLEVBQUUsOEJBQThCLEVBQUU7U0FDdkQsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxpQkFBaUIsR0FBRyxHQUErQixFQUFFLENBQUMsQ0FBQztZQUMzRCxNQUFNLEVBQUUsU0FBUztZQUNqQixvQkFBb0IsRUFBRSxVQUFVLENBQUMsb0JBQW9CLENBQUMsaUJBQWlCO1lBQ3ZFLGNBQWMsRUFBRSxVQUFVLENBQUMsY0FBYyxDQUFDLFNBQVM7WUFDbkQsV0FBVyxFQUFFLGNBQWM7WUFDM0IsbUJBQW1CLEVBQUUsc0JBQXNCO1lBQzNDLHFCQUFxQixFQUFFLElBQUksQ0FBQyxxQkFBcUI7WUFDakQsb0JBQW9CLEVBQUUsOEJBQThCLEVBQUU7U0FDdkQsQ0FBQyxDQUFDO1FBRUgsTUFBTSxtQkFBbUIsR0FBK0MsRUFBRSxDQUFDO1FBQzNFLE1BQU0sbUJBQW1CLEdBQUcsQ0FBQyxRQUFrQixFQUFFLE9BQXlDLEVBQVEsRUFBRTtZQUNsRyxLQUFLLE1BQU0sT0FBTyxJQUFJLDBCQUEwQixDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7Z0JBQzNELG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxHQUFHLE9BQU8sRUFBRSxDQUFDO1lBQzNDLENBQUM7UUFDSCxDQUFDLENBQUM7UUFFRixtQkFBbUIsQ0FBQyxDQUFDLEdBQUcsZUFBZSxJQUFJLENBQUMsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO1FBQ3BFLG1CQUFtQixDQUFDLG9CQUFvQixFQUFFLG9CQUFvQixDQUFDLENBQUM7UUFDaEUsbUJBQW1CLENBQUMsa0JBQWtCLEVBQUUsd0JBQXdCLENBQUMsQ0FBQztRQUNsRSxtQkFBbUIsQ0FBQyxlQUFlLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUN4RCxJQUFJLENBQUMsa0JBQWtCLEdBQUcsRUFBRSxDQUFDO1FBQzdCLDhCQUE4QixDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sRUFBRSxLQUFLLEVBQUUsRUFBRTtZQUN2RCxNQUFNLFdBQVcsR0FBRyxJQUFJLE1BQU0sQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLG9CQUFvQixLQUFLLEdBQUcsQ0FBQyxFQUFFLEVBQUU7Z0JBQ2hGLFFBQVEsRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDLFFBQVE7Z0JBQ2hDLFFBQVEsRUFBRSxNQUFNLENBQUMsbUJBQW1CLENBQUMsSUFBSTtnQkFDekMsVUFBVSxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsVUFBVSxJQUFJLE1BQU0sQ0FBQyxVQUFVLENBQUMsUUFBUTthQUNuRSxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDO1lBQzFDLE1BQU0saUJBQWlCLEdBQUcsSUFBSSxPQUFPLENBQUMsaUJBQWlCLENBQUMsV0FBVyxDQUFDLENBQUM7WUFDckUsTUFBTSwrQkFBK0IsR0FBRyxHQUErQixFQUFFLENBQUMsQ0FBQztnQkFDekUsTUFBTSxFQUFFLGlCQUFpQjtnQkFDekIsb0JBQW9CLEVBQUUsVUFBVSxDQUFDLG9CQUFvQixDQUFDLGlCQUFpQjtnQkFDdkUsY0FBYyxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsU0FBUztnQkFDbkQsV0FBVyxFQUFFLDRCQUE0QjtnQkFDekMsbUJBQW1CLEVBQUUsb0NBQW9DO2dCQUN6RCxxQkFBcUIsRUFBRSxJQUFJLENBQUMscUJBQXFCO2dCQUNqRCxvQkFBb0IsRUFBRSw4QkFBOEIsRUFBRTthQUN2RCxDQUFDLENBQUM7WUFDSCxtQkFBbUIsQ0FBQyxNQUFNLENBQUMsWUFBWSxFQUFFLCtCQUErQixDQUFDLENBQUM7UUFDNUUsQ0FBQyxDQUFDLENBQUM7UUFFSCxNQUFNLGFBQWEsR0FDakIsUUFBUSxLQUFLLG9CQUFvQixDQUFDLE9BQU87WUFDdkMsQ0FBQyxDQUFDLElBQUksT0FBTyxDQUFDLFdBQVcsQ0FBQztnQkFDdEIsYUFBYSxFQUFFLFVBQVU7Z0JBQ3pCLGNBQWMsRUFBRSxTQUFTO2dCQUN6QixtQkFBbUIsRUFBRSxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUM7YUFDaEMsQ0FBQztZQUNKLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDaEIsTUFBTSxxQkFBcUIsR0FDekIsUUFBUSxLQUFLLG9CQUFvQixDQUFDLE9BQU87WUFDdkMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxjQUFjLENBQUMsc0JBQXNCO1lBQ2xELENBQUMsQ0FBQyxVQUFVLENBQUMsY0FBYyxDQUFDLFNBQVMsQ0FBQztRQUUxQyw4RUFBOEU7UUFDOUUsTUFBTSxzQkFBc0IsR0FBRyxJQUFBLCtDQUE2QixFQUMxRCxhQUFhLEVBQ2IsdUJBQXVCLEtBQUssU0FBUyxFQUNyQyxLQUFLLENBQUMsc0JBQXNCLENBQzdCLENBQUM7UUFDRixNQUFNLGlCQUFpQixHQUFHLEtBQUssQ0FBQyxpQkFBaUI7ZUFDNUMsQ0FBQyxJQUFBLGdDQUFjLEVBQUMsYUFBYSxDQUFDLElBQUksUUFBUSxLQUFLLG9CQUFvQixDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUU3RyxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksVUFBVSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQ3BFLEdBQUcsQ0FBQyxhQUFhLElBQUksSUFBSSxDQUFDLFVBQVU7Z0JBQ2xDLENBQUMsQ0FBQyxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLElBQUksQ0FBQyxVQUFVLEVBQUUsYUFBYSxFQUFFLGFBQWEsRUFBRTtnQkFDbkYsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUNQLEdBQUcsQ0FBQyx1QkFBdUIsSUFBSSx1QkFBdUI7Z0JBQ3BELENBQUMsQ0FBQyxFQUFFLFdBQVcsRUFBRSx1QkFBdUIsRUFBRSxXQUFXLEVBQUUsdUJBQXVCLEVBQUU7Z0JBQ2hGLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDUCxHQUFHLENBQUMsc0JBQXNCLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLHNCQUFzQixFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUMzRSxHQUFHLENBQUMsaUJBQWlCLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLGlCQUFpQixFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUNqRSxlQUFlLEVBQUU7Z0JBQ2YsTUFBTSxFQUFFLGFBQWE7Z0JBQ3JCLG9CQUFvQixFQUFFLFVBQVUsQ0FBQyxvQkFBb0IsQ0FBQyxpQkFBaUI7Z0JBQ3ZFLGNBQWMsRUFBRSxxQkFBcUI7Z0JBQ3JDLFdBQVcsRUFBRSxRQUFRLEtBQUssb0JBQW9CLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLGNBQWM7Z0JBQ3pGLG1CQUFtQixFQUFFLFFBQVEsS0FBSyxvQkFBb0IsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLHVCQUF1QixDQUFDLENBQUMsQ0FBQyxzQkFBc0I7Z0JBQ2pILHFCQUFxQixFQUFFLElBQUksQ0FBQyxxQkFBcUI7Z0JBQ2pELG9CQUFvQixFQUFFLDhCQUE4QixFQUFFO2FBQ3ZEO1lBQ0QsbUJBQW1CO1lBQ25CLEdBQUcsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztTQUN4RCxDQUFDLENBQUM7UUFFSCxJQUFJLGVBQWUsSUFBSSxhQUFhLElBQUksT0FBTyxFQUFFLENBQUM7WUFDaEQsSUFBQSxrREFBK0IsRUFBQztnQkFDOUIsS0FBSyxFQUFFLElBQUk7Z0JBQ1gsRUFBRSxFQUFFLFlBQVk7Z0JBQ2hCLE9BQU8sRUFBRSxhQUFhO2dCQUN0QixZQUFZLEVBQUUsSUFBSSxDQUFDLFlBQVk7Z0JBQy9CLE9BQU8sRUFBRSxtQkFBbUIsT0FBTyxFQUFFO2dCQUNyQyxNQUFNLEVBQUUsS0FBSyxDQUFDLG1CQUFtQjthQUNsQyxDQUFDLENBQUM7UUFDTCxDQUFDO1FBRUQsSUFBSSxjQUFjLEtBQUssTUFBTSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQzFELEtBQUssQ0FBQyxXQUFXLENBQUMsYUFBYSxDQUFDLHFDQUFxQyxFQUFFO2dCQUNyRSxNQUFNLEVBQUUsdUJBQXVCO2dCQUMvQixTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsMEJBQTBCLENBQUM7Z0JBQy9ELFNBQVMsRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDLGVBQWU7Z0JBQzVDLHFCQUFxQixFQUFFLElBQUk7YUFDNUIsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUVELElBQUksSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQ3pCLElBQUksQ0FBQyxlQUFlLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUN6RCxDQUFDO1FBRUQsSUFBSSxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztZQUMxQixJQUFJLENBQUMsZ0JBQWdCLENBQUMsa0JBQWtCLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzlELENBQUM7UUFFRCxJQUFJLGNBQWMsRUFBRSxDQUFDO1lBQ25CLElBQUksQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUUvQyxNQUFNLGNBQWMsR0FBRyxLQUFLLENBQUMsV0FBa0IsQ0FBQztZQUNoRCxJQUFJLE9BQU8sY0FBYyxDQUFDLGNBQWMsS0FBSyxVQUFVLEVBQUUsQ0FBQztnQkFDeEQsTUFBTSxJQUFJLEtBQUssQ0FDYixvS0FBb0ssQ0FDckssQ0FBQztZQUNKLENBQUM7WUFFRCxjQUFjLENBQUMsY0FBYyxDQUFDLHlCQUF5QixFQUFFLElBQUksQ0FBQyxZQUFZLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDdkYsY0FBYyxDQUFDLGNBQWMsQ0FBQyx5QkFBeUIsRUFBRSxlQUFlLENBQUMsQ0FBQztZQUMxRSxjQUFjLENBQUMsY0FBYyxDQUFDLCtCQUErQixFQUFFLGlCQUFpQixDQUFDLENBQUM7WUFFbEYsSUFBSSxJQUFJLENBQUMsZUFBZSxJQUFJLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO2dCQUNwRCxjQUFjLENBQUMsY0FBYyxDQUFDLHVCQUF1QixFQUFFLElBQUksQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLENBQUM7Z0JBQ3hGLGNBQWMsQ0FBQyxjQUFjLENBQUMsdUJBQXVCLEVBQUUsSUFBSSxDQUFDLGtCQUFrQixDQUFDLENBQUM7WUFDbEYsQ0FBQztZQUNELElBQUksb0JBQW9CLEVBQUUsQ0FBQztnQkFDekIsY0FBYyxDQUFDLGNBQWMsQ0FBQyw0QkFBNEIsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO2dCQUNsRixjQUFjLENBQUMsY0FBYyxDQUFDLDZCQUE2QixFQUFFLG9CQUFvQixDQUFDLENBQUM7Z0JBQ25GLGNBQWMsQ0FBQyxjQUFjLENBQUMsa0JBQWtCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztnQkFDeEUsY0FBYyxDQUFDLGNBQWMsQ0FBQyxhQUFhLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztZQUNyRSxDQUFDO1FBQ0gsQ0FBQztRQUVELElBQUksVUFBVSxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUNuQyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtnQkFDdkMsSUFBSSxFQUFFLEtBQUssQ0FBQyxVQUFVO2dCQUN0QixVQUFVLEVBQUUsVUFBVTtnQkFDdEIsTUFBTSxFQUFFLE9BQU8sQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQzthQUN4RixDQUFDLENBQUM7UUFDTCxDQUFDO0lBRUgsQ0FBQzs7QUEzb0JILDRDQTRvQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudFwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdCB9IGZyb20gXCIuL2xvZ2dpbmdcIjtcbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyBidWNrZXROYW1pbmdQcm9wcywgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHsgZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24sIHNlY3VyZURlZmF1bHRzIH0gZnJvbSBcIi4vcHJpdmF0ZS9zZWN1cmUtZGVmYXVsdHNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIsIHRyaW1SZXBlYXRlZENoYXJTdGFydCB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5cbmNvbnN0IGFwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW5hbC11cmlcIjtcbmNvbnN0IGZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciA9IFwieC1mYWNldGhlb3J5LW9yaWdpbmFsLXVyaVwiO1xuY29uc3QgYXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW5hbC1ob3N0XCI7XG5jb25zdCBmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyID0gXCJ4LWZhY2V0aGVvcnktb3JpZ2luYWwtaG9zdFwiO1xuY29uc3Qgc3NyT3JpZ2luYWxVcmlIZWFkZXJzID0gW2FwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyLCBmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJdIGFzIGNvbnN0O1xuY29uc3Qgc3NyT3JpZ2luYWxIb3N0SGVhZGVycyA9IFthcHB0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIsIGZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJdIGFzIGNvbnN0O1xuY29uc3Qgc3NnSXNySHlkcmF0aW9uUGF0aFBhdHRlcm4gPSBcIi9fZmFjZXRoZW9yeS9kYXRhLypcIjtcbmNvbnN0IHNzZ0lzclNzckRhdGFQYXRoUGF0dGVybiA9IFwiL19mYWNldGhlb3J5L3Nzci1kYXRhLypcIjtcbmNvbnN0IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXggPSBcImlzclwiO1xuY29uc3QgbWF4RGVmYXVsdENhY2hlS2V5SGVhZGVycyA9IDEwO1xuY29uc3QgZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciA9IFwieC10ZW5hbnQtaWRcIjtcblxuZXhwb3J0IGVudW0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUge1xuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpcyB0aGUgZGVmYXVsdCBvcmlnaW4uIERpcmVjdCBTMyBiZWhhdmlvcnMgYXJlIHVzZWQgb25seSBmb3JcbiAgICogaW1tdXRhYmxlIGFzc2V0cyBhbmQgYW55IGV4cGxpY2l0bHkgY29uZmlndXJlZCBzdGF0aWMgcGF0aCBwYXR0ZXJucy5cbiAgICovXG4gIFNTUl9PTkxZID0gXCJzc3Itb25seVwiLFxuXG4gIC8qKlxuICAgKiBTMyBpcyB0aGUgcHJpbWFyeSBIVE1MIG9yaWdpbiBhbmQgTGFtYmRhIFNTUi9JU1IgaXMgdGhlIGZhbGxiYWNrLiBGYWNlVGhlb3J5IGh5ZHJhdGlvblxuICAgKiBkYXRhIHJvdXRlcyBhcmUga2VwdCBvbiBTMyBhbmQgdGhlIGVkZ2UgcmV3cml0ZXMgZXh0ZW5zaW9ubGVzcyBwYXRocyB0byBgL2luZGV4Lmh0bWxgLlxuICAgKi9cbiAgU1NHX0lTUiA9IFwic3NnLWlzclwiLFxufVxuXG5mdW5jdGlvbiBwYXRoUGF0dGVyblRvVXJpUHJlZml4KHBhdHRlcm46IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSB0cmltUmVwZWF0ZWRDaGFyU3RhcnQoU3RyaW5nKHBhdHRlcm4pLnRyaW0oKSwgXCIvXCIpLnJlcGxhY2UoL1xcL1xcKiQvLCBcIlwiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQgPyBgLyR7bm9ybWFsaXplZH1gIDogXCIvXCI7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBBcnJheS5mcm9tKFxuICAgIG5ldyBTZXQoXG4gICAgICAoQXJyYXkuaXNBcnJheShwYXR0ZXJucykgPyBwYXR0ZXJucyA6IFtdKVxuICAgICAgICAubWFwKChwYXR0ZXJuKSA9PiB0cmltUmVwZWF0ZWRDaGFyU3RhcnQoU3RyaW5nKHBhdHRlcm4pLnRyaW0oKSwgXCIvXCIpKVxuICAgICAgICAuZmlsdGVyKChwYXR0ZXJuKSA9PiBwYXR0ZXJuLmxlbmd0aCA+IDApLFxuICAgICksXG4gICk7XG59XG5cbmZ1bmN0aW9uIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZXhwYW5kZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgcGF0dGVybnMpIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWQpIGNvbnRpbnVlO1xuXG4gICAgZXhwYW5kZWQuYWRkKG5vcm1hbGl6ZWQpO1xuICAgIGlmIChub3JtYWxpemVkLmVuZHNXaXRoKFwiLypcIikpIHtcbiAgICAgIGNvbnN0IHJvb3RQYXR0ZXJuID0gbm9ybWFsaXplZC5zbGljZSgwLCAtMik7XG4gICAgICBpZiAocm9vdFBhdHRlcm4pIHtcbiAgICAgICAgZXhwYW5kZWQuYWRkKHJvb3RQYXR0ZXJuKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gQXJyYXkuZnJvbShleHBhbmRlZCk7XG59XG5cbmludGVyZmFjZSBTZWVuQmVoYXZpb3JQYXR0ZXJuIHtcbiAgcmVhZG9ubHkgcGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBsYWJlbDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUGF0aFBhdHRlcm5UcmFuc2l0aW9uIHtcbiAgcmVhZG9ubHkgdGFyZ2V0OiBudW1iZXI7XG4gIHJlYWRvbmx5IGFueTogYm9vbGVhbjtcbiAgcmVhZG9ubHkgbGl0ZXJhbD86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5FcHNpbG9uQ2xvc3VyZShwYXR0ZXJuOiBzdHJpbmcsIGluZGV4OiBudW1iZXIpOiBudW1iZXJbXSB7XG4gIGNvbnN0IGNsb3N1cmU6IG51bWJlcltdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgY29uc3Qgc3RhY2sgPSBbaW5kZXhdO1xuXG4gIHdoaWxlIChzdGFjay5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY3VycmVudCA9IHN0YWNrLnBvcCgpID8/IDA7XG4gICAgaWYgKHNlZW4uaGFzKGN1cnJlbnQpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgc2Vlbi5hZGQoY3VycmVudCk7XG4gICAgY2xvc3VyZS5wdXNoKGN1cnJlbnQpO1xuXG4gICAgaWYgKHBhdHRlcm5bY3VycmVudF0gPT09IFwiKlwiKSB7XG4gICAgICBzdGFjay5wdXNoKGN1cnJlbnQgKyAxKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gY2xvc3VyZTtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5UcmFuc2l0aW9ucyhwYXR0ZXJuOiBzdHJpbmcsIGluZGV4OiBudW1iZXIpOiBQYXRoUGF0dGVyblRyYW5zaXRpb25bXSB7XG4gIGNvbnN0IHRva2VuID0gcGF0dGVybltpbmRleF07XG4gIGlmICh0b2tlbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgaWYgKHRva2VuID09PSBcIipcIikge1xuICAgIHJldHVybiBbeyB0YXJnZXQ6IGluZGV4LCBhbnk6IHRydWUgfV07XG4gIH1cblxuICBpZiAodG9rZW4gPT09IFwiP1wiKSB7XG4gICAgcmV0dXJuIFt7IHRhcmdldDogaW5kZXggKyAxLCBhbnk6IHRydWUgfV07XG4gIH1cblxuICByZXR1cm4gW3sgdGFyZ2V0OiBpbmRleCArIDEsIGFueTogZmFsc2UsIGxpdGVyYWw6IHRva2VuIH1dO1xufVxuXG5mdW5jdGlvbiBwYXRoUGF0dGVyblRyYW5zaXRpb25zQ2FuU2hhcmVDaGFyYWN0ZXIobGVmdDogUGF0aFBhdHRlcm5UcmFuc2l0aW9uLCByaWdodDogUGF0aFBhdHRlcm5UcmFuc2l0aW9uKTogYm9vbGVhbiB7XG4gIHJldHVybiBsZWZ0LmFueSB8fCByaWdodC5hbnkgfHwgbGVmdC5saXRlcmFsID09PSByaWdodC5saXRlcmFsO1xufVxuXG5mdW5jdGlvbiBwYXRoUGF0dGVybnNDYW5PdmVybGFwKGxlZnQ6IHN0cmluZywgcmlnaHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBzZWVuU3RhdGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHF1ZXVlOiBBcnJheTxbbnVtYmVyLCBudW1iZXJdPiA9IFtdO1xuXG4gIGNvbnN0IGVucXVldWVDbG9zdXJlUGFpcnMgPSAobGVmdEluZGV4OiBudW1iZXIsIHJpZ2h0SW5kZXg6IG51bWJlcik6IHZvaWQgPT4ge1xuICAgIGZvciAoY29uc3QgbGVmdENsb3NlZCBvZiBwYXRoUGF0dGVybkVwc2lsb25DbG9zdXJlKGxlZnQsIGxlZnRJbmRleCkpIHtcbiAgICAgIGZvciAoY29uc3QgcmlnaHRDbG9zZWQgb2YgcGF0aFBhdHRlcm5FcHNpbG9uQ2xvc3VyZShyaWdodCwgcmlnaHRJbmRleCkpIHtcbiAgICAgICAgY29uc3Qga2V5ID0gYCR7bGVmdENsb3NlZH06JHtyaWdodENsb3NlZH1gO1xuICAgICAgICBpZiAoc2VlblN0YXRlcy5oYXMoa2V5KSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIHNlZW5TdGF0ZXMuYWRkKGtleSk7XG4gICAgICAgIHF1ZXVlLnB1c2goW2xlZnRDbG9zZWQsIHJpZ2h0Q2xvc2VkXSk7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIGVucXVldWVDbG9zdXJlUGFpcnMoMCwgMCk7XG5cbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBbbGVmdEluZGV4LCByaWdodEluZGV4XSA9IHF1ZXVlLnNoaWZ0KCkgPz8gWzAsIDBdO1xuICAgIGlmIChsZWZ0SW5kZXggPT09IGxlZnQubGVuZ3RoICYmIHJpZ2h0SW5kZXggPT09IHJpZ2h0Lmxlbmd0aCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBsZWZ0VHJhbnNpdGlvbiBvZiBwYXRoUGF0dGVyblRyYW5zaXRpb25zKGxlZnQsIGxlZnRJbmRleCkpIHtcbiAgICAgIGZvciAoY29uc3QgcmlnaHRUcmFuc2l0aW9uIG9mIHBhdGhQYXR0ZXJuVHJhbnNpdGlvbnMocmlnaHQsIHJpZ2h0SW5kZXgpKSB7XG4gICAgICAgIGlmICghcGF0aFBhdHRlcm5UcmFuc2l0aW9uc0NhblNoYXJlQ2hhcmFjdGVyKGxlZnRUcmFuc2l0aW9uLCByaWdodFRyYW5zaXRpb24pKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBlbnF1ZXVlQ2xvc3VyZVBhaXJzKGxlZnRUcmFuc2l0aW9uLnRhcmdldCwgcmlnaHRUcmFuc2l0aW9uLnRhcmdldCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgbGFiZWw6IHN0cmluZyxcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBzZWVuT3duZXJzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxuICBzZWVuUGF0dGVybnM6IFNlZW5CZWhhdmlvclBhdHRlcm5bXSxcbik6IHZvaWQge1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnMpKSB7XG4gICAgY29uc3Qgb3duZXIgPSBzZWVuT3duZXJzLmdldChwYXR0ZXJuKTtcbiAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IGxhYmVsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJuIFwiJHtwYXR0ZXJufVwiIGZvciAke293bmVyfSBhbmQgJHtsYWJlbH1gKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHNlZW5QYXR0ZXJuIG9mIHNlZW5QYXR0ZXJucykge1xuICAgICAgaWYgKHNlZW5QYXR0ZXJuLmxhYmVsICE9PSBsYWJlbCAmJiBwYXRoUGF0dGVybnNDYW5PdmVybGFwKHNlZW5QYXR0ZXJuLnBhdHRlcm4sIHBhdHRlcm4pKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBvdmVybGFwcGluZyBwYXRoIHBhdHRlcm5zIFwiJHtzZWVuUGF0dGVybi5wYXR0ZXJufVwiIGFuZCBcIiR7cGF0dGVybn1cIiBmb3IgJHtzZWVuUGF0dGVybi5sYWJlbH0gYW5kICR7bGFiZWx9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzZWVuT3duZXJzLnNldChwYXR0ZXJuLCBsYWJlbCk7XG4gICAgc2VlblBhdHRlcm5zLnB1c2goeyBwYXR0ZXJuLCBsYWJlbCB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5vbmljYWxpemVIZWFkZXJOYW1lKGhlYWRlcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyhoZWFkZXIpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5mdW5jdGlvbiBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IGNhbm9uaWNhbGl6ZUhlYWRlck5hbWUoaGVhZGVyKS5yZXBsYWNlKC9bXmEtejAtOV0rL2csIFwiLVwiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQgPT09IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgfHwgLyhefC0pdGVuYW50KC18JCkvLnRlc3Qobm9ybWFsaXplZCk7XG59XG5cbmZ1bmN0aW9uIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24oc2NvcGU6IENvbnN0cnVjdCk6IHZvaWQge1xuICBjb25zdCByZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pICYmIHJlZ2lvbiA9PT0gXCJ1cy1lYXN0LTFcIikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHJlZ2lvbkRlc2NyaXB0aW9uID0gVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgPyBcInVucmVzb2x2ZWRcIiA6IHJlZ2lvbjtcbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIGBBcHBUaGVvcnlTc3JTaXRlIGNhbm5vdCBjcmVhdGUgYSBob3N0ZWQtem9uZSBDbG91ZEZyb250IGNlcnRpZmljYXRlIHVubGVzcyB0aGUgc3RhY2sgcmVnaW9uIGlzIGV4cGxpY2l0bHkgdXMtZWFzdC0xOyBzdGFjayByZWdpb24gaXMgJHtyZWdpb25EZXNjcmlwdGlvbn0uIFByb3ZpZGUgcHJvcHMuY2VydGlmaWNhdGVBcm4gZm9yIHN0YWNrcyBpbiBvdGhlciBvciBlbnZpcm9ubWVudC1hZ25vc3RpYyByZWdpb25zLmAsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVxdWVzdEZ1bmN0aW9uQ29kZShcbiAgbW9kZTogQXBwVGhlb3J5U3NyU2l0ZU1vZGUsXG4gIHJhd1MzUGF0aFBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgbGFtYmRhUGFzc3Rocm91Z2hQYXRoUGF0dGVybnM6IHN0cmluZ1tdLFxuICBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyczogc3RyaW5nW10sXG4pOiBzdHJpbmcge1xuICBjb25zdCByYXdTM1ByZWZpeGVzID0gcmF3UzNQYXRoUGF0dGVybnMubWFwKHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgpLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpO1xuICBjb25zdCByYXdTM1ByZWZpeExpc3QgPSByYXdTM1ByZWZpeGVzLm1hcCgocHJlZml4KSA9PiBgJyR7cHJlZml4fSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zXG4gICAgLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG4gIGNvbnN0IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJMaXN0ID0gYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMubWFwKChoZWFkZXIpID0+IGAnJHtoZWFkZXJ9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuXG4gIHJldHVybiBgXG5cdGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcblx0ICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG5cdCAgcmVxdWVzdC5oZWFkZXJzID0gcmVxdWVzdC5oZWFkZXJzIHx8IHt9O1xuXHQgIHZhciBoZWFkZXJzID0gcmVxdWVzdC5oZWFkZXJzO1xuXHQgIHZhciB1cmkgPSByZXF1ZXN0LnVyaSB8fCAnLyc7XG5cdCAgdmFyIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzID0gW1xuXHQgICAgJHtibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyTGlzdH1cblx0ICBdO1xuXG5cdCAgZm9yICh2YXIgYmxvY2tlZEluZGV4ID0gMDsgYmxvY2tlZEluZGV4IDwgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMubGVuZ3RoOyBibG9ja2VkSW5kZXgrKykge1xuXHQgICAgZGVsZXRlIGhlYWRlcnNbYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnNbYmxvY2tlZEluZGV4XV07XG5cdCAgfVxuXG5cdCAgdmFyIHJlcXVlc3RJZEhlYWRlciA9IGhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddO1xuXHQgIHZhciByZXF1ZXN0SWQgPSByZXF1ZXN0SWRIZWFkZXIgJiYgcmVxdWVzdElkSGVhZGVyLnZhbHVlID8gcmVxdWVzdElkSGVhZGVyLnZhbHVlLnRyaW0oKSA6ICcnO1xuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9IGV2ZW50LmNvbnRleHQgJiYgZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQgPyBTdHJpbmcoZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQpLnRyaW0oKSA6ICcnO1xuXHQgIH1cblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSAncmVxXycgKyBEYXRlLm5vdygpLnRvU3RyaW5nKDM2KSArICdfJyArIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDEwKTtcblx0ICB9XG5cblx0ICBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSA9IHsgdmFsdWU6IHJlcXVlc3RJZCB9O1xuXHQgIGhlYWRlcnNbJyR7YXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblx0ICBoZWFkZXJzWycke2ZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcn0nXSA9IHsgdmFsdWU6IHVyaSB9O1xuXG5cdCAgaWYgKGhlYWRlcnMuaG9zdCAmJiBoZWFkZXJzLmhvc3QudmFsdWUpIHtcblx0ICAgIGhlYWRlcnNbJyR7YXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgICBoZWFkZXJzWycke2ZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJ9J10gPSB7IHZhbHVlOiBoZWFkZXJzLmhvc3QudmFsdWUgfTtcblx0ICB9XG5cblx0ICBpZiAoJyR7bW9kZX0nID09PSAnJHtBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSfScpIHtcblx0ICAgIHZhciByYXdTM1ByZWZpeGVzID0gW1xuXHQgICAgICAke3Jhd1MzUHJlZml4TGlzdH1cblx0ICAgIF07XG5cdCAgICB2YXIgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtsYW1iZGFQYXNzdGhyb3VnaFByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGlzTGFtYmRhUGFzc3Rocm91Z2hQYXRoID0gZmFsc2U7XG5cblx0ICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlcy5sZW5ndGg7IGkrKykge1xuXHQgICAgICB2YXIgcHJlZml4ID0gbGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhlc1tpXTtcblx0ICAgICAgaWYgKHVyaSA9PT0gcHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHByZWZpeCArICcvJykpIHtcblx0ICAgICAgICBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IHRydWU7XG5cdCAgICAgICAgYnJlYWs7XG5cdCAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgaWYgKCFpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCkge1xuXHQgICAgICB2YXIgaXNSYXdTM1BhdGggPSBmYWxzZTtcblxuXHQgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IHJhd1MzUHJlZml4ZXMubGVuZ3RoOyBqKyspIHtcblx0ICAgICAgICB2YXIgcmF3UHJlZml4ID0gcmF3UzNQcmVmaXhlc1tqXTtcblx0ICAgICAgICBpZiAodXJpID09PSByYXdQcmVmaXggfHwgdXJpLnN0YXJ0c1dpdGgocmF3UHJlZml4ICsgJy8nKSkge1xuXHQgICAgICAgICAgaXNSYXdTM1BhdGggPSB0cnVlO1xuXHQgICAgICAgICAgYnJlYWs7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cblx0ICAgICAgdmFyIGxhc3RTbGFzaCA9IHVyaS5sYXN0SW5kZXhPZignLycpO1xuXHQgICAgICB2YXIgbGFzdFNlZ21lbnQgPSBsYXN0U2xhc2ggPj0gMCA/IHVyaS5zdWJzdHJpbmcobGFzdFNsYXNoICsgMSkgOiB1cmk7XG5cblx0ICAgICAgaWYgKCFpc1Jhd1MzUGF0aCAmJiBsYXN0U2VnbWVudC5pbmRleE9mKCcuJykgPT09IC0xKSB7XG5cdCAgICAgICAgcmVxdWVzdC51cmkgPSB1cmkuZW5kc1dpdGgoJy8nKSA/IHVyaSArICdpbmRleC5odG1sJyA6IHVyaSArICcvaW5kZXguaHRtbCc7XG5cdCAgICAgIH1cblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVxdWVzdDtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uQ29kZSgpOiBzdHJpbmcge1xuICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHZhciByZXNwb25zZSA9IGV2ZW50LnJlc3BvbnNlO1xuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSByZXF1ZXN0LmhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddO1xuXHQgIHZhciByZXF1ZXN0SWQgPSByZXF1ZXN0SWRIZWFkZXIgJiYgcmVxdWVzdElkSGVhZGVyLnZhbHVlID8gcmVxdWVzdElkSGVhZGVyLnZhbHVlLnRyaW0oKSA6ICcnO1xuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9IGV2ZW50LmNvbnRleHQgJiYgZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQgPyBTdHJpbmcoZXZlbnQuY29udGV4dC5yZXF1ZXN0SWQpLnRyaW0oKSA6ICcnO1xuXHQgIH1cblxuXHQgIGlmIChyZXF1ZXN0SWQpIHtcblx0ICAgIHJlc3BvbnNlLmhlYWRlcnMgPSByZXNwb25zZS5oZWFkZXJzIHx8IHt9O1xuXHQgICAgaWYgKCFyZXNwb25zZS5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSkge1xuXHQgICAgICByZXNwb25zZS5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXSA9IHsgdmFsdWU6IHJlcXVlc3RJZCB9O1xuXHQgICAgfVxuXHQgIH1cblxuXHQgIHJldHVybiByZXNwb25zZTtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTc3JTaXRlUHJvcHMge1xuICByZWFkb25seSBzc3JGdW5jdGlvbjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogRXhwbGljaXQgZGVwbG95bWVudCBtb2RlIGZvciB0aGUgc2l0ZSB0b3BvbG9neS5cbiAgICpcbiAgICogLSBgc3NyLW9ubHlgOiBMYW1iZGEgRnVuY3Rpb24gVVJMIGlzIHRoZSBkZWZhdWx0IG9yaWdpblxuICAgKiAtIGBzc2ctaXNyYDogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBpcyB0aGUgZmFsbGJhY2tcbiAgICpcbiAgICogRXhpc3RpbmcgaW1wbGljaXQgYmVoYXZpb3IgbWFwcyB0byBgc3NyLW9ubHlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU1JfT05MWVxuICAgKi9cbiAgcmVhZG9ubHkgbW9kZT86IEFwcFRoZW9yeVNzclNpdGVNb2RlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGludm9rZSBtb2RlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkludm9rZU1vZGUuUkVTUE9OU0VfU1RSRUFNXG4gICAqL1xuICByZWFkb25seSBpbnZva2VNb2RlPzogbGFtYmRhLkludm9rZU1vZGU7XG5cbiAgLyoqXG4gICAqIEZ1bmN0aW9uIFVSTCBhdXRoIHR5cGUgZm9yIHRoZSBTU1Igb3JpZ2luLlxuICAgKlxuICAgKiBJZiBvbWl0dGVkLCBBcHBUaGVvcnkgZmFpbHMgY2xvc2VkIHRvIGBBV1NfSUFNYCBhbmQgc2lnbnMgQ2xvdWRGcm9udC10by1MYW1iZGFcbiAgICogdHJhZmZpYyB3aXRoIGxhbWJkYSBPcmlnaW4gQWNjZXNzIENvbnRyb2wuXG4gICAqXG4gICAqIFNldCB0aGlzIGV4cGxpY2l0bHkgdG8gYE5PTkVgIG9ubHkgd2hlbiB5b3UgaW50ZW50aW9uYWxseSByZXF1aXJlIHB1YmxpY1xuICAgKiBkaXJlY3QgRnVuY3Rpb24gVVJMIGFjY2VzcyBhcyBhIGRlbGliZXJhdGUgY29tcGF0aWJpbGl0eSBjaG9pY2UuXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICovXG4gIHJlYWRvbmx5IHNzclVybEF1dGhUeXBlPzogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGU7XG5cbiAgcmVhZG9ubHkgYXNzZXRzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcmVhZG9ubHkgYXNzZXRzUGF0aD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4Pzogc3RyaW5nO1xuICByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgUzMgYnVja2V0IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlIChgUzNIdG1sU3RvcmVgKS5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlczpcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfQlVDS0VUYFxuICAgKiAtIGBGQUNFVEhFT1JZX0lTUl9QUkVGSVhgXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBTMyBrZXkgcHJlZml4IHVzZWQgYnkgRmFjZVRoZW9yeSBJU1IgSFRNTCBzdG9yYWdlLlxuICAgKiBAZGVmYXVsdCBpc3JcbiAgICovXG4gIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBleHRlbnNpb25sZXNzIEhUTUwgc2VjdGlvbiBwYXRoIHBhdHRlcm5zIHRvIHJvdXRlIGRpcmVjdGx5IHRvIHRoZSBwcmltYXJ5IEhUTUwgUzMgb3JpZ2luLlxuICAgKlxuICAgKiBSZXF1ZXN0cyBsaWtlIGAvbWFya2V0aW5nYCBhbmQgYC9tYXJrZXRpbmcvLi4uYCBhcmUgcmV3cml0dGVuIHRvIGAvaW5kZXguaHRtbGBcbiAgICogd2l0aGluIHRoZSBzZWN0aW9uIGFuZCBzdGF5IG9uIFMzIGluc3RlYWQgb2YgZmFsbGluZyBiYWNrIHRvIExhbWJkYS5cbiAgICpcbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgSFRNTCBzZWN0aW9uIHBhdGg6IFwiL21hcmtldGluZy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YXRpY1BhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIHJhdyBTMyBvYmplY3QvZGF0YSBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBleHRlbnNpb25sZXNzIEhUTUwgcmV3cml0ZXMuXG4gICAqXG4gICAqIEluIGBzc2ctaXNyYCBtb2RlLCBgL19mYWNldGhlb3J5L2RhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseS5cbiAgICogRXhhbXBsZSBkaXJlY3QtUzMgb2JqZWN0IHBhdGg6IFwiL2ZlZWRzLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgZGlyZWN0UzNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyB0aGUgYHNzZy1pc3JgIG9yaWdpbiBncm91cCBhbmQgcm91dGUgZGlyZWN0bHlcbiAgICogdG8gdGhlIExhbWJkYSBGdW5jdGlvbiBVUkwgd2l0aCBmdWxsIG1ldGhvZCBzdXBwb3J0LlxuICAgKlxuICAgKiBJbiBgc3NnLWlzcmAgbW9kZSwgYC9fZmFjZXRoZW9yeS9zc3ItZGF0YS8qYCBpcyBhZGRlZCBhdXRvbWF0aWNhbGx5IGZvciBGYWNlVGhlb3J5XG4gICAqIHN0cmljdCBuby1pbmxpbmUtQ1NQIFNTUiBoeWRyYXRpb24gc2lkZWNhcnMuXG4gICAqXG4gICAqIFVzZSB0aGlzIGZvciBzYW1lLW9yaWdpbiBkeW5hbWljIHBhdGhzIHN1Y2ggYXMgYXV0aCBjYWxsYmFja3MsIGFjdGlvbnMsIG9yIGZvcm0gcG9zdHMuXG4gICAqIEV4YW1wbGUgZGlyZWN0LVNTUiBwYXRoOiBcIi9hY3Rpb25zLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3NyUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgYmVhcmVyLWF1dGggTGFtYmRhIEZ1bmN0aW9uIFVSTCBjby1vcmlnaW5zIHRvIGF0dGFjaCB0byB0aGUgc2FtZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgZWFjaCBjby1vcmlnaW4gRnVuY3Rpb24gVVJMIHdpdGggYEF1dGhUeXBlLk5PTkVgIGFuZCByb3V0ZXMgdGhlIHN1cHBsaWVkXG4gICAqIHBhdGggcGF0dGVybnMgdG8gaXQgd2l0aG91dCBMYW1iZGEgT3JpZ2luIEFjY2VzcyBDb250cm9sLiBUaGUgU1NSIG9yaWdpbiByZW1haW5zIGdvdmVybmVkIGJ5XG4gICAqIGBzc3JVcmxBdXRoVHlwZWAgYW5kIHN0aWxsIGRlZmF1bHRzIHRvIGBBV1NfSUFNYCBwbHVzIExhbWJkYSBPQUMuXG4gICAqXG4gICAqIENvLW9yaWdpbiBwYXRocyBwYXJ0aWNpcGF0ZSBpbiBBcHBUaGVvcnkncyBiZWhhdmlvciBwYXRoIGNvbGxpc2lvbiBjaGVja3MgYW5kIGJ5cGFzcyBgc3NnLWlzcmBcbiAgICogSFRNTCByZXdyaXRlcy4gVGhpcyBpcyB0aGUgc3VwcG9ydGVkIEFwcFRoZW9yeSBwYXRoIGZvciBtaXhlZC1hdXRoIGRpc3RyaWJ1dGlvbnM7IGRvIG5vdCBoYW5kLXdpcmVcbiAgICogcmF3IGBkaXN0cmlidXRpb24uYWRkQmVoYXZpb3IoLi4uKWAgY2FsbHMgd2hlbiBBcHBUaGVvcnkgc2hvdWxkIG93biBwYXRoIGFuZCBlZGdlLWNvbnRleHQgcG9saWN5LlxuICAgKlxuICAgKiBFeGFtcGxlIGJlYXJlciBBUEkgcGF0aHM6IGBbXCIvYXBpLypcIiwgXCIvYXV0aC8qXCJdYC5cbiAgICovXG4gIHJlYWRvbmx5IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucz86IEFwcFRoZW9yeVNzclNpdGVCZWFyZXJGdW5jdGlvblVybE9yaWdpbltdO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBUYWJsZVRoZW9yeS9EeW5hbW9EQiB0YWJsZSB1c2VkIGZvciBGYWNlVGhlb3J5IElTUiBtZXRhZGF0YSBhbmQgbGVhc2UgY29vcmRpbmF0aW9uLlxuICAgKlxuICAgKiBXaGVuIHByb3ZpZGVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBTU1IgZnVuY3Rpb24gcmVhZC93cml0ZSBhY2Nlc3MgYW5kIHdpcmVzIHRoZVxuICAgKiBtZXRhZGF0YSB0YWJsZSBhbGlhc2VzIGV4cGVjdGVkIGJ5IHRoZSBkb2N1bWVudGVkIEZhY2VUaGVvcnkgZGVwbG95bWVudCBzaGFwZS5cbiAgICovXG4gIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIElTUi9jYWNoZSBtZXRhZGF0YSB0YWJsZSBuYW1lIHRvIHdpcmUgd2hlbiB5b3UgYXJlIG5vdCBwYXNzaW5nIGBpc3JNZXRhZGF0YVRhYmxlYC5cbiAgICpcbiAgICogUHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCB3aGVuIEFwcFRoZW9yeSBzaG91bGQgYWxzbyBncmFudCBhY2Nlc3MgdG8gdGhlIFNTUiBMYW1iZGEuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGVnYWN5IGFsaWFzIGZvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgLlxuICAgKiBAZGVwcmVjYXRlZCBwcmVmZXIgYGlzck1ldGFkYXRhVGFibGVgIG9yIGBpc3JNZXRhZGF0YVRhYmxlTmFtZWBcbiAgICovXG4gIHJlYWRvbmx5IGNhY2hlVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8vIFdoZW4gdHJ1ZSAoZGVmYXVsdCksIEFwcFRoZW9yeSB3aXJlcyByZWNvbW1lbmRlZCBydW50aW1lIGVudmlyb25tZW50IHZhcmlhYmxlcyBvbnRvIHRoZSBTU1IgZnVuY3Rpb24uXG4gIHJlYWRvbmx5IHdpcmVSdW50aW1lRW52PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBoZWFkZXJzIHRvIGZvcndhcmQgdG8gdGhlIFNTUiBvcmlnaW4gKExhbWJkYSBGdW5jdGlvbiBVUkwpIHZpYSB0aGUgb3JpZ2luIHJlcXVlc3QgcG9saWN5LlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBBcHBUaGVvcnkvRmFjZVRoZW9yeS1zYWZlIGVkZ2UgY29udHJhY3QgZm9yd2FyZHMgb25seTpcbiAgICogLSBgY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9gXG4gICAqIC0gYGNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NgXG4gICAqIC0gYHgtYXBwdGhlb3J5LW9yaWdpbmFsLWhvc3RgXG4gICAqIC0gYHgtYXBwdGhlb3J5LW9yaWdpbmFsLXVyaWBcbiAgICogLSBgeC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtcmVxdWVzdC1pZGBcbiAgICpcbiAgICogVXNlIHRoaXMgdG8gb3B0IGluIHRvIGFkZGl0aW9uYWwgYXBwLXNwZWNpZmljIGhlYWRlcnMgc3VjaCBhc1xuICAgKiBgeC1mYWNldGhlb3J5LXNlZ21lbnRgLiBUZW5hbnQtbGlrZSB2aWV3ZXIgaGVhZGVycyBhcmUgcmVqZWN0ZWQgdW5sZXNzXG4gICAqIGBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNgIGlzIGV4cGxpY2l0bHkgZW5hYmxlZCBhcyBhIGNvbXBhdGliaWxpdHkgbW9kZS5cbiAgICogYGhvc3RgIGFuZCBgeC1mb3J3YXJkZWQtcHJvdG9gIGFyZSByZWplY3RlZCBiZWNhdXNlIHRoZXkgYnJlYWsgb3IgYnlwYXNzIHRoZVxuICAgKiBzdXBwb3J0ZWQgb3JpZ2luIG1vZGVsLlxuICAgKi9cbiAgcmVhZG9ubHkgc3NyRm9yd2FyZEhlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQ29tcGF0aWJpbGl0eSBlc2NhcGUgaGF0Y2ggZm9yIGxlZ2FjeSB2aWV3ZXItc3VwcGxpZWQgdGVuYW50IGhlYWRlcnMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UgKGRlZmF1bHQpLCBBcHBUaGVvcnkgc3RyaXBzIGB4LXRlbmFudC1pZGAgYXQgdGhlIGVkZ2UgYW5kIHJlamVjdHNcbiAgICogdGVuYW50LWxpa2UgZW50cmllcyBpbiBgc3NyRm9yd2FyZEhlYWRlcnNgIHNvIHZpZXdlci1zdXBwbGllZCB0ZW5hbnQgaGVhZGVyc1xuICAgKiBjYW5ub3QgaW5mbHVlbmNlIG9yaWdpbiByb3V0aW5nIG9yIEhUTUwgY2FjaGUgcGFydGl0aW9uaW5nLiBXaGVuIHRydWUsXG4gICAqIEFwcFRoZW9yeSByZXN0b3JlcyBsZWdhY3kgcGFzc3Rocm91Z2ggYmVoYXZpb3IgZm9yIGB4LXRlbmFudC1pZGAgYW5kIGFueVxuICAgKiB0ZW5hbnQtbGlrZSBgc3NyRm9yd2FyZEhlYWRlcnNgLlxuICAgKlxuICAgKiBQcmVmZXIgZGVyaXZpbmcgdGVuYW50IGZyb20gdHJ1c3RlZCBob3N0IG1hcHBpbmcgdXNpbmcgdGhlIG9yaWdpbmFsLWhvc3RcbiAgICogZWRnZSBoZWFkZXJzIGluc3RlYWQgb2YgZW5hYmxpbmcgcGFzc3Rocm91Z2guXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnM/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dC5cbiAgICpcbiAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIHRoZSBidWNrZXRzIHRoaXMgY29uc3RydWN0IGNyZWF0ZXMgdGFrZVxuICAgKiB0aGVpciBuYW1lcyBmcm9tIHRoZSBjb250cmFjdCBhbmQgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBnbyB0b1xuICAgKiBgbG9ncy9hY2Nlc3MvY2RuL3tsb2dpY2FsTmFtZX1gIHRocm91Z2ggQ2xvdWRXYXRjaCBMb2dzIHZlbmRlZCBkZWxpdmVyeS5cbiAgICogUGFzcyBgZW5hYmxlTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQgb2YgdGhlIGRlbGl2ZXJ5LlxuICAgKlxuICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogVGhlIHNpdGUncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlbiBhXG4gICAqIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIENsb3VkRnJvbnQgc3RhbmRhcmQtbG9nZ2luZyBvdXRwdXQgZm9ybWF0IGZvciBhIENsb3VkV2F0Y2ggTG9nc1xuICAgKiBkZXN0aW5hdGlvbi4gT25seSB1c2VkIHVuZGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQuSlNPTlxuICAgKi9cbiAgcmVhZG9ubHkgY2xvdWRGcm9udExvZ0Zvcm1hdD86IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQ7XG5cbiAgcmVhZG9ubHkgZW5hYmxlTG9nZ2luZz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBDbG91ZEZyb250IHJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGFwcGxpZWQgdG8gU1NSIGFuZCBkaXJlY3QtUzMgYmVoYXZpb3JzLlxuICAgKlxuICAgKiBJZiBvbWl0dGVkLCBBcHBUaGVvcnkgcHJvdmlzaW9ucyBhIEZhY2VUaGVvcnktYWxpZ25lZCBiYXNlbGluZSBwb2xpY3kgYXQgdGhlIENETlxuICAgKiBsYXllcjogSFNUUywgbm9zbmlmZiwgZnJhbWUtb3B0aW9ucywgcmVmZXJyZXItcG9saWN5LCBYU1MgcHJvdGVjdGlvbiwgYW5kIGFcbiAgICogcmVzdHJpY3RpdmUgcGVybWlzc2lvbnMtcG9saWN5LiBDb250ZW50LVNlY3VyaXR5LVBvbGljeSByZW1haW5zIG9yaWdpbi1kZWZpbmVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gIC8qKlxuICAgKiBDYWNoZSBwb2xpY3kgYXBwbGllZCB0byBkaXJlY3QgTGFtYmRhLWJhY2tlZCBTU1IgYmVoYXZpb3JzLlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBpcyBgQ0FDSElOR19ESVNBQkxFRGAgc28gZHluYW1pYyBMYW1iZGEgcm91dGVzIHN0YXkgc2FmZSB1bmxlc3MgeW91XG4gICAqIGludGVudGlvbmFsbHkgb3B0IGludG8gYSBjYWNoZSBwb2xpY3kgdGhhdCBtYXRjaGVzIHlvdXIgYXBwJ3MgdmFyaWFuY2UgbW9kZWwuXG4gICAqIEBkZWZhdWx0IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRFxuICAgKi9cbiAgcmVhZG9ubHkgc3NyQ2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICAvKipcbiAgICogQ2FjaGUgcG9saWN5IGFwcGxpZWQgdG8gdGhlIGNhY2hlYWJsZSBIVE1MIGJlaGF2aW9yIGluIGBzc2ctaXNyYCBtb2RlLlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBBcHBUaGVvcnkgcG9saWN5IGtleXMgb24gcXVlcnkgc3RyaW5ncyBwbHVzIHRoZSBzdGFibGUgcHVibGljIEhUTUxcbiAgICogdmFyaWFudCBoZWFkZXJzIChgeC0qLW9yaWdpbmFsLWhvc3RgIGFuZCBhbnkgbm9uLXRlbmFudCBleHRyYSBmb3J3YXJkZWRcbiAgICogaGVhZGVycyB5b3Ugb3B0IGludG8pIHdoaWxlIGxlYXZpbmcgY29va2llcyBvdXQgb2YgdGhlIGNhY2hlIGtleS4gVGVuYW50LWxpa2VcbiAgICogdmlld2VyIGhlYWRlcnMgam9pbiB0aGUgY2FjaGUga2V5IG9ubHkgd2hlbiBgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzYCBpc1xuICAgKiBleHBsaWNpdGx5IGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSBodG1sQ2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgYXV0b0RlbGV0ZU9iamVjdHM/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBETlMgcmVjb3JkcyBhbmQgb3B0aW9uYWwgY2VydGlmaWNhdGUgdmFsaWRhdGlvbi5cbiAgICpcbiAgICogV2hlbiBgZG9tYWluTmFtZWAgaXMgc2V0IHdpdGhvdXQgYGNlcnRpZmljYXRlQXJuYCwgaG9zdGVkLXpvbmUgY2VydGlmaWNhdGVcbiAgICogY3JlYXRpb24gaXMgYWxsb3dlZCBvbmx5IGZvciBzdGFja3Mgd2hvc2UgcmVnaW9uIGlzIGV4cGxpY2l0bHkgYHVzLWVhc3QtMWAuXG4gICAqIENsb3VkRnJvbnQgcmVxdWlyZXMgdmlld2VyIGNlcnRpZmljYXRlcyBpbiBgdXMtZWFzdC0xYDsgZW52aXJvbm1lbnQtYWdub3N0aWNcbiAgICogb3Igb3RoZXItcmVnaW9uIHN0YWNrcyBtdXN0IHByb3ZpZGUgYGNlcnRpZmljYXRlQXJuYC5cbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuICAvKipcbiAgICogRXhpc3RpbmcgQUNNIGNlcnRpZmljYXRlIEFSTiBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgKlxuICAgKiBUaGUgY2VydGlmaWNhdGUgbXVzdCBiZSBpbiBgdXMtZWFzdC0xYCBmb3IgQ2xvdWRGcm9udC5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBNaW5pbXVtIFRMUyBwcm90b2NvbCB2ZXJzaW9uIGZvciB2aWV3ZXJzIG9mIGEgY3VzdG9tIGRvbWFpbi5cbiAgICpcbiAgICogV2l0aCBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgYW5kIGEgY3VzdG9tIGNlcnRpZmljYXRlIHRoZSBkZWZhdWx0IGlzXG4gICAqIGBUTFNfVjFfMl8yMDI1YCwgdGhlIHBvbGljeSBTZWN1cml0eSBIdWIgQ2xvdWRGcm9udC4xNSBhY2NlcHRzIHdpdGggdGhlXG4gICAqIHdpZGVzdCBjbGllbnQgc3VwcG9ydC4gV2l0aG91dCBhIGNlcnRpZmljYXRlIENsb3VkRnJvbnQgc2VydmVzIHRoZSBmaXhlZFxuICAgKiBkZWZhdWx0IGNlcnRpZmljYXRlIGFuZCB0aGlzIHByb3BlcnR5IGhhcyBubyBlZmZlY3QuXG4gICAqXG4gICAqIEBkZWZhdWx0IFRMU19WMV8yXzIwMjUgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0IHdpdGggYSBjZXJ0aWZpY2F0ZSxcbiAgICogb3RoZXJ3aXNlIHRoZSBDbG91ZEZyb250IGRlZmF1bHQgZm9yIHRoZSBjZXJ0aWZpY2F0ZVxuICAgKi9cbiAgcmVhZG9ubHkgbWluaW11bVByb3RvY29sVmVyc2lvbj86IGNsb3VkZnJvbnQuU2VjdXJpdHlQb2xpY3lQcm90b2NvbDtcblxuICAvKipcbiAgICogT2JqZWN0IENsb3VkRnJvbnQgcmV0dXJucyBmb3IgYSByZXF1ZXN0IHRvIHRoZSBkaXN0cmlidXRpb24gcm9vdC5cbiAgICpcbiAgICogV2l0aCBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgYW5kIGBtb2RlOiBzc2ctaXNyYCB0aGUgZGVmYXVsdCBpc1xuICAgKiBgaW5kZXguaHRtbGAsIGJlY2F1c2UgdGhhdCBtb2RlJ3MgZGVmYXVsdCBiZWhhdmlvciBpcyB0aGUgUzMgSFRNTCBzdG9yZVxuICAgKiAoU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMSkuIGBzc3Itb25seWAgYWxzbyBjYXJyaWVzIGFuIFMzIG9yaWdpbiAodGhlXG4gICAqIGFzc2V0IGJ1Y2tldCksIHNvIHRoZSBjb250cm9sIGV2YWx1YXRlcyB0aGUgZGlzdHJpYnV0aW9uLCBidXQgYC9gIG11c3RcbiAgICogcmVhY2ggdGhlIGZ1bmN0aW9uIFVSTDsgYSBkZWZhdWx0IHJvb3Qgb2JqZWN0IHdvdWxkIHJld3JpdGUgYC9gIG9udG8gdGhlXG4gICAqIGZ1bmN0aW9uIFVSTCwgc28gQXBwVGhlb3J5IGRlbGliZXJhdGVseSBzZXRzIG5vbmUgYW5kIHRoZSBjb250cm9sIHJlcG9ydHNcbiAgICogYSByZXNpZHVhbCBmaW5kaW5nLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcImluZGV4Lmh0bWxcIiB1bmRlciBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgaW4gYHNzZy1pc3JgIG1vZGVcbiAgICovXG4gIHJlYWRvbmx5IGRlZmF1bHRSb290T2JqZWN0Pzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBCdWNrZXQgdGhhdCByZWNlaXZlcyBTMyBzZXJ2ZXIgYWNjZXNzIGxvZ3MgZm9yIHRoZSBidWNrZXRzIHRoaXMgY29uc3RydWN0XG4gICAqIGNyZWF0ZXMsIHdoaWNoIGlzIHdoYXQgU2VjdXJpdHkgSHViIFMzLjkgZXZhbHVhdGVzLlxuICAgKlxuICAgKiBPZmYgYnkgZGVmYXVsdCBiZWNhdXNlIHRoZSBsb2cgdGFyZ2V0IGFuZCBpdHMgc3RvcmFnZSBjb3N0IG1vbmV5LiBUaGUgdGFyZ2V0XG4gICAqIGJ1Y2tldCBpcyB5b3VyczogaXQgdGFrZXMgbm8gbmFtaW5nIGVudHJ5IChyZXNvdXJjZS1uYW1pbmcgY29udHJhY3RcbiAgICogc2VjdGlvbiA0KSwgYW5kIGl0IHNob3VsZCBub3QgaXRzZWxmIGJlIGxvZ2dlZC5cbiAgICpcbiAgICogQGRlZmF1bHQgbm8gc2VydmVyIGFjY2VzcyBsb2dnaW5nXG4gICAqL1xuICByZWFkb25seSBzZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogS2V5IHByZWZpeCBmb3IgdGhlIHNlcnZlciBhY2Nlc3MgbG9ncy4gT25seSB1c2VkIHdpdGhcbiAgICogYHNlcnZlckFjY2Vzc0xvZ3NCdWNrZXRgLlxuICAgKlxuICAgKiBAZGVmYXVsdCBubyBwcmVmaXhcbiAgICovXG4gIHJlYWRvbmx5IHNlcnZlckFjY2Vzc0xvZ3NQcmVmaXg/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZUJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luIHtcbiAgLyoqXG4gICAqIExhbWJkYSBmdW5jdGlvbiB0aGF0IEFwcFRoZW9yeSBleHBvc2VzIGFzIGEgYmVhcmVyLWF1dGggRnVuY3Rpb24gVVJMIGNvLW9yaWdpbi5cbiAgICpcbiAgICogQXBwVGhlb3J5IGNyZWF0ZXMgdGhlIEZ1bmN0aW9uIFVSTCB3aXRoIGBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5OT05FYDsgYXV0aGVudGljYXRpb24gcmVtYWluc1xuICAgKiB0aGUgcmVzcG9uc2liaWxpdHkgb2YgdGhlIExhbWJkYSBoYW5kbGVyLlxuICAgKi9cbiAgcmVhZG9ubHkgZnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIENsb3VkRnJvbnQgcGF0aCBwYXR0ZXJucyB0aGF0IHJvdXRlIHRvIHRoaXMgY28tb3JpZ2luLlxuICAgKlxuICAgKiBQYXR0ZXJucyBhcmUgbm9ybWFsaXplZCB0aGUgc2FtZSB3YXkgYXMgYHNzclBhdGhQYXR0ZXJuc2AuIEEgcGF0dGVybiBlbmRpbmcgaW4gYC8qYCBhbHNvIGNyZWF0ZXNcbiAgICogYSByb290IGJlaGF2aW9yIHdpdGhvdXQgdGhlIHdpbGRjYXJkIHNvIGAvYXBpLypgIGNvdmVycyBib3RoIGAvYXBpYCBhbmQgYC9hcGkvLi4uYC5cbiAgICovXG4gIHJlYWRvbmx5IHBhdGhQYXR0ZXJuczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaW52b2tlIG1vZGUgZm9yIHRoaXMgY28tb3JpZ2luLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuSW52b2tlTW9kZS5CVUZGRVJFRFxuICAgKi9cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5U3NyU2l0ZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNCdWNrZXQ6IHMzLklCdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNLZXlQcmVmaXg6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGFzc2V0c01hbmlmZXN0S2V5OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBodG1sU3RvcmVCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgaHRtbFN0b3JlS2V5UHJlZml4Pzogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgc3NyVXJsOiBsYW1iZGEuRnVuY3Rpb25Vcmw7XG4gIHB1YmxpYyByZWFkb25seSBiZWFyZXJGdW5jdGlvblVybHM6IGxhbWJkYS5GdW5jdGlvblVybFtdO1xuICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcbiAgcHVibGljIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlTc3JTaXRlUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKCFwcm9wcz8uc3NyRnVuY3Rpb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgcHJvcHMuc3NyRnVuY3Rpb25cIik7XG4gICAgfVxuXG4gICAgY29uc3Qgc2l0ZU1vZGUgPSBwcm9wcy5tb2RlID8/IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTUl9PTkxZO1xuICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgY29uc3Qgd2lyZVJ1bnRpbWVFbnYgPSBwcm9wcy53aXJlUnVudGltZUVudiA/PyB0cnVlO1xuICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcbiAgICBjb25zdCBpc3JNZXRhZGF0YUxvZ2ljYWwgPSBsb2dpY2FsID8gYCR7bG9naWNhbH0taXNyLW1ldGFkYXRhYCA6IHVuZGVmaW5lZDtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgXCJBcHBUaGVvcnlTc3JTaXRlXCIsXG4gICAgICBcImlzck1ldGFkYXRhVGFibGVOYW1lXCIsXG4gICAgICBcImR5bmFtb2RiX3RhYmxlXCIsXG4gICAgICBpc3JNZXRhZGF0YUxvZ2ljYWwsXG4gICAgICBwcm9wcy5pc3JNZXRhZGF0YVRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkLFxuICAgICk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKFxuICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZVwiLFxuICAgICAgXCJjYWNoZVRhYmxlTmFtZVwiLFxuICAgICAgXCJkeW5hbW9kYl90YWJsZVwiLFxuICAgICAgaXNyTWV0YWRhdGFMb2dpY2FsLFxuICAgICAgcHJvcHMuY2FjaGVUYWJsZU5hbWUgIT09IHVuZGVmaW5lZCxcbiAgICApO1xuICAgIGlmIChuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgcHJvcHMubG9nc0J1Y2tldCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZSBjYW5ub3QgaG9ub3IgcHJvcHMubG9nc0J1Y2tldCB1bmRlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlOyBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGdvIHRvIHRoZSBjb250cmFjdCBsb2cgZ3JvdXAsIHNvIHJlbW92ZSBwcm9wcy5sb2dzQnVja2V0IG9yIHVzZSB0aGUgbGVnYWN5IGxvZ2dpbmcgcHJvZmlsZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3Qgc3RhbmRhcmRMb2dnaW5nID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIGVuYWJsZUxvZ2dpbmc7XG5cbiAgICAvLyBTZWN1cml0eSBIdWIgUzMuOSBzdGF5cyBvcHQtaW46IHRoZSBjYWxsZXIgc3VwcGxpZXMgdGhlIGxvZyB0YXJnZXQsIGFuZCBpdFxuICAgIC8vIHRha2VzIG5vIG5hbWluZyBlbnRyeSAocmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0IHNlY3Rpb24gNCkuXG4gICAgY29uc3Qgc2VydmVyQWNjZXNzTG9ncyA9IHByb3BzLnNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQgIT09IHVuZGVmaW5lZFxuICAgICAgPyB7XG4gICAgICAgIHNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQ6IHByb3BzLnNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQsXG4gICAgICAgIC4uLihwcm9wcy5zZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4ICE9PSB1bmRlZmluZWRcbiAgICAgICAgICA/IHsgc2VydmVyQWNjZXNzTG9nc1ByZWZpeDogcHJvcHMuc2VydmVyQWNjZXNzTG9nc1ByZWZpeCB9XG4gICAgICAgICAgOiB7fSksXG4gICAgICB9XG4gICAgICA6IHt9O1xuXG4gICAgdGhpcy5hc3NldHNCdWNrZXQgPVxuICAgICAgcHJvcHMuYXNzZXRzQnVja2V0ID8/XG4gICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQXNzZXRzQnVja2V0XCIsIHtcbiAgICAgICAgLi4uKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCA/IGJ1Y2tldE5hbWluZ1Byb3BzKG5hbWluZ0NvbnRleHQsIGAke2xvZ2ljYWx9LWFzc2V0c2ApIDoge30pLFxuICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgIC4uLnNlcnZlckFjY2Vzc0xvZ3MsXG4gICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgfSk7XG5cbiAgICBpZiAoZW5hYmxlTG9nZ2luZyAmJiAhc3RhbmRhcmRMb2dnaW5nKSB7XG4gICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGFzc2V0c1ByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKHByb3BzLmFzc2V0c0tleVByZWZpeCA/PyBcImFzc2V0c1wiKS50cmltKCksIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNLZXlQcmVmaXggPSBhc3NldHNQcmVmaXhSYXcgfHwgXCJhc3NldHNcIjtcblxuICAgIGNvbnN0IG1hbmlmZXN0UmF3ID0gU3RyaW5nKHByb3BzLmFzc2V0c01hbmlmZXN0S2V5ID8/IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmApLnRyaW0oKTtcbiAgICBjb25zdCBtYW5pZmVzdEtleSA9IHRyaW1SZXBlYXRlZENoYXIobWFuaWZlc3RSYXcsIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNNYW5pZmVzdEtleSA9IG1hbmlmZXN0S2V5IHx8IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmA7XG5cbiAgICB0aGlzLmFzc2V0c0tleVByZWZpeCA9IGFzc2V0c0tleVByZWZpeDtcbiAgICB0aGlzLmFzc2V0c01hbmlmZXN0S2V5ID0gYXNzZXRzTWFuaWZlc3RLZXk7XG5cbiAgICBjb25zdCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dCA9IFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHNob3VsZENvbmZpZ3VyZUh0bWxTdG9yZSA9IEJvb2xlYW4ocHJvcHMuaHRtbFN0b3JlQnVja2V0KSB8fCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dC5sZW5ndGggPiAwO1xuICAgIGlmIChzaG91bGRDb25maWd1cmVIdG1sU3RvcmUpIHtcbiAgICAgIGNvbnN0IGh0bWxTdG9yZVByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoXG4gICAgICAgIFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeCkudHJpbSgpLFxuICAgICAgICBcIi9cIixcbiAgICAgICk7XG4gICAgICB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCA9IGh0bWxTdG9yZVByZWZpeFJhdyB8fCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4O1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQgPVxuICAgICAgICBwcm9wcy5odG1sU3RvcmVCdWNrZXQgPz9cbiAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkh0bWxTdG9yZUJ1Y2tldFwiLCB7XG4gICAgICAgICAgLi4uKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCA/IGJ1Y2tldE5hbWluZ1Byb3BzKG5hbWluZ0NvbnRleHQsIGAke2xvZ2ljYWx9LWh0bWwtc3RvcmVgKSA6IHt9KSxcbiAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgIC4uLnNlcnZlckFjY2Vzc0xvZ3MsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5pc3JNZXRhZGF0YVRhYmxlID0gcHJvcHMuaXNyTWV0YWRhdGFUYWJsZTtcblxuICAgIGNvbnN0IGV4cGxpY2l0SXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuaXNyTWV0YWRhdGFUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IGxlZ2FjeUNhY2hlVGFibGVOYW1lID0gU3RyaW5nKHByb3BzLmNhY2hlVGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCByZXNvdXJjZUlzck1ldGFkYXRhVGFibGVOYW1lID0gU3RyaW5nKHRoaXMuaXNyTWV0YWRhdGFUYWJsZT8udGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcblxuICAgIGNvbnN0IGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgW3Jlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUsIGV4cGxpY2l0SXNyTWV0YWRhdGFUYWJsZU5hbWUsIGxlZ2FjeUNhY2hlVGFibGVOYW1lXS5maWx0ZXIoXG4gICAgICAgICAgKG5hbWUpID0+IFN0cmluZyhuYW1lKS50cmltKCkubGVuZ3RoID4gMCxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIGlmIChjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzLmxlbmd0aCA+IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgY29uZmxpY3RpbmcgSVNSIG1ldGFkYXRhIHRhYmxlIG5hbWVzOiAke2NvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGxldCBpc3JNZXRhZGF0YVRhYmxlTmFtZSA9IGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXNbMF0gPz8gXCJcIjtcblxuICAgIC8vIFVuZGVyIGEgbmFtaW5nIGNvbnRleHQgdGhlIElTUi9jYWNoZSBtZXRhZGF0YSB0YWJsZSBpcyBuYW1lZCB0aHJvdWdoIHRoZVxuICAgIC8vIGNvbnRyYWN0IG9ubHkgd2hlbiB0aGUgY29uc3RydWN0IHdpcmVzIGEgbmFtZSB0aGUgY2FsbGVyIGRpZCBub3Qgc3VwcGx5LlxuICAgIC8vIGBzc2ctaXNyYCBuZWVkcyBhIHRhYmxlLCBzbyBpdCBjb25zdW1lcyB0aGUgYHtsb2dpY2FsfS1pc3ItbWV0YWRhdGFgXG4gICAgLy8gZW50cnkuIEFuIGV4dGVybmFsIHRhYmxlIHBhc3NlZCB0aHJvdWdoIGBpc3JNZXRhZGF0YVRhYmxlYCBpcyB0aGVcbiAgICAvLyBjYWxsZXIncyByZXNvdXJjZTogaXQgY29uc3VtZXMgbm8gZW50cnksIHNvIGFuIGVudHJ5IG5hbWluZyBpdCBpcyBhblxuICAgIC8vIG9ycGhhbiAocjMsIEFEVi0xMzEyLTI7IE0yIHJlc2lkdWFsKS5cbiAgICBpZiAoXG4gICAgICBuYW1pbmdDb250ZXh0ICYmXG4gICAgICBsb2dpY2FsICYmXG4gICAgICBwcm9wcy5pc3JNZXRhZGF0YVRhYmxlID09PSB1bmRlZmluZWQgJiZcbiAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgKSB7XG4gICAgICBjb25zdCBjb21wb3NlZCA9IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiZHluYW1vZGJfdGFibGVcIiwgYCR7bG9naWNhbH0taXNyLW1ldGFkYXRhYCk7XG4gICAgICBpZiAoaXNyTWV0YWRhdGFUYWJsZU5hbWUgPT09IFwiXCIgJiYgIWNvbXBvc2VkLmdlbmVyYXRlZCAmJiBjb21wb3NlZC5uYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBjb21wb3NlZC5uYW1lO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChwcm9wcy5hc3NldHNQYXRoKSB7XG4gICAgICBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCBcIkFzc2V0c0RlcGxveW1lbnRcIiwge1xuICAgICAgICBzb3VyY2VzOiBbczNkZXBsb3kuU291cmNlLmFzc2V0KHByb3BzLmFzc2V0c1BhdGgpXSxcbiAgICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IHRoaXMuYXNzZXRzQnVja2V0LFxuICAgICAgICBkZXN0aW5hdGlvbktleVByZWZpeDogYXNzZXRzS2V5UHJlZml4LFxuICAgICAgICBwcnVuZTogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YXRpY1BhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhwcm9wcy5zdGF0aWNQYXRoUGF0dGVybnMpO1xuICAgIGNvbnN0IGRpcmVjdFMzUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKFtcbiAgICAgIC4uLihzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IFtzc2dJc3JIeWRyYXRpb25QYXRoUGF0dGVybl0gOiBbXSksXG4gICAgICAuLi4oQXJyYXkuaXNBcnJheShwcm9wcy5kaXJlY3RTM1BhdGhQYXR0ZXJucykgPyBwcm9wcy5kaXJlY3RTM1BhdGhQYXR0ZXJucyA6IFtdKSxcbiAgICBdKTtcbiAgICBjb25zdCBzc3JQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMoW1xuICAgICAgLi4uKHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gW3NzZ0lzclNzckRhdGFQYXRoUGF0dGVybl0gOiBbXSksXG4gICAgICAuLi4oQXJyYXkuaXNBcnJheShwcm9wcy5zc3JQYXRoUGF0dGVybnMpID8gcHJvcHMuc3NyUGF0aFBhdHRlcm5zIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2lucyA9IEFycmF5LmlzQXJyYXkocHJvcHMuYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zKVxuICAgICAgPyBwcm9wcy5iZWFyZXJGdW5jdGlvblVybE9yaWdpbnNcbiAgICAgIDogW107XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzID0gYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zLm1hcCgob3JpZ2luLCBpbmRleCkgPT4ge1xuICAgICAgaWYgKCFvcmlnaW4/LmZ1bmN0aW9uKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5U3NyU2l0ZSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnNbJHtpbmRleH1dIHJlcXVpcmVzIGZ1bmN0aW9uYCk7XG4gICAgICB9XG4gICAgICBjb25zdCBwYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMob3JpZ2luLnBhdGhQYXR0ZXJucyk7XG4gICAgICBpZiAocGF0aFBhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zWyR7aW5kZXh9XSByZXF1aXJlcyBhdCBsZWFzdCBvbmUgcGF0aCBwYXR0ZXJuYCk7XG4gICAgICB9XG4gICAgICByZXR1cm4geyBvcmlnaW4sIHBhdGhQYXR0ZXJucyB9O1xuICAgIH0pO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsUGF0aFBhdHRlcm5zID0gYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmZsYXRNYXAoKGNvbmZpZykgPT4gY29uZmlnLnBhdGhQYXR0ZXJucyk7XG4gICAgY29uc3QgYmVoYXZpb3JQYXR0ZXJuT3duZXJzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBjb25zdCBiZWhhdmlvclBhdHRlcm5zOiBTZWVuQmVoYXZpb3JQYXR0ZXJuW10gPSBbXTtcbiAgICBjb25zdCBzc3JVcmxBdXRoVHlwZSA9IHByb3BzLnNzclVybEF1dGhUeXBlID8/IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU07XG4gICAgY29uc3QgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzID0gcHJvcHMuYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzID8/IGZhbHNlO1xuXG4gICAgdGhpcy5zc3JVcmwgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uVXJsKHRoaXMsIFwiU3NyVXJsXCIsIHtcbiAgICAgIGZ1bmN0aW9uOiBwcm9wcy5zc3JGdW5jdGlvbixcbiAgICAgIGF1dGhUeXBlOiBzc3JVcmxBdXRoVHlwZSxcbiAgICAgIGludm9rZU1vZGU6IHByb3BzLmludm9rZU1vZGUgPz8gbGFtYmRhLkludm9rZU1vZGUuUkVTUE9OU0VfU1RSRUFNLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3NyT3JpZ2luID1cbiAgICAgIHNzclVybEF1dGhUeXBlID09PSBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNXG4gICAgICAgID8gb3JpZ2lucy5GdW5jdGlvblVybE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCh0aGlzLnNzclVybClcbiAgICAgICAgOiBuZXcgb3JpZ2lucy5GdW5jdGlvblVybE9yaWdpbih0aGlzLnNzclVybCk7XG5cbiAgICBjb25zdCBhc3NldHNPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuYXNzZXRzQnVja2V0KTtcbiAgICBjb25zdCBodG1sT3JpZ2luQnVja2V0ID0gdGhpcy5odG1sU3RvcmVCdWNrZXQgPz8gdGhpcy5hc3NldHNCdWNrZXQ7XG4gICAgY29uc3QgaHRtbE9yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2woXG4gICAgICBodG1sT3JpZ2luQnVja2V0LFxuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQgJiYgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXhcbiAgICAgICAgPyB7XG4gICAgICAgICAgICBvcmlnaW5QYXRoOiBgLyR7dGhpcy5odG1sU3RvcmVLZXlQcmVmaXh9YCxcbiAgICAgICAgICB9XG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgICk7XG5cbiAgICBjb25zdCBiYXNlU3NyRm9yd2FyZEhlYWRlcnMgPSBbXG4gICAgICBcImNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvXCIsXG4gICAgICBcImNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NcIixcbiAgICAgIC4uLnNzck9yaWdpbmFsSG9zdEhlYWRlcnMsXG4gICAgICAuLi5zc3JPcmlnaW5hbFVyaUhlYWRlcnMsXG4gICAgICBcIngtcmVxdWVzdC1pZFwiLFxuICAgIF07XG5cbiAgICBjb25zdCBkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMgPSBuZXcgU2V0KFtcImhvc3RcIiwgXCJ4LWZvcndhcmRlZC1wcm90b1wiXSk7XG5cbiAgICBjb25zdCBleHRyYVNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuaXNBcnJheShwcm9wcy5zc3JGb3J3YXJkSGVhZGVycylcbiAgICAgID8gcHJvcHMuc3NyRm9yd2FyZEhlYWRlcnMubWFwKGNhbm9uaWNhbGl6ZUhlYWRlck5hbWUpLmZpbHRlcigoaGVhZGVyKSA9PiBoZWFkZXIubGVuZ3RoID4gMClcbiAgICAgIDogW107XG5cbiAgICBjb25zdCByZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChleHRyYVNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiBkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuaGFzKGhlYWRlcikpKSxcbiAgICApLnNvcnQoKTtcblxuICAgIGlmIChyZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBkaXNhbGxvd3Mgc3NyRm9yd2FyZEhlYWRlcnM6ICR7cmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+IGlzVGVuYW50SGVhZGVyTmFtZShoZWFkZXIpKSksXG4gICAgKS5zb3J0KCk7XG5cbiAgICBpZiAocmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMubGVuZ3RoID4gMCAmJiAhYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIGFsbG93Vmlld2VyVGVuYW50SGVhZGVycz10cnVlIGZvciB0ZW5hbnQtbGlrZSBzc3JGb3J3YXJkSGVhZGVyczogJHtyZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVycy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdGVuYW50UGFzc3Rocm91Z2hIZWFkZXJzID0gYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzXG4gICAgICA/IEFycmF5LmZyb20obmV3IFNldChbZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciwgLi4ucmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnNdKSlcbiAgICAgIDogW107XG4gICAgY29uc3QgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMgPSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNcbiAgICAgID8gW11cbiAgICAgIDogQXJyYXkuZnJvbShuZXcgU2V0KFtkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyLCAuLi5yZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVyc10pKS5zb3J0KCk7XG5cbiAgICBjb25zdCBzc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbLi4uYmFzZVNzckZvcndhcmRIZWFkZXJzLCAuLi50ZW5hbnRQYXNzdGhyb3VnaEhlYWRlcnMsIC4uLmV4dHJhU3NyRm9yd2FyZEhlYWRlcnNdLmZpbHRlcihcbiAgICAgICAgICAoaGVhZGVyKSA9PiAhZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmhhcyhoZWFkZXIpLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICApO1xuICAgIGNvbnN0IGh0bWxDYWNoZUtleUV4Y2x1ZGVkSGVhZGVycyA9IG5ldyBTZXQoW1xuICAgICAgXCJjbG91ZGZyb250LWZvcndhcmRlZC1wcm90b1wiLFxuICAgICAgXCJjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzXCIsXG4gICAgICAuLi5zc3JPcmlnaW5hbFVyaUhlYWRlcnMsXG4gICAgICBcIngtcmVxdWVzdC1pZFwiLFxuICAgIF0pO1xuICAgIGNvbnN0IGh0bWxDYWNoZUtleUhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChzc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gIWh0bWxDYWNoZUtleUV4Y2x1ZGVkSGVhZGVycy5oYXMoaGVhZGVyKSkpLFxuICAgICk7XG4gICAgY29uc3QgbWF4QmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcnMgPSAxMDtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShuZXcgU2V0KFsuLi5iYXNlU3NyRm9yd2FyZEhlYWRlcnMsIFwiY29udGVudC10eXBlXCJdKSk7XG4gICAgY29uc3QgaXNCbG9ja2VkQmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlciA9IChoZWFkZXI6IHN0cmluZyk6IGJvb2xlYW4gPT5cbiAgICAgIGhlYWRlciA9PT0gXCJob3N0XCIgfHxcbiAgICAgIGhlYWRlciA9PT0gXCJmb3J3YXJkZWRcIiB8fFxuICAgICAgaGVhZGVyID09PSBcIngtcmVhbC1pcFwiIHx8XG4gICAgICBoZWFkZXIuc3RhcnRzV2l0aChcIngtZm9yd2FyZGVkLVwiKSB8fFxuICAgICAgaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcik7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgW1xuICAgICAgICAgIFwiYXV0aG9yaXphdGlvblwiLFxuICAgICAgICAgIFwiYWNjZXB0XCIsXG4gICAgICAgICAgXCJvcmlnaW5cIixcbiAgICAgICAgICBcImFjY2Vzcy1jb250cm9sLXJlcXVlc3QtbWV0aG9kXCIsXG4gICAgICAgICAgXCJhY2Nlc3MtY29udHJvbC1yZXF1ZXN0LWhlYWRlcnNcIixcbiAgICAgICAgICAuLi5leHRyYVNzckZvcndhcmRIZWFkZXJzLmZpbHRlcihcbiAgICAgICAgICAgIChoZWFkZXIpID0+XG4gICAgICAgICAgICAgICFpc0Jsb2NrZWRCZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVyKGhlYWRlcikgJiZcbiAgICAgICAgICAgICAgIWJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luRm9yd2FyZEhlYWRlcnMuaW5jbHVkZXMoaGVhZGVyKSxcbiAgICAgICAgICApLFxuICAgICAgICBdLmZpbHRlcigoaGVhZGVyKSA9PiBoZWFkZXIubGVuZ3RoID4gMCksXG4gICAgICApLFxuICAgICk7XG5cbiAgICBpZiAoIXByb3BzLmh0bWxDYWNoZVBvbGljeSAmJiBodG1sQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aCA+IG1heERlZmF1bHRDYWNoZUtleUhlYWRlcnMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgZGVmYXVsdCBodG1sQ2FjaGVQb2xpY3kgc3VwcG9ydHMgYXQgbW9zdCAke21heERlZmF1bHRDYWNoZUtleUhlYWRlcnN9IGNhY2hlLWtleSBoZWFkZXJzOyByZWNlaXZlZCAke2h0bWxDYWNoZUtleUhlYWRlcnMubGVuZ3RofWAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MubGVuZ3RoID4gMCAmJlxuICAgICAgYmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcnMubGVuZ3RoID4gbWF4QmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcnNcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zIHN1cHBvcnQgYXQgbW9zdCAke21heEJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXJzfSBjYWNoZS1rZXkgZm9yd2FyZGVkIGhlYWRlcnM7IHJlY2VpdmVkICR7YmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcnMubGVuZ3RofWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHNzck9yaWdpblJlcXVlc3RQb2xpY3kgPSBuZXcgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5KHRoaXMsIFwiU3NyT3JpZ2luUmVxdWVzdFBvbGljeVwiLCB7XG4gICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLmFsbCgpLFxuICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5zc3JGb3J3YXJkSGVhZGVycyksXG4gICAgfSk7XG4gICAgY29uc3QgaHRtbE9yaWdpblJlcXVlc3RQb2xpY3kgPSBuZXcgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5KHRoaXMsIFwiSHRtbE9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLnNzckZvcndhcmRIZWFkZXJzKSxcbiAgICB9KTtcbiAgICBjb25zdCBzc3JDYWNoZVBvbGljeSA9IHByb3BzLnNzckNhY2hlUG9saWN5ID8/IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRDtcbiAgICBjb25zdCBzdGF0aWNBc3NldHNDYWNoZVBvbGljeSA9IG5ldyBjbG91ZGZyb250LkNhY2hlUG9saWN5KHRoaXMsIFwiU3RhdGljQXNzZXRzQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgY29tbWVudDpcbiAgICAgICAgXCJBcHBUaGVvcnkgZGlyZWN0IFMzIGFzc2V0L2RhdGEgY2FjaGUgcG9saWN5OiBvcmlnaW4gQ2FjaGUtQ29udHJvbCBib3VuZGVkIGJ5IG5vIHZpZXdlciBoZWFkZXIgZm9yd2FyZGluZ1wiLFxuICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgZGVmYXVsdFR0bDogRHVyYXRpb24uZGF5cygxKSxcbiAgICAgIG1heFR0bDogRHVyYXRpb24uZGF5cygzNjUpLFxuICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUhlYWRlckJlaGF2aW9yLm5vbmUoKSxcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVRdWVyeVN0cmluZ0JlaGF2aW9yLm5vbmUoKSxcbiAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nQnJvdGxpOiB0cnVlLFxuICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdHemlwOiB0cnVlLFxuICAgIH0pO1xuICAgIGNvbnN0IGh0bWxDYWNoZVBvbGljeSA9XG4gICAgICBwcm9wcy5odG1sQ2FjaGVQb2xpY3kgPz9cbiAgICAgIG5ldyBjbG91ZGZyb250LkNhY2hlUG9saWN5KHRoaXMsIFwiSHRtbENhY2hlUG9saWN5XCIsIHtcbiAgICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IEhUTUwgY2FjaGUgcG9saWN5IGtleWVkIGJ5IHF1ZXJ5IHN0cmluZ3MgYW5kIHN0YWJsZSBwdWJsaWMgdmFyaWFudCBoZWFkZXJzXCIsXG4gICAgICAgIG1pblR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgZGVmYXVsdFR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgbWF4VHRsOiBEdXJhdGlvbi5kYXlzKDM2NSksXG4gICAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlQ29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5odG1sQ2FjaGVLZXlIZWFkZXJzKSxcbiAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZVF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nQnJvdGxpOiB0cnVlLFxuICAgICAgICBlbmFibGVBY2NlcHRFbmNvZGluZ0d6aXA6IHRydWUsXG4gICAgICB9KTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpblJlcXVlc3RQb2xpY3kgPVxuICAgICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmxlbmd0aCA+IDBcbiAgICAgICAgPyBuZXcgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5KHRoaXMsIFwiQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgICAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICAgICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsKCksXG4gICAgICAgICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KFxuICAgICAgICAgICAgICAuLi5iZWFyZXJGdW5jdGlvblVybE9yaWdpbkZvcndhcmRIZWFkZXJzLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybENhY2hlUG9saWN5ID1cbiAgICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5sZW5ndGggPiAwXG4gICAgICAgID8gbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJCZWFyZXJGdW5jdGlvblVybENhY2hlUG9saWN5XCIsIHtcbiAgICAgICAgICAgIGNvbW1lbnQ6XG4gICAgICAgICAgICAgIFwiQXBwVGhlb3J5IGJlYXJlciBGdW5jdGlvbiBVUkwgQVBJIGNhY2hlIHBvbGljeTogY2FjaGluZyBkaXNhYmxlZCB3aGlsZSBmb3J3YXJkaW5nIGJlYXJlci9DT1JTIGFwcCBoZWFkZXJzXCIsXG4gICAgICAgICAgICBtaW5UdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICAgICAgbWF4VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICAgICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5iZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycyksXG4gICAgICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5ub25lKCksXG4gICAgICAgICAgfSlcbiAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcbiAgICAgIFwiZGlyZWN0IFMzIHBhdGhzXCIsXG4gICAgICBbYCR7YXNzZXRzS2V5UHJlZml4fS8qYCwgLi4uZGlyZWN0UzNQYXRoUGF0dGVybnNdLFxuICAgICAgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLFxuICAgICAgYmVoYXZpb3JQYXR0ZXJucyxcbiAgICApO1xuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFwic3RhdGljIEhUTUwgcGF0aHNcIiwgc3RhdGljUGF0aFBhdHRlcm5zLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMsIGJlaGF2aW9yUGF0dGVybnMpO1xuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFwiZGlyZWN0IFNTUiBwYXRoc1wiLCBzc3JQYXRoUGF0dGVybnMsIGJlaGF2aW9yUGF0dGVybk93bmVycywgYmVoYXZpb3JQYXR0ZXJucyk7XG4gICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmZvckVhY2goKGNvbmZpZywgaW5kZXgpID0+IHtcbiAgICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFxuICAgICAgICBgYmVhcmVyIEZ1bmN0aW9uIFVSTCBjby1vcmlnaW4gJHtpbmRleCArIDF9YCxcbiAgICAgICAgY29uZmlnLnBhdGhQYXR0ZXJucyxcbiAgICAgICAgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLFxuICAgICAgICBiZWhhdmlvclBhdHRlcm5zLFxuICAgICAgKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IHZpZXdlclJlcXVlc3RGdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LkZ1bmN0aW9uKHRoaXMsIFwiU3NyVmlld2VyUmVxdWVzdEZ1bmN0aW9uXCIsIHtcbiAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoXG4gICAgICAgIGdlbmVyYXRlU3NyVmlld2VyUmVxdWVzdEZ1bmN0aW9uQ29kZShcbiAgICAgICAgICBzaXRlTW9kZSxcbiAgICAgICAgICBbYCR7YXNzZXRzS2V5UHJlZml4fS8qYCwgLi4uZGlyZWN0UzNQYXRoUGF0dGVybnNdLFxuICAgICAgICAgIFsuLi5zc3JQYXRoUGF0dGVybnMsIC4uLmJlYXJlckZ1bmN0aW9uVXJsUGF0aFBhdHRlcm5zXSxcbiAgICAgICAgICBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgICBydW50aW1lOiBjbG91ZGZyb250LkZ1bmN0aW9uUnVudGltZS5KU18yXzAsXG4gICAgICBjb21tZW50OlxuICAgICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICAgID8gXCJGYWNlVGhlb3J5IHZpZXdlci1yZXF1ZXN0IGVkZ2UgY29udGV4dCBhbmQgSFRNTCByZXdyaXRlIGZvciBTU1Igc2l0ZVwiXG4gICAgICAgICAgOiBcIkZhY2VUaGVvcnkgdmlld2VyLXJlcXVlc3QgZWRnZSBjb250ZXh0IGZvciBTU1Igc2l0ZVwiLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgdmlld2VyUmVzcG9uc2VGdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LkZ1bmN0aW9uKHRoaXMsIFwiU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvblwiLCB7XG4gICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKGdlbmVyYXRlU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvbkNvZGUoKSksXG4gICAgICBydW50aW1lOiBjbG91ZGZyb250LkZ1bmN0aW9uUnVudGltZS5KU18yXzAsXG4gICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgdmlld2VyLXJlc3BvbnNlIHJlcXVlc3QtaWQgZWNobyBmb3IgU1NSIHNpdGVcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucyA9ICgpOiBjbG91ZGZyb250LkZ1bmN0aW9uQXNzb2NpYXRpb25bXSA9PiBbXG4gICAgICB7XG4gICAgICAgIGZ1bmN0aW9uOiB2aWV3ZXJSZXF1ZXN0RnVuY3Rpb24sXG4gICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVRVUVTVCxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGZ1bmN0aW9uOiB2aWV3ZXJSZXNwb25zZUZ1bmN0aW9uLFxuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFU1BPTlNFLFxuICAgICAgfSxcbiAgICBdO1xuXG4gICAgY29uc3QgZG9tYWluTmFtZSA9IFN0cmluZyhwcm9wcy5kb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKTtcblxuICAgIGxldCBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuXG4gICAgaWYgKGRvbWFpbk5hbWUpIHtcbiAgICAgIGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzID0gW2RvbWFpbk5hbWVdO1xuICAgICAgY29uc3QgY2VydEFybiA9IFN0cmluZyhwcm9wcy5jZXJ0aWZpY2F0ZUFybiA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoY2VydEFybikge1xuICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCBjZXJ0QXJuKTtcbiAgICAgIH0gZWxzZSBpZiAocHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgICBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHRoaXMpO1xuICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IG5ldyBhY20uQ2VydGlmaWNhdGUodGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCB7XG4gICAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgICAgICB2YWxpZGF0aW9uOiBhY20uQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMocHJvcHMuaG9zdGVkWm9uZSksXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBwcm9wcy5jZXJ0aWZpY2F0ZUFybiBvciBwcm9wcy5ob3N0ZWRab25lIHdoZW4gcHJvcHMuZG9tYWluTmFtZSBpcyBzZXRcIik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlO1xuXG4gICAgdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICBuZXcgY2xvdWRmcm9udC5SZXNwb25zZUhlYWRlcnNQb2xpY3kodGhpcywgXCJSZXNwb25zZUhlYWRlcnNQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgYmFzZWxpbmUgc2VjdXJpdHkgaGVhZGVycyAoQ1NQIHN0YXlzIG9yaWdpbi1kZWZpbmVkKVwiLFxuICAgICAgICBzZWN1cml0eUhlYWRlcnNCZWhhdmlvcjoge1xuICAgICAgICAgIHN0cmljdFRyYW5zcG9ydFNlY3VyaXR5OiB7XG4gICAgICAgICAgICBhY2Nlc3NDb250cm9sTWF4QWdlOiBEdXJhdGlvbi5kYXlzKDM2NSAqIDIpLFxuICAgICAgICAgICAgaW5jbHVkZVN1YmRvbWFpbnM6IHRydWUsXG4gICAgICAgICAgICBwcmVsb2FkOiB0cnVlLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBjb250ZW50VHlwZU9wdGlvbnM6IHsgb3ZlcnJpZGU6IHRydWUgfSxcbiAgICAgICAgICBmcmFtZU9wdGlvbnM6IHtcbiAgICAgICAgICAgIGZyYW1lT3B0aW9uOiBjbG91ZGZyb250LkhlYWRlcnNGcmFtZU9wdGlvbi5ERU5ZLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZWZlcnJlclBvbGljeToge1xuICAgICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IGNsb3VkZnJvbnQuSGVhZGVyc1JlZmVycmVyUG9saWN5LlNUUklDVF9PUklHSU5fV0hFTl9DUk9TU19PUklHSU4sXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHhzc1Byb3RlY3Rpb246IHtcbiAgICAgICAgICAgIHByb3RlY3Rpb246IHRydWUsXG4gICAgICAgICAgICBtb2RlQmxvY2s6IHRydWUsXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBjdXN0b21IZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICBjdXN0b21IZWFkZXJzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGhlYWRlcjogXCJwZXJtaXNzaW9ucy1wb2xpY3lcIixcbiAgICAgICAgICAgICAgdmFsdWU6IFwiY2FtZXJhPSgpLCBtaWNyb3Bob25lPSgpLCBnZW9sb2NhdGlvbj0oKVwiLFxuICAgICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlU3RhdGljQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogYXNzZXRzT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgY2FjaGVQb2xpY3k6IHN0YXRpY0Fzc2V0c0NhY2hlUG9saWN5LFxuICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZVN0YXRpY0h0bWxCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBodG1sT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgY2FjaGVQb2xpY3k6IGh0bWxDYWNoZVBvbGljeSxcbiAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZVNzckJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IHNzck9yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgY2FjaGVQb2xpY3k6IHNzckNhY2hlUG9saWN5LFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogc3NyT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG5cbiAgICBjb25zdCBhZGRpdGlvbmFsQmVoYXZpb3JzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucz4gPSB7fTtcbiAgICBjb25zdCBhZGRFeHBhbmRlZEJlaGF2aW9yID0gKHBhdHRlcm5zOiBzdHJpbmdbXSwgZmFjdG9yeTogKCkgPT4gY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMpOiB2b2lkID0+IHtcbiAgICAgIGZvciAoY29uc3QgcGF0dGVybiBvZiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJucykpIHtcbiAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1twYXR0ZXJuXSA9IGZhY3RvcnkoKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihbYCR7YXNzZXRzS2V5UHJlZml4fS8qYF0sIGNyZWF0ZVN0YXRpY0JlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKGRpcmVjdFMzUGF0aFBhdHRlcm5zLCBjcmVhdGVTdGF0aWNCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihzdGF0aWNQYXRoUGF0dGVybnMsIGNyZWF0ZVN0YXRpY0h0bWxCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihzc3JQYXRoUGF0dGVybnMsIGNyZWF0ZVNzckJlaGF2aW9yKTtcbiAgICB0aGlzLmJlYXJlckZ1bmN0aW9uVXJscyA9IFtdO1xuICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5mb3JFYWNoKChjb25maWcsIGluZGV4KSA9PiB7XG4gICAgICBjb25zdCBmdW5jdGlvblVybCA9IG5ldyBsYW1iZGEuRnVuY3Rpb25VcmwodGhpcywgYEJlYXJlckZ1bmN0aW9uVXJsJHtpbmRleCArIDF9YCwge1xuICAgICAgICBmdW5jdGlvbjogY29uZmlnLm9yaWdpbi5mdW5jdGlvbixcbiAgICAgICAgYXV0aFR5cGU6IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLk5PTkUsXG4gICAgICAgIGludm9rZU1vZGU6IGNvbmZpZy5vcmlnaW4uaW52b2tlTW9kZSA/PyBsYW1iZGEuSW52b2tlTW9kZS5CVUZGRVJFRCxcbiAgICAgIH0pO1xuICAgICAgdGhpcy5iZWFyZXJGdW5jdGlvblVybHMucHVzaChmdW5jdGlvblVybCk7XG4gICAgICBjb25zdCBmdW5jdGlvblVybE9yaWdpbiA9IG5ldyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luKGZ1bmN0aW9uVXJsKTtcbiAgICAgIGNvbnN0IGNyZWF0ZUJlYXJlckZ1bmN0aW9uVXJsQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgICAgb3JpZ2luOiBmdW5jdGlvblVybE9yaWdpbixcbiAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgY2FjaGVQb2xpY3k6IGJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVQb2xpY3ksXG4gICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgICAgfSk7XG4gICAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKGNvbmZpZy5wYXRoUGF0dGVybnMsIGNyZWF0ZUJlYXJlckZ1bmN0aW9uVXJsQmVoYXZpb3IpO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZGVmYXVsdE9yaWdpbiA9XG4gICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICA/IG5ldyBvcmlnaW5zLk9yaWdpbkdyb3VwKHtcbiAgICAgICAgICAgIHByaW1hcnlPcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICAgICAgICBmYWxsYmFja09yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgICAgICAgZmFsbGJhY2tTdGF0dXNDb2RlczogWzQwMywgNDA0XSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IHNzck9yaWdpbjtcbiAgICBjb25zdCBkZWZhdWx0QWxsb3dlZE1ldGhvZHMgPVxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgPyBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlNcbiAgICAgICAgOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTDtcblxuICAgIC8vIFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjE1IGFuZCBDbG91ZEZyb250LjEgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0LlxuICAgIGNvbnN0IG1pbmltdW1Qcm90b2NvbFZlcnNpb24gPSBkZWZhdWx0TWluaW11bVByb3RvY29sVmVyc2lvbihcbiAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSAhPT0gdW5kZWZpbmVkLFxuICAgICAgcHJvcHMubWluaW11bVByb3RvY29sVmVyc2lvbixcbiAgICApO1xuICAgIGNvbnN0IGRlZmF1bHRSb290T2JqZWN0ID0gcHJvcHMuZGVmYXVsdFJvb3RPYmplY3RcbiAgICAgID8/IChzZWN1cmVEZWZhdWx0cyhuYW1pbmdDb250ZXh0KSAmJiBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUiA/IFwiaW5kZXguaHRtbFwiIDogdW5kZWZpbmVkKTtcblxuICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICA/IHsgZW5hYmxlTG9nZ2luZzogdHJ1ZSwgbG9nQnVja2V0OiB0aGlzLmxvZ3NCdWNrZXQsIGxvZ0ZpbGVQcmVmaXg6IFwiY2xvdWRmcm9udC9cIiB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKG1pbmltdW1Qcm90b2NvbFZlcnNpb24gIT09IHVuZGVmaW5lZCA/IHsgbWluaW11bVByb3RvY29sVmVyc2lvbiB9IDoge30pLFxuICAgICAgLi4uKGRlZmF1bHRSb290T2JqZWN0ICE9PSB1bmRlZmluZWQgPyB7IGRlZmF1bHRSb290T2JqZWN0IH0gOiB7fSksXG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgb3JpZ2luOiBkZWZhdWx0T3JpZ2luLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGRlZmF1bHRBbGxvd2VkTWV0aG9kcyxcbiAgICAgICAgY2FjaGVQb2xpY3k6IHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gaHRtbENhY2hlUG9saWN5IDogc3NyQ2FjaGVQb2xpY3ksXG4gICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gaHRtbE9yaWdpblJlcXVlc3RQb2xpY3kgOiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgICB9LFxuICAgICAgYWRkaXRpb25hbEJlaGF2aW9ycyxcbiAgICAgIC4uLihwcm9wcy53ZWJBY2xJZCA/IHsgd2ViQWNsSWQ6IHByb3BzLndlYkFjbElkIH0gOiB7fSksXG4gICAgfSk7XG5cbiAgICBpZiAoc3RhbmRhcmRMb2dnaW5nICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyh7XG4gICAgICAgIHNjb3BlOiB0aGlzLFxuICAgICAgICBpZDogXCJDZG5Mb2dnaW5nXCIsXG4gICAgICAgIGNvbnRleHQ6IG5hbWluZ0NvbnRleHQsXG4gICAgICAgIGRpc3RyaWJ1dGlvbjogdGhpcy5kaXN0cmlidXRpb24sXG4gICAgICAgIGxvZ2ljYWw6IGBsb2dzL2FjY2Vzcy9jZG4vJHtsb2dpY2FsfWAsXG4gICAgICAgIGZvcm1hdDogcHJvcHMuY2xvdWRGcm9udExvZ0Zvcm1hdCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTSkge1xuICAgICAgcHJvcHMuc3NyRnVuY3Rpb24uYWRkUGVybWlzc2lvbihcIkFsbG93Q2xvdWRGcm9udEludm9rZUZ1bmN0aW9uVmlhVXJsXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLFxuICAgICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImNsb3VkZnJvbnQuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgc291cmNlQXJuOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Bcm4sXG4gICAgICAgIGludm9rZWRWaWFGdW5jdGlvblVybDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmh0bWxTdG9yZUJ1Y2tldCkge1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQuZ3JhbnRSZWFkV3JpdGUocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmlzck1ldGFkYXRhVGFibGUpIHtcbiAgICAgIHRoaXMuaXNyTWV0YWRhdGFUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh3aXJlUnVudGltZUVudikge1xuICAgICAgdGhpcy5hc3NldHNCdWNrZXQuZ3JhbnRSZWFkKHByb3BzLnNzckZ1bmN0aW9uKTtcblxuICAgICAgY29uc3Qgc3NyRnVuY3Rpb25BbnkgPSBwcm9wcy5zc3JGdW5jdGlvbiBhcyBhbnk7XG4gICAgICBpZiAodHlwZW9mIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZSB3aXJlUnVudGltZUVudiByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvbiB0byBzdXBwb3J0IGFkZEVudmlyb25tZW50OyBwYXNzIGEgbGFtYmRhLkZ1bmN0aW9uIG9yIHNldCB3aXJlUnVudGltZUVudj1mYWxzZSBhbmQgc2V0IGVudiB2YXJzIG1hbnVhbGx5XCIsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19CVUNLRVRcIiwgdGhpcy5hc3NldHNCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfUFJFRklYXCIsIGFzc2V0c0tleVByZWZpeCk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfTUFOSUZFU1RfS0VZXCIsIGFzc2V0c01hbmlmZXN0S2V5KTtcblxuICAgICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KSB7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfQlVDS0VUXCIsIHRoaXMuaHRtbFN0b3JlQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkZBQ0VUSEVPUllfSVNSX1BSRUZJWFwiLCB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCk7XG4gICAgICB9XG4gICAgICBpZiAoaXNyTWV0YWRhdGFUYWJsZU5hbWUpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQ0FDSEVfVEFCTEVfTkFNRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRvbWFpbk5hbWUgJiYgcHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogZG9tYWluTmFtZSxcbiAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gIH1cbn1cbiJdfQ==