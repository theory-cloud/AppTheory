import { generateOpenAPI, } from "./openapi.js";
function canonicalRouteKey(methodValue, pathValue) {
    const method = String(methodValue ?? "")
        .trim()
        .toUpperCase();
    if (!method)
        throw new Error("apptheory: route method is empty");
    let path = String(pathValue ?? "").trim();
    const queryIndex = path.indexOf("?");
    if (queryIndex >= 0)
        path = path.slice(0, queryIndex);
    path = path.trim();
    if (!path)
        path = "/";
    if (!path.startsWith("/"))
        path = `/${path}`;
    const rawSegments = path === "/" ? [] : path.slice(1).split("/");
    const canonical = [];
    for (let index = 0; index < rawSegments.length; index += 1) {
        let segment = String(rawSegments[index] ?? "").trim();
        if (!segment)
            throw new Error("apptheory: invalid route pattern");
        if (segment.startsWith(":") && segment.length > 1) {
            segment = `{${segment.slice(1)}}`;
        }
        if (segment.startsWith("{") && segment.endsWith("}")) {
            let name = segment.slice(1, -1).trim();
            const proxy = name.endsWith("+");
            if (proxy)
                name = name.slice(0, -1).trim();
            if (!name || name.includes("{") || name.includes("}")) {
                throw new Error("apptheory: invalid route pattern");
            }
            if (proxy && index !== rawSegments.length - 1) {
                throw new Error("apptheory: invalid route pattern");
            }
            canonical.push(`{${name}${proxy ? "+" : ""}}`);
            continue;
        }
        if (segment.includes("{") || segment.includes("}")) {
            throw new Error("apptheory: invalid route pattern");
        }
        canonical.push(segment);
    }
    path = canonical.length > 0 ? `/${canonical.join("/")}` : "/";
    return { key: `${method} ${path}`, method, path };
}
function normalizeNames(values) {
    const out = [];
    const seen = new Set();
    for (const raw of values ?? []) {
        const value = String(raw ?? "").trim();
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
function copyJSONValue(value, seen) {
    if (value === null ||
        typeof value === "string" ||
        typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number" || typeof value === "undefined") {
        throw new Error("numeric and undefined values are not allowed");
    }
    if (typeof value !== "object") {
        throw new Error(`value type ${typeof value} is not allowed`);
    }
    if (seen.has(value))
        throw new Error("cyclic value is not allowed");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => copyJSONValue(item, seen));
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error("runtime-specific objects are not allowed");
        }
        const out = {};
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") {
                throw new Error("object keys must be strings");
            }
            out[key] = copyJSONValue(value[key], seen);
        }
        return out;
    }
    finally {
        seen.delete(value);
    }
}
function normalizeSecuritySchemes(input) {
    const copied = copyJSONValue(input ?? {}, new WeakSet());
    const out = {};
    for (const [rawName, scheme] of Object.entries(copied)) {
        const name = rawName.trim();
        if (!name) {
            throw new Error("apptheory: secure openapi security scheme name is required");
        }
        if (Object.hasOwn(out, name)) {
            throw new Error(`apptheory: secure openapi security scheme ${name} is duplicated`);
        }
        out[name] = scheme;
    }
    return out;
}
function proxyPath(path) {
    const segments = path === "/" ? [] : path.slice(1).split("/");
    const last = segments.at(-1) ?? "";
    if (!last.startsWith("{") || !last.endsWith("+}")) {
        return { proxy: false, name: "", path };
    }
    const name = last.slice(1, -2).trim();
    segments[segments.length - 1] = `{${name}}`;
    return { proxy: true, name, path: `/${segments.join("/")}` };
}
function proxyFields(fields, name) {
    const out = [...(fields ?? [])].map((field) => ({ ...field }));
    const existing = out.find((field) => field.source === "path" && String(field.name).trim() === name);
    if (existing) {
        existing.required = true;
        return out;
    }
    out.push({
        field: name,
        source: "path",
        name,
        type: "string",
        required: true,
    });
    return out;
}
function operationSecurity(route, authenticated, internal) {
    if (route.posture === "public")
        return [];
    const names = route.posture === "internal_only" ? internal : authenticated;
    const scopes = route.posture === "authenticated" ? [...(route.scopes ?? [])] : [];
    const out = names.map((name) => ({ [name]: scopes }));
    if (route.posture === "optional")
        out.push({});
    return out;
}
export function generateSecureOpenAPI(routes, spec) {
    const registered = new Map();
    for (const route of routes) {
        if (route.surface !== "http")
            continue;
        registered.set(canonicalRouteKey(route.method, route.path).key, route);
    }
    const described = new Map();
    const order = [];
    for (const input of spec.routes) {
        const canonical = canonicalRouteKey(input.method, input.path);
        if (described.has(canonical.key)) {
            throw new Error(`apptheory: secure openapi route ${canonical.key} is duplicated`);
        }
        described.set(canonical.key, {
            ...input,
            method: canonical.method,
            path: canonical.path,
        });
        order.push(canonical.key);
    }
    for (const key of registered.keys()) {
        if (!described.has(key))
            throw new Error(`apptheory: secure openapi missing route ${key}`);
    }
    for (const key of described.keys()) {
        if (!registered.has(key))
            throw new Error(`apptheory: secure openapi extra route ${key}`);
    }
    const schemes = normalizeSecuritySchemes(spec.securitySchemes ?? {});
    const authenticated = normalizeNames(spec.authSchemes?.authenticated);
    const internal = normalizeNames(spec.authSchemes?.internalOnly);
    for (const name of [...authenticated, ...internal]) {
        if (!(name in schemes)) {
            throw new Error(`apptheory: secure openapi auth scheme ${name} is not defined`);
        }
    }
    const joins = [];
    const emitted = new Set();
    for (const key of order) {
        const route = registered.get(key);
        let description = described.get(key);
        const proxy = proxyPath(description.path);
        const emittedKey = `${description.method.toUpperCase()} ${proxy.path}`;
        if (emitted.has(emittedKey))
            throw new Error(`apptheory: secure openapi emitted route ${emittedKey} collides`);
        emitted.add(emittedKey);
        if ((route.posture === "optional" || route.posture === "authenticated") &&
            authenticated.length === 0) {
            throw new Error("apptheory: secure openapi authenticated scheme binding is required");
        }
        if (route.posture === "internal_only" && internal.length === 0) {
            throw new Error("apptheory: secure openapi internal scheme binding is required");
        }
        if (proxy.proxy) {
            description = {
                ...description,
                path: proxy.path,
                request: {
                    ...description.request,
                    fields: proxyFields(description.request?.fields, proxy.name),
                },
            };
        }
        joins.push({
            route,
            description,
            emittedPath: proxy.path,
            proxy: proxy.proxy,
        });
    }
    const document = generateOpenAPI({
        title: spec.title,
        version: spec.version,
        routes: joins.map((join) => join.description),
    });
    const components = document["components"];
    components["securitySchemes"] = schemes;
    document["x-apptheory-contract-mode"] = "secure-v1";
    const paths = document["paths"];
    for (const join of joins) {
        const operation = paths[join.emittedPath]?.[join.description.method.toLowerCase()];
        if (!operation)
            throw new Error("apptheory: secure openapi operation invariant");
        operation["x-apptheory-auth-posture"] = join.route.posture;
        if ((join.route.scopes?.length ?? 0) > 0) {
            operation["x-apptheory-required-scopes"] = [...(join.route.scopes ?? [])];
        }
        if (join.proxy)
            operation["x-apptheory-proxy"] = true;
        operation["security"] = operationSecurity(join.route, authenticated, internal);
    }
    return document;
}
function compareUnicodeScalars(left, right) {
    const a = Array.from(left, (ch) => ch.codePointAt(0) ?? 0);
    const b = Array.from(right, (ch) => ch.codePointAt(0) ?? 0);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        if (a[i] !== b[i])
            return (a[i] ?? 0) - (b[i] ?? 0);
    }
    return a.length - b.length;
}
function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const record = value;
    return `{${Object.keys(record)
        .sort(compareUnicodeScalars)
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(",")}}`;
}
export function generateSecureOpenAPIJSON(routes, spec) {
    return stableStringify(generateSecureOpenAPI(routes, spec));
}
//# sourceMappingURL=secure-openapi.js.map