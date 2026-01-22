import { randomUUID } from "node:crypto";
export class RandomIdGenerator {
    newId() {
        return randomUUID();
    }
}
export class ManualIdGenerator {
    _prefix;
    _next;
    _queue;
    constructor(options = {}) {
        this._prefix = String(options.prefix ?? "test-id");
        this._next = Number(options.start) || 1;
        this._queue = [];
    }
    queue(...ids) {
        this._queue.push(...ids.map((v) => String(v)));
    }
    reset() {
        this._next = 1;
        this._queue = [];
    }
    newId() {
        if (this._queue.length > 0) {
            return this._queue.shift() ?? "";
        }
        const out = `${this._prefix}-${this._next}`;
        this._next += 1;
        return out;
    }
}
