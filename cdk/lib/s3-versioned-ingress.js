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
exports.AppTheoryS3VersionedIngress = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const constructs_1 = require("constructs");
const NAMESPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const BUNDLE_ID_PATTERN = /^rel_[0-9a-z]{26}$/;
/**
 * Version-pinned artifact ingress bucket for Theory Cloud namespace releases.
 *
 * The construct owns one hardened, versioned bucket, its seven-day incomplete
 * multipart-upload reaping rule, and the one-action IAM grant path for
 * namespace bundles. Literal inputs produce exact-key grants. CloudFormation
 * resolves unresolved token inputs at deployment; AppTheory cannot guarantee
 * exactness for token-valued locations. It does not issue temporary
 * credentials, mint bundle identifiers, or define artifact URI schemes.
 */
class AppTheoryS3VersionedIngress extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryS3VersionedIngress", version: "4.2.4" };
    /** Canonical object-key root for every namespace release bundle. */
    static KEY_ROOT = "ns/";
    /** CloudFormation-resolved physical bucket name. */
    bucketName;
    /** CloudFormation-resolved bucket ARN. */
    bucketArn;
    /** Canonical object-key root for every namespace release bundle. */
    keyRoot;
    bucket;
    constructor(scope, id, props = {}) {
        super(scope, id);
        this.bucket = new s3.Bucket(this, "Bucket", {
            bucketName: props.bucketName,
            versioned: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            lifecycleRules: [{ abortIncompleteMultipartUploadAfter: aws_cdk_lib_1.Duration.days(7), enabled: true }],
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        });
        this.bucketName = this.bucket.bucketName;
        this.bucketArn = this.bucket.bucketArn;
        this.keyRoot = AppTheoryS3VersionedIngress.KEY_ROOT;
    }
    /**
     * Grant one principal `s3:PutObject` on one namespace bundle resource.
     *
     * `s3:PutObject` inherently covers multipart create, part upload, and
     * completion on the same key; separate abort and part-listing actions remain
     * ungranted. Literal location values are validated at synthesis. CDK tokens
     * skip literal value validation and are resolved by CloudFormation at
     * deployment; AppTheory cannot guarantee exactness for token-valued
     * locations. Missing inputs still fail closed before any grant is added.
     */
    grantUpload(grantee, namespaceSlug, bundleId) {
        return this.grantExactObject(grantee, namespaceSlug, bundleId, "s3:PutObject");
    }
    /**
     * Grant one principal permission to read one pinned namespace bundle version.
     *
     * The grant includes only `s3:GetObjectVersion`. Literal inputs target one
     * exact bundle key. CloudFormation resolves token inputs at deployment;
     * AppTheory cannot guarantee exactness for token-valued locations.
     * Unversioned reads and bucket listing remain ungranted.
     */
    grantVersionedRead(grantee, namespaceSlug, bundleId) {
        return this.grantExactObject(grantee, namespaceSlug, bundleId, "s3:GetObjectVersion");
    }
    grantExactObject(grantee, namespaceSlug, bundleId, action) {
        if (!grantee || !grantee.grantPrincipal) {
            throw new Error("AppTheoryS3VersionedIngress requires a grantable principal");
        }
        const slug = validateLocationValue(namespaceSlug, "namespaceSlug", NAMESPACE_SLUG_PATTERN);
        const id = validateLocationValue(bundleId, "bundleId", BUNDLE_ID_PATTERN);
        const objectKey = aws_cdk_lib_1.Fn.join("", [AppTheoryS3VersionedIngress.KEY_ROOT, slug, "/", id]);
        return iam.Grant.addToPrincipal({
            grantee,
            actions: [action],
            resourceArns: [this.bucket.arnForObjects(objectKey)],
        });
    }
}
exports.AppTheoryS3VersionedIngress = AppTheoryS3VersionedIngress;
function validateLocationValue(value, propName, pattern) {
    if (value === undefined || value === null) {
        throw new Error(`AppTheoryS3VersionedIngress requires ${propName}`);
    }
    if (aws_cdk_lib_1.Token.isUnresolved(value)) {
        return value;
    }
    if (!pattern.test(value)) {
        throw new Error(`AppTheoryS3VersionedIngress ${propName} must match ${pattern.source}`);
    }
    return value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiczMtdmVyc2lvbmVkLWluZ3Jlc3MuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzMy12ZXJzaW9uZWQtaW5ncmVzcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQWtEO0FBQ2xELHlEQUEyQztBQUMzQyx1REFBeUM7QUFDekMsMkNBQXVDO0FBRXZDLE1BQU0sc0JBQXNCLEdBQUcsMkJBQTJCLENBQUM7QUFDM0QsTUFBTSxpQkFBaUIsR0FBRyxvQkFBb0IsQ0FBQztBQWUvQzs7Ozs7Ozs7O0dBU0c7QUFDSCxNQUFhLDJCQUE0QixTQUFRLHNCQUFTOztJQUN4RCxvRUFBb0U7SUFDN0QsTUFBTSxDQUFVLFFBQVEsR0FBRyxLQUFLLENBQUM7SUFFeEMsb0RBQW9EO0lBQ3BDLFVBQVUsQ0FBUztJQUVuQywwQ0FBMEM7SUFDMUIsU0FBUyxDQUFTO0lBRWxDLG9FQUFvRTtJQUNwRCxPQUFPLENBQVM7SUFFZixNQUFNLENBQVk7SUFFbkMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUEwQyxFQUFFO1FBQ3BGLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRTtZQUMxQyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsU0FBUyxFQUFFLElBQUk7WUFDZixpQkFBaUIsRUFBRSxFQUFFLENBQUMsaUJBQWlCLENBQUMsU0FBUztZQUNqRCxVQUFVLEVBQUUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFVBQVU7WUFDMUMsVUFBVSxFQUFFLElBQUk7WUFDaEIsY0FBYyxFQUFFLENBQUMsRUFBRSxtQ0FBbUMsRUFBRSxzQkFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUM7WUFDMUYsZUFBZSxFQUFFLEVBQUUsQ0FBQyxlQUFlLENBQUMscUJBQXFCO1NBQzFELENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUM7UUFDekMsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQztRQUN2QyxJQUFJLENBQUMsT0FBTyxHQUFHLDJCQUEyQixDQUFDLFFBQVEsQ0FBQztJQUN0RCxDQUFDO0lBRUQ7Ozs7Ozs7OztPQVNHO0lBQ0ksV0FBVyxDQUFDLE9BQXVCLEVBQUUsYUFBcUIsRUFBRSxRQUFnQjtRQUNqRixPQUFPLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsYUFBYSxFQUFFLFFBQVEsRUFBRSxjQUFjLENBQUMsQ0FBQztJQUNqRixDQUFDO0lBRUQ7Ozs7Ozs7T0FPRztJQUNJLGtCQUFrQixDQUFDLE9BQXVCLEVBQUUsYUFBcUIsRUFBRSxRQUFnQjtRQUN4RixPQUFPLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsYUFBYSxFQUFFLFFBQVEsRUFBRSxxQkFBcUIsQ0FBQyxDQUFDO0lBQ3hGLENBQUM7SUFFTyxnQkFBZ0IsQ0FDdEIsT0FBdUIsRUFDdkIsYUFBcUIsRUFDckIsUUFBZ0IsRUFDaEIsTUFBYztRQUVkLElBQUksQ0FBQyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDeEMsTUFBTSxJQUFJLEtBQUssQ0FBQyw0REFBNEQsQ0FBQyxDQUFDO1FBQ2hGLENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxxQkFBcUIsQ0FBQyxhQUFhLEVBQUUsZUFBZSxFQUFFLHNCQUFzQixDQUFDLENBQUM7UUFDM0YsTUFBTSxFQUFFLEdBQUcscUJBQXFCLENBQUMsUUFBUSxFQUFFLFVBQVUsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO1FBQzFFLE1BQU0sU0FBUyxHQUFHLGdCQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxDQUFDLDJCQUEyQixDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsR0FBRyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFFckYsT0FBTyxHQUFHLENBQUMsS0FBSyxDQUFDLGNBQWMsQ0FBQztZQUM5QixPQUFPO1lBQ1AsT0FBTyxFQUFFLENBQUMsTUFBTSxDQUFDO1lBQ2pCLFlBQVksRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsYUFBYSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1NBQ3JELENBQUMsQ0FBQztJQUNMLENBQUM7O0FBOUVILGtFQStFQztBQUVELFNBQVMscUJBQXFCLENBQUMsS0FBYSxFQUFFLFFBQWdCLEVBQUUsT0FBZTtJQUM3RSxJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQzFDLE1BQU0sSUFBSSxLQUFLLENBQUMsd0NBQXdDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFDdEUsQ0FBQztJQUNELElBQUksbUJBQUssQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUM5QixPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7SUFDRCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3pCLE1BQU0sSUFBSSxLQUFLLENBQUMsK0JBQStCLFFBQVEsZUFBZSxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUMxRixDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIEZuLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5jb25zdCBOQU1FU1BBQ0VfU0xVR19QQVRURVJOID0gL15bYS16MC05XVthLXowLTktXXsxLDYyfSQvO1xuY29uc3QgQlVORExFX0lEX1BBVFRFUk4gPSAvXnJlbF9bMC05YS16XXsyNn0kLztcblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzcyBjb25zdHJ1Y3QuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UzNWZXJzaW9uZWRJbmdyZXNzUHJvcHMge1xuICAvKipcbiAgICogUGh5c2ljYWwgbmFtZSBmb3IgdGhlIGFydGlmYWN0IGluZ3Jlc3MgYnVja2V0LlxuICAgKlxuICAgKiBUb2tlbi12YWx1ZWQgbmFtZXMgcGFzcyB0aHJvdWdoIHRvIHRoZSBTMyBjb25zdHJ1Y3QgdW5jaGFuZ2VkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZCBuYW1lKVxuICAgKi9cbiAgcmVhZG9ubHkgYnVja2V0TmFtZT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBWZXJzaW9uLXBpbm5lZCBhcnRpZmFjdCBpbmdyZXNzIGJ1Y2tldCBmb3IgVGhlb3J5IENsb3VkIG5hbWVzcGFjZSByZWxlYXNlcy5cbiAqXG4gKiBUaGUgY29uc3RydWN0IG93bnMgb25lIGhhcmRlbmVkLCB2ZXJzaW9uZWQgYnVja2V0LCBpdHMgc2V2ZW4tZGF5IGluY29tcGxldGVcbiAqIG11bHRpcGFydC11cGxvYWQgcmVhcGluZyBydWxlLCBhbmQgdGhlIG9uZS1hY3Rpb24gSUFNIGdyYW50IHBhdGggZm9yXG4gKiBuYW1lc3BhY2UgYnVuZGxlcy4gTGl0ZXJhbCBpbnB1dHMgcHJvZHVjZSBleGFjdC1rZXkgZ3JhbnRzLiBDbG91ZEZvcm1hdGlvblxuICogcmVzb2x2ZXMgdW5yZXNvbHZlZCB0b2tlbiBpbnB1dHMgYXQgZGVwbG95bWVudDsgQXBwVGhlb3J5IGNhbm5vdCBndWFyYW50ZWVcbiAqIGV4YWN0bmVzcyBmb3IgdG9rZW4tdmFsdWVkIGxvY2F0aW9ucy4gSXQgZG9lcyBub3QgaXNzdWUgdGVtcG9yYXJ5XG4gKiBjcmVkZW50aWFscywgbWludCBidW5kbGUgaWRlbnRpZmllcnMsIG9yIGRlZmluZSBhcnRpZmFjdCBVUkkgc2NoZW1lcy5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzcyBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKiBDYW5vbmljYWwgb2JqZWN0LWtleSByb290IGZvciBldmVyeSBuYW1lc3BhY2UgcmVsZWFzZSBidW5kbGUuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgS0VZX1JPT1QgPSBcIm5zL1wiO1xuXG4gIC8qKiBDbG91ZEZvcm1hdGlvbi1yZXNvbHZlZCBwaHlzaWNhbCBidWNrZXQgbmFtZS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldE5hbWU6IHN0cmluZztcblxuICAvKiogQ2xvdWRGb3JtYXRpb24tcmVzb2x2ZWQgYnVja2V0IEFSTi4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldEFybjogc3RyaW5nO1xuXG4gIC8qKiBDYW5vbmljYWwgb2JqZWN0LWtleSByb290IGZvciBldmVyeSBuYW1lc3BhY2UgcmVsZWFzZSBidW5kbGUuICovXG4gIHB1YmxpYyByZWFkb25seSBrZXlSb290OiBzdHJpbmc7XG5cbiAgcHJpdmF0ZSByZWFkb25seSBidWNrZXQ6IHMzLkJ1Y2tldDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UzNWZXJzaW9uZWRJbmdyZXNzUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgXCJCdWNrZXRcIiwge1xuICAgICAgYnVja2V0TmFtZTogcHJvcHMuYnVja2V0TmFtZSxcbiAgICAgIHZlcnNpb25lZDogdHJ1ZSxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFt7IGFib3J0SW5jb21wbGV0ZU11bHRpcGFydFVwbG9hZEFmdGVyOiBEdXJhdGlvbi5kYXlzKDcpLCBlbmFibGVkOiB0cnVlIH1dLFxuICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuQlVDS0VUX09XTkVSX0VORk9SQ0VELFxuICAgIH0pO1xuXG4gICAgdGhpcy5idWNrZXROYW1lID0gdGhpcy5idWNrZXQuYnVja2V0TmFtZTtcbiAgICB0aGlzLmJ1Y2tldEFybiA9IHRoaXMuYnVja2V0LmJ1Y2tldEFybjtcbiAgICB0aGlzLmtleVJvb3QgPSBBcHBUaGVvcnlTM1ZlcnNpb25lZEluZ3Jlc3MuS0VZX1JPT1Q7XG4gIH1cblxuICAvKipcbiAgICogR3JhbnQgb25lIHByaW5jaXBhbCBgczM6UHV0T2JqZWN0YCBvbiBvbmUgbmFtZXNwYWNlIGJ1bmRsZSByZXNvdXJjZS5cbiAgICpcbiAgICogYHMzOlB1dE9iamVjdGAgaW5oZXJlbnRseSBjb3ZlcnMgbXVsdGlwYXJ0IGNyZWF0ZSwgcGFydCB1cGxvYWQsIGFuZFxuICAgKiBjb21wbGV0aW9uIG9uIHRoZSBzYW1lIGtleTsgc2VwYXJhdGUgYWJvcnQgYW5kIHBhcnQtbGlzdGluZyBhY3Rpb25zIHJlbWFpblxuICAgKiB1bmdyYW50ZWQuIExpdGVyYWwgbG9jYXRpb24gdmFsdWVzIGFyZSB2YWxpZGF0ZWQgYXQgc3ludGhlc2lzLiBDREsgdG9rZW5zXG4gICAqIHNraXAgbGl0ZXJhbCB2YWx1ZSB2YWxpZGF0aW9uIGFuZCBhcmUgcmVzb2x2ZWQgYnkgQ2xvdWRGb3JtYXRpb24gYXRcbiAgICogZGVwbG95bWVudDsgQXBwVGhlb3J5IGNhbm5vdCBndWFyYW50ZWUgZXhhY3RuZXNzIGZvciB0b2tlbi12YWx1ZWRcbiAgICogbG9jYXRpb25zLiBNaXNzaW5nIGlucHV0cyBzdGlsbCBmYWlsIGNsb3NlZCBiZWZvcmUgYW55IGdyYW50IGlzIGFkZGVkLlxuICAgKi9cbiAgcHVibGljIGdyYW50VXBsb2FkKGdyYW50ZWU6IGlhbS5JR3JhbnRhYmxlLCBuYW1lc3BhY2VTbHVnOiBzdHJpbmcsIGJ1bmRsZUlkOiBzdHJpbmcpOiBpYW0uR3JhbnQge1xuICAgIHJldHVybiB0aGlzLmdyYW50RXhhY3RPYmplY3QoZ3JhbnRlZSwgbmFtZXNwYWNlU2x1ZywgYnVuZGxlSWQsIFwiczM6UHV0T2JqZWN0XCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IG9uZSBwcmluY2lwYWwgcGVybWlzc2lvbiB0byByZWFkIG9uZSBwaW5uZWQgbmFtZXNwYWNlIGJ1bmRsZSB2ZXJzaW9uLlxuICAgKlxuICAgKiBUaGUgZ3JhbnQgaW5jbHVkZXMgb25seSBgczM6R2V0T2JqZWN0VmVyc2lvbmAuIExpdGVyYWwgaW5wdXRzIHRhcmdldCBvbmVcbiAgICogZXhhY3QgYnVuZGxlIGtleS4gQ2xvdWRGb3JtYXRpb24gcmVzb2x2ZXMgdG9rZW4gaW5wdXRzIGF0IGRlcGxveW1lbnQ7XG4gICAqIEFwcFRoZW9yeSBjYW5ub3QgZ3VhcmFudGVlIGV4YWN0bmVzcyBmb3IgdG9rZW4tdmFsdWVkIGxvY2F0aW9ucy5cbiAgICogVW52ZXJzaW9uZWQgcmVhZHMgYW5kIGJ1Y2tldCBsaXN0aW5nIHJlbWFpbiB1bmdyYW50ZWQuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnRWZXJzaW9uZWRSZWFkKGdyYW50ZWU6IGlhbS5JR3JhbnRhYmxlLCBuYW1lc3BhY2VTbHVnOiBzdHJpbmcsIGJ1bmRsZUlkOiBzdHJpbmcpOiBpYW0uR3JhbnQge1xuICAgIHJldHVybiB0aGlzLmdyYW50RXhhY3RPYmplY3QoZ3JhbnRlZSwgbmFtZXNwYWNlU2x1ZywgYnVuZGxlSWQsIFwiczM6R2V0T2JqZWN0VmVyc2lvblwiKTtcbiAgfVxuXG4gIHByaXZhdGUgZ3JhbnRFeGFjdE9iamVjdChcbiAgICBncmFudGVlOiBpYW0uSUdyYW50YWJsZSxcbiAgICBuYW1lc3BhY2VTbHVnOiBzdHJpbmcsXG4gICAgYnVuZGxlSWQ6IHN0cmluZyxcbiAgICBhY3Rpb246IHN0cmluZyxcbiAgKTogaWFtLkdyYW50IHtcbiAgICBpZiAoIWdyYW50ZWUgfHwgIWdyYW50ZWUuZ3JhbnRQcmluY2lwYWwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzcyByZXF1aXJlcyBhIGdyYW50YWJsZSBwcmluY2lwYWxcIik7XG4gICAgfVxuXG4gICAgY29uc3Qgc2x1ZyA9IHZhbGlkYXRlTG9jYXRpb25WYWx1ZShuYW1lc3BhY2VTbHVnLCBcIm5hbWVzcGFjZVNsdWdcIiwgTkFNRVNQQUNFX1NMVUdfUEFUVEVSTik7XG4gICAgY29uc3QgaWQgPSB2YWxpZGF0ZUxvY2F0aW9uVmFsdWUoYnVuZGxlSWQsIFwiYnVuZGxlSWRcIiwgQlVORExFX0lEX1BBVFRFUk4pO1xuICAgIGNvbnN0IG9iamVjdEtleSA9IEZuLmpvaW4oXCJcIiwgW0FwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzcy5LRVlfUk9PVCwgc2x1ZywgXCIvXCIsIGlkXSk7XG5cbiAgICByZXR1cm4gaWFtLkdyYW50LmFkZFRvUHJpbmNpcGFsKHtcbiAgICAgIGdyYW50ZWUsXG4gICAgICBhY3Rpb25zOiBbYWN0aW9uXSxcbiAgICAgIHJlc291cmNlQXJuczogW3RoaXMuYnVja2V0LmFybkZvck9iamVjdHMob2JqZWN0S2V5KV0sXG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMb2NhdGlvblZhbHVlKHZhbHVlOiBzdHJpbmcsIHByb3BOYW1lOiBzdHJpbmcsIHBhdHRlcm46IFJlZ0V4cCk6IHN0cmluZyB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTM1ZlcnNpb25lZEluZ3Jlc3MgcmVxdWlyZXMgJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuICBpZiAoIXBhdHRlcm4udGVzdCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzcyAke3Byb3BOYW1lfSBtdXN0IG1hdGNoICR7cGF0dGVybi5zb3VyY2V9YCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuIl19