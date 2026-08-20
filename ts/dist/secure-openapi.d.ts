import type { SecureRoute } from "./app.js";
import { type OpenAPIDocument, type OpenAPIRouteSpec } from "./openapi.js";
/** Document-level secure posture scheme bindings. */
export interface OpenAPIAuthSchemes {
    authenticated: string[];
    internalOnly: string[];
}
/** Exact HTTP description accepted by SecureApp OpenAPI generation. */
export interface SecureOpenAPISpec {
    title: string;
    version: string;
    routes: readonly OpenAPIRouteSpec[];
    securitySchemes: Record<string, Record<string, unknown>>;
    authSchemes: OpenAPIAuthSchemes;
}
export declare function generateSecureOpenAPI(routes: readonly SecureRoute[], spec: SecureOpenAPISpec): OpenAPIDocument;
export declare function generateSecureOpenAPIJSON(routes: readonly SecureRoute[], spec: SecureOpenAPISpec): string;
//# sourceMappingURL=secure-openapi.d.ts.map