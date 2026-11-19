from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any

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


# ---- theorycloud_resource_naming.v0.1 --------------------------------------

RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1"
LOG_SOURCE_PREFIX = "theorycloud"
ROLE_POLICY_MAX = 10240

_SEGMENT = r"[a-z0-9]+(?:-[a-z0-9]+)*"
_LOGICAL_RE = re.compile(rf"^{_SEGMENT}(?:/{_SEGMENT})*$")
_APP_RE = re.compile(rf"^{_SEGMENT}$")
_STAGE_RE = re.compile(r"^[a-z][a-z0-9]{0,7}$")
_NAMESPACE_RE = re.compile(rf"^{_SEGMENT}$")
_ACCOUNT_RE = re.compile(r"^[0-9]{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(?:-[a-z]+)+-[0-9]$")
_SECRET_TAIL_RE = re.compile(r"-[A-Za-z0-9]{6}$")
_S3_EDGES_RE = re.compile(r"^[a-z0-9].*[a-z0-9]$")
_STRIP = "-_./"

# kind: "dash" | "path" | "s3ar" | "log" (see contract section 2).
RESOURCE_NAME_RULES: dict[str, dict[str, Any]] = {
    "s3_bucket": {"kind": "s3ar", "max": 63, "charset": r"[a-z0-9-]"},
    "s3_vector_bucket": {"kind": "dash", "max": 63, "charset": r"[a-z0-9-]"},
    "s3_vector_index": {"kind": "dash", "max": 63, "charset": r"[a-z0-9-]"},
    "dynamodb_table": {"kind": "dash", "max": 255, "charset": r"[A-Za-z0-9_.-]"},
    "lambda_function": {"kind": "dash", "max": 64, "charset": r"[A-Za-z0-9_-]"},
    "sqs_queue": {"kind": "dash", "max": 80, "charset": r"[A-Za-z0-9_-]"},
    "sns_topic": {"kind": "dash", "max": 256, "charset": r"[A-Za-z0-9_-]"},
    "secret": {"kind": "path", "lead": "", "max": 512, "charset": r"[A-Za-z0-9/_+=.@-]"},
    "ssm_parameter": {"kind": "path", "lead": "/", "max": 900, "charset": r"[A-Za-z0-9_./-]"},
    "kms_alias": {"kind": "path", "lead": "alias/", "max": 256, "charset": r"[A-Za-z0-9/_-]"},
    "event_bus": {"kind": "dash", "max": 256, "charset": r"[A-Za-z0-9._-]"},
    "event_rule": {"kind": "dash", "max": 64, "charset": r"[A-Za-z0-9._-]"},
    "schedule": {"kind": "dash", "max": 64, "charset": r"[A-Za-z0-9._-]"},
    "alarm": {"kind": "dash", "max": 255, "charset": r"[A-Za-z0-9_.-]"},
    "dashboard": {"kind": "dash", "max": 255, "charset": r"[A-Za-z0-9_-]"},
    "iam_role": {"kind": "dash", "max": 64, "charset": r"[A-Za-z0-9+=,.@_-]"},
    "iam_managed_policy": {"kind": "dash", "max": 128, "charset": r"[A-Za-z0-9+=,.@_-]"},
    "state_machine": {"kind": "dash", "max": 80, "charset": r"[A-Za-z0-9_-]"},
    "codebuild_project": {"kind": "dash", "max": 150, "charset": r"[A-Za-z0-9_-]"},
    "api_rest": {"kind": "dash", "max": 128, "charset": r"[A-Za-z0-9_-]"},
    "api_http": {"kind": "dash", "max": 128, "charset": r"[A-Za-z0-9_-]"},
    "log_delivery_source": {"kind": "dash", "max": 60, "charset": r"[A-Za-z0-9_-]"},
    "log_delivery_destination": {"kind": "dash", "max": 60, "charset": r"[A-Za-z0-9_-]"},
    "log_group": {"kind": "log", "max": 512, "charset": r"[A-Za-z0-9_-]"},
}

KEEPER_ACTIONS_GROUP = ["logs:FilterLogEvents", "logs:DescribeLogStreams"]
KEEPER_ACTIONS_STREAM = ["logs:GetLogEvents"]

KEEPER_EVENTS = "events"
KEEPER_ALLOWED_NO_EVENTS = "allowed_no_events"
KEEPER_NOT_SHARED = "not_shared"


