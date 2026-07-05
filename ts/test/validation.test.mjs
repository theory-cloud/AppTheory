import test from "node:test";
import assert from "node:assert/strict";

import { bindRequest, required, validateValue } from "../dist/index.js";

test("required validation uses presence, not truthiness", () => {
  const schema = {
    count: [required()],
    active: [required()],
    name: [required()],
    tags: [required()],
    meta: [required()],
  };

  assert.deepEqual(
    validateValue(
      { count: 0, active: false, name: "", tags: [], meta: {} },
      schema,
    ),
    [],
  );

  assert.deepEqual(validateValue({ count: null, active: false }, schema), [
    { field: "count", rule: "required", message: "count is required" },
    { field: "name", rule: "required", message: "name is required" },
    { field: "tags", rule: "required", message: "tags is required" },
    { field: "meta", rule: "required", message: "meta is required" },
  ]);
});

test("body binding preserves present empty arrays for required", async () => {
  const req = await bindRequest(
    {
      request: {
        body: Buffer.from('{"tags":[]}'),
        query: {},
        headers: {},
      },
    },
    {
      body: true,
      fields: {
        tags: {
          source: "body",
          name: "tags",
          array: true,
          validate: [required()],
        },
      },
    },
  );

  assert.deepEqual(req, { tags: [] });
});
