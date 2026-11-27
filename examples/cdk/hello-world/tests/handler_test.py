import json as jsonlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "py" / "src"))
# The handler lives in the tree the deployment package stages, which holds only the modules
# that ship; this test lives outside it so the allow-list never has to name a test module.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "handlers" / "py"))

from apptheory import Request, create_test_env, json  # noqa: E402,F401
from handler import build_app  # noqa: E402


def main() -> None:
    env = create_test_env()
    app = build_app({"APPTHEORY_HELLO_LANG": "py", "APPTHEORY_TIER": "p0"})

    resp = env.invoke(app, Request(method="GET", path="/hello/AppTheory"))
    assert resp.status == 200
    body = jsonlib.loads(resp.body.decode())
    assert body["message"] == "hello AppTheory"
    assert body["runtime"] == "py"

    root = env.invoke(app, Request(method="GET", path="/"))
    assert root.status == 200
    print("examples/cdk/hello-world/tests/handler_test.py: PASS")


if __name__ == "__main__":
    main()
