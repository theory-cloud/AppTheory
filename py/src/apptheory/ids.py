from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4


class IdGenerator(Protocol):
    def new_id(self) -> str: ...


@dataclass(slots=True)
class RealIdGenerator:
    def new_id(self) -> str:
        return str(uuid4())


@dataclass(slots=True)
class ManualIdGenerator:
    prefix: str
    next: int
    queue: list[str]

    def __init__(self, *, prefix: str = "test-id", start: int = 1) -> None:
        self.prefix = str(prefix)
        self.next = int(start)
        self.queue = []

    def push(self, *ids: str) -> None:
        self.queue.extend([str(v) for v in ids])

    def reset(self) -> None:
        self.next = 1
        self.queue = []

    def new_id(self) -> str:
        if self.queue:
            return self.queue.pop(0)
        out = f"{self.prefix}-{self.next}"
        self.next += 1
        return out
