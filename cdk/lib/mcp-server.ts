import { RemovalPolicy, Stack, Token } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

import { AppTheoryMcpRouteAlgebra } from "./mcp-route-algebra";

const DEFAULT_THROTTLING_RATE_LIMIT = 100;
const DEFAULT_THROTTLING_BURST_LIMIT = 200;
const DEFAULT_SESSION_TTL_MINUTES = 60;

/** Custom domain configuration for an AppTheory-owned MCP HTTP API. */
export interface AppTheoryMcpServerDomainOptions {
  /** The custom domain name (for example, `mcp.example.com`). */
  readonly domainName: string;

  /** ACM certificate for the domain. Provide this or `certificateArn`. */
  readonly certificate?: acm.ICertificate;

  /** ACM certificate ARN. Provide this or `certificate`. */
  readonly certificateArn?: string;

  /**
   * Route53 hosted zone for an automatically created CNAME record.
   * @default undefined
   */
  readonly hostedZone?: route53.IHostedZone;
}

/** Stage configuration for an AppTheory-owned MCP HTTP API. */
export interface AppTheoryMcpServerStageOptions {
  /** @default "$default" */
  readonly stageName?: string;

  /** @default true */
  readonly accessLogging?: boolean;

  /**
   * Retention period for the access log group. Valid only when access logging
   * is enabled.
   * @default logs.RetentionDays.ONE_MONTH
   */
  readonly accessLogRetention?: logs.RetentionDays;

  /** @default true */
  readonly throttlingEnabled?: boolean;

  /**
   * Default-stage rate limit in requests per second.
   * @default 100
   */
  readonly throttlingRateLimit?: number;

  /**
   * Default-stage burst limit.
   * @default 200
   */
  readonly throttlingBurstLimit?: number;
}

/** Owned-API specialization for standalone MCP servers. */
export interface AppTheoryMcpServerOwnedApiOptions {
  /** Optional API name. */
  readonly apiName?: string;

  /** Optional custom domain owned by this construct. */
  readonly domain?: AppTheoryMcpServerDomainOptions;

  /**
   * Stage configuration. Access logging and throttling default on.
   * @default production defaults
   */
  readonly stage?: AppTheoryMcpServerStageOptions;
}

/** Ordered MCP route-pattern family wired as one facade. */
export interface AppTheoryMcpRouteFamily {
  /**
   * Ordered synthesis-time MCP route patterns.
   *
   * Each segment is either a literal RFC 3986 path segment or a complete
   * `{parameter_name}` segment. CDK tokens, origins, empty segments, dot
   * segments, greedy parameters, and duplicate patterns are rejected.
   */
  readonly patterns: string[];

  /**
   * Wire the algebra-derived unscoped authorization-server discovery route.
   * The runtime must supply `FacadeConfig.RootAuthorizationServer` too.
   * @default false
   */
  readonly rootAuthorizationServerDiscovery?: boolean;
}

/** DynamoDB-backed MCP session-state configuration. */
export interface AppTheoryMcpSessionStateOptions {
  /** @default true */
  readonly enabled?: boolean;

  /**
   * Session table name. Valid only when session state is enabled.
   * @default auto-generated
   */
  readonly tableName?: string;

  /**
   * TTL in minutes for session records. Valid only when session state is
   * enabled.
   * @default 60
   */
  readonly ttlMinutes?: number;

  /**
   * Session table removal policy. Valid only when session state is enabled.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
}

/** One derived MCP OAuth facade route family. */
export interface AppTheoryMcpServerFacadeRoute {
  readonly mcpPattern: string;
  readonly mcpMethods: string[];
  readonly protectedResourcePattern: string;
  readonly discoveryCanonicalPattern: string;
  readonly discoverySuffixPattern: string;
  readonly authorizePattern: string;
  readonly tokenPattern: string;
  readonly authorizationRoutesAttached: boolean;
}

/** Defensive snapshot of the construct's derived facade inventory. */
export interface AppTheoryMcpServerRouteInventory {
  readonly contractVersion: string;
  readonly routes: AppTheoryMcpServerFacadeRoute[];
  readonly rootAuthorizationServerPattern: string;
  readonly rootAuthorizationServerAttached: boolean;
}

/** Props for the AppTheoryMcpServer construct. */
export interface AppTheoryMcpServerProps {
  /** Lambda function handling the runtime-composed MCP facade. */
  readonly handler: lambda.IFunction;

