from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ErrorType = Literal["internal_error", "rate_limit_exceeded", "invalid_input"]


@dataclass(slots=True)
class RateLimiterError(Exception):
    type: ErrorType
    message: str
    cause: Exception | None = None

    def __str__(self) -> str:
        if self.cause is not None:
            return f"{self.message}: {self.cause}"
        return self.message


def new_error(error_type: ErrorType, message: str) -> RateLimiterError:
    return RateLimiterError(type=error_type, message=str(message))


def wrap_error(cause: Exception, error_type: ErrorType, message: str) -> RateLimiterError:
    return RateLimiterError(type=error_type, message=str(message), cause=cause)
