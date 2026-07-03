import {
  VALIDATION_RULE_ENUM,
  VALIDATION_RULE_MAX,
  VALIDATION_RULE_MAX_LENGTH,
  VALIDATION_RULE_MIN,
  VALIDATION_RULE_MIN_LENGTH,
  VALIDATION_RULE_PATTERN,
  VALIDATION_RULE_REQUIRED,
  type ValidationRuleName,
} from "./validate.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

export type OpenAPIFieldSource =
  | "body"
  | "query"
  | "path"
  | "header"
  | "response";
export type OpenAPIFieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "int"
  | "float"
  | "bool"
  | "map";

export interface OpenAPIValidationRuleSpec {
  rule: ValidationRuleName;
  value?: number | string | readonly string[] | undefined;
}

export interface OpenAPIFieldSpec {
  field: string;
  source: OpenAPIFieldSource;
  name: string;
  type: OpenAPIFieldType;
  array?: boolean | undefined;
  required?: boolean | undefined;
  validation?: readonly OpenAPIValidationRuleSpec[] | undefined;
}

export interface OpenAPIRequestSpec {
  fields?: readonly OpenAPIFieldSpec[] | undefined;
}

export interface OpenAPIResponseSpec {
  description?: string | undefined;
  fields?: readonly OpenAPIFieldSpec[] | undefined;
}

export interface OpenAPIRouteSpec {
  method: string;
  path: string;
  operationId: string;
  summary?: string | undefined;
  tags?: readonly string[] | undefined;
  successStatus?: number | undefined;
  request?: OpenAPIRequestSpec | undefined;
  response: OpenAPIResponseSpec;
}

export interface OpenAPISpec {
  title: string;
  version: string;
  routes: readonly OpenAPIRouteSpec[];
}

export type OpenAPIDocument = JsonObject;

export function generateOpenAPI(spec: OpenAPISpec): OpenAPIDocument {
  const title = spec.title.trim();
  const version = spec.version.trim();
  if (!title) {
    throw new Error("apptheory: openapi title is required");
  }
  if (!version) {
    throw new Error("apptheory: openapi version is required");
  }

  const paths: JsonObject = {};
  const routes = [...spec.routes].sort(compareRoutes);
  const seen = new Set<string>();
  for (const route of routes) {
    const path = normalizePath(route.path);
    const method = normalizeMethod(route.method);
    if (!path) {
      throw new Error("apptheory: openapi route path is required");
    }
    if (!method) {
      throw new Error(`apptheory: openapi route ${path} method is required`);
    }
    const operationId = route.operationId.trim();
    if (!operationId) {
      throw new Error(
        `apptheory: openapi route ${method.toUpperCase()} ${path} operation_id is required`,
      );
    }
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      throw new Error(`apptheory: openapi route ${key} is duplicated`);
    }
    seen.add(key);

    const operation = operationForRoute(route, operationId);
    const existing = paths[path];
    const pathItem = isJsonObject(existing) ? existing : {};
    pathItem[method] = operation;
    paths[path] = pathItem;
  }

  return {
    components: openAPIComponents(),
    info: { title, version },
    openapi: "3.1.0",
    paths,
  };
}

export function generateOpenAPIJSON(spec: OpenAPISpec): string {
  return stableStringify(generateOpenAPI(spec));
}

function openAPIComponents(): JsonObject {
  return {
    responses: {
      AppBadRequest: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AppTheoryError" },
          },
        },
        description: "AppTheory bad request error envelope",
      },
      AppValidationFailed: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AppTheoryError" },
          },
        },
        description: "AppTheory validation failure error envelope",
      },
    },
    schemas: {
      AppTheoryError: {
        additionalProperties: false,
        properties: {
          error: {
            additionalProperties: true,
            properties: {
              code: { type: "string" },
              details: { additionalProperties: true, type: "object" },
              message: { type: "string" },
              request_id: { type: "string" },
            },
            required: ["code", "message"],
            type: "object",
          },
        },
        required: ["error"],
        type: "object",
      },
    },
  };
}