def validate_naming_context(context: dict[str, Any]) -> None:
    """Enforce the bound-context grammar (contract section 1)."""
    if not _APP_RE.match(context["app"]):
        raise ValueError("app")
    if not _STAGE_RE.match(context["stage"]):
        raise ValueError("stage")
    if not _ACCOUNT_RE.match(context["account"]):
        raise ValueError("account")
    if not _REGION_RE.match(context["region"]):
        raise ValueError("region")
    if not _NAMESPACE_RE.match(context.get("namespace", LOG_SOURCE_PREFIX)):
        raise ValueError("namespace")


def _hash8(text: str) -> str:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return base64.b32encode(digest).decode("ascii").lower().rstrip("=")[:8]


def shorten_resource_name(full: str, limit: int) -> str:
    """Apply the deterministic over-budget form (contract section 2.2)."""
    if len(full) <= limit:
        return full
    head = full[: limit - 9].rstrip(_STRIP)
    return f"{head}-{_hash8(full)}"


def s3_account_regional_suffix(context: dict[str, Any]) -> str:
    return f"-{context['account']}-{context['region']}-an"


def log_source_prefix(context: dict[str, Any]) -> str:
    return (
        "_".join([LOG_SOURCE_PREFIX, context.get("namespace", LOG_SOURCE_PREFIX), context["app"], context["stage"]])
        + "_"
    )


def log_group_name(context: dict[str, Any], logical: str) -> str:
    """Map a logical log source to its physical log-group name."""
    if not logical.startswith("logs/"):
        raise ValueError("log logical must start with logs/")
    return log_source_prefix(context) + logical.replace("/", "_")


