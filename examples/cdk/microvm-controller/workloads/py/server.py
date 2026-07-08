from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib HTTP handler name
        self._send_json()

    def do_POST(self) -> None:  # noqa: N802 - stdlib HTTP handler name
        self._send_json()

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"AppTheory Python MicroVM workload: {fmt % args}")

    def _send_json(self) -> None:
        body = json.dumps(
            {
                "language": "python",
                "runtime": "apptheory-microvm-workload",
                "method": self.command,
                "path": self.path,
                "now": datetime.now(UTC).isoformat(),
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"AppTheory Python MicroVM workload listening on :{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
