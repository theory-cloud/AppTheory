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
exports.AppTheoryBucket = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const constructs_1 = require("constructs");
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
const secure_defaults_1 = require("./private/secure-defaults");
/**
 * An S3 bucket whose physical name comes from the resource-naming contract.
 *
 * With a derived profile the bucket uses the account-regional namespace and the
 * contract's prefix. With a legacy profile a pin supplies the full name
 * verbatim, and a generated entry sets no name at all so CloudFormation keeps
 * today's name and global namespace. The pinned aws-cdk-lib L2
 * (`aws-cdk-lib` 2.277.0) exposes `bucketNamespace` and `bucketNamePrefix`, so
 * no L1 property override is needed; CloudFormation appends
 * `-{account}-{region}-an` to the prefix.
 *
 * Under a derived profile the bucket also enforces TLS (`enforceSSL: true`),
 * which is the bucket-policy condition Security Hub S3.5 asks for. An explicit
 * `enforceSSL` still wins. Server access logging (S3.9) stays opt-in through the
 * inherited `serverAccessLogsBucket` and `serverAccessLogsPrefix` props, because
 * a log target costs money; the target bucket is the caller's and consumes no
 * naming entry (resource-naming contract section 4).
 */
class AppTheoryBucket extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryBucket", version: "7.5.0" };
    /**
     * The bucket.
     */
    bucket;
    constructor(scope, id, props) {
        super(scope, id);
        const { namingContext, logical, ...bucketProps } = props;
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryBucket", "bucketName", "s3_bucket", logical, bucketProps.bucketName !== undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryBucket", "bucketNamePrefix", "s3_bucket", logical, bucketProps.bucketNamePrefix !== undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryBucket", "bucketNamespace", "s3_bucket", logical, bucketProps.bucketNamespace !== undefined);
        const composed = namingContext.physicalName("s3_bucket", logical);
        const resolvedProps = {
            ...bucketProps,
            enforceSSL: bucketProps.enforceSSL ?? ((0, secure_defaults_1.secureDefaults)(namingContext) ? true : undefined),
        };
        if (composed.generated) {
            if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
                throw new Error(`AppTheoryBucket cannot honor an account-regional prefix when s3_bucket:${logical} is a generated entry; CloudFormation generates the name and the bucket keeps the global namespace`);
            }
            this.bucket = new s3.Bucket(this, "Bucket", { ...resolvedProps });
        }
        else if (composed.pinned) {
            if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
                throw new Error(`AppTheoryBucket cannot honor an account-regional prefix when the pin for s3_bucket:${logical} owns the name`);
            }
            this.bucket = new s3.Bucket(this, "Bucket", { ...resolvedProps, bucketName: composed.name });
        }
        else {
            if (composed.bucketNamePrefix === undefined) {
                throw new Error(`AppTheoryBucket requires an account-regional prefix for s3_bucket:${logical}`);
            }
            this.bucket = new s3.Bucket(this, "Bucket", {
                ...resolvedProps,
                bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
                bucketNamePrefix: composed.bucketNamePrefix,
            });
        }
        // Contract section 11.4: declare the resource carrying the composed name.
        namingContext.declareName("s3_bucket", logical, this.bucket);
    }
}
exports.AppTheoryBucket = AppTheoryBucket;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWJ1Y2tldC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm5hbWluZy1idWNrZXQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLHVEQUF5QztBQUN6QywyQ0FBdUM7QUFHdkMseUVBQW9FO0FBQ3BFLCtEQUEyRDtBQWlCM0Q7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBaUJHO0FBQ0gsTUFBYSxlQUFnQixTQUFRLHNCQUFTOztJQUM1Qzs7T0FFRztJQUNhLE1BQU0sQ0FBWTtJQUVsQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTJCO1FBQ25FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsR0FBRyxXQUFXLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFDekQsSUFBQSx5Q0FBa0IsRUFBQyxhQUFhLEVBQUUsaUJBQWlCLEVBQUUsWUFBWSxFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsV0FBVyxDQUFDLFVBQVUsS0FBSyxTQUFTLENBQUMsQ0FBQztRQUMvSCxJQUFBLHlDQUFrQixFQUNoQixhQUFhLEVBQ2IsaUJBQWlCLEVBQ2pCLGtCQUFrQixFQUNsQixXQUFXLEVBQ1gsT0FBTyxFQUNQLFdBQVcsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLENBQzNDLENBQUM7UUFDRixJQUFBLHlDQUFrQixFQUNoQixhQUFhLEVBQ2IsaUJBQWlCLEVBQ2pCLGlCQUFpQixFQUNqQixXQUFXLEVBQ1gsT0FBTyxFQUNQLFdBQVcsQ0FBQyxlQUFlLEtBQUssU0FBUyxDQUMxQyxDQUFDO1FBQ0YsTUFBTSxRQUFRLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxXQUFXLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDbEUsTUFBTSxhQUFhLEdBQUc7WUFDcEIsR0FBRyxXQUFXO1lBQ2QsVUFBVSxFQUFFLFdBQVcsQ0FBQyxVQUFVLElBQUksQ0FBQyxJQUFBLGdDQUFjLEVBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1NBQ3pGLENBQUM7UUFFRixJQUFJLFFBQVEsQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUN2QixJQUFJLFdBQVcsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLElBQUksV0FBVyxDQUFDLGVBQWUsS0FBSyxTQUFTLEVBQUUsQ0FBQztnQkFDNUYsTUFBTSxJQUFJLEtBQUssQ0FDYiwwRUFBMEUsT0FBTyxvR0FBb0csQ0FDdEwsQ0FBQztZQUNKLENBQUM7WUFDRCxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLEVBQUUsR0FBRyxhQUFhLEVBQUUsQ0FBQyxDQUFDO1FBQ3BFLENBQUM7YUFBTSxJQUFJLFFBQVEsQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUMzQixJQUFJLFdBQVcsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLElBQUksV0FBVyxDQUFDLGVBQWUsS0FBSyxTQUFTLEVBQUUsQ0FBQztnQkFDNUYsTUFBTSxJQUFJLEtBQUssQ0FDYixzRkFBc0YsT0FBTyxnQkFBZ0IsQ0FDOUcsQ0FBQztZQUNKLENBQUM7WUFDRCxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLEVBQUUsR0FBRyxhQUFhLEVBQUUsVUFBVSxFQUFFLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBQy9GLENBQUM7YUFBTSxDQUFDO1lBQ04sSUFBSSxRQUFRLENBQUMsZ0JBQWdCLEtBQUssU0FBUyxFQUFFLENBQUM7Z0JBQzVDLE1BQU0sSUFBSSxLQUFLLENBQUMscUVBQXFFLE9BQU8sRUFBRSxDQUFDLENBQUM7WUFDbEcsQ0FBQztZQUNELElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7Z0JBQzFDLEdBQUcsYUFBYTtnQkFDaEIsZUFBZSxFQUFFLEVBQUUsQ0FBQyxlQUFlLENBQUMsZ0JBQWdCO2dCQUNwRCxnQkFBZ0IsRUFBRSxRQUFRLENBQUMsZ0JBQWdCO2FBQzVDLENBQUMsQ0FBQztRQUNMLENBQUM7UUFDRCwwRUFBMEU7UUFDMUUsYUFBYSxDQUFDLFdBQVcsQ0FBQyxXQUFXLEVBQUUsT0FBTyxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUMvRCxDQUFDOztBQTNESCwwQ0E0REMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgc2VjdXJlRGVmYXVsdHMgfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIGFuIGBBcHBUaGVvcnlCdWNrZXRgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUJ1Y2tldFByb3BzIGV4dGVuZHMgczMuQnVja2V0UHJvcHMge1xuICAvKipcbiAgICogVGhlIG5hbWluZyBjb250ZXh0IHRoYXQgZGVyaXZlcyB0aGUgYnVja2V0IG5hbWUuXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgYnVja2V0J3MgbG9naWNhbCBuYW1lLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbDogc3RyaW5nO1xufVxuXG4vKipcbiAqIEFuIFMzIGJ1Y2tldCB3aG9zZSBwaHlzaWNhbCBuYW1lIGNvbWVzIGZyb20gdGhlIHJlc291cmNlLW5hbWluZyBjb250cmFjdC5cbiAqXG4gKiBXaXRoIGEgZGVyaXZlZCBwcm9maWxlIHRoZSBidWNrZXQgdXNlcyB0aGUgYWNjb3VudC1yZWdpb25hbCBuYW1lc3BhY2UgYW5kIHRoZVxuICogY29udHJhY3QncyBwcmVmaXguIFdpdGggYSBsZWdhY3kgcHJvZmlsZSBhIHBpbiBzdXBwbGllcyB0aGUgZnVsbCBuYW1lXG4gKiB2ZXJiYXRpbSwgYW5kIGEgZ2VuZXJhdGVkIGVudHJ5IHNldHMgbm8gbmFtZSBhdCBhbGwgc28gQ2xvdWRGb3JtYXRpb24ga2VlcHNcbiAqIHRvZGF5J3MgbmFtZSBhbmQgZ2xvYmFsIG5hbWVzcGFjZS4gVGhlIHBpbm5lZCBhd3MtY2RrLWxpYiBMMlxuICogKGBhd3MtY2RrLWxpYmAgMi4yNzcuMCkgZXhwb3NlcyBgYnVja2V0TmFtZXNwYWNlYCBhbmQgYGJ1Y2tldE5hbWVQcmVmaXhgLCBzb1xuICogbm8gTDEgcHJvcGVydHkgb3ZlcnJpZGUgaXMgbmVlZGVkOyBDbG91ZEZvcm1hdGlvbiBhcHBlbmRzXG4gKiBgLXthY2NvdW50fS17cmVnaW9ufS1hbmAgdG8gdGhlIHByZWZpeC5cbiAqXG4gKiBVbmRlciBhIGRlcml2ZWQgcHJvZmlsZSB0aGUgYnVja2V0IGFsc28gZW5mb3JjZXMgVExTIChgZW5mb3JjZVNTTDogdHJ1ZWApLFxuICogd2hpY2ggaXMgdGhlIGJ1Y2tldC1wb2xpY3kgY29uZGl0aW9uIFNlY3VyaXR5IEh1YiBTMy41IGFza3MgZm9yLiBBbiBleHBsaWNpdFxuICogYGVuZm9yY2VTU0xgIHN0aWxsIHdpbnMuIFNlcnZlciBhY2Nlc3MgbG9nZ2luZyAoUzMuOSkgc3RheXMgb3B0LWluIHRocm91Z2ggdGhlXG4gKiBpbmhlcml0ZWQgYHNlcnZlckFjY2Vzc0xvZ3NCdWNrZXRgIGFuZCBgc2VydmVyQWNjZXNzTG9nc1ByZWZpeGAgcHJvcHMsIGJlY2F1c2VcbiAqIGEgbG9nIHRhcmdldCBjb3N0cyBtb25leTsgdGhlIHRhcmdldCBidWNrZXQgaXMgdGhlIGNhbGxlcidzIGFuZCBjb25zdW1lcyBub1xuICogbmFtaW5nIGVudHJ5IChyZXNvdXJjZS1uYW1pbmcgY29udHJhY3Qgc2VjdGlvbiA0KS5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUJ1Y2tldCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBUaGUgYnVja2V0LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldDogczMuQnVja2V0O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlCdWNrZXRQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCB7IG5hbWluZ0NvbnRleHQsIGxvZ2ljYWwsIC4uLmJ1Y2tldFByb3BzIH0gPSBwcm9wcztcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUobmFtaW5nQ29udGV4dCwgXCJBcHBUaGVvcnlCdWNrZXRcIiwgXCJidWNrZXROYW1lXCIsIFwiczNfYnVja2V0XCIsIGxvZ2ljYWwsIGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKFxuICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgIFwiQXBwVGhlb3J5QnVja2V0XCIsXG4gICAgICBcImJ1Y2tldE5hbWVQcmVmaXhcIixcbiAgICAgIFwiczNfYnVja2V0XCIsXG4gICAgICBsb2dpY2FsLFxuICAgICAgYnVja2V0UHJvcHMuYnVja2V0TmFtZVByZWZpeCAhPT0gdW5kZWZpbmVkLFxuICAgICk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKFxuICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgIFwiQXBwVGhlb3J5QnVja2V0XCIsXG4gICAgICBcImJ1Y2tldE5hbWVzcGFjZVwiLFxuICAgICAgXCJzM19idWNrZXRcIixcbiAgICAgIGxvZ2ljYWwsXG4gICAgICBidWNrZXRQcm9wcy5idWNrZXROYW1lc3BhY2UgIT09IHVuZGVmaW5lZCxcbiAgICApO1xuICAgIGNvbnN0IGNvbXBvc2VkID0gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJzM19idWNrZXRcIiwgbG9naWNhbCk7XG4gICAgY29uc3QgcmVzb2x2ZWRQcm9wcyA9IHtcbiAgICAgIC4uLmJ1Y2tldFByb3BzLFxuICAgICAgZW5mb3JjZVNTTDogYnVja2V0UHJvcHMuZW5mb3JjZVNTTCA/PyAoc2VjdXJlRGVmYXVsdHMobmFtaW5nQ29udGV4dCkgPyB0cnVlIDogdW5kZWZpbmVkKSxcbiAgICB9O1xuXG4gICAgaWYgKGNvbXBvc2VkLmdlbmVyYXRlZCkge1xuICAgICAgaWYgKGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWVQcmVmaXggIT09IHVuZGVmaW5lZCB8fCBidWNrZXRQcm9wcy5idWNrZXROYW1lc3BhY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeUJ1Y2tldCBjYW5ub3QgaG9ub3IgYW4gYWNjb3VudC1yZWdpb25hbCBwcmVmaXggd2hlbiBzM19idWNrZXQ6JHtsb2dpY2FsfSBpcyBhIGdlbmVyYXRlZCBlbnRyeTsgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lIGFuZCB0aGUgYnVja2V0IGtlZXBzIHRoZSBnbG9iYWwgbmFtZXNwYWNlYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkJ1Y2tldFwiLCB7IC4uLnJlc29sdmVkUHJvcHMgfSk7XG4gICAgfSBlbHNlIGlmIChjb21wb3NlZC5waW5uZWQpIHtcbiAgICAgIGlmIChidWNrZXRQcm9wcy5idWNrZXROYW1lUHJlZml4ICE9PSB1bmRlZmluZWQgfHwgYnVja2V0UHJvcHMuYnVja2V0TmFtZXNwYWNlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlCdWNrZXQgY2Fubm90IGhvbm9yIGFuIGFjY291bnQtcmVnaW9uYWwgcHJlZml4IHdoZW4gdGhlIHBpbiBmb3IgczNfYnVja2V0OiR7bG9naWNhbH0gb3ducyB0aGUgbmFtZWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgXCJCdWNrZXRcIiwgeyAuLi5yZXNvbHZlZFByb3BzLCBidWNrZXROYW1lOiBjb21wb3NlZC5uYW1lIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoY29tcG9zZWQuYnVja2V0TmFtZVByZWZpeCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5QnVja2V0IHJlcXVpcmVzIGFuIGFjY291bnQtcmVnaW9uYWwgcHJlZml4IGZvciBzM19idWNrZXQ6JHtsb2dpY2FsfWApO1xuICAgICAgfVxuICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiQnVja2V0XCIsIHtcbiAgICAgICAgLi4ucmVzb2x2ZWRQcm9wcyxcbiAgICAgICAgYnVja2V0TmFtZXNwYWNlOiBzMy5CdWNrZXROYW1lc3BhY2UuQUNDT1VOVF9SRUdJT05BTCxcbiAgICAgICAgYnVja2V0TmFtZVByZWZpeDogY29tcG9zZWQuYnVja2V0TmFtZVByZWZpeCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICAvLyBDb250cmFjdCBzZWN0aW9uIDExLjQ6IGRlY2xhcmUgdGhlIHJlc291cmNlIGNhcnJ5aW5nIHRoZSBjb21wb3NlZCBuYW1lLlxuICAgIG5hbWluZ0NvbnRleHQuZGVjbGFyZU5hbWUoXCJzM19idWNrZXRcIiwgbG9naWNhbCwgdGhpcy5idWNrZXQpO1xuICB9XG59XG4iXX0=