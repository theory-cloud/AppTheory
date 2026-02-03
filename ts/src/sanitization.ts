import { Buffer } from "node:buffer";

import { toBuffer } from "./internal/http.js";

const REDACTED_VALUE = "[REDACTED]";
const EMPTY_MASKED_VALUE = "(empty)";
const MASKED_VALUE = "***masked***";

const allowedSanitizeFields = new Set(["card_bin", "card_brand", "card_type"]);

const sensitiveSanitizeFields = new Map<string, "fully" | "partial">([
  ["cvv", "fully"],
  ["security_code", "fully"],
  ["cvv2", "fully"],
  ["cvc", "fully"],
  ["cvc2", "fully"],

  ["cardholder", "fully"],
  ["cardholder_name", "fully"],

  ["card_number", "partial"],
  ["number", "partial"],

  ["account_number", "partial"],
  ["ssn", "partial"],
  ["tin", "partial"],
  ["tax_id", "partial"],
  ["ein", "partial"],

  ["password", "fully"],
  ["secret", "fully"],
  ["private_key", "fully"],
  ["secret_key", "fully"],

  ["api_token", "fully"],
  ["api_key_id", "partial"],
  ["authorization", "fully"],
  ["authorization_id", "fully"],
  ["authorization_header", "fully"],
]);

export function sanitizeLogString(value: string): string {
  const v = String(value ?? "");
  if (!v) return v;
  return v.replace(/\r/g, "").replace(/\n/g, "");
}

function stripNonDigits(value: unknown): string {
  return String(value ?? "").replace(/[^\d]+/g, "");
}

function maskRestrictedString(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return REDACTED_VALUE;

  const digits = stripNonDigits(raw);
  if (digits.length >= 4) {
    if (digits.length === 4) return "****";
    return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
  }

  if (raw.length >= 4) return `...${raw.slice(-4)}`;
  return REDACTED_VALUE;
}

export function maskFirstLast(
  value: string,
  prefixLen: number,
  suffixLen: number,
): string {
  const raw = String(value ?? "");
  if (!raw) return EMPTY_MASKED_VALUE;

  const prefix = Number.isFinite(prefixLen) ? Math.trunc(prefixLen) : -1;
  const suffix = Number.isFinite(suffixLen) ? Math.trunc(suffixLen) : -1;
  if (prefix < 0 || suffix < 0) return MASKED_VALUE;
  if (raw.length <= prefix + suffix) return MASKED_VALUE;
  return `${raw.slice(0, prefix)}***${raw.slice(raw.length - suffix)}`;
}

export function maskFirstLast4(value: string): string {
  return maskFirstLast(value, 4, 4);
}

function maskCardNumberString(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return REDACTED_VALUE;

  const digits = stripNonDigits(raw);
  if (digits.length < 4) return REDACTED_VALUE;
  if (digits.length > 10) {
    return `${digits.slice(0, 6)}${"*".repeat(digits.length - 10)}${digits.slice(-4)}`;
  }
  if (digits.length > 4) {
    return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
  }
  return "****";
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeLogString(value);
  if (value instanceof Uint8Array)
    return sanitizeLogString(Buffer.from(value).toString("utf8"));
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeFieldValue(k, v);
    }
    return out;
  }
  return sanitizeLogString(String(value));
}

export function sanitizeFieldValue(key: string, value: unknown): unknown {
  const k = String(key ?? "")
    .trim()
    .toLowerCase();
  if (!k) return sanitizeValue(value);
  if (allowedSanitizeFields.has(k)) return sanitizeValue(value);

  const explicit = sensitiveSanitizeFields.get(k);
  if (explicit === "fully") return REDACTED_VALUE;
  if (explicit === "partial") {
    if (k === "card_number" || k === "number")
      return maskCardNumberString(value);
    return maskRestrictedString(value);
  }

  const blockedSubstrings = [
    "secret",
    "token",
    "password",
    "private_key",
    "client_secret",
    "api_key",
    "authorization",
  ];
  for (const s of blockedSubstrings) {
    if (k.includes(s)) return REDACTED_VALUE;
  }

  return sanitizeValue(value);
}

export function sanitizeJSON(jsonBytes: Uint8Array | string): string {
  const buf =
    typeof jsonBytes === "string"
      ? Buffer.from(jsonBytes, "utf8")
      : toBuffer(jsonBytes);
  if (!buf || buf.length === 0) return "(empty)";

  let data: unknown;
  try {
    data = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    const msg =
      err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message)
        : String(err);
    return `(malformed JSON: ${msg})`;
  }

  const sanitized = sanitizeJSONValue(data);
  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return "(error marshaling sanitized JSON)";
  }
}

function sanitizeJSONValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => sanitizeJSONValue(v));
  if (typeof value !== "object") return sanitizeValue(value);

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === "body" && typeof raw === "string") {
      try {
        const parsed: unknown = JSON.parse(raw);
        out[key] = JSON.stringify(sanitizeJSONValue(parsed));
        continue;
      } catch {
        // fall through
      }
    }
    out[key] = sanitizeFieldValue(key, raw);
  }
  return out;
}

