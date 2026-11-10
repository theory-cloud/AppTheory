"""Python caller: fetch discovery and JWKS over verified TLS, and exercise the
AWS SDK in the same container.

The Lambda Python image's ssl module loads the file named by SSL_CERT_FILE
(OpenSSL's default verify path), so create_default_context trusts the runner's
CA without this handler knowing where it is. boto3 reads AWS_CA_BUNDLE and
applies it through its own HTTP session, and it verifies the @connections
management endpoint the runner serves over TLS.
https://docs.python.org/3/library/ssl.html#ssl.create_default_context
https://docs.aws.amazon.com/sdkref/latest/guide/feature-custom-trust-store.html
"""

import json
import ssl
import urllib.request

import boto3
from botocore.exceptions import ClientError


def get_json(url):
    context = ssl.create_default_context()
    with urllib.request.urlopen(url, context=context, timeout=10) as response:
        if response.status != 200:
            raise ValueError(f"GET {url}: status {response.status}")
        return json.loads(response.read(1 << 20).decode("utf-8"))


def exercise_aws():
    """One SDK call per runner-served endpoint the container was given."""
    tables = boto3.client("dynamodb").list_tables().get("TableNames") or []
    client = boto3.client("apigatewaymanagementapi")
    try:
        client.post_to_connection(ConnectionId="apptheory-local-tls-probe", Data=b"probe")
    except ClientError as error:
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if status != 410:
            raise ValueError(f"the @connections call did not reach the run's TLS endpoint: {error}") from error
        return {"tables": len(tables), "management": status}
    raise ValueError("the @connections call to an unknown connection must answer 410 GONE")


def handler(event, context=None):
    del context
    base = str((event or {}).get("url") or "")
    if not base:
        raise ValueError("url is required")
    discovery = get_json(base + "/.well-known/openid-configuration")
    if discovery.get("issuer") != base:
        raise ValueError(f"issuer {discovery.get('issuer')} does not equal {base}")
    jwks = get_json(discovery["jwks_uri"])
    keys = jwks.get("keys") or []
    if not keys:
        raise ValueError("jwks has no keys")
    result = {"ok": True, "issuer": discovery["issuer"], "keys": len(keys)}
    if (event or {}).get("aws"):
        result.update(exercise_aws())
    return result
