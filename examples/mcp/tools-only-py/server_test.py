from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "py" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from apptheory import create_mcp_test_harness, sequence_mcp_id_generator  # noqa: E402
from server import create_tools_only_mcp_server  # noqa: E402


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

    print("examples/mcp/tools-only-py/server_test.py: PASS")


if __name__ == "__main__":
    main()
