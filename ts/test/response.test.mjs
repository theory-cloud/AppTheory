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
