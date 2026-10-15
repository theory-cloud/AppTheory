import { Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { AppTheoryMcpRouteAlgebra } from "./mcp-route-algebra";
import { generateRestV1ChallengeRestorationHandlerCode } from "./private/rest-v1-challenge-restoration-handler";

/** Metadata key recorded on the distribution for the challenge-restoration contract. */
const CHALLENGE_RESTORATION_METADATA_KEY = "apptheory:rest-v1-challenge-restoration";

/** Contract id recorded in the distribution metadata marker. */
const CHALLENGE_RESTORATION_CONTRACT_ID = "m17.rest-v1-challenge-restoration/v1";

/**
 * The manifest constant for the AWS REST v1 remap artifact.
 *
 * AWS API Gateway REST API v1 remaps the origin's `WWW-Authenticate` response
 * header onto this header, so it is the restore source that does not depend on
 * any optional bridge.
 */
const REMAP_SOURCE_HEADER = "x-amzn-remapped-www-authenticate";

/**
 * The optional alias bridge spellings, consulted only when the alias bridge is
 * enabled, in priority order after the remap artifact.
 */
const ALIAS_SOURCE_HEADERS = ["x-theory-www-authenticate", "mcp-www-authenticate"];

/**
 * The default REST v1 transport-failure message.
 *
 * The restoration is a documented no-op on HTTP API v2, so a non-REST-v1 origin
 * fails synth rather than silently degrading.
 */
const NON_REST_V1_ORIGIN_MESSAGE =
  "AppTheoryRestV1ChallengeRestoration: origin must be an AWS API Gateway REST API (v1); " +
  "the WWW-Authenticate restoration is a documented no-op on HTTP API v2";

/** The origin-lock header this construct injects on any request it sends to the origin. */
const DEFAULT_ORIGIN_LOCK_HEADER = "x-apptheory-origin-lock";

/**
 * The origin-lock secret alphabet.
 *
 * The value is a literal CloudFront origin custom header value (CloudFront
 * custom origin headers carry plain strings, not template intrinsics), so the
 * secret is restricted to a header-value-safe alphabet with no whitespace and no
 * control characters.
 */
const ORIGIN_LOCK_SECRET_PATTERN = /^[A-Za-z0-9._~-]{32,128}$/;

/** The origin-lock header name alphabet. */
const ORIGIN_LOCK_HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Header names CloudFront reserves or that would rewrite the origin request
 * contract, so they can never carry the origin lock.
 */
const RESERVED_ORIGIN_LOCK_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "transfer-encoding",
  "www-authenticate",
  "x-forwarded-for",
]);

/**
 * The DD-2 direct-origin reachability decision for a REST v1 origin.
 *
 * DD-2 (`DEFENSE_IN_DEPTH.md`) requires the deployment to **record** whether the
 * `execute-api` default endpoint is directly reachable and, when it is, to make
 * that posture explicit. A directly reachable origin (`direct`) is **not**
 * allowed: it is not a member of this enum and the construct refuses it at
 * synthesis.
 */
export enum AppTheoryRestV1OriginReachability {
  /**
   * The REST API's `execute-api` default endpoint is disabled
   * (`disableExecuteApiEndpoint`), so the API is not reachable at its default
   * endpoint.
   *
   * Because the construct fronts an external `IRestApi` it cannot mutate, the
   * caller must assert the disablement with
   * `disableExecuteApiEndpointAsserted: true`.
   *
   * Note the platform shape: the disabled hostname is exactly the
   * `<restApiId>.execute-api.<region>.<urlSuffix>` hostname this construct uses
   * as its origin, so an app that disables the default endpoint must front its
   * REST API through a custom domain (AWS requires a custom domain once the
   * default endpoint is disabled). `LOCKED` is the posture for a REST v1 origin
   * this construct is expected to serve.
   */
  DISABLED = "disabled",
  /**
   * The origin is reachable only through this construct's CloudFront front door.
   *
   * Requires `originLock` carrying the origin-lock secret the construct injects
   * as a custom origin header, plus the caller's assertion that the REST API
   * verifies that header (the construct cannot attach an origin-side
   * verification to an external `IRestApi`).
   */
  LOCKED = "locked",
}