  /**
   * Existing HTTP API to attach to. Attach mode is the primary front-door
   * topology and never creates an `AWS::ApiGatewayV2::Api` resource.
   * @default a construct-owned HttpApi
   */
  readonly api?: apigwv2.IHttpApi;

  /**
   * Ordered MCP route family.
   *
   * Go `runtime/mcpfacade.RegisterMCPFacade` serves only the canonical default
   * family. Noncanonical patterns require app-owned runtime route registration
   * that matches the construct's `routeInventory`.
   * @default AppTheoryMcpRouteAlgebra.supportedEndpointTemplates()
   */
  readonly routeFamily?: AppTheoryMcpRouteFamily;

  /**
   * Explicitly opt out of the OAuth facade and wire only MCP transport routes.
   * This cannot be combined with legacy authorization props or root discovery.
   * `runtime/mcpfacade.RegisterMCPFacade` always installs the authenticated
   * canonical facade, so applications using this opt-out must own runtime
   * registration for the transport routes.
   * @default false
   */
  readonly unauthenticatedMcp?: boolean;

  /**
   * Session-state table configuration. The table defaults on.
   * @default enabled with production defaults
   */
  readonly sessionState?: AppTheoryMcpSessionStateOptions;

  /**
   * Owned-API configuration for standalone mode. Invalid with `api`.
   * @default production-owned API defaults
   */
  readonly ownedApi?: AppTheoryMcpServerOwnedApiOptions;

  /**
   * Single MCP route path from the v3.1.x A6 surface.
   * @deprecated Use `routeFamily.patterns`. The new default is the canonical
   * four-pattern family; use `{ patterns: ['/mcp'] }` for the old singleton.
   */
  readonly mcpPath?: string;

  /**
   * Authorization-server issuer from the v3.1.x A6 environment contract.
   * @deprecated Configure `runtime/mcpfacade.FacadeConfig.IssuerURL` in the
   * application. The construct no longer injects issuer environment values.
   */
  readonly authorizationServerIssuer?: string;

  /**
   * JWKS URI from the v3.1.x A6 environment contract.
   * @deprecated Configure `runtime/mcpfacade.FacadeConfig.JWKSURI` in the
   * application. The construct no longer injects JWKS environment values.
   */
  readonly jwksUri?: string;

  /** @deprecated Use `ownedApi.apiName`. */
  readonly apiName?: string;

  /**
   * @deprecated Use `sessionState.enabled`. Session state now defaults on.
   */
  readonly enableSessionTable?: boolean;

  /** @deprecated Use `sessionState.tableName`. */
  readonly sessionTableName?: string;

  /** @deprecated Use `sessionState.ttlMinutes`. */
  readonly sessionTtlMinutes?: number;

  /**
   * @deprecated Use `ownedApi.domain`. Domains are invalid in attach mode.
   */
  readonly domain?: AppTheoryMcpServerDomainOptions;

  /**
   * @deprecated Use `ownedApi.stage`. Stage options are invalid in attach mode.
   */
  readonly stage?: AppTheoryMcpServerStageOptions;
}

/**
 * Contract-first MCP facade deployment construct.
 *
 * The primary mode attaches the complete route-algebra family to a supplied
 * HTTP API. Omitting `api` specializes the same path into a standalone owned
 * API. The construct routes only: OAuth metadata, scopes, capabilities, and
 * authorize/token behavior remain application-owned through Go
 * `mcpfacade.RegisterMCPFacade`.
 */
export class AppTheoryMcpServer extends Construct {
  private routeSequence = 0;

