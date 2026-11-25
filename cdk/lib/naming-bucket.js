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
            return;
        }
        if (composed.pinned) {
            if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
                throw new Error(`AppTheoryBucket cannot honor an account-regional prefix when the pin for s3_bucket:${logical} owns the name`);
            }
            this.bucket = new s3.Bucket(this, "Bucket", { ...resolvedProps, bucketName: composed.name });
            return;
        }
        if (composed.bucketNamePrefix === undefined) {
            throw new Error(`AppTheoryBucket requires an account-regional prefix for s3_bucket:${logical}`);
        }
        this.bucket = new s3.Bucket(this, "Bucket", {
            ...resolvedProps,
            bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
            bucketNamePrefix: composed.bucketNamePrefix,
        });
    }
}
exports.AppTheoryBucket = AppTheoryBucket;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWJ1Y2tldC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm5hbWluZy1idWNrZXQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLHVEQUF5QztBQUN6QywyQ0FBdUM7QUFHdkMseUVBQW9FO0FBQ3BFLCtEQUEyRDtBQWlCM0Q7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBaUJHO0FBQ0gsTUFBYSxlQUFnQixTQUFRLHNCQUFTOztJQUM1Qzs7T0FFRztJQUNhLE1BQU0sQ0FBWTtJQUVsQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTJCO1FBQ25FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsR0FBRyxXQUFXLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFDekQsSUFBQSx5Q0FBa0IsRUFBQyxhQUFhLEVBQUUsaUJBQWlCLEVBQUUsWUFBWSxFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsV0FBVyxDQUFDLFVBQVUsS0FBSyxTQUFTLENBQUMsQ0FBQztRQUMvSCxJQUFBLHlDQUFrQixFQUNoQixhQUFhLEVBQ2IsaUJBQWlCLEVBQ2pCLGtCQUFrQixFQUNsQixXQUFXLEVBQ1gsT0FBTyxFQUNQLFdBQVcsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLENBQzNDLENBQUM7UUFDRixJQUFBLHlDQUFrQixFQUNoQixhQUFhLEVBQ2IsaUJBQWlCLEVBQ2pCLGlCQUFpQixFQUNqQixXQUFXLEVBQ1gsT0FBTyxFQUNQLFdBQVcsQ0FBQyxlQUFlLEtBQUssU0FBUyxDQUMxQyxDQUFDO1FBQ0YsTUFBTSxRQUFRLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxXQUFXLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDbEUsTUFBTSxhQUFhLEdBQUc7WUFDcEIsR0FBRyxXQUFXO1lBQ2QsVUFBVSxFQUFFLFdBQVcsQ0FBQyxVQUFVLElBQUksQ0FBQyxJQUFBLGdDQUFjLEVBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1NBQ3pGLENBQUM7UUFFRixJQUFJLFFBQVEsQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUN2QixJQUFJLFdBQVcsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLElBQUksV0FBVyxDQUFDLGVBQWUsS0FBSyxTQUFTLEVBQUUsQ0FBQztnQkFDNUYsTUFBTSxJQUFJLEtBQUssQ0FDYiwwRUFBMEUsT0FBTyxvR0FBb0csQ0FDdEwsQ0FBQztZQUNKLENBQUM7WUFDRCxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLEVBQUUsR0FBRyxhQUFhLEVBQUUsQ0FBQyxDQUFDO1lBQ2xFLE9BQU87UUFDVCxDQUFDO1FBRUQsSUFBSSxRQUFRLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDcEIsSUFBSSxXQUFXLENBQUMsZ0JBQWdCLEtBQUssU0FBUyxJQUFJLFdBQVcsQ0FBQyxlQUFlLEtBQUssU0FBUyxFQUFFLENBQUM7Z0JBQzVGLE1BQU0sSUFBSSxLQUFLLENBQ2Isc0ZBQXNGLE9BQU8sZ0JBQWdCLENBQzlHLENBQUM7WUFDSixDQUFDO1lBQ0QsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxFQUFFLEdBQUcsYUFBYSxFQUFFLFVBQVUsRUFBRSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUM3RixPQUFPO1FBQ1QsQ0FBQztRQUVELElBQUksUUFBUSxDQUFDLGdCQUFnQixLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzVDLE1BQU0sSUFBSSxLQUFLLENBQUMscUVBQXFFLE9BQU8sRUFBRSxDQUFDLENBQUM7UUFDbEcsQ0FBQztRQUNELElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDMUMsR0FBRyxhQUFhO1lBQ2hCLGVBQWUsRUFBRSxFQUFFLENBQUMsZUFBZSxDQUFDLGdCQUFnQjtZQUNwRCxnQkFBZ0IsRUFBRSxRQUFRLENBQUMsZ0JBQWdCO1NBQzVDLENBQUMsQ0FBQztJQUNMLENBQUM7O0FBN0RILDBDQThEQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyBzZWN1cmVEZWZhdWx0cyB9IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgYW4gYEFwcFRoZW9yeUJ1Y2tldGAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5QnVja2V0UHJvcHMgZXh0ZW5kcyBzMy5CdWNrZXRQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtaW5nIGNvbnRleHQgdGhhdCBkZXJpdmVzIHRoZSBidWNrZXQgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBidWNrZXQncyBsb2dpY2FsIG5hbWUuXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQW4gUzMgYnVja2V0IHdob3NlIHBoeXNpY2FsIG5hbWUgY29tZXMgZnJvbSB0aGUgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0LlxuICpcbiAqIFdpdGggYSBkZXJpdmVkIHByb2ZpbGUgdGhlIGJ1Y2tldCB1c2VzIHRoZSBhY2NvdW50LXJlZ2lvbmFsIG5hbWVzcGFjZSBhbmQgdGhlXG4gKiBjb250cmFjdCdzIHByZWZpeC4gV2l0aCBhIGxlZ2FjeSBwcm9maWxlIGEgcGluIHN1cHBsaWVzIHRoZSBmdWxsIG5hbWVcbiAqIHZlcmJhdGltLCBhbmQgYSBnZW5lcmF0ZWQgZW50cnkgc2V0cyBubyBuYW1lIGF0IGFsbCBzbyBDbG91ZEZvcm1hdGlvbiBrZWVwc1xuICogdG9kYXkncyBuYW1lIGFuZCBnbG9iYWwgbmFtZXNwYWNlLiBUaGUgcGlubmVkIGF3cy1jZGstbGliIEwyXG4gKiAoYGF3cy1jZGstbGliYCAyLjI3Ny4wKSBleHBvc2VzIGBidWNrZXROYW1lc3BhY2VgIGFuZCBgYnVja2V0TmFtZVByZWZpeGAsIHNvXG4gKiBubyBMMSBwcm9wZXJ0eSBvdmVycmlkZSBpcyBuZWVkZWQ7IENsb3VkRm9ybWF0aW9uIGFwcGVuZHNcbiAqIGAte2FjY291bnR9LXtyZWdpb259LWFuYCB0byB0aGUgcHJlZml4LlxuICpcbiAqIFVuZGVyIGEgZGVyaXZlZCBwcm9maWxlIHRoZSBidWNrZXQgYWxzbyBlbmZvcmNlcyBUTFMgKGBlbmZvcmNlU1NMOiB0cnVlYCksXG4gKiB3aGljaCBpcyB0aGUgYnVja2V0LXBvbGljeSBjb25kaXRpb24gU2VjdXJpdHkgSHViIFMzLjUgYXNrcyBmb3IuIEFuIGV4cGxpY2l0XG4gKiBgZW5mb3JjZVNTTGAgc3RpbGwgd2lucy4gU2VydmVyIGFjY2VzcyBsb2dnaW5nIChTMy45KSBzdGF5cyBvcHQtaW4gdGhyb3VnaCB0aGVcbiAqIGluaGVyaXRlZCBgc2VydmVyQWNjZXNzTG9nc0J1Y2tldGAgYW5kIGBzZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4YCBwcm9wcywgYmVjYXVzZVxuICogYSBsb2cgdGFyZ2V0IGNvc3RzIG1vbmV5OyB0aGUgdGFyZ2V0IGJ1Y2tldCBpcyB0aGUgY2FsbGVyJ3MgYW5kIGNvbnN1bWVzIG5vXG4gKiBuYW1pbmcgZW50cnkgKHJlc291cmNlLW5hbWluZyBjb250cmFjdCBzZWN0aW9uIDQpLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5QnVja2V0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSBidWNrZXQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYnVja2V0OiBzMy5CdWNrZXQ7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUJ1Y2tldFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHsgbmFtaW5nQ29udGV4dCwgbG9naWNhbCwgLi4uYnVja2V0UHJvcHMgfSA9IHByb3BzO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeUJ1Y2tldFwiLCBcImJ1Y2tldE5hbWVcIiwgXCJzM19idWNrZXRcIiwgbG9naWNhbCwgYnVja2V0UHJvcHMuYnVja2V0TmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgXCJBcHBUaGVvcnlCdWNrZXRcIixcbiAgICAgIFwiYnVja2V0TmFtZVByZWZpeFwiLFxuICAgICAgXCJzM19idWNrZXRcIixcbiAgICAgIGxvZ2ljYWwsXG4gICAgICBidWNrZXRQcm9wcy5idWNrZXROYW1lUHJlZml4ICE9PSB1bmRlZmluZWQsXG4gICAgKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgXCJBcHBUaGVvcnlCdWNrZXRcIixcbiAgICAgIFwiYnVja2V0TmFtZXNwYWNlXCIsXG4gICAgICBcInMzX2J1Y2tldFwiLFxuICAgICAgbG9naWNhbCxcbiAgICAgIGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWVzcGFjZSAhPT0gdW5kZWZpbmVkLFxuICAgICk7XG4gICAgY29uc3QgY29tcG9zZWQgPSBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcInMzX2J1Y2tldFwiLCBsb2dpY2FsKTtcbiAgICBjb25zdCByZXNvbHZlZFByb3BzID0ge1xuICAgICAgLi4uYnVja2V0UHJvcHMsXG4gICAgICBlbmZvcmNlU1NMOiBidWNrZXRQcm9wcy5lbmZvcmNlU1NMID8/IChzZWN1cmVEZWZhdWx0cyhuYW1pbmdDb250ZXh0KSA/IHRydWUgOiB1bmRlZmluZWQpLFxuICAgIH07XG5cbiAgICBpZiAoY29tcG9zZWQuZ2VuZXJhdGVkKSB7XG4gICAgICBpZiAoYnVja2V0UHJvcHMuYnVja2V0TmFtZVByZWZpeCAhPT0gdW5kZWZpbmVkIHx8IGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWVzcGFjZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5QnVja2V0IGNhbm5vdCBob25vciBhbiBhY2NvdW50LXJlZ2lvbmFsIHByZWZpeCB3aGVuIHMzX2J1Y2tldDoke2xvZ2ljYWx9IGlzIGEgZ2VuZXJhdGVkIGVudHJ5OyBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgYW5kIHRoZSBidWNrZXQga2VlcHMgdGhlIGdsb2JhbCBuYW1lc3BhY2VgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiQnVja2V0XCIsIHsgLi4ucmVzb2x2ZWRQcm9wcyB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoY29tcG9zZWQucGlubmVkKSB7XG4gICAgICBpZiAoYnVja2V0UHJvcHMuYnVja2V0TmFtZVByZWZpeCAhPT0gdW5kZWZpbmVkIHx8IGJ1Y2tldFByb3BzLmJ1Y2tldE5hbWVzcGFjZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5QnVja2V0IGNhbm5vdCBob25vciBhbiBhY2NvdW50LXJlZ2lvbmFsIHByZWZpeCB3aGVuIHRoZSBwaW4gZm9yIHMzX2J1Y2tldDoke2xvZ2ljYWx9IG93bnMgdGhlIG5hbWVgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiQnVja2V0XCIsIHsgLi4ucmVzb2x2ZWRQcm9wcywgYnVja2V0TmFtZTogY29tcG9zZWQubmFtZSB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoY29tcG9zZWQuYnVja2V0TmFtZVByZWZpeCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeUJ1Y2tldCByZXF1aXJlcyBhbiBhY2NvdW50LXJlZ2lvbmFsIHByZWZpeCBmb3IgczNfYnVja2V0OiR7bG9naWNhbH1gKTtcbiAgICB9XG4gICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiQnVja2V0XCIsIHtcbiAgICAgIC4uLnJlc29sdmVkUHJvcHMsXG4gICAgICBidWNrZXROYW1lc3BhY2U6IHMzLkJ1Y2tldE5hbWVzcGFjZS5BQ0NPVU5UX1JFR0lPTkFMLFxuICAgICAgYnVja2V0TmFtZVByZWZpeDogY29tcG9zZWQuYnVja2V0TmFtZVByZWZpeCxcbiAgICB9KTtcbiAgfVxufVxuIl19