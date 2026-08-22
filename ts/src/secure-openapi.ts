import type { SecureRoute } from "./app.js";
import {
  generateOpenAPI,
  type OpenAPIDocument,
  type OpenAPIFieldSpec,
  type OpenAPIRouteSpec,
} from "./openapi.js";

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

function canonicalRouteKey(methodValue: string, pathValue: string) {
  const method = String(methodValue ?? "")
    .trim()
    .toUpperCase();
  if (!method) throw new Error("apptheory: route method is empty");
  let path = String(pathValue ?? "").trim();
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) path = path.slice(0, queryIndex);
  path = path.trim();
  if (!path) path = "/";
  if (!path.startsWith("/")) path = `/${path}`;
  const rawSegments = path === "/" ? [] : path.slice(1).split("/");
  const canonical: string[] = [];
  for (let index = 0; index < rawSegments.length; index += 1) {
    let segment = String(rawSegments[index] ?? "").trim();
    if (!segment) throw new Error("apptheory: invalid route pattern");
    if (segment.startsWith(":") && segment.length > 1) {
      segment = `{${segment.slice(1)}}`;
    }
    if (segment.startsWith("{") && segment.endsWith("}")) {
      let name = segment.slice(1, -1).trim();
      const proxy = name.endsWith("+");
      if (proxy) name = name.slice(0, -1).trim();
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

function normalizeNames(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function copyJSONValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" || typeof value === "undefined") {
    throw new Error("numeric and undefined values are not allowed");
  }
  if (typeof value !== "object") {
    throw new Error(`value type ${typeof value} is not allowed`);
  }
  if (seen.has(value)) throw new Error("cyclic value is not allowed");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => copyJSONValue(item, seen));
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("runtime-specific objects are not allowed");
    }
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error("object keys must be strings");
      }
      out[key] = copyJSONValue((value as Record<string, unknown>)[key], seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function normalizeSecuritySchemes(
  input: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const copied = copyJSONValue(input ?? {}, new WeakSet()) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};
  for (const [rawName, scheme] of Object.entries(copied)) {
    const name = rawName.trim();
    if (!name) {
      throw new Error(
        "apptheory: secure openapi security scheme name is required",
      );
    }
    if (Object.hasOwn(out, name)) {
      throw new Error(
        `apptheory: secure openapi security scheme ${name} is duplicated`,
      );
    }
    out[name] = scheme;
  }
  return out;
}

function proxyPath(path: string): {
  proxy: boolean;
  name: string;
  path: string;
} {
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const last = segments.at(-1) ?? "";
  if (!last.startsWith("{") || !last.endsWith("+}")) {
    return { proxy: false, name: "", path };
  }
  const name = last.slice(1, -2).trim();
  segments[segments.length - 1] = `{${name}}`;
  return { proxy: true, name, path: `/${segments.join("/")}` };
}

function proxyFields(
  fields: readonly OpenAPIFieldSpec[] | undefined,
  name: string,
): OpenAPIFieldSpec[] {
  const out = [...(fields ?? [])].map((field) => ({ ...field }));
  const existing = out.find(
    (field) => field.source === "path" && String(field.name).trim() === name,
  );
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

function operationSecurity(
  route: SecureRoute,
  authenticated: string[],
  internal: string[],
): unknown[] {
  if (route.posture === "public") return [];
  const names = route.posture === "internal_only" ? internal : authenticated;
  if (route.posture === "authenticated_any_of") {
    return names.flatMap((name) =>
      (route.scopes ?? []).map((scope) => ({ [name]: [scope] })),
    );
  }
  const scopes =
    route.posture === "authenticated" ? [...(route.scopes ?? [])] : [];
  const out: unknown[] = names.map((name) => ({ [name]: scopes }));
  if (route.posture === "optional") out.push({});
  return out;
}

export function generateSecureOpenAPI(
  routes: readonly SecureRoute[],
  spec: SecureOpenAPISpec,
): OpenAPIDocument {
  const registered = new Map<string, SecureRoute>();
  for (const route of routes) {
    if (route.surface !== "http") continue;
    registered.set(canonicalRouteKey(route.method, route.path).key, route);
  }
  const described = new Map<string, OpenAPIRouteSpec>();
  const order: string[] = [];
  for (const input of spec.routes) {
    const canonical = canonicalRouteKey(input.method, input.path);
    if (described.has(canonical.key)) {
      throw new Error(
        `apptheory: secure openapi route ${canonical.key} is duplicated`,
      );
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
      throw new Error(
        `apptheory: secure openapi auth scheme ${name} is not defined`,
      );
    }
  }

  const joins: Array<{
    route: SecureRoute;
    description: OpenAPIRouteSpec;
    emittedPath: string;
    proxy: boolean;
  }> = [];
  const emitted = new Set<string>();
  for (const key of order) {
    const route = registered.get(key) as SecureRoute;
    let description = described.get(key) as OpenAPIRouteSpec;
    const proxy = proxyPath(description.path);
    const emittedKey = `${description.method.toUpperCase()} ${proxy.path}`;
    if (emitted.has(emittedKey))
      throw new Error(
        `apptheory: secure openapi emitted route ${emittedKey} collides`,
      );
    emitted.add(emittedKey);
    if (
      (route.posture === "optional" ||
        route.posture === "authenticated" ||
        route.posture === "authenticated_any_of") &&
      authenticated.length === 0
    ) {
      throw new Error(
        "apptheory: secure openapi authenticated scheme binding is required",
      );
    }
    if (route.posture === "internal_only" && internal.length === 0) {
      throw new Error(
        "apptheory: secure openapi internal scheme binding is required",
      );
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
  }) as unknown as Record<string, unknown>;
  const components = document["components"] as Record<string, unknown>;
  components["securitySchemes"] = schemes;
  document["x-apptheory-contract-mode"] = "secure-v1";
  const paths = document["paths"] as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  for (const join of joins) {
    const operation =
      paths[join.emittedPath]?.[join.description.method.toLowerCase()];
    if (!operation)
      throw new Error("apptheory: secure openapi operation invariant");
    operation["x-apptheory-auth-posture"] = join.route.posture;
    if ((join.route.scopes?.length ?? 0) > 0) {
      operation["x-apptheory-required-scopes"] = [...(join.route.scopes ?? [])];
    }
    if (join.proxy) operation["x-apptheory-proxy"] = true;
    operation["security"] = operationSecurity(
      join.route,
      authenticated,
      internal,
    );
  }
  return document as OpenAPIDocument;
}

function compareUnicodeScalars(left: string, right: string): number {
  const a = Array.from(left, (ch) => ch.codePointAt(0) ?? 0);
  const b = Array.from(right, (ch) => ch.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return a.length - b.length;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareUnicodeScalars)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function generateSecureOpenAPIJSON(
  routes: readonly SecureRoute[],
  spec: SecureOpenAPISpec,
): string {
  return stableStringify(generateSecureOpenAPI(routes, spec));
}