function operationForRoute(
  route: OpenAPIRouteSpec,
  operationId: string,
): JsonObject {
  const successStatus = route.successStatus ?? 200;
  if (successStatus < 100 || successStatus > 599) {
    throw new Error(
      `apptheory: openapi route ${route.method.toUpperCase()} ${route.path} success_status must be an HTTP status`,
    );
  }

  const operation: JsonObject = {
    operationId,
    responses: {
      [String(successStatus)]: successResponse(route.response),
      "400": { $ref: "#/components/responses/AppBadRequest" },
      "422": { $ref: "#/components/responses/AppValidationFailed" },
    },
  };

  const parameters = parametersForFields(route.request?.fields ?? []);
  if (parameters.length > 0) {
    operation["parameters"] = parameters;
  }

  const bodyFields = fieldsForSource(route.request?.fields ?? [], "body");
  if (bodyFields.length > 0) {
    operation["requestBody"] = {
      content: {
        "application/json": {
          schema: objectSchema(bodyFields),
        },
      },
      required: true,
    };
  }

  const summary = route.summary?.trim() ?? "";
  if (summary) {
    operation["summary"] = summary;
  }

  const tags = sortedTags(route.tags ?? []);
  if (tags.length > 0) {
    operation["tags"] = tags;
  }
  return operation;
}

function successResponse(response: OpenAPIResponseSpec): JsonObject {
  const description = response.description?.trim() || "success";
  const out: JsonObject = { description };
  const fields = fieldsForSource(response.fields ?? [], "response");
  if (fields.length > 0) {
    out["content"] = {
      "application/json": {
        schema: objectSchema(fields),
      },
    };
  }
  return out;
}

function parametersForFields(fields: readonly OpenAPIFieldSpec[]): JsonValue[] {
  const params: OpenAPIFieldSpec[] = [];
  for (const field of fields) {
    const source = normalizeSource(field.source);
    if (source === "path" || source === "query" || source === "header") {
      params.push({ ...field, source });
      continue;
    }
    if (source === "body") {
      continue;
    }
    throw new Error(
      `apptheory: openapi request field ${field.field} has unsupported source ${field.source}`,
    );
  }
  params.sort((left, right) => {
    const rank = sourceRank(left.source) - sourceRank(right.source);
    if (rank !== 0) {
      return rank;
    }
    return left.name.trim().localeCompare(right.name.trim());
  });

  return params.map((field): JsonObject => {
    const name = field.name.trim();
    if (!name) {
      throw new Error(
        `apptheory: openapi request field ${field.field} name is required`,
      );
    }
    return {
      in: field.source,
      name,
      required: fieldRequired(field),
      schema: fieldSchema(field),
    };
  });
}

function fieldsForSource(
  fields: readonly OpenAPIFieldSpec[],
  source: OpenAPIFieldSource,
): OpenAPIFieldSpec[] {
  const out: OpenAPIFieldSpec[] = [];
  for (const field of fields) {
    const fieldSource = normalizeSource(field.source);
    if (fieldSource !== source) {
      continue;
    }
    const name = field.name.trim();
    if (!name) {
      throw new Error(
        `apptheory: openapi field ${field.field} name is required`,
      );
    }
    out.push({ ...field, name, source: fieldSource });
  }
  out.sort((left, right) => left.name.localeCompare(right.name));
  return out;
}

function objectSchema(fields: readonly OpenAPIFieldSpec[]): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = fieldSchema(field);
    if (fieldRequired(field)) {
      required.push(field.name);
    }
  }
  required.sort();
  const schema: JsonObject = {
    additionalProperties: false,
    properties,
    type: "object",
  };
  if (required.length > 0) {
    schema["required"] = required;
  }
  return schema;
}

