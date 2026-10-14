import { Buffer } from "node:buffer";
import {
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/**
 * A dependency-free fake upstream OAuth provider for adapter conformance runs.
 * It serves an RFC 8414 discovery document, a JWKS, and a form-encoded token
 * endpoint over loopback HTTP, mints real RS256 compact JWS access tokens from
 * a real RSA key pair, and can be configured to fail, stall, or overshoot the
 * response size cap.
 *
 * A `grant_type=refresh_token` call is answered by `refreshTokenStatus` and
 * `refreshTokenBody` when configured and by the ordinary token response
 * otherwise, so the refresh grant can carry its own access token, its own
 * upstream refresh token, and its own id_token and a facade that hides upstream
 * material is observable; `refreshTokenStages` stages the leading refresh
 * responses in call order, so a transient upstream failure that clears is
 * observable too. `refreshCallCount` and `lastRefreshRequest` report the refresh
 * calls separately from the total token requests.
 *
 * This is test support only: it is not part of the runtime surface, it binds
 * loopback, and it holds nothing but throwaway keys.
 */

const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";
const JWKS_PATH = "/.well-known/jwks.json";
const TOKEN_PATH = "/token";
const AUTHORIZATION_PATH = "/oauth/authorize";
const DEFAULT_KID = "fake-provider-key-1";
const OVERSIZED_CHUNK_BYTES = 64 * 1024;
const OVERSIZED_FILL = 0x78;

/**
 * The form value that selects the refresh grant, so the fake can serve that
 * grant a response distinct from the code exchange.
 */
const GRANT_TYPE_REFRESH_TOKEN = "refresh_token";

/** Configuration for one fake upstream provider. */
export interface FakeOAuthProviderOptions {
  /** The issuer the discovery document advertises. */
  issuer?: string;
  /**
   * The base URL the discovery document advertises for its endpoints. It
   * defaults to `issuer`, so a test can pin an HTTPS name the caller's
   * transport bridges to loopback while the document still fails or matches
   * an issuer the adapter was configured with.
   */
  publicBaseUrl?: string;
  kid?: string;
  discoveryPath?: string;
  jwksPath?: string;
  tokenPath?: string;
  authorizationPath?: string;
  /** When set, the discovery request is answered with a redirect to it. */
  discoveryRedirectTo?: string;
  codeChallengeMethodsSupported?: string[];
  authorizationResponseIssParameterSupported?: boolean;
  resourceParameterSupported?: boolean;
  /** Status the token endpoint answers with. Defaults to 200. */
  tokenStatus?: number;
  /** JSON body the token endpoint answers with. */
  tokenBody?: unknown;
  /**
   * Status a `grant_type=refresh_token` call is answered with. Unset means
   * `tokenStatus`, so a caller that configures nothing keeps the
   * single-response behavior it had before.
   */
  refreshTokenStatus?: number;
  /**
   * JSON body a `grant_type=refresh_token` call is answered with. Unset means
   * `tokenBody`. It is how a test gives the refresh grant its own access token,
   * its own upstream refresh token, and its own id_token, so a caller that must
   * hide upstream material is observable.
   */
  refreshTokenBody?: unknown;
  /**
   * Stages the leading `grant_type=refresh_token` responses in call order: the
   * nth refresh call takes the nth stage, and every later call takes the
   * steady-state response above. A stage that omits `status` or `body` falls
   * back to the steady-state value. It exists so a transient upstream failure
   * that clears is observable.
   */
  refreshTokenStages?: FakeRefreshStage[];
  /** When positive, the token endpoint streams a body of this many bytes. */
  tokenBodyBytes?: number;
  /**
   * When positive, the token endpoint answers with a well-formed token document
   * whose `access_token` value is this many bytes long. Unlike `tokenBodyBytes`
   * the body is valid JSON, so a case that expects a failure only while the
   * response cap holds stops failing when the cap is removed.
   */
  tokenBodyPaddingBytes?: number;
  /** When positive, the token endpoint stalls this long before answering. */
  tokenDelaySeconds?: number;
}

/** One staged `grant_type=refresh_token` response. */
export interface FakeRefreshStage {
  /** The HTTP status. Unset means the steady-state refresh status. */
  status?: number;
  /** The JSON body. Unset means the steady-state refresh body. */
  body?: unknown;
}

/** One pre-encoded staged refresh response. */
interface StagedRefreshResponse {
  status: number;
  body: unknown;
}

/** The claims one minted access token carries. */
export interface FakeAccessTokenClaims {
  issuer?: string;
  audience?: string;
  authorizedParty?: string;
  subject?: string;
  scope?: string;
  expiresInSeconds?: number;
  kid?: string;
  /** When true, the minted signature is corrupted after signing. */
  tamperSignature?: boolean;
}

/**
 * What the fake observed on the last token request. Only non-secret shape is
 * retained: codes, refresh material, and PKCE verifiers are reported as
 * presence flags and never kept.
 */
export interface FakeTokenRequest {
  grantType: string;
  clientId: string;
  redirectUri: string;
  hasCode: boolean;
  hasCodeVerifier: boolean;
  hasRefreshToken: boolean;
}

/** A running fake upstream OAuth provider. */
export class FakeOAuthProvider {
  private readonly options: Required<
    Pick<FakeOAuthProviderOptions, "issuer" | "publicBaseUrl" | "kid">
  > &
    FakeOAuthProviderOptions;
  private readonly privateKey: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private server: Server | null = null;
  private loopbackUrl = "";
  private lastToken: FakeTokenRequest | null = null;
  private readonly refreshStatus: number;
  private readonly refreshBody: unknown;
  private readonly refreshStages: StagedRefreshResponse[];
  private refreshCalls = 0;
  private lastRefreshForm: URLSearchParams | null = null;

  constructor(options: FakeOAuthProviderOptions = {}) {
    const issuer = String(options.issuer ?? "https://auth.example.test");
    this.options = {
      ...options,
      issuer,
      publicBaseUrl: String(options.publicBaseUrl ?? issuer),
      kid: String(options.kid ?? DEFAULT_KID),
    };
    // The refresh grant falls back to the ordinary token response, so a caller
    // that configures nothing keeps the single-response behavior it had before.
    const tokenStatus = Number(this.options.tokenStatus ?? 200);
    const refreshStatus = Number(
      this.options.refreshTokenStatus ?? tokenStatus,
    );
    const refreshBody =
      this.options.refreshTokenBody ?? this.options.tokenBody ?? {};
    this.refreshStatus = refreshStatus;
    this.refreshBody = refreshBody;
    this.refreshStages = (this.options.refreshTokenStages ?? []).map(
      (stage) => ({
        status: Number(stage.status ?? refreshStatus),
        body: stage.body ?? refreshBody,
      }),
    );
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    this.privateKey = privateKey;
    this.jwk = {
      ...(publicKey.export({ format: "jwk" }) as unknown as Record<
        string,
        unknown
      >),
      kid: this.options.kid,
      use: "sig",
      alg: "RS256",
    };
  }

  get url(): string {
    return this.loopbackUrl;
  }

  get issuer(): string {
    return this.options.issuer;
  }

  get discoveryPath(): string {
    return String(this.options.discoveryPath ?? DISCOVERY_PATH);
  }

  get jwksPath(): string {
    return String(this.options.jwksPath ?? JWKS_PATH);
  }

  get tokenPath(): string {
    return String(this.options.tokenPath ?? TOKEN_PATH);
  }

  get authorizationPath(): string {
    return String(this.options.authorizationPath ?? AUTHORIZATION_PATH);
  }

  /** Starts the loopback server and returns its base URL. */
  async start(): Promise<string> {
    if (this.server) return this.loopbackUrl;
    const server = createServer((request, response) => {
      this.handleRequest(request, response);
    });
    server.on("clientError", (_error, socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    this.server = server;
    this.loopbackUrl = `http://127.0.0.1:${port}`;
    return this.loopbackUrl;
  }

  /** Stops the loopback server and drops every open connection. */
  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
  }

  /** Mints one real RS256 compact JWS access token. */
  mintAccessToken(claims: FakeAccessTokenClaims = {}): string {
    const kid = String(claims.kid ?? this.options.kid);
    const header = { alg: "RS256", typ: "JWT", kid };
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: String(claims.issuer ?? this.options.publicBaseUrl),
      aud: String(claims.audience ?? this.options.publicBaseUrl),
      sub: String(claims.subject ?? "subject-1"),
      iat: issuedAt,
      exp: issuedAt + Number(claims.expiresInSeconds ?? 900),
    };
    if (claims.authorizedParty !== undefined) {
      payload["azp"] = String(claims.authorizedParty);
    }
    if (claims.scope !== undefined) payload["scope"] = String(claims.scope);
    const signingInput = Buffer.from(
      `${encodeJSONSegment(header)}.${encodeJSONSegment(payload)}`,
      "utf8",
    );
    const signature = signBytes("RSA-SHA256", signingInput, this.privateKey);
    if (claims.tamperSignature === true && signature.length > 0) {
      signature[signature.length - 1] =
        (signature[signature.length - 1] ?? 0) ^ 0xff;
    }
    return `${signingInput.toString("utf8")}.${signature.toString("base64url")}`;
  }

  /** The JWKS document the fake publishes. */
  jwksDocument(): Record<string, unknown> {
    return { keys: [this.jwk] };
  }

  /** The shape of the last token request, or null before the first one. */
  lastTokenRequest(): FakeTokenRequest | null {
    return this.lastToken;
  }

  /**
   * Reports how many `grant_type=refresh_token` requests the fake served,
   * counted separately from the total token request count, so a caller's
   * single-flight rotation is observable.
   */
  refreshCallCount(): number {
    return this.refreshCalls;
  }

  /**
   * A copy of the form the last `grant_type=refresh_token` request presented, so
   * a test can observe the material and client that refresh leg carried. Unlike
   * `lastTokenRequest`, it deliberately retains the presented values: a refresh
   * leg's whole contract is which upstream refresh material it presented.
   */
  lastRefreshRequest(): URLSearchParams {
    return new URLSearchParams(this.lastRefreshForm ?? "");
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === this.discoveryPath) {
      this.handleDiscovery(response);
      return;
    }
    if (url.pathname === this.jwksPath) {
      this.sendJSON(response, 200, this.jwksDocument());
      return;
    }
    if (url.pathname === this.tokenPath) {
      void this.handleToken(request, response);
      return;
    }
    if (url.pathname === this.authorizationPath) {
      this.sendJSON(response, 200, { ok: true });
      return;
    }
    this.sendJSON(response, 404, { error: "not_found" });
  }

  private handleDiscovery(response: ServerResponse): void {
    const redirect = this.options.discoveryRedirectTo;
    if (redirect) {
      response.writeHead(302, { location: String(redirect) });
      response.end();
      return;
    }
    const base = String(this.options.publicBaseUrl ?? "");
    this.sendJSON(response, 200, {
      issuer: this.options.issuer,
      authorization_endpoint: `${base}${this.authorizationPath}`,
      token_endpoint: `${base}${this.tokenPath}`,
      jwks_uri: `${base}${this.jwksPath}`,
      code_challenge_methods_supported: this.options
        .codeChallengeMethodsSupported ?? ["S256"],
      authorization_response_iss_parameter_supported:
        this.options.authorizationResponseIssParameterSupported ?? true,
      resource_parameter_supported:
        this.options.resourceParameterSupported ?? true,
    });
  }

  private async handleToken(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const raw = await readRequestBody(request).catch(() => "");
    const form = new URLSearchParams(raw);
    this.lastToken = {
      grantType: form.get("grant_type") ?? "",
      clientId: form.get("client_id") ?? "",
      redirectUri: form.get("redirect_uri") ?? "",
      hasCode: form.has("code"),
      hasCodeVerifier: form.has("code_verifier"),
      hasRefreshToken: form.has("refresh_token"),
    };
    const refreshCall = this.recordRefreshRequest(form);
    const delaySeconds = Number(this.options.tokenDelaySeconds ?? 0);
    if (delaySeconds > 0) {
      await delay(delaySeconds * 1000);
    }
    if (refreshCall > 0) {
      const staged = this.refreshResponseFor(refreshCall);
      this.sendJSON(response, staged.status, staged.body);
      return;
    }
    const oversizedBytes = Number(this.options.tokenBodyBytes ?? 0);
    if (oversizedBytes > 0) {
      this.sendOversized(response, oversizedBytes);
      return;
    }
    const paddingBytes = Number(this.options.tokenBodyPaddingBytes ?? 0);
    if (paddingBytes > 0) {
      this.sendJSON(response, Number(this.options.tokenStatus ?? 200), {
        access_token: "a".repeat(paddingBytes),
        token_type: "Bearer",
        expires_in: 900,
      });
      return;
    }
    this.sendJSON(
      response,
      Number(this.options.tokenStatus ?? 200),
      this.options.tokenBody ?? {},
    );
  }

  /**
   * Counts one `grant_type=refresh_token` request and records its form,
   * returning the one-based index of that refresh call, or zero for any other
   * grant, so the caller can select a staged refresh response.
   */
  private recordRefreshRequest(form: URLSearchParams): number {
    if (form.get("grant_type") !== GRANT_TYPE_REFRESH_TOKEN) {
      return 0;
    }
    this.refreshCalls += 1;
    this.lastRefreshForm = new URLSearchParams(form);
    return this.refreshCalls;
  }

  /**
   * Returns the staged or steady-state response of the nth
   * `grant_type=refresh_token` call (one-based).
   */
  private refreshResponseFor(call: number): StagedRefreshResponse {
    const index = call - 1;
    if (index >= 0 && index < this.refreshStages.length) {
      const staged = this.refreshStages[index];
      if (staged !== undefined) {
        return staged;
      }
    }
    return { status: this.refreshStatus, body: this.refreshBody };
  }

  private sendJSON(
    response: ServerResponse,
    status: number,
    body: unknown,
  ): void {
    const payload = JSON.stringify(body ?? {});
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload, "utf8"),
    });
    response.end(payload);
  }

  /**
   * Streams a body larger than the adapter's cap in chunks, so the adapter
   * observes an oversized response while it is still being written and cancels
   * mid-stream. A cancelled response is expected, so write errors are dropped.
   */
  private sendOversized(response: ServerResponse, bytes: number): void {
    response.on("error", () => {});
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": bytes,
    });
    const chunk = Buffer.alloc(OVERSIZED_CHUNK_BYTES, OVERSIZED_FILL);
    let remaining = bytes;
    const pump = (): void => {
      while (remaining > 0) {
        if (response.destroyed || response.writableEnded) return;
        const slice =
          remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        remaining -= slice.length;
        if (!response.write(slice)) {
          response.once("drain", pump);
          return;
        }
      }
      response.end();
    };
    pump();
  }
}

/** Builds a fake upstream OAuth provider. */
export function newFakeOAuthProvider(
  options: FakeOAuthProviderOptions = {},
): FakeOAuthProvider {
  return new FakeOAuthProvider(options);
}

function encodeJSONSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error: Error) => {
      reject(error);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}
