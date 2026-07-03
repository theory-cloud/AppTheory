import { AppTheoryError } from "./errors.js";
export declare const VALIDATION_RULE_REQUIRED = "required";
export declare const VALIDATION_RULE_MIN = "min";
export declare const VALIDATION_RULE_MAX = "max";
export declare const VALIDATION_RULE_MIN_LENGTH = "min_length";
export declare const VALIDATION_RULE_MAX_LENGTH = "max_length";
export declare const VALIDATION_RULE_PATTERN = "pattern";
export declare const VALIDATION_RULE_ENUM = "enum";
export type ValidationRuleName = typeof VALIDATION_RULE_REQUIRED | typeof VALIDATION_RULE_MIN | typeof VALIDATION_RULE_MAX | typeof VALIDATION_RULE_MIN_LENGTH | typeof VALIDATION_RULE_MAX_LENGTH | typeof VALIDATION_RULE_PATTERN | typeof VALIDATION_RULE_ENUM;
export interface ValidationRuleSpec {
    rule: ValidationRuleName;
    value?: number | string | string[] | undefined;
    field?: string | undefined;
    message?: string | undefined;
}
export interface ValidationFieldError {
    field: string;
    rule: ValidationRuleName;
    message: string;
}
export type ValidationSchema<Req> = Partial<Record<Extract<keyof Req, string>, readonly ValidationRuleSpec[]>>;
export declare const required: (message?: string) => ValidationRuleSpec;
export declare const min: (value: number, message?: string) => ValidationRuleSpec;
export declare const max: (value: number, message?: string) => ValidationRuleSpec;
export declare const minLength: (value: number, message?: string) => ValidationRuleSpec;
export declare const maxLength: (value: number, message?: string) => ValidationRuleSpec;
export declare const pattern: (value: string | RegExp, message?: string) => ValidationRuleSpec;
export declare const oneOf: (values: readonly string[], message?: string) => ValidationRuleSpec;
export declare function validateValue<Req>(value: Req, schema: ValidationSchema<Req> | undefined): ValidationFieldError[];
export declare function validationError(errors: readonly ValidationFieldError[]): AppTheoryError;
export declare function validateOrThrow<Req>(value: Req, schema: ValidationSchema<Req> | undefined): void;
//# sourceMappingURL=validate.d.ts.map