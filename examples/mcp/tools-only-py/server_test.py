from __future__ import annotations

import json as jsonlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "py" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from apptheory import (  # noqa: E402
    build_apigw_v2_request,
    create_mcp_test_harness,
    sequence_mcp_id_generator,
)
from server import create_tools_only_mcp_server, handler  # noqa: E402


def main() -> None:
    server = create_tools_only_mcp_server(
        {"id_generator": sequence_mcp_id_generator(["sess-example"], "sess")}
    )
    harness = create_mcp_test_harness(server)

    init = harness.initialize(id="init")
    assert init.response.status == 200
    assert init.response.headers["mcp-session-id"] == ["sess-example"]
    assert init.body_json["result"]["capabilities"] == {"tools": {}}

    session_id = init.response.headers["mcp-session-id"][0]
    call = harness.call(
        session_id,
        "tools/call",
        {"name": "echo", "arguments": {"message": "hello Python MCP"}},
        "call",
    )
    assert call.response.status == 200
    assert call.body_json["result"] == {
        "content": [{"type": "text", "text": "hello Python MCP"}]
    }

    # Exercise the exported Lambda entry with a testkit-built API Gateway v2 event.
    lambda_event = build_apigw_v2_request(
        "POST",
        "/mcp",
        headers={
            "accept": "application/json, text/event-stream",
            "content-type": "application/json",
        },
        body='{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    )
    lambda_response = handler(lambda_event)
    assert lambda_response["statusCode"] == 200
    assert lambda_response["headers"]["mcp-session-id"], "expected an MCP session id"
    assert jsonlib.loads(lambda_response["body"])["jsonrpc"] == "2.0"

    print("examples/mcp/tools-only-py/server_test.py: PASS")


if __name__ == "__main__":
    main()
