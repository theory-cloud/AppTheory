from __future__ import annotations

import re
from dataclasses import dataclass
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
    if rule.rule == VALIDATION_RULE_REQUIRED:
        if _is_empty(value):
            return _field_error(field, rule, rule.message or f"{field} is required")
        return None
    if rule.rule == VALIDATION_RULE_MIN:
        actual = _numeric(value)
        limit = _numeric(rule.value)
        if actual is not None and limit is not None and actual < limit:
            return _field_error(field, rule, rule.message or f"{field} must be >= {rule.value}")
        return None
    if rule.rule == VALIDATION_RULE_MAX:
        actual = _numeric(value)
        limit = _numeric(rule.value)
        if actual is not None and limit is not None and actual > limit:
            return _field_error(field, rule, rule.message or f"{field} must be <= {rule.value}")
        return None
    if rule.rule == VALIDATION_RULE_MIN_LENGTH:
        actual = _length(value)
        limit = _numeric(rule.value)
        if actual is not None and limit is not None and actual < limit:
            return _field_error(field, rule, rule.message or f"{field} length must be >= {rule.value}")
        return None
    if rule.rule == VALIDATION_RULE_MAX_LENGTH:
        actual = _length(value)
        limit = _numeric(rule.value)
        if actual is not None and limit is not None and actual > limit:
            return _field_error(field, rule, rule.message or f"{field} length must be <= {rule.value}")
        return None
    if rule.rule == VALIDATION_RULE_PATTERN:
        if isinstance(value, str) and re.search(str(rule.value or ""), value) is None:
            return _field_error(field, rule, rule.message or f"{field} must match pattern")
        return None
    if rule.rule == VALIDATION_RULE_ENUM:
        allowed = (
            [str(item) for item in rule.value] if isinstance(rule.value, list) else str(rule.value or "").split("|")
        )
        allowed = [item.strip() for item in allowed if item.strip()]
        if str(value or "") not in allowed:
            return _field_error(field, rule, rule.message or f"{field} must be one of {', '.join(allowed)}")
        return None
    return None


def _field_error(field: str, rule: ValidationRule, message: str) -> ValidationFieldError:
    return ValidationFieldError(field=field, rule=str(rule.rule), message=message)


def _value_for_key(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, set, dict)):
        return len(value) == 0
    return False


def _numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _length(value: Any) -> int | None:
    if isinstance(value, str | list | tuple | set | dict):
        return len(value)
    return None
