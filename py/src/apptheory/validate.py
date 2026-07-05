from __future__ import annotations

import re
from dataclasses import dataclass
from math import isfinite
from typing import Any

from apptheory.errors import AppTheoryError

VALIDATION_RULE_REQUIRED = "required"
VALIDATION_RULE_MIN = "min"
VALIDATION_RULE_MAX = "max"
VALIDATION_RULE_MIN_LENGTH = "min_length"
VALIDATION_RULE_MAX_LENGTH = "max_length"
VALIDATION_RULE_PATTERN = "pattern"
VALIDATION_RULE_ENUM = "enum"

ValidationRuleName = str


@dataclass(frozen=True, slots=True)
class ValidationRule:
    rule: ValidationRuleName
    value: int | float | str | list[str] | None = None
    field: str = ""
    message: str = ""


@dataclass(frozen=True, slots=True)
class ValidationFieldError:
    field: str
    rule: str
    message: str


ValidationSchema = dict[str, list[ValidationRule]]


def required(message: str = "") -> ValidationRule:
    return ValidationRule(rule=VALIDATION_RULE_REQUIRED, message=message)


def min_value(value: int | float, message: str = "") -> ValidationRule:
    return ValidationRule(rule=VALIDATION_RULE_MIN, value=value, message=message)


def max_value(value: int | float, message: str = "") -> ValidationRule:
    return ValidationRule(rule=VALIDATION_RULE_MAX, value=value, message=message)


def min_length(value: int, message: str = "") -> ValidationRule:
    return ValidationRule(rule=VALIDATION_RULE_MIN_LENGTH, value=value, message=message)


def max_length(value: int, message: str = "") -> ValidationRule:
    return ValidationRule(rule=VALIDATION_RULE_MAX_LENGTH, value=value, message=message)


def pattern(value: str, message: str = "") -> ValidationRule:
    return ValidationRule(rule=VALIDATION_RULE_PATTERN, value=value, message=message)


def one_of(values: list[str] | tuple[str, ...], message: str = "") -> ValidationRule:
    return ValidationRule(rule=VALIDATION_RULE_ENUM, value=[str(value) for value in values], message=message)


def validate_value(value: Any, schema: ValidationSchema | None) -> list[ValidationFieldError]:
    if not schema:
        return []
    errors: list[ValidationFieldError] = []
    for key, rules in schema.items():
        actual = _value_for_key(value, key)
        for rule in rules:
            field = str(rule.field or key)
            field_error = _validate_rule(field, actual, rule)
            if field_error is None:
                continue
            errors.append(field_error)
            if rule.rule == VALIDATION_RULE_REQUIRED:
                break
    return errors


def validate_or_raise(value: Any, schema: ValidationSchema | None) -> None:
    errors = validate_value(value, schema)
    if errors:
        raise validation_error(errors)


def validation_error(errors: list[ValidationFieldError]) -> AppTheoryError:
    return AppTheoryError(
        code="app.validation_failed",
        message="validation failed",
        status_code=422,
        details={"errors": [{"field": err.field, "rule": err.rule, "message": err.message} for err in errors]},
    )


def _validate_rule(field: str, value: Any, rule: ValidationRule) -> ValidationFieldError | None:
    config_error = _validate_rule_config(field, rule)
    if config_error is not None:
        return config_error

    if rule.rule == VALIDATION_RULE_REQUIRED:
        if _is_empty(value):
            return _field_error(field, rule, rule.message or f"{field} is required")
        return None
    if rule.rule in {VALIDATION_RULE_MIN, VALIDATION_RULE_MAX}:
        return _validate_numeric_rule(field, value, rule)
    if rule.rule in {VALIDATION_RULE_MIN_LENGTH, VALIDATION_RULE_MAX_LENGTH}:
        return _validate_length_rule(field, value, rule)
    if rule.rule == VALIDATION_RULE_PATTERN:
        return _validate_pattern_rule(field, value, rule)
    if rule.rule == VALIDATION_RULE_ENUM:
        return _validate_enum_rule(field, value, rule)
    return None


def _validate_numeric_rule(field: str, value: Any, rule: ValidationRule) -> ValidationFieldError | None:
    actual = _numeric(value)
    limit = _rule_number(rule.value)
    if actual is None or limit is None:
        return None
    if rule.rule == VALIDATION_RULE_MIN and actual < limit:
        return _field_error(field, rule, rule.message or f"{field} must be >= {rule.value}")
    if rule.rule == VALIDATION_RULE_MAX and actual > limit:
        return _field_error(field, rule, rule.message or f"{field} must be <= {rule.value}")
    return None


def _validate_length_rule(field: str, value: Any, rule: ValidationRule) -> ValidationFieldError | None:
    actual = _length(value)
    limit = _rule_number(rule.value)
    if actual is None or limit is None:
        return None
    if rule.rule == VALIDATION_RULE_MIN_LENGTH and actual < limit:
        return _field_error(field, rule, rule.message or f"{field} length must be >= {rule.value}")
    if rule.rule == VALIDATION_RULE_MAX_LENGTH and actual > limit:
        return _field_error(field, rule, rule.message or f"{field} length must be <= {rule.value}")
    return None


def _validate_pattern_rule(field: str, value: Any, rule: ValidationRule) -> ValidationFieldError | None:
    if isinstance(value, str) and re.search(str(rule.value or ""), value) is None:
        return _field_error(field, rule, rule.message or f"{field} must match pattern")
    return None


def _validate_enum_rule(field: str, value: Any, rule: ValidationRule) -> ValidationFieldError | None:
    allowed = _enum_values(rule.value)
    if str(value or "") not in allowed:
        return _field_error(field, rule, rule.message or f"{field} must be one of {', '.join(allowed)}")
    return None


def _validate_rule_config(field: str, rule: ValidationRule) -> ValidationFieldError | None:
    invalid = False
    if rule.rule == VALIDATION_RULE_REQUIRED:
        invalid = rule.value is not None and str(rule.value).strip() != ""
    elif rule.rule in {VALIDATION_RULE_MIN, VALIDATION_RULE_MAX}:
        invalid = _rule_number(rule.value) is None
    elif rule.rule in {VALIDATION_RULE_MIN_LENGTH, VALIDATION_RULE_MAX_LENGTH}:
        number = _rule_number(rule.value)
        invalid = number is None or int(number) != number
    elif rule.rule == VALIDATION_RULE_PATTERN:
        try:
            re.compile(str(rule.value or ""))
        except re.error:
            invalid = True
    elif rule.rule == VALIDATION_RULE_ENUM:
        invalid = not _enum_values(rule.value)
    else:
        invalid = True
    if not invalid:
        return None
    return _field_error(
        field,
        rule,
        rule.message or f"{field} has invalid validation rule {rule.rule}",
    )


def _field_error(field: str, rule: ValidationRule, message: str) -> ValidationFieldError:
    return ValidationFieldError(field=field, rule=str(rule.rule), message=message)


def _value_for_key(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _is_empty(value: Any) -> bool:
    return value is None


def _numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _rule_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or str(value).strip() == "":
        return None
    try:
        out = float(str(value))
    except ValueError:
        return None
    return out if isfinite(out) else None


def _enum_values(value: Any) -> list[str]:
    allowed = [str(item) for item in value] if isinstance(value, list) else str(value or "").split("|")
    return [item.strip() for item in allowed if item.strip()]


def _length(value: Any) -> int | None:
    if isinstance(value, str | list | tuple | set | dict):
        return len(value)
    return None
