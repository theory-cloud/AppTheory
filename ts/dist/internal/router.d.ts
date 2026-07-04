/** Per-route registration options consumed by the internal router. */
export interface RouteOptions {
    authRequired?: boolean;
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
    /** Registers a route using the fail-closed route-registration path. */
    add(method: string, pattern: string, handler: THandler, options?: RouteOptions): void;
    /** Matches an HTTP method and path against registered routes. */
    match(method: string, path: string): {
        match: {
            route: Route<THandler>;
            params: Record<string, string>;
        } | null;
        allowed: string[];
    };
}
export {};
//# sourceMappingURL=router.d.ts.map