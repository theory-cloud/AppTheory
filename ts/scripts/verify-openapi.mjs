import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateOpenAPIJSON } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const fixtureDir = join(repoRoot, "contract-tests", "fixtures", "openapi");

const fixtureNames = [
  "canonical-edge-parity.json",
  "invalid-integer-rule.json",
  "invalid-success-status-zero.json",
  "descriptive-validation.json",
];

for (const fixtureName of fixtureNames) {
  const fixture = JSON.parse(
    readFileSync(join(fixtureDir, fixtureName), "utf8"),
  );
  const spec = normalizeOpenAPISpecForRuntime(fixture.setup?.openapi ?? {});
  const expectedError = fixture.expect?.error;
  if (expectedError) {
    assert.throws(
      () => generateOpenAPIJSON(spec),
      (err) =>
        err instanceof Error &&
        err.message === String(expectedError.message ?? ""),
      fixtureName,
    );
    continue;
  }

  assert.equal(generateOpenAPIJSON(spec), fixture.expect?.output_json, fixtureName);
}

function normalizeOpenAPISpecForRuntime(spec) {
  return {
    title: String(spec?.title ?? ""),
    version: String(spec?.version ?? ""),
    routes: (spec?.routes ?? []).map((route) => ({
      method: String(route?.method ?? ""),
      path: String(route?.path ?? ""),
      operationId: String(route?.operation_id ?? route?.operationId ?? ""),
      ...(route?.summary !== undefined ? { summary: String(route.summary) } : {}),
      ...(Array.isArray(route?.tags)
        ? { tags: route.tags.map((tag) => String(tag)) }
        : {}),
      ...(route?.success_status !== undefined || route?.successStatus !== undefined
        ? { successStatus: Number(route?.success_status ?? route?.successStatus) }
        : {}),
      request: {
        fields: normalizeOpenAPIFields(route?.request?.fields ?? []),
      },
      response: {
        ...(route?.response?.description !== undefined
          ? { description: String(route.response.description) }
          : {}),
        fields: normalizeOpenAPIFields(route?.response?.fields ?? []),
      },
    })),
  };
}

function normalizeOpenAPIFields(fields) {
  return (fields ?? []).map((field) => ({
    field: String(field?.field ?? ""),
    source: String(field?.source ?? ""),
    name: String(field?.name ?? ""),
    type: String(field?.type ?? ""),
    ...(field?.array !== undefined ? { array: Boolean(field.array) } : {}),
    ...(field?.required !== undefined ? { required: Boolean(field.required) } : {}),
    ...(Array.isArray(field?.validation)
      ? {
          validation: field.validation.map((rule) => ({
            rule: String(rule?.rule ?? ""),
            ...(Object.prototype.hasOwnProperty.call(rule ?? {}, "value")
              ? { value: rule.value }
              : {}),
          })),
        }
      : {}),
  }));
}