/**
 * The origin lock for `originReachability: LOCKED`.
 *
 * The construct injects `secret` as the `headerName` custom origin header on
 * **every** request it sends to the REST v1 origin, so an origin-side
 * verification can refuse a request that did not come through this
 * distribution. The construct fronts an external `IRestApi`, so it cannot attach
 * that verification itself: the caller asserts it with `asserted: true`.
 */
export interface AppTheoryRestV1OriginLockOptions {
  /**
   * The literal secret injected as the origin-lock header on every CloudFront
   * request to the origin.
   *
   * 32 to 128 characters of `[A-Za-z0-9._~-]`. The value is a literal CloudFront
   * origin custom header value, so it appears verbatim in the synthesized
   * template and must not be (or contain) a credential you cannot rotate with the
   * REST API's verification.
   */
  readonly secret: string;

  /**
   * The origin-lock header name.
   *
   * 1 to 64 characters of `[A-Za-z0-9-]`, and never a name CloudFront reserves or
   * that rewrites the origin request contract (`Host`, `Authorization`,
   * `Cookie`, `Content-Length`, `Transfer-Encoding`, `Connection`,
   * `WWW-Authenticate`, `X-Forwarded-For`, or any `x-amz-*`, `x-amzn-*`, or
   * `cloudfront-*` name).
   *
   * @default "x-apptheory-origin-lock"
   */
  readonly headerName?: string;

  /**
   * The caller's assertion that the REST API verifies the origin lock.
   *
   * This construct cannot attach a resource policy, authorizer, or any other
   * origin-side verification to an external `IRestApi` it does not own, so it
   * refuses to synthesize until the caller records that the verification exists
   * and requires the injected header. Must be `true`.
   */
  readonly asserted: boolean;
}

/**
 * Options for the optional challenge alias bridge.
 */
export interface AppTheoryChallengeAliasBridgeOptions {
  /**
   * Enables the optional challenge alias bridge.
   *
   * When enabled the restoration consults the bridge aliases
   * (`x-theory-www-authenticate`, then `mcp-www-authenticate`) after the AWS
   * REST v1 remap artifact. When disabled only the remap artifact is consulted
   * and the alias spellings never appear in the deployed function source.
   *
   * @default false
   */
  readonly enabled?: boolean;
}

/**
 * Properties for `AppTheoryRestV1ChallengeRestoration`.
 */
export interface AppTheoryRestV1ChallengeRestorationProps {
  /**
   * The REST API v1 origin whose `WWW-Authenticate` responses must be restored.
   *
   * Only an AWS API Gateway REST API v1 (a non-empty `restApiId` and a non-empty
   * `restApiRootResourceId`) is accepted; the restoration is a documented no-op
   * on HTTP API v2.
   */
  readonly origin: apigw.IRestApi;

  /**
   * The mandatory DD-2 direct-origin reachability decision.
   *
   * Required. `DISABLED` and `LOCKED` synthesize; anything else — in particular a
   * directly reachable origin — fails synthesis with an error that names the
   * rejected decision.
   */
  readonly originReachability: AppTheoryRestV1OriginReachability;

  /**
   * The caller's assertion that the REST API's `disableExecuteApiEndpoint` is
   * set, required with `originReachability: DISABLED`.
   *
   * This construct fronts an external `IRestApi` it cannot mutate, so it cannot
   * set the property for the caller; it requires the assertion instead and
   * records it in the distribution metadata.
   */
  readonly disableExecuteApiEndpointAsserted?: boolean;

  /**
   * The mandatory origin lock, required with `originReachability: LOCKED`.
   */
  readonly originLock?: AppTheoryRestV1OriginLockOptions;

  /**
   * MCP resource paths whose derived routes receive an explicit ordered cache
   * behavior.
   *
   * The effective route set is derived from the shared route algebra, never
   * hand-wired. A supplied-but-empty array is treated as the default.
   *
   * @default the standard MCP patterns from the shared route algebra
   * (`AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().mcpPattern`)
   */
  readonly resourcePaths?: string[];

  /**
   * Optional challenge alias bridge.
   *
   * @default disabled
   */
  readonly aliasBridge?: AppTheoryChallengeAliasBridgeOptions;

  /**
   * Optional custom domain names for the distribution.
   *
   * When set, `certificate` is required.
   */
  readonly domainNames?: string[];

  /**
   * Certificate for `domainNames`. Required when `domainNames` is set.
   */
  readonly certificate?: acm.ICertificate;

