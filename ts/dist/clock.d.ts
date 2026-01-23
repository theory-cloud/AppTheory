export interface Clock {
    now(): Date;
}
export declare class RealClock implements Clock {
    now(): Date;
}
export declare class ManualClock implements Clock {
    private _now;
    constructor(now?: Date);
    now(): Date;
    set(now: Date): void;
    advance(ms: number): Date;
}
