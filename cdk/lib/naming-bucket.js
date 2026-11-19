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
 */
class AppTheoryBucket extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryBucket", version: "7.4.0" };
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
        if (composed.generated) {
            if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
                throw new Error(`AppTheoryBucket cannot honor an account-regional prefix when s3_bucket:${logical} is a generated entry; CloudFormation generates the name and the bucket keeps the global namespace`);
            }
            this.bucket = new s3.Bucket(this, "Bucket", { ...bucketProps });
            return;
        }
        if (composed.pinned) {
            if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
                throw new Error(`AppTheoryBucket cannot honor an account-regional prefix when the pin for s3_bucket:${logical} owns the name`);
            }
            this.bucket = new s3.Bucket(this, "Bucket", { ...bucketProps, bucketName: composed.name });
            return;
        }
        if (composed.bucketNamePrefix === undefined) {
            throw new Error(`AppTheoryBucket requires an account-regional prefix for s3_bucket:${logical}`);
        }
        this.bucket = new s3.Bucket(this, "Bucket", {
            ...bucketProps,
            bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
            bucketNamePrefix: composed.bucketNamePrefix,
        });
    }
}
exports.AppTheoryBucket = AppTheoryBucket;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWJ1Y2tldC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm5hbWluZy1idWNrZXQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLHVEQUF5QztBQUN6QywyQ0FBdUM7QUFHdkMseUVBQW9FO0FBaUJwRTs7Ozs7Ozs7OztHQVVHO0FBQ0gsTUFBYSxlQUFnQixTQUFRLHNCQUFTOztJQUM1Qzs7T0FFRztJQUNhLE1BQU0sQ0FBWTtJQUVsQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTJCO1FBQ25FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsR0FBRyxXQUFXLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFDekQsSUFBQSx5Q0FBa0IsRUFBQyxhQUFhLEVBQUUsaUJBQWlCLEVBQUUsWUFBWSxFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsV0FBVyxDQUFDLFVBQVUsS0FBSyxTQUFTLENBQUMsQ0FBQztRQUMvSCxJQUFBLHlDQUFrQixFQUNoQixhQUFhLEVBQ2IsaUJBQWlCLEVBQ2pCLGtCQUFrQixFQUNsQixXQUFXLEVBQ1gsT0FBTyxFQUNQLFdBQVcsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLENBQzNDLENBQUM7UUFDRixJQUFBLHlDQUFrQixFQUNoQixhQUFhLEVBQ2IsaUJBQWlCLEVBQ2pCLGlCQUFpQixFQUNqQixXQUFXLEVBQ1gsT0FBTyxFQUNQLFdBQVcsQ0FBQyxlQUFlLEtBQUssU0FBUyxDQUMxQyxDQUFDO1FBQ0YsTUFBTSxRQUFRLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxXQUFXLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFFbEUsSUFBSSxRQUFRLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDdkIsSUFBSSxXQUFXLENBQUMsZ0JBQWdCLEtBQUssU0FBUyxJQUFJLFdBQVcsQ0FBQyxlQUFlLEtBQUssU0FBUyxFQUFFLENBQUM7Z0JBQzVGLE1BQU0sSUFBSSxLQUFLLENBQ2IsMEVBQTBFLE9BQU8sb0dBQW9HLENBQ3RMLENBQUM7WUFDSixDQUFDO1lBQ0QsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxFQUFFLEdBQUcsV0FBVyxFQUFFLENBQUMsQ0FBQztZQUNoRSxPQUFPO1FBQ1QsQ0FBQztRQUVELElBQUksUUFBUSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ3BCLElBQUksV0FBVyxDQUFDLGdCQUFnQixLQUFLLFNBQVMsSUFBSSxXQUFXLENBQUMsZUFBZSxLQUFLLFNBQVMsRUFBRSxDQUFDO2dCQUM1RixNQUFNLElBQUksS0FBSyxDQUNiLHNGQUFzRixPQUFPLGdCQUFnQixDQUM5RyxDQUFDO1lBQ0osQ0FBQztZQUNELElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsRUFBRSxHQUFHLFdBQVcsRUFBRSxVQUFVLEVBQUUsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7WUFDM0YsT0FBTztRQUNULENBQUM7UUFFRCxJQUFJLFFBQVEsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUM1QyxNQUFNLElBQUksS0FBSyxDQUFDLHFFQUFxRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQ2xHLENBQUM7UUFDRCxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFO1lBQzFDLEdBQUcsV0FBVztZQUNkLGVBQWUsRUFBRSxFQUFFLENBQUMsZUFBZSxDQUFDLGdCQUFnQjtZQUNwRCxnQkFBZ0IsRUFBRSxRQUFRLENBQUMsZ0JBQWdCO1NBQzVDLENBQUMsQ0FBQztJQUNMLENBQUM7O0FBekRILDBDQTBEQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgYW4gYEFwcFRoZW9yeUJ1Y2tldGAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5QnVja2V0UHJvcHMgZXh0ZW5kcyBzMy5CdWNrZXRQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtaW5nIGNvbnRleHQgdGhhdCBkZXJpdmVzIHRoZSBidWNrZXQgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBidWNrZXQncyBsb2dpY2FsIG5hbWUuXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQW4gUzMgYnVja2V0IHdob3NlIHBoeXNpY2FsIG5hbWUgY29tZXMgZnJvbSB0aGUgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0LlxuICpcbiAqIFdpdGggYSBkZXJpdmVkIHByb2ZpbGUgdGhlIGJ1Y2tldCB1c2VzIHRoZSBhY2NvdW50LXJlZ2lvbmFsIG5hbWVzcGFjZSBhbmQgdGhlXG4gKiBjb250cmFjdCdzIHByZWZpeC4gV2l0aCBhIGxlZ2FjeSBwcm9maWxlIGEgcGluIHN1cHBsaWVzIHRoZSBmdWxsIG5hbWVcbiAqIHZlcmJhdGltLCBhbmQgYSBnZW5lcmF0ZWQgZW50cnkgc2V0cyBubyBuYW1lIGF0IGFsbCBzbyBDbG91ZEZvcm1hdGlvbiBrZWVwc1xuICogdG9kYXkncyBuYW1lIGFuZCBnbG9iYWwgbmFtZXNwYWNlLiBUaGUgcGlubmVkIGF3cy1jZGstbGliIEwyXG4gKiAoYGF3cy1jZGstbGliYCAyLjI3Ny4wKSBleHBvc2VzIGBidWNrZXROYW1lc3BhY2VgIGFuZCBgYnVja2V0TmFtZVByZWZpeGAsIHNvXG4gKiBubyBMMSBwcm9wZXJ0eSBvdmVycmlkZSBpcyBuZWVkZWQ7IENsb3VkRm9ybWF0aW9uIGFwcGVuZHNcbiAqIGAte2FjY291bnR9LXtyZWdpb259LWFuYCB0byB0aGUgcHJlZml4LlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5QnVja2V0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSBidWNrZXQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYnVja2V0OiBzMy5CdWNrZXQ7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUJ1Y2tldFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHsgbmFtaW5nQ29udGV4dCwgbG9naWNhbCwgLi4uYnVja2V0UHJvcHMgfSA9IHByb3BzO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeUJ1Y2tldFwiLCBcImJ1Y2tldE5hbWVcIiwgXCJzM19idWNrZXRcIiwgbG9naWNhbCwgYnVja2V0UHJvcHMuYnVja2V0TmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgXCJBcHBUaGVvcnlCdWNrZXRcIixcbiAgICAgIFwiYnVja2V0TmFtZVByZWZpeFwiLFxuICAgICAgXCJzM19idWNrZXRcIixcbiAgICAgIGxvZ2ljYWwsXG4gICAgICBidWNrZXRQcm9wcy5idWNrZXROYW1lUHJlZml4ICE9PSB1bmRlZmluZWQsXG4gICAgKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgXCJBcHBUaGVvcnlCdWNrZXRcIixcbiAgICAgIFwiYnVja2V0TmFtZXNwYWNlXCIsXG4gICAgICBcInMzX2J1Y2tldFwiLFxuICAgICAgbG9naWNhbCxcbiAgICAgIGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWVzcGFjZSAhPT0gdW5kZWZpbmVkLFxuICAgICk7XG4gICAgY29uc3QgY29tcG9zZWQgPSBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcInMzX2J1Y2tldFwiLCBsb2dpY2FsKTtcblxuICAgIGlmIChjb21wb3NlZC5nZW5lcmF0ZWQpIHtcbiAgICAgIGlmIChidWNrZXRQcm9wcy5idWNrZXROYW1lUHJlZml4ICE9PSB1bmRlZmluZWQgfHwgYnVja2V0UHJvcHMuYnVja2V0TmFtZXNwYWNlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlCdWNrZXQgY2Fubm90IGhvbm9yIGFuIGFjY291bnQtcmVnaW9uYWwgcHJlZml4IHdoZW4gczNfYnVja2V0OiR7bG9naWNhbH0gaXMgYSBnZW5lcmF0ZWQgZW50cnk7IENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSBhbmQgdGhlIGJ1Y2tldCBrZWVwcyB0aGUgZ2xvYmFsIG5hbWVzcGFjZWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgXCJCdWNrZXRcIiwgeyAuLi5idWNrZXRQcm9wcyB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoY29tcG9zZWQucGlubmVkKSB7XG4gICAgICBpZiAoYnVja2V0UHJvcHMuYnVja2V0TmFtZVByZWZpeCAhPT0gdW5kZWZpbmVkIHx8IGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWVzcGFjZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5QnVja2V0IGNhbm5vdCBob25vciBhbiBhY2NvdW50LXJlZ2lvbmFsIHByZWZpeCB3aGVuIHRoZSBwaW4gZm9yIHMzX2J1Y2tldDoke2xvZ2ljYWx9IG93bnMgdGhlIG5hbWVgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiQnVja2V0XCIsIHsgLi4uYnVja2V0UHJvcHMsIGJ1Y2tldE5hbWU6IGNvbXBvc2VkLm5hbWUgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKGNvbXBvc2VkLmJ1Y2tldE5hbWVQcmVmaXggPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlCdWNrZXQgcmVxdWlyZXMgYW4gYWNjb3VudC1yZWdpb25hbCBwcmVmaXggZm9yIHMzX2J1Y2tldDoke2xvZ2ljYWx9YCk7XG4gICAgfVxuICAgIHRoaXMuYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkJ1Y2tldFwiLCB7XG4gICAgICAuLi5idWNrZXRQcm9wcyxcbiAgICAgIGJ1Y2tldE5hbWVzcGFjZTogczMuQnVja2V0TmFtZXNwYWNlLkFDQ09VTlRfUkVHSU9OQUwsXG4gICAgICBidWNrZXROYW1lUHJlZml4OiBjb21wb3NlZC5idWNrZXROYW1lUHJlZml4LFxuICAgIH0pO1xuICB9XG59XG4iXX0=