"""The WSGI entry point of the example's Python Web Function.

The same application, served through the other interface a Python Web Function offers. A WSGI
application is loaded by name, so the composition names ``main_wsgi`` with the callable
``application`` and declares the ``wsgi`` interface; Lambda's server then calls the application on
its worker threads, one request per thread.
"""

from __future__ import annotations

from apptheory import WSGIApp

from lib.application import build_app

application = WSGIApp(build_app())
