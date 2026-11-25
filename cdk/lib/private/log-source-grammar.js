"use strict";
/**
 * The `theorycloud_resource_naming.v0.1` section 3 log-source grammar, shared by
 * the derivation and the fixed-name check so the two cannot drift apart.
 *
 * Section 1 defines one logical segment as `[a-z0-9]+(-[a-z0-9]+)*`; section 3
 * names a log group `theorycloud_{namespace}_{app}_{stage}_{logical}`, where the
 * logical source's `/` separators become `_` (one grammar then also satisfies
 * CloudFront's `[\w-]` destination). The remainder of such a name after its
 * bound prefix is therefore `logs`, then one or more logical segments joined
 * with `_`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOG_SOURCE_REMAINDER_RE = exports.LAMBDA_LOG_GROUP_LEAD = exports.LOGICAL_SEGMENT_PATTERN = void 0;
/**
 * One logical-name segment (`[a-z0-9]+(-[a-z0-9]+)*`), the grammar of a
 * namespace, an app id, a stage's siblings and every logical-name segment.
 */
exports.LOGICAL_SEGMENT_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";
/**
 * The Lambda service log-group path lead (contract section 3): the second shape a
 * fixed log-group name may take, `/aws/lambda/{function name}`.
 */
exports.LAMBDA_LOG_GROUP_LEAD = "/aws/lambda/";
/**
 * The remainder of a section 3 log-source name after its bound
 * `theorycloud_{namespace}_{app}_{stage}_` prefix: the literal `logs` segment,
 * then one or more logical segments joined with `_`, and nothing else.
 */
exports.LOG_SOURCE_REMAINDER_RE = new RegExp(`^logs(?:_${exports.LOGICAL_SEGMENT_PATTERN})+$`);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9nLXNvdXJjZS1ncmFtbWFyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9nLXNvdXJjZS1ncmFtbWFyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7OztHQVVHOzs7QUFFSDs7O0dBR0c7QUFDVSxRQUFBLHVCQUF1QixHQUFHLDBCQUEwQixDQUFDO0FBRWxFOzs7R0FHRztBQUNVLFFBQUEscUJBQXFCLEdBQUcsY0FBYyxDQUFDO0FBRXBEOzs7O0dBSUc7QUFDVSxRQUFBLHVCQUF1QixHQUFHLElBQUksTUFBTSxDQUFDLFlBQVksK0JBQXVCLEtBQUssQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUaGUgYHRoZW9yeWNsb3VkX3Jlc291cmNlX25hbWluZy52MC4xYCBzZWN0aW9uIDMgbG9nLXNvdXJjZSBncmFtbWFyLCBzaGFyZWQgYnlcbiAqIHRoZSBkZXJpdmF0aW9uIGFuZCB0aGUgZml4ZWQtbmFtZSBjaGVjayBzbyB0aGUgdHdvIGNhbm5vdCBkcmlmdCBhcGFydC5cbiAqXG4gKiBTZWN0aW9uIDEgZGVmaW5lcyBvbmUgbG9naWNhbCBzZWdtZW50IGFzIGBbYS16MC05XSsoLVthLXowLTldKykqYDsgc2VjdGlvbiAzXG4gKiBuYW1lcyBhIGxvZyBncm91cCBgdGhlb3J5Y2xvdWRfe25hbWVzcGFjZX1fe2FwcH1fe3N0YWdlfV97bG9naWNhbH1gLCB3aGVyZSB0aGVcbiAqIGxvZ2ljYWwgc291cmNlJ3MgYC9gIHNlcGFyYXRvcnMgYmVjb21lIGBfYCAob25lIGdyYW1tYXIgdGhlbiBhbHNvIHNhdGlzZmllc1xuICogQ2xvdWRGcm9udCdzIGBbXFx3LV1gIGRlc3RpbmF0aW9uKS4gVGhlIHJlbWFpbmRlciBvZiBzdWNoIGEgbmFtZSBhZnRlciBpdHNcbiAqIGJvdW5kIHByZWZpeCBpcyB0aGVyZWZvcmUgYGxvZ3NgLCB0aGVuIG9uZSBvciBtb3JlIGxvZ2ljYWwgc2VnbWVudHMgam9pbmVkXG4gKiB3aXRoIGBfYC5cbiAqL1xuXG4vKipcbiAqIE9uZSBsb2dpY2FsLW5hbWUgc2VnbWVudCAoYFthLXowLTldKygtW2EtejAtOV0rKSpgKSwgdGhlIGdyYW1tYXIgb2YgYVxuICogbmFtZXNwYWNlLCBhbiBhcHAgaWQsIGEgc3RhZ2UncyBzaWJsaW5ncyBhbmQgZXZlcnkgbG9naWNhbC1uYW1lIHNlZ21lbnQuXG4gKi9cbmV4cG9ydCBjb25zdCBMT0dJQ0FMX1NFR01FTlRfUEFUVEVSTiA9IFwiW2EtejAtOV0rKD86LVthLXowLTldKykqXCI7XG5cbi8qKlxuICogVGhlIExhbWJkYSBzZXJ2aWNlIGxvZy1ncm91cCBwYXRoIGxlYWQgKGNvbnRyYWN0IHNlY3Rpb24gMyk6IHRoZSBzZWNvbmQgc2hhcGUgYVxuICogZml4ZWQgbG9nLWdyb3VwIG5hbWUgbWF5IHRha2UsIGAvYXdzL2xhbWJkYS97ZnVuY3Rpb24gbmFtZX1gLlxuICovXG5leHBvcnQgY29uc3QgTEFNQkRBX0xPR19HUk9VUF9MRUFEID0gXCIvYXdzL2xhbWJkYS9cIjtcblxuLyoqXG4gKiBUaGUgcmVtYWluZGVyIG9mIGEgc2VjdGlvbiAzIGxvZy1zb3VyY2UgbmFtZSBhZnRlciBpdHMgYm91bmRcbiAqIGB0aGVvcnljbG91ZF97bmFtZXNwYWNlfV97YXBwfV97c3RhZ2V9X2AgcHJlZml4OiB0aGUgbGl0ZXJhbCBgbG9nc2Agc2VnbWVudCxcbiAqIHRoZW4gb25lIG9yIG1vcmUgbG9naWNhbCBzZWdtZW50cyBqb2luZWQgd2l0aCBgX2AsIGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cbmV4cG9ydCBjb25zdCBMT0dfU09VUkNFX1JFTUFJTkRFUl9SRSA9IG5ldyBSZWdFeHAoYF5sb2dzKD86XyR7TE9HSUNBTF9TRUdNRU5UX1BBVFRFUk59KSskYCk7XG4iXX0=