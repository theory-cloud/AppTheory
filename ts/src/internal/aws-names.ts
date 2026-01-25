export function sqsQueueNameFromArn(arn: string): string {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const parts = value.split(":");
  return parts.length > 0 ? (parts[parts.length - 1] ?? "") : "";
}

export function kinesisStreamNameFromArn(arn: string): string {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const parts = value.split(":");
  const last = parts.length > 0 ? (parts[parts.length - 1] ?? "") : "";
  if (!last) return "";
  const idx = last.indexOf("/");
  return idx >= 0 ? last.slice(idx + 1).trim() : last.trim();
}

export function snsTopicNameFromArn(arn: string): string {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const parts = value.split(":");
  return parts.length > 0 ? String(parts[parts.length - 1] ?? "").trim() : "";
}

export function eventBridgeRuleNameFromArn(arn: string): string {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const idx = value.indexOf(":rule/");
  let start = -1;
  if (idx >= 0) {
    start = idx + ":rule/".length;
  } else {
    const alt = value.indexOf("rule/");
    if (alt >= 0) {
      start = alt + "rule/".length;
    }
  }
  if (start < 0) return "";
  const after = value.slice(start).replace(/^\/+/, "");
  if (!after) return "";
  const slash = after.indexOf("/");
  return slash >= 0 ? after.slice(0, slash) : after;
}

export function dynamoDBTableNameFromStreamArn(arn: string): string {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const idx = value.indexOf(":table/");
  if (idx < 0) return "";
  const after = value.slice(idx + ":table/".length);
  const streamIdx = after.indexOf("/stream/");
  if (streamIdx >= 0) return after.slice(0, streamIdx);
  const slashIdx = after.indexOf("/");
  return slashIdx >= 0 ? after.slice(0, slashIdx) : after;
}

export function webSocketManagementEndpoint(
  domainName: string,
  stage: string,
  path: string,
): string {
  const dnRaw = String(domainName ?? "").trim();
  if (!dnRaw) return "";

  const host = dnRaw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) return "";

  const isExecuteApi = host.toLowerCase().includes(".execute-api.");
  if (isExecuteApi) {
    const st = String(stage ?? "")
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!st) return "";
    return `https://${host}/${st}`;
  }

  const basePath = String(path ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!basePath) return `https://${host}`;
  return `https://${host}/${basePath}`;
}
