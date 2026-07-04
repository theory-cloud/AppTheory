import os

from apptheory import create_app, json


def build_app(environ=None):
    env = environ if environ is not None else os.environ
    lang = env.get("APPTHEORY_HELLO_LANG", "py")
    tier = env.get("APPTHEORY_TIER", "p2")
    app = create_app(tier=tier)

    def hello(ctx, name):
        return json(
            200,
            {
                "message": f"hello {name}",
                "runtime": lang,
                "request_id": ctx.request_id,
                "tenant_id": ctx.tenant_id,
            },
        )

    app.get("/", lambda ctx: hello(ctx, "world"))
    app.get("/hello/{name}", lambda ctx: hello(ctx, ctx.param("name")))

    return app


_app = build_app()


def handler(event, context):
    return _app.handle_lambda(event, context)
