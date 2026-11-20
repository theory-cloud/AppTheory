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
 * cipher suite is excluded. API Gateway requires `endpointAccessMode: STRICT`
 * alongside an enhanced policy.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VjdXJlLWRlZmF1bHRzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2VjdXJlLWRlZmF1bHRzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQTRCQSx3Q0FFQztBQVVELDhEQVFDO0FBU0Qsc0VBUUM7QUFzQ0Qsb0VBRUM7QUF6R0QsNkNBQTRDO0FBQzVDLGtFQUFvRDtBQUNwRCxzRUFBd0Q7QUFDeEQsdUVBQXlEO0FBRXpELHNDQUFtRDtBQUduRDs7Ozs7OztHQU9HO0FBQ1UsUUFBQSx1Q0FBdUMsR0FBRyxVQUFVLENBQUMsc0JBQXNCLENBQUMsYUFBYSxDQUFDO0FBRXZHOzs7Ozs7Ozs7R0FTRztBQUNILFNBQWdCLGNBQWMsQ0FBQyxPQUEyQztJQUN4RSxPQUFPLE9BQU8sS0FBSyxTQUFTLElBQUksT0FBTyxDQUFDLGFBQWEsS0FBSywrQkFBc0IsQ0FBQyxPQUFPLENBQUM7QUFDM0YsQ0FBQztBQUVEOzs7Ozs7O0dBT0c7QUFDSCxTQUFnQix5QkFBeUIsQ0FDdkMsT0FBMkMsRUFDM0MsYUFBNEIsRUFDNUIsUUFBNkI7SUFFN0IsSUFBSSxRQUFRLEtBQUssU0FBUztRQUFFLE9BQU8sUUFBUSxDQUFDO0lBQzVDLElBQUksQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDL0MsT0FBTyxhQUFhLEtBQUssMkJBQWEsQ0FBQyxNQUFNLENBQUM7QUFDaEQsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQWdCLDZCQUE2QixDQUMzQyxPQUEyQyxFQUMzQyxrQkFBMkIsRUFDM0IsUUFBdUQ7SUFFdkQsSUFBSSxRQUFRLEtBQUssU0FBUztRQUFFLE9BQU8sUUFBUSxDQUFDO0lBQzVDLElBQUksQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxrQkFBa0I7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUN0RSxPQUFPLCtDQUF1QyxDQUFDO0FBQ2pELENBQUM7QUFFRDs7Ozs7Ozs7Ozs7R0FXRztBQUNVLFFBQUEsb0NBQW9DLEdBQUcsS0FBSyxDQUFDLGNBQWMsQ0FBQyx3QkFBd0IsQ0FBQztBQUVsRzs7OztHQUlHO0FBQ1UsUUFBQSx5Q0FBeUMsR0FBRyxLQUFLLENBQUMsY0FBYyxDQUFDLG1CQUFtQixDQUFDO0FBRWxHOzs7Ozs7O0dBT0c7QUFDVSxRQUFBLG9DQUFvQyxHQUFHLE9BQU8sQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDO0FBRW5GOzs7O0dBSUc7QUFDSCxTQUFnQiw0QkFBNEIsQ0FBQyxNQUE0QjtJQUN2RSxPQUFPLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxVQUFVLENBQUMsaUJBQWlCLENBQUMsQ0FBQztBQUN0RCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlIH0gZnJvbSBcIi4uL25hbWluZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4uL25hbWluZy1jb250ZXh0XCI7XG5cbi8qKlxuICogVGhlIENsb3VkRnJvbnQgdmlld2VyIHNlY3VyaXR5IHBvbGljeSB0aGF0IHNhdGlzZmllcyBTZWN1cml0eSBIdWJcbiAqIENsb3VkRnJvbnQuMTUuIFRoZSBjb250cm9sIGFjY2VwdHMgYFRMU3YxLjJfMjAyNWAgYW5kIGBUTFN2MS4zXzIwMjVgIG9ubHlcbiAqIChpdHMgYHNlY3VyaXR5UG9saWNpZXNgIHBhcmFtZXRlciBpcyBub3QgY3VzdG9taXphYmxlKSwgc28gdGhlIGRlZmF1bHQgcGlja3NcbiAqIHRoZSBUTFMgMS4yIGZsb29yIGZvciBjbGllbnQgY29tcGF0aWJpbGl0eSB3aGlsZSBzdGlsbCBwYXNzaW5nIHRoZSBjb250cm9sLlxuICpcbiAqIEBzZWUgaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL3NlY3VyaXR5aHViL2xhdGVzdC91c2VyZ3VpZGUvY2xvdWRmcm9udC1jb250cm9scy5odG1sXG4gKi9cbmV4cG9ydCBjb25zdCBSRUNPTU1FTkRFRF9DTE9VRF9GUk9OVF9TRUNVUklUWV9QT0xJQ1kgPSBjbG91ZGZyb250LlNlY3VyaXR5UG9saWN5UHJvdG9jb2wuVExTX1YxXzJfMjAyNTtcblxuLyoqXG4gKiBXaGV0aGVyIG9uZSBjb25zdHJ1Y3QgYXBwbGllcyB0aGUgU2VjdXJpdHkgSHViLWFsaWduZWQgZGVmYXVsdHMuXG4gKlxuICogVGhlIG5hbWluZyBjb250ZXh0IHNlbGVjdHMgdGhlbSwgYW5kIHRoZSBuYW1pbmcgcHJvZmlsZSBkZWNpZGVzIHdoaWNoIHNpZGUgb2ZcbiAqIHRoZSBtaWdyYXRpb24gYSBjb25zdW1lciBpcyBvbjogYSBkZXJpdmVkIGNvbnRleHQgaXMgdGhlIGxhYiBwYXRoLCB3aGVyZSB0aGVcbiAqIGRlZmF1bHRzIGFwcGx5LCB3aGlsZSBhIGxlZ2FjeSBjb250ZXh0IGlzIHRoZSBwaW5uZWQgcGF0aCB0aGF0IG11c3Qga2VlcFxuICogdG9kYXkncyB0ZW1wbGF0ZSBieXRlIGZvciBieXRlICh0aGUgQVQtTjMgbWlncmF0aW9uIHByb3BlcnR5KS4gQSBjb25zdW1lciB3aXRoXG4gKiBubyBjb250ZXh0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlIHRoaXMgY29udHJhY3QgZXhpc3RlZCwgc28gYSBsaXZlXG4gKiB0ZW1wbGF0ZSBzdGF5cyBieXRlLWlkZW50aWNhbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlY3VyZURlZmF1bHRzKGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgcmV0dXJuIGNvbnRleHQgIT09IHVuZGVmaW5lZCAmJiBjb250ZXh0Lm5hbWluZ1Byb2ZpbGUgPT09IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRDtcbn1cblxuLyoqXG4gKiBEeW5hbW9EQiBkZWxldGlvbiBwcm90ZWN0aW9uIChTZWN1cml0eSBIdWIgRHluYW1vREIuNikuXG4gKlxuICogVW5kZXIgYSBuYW1pbmcgY29udGV4dCB0aGUgZGVmYXVsdCBmb2xsb3dzIHRoZSByZXNvbHZlZCByZW1vdmFsIHBvbGljeTogYVxuICogUkVUQUlOIHRhYmxlIG91dGxpdmVzIGEgc3RhY2sgZGVsZXRpb24sIHNvIHByb3RlY3Rpb24gaXMgb247IGEgdGFibGUgd2l0aCBhbnlcbiAqIG90aGVyIHJlbW92YWwgcG9saWN5IGlzIGRlbGliZXJhdGVseSBkZXN0cnVjdGl2ZSwgc28gcHJvdGVjdGlvbiBzdGF5cyBvZmYgYW5kXG4gKiB0aGUgc3RhY2sgY2FuIHN0aWxsIGJlIHRvcm4gZG93biAodGhlIGxhYiByZW1vdmFsLXBvbGljeSBydWxpbmcpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbihcbiAgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB8IHVuZGVmaW5lZCxcbiAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeSxcbiAgZXhwbGljaXQ6IGJvb2xlYW4gfCB1bmRlZmluZWQsXG4pOiBib29sZWFuIHwgdW5kZWZpbmVkIHtcbiAgaWYgKGV4cGxpY2l0ICE9PSB1bmRlZmluZWQpIHJldHVybiBleHBsaWNpdDtcbiAgaWYgKCFzZWN1cmVEZWZhdWx0cyhjb250ZXh0KSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIHJlbW92YWxQb2xpY3kgPT09IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xufVxuXG4vKipcbiAqIENsb3VkRnJvbnQgYG1pbmltdW1Qcm90b2NvbFZlcnNpb25gIChTZWN1cml0eSBIdWIgQ2xvdWRGcm9udC4xNSkuXG4gKlxuICogVGhlIHByb3BlcnR5IG9ubHkgcmVuZGVycyBvbiBhIGRpc3RyaWJ1dGlvbiB0aGF0IGNhcnJpZXMgYSBjdXN0b21cbiAqIGNlcnRpZmljYXRlOyB3aXRob3V0IG9uZSBDbG91ZEZyb250IHNlcnZlcyB0aGUgZml4ZWQgZGVmYXVsdCBjZXJ0aWZpY2F0ZSBhbmRcbiAqIHRoZSBjb250cm9sIGRvZXMgbm90IGV2YWx1YXRlIHRoZSBkaXN0cmlidXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0TWluaW11bVByb3RvY29sVmVyc2lvbihcbiAgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB8IHVuZGVmaW5lZCxcbiAgY2VydGlmaWNhdGVQcmVzZW50OiBib29sZWFuLFxuICBleHBsaWNpdDogY2xvdWRmcm9udC5TZWN1cml0eVBvbGljeVByb3RvY29sIHwgdW5kZWZpbmVkLFxuKTogY2xvdWRmcm9udC5TZWN1cml0eVBvbGljeVByb3RvY29sIHwgdW5kZWZpbmVkIHtcbiAgaWYgKGV4cGxpY2l0ICE9PSB1bmRlZmluZWQpIHJldHVybiBleHBsaWNpdDtcbiAgaWYgKCFzZWN1cmVEZWZhdWx0cyhjb250ZXh0KSB8fCAhY2VydGlmaWNhdGVQcmVzZW50KSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gUkVDT01NRU5ERURfQ0xPVURfRlJPTlRfU0VDVVJJVFlfUE9MSUNZO1xufVxuXG4vKipcbiAqIFRoZSBSRVNUIGN1c3RvbS1kb21haW4gc2VjdXJpdHkgcG9saWN5IHRoYXQgc2F0aXNmaWVzIFNlY3VyaXR5IEh1YlxuICogQVBJR2F0ZXdheS4xMSBmb3IgYSByZWdpb25hbCBvciBwcml2YXRlIGVuZHBvaW50OiBUTFMgMS4zIGFuZCBUTFMgMS4yIHdpdGhcbiAqIHBlcmZlY3QgZm9yd2FyZCBzZWNyZWN5IGFuZCBwb3N0LXF1YW50dW0ga2V5IGV4Y2hhbmdlLlxuICpcbiAqIEl0IGlzIGFsc28gYSBjaXBoZXItcG9saWN5IGNoYW5nZSBmb3IgY2xpZW50cywgd2l0aCB0aGUgc2FtZSBjYXZlYXQgYXMgdGhlXG4gKiBDbG91ZEZyb250LjE1IDIwMjUgcG9saWNpZXM6IGEgY2xpZW50IHRoYXQgb25seSBuZWdvdGlhdGVzIGFuIG9sZGVyIFRMUyAxLjJcbiAqIGNpcGhlciBzdWl0ZSBpcyBleGNsdWRlZC4gQVBJIEdhdGV3YXkgcmVxdWlyZXMgYGVuZHBvaW50QWNjZXNzTW9kZTogU1RSSUNUYFxuICogYWxvbmdzaWRlIGFuIGVuaGFuY2VkIHBvbGljeS5cbiAqXG4gKiBAc2VlIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9zZWN1cml0eWh1Yi9sYXRlc3QvdXNlcmd1aWRlL2FwaWdhdGV3YXktY29udHJvbHMuaHRtbFxuICovXG5leHBvcnQgY29uc3QgUkVDT01NRU5ERURfUkVTVF9BUElfU0VDVVJJVFlfUE9MSUNZID0gYXBpZ3cuU2VjdXJpdHlQb2xpY3kuVExTMTNfMV8yX1BGU19QUV8yMDI1XzA5O1xuXG4vKipcbiAqIFRoZSBSRVNUIGN1c3RvbS1kb21haW4gc2VjdXJpdHkgcG9saWN5IHRoYXQgc2F0aXNmaWVzIEFQSUdhdGV3YXkuMTEgZm9yIGFuXG4gKiBlZGdlLW9wdGltaXplZCBlbmRwb2ludC4gQVBJIEdhdGV3YXkgcmVqZWN0cyB0aGUgcmVnaW9uYWwgcG9saWNpZXMgb24gYW4gZWRnZVxuICogZG9tYWluIGFuZCB2aWNlIHZlcnNhLlxuICovXG5leHBvcnQgY29uc3QgUkVDT01NRU5ERURfRURHRV9SRVNUX0FQSV9TRUNVUklUWV9QT0xJQ1kgPSBhcGlndy5TZWN1cml0eVBvbGljeS5UTFMxMl9QRlNfMjAyNV9FREdFO1xuXG4vKipcbiAqIFRoZSBzdHJvbmdlc3Qgc2VjdXJpdHkgcG9saWN5IGFuIEhUVFAgQVBJIGN1c3RvbSBkb21haW4gY2FuIGNhcnJ5LiBTZWN1cml0eVxuICogSHViIEFQSUdhdGV3YXkuMTEgcHJvZHVjZXMgYSBGQUlMRUQgZmluZGluZyBmb3IgZXZlcnkgY3VzdG9tIGRvbWFpbiBhdHRhY2hlZFxuICogdG8gYW4gSFRUUCBBUEksIHNvIG5vIHZhbHVlIHNhdGlzZmllcyB0aGUgY29udHJvbDsgQVBJIEdhdGV3YXkgdjIgb2ZmZXJzIG9ubHlcbiAqIHRoZSBsZWdhY3kgVExTIHBvbGljaWVzLCBhbmQgVExTIDEuMiBpcyB0aGUgc3Ryb25nZXIgb2YgdGhlIHR3by5cbiAqXG4gKiBAc2VlIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9zZWN1cml0eWh1Yi9sYXRlc3QvdXNlcmd1aWRlL2FwaWdhdGV3YXktY29udHJvbHMuaHRtbFxuICovXG5leHBvcnQgY29uc3QgUkVDT01NRU5ERURfSFRUUF9BUElfU0VDVVJJVFlfUE9MSUNZID0gYXBpZ3d2Mi5TZWN1cml0eVBvbGljeS5UTFNfMV8yO1xuXG4vKipcbiAqIFdoZXRoZXIgYW4gQVBJIEdhdGV3YXkgUkVTVCBzZWN1cml0eSBwb2xpY3kgaXMgb25lIG9mIHRoZSBlbmhhbmNlZFxuICogYFNlY3VyaXR5UG9saWN5XypgIHZhbHVlcy4gQW4gZW5oYW5jZWQgcG9saWN5IHJlcXVpcmVzIGFuIGVuZHBvaW50IGFjY2Vzc1xuICogbW9kZSwgYW5kIGEgbGVnYWN5IHBvbGljeSByZWplY3RzIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzRW5oYW5jZWRSZXN0U2VjdXJpdHlQb2xpY3kocG9saWN5OiBhcGlndy5TZWN1cml0eVBvbGljeSk6IGJvb2xlYW4ge1xuICByZXR1cm4gU3RyaW5nKHBvbGljeSkuc3RhcnRzV2l0aChcIlNlY3VyaXR5UG9saWN5X1wiKTtcbn1cbiJdfQ==