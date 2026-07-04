/**
 * Regional WAFv2 options for API Gateway REST API stages.
 *
 * AppTheory intentionally scopes this surface to API Gateway REST API v1
 * stages, whose supported WAF resource ARN shape is:
 * `arn:${partition}:apigateway:${region}::/restapis/${apiId}/stages/${stageName}`.
 *
 * API Gateway v2 HTTP API stages are not exposed through this construct
 * because their `/apis/.../stages/...` ARN shape is not a supported regional
 * WAFv2 association target.
 */
export interface AppTheoryRegionalWafOptions {
  /**
   * Existing regional WAFv2 WebACL ARN to associate with the REST API stage.
   *
   * When omitted, AppTheory creates a regional WebACL with AWS managed
   * baseline rules.
   * @default undefined
   */
  readonly webAclArn?: string;

  /**
   * WebACL name when AppTheory creates one.
   * @default derived from apiName
   */
  readonly name?: string;

  /**
   * CloudWatch metric name for the WebACL.
   * @default derived from apiName
   */
  readonly metricName?: string;

  /**
   * Optional request rate limit rule threshold per five-minute window.
   * @default undefined
   */
  readonly rateLimit?: number;
}
