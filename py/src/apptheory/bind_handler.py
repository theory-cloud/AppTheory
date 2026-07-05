from __future__ import annotations

import asyncio
import datetime as dt
import inspect
import json as jsonlib
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, fields, is_dataclass
from types import NoneType, UnionType
from typing import Any, get_args, get_origin

from apptheory.context import Context
from apptheory.errors import AppError, AppTheoryError, app_theory_error_from_app_error, status_for_error_code
from apptheory.response import Response, json
from apptheory.validate import ValidationRule, ValidationSchema, validate_or_raise

_UNSET = object()


@dataclass(frozen=True, slots=True)
class BindField:
    source: str
    name: str = ""
    value_type: str = ""
    field_name: str = ""
    array: bool = False
    validate: list[ValidationRule] | None = None


@dataclass(frozen=True, slots=True)
class _SourceValues:
    present: bool
    values: list[Any]


@dataclass(slots=True)
class BindConfig[ReqT]:
    model: type[ReqT]
    body: bool = False
    query: bool = False
    path: bool = False
    headers: bool = False
    strict_json: bool = False
    success_status: int = 200
    validation: ValidationSchema | None = None
    validate: Callable[[Context, ReqT], None | Awaitable[None]] | None = None


type TypedHandler[ReqT, RespT] = Callable[[Context, ReqT], RespT | Awaitable[RespT]]


def body(
    name: str = "",
    *,
    default: Any = _UNSET,
    value_type: str = "",
    validate: list[ValidationRule] | None = None,
    array: bool = False,
):
    return _bind_field("body", name, default=default, value_type=value_type, validate=validate, array=array)


def query(
    name: str = "",
    *,
    default: Any = _UNSET,
    value_type: str = "",
    validate: list[ValidationRule] | None = None,
    array: bool = False,
):
    return _bind_field("query", name, default=default, value_type=value_type, validate=validate, array=array)


def path(
    name: str = "",
    *,
    default: Any = _UNSET,
    value_type: str = "",
    validate: list[ValidationRule] | None = None,
    array: bool = False,
):
    return _bind_field("path", name, default=default, value_type=value_type, validate=validate, array=array)


def header(
    name: str = "",
    *,
    default: Any = _UNSET,
    value_type: str = "",
    validate: list[ValidationRule] | None = None,
    array: bool = False,
):
    return _bind_field("header", name, default=default, value_type=value_type, validate=validate, array=array)


def bind_handler[ReqT, RespT](config: BindConfig[ReqT], handler: TypedHandler[ReqT, RespT]):
    def _handler(ctx: Context) -> Response:
        req = bind_request(ctx, config)
        resp = _resolve(handler(ctx, req))
        return json(config.success_status or 200, resp)

    return _handler


def bind_request[ReqT](ctx: Context, config: BindConfig[ReqT]) -> ReqT:
    model = config.model
    body_value: dict[str, Any] | None = None
    if config.body:
        body_value = _parse_body(ctx)
    bind_fields = _model_fields(model, body_enabled=config.body)
    if config.strict_json and body_value is not None:
        expected_body_names = {bind.name for bind, _annotation in bind_fields.values() if bind.source == "body"}
        for key in body_value:
            if key not in expected_body_names:
                raise _binding_error("body", key, "", None)

    values: dict[str, Any] = {}
    for attr, (bind, annotation) in bind_fields.items():
        source = _source_values(ctx, body_value, bind.source, bind.name)
        if not source.present:
            continue
        try:
            values[attr] = _convert_values(source.values, annotation, bind)
        except Exception as exc:
            raise _binding_error(bind.source, bind.name, bind.field_name or attr, exc) from exc

    req = _construct_model(model, values)
    validation = _merge_validation(config.validation, bind_fields)
    validate_or_raise(req, validation)

    if config.validate is not None:
        try:
            _resolve(config.validate(ctx, req))
        except Exception as exc:
            raise _normalize_validation_error(exc) from exc

    return req


