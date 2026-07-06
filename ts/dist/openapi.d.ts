import { type ValidationRuleName } from "./validate.js";
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
    [key: string]: JsonValue;
}
type OpenAPIValidationRuleValue = number | string | readonly (number | string)[] | undefined;
export type OpenAPIFieldSource = "body" | "query" | "path" | "header" | "response";
export type OpenAPIFieldType = "string" | "integer" | "number" | "boolean" | "object" | "int" | "float" | "bool" | "map";
export interface OpenAPIValidationRuleSpec {
    rule: ValidationRuleName;
    value?: OpenAPIValidationRuleValue;
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
export declare function generateOpenAPI(spec: OpenAPISpec): OpenAPIDocument;
export declare function generateOpenAPIJSON(spec: OpenAPISpec): string;
export {};
//# sourceMappingURL=openapi.d.ts.map