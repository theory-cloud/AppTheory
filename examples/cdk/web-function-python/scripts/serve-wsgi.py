"""Serve the example's WSGI application on the Python standard library's WSGI server.

A WSGI application is never started by the application itself: the server calls it. Lambda manages
that server for a real WSGI Web Function, and nothing provides one locally, so this script is the
local stand-in. ``wsgiref`` is the reference WSGI implementation that ships with Python, and the
threading mixin gives it exactly the model upstream documents for WSGI — "a pool of worker threads,
with each request running in its own thread".

It is a convenience for running the example on a laptop. The deployment package does not use it,
and no revision reads it: Lambda loads ``main_wsgi:application`` itself.

Usage: PORT=8000 python scripts/serve-wsgi.py [APP_DIR]

``APP_DIR`` defaults to the example's ``app/`` directory and exists so the package the stack stages
— which carries the same entry module beside the vendored runtime — can be served exactly as it
would be after deployment.
"""

from __future__ import annotations

import os
import socketserver
import sys
from pathlib import Path
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

DEFAULT_APP_DIR = Path(__file__).resolve().parents[1] / "app"
APP_DIR = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_APP_DIR
sys.path.insert(0, str(APP_DIR))

from main_wsgi import application  # noqa: E402


class ThreadingWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
    """One worker thread per request, which is the concurrency model a WSGI Web Function has."""

    daemon_threads = True


class _QuietHandler(WSGIRequestHandler):
    """Keep the server's own request log out of the output the example prints."""

    def log_message(self, *_args: object) -> None:
        return


def main() -> int:
    port = int(os.environ.get("PORT", "8000"))
    with make_server(
        "127.0.0.1",
        port,
        application,
        server_class=ThreadingWSGIServer,
        handler_class=_QuietHandler,
    ) as server:
        print(f"web-function wsgi listening on 127.0.0.1:{port}", flush=True)
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
