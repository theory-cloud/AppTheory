import { randomUUID } from "node:crypto";

export interface IdGenerator {
  newId(): string;
}

export type IDGenerator = IdGenerator;

export class RandomIdGenerator implements IdGenerator {
  newId(): string {
    return randomUUID();
  }
}

export class ManualIdGenerator implements IdGenerator {
  private _prefix: string;
  private _next: number;
  private _queue: string[];

  constructor(options: { prefix?: string; start?: number } = {}) {
    this._prefix = String(options.prefix ?? "test-id");
    this._next = Number(options.start) || 1;
    this._queue = [];
  }

  queue(...ids: string[]): void {
    this._queue.push(...ids.map((v) => String(v)));
  }

  reset(): void {
    this._next = 1;
    this._queue = [];
  }

  newId(): string {
    if (this._queue.length > 0) {
      return this._queue.shift() ?? "";
    }
    const out = `${this._prefix}-${this._next}`;
    this._next += 1;
    return out;
  }
}
