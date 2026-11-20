import { RemovalPolicy } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import type { AppTheoryNamingContext } from "../naming-context";
/**
 * The CloudFront viewer security policy that satisfies Security Hub
 * CloudFront.15. The control accepts `TLSv1.2_2025` and `TLSv1.3_2025` only
 * (its `securityPolicies` parameter is not customizable), so the default picks
 * the TLS 1.2 floor for client compatibility while still passing the control.
 *
 * @see https://docs.aws.amazon.com/securityhub/latest/userguide/cloudfront-controls.html
 */
export declare const RECOMMENDED_CLOUD_FRONT_SECURITY_POLICY = cloudfront.SecurityPolicyProtocol.TLS_V1_2_2025;
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
export declare function secureDefaults(context: AppTheoryNamingContext | undefined): boolean;
/**
 * DynamoDB deletion protection (Security Hub DynamoDB.6).
 *
 * Under a naming context the default follows the resolved removal policy: a
 * RETAIN table outlives a stack deletion, so protection is on; a table with any
 * other removal policy is deliberately destructive, so protection stays off and
 * the stack can still be torn down (the lab removal-policy ruling).
 */
export declare function defaultDeletionProtection(context: AppTheoryNamingContext | undefined, removalPolicy: RemovalPolicy, explicit: boolean | undefined): boolean | undefined;
/**
 * CloudFront `minimumProtocolVersion` (Security Hub CloudFront.15).
 *
 * The property only renders on a distribution that carries a custom
 * certificate; without one CloudFront serves the fixed default certificate and
 * the control does not evaluate the distribution.
 */
export declare function defaultMinimumProtocolVersion(context: AppTheoryNamingContext | undefined, certificatePresent: boolean, explicit: cloudfront.SecurityPolicyProtocol | undefined): cloudfront.SecurityPolicyProtocol | undefined;
/**
 * The REST custom-domain security policy that satisfies Security Hub
 * APIGateway.11 for a regional or private endpoint: TLS 1.3 and TLS 1.2 with
 * perfect forward secrecy and post-quantum key exchange.
 *
 * @see https://docs.aws.amazon.com/securityhub/latest/userguide/apigateway-controls.html
 */
export declare const RECOMMENDED_REST_API_SECURITY_POLICY = apigw.SecurityPolicy.TLS13_1_2_PFS_PQ_2025_09;
/**
 * The REST custom-domain security policy that satisfies APIGateway.11 for an
 * edge-optimized endpoint. API Gateway rejects the regional policies on an edge
 * domain and vice versa.
 */
export declare const RECOMMENDED_EDGE_REST_API_SECURITY_POLICY = apigw.SecurityPolicy.TLS12_PFS_2025_EDGE;
/**
 * The strongest security policy an HTTP API custom domain can carry. Security
 * Hub APIGateway.11 produces a FAILED finding for every custom domain attached
 * to an HTTP API, so no value satisfies the control; API Gateway v2 offers only
 * the legacy TLS policies, and TLS 1.2 is the stronger of the two.
 *
 * @see https://docs.aws.amazon.com/securityhub/latest/userguide/apigateway-controls.html
 */
export declare const RECOMMENDED_HTTP_API_SECURITY_POLICY = apigwv2.SecurityPolicy.TLS_1_2;
/**
 * Whether an API Gateway REST security policy is one of the enhanced
 * `SecurityPolicy_*` values. An enhanced policy requires an endpoint access
 * mode, and a legacy policy rejects one.
 */
export declare function isEnhancedRestSecurityPolicy(policy: apigw.SecurityPolicy): boolean;
