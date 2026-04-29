import { isIP } from "node:net";

import type { SourceProvenance } from "../types.js";

const PROVIDER_APIGW_V2 = "apigw-v2";
const PROVIDER_LAMBDA_URL = "lambda-url";
const PROVIDER_APIGW_V1 = "apigw-v1";
const PROVIDER_UNKNOWN = "unknown";
const SOURCE_PROVIDER_REQUEST_CONTEXT = "provider_request_context";
const SOURCE_UNKNOWN = "unknown";

export function unknownSourceProvenance(): SourceProvenance {
  return {
    sourceIP: "",
    provider: PROVIDER_UNKNOWN,
    source: SOURCE_UNKNOWN,
    valid: false,
  };
}

export function sourceProvenanceFromProviderRequestContext(
  provider: unknown,
  sourceIP: unknown,
): SourceProvenance {
  const providerValue = String(provider ?? "").trim();
  if (!isKnownProvider(providerValue)) {
    return unknownSourceProvenance();
  }

  const sourceIPValue = String(sourceIP ?? "").trim();
  if (isIP(sourceIPValue) === 0) {
    return unknownSourceProvenance();
  }
  const canonicalSourceIP = canonicalizeIP(sourceIPValue);

  return {
    sourceIP: canonicalSourceIP,
    provider: providerValue,
    source: SOURCE_PROVIDER_REQUEST_CONTEXT,
    valid: true,
  };
}

export function normalizeSourceProvenance(input: unknown): SourceProvenance {
  if (!input || typeof input !== "object") {
    return unknownSourceProvenance();
  }

  const record = input as Record<string, unknown>;
  if (record["valid"] !== true) {
    return unknownSourceProvenance();
  }

  const provider = String(record["provider"] ?? "").trim();
  if (!isKnownProvider(provider)) {
    return unknownSourceProvenance();
  }

  const source = String(record["source"] ?? "").trim();
  if (source !== SOURCE_PROVIDER_REQUEST_CONTEXT) {
    return unknownSourceProvenance();
  }

  const sourceIP = String(record["sourceIP"] ?? "").trim();
  if (isIP(sourceIP) === 0) {
    return unknownSourceProvenance();
  }
  const canonicalSourceIP = canonicalizeIP(sourceIP);

  return {
    sourceIP: canonicalSourceIP,
    provider,
    source,
    valid: true,
  };
}

function isKnownProvider(provider: string): boolean {
  return (
    provider === PROVIDER_APIGW_V2 ||
    provider === PROVIDER_LAMBDA_URL ||
    provider === PROVIDER_APIGW_V1
  );
}

function canonicalizeIP(value: string): string {
  if (isIP(value) === 4) {
    return value;
  }

  const words = parseIPv6Words(value);
  if (!words) {
    return value.toLowerCase();
  }

  if (isIPv4MappedIPv6(words)) {
    const high = words[6];
    const low = words[7];
    if (high === undefined || low === undefined) {
      return value.toLowerCase();
    }
    return `::ffff:${ipv4StringFromWords(high, low)}`;
  }

  const run = longestZeroRun(words);
  if (!run || run.length < 2) {
    return words.map((word) => word.toString(16)).join(":");
  }

  const left = words.slice(0, run.start).map((word) => word.toString(16));
  const right = words
    .slice(run.start + run.length)
    .map((word) => word.toString(16));

  if (left.length === 0 && right.length === 0) {
    return "::";
  }
  if (left.length === 0) {
    return `::${right.join(":")}`;
  }
  if (right.length === 0) {
    return `${left.join(":")}::`;
  }
  return `${left.join(":")}::${right.join(":")}`;
}

function parseIPv6Words(input: string): number[] | undefined {
  let value = input.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) {
      return undefined;
    }
    const ipv4Words = parseIPv4Suffix(value.slice(lastColon + 1));
    if (!ipv4Words) {
      return undefined;
    }
    value = `${value.slice(0, lastColon)}:${ipv4Words[0].toString(16)}:${ipv4Words[1].toString(16)}`;
  }

  const compressedParts = value.split("::");
  if (compressedParts.length > 2) {
    return undefined;
  }

  if (compressedParts.length === 2) {
    const left = parseIPv6Groups(compressedParts[0] ?? "");
    const right = parseIPv6Groups(compressedParts[1] ?? "");
    if (!left || !right) {
      return undefined;
    }
    const missing = 8 - left.length - right.length;
    if (missing < 1) {
      return undefined;
    }
    return [...left, ...Array.from({ length: missing }, () => 0), ...right];
  }

  const words = parseIPv6Groups(value);
  if (!words || words.length !== 8) {
    return undefined;
  }
  return words;
}

function parseIPv6Groups(value: string): number[] | undefined {
  if (value === "") {
    return [];
  }

  const groups = value.split(":");
  if (groups.some((group) => group === "")) {
    return undefined;
  }

  const words: number[] = [];
  for (const group of groups) {
    if (!/^[\da-f]{1,4}$/u.test(group)) {
      return undefined;
    }
    words.push(Number.parseInt(group, 16));
  }
  return words;
}

function parseIPv4Suffix(value: string): [number, number] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return undefined;
    }
    const byte = Number.parseInt(part, 10);
    if (byte > 255) {
      return undefined;
    }
    bytes.push(byte);
  }

  const [first, second, third, fourth] = bytes;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    return undefined;
  }

  return [(first << 8) | second, (third << 8) | fourth];
}

function isIPv4MappedIPv6(words: number[]): boolean {
  return (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  );
}

function ipv4StringFromWords(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function longestZeroRun(
  words: number[],
): { start: number; length: number } | undefined {
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;

  for (const [index, word] of words.entries()) {
    if (word === 0) {
      if (currentStart === -1) {
        currentStart = index;
        currentLength = 0;
      }
      currentLength += 1;
      if (currentLength > bestLength) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
      continue;
    }

    currentStart = -1;
    currentLength = 0;
  }

  if (bestStart === -1) {
    return undefined;
  }
  return { start: bestStart, length: bestLength };
}
