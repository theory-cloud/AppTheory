/**
 * CloudFront standard-logging output format for a CloudWatch Logs destination.
 *
 * The resource-naming contract settles this from `DescribeConfigurationTemplates`
 * (contract section 3, 2026-11-19): CloudFront `ACCESS_LOGS` to a CloudWatch Logs
 * (`CWL`) destination accepts only `plain` and `json`, and `w3c` is S3-only. The
 * evidence is `evidence/cloudfront-cwl-output-format-2026-11-19.json` in the
 * contract. The format cannot be changed later without replacing the delivery
 * destination.
 */
export enum AppTheoryCloudFrontLogFormat {
  /**
   * JSON records.
   */
  JSON = "json",

  /**
   * W3C extended log format.
   * @deprecated not accepted for a CloudWatch Logs destination: the CloudFront
   * `ACCESS_LOGS` to `CWL` template allows only `plain` and `json` (contract
   * section 3). Use `JSON`.
   */
  W3C = "w3c",
}
