import { Buffer } from "node:buffer";

import type { Context, Handler } from "./context.js";
import { AppError, AppTheoryError } from "./errors.js";
import { json } from "./response.js";
import type { ValidationRuleSpec, ValidationSchema } from "./validate.js";
import { validateOrThrow } from "./validate.js";

export type BindSource = "body" | "query" | "path" | "header";
export type BindFieldType = "string" | "int" | "bool" | "float" | "duration";

export interface BindFieldSpec {
  source: BindSource;
  name?: string;
  type?: BindFieldType;
  array?: boolean;
  field?: string;
  validate?: readonly ValidationRuleSpec[];
}

export type BindFieldSpecs<Req> = Partial<
  Record<Extract<keyof Req, string>, BindFieldSpec>
>;

export interface BindConfig<Req> {
  body?: boolean;
  query?: boolean;
  path?: boolean;
  headers?: boolean;
  strictJson?: boolean;
  successStatus?: number;
  fields?: BindFieldSpecs<Req>;
  validation?: ValidationSchema<Req>;
  validate?: (ctx: Context, req: Req) => void | Promise<void>;
}

interface SourceValueResult {
  present: boolean;
  values: unknown[];
}

const MAX_PORTABLE_INTEGER = Number.MAX_SAFE_INTEGER;

export type TypedHandler<Req, Resp> = (
  ctx: Context,
  req: Req,
) => Resp | Promise<Resp>;

export function bindHandler<Req, Resp>(
  config: BindConfig<Req>,
  handler: TypedHandler<Req, Resp>,
): Handler {
  return async (ctx: Context) => {
    const req = await bindRequest(ctx, config);
    const resp = await handler(ctx, req);
    return json(config.successStatus ?? 200, resp);
  };
}

export async function bindRequest<Req>(
  ctx: Context,
  config: BindConfig<Req>,
): Promise<Req> {
  const fields = (config.fields ?? {}) as BindFieldSpecs<Req>;
  const fieldKeys = Object.keys(fields) as Extract<keyof Req, string>[];
  let req: Record<string, unknown> = {};
  let bodyValue: Record<string, unknown> | null = null;

  if (config.body) {
    bodyValue = parseBody(ctx);
    const bodyFieldNames = new Set(
      fieldKeys
        .filter((key) => fields[key]?.source === "body")
        .map((key) => fields[key]?.name ?? key),
    );
    if (config.strictJson) {
      for (const key of Object.keys(bodyValue)) {
        if (!bodyFieldNames.has(key)) {
          throw bindingError("body", key, "", undefined);
        }
      }
    }
    if (fieldKeys.length === 0) {
      req = { ...bodyValue };
    }
  }

  for (const key of fieldKeys) {
    const spec = fields[key];
    if (!spec) continue;
    const name = spec.name ?? key;
    const source = sourceValues(ctx, bodyValue, spec.source, name);
    if (!source.present) continue;
    try {
      req[key] = spec.array
        ? source.values.map((value) => parseValue(value, spec.type ?? "string"))
        : parseValue(
            source.values.length > 0 ? source.values[0] : "",
            spec.type ?? "string",
          );
    } catch (err) {
      throw bindingError(spec.source, name, spec.field ?? key, err);
    }
  }

  const validation = mergeValidation(config.validation, fields);
  validateOrThrow(req as Req, validation);

  if (typeof config.validate === "function") {
    try {
      await config.validate(ctx, req as Req);
    } catch (err) {
      throw normalizeValidationError(err);
    }
  }

  return req as Req;
}

function parseBody(ctx: Context): Record<string, unknown> {
  const body = Buffer.from(ctx.request.body ?? []);
  if (body.length === 0) {
    throw new AppTheoryError("app.bad_request", "request body is empty", {
      statusCode: 400,
    });
  }
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new TypeError("request body must be a JSON object");
    }
    return parsed;
  } catch (err) {
    if (err instanceof AppTheoryError) throw err;
    throw new AppTheoryError("app.bad_request", "invalid json", {
      statusCode: 400,
      cause: err,
    });
  }
}

