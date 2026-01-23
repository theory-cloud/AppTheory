export interface IdGenerator {
    newId(): string;
}
export type IDGenerator = IdGenerator;
export declare class RandomIdGenerator implements IdGenerator {
    newId(): string;
}
export declare class ManualIdGenerator implements IdGenerator {
    private _prefix;
    private _next;
    private _queue;
    constructor(options?: {
        prefix?: string;
        start?: number;
    });
    queue(...ids: string[]): void;
    reset(): void;
    newId(): string;
}
