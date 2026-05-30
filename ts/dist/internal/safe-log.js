import { Buffer } from "node:buffer";
const LOG_SAFE_WHITESPACE_PATTERN = /\s/u;
export function logSafeValue(value) {
    const raw = String(value ?? "");
    if (!raw)
        return raw;
    let out = "";
    for (const char of raw) {
        if (!isUnsafeLogValueChar(char)) {
            out += char;
            continue;
        }
        for (const byte of Buffer.from(char, "utf8")) {
            out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        }
    }
    return out;
}
function isUnsafeLogValueChar(char) {
    const codePoint = char.codePointAt(0) ?? 0;
    return (char === "%" ||
        char === "=" ||
        LOG_SAFE_WHITESPACE_PATTERN.test(char) ||
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f));
}
