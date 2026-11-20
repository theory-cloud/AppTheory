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
exports.RECOMMENDED_HTTP_API_SECURITY_POLICY = exports.RECOMMENDED_EDGE_REST_API_SECURITY_POLICY = exports.RECOMMENDED_REST_API_SECURITY_POLICY = exports.RECOMMENDED_CLOUD_FRONT_SECURITY_POLICY = void 0;
exports.secureDefaults = secureDefaults;
exports.defaultDeletionProtection = defaultDeletionProtection;
exports.defaultMinimumProtocolVersion = defaultMinimumProtocolVersion;
exports.isEnhancedRestSecurityPolicy = isEnhancedRestSecurityPolicy;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigw = __importStar(require("aws-cdk-lib/aws-apigateway"));
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
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
/**
 * The REST custom-domain security policy that satisfies Security Hub
 * APIGateway.11 for a regional or private endpoint: TLS 1.3 and TLS 1.2 with
 * perfect forward secrecy and post-quantum key exchange.
 *
 * It is also a cipher-policy change for clients, with the same caveat as the
 * CloudFront.15 2025 policies: a client that only negotiates an older TLS 1.2
 * cipher suite is excluded. An enhanced policy requires an endpoint access
 * mode alongside it: AppTheory derives `STRICT` (the recommended mode), and
 * `BASIC` remains available through `domain.endpointAccessMode`.
 *
 * @see https://docs.aws.amazon.com/securityhub/latest/userguide/apigateway-controls.html
 */
exports.RECOMMENDED_REST_API_SECURITY_POLICY = apigw.SecurityPolicy.TLS13_1_2_PFS_PQ_2025_09;
/**
 * The REST custom-domain security policy that satisfies APIGateway.11 for an
 * edge-optimized endpoint. API Gateway rejects the regional policies on an edge
 * domain and vice versa.
 */
exports.RECOMMENDED_EDGE_REST_API_SECURITY_POLICY = apigw.SecurityPolicy.TLS12_PFS_2025_EDGE;
/**
 * The strongest security policy an HTTP API custom domain can carry. Security
 * Hub APIGateway.11 produces a FAILED finding for every custom domain attached
 * to an HTTP API, so no value satisfies the control; API Gateway v2 offers only
 * the legacy TLS policies, and TLS 1.2 is the stronger of the two.
 *
 * @see https://docs.aws.amazon.com/securityhub/latest/userguide/apigateway-controls.html
 */
exports.RECOMMENDED_HTTP_API_SECURITY_POLICY = apigwv2.SecurityPolicy.TLS_1_2;
/**
 * Whether an API Gateway REST security policy is one of the enhanced
 * `SecurityPolicy_*` values. An enhanced policy requires an endpoint access
 * mode, and a legacy policy rejects one.
 */
