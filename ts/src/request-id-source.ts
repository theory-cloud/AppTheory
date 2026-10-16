export const REQUEST_ID_SOURCE_DEFAULT = "default";
export const REQUEST_ID_SOURCE_SERVER = "server";

export type RequestIdSource =
  typeof REQUEST_ID_SOURCE_DEFAULT | typeof REQUEST_ID_SOURCE_SERVER;

export function normalizeRequestIdSource(source: unknown): RequestIdSource {
  return source === REQUEST_ID_SOURCE_SERVER
    ? REQUEST_ID_SOURCE_SERVER
    : REQUEST_ID_SOURCE_DEFAULT;
}
