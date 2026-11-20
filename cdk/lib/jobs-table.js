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
exports.AppTheoryJobsTable = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const constructs_1 = require("constructs");
const secure_defaults_1 = require("./private/secure-defaults");
/**
 * Opinionated DynamoDB table for import pipeline job ledgers.
 *
 * Canonical schema:
 * - PK: `pk` (string)
 * - SK: `sk` (string)
 *
 * Canonical GSIs (locked by ADR 0002):
 * - `status-created-index`: `status` (pk) + `created_at` (sk)
 * - `tenant-created-index`: `tenant_id` (pk) + `created_at` (sk)
 *
 * Canonical TTL attribute:
 * - `ttl` (configurable)
 */
class AppTheoryJobsTable extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryJobsTable", version: "7.4.0" };
    table;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const billingMode = props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const ttlAttribute = props.timeToLiveAttribute ?? "ttl";
        const enablePITR = props.enablePointInTimeRecovery ?? true;
        const encryption = props.encryption ?? dynamodb.TableEncryption.AWS_MANAGED;
        const deletionProtection = (0, secure_defaults_1.defaultDeletionProtection)(props.namingContext, removalPolicy, props.deletionProtection);
        if (encryption === dynamodb.TableEncryption.CUSTOMER_MANAGED && !props.encryptionKey) {
            throw new Error("AppTheoryJobsTable requires encryptionKey when encryption is CUSTOMER_MANAGED");
        }
        this.table = new dynamodb.Table(this, "Table", {
            tableName: props.tableName,
            billingMode,
            partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
            sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
            timeToLiveAttribute: ttlAttribute,
            removalPolicy,
            deletionProtection: deletionProtection,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: enablePITR,
            },
            encryption,
            encryptionKey: props.encryptionKey,
            ...(billingMode === dynamodb.BillingMode.PROVISIONED
                ? {
                    readCapacity: props.readCapacity ?? 5,
                    writeCapacity: props.writeCapacity ?? 5,
                }
                : {}),
        });
        this.table.addGlobalSecondaryIndex({
            indexName: "status-created-index",
            partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
            sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
            ...(billingMode === dynamodb.BillingMode.PROVISIONED
                ? {
                    readCapacity: 5,
                    writeCapacity: 5,
                }
                : {}),
        });
        this.table.addGlobalSecondaryIndex({
            indexName: "tenant-created-index",
            partitionKey: { name: "tenant_id", type: dynamodb.AttributeType.STRING },
            sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
            ...(billingMode === dynamodb.BillingMode.PROVISIONED
                ? {
                    readCapacity: 5,
                    writeCapacity: 5,
                }
                : {}),
        });
        for (const grantee of props.grantReadTo ?? []) {
            this.table.grantReadData(grantee);
        }
        for (const grantee of props.grantWriteTo ?? []) {
            this.table.grantWriteData(grantee);
        }
        for (const grantee of props.grantReadWriteTo ?? []) {
            this.table.grantReadWriteData(grantee);
        }
    }
    /**
     * Binds the canonical jobs table env var to a Lambda function.
     */
    bindEnvironment(fn) {
        fn.addEnvironment("APPTHEORY_JOBS_TABLE_NAME", this.table.tableName);
    }
    /**
     * Grant DynamoDB read permissions.
     */
    grantReadTo(grantee) {
        this.table.grantReadData(grantee);
    }
    /**
     * Grant DynamoDB write permissions.
     */
    grantWriteTo(grantee) {
        this.table.grantWriteData(grantee);
    }
    /**
     * Grant DynamoDB read/write permissions.
     */
    grantReadWriteTo(grantee) {
        this.table.grantReadWriteData(grantee);
    }
}
exports.AppTheoryJobsTable = AppTheoryJobsTable;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiam9icy10YWJsZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImpvYnMtdGFibGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE0QztBQUM1QyxtRUFBcUQ7QUFJckQsMkNBQXVDO0FBR3ZDLCtEQUFzRTtBQTBGdEU7Ozs7Ozs7Ozs7Ozs7R0FhRztBQUNILE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7O0lBQy9CLEtBQUssQ0FBaUI7SUFFdEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFpQyxFQUFFO1FBQzNFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWUsQ0FBQztRQUM5RSxNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxJQUFJLDJCQUFhLENBQUMsTUFBTSxDQUFDO1FBQ2xFLE1BQU0sWUFBWSxHQUFHLEtBQUssQ0FBQyxtQkFBbUIsSUFBSSxLQUFLLENBQUM7UUFDeEQsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLHlCQUF5QixJQUFJLElBQUksQ0FBQztRQUMzRCxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsVUFBVSxJQUFJLFFBQVEsQ0FBQyxlQUFlLENBQUMsV0FBVyxDQUFDO1FBQzVFLE1BQU0sa0JBQWtCLEdBQUcsSUFBQSwyQ0FBeUIsRUFDbEQsS0FBSyxDQUFDLGFBQWEsRUFDbkIsYUFBYSxFQUNiLEtBQUssQ0FBQyxrQkFBa0IsQ0FDekIsQ0FBQztRQUVGLElBQUksVUFBVSxLQUFLLFFBQVEsQ0FBQyxlQUFlLENBQUMsZ0JBQWdCLElBQUksQ0FBQyxLQUFLLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDckYsTUFBTSxJQUFJLEtBQUssQ0FBQywrRUFBK0UsQ0FBQyxDQUFDO1FBQ25HLENBQUM7UUFFRCxJQUFJ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Q0FBQyxDQUFDO1FBQ3pDLENBQUM7SUFDSCxDQUFDO0lBRUQ7O09BRUc7SUFDSSxlQUFlLENBQUMsRUFBbUI7UUFDeEMsRUFBRSxDQUFDLGNBQWMsQ0FBQywyQkFBMkIsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7SUFFRDs7T0FFRztJQUNJLFdBQVcsQ0FBQyxPQUF1QjtRQUN4QyxJQUFJLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNwQyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxZQUFZLENBQUMsT0FBdUI7UUFDekMsSUFBSSxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDckMsQ0FBQztJQUVEOztPQUVHO0lBQ0ksZ0JBQWdCLENBQUMsT0FBdUI7UUFDN0MsSUFBSSxDQUFDLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN6QyxDQUFDOztBQXpHSCxnREEwR0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0IHR5cGUgKiBhcyBrbXMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1rbXNcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuaW1wb3J0IHsgZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbiB9IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5Sm9ic1RhYmxlUHJvcHMge1xuICAvKipcbiAgICogT3B0aW9uYWwgdGFibGUgbmFtZS5cbiAgICogQGRlZmF1bHQgLSBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZVxuICAgKi9cbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBCaWxsaW5nIG1vZGUgZm9yIHRoZSB0YWJsZS5cbiAgICogQGRlZmF1bHQgUEFZX1BFUl9SRVFVRVNUXG4gICAqL1xuICByZWFkb25seSBiaWxsaW5nTW9kZT86IGR5bmFtb2RiLkJpbGxpbmdNb2RlO1xuXG4gIC8qKlxuICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgdGhlIHRhYmxlLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgZGVsZXRpb24gcHJvdGVjdGlvbiBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHRhYmxlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHdpdGggbm8gbmFtaW5nIGNvbnRleHQ6IHRoZSBBV1MgZGVmYXVsdCwgbm8gZGVsZXRpb25cbiAgICogcHJvdGVjdGlvbjsgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0OiBvbiBmb3IgYSBSRVRBSU4gdGFibGUsIG9mZiBvdGhlcndpc2UpXG4gICAqL1xuICByZWFkb25seSBkZWxldGlvblByb3RlY3Rpb24/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBUVEwgYXR0cmlidXRlIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwidHRsXCJcbiAgICovXG4gIHJlYWRvbmx5IHRpbWVUb0xpdmVBdHRyaWJ1dGU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgcG9pbnQtaW4tdGltZSByZWNvdmVyeSBzaG91bGQgYmUgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlUG9pbnRJblRpbWVSZWNvdmVyeT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRhYmxlIGVuY3J5cHRpb24gc2V0dGluZy5cbiAgICogQGRlZmF1bHQgQVdTX01BTkFHRURcbiAgICovXG4gIHJlYWRvbmx5IGVuY3J5cHRpb24/OiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb247XG5cbiAgLyoqXG4gICAqIEN1c3RvbWVyLW1hbmFnZWQgS01TIGtleSAocmVxdWlyZWQgd2hlbiBlbmNyeXB0aW9uIGlzIENVU1RPTUVSX01BTkFHRUQpLlxuICAgKi9cbiAgcmVhZG9ubHkgZW5jcnlwdGlvbktleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBQcm92aXNpb25lZCByZWFkIGNhcGFjaXR5IChvbmx5IHVzZWQgd2hlbiBiaWxsaW5nTW9kZSBpcyBQUk9WSVNJT05FRCkuXG4gICAqIEBkZWZhdWx0IDVcbiAgICovXG4gIHJlYWRvbmx5IHJlYWRDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgd3JpdGUgY2FwYWNpdHkgKG9ubHkgdXNlZCB3aGVuIGJpbGxpbmdNb2RlIGlzIFBST1ZJU0lPTkVEKS5cbiAgICogQGRlZmF1bHQgNVxuICAgKi9cbiAgcmVhZG9ubHkgd3JpdGVDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogUHJpbmNpcGFscyB0byBncmFudCBEeW5hbW9EQiByZWFkIHBlcm1pc3Npb25zIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgZ3JhbnRSZWFkVG8/OiBpYW0uSUdyYW50YWJsZVtdO1xuXG4gIC8qKlxuICAgKiBQcmluY2lwYWxzIHRvIGdyYW50IER5bmFtb0RCIHdyaXRlIHBlcm1pc3Npb25zIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgZ3JhbnRXcml0ZVRvPzogaWFtLklHcmFudGFibGVbXTtcblxuICAvKipcbiAgICogUHJpbmNpcGFscyB0byBncmFudCBEeW5hbW9EQiByZWFkL3dyaXRlIHBlcm1pc3Npb25zIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgZ3JhbnRSZWFkV3JpdGVUbz86IGlhbS5JR3JhbnRhYmxlW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBjb250ZXh0LiBVbmRlciBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgdGhlIHRhYmxlIHRha2VzIHRoZSBjb250cmFjdCdzXG4gICAqIFNlY3VyaXR5IEh1Yi1hbGlnbmVkIGRlZmF1bHRzOiBwb2ludC1pbi10aW1lIHJlY292ZXJ5IG9uLCBhbmQgZGVsZXRpb25cbiAgICogcHJvdGVjdGlvbiBvbiBmb3IgYSBSRVRBSU4gdGFibGUuXG4gICAqXG4gICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xufVxuXG4vKipcbiAqIE9waW5pb25hdGVkIER5bmFtb0RCIHRhYmxlIGZvciBpbXBvcnQgcGlwZWxpbmUgam9iIGxlZGdlcnMuXG4gKlxuICogQ2Fub25pY2FsIHNjaGVtYTpcbiAqIC0gUEs6IGBwa2AgKHN0cmluZylcbiAqIC0gU0s6IGBza2AgKHN0cmluZylcbiAqXG4gKiBDYW5vbmljYWwgR1NJcyAobG9ja2VkIGJ5IEFEUiAwMDAyKTpcbiAqIC0gYHN0YXR1cy1jcmVhdGVkLWluZGV4YDogYHN0YXR1c2AgKHBrKSArIGBjcmVhdGVkX2F0YCAoc2spXG4gKiAtIGB0ZW5hbnQtY3JlYXRlZC1pbmRleGA6IGB0ZW5hbnRfaWRgIChwaykgKyBgY3JlYXRlZF9hdGAgKHNrKVxuICpcbiAqIENhbm9uaWNhbCBUVEwgYXR0cmlidXRlOlxuICogLSBgdHRsYCAoY29uZmlndXJhYmxlKVxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5Sm9ic1RhYmxlIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IHRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5Sm9ic1RhYmxlUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBiaWxsaW5nTW9kZSA9IHByb3BzLmJpbGxpbmdNb2RlID8/IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVDtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCB0dGxBdHRyaWJ1dGUgPSBwcm9wcy50aW1lVG9MaXZlQXR0cmlidXRlID8/IFwidHRsXCI7XG4gICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmVuYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcbiAgICBjb25zdCBlbmNyeXB0aW9uID0gcHJvcHMuZW5jcnlwdGlvbiA/PyBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQ7XG4gICAgY29uc3QgZGVsZXRpb25Qcm90ZWN0aW9uID0gZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbihcbiAgICAgIHByb3BzLm5hbWluZ0NvbnRleHQsXG4gICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgcHJvcHMuZGVsZXRpb25Qcm90ZWN0aW9uLFxuICAgICk7XG5cbiAgICBpZiAoZW5jcnlwdGlvbiA9PT0gZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkNVU1RPTUVSX01BTkFHRUQgJiYgIXByb3BzLmVuY3J5cHRpb25LZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUpvYnNUYWJsZSByZXF1aXJlcyBlbmNyeXB0aW9uS2V5IHdoZW4gZW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VEXCIpO1xuICAgIH1cblxuICAgIHRoaXMudGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJUYWJsZVwiLCB7XG4gICAgICB0YWJsZU5hbWU6IHByb3BzLnRhYmxlTmFtZSxcbiAgICAgIGJpbGxpbmdNb2RlLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwicGtcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJza1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogdHRsQXR0cmlidXRlLFxuICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogZGVsZXRpb25Qcm90ZWN0aW9uLFxuICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IGVuYWJsZVBJVFIsXG4gICAgICB9LFxuICAgICAgZW5jcnlwdGlvbixcbiAgICAgIGVuY3J5cHRpb25LZXk6IHByb3BzLmVuY3J5cHRpb25LZXksXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhZENhcGFjaXR5OiBwcm9wcy5yZWFkQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IHByb3BzLndyaXRlQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgdGhpcy50YWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6IFwic3RhdHVzLWNyZWF0ZWQtaW5kZXhcIixcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInN0YXR1c1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiBcImNyZWF0ZWRfYXRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhZENhcGFjaXR5OiA1LFxuICAgICAgICAgICAgd3JpdGVDYXBhY2l0eTogNSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgdGhpcy50YWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6IFwidGVuYW50LWNyZWF0ZWQtaW5kZXhcIixcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInRlbmFudF9pZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiBcImNyZWF0ZWRfYXRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhZENhcGFjaXR5OiA1LFxuICAgICAgICAgICAgd3JpdGVDYXBhY2l0eTogNSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgZm9yIChjb25zdCBncmFudGVlIG9mIHByb3BzLmdyYW50UmVhZFRvID8/IFtdKSB7XG4gICAgICB0aGlzLnRhYmxlLmdyYW50UmVhZERhdGEoZ3JhbnRlZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudFdyaXRlVG8gPz8gW10pIHtcbiAgICAgIHRoaXMudGFibGUuZ3JhbnRXcml0ZURhdGEoZ3JhbnRlZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudFJlYWRXcml0ZVRvID8/IFtdKSB7XG4gICAgICB0aGlzLnRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShncmFudGVlKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQmluZHMgdGhlIGNhbm9uaWNhbCBqb2JzIHRhYmxlIGVudiB2YXIgdG8gYSBMYW1iZGEgZnVuY3Rpb24uXG4gICAqL1xuICBwdWJsaWMgYmluZEVudmlyb25tZW50KGZuOiBsYW1iZGEuRnVuY3Rpb24pOiB2b2lkIHtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFQUFRIRU9SWV9KT0JTX1RBQkxFX05BTUVcIiwgdGhpcy50YWJsZS50YWJsZU5hbWUpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IER5bmFtb0RCIHJlYWQgcGVybWlzc2lvbnMuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnRSZWFkVG8oZ3JhbnRlZTogaWFtLklHcmFudGFibGUpOiB2b2lkIHtcbiAgICB0aGlzLnRhYmxlLmdyYW50UmVhZERhdGEoZ3JhbnRlZSk7XG4gIH1cblxuICAvKipcbiAgICogR3JhbnQgRHluYW1vREIgd3JpdGUgcGVybWlzc2lvbnMuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnRXcml0ZVRvKGdyYW50ZWU6IGlhbS5JR3JhbnRhYmxlKTogdm9pZCB7XG4gICAgdGhpcy50YWJsZS5ncmFudFdyaXRlRGF0YShncmFudGVlKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHcmFudCBEeW5hbW9EQiByZWFkL3dyaXRlIHBlcm1pc3Npb25zLlxuICAgKi9cbiAgcHVibGljIGdyYW50UmVhZFdyaXRlVG8oZ3JhbnRlZTogaWFtLklHcmFudGFibGUpOiB2b2lkIHtcbiAgICB0aGlzLnRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShncmFudGVlKTtcbiAgfVxufVxuIl19