import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
export function isAwsCredentials(value) {
    if (!value || typeof value !== "object")
        return false;
    const rec = value;
    return (typeof rec["accessKeyId"] === "string" &&
        typeof rec["secretAccessKey"] === "string");
}
export function loadEnvCredentials() {
    const accessKeyId = String(process.env["AWS_ACCESS_KEY_ID"] ?? "").trim();
    const secretAccessKey = String(process.env["AWS_SECRET_ACCESS_KEY"] ?? "").trim();
    const sessionToken = String(process.env["AWS_SESSION_TOKEN"] ?? "").trim();
    if (!accessKeyId || !secretAccessKey) {
        throw new Error("apptheory: missing aws credentials");
    }
    const out = { accessKeyId, secretAccessKey };
    if (sessionToken)
        out.sessionToken = sessionToken;
    return out;
}
function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
function hmacSha256(key, data) {
    return createHmac("sha256", key).update(data, "utf8").digest();
}
function signingKey(secretAccessKey, dateStamp, region, service) {
    const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    return hmacSha256(kService, "aws4_request");
}
function amzDateNow(now = new Date()) {
    return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
export async function signedFetch({ method, url, region, service, credentials, headers, body, }) {
    const u = new URL(url);
    const host = u.host;
    const canonicalUri = u.pathname || "/";
    const canonicalQueryString = u.searchParams.toString();
    const payloadHash = sha256Hex(body ?? "");
    const amzDate = amzDateNow();
    const dateStamp = amzDate.slice(0, 8);
    const merged = { host, "x-amz-date": amzDate };
    for (const [key, value] of Object.entries(headers ?? {})) {
        const k = String(key).trim().toLowerCase();
        if (k)
            merged[k] = String(value);
    }
    if (credentials.sessionToken) {
        merged["x-amz-security-token"] = credentials.sessionToken;
    }
    const sortedKeys = Object.keys(merged).sort();
    const canonicalHeaders = sortedKeys
        .map((k) => `${k}:${String(merged[k]).trim().replace(/\s+/g, " ")}\n`)
        .join("");
    const signedHeaders = sortedKeys.join(";");
    const canonicalRequest = [
        String(method).toUpperCase(),
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        scope,
        sha256Hex(canonicalRequest),
    ].join("\n");
    const kSigning = signingKey(credentials.secretAccessKey, dateStamp, region, service);
    const signature = createHmac("sha256", kSigning)
        .update(stringToSign, "utf8")
        .digest("hex");
    merged["authorization"] =
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const init = {
        method,
        headers: merged,
    };
    if (body) {
        init.body = Buffer.from(body);
    }
    return fetch(u.toString(), init);
}
