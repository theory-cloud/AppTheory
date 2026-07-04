from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "py" / "src"))

from apptheory import create_app, create_mcp_server  # noqa: E402


def create_tools_only_mcp_server(options: dict[str, Any] | None = None):
    server = create_mcp_server("ToolsOnlyPy", "example", options or {})

    def echo(args: Any, _ctx: Any) -> dict[str, Any]:
        payload = args if isinstance(args, dict) else {}
        message = str(payload.get("message") or "").strip()
        if not message:
            raise RuntimeError("missing message")
        return {"content": [{"type": "text", "text": message}]}

    server.registry().register_tool(
        {
            "name": "echo",
            "description": "Echo text back to the caller",
            "inputSchema": {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
            },
        },
        echo,
    )
    return server


def create_tools_only_app(options: dict[str, Any] | None = None):
    resolved = options or {}
    app = create_app(**dict(resolved.get("app_options") or {}))
    handler = create_tools_only_mcp_server(
        dict(resolved.get("server_options") or {})
    ).handler()
    app.post("/mcp", handler)
    app.get("/mcp", handler)
    app.delete("/mcp", handler)
    return app
