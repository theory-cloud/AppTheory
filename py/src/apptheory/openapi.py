from __future__ import annotations

import json as jsonlib
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any

from apptheory.validate import (
    VALIDATION_RULE_ENUM,
    VALIDATION_RULE_MAX,
    VALIDATION_RULE_MAX_LENGTH,
    VALIDATION_RULE_MIN,
    VALIDATION_RULE_MIN_LENGTH,
    VALIDATION_RULE_PATTERN,
    VALIDATION_RULE_REQUIRED,
)


@dataclass(frozen=True, slots=True)
class OpenAPIValidationRule:
    rule: str
    value: int | float | str | list[int | float | str] | None = None


@dataclass(frozen=True, slots=True)
class OpenAPIFieldSpec:
    field: str
    source: str
    name: str
    type: str
    array: bool = False
    required: bool = False
    validation: list[OpenAPIValidationRule] | None = None


@dataclass(frozen=True, slots=True)
class OpenAPIRequestSpec:
    fields: list[OpenAPIFieldSpec] | None = None


@dataclass(frozen=True, slots=True)
class OpenAPIResponseSpec:
    description: str = ""
    fields: list[OpenAPIFieldSpec] | None = None


@dataclass(frozen=True, slots=True)
class OpenAPIRouteSpec:
    method: str
    path: str
    operation_id: str
    response: OpenAPIResponseSpec
    summary: str = ""
    tags: list[str] | None = None
    success_status: int | None = None
    request: OpenAPIRequestSpec | None = None


@dataclass(frozen=True, slots=True)
class OpenAPISpec:
    title: str
    version: str
    routes: list[OpenAPIRouteSpec]


def generate_openapi(spec: OpenAPISpec | Mapping[str, Any]) -> dict[str, Any]:
    raw_spec = _as_mapping(spec)
    title = str(raw_spec.get("title", "")).strip()
    version = str(raw_spec.get("version", "")).strip()
    if not title:
        raise ValueError("apptheory: openapi title is required")
    if not version:
        raise ValueError("apptheory: openapi version is required")

    paths: dict[str, Any] = {}
    routes = sorted(_sequence(raw_spec.get("routes")), key=_route_sort_key)
    seen: set[str] = set()
    for route_value in routes:
        route = _as_mapping(route_value)
        path_value = _normalize_path(str(route.get("path", "")))
        method = _normalize_method(str(route.get("method", "")))
        if not path_value:
            raise ValueError("apptheory: openapi route path is required")
        if not method:
            raise ValueError(f"apptheory: openapi route {path_value} method is required")
        operation_id = str(_first(route, "operation_id", "operationId")).strip()
        if not operation_id:
            raise ValueError(f"apptheory: openapi route {method.upper()} {path_value} operation_id is required")
        key = f"{method} {path_value}"
        if key in seen:
            raise ValueError(f"apptheory: openapi route {key} is duplicated")
        seen.add(key)
        paths.setdefault(path_value, {})[method] = _operation_for_route(route, operation_id)

    return {
        "components": _openapi_components(),
        "info": {"title": title, "version": version},
        "openapi": "3.1.0",
        "paths": paths,
    }


def generate_openapi_json(spec: OpenAPISpec | Mapping[str, Any]) -> str:
    return jsonlib.dumps(generate_openapi(spec), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _openapi_components() -> dict[str, Any]:
    return {
        "responses": {
            "AppBadRequest": {
                "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AppTheoryError"}}},
                "description": "AppTheory bad request error envelope",
            },
            "AppValidationFailed": {
                "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AppTheoryError"}}},
                "description": "AppTheory validation failure error envelope",
            },
        },
        "schemas": {
            "AppTheoryError": {
                "additionalProperties": False,
                "properties": {
                    "error": {
                        "additionalProperties": True,
                        "properties": {
                            "code": {"type": "string"},
                            "details": {"additionalProperties": True, "type": "object"},
                            "message": {"type": "string"},
                            "request_id": {"type": "string"},
                        },
                        "required": ["code", "message"],
                        "type": "object",
                    }
                },
                "required": ["error"],
                "type": "object",
            }
        },
    }


