from __future__ import annotations

import json as jsonlib
from dataclasses import dataclass
from typing import Any

from apptheory.clock import Clock, RealClock
from apptheory.errors import AppError
from apptheory.ids import IdGenerator, RealIdGenerator
from apptheory.request import Request


@dataclass(slots=True)
class Context:
    request: Request
    params: dict[str, str]
    clock: Clock
    id_generator: IdGenerator
    ctx: Any | None
    request_id: str
    tenant_id: str
    auth_identity: str
    remaining_ms: int
    middleware_trace: list[str]

    def __init__(
        self,
        *,
        request: Request,
        params: dict[str, str] | None = None,
        clock: Clock | None = None,
        id_generator: IdGenerator | None = None,
        ctx: Any | None = None,
        request_id: str = "",
        tenant_id: str = "",
        auth_identity: str = "",
        remaining_ms: int = 0,
        middleware_trace: list[str] | None = None,
    ) -> None:
        self.request = request
        self.params = params or {}
        self.clock = clock or RealClock()
        self.id_generator = id_generator or RealIdGenerator()
        self.ctx = ctx
        self.request_id = str(request_id)
        self.tenant_id = str(tenant_id)
        self.auth_identity = str(auth_identity)
        self.remaining_ms = int(remaining_ms or 0)
        self.middleware_trace = middleware_trace if middleware_trace is not None else []

    def now(self):
        return self.clock.now()

    def new_id(self) -> str:
        return self.id_generator.new_id()

    def param(self, name: str) -> str:
        return self.params.get(name, "")

    def json_value(self) -> Any:
        if not _has_json_content_type(self.request.headers):
            raise AppError("app.bad_request", "invalid json")
        if not self.request.body:
            return None
        try:
            return jsonlib.loads(self.request.body.decode("utf-8"))
        except Exception:  # noqa: BLE001
            raise AppError("app.bad_request", "invalid json") from None


@dataclass(slots=True)
class EventContext:
    clock: Clock
    id_generator: IdGenerator
    ctx: Any | None
    request_id: str
    remaining_ms: int

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        id_generator: IdGenerator | None = None,
        ctx: Any | None = None,
        request_id: str = "",
        remaining_ms: int = 0,
    ) -> None:
        self.clock = clock or RealClock()
        self.id_generator = id_generator or RealIdGenerator()
        self.ctx = ctx
        self.request_id = str(request_id)
        self.remaining_ms = int(remaining_ms or 0)

    def now(self):
        return self.clock.now()

    def new_id(self) -> str:
        return self.id_generator.new_id()


def _has_json_content_type(headers: dict[str, list[str]]) -> bool:
    for value in headers.get("content-type", []):
        v = str(value).strip().lower()
        if v.startswith("application/json"):
            return True
    return False
