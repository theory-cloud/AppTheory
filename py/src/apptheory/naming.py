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
# The longest hosted namespace label, in characters (contract section 1, r5 rev1).
HOSTED_NAMESPACE_MAX = 12

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
    "api_websocket": {"kind": "dash", "max": 128, "charset": r"[A-Za-z0-9_-]"},
    "log_delivery_source": {"kind": "dash", "max": 60, "charset": r"[A-Za-z0-9_-]"},
    "log_delivery_destination": {"kind": "dash", "max": 60, "charset": r"[A-Za-z0-9_-]"},
    "log_group": {"kind": "log", "max": 512, "charset": r"[A-Za-z0-9_-]"},
}

# API names are explicit today (the CDK defaults them), so they take a pin and
# never a generated entry (r3, ADV-1312-3).
_API_TYPES = frozenset({"api_rest", "api_http", "api_websocket"})

KEEPER_ACTIONS_GROUP = ["logs:FilterLogEvents", "logs:DescribeLogStreams"]
KEEPER_ACTIONS_STREAM = ["logs:GetLogEvents"]

KEEPER_EVENTS = "events"
KEEPER_ALLOWED_NO_EVENTS = "allowed_no_events"
KEEPER_NOT_SHARED = "not_shared"

# The refusal contract sections 1 and 4 state for the two live-compatibility
# naming tools on a namespaced context: a deployment whose names carry the tenant
# namespace takes neither the legacy profile nor a generated entry, because
# either would produce a name with no namespace and collide across tenants in a
# pooled account.
_HOSTED_PROFILE_FAILURE = "a hosted deployment takes no legacy profile or generated entries"


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
    # r5 rev1: a hosted deployment always supplies its namespace; it never
    # defaults to the platform form.
    if context.get("hosted") and not context.get("namespace"):
        raise ValueError("a hosted deployment must supply its namespace")
    namespace = context.get("namespace", LOG_SOURCE_PREFIX)
    if not _NAMESPACE_RE.match(namespace):
        raise ValueError("namespace")
    # r5 rev1: `theorycloud` is reserved for first-party platform apps. A hosted
    # deployment may never use it, because its names would then collide with the
    # platform app's in a pooled account.
    if context.get("hosted") and namespace == LOG_SOURCE_PREFIX:
        raise ValueError(f"namespace {LOG_SOURCE_PREFIX} is reserved for first-party platform apps")
    validate_hosted_namespace(namespace)
    # r5 section 4: the naming profile and the context's own generated entries are
    # properties of the context, so a forbidden one is refused here -- when the
    # context is validated -- and not only as a side effect of composing a
    # physical name. A hosted context that names nothing yet would otherwise stand
    # as a valid context whose every future name could carry no namespace
    # (SAN-AT-N5-01).
    if namespaced_context(context):
        legacy = context.get("naming_profile", "derived") == "legacy"
        if legacy or context.get("generated"):
            raise ValueError(_HOSTED_PROFILE_FAILURE)


def validate_hosted_namespace(namespace: str) -> None:
    """Apply the hosted namespace label rule (contract section 1, r5 rev1).

    A namespace other than the reserved platform one is at most
    ``HOSTED_NAMESPACE_MAX`` characters and never starts with ``aws`` or ``ssm``.
    Those two prefixes are reserved by AWS, so a name carrying them cannot be
    created.
    """
    if namespace == LOG_SOURCE_PREFIX:
        return
    if len(namespace) > HOSTED_NAMESPACE_MAX:
        raise ValueError("hosted namespace longer than 12 characters")
    if namespace.startswith(("aws", "ssm")):
        raise ValueError("hosted namespace must not start with aws or ssm")


def namespaced_context(context: dict[str, Any]) -> bool:
    """Whether every derived name carries the namespace (contract section 2, r5).

    True for a hosted deployment and for any namespace other than the reserved
    platform one. The platform namespace keeps the compatibility form byte for
    byte, so the live hard gate (contract section 4) is unchanged.
    """
    return bool(context.get("hosted")) or context.get("namespace", LOG_SOURCE_PREFIX) != LOG_SOURCE_PREFIX