  /**
   * Optional CloudFront price class.
   */
  readonly priceClass?: cloudfront.PriceClass;
}

/**
 * A framework CloudFront front door that restores the canonical
 * `WWW-Authenticate` challenge for an AWS API Gateway REST API v1 origin.
 *
 * AWS REST API v1 remaps the origin's `WWW-Authenticate` response header onto
 * `x-amzn-remapped-www-authenticate`, so a canonical-only app loses the
 * challenge at the edge. This construct fronts the REST v1 `execute-api` origin
 * with a CloudFront distribution whose origin-response Lambda@Edge function
 * copies the first present source back onto `WWW-Authenticate` and removes the
 * consumed source headers.
 *
 * The restore **source set**, in priority order, is:
 *
 * 1. `x-amzn-remapped-www-authenticate` — the artifact AWS itself produces when
 *    REST v1 remaps the origin header. Always consulted.
 * 2. the bridge aliases `x-theory-www-authenticate`, then
 *    `mcp-www-authenticate` — consulted only when the optional alias bridge is
 *    enabled (off by default).
 *
 * ## The direct-endpoint caveat (DD-2)
 *
 * A CloudFront front door does **not** by itself make the origin unreachable.
 * The REST API keeps answering at its own
 * `<restApiId>.execute-api.<region>.<urlSuffix>` endpoint, which is exactly the
 * origin this distribution uses, so a client that skips the distribution still
 * reaches the origin and observes a **challenge-less `401`** for a REST v1
 * canonical-only app — the restoration never runs, and any edge-only control
 * (throttling at the edge, edge observability, the alias bridge) is bypassed on
 * that path. Authentication itself is unaffected: the runtime bearer gate still
 * refuses the request at the origin, so this is challenge loss and edge bypass,
 * not an authentication bypass.
 *
 * `originReachability` is therefore **required** (DD-2's mandatory
 * direct-origin decision):
 *
 * - `DISABLED` — the REST API's `execute-api` default endpoint is disabled. The
 *   caller asserts it (`disableExecuteApiEndpointAsserted: true`) because this
 *   construct cannot mutate an external `IRestApi`. The construct does not
 *   verify the assertion, and the disabled hostname is the distribution's own
 *   origin hostname, so an app that disables the default endpoint must front the
 *   origin through a custom domain.
 * - `LOCKED` — the origin is reachable only through this distribution. The
 *   construct injects `originLock.secret` as a custom origin header on every
 *   request to the origin, and the caller asserts
 *   (`originLock.asserted: true`) that the REST API verifies that header; the
 *   construct cannot attach the verification to an external `IRestApi`.
 *
 * A directly reachable origin (`direct`) is refused at synthesis. The decision
 * is recorded in the distribution's CloudFormation metadata
 * (`apptheory:rest-v1-challenge-restoration`), so the posture is auditable from
 * the synthesized template.
 *
 * The derived route set and the explicit ordered cache behaviors come from the
 * shared route algebra (`AppTheoryMcpRouteAlgebra`), so the construct is never
 * hand-wired. Parameterized derived routes (those carrying a `{parameter}`
 * segment) cannot be expressed as CloudFront path patterns and are therefore
 * covered by the distribution's default behavior.
 */
export class AppTheoryRestV1ChallengeRestoration extends Construct {
  /** The CloudFront distribution fronting the REST v1 origin. */
  public readonly distribution: cloudfront.Distribution;

  /**
   * The response headers the restoration function consults, in priority order.
   *
   * `["x-amzn-remapped-www-authenticate"]` when the alias bridge is disabled;
   * `["x-amzn-remapped-www-authenticate", "x-theory-www-authenticate",
   * "mcp-www-authenticate"]` when it is enabled.
   */
  public readonly restoreSourceHeaders: string[];

  /** True when the optional alias bridge is enabled. */
  public readonly aliasBridgeEnabled: boolean;

  /** The recorded DD-2 direct-origin reachability decision. */
  public readonly originReachability: AppTheoryRestV1OriginReachability;

  /**
   * The origin-lock header name injected on every request to the origin, or
   * `undefined` when the decision is `DISABLED`.
   */
  public readonly originLockHeaderName?: string;

  /**
   * The complete route set derived from the shared route algebra (parameterized
   * routes included), deduped and in deterministic sorted order.
   */
  public readonly derivedRoutePaths: string[];

