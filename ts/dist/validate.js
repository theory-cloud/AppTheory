import { AppTheoryError } from "./errors.js";
export const VALIDATION_RULE_REQUIRED = "required";
export const VALIDATION_RULE_MIN = "min";
export const VALIDATION_RULE_MAX = "max";
export const VALIDATION_RULE_MIN_LENGTH = "min_length";
export const VALIDATION_RULE_MAX_LENGTH = "max_length";
export const VALIDATION_RULE_PATTERN = "pattern";
export const VALIDATION_RULE_ENUM = "enum";
export const required = (message) => ({
    rule: VALIDATION_RULE_REQUIRED,
    message,
});
export const min = (value, message) => ({
    rule: VALIDATION_RULE_MIN,
    value,
    message,
});
export const max = (value, message) => ({
    rule: VALIDATION_RULE_MAX,
    value,
    message,
});
export const minLength = (value, message) => ({
    rule: VALIDATION_RULE_MIN_LENGTH,
    value,
    message,
});
export const maxLength = (value, message) => ({
    rule: VALIDATION_RULE_MAX_LENGTH,
    value,
    message,
});
export const pattern = (value, message) => ({
    rule: VALIDATION_RULE_PATTERN,
    value: value instanceof RegExp ? value.source : String(value),
    message,
});
export const oneOf = (values, message) => ({
    rule: VALIDATION_RULE_ENUM,
    value: [...values],
    message,
});
export function validateValue(value, schema) {
    if (!schema || typeof schema !== "object")
        return [];
    const record = value;
    const errors = [];
    for (const key of Object.keys(schema)) {
        const rules = schema[key] ?? [];
        for (const rule of rules) {
            const field = String(rule.field ?? key);
            const error = validateRule(field, record[key], rule);
            if (!error)
                continue;
            errors.push(error);
            if (rule.rule === VALIDATION_RULE_REQUIRED)
                break;
        }
    }
    return errors;
}
export function validationError(errors) {
    return new AppTheoryError("app.validation_failed", "validation failed", {
        statusCode: 422,
        details: { errors: errors.map((error) => ({ ...error })) },
    });
}
export function validateOrThrow(value, schema) {
    const errors = validateValue(value, schema);
    if (errors.length > 0) {
        throw validationError(errors);
    }
}
function validateRule(field, value, rule) {
    const configError = validateRuleConfig(field, rule);
    if (configError)
        return configError;
    switch (rule.rule) {
        case VALIDATION_RULE_REQUIRED:
            if (isEmptyValue(value)) {
                return fieldError(field, rule.rule, rule.message ?? `${field} is required`);
            }
            return null;
        case VALIDATION_RULE_MIN: {
            const actual = numericValue(value);
            const limit = Number(rule.value);
            if (actual !== null && Number.isFinite(limit) && actual < limit) {
                return fieldError(field, rule.rule, rule.message ?? `${field} must be >= ${String(rule.value)}`);
            }
            return null;
        }
        case VALIDATION_RULE_MAX: {
            const actual = numericValue(value);
            const limit = Number(rule.value);
            if (actual !== null && Number.isFinite(limit) && actual > limit) {
                return fieldError(field, rule.rule, rule.message ?? `${field} must be <= ${String(rule.value)}`);
            }
            return null;
        }
        case VALIDATION_RULE_MIN_LENGTH: {
            const actual = lengthValue(value);
            const limit = Number(rule.value);
            if (actual !== null && Number.isFinite(limit) && actual < limit) {
                return fieldError(field, rule.rule, rule.message ?? `${field} length must be >= ${String(rule.value)}`);
            }
            return null;
        }
        case VALIDATION_RULE_MAX_LENGTH: {
            const actual = lengthValue(value);
            const limit = Number(rule.value);
            if (actual !== null && Number.isFinite(limit) && actual > limit) {
                return fieldError(field, rule.rule, rule.message ?? `${field} length must be <= ${String(rule.value)}`);
            }
            return null;
        }
        case VALIDATION_RULE_PATTERN: {
            const raw = typeof value === "string" ? value : null;
            if (raw === null)
                return null;
            const patternValue = String(rule.value ?? "");
            if (!new RegExp(patternValue).test(raw)) {
                return fieldError(field, rule.rule, rule.message ?? `${field} must match pattern`);
            }
            return null;
        }
        case VALIDATION_RULE_ENUM: {
            const allowed = enumValues(rule.value);
            const actual = String(value ?? "");
            if (!allowed.includes(actual)) {
                return fieldError(field, rule.rule, rule.message ?? `${field} must be one of ${allowed.join(", ")}`);
            }
            return null;
        }
    }
}
function validateRuleConfig(field, rule) {
    const ruleName = typeof rule.rule === "string" ? rule.rule : "";
    let invalid = false;
    switch (ruleName) {
        case VALIDATION_RULE_REQUIRED:
            invalid =
                rule.value !== undefined &&
                    rule.value !== null &&
                    String(rule.value).trim() !== "";
            break;
        case VALIDATION_RULE_MIN:
        case VALIDATION_RULE_MAX:
            invalid = !isFiniteRuleNumber(rule.value);
            break;
        case VALIDATION_RULE_MIN_LENGTH:
        case VALIDATION_RULE_MAX_LENGTH:
            invalid = !isIntegerRuleNumber(rule.value);
            break;
        case VALIDATION_RULE_PATTERN:
            try {
                new RegExp(String(rule.value ?? ""));
            }
            catch {
                invalid = true;
            }
            break;
        case VALIDATION_RULE_ENUM:
            invalid = enumValues(rule.value).length === 0;
            break;
        default:
            invalid = true;
            break;
    }
    if (!invalid)
        return null;
    const displayRule = ruleName || "invalid";
    return fieldError(field, displayRule, `${field} has invalid validation rule ${displayRule}`);
}
function fieldError(field, rule, message) {
    return { field, rule, message };
}
function isEmptyValue(value) {
    if (value === null || value === undefined)
        return true;
    return false;
}
function numericValue(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    return value;
}
function lengthValue(value) {
    if (typeof value === "string" || Array.isArray(value))
        return value.length;
    return null;
}
function isFiniteRuleNumber(value) {
    if (value === null || value === undefined || String(value).trim() === "") {
        return false;
    }
    return Number.isFinite(Number(value));
}
function isIntegerRuleNumber(value) {
    if (!isFiniteRuleNumber(value))
        return false;
    return Number.isInteger(Number(value));
}
function enumValues(value) {
    return Array.isArray(value)
        ? value.map((item) => String(item))
        : String(value ?? "")
            .split("|")
            .map((item) => item.trim())
            .filter(Boolean);
}
//# sourceMappingURL=validate.js.map