import { RemovalPolicy } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";

import { AppTheoryNamingProfile } from "../naming";
import type { AppTheoryNamingContext } from "../naming-context";

/**
 * The CloudFront viewer security policy that satisfies Security Hub
 * CloudFront.15. The control accepts `TLSv1.2_2025` and `TLSv1.3_2025` only
 * (its `securityPolicies` parameter is not customizable), so the default picks
 * the TLS 1.2 floor for client compatibility while still passing the control.
 *
 * @see https://docs.aws.amazon.com/securityhub/latest/userguide/cloudfront-controls.html
 */
export const RECOMMENDED_CLOUD_FRONT_SECURITY_POLICY = cloudfront.SecurityPolicyProtocol.TLS_V1_2_2025;

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
export function secureDefaults(context: AppTheoryNamingContext | undefined): boolean {
  return context !== undefined && context.namingProfile === AppTheoryNamingProfile.DERIVED;
}

/**
 * DynamoDB deletion protection (Security Hub DynamoDB.6).
 *
 * Under a naming context the default follows the resolved removal policy: a
 * RETAIN table outlives a stack deletion, so protection is on; a table with any
 * other removal policy is deliberately destructive, so protection stays off and
 * the stack can still be torn down (the lab removal-policy ruling).
 */
export function defaultDeletionProtection(
  context: AppTheoryNamingContext | undefined,
  removalPolicy: RemovalPolicy,
  explicit: boolean | undefined,
): boolean | undefined {
  if (explicit !== undefined) return explicit;
  if (!secureDefaults(context)) return undefined;
  return removalPolicy === RemovalPolicy.RETAIN;
}

/**
 * CloudFront `minimumProtocolVersion` (Security Hub CloudFront.15).
 *
 * The property only renders on a distribution that carries a custom
 * certificate; without one CloudFront serves the fixed default certificate and
 * the control does not evaluate the distribution.
 */
export function defaultMinimumProtocolVersion(
  context: AppTheoryNamingContext | undefined,
  certificatePresent: boolean,
  explicit: cloudfront.SecurityPolicyProtocol | undefined,
): cloudfront.SecurityPolicyProtocol | undefined {
  if (explicit !== undefined) return explicit;
  if (!secureDefaults(context) || !certificatePresent) return undefined;
  return RECOMMENDED_CLOUD_FRONT_SECURITY_POLICY;
}
