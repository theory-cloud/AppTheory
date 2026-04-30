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
        const viewerRequestFunction = new cloudfront.Function(this, "SsrViewerRequestFunction", {
            code: cloudfront.FunctionCode.fromInline(generateSsrViewerRequestFunctionCode(siteMode, [`${assetsKeyPrefix}/*`, ...directS3PathPatterns], ssrPathPatterns, blockedViewerTenantHeaders)),
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
AppTheorySsrSite[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheorySsrSite", version: "1.3.0-rc.1" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NyLXNpdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzc3Itc2l0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUFzRDtBQUN0RCwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUU5RCwyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyREFBMkQ7QUFDM0QseUNBQXlDO0FBQ3pDLDBEQUEwRDtBQUMxRCwyQ0FBdUM7QUFFdkMseURBQWlGO0FBRWpGLE1BQU0sMEJBQTBCLEdBQUcsMEJBQTBCLENBQUM7QUFDOUQsTUFBTSwyQkFBMkIsR0FBRywyQkFBMkIsQ0FBQztBQUNoRSxNQUFNLDJCQUEyQixHQUFHLDJCQUEyQixDQUFDO0FBQ2hFLE1BQU0sNEJBQTRCLEdBQUcsNEJBQTRCLENBQUM7QUFDbEUsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLDJCQUEyQixDQUFVLENBQUM7QUFDakcsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLDRCQUE0QixDQUFVLENBQUM7QUFDcEcsTUFBTSwwQkFBMEIsR0FBRyxxQkFBcUIsQ0FBQztBQUN6RCxNQUFNLDRCQUE0QixHQUFHLEtBQUssQ0FBQztBQUMzQyxNQUFNLHlCQUF5QixHQUFHLEVBQUUsQ0FBQztBQUNyQyxNQUFNLHlCQUF5QixHQUFHLGFBQWEsQ0FBQztBQUVoRCxJQUFZLG9CQVlYO0FBWkQsV0FBWSxvQkFBb0I7SUFDOUI7OztPQUdHO0lBQ0gsNkNBQXFCLENBQUE7SUFFckI7OztPQUdHO0lBQ0gsMkNBQW1CLENBQUE7QUFDckIsQ0FBQyxFQVpXLG9CQUFvQixvQ0FBcEIsb0JBQW9CLFFBWS9CO0FBRUQsU0FBUyxzQkFBc0IsQ0FBQyxPQUFlO0lBQzdDLE1BQU0sVUFBVSxHQUFHLElBQUEsb0NBQXFCLEVBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQyxD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QyxDQUFDO2dCQUN4RixjQUFjLENBQUMsY0FBYyxDQUFDLHVCQUF1QixFQUFFLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1lBQ2xGLENBQUM7WUFDRCxJQUFJLG9CQUFvQixFQUFFLENBQUM7Z0JBQ3pCLGNBQWMsQ0FBQyxjQUFjLENBQUMsNEJBQTRCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztnQkFDbEYsY0FBYyxDQUFDLGNBQWMsQ0FBQyw2QkFBNkIsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO2dCQUNuRixjQUFjLENBQUMsY0FBYyxDQUFDLGtCQUFrQixFQUFFLG9CQUFvQixDQUFDLENBQUM7Z0JBQ3hFLGNBQWMsQ0FBQyxjQUFjLENBQUMsYUFBYSxFQUFFLG9CQUFvQixDQUFDLENBQUM7WUFDckUsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLFVBQVUsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDbkMsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQ3ZDLElBQUksRUFBRSxLQUFLLENBQUMsVUFBVTtnQkFDdEIsVUFBVSxFQUFFLFVBQVU7Z0JBQ3RCLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7YUFDeEYsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUVILENBQUM7O0FBcGNILDRDQXFjQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uLCBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudFwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciwgdHJpbVJlcGVhdGVkQ2hhclN0YXJ0IH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuY29uc3QgYXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIgPSBcIngtYXBwdGhlb3J5LW9yaWdpbmFsLXVyaVwiO1xuY29uc3QgZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyID0gXCJ4LWZhY2V0aGVvcnktb3JpZ2luYWwtdXJpXCI7XG5jb25zdCBhcHB0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIgPSBcIngtYXBwdGhlb3J5LW9yaWdpbmFsLWhvc3RcIjtcbmNvbnN0IGZhY2V0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXIgPSBcIngtZmFjZXRoZW9yeS1vcmlnaW5hbC1ob3N0XCI7XG5jb25zdCBzc3JPcmlnaW5hbFVyaUhlYWRlcnMgPSBbYXBwdGhlb3J5T3JpZ2luYWxVcmlIZWFkZXIsIGZhY2V0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcl0gYXMgY29uc3Q7XG5jb25zdCBzc3JPcmlnaW5hbEhvc3RIZWFkZXJzID0gW2FwcHRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlciwgZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcl0gYXMgY29uc3Q7XG5jb25zdCBzc2dJc3JIeWRyYXRpb25QYXRoUGF0dGVybiA9IFwiL19mYWNldGhlb3J5L2RhdGEvKlwiO1xuY29uc3QgZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeCA9IFwiaXNyXCI7XG5jb25zdCBtYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzID0gMTA7XG5jb25zdCBkZWZhdWx0Vmlld2VyVGVuYW50SGVhZGVyID0gXCJ4LXRlbmFudC1pZFwiO1xuXG5leHBvcnQgZW51bSBBcHBUaGVvcnlTc3JTaXRlTW9kZSB7XG4gIC8qKlxuICAgKiBMYW1iZGEgRnVuY3Rpb24gVVJMIGlzIHRoZSBkZWZhdWx0IG9yaWdpbi4gRGlyZWN0IFMzIGJlaGF2aW9ycyBhcmUgdXNlZCBvbmx5IGZvclxuICAgKiBpbW11dGFibGUgYXNzZXRzIGFuZCBhbnkgZXhwbGljaXRseSBjb25maWd1cmVkIHN0YXRpYyBwYXRoIHBhdHRlcm5zLlxuICAgKi9cbiAgU1NSX09OTFkgPSBcInNzci1vbmx5XCIsXG5cbiAgLyoqXG4gICAqIFMzIGlzIHRoZSBwcmltYXJ5IEhUTUwgb3JpZ2luIGFuZCBMYW1iZGEgU1NSL0lTUiBpcyB0aGUgZmFsbGJhY2suIEZhY2VUaGVvcnkgaHlkcmF0aW9uXG4gICAqIGRhdGEgcm91dGVzIGFyZSBrZXB0IG9uIFMzIGFuZCB0aGUgZWRnZSByZXdyaXRlcyBleHRlbnNpb25sZXNzIHBhdGhzIHRvIGAvaW5kZXguaHRtbGAuXG4gICAqL1xuICBTU0dfSVNSID0gXCJzc2ctaXNyXCIsXG59XG5cbmZ1bmN0aW9uIHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgocGF0dGVybjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIikucmVwbGFjZSgvXFwvXFwqJC8sIFwiXCIpO1xuICByZXR1cm4gbm9ybWFsaXplZCA/IGAvJHtub3JtYWxpemVkfWAgOiBcIi9cIjtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUGF0aFBhdHRlcm5zKHBhdHRlcm5zOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIEFycmF5LmZyb20oXG4gICAgbmV3IFNldChcbiAgICAgIChBcnJheS5pc0FycmF5KHBhdHRlcm5zKSA/IHBhdHRlcm5zIDogW10pXG4gICAgICAgIC5tYXAoKHBhdHRlcm4pID0+IHRyaW1SZXBlYXRlZENoYXJTdGFydChTdHJpbmcocGF0dGVybikudHJpbSgpLCBcIi9cIikpXG4gICAgICAgIC5maWx0ZXIoKHBhdHRlcm4pID0+IHBhdHRlcm4ubGVuZ3RoID4gMCksXG4gICAgKSxcbiAgKTtcbn1cblxuZnVuY3Rpb24gZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBleHBhbmRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBwYXR0ZXJucykge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSB0cmltUmVwZWF0ZWRDaGFyU3RhcnQoU3RyaW5nKHBhdHRlcm4pLnRyaW0oKSwgXCIvXCIpO1xuICAgIGlmICghbm9ybWFsaXplZCkgY29udGludWU7XG5cbiAgICBleHBhbmRlZC5hZGQobm9ybWFsaXplZCk7XG4gICAgaWYgKG5vcm1hbGl6ZWQuZW5kc1dpdGgoXCIvKlwiKSkge1xuICAgICAgY29uc3Qgcm9vdFBhdHRlcm4gPSBub3JtYWxpemVkLnNsaWNlKDAsIC0yKTtcbiAgICAgIGlmIChyb290UGF0dGVybikge1xuICAgICAgICBleHBhbmRlZC5hZGQocm9vdFBhdHRlcm4pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBBcnJheS5mcm9tKGV4cGFuZGVkKTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgc2Vlbk93bmVyczogTWFwPHN0cmluZywgc3RyaW5nPixcbik6IHZvaWQge1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZXhwYW5kQmVoYXZpb3JQYXRoUGF0dGVybnMocGF0dGVybnMpKSB7XG4gICAgY29uc3Qgb3duZXIgPSBzZWVuT3duZXJzLmdldChwYXR0ZXJuKTtcbiAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IGxhYmVsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgb3ZlcmxhcHBpbmcgcGF0aCBwYXR0ZXJuIFwiJHtwYXR0ZXJufVwiIGZvciAke293bmVyfSBhbmQgJHtsYWJlbH1gKTtcbiAgICB9XG4gICAgc2Vlbk93bmVycy5zZXQocGF0dGVybiwgbGFiZWwpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNhbm9uaWNhbGl6ZUhlYWRlck5hbWUoaGVhZGVyOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKGhlYWRlcikudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG59XG5cbmZ1bmN0aW9uIGlzVGVuYW50SGVhZGVyTmFtZShoZWFkZXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBub3JtYWxpemVkID0gY2Fub25pY2FsaXplSGVhZGVyTmFtZShoZWFkZXIpLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpO1xuICByZXR1cm4gbm9ybWFsaXplZCA9PT0gZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciB8fCAvKF58LSl0ZW5hbnQoLXwkKS8udGVzdChub3JtYWxpemVkKTtcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25Db2RlKFxuICBtb2RlOiBBcHBUaGVvcnlTc3JTaXRlTW9kZSxcbiAgcmF3UzNQYXRoUGF0dGVybnM6IHN0cmluZ1tdLFxuICBsYW1iZGFQYXNzdGhyb3VnaFBhdGhQYXR0ZXJuczogc3RyaW5nW10sXG4gIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzOiBzdHJpbmdbXSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHJhd1MzUHJlZml4ZXMgPSByYXdTM1BhdGhQYXR0ZXJucy5tYXAocGF0aFBhdHRlcm5Ub1VyaVByZWZpeCkuc29ydCgoYSwgYikgPT4gYi5sZW5ndGggLSBhLmxlbmd0aCk7XG4gIGNvbnN0IHJhd1MzUHJlZml4TGlzdCA9IHJhd1MzUHJlZml4ZXMubWFwKChwcmVmaXgpID0+IGAnJHtwcmVmaXh9J2ApLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuICBjb25zdCBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzID0gbGFtYmRhUGFzc3Rocm91Z2hQYXRoUGF0dGVybnNcbiAgICAubWFwKHBhdGhQYXR0ZXJuVG9VcmlQcmVmaXgpXG4gICAgLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpO1xuICBjb25zdCBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeExpc3QgPSBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzLm1hcCgocHJlZml4KSA9PiBgJyR7cHJlZml4fSdgKS5qb2luKFwiLFxcbiAgICAgIFwiKTtcbiAgY29uc3QgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlckxpc3QgPSBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycy5tYXAoKGhlYWRlcikgPT4gYCcke2hlYWRlcn0nYCkuam9pbihcIixcXG4gICAgICBcIik7XG5cbiAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICByZXF1ZXN0LmhlYWRlcnMgPSByZXF1ZXN0LmhlYWRlcnMgfHwge307XG5cdCAgdmFyIGhlYWRlcnMgPSByZXF1ZXN0LmhlYWRlcnM7XG5cdCAgdmFyIHVyaSA9IHJlcXVlc3QudXJpIHx8ICcvJztcblx0ICB2YXIgYmxvY2tlZFZpZXdlclRlbmFudEhlYWRlcnMgPSBbXG5cdCAgICAke2Jsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJMaXN0fVxuXHQgIF07XG5cblx0ICBmb3IgKHZhciBibG9ja2VkSW5kZXggPSAwOyBibG9ja2VkSW5kZXggPCBibG9ja2VkVmlld2VyVGVuYW50SGVhZGVycy5sZW5ndGg7IGJsb2NrZWRJbmRleCsrKSB7XG5cdCAgICBkZWxldGUgaGVhZGVyc1tibG9ja2VkVmlld2VyVGVuYW50SGVhZGVyc1tibG9ja2VkSW5kZXhdXTtcblx0ICB9XG5cblx0ICB2YXIgcmVxdWVzdElkSGVhZGVyID0gaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ107XG5cdCAgdmFyIHJlcXVlc3RJZCA9IHJlcXVlc3RJZEhlYWRlciAmJiByZXF1ZXN0SWRIZWFkZXIudmFsdWUgPyByZXF1ZXN0SWRIZWFkZXIudmFsdWUudHJpbSgpIDogJyc7XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gZXZlbnQuY29udGV4dCAmJiBldmVudC5jb250ZXh0LnJlcXVlc3RJZCA/IFN0cmluZyhldmVudC5jb250ZXh0LnJlcXVlc3RJZCkudHJpbSgpIDogJyc7XG5cdCAgfVxuXG5cdCAgaWYgKCFyZXF1ZXN0SWQpIHtcblx0ICAgIHJlcXVlc3RJZCA9ICdyZXFfJyArIERhdGUubm93KCkudG9TdHJpbmcoMzYpICsgJ18nICsgTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTApO1xuXHQgIH1cblxuXHQgIGhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddID0geyB2YWx1ZTogcmVxdWVzdElkIH07XG5cdCAgaGVhZGVyc1snJHthcHB0aGVvcnlPcmlnaW5hbFVyaUhlYWRlcn0nXSA9IHsgdmFsdWU6IHVyaSB9O1xuXHQgIGhlYWRlcnNbJyR7ZmFjZXRoZW9yeU9yaWdpbmFsVXJpSGVhZGVyfSddID0geyB2YWx1ZTogdXJpIH07XG5cblx0ICBpZiAoaGVhZGVycy5ob3N0ICYmIGhlYWRlcnMuaG9zdC52YWx1ZSkge1xuXHQgICAgaGVhZGVyc1snJHthcHB0aGVvcnlPcmlnaW5hbEhvc3RIZWFkZXJ9J10gPSB7IHZhbHVlOiBoZWFkZXJzLmhvc3QudmFsdWUgfTtcblx0ICAgIGhlYWRlcnNbJyR7ZmFjZXRoZW9yeU9yaWdpbmFsSG9zdEhlYWRlcn0nXSA9IHsgdmFsdWU6IGhlYWRlcnMuaG9zdC52YWx1ZSB9O1xuXHQgIH1cblxuXHQgIGlmICgnJHttb2RlfScgPT09ICcke0FwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1J9Jykge1xuXHQgICAgdmFyIHJhd1MzUHJlZml4ZXMgPSBbXG5cdCAgICAgICR7cmF3UzNQcmVmaXhMaXN0fVxuXHQgICAgXTtcblx0ICAgIHZhciBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzID0gW1xuXHQgICAgICAke2xhbWJkYVBhc3N0aHJvdWdoUHJlZml4TGlzdH1cblx0ICAgIF07XG5cdCAgICB2YXIgaXNMYW1iZGFQYXNzdGhyb3VnaFBhdGggPSBmYWxzZTtcblxuXHQgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzLmxlbmd0aDsgaSsrKSB7XG5cdCAgICAgIHZhciBwcmVmaXggPSBsYW1iZGFQYXNzdGhyb3VnaFByZWZpeGVzW2ldO1xuXHQgICAgICBpZiAodXJpID09PSBwcmVmaXggfHwgdXJpLnN0YXJ0c1dpdGgocHJlZml4ICsgJy8nKSkge1xuXHQgICAgICAgIGlzTGFtYmRhUGFzc3Rocm91Z2hQYXRoID0gdHJ1ZTtcblx0ICAgICAgICBicmVhaztcblx0ICAgICAgfVxuXHQgICAgfVxuXG5cdCAgICBpZiAoIWlzTGFtYmRhUGFzc3Rocm91Z2hQYXRoKSB7XG5cdCAgICAgIHZhciBpc1Jhd1MzUGF0aCA9IGZhbHNlO1xuXG5cdCAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgcmF3UzNQcmVmaXhlcy5sZW5ndGg7IGorKykge1xuXHQgICAgICAgIHZhciByYXdQcmVmaXggPSByYXdTM1ByZWZpeGVzW2pdO1xuXHQgICAgICAgIGlmICh1cmkgPT09IHJhd1ByZWZpeCB8fCB1cmkuc3RhcnRzV2l0aChyYXdQcmVmaXggKyAnLycpKSB7XG5cdCAgICAgICAgICBpc1Jhd1MzUGF0aCA9IHRydWU7XG5cdCAgICAgICAgICBicmVhaztcblx0ICAgICAgICB9XG5cdCAgICAgIH1cblxuXHQgICAgICB2YXIgbGFzdFNsYXNoID0gdXJpLmxhc3RJbmRleE9mKCcvJyk7XG5cdCAgICAgIHZhciBsYXN0U2VnbWVudCA9IGxhc3RTbGFzaCA+PSAwID8gdXJpLnN1YnN0cmluZyhsYXN0U2xhc2ggKyAxKSA6IHVyaTtcblxuXHQgICAgICBpZiAoIWlzUmF3UzNQYXRoICYmIGxhc3RTZWdtZW50LmluZGV4T2YoJy4nKSA9PT0gLTEpIHtcblx0ICAgICAgICByZXF1ZXN0LnVyaSA9IHVyaS5lbmRzV2l0aCgnLycpID8gdXJpICsgJ2luZGV4Lmh0bWwnIDogdXJpICsgJy9pbmRleC5odG1sJztcblx0ICAgICAgfVxuXHQgICAgfVxuXHQgIH1cblxuXHQgIHJldHVybiByZXF1ZXN0O1xuXHR9XG5cdGAudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBnZW5lcmF0ZVNzclZpZXdlclJlc3BvbnNlRnVuY3Rpb25Db2RlKCk6IHN0cmluZyB7XG4gIHJldHVybiBgXG5cdGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcblx0ICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG5cdCAgdmFyIHJlc3BvbnNlID0gZXZlbnQucmVzcG9uc2U7XG5cdCAgdmFyIHJlcXVlc3RJZEhlYWRlciA9IHJlcXVlc3QuaGVhZGVyc1sneC1yZXF1ZXN0LWlkJ107XG5cdCAgdmFyIHJlcXVlc3RJZCA9IHJlcXVlc3RJZEhlYWRlciAmJiByZXF1ZXN0SWRIZWFkZXIudmFsdWUgPyByZXF1ZXN0SWRIZWFkZXIudmFsdWUudHJpbSgpIDogJyc7XG5cblx0ICBpZiAoIXJlcXVlc3RJZCkge1xuXHQgICAgcmVxdWVzdElkID0gZXZlbnQuY29udGV4dCAmJiBldmVudC5jb250ZXh0LnJlcXVlc3RJZCA/IFN0cmluZyhldmVudC5jb250ZXh0LnJlcXVlc3RJZCkudHJpbSgpIDogJyc7XG5cdCAgfVxuXG5cdCAgaWYgKHJlcXVlc3RJZCkge1xuXHQgICAgcmVzcG9uc2UuaGVhZGVycyA9IHJlc3BvbnNlLmhlYWRlcnMgfHwge307XG5cdCAgICBpZiAoIXJlc3BvbnNlLmhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddKSB7XG5cdCAgICAgIHJlc3BvbnNlLmhlYWRlcnNbJ3gtcmVxdWVzdC1pZCddID0geyB2YWx1ZTogcmVxdWVzdElkIH07XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlc3BvbnNlO1xuXHR9XG5cdGAudHJpbSgpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVNzclNpdGVQcm9wcyB7XG4gIHJlYWRvbmx5IHNzckZ1bmN0aW9uOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCBkZXBsb3ltZW50IG1vZGUgZm9yIHRoZSBzaXRlIHRvcG9sb2d5LlxuICAgKlxuICAgKiAtIGBzc3Itb25seWA6IExhbWJkYSBGdW5jdGlvbiBVUkwgaXMgdGhlIGRlZmF1bHQgb3JpZ2luXG4gICAqIC0gYHNzZy1pc3JgOiBTMyBpcyB0aGUgcHJpbWFyeSBIVE1MIG9yaWdpbiBhbmQgTGFtYmRhIGlzIHRoZSBmYWxsYmFja1xuICAgKlxuICAgKiBFeGlzdGluZyBpbXBsaWNpdCBiZWhhdmlvciBtYXBzIHRvIGBzc3Itb25seWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTUl9PTkxZXG4gICAqL1xuICByZWFkb25seSBtb2RlPzogQXBwVGhlb3J5U3NyU2l0ZU1vZGU7XG5cbiAgLyoqXG4gICAqIExhbWJkYSBGdW5jdGlvbiBVUkwgaW52b2tlIG1vZGUgZm9yIHRoZSBTU1Igb3JpZ2luLlxuICAgKiBAZGVmYXVsdCBsYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU1cbiAgICovXG4gIHJlYWRvbmx5IGludm9rZU1vZGU/OiBsYW1iZGEuSW52b2tlTW9kZTtcblxuICAvKipcbiAgICogRnVuY3Rpb24gVVJMIGF1dGggdHlwZSBmb3IgdGhlIFNTUiBvcmlnaW4uXG4gICAqXG4gICAqIElmIG9taXR0ZWQsIEFwcFRoZW9yeSBmYWlscyBjbG9zZWQgdG8gYEFXU19JQU1gIGFuZCBzaWducyBDbG91ZEZyb250LXRvLUxhbWJkYVxuICAgKiB0cmFmZmljIHdpdGggbGFtYmRhIE9yaWdpbiBBY2Nlc3MgQ29udHJvbC5cbiAgICpcbiAgICogU2V0IHRoaXMgZXhwbGljaXRseSB0byBgTk9ORWAgb25seSB3aGVuIHlvdSBpbnRlbnRpb25hbGx5IHJlcXVpcmUgcHVibGljXG4gICAqIGRpcmVjdCBGdW5jdGlvbiBVUkwgYWNjZXNzIGFzIGEgZGVsaWJlcmF0ZSBjb21wYXRpYmlsaXR5IGNob2ljZS5cbiAgICogQGRlZmF1bHQgbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTVxuICAgKi9cbiAgcmVhZG9ubHkgc3NyVXJsQXV0aFR5cGU/OiBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZTtcblxuICByZWFkb25seSBhc3NldHNCdWNrZXQ/OiBzMy5JQnVja2V0O1xuICByZWFkb25seSBhc3NldHNQYXRoPzogc3RyaW5nO1xuICByZWFkb25seSBhc3NldHNLZXlQcmVmaXg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFzc2V0c01hbmlmZXN0S2V5Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBTMyBidWNrZXQgdXNlZCBieSBGYWNlVGhlb3J5IElTUiBIVE1MIHN0b3JhZ2UgKGBTM0h0bWxTdG9yZWApLlxuICAgKlxuICAgKiBXaGVuIHByb3ZpZGVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBTU1IgZnVuY3Rpb24gcmVhZC93cml0ZSBhY2Nlc3MgYW5kIHdpcmVzOlxuICAgKiAtIGBGQUNFVEhFT1JZX0lTUl9CVUNLRVRgXG4gICAqIC0gYEZBQ0VUSEVPUllfSVNSX1BSRUZJWGBcbiAgICovXG4gIHJlYWRvbmx5IGh0bWxTdG9yZUJ1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgLyoqXG4gICAqIFMzIGtleSBwcmVmaXggdXNlZCBieSBGYWNlVGhlb3J5IElTUiBIVE1MIHN0b3JhZ2UuXG4gICAqIEBkZWZhdWx0IGlzclxuICAgKi9cbiAgcmVhZG9ubHkgaHRtbFN0b3JlS2V5UHJlZml4Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGV4dGVuc2lvbmxlc3MgSFRNTCBzZWN0aW9uIHBhdGggcGF0dGVybnMgdG8gcm91dGUgZGlyZWN0bHkgdG8gdGhlIHByaW1hcnkgSFRNTCBTMyBvcmlnaW4uXG4gICAqXG4gICAqIFJlcXVlc3RzIGxpa2UgYC9tYXJrZXRpbmdgIGFuZCBgL21hcmtldGluZy8uLi5gIGFyZSByZXdyaXR0ZW4gdG8gYC9pbmRleC5odG1sYFxuICAgKiB3aXRoaW4gdGhlIHNlY3Rpb24gYW5kIHN0YXkgb24gUzMgaW5zdGVhZCBvZiBmYWxsaW5nIGJhY2sgdG8gTGFtYmRhLlxuICAgKlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TMyBIVE1MIHNlY3Rpb24gcGF0aDogXCIvbWFya2V0aW5nLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhdGljUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgcmF3IFMzIG9iamVjdC9kYXRhIHBhdGggcGF0dGVybnMgdGhhdCBzaG91bGQgYnlwYXNzIGV4dGVuc2lvbmxlc3MgSFRNTCByZXdyaXRlcy5cbiAgICpcbiAgICogSW4gYHNzZy1pc3JgIG1vZGUsIGAvX2ZhY2V0aGVvcnkvZGF0YS8qYCBpcyBhZGRlZCBhdXRvbWF0aWNhbGx5LlxuICAgKiBFeGFtcGxlIGRpcmVjdC1TMyBvYmplY3QgcGF0aDogXCIvZmVlZHMvKlwiXG4gICAqL1xuICByZWFkb25seSBkaXJlY3RTM1BhdGhQYXR0ZXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIHBhdGggcGF0dGVybnMgdGhhdCBzaG91bGQgYnlwYXNzIHRoZSBgc3NnLWlzcmAgb3JpZ2luIGdyb3VwIGFuZCByb3V0ZSBkaXJlY3RseVxuICAgKiB0byB0aGUgTGFtYmRhIEZ1bmN0aW9uIFVSTCB3aXRoIGZ1bGwgbWV0aG9kIHN1cHBvcnQuXG4gICAqXG4gICAqIFVzZSB0aGlzIGZvciBzYW1lLW9yaWdpbiBkeW5hbWljIHBhdGhzIHN1Y2ggYXMgYXV0aCBjYWxsYmFja3MsIGFjdGlvbnMsIG9yIGZvcm0gcG9zdHMuXG4gICAqIEV4YW1wbGUgZGlyZWN0LVNTUiBwYXRoOiBcIi9hY3Rpb25zLypcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3NyUGF0aFBhdHRlcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIFRhYmxlVGhlb3J5L0R5bmFtb0RCIHRhYmxlIHVzZWQgZm9yIEZhY2VUaGVvcnkgSVNSIG1ldGFkYXRhIGFuZCBsZWFzZSBjb29yZGluYXRpb24uXG4gICAqXG4gICAqIFdoZW4gcHJvdmlkZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIFNTUiBmdW5jdGlvbiByZWFkL3dyaXRlIGFjY2VzcyBhbmQgd2lyZXMgdGhlXG4gICAqIG1ldGFkYXRhIHRhYmxlIGFsaWFzZXMgZXhwZWN0ZWQgYnkgdGhlIGRvY3VtZW50ZWQgRmFjZVRoZW9yeSBkZXBsb3ltZW50IHNoYXBlLlxuICAgKi9cbiAgcmVhZG9ubHkgaXNyTWV0YWRhdGFUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgSVNSL2NhY2hlIG1ldGFkYXRhIHRhYmxlIG5hbWUgdG8gd2lyZSB3aGVuIHlvdSBhcmUgbm90IHBhc3NpbmcgYGlzck1ldGFkYXRhVGFibGVgLlxuICAgKlxuICAgKiBQcmVmZXIgYGlzck1ldGFkYXRhVGFibGVgIHdoZW4gQXBwVGhlb3J5IHNob3VsZCBhbHNvIGdyYW50IGFjY2VzcyB0byB0aGUgU1NSIExhbWJkYS5cbiAgICovXG4gIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBMZWdhY3kgYWxpYXMgZm9yIGBpc3JNZXRhZGF0YVRhYmxlTmFtZWAuXG4gICAqIEBkZXByZWNhdGVkIHByZWZlciBgaXNyTWV0YWRhdGFUYWJsZWAgb3IgYGlzck1ldGFkYXRhVGFibGVOYW1lYFxuICAgKi9cbiAgcmVhZG9ubHkgY2FjaGVUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLy8gV2hlbiB0cnVlIChkZWZhdWx0KSwgQXBwVGhlb3J5IHdpcmVzIHJlY29tbWVuZGVkIHJ1bnRpbWUgZW52aXJvbm1lbnQgdmFyaWFibGVzIG9udG8gdGhlIFNTUiBmdW5jdGlvbi5cbiAgcmVhZG9ubHkgd2lyZVJ1bnRpbWVFbnY/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIGhlYWRlcnMgdG8gZm9yd2FyZCB0byB0aGUgU1NSIG9yaWdpbiAoTGFtYmRhIEZ1bmN0aW9uIFVSTCkgdmlhIHRoZSBvcmlnaW4gcmVxdWVzdCBwb2xpY3kuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IEFwcFRoZW9yeS9GYWNlVGhlb3J5LXNhZmUgZWRnZSBjb250cmFjdCBmb3J3YXJkcyBvbmx5OlxuICAgKiAtIGBjbG91ZGZyb250LWZvcndhcmRlZC1wcm90b2BcbiAgICogLSBgY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc2BcbiAgICogLSBgeC1hcHB0aGVvcnktb3JpZ2luYWwtaG9zdGBcbiAgICogLSBgeC1hcHB0aGVvcnktb3JpZ2luYWwtdXJpYFxuICAgKiAtIGB4LWZhY2V0aGVvcnktb3JpZ2luYWwtaG9zdGBcbiAgICogLSBgeC1mYWNldGhlb3J5LW9yaWdpbmFsLXVyaWBcbiAgICogLSBgeC1yZXF1ZXN0LWlkYFxuICAgKlxuICAgKiBVc2UgdGhpcyB0byBvcHQgaW4gdG8gYWRkaXRpb25hbCBhcHAtc3BlY2lmaWMgaGVhZGVycyBzdWNoIGFzXG4gICAqIGB4LWZhY2V0aGVvcnktc2VnbWVudGAuIFRlbmFudC1saWtlIHZpZXdlciBoZWFkZXJzIGFyZSByZWplY3RlZCB1bmxlc3NcbiAgICogYGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc2AgaXMgZXhwbGljaXRseSBlbmFibGVkIGFzIGEgY29tcGF0aWJpbGl0eSBtb2RlLlxuICAgKiBgaG9zdGAgYW5kIGB4LWZvcndhcmRlZC1wcm90b2AgYXJlIHJlamVjdGVkIGJlY2F1c2UgdGhleSBicmVhayBvciBieXBhc3MgdGhlXG4gICAqIHN1cHBvcnRlZCBvcmlnaW4gbW9kZWwuXG4gICAqL1xuICByZWFkb25seSBzc3JGb3J3YXJkSGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDb21wYXRpYmlsaXR5IGVzY2FwZSBoYXRjaCBmb3IgbGVnYWN5IHZpZXdlci1zdXBwbGllZCB0ZW5hbnQgaGVhZGVycy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSAoZGVmYXVsdCksIEFwcFRoZW9yeSBzdHJpcHMgYHgtdGVuYW50LWlkYCBhdCB0aGUgZWRnZSBhbmQgcmVqZWN0c1xuICAgKiB0ZW5hbnQtbGlrZSBlbnRyaWVzIGluIGBzc3JGb3J3YXJkSGVhZGVyc2Agc28gdmlld2VyLXN1cHBsaWVkIHRlbmFudCBoZWFkZXJzXG4gICAqIGNhbm5vdCBpbmZsdWVuY2Ugb3JpZ2luIHJvdXRpbmcgb3IgSFRNTCBjYWNoZSBwYXJ0aXRpb25pbmcuIFdoZW4gdHJ1ZSxcbiAgICogQXBwVGhlb3J5IHJlc3RvcmVzIGxlZ2FjeSBwYXNzdGhyb3VnaCBiZWhhdmlvciBmb3IgYHgtdGVuYW50LWlkYCBhbmQgYW55XG4gICAqIHRlbmFudC1saWtlIGBzc3JGb3J3YXJkSGVhZGVyc2AuXG4gICAqXG4gICAqIFByZWZlciBkZXJpdmluZyB0ZW5hbnQgZnJvbSB0cnVzdGVkIGhvc3QgbWFwcGluZyB1c2luZyB0aGUgb3JpZ2luYWwtaG9zdFxuICAgKiBlZGdlIGhlYWRlcnMgaW5zdGVhZCBvZiBlbmFibGluZyBwYXNzdGhyb3VnaC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFsbG93Vmlld2VyVGVuYW50SGVhZGVycz86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZW5hYmxlTG9nZ2luZz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBDbG91ZEZyb250IHJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGFwcGxpZWQgdG8gU1NSIGFuZCBkaXJlY3QtUzMgYmVoYXZpb3JzLlxuICAgKlxuICAgKiBJZiBvbWl0dGVkLCBBcHBUaGVvcnkgcHJvdmlzaW9ucyBhIEZhY2VUaGVvcnktYWxpZ25lZCBiYXNlbGluZSBwb2xpY3kgYXQgdGhlIENETlxuICAgKiBsYXllcjogSFNUUywgbm9zbmlmZiwgZnJhbWUtb3B0aW9ucywgcmVmZXJyZXItcG9saWN5LCBYU1MgcHJvdGVjdGlvbiwgYW5kIGFcbiAgICogcmVzdHJpY3RpdmUgcGVybWlzc2lvbnMtcG9saWN5LiBDb250ZW50LVNlY3VyaXR5LVBvbGljeSByZW1haW5zIG9yaWdpbi1kZWZpbmVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gIC8qKlxuICAgKiBDYWNoZSBwb2xpY3kgYXBwbGllZCB0byBkaXJlY3QgTGFtYmRhLWJhY2tlZCBTU1IgYmVoYXZpb3JzLlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBpcyBgQ0FDSElOR19ESVNBQkxFRGAgc28gZHluYW1pYyBMYW1iZGEgcm91dGVzIHN0YXkgc2FmZSB1bmxlc3MgeW91XG4gICAqIGludGVudGlvbmFsbHkgb3B0IGludG8gYSBjYWNoZSBwb2xpY3kgdGhhdCBtYXRjaGVzIHlvdXIgYXBwJ3MgdmFyaWFuY2UgbW9kZWwuXG4gICAqIEBkZWZhdWx0IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRFxuICAgKi9cbiAgcmVhZG9ubHkgc3NyQ2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICAvKipcbiAgICogQ2FjaGUgcG9saWN5IGFwcGxpZWQgdG8gdGhlIGNhY2hlYWJsZSBIVE1MIGJlaGF2aW9yIGluIGBzc2ctaXNyYCBtb2RlLlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBBcHBUaGVvcnkgcG9saWN5IGtleXMgb24gcXVlcnkgc3RyaW5ncyBwbHVzIHRoZSBzdGFibGUgcHVibGljIEhUTUxcbiAgICogdmFyaWFudCBoZWFkZXJzIChgeC0qLW9yaWdpbmFsLWhvc3RgIGFuZCBhbnkgbm9uLXRlbmFudCBleHRyYSBmb3J3YXJkZWRcbiAgICogaGVhZGVycyB5b3Ugb3B0IGludG8pIHdoaWxlIGxlYXZpbmcgY29va2llcyBvdXQgb2YgdGhlIGNhY2hlIGtleS4gVGVuYW50LWxpa2VcbiAgICogdmlld2VyIGhlYWRlcnMgam9pbiB0aGUgY2FjaGUga2V5IG9ubHkgd2hlbiBgYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzYCBpc1xuICAgKiBleHBsaWNpdGx5IGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSBodG1sQ2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgYXV0b0RlbGV0ZU9iamVjdHM/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVNzclNpdGUgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzQnVja2V0OiBzMy5JQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzZXRzS2V5UHJlZml4OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBhc3NldHNNYW5pZmVzdEtleTogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaHRtbFN0b3JlQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IGh0bWxTdG9yZUtleVByZWZpeD86IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGlzck1ldGFkYXRhVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IHNzclVybDogbGFtYmRhLkZ1bmN0aW9uVXJsO1xuICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcbiAgcHVibGljIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlTc3JTaXRlUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKCFwcm9wcz8uc3NyRnVuY3Rpb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgcHJvcHMuc3NyRnVuY3Rpb25cIik7XG4gICAgfVxuXG4gICAgY29uc3Qgc2l0ZU1vZGUgPSBwcm9wcy5tb2RlID8/IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTUl9PTkxZO1xuICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgY29uc3Qgd2lyZVJ1bnRpbWVFbnYgPSBwcm9wcy53aXJlUnVudGltZUVudiA/PyB0cnVlO1xuXG4gICAgdGhpcy5hc3NldHNCdWNrZXQgPVxuICAgICAgcHJvcHMuYXNzZXRzQnVja2V0ID8/XG4gICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQXNzZXRzQnVja2V0XCIsIHtcbiAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcbiAgICBpZiAoZW5hYmxlTG9nZ2luZykge1xuICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBhc3NldHNQcmVmaXhSYXcgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhwcm9wcy5hc3NldHNLZXlQcmVmaXggPz8gXCJhc3NldHNcIikudHJpbSgpLCBcIi9cIik7XG4gICAgY29uc3QgYXNzZXRzS2V5UHJlZml4ID0gYXNzZXRzUHJlZml4UmF3IHx8IFwiYXNzZXRzXCI7XG5cbiAgICBjb25zdCBtYW5pZmVzdFJhdyA9IFN0cmluZyhwcm9wcy5hc3NldHNNYW5pZmVzdEtleSA/PyBgJHthc3NldHNLZXlQcmVmaXh9L21hbmlmZXN0Lmpzb25gKS50cmltKCk7XG4gICAgY29uc3QgbWFuaWZlc3RLZXkgPSB0cmltUmVwZWF0ZWRDaGFyKG1hbmlmZXN0UmF3LCBcIi9cIik7XG4gICAgY29uc3QgYXNzZXRzTWFuaWZlc3RLZXkgPSBtYW5pZmVzdEtleSB8fCBgJHthc3NldHNLZXlQcmVmaXh9L21hbmlmZXN0Lmpzb25gO1xuXG4gICAgdGhpcy5hc3NldHNLZXlQcmVmaXggPSBhc3NldHNLZXlQcmVmaXg7XG4gICAgdGhpcy5hc3NldHNNYW5pZmVzdEtleSA9IGFzc2V0c01hbmlmZXN0S2V5O1xuXG4gICAgY29uc3QgaHRtbFN0b3JlS2V5UHJlZml4SW5wdXQgPSBTdHJpbmcocHJvcHMuaHRtbFN0b3JlS2V5UHJlZml4ID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBzaG91bGRDb25maWd1cmVIdG1sU3RvcmUgPSBCb29sZWFuKHByb3BzLmh0bWxTdG9yZUJ1Y2tldCkgfHwgaHRtbFN0b3JlS2V5UHJlZml4SW5wdXQubGVuZ3RoID4gMDtcbiAgICBpZiAoc2hvdWxkQ29uZmlndXJlSHRtbFN0b3JlKSB7XG4gICAgICBjb25zdCBodG1sU3RvcmVQcmVmaXhSYXcgPSB0cmltUmVwZWF0ZWRDaGFyKFxuICAgICAgICBTdHJpbmcocHJvcHMuaHRtbFN0b3JlS2V5UHJlZml4ID8/IGRlZmF1bHRJc3JIdG1sU3RvcmVLZXlQcmVmaXgpLnRyaW0oKSxcbiAgICAgICAgXCIvXCIsXG4gICAgICApO1xuICAgICAgdGhpcy5odG1sU3RvcmVLZXlQcmVmaXggPSBodG1sU3RvcmVQcmVmaXhSYXcgfHwgZGVmYXVsdElzckh0bWxTdG9yZUtleVByZWZpeDtcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0ID1cbiAgICAgICAgcHJvcHMuaHRtbFN0b3JlQnVja2V0ID8/XG4gICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJIdG1sU3RvcmVCdWNrZXRcIiwge1xuICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5pc3JNZXRhZGF0YVRhYmxlID0gcHJvcHMuaXNyTWV0YWRhdGFUYWJsZTtcblxuICAgIGNvbnN0IGV4cGxpY2l0SXNyTWV0YWRhdGFUYWJsZU5hbWUgPSBTdHJpbmcocHJvcHMuaXNyTWV0YWRhdGFUYWJsZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IGxlZ2FjeUNhY2hlVGFibGVOYW1lID0gU3RyaW5nKHByb3BzLmNhY2hlVGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCByZXNvdXJjZUlzck1ldGFkYXRhVGFibGVOYW1lID0gU3RyaW5nKHRoaXMuaXNyTWV0YWRhdGFUYWJsZT8udGFibGVOYW1lID8/IFwiXCIpLnRyaW0oKTtcblxuICAgIGNvbnN0IGNvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgW3Jlc291cmNlSXNyTWV0YWRhdGFUYWJsZU5hbWUsIGV4cGxpY2l0SXNyTWV0YWRhdGFUYWJsZU5hbWUsIGxlZ2FjeUNhY2hlVGFibGVOYW1lXS5maWx0ZXIoXG4gICAgICAgICAgKG5hbWUpID0+IFN0cmluZyhuYW1lKS50cmltKCkubGVuZ3RoID4gMCxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIGlmIChjb25maWd1cmVkSXNyTWV0YWRhdGFUYWJsZU5hbWVzLmxlbmd0aCA+IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgcmVjZWl2ZWQgY29uZmxpY3RpbmcgSVNSIG1ldGFkYXRhIHRhYmxlIG5hbWVzOiAke2NvbmZpZ3VyZWRJc3JNZXRhZGF0YVRhYmxlTmFtZXMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGlzck1ldGFkYXRhVGFibGVOYW1lID0gY29uZmlndXJlZElzck1ldGFkYXRhVGFibGVOYW1lc1swXSA/PyBcIlwiO1xuXG4gICAgaWYgKHByb3BzLmFzc2V0c1BhdGgpIHtcbiAgICAgIG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsIFwiQXNzZXRzRGVwbG95bWVudFwiLCB7XG4gICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQocHJvcHMuYXNzZXRzUGF0aCldLFxuICAgICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5hc3NldHNCdWNrZXQsXG4gICAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiBhc3NldHNLZXlQcmVmaXgsXG4gICAgICAgIHBydW5lOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhdGljUGF0aFBhdHRlcm5zID0gbm9ybWFsaXplUGF0aFBhdHRlcm5zKHByb3BzLnN0YXRpY1BhdGhQYXR0ZXJucyk7XG4gICAgY29uc3QgZGlyZWN0UzNQYXRoUGF0dGVybnMgPSBub3JtYWxpemVQYXRoUGF0dGVybnMoW1xuICAgICAgLi4uKHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSID8gW3NzZ0lzckh5ZHJhdGlvblBhdGhQYXR0ZXJuXSA6IFtdKSxcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zKSA/IHByb3BzLmRpcmVjdFMzUGF0aFBhdHRlcm5zIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IHNzclBhdGhQYXR0ZXJucyA9IG5vcm1hbGl6ZVBhdGhQYXR0ZXJucyhwcm9wcy5zc3JQYXRoUGF0dGVybnMpO1xuICAgIGNvbnN0IGJlaGF2aW9yUGF0dGVybk93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgY29uc3Qgc3NyVXJsQXV0aFR5cGUgPSBwcm9wcy5zc3JVcmxBdXRoVHlwZSA/PyBsYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNO1xuICAgIGNvbnN0IGFsbG93Vmlld2VyVGVuYW50SGVhZGVycyA9IHByb3BzLmFsbG93Vmlld2VyVGVuYW50SGVhZGVycyA/PyBmYWxzZTtcblxuICAgIHRoaXMuc3NyVXJsID0gbmV3IGxhbWJkYS5GdW5jdGlvblVybCh0aGlzLCBcIlNzclVybFwiLCB7XG4gICAgICBmdW5jdGlvbjogcHJvcHMuc3NyRnVuY3Rpb24sXG4gICAgICBhdXRoVHlwZTogc3NyVXJsQXV0aFR5cGUsXG4gICAgICBpbnZva2VNb2RlOiBwcm9wcy5pbnZva2VNb2RlID8/IGxhbWJkYS5JbnZva2VNb2RlLlJFU1BPTlNFX1NUUkVBTSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNzck9yaWdpbiA9XG4gICAgICBzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTVxuICAgICAgICA/IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5zc3JVcmwpXG4gICAgICAgIDogbmV3IG9yaWdpbnMuRnVuY3Rpb25VcmxPcmlnaW4odGhpcy5zc3JVcmwpO1xuXG4gICAgY29uc3QgYXNzZXRzT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCh0aGlzLmFzc2V0c0J1Y2tldCk7XG4gICAgY29uc3QgaHRtbE9yaWdpbkJ1Y2tldCA9IHRoaXMuaHRtbFN0b3JlQnVja2V0ID8/IHRoaXMuYXNzZXRzQnVja2V0O1xuICAgIGNvbnN0IGh0bWxPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKFxuICAgICAgaHRtbE9yaWdpbkJ1Y2tldCxcbiAgICAgIHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4XG4gICAgICAgID8ge1xuICAgICAgICAgICAgb3JpZ2luUGF0aDogYC8ke3RoaXMuaHRtbFN0b3JlS2V5UHJlZml4fWAsXG4gICAgICAgICAgfVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICApO1xuXG4gICAgY29uc3QgYmFzZVNzckZvcndhcmRIZWFkZXJzID0gW1xuICAgICAgXCJjbG91ZGZyb250LWZvcndhcmRlZC1wcm90b1wiLFxuICAgICAgXCJjbG91ZGZyb250LXZpZXdlci1hZGRyZXNzXCIsXG4gICAgICAuLi5zc3JPcmlnaW5hbEhvc3RIZWFkZXJzLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdO1xuXG4gICAgY29uc3QgZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzID0gbmV3IFNldChbXCJob3N0XCIsIFwieC1mb3J3YXJkZWQtcHJvdG9cIl0pO1xuXG4gICAgY29uc3QgZXh0cmFTc3JGb3J3YXJkSGVhZGVycyA9IEFycmF5LmlzQXJyYXkocHJvcHMuc3NyRm9yd2FyZEhlYWRlcnMpXG4gICAgICA/IHByb3BzLnNzckZvcndhcmRIZWFkZXJzLm1hcChjYW5vbmljYWxpemVIZWFkZXJOYW1lKS5maWx0ZXIoKGhlYWRlcikgPT4gaGVhZGVyLmxlbmd0aCA+IDApXG4gICAgICA6IFtdO1xuXG4gICAgY29uc3QgcmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoZXh0cmFTc3JGb3J3YXJkSGVhZGVycy5maWx0ZXIoKGhlYWRlcikgPT4gZGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmhhcyhoZWFkZXIpKSksXG4gICAgKS5zb3J0KCk7XG5cbiAgICBpZiAocmVxdWVzdGVkRGlzYWxsb3dlZFNzckZvcndhcmRIZWFkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeVNzclNpdGUgZGlzYWxsb3dzIHNzckZvcndhcmRIZWFkZXJzOiAke3JlcXVlc3RlZERpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5qb2luKFwiLCBcIil9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChleHRyYVNzckZvcndhcmRIZWFkZXJzLmZpbHRlcigoaGVhZGVyKSA9PiBpc1RlbmFudEhlYWRlck5hbWUoaGVhZGVyKSkpLFxuICAgICkuc29ydCgpO1xuXG4gICAgaWYgKHJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzLmxlbmd0aCA+IDAgJiYgIWFsbG93Vmlld2VyVGVuYW50SGVhZGVycykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5U3NyU2l0ZSByZXF1aXJlcyBhbGxvd1ZpZXdlclRlbmFudEhlYWRlcnM9dHJ1ZSBmb3IgdGVuYW50LWxpa2Ugc3NyRm9yd2FyZEhlYWRlcnM6ICR7cmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHRlbmFudFBhc3N0aHJvdWdoSGVhZGVycyA9IGFsbG93Vmlld2VyVGVuYW50SGVhZGVyc1xuICAgICAgPyBBcnJheS5mcm9tKG5ldyBTZXQoW2RlZmF1bHRWaWV3ZXJUZW5hbnRIZWFkZXIsIC4uLnJlcXVlc3RlZFRlbmFudFNzckZvcndhcmRIZWFkZXJzXSkpXG4gICAgICA6IFtdO1xuICAgIGNvbnN0IGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzID0gYWxsb3dWaWV3ZXJUZW5hbnRIZWFkZXJzXG4gICAgICA/IFtdXG4gICAgICA6IEFycmF5LmZyb20obmV3IFNldChbZGVmYXVsdFZpZXdlclRlbmFudEhlYWRlciwgLi4ucmVxdWVzdGVkVGVuYW50U3NyRm9yd2FyZEhlYWRlcnNdKSkuc29ydCgpO1xuXG4gICAgY29uc3Qgc3NyRm9yd2FyZEhlYWRlcnMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChcbiAgICAgICAgWy4uLmJhc2VTc3JGb3J3YXJkSGVhZGVycywgLi4udGVuYW50UGFzc3Rocm91Z2hIZWFkZXJzLCAuLi5leHRyYVNzckZvcndhcmRIZWFkZXJzXS5maWx0ZXIoXG4gICAgICAgICAgKGhlYWRlcikgPT4gIWRpc2FsbG93ZWRTc3JGb3J3YXJkSGVhZGVycy5oYXMoaGVhZGVyKSxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMgPSBuZXcgU2V0KFtcbiAgICAgIFwiY2xvdWRmcm9udC1mb3J3YXJkZWQtcHJvdG9cIixcbiAgICAgIFwiY2xvdWRmcm9udC12aWV3ZXItYWRkcmVzc1wiLFxuICAgICAgLi4uc3NyT3JpZ2luYWxVcmlIZWFkZXJzLFxuICAgICAgXCJ4LXJlcXVlc3QtaWRcIixcbiAgICBdKTtcbiAgICBjb25zdCBodG1sQ2FjaGVLZXlIZWFkZXJzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoc3NyRm9yd2FyZEhlYWRlcnMuZmlsdGVyKChoZWFkZXIpID0+ICFodG1sQ2FjaGVLZXlFeGNsdWRlZEhlYWRlcnMuaGFzKGhlYWRlcikpKSxcbiAgICApO1xuXG4gICAgaWYgKCFwcm9wcy5odG1sQ2FjaGVQb2xpY3kgJiYgaHRtbENhY2hlS2V5SGVhZGVycy5sZW5ndGggPiBtYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlTc3JTaXRlIGRlZmF1bHQgaHRtbENhY2hlUG9saWN5IHN1cHBvcnRzIGF0IG1vc3QgJHttYXhEZWZhdWx0Q2FjaGVLZXlIZWFkZXJzfSBjYWNoZS1rZXkgaGVhZGVyczsgcmVjZWl2ZWQgJHtodG1sQ2FjaGVLZXlIZWFkZXJzLmxlbmd0aH1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzc3JPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIlNzck9yaWdpblJlcXVlc3RQb2xpY3lcIiwge1xuICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoLi4uc3NyRm9yd2FyZEhlYWRlcnMpLFxuICAgIH0pO1xuICAgIGNvbnN0IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeSh0aGlzLCBcIkh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5XCIsIHtcbiAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICBjb29raWVCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3Iubm9uZSgpLFxuICAgICAgaGVhZGVyQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdCguLi5zc3JGb3J3YXJkSGVhZGVycyksXG4gICAgfSk7XG4gICAgY29uc3Qgc3NyQ2FjaGVQb2xpY3kgPSBwcm9wcy5zc3JDYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQ7XG4gICAgY29uc3QgaHRtbENhY2hlUG9saWN5ID1cbiAgICAgIHByb3BzLmh0bWxDYWNoZVBvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kodGhpcywgXCJIdG1sQ2FjaGVQb2xpY3lcIiwge1xuICAgICAgICBjb21tZW50OiBcIkZhY2VUaGVvcnkgSFRNTCBjYWNoZSBwb2xpY3kga2V5ZWQgYnkgcXVlcnkgc3RyaW5ncyBhbmQgc3RhYmxlIHB1YmxpYyB2YXJpYW50IGhlYWRlcnNcIixcbiAgICAgICAgbWluVHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBkZWZhdWx0VHRsOiBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICBtYXhUdGw6IER1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuQ2FjaGVDb29raWVCZWhhdmlvci5ub25lKCksXG4gICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlSGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KC4uLmh0bWxDYWNoZUtleUhlYWRlcnMpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250LkNhY2hlUXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgZW5hYmxlQWNjZXB0RW5jb2RpbmdCcm90bGk6IHRydWUsXG4gICAgICAgIGVuYWJsZUFjY2VwdEVuY29kaW5nR3ppcDogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgYXNzZXJ0Tm9Db25mbGljdGluZ0JlaGF2aW9yUGF0dGVybnMoXCJkaXJlY3QgUzMgcGF0aHNcIiwgW2Ake2Fzc2V0c0tleVByZWZpeH0vKmAsIC4uLmRpcmVjdFMzUGF0aFBhdHRlcm5zXSwgYmVoYXZpb3JQYXR0ZXJuT3duZXJzKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcInN0YXRpYyBIVE1MIHBhdGhzXCIsIHN0YXRpY1BhdGhQYXR0ZXJucywgYmVoYXZpb3JQYXR0ZXJuT3duZXJzKTtcbiAgICBhc3NlcnROb0NvbmZsaWN0aW5nQmVoYXZpb3JQYXR0ZXJucyhcImRpcmVjdCBTU1IgcGF0aHNcIiwgc3NyUGF0aFBhdHRlcm5zLCBiZWhhdmlvclBhdHRlcm5Pd25lcnMpO1xuXG4gICAgY29uc3Qgdmlld2VyUmVxdWVzdEZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25cIiwge1xuICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShcbiAgICAgICAgZ2VuZXJhdGVTc3JWaWV3ZXJSZXF1ZXN0RnVuY3Rpb25Db2RlKFxuICAgICAgICAgIHNpdGVNb2RlLFxuICAgICAgICAgIFtgJHthc3NldHNLZXlQcmVmaXh9LypgLCAuLi5kaXJlY3RTM1BhdGhQYXR0ZXJuc10sXG4gICAgICAgICAgc3NyUGF0aFBhdHRlcm5zLFxuICAgICAgICAgIGJsb2NrZWRWaWV3ZXJUZW5hbnRIZWFkZXJzLFxuICAgICAgICApLFxuICAgICAgKSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgIGNvbW1lbnQ6XG4gICAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgICAgPyBcIkZhY2VUaGVvcnkgdmlld2VyLXJlcXVlc3QgZWRnZSBjb250ZXh0IGFuZCBIVE1MIHJld3JpdGUgZm9yIFNTUiBzaXRlXCJcbiAgICAgICAgICA6IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVxdWVzdCBlZGdlIGNvbnRleHQgZm9yIFNTUiBzaXRlXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCB2aWV3ZXJSZXNwb25zZUZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uXCIsIHtcbiAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoZ2VuZXJhdGVTc3JWaWV3ZXJSZXNwb25zZUZ1bmN0aW9uQ29kZSgpKSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgIGNvbW1lbnQ6IFwiRmFjZVRoZW9yeSB2aWV3ZXItcmVzcG9uc2UgcmVxdWVzdC1pZCBlY2hvIGZvciBTU1Igc2l0ZVwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zID0gKCk6IGNsb3VkZnJvbnQuRnVuY3Rpb25Bc3NvY2lhdGlvbltdID0+IFtcbiAgICAgIHtcbiAgICAgICAgZnVuY3Rpb246IHZpZXdlclJlcXVlc3RGdW5jdGlvbixcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgZnVuY3Rpb246IHZpZXdlclJlc3BvbnNlRnVuY3Rpb24sXG4gICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVTUE9OU0UsXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpO1xuXG4gICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuICAgIGxldCBkaXN0cmlidXRpb25Eb21haW5OYW1lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG4gICAgICBjb25zdCBjZXJ0QXJuID0gU3RyaW5nKHByb3BzLmNlcnRpZmljYXRlQXJuID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmIChjZXJ0QXJuKSB7XG4gICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkNlcnRpZmljYXRlXCIsIGNlcnRBcm4pO1xuICAgICAgfSBlbHNlIGlmIChwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5EbnNWYWxpZGF0ZWRDZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgIGhvc3RlZFpvbmU6IHByb3BzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgcmVnaW9uOiBcInVzLWVhc3QtMVwiLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVNzclNpdGUgcmVxdWlyZXMgcHJvcHMuY2VydGlmaWNhdGVBcm4gb3IgcHJvcHMuaG9zdGVkWm9uZSB3aGVuIHByb3BzLmRvbWFpbk5hbWUgaXMgc2V0XCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgIHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgbmV3IGNsb3VkZnJvbnQuUmVzcG9uc2VIZWFkZXJzUG9saWN5KHRoaXMsIFwiUmVzcG9uc2VIZWFkZXJzUG9saWN5XCIsIHtcbiAgICAgICAgY29tbWVudDogXCJGYWNlVGhlb3J5IGJhc2VsaW5lIHNlY3VyaXR5IGhlYWRlcnMgKENTUCBzdGF5cyBvcmlnaW4tZGVmaW5lZClcIixcbiAgICAgICAgc2VjdXJpdHlIZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICBzdHJpY3RUcmFuc3BvcnRTZWN1cml0eToge1xuICAgICAgICAgICAgYWNjZXNzQ29udHJvbE1heEFnZTogRHVyYXRpb24uZGF5cygzNjUgKiAyKSxcbiAgICAgICAgICAgIGluY2x1ZGVTdWJkb21haW5zOiB0cnVlLFxuICAgICAgICAgICAgcHJlbG9hZDogdHJ1ZSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgY29udGVudFR5cGVPcHRpb25zOiB7IG92ZXJyaWRlOiB0cnVlIH0sXG4gICAgICAgICAgZnJhbWVPcHRpb25zOiB7XG4gICAgICAgICAgICBmcmFtZU9wdGlvbjogY2xvdWRmcm9udC5IZWFkZXJzRnJhbWVPcHRpb24uREVOWSxcbiAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IHtcbiAgICAgICAgICAgIHJlZmVycmVyUG9saWN5OiBjbG91ZGZyb250LkhlYWRlcnNSZWZlcnJlclBvbGljeS5TVFJJQ1RfT1JJR0lOX1dIRU5fQ1JPU1NfT1JJR0lOLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB4c3NQcm90ZWN0aW9uOiB7XG4gICAgICAgICAgICBwcm90ZWN0aW9uOiB0cnVlLFxuICAgICAgICAgICAgbW9kZUJsb2NrOiB0cnVlLFxuICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgY3VzdG9tSGVhZGVyc0JlaGF2aW9yOiB7XG4gICAgICAgICAgY3VzdG9tSGVhZGVyczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBoZWFkZXI6IFwicGVybWlzc2lvbnMtcG9saWN5XCIsXG4gICAgICAgICAgICAgIHZhbHVlOiBcImNhbWVyYT0oKSwgbWljcm9waG9uZT0oKSwgZ2VvbG9jYXRpb249KClcIixcbiAgICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZVN0YXRpY0JlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IGFzc2V0c09yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LlVTRV9PUklHSU5fQ0FDSEVfQ09OVFJPTF9IRUFERVJTLFxuICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZVN0YXRpY0h0bWxCZWhhdmlvciA9ICgpOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9PiAoe1xuICAgICAgb3JpZ2luOiBodG1sT3JpZ2luLFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgY2FjaGVQb2xpY3k6IGh0bWxDYWNoZVBvbGljeSxcbiAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGh0bWxPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHRoaXMucmVzcG9uc2VIZWFkZXJzUG9saWN5LFxuICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IGNyZWF0ZUVkZ2VGdW5jdGlvbkFzc29jaWF0aW9ucygpLFxuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZVNzckJlaGF2aW9yID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IHNzck9yaWdpbixcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgY2FjaGVQb2xpY3k6IHNzckNhY2hlUG9saWN5LFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogc3NyT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogY3JlYXRlRWRnZUZ1bmN0aW9uQXNzb2NpYXRpb25zKCksXG4gICAgfSk7XG5cbiAgICBjb25zdCBhZGRpdGlvbmFsQmVoYXZpb3JzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucz4gPSB7fTtcbiAgICBjb25zdCBhZGRFeHBhbmRlZEJlaGF2aW9yID0gKHBhdHRlcm5zOiBzdHJpbmdbXSwgZmFjdG9yeTogKCkgPT4gY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMpOiB2b2lkID0+IHtcbiAgICAgIGZvciAoY29uc3QgcGF0dGVybiBvZiBleHBhbmRCZWhhdmlvclBhdGhQYXR0ZXJucyhwYXR0ZXJucykpIHtcbiAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1twYXR0ZXJuXSA9IGZhY3RvcnkoKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihbYCR7YXNzZXRzS2V5UHJlZml4fS8qYF0sIGNyZWF0ZVN0YXRpY0JlaGF2aW9yKTtcbiAgICBhZGRFeHBhbmRlZEJlaGF2aW9yKGRpcmVjdFMzUGF0aFBhdHRlcm5zLCBjcmVhdGVTdGF0aWNCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihzdGF0aWNQYXRoUGF0dGVybnMsIGNyZWF0ZVN0YXRpY0h0bWxCZWhhdmlvcik7XG4gICAgYWRkRXhwYW5kZWRCZWhhdmlvcihzc3JQYXRoUGF0dGVybnMsIGNyZWF0ZVNzckJlaGF2aW9yKTtcblxuICAgIGNvbnN0IGRlZmF1bHRPcmlnaW4gPVxuICAgICAgc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1JcbiAgICAgICAgPyBuZXcgb3JpZ2lucy5PcmlnaW5Hcm91cCh7XG4gICAgICAgICAgICBwcmltYXJ5T3JpZ2luOiBodG1sT3JpZ2luLFxuICAgICAgICAgICAgZmFsbGJhY2tPcmlnaW46IHNzck9yaWdpbixcbiAgICAgICAgICAgIGZhbGxiYWNrU3RhdHVzQ29kZXM6IFs0MDMsIDQwNF0sXG4gICAgICAgICAgfSlcbiAgICAgICAgOiBzc3JPcmlnaW47XG4gICAgY29uc3QgZGVmYXVsdEFsbG93ZWRNZXRob2RzID1cbiAgICAgIHNpdGVNb2RlID09PSBBcHBUaGVvcnlTc3JTaXRlTW9kZS5TU0dfSVNSXG4gICAgICAgID8gY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TXG4gICAgICAgIDogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEw7XG5cbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICAuLi4oZW5hYmxlTG9nZ2luZyAmJiB0aGlzLmxvZ3NCdWNrZXRcbiAgICAgICAgPyB7IGVuYWJsZUxvZ2dpbmc6IHRydWUsIGxvZ0J1Y2tldDogdGhpcy5sb2dzQnVja2V0LCBsb2dGaWxlUHJlZml4OiBcImNsb3VkZnJvbnQvXCIgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICA/IHsgZG9tYWluTmFtZXM6IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIGRlZmF1bHRCZWhhdmlvcjoge1xuICAgICAgICBvcmlnaW46IGRlZmF1bHRPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogZGVmYXVsdEFsbG93ZWRNZXRob2RzLFxuICAgICAgICBjYWNoZVBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sQ2FjaGVQb2xpY3kgOiBzc3JDYWNoZVBvbGljeSxcbiAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogc2l0ZU1vZGUgPT09IEFwcFRoZW9yeVNzclNpdGVNb2RlLlNTR19JU1IgPyBodG1sT3JpZ2luUmVxdWVzdFBvbGljeSA6IHNzck9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogdGhpcy5yZXNwb25zZUhlYWRlcnNQb2xpY3ksXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBjcmVhdGVFZGdlRnVuY3Rpb25Bc3NvY2lhdGlvbnMoKSxcbiAgICAgIH0sXG4gICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICB9KTtcblxuICAgIGlmIChzc3JVcmxBdXRoVHlwZSA9PT0gbGFtYmRhLkZ1bmN0aW9uVXJsQXV0aFR5cGUuQVdTX0lBTSkge1xuICAgICAgcHJvcHMuc3NyRnVuY3Rpb24uYWRkUGVybWlzc2lvbihcIkFsbG93Q2xvdWRGcm9udEludm9rZUZ1bmN0aW9uVmlhVXJsXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLFxuICAgICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImNsb3VkZnJvbnQuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgc291cmNlQXJuOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Bcm4sXG4gICAgICAgIGludm9rZWRWaWFGdW5jdGlvblVybDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmh0bWxTdG9yZUJ1Y2tldCkge1xuICAgICAgdGhpcy5odG1sU3RvcmVCdWNrZXQuZ3JhbnRSZWFkV3JpdGUocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmlzck1ldGFkYXRhVGFibGUpIHtcbiAgICAgIHRoaXMuaXNyTWV0YWRhdGFUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuc3NyRnVuY3Rpb24pO1xuICAgIH1cblxuICAgIGlmICh3aXJlUnVudGltZUVudikge1xuICAgICAgdGhpcy5hc3NldHNCdWNrZXQuZ3JhbnRSZWFkKHByb3BzLnNzckZ1bmN0aW9uKTtcblxuICAgICAgY29uc3Qgc3NyRnVuY3Rpb25BbnkgPSBwcm9wcy5zc3JGdW5jdGlvbiBhcyBhbnk7XG4gICAgICBpZiAodHlwZW9mIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5U3NyU2l0ZSB3aXJlUnVudGltZUVudiByZXF1aXJlcyBwcm9wcy5zc3JGdW5jdGlvbiB0byBzdXBwb3J0IGFkZEVudmlyb25tZW50OyBwYXNzIGEgbGFtYmRhLkZ1bmN0aW9uIG9yIHNldCB3aXJlUnVudGltZUVudj1mYWxzZSBhbmQgc2V0IGVudiB2YXJzIG1hbnVhbGx5XCIsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiQVBQVEhFT1JZX0FTU0VUU19CVUNLRVRcIiwgdGhpcy5hc3NldHNCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfUFJFRklYXCIsIGFzc2V0c0tleVByZWZpeCk7XG4gICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9BU1NFVFNfTUFOSUZFU1RfS0VZXCIsIGFzc2V0c01hbmlmZXN0S2V5KTtcblxuICAgICAgaWYgKHRoaXMuaHRtbFN0b3JlQnVja2V0ICYmIHRoaXMuaHRtbFN0b3JlS2V5UHJlZml4KSB7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9JU1JfQlVDS0VUXCIsIHRoaXMuaHRtbFN0b3JlQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgICBzc3JGdW5jdGlvbkFueS5hZGRFbnZpcm9ubWVudChcIkZBQ0VUSEVPUllfSVNSX1BSRUZJWFwiLCB0aGlzLmh0bWxTdG9yZUtleVByZWZpeCk7XG4gICAgICB9XG4gICAgICBpZiAoaXNyTWV0YWRhdGFUYWJsZU5hbWUpIHtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfQ0FDSEVfVEFCTEVfTkFNRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICAgIHNzckZ1bmN0aW9uQW55LmFkZEVudmlyb25tZW50KFwiRkFDRVRIRU9SWV9DQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRV9OQU1FXCIsIGlzck1ldGFkYXRhVGFibGVOYW1lKTtcbiAgICAgICAgc3NyRnVuY3Rpb25BbnkuYWRkRW52aXJvbm1lbnQoXCJDQUNIRV9UQUJMRVwiLCBpc3JNZXRhZGF0YVRhYmxlTmFtZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRvbWFpbk5hbWUgJiYgcHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogZG9tYWluTmFtZSxcbiAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gIH1cbn1cbiJdfQ==