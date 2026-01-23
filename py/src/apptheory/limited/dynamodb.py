from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class DynamoDBClient:
    region: str | None = None
    endpoint_url: str | None = None
    _boto: Any = None

    def _client(self):
        if self._boto is not None:
            return self._boto

        try:
            import boto3  # type: ignore
        except ImportError as exc:
            raise RuntimeError("apptheory: boto3 is required for dynamodb rate limiting") from exc

        self._boto = boto3.client("dynamodb", region_name=self.region, endpoint_url=self.endpoint_url)
        return self._boto

    def get_item(self, **kwargs: Any) -> dict[str, Any]:
        return dict(self._client().get_item(**kwargs) or {})

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        return dict(self._client().update_item(**kwargs) or {})

    def put_item(self, **kwargs: Any) -> dict[str, Any]:
        return dict(self._client().put_item(**kwargs) or {})

    def transact_write_items(self, **kwargs: Any) -> dict[str, Any]:
        return dict(self._client().transact_write_items(**kwargs) or {})
