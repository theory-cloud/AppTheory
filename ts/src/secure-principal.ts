/** Classification assigned after application-owned credential verification. */
export type PrincipalKind = "external" | "internal";

/** Normalized principal used by SecureApp gates. */
export interface SecurePrincipal {
  identity: string;
  scopes: string[];
  claims: Record<string, unknown>;
  kind: PrincipalKind | "" | string;
}

function deepCopyValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(deepCopyValue(item, seen));
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = deepCopyValue((value as Record<string, unknown>)[key], seen);
  }
  return out;
}

export function cloneSecurePrincipal(
  principal: SecurePrincipal | null | undefined,
): SecurePrincipal | null {
  if (!principal) return null;
  return {
    identity: String(principal.identity ?? ""),
    scopes: Array.isArray(principal.scopes)
      ? principal.scopes.map((scope) => String(scope))
      : [],
    claims: deepCopyValue(principal.claims ?? {}, new WeakMap()) as Record<
      string,
      unknown
    >,
    kind: String(principal.kind ?? ""),
  };
}

export function normalizeSecurePrincipal(
  principal: SecurePrincipal | null | undefined,
): { principal: SecurePrincipal | null; invalidKind: boolean } {
  if (!principal) return { principal: null, invalidKind: false };
  const kind = String(principal.kind ?? "").trim() || "external";
  if (kind !== "external" && kind !== "internal") {
    return { principal: null, invalidKind: true };
  }
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(principal.scopes) ? principal.scopes : []) {
    const scope = String(raw ?? "").trim();
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  return {
    invalidKind: false,
    principal: {
      identity: String(principal.identity ?? "").trim(),
      scopes,
      claims: deepCopyValue(principal.claims ?? {}, new WeakMap()) as Record<
        string,
        unknown
      >,
      kind,
    },
  };
}
