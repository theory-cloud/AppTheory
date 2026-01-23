import { getFixedWindow, formatWindowId } from "./models.js";
export class FixedWindowStrategy {
    windowSizeMs;
    maxRequests;
    identifierLimits;
    resourceLimits;
    constructor(windowSizeMs, maxRequests) {
        this.windowSizeMs = Math.floor(Number(windowSizeMs));
        this.maxRequests = Math.floor(Number(maxRequests));
        this.identifierLimits = {};
        this.resourceLimits = {};
    }
    calculateWindows(now) {
        const size = Math.floor(this.windowSizeMs);
        if (!Number.isFinite(size) || size <= 0) {
            return [];
        }
        const startMs = Math.floor(now.valueOf() / size) * size;
        const start = new Date(startMs);
        const end = new Date(startMs + size);
        return [{ start, end, key: formatWindowId(start) }];
    }
    getLimit(key) {
        const id = String(key.identifier ?? "");
        if (id && id in this.identifierLimits)
            return this.identifierLimits[id] ?? 0;
        const res = String(key.resource ?? "");
        if (res && res in this.resourceLimits)
            return this.resourceLimits[res] ?? 0;
        return this.maxRequests;
    }
    shouldAllow(counts, limit) {
        let total = 0;
        for (const v of Object.values(counts)) {
            total += Number(v) || 0;
        }
        return total < Number(limit);
    }
    setIdentifierLimit(identifier, limit) {
        this.identifierLimits[String(identifier)] = Math.floor(Number(limit));
    }
    setResourceLimit(resource, limit) {
        this.resourceLimits[String(resource)] = Math.floor(Number(limit));
    }
}
export class SlidingWindowStrategy {
    windowSizeMs;
    maxRequests;
    granularityMs;
    identifierLimits;
    resourceLimits;
    constructor(windowSizeMs, maxRequests, granularityMs) {
        this.windowSizeMs = Math.floor(Number(windowSizeMs));
        this.maxRequests = Math.floor(Number(maxRequests));
        this.granularityMs = Math.floor(Number(granularityMs));
        this.identifierLimits = {};
        this.resourceLimits = {};
    }
    calculateWindows(now) {
        const windowMs = Math.floor(this.windowSizeMs);
        if (!Number.isFinite(windowMs) || windowMs <= 0)
            return [];
        let granularity = Math.floor(this.granularityMs);
        if (!Number.isFinite(granularity) || granularity <= 0)
            granularity = 60_000;
        let subWindows = Math.floor(windowMs / granularity);
        if (subWindows < 1)
            subWindows = 1;
        const nowMs = now.valueOf();
        const currentStartMs = Math.floor(nowMs / granularity) * granularity;
        const windows = [];
        for (let i = 0; i < subWindows; i += 1) {
            const startMs = currentStartMs - i * granularity;
            if (nowMs - startMs > windowMs)
                continue;
            const start = new Date(startMs);
            const end = new Date(startMs + granularity);
            windows.push({ start, end, key: formatWindowId(start) });
        }
        return windows;
    }
    getLimit(key) {
        const id = String(key.identifier ?? "");
        if (id && id in this.identifierLimits)
            return this.identifierLimits[id] ?? 0;
        const res = String(key.resource ?? "");
        if (res && res in this.resourceLimits)
            return this.resourceLimits[res] ?? 0;
        return this.maxRequests;
    }
    shouldAllow(counts, limit) {
        let total = 0;
        for (const v of Object.values(counts)) {
            total += Number(v) || 0;
        }
        return total < Number(limit);
    }
    setIdentifierLimit(identifier, limit) {
        this.identifierLimits[String(identifier)] = Math.floor(Number(limit));
    }
    setResourceLimit(resource, limit) {
        this.resourceLimits[String(resource)] = Math.floor(Number(limit));
    }
}
export class MultiWindowStrategy {
    windows;
    identifierLimits;
    resourceLimits;
    constructor(windows) {
        this.windows = Array.isArray(windows) ? windows.map((w) => ({ ...w })) : [];
        this.identifierLimits = {};
        this.resourceLimits = {};
    }
    calculateWindows(now) {
        if (this.windows.length === 0)
            return [];
        const out = [];
        for (const cfg of this.windows) {
            const durationMs = Math.floor(Number(cfg.durationMs));
            if (!Number.isFinite(durationMs) || durationMs <= 0)
                continue;
            const window = getFixedWindow(now, durationMs);
            out.push({
                start: window.start,
                end: window.end,
                key: `${formatWindowId(window.start)}_${durationMs}ms`,
            });
        }
        return out;
    }
    getLimit(key) {
        const limits = this._limitsForKey(key);
        if (limits.length === 0)
            return 0;
        return Math.floor(Number(limits[0]?.maxRequests ?? 0));
    }
    shouldAllow(counts, _limit) {
        if (this.windows.length === 0)
            return false;
        for (const cfg of this.windows) {
            const durationMs = Math.floor(Number(cfg.durationMs));
            if (!Number.isFinite(durationMs) || durationMs <= 0)
                continue;
            const suffix = `_${durationMs}ms`;
            let count = 0;
            for (const [key, observed] of Object.entries(counts)) {
                if (String(key).endsWith(suffix)) {
                    count = Math.floor(Number(observed) || 0);
                    break;
                }
            }
            const maxAllowed = Math.floor(Number(cfg.maxRequests) || 0);
            if (count >= maxAllowed)
                return false;
        }
        return true;
    }
    _limitsForKey(key) {
        const id = String(key.identifier ?? "");
        if (id && id in this.identifierLimits) {
            const v = this.identifierLimits[id];
            if (Array.isArray(v) && v.length > 0)
                return v;
        }
        const res = String(key.resource ?? "");
        if (res && res in this.resourceLimits) {
            const v = this.resourceLimits[res];
            if (Array.isArray(v) && v.length > 0)
                return v;
        }
        return this.windows;
    }
}
