/**
 * CloudFront standard-logging output format for a CloudWatch Logs destination.
 *
 * The resource-naming contract settles this from `DescribeConfigurationTemplates`.
 * Until that lab evidence exists, AppTheory defaults to `W3C`. The format cannot
 * be changed later without replacing the delivery destination.
 */
export declare enum AppTheoryCloudFrontLogFormat {
    /**
     * JSON records.
     */
    JSON = "json",
    /**
     * W3C extended log format.
     */
    W3C = "w3c"
}
