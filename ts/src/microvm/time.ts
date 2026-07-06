import { randomBytes } from "node:crypto";

export function cloneMicroVMDateFromUnknown(value: unknown): Date {
  if (value instanceof Date) {
    return cloneMicroVMDate(value);
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (validDate(parsed)) return parsed;
  }
  return new Date(Number.NaN);
}

export function coalesceMicroVMTime(value: Date, fallback: Date): Date {
  if (validDate(value)) return new Date(value.valueOf());
  if (validDate(fallback)) return new Date(fallback.valueOf());
  return new Date(0);
}

export function cloneMicroVMDate(value: Date): Date {
  return validDate(value) ? new Date(value.valueOf()) : new Date(Number.NaN);
}

export function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

export function randomMicroVMSessionID(): string {
  try {
    return `microvm-${randomBytes(16).toString("hex")}`;
  } catch {
    return `microvm-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
  }
}