def _operation_for_route(route: Mapping[str, Any], operation_id: str) -> dict[str, Any]:
    raw_success_status = _first(route, "success_status", "successStatus")
    success_status = 200 if raw_success_status is None else int(raw_success_status)
    if success_status < 100 or success_status > 599:
        method = str(route.get("method", "")).upper()
        path_value = str(route.get("path", ""))
        raise ValueError(f"apptheory: openapi route {method} {path_value} success_status must be an HTTP status")

    response = _as_mapping(route.get("response"))
    operation: dict[str, Any] = {
        "operationId": operation_id,
        "responses": {
            str(success_status): _success_response(response),
            "400": {"$ref": "#/components/responses/AppBadRequest"},
            "422": {"$ref": "#/components/responses/AppValidationFailed"},
        },
    }

    request = _as_mapping(route.get("request"))
    request_fields = _sequence(request.get("fields"))
    parameters = _parameters_for_fields(request_fields)
    if parameters:
        operation["parameters"] = parameters

    body_fields = _fields_for_source(request_fields, "body")
    if body_fields:
        operation["requestBody"] = {
            "content": {"application/json": {"schema": _object_schema(body_fields)}},
            "required": True,
        }

    summary = str(route.get("summary", "")).strip()
    if summary:
        operation["summary"] = summary
    tags = _sorted_tags(_sequence(route.get("tags")))
    if tags:
        operation["tags"] = tags
    return operation


def _success_response(response: Mapping[str, Any]) -> dict[str, Any]:
    description = str(response.get("description", "")).strip() or "success"
    out: dict[str, Any] = {"description": description}
    fields = _fields_for_source(_sequence(response.get("fields")), "response")
    if fields:
        out["content"] = {"application/json": {"schema": _object_schema(fields)}}
    return out


def _parameters_for_fields(fields: Sequence[Any]) -> list[dict[str, Any]]:
    params: list[dict[str, Any]] = []
    for field_value in fields:
        field = _as_mapping(field_value)
        source = _normalize_source(str(field.get("source", "")))
        if source in {"path", "query", "header"}:
            normalized = dict(field)
            normalized["source"] = source
            params.append(normalized)
            continue
        if source == "body":
            continue
        field_name = field.get("field", "")
        field_source = field.get("source", "")
        raise ValueError(f"apptheory: openapi request field {field_name} has unsupported source {field_source}")
    params.sort(key=lambda field: (_source_rank(str(field.get("source", ""))), str(field.get("name", "")).strip()))

    out: list[dict[str, Any]] = []
    for field in params:
        name = str(field.get("name", "")).strip()
        if not name:
            raise ValueError(f"apptheory: openapi request field {field.get('field', '')} name is required")
        out.append(
            {
                "in": field["source"],
                "name": name,
                "required": _field_required(field),
                "schema": _field_schema(field),
            }
        )
    return out


