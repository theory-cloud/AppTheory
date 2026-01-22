from __future__ import annotations

from typing import Any


def _normalize_endpoint(endpoint: str) -> str:
    value = str(endpoint or "").strip()
    if not value:
        return ""
    if value.startswith("wss://"):
        return "https://" + value[len("wss://") :]
    if value.startswith("ws://"):
        return "http://" + value[len("ws://") :]
    if value.startswith(("https://", "http://")):
        return value
    return "https://" + value


class Client:
    def __init__(self, endpoint: str, *, region: str | None = None) -> None:
        normalized = _normalize_endpoint(endpoint)
        if not normalized:
            raise RuntimeError("apptheory: websocket management endpoint is empty")
        self.endpoint = normalized
        self.region = str(region).strip() if region else None
        self._boto = None

    def _client(self):
        if self._boto is not None:
            return self._boto

        try:
            import boto3  # type: ignore
        except ImportError as exc:
            raise RuntimeError("apptheory: boto3 is required for websocket management client") from exc

        self._boto = boto3.client("apigatewaymanagementapi", endpoint_url=self.endpoint, region_name=self.region)
        return self._boto

    def post_to_connection(self, connection_id: str, data: bytes) -> None:
        conn = str(connection_id or "").strip()
        if not conn:
            raise RuntimeError("apptheory: websocket connection id is empty")
        client = self._client()
        client.post_to_connection(ConnectionId=conn, Data=bytes(data or b""))

    def get_connection(self, connection_id: str) -> dict[str, Any]:
        conn = str(connection_id or "").strip()
        if not conn:
            raise RuntimeError("apptheory: websocket connection id is empty")
        client = self._client()
        return dict(client.get_connection(ConnectionId=conn) or {})

    def delete_connection(self, connection_id: str) -> None:
        conn = str(connection_id or "").strip()
        if not conn:
            raise RuntimeError("apptheory: websocket connection id is empty")
        client = self._client()
        client.delete_connection(ConnectionId=conn)
