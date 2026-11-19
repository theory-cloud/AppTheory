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
const naming_1 = require("./naming");
/**
 * An S3 bucket whose physical name comes from the resource-naming contract.
 *
 * With a derived profile the bucket uses the account-regional namespace and the
 * contract's prefix. With a legacy profile the pinned full name is used
 * verbatim. The pinned aws-cdk-lib L2 (`aws-cdk-lib` 2.277.0) exposes
 * `bucketNamespace` and `bucketNamePrefix`, so no L1 property override is
 * needed; CloudFormation appends `-{account}-{region}-an` to the prefix.
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
        const composed = namingContext.physicalName("s3_bucket", logical);
        if (namingContext.namingProfile === naming_1.AppTheoryNamingProfile.LEGACY) {
            if (bucketProps.bucketName !== undefined && bucketProps.bucketName !== composed.name) {
                throw new Error(`AppTheoryBucket cannot honor props.bucketName ${JSON.stringify(bucketProps.bucketName)} when the legacy pin for s3_bucket:${logical} is ${JSON.stringify(composed.name)}`);
            }
            if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
                throw new Error(`AppTheoryBucket cannot honor an account-regional prefix under a legacy naming profile; the pin for s3_bucket:${logical} owns the name`);
            }
            this.bucket = new s3.Bucket(this, "Bucket", { ...bucketProps, bucketName: composed.name });
            return;
        }
        if (bucketProps.bucketName !== undefined) {
            throw new Error(`AppTheoryBucket derives the name for s3_bucket:${logical} from the naming context; omit props.bucketName or use the legacy profile with a pin`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWJ1Y2tldC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm5hbWluZy1idWNrZXQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLHVEQUF5QztBQUN6QywyQ0FBdUM7QUFHdkMscUNBQWtEO0FBaUJsRDs7Ozs7Ozs7R0FRRztBQUNILE1BQWEsZUFBZ0IsU0FBUSxzQkFBUzs7SUFDNUM7O09BRUc7SUFDYSxNQUFNLENBQVk7SUFFbEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUEyQjtRQUNuRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sRUFBRSxhQUFhLEVBQUUsT0FBTyxFQUFFLEdBQUcsV0FBVyxFQUFFLEdBQUcsS0FBSyxDQUFDO1FBQ3pELE1BQU0sUUFBUSxHQUFHLGFBQWEsQ0FBQyxZQUFZLENBQUMsV0FBVyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBRWxFLElBQUksYUFBYSxDQUFDLGFBQWEsS0FBSywrQkFBc0IsQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNsRSxJQUFJLFdBQVcsQ0FBQyxVQUFVLEtBQUssU0FBUyxJQUFJLFdBQVcsQ0FBQyxVQUFVLEtBQUssUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNyRixNQUFNLElBQUksS0FBSyxDQUNiLGlEQUFpRCxJQUFJLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsc0NBQXNDLE9BQU8sT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUMzSyxDQUFDO1lBQ0osQ0FBQztZQUNELElBQUksV0FBVyxDQUFDLGdCQUFnQixLQUFLLFNBQVMsSUFBSSxXQUFXLENBQUMsZUFBZSxLQUFLLFNBQVMsRUFBRSxDQUFDO2dCQUM1RixNQUFNLElBQUksS0FBSyxDQUNiLGdIQUFnSCxPQUFPLGdCQUFnQixDQUN4SSxDQUFDO1lBQ0osQ0FBQztZQUNELElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsRUFBRSxHQUFHLFdBQVcsRUFBRSxVQUFVLEVBQUUsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7WUFDM0YsT0FBTztRQUNULENBQUM7UUFFRCxJQUFJLFdBQVcsQ0FBQyxVQUFVLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDekMsTUFBTSxJQUFJLEtBQUssQ0FDYixrREFBa0QsT0FBTyxzRkFBc0YsQ0FDaEosQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLFFBQVEsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUM1QyxNQUFNLElBQUksS0FBSyxDQUFDLHFFQUFxRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQ2xHLENBQUM7UUFDRCxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFO1lBQzFDLEdBQUcsV0FBVztZQUNkLGVBQWUsRUFBRSxFQUFFLENBQUMsZUFBZSxDQUFDLGdCQUFnQjtZQUNwRCxnQkFBZ0IsRUFBRSxRQUFRLENBQUMsZ0JBQWdCO1NBQzVDLENBQUMsQ0FBQztJQUNMLENBQUM7O0FBeENILDBDQXlDQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5pbXBvcnQgeyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlIH0gZnJvbSBcIi4vbmFtaW5nXCI7XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgYW4gYEFwcFRoZW9yeUJ1Y2tldGAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5QnVja2V0UHJvcHMgZXh0ZW5kcyBzMy5CdWNrZXRQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtaW5nIGNvbnRleHQgdGhhdCBkZXJpdmVzIHRoZSBidWNrZXQgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBidWNrZXQncyBsb2dpY2FsIG5hbWUuXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQW4gUzMgYnVja2V0IHdob3NlIHBoeXNpY2FsIG5hbWUgY29tZXMgZnJvbSB0aGUgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0LlxuICpcbiAqIFdpdGggYSBkZXJpdmVkIHByb2ZpbGUgdGhlIGJ1Y2tldCB1c2VzIHRoZSBhY2NvdW50LXJlZ2lvbmFsIG5hbWVzcGFjZSBhbmQgdGhlXG4gKiBjb250cmFjdCdzIHByZWZpeC4gV2l0aCBhIGxlZ2FjeSBwcm9maWxlIHRoZSBwaW5uZWQgZnVsbCBuYW1lIGlzIHVzZWRcbiAqIHZlcmJhdGltLiBUaGUgcGlubmVkIGF3cy1jZGstbGliIEwyIChgYXdzLWNkay1saWJgIDIuMjc3LjApIGV4cG9zZXNcbiAqIGBidWNrZXROYW1lc3BhY2VgIGFuZCBgYnVja2V0TmFtZVByZWZpeGAsIHNvIG5vIEwxIHByb3BlcnR5IG92ZXJyaWRlIGlzXG4gKiBuZWVkZWQ7IENsb3VkRm9ybWF0aW9uIGFwcGVuZHMgYC17YWNjb3VudH0te3JlZ2lvbn0tYW5gIHRvIHRoZSBwcmVmaXguXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlCdWNrZXQgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogVGhlIGJ1Y2tldC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBidWNrZXQ6IHMzLkJ1Y2tldDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5QnVja2V0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgeyBuYW1pbmdDb250ZXh0LCBsb2dpY2FsLCAuLi5idWNrZXRQcm9wcyB9ID0gcHJvcHM7XG4gICAgY29uc3QgY29tcG9zZWQgPSBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcInMzX2J1Y2tldFwiLCBsb2dpY2FsKTtcblxuICAgIGlmIChuYW1pbmdDb250ZXh0Lm5hbWluZ1Byb2ZpbGUgPT09IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuTEVHQUNZKSB7XG4gICAgICBpZiAoYnVja2V0UHJvcHMuYnVja2V0TmFtZSAhPT0gdW5kZWZpbmVkICYmIGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWUgIT09IGNvbXBvc2VkLm5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlCdWNrZXQgY2Fubm90IGhvbm9yIHByb3BzLmJ1Y2tldE5hbWUgJHtKU09OLnN0cmluZ2lmeShidWNrZXRQcm9wcy5idWNrZXROYW1lKX0gd2hlbiB0aGUgbGVnYWN5IHBpbiBmb3IgczNfYnVja2V0OiR7bG9naWNhbH0gaXMgJHtKU09OLnN0cmluZ2lmeShjb21wb3NlZC5uYW1lKX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWVQcmVmaXggIT09IHVuZGVmaW5lZCB8fCBidWNrZXRQcm9wcy5idWNrZXROYW1lc3BhY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeUJ1Y2tldCBjYW5ub3QgaG9ub3IgYW4gYWNjb3VudC1yZWdpb25hbCBwcmVmaXggdW5kZXIgYSBsZWdhY3kgbmFtaW5nIHByb2ZpbGU7IHRoZSBwaW4gZm9yIHMzX2J1Y2tldDoke2xvZ2ljYWx9IG93bnMgdGhlIG5hbWVgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiQnVja2V0XCIsIHsgLi4uYnVja2V0UHJvcHMsIGJ1Y2tldE5hbWU6IGNvbXBvc2VkLm5hbWUgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5QnVja2V0IGRlcml2ZXMgdGhlIG5hbWUgZm9yIHMzX2J1Y2tldDoke2xvZ2ljYWx9IGZyb20gdGhlIG5hbWluZyBjb250ZXh0OyBvbWl0IHByb3BzLmJ1Y2tldE5hbWUgb3IgdXNlIHRoZSBsZWdhY3kgcHJvZmlsZSB3aXRoIGEgcGluYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChjb21wb3NlZC5idWNrZXROYW1lUHJlZml4ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5QnVja2V0IHJlcXVpcmVzIGFuIGFjY291bnQtcmVnaW9uYWwgcHJlZml4IGZvciBzM19idWNrZXQ6JHtsb2dpY2FsfWApO1xuICAgIH1cbiAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgXCJCdWNrZXRcIiwge1xuICAgICAgLi4uYnVja2V0UHJvcHMsXG4gICAgICBidWNrZXROYW1lc3BhY2U6IHMzLkJ1Y2tldE5hbWVzcGFjZS5BQ0NPVU5UX1JFR0lPTkFMLFxuICAgICAgYnVja2V0TmFtZVByZWZpeDogY29tcG9zZWQuYnVja2V0TmFtZVByZWZpeCxcbiAgICB9KTtcbiAgfVxufVxuIl19