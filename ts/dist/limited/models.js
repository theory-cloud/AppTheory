export function setKeys(entry) {
    const pk = `${entry.Identifier}#${entry.WindowStart}`;
    const sk = `${entry.Resource}#${entry.Operation}`;
    entry.PK = pk;
    entry.SK = sk;
}
export function rateLimitTableName() {
    const env = process.env;
    return (String(env["APPTHEORY_RATE_LIMIT_TABLE_NAME"] ?? "").trim() ||
        String(env["RATE_LIMIT_TABLE_NAME"] ?? "").trim() ||
        String(env["RATE_LIMIT_TABLE"] ?? "").trim() ||
        String(env["LIMITED_TABLE_NAME"] ?? "").trim() ||
        "rate-limits");
}
export function unixSeconds(d) {
    return Math.floor(d.valueOf() / 1000);
}
export function formatWindowId(d) {
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
export function formatRfc3339Nano(d) {
    const iso = d.toISOString(); // always includes milliseconds
    const idx = iso.indexOf(".");
    if (idx === -1)
        return `${iso.slice(0, -1)}.000000000Z`;
    const base = iso.slice(0, idx);
    const ms = iso.slice(idx + 1, -1); // "123"
    return `${base}.${ms}000000Z`;
}
export function getMinuteWindow(now) {
    const start = new Date(now.valueOf());
    start.setSeconds(0, 0);
    const end = new Date(start.valueOf() + 60_000);
    return { windowType: "MINUTE", start, end };
}
export function getHourWindow(now) {
    const start = new Date(now.valueOf());
    start.setMinutes(0, 0, 0);
    const end = new Date(start.valueOf() + 3_600_000);
    return { windowType: "HOUR", start, end };
}
export function getDayWindow(now) {
    const start = new Date(now.valueOf());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.valueOf());
    end.setDate(end.getDate() + 1);
    return { windowType: "DAY", start, end };
}
export function getFixedWindow(now, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return { windowType: "CUSTOM_0ms", start: now, end: now };
    }
    const startMs = Math.floor(now.valueOf() / durationMs) * durationMs;
    const start = new Date(startMs);
    const end = new Date(startMs + durationMs);
    return { windowType: `CUSTOM_${String(durationMs)}ms`, start, end };
}