  public readonly api: apigwv2.IHttpApi;
  public readonly ownedApi?: apigwv2.HttpApi;
  public readonly sessionTable?: dynamodb.ITable;
  public readonly endpoints: string[];
  public readonly mcpPaths: string[];
  public readonly protectedResourceMetadataPaths: string[];
  public readonly routeInventory: AppTheoryMcpServerRouteInventory;

  /** @deprecated Use `endpoints`. */
  public readonly endpoint: string;

  /** @deprecated Use `mcpPaths`. */
  public readonly mcpPath: string;

  /** @deprecated Use `protectedResourceMetadataPaths` or `routeInventory`. */
  public readonly protectedResourceMetadataPath: string;

  public readonly domainName?: apigwv2.DomainName;
  public readonly apiMapping?: apigwv2.ApiMapping;
  public readonly cnameRecord?: route53.CnameRecord;
  public readonly accessLogGroup?: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: AppTheoryMcpServerProps) {
    super(scope, id);

    validateOwningMode(props);
    normalizeLegacyAuthConfig(props);
    const routeFamily = normalizeRouteFamily(props);
    const unauthenticatedMcp = props.unauthenticatedMcp ?? false;
    if (
      unauthenticatedMcp
      && (props.authorizationServerIssuer !== undefined || props.jwksUri !== undefined)
    ) {
      throw new Error(
        "AppTheoryMcpServer: unauthenticatedMcp cannot be combined with authorizationServerIssuer or jwksUri",
      );
    }
    if (unauthenticatedMcp && routeFamily.rootAuthorizationServerDiscovery) {
      throw new Error(
        "AppTheoryMcpServer: unauthenticatedMcp cannot enable rootAuthorizationServerDiscovery",
      );
    }

    this.mcpPaths = [...routeFamily.patterns];
    this.routeInventory = buildRouteInventory(
      this.mcpPaths,
      !unauthenticatedMcp,
      routeFamily.rootAuthorizationServerDiscovery,
    );
    validateRouteInventory(this.routeInventory, unauthenticatedMcp);
    this.protectedResourceMetadataPaths = this.routeInventory.routes.map(
      (route) => route.protectedResourcePattern,
    );
    this.mcpPath = this.mcpPaths[0];
    this.protectedResourceMetadataPath = this.protectedResourceMetadataPaths[0];

    const ownedOptions = normalizeOwnedApiOptions(props);
    let ownedStage: apigwv2.IStage | undefined;
    let ownedStageName = "$default";
    if (props.api) {
      this.api = props.api;
    } else {
      const stageOptions = normalizeStageOptions(ownedOptions.stage);
      ownedStageName = stageOptions.stageName;
      const api = new apigwv2.HttpApi(this, "Api", {
        apiName: ownedOptions.apiName,
        createDefaultStage: false,
      });
      (this as { ownedApi?: apigwv2.HttpApi }).ownedApi = api;
      this.api = api;

      const stage = new apigwv2.HttpStage(this, "Stage", {
        httpApi: api,
        stageName: stageOptions.stageName,
        autoDeploy: true,
        throttle: stageOptions.throttlingEnabled
          ? {
            rateLimit: stageOptions.throttlingRateLimit,
            burstLimit: stageOptions.throttlingBurstLimit,
          }
          : undefined,
      });
      ownedStage = stage;

      if (stageOptions.accessLogging) {
        const logGroup = new logs.LogGroup(this, "AccessLogs", {
          retention: stageOptions.accessLogRetention,
        });
        (this as { accessLogGroup?: logs.ILogGroup }).accessLogGroup = logGroup;
        const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
        cfnStage.accessLogSettings = {
          destinationArn: logGroup.logGroupArn,
          format: accessLogFormat(),
        };
      }
    }

    const integration = new apigwv2Integrations.HttpLambdaIntegration(
      "McpHandler",
      props.handler,
      { payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0 },
    );
    const runtimeOwnedAuth = new apigwv2.HttpNoneAuthorizer();
    for (const route of this.routeInventory.routes) {
      for (const method of route.mcpMethods) {
        this.addRuntimeRoute(route.mcpPattern, toHttpMethod(method), integration, runtimeOwnedAuth);
      }
      if (!unauthenticatedMcp) {
        this.addRuntimeRoute(route.protectedResourcePattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
        this.addRuntimeRoute(route.discoveryCanonicalPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
        this.addRuntimeRoute(route.discoverySuffixPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
        this.addRuntimeRoute(route.authorizePattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
        this.addRuntimeRoute(route.tokenPattern, apigwv2.HttpMethod.POST, integration, runtimeOwnedAuth);
      }
    }
    if (this.routeInventory.rootAuthorizationServerAttached) {
      this.addRuntimeRoute(
        this.routeInventory.rootAuthorizationServerPattern,
        apigwv2.HttpMethod.GET,
        integration,
        runtimeOwnedAuth,
      );
    }

    const sessionState = normalizeSessionState(props);
    if (sessionState.enabled) {
      const table = new dynamodb.Table(this, "SessionTable", {
        tableName: sessionState.tableName,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
        timeToLiveAttribute: "expiresAt",
        removalPolicy: sessionState.removalPolicy,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
      });
      table.grantReadWriteData(props.handler);
      this.sessionTable = table;
      this.addEnvironment(props.handler, "MCP_SESSION_TABLE", table.tableName);
      this.addEnvironment(props.handler, "MCP_SESSION_TTL_MINUTES", String(sessionState.ttlMinutes));
    }

    let endpointBase: string;
    if (ownedOptions.domain) {
      if (!ownedStage) {
        throw new Error("AppTheoryMcpServer: domain configuration requires construct-owned API mode");
      }
      this.setupCustomDomain(ownedOptions.domain, ownedStage);
      endpointBase = `https://${ownedOptions.domain.domainName}`;
    } else if (props.api) {
      const stack = Stack.of(this);
      endpointBase = `https://${this.api.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
    } else {
      endpointBase = ownedStageName === "$default"
        ? this.api.apiEndpoint
        : `${this.api.apiEndpoint}/${ownedStageName}`;
    }
    this.endpoints = this.mcpPaths.map(
      (pattern) => `${stripTrailingSlash(endpointBase)}${pattern}`,
    );
    this.endpoint = this.endpoints[0];

    // Attach-mode public authority belongs to the front door. Do not smuggle
    // it into this construct as an origin prop.
    if (!props.api) {
      this.addEnvironment(props.handler, "MCP_ENDPOINT", this.endpoint);
    }
  }

  private addRuntimeRoute(
    path: string,
    method: apigwv2.HttpMethod,
    integration: apigwv2Integrations.HttpLambdaIntegration,
    authorizer: apigwv2.HttpNoneAuthorizer,
  ): void {
    new apigwv2.HttpRoute(this, `Route${this.routeSequence++}`, {
      httpApi: this.api,
      routeKey: apigwv2.HttpRouteKey.with(path, method),
      integration,
      authorizer,
    });
  }

  private addEnvironment(handler: lambda.IFunction, key: string, value: string): void {
    if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
      handler.addEnvironment(key, value);
    }
  }

  private setupCustomDomain(
    options: AppTheoryMcpServerDomainOptions,
    stage: apigwv2.IStage,
  ): void {
    const certificate = options.certificate ?? (options.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "ImportedCert", options.certificateArn) as acm.ICertificate
      : undefined);
    if (!certificate) {
      throw new Error(
        "AppTheoryMcpServer: ownedApi.domain requires either certificate or certificateArn",
      );
    }
    const domainName = new apigwv2.DomainName(this, "DomainName", {
      domainName: options.domainName,
      certificate,
    });
    (this as { domainName?: apigwv2.DomainName }).domainName = domainName;
    const apiMapping = new apigwv2.ApiMapping(this, "ApiMapping", {
      api: this.api,
      domainName,
      stage,
    });
    (this as { apiMapping?: apigwv2.ApiMapping }).apiMapping = apiMapping;
    if (options.hostedZone) {
      const cnameRecord = new route53.CnameRecord(this, "CnameRecord", {
        zone: options.hostedZone,
        recordName: toRoute53RecordName(options.domainName, options.hostedZone),
        domainName: domainName.regionalDomainName,
      });
      (this as { cnameRecord?: route53.CnameRecord }).cnameRecord = cnameRecord;
    }
  }
}

interface NormalizedRouteFamily {
  readonly patterns: string[];
  readonly rootAuthorizationServerDiscovery: boolean;
}

interface NormalizedOwnedApiOptions {
  readonly apiName?: string;
  readonly domain?: AppTheoryMcpServerDomainOptions;
  readonly stage?: AppTheoryMcpServerStageOptions;
}

interface NormalizedStageOptions {
  readonly stageName: string;
  readonly accessLogging: boolean;
  readonly accessLogRetention: logs.RetentionDays;
  readonly throttlingEnabled: boolean;
  readonly throttlingRateLimit: number;
  readonly throttlingBurstLimit: number;
}

interface NormalizedSessionState {
  readonly enabled: boolean;
  readonly tableName?: string;
  readonly ttlMinutes: number;
  readonly removalPolicy: RemovalPolicy;
}

function normalizeRouteFamily(props: AppTheoryMcpServerProps): NormalizedRouteFamily {
  if (props.routeFamily !== undefined && props.mcpPath !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: routeFamily and deprecated mcpPath cannot be supplied together",
    );
  }
  const rawPatterns = props.routeFamily?.patterns
    ?? (props.mcpPath !== undefined
      ? [props.mcpPath]
      : AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().map(
        (template) => template.mcpPattern,
      ));
  if (rawPatterns.length === 0) {
    throw new Error("AppTheoryMcpServer: routeFamily.patterns must not be empty");
  }
  const patterns = rawPatterns.map((pattern, index) =>
    normalizeRoutePath(pattern, `routeFamily.patterns[${index}]`));
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (seen.has(pattern)) {
      throw new Error(
        `AppTheoryMcpServer: routeFamily.patterns contains duplicate pattern ${JSON.stringify(pattern)}`,
      );
    }
    seen.add(pattern);
  }
  return {
    patterns,
    rootAuthorizationServerDiscovery:
      props.routeFamily?.rootAuthorizationServerDiscovery ?? false,
  };
}

function normalizeRoutePath(value: string, propName: string): string {
  if (Token.isUnresolved(value)) {
    throw new Error(
      `AppTheoryMcpServer: ${propName} must be a synthesis-time literal route pattern`,
    );
  }
  const routePath = String(value ?? "");
  if (!routePath.startsWith("/")) throw invalidRoutePattern(propName);
  const segments = routePath.slice(1).split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "")) {
    throw invalidRoutePattern(propName);
  }
  const literal = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/;
  const parameter = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw invalidRoutePattern(propName);
    if (parameter.test(segment)) continue;
    if (!literal.test(segment) || segment.includes("{") || segment.includes("}")) {
      throw invalidRoutePattern(propName);
    }
  }
  return routePath;
}

function invalidRoutePattern(propName: string): Error {
  return new Error(
    `AppTheoryMcpServer: ${propName} must be an absolute synthesis-time route pattern with non-empty literal or {parameter_name} segments and no dot segments`,
  );
}

function buildRouteInventory(
  patterns: string[],
  authorizationRoutesAttached: boolean,
  rootAuthorizationServerAttached: boolean,
): AppTheoryMcpServerRouteInventory {
  return {
    contractVersion: AppTheoryMcpRouteAlgebra.CONTRACT_VERSION,
    routes: patterns.map((mcpPattern) => ({
      mcpPattern,
      mcpMethods: ["POST", "GET", "DELETE"],
      protectedResourcePattern:
        AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(mcpPattern),
      discoveryCanonicalPattern:
        AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(mcpPattern),
      discoverySuffixPattern:
        AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(mcpPattern),
      authorizePattern:
        AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(mcpPattern),
      tokenPattern:
        AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(mcpPattern),
      authorizationRoutesAttached,
    })),
    rootAuthorizationServerPattern:
      AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath("/"),
    rootAuthorizationServerAttached,
  };
}

function validateRouteInventory(
  inventory: AppTheoryMcpServerRouteInventory,
  unauthenticatedMcp: boolean,
): void {
  const seen = new Set<string>();
  const add = (method: string, path: string): void => {
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      throw new Error(`AppTheoryMcpServer: derived route family collides at ${key}`);
    }
    seen.add(key);
  };
  for (const route of inventory.routes) {
    for (const method of route.mcpMethods) add(method, route.mcpPattern);
    if (!unauthenticatedMcp) {
      add("GET", route.protectedResourcePattern);
      add("GET", route.discoveryCanonicalPattern);
      add("GET", route.discoverySuffixPattern);
      add("GET", route.authorizePattern);
      add("POST", route.tokenPattern);
    }
  }
  if (inventory.rootAuthorizationServerAttached) {
    add("GET", inventory.rootAuthorizationServerPattern);
  }
}

function validateOwningMode(props: AppTheoryMcpServerProps): void {
  if (!props.api) return;
  const invalid: string[] = [];
  if (props.ownedApi !== undefined) invalid.push("ownedApi");
  if (props.apiName !== undefined) invalid.push("apiName");
  if (props.domain !== undefined) invalid.push("domain");
  if (props.stage !== undefined) invalid.push("stage");
  if (invalid.length !== 0) {
    throw new Error(
      `AppTheoryMcpServer: attach mode with api cannot configure owned-API props: ${invalid.join(", ")}`,
    );
  }
}

function normalizeOwnedApiOptions(props: AppTheoryMcpServerProps): NormalizedOwnedApiOptions {
  if (props.ownedApi?.apiName !== undefined && props.apiName !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.apiName and deprecated apiName cannot be supplied together",
    );
  }
  if (props.ownedApi?.domain !== undefined && props.domain !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.domain and deprecated domain cannot be supplied together",
    );
  }
  if (props.ownedApi?.stage !== undefined && props.stage !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.stage and deprecated stage cannot be supplied together",
    );
  }
  return {
    apiName: props.ownedApi?.apiName ?? props.apiName,
    domain: props.ownedApi?.domain ?? props.domain,
    stage: props.ownedApi?.stage ?? props.stage,
  };
}

function normalizeStageOptions(options?: AppTheoryMcpServerStageOptions): NormalizedStageOptions {
  const accessLogging = options?.accessLogging ?? true;
  if (!accessLogging && options?.accessLogRetention !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.stage.accessLogRetention requires accessLogging to be enabled",
    );
  }
  const throttlingEnabled = options?.throttlingEnabled ?? true;
  if (
    !throttlingEnabled
    && (options?.throttlingRateLimit !== undefined || options?.throttlingBurstLimit !== undefined)
  ) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.stage throttling limits require throttlingEnabled to be true",
    );
  }
  const rateLimit = options?.throttlingRateLimit ?? DEFAULT_THROTTLING_RATE_LIMIT;
  const burstLimit = options?.throttlingBurstLimit ?? DEFAULT_THROTTLING_BURST_LIMIT;
  validatePositiveNumber(rateLimit, "ownedApi.stage.throttlingRateLimit");
  validatePositiveNumber(burstLimit, "ownedApi.stage.throttlingBurstLimit");
  return {
    stageName: options?.stageName ?? "$default",
    accessLogging,
    accessLogRetention: options?.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
    throttlingEnabled,
    throttlingRateLimit: rateLimit,
    throttlingBurstLimit: burstLimit,
  };
}

function normalizeSessionState(props: AppTheoryMcpServerProps): NormalizedSessionState {
  const hasLegacy = props.enableSessionTable !== undefined
    || props.sessionTableName !== undefined
    || props.sessionTtlMinutes !== undefined;
  if (props.sessionState !== undefined && hasLegacy) {
    throw new Error(
      "AppTheoryMcpServer: sessionState cannot be combined with deprecated session-table props",
    );
  }
  const enabled = props.sessionState?.enabled ?? props.enableSessionTable ?? true;
  const tableName = props.sessionState?.tableName ?? props.sessionTableName;
  const ttlMinutes = props.sessionState?.ttlMinutes
    ?? props.sessionTtlMinutes
    ?? DEFAULT_SESSION_TTL_MINUTES;
  const removalPolicy = props.sessionState?.removalPolicy ?? RemovalPolicy.RETAIN;
  if (
    !enabled
    && (tableName !== undefined
      || props.sessionState?.ttlMinutes !== undefined
      || props.sessionState?.removalPolicy !== undefined
      || props.sessionTableName !== undefined
      || props.sessionTtlMinutes !== undefined)
  ) {
    throw new Error(
      "AppTheoryMcpServer: disabled session state cannot configure tableName, ttlMinutes, or removalPolicy",
    );
  }
  validatePositiveInteger(ttlMinutes, "sessionState.ttlMinutes");
  return { enabled, tableName, ttlMinutes, removalPolicy };
}

function normalizeLegacyAuthConfig(props: AppTheoryMcpServerProps): void {
  const hasIssuer = props.authorizationServerIssuer !== undefined;
  const hasJwksUri = props.jwksUri !== undefined;
  if (hasIssuer !== hasJwksUri) {
    throw new Error(
      "AppTheoryMcpServer: authorizationServerIssuer and jwksUri must be supplied together",
    );
  }
  if (!hasIssuer || !hasJwksUri) return;
  const issuer = String(props.authorizationServerIssuer);
  const jwksUri = String(props.jwksUri);
  if (!Token.isUnresolved(issuer)) {
    validateLiteralOAuthURL(
      issuer,
      false,
      "authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment",
    );
  }
  if (!Token.isUnresolved(jwksUri)) {
    validateLiteralOAuthURL(
      jwksUri,
      true,
      "jwksUri must be an absolute HTTPS URL with no userinfo or fragment",
    );
  }
}

function validateLiteralOAuthURL(value: string, allowQuery: boolean, message: string): void {
  const literal = value.trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(literal);
  } catch {
    // The shared validation error below is the public synthesis contract.
  }
  if (
    !parsed
    || !literalURLHasRFC3986Authority(literal)
    || parsed.protocol !== "https:"
    || !parsed.hostname
    || parsed.username !== ""
    || parsed.password !== ""
    || literalURLAuthorityHasUserinfo(literal)
    || (!allowQuery && literal.includes("?"))
    || literal.includes("#")
  ) {
    throw new Error(`AppTheoryMcpServer: ${message}`);
  }
}

function toHttpMethod(method: string): apigwv2.HttpMethod {
  switch (method) {
    case "POST": return apigwv2.HttpMethod.POST;
    case "GET": return apigwv2.HttpMethod.GET;
    case "DELETE": return apigwv2.HttpMethod.DELETE;
    default:
      throw new Error(`AppTheoryMcpServer: unsupported runtime MCP method ${method}`);
  }
}

function validatePositiveNumber(value: number, propName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`AppTheoryMcpServer: ${propName} must be greater than zero`);
  }
}

function validatePositiveInteger(value: number, propName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`AppTheoryMcpServer: ${propName} must be a positive integer`);
  }
}

function accessLogFormat(): string {
  return JSON.stringify({
    requestId: "$context.requestId",
    ip: "$context.identity.sourceIp",
    requestTime: "$context.requestTime",
    httpMethod: "$context.httpMethod",
    routeKey: "$context.routeKey",
    status: "$context.status",
    protocol: "$context.protocol",
    responseLength: "$context.responseLength",
    integrationLatency: "$context.integrationLatency",
  });
}

function toRoute53RecordName(domainName: string, zone: route53.IHostedZone): string {
  const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
  const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
  if (!zoneName) return fqdn;
  if (fqdn === zoneName) return "";
  const suffix = `.${zoneName}`;
  return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function literalURLHasRFC3986Authority(value: string): boolean {
  const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1];
  return authority !== undefined && !authority.includes("%");
}

function literalURLAuthorityHasUserinfo(value: string): boolean {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
  return authority?.includes("@") ?? false;
}
