"""The ASGI entry point of the example's Python Web Function.

A Python Web Function loads ``main:app`` by default and serves it as an ASGI application; this
module is that default, so the composition only has to name ``main``. ``apptheory.ASGIApp`` is the
application: it turns each ASGI request into an AppTheory request, calls the runtime, and writes the
response back chunk by chunk.
"""

from __future__ import annotations

from apptheory import ASGIApp

from lib.application import build_app

app = ASGIApp(build_app())