def physical_resource_name(
    context: dict[str, Any],
    resource_type: str,
    logical: str,
    pins: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Compose the physical name of one resource. Pins are returned verbatim."""
    validate_naming_context(context)
    if not _LOGICAL_RE.match(logical):
        raise ValueError("logical")
    rule = RESOURCE_NAME_RULES.get(resource_type)
    if rule is None:
        raise ValueError(f"resource type {resource_type}")
    pin = (pins or {}).get(f"{resource_type}:{logical}")
    if pin is not None:
        return {"name": pin, "pinned": True}
    if context.get("naming_profile", "derived") == "legacy":
        raise ValueError("legacy naming profile requires a pin for every resource")

    out = _compose(context, resource_type, logical, rule)

    name = out["name"]
    if not re.fullmatch(rule["charset"] + "+", name):
        raise ValueError("charset")
    if len(name) > rule["max"]:
        raise ValueError("length")
    if resource_type in ("s3_bucket", "s3_vector_bucket", "s3_vector_index") and not _S3_EDGES_RE.match(name):
        raise ValueError("s3 start/end")
    return out


def _compose(
    context: dict[str, Any],
    resource_type: str,
    logical: str,
    rule: dict[str, Any],
) -> dict[str, Any]:
    """Compose the type-specific form before the shared limits are checked."""
    kind = rule["kind"]
    if kind == "s3ar":
        suffix = s3_account_regional_suffix(context)
        budget = rule["max"] - len(suffix)
        prefix = shorten_resource_name(f"{context['app']}-{context['stage']}-{logical.replace('/', '-')}", budget)
        return {
            "bucket_name_prefix": prefix,
            "bucket_namespace": "account-regional",
            "name": prefix + suffix,
        }
    if kind == "dash":
        return {
            "name": shorten_resource_name(
                f"{context['app']}-{context['stage']}-{logical.replace('/', '-')}", rule["max"]
            )
        }
    if kind == "path":
        full = f"{rule.get('lead', '')}{context['app']}/{context['stage']}/{logical}"
        if resource_type == "secret" and _SECRET_TAIL_RE.search(full):
            raise ValueError("secret name must not end with a hyphen and six characters")
        if resource_type == "ssm_parameter" and full.count("/") > 15:
            raise ValueError("ssm hierarchy deeper than 15")
        if len(full) > rule["max"]:
            raise ValueError("path name over limit")
        return {"name": full}
    if kind == "log":
        name = log_group_name(context, logical)
        if len(name) > rule["max"]:
            raise ValueError("log group over limit")
        return {"name": name}
    raise ValueError(kind)  # pragma: no cover


# ---- visibility (contract sections 5-7) ------------------------------------


def validate_visibility_selector(selector: str) -> None:
    """Enforce the selector grammar (contract section 5)."""
    base = selector[:-2] if selector.endswith("/*") else selector
    if not _LOGICAL_RE.match(base) or base.split("/")[0] != "logs" or (base == "logs" and not selector.endswith("/*")):
        raise ValueError(f"selector {selector}")
    if "*" in base:
        raise ValueError("wildcard only as trailing /*")


def visibility_selector_matches(selector: str, logical: str) -> bool:
    """Whether a selector matches a logical source. `/*` matches descendants only."""
    if selector.endswith("/*"):
        return logical.startswith(selector[:-1])
    return logical == selector


def source_visible(rules: dict[str, Any], logical: str) -> bool:
    """Whether a source is visible: an include matches and no exclude does."""
    include = any(visibility_selector_matches(s, logical) for s in rules.get("include", []))
    exclude = any(visibility_selector_matches(s, logical) for s in rules.get("exclude", []))
    return include and not exclude


def visibility_selector_arns(context: dict[str, Any], selector: str) -> list[str]:
    """Expand a selector to the log-group ARNs it covers."""
    base = f"arn:aws:logs:{context['region']}:{context['account']}:log-group:"
    if selector.endswith("/*"):
        return [base + log_source_prefix(context) + selector[:-1].replace("/", "_") + "*"]
    name = log_source_prefix(context) + selector.replace("/", "_")
    return [base + name, base + name + ":*"]


def visibility_rule_version(rules: dict[str, Any]) -> str:
    """The first 12 hex characters of SHA-256 over the canonical rules."""
    canonical = json.dumps(
        {"include": sorted(rules.get("include", [])), "exclude": sorted(rules.get("exclude", []))},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()[:12]


def compile_visibility_policy(context: dict[str, Any], rules: dict[str, Any]) -> dict[str, Any]:
    """Compile the rules into the reader-role inline policy."""
    for selector in rules.get("include", []) + rules.get("exclude", []):
        validate_visibility_selector(selector)
    statements: list[dict[str, Any]] = []
    actions = KEEPER_ACTIONS_GROUP + KEEPER_ACTIONS_STREAM
    included = [arn for s in sorted(rules.get("include", [])) for arn in visibility_selector_arns(context, s)]
    excluded = [arn for s in sorted(rules.get("exclude", [])) for arn in visibility_selector_arns(context, s)]
    manifest = (
        f"arn:aws:ssm:{context['region']}:{context['account']}:parameter"
        f"/{LOG_SOURCE_PREFIX}/visibility/{context['app']}/{context['stage']}/manifest"
    )
    statements.append(
        {"Sid": "ReadManifest", "Effect": "Allow", "Action": ["ssm:GetParameter"], "Resource": [manifest]}
    )
    if included:
        statements.append({"Sid": "ReadIncluded", "Effect": "Allow", "Action": actions, "Resource": included})
    if excluded:
        statements.append({"Sid": "DenyExcluded", "Effect": "Deny", "Action": actions, "Resource": excluded})
    policy = {"Version": "2012-10-17", "Statement": statements}
    if len(json.dumps(policy, separators=(",", ":"))) > ROLE_POLICY_MAX:
        raise ValueError("compiled policy over role policy size")
    return policy


def _future_rules(rules: dict[str, Any]) -> dict[str, list[str]]:
    return {"include": sorted(rules.get("include", [])), "exclude": sorted(rules.get("exclude", []))}


def visibility_preview(context: dict[str, Any], rules: dict[str, Any], sources: list[str]) -> dict[str, Any]:
    """Assemble the synth-time preview."""
    for selector in rules.get("include", []) + rules.get("exclude", []):
        validate_visibility_selector(selector)
    return {
        "rule_version": visibility_rule_version(rules),
        "matched_now": sorted(s for s in sources if source_visible(rules, s)),
        "not_matched_now": sorted(s for s in sources if not source_visible(rules, s)),
        "future": _future_rules(rules),
    }


def visibility_manifest(context: dict[str, Any], rules: dict[str, Any], sources: list[str]) -> dict[str, Any]:
    """Assemble the published manifest (no `not_matched_now`)."""
    preview = visibility_preview(context, rules, sources)
    del preview["not_matched_now"]
    return preview


def keeper_decision(rules: dict[str, Any] | None, logical: str, aws_result: str | None) -> str:
    """Keeper's answer to a read request. Fails closed on denial or unreachable."""
    if rules is None or not source_visible(rules, logical):
        return KEEPER_NOT_SHARED
    if aws_result == "events":
        return KEEPER_EVENTS
    if aws_result in ("empty", "not_found"):
        return KEEPER_ALLOWED_NO_EVENTS
    return KEEPER_NOT_SHARED