  /**
   * The subset of `derivedRoutePaths` emitted as explicit ordered cache
   * behaviors (the literal paths, with no `{parameter}` segment).
   *
   * CloudFront path patterns cannot express a `{param}` segment, so
   * parameterized derived routes are covered by the default behavior.
   */
  public readonly behaviorPathPatterns: string[];

  public constructor(
    scope: Construct,
    id: string,
    props: AppTheoryRestV1ChallengeRestorationProps,
  ) {
    super(scope, id);

    const origin = (props as { origin?: apigw.IRestApi }).origin;
    assertRestV1Origin(origin);

    const reachability = resolveOriginReachability(props);
    this.originReachability = reachability.decision;
    this.originLockHeaderName = reachability.lockHeaderName;

    if (
      props.domainNames !== undefined &&
      props.domainNames.length > 0 &&
      props.certificate === undefined
    ) {
      throw new Error(
        "AppTheoryRestV1ChallengeRestoration: domainNames requires certificate",
      );
    }

    this.aliasBridgeEnabled = props.aliasBridge?.enabled === true;
    this.restoreSourceHeaders = this.aliasBridgeEnabled
      ? [REMAP_SOURCE_HEADER, ...ALIAS_SOURCE_HEADERS]
      : [REMAP_SOURCE_HEADER];

    const derivedRoutePaths = deriveRoutePaths(props.resourcePaths);
    if (derivedRoutePaths.length === 0) {
      throw new Error(
        "AppTheoryRestV1ChallengeRestoration: the route model derived no routes from resourcePaths",
      );
    }
    this.derivedRoutePaths = derivedRoutePaths;
    this.behaviorPathPatterns = derivedRoutePaths.filter(
      (pathPattern) => !pathPattern.includes("{") && !pathPattern.includes("}"),
    );

    const restOrigin = buildRestV1Origin(this, origin, reachability);

    const restorationFunction = new cloudfront.experimental.EdgeFunction(
      this,
      "ChallengeRestorationFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromInline(
          generateRestV1ChallengeRestorationHandlerCode(this.restoreSourceHeaders),
        ),
        description:
          "Restore the canonical WWW-Authenticate challenge for AppTheory REST v1 origin responses",
      },
    );

    // CDK's OriginRequestHeaderBehavior has no `allViewerExceptHostHeader`
    // builder and refuses `Authorization` in an allow list, so the managed
    // ALL_VIEWER_EXCEPT_HOST_HEADER policy is expressed the way AWS implements
    // it: `allExcept` with only `Host` denied. Every viewer header (the
    // `Authorization` header above all) is forwarded, and CloudFront still
    // presents the execute-api origin host.
    //
    // Under LOCKED the origin-lock header is denied to the viewer as well, so a
    // viewer-supplied copy of the lock header is stripped at the edge and the
    // CloudFront-injected origin custom header is the only copy that reaches the
    // origin through this distribution.
    //
    // All cookies and all query strings are forwarded as well, exactly as the
    // managed policy does: the derived OAuth routes carry their parameters in
    // the query string (the per-kind `.../authorize` route and the callback's
    // `?code=...&state=...`), so dropping the query string would break the
    // front channel, and a cookie-carried session must reach the origin
    // unchanged.
    const deniedViewerHeaders = [
      "Host",
      ...(this.originLockHeaderName !== undefined ? [this.originLockHeaderName] : []),
    ];
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      "OriginRequestPolicy",
      {
        comment:
          "AppTheory REST v1 challenge restoration: forward all viewer headers except Host and any origin-lock header, all cookies and all query strings",
        headerBehavior:
          cloudfront.OriginRequestHeaderBehavior.denyList(...deniedViewerHeaders),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      },
    );

    const edgeLambdas: cloudfront.EdgeLambda[] = [
      {
        eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
        functionVersion: restorationFunction.currentVersion,
      },
    ];
    const behaviorOptions = (): cloudfront.BehaviorOptions => ({
      origin: restOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      edgeLambdas,
    });

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    for (const pathPattern of this.behaviorPathPatterns) {
      additionalBehaviors[pathPattern] = behaviorOptions();
    }

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: behaviorOptions(),
      additionalBehaviors,
      ...(props.domainNames !== undefined &&
      props.domainNames.length > 0 &&
      props.certificate !== undefined
        ? { domainNames: props.domainNames, certificate: props.certificate }
        : {}),
      ...(props.priceClass !== undefined ? { priceClass: props.priceClass } : {}),
    });

    const cfnDistribution = this.distribution.node
      .defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addMetadata(CHALLENGE_RESTORATION_METADATA_KEY, {
      contractId: CHALLENGE_RESTORATION_CONTRACT_ID,
      aliasBridge: this.aliasBridgeEnabled,
      sourceHeaders: this.restoreSourceHeaders,
      routeCount: this.derivedRoutePaths.length,
      originReachability: this.originReachability,
      ...(this.originLockHeaderName !== undefined
        ? { originLockHeader: this.originLockHeaderName }
        : { disableExecuteApiEndpointAsserted: true }),
    });
  }
}

