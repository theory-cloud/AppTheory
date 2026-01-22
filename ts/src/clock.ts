export interface Clock {
  now(): Date;
}

export class RealClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class ManualClock implements Clock {
  private _now: Date;

  constructor(now: Date = new Date(0)) {
    this._now = new Date(now.valueOf());
  }

  now(): Date {
    return new Date(this._now.valueOf());
  }

  set(now: Date): void {
    this._now = new Date(now.valueOf());
  }

  advance(ms: number): Date {
    this._now = new Date(this._now.valueOf() + ms);
    return this.now();
  }
}
