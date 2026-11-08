// The Node caller.
//
// The nodejs24.x image carries the AWS SDK for JavaScript v3 under
// /var/runtime/node_modules, and the function's NODE_PATH points there, so a
// bare-name require resolves the SDK the image ships. The signer is the SDK's
// own SignatureV4, which is what makes this row a proof of the SDK's credential
// and endpoint resolution rather than a hand-written signature.
//
// https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const SDK = "/var/runtime/node_modules/";
const { SignatureV4 } = require(SDK + "@aws-sdk/signature-v4");
const { HttpRequest } = require(SDK + "@aws-sdk/protocol-http");
const { STSClient, AssumeRoleCommand } = require(SDK + "@aws-sdk/client-sts");

// Sha256 is the hash the SDK's signer expects: a constructor that takes the
// HMAC key as its only argument, updates, and digests.
// https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/signing.html
class Sha256 {
  constructor(secret) {
    this.secret = secret;
    this.chunks = [];
  }

  update(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return this;
  }

  async digest() {
    const body = Buffer.concat(this.chunks);
    if (this.secret) {
      return crypto.createHmac("sha256", this.secret).update(body).digest();
    }
    return crypto.createHash("sha256").update(body).digest();
  }
}

function proxy(payload) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function echoIdentity(event) {
  const context = (event && event.requestContext) || {};
  const identity = context.identity || {};
  const iam = (context.authorizer && context.authorizer.iam) || {};
  return proxy({
    route: context.routeKey || context.httpMethod || "function-url",
    caller: identity.caller || iam.callerId || null,
    userArn: identity.userArn || iam.userArn || null,
    accountId: identity.accountId || iam.accountId || null,
    accessKey: identity.accessKey || iam.accessKey || null,
  });
}

function sendRequest(target, method, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method,
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode || 0, body }));
      },
    );
    request.on("error", reject);
    request.setTimeout(20000, () => request.destroy(new Error("timeout")));
    request.end();
  });
}

exports.handler = async (event) => {
  const role = process.env.APPTHEORY_LOCAL_IAM_ROLE || "";
  if (!role) {
    return echoIdentity(event);
  }
  const outcome = { role, signed: false };
  try {
    const target = new URL(event.url);
    let credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      sessionToken: process.env.AWS_SESSION_TOKEN || "",
    };
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      throw new Error("the container has no AWS credentials");
    }
    outcome.accessKeyId = credentials.accessKeyId;
    if (event.assumeRoleArn) {
      const client = new STSClient({ region: "us-east-1" });
      const assumed = await client.send(
        new AssumeRoleCommand({
          RoleArn: event.assumeRoleArn,
          RoleSessionName: event.roleSessionName || "local-iam-row",
        }),
      );
      credentials = {
        accessKeyId: assumed.Credentials.AccessKeyId,
        secretAccessKey: assumed.Credentials.SecretAccessKey,
        sessionToken: assumed.Credentials.SessionToken,
      };
      outcome.accessKeyId = credentials.accessKeyId;
      outcome.principalArn = assumed.AssumedRoleUser.Arn;
    }
    const signed = new HttpRequest({
      method: event.method || "GET",
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams.entries()),
      headers: { host: target.host },
    });
    let headers = signed.headers;
    if (event.unsigned !== true) {
      const signer = new SignatureV4({
        credentials,
        region: "us-east-1",
        service: "execute-api",
        sha256: Sha256,
      });
      const request = await signer.sign(signed);
      headers = request.headers;
      outcome.signed = true;
      if (event.tamperSignature === true) {
        const authorization = headers.authorization || "";
        const index = authorization.lastIndexOf("Signature=");
        if (index >= 0) {
          const prefix = authorization.slice(0, index + "Signature=".length);
          const signature = authorization.slice(index + "Signature=".length);
          headers.authorization = prefix + signature.slice(0, -1) + (signature.slice(-1) === "0" ? "1" : "0");
        }
      }
    }
    const answer = await sendRequest(target, signed.method, headers);
    outcome.status = answer.status;
    outcome.body = answer.body;
    return proxy(outcome);
  } catch (error) {
    outcome.status = 403;
    outcome.body = String(error && error.message ? error.message : error);
    return proxy(outcome);
  }
};
