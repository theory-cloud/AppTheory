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
export declare function semanticRouteToken(value: string): string;
/** Construct id for a route, derived from its method and pattern. */
export declare function semanticRouteConstructId(method: string, pattern: string): string;
