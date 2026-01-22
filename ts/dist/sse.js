import { Buffer } from "node:buffer";
import { normalizeResponse } from "./internal/response.js";
function formatSSEEvent(event) {
    const id = String(event.id ?? "").trim();
    const name = String(event.event ?? "").trim();
    let data;
    const value = event.data;
    if (value === null || value === undefined) {
        data = "";
    }
    else if (typeof value === "string") {
        data = value;
    }
    else if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        data = Buffer.from(value).toString("utf8");
    }
    else {
        data = JSON.stringify(value);
    }
    data = String(data).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = String(data).split("\n");
    if (lines.length === 0)
        lines.push("");
    let out = "";
    if (id)
        out += `id: ${id}\n`;
    if (name)
        out += `event: ${name}\n`;
    for (const line of lines) {
        out += `data: ${line}\n`;
    }
    out += "\n";
    return out;
}
export function sse(status, events) {
    const list = Array.isArray(events) ? events : [];
    const framed = list.map(formatSSEEvent).join("");
    return normalizeResponse({
        status,
        headers: {
            "content-type": ["text/event-stream"],
            "cache-control": ["no-cache"],
            connection: ["keep-alive"],
        },
        cookies: [],
        body: Buffer.from(framed, "utf8"),
        isBase64: false,
    });
}
export async function* sseEventStream(events) {
    for await (const ev of events ?? []) {
        yield Buffer.from(formatSSEEvent(ev), "utf8");
    }
}
