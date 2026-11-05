"""The Python handler set for the Runtime API conformance suite.

Python buffers responses through the managed runtime. Lambda response streaming
is available on Node.js managed runtimes and, for other languages, "you can use a
custom runtime with a custom Runtime API integration"; this suite therefore
compares Python buffered only.
https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
"""

import time


def handler(event, context):
    case = event.get("case")
    if case == "proxy":
        return {
            "statusCode": 201,
            "headers": {"content-type": "text/plain; charset=utf-8", "x-case": "proxy"},
            "cookies": ["a=1", "b=2"],
            "body": "python proxy body",
        }
    if case == "error":
        raise RuntimeError("python handler error")
    if case == "timeout":
        time.sleep(3)
        return {"ok": True}
    return {"ok": True, "case": case, "runtime": "python"}
