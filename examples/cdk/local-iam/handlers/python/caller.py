"""The Python side of the local IAM example.

boto3 and botocore are in the python3.14 Lambda image. The signer is botocore's
own ``SigV4Auth``, so the row proves the SDK's credential and endpoint
resolution rather than a hand-written signature:

* ``boto3.Session`` reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
  AWS_SESSION_TOKEN from the environment, which is what the local runner issues
  to the container;
* ``boto3.client("sts")`` resolves its endpoint from AWS_ENDPOINT_URL_STS
  (https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html);
* ``botocore.auth.SigV4Auth`` signs the execute-api request.
  (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html)
"""

import hashlib
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

EMPTY_HASH = hashlib.sha256(b"").hexdigest()


def _credentials():
    session = boto3.Session(region_name="us-east-1")
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError("the container has no AWS credentials")
    frozen = credentials.get_frozen_credentials()
    return {
        "access_key": frozen.access_key,
        "secret_key": frozen.secret_key,
        "token": frozen.token or "",
    }


def _assume_role(role_arn, session_name):
    client = boto3.client("sts", region_name="us-east-1")
    response = client.assume_role(RoleArn=role_arn, RoleSessionName=session_name)
    credentials = response["Credentials"]
    return {
        "access_key": credentials["AccessKeyId"],
        "secret_key": credentials["SecretAccessKey"],
        "token": credentials["SessionToken"],
        "principal": response["AssumedRoleUser"]["Arn"],
    }


def _echo(event):
    context = event.get("requestContext") or {}
    identity = context.get("identity") or {}
    iam = (context.get("authorizer") or {}).get("iam") or {}
    route = context.get("routeKey") or context.get("httpMethod") or "function-url"
    return {
        "route": route,
        "caller": identity.get("caller") or iam.get("callerId"),
        "userArn": identity.get("userArn") or iam.get("userArn"),
        "accountId": identity.get("accountId") or iam.get("accountId"),
        "accessKey": identity.get("accessKey") or iam.get("accessKey"),
    }


def _proxy(payload):
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload),
    }


def handler(event, _context):
    role = os.environ.get("APPTHEORY_LOCAL_IAM_ROLE", "")
    if not role:
        return _proxy(_echo(event))
    outcome = {"role": role, "signed": False}
    try:
        credentials = _credentials()
        outcome["accessKeyId"] = credentials["access_key"]
        if event.get("assumeRoleArn"):
            assumed = _assume_role(event["assumeRoleArn"], event.get("roleSessionName") or "local-iam-row")
            credentials = {
                "access_key": assumed["access_key"],
                "secret_key": assumed["secret_key"],
                "token": assumed["token"],
            }
            outcome["accessKeyId"] = assumed["access_key"]
            outcome["principalArn"] = assumed["principal"]
        parts = urlsplit(event["url"])
        headers = {"host": parts.netloc}
        if event.get("unsigned") is not True:
            request = AWSRequest(method=event.get("method") or "GET", url=event["url"], headers=headers)
            frozen = _frozen(credentials)
            SigV4Auth(frozen, "execute-api", "us-east-1").add_auth(request)
            headers = dict(request.headers)
            outcome["signed"] = True
            if event.get("tamperSignature") is True:
                headers = _tamper(headers)
        body = _call(urlunsplit(parts), event.get("method") or "GET", headers)
        outcome["status"] = body[0]
        outcome["body"] = body[1]
        return _proxy(outcome)
    except Exception as error:  # noqa: BLE001 - the row reports the refusal
        outcome["status"] = 403
        outcome["body"] = str(error)
        return _proxy(outcome)


class _Frozen:
    def __init__(self, access_key, secret_key, token):
        self.access_key = access_key
        self.secret_key = secret_key
        self.token = token


def _frozen(credentials):
    return _Frozen(credentials["access_key"], credentials["secret_key"], credentials["token"])


def _tamper(headers):
    for name, value in list(headers.items()):
        normalized = name.lower()
        if normalized == "authorization":
            index = value.rfind("Signature=")
            if index >= 0:
                signature = value[index + len("Signature=") :]
                last = "1" if signature[-1] == "0" else "0"
                headers[name] = value[: index + len("Signature=")] + signature[:-1] + last
        elif normalized in ("x-amz-security-token", "x-amz-date"):
            continue
    return headers


def _call(url, method, headers):
    request = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310 - a local loopback URL
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", errors="replace")
