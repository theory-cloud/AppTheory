from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.aws_http import (  # noqa: E402
    alb_target_group_response_from_response,
    apigw_proxy_response_from_response,
    apigw_v2_response_from_response,
    build_alb_target_group_request,
    build_apigw_v2_request,
    build_lambda_function_url_request,
    lambda_function_url_response_from_response,
    request_from_alb_target_group,
    request_from_apigw_proxy,
    request_from_apigw_v2,
)
from apptheory.response import Response  # noqa: E402


class TestAwsHttp(unittest.TestCase):
    def test_build_apigw_v2_request_encodes_body_and_orders_query(self) -> None:
        evt = build_apigw_v2_request(
            "get",
            "/hello",
            query={"b": ["2"], "a": ["1"]},
            body=b"\x01\x02",
            is_base64=True,
        )
        self.assertEqual(evt["requestContext"]["http"]["method"], "GET")
        self.assertEqual(evt["rawQueryString"], "a=1&b=2")
        self.assertEqual(evt["body"], base64.b64encode(b"\x01\x02").decode("ascii"))
        self.assertTrue(evt["isBase64Encoded"])

    def test_request_from_apigw_v2_prefers_cookies_and_parses_raw_query(self) -> None:
        evt = build_apigw_v2_request(
            "post",
            "/x?z=9",
            headers={"cookie": "ignored=yes", "x-one": "1"},
            cookies=["a=b"],
            body="ok",
        )
        req = request_from_apigw_v2(evt)
        self.assertEqual(req.method, "POST")
        self.assertEqual(req.path, "/x")
        self.assertEqual(req.query, {"z": ["9"]})
        self.assertEqual(req.headers["cookie"], ["a=b"])
        self.assertEqual(req.headers["x-one"], ["1"])

        manual_evt = {
            "version": "2.0",
            "rawPath": "/",
            "rawQueryString": "",
            "headers": {"x": "y"},
            "queryStringParameters": {"q": "1"},
            "requestContext": {"http": {"method": "GET", "path": "/"}},
            "body": "",
            "isBase64Encoded": False,
        }
        manual_req = request_from_apigw_v2(manual_evt)
        self.assertEqual(manual_req.query, {"q": ["1"]})

    def test_request_from_proxy_variants_merge_multi_headers_and_query(self) -> None:
        proxy_evt = {
            "httpMethod": "GET",
            "path": "/p",
            "headers": {"x-one": "1"},
            "multiValueHeaders": {"x-two": ["2", "3"]},
            "queryStringParameters": {"a": "1"},
            "multiValueQueryStringParameters": {"b": ["2", "3"]},
            "body": "",
            "isBase64Encoded": False,
            "requestContext": {"httpMethod": "GET", "path": "/p"},
        }
        req = request_from_apigw_proxy(proxy_evt)
        self.assertEqual(req.headers["x-one"], ["1"])
        self.assertEqual(req.headers["x-two"], ["2", "3"])
        self.assertEqual(req.query["a"], ["1"])
        self.assertEqual(req.query["b"], ["2", "3"])

        alb_evt = build_alb_target_group_request(
            "put",
            "/q?a=1&a=2",
            headers={"x": "1"},
            multi_headers={"x": ["override"], "y": ["2", "3"]},
            body="ok",
        )
        alb_req = request_from_alb_target_group(alb_evt)
        self.assertEqual(alb_req.method, "PUT")
        self.assertEqual(alb_req.path, "/q")
        self.assertEqual(alb_req.query["a"], ["1", "2"])
        self.assertEqual(alb_req.headers["x"], ["override"])
        self.assertEqual(alb_req.headers["y"], ["2", "3"])

    def test_response_converters_preserve_headers_and_cookies(self) -> None:
        resp = Response(
            status=200,
            headers={"x": ["1", "2"]},
            cookies=["a=b", "c=d"],
            body=b"ok",
            is_base64=False,
        )

        v2 = apigw_v2_response_from_response(resp)
        self.assertEqual(v2["statusCode"], 200)
        self.assertEqual(v2["headers"]["x"], "1")
        self.assertEqual(v2["multiValueHeaders"]["x"], ["1", "2"])
        self.assertEqual(v2["cookies"], ["a=b", "c=d"])

        url = lambda_function_url_response_from_response(resp)
        self.assertEqual(url["headers"]["x"], "1,2")

        proxy = apigw_proxy_response_from_response(resp)
        self.assertEqual(proxy["headers"]["set-cookie"], "a=b")
        self.assertEqual(proxy["multiValueHeaders"]["set-cookie"], ["a=b", "c=d"])

        alb = alb_target_group_response_from_response(resp)
        self.assertEqual(alb["statusDescription"], "200 OK")

        b64 = Response(
            status=200,
            headers={},
            cookies=[],
            body=b"\x00\xff",
            is_base64=True,
        )
        out = apigw_v2_response_from_response(b64)
        self.assertTrue(out["isBase64Encoded"])
        self.assertEqual(out["body"], base64.b64encode(b"\x00\xff").decode("ascii"))