def _fields_for_source(fields: Sequence[Any], source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for field_value in fields:
        field = _as_mapping(field_value)
        field_source = _normalize_source(str(field.get("source", "")))
        if field_source != source:
            continue
        name = str(field.get("name", "")).strip()
        if not name:
            raise ValueError(f"apptheory: openapi field {field.get('field', '')} name is required")
        normalized = dict(field)
        normalized["name"] = name
        normalized["source"] = field_source
        out.append(normalized)
    return sorted(out, key=lambda field: str(field.get("name", "")))


def _object_schema(fields: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required_fields: list[str] = []
    for field in fields:
        name = str(field.get("name", ""))
        properties[name] = _field_schema(field)
        if _field_required(field):
            required_fields.append(name)
    schema: dict[str, Any] = {"additionalProperties": False, "properties": properties, "type": "object"}
    if required_fields:
        schema["required"] = sorted(required_fields)
    return schema


def _field_schema(field: Mapping[str, Any]) -> dict[str, Any]:
    base_type = _normalize_field_type(str(field.get("type", "")))
    is_array = bool(field.get("array", False))
    if is_array:
        items: dict[str, Any] = {"type": base_type}
        if base_type == "object":
            items["additionalProperties"] = True
        schema: dict[str, Any] = {"items": items, "type": "array"}
    else:
        schema = {"type": base_type}
        if base_type == "object":
            schema["additionalProperties"] = True

    for rule in _sequence(field.get("validation")):
        _apply_validation_rule(schema, base_type, is_array, field, _as_mapping(rule))
    return schema


def _apply_validation_rule(
    schema: dict[str, Any],
    base_type: str,
    is_array: bool,
    field: Mapping[str, Any],
    rule: Mapping[str, Any],
) -> None:
    rule_name = str(rule.get("rule", "")).strip()
    value = rule.get("value")
    if rule_name == VALIDATION_RULE_REQUIRED:
        return
    if rule_name == VALIDATION_RULE_MIN and not is_array and base_type in {"integer", "number"}:
        number = _number_value(value)
        if number is not None:
            schema["minimum"] = number
    elif rule_name == VALIDATION_RULE_MAX and not is_array and base_type in {"integer", "number"}:
        number = _number_value(value)
        if number is not None:
            schema["maximum"] = number
    elif rule_name == VALIDATION_RULE_MIN_LENGTH:
        integer = _integer_value(value)
        if integer is None:
            raise ValueError(f"apptheory: openapi field {_field_label(field)} {rule_name} must be an integer")
        _apply_length(schema, base_type, is_array, "min", integer)
    elif rule_name == VALIDATION_RULE_MAX_LENGTH:
        integer = _integer_value(value)
        if integer is None:
            raise ValueError(f"apptheory: openapi field {_field_label(field)} {rule_name} must be an integer")
        _apply_length(schema, base_type, is_array, "max", integer)
    elif rule_name == VALIDATION_RULE_PATTERN and not is_array and base_type == "string":
        schema["pattern"] = str(value or "")
    elif rule_name == VALIDATION_RULE_ENUM:
        values = _enum_values(value)
        if values:
            schema["enum"] = values


def _apply_length(schema: dict[str, Any], base_type: str, is_array: bool, kind: str, value: int) -> None:
    if is_array:
        schema["minItems" if kind == "min" else "maxItems"] = value
    elif base_type == "object":
        schema["minProperties" if kind == "min" else "maxProperties"] = value
    else:
        schema["minLength" if kind == "min" else "maxLength"] = value


def _field_required(field: Mapping[str, Any]) -> bool:
    if _normalize_source(str(field.get("source", ""))) == "path" or bool(field.get("required", False)):
        return True
    return any(_as_mapping(rule).get("rule") == VALIDATION_RULE_REQUIRED for rule in _sequence(field.get("validation")))


def _field_label(field: Mapping[str, Any]) -> str:
    return str(field.get("field") or "").strip() or str(field.get("name") or "").strip() or "field"


def _route_sort_key(route_value: Any) -> tuple[str, int, str]:
    route = _as_mapping(route_value)
    method = _normalize_method(str(route.get("method", "")))
    return (_normalize_path(str(route.get("path", ""))), _method_rank(method), method)


def _normalize_path(path: str) -> str:
    trimmed = path.strip()
    if not trimmed:
        return ""
    return trimmed if trimmed.startswith("/") else f"/{trimmed}"


def _normalize_method(method: str) -> str:
    return method.strip().lower()


def _normalize_source(source: str) -> str:
    return source.strip().lower()


def _normalize_field_type(value: str) -> str:
    match value.strip().lower():
        case "int" | "integer":
            return "integer"
        case "float" | "number":
            return "number"
        case "bool" | "boolean":
            return "boolean"
        case "map" | "object":
            return "object"
        case _:
            return "string"


def _method_rank(method: str) -> int:
    order = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]
    try:
        return order.index(method)
    except ValueError:
        return len(order)


def _source_rank(source: str) -> int:
    return {"path": 0, "query": 1, "header": 2, "body": 3, "response": 4}.get(source, 99)


def _sorted_tags(tags: Sequence[Any]) -> list[str]:
    return sorted({str(tag).strip() for tag in tags if str(tag).strip()})


def _enum_values(value: Any) -> list[str]:
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [str(item).strip() for item in value]
    if isinstance(value, str):
        return [part.strip() for part in value.split("|") if part.strip()]
    if value is None:
        return []
    return [str(value).strip()]


def _number_value(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return value
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return None
        return int(parsed) if parsed.is_integer() else parsed
    return None


def _integer_value(value: Any) -> int | None:
    number = _number_value(value)
    if number is None:
        return None
    return int(number) if float(number).is_integer() else None


def _as_mapping(value: Any) -> dict[str, Any]:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if isinstance(value, Mapping):
        return dict(value)
    return {}


def _sequence(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return list(value)
    return []


def _first(mapping: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None
