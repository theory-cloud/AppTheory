import type { Context, Handler } from "./context.js";
import type { ValidationRuleSpec, ValidationSchema } from "./validate.js";
export type BindSource = "body" | "query" | "path" | "header";
export type BindFieldType = "string" | "int" | "bool" | "float" | "duration";
export interface BindFieldSpec {
    source: BindSource;
    name?: string;
    type?: BindFieldType;
    array?: boolean;
    field?: string;
    validate?: readonly ValidationRuleSpec[];
}
export type BindFieldSpecs<Req> = Partial<Record<Extract<keyof Req, string>, BindFieldSpec>>;
export interface BindConfig<Req> {
    body?: boolean;
    query?: boolean;
    path?: boolean;
    headers?: boolean;
    strictJson?: boolean;
    successStatus?: number;
    fields?: BindFieldSpecs<Req>;
    validation?: ValidationSchema<Req>;
    validate?: (ctx: Context, req: Req) => void | Promise<void>;
}
export type TypedHandler<Req, Resp> = (ctx: Context, req: Req) => Resp | Promise<Resp>;
export declare function bindHandler<Req, Resp>(config: BindConfig<Req>, handler: TypedHandler<Req, Resp>): Handler;
export declare function bindRequest<Req>(ctx: Context, config: BindConfig<Req>): Promise<Req>;
//# sourceMappingURL=bind-handler.d.ts.map