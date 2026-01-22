export class RealClock {
    now() {
        return new Date();
    }
}
export class ManualClock {
    _now;
    constructor(now = new Date(0)) {
        this._now = new Date(now.valueOf());
    }
    now() {
        return new Date(this._now.valueOf());
    }
    set(now) {
        this._now = new Date(now.valueOf());
    }
    advance(ms) {
        this._now = new Date(this._now.valueOf() + ms);
        return this.now();
    }
}
