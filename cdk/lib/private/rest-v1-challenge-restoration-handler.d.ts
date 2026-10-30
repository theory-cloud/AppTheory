/**
 * Self-contained Lambda@Edge handler source for `AppTheoryRestV1ChallengeRestoration`.
 *
 * AWS API Gateway REST API v1 remaps the origin's `WWW-Authenticate` response
 * header onto `x-amzn-remapped-www-authenticate`, so a canonical-only app loses
 * its challenge at the edge. This handler restores the canonical header on the
 * CloudFront origin response and removes the consumed source headers.
 *
 * The ordered **restore source list is embedded at synth time**, never resolved
 * at runtime. That is deliberate:
 *
 * - With the optional alias bridge disabled the code carries only the AWS remap
 *   artifact (`x-amzn-remapped-www-authenticate`) and the alias spellings do not
 *   appear in the deployed function source at all.
 * - With the alias bridge enabled the alias spellings are appended after the
 *   remap artifact, preserving the mandated priority order
 *   (`x-theory-www-authenticate`, then `mcp-www-authenticate`).
 *
 * The handler walks that list in order, adopts the first present non-empty
 * value as the canonical `WWW-Authenticate` header when the origin did not emit
 * one, then deletes every consumed source header.
 *
 * The generated handler is `async`: Lambda@Edge uses the returned promise as the
 * invocation result, whereas a plain synchronous return value is discarded.
 * Tests must await that promise instead of reading a detached early value.
 *
 * This module is internal to the CDK package and intentionally NOT exported from
 * `index.ts`, so it never appears in the jsii assembly or generated bindings.
 *
 * @internal
 */
export declare function generateRestV1ChallengeRestorationHandlerCode(restoreSourceHeaders: string[]): string;
