function deepCopyValue(value, seen) {
    if (value === null || typeof value !== "object")
        return value;
    const existing = seen.get(value);
    if (existing !== undefined)
        return existing;
    if (Array.isArray(value)) {
        const out = [];
        seen.set(value, out);
        for (const item of value)
            out.push(deepCopyValue(item, seen));
        return out;
    }
    const out = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) {
        out[key] = deepCopyValue(value[key], seen);
    }
    return out;
}
export function cloneSecurePrincipal(principal) {
    if (!principal)
        return null;
    return {
        identity: String(principal.identity ?? ""),
        scopes: Array.isArray(principal.scopes)
            ? principal.scopes.map((scope) => String(scope))
            : [],
        claims: deepCopyValue(principal.claims ?? {}, new WeakMap()),
        kind: String(principal.kind ?? ""),
    };
}
export function normalizeSecurePrincipal(principal) {
    if (!principal)
        return { principal: null, invalidKind: false };
    const kind = String(principal.kind ?? "").trim() || "external";
    if (kind !== "external" && kind !== "internal") {
        return { principal: null, invalidKind: true };
    }
    const scopes = [];
    const seen = new Set();
    for (const raw of Array.isArray(principal.scopes) ? principal.scopes : []) {
        const scope = String(raw ?? "").trim();
        if (!scope || seen.has(scope))
            continue;
        seen.add(scope);
        scopes.push(scope);
    }
    return {
        invalidKind: false,
        principal: {
            identity: String(principal.identity ?? "").trim(),
            scopes,
            claims: deepCopyValue(principal.claims ?? {}, new WeakMap()),
            kind,
        },
    };
}
//# sourceMappingURL=secure-principal.js.map