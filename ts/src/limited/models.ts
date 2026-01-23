export interface RateLimitEntry {
  PK: string;
  SK: string;

  Identifier: string;
  Resource: string;
  Operation: string;

  WindowStart: number;
  WindowType: string;
  WindowID: string;

  Count: number;
  TTL: number;

  CreatedAt: string;
  UpdatedAt: string;
  Metadata?: Record<string, string>;
}

export function setKeys(
  entry: Pick<
    RateLimitEntry,
    "Identifier" | "WindowStart" | "Resource" | "Operation"
  > & { PK?: string; SK?: string },
): void {
  const pk = `${entry.Identifier}#${entry.WindowStart}`;
  const sk = `${entry.Resource}#${entry.Operation}`;
  (entry as { PK?: string }).PK = pk;
  (entry as { SK?: string }).SK = sk;
}

export function rateLimitTableName(): string {
  const env = process.env;
  return (
    String(env["APPTHEORY_RATE_LIMIT_TABLE_NAME"] ?? "").trim() ||
    String(env["RATE_LIMIT_TABLE_NAME"] ?? "").trim() ||
    String(env["RATE_LIMIT_TABLE"] ?? "").trim() ||
    String(env["LIMITED_TABLE_NAME"] ?? "").trim() ||
    "rate-limits"
  );
}

export type RateLimitWindow = { windowType: string; start: Date; end: Date };

export function unixSeconds(d: Date): number {
  return Math.floor(d.valueOf() / 1000);
}

export function formatWindowId(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatRfc3339Nano(d: Date): string {
  const iso = d.toISOString(); // always includes milliseconds
  const idx = iso.indexOf(".");
  if (idx === -1) return `${iso.slice(0, -1)}.000000000Z`;
  const base = iso.slice(0, idx);
  const ms = iso.slice(idx + 1, -1); // "123"
  return `${base}.${ms}000000Z`;
}

export function getMinuteWindow(now: Date): RateLimitWindow {
  const start = new Date(now.valueOf());
  start.setSeconds(0, 0);
  const end = new Date(start.valueOf() + 60_000);
  return { windowType: "MINUTE", start, end };
}

export function getHourWindow(now: Date): RateLimitWindow {
  const start = new Date(now.valueOf());
  start.setMinutes(0, 0, 0);
  const end = new Date(start.valueOf() + 3_600_000);
  return { windowType: "HOUR", start, end };
}

export function getDayWindow(now: Date): RateLimitWindow {
  const start = new Date(now.valueOf());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.valueOf());
  end.setDate(end.getDate() + 1);
  return { windowType: "DAY", start, end };
}

export function getFixedWindow(now: Date, durationMs: number): RateLimitWindow {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { windowType: "CUSTOM_0ms", start: now, end: now };
  }

  const startMs = Math.floor(now.valueOf() / durationMs) * durationMs;
  const start = new Date(startMs);
  const end = new Date(startMs + durationMs);
  return { windowType: `CUSTOM_${String(durationMs)}ms`, start, end };
}
