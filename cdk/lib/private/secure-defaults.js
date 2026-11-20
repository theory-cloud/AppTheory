"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECOMMENDED_CLOUD_FRONT_SECURITY_POLICY = void 0;
exports.secureDefaults = secureDefaults;
exports.defaultDeletionProtection = defaultDeletionProtection;
exports.defaultMinimumProtocolVersion = defaultMinimumProtocolVersion;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const naming_1 = require("../naming");
/**
 * The CloudFront viewer security policy that satisfies Security Hub
 * CloudFront.15. The control accepts `TLSv1.2_2025` and `TLSv1.3_2025` only
 * (its `securityPolicies` parameter is not customizable), so the default picks
 * the TLS 1.2 floor for client compatibility while still passing the control.
 *
 * @see https://docs.aws.amazon.com/securityhub/latest/userguide/cloudfront-controls.html
 */
exports.RECOMMENDED_CLOUD_FRONT_SECURITY_POLICY = cloudfront.SecurityPolicyProtocol.TLS_V1_2_2025;
/**
 * Whether one construct applies the Security Hub-aligned defaults.
 *
 * The naming context selects them, and the naming profile decides which side of
 * the migration a consumer is on: a derived context is the lab path, where the
 * defaults apply, while a legacy context is the pinned path that must keep
 * today's template byte for byte (the AT-N3 migration property). A consumer with
 * no context synthesizes exactly as before this contract existed, so a live
 * template stays byte-identical.
 */
function secureDefaults(context) {
    return context !== undefined && context.namingProfile === naming_1.AppTheoryNamingProfile.DERIVED;
}
/**
 * DynamoDB deletion protection (Security Hub DynamoDB.6).
 *
 * Under a naming context the default follows the resolved removal policy: a
 * RETAIN table outlives a stack deletion, so protection is on; a table with any
 * other removal policy is deliberately destructive, so protection stays off and
 * the stack can still be torn down (the lab removal-policy ruling).
 */
function defaultDeletionProtection(context, removalPolicy, explicit) {
    if (explicit !== undefined)
        return explicit;
    if (!secureDefaults(context))
        return undefined;
    return removalPolicy === aws_cdk_lib_1.RemovalPolicy.RETAIN;
}
/**
 * CloudFront `minimumProtocolVersion` (Security Hub CloudFront.15).
 *
 * The property only renders on a distribution that carries a custom
 * certificate; without one CloudFront serves the fixed default certificate and
 * the control does not evaluate the distribution.
 */
