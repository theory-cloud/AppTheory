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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "7.5.0" };
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
        if (namingContext && logical && props.assetsBucket === undefined) {
            // Contract section 11.4: declare the resource carrying the composed name.
            namingContext.declareName("s3_bucket", `${logical}-assets`, this.assetsBucket);
        }
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
            if (namingContext && logical && props.htmlStoreBucket === undefined) {
                namingContext.declareName("s3_bucket", `${logical}-html-store`, this.htmlStoreBucket);
            }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQW9FO0FBQ3BFLHdFQUEwRDtBQUMxRCx1RUFBeUQ7QUFDekQsNEVBQThEO0FBRTlELHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsd0VBQTBEO0FBQzFELDJDQUF1QztBQUd2Qyx5REFBNEQ7QUFDNUQseUVBQW9FO0FBQ3BFLGlFQUFnRztBQUNoRywrREFBMEY7QUFHMUYseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLHlCQUF5QixDQUFDO0FBQzNELE1BQU0sNEJBQTRCLEdBQUcsS0FBSyxDQUFDO0FBQzNDLE1BQU0seUJBQXlCLEdBQUcsRUFBRSxDQUFDO0FBQ3JDLE1BQU0seUJBQXlCLEdBQUcsYUFBYSxDQUFDO0FBRWhELElBQVksb0JBWVg7QUFaRCxXQUFZLG9CQUFvQjtJQUM5Qjs7O09BR0c7SUFDSCw2Q0FBcUIsQ0FBQTtJQUVyQjs7O09BR0c7SUFDSCwyQ0FBbUIsQ0FBQTtBQUNyQixDQUFDLEVBWlcsb0JBQW9CLG9DQUFwQixvQkFBb0IsUUFZ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O1FBQ0wsQ0FBQztJQUVILENBQUM7O0FBbHBCSCw0Q0FtcEJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnRcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi9sb2dnaW5nXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgYnVja2V0TmFtaW5nUHJvcHMsIGVuYWJsZUNsb3VkRnJvbnRTdGFuZGFyZExvZ2dpbmcgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB7IGRlZmF1bHRNaW5pbXVtUHJvdG9jb2xWZXJzaW9uLCBzZWN1cmVEZWZhdWx0cyB9IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuXG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyLCB0cmltUmVwZWF0ZWRDaGFyU3RhcnQgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuXG5jb25zdCBhcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtdXJpXCI7XG5jb25zdCBmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIgPSBcIngtZmFjZXRoZW9yeS1vcmlnaW5hbC11cmlcIjtcbmNvbnN0IGFwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1hcHB0aGVvcnktb3JpZ2luYWwtaG9zdFwiO1xuY29uc3QgZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciA9IFwieC1mYWNldGhlb3J5LW9yaWdpbmFsLWhvc3RcIjtcbmNvbnN0IHNzck9yaWdpbmFsVXJpSGVhZGVycyA9IFthcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlciwgZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzck9yaWdpbmFsSG9zdEhlYWRlcnMgPSBbYXBwdGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyLCBmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyXSBhcyBjb25zdDtcbmNvbnN0IHNzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuID0gXCIvX2ZhY2V0aGVvcnkvZGF0YS8qXCI7XG5jb25zdCBzc2dJc3JTc3JEYXRhUGF0aFBhdHRlcm4gPSBcIi9fZmFjZXRoZW9yeS9zc3ItZGF0YS8qXCI7XG5jb25zdCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4ID0gXCJpc3JcIjtcbmNvbnN0IG1heERlZmF1bHRDYWNoZUtleUhlYWRlcnMgPSAxMDtcbmNvbnN0IGRlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIgPSBcIngtdGVuYW50LWlkXCI7XG5cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeVNzclNpdGVNb2RlIHtcbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaXMgdGhlIGRlZmF1bHQgb3JpZ2luLiBEaXJlY3QgUzMgYmVoYXZpb3JzIGFyZSB1c2VkIG9ubHkgZm9yXG4gICAqIGltbXV0YWJsZSBhc3NldHMgYW5kIGFueSBleHBsaWNpdGx5IGNvbmZpZ3VyZWQgc3RhdGljIHBhdGggcGF0dGVybnMuXG4gICAqL1xuICBTU1JfT05MWSA9IFwic3NyLW9ubHlcIixcblxuICAvKipcbiAgICogUzMgaXMgdGhlIHByaW1hcnkgSFRNTCBvcmlnaW4gYW5kIExhbWJkYSBTU1IvSVNSIGlzIHRoZSBmYWxsYmFjay4gRmFjZVRoZW9yeSBoeWRyYXRpb25cbiAgICogZGF0YSByb3V0ZXMgYXJlIGtlcHQgb24gUzMgYW5kIHRoZSBlZGdlIHJld3JpdGVzIGV4dGVuc2lvbmxlc3MgcGF0aHMgdG8gYC9pbmRleC5odG1sYC5cbiAgICovXG4gIFNTR19JU1IgPSBcInNzZy1pc3JcIixcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5Ub1VyaVByZWZpeChwYXR0ZXJuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKS5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gIHJldHVybiBub3JtYWxpemVkID8gYC8ke25vcm1hbGl6ZWR9YCA6IFwiL1wiO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoUGF0dGVybnMocGF0dGVybnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICByZXR1cm4gQXJyYXkuZnJvbShcbiAgICBuZXcgU2V0KFxuICAgICAgKEFycmF5LmlzQXJyYXkocGF0dGVybnMpID8gcGF0dGVybnMgOiBbXSlcbiAgICAgICAgLm1hcCgocGF0dGVybikgPT4gdHJpbVJlcGVhdGVkQ2hhclN0YXJ0KFN0cmluZyhwYXR0ZXJuKS50cmltKCksIFwiL1wiKSlcbiAgICAgICAgLmZpbHRlcigocGF0dGVybikgPT4gcGF0dGVybi5sZW5ndGggPiAwKSxcbiAgICApLFxuICApO1xufVxuXG5mdW5jdGlvbiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJuczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4cGFuZGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIik7XG4gICAgaWYgKCFub3JtYWxpemVkKSBjb250aW51ZTtcblxuICAgIGV4cGFuZGVkLmFkZChub3JtYWxpemVkKTtcbiAgICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aChcIi8qXCIpKSB7XG4gICAgICBjb25zdCByb290UGF0dGVybiA9IG5vcm1hbGl6ZWQuc2xpY2UoMCwgLTIpO1xuICAgICAgaWYgKHJvb3RQYXR0ZXJuKSB7XG4gICAgICAgIGV4cGFuZGVkLmFkZChyb290UGF0dGVybik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIEFycmF5LmZyb20oZXhwYW5kZWQpO1xufVxuXG5pbnRlcmZhY2UgU2VlbkJlaGF2aW9yUGF0dGVybiB7XG4gIHJlYWRvbmx5IHBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbGFiZWw6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFBhdGhQYXR0ZXJuVHJhbnNpdGlvbiB7XG4gIHJlYWRvbmx5IHRhcmdldDogbnVtYmVyO1xuICByZWFkb25seSBhbnk6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxpdGVyYWw/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuRXBzaWxvbkNsb3N1cmUocGF0dGVybjogc3RyaW5nLCBpbmRleDogbnVtYmVyKTogbnVtYmVyW10ge1xuICBjb25zdCBjbG9zdXJlOiBudW1iZXJbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IHN0YWNrID0gW2luZGV4XTtcblxuICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBzdGFjay5wb3AoKSA/PyAwO1xuICAgIGlmIChzZWVuLmhhcyhjdXJyZW50KSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZW4uYWRkKGN1cnJlbnQpO1xuICAgIGNsb3N1cmUucHVzaChjdXJyZW50KTtcblxuICAgIGlmIChwYXR0ZXJuW2N1cnJlbnRdID09PSBcIipcIikge1xuICAgICAgc3RhY2sucHVzaChjdXJyZW50ICsgMSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGNsb3N1cmU7XG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuVHJhbnNpdGlvbnMocGF0dGVybjogc3RyaW5nLCBpbmRleDogbnVtYmVyKTogUGF0aFBhdHRlcm5UcmFuc2l0aW9uW10ge1xuICBjb25zdCB0b2tlbiA9IHBhdHRlcm5baW5kZXhdO1xuICBpZiAodG9rZW4gPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGlmICh0b2tlbiA9PT0gXCIqXCIpIHtcbiAgICByZXR1cm4gW3sgdGFyZ2V0OiBpbmRleCwgYW55OiB0cnVlIH1dO1xuICB9XG5cbiAgaWYgKHRva2VuID09PSBcIj9cIikge1xuICAgIHJldHVybiBbeyB0YXJnZXQ6IGluZGV4ICsgMSwgYW55OiB0cnVlIH1dO1xuICB9XG5cbiAgcmV0dXJuIFt7IHRhcmdldDogaW5kZXggKyAxLCBhbnk6IGZhbHNlLCBsaXRlcmFsOiB0b2tlbiB9XTtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5UcmFuc2l0aW9uc0NhblNoYXJlQ2hhcmFjdGVyKGxlZnQ6IFBhdGhQYXR0ZXJuVHJhbnNpdGlvbiwgcmlnaHQ6IFBhdGhQYXR0ZXJuVHJhbnNpdGlvbik6IGJvb2xlYW4ge1xuICByZXR1cm4gbGVmdC5hbnkgfHwgcmlnaHQuYW55IHx8IGxlZnQubGl0ZXJhbCA9PT0gcmlnaHQubGl0ZXJhbDtcbn1cblxuZnVuY3Rpb24gcGF0aFBhdHRlcm5zQ2FuT3ZlcmxhcChsZWZ0OiBzdHJpbmcsIHJpZ2h0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgc2VlblN0YXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBxdWV1ZTogQXJyYXk8W251bWJlciwgbnVtYmVyXT4gPSBbXTtcblxuICBjb25zdCBlbnF1ZXVlQ2xvc3VyZVBhaXJzID0gKGxlZnRJbmRleDogbnVtYmVyLCByaWdodEluZGV4OiBudW1iZXIpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGxlZnRDbG9zZWQgb2YgcGF0aFBhdHRlcm5FcHNpbG9uQ2xvc3VyZShsZWZ0LCBsZWZ0SW5kZXgpKSB7XG4gICAgICBmb3IgKGNvbnN0IHJpZ2h0Q2xvc2VkIG9mIHBhdGhQYXR0ZXJuRXBzaWxvbkNsb3N1cmUocmlnaHQsIHJpZ2h0SW5kZXgpKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke2xlZnRDbG9zZWR9OiR7cmlnaHRDbG9zZWR9YDtcbiAgICAgICAgaWYgKHNlZW5TdGF0ZXMuaGFzKGtleSkpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBzZWVuU3RhdGVzLmFkZChrZXkpO1xuICAgICAgICBxdWV1ZS5wdXNoKFtsZWZ0Q2xvc2VkLCByaWdodENsb3NlZF0pO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBlbnF1ZXVlQ2xvc3VyZVBhaXJzKDAsIDApO1xuXG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgW2xlZnRJbmRleCwgcmlnaHRJbmRleF0gPSBxdWV1ZS5zaGlmdCgpID8/IFswLCAwXTtcbiAgICBpZiAobGVmdEluZGV4ID09PSBsZWZ0Lmxlbmd0aCAmJiByaWdodEluZGV4ID09PSByaWdodC5sZW5ndGgpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgbGVmdFRyYW5zaXRpb24gb2YgcGF0aFBhdHRlcm5UcmFuc2l0aW9ucyhsZWZ0LCBsZWZ0SW5kZXgpKSB7XG4gICAgICBmb3IgKGNvbnN0IHJpZ2h0VHJhbnNpdGlvbiBvZiBwYXRoUGF0dGVyblRyYW5zaXRpb25zKHJpZ2h0LCByaWdodEluZGV4KSkge1xuICAgICAgICBpZiAoIXBhdGhQYXR0ZXJuVHJhbnNpdGlvbnNDYW5TaGFyZUNoYXJhY3RlcihsZWZ0VHJhbnNpdGlvbiwgcmlnaHRUcmFuc2l0aW9uKSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZW5xdWV1ZUNsb3N1cmVQYWlycyhsZWZ0VHJhbnNpdGlvbi50YXJnZXQsIHJpZ2h0VHJhbnNpdGlvbi50YXJnZXQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgc2Vlbk93bmVyczogTWFwPHN0cmluZywgc3RyaW5nPixcbiAgc2VlblBhdHRlcm5zOiBTZWVuQmVoYXZpb3JQYXR0ZXJuW10sXG4pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgIGNvbnN0IG93bmVyID0gc2Vlbk93bmVycy5nZXQocGF0dGVybik7XG4gICAgaWYgKG93bmVyICYmIG93bmVyICE9PSBsYWJlbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIHJlY2VpdmVkIG92ZXJsYXBwaW5nIHBhdGggcGF0dGVybiBcIiR7cGF0dGVybn1cIiBmb3IgJHtvd25lcn0gYW5kICR7bGFiZWx9YCk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBzZWVuUGF0dGVybiBvZiBzZWVuUGF0dGVybnMpIHtcbiAgICAgIGlmIChzZWVuUGF0dGVybi5sYWJlbCAhPT0gbGFiZWwgJiYgcGF0aFBhdHRlcm5zQ2FuT3ZlcmxhcChzZWVuUGF0dGVybi5wYXR0ZXJuLCBwYXR0ZXJuKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJucyBcIiR7c2VlblBhdHRlcm4ucGF0dGVybn1cIiBhbmQgXCIke3BhdHRlcm59XCIgZm9yICR7c2VlblBhdHRlcm4ubGFiZWx9IGFuZCAke2xhYmVsfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgc2Vlbk93bmVycy5zZXQocGF0dGVybiwgbGFiZWwpO1xuICAgIHNlZW5QYXR0ZXJucy5wdXNoKHsgcGF0dGVybiwgbGFiZWwgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2Fub25pY2FsaXplSGVhZGVyTmFtZShoZWFkZXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcoaGVhZGVyKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuZnVuY3Rpb24gaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBjYW5vbmljYWxpemVIZWFkZXJOYW1lKGhlYWRlcikucmVwbGFjZSgvW15hLXowLTldKy9nLCBcIi1cIik7XG4gIHJldHVybiBub3JtYWxpemVkID09PSBkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyIHx8IC8oXnwtKXRlbmFudCgtfCQpLy50ZXN0KG5vcm1hbGl6ZWQpO1xufVxuXG5mdW5jdGlvbiBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHNjb3BlOiBDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgY29uc3QgcmVnaW9uID0gU3RhY2sub2Yoc2NvcGUpLnJlZ2lvbjtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQocmVnaW9uKSAmJiByZWdpb24gPT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5U3NyU2l0ZSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIHByb3BzLmNlcnRpZmljYXRlQXJuIGZvciBzdGFja3MgaW4gb3RoZXIgb3IgZW52aXJvbm1lbnQtYWdub3N0aWMgcmVnaW9ucy5gLFxuICApO1xufVxuXG5mdW5jdGlvbiBnZW5lcmF0ZVNzclZpZXdlclJlcXVlc3RGdW5jdGlvbkNvZGUoXG4gIG1vZGU6IEFwcFRoZW9yeVNzclNpdGVNb2RlLFxuICByYXdTM1BhdGhQYXR0ZXJuczogc3RyaW5nW10sXG4gIGxhbWJkYVBhc3N0aHJvdWdoUGF0aFBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnM6IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3UzNQcmVmaXhlcyA9IHJhd1MzUGF0aFBhdHRlcm5zLm1hcChwYXRoUGF0dGVyblRvVXJpUHJlZml4KS5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbiAgY29uc3QgcmF3UzNQcmVmaXhMaXN0ID0gcmF3UzNQcmVmaXhlcy5tYXAoKHByZWZpeCkgPT4gYCcke3ByZWZpeH0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG4gIGNvbnN0IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBsYW1iZGFQYXNzdGhyb3VnaFBhdGhQYXR0ZXJuc1xuICAgIC5tYXAocGF0aFBhdHRlcm5Ub1VyaVByZWZpeClcbiAgICAuc29ydCgoYSwgYikgPT4gYi5sZW5ndGggLSBhLmxlbmd0aCk7XG4gIGNvbnN0IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4TGlzdCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubWFwKChwcmVmaXgpID0+IGAnJHtwcmVmaXh9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuICBjb25zdCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyTGlzdCA9IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLm1hcCgoaGVhZGVyKSA9PiBgJyR7aGVhZGVyfSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcblxuICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHJlcXVlc3QuaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycyB8fCB7fTtcblx0ICB2YXIgaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycztcblx0ICB2YXIgdXJpID0gcmVxdWVzdC51cmkgfHwgJy8nO1xuXHQgIHZhciBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyA9IFtcblx0ICAgICR7YmxvY2tlZFZpZXdlclRlbmFudEhlYWRlckxpc3R9XG5cdCAgXTtcblxuXHQgIGZvciAodmFyIGJsb2NrZWRJbmRleCA9IDA7IGJsb2NrZWRJbmRleCA8IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLmxlbmd0aDsgYmxvY2tlZEluZGV4KyspIHtcblx0ICAgIGRlbGV0ZSBoZWFkZXJzW2Jsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzW2Jsb2NrZWRJbmRleF1dO1xuXHQgIH1cblxuXHQgIHZhciByZXF1ZXN0SWRIZWFkZXIgPSBoZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gJ3JlcV8nICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyAnXycgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCk7XG5cdCAgfVxuXG5cdCAgaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyfSddID0geyB2YWx1ZTogdXJpIH07XG5cdCAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxVcmlIZWFkZXJ9J10gPSB7IHZhbHVlOiB1cmkgfTtcblxuXHQgIGlmIChoZWFkZXJzLmhvc3QgJiYgaGVhZGVycy5ob3N0LnZhbHVlKSB7XG5cdCAgICBoZWFkZXJzWycke2FwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcn0nXSA9IHsgdmFsdWU6IGhlYWRlcnMuaG9zdC52YWx1ZSB9O1xuXHQgICAgaGVhZGVyc1snJHtmYWNldGhlb3J5T3JpZ2luYWxIb3N0SGVhZGVyfSddID0geyB2YWx1ZTogaGVhZGVycy5ob3N0LnZhbHVlIH07XG5cdCAgfVxuXG5cdCAgaWYgKCcke21vZGV9JyA9PT0gJyR7QXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUn0nKSB7XG5cdCAgICB2YXIgcmF3UzNQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtyYXdTM1ByZWZpeExpc3R9XG5cdCAgICBdO1xuXHQgICAgdmFyIGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMgPSBbXG5cdCAgICAgICR7bGFtYmRhUGFzc3Rocm91Z2hQcmVmaXhMaXN0fVxuXHQgICAgXTtcblx0ICAgIHZhciBpc0xhbWJkYVBhc3N0aHJvdWdoUGF0aCA9IGZhbHNlO1xuXG5cdCAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXMubGVuZ3RoOyBpKyspIHtcblx0ICAgICAgdmFyIHByZWZpeCA9IGxhbWJkYVBhc3N0aHJvdWdoUHJlZml4ZXNbaV07XG5cdCAgICAgIGlmICh1cmkgPT09IHByZWZpeCB8fCB1cmkuc3RhcnRzV2l0aChwcmVmaXggKyAnLycpKSB7XG5cdCAgICAgICAgaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGggPSB0cnVlO1xuXHQgICAgICAgIGJyZWFrO1xuXHQgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIGlmICghaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGgpIHtcblx0ICAgICAgdmFyIGlzUmF3UzNQYXRoID0gZmFsc2U7XG5cblx0ICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCByYXdTM1ByZWZpeGVzLmxlbmd0aDsgaisrKSB7XG5cdCAgICAgICAgdmFyIHJhd1ByZWZpeCA9IHJhd1MzUHJlZml4ZXNbal07XG5cdCAgICAgICAgaWYgKHVyaSA9PT0gcmF3UHJlZml4IHx8IHVyaS5zdGFydHNXaXRoKHJhd1ByZWZpeCArICcvJykpIHtcblx0ICAgICAgICAgIGlzUmF3UzNQYXRoID0gdHJ1ZTtcblx0ICAgICAgICAgIGJyZWFrO1xuXHQgICAgICAgIH1cblx0ICAgICAgfVxuXG5cdCAgICAgIHZhciBsYXN0U2xhc2ggPSB1cmkubGFzdEluZGV4T2YoJy8nKTtcblx0ICAgICAgdmFyIGxhc3RTZWdtZW50ID0gbGFzdFNsYXNoID49IDAgPyB1cmkuc3Vic3RyaW5nKGxhc3RTbGFzaCArIDEpIDogdXJpO1xuXG5cdCAgICAgIGlmICghaXNSYXdTM1BhdGggJiYgbGFzdFNlZ21lbnQuaW5kZXhPZignLicpID09PSAtMSkge1xuXHQgICAgICAgIHJlcXVlc3QudXJpID0gdXJpLmVuZHNXaXRoKCcvJykgPyB1cmkgKyAnaW5kZXguaHRtbCcgOiB1cmkgKyAnL2luZGV4Lmh0bWwnO1xuXHQgICAgICB9XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlcXVlc3Q7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlU3NyVmlld2VyUmVzcG9uc2VGdW5jdGlvbkNvZGUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgcmVzcG9uc2UgPSBldmVudC5yZXNwb25zZTtcblx0ICB2YXIgcmVxdWVzdElkSGVhZGVyID0gcmVxdWVzdC5oZWFkZXJzWyd4LXJlcXVlc3QtaWQnXTtcblx0ICB2YXIgcmVxdWVzdElkID0gcmVxdWVzdElkSGVhZGVyICYmIHJlcXVlc3RJZEhlYWRlci52YWx1ZSA/IHJlcXVlc3RJZEhlYWRlci52YWx1ZS50cmltKCkgOiAnJztcblxuXHQgIGlmICghcmVxdWVzdElkKSB7XG5cdCAgICByZXF1ZXN0SWQgPSBldmVudC5jb250ZXh0ICYmIGV2ZW50LmNvbnRleHQucmVxdWVzdElkID8gU3RyaW5nKGV2ZW50LmNvbnRleHQucmVxdWVzdElkKS50cmltKCkgOiAnJztcblx0ICB9XG5cblx0ICBpZiAocmVxdWVzdElkKSB7XG5cdCAgICByZXNwb25zZS5oZWFkZXJzID0gcmVzcG9uc2UuaGVhZGVycyB8fCB7fTtcblx0ICAgIGlmICghcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10pIHtcblx0ICAgICAgcmVzcG9uc2UuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ10gPSB7IHZhbHVlOiByZXF1ZXN0SWQgfTtcblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVzcG9uc2U7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U3NyU2l0ZVByb3BzIHtcbiAgcmVhZG9ubHkgc3NyRnVuY3Rpb246IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IGRlcGxveW1lbnQgbW9kZSBmb3IgdGhlIHNpdGUgdG9wb2xvZ3kuXG4gICAqXG4gICAqIC0gYHNzci1vbmx5YDogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpcyB0aGUgZGVmYXVsdCBvcmlnaW5cbiAgICogLSBgc3NnLWlzcmA6IFMzIGlzIHRoZSBwcmltYXJ5IEhUTUwgb3JpZ2luIGFuZCBMYW1iZGEgaXMgdGhlIGZhbGxiYWNrXG4gICAqXG4gICAqIEV4aXN0aW5nIGltcGxpY2l0IGJlaGF2aW9yIG1hcHMgdG8gYHNzci1vbmx5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NSX09OTFlcbiAgICovXG4gIHJlYWRvbmx5IG1vZGU/OiBBcHBUaGVvcnlTc3JTaXRlTW9kZTtcblxuICAvKipcbiAgICogTGFtYmRhIEZ1bmN0aW9uIFVSTCBpbnZva2UgbW9kZSBmb3IgdGhlIFNTUiBvcmlnaW4uXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTVxuICAgKi9cbiAgcmVhZG9ubHkgaW52b2tlTW9kZT86IGxhbWJkYS5JbnZva2VNb2RlO1xuXG4gIC8qKlxuICAgKiBGdW5jdGlvbiBVUkwgYXV0aCB0eXBlIGZvciB0aGUgU1NSIG9yaWdpbi5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IGZhaWxzIGNsb3NlZCB0byBgQVdTX0lBTWAgYW5kIHNpZ25zIENsb3VkRnJvbnQtdG8tTGFtYmRhXG4gICAqIHRyYWZmaWMgd2l0aCBsYW1iZGEgT3JpZ2luIEFjY2VzcyBDb250cm9sLlxuICAgKlxuICAgKiBTZXQgdGhpcyBleHBsaWNpdGx5IHRvIGBOT05FYCBvbmx5IHdoZW4geW91IGludGVudGlvbmFsbHkgcmVxdWlyZSBwdWJsaWNcbiAgICogZGlyZWN0IEZ1bmN0aW9uIFVSTCBhY2Nlc3MgYXMgYSBkZWxpYmVyYXRlIGNvbXBhdGliaWxpdHkgY2hvaWNlLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNXG4gICAqL1xuICByZWFkb25seSBzc3JVcmxBdXRoVHlwZT86IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlO1xuXG4gIHJlYWRvbmx5IGFzc2V0c0J1Y2tldD86IHMzLklCdWNrZXQ7XG4gIHJlYWRvbmx5IGFzc2V0c1BhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFzc2V0c0tleVByZWZpeD86IHN0cmluZztcbiAgcmVhZG9ubHkgYXNzZXRzTWFuaWZlc3RLZXk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCB1c2VkIGJ5IEZhY2VUaGVvcnkgSVNSIEhUTUwgc3RvcmFnZSAoYFMzSHRtbFN0b3JlYCkuXG4gICAqXG4gICAqIFdoZW4gcHJvdmlkZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIFNTUiBmdW5jdGlvbiByZWFkL3dyaXRlIGFjY2VzcyBhbmQgd2lyZXM6XG4gICAqIC0gYEZBQ0VUSEVPUllfSVNSX0JVQ0tFVGBcbiAgICogLSBgRkFDRVRIRU9SWV9JU1JfUFJFRklYYFxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbFN0b3JlQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogUzMga2V5IHByZWZpeCB1c2VkIGJ5IEZhY2VUaGVvcnkgSVNSIEhUTUwgc3RvcmFnZS5cbiAgICogQGRlZmF1bHQgaXNyXG4gICAqL1xuICByZWFkb25seSBodG1sU3RvcmVLZXlQcmVmaXg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgZXh0ZW5zaW9ubGVzcyBIVE1MIHNlY3Rpb24gcGF0aCBwYXR0ZXJucyB0byByb3V0ZSBkaXJlY3RseSB0byB0aGUgcHJpbWFyeSBIVE1MIFMzIG9yaWdpbi5cbiAgICpcbiAgICogUmVxdWVzdHMgbGlrZSBgL21hcmtldGluZ2AgYW5kIGAvbWFya2V0aW5nLy4uLmAgYXJlIHJld3JpdHRlbiB0byBgL2luZGV4Lmh0bWxgXG4gICAqIHdpdGhpbiB0aGUgc2VjdGlvbiBhbmQgc3RheSBvbiBTMyBpbnN0ZWFkIG9mIGZhbGxpbmcgYmFjayB0byBMYW1iZGEuXG4gICAqXG4gICAqIEV4YW1wbGUgZGlyZWN0LVMzIEhUTUwgc2VjdGlvbiBwYXRoOiBcIi9tYXJrZXRpbmcvKlwiXG4gICAqL1xuICByZWFkb25seSBzdGF0aWNQYXRoUGF0dGVybnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCByYXcgUzMgb2JqZWN0L2RhdGEgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgZXh0ZW5zaW9ubGVzcyBIVE1MIHJld3JpdGVzLlxuICAgKlxuICAgKiBJbiBgc3NnLWlzcmAgbW9kZSwgYC9fZmFjZXRoZW9yeS9kYXRhLypgIGlzIGFkZGVkIGF1dG9tYXRpY2FsbHkuXG4gICAqIEV4YW1wbGUgZGlyZWN0LVMzIG9iamVjdCBwYXRoOiBcIi9mZWVkcy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IGRpcmVjdFMzUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgdGhlIGBzc2ctaXNyYCBvcmlnaW4gZ3JvdXAgYW5kIHJvdXRlIGRpcmVjdGx5XG4gICAqIHRvIHRoZSBMYW1iZGEgRnVuY3Rpb24gVVJMIHdpdGggZnVsbCBtZXRob2Qgc3VwcG9ydC5cbiAgICpcbiAgICogSW4gYHNzZy1pc3JgIG1vZGUsIGAvX2ZhY2V0aGVvcnkvc3NyLWRhdGEvKmAgaXMgYWRkZWQgYXV0b21hdGljYWxseSBmb3IgRmFjZVRoZW9yeVxuICAgKiBzdHJpY3Qgbm8taW5saW5lLUNTUCBTU1IgaHlkcmF0aW9uIHNpZGVjYXJzLlxuICAgKlxuICAgKiBVc2UgdGhpcyBmb3Igc2FtZS1vcmlnaW4gZHluYW1pYyBwYXRocyBzdWNoIGFzIGF1dGggY2FsbGJhY2tzLCBhY3Rpb25zLCBvciBmb3JtIHBvc3RzLlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TU1IgcGF0aDogXCIvYWN0aW9ucy8qXCJcbiAgICovXG4gIHJlYWRvbmx5IHNzclBhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGJlYXJlci1hdXRoIExhbWJkYSBGdW5jdGlvbiBVUkwgY28tb3JpZ2lucyB0byBhdHRhY2ggdG8gdGhlIHNhbWUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIGVhY2ggY28tb3JpZ2luIEZ1bmN0aW9uIFVSTCB3aXRoIGBBdXRoVHlwZS5OT05FYCBhbmQgcm91dGVzIHRoZSBzdXBwbGllZFxuICAgKiBwYXRoIHBhdHRlcm5zIHRvIGl0IHdpdGhvdXQgTGFtYmRhIE9yaWdpbiBBY2Nlc3MgQ29udHJvbC4gVGhlIFNTUiBvcmlnaW4gcmVtYWlucyBnb3Zlcm5lZCBieVxuICAgKiBgc3NyVXJsQXV0aFR5cGVgIGFuZCBzdGlsbCBkZWZhdWx0cyB0byBgQVdTX0lBTWAgcGx1cyBMYW1iZGEgT0FDLlxuICAgKlxuICAgKiBDby1vcmlnaW4gcGF0aHMgcGFydGljaXBhdGUgaW4gQXBwVGhlb3J5J3MgYmVoYXZpb3IgcGF0aCBjb2xsaXNpb24gY2hlY2tzIGFuZCBieXBhc3MgYHNzZy1pc3JgXG4gICAqIEhUTUwgcmV3cml0ZXMuIFRoaXMgaXMgdGhlIHN1cHBvcnRlZCBBcHBUaGVvcnkgcGF0aCBmb3IgbWl4ZWQtYXV0aCBkaXN0cmlidXRpb25zOyBkbyBub3QgaGFuZC13aXJlXG4gICAqIHJhdyBgZGlzdHJpYnV0aW9uLmFkZEJlaGF2aW9yKC4uLilgIGNhbGxzIHdoZW4gQXBwVGhlb3J5IHNob3VsZCBvd24gcGF0aCBhbmQgZWRnZS1jb250ZXh0IHBvbGljeS5cbiAgICpcbiAgICogRXhhbXBsZSBiZWFyZXIgQVBJIHBhdGhzOiBgW1wiL2FwaS8qXCIsIFwiL2F1dGgvKlwiXWAuXG4gICAqL1xuICByZWFkb25seSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnM/OiBBcHBUaGVvcnlTc3JTaXRlQmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5bXTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgVGFibGVUaGVvcnkvRHluYW1vREIgdGFibGUgdXNlZCBmb3IgRmFjZVRoZW9yeSBJU1IgbWV0YWRhdGEgYW5kIGxlYXNlIGNvb3JkaW5hdGlvbi5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgU1NSIGZ1bmN0aW9uIHJlYWQvd3JpdGUgYWNjZXNzIGFuZCB3aXJlcyB0aGVcbiAgICogbWV0YWRhdGEgdGFibGUgYWxpYXNlcyBleHBlY3RlZCBieSB0aGUgZG9jdW1lbnRlZCBGYWNlVGhlb3J5IGRlcGxveW1lbnQgc2hhcGUuXG4gICAqL1xuICByZWFkb25seSBpc3JNZXRhZGF0YVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBJU1IvY2FjaGUgbWV0YWRhdGEgdGFibGUgbmFtZSB0byB3aXJlIHdoZW4geW91IGFyZSBub3QgcGFzc2luZyBgaXNyTWV0YWRhdGFUYWJsZWAuXG4gICAqXG4gICAqIFByZWZlciBgaXNyTWV0YWRhdGFUYWJsZWAgd2hlbiBBcHBUaGVvcnkgc2hvdWxkIGFsc28gZ3JhbnQgYWNjZXNzIHRvIHRoZSBTU1IgTGFtYmRhLlxuICAgKi9cbiAgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExlZ2FjeSBhbGlhcyBmb3IgYGlzck1ldGFkYXRhVGFibGVOYW1lYC5cbiAgICogQGRlcHJlY2F0ZWQgcHJlZmVyIGBpc3JNZXRhZGF0YVRhYmxlYCBvciBgaXNyTWV0YWRhdGFUYWJsZU5hbWVgXG4gICAqL1xuICByZWFkb25seSBjYWNoZVRhYmxlTmFtZT86IHN0cmluZztcblxuICAvLyBXaGVuIHRydWUgKGRlZmF1bHQpLCBBcHBUaGVvcnkgd2lyZXMgcmVjb21tZW5kZWQgcnVudGltZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgb250byB0aGUgU1NSIGZ1bmN0aW9uLlxuICByZWFkb25seSB3aXJlUnVudGltZUVudj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgaGVhZGVycyB0byBmb3J3YXJkIHRvIHRoZSBTU1Igb3JpZ2luIChMYW1iZGEgRnVuY3Rpb24gVVJMKSB2aWEgdGhlIG9yaWdpbiByZXF1ZXN0IHBvbGljeS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5L0ZhY2VUaGVvcnktc2FmZSBlZGdlIGNvbnRyYWN0IGZvcndhcmRzIG9ubHk6XG4gICAqIC0gYGNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvYFxuICAgKiAtIGBjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzYFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWFwcHRoZW9yeS1vcmlnaW5hbC11cmlgXG4gICAqIC0gYHgtZmFjZXRoZW9yeS1vcmlnaW5hbC1ob3N0YFxuICAgKiAtIGB4LWZhY2V0aGVvcnktb3JpZ2luYWwtdXJpYFxuICAgKiAtIGB4LXJlcXVlc3QtaWRgXG4gICAqXG4gICAqIFVzZSB0aGlzIHRvIG9wdCBpbiB0byBhZGRpdGlvbmFsIGFwcC1zcGVjaWZpYyBoZWFkZXJzIHN1Y2ggYXNcbiAgICogYHgtZmFjZXRoZW9yeS1zZWdtZW50YC4gVGVuYW50LWxpa2Ugdmlld2VyIGhlYWRlcnMgYXJlIHJlamVjdGVkIHVubGVzc1xuICAgKiBgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzYCBpcyBleHBsaWNpdGx5IGVuYWJsZWQgYXMgYSBjb21wYXRpYmlsaXR5IG1vZGUuXG4gICAqIGBob3N0YCBhbmQgYHgtZm9yd2FyZGVkLXByb3RvYCBhcmUgcmVqZWN0ZWQgYmVjYXVzZSB0aGV5IGJyZWFrIG9yIGJ5cGFzcyB0aGVcbiAgICogc3VwcG9ydGVkIG9yaWdpbiBtb2RlbC5cbiAgICovXG4gIHJlYWRvbmx5IHNzckZvcndhcmRIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIENvbXBhdGliaWxpdHkgZXNjYXBlIGhhdGNoIGZvciBsZWdhY3kgdmlld2VyLXN1cHBsaWVkIHRlbmFudCBoZWFkZXJzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlIChkZWZhdWx0KSwgQXBwVGhlb3J5IHN0cmlwcyBgeC10ZW5hbnQtaWRgIGF0IHRoZSBlZGdlIGFuZCByZWplY3RzXG4gICAqIHRlbmFudC1saWtlIGVudHJpZXMgaW4gYHNzckZvcndhcmRIZWFkZXJzYCBzbyB2aWV3ZXItc3VwcGxpZWQgdGVuYW50IGhlYWRlcnNcbiAgICogY2Fubm90IGluZmx1ZW5jZSBvcmlnaW4gcm91dGluZyBvciBIVE1MIGNhY2hlIHBhcnRpdGlvbmluZy4gV2hlbiB0cnVlLFxuICAgKiBBcHBUaGVvcnkgcmVzdG9yZXMgbGVnYWN5IHBhc3N0aHJvdWdoIGJlaGF2aW9yIGZvciBgeC10ZW5hbnQtaWRgIGFuZCBhbnlcbiAgICogdGVuYW50LWxpa2UgYHNzckZvcndhcmRIZWFkZXJzYC5cbiAgICpcbiAgICogUHJlZmVyIGRlcml2aW5nIHRlbmFudCBmcm9tIHRydXN0ZWQgaG9zdCBtYXBwaW5nIHVzaW5nIHRoZSBvcmlnaW5hbC1ob3N0XG4gICAqIGVkZ2UgaGVhZGVycyBpbnN0ZWFkIG9mIGVuYWJsaW5nIHBhc3N0aHJvdWdoLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSB0aGUgYnVja2V0cyB0aGlzIGNvbnN0cnVjdCBjcmVhdGVzIHRha2VcbiAgICogdGhlaXIgbmFtZXMgZnJvbSB0aGUgY29udHJhY3QgYW5kIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG9cbiAgICogYGxvZ3MvYWNjZXNzL2Nkbi97bG9naWNhbE5hbWV9YCB0aHJvdWdoIENsb3VkV2F0Y2ggTG9ncyB2ZW5kZWQgZGVsaXZlcnkuXG4gICAqIFBhc3MgYGVuYWJsZUxvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0IG9mIHRoZSBkZWxpdmVyeS5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBzaXRlJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW4gYVxuICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDbG91ZEZyb250IHN0YW5kYXJkLWxvZ2dpbmcgb3V0cHV0IGZvcm1hdCBmb3IgYSBDbG91ZFdhdGNoIExvZ3NcbiAgICogZGVzdGluYXRpb24uIE9ubHkgdXNlZCB1bmRlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LkpTT05cbiAgICovXG4gIHJlYWRvbmx5IGNsb3VkRnJvbnRMb2dGb3JtYXQ/OiBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0O1xuXG4gIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAvKipcbiAgICogQ2xvdWRGcm9udCByZXNwb25zZSBoZWFkZXJzIHBvbGljeSBhcHBsaWVkIHRvIFNTUiBhbmQgZGlyZWN0LVMzIGJlaGF2aW9ycy5cbiAgICpcbiAgICogSWYgb21pdHRlZCwgQXBwVGhlb3J5IHByb3Zpc2lvbnMgYSBGYWNlVGhlb3J5LWFsaWduZWQgYmFzZWxpbmUgcG9saWN5IGF0IHRoZSBDRE5cbiAgICogbGF5ZXI6IEhTVFMsIG5vc25pZmYsIGZyYW1lLW9wdGlvbnMsIHJlZmVycmVyLXBvbGljeSwgWFNTIHByb3RlY3Rpb24sIGFuZCBhXG4gICAqIHJlc3RyaWN0aXZlIHBlcm1pc3Npb25zLXBvbGljeS4gQ29udGVudC1TZWN1cml0eS1Qb2xpY3kgcmVtYWlucyBvcmlnaW4tZGVmaW5lZC5cbiAgICovXG4gIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAvKipcbiAgICogQ2FjaGUgcG9saWN5IGFwcGxpZWQgdG8gZGlyZWN0IExhbWJkYS1iYWNrZWQgU1NSIGJlaGF2aW9ycy5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgaXMgYENBQ0hJTkdfRElTQUJMRURgIHNvIGR5bmFtaWMgTGFtYmRhIHJvdXRlcyBzdGF5IHNhZmUgdW5sZXNzIHlvdVxuICAgKiBpbnRlbnRpb25hbGx5IG9wdCBpbnRvIGEgY2FjaGUgcG9saWN5IHRoYXQgbWF0Y2hlcyB5b3VyIGFwcCdzIHZhcmlhbmNlIG1vZGVsLlxuICAgKiBAZGVmYXVsdCBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRURcbiAgICovXG4gIHJlYWRvbmx5IHNzckNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgLyoqXG4gICAqIENhY2hlIHBvbGljeSBhcHBsaWVkIHRvIHRoZSBjYWNoZWFibGUgSFRNTCBiZWhhdmlvciBpbiBgc3NnLWlzcmAgbW9kZS5cbiAgICpcbiAgICogVGhlIGRlZmF1bHQgQXBwVGhlb3J5IHBvbGljeSBrZXlzIG9uIHF1ZXJ5IHN0cmluZ3MgcGx1cyB0aGUgc3RhYmxlIHB1YmxpYyBIVE1MXG4gICAqIHZhcmlhbnQgaGVhZGVycyAoYHgtKi1vcmlnaW5hbC1ob3N0YCBhbmQgYW55IG5vbi10ZW5hbnQgZXh0cmEgZm9yd2FyZGVkXG4gICAqIGhlYWRlcnMgeW91IG9wdCBpbnRvKSB3aGlsZSBsZWF2aW5nIGNvb2tpZXMgb3V0IG9mIHRoZSBjYWNoZSBrZXkuIFRlbmFudC1saWtlXG4gICAqIHZpZXdlciBoZWFkZXJzIGpvaW4gdGhlIGNhY2hlIGtleSBvbmx5IHdoZW4gYGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc2AgaXNcbiAgICogZXhwbGljaXRseSBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbENhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICByZWFkb25seSBkb21haW5OYW1lPzogc3RyaW5nO1xuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZHMgYW5kIG9wdGlvbmFsIGNlcnRpZmljYXRlIHZhbGlkYXRpb24uXG4gICAqXG4gICAqIFdoZW4gYGRvbWFpbk5hbWVgIGlzIHNldCB3aXRob3V0IGBjZXJ0aWZpY2F0ZUFybmAsIGhvc3RlZC16b25lIGNlcnRpZmljYXRlXG4gICAqIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvbiBpcyBleHBsaWNpdGx5IGB1cy1lYXN0LTFgLlxuICAgKiBDbG91ZEZyb250IHJlcXVpcmVzIHZpZXdlciBjZXJ0aWZpY2F0ZXMgaW4gYHVzLWVhc3QtMWA7IGVudmlyb25tZW50LWFnbm9zdGljXG4gICAqIG9yIG90aGVyLXJlZ2lvbiBzdGFja3MgbXVzdCBwcm92aWRlIGBjZXJ0aWZpY2F0ZUFybmAuXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcbiAgLyoqXG4gICAqIEV4aXN0aW5nIEFDTSBjZXJ0aWZpY2F0ZSBBUk4gZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogVGhlIGNlcnRpZmljYXRlIG11c3QgYmUgaW4gYHVzLWVhc3QtMWAgZm9yIENsb3VkRnJvbnQuXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogTWluaW11bSBUTFMgcHJvdG9jb2wgdmVyc2lvbiBmb3Igdmlld2VycyBvZiBhIGN1c3RvbSBkb21haW4uXG4gICAqXG4gICAqIFdpdGggYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0IGFuZCBhIGN1c3RvbSBjZXJ0aWZpY2F0ZSB0aGUgZGVmYXVsdCBpc1xuICAgKiBgVExTX1YxXzJfMjAyNWAsIHRoZSBwb2xpY3kgU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUgYWNjZXB0cyB3aXRoIHRoZVxuICAgKiB3aWRlc3QgY2xpZW50IHN1cHBvcnQuIFdpdGhvdXQgYSBjZXJ0aWZpY2F0ZSBDbG91ZEZyb250IHNlcnZlcyB0aGUgZml4ZWRcbiAgICogZGVmYXVsdCBjZXJ0aWZpY2F0ZSBhbmQgdGhpcyBwcm9wZXJ0eSBoYXMgbm8gZWZmZWN0LlxuICAgKlxuICAgKiBAZGVmYXVsdCBUTFNfVjFfMl8yMDI1IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB3aXRoIGEgY2VydGlmaWNhdGUsXG4gICAqIG90aGVyd2lzZSB0aGUgQ2xvdWRGcm9udCBkZWZhdWx0IGZvciB0aGUgY2VydGlmaWNhdGVcbiAgICovXG4gIHJlYWRvbmx5IG1pbmltdW1Qcm90b2NvbFZlcnNpb24/OiBjbG91ZGZyb250LlNlY3VyaXR5UG9saWN5UHJvdG9jb2w7XG5cbiAgLyoqXG4gICAqIE9iamVjdCBDbG91ZEZyb250IHJldHVybnMgZm9yIGEgcmVxdWVzdCB0byB0aGUgZGlzdHJpYnV0aW9uIHJvb3QuXG4gICAqXG4gICAqIFdpdGggYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0IGFuZCBgbW9kZTogc3NnLWlzcmAgdGhlIGRlZmF1bHQgaXNcbiAgICogYGluZGV4Lmh0bWxgLCBiZWNhdXNlIHRoYXQgbW9kZSdzIGRlZmF1bHQgYmVoYXZpb3IgaXMgdGhlIFMzIEhUTUwgc3RvcmVcbiAgICogKFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjEpLiBgc3NyLW9ubHlgIGFsc28gY2FycmllcyBhbiBTMyBvcmlnaW4gKHRoZVxuICAgKiBhc3NldCBidWNrZXQpLCBzbyB0aGUgY29udHJvbCBldmFsdWF0ZXMgdGhlIGRpc3RyaWJ1dGlvbiwgYnV0IGAvYCBtdXN0XG4gICAqIHJlYWNoIHRoZSBmdW5jdGlvbiBVUkw7IGEgZGVmYXVsdCByb290IG9iamVjdCB3b3VsZCByZXdyaXRlIGAvYCBvbnRvIHRoZVxuICAgKiBmdW5jdGlvbiBVUkwsIHNvIEFwcFRoZW9yeSBkZWxpYmVyYXRlbHkgc2V0cyBub25lIGFuZCB0aGUgY29udHJvbCByZXBvcnRzXG4gICAqIGEgcmVzaWR1YWwgZmluZGluZy5cbiAgICpcbiAgICogQGRlZmF1bHQgXCJpbmRleC5odG1sXCIgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0IGluIGBzc2ctaXNyYCBtb2RlXG4gICAqL1xuICByZWFkb25seSBkZWZhdWx0Um9vdE9iamVjdD86IHN0cmluZztcblxuICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcblxuICAvKipcbiAgICogQnVja2V0IHRoYXQgcmVjZWl2ZXMgUzMgc2VydmVyIGFjY2VzcyBsb2dzIGZvciB0aGUgYnVja2V0cyB0aGlzIGNvbnN0cnVjdFxuICAgKiBjcmVhdGVzLCB3aGljaCBpcyB3aGF0IFNlY3VyaXR5IEh1YiBTMy45IGV2YWx1YXRlcy5cbiAgICpcbiAgICogT2ZmIGJ5IGRlZmF1bHQgYmVjYXVzZSB0aGUgbG9nIHRhcmdldCBhbmQgaXRzIHN0b3JhZ2UgY29zdCBtb25leS4gVGhlIHRhcmdldFxuICAgKiBidWNrZXQgaXMgeW91cnM6IGl0IHRha2VzIG5vIG5hbWluZyBlbnRyeSAocmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0XG4gICAqIHNlY3Rpb24gNCksIGFuZCBpdCBzaG91bGQgbm90IGl0c2VsZiBiZSBsb2dnZWQuXG4gICAqXG4gICAqIEBkZWZhdWx0IG5vIHNlcnZlciBhY2Nlc3MgbG9nZ2luZ1xuICAgKi9cbiAgcmVhZG9ubHkgc2VydmVyQWNjZXNzTG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgLyoqXG4gICAqIEtleSBwcmVmaXggZm9yIHRoZSBzZXJ2ZXIgYWNjZXNzIGxvZ3MuIE9ubHkgdXNlZCB3aXRoXG4gICAqIGBzZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0YC5cbiAgICpcbiAgICogQGRlZmF1bHQgbm8gcHJlZml4XG4gICAqL1xuICByZWFkb25seSBzZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVNzclNpdGVCZWFyZXJGdW5jdGlvblVybE9yaWdpbiB7XG4gIC8qKlxuICAgKiBMYW1iZGEgZnVuY3Rpb24gdGhhdCBBcHBUaGVvcnkgZXhwb3NlcyBhcyBhIGJlYXJlci1hdXRoIEZ1bmN0aW9uIFVSTCBjby1vcmlnaW4uXG4gICAqXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIHRoZSBGdW5jdGlvbiBVUkwgd2l0aCBgbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuTk9ORWA7IGF1dGhlbnRpY2F0aW9uIHJlbWFpbnNcbiAgICogdGhlIHJlc3BvbnNpYmlsaXR5IG9mIHRoZSBMYW1iZGEgaGFuZGxlci5cbiAgICovXG4gIHJlYWRvbmx5IGZ1bmN0aW9uOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBDbG91ZEZyb250IHBhdGggcGF0dGVybnMgdGhhdCByb3V0ZSB0byB0aGlzIGNvLW9yaWdpbi5cbiAgICpcbiAgICogUGF0dGVybnMgYXJlIG5vcm1hbGl6ZWQgdGhlIHNhbWUgd2F5IGFzIGBzc3JQYXRoUGF0dGVybnNgLiBBIHBhdHRlcm4gZW5kaW5nIGluIGAvKmAgYWxzbyBjcmVhdGVzXG4gICAqIGEgcm9vdCBiZWhhdmlvciB3aXRob3V0IHRoZSB3aWxkY2FyZCBzbyBgL2FwaS8qYCBjb3ZlcnMgYm90aCBgL2FwaWAgYW5kIGAvYXBpLy4uLmAuXG4gICAqL1xuICByZWFkb25seSBwYXRoUGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGludm9rZSBtb2RlIGZvciB0aGlzIGNvLW9yaWdpbi5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkludm9rZU1vZGUuQlVGRkVSRURcbiAgICovXG4gIHJlYWRvbmx5IGludm9rZU1vZGU/OiBsYW1iZGEuSW52b2tlTW9kZTtcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVNzclNpdGUgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzQnVja2V0OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleTogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaHRtbFN0b3JlQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IHNzclVybDogbGFtYmRhLkZ1bmN0aW9uVXJsO1xuICBwdWJsaWMgcmVhZG9ubHkgYmVhcmVyRnVuY3Rpb25VcmxzOiBsYW1iZGEuRnVuY3Rpb25VcmxbXTtcbiAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG4gIHB1YmxpYyByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG4gIHB1YmxpYyByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k6IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5U3NyU2l0ZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmICghcHJvcHM/LnNzckZ1bmN0aW9uKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIHByb3BzLnNzckZ1bmN0aW9uXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IHNpdGVNb2RlID0gcHJvcHMubW9kZSA/PyBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU1JfT05MWTtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCBhdXRvRGVsZXRlT2JqZWN0cyA9IHByb3BzLmF1dG9EZWxldGVPYmplY3RzID8/IGZhbHNlO1xuICAgIGNvbnN0IHdpcmVSdW50aW1lRW52ID0gcHJvcHMud2lyZVJ1bnRpbWVFbnYgPz8gdHJ1ZTtcbiAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgIGNvbnN0IGVuYWJsZUxvZ2dpbmcgPSBwcm9wcy5lbmFibGVMb2dnaW5nID8/IHRydWU7XG4gICAgY29uc3QgaXNyTWV0YWRhdGFMb2dpY2FsID0gbG9naWNhbCA/IGAke2xvZ2ljYWx9LWlzci1tZXRhZGF0YWAgOiB1bmRlZmluZWQ7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKFxuICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZVwiLFxuICAgICAgXCJpc3JNZXRhZGF0YVRhYmxlTmFtZVwiLFxuICAgICAgXCJkeW5hbW9kYl90YWJsZVwiLFxuICAgICAgaXNyTWV0YWRhdGFMb2dpY2FsLFxuICAgICAgcHJvcHMuaXNyTWV0YWRhdGFUYWJsZU5hbWUgIT09IHVuZGVmaW5lZCxcbiAgICApO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShcbiAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICBcIkFwcFRoZW9yeVNzclNpdGVcIixcbiAgICAgIFwiY2FjaGVUYWJsZU5hbWVcIixcbiAgICAgIFwiZHluYW1vZGJfdGFibGVcIixcbiAgICAgIGlzck1ldGFkYXRhTG9naWNhbCxcbiAgICAgIHByb3BzLmNhY2hlVGFibGVOYW1lICE9PSB1bmRlZmluZWQsXG4gICAgKTtcbiAgICBpZiAobmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIHByb3BzLmxvZ3NCdWNrZXQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVNzclNpdGUgY2Fubm90IGhvbm9yIHByb3BzLmxvZ3NCdWNrZXQgdW5kZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZTsgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBnbyB0byB0aGUgY29udHJhY3QgbG9nIGdyb3VwLCBzbyByZW1vdmUgcHJvcHMubG9nc0J1Y2tldCBvciB1c2UgdGhlIGxlZ2FjeSBsb2dnaW5nIHByb2ZpbGVcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHN0YW5kYXJkTG9nZ2luZyA9IG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBlbmFibGVMb2dnaW5nO1xuXG4gICAgLy8gU2VjdXJpdHkgSHViIFMzLjkgc3RheXMgb3B0LWluOiB0aGUgY2FsbGVyIHN1cHBsaWVzIHRoZSBsb2cgdGFyZ2V0LCBhbmQgaXRcbiAgICAvLyB0YWtlcyBubyBuYW1pbmcgZW50cnkgKHJlc291cmNlLW5hbWluZyBjb250cmFjdCBzZWN0aW9uIDQpLlxuICAgIGNvbnN0IHNlcnZlckFjY2Vzc0xvZ3MgPSBwcm9wcy5zZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0ICE9PSB1bmRlZmluZWRcbiAgICAgID8ge1xuICAgICAgICBzZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0OiBwcm9wcy5zZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0LFxuICAgICAgICAuLi4ocHJvcHMuc2VydmVyQWNjZXNzTG9nc1ByZWZpeCAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgPyB7IHNlcnZlckFjY2Vzc0xvZ3NQcmVmaXg6IHByb3BzLnNlcnZlckFjY2Vzc0xvZ3NQcmVmaXggfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfVxuICAgICAgOiB7fTtcblxuICAgIHRoaXMuYXNzZXRzQnVja2V0ID1cbiAgICAgIHByb3BzLmFzc2V0c0J1Y2tldCA/P1xuICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkFzc2V0c0J1Y2tldFwiLCB7XG4gICAgICAgIC4uLihuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgPyBidWNrZXROYW1pbmdQcm9wcyhuYW1pbmdDb250ZXh0LCBgJHtsb2dpY2FsfS1hc3NldHNgKSA6IHt9KSxcbiAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAuLi5zZXJ2ZXJBY2Nlc3NMb2dzLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgIH0pO1xuICAgIGlmIChuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgJiYgcHJvcHMuYXNzZXRzQnVja2V0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIC8vIENvbnRyYWN0IHNlY3Rpb24gMTEuNDogZGVjbGFyZSB0aGUgcmVzb3VyY2UgY2FycnlpbmcgdGhlIGNvbXBvc2VkIG5hbWUuXG4gICAgICBuYW1pbmdDb250ZXh0LmRlY2xhcmVOYW1lKFwiczNfYnVja2V0XCIsIGAke2xvZ2ljYWx9LWFzc2V0c2AsIHRoaXMuYXNzZXRzQnVja2V0KTtcbiAgICB9XG5cbiAgICBpZiAoZW5hYmxlTG9nZ2luZyAmJiAhc3RhbmRhcmRMb2dnaW5nKSB7XG4gICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGFzc2V0c1ByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKHByb3BzLmFzc2V0c0tleVByZWZpeCA/PyBcImFzc2V0c1wiKS50cmltKCksIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNLZXlQcmVmaXggPSBhc3NldHNQcmVmaXhSYXcgfHwgXCJhc3NldHNcIjtcblxuICAgIGNvbnN0IG1hbmlmZXN0UmF3ID0gU3RyaW5nKHByb3BzLmFzc2V0c01hbmlmZXN0S2V5ID8/IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmApLnRyaW0oKTtcbiAgICBjb25zdCBtYW5pZmVzdEtleSA9IHRyaW1SZXBlYXRlZENoYXIobWFuaWZlc3RSYXcsIFwiL1wiKTtcbiAgICBjb25zdCBhc3NldHNNYW5pZmVzdEtleSA9IG1hbmlmZXN0S2V5IHx8IGAke2Fzc2V0c0tleVByZWZpeH0vbWFuaWZlc3QuanNvbmA7XG5cbiAgICB0aGlzLmFzc2V0c0tleVByZWZpeCA9IGFzc2V0c0tleVByZWZpeDtcbiAgICB0aGlzLmFzc2V0c01hbmlmZXN0S2V5ID0gYXNzZXRzTWFuaWZlc3RLZXk7XG5cbiAgICBjb25zdCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dCA9IFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHNob3VsZENvbmZpZ3VyZUh0bWxTdG9yZSA9IEJvb2xlYW4ocHJvcHMuaHRtbFN0b3JlQnVja2V0KSB8fCBodG1sU3RvcmVLZXlQcmVmaXhJbnB1dC5sZW5ndGggPiAwO1xuICAgIGlmIChzaG91bGRDb25maWd1cmVIdG1sU3RvcmUpIHtcbiAgICAgIGNvbnN0IGh0bWxTdG9yZVByZWZpeFJhdyA9IHRyaW1SZXBlYXRlZENoYXIoXG4gICAgICAgIFN0cmluZyhwcm9wcy5odG1sU3RvcmVLZXlQcmVmaXggPz8gZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeCkudHJpbSgpLFxuICAgICAgICBcIi9cIixcbiAgICAgICk7XG4gICAgICB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCA9IGh0bWxTdG9yZVByZWZpeFJhdyB8fCBkZWZhdWx0SXNySHRtbFN0b3JlS2V5UHJlZml4O1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQgPVxuICAgICAgICBwcm9wcy5odG1sU3RvcmVCdWNrZXQgPz9cbiAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkh0bWxTdG9yZUJ1Y2tldFwiLCB7XG4gICAgICAgICAgLi4uKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCA/IGJ1Y2tldE5hbWluZ1Byb3BzKG5hbWluZ0NvbnRleHQsIGAke2xvZ2ljYWx9LWh0bWwtc3RvcmVgKSA6IHt9KSxcbiAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgIC4uLnNlcnZlckFjY2Vzc0xvZ3MsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgfSk7XG4gICAgICBpZiAobmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsICYmIHByb3BzLmh0bWxTdG9yZUJ1Y2tldCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIG5hbWluZ0NvbnRleHQuZGVjbGFyZU5hbWUoXCJzM19idWNrZXRcIiwgYCR7bG9naWNhbH0taHRtbC1zdG9yZWAsIHRoaXMuaHRtbFN0b3JlQnVja2V0KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmlzck1ldGFkYXRhVGFibGUgPSBwcm9wcy5pc3JNZXRhZGF0YVRhYmxlO1xuXG4gICAgY29uc3QgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSA9IFN0cmluZyhwcm9wcy5pc3JNZXRhZGF0YVRhYmxlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgbGVnYWN5Q2FjaGVUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuY2FjaGVUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHJlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcodGhpcy5pc3JNZXRhZGF0YVRhYmxlPy50YWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgY29uc3QgY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbcmVzb3VyY2VJc3JNZXRhZGF0YVRhYmxlTmFtZSwgZXhwbGljaXRJc3JNZXRhZGF0YVRhYmxlTmFtZSwgbGVnYWN5Q2FjaGVUYWJsZU5hbWVdLmZpbHRlcihcbiAgICAgICAgICAobmFtZSkgPT4gU3RyaW5nKG5hbWUpLnRyaW0oKS5sZW5ndGggPiAwLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICApO1xuXG4gICAgaWYgKGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMubGVuZ3RoID4gMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZWNlaXZlZCBjb25mbGljdGluZyBJU1IgbWV0YWRhdGEgdGFibGUgbmFtZXM6ICR7Y29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lcy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgbGV0IGlzck1ldGFkYXRhVGFibGVOYW1lID0gY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lc1swXSA/PyBcIlwiO1xuXG4gICAgLy8gVW5kZXIgYSBuYW1pbmcgY29udGV4dCB0aGUgSVNSL2NhY2hlIG1ldGFkYXRhIHRhYmxlIGlzIG5hbWVkIHRocm91Z2ggdGhlXG4gICAgLy8gY29udHJhY3Qgb25seSB3aGVuIHRoZSBjb25zdHJ1Y3Qgd2lyZXMgYSBuYW1lIHRoZSBjYWxsZXIgZGlkIG5vdCBzdXBwbHkuXG4gICAgLy8gYHNzZy1pc3JgIG5lZWRzIGEgdGFibGUsIHNvIGl0IGNvbnN1bWVzIHRoZSBge2xvZ2ljYWx9LWlzci1tZXRhZGF0YWBcbiAgICAvLyBlbnRyeS4gQW4gZXh0ZXJuYWwgdGFibGUgcGFzc2VkIHRocm91Z2ggYGlzck1ldGFkYXRhVGFibGVgIGlzIHRoZVxuICAgIC8vIGNhbGxlcidzIHJlc291cmNlOiBpdCBjb25zdW1lcyBubyBlbnRyeSwgc28gYW4gZW50cnkgbmFtaW5nIGl0IGlzIGFuXG4gICAgLy8gb3JwaGFuIChyMywgQURWLTEzMTItMjsgTTIgcmVzaWR1YWwpLlxuICAgIGlmIChcbiAgICAgIG5hbWluZ0NvbnRleHQgJiZcbiAgICAgIGxvZ2ljYWwgJiZcbiAgICAgIHByb3BzLmlzck1ldGFkYXRhVGFibGUgPT09IHVuZGVmaW5lZCAmJlxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICApIHtcbiAgICAgIGNvbnN0IGNvbXBvc2VkID0gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJkeW5hbW9kYl90YWJsZVwiLCBgJHtsb2dpY2FsfS1pc3ItbWV0YWRhdGFgKTtcbiAgICAgIGlmIChpc3JNZXRhZGF0YVRhYmxlTmFtZSA9PT0gXCJcIiAmJiAhY29tcG9zZWQuZ2VuZXJhdGVkICYmIGNvbXBvc2VkLm5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpc3JNZXRhZGF0YVRhYmxlTmFtZSA9IGNvbXBvc2VkLm5hbWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmFzc2V0c1BhdGgpIHtcbiAgICAgIG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsIFwiQXNzZXRzRGVwbG95bWVudFwiLCB7XG4gICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQocHJvcHMuYXNzZXRzUGF0aCldLFxuICAgICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5hc3NldHNCdWNrZXQsXG4gICAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiBhc3NldHNLZXlQcmVmaXgsXG4gICAgICAgIHBydW5lOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhdGljUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKHByb3BzLnN0YXRpY1BhdGhQYXR0ZXJucyk7XG4gICAgY29uc3QgZGlyZWN0UzNQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMoW1xuICAgICAgLi4uKHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gW3NzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zKSA/IHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IHNzclBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhbXG4gICAgICAuLi4oc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBbc3NnSXNyU3NyRGF0YVBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLnNzclBhdGhQYXR0ZXJucykgPyBwcm9wcy5zc3JQYXRoUGF0dGVybnMgOiBbXSksXG4gICAgXSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5zID0gQXJyYXkuaXNBcnJheShwcm9wcy5iZWFyZXJGdW5jdGlvblVybE9yaWdpbnMpXG4gICAgICA/IHByb3BzLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1xuICAgICAgOiBbXTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MgPSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMubWFwKChvcmlnaW4sIGluZGV4KSA9PiB7XG4gICAgICBpZiAoIW9yaWdpbj8uZnVuY3Rpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTc3JTaXRlIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luc1ske2luZGV4fV0gcmVxdWlyZXMgZnVuY3Rpb25gKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhvcmlnaW4ucGF0aFBhdHRlcm5zKTtcbiAgICAgIGlmIChwYXRoUGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5U3NyU2l0ZSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnNbJHtpbmRleH1dIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBwYXRoIHBhdHRlcm5gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IG9yaWdpbiwgcGF0aFBhdHRlcm5zIH07XG4gICAgfSk7XG4gICAgY29uc3QgYmVhcmVyRnVuY3Rpb25VcmxQYXRoUGF0dGVybnMgPSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZmxhdE1hcCgoY29uZmlnKSA9PiBjb25maWcucGF0aFBhdHRlcm5zKTtcbiAgICBjb25zdCBiZWhhdmlvclBhdHRlcm5Pd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybnM6IFNlZW5CZWhhdmlvclBhdHRlcm5bXSA9IFtdO1xuICAgIGNvbnN0IHNzclVybEF1dGhUeXBlID0gcHJvcHMuc3NyVXJsQXV0aFR5cGUgPz8gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTTtcbiAgICBjb25zdCBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMgPSBwcm9wcy5hbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMgPz8gZmFsc2U7XG5cbiAgICB0aGlzLnNzclVybCA9IG5ldyBsYW1iZGEuRnVuY3Rpb25VcmwodGhpcywgXCJTc3JVcmxcIiwge1xuICAgICAgZnVuY3Rpb246IHByb3BzLnNzckZ1bmN0aW9uLFxuICAgICAgYXV0aFR5cGU6IHNzclVybEF1dGhUeXBlLFxuICAgICAgaW52b2tlTW9kZTogcHJvcHMuaW52b2tlTW9kZSA/PyBsYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzc3JPcmlnaW4gPVxuICAgICAgc3NyVXJsQXV0aFR5cGUgPT09IGxhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU1cbiAgICAgICAgPyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuc3NyVXJsKVxuICAgICAgICA6IG5ldyBvcmlnaW5zLkZ1bmN0aW9uVXJsT3JpZ2luKHRoaXMuc3NyVXJsKTtcblxuICAgIGNvbnN0IGFzc2V0c09yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5hc3NldHNCdWNrZXQpO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5CdWNrZXQgPSB0aGlzLmh0bWxTdG9yZUJ1Y2tldCA/PyB0aGlzLmFzc2V0c0J1Y2tldDtcbiAgICBjb25zdCBodG1sT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChcbiAgICAgIGh0bWxPcmlnaW5CdWNrZXQsXG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldCAmJiB0aGlzLmh0bWxTdG9yZUtleVByZWZpeFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIG9yaWdpblBhdGg6IGAvJHt0aGlzLmh0bWxTdG9yZUtleVByZWZpeH1gLFxuICAgICAgICAgIH1cbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgKTtcblxuICAgIGNvbnN0IGJhc2VTc3JGb3J3YXJkSGVhZGVycyA9IFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxIb3N0SGVhZGVycyxcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgXTtcblxuICAgIGNvbnN0IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IG5ldyBTZXQoW1wiaG9zdFwiLCBcIngtZm9yd2FyZGVkLXByb3RvXCJdKTtcblxuICAgIGNvbnN0IGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5pc0FycmF5KHByb3BzLnNzckZvcndhcmRIZWFkZXJzKVxuICAgICAgPyBwcm9wcy5zc3JGb3J3YXJkSGVhZGVycy5tYXAoY2Fub25pY2FsaXplSGVhZGVyTmFtZSkuZmlsdGVyKChoZWFkZXIpID0+IGhlYWRlci5sZW5ndGggPiAwKVxuICAgICAgOiBbXTtcblxuICAgIGNvbnN0IHJlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KGV4dHJhU3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+IGRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSkpLFxuICAgICkuc29ydCgpO1xuXG4gICAgaWYgKHJlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRpc2FsbG93cyBzc3JGb3J3YXJkSGVhZGVyczogJHtyZXF1ZXN0ZWREaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gaXNUZW5hbnRIZWFkZXJOYW1lKGhlYWRlcikpKSxcbiAgICApLnNvcnQoKTtcblxuICAgIGlmIChyZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVycy5sZW5ndGggPiAwICYmICFhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzPXRydWUgZm9yIHRlbmFudC1saWtlIHNzckZvcndhcmRIZWFkZXJzOiAke3JlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB0ZW5hbnRQYXNzdGhyb3VnaEhlYWRlcnMgPSBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnNcbiAgICAgID8gQXJyYXkuZnJvbShuZXcgU2V0KFtkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyLCAuLi5yZXF1ZXN0ZWRUZW5hbnRTc3JGb3J3YXJkSGVhZGVyc10pKVxuICAgICAgOiBbXTtcbiAgICBjb25zdCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycyA9IGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc1xuICAgICAgPyBbXVxuICAgICAgOiBBcnJheS5mcm9tKG5ldyBTZXQoW2RlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIsIC4uLnJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzXSkpLnNvcnQoKTtcblxuICAgIGNvbnN0IHNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIFsuLi5iYXNlU3NyRm9yd2FyZEhlYWRlcnMsIC4uLnRlbmFudFBhc3N0aHJvdWdoSGVhZGVycywgLi4uZXh0cmFTc3JGb3J3YXJkSGVhZGVyc10uZmlsdGVyKFxuICAgICAgICAgIChoZWFkZXIpID0+ICFkaXNhbGxvd2VkU3NyRm9yd2FyZEhlYWRlcnMuaGFzKGhlYWRlciksXG4gICAgICAgICksXG4gICAgICApLFxuICAgICk7XG4gICAgY29uc3QgaHRtbENhY2hlS2V5RXhjbHVkZWRIZWFkZXJzID0gbmV3IFNldChbXG4gICAgICBcImNsb3VkZnJvbnQtZm9yd2FyZGVkLXByb3RvXCIsXG4gICAgICBcImNsb3VkZnJvbnQtdmlld2VyLWFkZHJlc3NcIixcbiAgICAgIC4uLnNzck9yaWdpbmFsVXJpSGVhZGVycyxcbiAgICAgIFwieC1yZXF1ZXN0LWlkXCIsXG4gICAgXSk7XG4gICAgY29uc3QgaHRtbENhY2hlS2V5SGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KHNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiAhaHRtbENhY2hlS2V5RXhjbHVkZWRIZWFkZXJzLmhhcyhoZWFkZXIpKSksXG4gICAgKTtcbiAgICBjb25zdCBtYXhCZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycyA9IDEwO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKG5ldyBTZXQoWy4uLmJhc2VTc3JGb3J3YXJkSGVhZGVycywgXCJjb250ZW50LXR5cGVcIl0pKTtcbiAgICBjb25zdCBpc0Jsb2NrZWRCZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVyID0gKGhlYWRlcjogc3RyaW5nKTogYm9vbGVhbiA9PlxuICAgICAgaGVhZGVyID09PSBcImhvc3RcIiB8fFxuICAgICAgaGVhZGVyID09PSBcImZvcndhcmRlZFwiIHx8XG4gICAgICBoZWFkZXIgPT09IFwieC1yZWFsLWlwXCIgfHxcbiAgICAgIGhlYWRlci5zdGFydHNXaXRoKFwieC1mb3J3YXJkZWQtXCIpIHx8XG4gICAgICBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyKTtcbiAgICBjb25zdCBiZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycyA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFxuICAgICAgICBbXG4gICAgICAgICAgXCJhdXRob3JpemF0aW9uXCIsXG4gICAgICAgICAgXCJhY2NlcHRcIixcbiAgICAgICAgICBcIm9yaWdpblwiLFxuICAgICAgICAgIFwiYWNjZXNzLWNvbnRyb2wtcmVxdWVzdC1tZXRob2RcIixcbiAgICAgICAgICBcImFjY2Vzcy1jb250cm9sLXJlcXVlc3QtaGVhZGVyc1wiLFxuICAgICAgICAgIC4uLmV4dHJhU3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKFxuICAgICAgICAgICAgKGhlYWRlcikgPT5cbiAgICAgICAgICAgICAgIWlzQmxvY2tlZEJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXIoaGVhZGVyKSAmJlxuICAgICAgICAgICAgICAhYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Gb3J3YXJkSGVhZGVycy5pbmNsdWRlcyhoZWFkZXIpLFxuICAgICAgICAgICksXG4gICAgICAgIF0uZmlsdGVyKChoZWFkZXIpID0+IGhlYWRlci5sZW5ndGggPiAwKSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIGlmICghcHJvcHMuaHRtbENhY2hlUG9saWN5ICYmIGh0bWxDYWNoZUtleUhlYWRlcnMubGVuZ3RoID4gbWF4RGVmYXVsdENhY2hlS2V5SGVhZGVycykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBkZWZhdWx0IGh0bWxDYWNoZVBvbGljeSBzdXBwb3J0cyBhdCBtb3N0ICR7bWF4RGVmYXVsdENhY2hlS2V5SGVhZGVyc30gY2FjaGUta2V5IGhlYWRlcnM7IHJlY2VpdmVkICR7aHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGh9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luQ29uZmlncy5sZW5ndGggPiAwICYmXG4gICAgICBiZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycy5sZW5ndGggPiBtYXhCZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVyc1xuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSBiZWFyZXJGdW5jdGlvblVybE9yaWdpbnMgc3VwcG9ydCBhdCBtb3N0ICR7bWF4QmVhcmVyRnVuY3Rpb25VcmxDYWNoZUtleUhlYWRlcnN9IGNhY2hlLWtleSBmb3J3YXJkZWQgaGVhZGVyczsgcmVjZWl2ZWQgJHtiZWFyZXJGdW5jdGlvblVybENhY2hlS2V5SGVhZGVycy5sZW5ndGh9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3NyT3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJTc3JPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsKCksXG4gICAgICBoZWFkZXJCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLnNzckZvcndhcmRIZWFkZXJzKSxcbiAgICB9KTtcbiAgICBjb25zdCBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJIdG1sT3JpZ2luUmVxdWVzdFBvbGljeVwiLCB7XG4gICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IHNzckNhY2hlUG9saWN5ID0gcHJvcHMuc3NyQ2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVEO1xuICAgIGNvbnN0IHN0YXRpY0Fzc2V0c0NhY2hlUG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJTdGF0aWNBc3NldHNDYWNoZVBvbGljeVwiLCB7XG4gICAgICBjb21tZW50OlxuICAgICAgICBcIkFwcFRoZW9yeSBkaXJlY3QgUzMgYXNzZXQvZGF0YSBjYWNoZSBwb2xpY3k6IG9yaWdpbiBDYWNoZS1Db250cm9sIGJvdW5kZWQgYnkgbm8gdmlld2VyIGhlYWRlciBmb3J3YXJkaW5nXCIsXG4gICAgICBtaW5UdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgbWF4VHRsOiBEdXJhdGlvbi5kYXlzKDM2NSksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUNvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZVF1ZXJ5U3RyaW5nQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICBlbmFibGVBY2NlcHRFbmNvZGluZ0d6aXA6IHRydWUsXG4gICAgfSk7XG4gICAgY29uc3QgaHRtbENhY2hlUG9saWN5ID1cbiAgICAgIHByb3BzLmh0bWxDYWNoZVBvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJIdG1sQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgSFRNTCBjYWNoZSBwb2xpY3kga2V5ZWQgYnkgcXVlcnkgc3RyaW5ncyBhbmQgc3RhYmxlIHB1YmxpYyB2YXJpYW50IGhlYWRlcnNcIixcbiAgICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBtYXhUdGw6IER1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmh0bWxDYWNoZUtleUhlYWRlcnMpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nR3ppcDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luUmVxdWVzdFBvbGljeSA9XG4gICAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MubGVuZ3RoID4gMFxuICAgICAgICA/IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3kodGhpcywgXCJCZWFyZXJGdW5jdGlvblVybE9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoXG4gICAgICAgICAgICAgIC4uLmJlYXJlckZ1bmN0aW9uVXJsT3JpZ2luRm9yd2FyZEhlYWRlcnMsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIH0pXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVQb2xpY3kgPVxuICAgICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmxlbmd0aCA+IDBcbiAgICAgICAgPyBuZXcgY2xvdWRmcm9udC5DYWNoZVBvbGljeSh0aGlzLCBcIkJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICAgICAgY29tbWVudDpcbiAgICAgICAgICAgICAgXCJBcHBUaGVvcnkgYmVhcmVyIEZ1bmN0aW9uIFVSTCBBUEkgY2FjaGUgcG9saWN5OiBjYWNoaW5nIGRpc2FibGVkIHdoaWxlIGZvcndhcmRpbmcgYmVhcmVyL0NPUlMgYXBwIGhlYWRlcnNcIixcbiAgICAgICAgICAgIG1pblR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgICAgIGRlZmF1bHRUdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgICAgICBtYXhUdGw6IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5DYWNoZUNvb2tpZUJlaGF2aW9yLm5vbmUoKSxcbiAgICAgICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmJlYXJlckZ1bmN0aW9uVXJsQ2FjaGVLZXlIZWFkZXJzKSxcbiAgICAgICAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVRdWVyeVN0cmluZ0JlaGF2aW9yLm5vbmUoKSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IHVuZGVmaW5lZDtcblxuICAgIGFzc2VydE5vQ29uZmxpY3RpbmdCZWhhdmlvclBhdHRlcm5zKFxuICAgICAgXCJkaXJlY3QgUzMgcGF0aHNcIixcbiAgICAgIFtgJHthc3NldHNLZXlQcmVmaXh9LypgLCAuLi5kaXJlY3RTM1BhdGhQYXR0ZXJuc10sXG4gICAgICBiZWhhdmlvclBhdHRlcm5Pd25lcnMsXG4gICAgICBiZWhhdmlvclBhdHRlcm5zLFxuICAgICk7XG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJzdGF0aWMgSFRNTCBwYXRoc1wiLCBzdGF0aWNQYXRoUGF0dGVybnMsIGJlaGF2aW9yUGF0dGVybk93bmVycywgYmVoYXZpb3JQYXR0ZXJucyk7XG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJkaXJlY3QgU1NSIHBhdGhzXCIsIHNzclBhdGhQYXR0ZXJucywgYmVoYXZpb3JQYXR0ZXJuT3duZXJzLCBiZWhhdmlvclBhdHRlcm5zKTtcbiAgICBiZWFyZXJGdW5jdGlvblVybE9yaWdpbkNvbmZpZ3MuZm9yRWFjaCgoY29uZmlnLCBpbmRleCkgPT4ge1xuICAgICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gICAgICAgIGBiZWFyZXIgRnVuY3Rpb24gVVJMIGNvLW9yaWdpbiAke2luZGV4ICsgMX1gLFxuICAgICAgICBjb25maWcucGF0aFBhdHRlcm5zLFxuICAgICAgICBiZWhhdmlvclBhdHRlcm5Pd25lcnMsXG4gICAgICAgIGJlaGF2aW9yUGF0dGVybnMsXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgdmlld2VyUmVxdWVzdEZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShcbiAgICAgICAgZ2VuZXJhdGVTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25Db2RlKFxuICAgICAgICAgIHNpdGVNb2RlLFxuICAgICAgICAgIFtgJHthc3NldHNLZXlQcmVmaXh9LypgLCAuLi5kaXJlY3RTM1BhdGhQYXR0ZXJuc10sXG4gICAgICAgICAgWy4uLnNzclBhdGhQYXR0ZXJucywgLi4uYmVhcmVyRnVuY3Rpb25VcmxQYXRoUGF0dGVybnNdLFxuICAgICAgICAgIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgIGNvbW1lbnQ6XG4gICAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgICAgPyBcIkZhY2VUaGVvcnkgdmlld2VyLXJlcXVlc3QgZWRnZSBjb250ZXh0IGFuZCBIVE1MIHJld3JpdGUgZm9yIFNTUiBzaXRlXCJcbiAgICAgICAgICA6IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXNwb25zZUZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uXCIsIHtcbiAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoZ2VuZXJhdGVTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uQ29kZSgpKSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVzcG9uc2UgcmVxdWVzdC1pZCBlY2hvIGZvciBTU1Igc2l0ZVwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zID0gKCk6IGNsb3VkZnJvbnQuRnVuY3Rpb25Bc3NvY2lhdGlvbltdID0+IFtcbiAgICAgIHtcbiAgICAgICAgZnVuY3Rpb246IHZpZXdlclJlcXVlc3RGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgZnVuY3Rpb246IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24sXG4gICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVTUE9OU0UsXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuICAgIGxldCBkaXN0cmlidXRpb25Eb21haW5OYW1lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG4gICAgICBjb25zdCBjZXJ0QXJuID0gU3RyaW5nKHByb3BzLmNlcnRpZmljYXRlQXJuID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmIChjZXJ0QXJuKSB7XG4gICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkNlcnRpZmljYXRlXCIsIGNlcnRBcm4pO1xuICAgICAgfSBlbHNlIGlmIChwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICAgIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24odGhpcyk7XG4gICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgIHZhbGlkYXRpb246IGFjbS5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucyhwcm9wcy5ob3N0ZWRab25lKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTc3JTaXRlIHJlcXVpcmVzIHByb3BzLmNlcnRpZmljYXRlQXJuIG9yIHByb3BzLmhvc3RlZFpvbmUgd2hlbiBwcm9wcy5kb21haW5OYW1lIGlzIHNldFwiKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA9XG4gICAgICBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgIG5ldyBjbG91ZGZyb250LlJlc3BvbnNlSGVhZGVyc1BvbGljeSh0aGlzLCBcIlJlc3BvbnNlSGVhZGVyc1BvbGljeVwiLCB7XG4gICAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSBiYXNlbGluZSBzZWN1cml0eSBoZWFkZXJzIChDU1Agc3RheXMgb3JpZ2luLWRlZmluZWQpXCIsXG4gICAgICAgIHNlY3VyaXR5SGVhZGVyc0JlaGF2aW9yOiB7XG4gICAgICAgICAgc3RyaWN0VHJhbnNwb3J0U2VjdXJpdHk6IHtcbiAgICAgICAgICAgIGFjY2Vzc0NvbnRyb2xNYXhBZ2U6IER1cmF0aW9uLmRheXMoMzY1ICogMiksXG4gICAgICAgICAgICBpbmNsdWRlU3ViZG9tYWluczogdHJ1ZSxcbiAgICAgICAgICAgIHByZWxvYWQ6IHRydWUsXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGNvbnRlbnRUeXBlT3B0aW9uczogeyBvdmVycmlkZTogdHJ1ZSB9LFxuICAgICAgICAgIGZyYW1lT3B0aW9uczoge1xuICAgICAgICAgICAgZnJhbWVPcHRpb246IGNsb3VkZnJvbnQuSGVhZGVyc0ZyYW1lT3B0aW9uLkRFTlksXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHJlZmVycmVyUG9saWN5OiB7XG4gICAgICAgICAgICByZWZlcnJlclBvbGljeTogY2xvdWRmcm9udC5IZWFkZXJzUmVmZXJyZXJQb2xpY3kuU1RSSUNUX09SSUdJTl9XSEVOX0NST1NTX09SSUdJTixcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgeHNzUHJvdGVjdGlvbjoge1xuICAgICAgICAgICAgcHJvdGVjdGlvbjogdHJ1ZSxcbiAgICAgICAgICAgIG1vZGVCbG9jazogdHJ1ZSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGN1c3RvbUhlYWRlcnNCZWhhdmlvcjoge1xuICAgICAgICAgIGN1c3RvbUhlYWRlcnM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgaGVhZGVyOiBcInBlcm1pc3Npb25zLXBvbGljeVwiLFxuICAgICAgICAgICAgICB2YWx1ZTogXCJjYW1lcmE9KCksIG1pY3JvcGhvbmU9KCksIGdlb2xvY2F0aW9uPSgpXCIsXG4gICAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVTdGF0aWNCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBhc3NldHNPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogc3RhdGljQXNzZXRzQ2FjaGVQb2xpY3ksXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGh0bWxPcmlnaW4sXG4gICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICBjYWNoZVBvbGljeTogaHRtbENhY2hlUG9saWN5LFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogaHRtbE9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlU3NyQmVoYXZpb3IgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogc3NyT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICBjYWNoZVBvbGljeTogc3NyQ2FjaGVQb2xpY3ksXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiB0aGlzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSxcbiAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuICAgIGNvbnN0IGFkZEV4cGFuZGVkQmVoYXZpb3IgPSAocGF0dGVybnM6IHN0cmluZ1tdLCBmYWN0b3J5OiAoKSA9PiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyk6IHZvaWQgPT4ge1xuICAgICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGV4cGFuZEJlaGF2aW9yUGF0aFBhdHRlcm5zKHBhdHRlcm5zKSkge1xuICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW3BhdHRlcm5dID0gZmFjdG9yeSgpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKFtgJHthc3NldHNLZXlQcmVmaXh9LypgXSwgY3JlYXRlU3RhdGljQmVoYXZpb3IpO1xuICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoZGlyZWN0UzNQYXRoUGF0dGVybnMsIGNyZWF0ZVN0YXRpY0JlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHN0YXRpY1BhdGhQYXR0ZXJucywgY3JlYXRlU3RhdGljSHRtbEJlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKHNzclBhdGhQYXR0ZXJucywgY3JlYXRlU3NyQmVoYXZpb3IpO1xuICAgIHRoaXMuYmVhcmVyRnVuY3Rpb25VcmxzID0gW107XG4gICAgYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5Db25maWdzLmZvckVhY2goKGNvbmZpZywgaW5kZXgpID0+IHtcbiAgICAgIGNvbnN0IGZ1bmN0aW9uVXJsID0gbmV3IGxhbWJkYS5GdW5jdGlvblVybCh0aGlzLCBgQmVhcmVyRnVuY3Rpb25Vcmwke2luZGV4ICsgMX1gLCB7XG4gICAgICAgIGZ1bmN0aW9uOiBjb25maWcub3JpZ2luLmZ1bmN0aW9uLFxuICAgICAgICBhdXRoVHlwZTogbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuTk9ORSxcbiAgICAgICAgaW52b2tlTW9kZTogY29uZmlnLm9yaWdpbi5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLkJVRkZFUkVELFxuICAgICAgfSk7XG4gICAgICB0aGlzLmJlYXJlckZ1bmN0aW9uVXJscy5wdXNoKGZ1bmN0aW9uVXJsKTtcbiAgICAgIGNvbnN0IGZ1bmN0aW9uVXJsT3JpZ2luID0gbmV3IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4oZnVuY3Rpb25VcmwpO1xuICAgICAgY29uc3QgY3JlYXRlQmVhcmVyRnVuY3Rpb25VcmxCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgICBvcmlnaW46IGZ1bmN0aW9uVXJsT3JpZ2luLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICBjYWNoZVBvbGljeTogYmVhcmVyRnVuY3Rpb25VcmxDYWNoZVBvbGljeSxcbiAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogYmVhcmVyRnVuY3Rpb25VcmxPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgICB9KTtcbiAgICAgIGFkZEV4cGFuZGVkQmVoYXZpb3IoY29uZmlnLnBhdGhQYXR0ZXJucywgY3JlYXRlQmVhcmVyRnVuY3Rpb25VcmxCZWhhdmlvcik7XG4gICAgfSk7XG5cbiAgICBjb25zdCBkZWZhdWx0T3JpZ2luID1cbiAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgID8gbmV3IG9yaWdpbnMuT3JpZ2luR3JvdXAoe1xuICAgICAgICAgICAgcHJpbWFyeU9yaWdpbjogaHRtbE9yaWdpbixcbiAgICAgICAgICAgIGZhbGxiYWNrT3JpZ2luOiBzc3JPcmlnaW4sXG4gICAgICAgICAgICBmYWxsYmFja1N0YXR1c0NvZGVzOiBbNDAzLCA0MDRdLFxuICAgICAgICAgIH0pXG4gICAgICAgIDogc3NyT3JpZ2luO1xuICAgIGNvbnN0IGRlZmF1bHRBbGxvd2VkTWV0aG9kcyA9XG4gICAgICBzaXRlTW9kZSA9PT0gQXBwVGhlb3J5U3NyU2l0ZU1vZGUuU1NHX0lTUlxuICAgICAgICA/IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OU1xuICAgICAgICA6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMO1xuXG4gICAgLy8gU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUgYW5kIENsb3VkRnJvbnQuMSB1bmRlciBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQuXG4gICAgY29uc3QgbWluaW11bVByb3RvY29sVmVyc2lvbiA9IGRlZmF1bHRNaW5pbXVtUHJvdG9jb2xWZXJzaW9uKFxuICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlICE9PSB1bmRlZmluZWQsXG4gICAgICBwcm9wcy5taW5pbXVtUHJvdG9jb2xWZXJzaW9uLFxuICAgICk7XG4gICAgY29uc3QgZGVmYXVsdFJvb3RPYmplY3QgPSBwcm9wcy5kZWZhdWx0Um9vdE9iamVjdFxuICAgICAgPz8gKHNlY3VyZURlZmF1bHRzKG5hbWluZ0NvbnRleHQpICYmIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gXCJpbmRleC5odG1sXCIgOiB1bmRlZmluZWQpO1xuXG4gICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgLi4uKGVuYWJsZUxvZ2dpbmcgJiYgdGhpcy5sb2dzQnVja2V0XG4gICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgOiB7fSksXG4gICAgICAuLi4oZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgJiYgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGVcbiAgICAgICAgPyB7IGRvbWFpbk5hbWVzOiBkaXN0cmlidXRpb25Eb21haW5OYW1lcywgY2VydGlmaWNhdGU6IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlIH1cbiAgICAgICAgOiB7fSksXG4gICAgICAuLi4obWluaW11bVByb3RvY29sVmVyc2lvbiAhPT0gdW5kZWZpbmVkID8geyBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uIH0gOiB7fSksXG4gICAgICAuLi4oZGVmYXVsdFJvb3RPYmplY3QgIT09IHVuZGVmaW5lZCA/IHsgZGVmYXVsdFJvb3RPYmplY3QgfSA6IHt9KSxcbiAgICAgIGRlZmF1bHRCZWhhdmlvcjoge1xuICAgICAgICBvcmlnaW46IGRlZmF1bHRPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogZGVmYXVsdEFsbG93ZWRNZXRob2RzLFxuICAgICAgICBjYWNoZVBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sQ2FjaGVQb2xpY3kgOiBzc3JDYWNoZVBvbGljeSxcbiAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA6IHNzck9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICAgIH0sXG4gICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICB9KTtcblxuICAgIGlmIChzdGFuZGFyZExvZ2dpbmcgJiYgbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsKSB7XG4gICAgICBlbmFibGVDbG91ZEZyb250U3RhbmRhcmRMb2dnaW5nKHtcbiAgICAgICAgc2NvcGU6IHRoaXMsXG4gICAgICAgIGlkOiBcIkNkbkxvZ2dpbmdcIixcbiAgICAgICAgY29udGV4dDogbmFtaW5nQ29udGV4dCxcbiAgICAgICAgZGlzdHJpYnV0aW9uOiB0aGlzLmRpc3RyaWJ1dGlvbixcbiAgICAgICAgbG9naWNhbDogYGxvZ3MvYWNjZXNzL2Nkbi8ke2xvZ2ljYWx9YCxcbiAgICAgICAgZm9ybWF0OiBwcm9wcy5jbG91ZEZyb250TG9nRm9ybWF0LFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHNzclVybEF1dGhUeXBlID09PSBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNKSB7XG4gICAgICBwcm9wcy5zc3JGdW5jdGlvbi5hZGRQZXJtaXNzaW9uKFwiQWxsb3dDbG91ZEZyb250SW52b2tlRnVuY3Rpb25WaWFVcmxcIiwge1xuICAgICAgICBhY3Rpb246IFwibGFtYmRhOkludm9rZUZ1bmN0aW9uXCIsXG4gICAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiY2xvdWRmcm9udC5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgICBzb3VyY2VBcm46IHRoaXMuZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkFybixcbiAgICAgICAgaW52b2tlZFZpYUZ1bmN0aW9uVXJsOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0KSB7XG4gICAgICB0aGlzLmh0bWxTdG9yZUJ1Y2tldC5ncmFudFJlYWRXcml0ZShwcm9wcy5zc3JGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaXNyTWV0YWRhdGFUYWJsZSkge1xuICAgICAgdGhpcy5pc3JNZXRhZGF0YVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5zc3JGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHdpcmVSdW50aW1lRW52KSB7XG4gICAgICB0aGlzLmFzc2V0c0J1Y2tldC5ncmFudFJlYWQocHJvcHMuc3NyRnVuY3Rpb24pO1xuXG4gICAgICBjb25zdCBzc3JGdW5jdGlvbkFueSA9IHByb3BzLnNzckZ1bmN0aW9uIGFzIGFueTtcbiAgICAgIGlmICh0eXBlb2Ygc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlTc3JTaXRlIHdpcmVSdW50aW1lRW52IHJlcXVpcmVzIHByb3BzLnNzckZ1bmN0aW9uIHRvIHN1cHBvcnQgYWRkRW52aXJvbm1lbnQ7IHBhc3MgYSBsYW1iZGEuRnVuY3Rpb24gb3Igc2V0IHdpcmVSdW50aW1lRW52PWZhbHNlIGFuZCBzZXQgZW52IHZhcnMgbWFudWFsbHlcIixcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQVNTRVRTX0JVQ0tFVFwiLCB0aGlzLmFzc2V0c0J1Y2tldC5idWNrZXROYW1lKTtcbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19QUkVGSVhcIiwgYXNzZXRzS2V5UHJlZml4KTtcbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19NQU5JRkVTVF9LRVlcIiwgYXNzZXRzTWFuaWZlc3RLZXkpO1xuXG4gICAgICBpZiAodGhpcy5odG1sU3RvcmVCdWNrZXQgJiYgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXgpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0lTUl9CVUNLRVRcIiwgdGhpcy5odG1sU3RvcmVCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfUFJFRklYXCIsIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KTtcbiAgICAgIH1cbiAgICAgIGlmIChpc3JNZXRhZGF0YVRhYmxlTmFtZSkge1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJGQUNFVEhFT1JZX0NBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFX05BTUVcIiwgaXNyTWV0YWRhdGFUYWJsZU5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkNBQ0hFX1RBQkxFXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBkb21haW5OYW1lLFxuICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgfVxufVxuIl19