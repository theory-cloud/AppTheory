import json as jsonlib
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "py" / "src"))

from apptheory import build_apigw_v2_request, create_test_env, json  # noqa: E402


def main() -> None:
    env = create_test_env(now=datetime(2026, 1, 1, tzinfo=UTC))
    env.ids.push("req-1")

    app = env.app()

    def mw(ctx, next_handler):
        ctx.set("mw", "ok")
        resp = next_handler(ctx)
        resp.headers["x-middleware"] = ["1"]
        return resp

    app.use(mw)
    app.get("/hello", lambda ctx: json(200, {"now": ctx.now().isoformat(), "id": ctx.new_id(), "mw": ctx.get("mw")}))

    event = build_apigw_v2_request("GET", "/hello", headers={"x-request-id": "request-1"})
    resp = env.invoke_apigw_v2(app, event)

    assert resp["statusCode"] == 200
    assert resp["headers"]["x-request-id"] == "request-1"
    assert resp["headers"]["x-middleware"] == "1"
    body = jsonlib.loads(resp["body"])
    assert body["id"] == "req-1"
    assert body["now"] == "2026-01-01T00:00:00+00:00"
    assert body["mw"] == "ok"

    print("examples/testkit/py.py: PASS")


if __name__ == "__main__":
    main()
