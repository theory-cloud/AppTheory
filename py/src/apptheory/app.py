from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from apptheory.clock import Clock, RealClock
from apptheory.context import Context
from apptheory.errors import AppError, error_response, response_for_error
from apptheory.ids import IdGenerator, RealIdGenerator
from apptheory.request import Request, normalize_request
from apptheory.response import Response, normalize_response
from apptheory.router import Router

Handler = Callable[[Context], Response]


@dataclass(slots=True)
class App:
    _router: Router
    _clock: Clock
    _id_generator: IdGenerator

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        id_generator: IdGenerator | None = None,
    ) -> None:
        self._router = Router()
        self._clock = clock or RealClock()
        self._id_generator = id_generator or RealIdGenerator()

    def handle(self, method: str, pattern: str, handler: Handler) -> App:
        self._router.add(method, pattern, handler)
        return self

    def get(self, pattern: str, handler: Handler) -> App:
        return self.handle("GET", pattern, handler)

    def post(self, pattern: str, handler: Handler) -> App:
        return self.handle("POST", pattern, handler)

    def put(self, pattern: str, handler: Handler) -> App:
        return self.handle("PUT", pattern, handler)

    def delete(self, pattern: str, handler: Handler) -> App:
        return self.handle("DELETE", pattern, handler)

    def serve(self, request: Request, ctx: Any | None = None) -> Response:
        try:
            normalized = normalize_request(request)
        except Exception as exc:  # noqa: BLE001
            return response_for_error(exc)

        match, allowed = self._router.match(normalized.method, normalized.path)
        if match is None:
            if allowed:
                return error_response(
                    "app.method_not_allowed",
                    "method not allowed",
                    headers={"allow": [self._router.format_allow_header(allowed)]},
                )
            return error_response("app.not_found", "not found")

        request_ctx = Context(
            request=normalized,
            params=match.params,
            clock=self._clock,
            id_generator=self._id_generator,
            ctx=ctx,
        )

        try:
            resp = match.handler(request_ctx)
        except AppError as exc:
            return error_response(exc.code, exc.message)
        except Exception:  # noqa: BLE001
            return error_response("app.internal", "internal error")

        return normalize_response(resp)


def create_app(*, clock: Clock | None = None, id_generator: IdGenerator | None = None) -> App:
    return App(clock=clock, id_generator=id_generator)