function sourceValues(
  ctx: Context,
  bodyValue: Record<string, unknown> | null,
  source: BindSource,
  name: string,
): SourceValueResult {
  switch (source) {
    case "body": {
      if (
        !bodyValue ||
        !Object.prototype.hasOwnProperty.call(bodyValue, name)
      ) {
        return { present: false, values: [] };
      }
      const value = bodyValue[name];
      if (Array.isArray(value)) return { present: true, values: value };
      return { present: true, values: [value] };
    }
    case "query": {
      const values = ctx.request.query?.[name];
      return values && values.length > 0
        ? { present: true, values: values.map((value) => String(value)) }
        : { present: false, values: [] };
    }
    case "path": {
      const value = ctx.params?.[name];
      return value === undefined
        ? { present: false, values: [] }
        : { present: true, values: [String(value)] };
    }
    case "header": {
      const values = ctx.request.headers?.[name.toLowerCase()];
      return values && values.length > 0
        ? { present: true, values: values.map((value) => String(value)) }
        : { present: false, values: [] };
    }
  }
}

function parseValue(raw: unknown, type: BindFieldType): unknown {
  switch (type) {
    case "string":
      return raw === null ? null : String(raw);
    case "int": {
      const rawText = String(raw ?? "");
      if (!/^[+-]?\d+$/.test(rawText)) throw new Error("invalid integer");
      const value = Number.parseInt(rawText, 10);
      if (
        !Number.isSafeInteger(value) ||
        Math.abs(value) > MAX_PORTABLE_INTEGER
      ) {
        throw new Error("integer outside portable safe range");
      }
      return value;
    }
    case "bool": {
      const normalized = String(raw ?? "")
        .trim()
        .toLowerCase();
      if (["1", "t", "true"].includes(normalized)) return true;
      if (["0", "f", "false"].includes(normalized)) return false;
      throw new Error("invalid boolean");
    }
    case "float": {
      const rawText = String(raw ?? "");
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawText)) {
        throw new Error("invalid float");
      }
      const value = Number(rawText);
      if (!Number.isFinite(value)) throw new Error("invalid float");
      return value;
    }
    case "duration":
      return parseDuration(String(raw ?? ""));
  }
}

function parseDuration(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("invalid duration");
  let sign = 1n;
  let body = trimmed;
  if (body[0] === "-" || body[0] === "+") {
    sign = body[0] === "-" ? -1n : 1n;
    body = body.slice(1);
  }
  if (!body) throw new Error("invalid duration");

  const pattern = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/gy;
  let totalNs = 0n;
  while (pattern.lastIndex < body.length) {
    const match = pattern.exec(body);
    if (!match) throw new Error("invalid duration");
    totalNs += decimalDurationToNs(match[1] ?? "", match[2] ?? "");
  }
  totalNs *= sign;
  if (totalNs % 1000n !== 0n) {
    throw new Error("duration precision below one microsecond is not portable");
  }
  return formatDurationNs(totalNs);
}

function durationUnitNs(unit: string): bigint {
  switch (unit) {
    case "h":
      return 3_600_000_000_000n;
    case "m":
      return 60_000_000_000n;
    case "s":
      return 1_000_000_000n;
    case "ms":
      return 1_000_000n;
    case "us":
    case "µs":
      return 1_000n;
    case "ns":
      return 1n;
    default:
      throw new Error("invalid duration");
  }
}

function decimalDurationToNs(amount: string, unit: string): bigint {
  const unitNs = durationUnitNs(unit);
  const pieces = amount.split(".");
  const wholeRaw = pieces[0] ?? "";
  const fractionRaw = pieces[1] ?? "";
  const whole = wholeRaw === "" ? 0n : BigInt(wholeRaw);
  let out = whole * unitNs;
  if (fractionRaw !== "") {
    const fraction = BigInt(fractionRaw);
    const scale = 10n ** BigInt(fractionRaw.length);
    out += (fraction * unitNs) / scale;
  }
  return out;
}

function formatDurationNs(totalNs: bigint): string {
  const sign = totalNs < 0n ? "-" : "";
  let remaining = totalNs < 0n ? -totalNs : totalNs;
  const hour = 3_600_000_000_000n;
  const minute = 60_000_000_000n;
  const second = 1_000_000_000n;
  const millisecond = 1_000_000n;
  const microsecond = 1_000n;
  if (remaining === 0n) return "0s";

  const parts: string[] = [];
  if (remaining >= second) {
    const hours = remaining / hour;
    if (hours > 0n) {
      parts.push(`${hours}h`);
      remaining %= hour;
      const minutes = remaining / minute;
      parts.push(`${minutes}m`);
      remaining %= minute;
    } else {
      const minutes = remaining / minute;
      if (minutes > 0n) {
        parts.push(`${minutes}m`);
        remaining %= minute;
      }
    }
    const seconds = remaining / second;
    const fraction = remaining % second;
    parts.push(formatDecimalUnit(seconds, fraction, 9, "s"));
    return `${sign}${parts.join("")}`;
  }

  if (remaining >= millisecond) {
    return `${sign}${formatDecimalUnit(
      remaining / millisecond,
      remaining % millisecond,
      6,
      "ms",
    )}`;
  }
  if (remaining >= microsecond) {
    return `${sign}${formatDecimalUnit(
      remaining / microsecond,
      remaining % microsecond,
      3,
      "µs",
    )}`;
  }
  return `${sign}${remaining}ns`;
}

function formatDecimalUnit(
  whole: bigint,
  fraction: bigint,
  fractionWidth: number,
  unit: string,
): string {
  if (fraction === 0n) return `${whole}${unit}`;
  let text = fraction.toString().padStart(fractionWidth, "0");
  text = text.replace(/0+$/, "");
  return `${whole}.${text}${unit}`;
}

function bindingError(
  source: BindSource,
  name: string,
  field: string,
  cause: unknown,
): AppTheoryError {
  const message = field
    ? `invalid ${source} binding for ${field}`
    : `invalid ${source} binding: ${name}`;
  const details: Record<string, unknown> = { source, name };
  if (field) details["field"] = field;
  return new AppTheoryError("app.bad_request", message, {
    statusCode: 400,
    details,
    cause,
  });
}

function normalizeValidationError(err: unknown): AppTheoryError {
  if (err instanceof AppTheoryError) {
    if (err.code === "app.validation_failed" && !err.statusCode) {
      err.statusCode = 422;
    }
    return err;
  }
  if (err instanceof AppError) {
    const options =
      err.code === "app.validation_failed"
        ? { statusCode: 422, cause: err }
        : { cause: err };
    return new AppTheoryError(err.code, err.message, options);
  }
  return new AppTheoryError("app.validation_failed", "validation failed", {
    statusCode: 422,
    cause: err,
  });
}

function mergeValidation<Req>(
  validation: ValidationSchema<Req> | undefined,
  fields: BindFieldSpecs<Req>,
): ValidationSchema<Req> | undefined {
  const merged: Record<string, ValidationRuleSpec[]> = {};
  for (const [key, rules] of Object.entries(
    (validation as Record<string, readonly ValidationRuleSpec[]>) ?? {},
  )) {
    const spec = (fields as Record<string, BindFieldSpec>)[key];
    const wireName = spec?.name ?? key;
    merged[key] = [...(rules ?? [])].map((rule) =>
      withCanonicalValidationField(rule, wireName),
    );
  }
  for (const [key, spec] of Object.entries(
    fields as Record<string, BindFieldSpec>,
  )) {
    if (!spec.validate) continue;
    const wireName = spec.name ?? key;
    merged[key] = [
      ...(merged[key] ?? []),
      ...spec.validate.map((rule) =>
        withCanonicalValidationField(rule, wireName),
      ),
    ];
  }
  return Object.keys(merged).length > 0
    ? (merged as ValidationSchema<Req>)
    : undefined;
}

function withCanonicalValidationField(
  rule: ValidationRuleSpec,
  field: string,
): ValidationRuleSpec {
  return rule.field === undefined ? { ...rule, field } : { ...rule };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