function fieldSchema(field: OpenAPIFieldSpec): JsonObject {
  const baseType = normalizeFieldType(field.type);
  let schema: JsonObject;
  if (field.array) {
    const items: JsonObject = { type: baseType };
    if (baseType === "object") {
      items["additionalProperties"] = true;
    }
    schema = { items, type: "array" };
  } else {
    schema = { type: baseType };
    if (baseType === "object") {
      schema["additionalProperties"] = true;
    }
  }

  for (const rule of field.validation ?? []) {
    switch (rule.rule) {
      case VALIDATION_RULE_REQUIRED:
        break;
      case VALIDATION_RULE_MIN:
        if (!field.array && (baseType === "integer" || baseType === "number")) {
          const value = numberValue(rule.value);
          if (value !== null) {
            schema["minimum"] = value;
          }
        }
        break;
      case VALIDATION_RULE_MAX:
        if (!field.array && (baseType === "integer" || baseType === "number")) {
          const value = numberValue(rule.value);
          if (value !== null) {
            schema["maximum"] = value;
          }
        }
        break;
      case VALIDATION_RULE_MIN_LENGTH: {
        const value = integerValue(rule.value);
        if (value !== null) {
          applyLength(schema, baseType, Boolean(field.array), "min", value);
        }
        break;
      }
      case VALIDATION_RULE_MAX_LENGTH: {
        const value = integerValue(rule.value);
        if (value !== null) {
          applyLength(schema, baseType, Boolean(field.array), "max", value);
        }
        break;
      }
      case VALIDATION_RULE_PATTERN:
        if (!field.array && baseType === "string") {
          schema["pattern"] = String(rule.value ?? "");
        }
        break;
      case VALIDATION_RULE_ENUM: {
        const values = enumValues(rule.value);
        if (values.length > 0) {
          schema["enum"] = values;
        }
        break;
      }
    }
  }
  return schema;
}

function applyLength(
  schema: JsonObject,
  baseType: string,
  array: boolean,
  kind: "min" | "max",
  value: number,
): void {
  if (array) {
    schema[kind === "min" ? "minItems" : "maxItems"] = value;
    return;
  }
  if (baseType === "object") {
    schema[kind === "min" ? "minProperties" : "maxProperties"] = value;
    return;
  }
  schema[kind === "min" ? "minLength" : "maxLength"] = value;
}

function fieldRequired(field: OpenAPIFieldSpec): boolean {
  if (normalizeSource(field.source) === "path" || field.required === true) {
    return true;
  }
  return (field.validation ?? []).some(
    (rule) => rule.rule === VALIDATION_RULE_REQUIRED,
  );
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeMethod(method: string): string {
  return method.trim().toLowerCase();
}

function normalizeSource(source: OpenAPIFieldSource): OpenAPIFieldSource {
  return source.trim().toLowerCase() as OpenAPIFieldSource;
}

function normalizeFieldType(
  value: OpenAPIFieldType,
): "string" | "integer" | "number" | "boolean" | "object" {
  switch (value.trim().toLowerCase()) {
    case "int":
    case "integer":
      return "integer";
    case "float":
    case "number":
      return "number";
    case "bool":
    case "boolean":
      return "boolean";
    case "map":
    case "object":
      return "object";
    default:
      return "string";
  }
}

function compareRoutes(
  left: OpenAPIRouteSpec,
  right: OpenAPIRouteSpec,
): number {
  const leftPath = normalizePath(left.path);
  const rightPath = normalizePath(right.path);
  if (leftPath !== rightPath) {
    return leftPath.localeCompare(rightPath);
  }
  const leftMethod = normalizeMethod(left.method);
  const rightMethod = normalizeMethod(right.method);
  const rank = methodRank(leftMethod) - methodRank(rightMethod);
  if (rank !== 0) {
    return rank;
  }
  return leftMethod.localeCompare(rightMethod);
}

function methodRank(method: string): number {
  const order = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
  ];
  const index = order.indexOf(method);
  return index === -1 ? order.length : index;
}

function sourceRank(source: OpenAPIFieldSource): number {
  switch (source) {
    case "path":
      return 0;
    case "query":
      return 1;
    case "header":
      return 2;
    case "body":
      return 3;
    case "response":
      return 4;
  }
}

function sortedTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort();
}

function enumValues(
  value: number | string | readonly string[] | undefined,
): string[] {
  if (isReadonlyStringArray(value)) {
    return value.map((item) => item.trim());
  }
  if (typeof value === "string") {
    return value
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "number") {
    return [String(value)];
  }
  return [];
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
}

function numberValue(
  value: number | string | readonly string[] | undefined,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function integerValue(
  value: number | string | readonly string[] | undefined,
): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
