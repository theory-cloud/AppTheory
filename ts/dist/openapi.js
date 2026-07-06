import { VALIDATION_RULE_ENUM, VALIDATION_RULE_MAX, VALIDATION_RULE_MAX_LENGTH, VALIDATION_RULE_MIN, VALIDATION_RULE_MIN_LENGTH, VALIDATION_RULE_PATTERN, VALIDATION_RULE_REQUIRED, } from "./validate.js";
const JSON_NUMBER_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
export function generateOpenAPI(spec) {
    const title = spec.title.trim();
    const version = spec.version.trim();
    if (!title) {
        throw new Error("apptheory: openapi title is required");
    }
    if (!version) {
        throw new Error("apptheory: openapi version is required");
    }
    const paths = newJsonObject();
    const routes = [...spec.routes].sort(compareRoutes);
    const seen = new Set();
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
            throw new Error(`apptheory: openapi route ${method.toUpperCase()} ${path} operation_id is required`);
        }
        const key = `${method} ${path}`;
        if (seen.has(key)) {
            throw new Error(`apptheory: openapi route ${key} is duplicated`);
        }
        seen.add(key);
        const operation = operationForRoute(route, operationId);
        const existing = paths[path];
        const pathItem = isJsonObject(existing) ? existing : newJsonObject();
        setJsonMember(pathItem, method, operation);
        setJsonMember(paths, path, pathItem);
    }
    return {
        components: openAPIComponents(),
        info: { title, version },
        openapi: "3.1.0",
        paths,
    };
}
export function generateOpenAPIJSON(spec) {
    return stableStringify(generateOpenAPI(spec));
}
function openAPIComponents() {
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
function operationForRoute(route, operationId) {
    const successStatus = route.successStatus ?? 200;
    if (successStatus < 100 || successStatus > 599) {
        throw new Error(`apptheory: openapi route ${route.method.toUpperCase()} ${route.path} success_status must be an HTTP status`);
    }
    const operation = {
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
function successResponse(response) {
    const description = response.description?.trim() || "success";
    const out = { description };
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
function parametersForFields(fields) {
    const params = [];
    for (const field of fields) {
        const source = normalizeSource(field.source);
        if (source === "path" || source === "query" || source === "header") {
            params.push({ ...field, source });
            continue;
        }
        if (source === "body") {
            continue;
        }
        throw new Error(`apptheory: openapi request field ${field.field} has unsupported source ${field.source}`);
    }
    params.sort((left, right) => {
        const rank = sourceRank(left.source) - sourceRank(right.source);
        if (rank !== 0) {
            return rank;
        }
        return compareCanonicalStrings(left.name.trim(), right.name.trim());
    });
    return params.map((field) => {
        const name = field.name.trim();
        if (!name) {
            throw new Error(`apptheory: openapi request field ${field.field} name is required`);
        }
        return {
            in: field.source,
            name,
            required: fieldRequired(field),
            schema: fieldSchema(field),
        };
    });
}
function fieldsForSource(fields, source) {
    const out = [];
    for (const field of fields) {
        const fieldSource = normalizeSource(field.source);
        if (fieldSource !== source) {
            continue;
        }
        const name = field.name.trim();
        if (!name) {
            throw new Error(`apptheory: openapi field ${field.field} name is required`);
        }
        out.push({ ...field, name, source: fieldSource });
    }
    out.sort((left, right) => compareCanonicalStrings(left.name, right.name));
    return out;
}
function objectSchema(fields) {
    const properties = {};
    const required = [];
    for (const field of fields) {
        properties[field.name] = fieldSchema(field);
        if (fieldRequired(field)) {
            required.push(field.name);
        }
    }
    required.sort(compareCanonicalStrings);
    const schema = {
        additionalProperties: false,
        properties,
        type: "object",
    };
    if (required.length > 0) {
        schema["required"] = required;
    }
    return schema;
}
function fieldSchema(field) {
    const baseType = normalizeFieldType(field.type);
    let schema;
    if (field.array) {
        const items = { type: baseType };
        if (baseType === "object") {
            items["additionalProperties"] = true;
        }
        schema = { items, type: "array" };
    }
    else {
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
                    if (value === null) {
                        throw new Error(`apptheory: openapi field ${fieldLabel(field)} ${VALIDATION_RULE_MIN} must be a number`);
                    }
                    schema["minimum"] = value;
                }
                break;
            case VALIDATION_RULE_MAX:
                if (!field.array && (baseType === "integer" || baseType === "number")) {
                    const value = numberValue(rule.value);
                    if (value === null) {
                        throw new Error(`apptheory: openapi field ${fieldLabel(field)} ${VALIDATION_RULE_MAX} must be a number`);
                    }
                    schema["maximum"] = value;
                }
                break;
            case VALIDATION_RULE_MIN_LENGTH: {
                const value = integerValue(rule.value);
                if (value === null) {
                    throw new Error(`apptheory: openapi field ${fieldLabel(field)} ${VALIDATION_RULE_MIN_LENGTH} must be an integer`);
                }
                applyLength(schema, baseType, Boolean(field.array), "min", value);
                break;
            }
            case VALIDATION_RULE_MAX_LENGTH: {
                const value = integerValue(rule.value);
                if (value === null) {
                    throw new Error(`apptheory: openapi field ${fieldLabel(field)} ${VALIDATION_RULE_MAX_LENGTH} must be an integer`);
                }
                applyLength(schema, baseType, Boolean(field.array), "max", value);
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
function applyLength(schema, baseType, array, kind, value) {
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
function fieldRequired(field) {
    if (normalizeSource(field.source) === "path" || field.required === true) {
        return true;
    }
    return (field.validation ?? []).some((rule) => rule.rule === VALIDATION_RULE_REQUIRED);
}
function normalizePath(path) {
    const trimmed = path.trim();
    if (!trimmed) {
        return "";
    }
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function normalizeMethod(method) {
    return method.trim().toLowerCase();
}
function normalizeSource(source) {
    return source.trim().toLowerCase();
}
function normalizeFieldType(value) {
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
function compareRoutes(left, right) {
    const leftPath = normalizePath(left.path);
    const rightPath = normalizePath(right.path);
    if (leftPath !== rightPath) {
        return compareCanonicalStrings(leftPath, rightPath);
    }
    const leftMethod = normalizeMethod(left.method);
    const rightMethod = normalizeMethod(right.method);
    const rank = methodRank(leftMethod) - methodRank(rightMethod);
    if (rank !== 0) {
        return rank;
    }
    return compareCanonicalStrings(leftMethod, rightMethod);
}
function methodRank(method) {
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
function sourceRank(source) {
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
function sortedTags(tags) {
    return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort(compareCanonicalStrings);
}
function enumValues(value) {
    if (isReadonlyEnumArray(value)) {
        return value.map((item) => typeof item === "number" ? canonicalNumberString(item) : item.trim());
    }
    if (typeof value === "string") {
        return value
            .split("|")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    if (typeof value === "number") {
        return [canonicalNumberString(value)];
    }
    return [];
}
function isReadonlyEnumArray(value) {
    return (Array.isArray(value) &&
        value.every((item) => typeof item === "string" || typeof item === "number"));
}
function numberValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!JSON_NUMBER_PATTERN.test(trimmed)) {
            return null;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function integerValue(value) {
    const parsed = numberValue(value);
    return parsed === null || !Number.isInteger(parsed) ? null : parsed;
}
function fieldLabel(field) {
    return field.field.trim() || field.name.trim() || "field";
}
function compareCanonicalStrings(left, right) {
    const leftPoints = Array.from(left);
    const rightPoints = Array.from(right);
    const limit = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < limit; index += 1) {
        const leftCode = leftPoints[index]?.codePointAt(0) ?? 0;
        const rightCode = rightPoints[index]?.codePointAt(0) ?? 0;
        if (leftCode !== rightCode) {
            return leftCode < rightCode ? -1 : 1;
        }
    }
    if (leftPoints.length === rightPoints.length) {
        return 0;
    }
    return leftPoints.length < rightPoints.length ? -1 : 1;
}
function stableStringify(value) {
    if (value === null || value === undefined) {
        return "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    if (typeof value === "number") {
        return canonicalNumberString(value);
    }
    if (typeof value === "object") {
        const record = value;
        const keys = Object.keys(record).sort(compareCanonicalStrings);
        return `{${keys
            .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
function canonicalNumberString(value) {
    if (!Number.isFinite(value)) {
        throw new Error("apptheory: openapi number must be finite");
    }
    if (Object.is(value, -0) || value === 0) {
        return "0";
    }
    const text = String(value);
    if (!/[eE]/.test(text)) {
        return text;
    }
    return expandExponentialNumber(text);
}
function expandExponentialNumber(value) {
    const sign = value.startsWith("-") ? "-" : "";
    const unsigned = sign ? value.slice(1) : value;
    const [coefficient = "", exponentText = "0"] = unsigned.split(/[eE]/);
    const exponent = Number(exponentText);
    const [whole = "", fraction = ""] = coefficient.split(".");
    const digits = trimLeadingZerosPreservingOne(`${whole}${fraction}`) || "0";
    const decimalIndex = whole.length + exponent;
    let expanded;
    if (decimalIndex <= 0) {
        expanded = `0.${"0".repeat(-decimalIndex)}${digits}`;
    }
    else if (decimalIndex >= digits.length) {
        expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
    }
    else {
        expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
    }
    if (expanded.includes(".")) {
        expanded = trimTrailingZeros(expanded);
        if (expanded.endsWith(".")) {
            expanded = expanded.slice(0, -1);
        }
    }
    if (expanded === "0") {
        return "0";
    }
    return `${sign}${expanded}`;
}
function isJsonObject(value) {
    return (value !== undefined &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value));
}
function newJsonObject() {
    return Object.create(null);
}
function setJsonMember(target, key, value) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}
function trimLeadingZerosPreservingOne(value) {
    let index = 0;
    while (index < value.length - 1 &&
        value.charCodeAt(index) === 48 &&
        isAsciiDigit(value.charCodeAt(index + 1))) {
        index += 1;
    }
    return value.slice(index);
}
function trimTrailingZeros(value) {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 48) {
        end -= 1;
    }
    return value.slice(0, end);
}
function isAsciiDigit(code) {
    return code >= 48 && code <= 57;
}
//# sourceMappingURL=openapi.js.map