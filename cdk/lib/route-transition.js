"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryRouteTransitionProblemKind = void 0;
exports.indexRouteKeys = indexRouteKeys;
exports.checkRouteKeyTransitions = checkRouteKeyTransitions;
exports.describeRouteTransitionProblems = describeRouteTransitionProblems;
/** Failure shapes reported by {@link checkRouteKeyTransitions}. */
var AppTheoryRouteTransitionProblemKind;
(function (AppTheoryRouteTransitionProblemKind) {
    /** A surviving route key is now held by a different logical id in the same API. */
    AppTheoryRouteTransitionProblemKind["OWNERSHIP_CHANGED"] = "ownership-changed";
    /** A route created by this transition took a route key already held in the same API. */
    AppTheoryRouteTransitionProblemKind["CREATED_ROUTE_TAKES_EXISTING_KEY"] = "created-route-takes-existing-key";
})(AppTheoryRouteTransitionProblemKind || (exports.AppTheoryRouteTransitionProblemKind = AppTheoryRouteTransitionProblemKind = {}));
function normalizeApiRef(apiId) {
    if (typeof apiId === "string") {
        return `literal:${apiId}`;
    }
    const ref = apiId?.Ref;
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
function indexRouteKeys(template) {
    const resources = (template?.Resources ?? {});
    const byApi = new Map();
    for (const [logicalId, resource] of Object.entries(resources)) {
        const typed = resource;
        if (typed?.Type !== "AWS::ApiGatewayV2::Route")
            continue;
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
            throw new Error(`route key ${routeKey} must be held by exactly one logical id on API ${apiRef}, found ${existing}, ${logicalId}`);
        }
        entry.keys.set(routeKey, logicalId);
        entry.logicalIds.push(logicalId);
    }
    const index = new Map();
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
function checkRouteKeyTransitions(before, after) {
    const beforeIndex = indexRouteKeys(before);
    const afterIndex = indexRouteKeys(after);
    const problems = [];
    for (const [apiRef, beforeApi] of beforeIndex) {
        const afterApi = afterIndex.get(apiRef);
        if (afterApi === undefined)
            continue;
        const beforeIds = new Set(beforeApi.logicalIds);
        for (const [routeKey, beforeLogicalId] of beforeApi.keys) {
            const afterLogicalId = afterApi.keys.get(routeKey);
            if (afterLogicalId === undefined || afterLogicalId === beforeLogicalId)
                continue;
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
function describeRouteTransitionProblems(problems) {
    return problems.map((problem) => {
        const kind = problem.kind === AppTheoryRouteTransitionProblemKind.OWNERSHIP_CHANGED
            ? "route key changes logical id"
            : "created route takes an existing route key";
        return `${kind}: ${problem.routeKey} on ${problem.apiRef} moved from ${problem.beforeLogicalId} to ${problem.afterLogicalId}`;
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGUtdHJhbnNpdGlvbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJvdXRlLXRyYW5zaXRpb24udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTBCRzs7O0FBMkRILHdDQW9DQztBQU9ELDREQWlDQztBQUdELDBFQVNDO0FBakpELG1FQUFtRTtBQUNuRSxJQUFZLG1DQUtYO0FBTEQsV0FBWSxtQ0FBbUM7SUFDN0MsbUZBQW1GO0lBQ25GLDhFQUF1QyxDQUFBO0lBQ3ZDLHdGQUF3RjtJQUN4Riw0R0FBcUUsQ0FBQTtBQUN2RSxDQUFDLEVBTFcsbUNBQW1DLG1EQUFuQyxtQ0FBbUMsUUFLOUM7QUE4QkQsU0FBUyxlQUFlLENBQUMsS0FBYztJQUNyQyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzlCLE9BQU8sV0FBVyxLQUFLLEVBQUUsQ0FBQztJQUM1QixDQUFDO0lBQ0QsTUFBTSxHQUFHLEdBQUksS0FBdUMsRUFBRSxHQUFHLENBQUM7SUFDMUQsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUM1QixPQUFPLE9BQU8sR0FBRyxFQUFFLENBQUM7SUFDdEIsQ0FBQztJQUNELElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDMUMsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUNELE9BQU8sUUFBUSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7QUFDekMsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQWdCLGNBQWMsQ0FBQyxRQUFpQjtJQUM5QyxNQUFNLFNBQVMsR0FBRyxDQUFFLFFBQXFDLEVBQUUsU0FBUyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQzVFLE1BQU0sS0FBSyxHQUFHLElBQUksR0FBRyxFQUErRCxDQUFDO0lBQ3JGLEtBQUssTUFBTSxDQUFDLFNBQVMs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UUFBUSxDQUFDLENBQUM7WUFDbkQsSUFBSSxjQUFjLEtBQUssU0FBUyxJQUFJLGNBQWMsS0FBSyxlQUFlO2dCQUFFLFNBQVM7WUFDakYsUUFBUSxDQUFDLElBQUksQ0FBQztnQkFDWixJQUFJLEVBQUUsbUNBQW1DLENBQUMsaUJBQWlCO2dCQUMzRCxNQUFNO2dCQUNOLFFBQVE7Z0JBQ1IsZUFBZTtnQkFDZixjQUFjO2FBQ2YsQ0FBQyxDQUFDO1lBQ0gsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFDLEVBQUUsQ0FBQztnQkFDbkMsUUFBUSxDQUFDLElBQUksQ0FBQztvQkFDWixJQUFJLEVBQUUsbUNBQW1DLENBQUMsZ0NBQWdDO29CQUMxRSxNQUFNO29CQUNOLFFBQVE7b0JBQ1IsZUFBZTtvQkFDZixjQUFjO2lCQUNmLENBQUMsQ0FBQztZQUNMLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sUUFBUSxDQUFDO0FBQ2xCLENBQUM7QUFFRCx3RUFBd0U7QUFDeEUsU0FBZ0IsK0JBQStCLENBQzdDLFFBQTJDO0lBRTNDLE9BQU8sUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFO1FBQzlCLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxJQUFJLEtBQUssbUNBQW1DLENBQUMsaUJBQWlCO1lBQ2pGLENBQUMsQ0FBQyw4QkFBOEI7WUFDaEMsQ0FBQyxDQUFDLDJDQUEyQyxDQUFDO1FBQ2hELE9BQU8sR0FBRyxJQUFJLEtBQUssT0FBTyxDQUFDLFFBQVEsT0FBTyxPQUFPLENBQUMsTUFBTSxlQUFlLE9BQU8sQ0FBQyxlQUFlLE9BQU8sT0FBTyxDQUFDLGNBQWMsRUFBRSxDQUFDO0lBQ2hJLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQVBJIEdhdGV3YXkgdjIgcm91dGUta2V5IHRyYW5zaXRpb24gY2hlY2suXG4gKlxuICogVGhpcyBpcyB0aGUgcmV1c2FibGUgaGVscGVyIGJlaGluZCB0aGUgY29uc3RydWN0J3MgbWlncmF0aW9uIHRlc3QgYW5kIGJlaGluZFxuICogYW55IGNvbnN1bWVyIHRoYXQgc3dhcHMgYSBoYW5kLXJvbGxlZCByb3V0ZSBpbnZlbnRvcnkgZm9yIGEgY29uc3RydWN0LW93bmVkXG4gKiBvbmUuIEl0IGNvbXBhcmVzIE9ORSBiZWZvcmUtdGVtcGxhdGUgYW5kIE9ORSBhZnRlci10ZW1wbGF0ZSBvZiB0aGUgU0FNRSBzdGFja1xuICogYW5kIGZhaWxzIGNsb3NlZCBvbiB0aGUgb25lIHRoaW5nIEFQSSBHYXRld2F5IGNhbm5vdCB0b2xlcmF0ZTogYSByb3V0ZSBrZXlcbiAqIHRoYXQgaXMgaGVsZCBieSB0d28gbG9naWNhbCBpZHMgaW4gdGhlIHNhbWUgQVBJIGFjcm9zcyBhIHNpbmdsZSBzdGFjayB1cGRhdGUuXG4gKlxuICogVGhlIHR3byBmYWlsdXJlIHNoYXBlcyBpdCByZXBvcnRzIGFyZTpcbiAqXG4gKiAxLiBhIHJvdXRlIGtleSB0aGF0IHN1cnZpdmVzIHRoZSB0cmFuc2l0aW9uIGJ1dCBjaGFuZ2VzIHRoZSBsb2dpY2FsIGlkIHRoYXRcbiAqICAgIGhvbGRzIGl0LCBhbmRcbiAqIDIuIGEgcm91dGUgcmVzb3VyY2UgY3JlYXRlZCBieSB0aGlzIHRyYW5zaXRpb24gdGhhdCB0YWtlcyBhIHJvdXRlIGtleSBhbm90aGVyXG4gKiAgICBsb2dpY2FsIGlkIGhlbGQgaW4gdGhlIHNhbWUgQVBJIGJlZm9yZS5cbiAqXG4gKiBDbG91ZEZvcm1hdGlvbiBhcHBsaWVzIGFuIHVwZGF0ZSBhcyBjcmVhdGUtdGhlbi1kZWxldGUsIHNvIGVpdGhlciBzaGFwZSBsZXRzXG4gKiB0aGUgbmV3IHJvdXRlIGJlIGNyZWF0ZWQgd2hpbGUgdGhlIG9sZCByb3V0ZSB3aXRoIHRoZSBzYW1lIGtleSBzdGlsbCBleGlzdHMsXG4gKiBhbmQgQVBJIEdhdGV3YXkgcmVqZWN0cyB0aGUgdXBkYXRlIHdpdGggYSBkdXBsaWNhdGUgcm91dGUta2V5IGVycm9yLlxuICpcbiAqIEFuIEFQSSB0aGF0IGV4aXN0cyBpbiBvbmx5IG9uZSBvZiB0aGUgdHdvIHRlbXBsYXRlcyBpcyBub3QgYSB0cmFuc2l0aW9uXG4gKiBoYXphcmQ6IGRlbGV0aW5nIHRoZSBvbGQgQVBJIGFuZCBjcmVhdGluZyB0aGUgY29uc29saWRhdGVkIHJlcGxhY2VtZW50IGluIHRoZVxuICogc2FtZSBzdGFjayBtb3ZlcyBldmVyeSByb3V0ZSBrZXkgdG8gYSBsb2dpY2FsbHkgZGlmZmVyZW50IEFQSSwgd2hpY2ggaXMgdGhlXG4gKiBkb2N1bWVudGVkIG5ldy1BUEkgc3dhcC5cbiAqXG4gKiBJbnRlcm5hbCB0byB0aGUgcGFja2FnZTogaXQgaXMgbm90IHBhcnQgb2YgdGhlIGV4cG9ydGVkIGpzaWkgc3VyZmFjZS5cbiAqL1xuXG4vKiogRmFpbHVyZSBzaGFwZXMgcmVwb3J0ZWQgYnkge0BsaW5rIGNoZWNrUm91dGVLZXlUcmFuc2l0aW9uc30uICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlSb3V0ZVRyYW5zaXRpb25Qcm9ibGVtS2luZCB7XG4gIC8qKiBBIHN1cnZpdmluZyByb3V0ZSBrZXkgaXMgbm93IGhlbGQgYnkgYSBkaWZmZXJlbnQgbG9naWNhbCBpZCBpbiB0aGUgc2FtZSBBUEkuICovXG4gIE9XTkVSU0hJUF9DSEFOR0VEID0gXCJvd25lcnNoaXAtY2hhbmdlZFwiLFxuICAvKiogQSByb3V0ZSBjcmVhdGVkIGJ5IHRoaXMgdHJhbnNpdGlvbiB0b29rIGEgcm91dGUga2V5IGFscmVhZHkgaGVsZCBpbiB0aGUgc2FtZSBBUEkuICovXG4gIENSRUFURURfUk9VVEVfVEFLRVNfRVhJU1RJTkdfS0VZID0gXCJjcmVhdGVkLXJvdXRlLXRha2VzLWV4aXN0aW5nLWtleVwiLFxufVxuXG4vKiogT25lIHRyYW5zaXRpb24gaGF6YXJkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSb3V0ZVRyYW5zaXRpb25Qcm9ibGVtIHtcbiAgLyoqIFdoaWNoIGZhaWx1cmUgc2hhcGUgd2FzIGRldGVjdGVkLiAqL1xuICByZWFkb25seSBraW5kOiBBcHBUaGVvcnlSb3V0ZVRyYW5zaXRpb25Qcm9ibGVtS2luZDtcbiAgLyoqIE5vcm1hbGl6ZWQgYEFXUzo6QXBpR2F0ZXdheVYyOjpSb3V0ZS5Qcm9wZXJ0aWVzLkFwaUlkYCBvZiB0aGUgYWZmZWN0ZWQgQVBJLiAqL1xuICByZWFkb25seSBhcGlSZWY6IHN0cmluZztcbiAgLyoqIFRoZSBBUEkgR2F0ZXdheSByb3V0ZSBrZXkgdGhhdCBpcyBoZWxkIHR3aWNlIGFjcm9zcyB0aGUgdHJhbnNpdGlvbi4gKi9cbiAgcmVhZG9ubHkgcm91dGVLZXk6IHN0cmluZztcbiAgLyoqIExvZ2ljYWwgaWQgaG9sZGluZyB0aGUga2V5IGJlZm9yZSB0aGUgdHJhbnNpdGlvbiwgd2hlbiBpdCBleGlzdGVkLiAqL1xuICByZWFkb25seSBiZWZvcmVMb2dpY2FsSWQ/OiBzdHJpbmc7XG4gIC8qKiBMb2dpY2FsIGlkIGhvbGRpbmcgdGhlIGtleSBhZnRlciB0aGUgdHJhbnNpdGlvbi4gKi9cbiAgcmVhZG9ubHkgYWZ0ZXJMb2dpY2FsSWQ/OiBzdHJpbmc7XG59XG5cbi8qKiBSb3V0ZSBpbnZlbnRvcnkgb2Ygb25lIEFQSSBpbiBvbmUgdGVtcGxhdGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJvdXRlS2V5SW5kZXgge1xuICAvKiogTm9ybWFsaXplZCBgQXBpSWRgIG9mIHRoZSBBUEkuICovXG4gIHJlYWRvbmx5IGFwaVJlZjogc3RyaW5nO1xuICAvKiogUm91dGUga2V5IHRvIHRoZSBzaW5nbGUgbG9naWNhbCBpZCB0aGF0IGhvbGRzIGl0LiAqL1xuICByZWFkb25seSBrZXlzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xuICAvKiogRXZlcnkgbG9naWNhbCBpZCB0aGF0IGhvbGRzIGEgcm91dGUgb24gdGhpcyBBUEkuICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxJZHM6IHN0cmluZ1tdO1xufVxuXG5pbnRlcmZhY2UgSnNvblRlbXBsYXRlIHtcbiAgcmVhZG9ubHkgUmVzb3VyY2VzPzogeyBbbG9naWNhbElkOiBzdHJpbmddOiB1bmtub3duIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUFwaVJlZihhcGlJZDogdW5rbm93bik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmICh0eXBlb2YgYXBpSWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4gYGxpdGVyYWw6JHthcGlJZH1gO1xuICB9XG4gIGNvbnN0IHJlZiA9IChhcGlJZCBhcyB7IFJlZj86IHVua25vd24gfSB8IHVuZGVmaW5lZCk/LlJlZjtcbiAgaWYgKHR5cGVvZiByZWYgPT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4gYHJlZjoke3JlZn1gO1xuICB9XG4gIGlmIChhcGlJZCA9PT0gdW5kZWZpbmVkIHx8IGFwaUlkID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICByZXR1cm4gYGpzb246JHtKU09OLnN0cmluZ2lmeShhcGlJZCl9YDtcbn1cblxuLyoqXG4gKiBJbmRleCBldmVyeSBIVFRQIEFQSSB2MiByb3V0ZSBpbiBhIENsb3VkRm9ybWF0aW9uIHRlbXBsYXRlIGJ5IEFQSSBhbmQgcm91dGVcbiAqIGtleS5cbiAqXG4gKiBUaHJvd3Mgd2hlbiBvbmUgQVBJIGhvbGRzIHRoZSBzYW1lIHJvdXRlIGtleSBvbiB0d28gbG9naWNhbCBpZHM6IHRoYXRcbiAqIHRlbXBsYXRlIGlzIG5vdCBkZXBsb3lhYmxlIGF0IGFsbCwgbGV0IGFsb25lIGFzIGEgdHJhbnNpdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluZGV4Um91dGVLZXlzKHRlbXBsYXRlOiB1bmtub3duKTogTWFwPHN0cmluZywgQXBwVGhlb3J5Um91dGVLZXlJbmRleD4ge1xuICBjb25zdCByZXNvdXJjZXMgPSAoKHRlbXBsYXRlIGFzIEpzb25UZW1wbGF0ZSB8IHVuZGVmaW5lZCk/LlJlc291cmNlcyA/PyB7fSk7XG4gIGNvbnN0IGJ5QXBpID0gbmV3IE1hcDxzdHJpbmcsIHsga2V5czogTWFwPHN0cmluZywgc3RyaW5nPjsgbG9naWNhbElkczogc3RyaW5nW10gfT4oKTtcbiAgZm9yIChjb25zdCBbbG9naWNhbElkLCByZXNvdXJjZV0gb2YgT2JqZWN0LmVudHJpZXMocmVzb3VyY2VzKSkge1xuICAgIGNvbnN0IHR5cGVkID0gcmVzb3VyY2UgYXMge1xuICAgICAgVHlwZT86IHN0cmluZztcbiAgICAgIFByb3BlcnRpZXM/OiB7IEFwaUlkPzogdW5rbm93bjsgUm91dGVLZXk/OiB1bmtub3duIH07XG4gICAgfTtcbiAgICBpZiAodHlwZWQ/LlR5cGUgIT09IFwiQVdTOjpBcGlHYXRld2F5VjI6OlJvdXRlXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFwaVJlZiA9IG5vcm1hbGl6ZUFwaVJlZih0eXBlZC5Qcm9wZXJ0aWVzPy5BcGlJZCk7XG4gICAgaWYgKGFwaVJlZiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHJvdXRlICR7bG9naWNhbElkfSBtdXN0IHJlZmVyZW5jZSBpdHMgQVBJYCk7XG4gICAgfVxuICAgIGNvbnN0IHJvdXRlS2V5ID0gdHlwZWQuUHJvcGVydGllcz8uUm91dGVLZXk7XG4gICAgaWYgKHR5cGVvZiByb3V0ZUtleSAhPT0gXCJzdHJpbmdcIiB8fCByb3V0ZUtleSA9PT0gXCJcIikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGByb3V0ZSAke2xvZ2ljYWxJZH0gbXVzdCBkZWNsYXJlIGEgcm91dGUga2V5YCk7XG4gICAgfVxuICAgIGxldCBlbnRyeSA9IGJ5QXBpLmdldChhcGlSZWYpO1xuICAgIGlmIChlbnRyeSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBlbnRyeSA9IHsga2V5czogbmV3IE1hcCgpLCBsb2dpY2FsSWRzOiBbXSB9O1xuICAgICAgYnlBcGkuc2V0KGFwaVJlZiwgZW50cnkpO1xuICAgIH1cbiAgICBjb25zdCBleGlzdGluZyA9IGVudHJ5LmtleXMuZ2V0KHJvdXRlS2V5KTtcbiAgICBpZiAoZXhpc3RpbmcgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgcm91dGUga2V5ICR7cm91dGVLZXl9IG11c3QgYmUgaGVsZCBieSBleGFjdGx5IG9uZSBsb2dpY2FsIGlkIG9uIEFQSSAke2FwaVJlZn0sIGZvdW5kICR7ZXhpc3Rpbmd9LCAke2xvZ2ljYWxJZH1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgZW50cnkua2V5cy5zZXQocm91dGVLZXksIGxvZ2ljYWxJZCk7XG4gICAgZW50cnkubG9naWNhbElkcy5wdXNoKGxvZ2ljYWxJZCk7XG4gIH1cbiAgY29uc3QgaW5kZXggPSBuZXcgTWFwPHN0cmluZywgQXBwVGhlb3J5Um91dGVLZXlJbmRleD4oKTtcbiAgZm9yIChjb25zdCBbYXBpUmVmLCBlbnRyeV0gb2YgYnlBcGkpIHtcbiAgICBpbmRleC5zZXQoYXBpUmVmLCB7IGFwaVJlZiwga2V5czogZW50cnkua2V5cywgbG9naWNhbElkczogZW50cnkubG9naWNhbElkcyB9KTtcbiAgfVxuICByZXR1cm4gaW5kZXg7XG59XG5cbi8qKlxuICogQ29tcGFyZSBhIGJlZm9yZS10ZW1wbGF0ZSBhbmQgYW4gYWZ0ZXItdGVtcGxhdGUgb2YgdGhlIHNhbWUgc3RhY2sgYW5kIHJldHVyblxuICogZXZlcnkgcm91dGUga2V5IHRoYXQgd291bGQgYmUgaGVsZCBieSB0d28gbG9naWNhbCBpZHMgaW4gdGhlIHNhbWUgQVBJIGFjcm9zc1xuICogdGhlIHRyYW5zaXRpb24uIEFuIGVtcHR5IGFycmF5IG1lYW5zIHRoZSB0cmFuc2l0aW9uIGlzIHNhZmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja1JvdXRlS2V5VHJhbnNpdGlvbnMoXG4gIGJlZm9yZTogdW5rbm93bixcbiAgYWZ0ZXI6IHVua25vd24sXG4pOiBBcHBUaGVvcnlSb3V0ZVRyYW5zaXRpb25Qcm9ibGVtW10ge1xuICBjb25zdCBiZWZvcmVJbmRleCA9IGluZGV4Um91dGVLZXlzKGJlZm9yZSk7XG4gIGNvbnN0IGFmdGVySW5kZXggPSBpbmRleFJvdXRlS2V5cyhhZnRlcik7XG4gIGNvbnN0IHByb2JsZW1zOiBBcHBUaGVvcnlSb3V0ZVRyYW5zaXRpb25Qcm9ibGVtW10gPSBbXTtcbiAgZm9yIChjb25zdCBbYXBpUmVmLCBiZWZvcmVBcGldIG9mIGJlZm9yZUluZGV4KSB7XG4gICAgY29uc3QgYWZ0ZXJBcGkgPSBhZnRlckluZGV4LmdldChhcGlSZWYpO1xuICAgIGlmIChhZnRlckFwaSA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBjb25zdCBiZWZvcmVJZHMgPSBuZXcgU2V0KGJlZm9yZUFwaS5sb2dpY2FsSWRzKTtcbiAgICBmb3IgKGNvbnN0IFtyb3V0ZUtleSwgYmVmb3JlTG9naWNhbElkXSBvZiBiZWZvcmVBcGkua2V5cykge1xuICAgICAgY29uc3QgYWZ0ZXJMb2dpY2FsSWQgPSBhZnRlckFwaS5rZXlzLmdldChyb3V0ZUtleSk7XG4gICAgICBpZiAoYWZ0ZXJMb2dpY2FsSWQgPT09IHVuZGVmaW5lZCB8fCBhZnRlckxvZ2ljYWxJZCA9PT0gYmVmb3JlTG9naWNhbElkKSBjb250aW51ZTtcbiAgICAgIHByb2JsZW1zLnB1c2goe1xuICAgICAgICBraW5kOiBBcHBUaGVvcnlSb3V0ZVRyYW5zaXRpb25Qcm9ibGVtS2luZC5PV05FUlNISVBfQ0hBTkdFRCxcbiAgICAgICAgYXBpUmVmLFxuICAgICAgICByb3V0ZUtleSxcbiAgICAgICAgYmVmb3JlTG9naWNhbElkLFxuICAgICAgICBhZnRlckxvZ2ljYWxJZCxcbiAgICAgIH0pO1xuICAgICAgaWYgKCFiZWZvcmVJZHMuaGFzKGFmdGVyTG9naWNhbElkKSkge1xuICAgICAgICBwcm9ibGVtcy5wdXNoKHtcbiAgICAgICAgICBraW5kOiBBcHBUaGVvcnlSb3V0ZVRyYW5zaXRpb25Qcm9ibGVtS2luZC5DUkVBVEVEX1JPVVRFX1RBS0VTX0VYSVNUSU5HX0tFWSxcbiAgICAgICAgICBhcGlSZWYsXG4gICAgICAgICAgcm91dGVLZXksXG4gICAgICAgICAgYmVmb3JlTG9naWNhbElkLFxuICAgICAgICAgIGFmdGVyTG9naWNhbElkLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHByb2JsZW1zO1xufVxuXG4vKiogUmVuZGVyIHRyYW5zaXRpb24gcHJvYmxlbXMgYXMgb25lIGh1bWFuLXJlYWRhYmxlIGxpbmUgcGVyIGhhemFyZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZVJvdXRlVHJhbnNpdGlvblByb2JsZW1zKFxuICBwcm9ibGVtczogQXBwVGhlb3J5Um91dGVUcmFuc2l0aW9uUHJvYmxlbVtdLFxuKTogc3RyaW5nW10ge1xuICByZXR1cm4gcHJvYmxlbXMubWFwKChwcm9ibGVtKSA9PiB7XG4gICAgY29uc3Qga2luZCA9IHByb2JsZW0ua2luZCA9PT0gQXBwVGhlb3J5Um91dGVUcmFuc2l0aW9uUHJvYmxlbUtpbmQuT1dORVJTSElQX0NIQU5HRURcbiAgICAgID8gXCJyb3V0ZSBrZXkgY2hhbmdlcyBsb2dpY2FsIGlkXCJcbiAgICAgIDogXCJjcmVhdGVkIHJvdXRlIHRha2VzIGFuIGV4aXN0aW5nIHJvdXRlIGtleVwiO1xuICAgIHJldHVybiBgJHtraW5kfTogJHtwcm9ibGVtLnJvdXRlS2V5fSBvbiAke3Byb2JsZW0uYXBpUmVmfSBtb3ZlZCBmcm9tICR7cHJvYmxlbS5iZWZvcmVMb2dpY2FsSWR9IHRvICR7cHJvYmxlbS5hZnRlckxvZ2ljYWxJZH1gO1xuICB9KTtcbn1cbiJdfQ==