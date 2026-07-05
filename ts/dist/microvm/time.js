import { randomBytes } from "node:crypto";
export function cloneMicroVMDateFromUnknown(value) {
    if (value instanceof Date) {
        return cloneMicroVMDate(value);
    }
    if (typeof value === "string" || typeof value === "number") {
        const parsed = new Date(value);
        if (validDate(parsed))
            return parsed;
    }
    return new Date(Number.NaN);
}
export function coalesceMicroVMTime(value, fallback) {
    if (validDate(value))
        return new Date(value.valueOf());
    if (validDate(fallback))
        return new Date(fallback.valueOf());
    return new Date(0);
}
export function cloneMicroVMDate(value) {
    return validDate(value) ? new Date(value.valueOf()) : new Date(Number.NaN);
}
export function validDate(value) {
    return value instanceof Date && Number.isFinite(value.valueOf());
}
export function randomMicroVMSessionID() {
    try {
        return `microvm-${randomBytes(16).toString("hex")}`;
    }
    catch {
        return `microvm-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
    }
}
//# sourceMappingURL=time.js.map