export interface XMLSanitizationPattern {
  name: string;
  pattern: RegExp;
  maskingFunc: (match: string) => string;
}

export function sanitizeXML(
  xmlString: string,
  patterns: XMLSanitizationPattern[],
): string {
  let out = String(xmlString ?? "");
  const list = Array.isArray(patterns) ? patterns : [];
  for (const p of list) {
    if (
      !p ||
      !(p.pattern instanceof RegExp) ||
      typeof p.maskingFunc !== "function"
    )
      continue;
    out = out.replace(p.pattern, (match) => p.maskingFunc(match));
  }
  return out;
}

function maskCardNumberXML(match: string): string {
  const m = String(match ?? "");
  const isEscaped = m.includes("&gt;");

  let start: number;
  let end: number;
  if (isEscaped) {
    start = m.indexOf("&gt;") + 4;
    end = m.lastIndexOf("&lt;");
  } else {
    start = m.indexOf(">") + 1;
    end = m.lastIndexOf("<");
  }

  if (end > start) {
    const number = m.slice(start, end);
    const masked = maskCardNumberString(number);
    return m.slice(0, start) + masked + m.slice(end);
  }
  return m;
}

function maskCompletelyXML(replacement: string): (match: string) => string {
  const rep = String(replacement ?? "");
  return (match) => {
    const m = String(match ?? "");
    const isEscaped = m.includes("&gt;");

    let start: number;
    let end: number;
    if (isEscaped) {
      start = m.indexOf("&gt;") + 4;
      end = m.lastIndexOf("&lt;");
    } else {
      start = m.indexOf(">") + 1;
      end = m.lastIndexOf("<");
    }

    if (end >= start) {
      return m.slice(0, start) + rep + m.slice(end);
    }
    return m;
  };
}

function maskTokenLastFourXML(match: string): string {
  const m = String(match ?? "");
  const isEscaped = m.includes("&gt;");

  if (m.includes("><") || m.includes("&gt;&lt;")) return m;

  let start: number;
  let end: number;
  if (isEscaped) {
    start = m.indexOf("&gt;") + 4;
    end = m.lastIndexOf("&lt;");
  } else {
    start = m.indexOf(">") + 1;
    end = m.lastIndexOf("<");
  }

  if (end > start) {
    const token = m.slice(start, end);
    const trimmed = String(token ?? "");
    if (trimmed.length > 4) {
      const masked = `${"*".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
      return m.slice(0, start) + masked + m.slice(end);
    }
  }
  return m;
}

export const paymentXMLPatterns: XMLSanitizationPattern[] = [
  {
    name: "AcctNum",
    pattern:
      /(<AcctNum>[^<]*<\/AcctNum>|&lt;AcctNum&gt;[^&]*&lt;\/AcctNum&gt;)/gi,
    maskingFunc: maskCardNumberXML,
  },
  {
    name: "CardNum",
    pattern:
      /(<CardNum>[^<]*<\/CardNum>|&lt;CardNum&gt;[^&]*&lt;\/CardNum&gt;)/gi,
    maskingFunc: maskCardNumberXML,
  },
  {
    name: "CardNumber",
    pattern:
      /(<CardNumber>[^<]*<\/CardNumber>|&lt;CardNumber&gt;[^&]*&lt;\/CardNumber&gt;)/gi,
    maskingFunc: maskCardNumberXML,
  },
  {
    name: "TrackData",
    pattern:
      /(<TrackData>[^<]*<\/TrackData>|&lt;TrackData&gt;[^&]*&lt;\/TrackData&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "CVV",
    pattern: /(<CVV>[^<]*<\/CVV>|&lt;CVV&gt;[^&]*&lt;\/CVV&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "CVV2",
    pattern: /(<CVV2>[^<]*<\/CVV2>|&lt;CVV2&gt;[^&]*&lt;\/CVV2&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "CVC",
    pattern: /(<CVC>[^<]*<\/CVC>|&lt;CVC&gt;[^&]*&lt;\/CVC&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "ExpDate",
    pattern:
      /(<ExpDate>[^<]*<\/ExpDate>|&lt;ExpDate&gt;[^&]*&lt;\/ExpDate&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "ExpiryDate",
    pattern:
      /(<ExpiryDate>[^<]*<\/ExpiryDate>|&lt;ExpiryDate&gt;[^&]*&lt;\/ExpiryDate&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "Password",
    pattern:
      /(<Password>[^<]*<\/Password>|&lt;Password&gt;[^&]*&lt;\/Password&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "TransArmorToken",
    pattern:
      /(<TransArmorToken>[^<]*<\/TransArmorToken>|&lt;TransArmorToken&gt;[^&]*&lt;\/TransArmorToken&gt;)/gi,
    maskingFunc: maskTokenLastFourXML,
  },
];

export const rapidConnectXMLPatterns = paymentXMLPatterns;
