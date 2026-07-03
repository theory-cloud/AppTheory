import { AppTheoryError } from "./errors.js";

export const VALIDATION_RULE_REQUIRED = "required";
export const VALIDATION_RULE_MIN = "min";
export const VALIDATION_RULE_MAX = "max";
export const VALIDATION_RULE_MIN_LENGTH = "min_length";
export const VALIDATION_RULE_MAX_LENGTH = "max_length";
export const VALIDATION_RULE_PATTERN = "pattern";
export const VALIDATION_RULE_ENUM = "enum";

export type ValidationRuleName =
  | typeof VALIDATION_RULE_REQUIRED
  | typeof VALIDATION_RULE_MIN
  | typeof VALIDATION_RULE_MAX
  | typeof VALIDATION_RULE_MIN_LENGTH
  | typeof VALIDATION_RULE_MAX_LENGTH
  | typeof VALIDATION_RULE_PATTERN
  | typeof VALIDATION_RULE_ENUM;

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

export type ValidationSchema<Req> = Partial<
  Record<Extract<keyof Req, string>, readonly ValidationRuleSpec[]>
>;

export const required = (message?: string): ValidationRuleSpec => ({
  rule: VALIDATION_RULE_REQUIRED,
  message,
});

export const min = (value: number, message?: string): ValidationRuleSpec => ({
  rule: VALIDATION_RULE_MIN,
  value,
  message,
});

export const max = (value: number, message?: string): ValidationRuleSpec => ({
  rule: VALIDATION_RULE_MAX,
  value,
  message,
});

export const minLength = (
  value: number,
  message?: string,
): ValidationRuleSpec => ({
  rule: VALIDATION_RULE_MIN_LENGTH,
  value,
  message,
});

export const maxLength = (
  value: number,
  message?: string,
): ValidationRuleSpec => ({
  rule: VALIDATION_RULE_MAX_LENGTH,
  value,
  message,
});

export const pattern = (
  value: string | RegExp,
  message?: string,
): ValidationRuleSpec => ({
  rule: VALIDATION_RULE_PATTERN,
  value: value instanceof RegExp ? value.source : String(value),
  message,
});

export const oneOf = (
  values: readonly string[],
  message?: string,
): ValidationRuleSpec => ({
  rule: VALIDATION_RULE_ENUM,
  value: [...values],
  message,
});

export function validateValue<Req>(
  value: Req,
  schema: ValidationSchema<Req> | undefined,
): ValidationFieldError[] {
  if (!schema || typeof schema !== "object") return [];
  const record = value as Record<string, unknown>;
  const errors: ValidationFieldError[] = [];
  for (const key of Object.keys(schema)) {
    const rules = schema[key as Extract<keyof Req, string>] ?? [];
    for (const rule of rules) {
      const field = String(rule.field ?? key);
      const error = validateRule(field, record[key], rule);
      if (!error) continue;
      errors.push(error);
      if (rule.rule === VALIDATION_RULE_REQUIRED) break;
    }
  }
  return errors;
}

export function validationError(
  errors: readonly ValidationFieldError[],
): AppTheoryError {
  return new AppTheoryError("app.validation_failed", "validation failed", {
    statusCode: 422,
    details: { errors: errors.map((error) => ({ ...error })) },
  });
}

export function validateOrThrow<Req>(
  value: Req,
  schema: ValidationSchema<Req> | undefined,
): void {
  const errors = validateValue(value, schema);
  if (errors.length > 0) {
    throw validationError(errors);
  }
}

function validateRule(
  field: string,
  value: unknown,
  rule: ValidationRuleSpec,
): ValidationFieldError | null {
  switch (rule.rule) {
    case VALIDATION_RULE_REQUIRED:
      if (isEmptyValue(value)) {
        return fieldError(
          field,
          rule.rule,
          rule.message ?? `${field} is required`,
        );
      }
      return null;
    case VALIDATION_RULE_MIN: {
      const actual = numericValue(value);
      const limit = Number(rule.value);
      if (actual !== null && Number.isFinite(limit) && actual < limit) {
        return fieldError(
          field,
          rule.rule,
          rule.message ?? `${field} must be >= ${String(rule.value)}`,
        );
      }
      return null;
    }
    case VALIDATION_RULE_MAX: {
      const actual = numericValue(value);
      const limit = Number(rule.value);
      if (actual !== null && Number.isFinite(limit) && actual > limit) {
        return fieldError(
          field,
          rule.rule,
          rule.message ?? `${field} must be <= ${String(rule.value)}`,
        );
      }
      return null;
    }
    case VALIDATION_RULE_MIN_LENGTH: {
      const actual = lengthValue(value);
      const limit = Number(rule.value);
      if (actual !== null && Number.isFinite(limit) && actual < limit) {
        return fieldError(
          field,
          rule.rule,
          rule.message ?? `${field} length must be >= ${String(rule.value)}`,
        );
      }
      return null;
    }
    case VALIDATION_RULE_MAX_LENGTH: {
      const actual = lengthValue(value);
      const limit = Number(rule.value);
      if (actual !== null && Number.isFinite(limit) && actual > limit) {
        return fieldError(
          field,
          rule.rule,
          rule.message ?? `${field} length must be <= ${String(rule.value)}`,
        );
      }
      return null;
    }
    case VALIDATION_RULE_PATTERN: {
      const raw = typeof value === "string" ? value : null;
      if (raw === null) return null;
      const patternValue = String(rule.value ?? "");
      if (!new RegExp(patternValue).test(raw)) {
        return fieldError(
          field,
          rule.rule,
          rule.message ?? `${field} must match pattern`,
        );
      }
      return null;
    }
    case VALIDATION_RULE_ENUM: {
      const allowed = Array.isArray(rule.value)
        ? rule.value.map((item) => String(item))
        : String(rule.value ?? "")
            .split("|")
            .map((item) => item.trim())
            .filter(Boolean);
      const actual = String(value ?? "");
      if (!allowed.includes(actual)) {
        return fieldError(
          field,
          rule.rule,
          rule.message ?? `${field} must be one of ${allowed.join(", ")}`,
        );
      }
      return null;
    }
  }
}

function fieldError(
  field: string,
  rule: ValidationRuleName,
  message: string,
): ValidationFieldError {
  return { field, rule, message };
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  return false;
}

function numericValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function lengthValue(value: unknown): number | null {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  return null;
}
