/**
 * Semantic route-construct-id derivation shared by `AppTheoryHttpApi` and the
 * semantic `routeIdMode` of `AppTheoryMcpServer`.
 *
 * The id is a pure function of the route method and pattern, so inserting,
 * removing, or reordering a route never renames an unrelated route. That
 * stability is what lets a task land as an in-place stack update instead of the
 * create-before-delete collision a positional counter produces.
 *
 * Internal to the package: it is not part of the exported jsii surface.
 */
export function semanticRouteToken(value: string): string {
  const parts = String(value).split(/[^A-Za-z0-9]+/).filter((part) => part !== "");
  if (parts.length === 0) {
    return "Root";
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

/** Construct id for a route, derived from its method and pattern. */
export function semanticRouteConstructId(method: string, pattern: string): string {
  return `Route${semanticRouteToken(method)}${semanticRouteToken(pattern)}`;
}
