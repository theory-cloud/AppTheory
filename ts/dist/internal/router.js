import { AppTheoryError } from "../errors.js";
import { normalizeMethod, normalizePath, splitPath } from "./http.js";
/** Fail-closed HTTP route matcher used by the AppTheory runtime. */
export class Router {
    _routes = [];
    /** Registers a route through the deprecated strict compatibility path. */
    addStrict(method, pattern, handler, options = {}) {
        if (handler === null || handler === undefined) {
            throw routeRegistrationError("route handler is nil");
        }
        const normalizedMethod = normalizeMethod(method);
        const normalizedPattern = normalizePath(pattern);
        const parsed = parseRouteSegments(splitPath(normalizedPattern));
        if (!parsed.ok) {
            throw routeRegistrationError("invalid route pattern");
        }
        const normalizedPatternValue = parsed.canonicalSegments.length > 0
            ? `/${parsed.canonicalSegments.join("/")}`
            : "/";
        for (const route of this._routes) {
            if (route.method === normalizedMethod &&
                route.pattern === normalizedPatternValue) {
                throw routeRegistrationError("duplicate route");
            }
        }
        this._routes.push({
            method: normalizedMethod,
            pattern: normalizedPatternValue,
            segments: parsed.segments,
            handler,
            authRequired: Boolean(options.authRequired),
            staticCount: parsed.staticCount,
            paramCount: parsed.paramCount,
            hasProxy: parsed.hasProxy,
            order: this._routes.length,
        });
    }
    /** Registers a route using the fail-closed route-registration path. */
    add(method, pattern, handler, options = {}) {
        this.addStrict(method, pattern, handler, options);
    }
    /** Matches an HTTP method and path against registered routes. */
    match(method, path) {
        const normalizedMethod = normalizeMethod(method);
        const pathSegments = splitPath(normalizePath(path));
        const allowed = [];
        let best = null;
        for (const route of this._routes) {
            const params = matchRoute(route.segments, pathSegments);
            if (!params) {
                continue;
            }
            allowed.push(route.method);
            if (route.method === normalizedMethod) {
                if (!best || routeMoreSpecific(route, best.route)) {
                    best = { route, params };
                }
            }
        }
        return { match: best, allowed };
    }
}
function routeRegistrationError(message) {
    return new AppTheoryError("app.bad_request", message, { statusCode: 400 });
}
function parseRouteSegments(rawSegments) {
    const segments = [];
    const canonicalSegments = [];
    let staticCount = 0;
    let paramCount = 0;
    let hasProxy = false;
    for (let i = 0; i < rawSegments.length; i += 1) {
        let raw = String(rawSegments[i] ?? "").trim();
        if (!raw)
            return { ok: false, error: "empty segment" };
        if (raw.startsWith(":") && raw.length > 1) {
            raw = `{${raw.slice(1)}}`;
        }
        if (raw.startsWith("{") && raw.endsWith("}") && raw.length > 2) {
            const inner = raw.slice(1, -1).trim();
            if (inner.endsWith("+")) {
                const name = inner.slice(0, -1).trim();
                if (!name)
                    return { ok: false, error: "proxy name is empty" };
                if (i !== rawSegments.length - 1)
                    return { ok: false, error: "proxy segment must be last" };
                segments.push({ kind: "proxy", value: name });
                canonicalSegments.push(`{${name}+}`);
                hasProxy = true;
                continue;
            }
            if (!inner)
                return { ok: false, error: "param name is empty" };
            segments.push({ kind: "param", value: inner });
            canonicalSegments.push(`{${inner}}`);
            paramCount += 1;
            continue;
        }
        if (raw.includes("{") || raw.includes("}")) {
            return { ok: false, error: "invalid segment" };
        }
        segments.push({ kind: "static", value: raw });
        canonicalSegments.push(raw);
        staticCount += 1;
    }
    return {
        ok: true,
        segments,
        canonicalSegments,
        staticCount,
        paramCount,
        hasProxy,
    };
}
function matchRoute(patternSegments, pathSegments) {
    if (patternSegments.length === 0)
        return pathSegments.length === 0 ? {} : null;
    const last = patternSegments[patternSegments.length - 1];
    const hasProxy = last?.kind === "proxy";
    if (hasProxy) {
        const prefixLen = patternSegments.length - 1;
        if (pathSegments.length <= prefixLen)
            return null;
        const params = {};
        for (let i = 0; i < prefixLen; i += 1) {
            const pattern = patternSegments[i];
            const segment = pathSegments[i];
            if (!pattern || segment === undefined)
                return null;
            if (pattern.kind === "static") {
                if (pattern.value !== segment)
                    return null;
            }
            else if (pattern.kind === "param") {
                params[pattern.value] = segment;
            }
            else {
                return null;
            }
        }
        if (!last)
            return null;
        params[last.value] = pathSegments.slice(prefixLen).join("/");
        return params;
    }
    if (patternSegments.length !== pathSegments.length)
        return null;
    const params = {};
    for (let i = 0; i < patternSegments.length; i += 1) {
        const pattern = patternSegments[i];
        const segment = pathSegments[i];
        if (!pattern || segment === undefined)
            return null;
        if (pattern.kind === "static") {
            if (pattern.value !== segment)
                return null;
        }
        else if (pattern.kind === "param") {
            params[pattern.value] = segment;
        }
        else {
            return null;
        }
    }
    return params;
}
function routeMoreSpecific(a, b) {
    if (a.staticCount !== b.staticCount)
        return a.staticCount > b.staticCount;
    if (a.paramCount !== b.paramCount)
        return a.paramCount > b.paramCount;
    if (a.hasProxy !== b.hasProxy)
        return !a.hasProxy && b.hasProxy;
    if (a.segments.length !== b.segments.length)
        return a.segments.length > b.segments.length;
    return a.order < b.order;
}
//# sourceMappingURL=router.js.map