def dash_stem(context: dict[str, Any], logical: str) -> str:
    """The ``{namespace}-{app}-{stage}-{logical}`` stem of a ``dash`` name."""
    parts = [context["app"], context["stage"], logical.replace("/", "-")]
    if namespaced_context(context):
        parts.insert(0, context["namespace"])
    return "-".join(parts)


def path_stem(context: dict[str, Any], logical: str) -> str:
    """The ``{namespace}/{app}/{stage}/{logical}`` stem of a ``path`` name."""
    parts = [context["app"], context["stage"], logical]
    if namespaced_context(context):
        parts.insert(0, context["namespace"])
    return "/".join(parts)


def hosted_pin_lead(context: dict[str, Any], rule: dict[str, Any]) -> str:
    """The leading namespace component a hosted pin must carry (contract section 4).

    Exactly where the derived form puts it (r5 rev1, rev2). Containing the
    namespace elsewhere is not enough: ``shop-lab-events`` is not a pin for
    namespace ``hop``.
    """
    namespace = context["namespace"]
    kind = rule["kind"]
    if kind == "path":
        return f"{rule.get('lead', '')}{namespace}/"
    if kind == "log":
        return f"{LOG_SOURCE_PREFIX}_{namespace}_"
    return f"{namespace}-"


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
    """Map a logical log source to its physical log-group name.

    The context is validated first, so a context that breaks a rule is refused
    here as well: resolving one log-source name is enough to establish the
    context's naming, and a forbidden naming profile must not survive on the
    log-only path (SAN-AT-N5-01).
    """
    validate_naming_context(context)
    if not logical.startswith("logs/"):
        raise ValueError("log logical must start with logs/")
    return log_source_prefix(context) + logical.replace("/", "_")


def physical_resource_name(
    context: dict[str, Any],
    resource_type: str,
    logical: str,
    pins: dict[str, str] | None = None,
    generated: list[str] | None = None,
) -> dict[str, Any]:
    """Compose the physical name of one resource.

    Pins are returned verbatim. A generated entry means CloudFormation generates
    the name today, so the construct sets no physical-name property and the
    result is ``{"generated": True}``. Generated entries are legacy-only.

    A hosted deployment (``hosted: True``, or any namespace other than the
    platform one) carries the namespace as the first component of every derived
    name, its S3 prefix included, and takes no pin whose name does not start with
    that namespace component (contract sections 2 and 4, r5).
    """
    validate_naming_context(context)
    if not _LOGICAL_RE.match(logical):
        raise ValueError("logical")
    rule = RESOURCE_NAME_RULES.get(resource_type)
    if rule is None:
        raise ValueError(f"resource type {resource_type}")
    generated = generated or []
    legacy = context.get("naming_profile", "derived") == "legacy"
    # r5 rev2: the legacy profile and generated entries are first-party
    # live-compatibility tools only. A hosted deployment takes neither, because a
    # pinned or CloudFormation-generated name carries no namespace and would
    # collide across tenants in a pooled account.
    if namespaced_context(context) and (legacy or generated):
        raise ValueError(_HOSTED_PROFILE_FAILURE)
    if generated and not legacy:
        raise ValueError("generated entries are only valid under the legacy naming profile")
    key = f"{resource_type}:{logical}"
    pin = (pins or {}).get(key)
    keep_generated = key in generated
    # r3, ADV-1312-3: CDK defaults an API Name today, so it is an explicit name
    # and takes a pin, never a generated entry.
    if keep_generated and resource_type in _API_TYPES:
        raise ValueError("an API name takes a pin, never a generated entry")
    if pin is not None and keep_generated:
        raise ValueError("a resource has both a pin and a generated entry")
    if pin is not None:
        # r5 rev2: a hosted pin starts with its namespace component, as the
        # derived form does. A namespace that merely appears somewhere in the
        # name is not the namespace component.
        if namespaced_context(context) and not pin.startswith(hosted_pin_lead(context, rule)):
            raise ValueError("a hosted pin must start with the namespace component")
        return {"name": pin, "pinned": True}
    if keep_generated:
        return {"generated": True}
    if legacy:
        raise ValueError("legacy naming profile requires a pin or a generated entry for every resource")

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
        prefix = shorten_resource_name(dash_stem(context, logical), budget)
        return {
            "bucket_name_prefix": prefix,
            "bucket_namespace": "account-regional",
            "name": prefix + suffix,
        }
    if kind == "dash":
        return {"name": shorten_resource_name(dash_stem(context, logical), rule["max"])}
    if kind == "path":
        full = f"{rule.get('lead', '')}{path_stem(context, logical)}"
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
        {"include": sorted(set(rules.get("include", []))), "exclude": sorted(set(rules.get("exclude", [])))},
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
    included = [arn for s in sorted(set(rules.get("include", []))) for arn in visibility_selector_arns(context, s)]
    excluded = [arn for s in sorted(set(rules.get("exclude", []))) for arn in visibility_selector_arns(context, s)]
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
    return {"include": sorted(set(rules.get("include", []))), "exclude": sorted(set(rules.get("exclude", [])))}


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