function isEnhancedRestSecurityPolicy(policy) {
    return String(policy).startsWith("SecurityPolicy_");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VjdXJlLWRlZmF1bHRzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2VjdXJlLWRlZmF1bHRzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQTRCQSx3Q0FFQztBQVVELDhEQVFDO0FBU0Qsc0VBUUM7QUF1Q0Qsb0VBRUM7QUExR0QsNkNBQTRDO0FBQzVDLGtFQUFvRDtBQUNwRCxzRUFBd0Q7QUFDeEQsdUVBQXlEO0FBRXpELHNDQUFtRDtBQUduRDs7Ozs7OztHQU9HO0FBQ1UsUUFBQSx1Q0FBdUMsR0FBRyxVQUFVLENBQUMsc0JBQXNCLENBQUMsYUFBYSxDQUFDO0FBRXZHOzs7Ozs7Ozs7R0FTRztBQUNILFNBQWdCLGNBQWMsQ0FBQyxPQUEyQztJQUN4RSxPQUFPLE9BQU8sS0FBSyxTQUFTLElBQUksT0FBTyxDQUFDLGFBQWEsS0FBSywrQkFBc0IsQ0FBQyxPQUFPLENBQUM7QUFDM0YsQ0FBQztBQUVEOzs7Ozs7O0dBT0c7QUFDSCxTQUFnQix5QkFBeUIsQ0FDdkMsT0FBMkMsRUFDM0MsYUFBNEIsRUFDNUIsUUFBNkI7SUFFN0IsSUFBSSxRQUFRLEtBQUssU0FBUztRQUFFLE9BQU8sUUFBUSxDQUFDO0lBQzVDLElBQUksQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDL0MsT0FBTyxhQUFhLEtBQUssMkJBQWEsQ0FBQyxNQUFNLENBQUM7QUFDaEQsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQWdCLDZCQUE2QixDQUMzQyxPQUEyQyxFQUMzQyxrQkFBMkIsRUFDM0IsUUFBdUQ7SUFFdkQsSUFBSSxRQUFRLEtBQUssU0FBUztRQUFFLE9BQU8sUUFBUSxDQUFDO0lBQzVDLElBQUksQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxrQkFBa0I7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUN0RSxPQUFPLCtDQUF1QyxDQUFDO0FBQ2pELENBQUM7QUFFRDs7Ozs7Ozs7Ozs7O0dBWUc7QUFDVSxRQUFBLG9DQUFvQyxHQUFHLEtBQUssQ0FBQyxjQUFjLENBQUMsd0JBQXdCLENBQUM7QUFFbEc7Ozs7R0FJRztBQUNVLFFBQUEseUNBQXlDLEdBQUcsS0FBSyxDQUFDLGNBQWMsQ0FBQyxtQkFBbUIsQ0FBQztBQUVsRzs7Ozs7OztHQU9HO0FBQ1UsUUFBQSxvQ0FBb0MsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQztBQUVuRjs7OztHQUlHO0FBQ0gsU0FBZ0IsNEJBQTRCLENBQUMsTUFBNEI7SUFDdkUsT0FBTyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsVUFBVSxDQUFDLGlCQUFpQixDQUFDLENBQUM7QUFDdEQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TmFtaW5nUHJvZmlsZSB9IGZyb20gXCIuLi9uYW1pbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuLi9uYW1pbmctY29udGV4dFwiO1xuXG4vKipcbiAqIFRoZSBDbG91ZEZyb250IHZpZXdlciBzZWN1cml0eSBwb2xpY3kgdGhhdCBzYXRpc2ZpZXMgU2VjdXJpdHkgSHViXG4gKiBDbG91ZEZyb250LjE1LiBUaGUgY29udHJvbCBhY2NlcHRzIGBUTFN2MS4yXzIwMjVgIGFuZCBgVExTdjEuM18yMDI1YCBvbmx5XG4gKiAoaXRzIGBzZWN1cml0eVBvbGljaWVzYCBwYXJhbWV0ZXIgaXMgbm90IGN1c3RvbWl6YWJsZSksIHNvIHRoZSBkZWZhdWx0IHBpY2tzXG4gKiB0aGUgVExTIDEuMiBmbG9vciBmb3IgY2xpZW50IGNvbXBhdGliaWxpdHkgd2hpbGUgc3RpbGwgcGFzc2luZyB0aGUgY29udHJvbC5cbiAqXG4gKiBAc2VlIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9zZWN1cml0eWh1Yi9sYXRlc3QvdXNlcmd1aWRlL2Nsb3VkZnJvbnQtY29udHJvbHMuaHRtbFxuICovXG5leHBvcnQgY29uc3QgUkVDT01NRU5ERURfQ0xPVURfRlJPTlRfU0VDVVJJVFlfUE9MSUNZID0gY2xvdWRmcm9udC5TZWN1cml0eVBvbGljeVByb3RvY29sLlRMU19WMV8yXzIwMjU7XG5cbi8qKlxuICogV2hldGhlciBvbmUgY29uc3RydWN0IGFwcGxpZXMgdGhlIFNlY3VyaXR5IEh1Yi1hbGlnbmVkIGRlZmF1bHRzLlxuICpcbiAqIFRoZSBuYW1pbmcgY29udGV4dCBzZWxlY3RzIHRoZW0sIGFuZCB0aGUgbmFtaW5nIHByb2ZpbGUgZGVjaWRlcyB3aGljaCBzaWRlIG9mXG4gKiB0aGUgbWlncmF0aW9uIGEgY29uc3VtZXIgaXMgb246IGEgZGVyaXZlZCBjb250ZXh0IGlzIHRoZSBsYWIgcGF0aCwgd2hlcmUgdGhlXG4gKiBkZWZhdWx0cyBhcHBseSwgd2hpbGUgYSBsZWdhY3kgY29udGV4dCBpcyB0aGUgcGlubmVkIHBhdGggdGhhdCBtdXN0IGtlZXBcbiAqIHRvZGF5J3MgdGVtcGxhdGUgYnl0ZSBmb3IgYnl0ZSAodGhlIEFULU4zIG1pZ3JhdGlvbiBwcm9wZXJ0eSkuIEEgY29uc3VtZXIgd2l0aFxuICogbm8gY29udGV4dCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZSB0aGlzIGNvbnRyYWN0IGV4aXN0ZWQsIHNvIGEgbGl2ZVxuICogdGVtcGxhdGUgc3RheXMgYnl0ZS1pZGVudGljYWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWN1cmVEZWZhdWx0cyhjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIHJldHVybiBjb250ZXh0ICE9PSB1bmRlZmluZWQgJiYgY29udGV4dC5uYW1pbmdQcm9maWxlID09PSBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQ7XG59XG5cbi8qKlxuICogRHluYW1vREIgZGVsZXRpb24gcHJvdGVjdGlvbiAoU2VjdXJpdHkgSHViIER5bmFtb0RCLjYpLlxuICpcbiAqIFVuZGVyIGEgbmFtaW5nIGNvbnRleHQgdGhlIGRlZmF1bHQgZm9sbG93cyB0aGUgcmVzb2x2ZWQgcmVtb3ZhbCBwb2xpY3k6IGFcbiAqIFJFVEFJTiB0YWJsZSBvdXRsaXZlcyBhIHN0YWNrIGRlbGV0aW9uLCBzbyBwcm90ZWN0aW9uIGlzIG9uOyBhIHRhYmxlIHdpdGggYW55XG4gKiBvdGhlciByZW1vdmFsIHBvbGljeSBpcyBkZWxpYmVyYXRlbHkgZGVzdHJ1Y3RpdmUsIHNvIHByb3RlY3Rpb24gc3RheXMgb2ZmIGFuZFxuICogdGhlIHN0YWNrIGNhbiBzdGlsbCBiZSB0b3JuIGRvd24gKHRoZSBsYWIgcmVtb3ZhbC1wb2xpY3kgcnVsaW5nKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHREZWxldGlvblByb3RlY3Rpb24oXG4gIGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfCB1bmRlZmluZWQsXG4gIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3ksXG4gIGV4cGxpY2l0OiBib29sZWFuIHwgdW5kZWZpbmVkLFxuKTogYm9vbGVhbiB8IHVuZGVmaW5lZCB7XG4gIGlmIChleHBsaWNpdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gZXhwbGljaXQ7XG4gIGlmICghc2VjdXJlRGVmYXVsdHMoY29udGV4dCkpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiByZW1vdmFsUG9saWN5ID09PSBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbn1cblxuLyoqXG4gKiBDbG91ZEZyb250IGBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uYCAoU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUpLlxuICpcbiAqIFRoZSBwcm9wZXJ0eSBvbmx5IHJlbmRlcnMgb24gYSBkaXN0cmlidXRpb24gdGhhdCBjYXJyaWVzIGEgY3VzdG9tXG4gKiBjZXJ0aWZpY2F0ZTsgd2l0aG91dCBvbmUgQ2xvdWRGcm9udCBzZXJ2ZXMgdGhlIGZpeGVkIGRlZmF1bHQgY2VydGlmaWNhdGUgYW5kXG4gKiB0aGUgY29udHJvbCBkb2VzIG5vdCBldmFsdWF0ZSB0aGUgZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24oXG4gIGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfCB1bmRlZmluZWQsXG4gIGNlcnRpZmljYXRlUHJlc2VudDogYm9vbGVhbixcbiAgZXhwbGljaXQ6IGNsb3VkZnJvbnQuU2VjdXJpdHlQb2xpY3lQcm90b2NvbCB8IHVuZGVmaW5lZCxcbik6IGNsb3VkZnJvbnQuU2VjdXJpdHlQb2xpY3lQcm90b2NvbCB8IHVuZGVmaW5lZCB7XG4gIGlmIChleHBsaWNpdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gZXhwbGljaXQ7XG4gIGlmICghc2VjdXJlRGVmYXVsdHMoY29udGV4dCkgfHwgIWNlcnRpZmljYXRlUHJlc2VudCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIFJFQ09NTUVOREVEX0NMT1VEX0ZST05UX1NFQ1VSSVRZX1BPTElDWTtcbn1cblxuLyoqXG4gKiBUaGUgUkVTVCBjdXN0b20tZG9tYWluIHNlY3VyaXR5IHBvbGljeSB0aGF0IHNhdGlzZmllcyBTZWN1cml0eSBIdWJcbiAqIEFQSUdhdGV3YXkuMTEgZm9yIGEgcmVnaW9uYWwgb3IgcHJpdmF0ZSBlbmRwb2ludDogVExTIDEuMyBhbmQgVExTIDEuMiB3aXRoXG4gKiBwZXJmZWN0IGZvcndhcmQgc2VjcmVjeSBhbmQgcG9zdC1xdWFudHVtIGtleSBleGNoYW5nZS5cbiAqXG4gKiBJdCBpcyBhbHNvIGEgY2lwaGVyLXBvbGljeSBjaGFuZ2UgZm9yIGNsaWVudHMsIHdpdGggdGhlIHNhbWUgY2F2ZWF0IGFzIHRoZVxuICogQ2xvdWRGcm9udC4xNSAyMDI1IHBvbGljaWVzOiBhIGNsaWVudCB0aGF0IG9ubHkgbmVnb3RpYXRlcyBhbiBvbGRlciBUTFMgMS4yXG4gKiBjaXBoZXIgc3VpdGUgaXMgZXhjbHVkZWQuIEFuIGVuaGFuY2VkIHBvbGljeSByZXF1aXJlcyBhbiBlbmRwb2ludCBhY2Nlc3NcbiAqIG1vZGUgYWxvbmdzaWRlIGl0OiBBcHBUaGVvcnkgZGVyaXZlcyBgU1RSSUNUYCAodGhlIHJlY29tbWVuZGVkIG1vZGUpLCBhbmRcbiAqIGBCQVNJQ2AgcmVtYWlucyBhdmFpbGFibGUgdGhyb3VnaCBgZG9tYWluLmVuZHBvaW50QWNjZXNzTW9kZWAuXG4gKlxuICogQHNlZSBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vc2VjdXJpdHlodWIvbGF0ZXN0L3VzZXJndWlkZS9hcGlnYXRld2F5LWNvbnRyb2xzLmh0bWxcbiAqL1xuZXhwb3J0IGNvbnN0IFJFQ09NTUVOREVEX1JFU1RfQVBJX1NFQ1VSSVRZX1BPTElDWSA9IGFwaWd3LlNlY3VyaXR5UG9saWN5LlRMUzEzXzFfMl9QRlNfUFFfMjAyNV8wOTtcblxuLyoqXG4gKiBUaGUgUkVTVCBjdXN0b20tZG9tYWluIHNlY3VyaXR5IHBvbGljeSB0aGF0IHNhdGlzZmllcyBBUElHYXRld2F5LjExIGZvciBhblxuICogZWRnZS1vcHRpbWl6ZWQgZW5kcG9pbnQuIEFQSSBHYXRld2F5IHJlamVjdHMgdGhlIHJlZ2lvbmFsIHBvbGljaWVzIG9uIGFuIGVkZ2VcbiAqIGRvbWFpbiBhbmQgdmljZSB2ZXJzYS5cbiAqL1xuZXhwb3J0IGNvbnN0IFJFQ09NTUVOREVEX0VER0VfUkVTVF9BUElfU0VDVVJJVFlfUE9MSUNZID0gYXBpZ3cuU2VjdXJpdHlQb2xpY3kuVExTMTJfUEZTXzIwMjVfRURHRTtcblxuLyoqXG4gKiBUaGUgc3Ryb25nZXN0IHNlY3VyaXR5IHBvbGljeSBhbiBIVFRQIEFQSSBjdXN0b20gZG9tYWluIGNhbiBjYXJyeS4gU2VjdXJpdHlcbiAqIEh1YiBBUElHYXRld2F5LjExIHByb2R1Y2VzIGEgRkFJTEVEIGZpbmRpbmcgZm9yIGV2ZXJ5IGN1c3RvbSBkb21haW4gYXR0YWNoZWRcbiAqIHRvIGFuIEhUVFAgQVBJLCBzbyBubyB2YWx1ZSBzYXRpc2ZpZXMgdGhlIGNvbnRyb2w7IEFQSSBHYXRld2F5IHYyIG9mZmVycyBvbmx5XG4gKiB0aGUgbGVnYWN5IFRMUyBwb2xpY2llcywgYW5kIFRMUyAxLjIgaXMgdGhlIHN0cm9uZ2VyIG9mIHRoZSB0d28uXG4gKlxuICogQHNlZSBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vc2VjdXJpdHlodWIvbGF0ZXN0L3VzZXJndWlkZS9hcGlnYXRld2F5LWNvbnRyb2xzLmh0bWxcbiAqL1xuZXhwb3J0IGNvbnN0IFJFQ09NTUVOREVEX0hUVFBfQVBJX1NFQ1VSSVRZX1BPTElDWSA9IGFwaWd3djIuU2VjdXJpdHlQb2xpY3kuVExTXzFfMjtcblxuLyoqXG4gKiBXaGV0aGVyIGFuIEFQSSBHYXRld2F5IFJFU1Qgc2VjdXJpdHkgcG9saWN5IGlzIG9uZSBvZiB0aGUgZW5oYW5jZWRcbiAqIGBTZWN1cml0eVBvbGljeV8qYCB2YWx1ZXMuIEFuIGVuaGFuY2VkIHBvbGljeSByZXF1aXJlcyBhbiBlbmRwb2ludCBhY2Nlc3NcbiAqIG1vZGUsIGFuZCBhIGxlZ2FjeSBwb2xpY3kgcmVqZWN0cyBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0VuaGFuY2VkUmVzdFNlY3VyaXR5UG9saWN5KHBvbGljeTogYXBpZ3cuU2VjdXJpdHlQb2xpY3kpOiBib29sZWFuIHtcbiAgcmV0dXJuIFN0cmluZyhwb2xpY3kpLnN0YXJ0c1dpdGgoXCJTZWN1cml0eVBvbGljeV9cIik7XG59XG4iXX0=