/** The resolved DD-2 decision, with the origin-lock material when LOCKED. */
interface OriginReachabilityDecision {
  readonly decision: AppTheoryRestV1OriginReachability;
  readonly lockHeaderName?: string;
  readonly lockSecret?: string;
}

/** Renders a rejected decision for an error message without assuming its type. */
function describeDecision(decision: unknown): string {
  return typeof decision === "string" ? JSON.stringify(decision) : String(decision);
}

/**
 * Resolves and validates the mandatory DD-2 direct-origin reachability decision.
 *
 * Fails closed at synthesis on a missing or `direct` decision, on a `DISABLED`
 * decision without the caller's disablement assertion, on a `LOCKED` decision
 * without a complete origin lock, and on contradictory props.
 */
function resolveOriginReachability(
  props: AppTheoryRestV1ChallengeRestorationProps,
): OriginReachabilityDecision {
  const decision = props.originReachability;
  if (
    decision !== AppTheoryRestV1OriginReachability.DISABLED &&
    decision !== AppTheoryRestV1OriginReachability.LOCKED
  ) {
    throw new Error(
      "AppTheoryRestV1ChallengeRestoration: originReachability is required and must be " +
        "AppTheoryRestV1OriginReachability.DISABLED or .LOCKED (DD-2); a directly reachable " +
        `origin ('direct') is not allowed (received ${describeDecision(decision)}). ` +
        "The REST API's execute-api endpoint is the origin this distribution uses, so a client that " +
        "bypasses the distribution still reaches it and observes a challenge-less 401: record how that " +
        "endpoint is made unreachable (DISABLED) or reached only through this distribution (LOCKED)",
    );
  }

  if (decision === AppTheoryRestV1OriginReachability.DISABLED) {
    if (props.originLock !== undefined) {
      throw new Error(
        "AppTheoryRestV1ChallengeRestoration: originLock is only valid with originReachability " +
          "AppTheoryRestV1OriginReachability.LOCKED",
      );
    }
    if (props.disableExecuteApiEndpointAsserted !== true) {
      throw new Error(
        "AppTheoryRestV1ChallengeRestoration: originReachability DISABLED requires " +
          "disableExecuteApiEndpointAsserted: true; this construct fronts an external IRestApi it " +
          "cannot mutate, so the caller must assert that the REST API's disableExecuteApiEndpoint is set",
      );
    }
    return { decision };
  }

  if (props.disableExecuteApiEndpointAsserted !== undefined) {
    throw new Error(
      "AppTheoryRestV1ChallengeRestoration: disableExecuteApiEndpointAsserted is only valid with " +
        "originReachability AppTheoryRestV1OriginReachability.DISABLED",
    );
  }

  const lock = props.originLock;
  if (lock === undefined) {
    throw new Error(
      "AppTheoryRestV1ChallengeRestoration: originReachability LOCKED requires originLock " +
        "({ secret, asserted: true }) carrying the origin-lock material and the caller's assertion that " +
        "the REST API verifies it",
    );
  }
  if (lock.asserted !== true) {
    throw new Error(
      "AppTheoryRestV1ChallengeRestoration: originReachability LOCKED requires originLock.asserted: true " +
        "(the caller asserts the REST API verifies the origin-lock header this distribution injects); " +
        "this construct cannot attach the verification to an external IRestApi",
    );
  }
  if (typeof lock.secret !== "string" || !ORIGIN_LOCK_SECRET_PATTERN.test(lock.secret)) {
    throw new Error(
      "AppTheoryRestV1ChallengeRestoration: originLock.secret must be 32..128 characters of " +
        "[A-Za-z0-9._~-] (a literal CloudFront origin custom header value: no whitespace, no control " +
        "characters, no template intrinsics)",
    );
  }

  const headerName = lock.headerName ?? DEFAULT_ORIGIN_LOCK_HEADER;
  if (!ORIGIN_LOCK_HEADER_NAME_PATTERN.test(headerName)) {
    throw new Error(
      "AppTheoryRestV1ChallengeRestoration: originLock.headerName must be 1..64 characters of [A-Za-z0-9-]",
    );
  }
  const normalizedHeaderName = headerName.toLowerCase();
  if (
    RESERVED_ORIGIN_LOCK_HEADERS.has(normalizedHeaderName) ||
    normalizedHeaderName.startsWith("x-amz-") ||
    normalizedHeaderName.startsWith("x-amzn-") ||
    normalizedHeaderName.startsWith("cloudfront-")
  ) {
    throw new Error(
      `AppTheoryRestV1ChallengeRestoration: originLock.headerName "${headerName}" is reserved by CloudFront or the origin request contract and cannot carry the origin lock`,
    );
  }

  return { decision, lockHeaderName: headerName, lockSecret: lock.secret };
}

