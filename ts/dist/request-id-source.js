export const REQUEST_ID_SOURCE_DEFAULT = "default";
export const REQUEST_ID_SOURCE_SERVER = "server";
export function normalizeRequestIdSource(source) {
    return source === REQUEST_ID_SOURCE_SERVER
        ? REQUEST_ID_SOURCE_SERVER
        : REQUEST_ID_SOURCE_DEFAULT;
}
//# sourceMappingURL=request-id-source.js.map