function defaultMinimumProtocolVersion(context, certificatePresent, explicit) {
    if (explicit !== undefined)
        return explicit;
    if (!secureDefaults(context) || !certificatePresent)
        return undefined;
    return exports.RECOMMENDED_CLOUD_FRONT_SECURITY_POLICY;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VjdXJlLWRlZmF1bHRzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2VjdXJlLWRlZmF1bHRzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQTBCQSx3Q0FFQztBQVVELDhEQVFDO0FBU0Qsc0VBUUM7QUEvREQsNkNBQTRDO0FBQzVDLHVFQUF5RDtBQUV6RCxzQ0FBbUQ7QUFHbkQ7Ozs7Ozs7R0FPRztBQUNVLFFBQUEsdUNBQXVDLEdBQUcsVUFBVSxDQUFDLHNCQUFzQixDQUFDLGFBQWEsQ0FBQztBQUV2Rzs7Ozs7Ozs7O0dBU0c7QUFDSCxTQUFnQixjQUFjLENBQUMsT0FBMkM7SUFDeEUsT0FBTyxPQUFPLEtBQUssU0FBUyxJQUFJLE9BQU8sQ0FBQyxhQUFhLEtBQUssK0JBQXNCLENBQUMsT0FBTyxDQUFDO0FBQzNGLENBQUM7QUFFRDs7Ozs7OztHQU9HO0FBQ0gsU0FBZ0IseUJBQXlCLENBQ3ZDLE9BQTJDLEVBQzNDLGFBQTRCLEVBQzVCLFFBQTZCO0lBRTdCLElBQUksUUFBUSxLQUFLLFNBQVM7UUFBRSxPQUFPLFFBQVEsQ0FBQztJQUM1QyxJQUFJLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQztRQUFFLE9BQU8sU0FBUyxDQUFDO0lBQy9DLE9BQU8sYUFBYSxLQUFLLDJCQUFhLENBQUMsTUFBTSxDQUFDO0FBQ2hELENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxTQUFnQiw2QkFBNkIsQ0FDM0MsT0FBMkMsRUFDM0Msa0JBQTJCLEVBQzNCLFFBQXVEO0lBRXZELElBQUksUUFBUSxLQUFLLFNBQVM7UUFBRSxPQUFPLFFBQVEsQ0FBQztJQUM1QyxJQUFJLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsa0JBQWtCO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDdEUsT0FBTywrQ0FBdUMsQ0FBQztBQUNqRCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TmFtaW5nUHJvZmlsZSB9IGZyb20gXCIuLi9uYW1pbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuLi9uYW1pbmctY29udGV4dFwiO1xuXG4vKipcbiAqIFRoZSBDbG91ZEZyb250IHZpZXdlciBzZWN1cml0eSBwb2xpY3kgdGhhdCBzYXRpc2ZpZXMgU2VjdXJpdHkgSHViXG4gKiBDbG91ZEZyb250LjE1LiBUaGUgY29udHJvbCBhY2NlcHRzIGBUTFN2MS4yXzIwMjVgIGFuZCBgVExTdjEuM18yMDI1YCBvbmx5XG4gKiAoaXRzIGBzZWN1cml0eVBvbGljaWVzYCBwYXJhbWV0ZXIgaXMgbm90IGN1c3RvbWl6YWJsZSksIHNvIHRoZSBkZWZhdWx0IHBpY2tzXG4gKiB0aGUgVExTIDEuMiBmbG9vciBmb3IgY2xpZW50IGNvbXBhdGliaWxpdHkgd2hpbGUgc3RpbGwgcGFzc2luZyB0aGUgY29udHJvbC5cbiAqXG4gKiBAc2VlIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9zZWN1cml0eWh1Yi9sYXRlc3QvdXNlcmd1aWRlL2Nsb3VkZnJvbnQtY29udHJvbHMuaHRtbFxuICovXG5leHBvcnQgY29uc3QgUkVDT01NRU5ERURfQ0xPVURfRlJPTlRfU0VDVVJJVFlfUE9MSUNZID0gY2xvdWRmcm9udC5TZWN1cml0eVBvbGljeVByb3RvY29sLlRMU19WMV8yXzIwMjU7XG5cbi8qKlxuICogV2hldGhlciBvbmUgY29uc3RydWN0IGFwcGxpZXMgdGhlIFNlY3VyaXR5IEh1Yi1hbGlnbmVkIGRlZmF1bHRzLlxuICpcbiAqIFRoZSBuYW1pbmcgY29udGV4dCBzZWxlY3RzIHRoZW0sIGFuZCB0aGUgbmFtaW5nIHByb2ZpbGUgZGVjaWRlcyB3aGljaCBzaWRlIG9mXG4gKiB0aGUgbWlncmF0aW9uIGEgY29uc3VtZXIgaXMgb246IGEgZGVyaXZlZCBjb250ZXh0IGlzIHRoZSBsYWIgcGF0aCwgd2hlcmUgdGhlXG4gKiBkZWZhdWx0cyBhcHBseSwgd2hpbGUgYSBsZWdhY3kgY29udGV4dCBpcyB0aGUgcGlubmVkIHBhdGggdGhhdCBtdXN0IGtlZXBcbiAqIHRvZGF5J3MgdGVtcGxhdGUgYnl0ZSBmb3IgYnl0ZSAodGhlIEFULU4zIG1pZ3JhdGlvbiBwcm9wZXJ0eSkuIEEgY29uc3VtZXIgd2l0aFxuICogbm8gY29udGV4dCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZSB0aGlzIGNvbnRyYWN0IGV4aXN0ZWQsIHNvIGEgbGl2ZVxuICogdGVtcGxhdGUgc3RheXMgYnl0ZS1pZGVudGljYWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWN1cmVEZWZhdWx0cyhjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIHJldHVybiBjb250ZXh0ICE9PSB1bmRlZmluZWQgJiYgY29udGV4dC5uYW1pbmdQcm9maWxlID09PSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQ7XG59XG5cbi8qKlxuICogRHluYW1vREIgZGVsZXRpb24gcHJvdGVjdGlvbiAoU2VjdXJpdHkgSHViIER5bmFtb0RCLjYpLlxuICpcbiAqIFVuZGVyIGEgbmFtaW5nIGNvbnRleHQgdGhlIGRlZmF1bHQgZm9sbG93cyB0aGUgcmVzb2x2ZWQgcmVtb3ZhbCBwb2xpY3k6IGFcbiAqIFJFVEFJTiB0YWJsZSBvdXRsaXZlcyBhIHN0YWNrIGRlbGV0aW9uLCBzbyBwcm90ZWN0aW9uIGlzIG9uOyBhIHRhYmxlIHdpdGggYW55XG4gKiBvdGhlciByZW1vdmFsIHBvbGljeSBpcyBkZWxpYmVyYXRlbHkgZGVzdHJ1Y3RpdmUsIHNvIHByb3RlY3Rpb24gc3RheXMgb2ZmIGFuZFxuICogdGhlIHN0YWNrIGNhbiBzdGlsbCBiZSB0b3JuIGRvd24gKHRoZSBsYWIgcmVtb3ZhbC1wb2xpY3kgcnVsaW5nKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHREZWxldGlvblByb3RlY3Rpb24oXG4gIGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfCB1bmRlZmluZWQsXG4gIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3ksXG4gIGV4cGxpY2l0OiBib29sZWFuIHwgdW5kZWZpbmVkLFxuKTogYm9vbGVhbiB8IHVuZGVmaW5lZCB7XG4gIGlmIChleHBsaWNpdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gZXhwbGljaXQ7XG4gIGlmICghc2VjdXJlRGVmYXVsdHMoY29udGV4dCkpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiByZW1vdmFsUG9saWN5ID09PSBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbn1cblxuLyoqXG4gKiBDbG91ZEZyb250IGBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uYCAoU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUpLlxuICpcbiAqIFRoZSBwcm9wZXJ0eSBvbmx5IHJlbmRlcnMgb24gYSBkaXN0cmlidXRpb24gdGhhdCBjYXJyaWVzIGEgY3VzdG9tXG4gKiBjZXJ0aWZpY2F0ZTsgd2l0aG91dCBvbmUgQ2xvdWRGcm9udCBzZXJ2ZXMgdGhlIGZpeGVkIGRlZmF1bHQgY2VydGlmaWNhdGUgYW5kXG4gKiB0aGUgY29udHJvbCBkb2VzIG5vdCBldmFsdWF0ZSB0aGUgZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24oXG4gIGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfCB1bmRlZmluZWQsXG4gIGNlcnRpZmljYXRlUHJlc2VudDogYm9vbGVhbixcbiAgZXhwbGljaXQ6IGNsb3VkZnJvbnQuU2VjdXJpdHlQb2xpY3lQcm90b2NvbCB8IHVuZGVmaW5lZCxcbik6IGNsb3VkZnJvbnQuU2VjdXJpdHlQb2xpY3lQcm90b2NvbCB8IHVuZGVmaW5lZCB7XG4gIGlmIChleHBsaWNpdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gZXhwbGljaXQ7XG4gIGlmICghc2VjdXJlRGVmYXVsdHMoY29udGV4dCkgfHwgIWNlcnRpZmljYXRlUHJlc2VudCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIFJFQ09NTUVOREVEX0NMT1VEX0ZST05UX1NFQ1VSSVRZX1BPTElDWTtcbn1cbiJdfQ==