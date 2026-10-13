import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as signBytes, } from "node:crypto";
import { createServer, } from "node:http";
/**
 * A dependency-free fake upstream OAuth provider for adapter conformance runs.
 * It serves an RFC 8414 discovery document, a JWKS, and a form-encoded token
 * endpoint over loopback HTTP, mints real RS256 compact JWS access tokens from
 * a real RSA key pair, and can be configured to fail, stall, or overshoot the
 * response size cap.
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
/** A running fake upstream OAuth provider. */
export class FakeOAuthProvider {
    options;
    privateKey;
    jwk;
    server = null;
    loopbackUrl = "";
    lastToken = null;
    constructor(options = {}) {
        const issuer = String(options.issuer ?? "https://auth.example.test");
        this.options = {
            ...options,
            issuer,
            publicBaseUrl: String(options.publicBaseUrl ?? issuer),
            kid: String(options.kid ?? DEFAULT_KID),
        };
        const { privateKey, publicKey } = generateKeyPairSync("rsa", {
            modulusLength: 2048,
        });
        this.privateKey = privateKey;
        this.jwk = {
            ...publicKey.export({ format: "jwk" }),
            kid: this.options.kid,
            use: "sig",
            alg: "RS256",
        };
    }
    get url() {
        return this.loopbackUrl;
    }
    get issuer() {
        return this.options.issuer;
    }
    get discoveryPath() {
        return String(this.options.discoveryPath ?? DISCOVERY_PATH);
    }
    get jwksPath() {
        return String(this.options.jwksPath ?? JWKS_PATH);
    }
    get tokenPath() {
        return String(this.options.tokenPath ?? TOKEN_PATH);
    }
    get authorizationPath() {
        return String(this.options.authorizationPath ?? AUTHORIZATION_PATH);
    }
    /** Starts the loopback server and returns its base URL. */
    async start() {
        if (this.server)
            return this.loopbackUrl;
        const server = createServer((request, response) => {
            this.handleRequest(request, response);
        });
        server.on("clientError", (_error, socket) => {
            socket.destroy();
        });
        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 0;
        this.server = server;
        this.loopbackUrl = `http://127.0.0.1:${port}`;
        return this.loopbackUrl;
    }
    /** Stops the loopback server and drops every open connection. */
    async close() {
        const server = this.server;
        if (!server)
            return;
        this.server = null;
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
            server.closeAllConnections();
        });
    }
    /** Mints one real RS256 compact JWS access token. */
    mintAccessToken(claims = {}) {
        const kid = String(claims.kid ?? this.options.kid);
        const header = { alg: "RS256", typ: "JWT", kid };
        const issuedAt = Math.floor(Date.now() / 1000);
        const payload = {
            iss: String(claims.issuer ?? this.options.publicBaseUrl),
            aud: String(claims.audience ?? this.options.publicBaseUrl),
            sub: String(claims.subject ?? "subject-1"),
            iat: issuedAt,
            exp: issuedAt + Number(claims.expiresInSeconds ?? 900),
        };
        if (claims.authorizedParty !== undefined) {
            payload["azp"] = String(claims.authorizedParty);
        }
        if (claims.scope !== undefined)
            payload["scope"] = String(claims.scope);
        const signingInput = Buffer.from(`${encodeJSONSegment(header)}.${encodeJSONSegment(payload)}`, "utf8");
        const signature = signBytes("RSA-SHA256", signingInput, this.privateKey);
        if (claims.tamperSignature === true && signature.length > 0) {
            signature[signature.length - 1] =
                (signature[signature.length - 1] ?? 0) ^ 0xff;
        }
        return `${signingInput.toString("utf8")}.${signature.toString("base64url")}`;
    }
    /** The JWKS document the fake publishes. */
    jwksDocument() {
        return { keys: [this.jwk] };
    }
    /** The shape of the last token request, or null before the first one. */
    lastTokenRequest() {
        return this.lastToken;
    }
    handleRequest(request, response) {
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
    handleDiscovery(response) {
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
            authorization_response_iss_parameter_supported: this.options.authorizationResponseIssParameterSupported ?? true,
            resource_parameter_supported: this.options.resourceParameterSupported ?? true,
        });
    }
    async handleToken(request, response) {
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
        const delaySeconds = Number(this.options.tokenDelaySeconds ?? 0);
        if (delaySeconds > 0) {
            await delay(delaySeconds * 1000);
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
        this.sendJSON(response, Number(this.options.tokenStatus ?? 200), this.options.tokenBody ?? {});
    }
    sendJSON(response, status, body) {
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
    sendOversized(response, bytes) {
        response.on("error", () => { });
        response.writeHead(200, {
            "content-type": "application/json",
            "content-length": bytes,
        });
        const chunk = Buffer.alloc(OVERSIZED_CHUNK_BYTES, OVERSIZED_FILL);
        let remaining = bytes;
        const pump = () => {
            while (remaining > 0) {
                if (response.destroyed || response.writableEnded)
                    return;
                const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
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
export function newFakeOAuthProvider(options = {}) {
    return new FakeOAuthProvider(options);
}
function encodeJSONSegment(value) {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => {
            chunks.push(chunk);
        });
        request.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        request.on("error", (error) => {
            reject(error);
        });
    });
}
function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === "function")
            timer.unref();
    });
}
//# sourceMappingURL=oauthprovider.js.map