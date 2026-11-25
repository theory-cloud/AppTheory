"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryCloudFrontLogFormat = void 0;
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
var AppTheoryCloudFrontLogFormat;
(function (AppTheoryCloudFrontLogFormat) {
    /**
     * JSON records.
     */
    AppTheoryCloudFrontLogFormat["JSON"] = "json";
    /**
     * W3C extended log format.
     * @deprecated not accepted for a CloudWatch Logs destination: the CloudFront
     * `ACCESS_LOGS` to `CWL` template allows only `plain` and `json` (contract
     * section 3). Use `JSON`.
     */
    AppTheoryCloudFrontLogFormat["W3C"] = "w3c";
})(AppTheoryCloudFrontLogFormat || (exports.AppTheoryCloudFrontLogFormat = AppTheoryCloudFrontLogFormat = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9nZ2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImxvZ2dpbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUE7Ozs7Ozs7OztHQVNHO0FBQ0gsSUFBWSw0QkFhWDtBQWJELFdBQVksNEJBQTRCO0lBQ3RDOztPQUVHO0lBQ0gsNkNBQWEsQ0FBQTtJQUViOzs7OztPQUtHO0lBQ0gsMkNBQVcsQ0FBQTtBQUNiLENBQUMsRUFiVyw0QkFBNEIsNENBQTVCLDRCQUE0QixRQWF2QyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ2xvdWRGcm9udCBzdGFuZGFyZC1sb2dnaW5nIG91dHB1dCBmb3JtYXQgZm9yIGEgQ2xvdWRXYXRjaCBMb2dzIGRlc3RpbmF0aW9uLlxuICpcbiAqIFRoZSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3Qgc2V0dGxlcyB0aGlzIGZyb20gYERlc2NyaWJlQ29uZmlndXJhdGlvblRlbXBsYXRlc2BcbiAqIChjb250cmFjdCBzZWN0aW9uIDMsIDIwMjYtMTEtMTkpOiBDbG91ZEZyb250IGBBQ0NFU1NfTE9HU2AgdG8gYSBDbG91ZFdhdGNoIExvZ3NcbiAqIChgQ1dMYCkgZGVzdGluYXRpb24gYWNjZXB0cyBvbmx5IGBwbGFpbmAgYW5kIGBqc29uYCwgYW5kIGB3M2NgIGlzIFMzLW9ubHkuIFRoZVxuICogZXZpZGVuY2UgaXMgYGV2aWRlbmNlL2Nsb3VkZnJvbnQtY3dsLW91dHB1dC1mb3JtYXQtMjAyNi0xMS0xOS5qc29uYCBpbiB0aGVcbiAqIGNvbnRyYWN0LiBUaGUgZm9ybWF0IGNhbm5vdCBiZSBjaGFuZ2VkIGxhdGVyIHdpdGhvdXQgcmVwbGFjaW5nIHRoZSBkZWxpdmVyeVxuICogZGVzdGluYXRpb24uXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQge1xuICAvKipcbiAgICogSlNPTiByZWNvcmRzLlxuICAgKi9cbiAgSlNPTiA9IFwianNvblwiLFxuXG4gIC8qKlxuICAgKiBXM0MgZXh0ZW5kZWQgbG9nIGZvcm1hdC5cbiAgICogQGRlcHJlY2F0ZWQgbm90IGFjY2VwdGVkIGZvciBhIENsb3VkV2F0Y2ggTG9ncyBkZXN0aW5hdGlvbjogdGhlIENsb3VkRnJvbnRcbiAgICogYEFDQ0VTU19MT0dTYCB0byBgQ1dMYCB0ZW1wbGF0ZSBhbGxvd3Mgb25seSBgcGxhaW5gIGFuZCBganNvbmAgKGNvbnRyYWN0XG4gICAqIHNlY3Rpb24gMykuIFVzZSBgSlNPTmAuXG4gICAqL1xuICBXM0MgPSBcInczY1wiLFxufVxuIl19