import test from "node:test";
import assert from "node:assert/strict";

import { originURL, originalHost, originalURI } from "../dist/index.js";

test("originURL prefers edge-copied original host headers before forwarded fallbacks", () => {
  assert.equal(
    originURL({
      "x-apptheory-original-host": "edge.example.com",
      "cloudfront-forwarded-proto": "https",
    }),
    "https://edge.example.com",
  );

  assert.equal(
    originURL({
      "x-facetheory-original-host": "tenant.example.com",
      "cloudfront-forwarded-proto": "https",
    }),
    "https://tenant.example.com",
  );

  assert.equal(
    originURL({
      "x-forwarded-host": "fallback.example.com, other.example.com",
      "cloudfront-forwarded-proto": "https",
    }),
    "https://fallback.example.com",
  );
});

test("originalHost and originalURI normalize both AppTheory and FaceTheory edge headers", () => {
  assert.equal(originalHost({ "x-apptheory-original-host": "app.example.com" }), "app.example.com");
  assert.equal(originalURI({ "x-apptheory-original-uri": "/from-app" }), "/from-app");
  assert.equal(originalHost({ "x-facetheory-original-host": "face.example.com" }), "face.example.com");
  assert.equal(originalURI({ "x-facetheory-original-uri": "/from-face" }), "/from-face");
});

test("dual-body responses (buffered body + bodyStream) fail closed through the serve path", async () => {
  // A response carrying both a non-empty buffered body and a bodyStream is
  // divergent: the buffered adapters drain the stream and replace the buffered
  // body, while the v1 proxy adapter ignores bodyStream entirely and the v1
  // streaming adapter composes only body + BodyReader. The normalizer must fail
  // closed on the ambiguous shape instead of letting adapters silently pick one
  // representation.
  const { createApp } = await import("../dist/index.js");
  const app = createApp();
  app.get("/dual", () => ({
    status: 200,
    headers: { "content-type": ["text/html; charset=utf-8"] },
    cookies: [],
    body: Buffer.from("buffered", "utf8"),
    bodyStream: (async function* () {
      yield Buffer.from("streamed", "utf8");
    })(),
    isBase64: false,
  }));

  const resp = await app.serve({
    method: "GET",
    path: "/dual",
    headers: {},
    query: {},
    body: Buffer.alloc(0),
    isBase64: false,
  });

  assert.equal(resp.status, 500);
  const body = JSON.parse(Buffer.from(resp.body).toString("utf8"));
  assert.equal(body.error.code, "app.internal");
  assert.equal(body.error.message, "internal error");
});
