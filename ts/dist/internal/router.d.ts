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
export interface Match<THandler> {
    handler: THandler;
    params: Record<string, string>;
    authRequired: boolean;
}
export declare class Router<THandler> {
    private readonly _routes;
    addStrict(method: string, pattern: string, handler: THandler, options?: RouteOptions): void;
    add(method: string, pattern: string, handler: THandler, options?: RouteOptions): void;
    match(method: string, path: string): {
        match: {
            route: Route<THandler>;
            params: Record<string, string>;
        } | null;
        allowed: string[];
    };
}
export {};
