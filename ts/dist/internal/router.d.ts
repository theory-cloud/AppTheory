/** Per-route registration options consumed by the internal router. */
export interface RouteOptions {
    authRequired?: boolean;
}
/** Private metadata carried only by SecureApp registrations. */
export interface SecureRouteMetadata {
    surface: "http" | "appsync";
    posture: "public" | "optional" | "authenticated" | "authenticated_any_of" | "internal_only";
    scopes: string[];
    posturePresent: boolean;
}
interface ParsedRouteSegment {
    kind: "static" | "param" | "proxy";
    value: string;
}
interface Route<THandler> {
    method: string;
    pattern: string;
    segments: ParsedRouteSegment[];
    handler: THandler;
    authRequired: boolean;
    secure: SecureRouteMetadata | null;
    staticCount: number;
    paramCount: number;
    hasProxy: boolean;
    order: number;
}
/** Resolved route match including handler, params, and auth flag. */
export interface Match<THandler> {
    handler: THandler;
    params: Record<string, string>;
    authRequired: boolean;
}
/** Fail-closed HTTP route matcher used by the AppTheory runtime. */
export declare class Router<THandler> {
    private readonly _routes;
    /** Registers a route through the deprecated strict compatibility path. */
    addStrict(method: string, pattern: string, handler: THandler, options?: RouteOptions): void;
    /** Registers one posture-bearing secure route. */
    addSecure(method: string, pattern: string, handler: THandler, metadata: SecureRouteMetadata): void;
    /** Registers a route using the fail-closed route-registration path. */
    add(method: string, pattern: string, handler: THandler, options?: RouteOptions): void;
    /** Matches an HTTP method and path against registered routes. */
    match(method: string, path: string, surface?: "http" | "appsync"): {
        match: {
            route: Route<THandler>;
            params: Record<string, string>;
        } | null;
        allowed: string[];
    };
}
export {};
//# sourceMappingURL=router.d.ts.map