import { Buffer } from "node:buffer";

import { toBuffer } from "./internal/http.js";

const REDACTED_VALUE = "[REDACTED]";
const EMPTY_MASKED_VALUE = "(empty)";
const MASKED_VALUE = "***masked***";

const allowedSanitizeFields = new Set([
  "card_bin",
  "card_brand",
  "card_type",

  // Common system identifiers that are safe/necessary for debugging and correlation.
  "transaction_id",
  "merchant_uid",

  // External system identifiers (MIDs, acceptor IDs, terminal IDs, etc.).
  "mid",
  "merchant_id",
  "acceptor_id",
  "tid",
  "terminal_id",
]);

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
  // Common PAN aliases used in import/migration datasets.
  ["pan_value", "partial"],
  ["pan", "partial"],
  ["primary_account_number", "partial"],

  ["account_number", "partial"],
  ["ssn", "partial"],
  ["tin", "partial"],
  ["tax_id", "partial"],
  ["ein", "partial"],

  ["password", "fully"],
  ["secret", "fully"],
  ["private_key", "fully"],
  ["secret_key", "fully"],

  ["access_token", "fully"],
  ["refresh_token", "fully"],
  ["id_token", "fully"],
  ["token", "fully"],
  ["client_secret", "fully"],
  ["api_key", "fully"],
  ["api_token", "fully"],
  ["api_key_id", "partial"],
  ["authorization_id", "fully"],
  ["authorization", "fully"],
  ["authorization_header", "fully"],
]);

function canonicalizeSanitizationKey(key: string): string {
  return String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\-\s]+/g, "");
}

function addSanitizationKeyAliases(): void {
  for (const k of Array.from(allowedSanitizeFields)) {
    const alias = canonicalizeSanitizationKey(k);
    if (alias && alias !== k) allowedSanitizeFields.add(alias);
  }

  for (const [k, v] of Array.from(sensitiveSanitizeFields.entries())) {
    const alias = canonicalizeSanitizationKey(k);
    if (alias && alias !== k && !sensitiveSanitizeFields.has(alias))
      sensitiveSanitizeFields.set(alias, v);
  }
}

addSanitizationKeyAliases();

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

function shouldMaskAccountNumberAsBank(
  parentKey: string,
  keyLower: string,
): boolean {
  if (String(keyLower ?? "").includes("_")) return true;
  const parentCanonical = canonicalizeSanitizationKey(parentKey);
  return (
    parentCanonical === "achdetails" ||
    parentCanonical === "bankaccount" ||
    parentCanonical === "bankaccountdetails" ||
    parentCanonical === "bankdetails"
  );
}

function shouldMaskAccountNumberAsCard(parentKey: string): boolean {
  const parentCanonical = canonicalizeSanitizationKey(parentKey);
  return (
    parentCanonical === "cardwithpandetails" ||
    parentCanonical === "cardpandetails" ||
    parentCanonical === "pandetails"
  );
}

function sanitizeValue(value: unknown): unknown {
  return sanitizeValueWithParent("", value);
}

function sanitizeValueWithParent(parentKey: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeLogString(value);
  if (value instanceof Uint8Array)
    return sanitizeLogString(Buffer.from(value).toString("utf8"));
  if (Array.isArray(value))
    return value.map((v) => sanitizeValueWithParent(parentKey, v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeFieldValueWithParent(parentKey, k, v);
    }
    return out;
  }
  return sanitizeLogString(String(value));
}

export function sanitizeFieldValue(key: string, value: unknown): unknown {
  return sanitizeFieldValueWithParent("", key, value);
}

function sanitizeFieldValueWithParent(
  parentKey: string,
  key: string,
  value: unknown,
): unknown {
  const k = String(key ?? "")
    .trim()
    .toLowerCase();
  const canonical = canonicalizeSanitizationKey(k);
  if (!k || !canonical) return sanitizeValueWithParent(parentKey, value);
  if (allowedSanitizeFields.has(k) || allowedSanitizeFields.has(canonical))
    return sanitizeValueWithParent(k, value);

  const explicit =
    sensitiveSanitizeFields.get(k) ?? sensitiveSanitizeFields.get(canonical);
  if (explicit === "fully") return REDACTED_VALUE;
  if (explicit === "partial") {
    if (
      canonical === "cardnumber" ||
      canonical === "number" ||
      canonical === "panvalue" ||
      canonical === "pan" ||
      canonical === "primaryaccountnumber"
    )
      return maskCardNumberString(value);
    if (canonical === "accountnumber") {
      if (shouldMaskAccountNumberAsBank(parentKey, k))
        return maskRestrictedString(value);
      if (shouldMaskAccountNumberAsCard(parentKey))
        return maskCardNumberString(value);
      return maskRestrictedString(value);
    }
    return maskRestrictedString(value);
  }

  if (shouldHeuristicallyRedactKey(key)) return REDACTED_VALUE;

  return sanitizeValueWithParent(k, value);
}

function shouldHeuristicallyRedactKey(key: string): boolean {
  const segments = sanitizationKeySegments(key);
  if (segments.length === 0) return false;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === "token" || segment === "secret" || segment === "password") {
      return true;
    }
    if (
      segment === "key" &&
      i > 0 &&
      (segments[i - 1] === "api" ||
        segments[i - 1] === "private" ||
        segments[i - 1] === "secret")
    ) {
      return true;
    }
  }

  return false;
}

function sanitizationKeySegments(key: string): string[] {
  const value = String(key ?? "").trim();
  if (!value) return [];

  const segments: string[] = [];
  let current = "";
  let previous = "";

  const flush = (): void => {
    if (!current) return;
    segments.push(current);
    current = "";
  };

  for (const char of value) {
    const isAlphaNumeric = /[\p{L}\p{N}]/u.test(char);
    if (!isAlphaNumeric) {
      flush();
      previous = "";
      continue;
    }

    if (
      previous &&
      /[\p{Lu}]/u.test(char) &&
      (/[\p{Ll}]/u.test(previous) || /[\p{N}]/u.test(previous))
    ) {
      flush();
    }

    current += char.toLowerCase();
    previous = char;
  }

  flush();
  return segments;
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

  const sanitized = sanitizeJSONStructure(data, { keepBodyString: true });
  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return "(error marshaling sanitized JSON)";
  }
}

export function sanitizeJSONValue(jsonBytes: Uint8Array | string): unknown {
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

  return sanitizeJSONStructure(data, { keepBodyString: false });
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

type SanitizeJSONOptions = {
  keepBodyString: boolean;
};

function sanitizeJSONStructure(
  value: unknown,
  opts: SanitizeJSONOptions,
): unknown {
  const sanitized = sanitizeValue(value);
  return sanitizeEmbeddedBodyJSON(sanitized, opts);
}

function sanitizeEmbeddedBodyJSON(
  value: unknown,
  opts: SanitizeJSONOptions,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value))
    return value.map((v) => sanitizeEmbeddedBodyJSON(v, opts));
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === "body" && typeof raw === "string") {
      try {
        const parsed: unknown = JSON.parse(raw);
        const sanitizedBody = sanitizeJSONStructure(parsed, opts);
        out[key] = opts.keepBodyString
          ? JSON.stringify(sanitizedBody)
          : sanitizedBody;
        continue;
      } catch {
        // fall through
      }
    }
    out[key] = sanitizeEmbeddedBodyJSON(raw, opts);
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
