"""Python caller: fetch discovery and JWKS over verified TLS.

The Lambda Python image's ssl module loads the file named by SSL_CERT_FILE
(OpenSSL's default verify path), so create_default_context trusts the runner's
CA without this handler knowing where it is.
https://docs.python.org/3/library/ssl.html#ssl.create_default_context
"""

import json
import ssl
import urllib.request


def get_json(url):
    context = ssl.create_default_context()
    with urllib.request.urlopen(url, context=context, timeout=10) as response:
        if response.status != 200:
            raise ValueError(f"GET {url}: status {response.status}")
        return json.loads(response.read(1 << 20).decode("utf-8"))


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
    return {"ok": True, "issuer": discovery["issuer"], "keys": len(keys)}