/** Fails closed unless the origin is an AWS API Gateway REST API v1. */
function assertRestV1Origin(
  origin: apigw.IRestApi | undefined,
): asserts origin is apigw.IRestApi {
  if (
    origin === undefined ||
    typeof origin.restApiId !== "string" ||
    origin.restApiId.length === 0 ||
    typeof origin.restApiRootResourceId !== "string" ||
    origin.restApiRootResourceId.length === 0
  ) {
    throw new Error(NON_REST_V1_ORIGIN_MESSAGE);
  }
}

/**
 * Builds the HTTPS-only `execute-api` origin for an AWS API Gateway REST API v1,
 * carrying the origin-lock header when the decision is `LOCKED`.
 *
 * `cloudfront-origins`' `RestApiOrigin` accepts a `RestApiBase` (it reads the
 * concrete `url` token), not the `IRestApi` this construct takes, and `IRestApi`
 * exposes neither `url` nor `urlForPath`. The execute-api origin is therefore
 * built from `restApiId`, the stack region and URL suffix, and the deployment
 * stage's origin path.
 */
function buildRestV1Origin(
  scope: Construct,
  origin: apigw.IRestApi,
  reachability: OriginReachabilityDecision,
): origins.HttpOrigin {
  const stack = Stack.of(scope);
  const originDomainName = `${origin.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
  const stageName = origin.deploymentStage?.stageName;
  return new origins.HttpOrigin(originDomainName, {
    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    ...(stageName ? { originPath: `/${stageName}` } : {}),
    ...(reachability.lockHeaderName !== undefined && reachability.lockSecret !== undefined
      ? { customHeaders: { [reachability.lockHeaderName]: reachability.lockSecret } }
      : {}),
  });
}

/**
 * Derives the complete deduped, sorted route set for the effective resource
 * paths using only the shared route algebra (never hand-wired).
 */
function deriveRoutePaths(configuredResourcePaths?: string[]): string[] {
  const effectiveResourcePaths =
    configuredResourcePaths !== undefined && configuredResourcePaths.length > 0
      ? configuredResourcePaths
      : AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().map(
          (template) => template.mcpPattern,
        );

  const derivations: Array<(resourcePath: string) => string> = [
    (resourcePath) => resourcePath,
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(resourcePath),
  ];

  const derived = new Set<string>();
  for (const resourcePath of effectiveResourcePaths) {
    for (const derive of derivations) {
      try {
        derived.add(derive(resourcePath));
      } catch (error) {
        throw new Error(
          `AppTheoryRestV1ChallengeRestoration: resourcePaths entry "${resourcePath}" is not a route the route model can derive: ${errorMessage(error)}`,
        );
      }
    }
  }

  // The upstream OAuth callback is stage-global, so it is derived exactly once
  // rather than per resource path. The contract default is always derivable.
  derived.add(
    AppTheoryMcpRouteAlgebra.callbackPathForConfiguredPath(
      AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH,
    ),
  );

  return Array.from(derived).sort();
}

/** Returns a thrown value's message without assuming it is an Error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
