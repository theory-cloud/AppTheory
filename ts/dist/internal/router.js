import { normalizeMethod, normalizePath, splitPath } from "./http.js";
export class Router {
    _routes = [];
    add(method, pattern, handler, options = {}) {
        const normalizedMethod = normalizeMethod(method);
        const normalizedPattern = normalizePath(pattern);
        const parsed = parseRouteSegments(splitPath(normalizedPattern));
        if (!parsed.ok) {
            return;
        }
        const normalizedPatternValue = parsed.canonicalSegments.length > 0
            ? `/${parsed.canonicalSegments.join("/")}`
            : "/";
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
function parseRouteSegments(rawSegments) {
    const segments = [];
    const canonicalSegments = [];
    let staticCount = 0;
    let paramCount = 0;
    let hasProxy = false;
    for (let i = 0; i < rawSegments.length; i += 1) {
        let raw = String(rawSegments[i] ?? "").trim();
        if (!raw)
            return { ok: false };
        if (raw.startsWith(":") && raw.length > 1) {
            raw = `{${raw.slice(1)}}`;
        }
        if (raw.startsWith("{") && raw.endsWith("}") && raw.length > 2) {
            const inner = raw.slice(1, -1).trim();
            if (inner.endsWith("+")) {
                const name = inner.slice(0, -1).trim();
                if (!name)
                    return { ok: false };
                if (i !== rawSegments.length - 1)
                    return { ok: false };
                segments.push({ kind: "proxy", value: name });
                canonicalSegments.push(`{${name}+}`);
                hasProxy = true;
                continue;
            }
            if (!inner)
                return { ok: false };
            segments.push({ kind: "param", value: inner });
            canonicalSegments.push(`{${inner}}`);
            paramCount += 1;
            continue;
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
