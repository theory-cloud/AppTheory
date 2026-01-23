from __future__ import annotations

import re

_non_alnum = re.compile(r"[^a-z0-9-]+")
_multi_dash = re.compile(r"-+")


def _sanitize_part(value: str) -> str:
    out = str(value or "").strip().lower()
    if not out:
        return ""
    out = out.replace("_", "-").replace(" ", "-")
    out = _non_alnum.sub("-", out)
    out = _multi_dash.sub("-", out)
    return out.strip("-")


def normalize_stage(stage: str) -> str:
    value = str(stage or "").strip().lower()
    if value in {"prod", "production", "live"}:
        return "live"
    if value in {"dev", "development"}:
        return "dev"
    if value in {"stg", "stage", "staging"}:
        return "stage"
    if value in {"test", "testing"}:
        return "test"
    if value == "local":
        return "local"
    return _sanitize_part(value)


def base_name(app_name: str, stage: str, tenant: str = "") -> str:
    app = _sanitize_part(app_name)
    ten = _sanitize_part(tenant)
    stg = normalize_stage(stage)
    if ten:
        return f"{app}-{ten}-{stg}"
    return f"{app}-{stg}"


def resource_name(app_name: str, resource: str, stage: str, tenant: str = "") -> str:
    app = _sanitize_part(app_name)
    ten = _sanitize_part(tenant)
    res = _sanitize_part(resource)
    stg = normalize_stage(stage)
    if ten:
        return f"{app}-{ten}-{res}-{stg}"
    return f"{app}-{res}-{stg}"