# ---- r4: cross-app uniqueness (contract section 11) -------------------------

NAMING_SCOPE_ACCOUNT = "account"
NAMING_SCOPE_ACCOUNT_REGION = "account_region"
NAMING_SCOPE_NOT_UNIQUE = "not_unique"

UNKNOWN_NAMING_SCOPE = "a type with no stated naming scope cannot be reserved"

# Types AWS keeps unique across Regions.
_ACCOUNT_GLOBAL_TYPES = frozenset({"iam_role", "iam_managed_policy", "dashboard"})

# API display names AWS does not keep unique, so nothing is reserved for them.
_NOT_UNIQUE_TYPES = frozenset({"api_rest", "api_http", "api_websocket"})


def naming_scope(resource_type: str) -> str:
    """The scope in which AWS requires a type's names to be unique (section 11.1).

    A type the contract states no scope for is refused: it cannot be reserved, so
    it cannot be deployed through the reservation index until a revision states
    its scope.
    """
    if resource_type not in RESOURCE_NAME_RULES:
        raise ValueError(UNKNOWN_NAMING_SCOPE)
    if resource_type in _NOT_UNIQUE_TYPES:
        return NAMING_SCOPE_NOT_UNIQUE
    if resource_type in _ACCOUNT_GLOBAL_TYPES:
        return NAMING_SCOPE_ACCOUNT
    return NAMING_SCOPE_ACCOUNT_REGION


def synth_check(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Refuse two different logical resources in one naming context that derive
    the same name in the same naming scope, and return the derived-name artifact
    (contract section 11.4).

    A Lambda function and its IAM role may share a name because their scopes
    differ, and two APIs may share one because AWS does not keep API names
    unique. A generated entry carries no name: CloudFormation owns the name, so
    there is nothing to reserve. Rows keep the order of the entries.
    """
    seen: dict[tuple[str, str, str], str] = {}
    artifact: list[dict[str, Any]] = []
    for entry in entries:
        scope = naming_scope(entry["type"])
        generated = bool(entry.get("generated"))
        row: dict[str, Any] = {"type": entry["type"], "scope": scope, "logical_id": entry["logical_id"]}
        if not generated and entry.get("name") is not None:
            row = {"name": entry["name"], **row}
        if generated:
            row["generated"] = True
        artifact.append(row)
        if scope == NAMING_SCOPE_NOT_UNIQUE or generated:
            continue
        key = (scope, entry["type"], entry.get("name") or "")
        held = seen.get(key)
        if held is not None and held != entry["logical_id"]:
            raise ValueError(f"{held} and {entry['logical_id']} derive {entry.get('name') or ''} in scope {scope}")
        seen[key] = entry["logical_id"]
    return artifact
