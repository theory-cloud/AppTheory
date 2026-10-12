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
 * namespace bundles. Grant locations must be literal values, so every grant
 * targets one exact object key; unresolved token locations are rejected. It
 * does not issue temporary credentials, mint bundle identifiers, or define
 * artifact URI schemes.
 */
class AppTheoryS3VersionedIngress extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryS3VersionedIngress", version: "5.0.2" };
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
     * ungranted. Location values must be literal strings: AppTheory validates them
     * at synthesis and rejects unresolved CDK tokens, because a grant cannot
     * guarantee an exact key for a location that CloudFormation only resolves at
     * deployment. Missing inputs still fail closed before any grant is added.
     */
    grantUpload(grantee, namespaceSlug, bundleId) {
        return this.grantExactObject(grantee, namespaceSlug, bundleId, "s3:PutObject");
    }
    /**
     * Grant one principal permission to read one pinned namespace bundle version.
     *
     * The grant includes only `s3:GetObjectVersion`. Inputs must be literal
     * strings and target one exact bundle key; unresolved CDK tokens are rejected.
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
        throw new Error(`AppTheoryS3VersionedIngress ${propName} must be a literal value; unresolved CDK tokens are rejected because AppTheory cannot guarantee an exact-key grant for a CloudFormation-resolved location`);
    }
    if (!pattern.test(value)) {
        throw new Error(`AppTheoryS3VersionedIngress ${propName} must match ${pattern.source}`);
    }
    return value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiczMtdmVyc2lvbmVkLWluZ3Jlc3MuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzMy12ZXJzaW9uZWQtaW5ncmVzcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQWtEO0FBQ2xELHlEQUEyQztBQUMzQyx1REFBeUM7QUFDekMsMkNBQXVDO0FBRXZDLE1BQU0sc0JBQXNCLEdBQUcsMkJBQTJCLENBQUM7QUFDM0QsTUFBTSxpQkFBaUIsR0FBRyxvQkFBb0IsQ0FBQztBQWUvQzs7Ozs7Ozs7O0dBU0c7QUFDSCxNQUFhLDJCQUE0QixTQUFRLHNCQUFTOztJQUN4RCxvRUFBb0U7SUFDN0QsTUFBTSxDQUFVLFFBQVEsR0FBRyxLQUFLLENBQUM7SUFFeEMsb0RBQW9EO0lBQ3BDLFVBQVUsQ0FBUztJQUVuQywwQ0FBMEM7SUFDMUIsU0FBUyxDQUFTO0lBRWxDLG9FQUFvRTtJQUNwRCxPQUFPLENBQVM7SUFFZixNQUFNLENBQVk7SUFFbkMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUEwQyxFQUFFO1FBQ3BGLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRTtZQUMxQyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsU0FBUyxFQUFFLElBQUk7WUFDZixpQkFBaUIsRUFBRSxFQUFFLENBQUMsaUJBQWlCLENBQUMsU0FBUztZQUNqRCxVQUFVLEVBQUUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFVBQVU7WUFDMUMsVUFBVSxFQUFFLElBQUk7WUFDaEIsY0FBYyxFQUFFLENBQUMsRUFBRSxtQ0FBbUMsRUFBRSxzQkFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUM7WUFDMUYsZUFBZSxFQUFFLEVBQUUsQ0FBQyxlQUFlLENBQUMscUJBQXFCO1NBQzFELENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUM7UUFDekMsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQztRQUN2QyxJQUFJLENBQUMsT0FBTyxHQUFHLDJCQUEyQixDQUFDLFFBQVEsQ0FBQztJQUN0RCxDQUFDO0lBRUQ7Ozs7Ozs7OztPQVNHO0lBQ0ksV0FBVyxDQUFDLE9BQXVCLEVBQUUsYUFBcUIsRUFBRSxRQUFnQjtRQUNqRixPQUFPLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsYUFBYSxFQUFFLFFBQVEsRUFBRSxjQUFjLENBQUMsQ0FBQztJQUNqRixDQUFDO0lBRUQ7Ozs7OztPQU1HO0lBQ0ksa0JBQWtCLENBQUMsT0FBdUIsRUFBRSxhQUFxQixFQUFFLFFBQWdCO1FBQ3hGLE9BQU8sSUFBSSxDQUFDLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxhQUFhLEVBQUUsUUFBUSxFQUFFLHFCQUFxQixDQUFDLENBQUM7SUFDeEYsQ0FBQztJQUVPLGdCQUFnQixDQUN0QixPQUF1QixFQUN2QixhQUFxQixFQUNyQixRQUFnQixFQUNoQixNQUFjO1FBRWQsSUFBSSxDQUFDLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUN4QyxNQUFNLElBQUksS0FBSyxDQUFDLDREQUE0RCxDQUFDLENBQUM7UUFDaEYsQ0FBQztRQUVELE1BQU0sSUFBSSxHQUFHLHFCQUFxQixDQUFDLGFBQWEsRUFBRSxlQUFlLEVBQUUsc0JBQXNCLENBQUMsQ0FBQztRQUMzRixNQUFNLEVBQUUsR0FBRyxxQkFBcUIsQ0FBQyxRQUFRLEVBQUUsVUFBVSxFQUFFLGlCQUFpQixDQUFDLENBQUM7UUFDMUUsTUFBTSxTQUFTLEdBQUcsZ0JBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUMsMkJBQTJCLENBQUMsUUFBUSxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUVyRixPQUFPLEdBQUcsQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDO1lBQzlCLE9BQU87WUFDUCxPQUFPLEVBQUUsQ0FBQyxNQUFNLENBQUM7WUFDakIsWUFBWSxFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUM7U0FDckQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQzs7QUE3RUgsa0VBOEVDO0FBRUQsU0FBUyxxQkFBcUIsQ0FBQyxLQUFhLEVBQUUsUUFBZ0IsRUFBRSxPQUFlO0lBQzdFLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDMUMsTUFBTSxJQUFJLEtBQUssQ0FBQyx3Q0FBd0MsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUN0RSxDQUFDO0lBQ0QsSUFBSSxtQkFBSyxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzlCLE1BQU0sSUFBSSxLQUFLLENBQ2IsK0JBQStCLFFBQVEsMkpBQTJKLENBQ25NLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUN6QixNQUFNLElBQUksS0FBSyxDQUFDLCtCQUErQixRQUFRLGVBQWUsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDMUYsQ0FBQztJQUNELE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uLCBGbiwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuY29uc3QgTkFNRVNQQUNFX1NMVUdfUEFUVEVSTiA9IC9eW2EtejAtOV1bYS16MC05LV17MSw2Mn0kLztcbmNvbnN0IEJVTkRMRV9JRF9QQVRURVJOID0gL15yZWxfWzAtOWEtel17MjZ9JC87XG5cbi8qKlxuICogUHJvcHMgZm9yIHRoZSBBcHBUaGVvcnlTM1ZlcnNpb25lZEluZ3Jlc3MgY29uc3RydWN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzc1Byb3BzIHtcbiAgLyoqXG4gICAqIFBoeXNpY2FsIG5hbWUgZm9yIHRoZSBhcnRpZmFjdCBpbmdyZXNzIGJ1Y2tldC5cbiAgICpcbiAgICogVG9rZW4tdmFsdWVkIG5hbWVzIHBhc3MgdGhyb3VnaCB0byB0aGUgUzMgY29uc3RydWN0IHVuY2hhbmdlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZSlcbiAgICovXG4gIHJlYWRvbmx5IGJ1Y2tldE5hbWU/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogVmVyc2lvbi1waW5uZWQgYXJ0aWZhY3QgaW5ncmVzcyBidWNrZXQgZm9yIFRoZW9yeSBDbG91ZCBuYW1lc3BhY2UgcmVsZWFzZXMuXG4gKlxuICogVGhlIGNvbnN0cnVjdCBvd25zIG9uZSBoYXJkZW5lZCwgdmVyc2lvbmVkIGJ1Y2tldCwgaXRzIHNldmVuLWRheSBpbmNvbXBsZXRlXG4gKiBtdWx0aXBhcnQtdXBsb2FkIHJlYXBpbmcgcnVsZSwgYW5kIHRoZSBvbmUtYWN0aW9uIElBTSBncmFudCBwYXRoIGZvclxuICogbmFtZXNwYWNlIGJ1bmRsZXMuIEdyYW50IGxvY2F0aW9ucyBtdXN0IGJlIGxpdGVyYWwgdmFsdWVzLCBzbyBldmVyeSBncmFudFxuICogdGFyZ2V0cyBvbmUgZXhhY3Qgb2JqZWN0IGtleTsgdW5yZXNvbHZlZCB0b2tlbiBsb2NhdGlvbnMgYXJlIHJlamVjdGVkLiBJdFxuICogZG9lcyBub3QgaXNzdWUgdGVtcG9yYXJ5IGNyZWRlbnRpYWxzLCBtaW50IGJ1bmRsZSBpZGVudGlmaWVycywgb3IgZGVmaW5lXG4gKiBhcnRpZmFjdCBVUkkgc2NoZW1lcy5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzcyBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKiBDYW5vbmljYWwgb2JqZWN0LWtleSByb290IGZvciBldmVyeSBuYW1lc3BhY2UgcmVsZWFzZSBidW5kbGUuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgS0VZX1JPT1QgPSBcIm5zL1wiO1xuXG4gIC8qKiBDbG91ZEZvcm1hdGlvbi1yZXNvbHZlZCBwaHlzaWNhbCBidWNrZXQgbmFtZS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldE5hbWU6IHN0cmluZztcblxuICAvKiogQ2xvdWRGb3JtYXRpb24tcmVzb2x2ZWQgYnVja2V0IEFSTi4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldEFybjogc3RyaW5nO1xuXG4gIC8qKiBDYW5vbmljYWwgb2JqZWN0LWtleSByb290IGZvciBldmVyeSBuYW1lc3BhY2UgcmVsZWFzZSBidW5kbGUuICovXG4gIHB1YmxpYyByZWFkb25seSBrZXlSb290OiBzdHJpbmc7XG5cbiAgcHJpdmF0ZSByZWFkb25seSBidWNrZXQ6IHMzLkJ1Y2tldDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UzNWZXJzaW9uZWRJbmdyZXNzUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgXCJCdWNrZXRcIiwge1xuICAgICAgYnVja2V0TmFtZTogcHJvcHMuYnVja2V0TmFtZSxcbiAgICAgIHZlcnNpb25lZDogdHJ1ZSxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFt7IGFib3J0SW5jb21wbGV0ZU11bHRpcGFydFVwbG9hZEFmdGVyOiBEdXJhdGlvbi5kYXlzKDcpLCBlbmFibGVkOiB0cnVlIH1dLFxuICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuQlVDS0VUX09XTkVSX0VORk9SQ0VELFxuICAgIH0pO1xuXG4gICAgdGhpcy5idWNrZXROYW1lID0gdGhpcy5idWNrZXQuYnVja2V0TmFtZTtcbiAgICB0aGlzLmJ1Y2tldEFybiA9IHRoaXMuYnVja2V0LmJ1Y2tldEFybjtcbiAgICB0aGlzLmtleVJvb3QgPSBBcHBUaGVvcnlTM1ZlcnNpb25lZEluZ3Jlc3MuS0VZX1JPT1Q7XG4gIH1cblxuICAvKipcbiAgICogR3JhbnQgb25lIHByaW5jaXBhbCBgczM6UHV0T2JqZWN0YCBvbiBvbmUgbmFtZXNwYWNlIGJ1bmRsZSByZXNvdXJjZS5cbiAgICpcbiAgICogYHMzOlB1dE9iamVjdGAgaW5oZXJlbnRseSBjb3ZlcnMgbXVsdGlwYXJ0IGNyZWF0ZSwgcGFydCB1cGxvYWQsIGFuZFxuICAgKiBjb21wbGV0aW9uIG9uIHRoZSBzYW1lIGtleTsgc2VwYXJhdGUgYWJvcnQgYW5kIHBhcnQtbGlzdGluZyBhY3Rpb25zIHJlbWFpblxuICAgKiB1bmdyYW50ZWQuIExvY2F0aW9uIHZhbHVlcyBtdXN0IGJlIGxpdGVyYWwgc3RyaW5nczogQXBwVGhlb3J5IHZhbGlkYXRlcyB0aGVtXG4gICAqIGF0IHN5bnRoZXNpcyBhbmQgcmVqZWN0cyB1bnJlc29sdmVkIENESyB0b2tlbnMsIGJlY2F1c2UgYSBncmFudCBjYW5ub3RcbiAgICogZ3VhcmFudGVlIGFuIGV4YWN0IGtleSBmb3IgYSBsb2NhdGlvbiB0aGF0IENsb3VkRm9ybWF0aW9uIG9ubHkgcmVzb2x2ZXMgYXRcbiAgICogZGVwbG95bWVudC4gTWlzc2luZyBpbnB1dHMgc3RpbGwgZmFpbCBjbG9zZWQgYmVmb3JlIGFueSBncmFudCBpcyBhZGRlZC5cbiAgICovXG4gIHB1YmxpYyBncmFudFVwbG9hZChncmFudGVlOiBpYW0uSUdyYW50YWJsZSwgbmFtZXNwYWNlU2x1Zzogc3RyaW5nLCBidW5kbGVJZDogc3RyaW5nKTogaWFtLkdyYW50IHtcbiAgICByZXR1cm4gdGhpcy5ncmFudEV4YWN0T2JqZWN0KGdyYW50ZWUsIG5hbWVzcGFjZVNsdWcsIGJ1bmRsZUlkLCBcInMzOlB1dE9iamVjdFwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHcmFudCBvbmUgcHJpbmNpcGFsIHBlcm1pc3Npb24gdG8gcmVhZCBvbmUgcGlubmVkIG5hbWVzcGFjZSBidW5kbGUgdmVyc2lvbi5cbiAgICpcbiAgICogVGhlIGdyYW50IGluY2x1ZGVzIG9ubHkgYHMzOkdldE9iamVjdFZlcnNpb25gLiBJbnB1dHMgbXVzdCBiZSBsaXRlcmFsXG4gICAqIHN0cmluZ3MgYW5kIHRhcmdldCBvbmUgZXhhY3QgYnVuZGxlIGtleTsgdW5yZXNvbHZlZCBDREsgdG9rZW5zIGFyZSByZWplY3RlZC5cbiAgICogVW52ZXJzaW9uZWQgcmVhZHMgYW5kIGJ1Y2tldCBsaXN0aW5nIHJlbWFpbiB1bmdyYW50ZWQuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnRWZXJzaW9uZWRSZWFkKGdyYW50ZWU6IGlhbS5JR3JhbnRhYmxlLCBuYW1lc3BhY2VTbHVnOiBzdHJpbmcsIGJ1bmRsZUlkOiBzdHJpbmcpOiBpYW0uR3JhbnQge1xuICAgIHJldHVybiB0aGlzLmdyYW50RXhhY3RPYmplY3QoZ3JhbnRlZSwgbmFtZXNwYWNlU2x1ZywgYnVuZGxlSWQsIFwiczM6R2V0T2JqZWN0VmVyc2lvblwiKTtcbiAgfVxuXG4gIHByaXZhdGUgZ3JhbnRFeGFjdE9iamVjdChcbiAgICBncmFudGVlOiBpYW0uSUdyYW50YWJsZSxcbiAgICBuYW1lc3BhY2VTbHVnOiBzdHJpbmcsXG4gICAgYnVuZGxlSWQ6IHN0cmluZyxcbiAgICBhY3Rpb246IHN0cmluZyxcbiAgKTogaWFtLkdyYW50IHtcbiAgICBpZiAoIWdyYW50ZWUgfHwgIWdyYW50ZWUuZ3JhbnRQcmluY2lwYWwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzcyByZXF1aXJlcyBhIGdyYW50YWJsZSBwcmluY2lwYWxcIik7XG4gICAgfVxuXG4gICAgY29uc3Qgc2x1ZyA9IHZhbGlkYXRlTG9jYXRpb25WYWx1ZShuYW1lc3BhY2VTbHVnLCBcIm5hbWVzcGFjZVNsdWdcIiwgTkFNRVNQQUNFX1NMVUdfUEFUVEVSTik7XG4gICAgY29uc3QgaWQgPSB2YWxpZGF0ZUxvY2F0aW9uVmFsdWUoYnVuZGxlSWQsIFwiYnVuZGxlSWRcIiwgQlVORExFX0lEX1BBVFRFUk4pO1xuICAgIGNvbnN0IG9iamVjdEtleSA9IEZuLmpvaW4oXCJcIiwgW0FwcFRoZW9yeVMzVmVyc2lvbmVkSW5ncmVzcy5LRVlfUk9PVCwgc2x1ZywgXCIvXCIsIGlkXSk7XG5cbiAgICByZXR1cm4gaWFtLkdyYW50LmFkZFRvUHJpbmNpcGFsKHtcbiAgICAgIGdyYW50ZWUsXG4gICAgICBhY3Rpb25zOiBbYWN0aW9uXSxcbiAgICAgIHJlc291cmNlQXJuczogW3RoaXMuYnVja2V0LmFybkZvck9iamVjdHMob2JqZWN0S2V5KV0sXG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMb2NhdGlvblZhbHVlKHZhbHVlOiBzdHJpbmcsIHByb3BOYW1lOiBzdHJpbmcsIHBhdHRlcm46IFJlZ0V4cCk6IHN0cmluZyB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTM1ZlcnNpb25lZEluZ3Jlc3MgcmVxdWlyZXMgJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlTM1ZlcnNpb25lZEluZ3Jlc3MgJHtwcm9wTmFtZX0gbXVzdCBiZSBhIGxpdGVyYWwgdmFsdWU7IHVucmVzb2x2ZWQgQ0RLIHRva2VucyBhcmUgcmVqZWN0ZWQgYmVjYXVzZSBBcHBUaGVvcnkgY2Fubm90IGd1YXJhbnRlZSBhbiBleGFjdC1rZXkgZ3JhbnQgZm9yIGEgQ2xvdWRGb3JtYXRpb24tcmVzb2x2ZWQgbG9jYXRpb25gLFxuICAgICk7XG4gIH1cbiAgaWYgKCFwYXR0ZXJuLnRlc3QodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlTM1ZlcnNpb25lZEluZ3Jlc3MgJHtwcm9wTmFtZX0gbXVzdCBtYXRjaCAke3BhdHRlcm4uc291cmNlfWApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cbiJdfQ==