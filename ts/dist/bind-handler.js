import { Buffer } from "node:buffer";
import { AppError, AppTheoryError } from "./errors.js";
import { json } from "./response.js";
import { validateOrThrow } from "./validate.js";
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
        if (config.strictJson && bodyFieldNames.size > 0) {
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
            return Number.parseInt(rawText, 10);
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
            const value = Number.parseFloat(String(raw ?? ""));
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
    const pattern = /([+-]?\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
    let match;
    let consumed = "";
    let totalNs = 0;
    while ((match = pattern.exec(trimmed)) !== null) {
        consumed += match[0];
        const amount = Number(match[1]);
        const unit = match[2];
        if (!Number.isFinite(amount) || !unit)
            throw new Error("invalid duration");
        totalNs += amount * durationUnitNs(unit);
    }
    if (!trimmed || consumed !== trimmed)
        throw new Error("invalid duration");
    return formatDuration(totalNs);
}
function durationUnitNs(unit) {
    switch (unit) {
        case "h":
            return 3_600_000_000_000;
        case "m":
            return 60_000_000_000;
        case "s":
            return 1_000_000_000;
        case "ms":
            return 1_000_000;
        case "us":
        case "µs":
            return 1_000;
        case "ns":
            return 1;
        default:
            throw new Error("invalid duration");
    }
}
function formatDuration(totalNs) {
    const sign = totalNs < 0 ? "-" : "";
    let remaining = Math.abs(Math.trunc(totalNs));
    const hour = 3_600_000_000_000;
    const minute = 60_000_000_000;
    const second = 1_000_000_000;
    const parts = [];
    const hours = Math.trunc(remaining / hour);
    if (hours > 0) {
        parts.push(`${hours}h`);
        remaining %= hour;
    }
    const minutes = Math.trunc(remaining / minute);
    if (minutes > 0) {
        parts.push(`${minutes}m`);
        remaining %= minute;
    }
    const seconds = Math.trunc(remaining / second);
    remaining %= second;
    if (seconds > 0 || parts.length > 0) {
        parts.push(`${seconds}s`);
    }
    else if (remaining === 0) {
        parts.push("0s");
    }
    if (remaining > 0) {
        parts.push(`${remaining}ns`);
    }
    return `${sign}${parts.join("")}`;
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
    const merged = {
        ...(validation ?? {}),
    };
    for (const [key, spec] of Object.entries(fields)) {
        if (!spec.validate)
            continue;
        merged[key] = [...(merged[key] ?? []), ...spec.validate];
    }
    return Object.keys(merged).length > 0
        ? merged
        : undefined;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=bind-handler.js.map