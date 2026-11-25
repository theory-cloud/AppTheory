"""Purpose: the clean-consumer call path for the built AppTheory Python distribution.

This file is copied into a virtual environment that holds nothing but the
installed wheel (and therefore the real `tabletheory-py` release asset the wheel
depends on), and is then run with `python consumer.py`. It imports only published
entry points, drives one real `handle_lambda` request through API Gateway v2
dispatch, and asserts the canonical response and the canonical fail-closed 404
envelope.

It is deliberately not a test framework: the gate is the process exit code, so a
failed assertion raises and the install is not proven.
"""

from __future__ import annotations

import json
from importlib.metadata import version

from apptheory import create_app, text

app = create_app()


def ping(_ctx):
    return text(200, "pong")


app.get("/ping", ping)


def api_gateway_v2_request(method: str, path: str) -> dict:
    return {
        "version": "2.0",
        "routeKey": f"{method} {path}",
        "rawPath": path,
        "rawQueryString": "",
        "headers": {"host": "example.com"},
        "requestContext": {
            "accountId": "000000000000",
            "apiId": "consumerinstall",
            "domainName": "example.com",
            "domainPrefix": "consumerinstall",
            "http": {
                "method": method,
                "path": path,
                "protocol": "HTTP/1.1",
                "sourceIp": "127.0.0.1",
                "userAgent": "apptheory-consumer-install",
            },
            "requestId": "consumer-install-request",
            "routeKey": f"{method} {path}",
            "stage": "$default",
            "time": "01/Jan/2026:00:00:00 +0000",
            "timeEpoch": 1767225600000,
        },
        "isBase64Encoded": False,
    }


def main() -> None:
    # The runtime's data layer must be a real, importable dependency, not a name
    # that only appears in the package metadata.
    tabletheory_version = version("tabletheory-py")
    import tabletheory_py  # noqa: F401 - the import itself is the assertion

    ok = app.handle_lambda(api_gateway_v2_request("GET", "/ping"), {})
    if ok.get("statusCode") != 200:
        raise SystemExit(f"consumer-install(py): expected 200, got {ok.get('statusCode')}")
    if ok.get("body") != "pong":
        raise SystemExit(f"consumer-install(py): expected 'pong', got {json.dumps(ok.get('body'))}")

    missing = app.handle_lambda(api_gateway_v2_request("GET", "/absent"), {})
    if missing.get("statusCode") != 404:
        raise SystemExit(
            f"consumer-install(py): expected the fail-closed 404 envelope, got {missing.get('statusCode')}"
        )
    if not isinstance(missing.get("body"), str) or not missing.get("body"):
        raise SystemExit("consumer-install(py): the fail-closed 404 envelope carried no body")

    tier_app = create_app(tier="p0")
    if not hasattr(tier_app, "handle_lambda"):
        raise SystemExit('consumer-install(py): create_app(tier="p0") did not return an app')

    print(
        "consumer-install(py): handle_lambda GET /ping -> "
        f"{ok.get('statusCode')} {json.dumps(ok.get('body'))}, "
        f"GET /absent -> {missing.get('statusCode')}, tabletheory-py {tabletheory_version}"
    )


if __name__ == "__main__":
    main()