def _bind_field(
    source: str,
    name: str,
    *,
    default: Any,
    value_type: str,
    validate: list[ValidationRule] | None,
    array: bool = False,
):
    metadata = {"apptheory_bind": BindField(source, name, value_type=value_type, validate=validate, array=array)}
    if default is _UNSET:
        return field(default=None, metadata=metadata)
    return field(default=default, metadata=metadata)


def _resolve[RespT](value: RespT | Awaitable[RespT]) -> RespT:
    if not inspect.isawaitable(value):
        return value

    async def _await_any(awaitable: Awaitable[RespT]) -> RespT:
        return await awaitable

    try:
        return asyncio.run(_await_any(value))
    except RuntimeError as exc:  # pragma: no cover
        raise RuntimeError("apptheory: cannot resolve awaitable from sync bind handler") from exc


def _parse_body(ctx: Context) -> dict[str, Any]:
    if not ctx.request.body:
        raise AppTheoryError("app.bad_request", "request body is empty", status_code=400)
    try:
        parsed = jsonlib.loads(ctx.request.body.decode("utf-8"))
    except Exception as exc:
        raise AppTheoryError("app.bad_request", "invalid json", status_code=400, cause=exc) from exc
    if not isinstance(parsed, dict):
        raise AppTheoryError("app.bad_request", "invalid json", status_code=400)
    return parsed


def _model_fields(model: type[Any], *, body_enabled: bool) -> dict[str, tuple[BindField, Any]]:
    out: dict[str, tuple[BindField, Any]] = {}
    if is_dataclass(model):
        for dataclass_field in fields(model):
            bind = dataclass_field.metadata.get("apptheory_bind")
            if bind is None:
                if not body_enabled:
                    continue
                bind = BindField("body", dataclass_field.name)
            if not bind.name:
                bind = BindField(
                    bind.source,
                    dataclass_field.name,
                    value_type=bind.value_type,
                    field_name=bind.field_name or dataclass_field.name,
                    array=bind.array,
                    validate=bind.validate,
                )
            elif not bind.field_name:
                bind = BindField(
                    bind.source,
                    bind.name,
                    value_type=bind.value_type,
                    field_name=dataclass_field.name,
                    array=bind.array,
                    validate=bind.validate,
                )
            out[dataclass_field.name] = (bind, dataclass_field.type)
        return out

    annotations = getattr(model, "__annotations__", {}) or {}
    for attr, annotation in annotations.items():
        if body_enabled:
            out[attr] = (BindField("body", str(attr), field_name=str(attr)), annotation)
    return out


def _source_values(ctx: Context, body_value: dict[str, Any] | None, source: str, name: str) -> _SourceValues:
    if source == "body":
        if body_value is None or name not in body_value:
            return _SourceValues(False, [])
        value = body_value.get(name)
        return _SourceValues(True, list(value) if isinstance(value, list) else [value])
    if source == "query":
        values = list((ctx.request.query or {}).get(name) or [])
        return _SourceValues(bool(values), values)
    if source == "path":
        value = (ctx.params or {}).get(name)
        return _SourceValues(False, []) if value is None else _SourceValues(True, [value])
    if source == "header":
        values = list((ctx.request.headers or {}).get(name.lower()) or [])
        return _SourceValues(bool(values), values)
    return _SourceValues(False, [])


def _construct_model[ReqT](model: type[ReqT], values: dict[str, Any]) -> ReqT:
    return model(**values)


def _convert_values(values: list[Any], annotation: Any, bind: BindField) -> Any:
    inner, is_list = _inner_type(annotation)
    if bind.array or is_list:
        return [_convert_one(value, inner, bind.value_type) for value in values]
    return _convert_one(values[0], inner, bind.value_type)


def _inner_type(annotation: Any) -> tuple[Any, bool]:
    origin = get_origin(annotation)
    args = [arg for arg in get_args(annotation) if arg is not NoneType]
    if origin is UnionType and args:
        return _inner_type(args[0])
    if origin in {list, tuple, set} and args:
        return args[0], True
    return annotation, False


