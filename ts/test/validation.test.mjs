import test from "node:test";
import assert from "node:assert/strict";

import {
  bindRequest,
  min,
  oneOf,
  pattern,
  required,
  validateValue,
} from "../dist/index.js";

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

test("validation errors use canonical wire names for bound fields", async () => {
  await assert.rejects(
    () =>
      bindRequest(
        {
          request: {
            body: Buffer.from('{"name":"Alice"}'),
            query: { "page-size": ["3"] },
            headers: { "x-role": ["guest"] },
          },
          params: { account_id: "tenant_123" },
        },
        {
          body: true,
          query: true,
          path: true,
          headers: true,
          fields: {
            AccountID: { source: "path", name: "account_id" },
            PageSize: { source: "query", name: "page-size", type: "int" },
            Role: { source: "header", name: "x-role" },
            Name: { source: "body", name: "name" },
          },
          validation: {
            AccountID: [pattern("^acct_")],
            PageSize: [min(10)],
            Role: [oneOf(["admin", "member"])],
            Name: [required()],
          },
        },
      ),
    (err) => {
      assert.equal(err.code, "app.validation_failed");
      assert.deepEqual(err.details, {
        errors: [
          {
            field: "account_id",
            rule: "pattern",
            message: "account_id must match pattern",
          },
          {
            field: "page-size",
            rule: "min",
            message: "page-size must be >= 10",
          },
          {
            field: "x-role",
            rule: "enum",
            message: "x-role must be one of admin, member",
          },
        ],
      });
      return true;
    },
  );
});

test("invalid validation rule config fails closed", () => {
  assert.deepEqual(
    validateValue(
      { email: "alice@example.com", age: 30, name: "Alice", role: "admin" },
      {
        email: [{ rule: "pattern", value: "[" }],
        age: [{ rule: "min", value: "abc" }],
        name: [{ rule: "required", value: "unexpected" }],
        role: [{ rule: "typo", value: "1" }],
      },
    ),
    [
      {
        field: "email",
        rule: "pattern",
        message: "email has invalid validation rule pattern",
      },
      {
        field: "age",
        rule: "min",
        message: "age has invalid validation rule min",
      },
      {
        field: "name",
        rule: "required",
        message: "name has invalid validation rule required",
      },
      {
        field: "role",
        rule: "typo",
        message: "role has invalid validation rule typo",
      },
    ],
  );
});

test("duration binding uses Go-compatible portable canonicalization", async () => {
  const req = await bindRequest(
    {
      request: {
        query: {
          half: ["500ms"],
          micro: ["1500us"],
          boundary: ["999999us"],
          combined: ["1s500ms"],
          negative: ["-1s500ms"],
        },
        headers: {},
      },
    },
    {
      query: true,
      fields: {
        Half: { source: "query", name: "half", type: "duration" },
        Micro: { source: "query", name: "micro", type: "duration" },
        Boundary: { source: "query", name: "boundary", type: "duration" },
        Combined: { source: "query", name: "combined", type: "duration" },
        Negative: { source: "query", name: "negative", type: "duration" },
      },
    },
  );

  assert.deepEqual(req, {
    Half: "500ms",
    Micro: "1.5ms",
    Boundary: "999.999ms",
    Combined: "1.5s",
    Negative: "-1.5s",
  });

  await assert.rejects(() =>
    bindRequest(
      { request: { query: { ttl: ["1s-500ms"] }, headers: {} } },
      {
        query: true,
        fields: { TTL: { source: "query", name: "ttl", type: "duration" } },
      },
    ),
  );
  await assert.rejects(() =>
    bindRequest(
      { request: { query: { ttl: ["1ns"] }, headers: {} } },
      {
        query: true,
        fields: { TTL: { source: "query", name: "ttl", type: "duration" } },
      },
    ),
  );
});

test("numeric binding rejects unsafe integers and partial floats", async () => {
  const config = {
    query: true,
    fields: {
      Count: { source: "query", name: "count", type: "int" },
      Ratio: { source: "query", name: "ratio", type: "float" },
    },
  };
  await assert.rejects(() =>
    bindRequest(
      {
        request: {
          query: { count: ["9007199254740992"], ratio: ["1.5"] },
          headers: {},
        },
      },
      config,
    ),
  );
  await assert.rejects(() =>
    bindRequest(
      {
        request: {
          query: { count: ["7"], ratio: ["1.5oops"] },
          headers: {},
        },
      },
      config,
    ),
  );
});

test("strict json rejects unknown keys with zero declared body fields", async () => {
  await assert.rejects(
    () =>
      bindRequest(
        {
          request: {
            body: Buffer.from('{"extra":true}'),
            query: { count: ["7"] },
            headers: {},
          },
        },
        {
          body: true,
          query: true,
          strictJson: true,
          fields: {
            Count: { source: "query", name: "count", type: "int" },
          },
        },
      ),
    (err) => {
      assert.equal(err.code, "app.bad_request");
      assert.deepEqual(err.details, { source: "body", name: "extra" });
      return true;
    },
  );
});
