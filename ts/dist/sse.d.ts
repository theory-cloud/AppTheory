import type { Response } from "./types.js";
export interface SSEEvent {
    id?: string;
    event?: string;
    data?: unknown;
}
export declare function sse(status: number, events: SSEEvent[]): Response;
export declare function sseEventStream(events: AsyncIterable<SSEEvent> | Iterable<SSEEvent>): AsyncIterable<Uint8Array>;
