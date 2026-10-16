/**
 * API Gateway v2 route-key transition check.
 *
 * This is the reusable helper behind the construct's migration test and behind
 * any consumer that swaps a hand-rolled route inventory for a construct-owned
 * one. It compares ONE before-template and ONE after-template of the SAME stack
 * and fails closed on the one thing API Gateway cannot tolerate: a route key
 * that is held by two logical ids in the same API across a single stack update.
 *
 * The two failure shapes it reports are:
 *
 * 1. a route key that survives the transition but changes the logical id that
 *    holds it, and
 * 2. a route resource created by this transition that takes a route key another
 *    logical id held in the same API before.
 *
 * CloudFormation applies an update as create-then-delete, so either shape lets
 * the new route be created while the old route with the same key still exists,
 * and API Gateway rejects the update with a duplicate route-key error.
 *
 * An API that exists in only one of the two templates is not a transition
 * hazard: deleting the old API and creating the consolidated replacement in the
 * same stack moves every route key to a logically different API, which is the
 * documented new-API swap.
 *
 * Internal to the package: it is not part of the exported jsii surface.
 */

/** Failure shapes reported by {@link checkRouteKeyTransitions}. */
export enum AppTheoryRouteTransitionProblemKind {
  /** A surviving route key is now held by a different logical id in the same API. */
  OWNERSHIP_CHANGED = "ownership-changed",
  /** A route created by this transition took a route key already held in the same API. */
  CREATED_ROUTE_TAKES_EXISTING_KEY = "created-route-takes-existing-key",
}

/** One transition hazard. */
export interface AppTheoryRouteTransitionProblem {
  /** Which failure shape was detected. */
  readonly kind: AppTheoryRouteTransitionProblemKind;
  /** Normalized `AWS::ApiGatewayV2::Route.Properties.ApiId` of the affected API. */
  readonly apiRef: string;
  /** The API Gateway route key that is held twice across the transition. */
  readonly routeKey: string;
  /** Logical id holding the key before the transition, when it existed. */
  readonly beforeLogicalId?: string;
  /** Logical id holding the key after the transition. */
  readonly afterLogicalId?: string;
}

/** Route inventory of one API in one template. */
export interface AppTheoryRouteKeyIndex {
  /** Normalized `ApiId` of the API. */
  readonly apiRef: string;
  /** Route key to the single logical id that holds it. */
  readonly keys: Map<string, string>;
  /** Every logical id that holds a route on this API. */
  readonly logicalIds: string[];
}

interface JsonTemplate {
  readonly Resources?: { [logicalId: string]: unknown };
}

function normalizeApiRef(apiId: unknown): string | undefined {
  if (typeof apiId === "string") {
    return `literal:${apiId}`;
  }
  const ref = (apiId as { Ref?: unknown } | undefined)?.Ref;
  if (typeof ref === "string") {
    return `ref:${ref}`;
  }
  if (apiId === undefined || apiId === null) {
    return undefined;
  }
  return `json:${JSON.stringify(apiId)}`;
}

/**
 * Index every HTTP API v2 route in a CloudFormation template by API and route
 * key.
 *
 * Throws when one API holds the same route key on two logical ids: that
 * template is not deployable at all, let alone as a transition.
 */
export function indexRouteKeys(template: unknown): Map<string, AppTheoryRouteKeyIndex> {
  const resources = ((template as JsonTemplate | undefined)?.Resources ?? {});
  const byApi = new Map<string, { keys: Map<string, string>; logicalIds: string[] }>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    const typed = resource as {
      Type?: string;
      Properties?: { ApiId?: unknown; RouteKey?: unknown };
    };
    if (typed?.Type !== "AWS::ApiGatewayV2::Route") continue;
    const apiRef = normalizeApiRef(typed.Properties?.ApiId);
    if (apiRef === undefined) {
      throw new Error(`route ${logicalId} must reference its API`);
    }
    const routeKey = typed.Properties?.RouteKey;
    if (typeof routeKey !== "string" || routeKey === "") {
      throw new Error(`route ${logicalId} must declare a route key`);
    }
    let entry = byApi.get(apiRef);
    if (entry === undefined) {
      entry = { keys: new Map(), logicalIds: [] };
      byApi.set(apiRef, entry);
    }
    const existing = entry.keys.get(routeKey);
    if (existing !== undefined) {
      throw new Error(
        `route key ${routeKey} must be held by exactly one logical id on API ${apiRef}, found ${existing}, ${logicalId}`,
      );
    }
    entry.keys.set(routeKey, logicalId);
    entry.logicalIds.push(logicalId);
  }
  const index = new Map<string, AppTheoryRouteKeyIndex>();
  for (const [apiRef, entry] of byApi) {
    index.set(apiRef, { apiRef, keys: entry.keys, logicalIds: entry.logicalIds });
  }
  return index;
}

/**
 * Compare a before-template and an after-template of the same stack and return
 * every route key that would be held by two logical ids in the same API across
 * the transition. An empty array means the transition is safe.
 */
export function checkRouteKeyTransitions(
  before: unknown,
  after: unknown,
): AppTheoryRouteTransitionProblem[] {
  const beforeIndex = indexRouteKeys(before);
  const afterIndex = indexRouteKeys(after);
  const problems: AppTheoryRouteTransitionProblem[] = [];
  for (const [apiRef, beforeApi] of beforeIndex) {
    const afterApi = afterIndex.get(apiRef);
    if (afterApi === undefined) continue;
    const beforeIds = new Set(beforeApi.logicalIds);
    for (const [routeKey, beforeLogicalId] of beforeApi.keys) {
      const afterLogicalId = afterApi.keys.get(routeKey);
      if (afterLogicalId === undefined || afterLogicalId === beforeLogicalId) continue;
      problems.push({
        kind: AppTheoryRouteTransitionProblemKind.OWNERSHIP_CHANGED,
        apiRef,
        routeKey,
        beforeLogicalId,
        afterLogicalId,
      });
      if (!beforeIds.has(afterLogicalId)) {
        problems.push({
          kind: AppTheoryRouteTransitionProblemKind.CREATED_ROUTE_TAKES_EXISTING_KEY,
          apiRef,
          routeKey,
          beforeLogicalId,
          afterLogicalId,
        });
      }
    }
  }
  return problems;
}

/** Render transition problems as one human-readable line per hazard. */
export function describeRouteTransitionProblems(
  problems: AppTheoryRouteTransitionProblem[],
): string[] {
  return problems.map((problem) => {
    const kind = problem.kind === AppTheoryRouteTransitionProblemKind.OWNERSHIP_CHANGED
      ? "route key changes logical id"
      : "created route takes an existing route key";
    return `${kind}: ${problem.routeKey} on ${problem.apiRef} moved from ${problem.beforeLogicalId} to ${problem.afterLogicalId}`;
  });
}
