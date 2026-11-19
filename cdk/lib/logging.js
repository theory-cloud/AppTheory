"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryCloudFrontLogFormat = void 0;
/**
 * CloudFront standard-logging output format for a CloudWatch Logs destination.
 *
 * The resource-naming contract settles this from `DescribeConfigurationTemplates`.
 * Until that lab evidence exists, AppTheory defaults to `W3C`. The format cannot
 * be changed later without replacing the delivery destination.
 */
var AppTheoryCloudFrontLogFormat;
(function (AppTheoryCloudFrontLogFormat) {
    /**
     * JSON records.
     */
    AppTheoryCloudFrontLogFormat["JSON"] = "json";
    /**
     * W3C extended log format.
     */
    AppTheoryCloudFrontLogFormat["W3C"] = "w3c";
})(AppTheoryCloudFrontLogFormat || (exports.AppTheoryCloudFrontLogFormat = AppTheoryCloudFrontLogFormat = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9nZ2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImxvZ2dpbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUE7Ozs7OztHQU1HO0FBQ0gsSUFBWSw0QkFVWDtBQVZELFdBQVksNEJBQTRCO0lBQ3RDOztPQUVHO0lBQ0gsNkNBQWEsQ0FBQTtJQUViOztPQUVHO0lBQ0gsMkNBQVcsQ0FBQTtBQUNiLENBQUMsRUFWVyw0QkFBNEIsNENBQTVCLDRCQUE0QixRQVV2QyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ2xvdWRGcm9udCBzdGFuZGFyZC1sb2dnaW5nIG91dHB1dCBmb3JtYXQgZm9yIGEgQ2xvdWRXYXRjaCBMb2dzIGRlc3RpbmF0aW9uLlxuICpcbiAqIFRoZSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3Qgc2V0dGxlcyB0aGlzIGZyb20gYERlc2NyaWJlQ29uZmlndXJhdGlvblRlbXBsYXRlc2AuXG4gKiBVbnRpbCB0aGF0IGxhYiBldmlkZW5jZSBleGlzdHMsIEFwcFRoZW9yeSBkZWZhdWx0cyB0byBgVzNDYC4gVGhlIGZvcm1hdCBjYW5ub3RcbiAqIGJlIGNoYW5nZWQgbGF0ZXIgd2l0aG91dCByZXBsYWNpbmcgdGhlIGRlbGl2ZXJ5IGRlc3RpbmF0aW9uLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0IHtcbiAgLyoqXG4gICAqIEpTT04gcmVjb3Jkcy5cbiAgICovXG4gIEpTT04gPSBcImpzb25cIixcblxuICAvKipcbiAgICogVzNDIGV4dGVuZGVkIGxvZyBmb3JtYXQuXG4gICAqL1xuICBXM0MgPSBcInczY1wiLFxufVxuIl19