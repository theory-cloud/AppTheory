import { Buffer } from "node:buffer";
import { AppError, AppTheoryError } from "./errors.js";
import { json } from "./response.js";
import { validateOrThrow } from "./validate.js";
const MAX_PORTABLE_INTEGER = Number.MAX_SAFE_INTEGER;
export function bindHandler(config, handler) {
    return async (ctx) => {
        const req = await bindRequest(ctx, config);
        const resp = await handler(ctx, req);
        return json(config.successStatus ?? 200, resp);
    };
}
export async function bindRequest(ctx, config) {
    const fields = (config.fields ?? {});
    const fieldKeys = Object.keys(fields);
    let req = {};
    let bodyValue = null;
    if (config.body) {
        bodyValue = parseBody(ctx);
        const bodyFieldNames = new Set(fieldKeys
            .filter((key) => fields[key]?.source === "body")
            .map((key) => fields[key]?.name ?? key));
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
        if (!spec)
            continue;
        const name = spec.name ?? key;
        const source = sourceValues(ctx, bodyValue, spec.source, name);
        if (!source.present)
            continue;
        try {
            req[key] = spec.array
                ? source.values.map((value) => parseValue(value, spec.type ?? "string"))
                : parseValue(source.values.length > 0 ? source.values[0] : "", spec.type ?? "string");
        }
        catch (err) {
            throw bindingError(spec.source, name, spec.field ?? key, err);
        }
    }
    const validation = mergeValidation(config.validation, fields);
    validateOrThrow(req, validation);
    if (typeof config.validate === "function") {
        try {
            await config.validate(ctx, req);
        }
        catch (err) {
            throw normalizeValidationError(err);
        }
    }
    return req;
}
function parseBody(ctx) {
    const body = Buffer.from(ctx.request.body ?? []);
    if (body.length === 0) {
        throw new AppTheoryError("app.bad_request", "request body is empty", {
            statusCode: 400,
        });
    }
    try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (!isRecord(parsed)) {
            throw new TypeError("request body must be a JSON object");
        }
        return parsed;
    }
    catch (err) {
        if (err instanceof AppTheoryError)
            throw err;
        throw new AppTheoryError("app.bad_request", "invalid json", {
            statusCode: 400,
            cause: err,
        });
    }
}
function sourceValues(ctx, bodyValue, source, name) {
    switch (source) {
        case "body": {
            if (!bodyValue ||
                !Object.prototype.hasOwnProperty.call(bodyValue, name)) {
                return { present: false, values: [] };
            }
            const value = bodyValue[name];
            if (Array.isArray(value))
                return { present: true, values: value };
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
function parseValue(raw, type) {
    switch (type) {
        case "string":
            return raw === null ? null : String(raw);
        case "int": {
            const rawText = String(raw ?? "");
            if (!/^[+-]?\d+$/.test(rawText))
                throw new Error("invalid integer");
            const value = Number.parseInt(rawText, 10);
            if (!Number.isSafeInteger(value) ||
                Math.abs(value) > MAX_PORTABLE_INTEGER) {
                throw new Error("integer outside portable safe range");
            }
            return value;
        }
        case "bool": {
            const normalized = String(raw ?? "")
                .trim()
                .toLowerCase();
            if (["1", "t", "true"].includes(normalized))
                return true;
            if (["0", "f", "false"].includes(normalized))
                return false;
            throw new Error("invalid boolean");
        }
        case "float": {
            const rawText = String(raw ?? "");
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawText)) {
                throw new Error("invalid float");
            }
            const value = Number(rawText);
            if (!Number.isFinite(value))
                throw new Error("invalid float");
            return value;
        }
        case "duration":
            return parseDuration(String(raw ?? ""));
    }
}
function parseDuration(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        throw new Error("invalid duration");
    let sign = 1n;
    let body = trimmed;
    if (body[0] === "-" || body[0] === "+") {
        sign = body[0] === "-" ? -1n : 1n;
        body = body.slice(1);
    }
    if (!body)
        throw new Error("invalid duration");
    const segments = parseDurationSegments(body);
    let totalNs = 0n;
    for (const segment of segments) {
        totalNs += decimalDurationToNs(segment.amount, segment.unit);
    }
    totalNs *= sign;
    if (totalNs % 1000n !== 0n) {
        throw new Error("duration precision below one microsecond is not portable");
    }
    return formatDurationNs(totalNs);
}
function durationUnitNs(unit) {
    switch (unit) {
        case "h":
            return 3600000000000n;
        case "m":
            return 60000000000n;
        case "s":
            return 1000000000n;
        case "ms":
            return 1000000n;
        case "us":
        case "µs":
            return 1000n;
        case "ns":
            return 1n;
        default:
            throw new Error("invalid duration");
    }
}
function parseDurationSegments(body) {
    const segments = [];
    let index = 0;
    while (index < body.length) {
        const amountStart = index;
        let sawWholeDigit = false;
        while (index < body.length && isAsciiDigit(body.charCodeAt(index))) {
            sawWholeDigit = true;
            index += 1;
        }
        if (index < body.length && body[index] === ".") {
            index += 1;
            const fractionStart = index;
            while (index < body.length && isAsciiDigit(body.charCodeAt(index))) {
                index += 1;
            }
            if (!sawWholeDigit && index === fractionStart) {
                throw new Error("invalid duration");
            }
        }
        else if (!sawWholeDigit) {
            throw new Error("invalid duration");
        }
        const amount = body.slice(amountStart, index);
        const unit = readDurationUnit(body, index);
        if (!unit) {
            throw new Error("invalid duration");
        }
        index += unit.length;
        segments.push({ amount, unit });
    }
    if (segments.length === 0) {
        throw new Error("invalid duration");
    }
    return segments;
}
function readDurationUnit(body, index) {
    for (const unit of ["ns", "us", "µs", "ms", "s", "m", "h"]) {
        if (body.startsWith(unit, index)) {
            return unit;
        }
    }
    return "";
}
function decimalDurationToNs(amount, unit) {
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
function formatDurationNs(totalNs) {
    const sign = totalNs < 0n ? "-" : "";
    let remaining = totalNs < 0n ? -totalNs : totalNs;
    const hour = 3600000000000n;
    const minute = 60000000000n;
    const second = 1000000000n;
    const millisecond = 1000000n;
    const microsecond = 1000n;
    if (remaining === 0n)
        return "0s";
    const parts = [];
    if (remaining >= second) {
        const hours = remaining / hour;
        if (hours > 0n) {
            parts.push(`${hours}h`);
            remaining %= hour;
            const minutes = remaining / minute;
            parts.push(`${minutes}m`);
            remaining %= minute;
        }
        else {
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
        return `${sign}${formatDecimalUnit(remaining / millisecond, remaining % millisecond, 6, "ms")}`;
    }
    if (remaining >= microsecond) {
        return `${sign}${formatDecimalUnit(remaining / microsecond, remaining % microsecond, 3, "µs")}`;
    }
    return `${sign}${remaining}ns`;
}
function formatDecimalUnit(whole, fraction, fractionWidth, unit) {
    if (fraction === 0n)
        return `${whole}${unit}`;
    let text = fraction.toString().padStart(fractionWidth, "0");
    text = trimTrailingZeros(text);
    return `${whole}.${text}${unit}`;
}
function trimTrailingZeros(value) {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 48) {
        end -= 1;
    }
    return value.slice(0, end);
}
function isAsciiDigit(code) {
    return code >= 48 && code <= 57;
}
function bindingError(source, name, field, cause) {
    const message = field
        ? `invalid ${source} binding for ${field}`
        : `invalid ${source} binding: ${name}`;
    const details = { source, name };
    if (field)
        details["field"] = field;
    return new AppTheoryError("app.bad_request", message, {
        statusCode: 400,
        details,
        cause,
    });
}
function normalizeValidationError(err) {
    if (err instanceof AppTheoryError) {
        if (err.code === "app.validation_failed" && !err.statusCode) {
            err.statusCode = 422;
        }
        return err;
    }
    if (err instanceof AppError) {
        const options = err.code === "app.validation_failed"
            ? { statusCode: 422, cause: err }
            : { cause: err };
        return new AppTheoryError(err.code, err.message, options);
    }
    return new AppTheoryError("app.validation_failed", "validation failed", {
        statusCode: 422,
        cause: err,
    });
}
function mergeValidation(validation, fields) {
    const merged = {};
    for (const [key, rules] of Object.entries(validation ?? {})) {
        const spec = fields[key];
        const wireName = spec?.name ?? key;
        merged[key] = [...(rules ?? [])].map((rule) => withCanonicalValidationField(rule, wireName));
    }
    for (const [key, spec] of Object.entries(fields)) {
        if (!spec.validate)
            continue;
        const wireName = spec.name ?? key;
        merged[key] = [
            ...(merged[key] ?? []),
            ...spec.validate.map((rule) => withCanonicalValidationField(rule, wireName)),
        ];
    }
    return Object.keys(merged).length > 0
        ? merged
        : undefined;
}
function withCanonicalValidationField(rule, field) {
    return rule.field === undefined ? { ...rule, field } : { ...rule };
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=bind-handler.js.map