def _convert_one(value: Any, annotation: Any, value_type: str) -> Any:
    target = value_type or _type_name(annotation)
    if target in {"str", "string"}:
        if value is None:
            return None
        return str(value)
    if target in {"int", "integer"}:
        raw = str(value)
        if re.fullmatch(r"[+-]?\d+", raw) is None:
            raise ValueError("invalid integer")
        return int(raw)
    if target in {"bool", "boolean"}:
        raw = str(value).strip().lower()
        if raw in {"1", "t", "true"}:
            return True
        if raw in {"0", "f", "false"}:
            return False
        raise ValueError("invalid boolean")
    if target in {"float", "number"}:
        return float(str(value))
    if target in {"duration", "timedelta"} or annotation is dt.timedelta:
        return _parse_duration(str(value))
    return value


def _type_name(annotation: Any) -> str:
    if annotation is str:
        return "str"
    if annotation is int:
        return "int"
    if annotation is bool:
        return "bool"
    if annotation is float:
        return "float"
    if annotation is dt.timedelta:
        return "timedelta"
    return str(annotation)


def _parse_duration(raw: str) -> dt.timedelta:
    units = {"h": 3600, "m": 60, "s": 1, "ms": 0.001, "us": 0.000001, "µs": 0.000001, "ns": 0.000000001}
    pattern = re.compile(r"([+-]?\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)")
    consumed = ""
    seconds = 0.0
    for match in pattern.finditer(raw.strip()):
        consumed += match.group(0)
        seconds += float(match.group(1)) * units[match.group(2)]
    if not raw.strip() or consumed != raw.strip():
        raise ValueError("invalid duration")
    return dt.timedelta(seconds=seconds)


def format_duration(value: dt.timedelta) -> str:
    total_ns = int(value.total_seconds() * 1_000_000_000)
    sign = "-" if total_ns < 0 else ""
    remaining = abs(total_ns)
    hour = 3_600_000_000_000
    minute = 60_000_000_000
    second = 1_000_000_000
    parts: list[str] = []
    hours, remaining = divmod(remaining, hour)
    if hours:
        parts.append(f"{hours}h")
    minutes, remaining = divmod(remaining, minute)
    if minutes:
        parts.append(f"{minutes}m")
    seconds, remaining = divmod(remaining, second)
    if seconds or parts:
        parts.append(f"{seconds}s")
    elif remaining == 0:
        parts.append("0s")
    if remaining:
        parts.append(f"{remaining}ns")
    return sign + "".join(parts)


def _binding_error(source: str, name: str, field_name: str, cause: Exception | None) -> AppTheoryError:
    message = f"invalid {source} binding for {field_name}" if field_name else f"invalid {source} binding: {name}"
    details: dict[str, Any] = {"source": source, "name": name}
    if field_name:
        details["field"] = field_name
    return AppTheoryError("app.bad_request", message, status_code=400, details=details, cause=cause)


def _merge_validation(
    config_validation: ValidationSchema | None, bind_fields: dict[str, tuple[BindField, Any]]
) -> ValidationSchema | None:
    merged: ValidationSchema = {key: list(value) for key, value in (config_validation or {}).items()}
    for attr, (bind, _annotation) in bind_fields.items():
        if not bind.validate:
            continue
        rules = [ValidationRule(rule.rule, rule.value, field=bind.name, message=rule.message) for rule in bind.validate]
        merged.setdefault(attr, []).extend(rules)
    return merged or None


def _normalize_validation_error(exc: Exception) -> AppTheoryError:
    if isinstance(exc, AppTheoryError):
        if exc.code == "app.validation_failed" and not exc.status_code:
            exc.status_code = 422
        return exc
    if isinstance(exc, AppError):
        return app_theory_error_from_app_error(exc).with_status_code(status_for_error_code(exc.code)).with_cause(exc)
    return AppTheoryError("app.validation_failed", "validation failed", status_code=422, cause=exc)
