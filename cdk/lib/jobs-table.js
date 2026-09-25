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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryJobsTable", version: "4.4.1-rc" };
    table;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const billingMode = props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const ttlAttribute = props.timeToLiveAttribute ?? "ttl";
        const enablePITR = props.enablePointInTimeRecovery ?? true;
        const encryption = props.encryption ?? dynamodb.TableEncryption.AWS_MANAGED;
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
            deletionProtection: props.deletionProtection,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiam9icy10YWJsZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImpvYnMtdGFibGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE0QztBQUM1QyxtRUFBcUQ7QUFJckQsMkNBQXVDO0FBOEV2Qzs7Ozs7Ozs7Ozs7OztHQWFHO0FBQ0gsTUFBYSxrQkFBbUIsU0FBUSxzQkFBUzs7SUFDL0IsS0FBSyxDQUFpQjtJQUV0QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLFFBQWlDLEVBQUU7UUFDM0UsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFdBQVcsR0FBRyxLQUFLLENBQUMsV0FBVyxJQUFJLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZSxDQUFDO1FBQzlFLE1BQU0sYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLElBQUksMkJBQWEsQ0FBQyxNQUFNLENBQUM7UUFDbEUsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLG1CQUFtQixJQUFJLEtBQUssQ0FBQztRQUN4RCxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMseUJBQXlCLElBQUksSUFBSSxDQUFDO1FBQzNELE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxVQUFVLElBQUksUUFBUSxDQUFDLGVBQWUsQ0FBQyxXQUFXLENBQUM7UUFFNUUsSUFBSSxVQUFVLEtBQUssUUFBUSxDQUFDLGVBQWUsQ0FBQyxnQkFBZ0IsSUFBSSxDQUFDLEtBQUssQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUNyRixNQUFNLElBQUksS0FBSyxDQUFDLCtFQUErRSxDQUFDLENBQUM7UUFDbkcsQ0FBQztRQUVELElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7WUFDN0MsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQzFCLFdBQVc7WUFDWCxZQUFZ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QUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7SUFFRDs7T0FFRztJQUNJLFdBQVcsQ0FBQyxPQUF1QjtRQUN4QyxJQUFJLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNwQyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxZQUFZLENBQUMsT0FBdUI7UUFDekMsSUFBSSxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDckMsQ0FBQztJQUVEOztPQUVHO0lBQ0ksZ0JBQWdCLENBQUMsT0FBdUI7UUFDN0MsSUFBSSxDQUFDLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN6QyxDQUFDOztBQXBHSCxnREFxR0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0IHR5cGUgKiBhcyBrbXMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1rbXNcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUpvYnNUYWJsZVByb3BzIHtcbiAgLyoqXG4gICAqIE9wdGlvbmFsIHRhYmxlIG5hbWUuXG4gICAqIEBkZWZhdWx0IC0gQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkIG5hbWVcbiAgICovXG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQmlsbGluZyBtb2RlIGZvciB0aGUgdGFibGUuXG4gICAqIEBkZWZhdWx0IFBBWV9QRVJfUkVRVUVTVFxuICAgKi9cbiAgcmVhZG9ubHkgYmlsbGluZ01vZGU/OiBkeW5hbW9kYi5CaWxsaW5nTW9kZTtcblxuICAvKipcbiAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIHRoZSB0YWJsZS5cbiAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICovXG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGRlbGV0aW9uIHByb3RlY3Rpb24gc2hvdWxkIGJlIGVuYWJsZWQgZm9yIHRoZSB0YWJsZS5cbiAgICogQGRlZmF1bHQgLSBBV1MgZGVmYXVsdCAobm8gZGVsZXRpb24gcHJvdGVjdGlvbilcbiAgICovXG4gIHJlYWRvbmx5IGRlbGV0aW9uUHJvdGVjdGlvbj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRUTCBhdHRyaWJ1dGUgbmFtZS5cbiAgICogQGRlZmF1bHQgXCJ0dGxcIlxuICAgKi9cbiAgcmVhZG9ubHkgdGltZVRvTGl2ZUF0dHJpYnV0ZT86IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciBwb2ludC1pbi10aW1lIHJlY292ZXJ5IHNob3VsZCBiZSBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVQb2ludEluVGltZVJlY292ZXJ5PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogVGFibGUgZW5jcnlwdGlvbiBzZXR0aW5nLlxuICAgKiBAZGVmYXVsdCBBV1NfTUFOQUdFRFxuICAgKi9cbiAgcmVhZG9ubHkgZW5jcnlwdGlvbj86IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbjtcblxuICAvKipcbiAgICogQ3VzdG9tZXItbWFuYWdlZCBLTVMga2V5IChyZXF1aXJlZCB3aGVuIGVuY3J5cHRpb24gaXMgQ1VTVE9NRVJfTUFOQUdFRCkuXG4gICAqL1xuICByZWFkb25seSBlbmNyeXB0aW9uS2V5Pzoga21zLklLZXk7XG5cbiAgLyoqXG4gICAqIFByb3Zpc2lvbmVkIHJlYWQgY2FwYWNpdHkgKG9ubHkgdXNlZCB3aGVuIGJpbGxpbmdNb2RlIGlzIFBST1ZJU0lPTkVEKS5cbiAgICogQGRlZmF1bHQgNVxuICAgKi9cbiAgcmVhZG9ubHkgcmVhZENhcGFjaXR5PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBQcm92aXNpb25lZCB3cml0ZSBjYXBhY2l0eSAob25seSB1c2VkIHdoZW4gYmlsbGluZ01vZGUgaXMgUFJPVklTSU9ORUQpLlxuICAgKiBAZGVmYXVsdCA1XG4gICAqL1xuICByZWFkb25seSB3cml0ZUNhcGFjaXR5PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBQcmluY2lwYWxzIHRvIGdyYW50IER5bmFtb0RCIHJlYWQgcGVybWlzc2lvbnMgdG8uXG4gICAqL1xuICByZWFkb25seSBncmFudFJlYWRUbz86IGlhbS5JR3JhbnRhYmxlW107XG5cbiAgLyoqXG4gICAqIFByaW5jaXBhbHMgdG8gZ3JhbnQgRHluYW1vREIgd3JpdGUgcGVybWlzc2lvbnMgdG8uXG4gICAqL1xuICByZWFkb25seSBncmFudFdyaXRlVG8/OiBpYW0uSUdyYW50YWJsZVtdO1xuXG4gIC8qKlxuICAgKiBQcmluY2lwYWxzIHRvIGdyYW50IER5bmFtb0RCIHJlYWQvd3JpdGUgcGVybWlzc2lvbnMgdG8uXG4gICAqL1xuICByZWFkb25seSBncmFudFJlYWRXcml0ZVRvPzogaWFtLklHcmFudGFibGVbXTtcbn1cblxuLyoqXG4gKiBPcGluaW9uYXRlZCBEeW5hbW9EQiB0YWJsZSBmb3IgaW1wb3J0IHBpcGVsaW5lIGpvYiBsZWRnZXJzLlxuICpcbiAqIENhbm9uaWNhbCBzY2hlbWE6XG4gKiAtIFBLOiBgcGtgIChzdHJpbmcpXG4gKiAtIFNLOiBgc2tgIChzdHJpbmcpXG4gKlxuICogQ2Fub25pY2FsIEdTSXMgKGxvY2tlZCBieSBBRFIgMDAwMik6XG4gKiAtIGBzdGF0dXMtY3JlYXRlZC1pbmRleGA6IGBzdGF0dXNgIChwaykgKyBgY3JlYXRlZF9hdGAgKHNrKVxuICogLSBgdGVuYW50LWNyZWF0ZWQtaW5kZXhgOiBgdGVuYW50X2lkYCAocGspICsgYGNyZWF0ZWRfYXRgIChzaylcbiAqXG4gKiBDYW5vbmljYWwgVFRMIGF0dHJpYnV0ZTpcbiAqIC0gYHR0bGAgKGNvbmZpZ3VyYWJsZSlcbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUpvYnNUYWJsZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSB0YWJsZTogZHluYW1vZGIuVGFibGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUpvYnNUYWJsZVByb3BzID0ge30pIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgYmlsbGluZ01vZGUgPSBwcm9wcy5iaWxsaW5nTW9kZSA/PyBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1Q7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgdHRsQXR0cmlidXRlID0gcHJvcHMudGltZVRvTGl2ZUF0dHJpYnV0ZSA/PyBcInR0bFwiO1xuICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5lbmFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG4gICAgY29uc3QgZW5jcnlwdGlvbiA9IHByb3BzLmVuY3J5cHRpb24gPz8gZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VEO1xuXG4gICAgaWYgKGVuY3J5cHRpb24gPT09IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5DVVNUT01FUl9NQU5BR0VEICYmICFwcm9wcy5lbmNyeXB0aW9uS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlKb2JzVGFibGUgcmVxdWlyZXMgZW5jcnlwdGlvbktleSB3aGVuIGVuY3J5cHRpb24gaXMgQ1VTVE9NRVJfTUFOQUdFRFwiKTtcbiAgICB9XG5cbiAgICB0aGlzLnRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiVGFibGVcIiwge1xuICAgICAgdGFibGVOYW1lOiBwcm9wcy50YWJsZU5hbWUsXG4gICAgICBiaWxsaW5nTW9kZSxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInBrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6IFwic2tcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IHR0bEF0dHJpYnV0ZSxcbiAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICBkZWxldGlvblByb3RlY3Rpb246IHByb3BzLmRlbGV0aW9uUHJvdGVjdGlvbixcbiAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiBlbmFibGVQSVRSLFxuICAgICAgfSxcbiAgICAgIGVuY3J5cHRpb24sXG4gICAgICBlbmNyeXB0aW9uS2V5OiBwcm9wcy5lbmNyeXB0aW9uS2V5LFxuICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlYWRDYXBhY2l0eTogcHJvcHMucmVhZENhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgICB3cml0ZUNhcGFjaXR5OiBwcm9wcy53cml0ZUNhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgfVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcblxuICAgIHRoaXMudGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiBcInN0YXR1cy1jcmVhdGVkLWluZGV4XCIsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzdGF0dXNcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJjcmVhdGVkX2F0XCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlYWRDYXBhY2l0eTogNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IDUsXG4gICAgICAgICAgfVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcblxuICAgIHRoaXMudGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiBcInRlbmFudC1jcmVhdGVkLWluZGV4XCIsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJ0ZW5hbnRfaWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJjcmVhdGVkX2F0XCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlYWRDYXBhY2l0eTogNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IDUsXG4gICAgICAgICAgfVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcblxuICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudFJlYWRUbyA/PyBbXSkge1xuICAgICAgdGhpcy50YWJsZS5ncmFudFJlYWREYXRhKGdyYW50ZWUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGdyYW50ZWUgb2YgcHJvcHMuZ3JhbnRXcml0ZVRvID8/IFtdKSB7XG4gICAgICB0aGlzLnRhYmxlLmdyYW50V3JpdGVEYXRhKGdyYW50ZWUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGdyYW50ZWUgb2YgcHJvcHMuZ3JhbnRSZWFkV3JpdGVUbyA/PyBbXSkge1xuICAgICAgdGhpcy50YWJsZS5ncmFudFJlYWRXcml0ZURhdGEoZ3JhbnRlZSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEJpbmRzIHRoZSBjYW5vbmljYWwgam9icyB0YWJsZSBlbnYgdmFyIHRvIGEgTGFtYmRhIGZ1bmN0aW9uLlxuICAgKi9cbiAgcHVibGljIGJpbmRFbnZpcm9ubWVudChmbjogbGFtYmRhLkZ1bmN0aW9uKTogdm9pZCB7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBUFBUSEVPUllfSk9CU19UQUJMRV9OQU1FXCIsIHRoaXMudGFibGUudGFibGVOYW1lKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHcmFudCBEeW5hbW9EQiByZWFkIHBlcm1pc3Npb25zLlxuICAgKi9cbiAgcHVibGljIGdyYW50UmVhZFRvKGdyYW50ZWU6IGlhbS5JR3JhbnRhYmxlKTogdm9pZCB7XG4gICAgdGhpcy50YWJsZS5ncmFudFJlYWREYXRhKGdyYW50ZWUpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IER5bmFtb0RCIHdyaXRlIHBlcm1pc3Npb25zLlxuICAgKi9cbiAgcHVibGljIGdyYW50V3JpdGVUbyhncmFudGVlOiBpYW0uSUdyYW50YWJsZSk6IHZvaWQge1xuICAgIHRoaXMudGFibGUuZ3JhbnRXcml0ZURhdGEoZ3JhbnRlZSk7XG4gIH1cblxuICAvKipcbiAgICogR3JhbnQgRHluYW1vREIgcmVhZC93cml0ZSBwZXJtaXNzaW9ucy5cbiAgICovXG4gIHB1YmxpYyBncmFudFJlYWRXcml0ZVRvKGdyYW50ZWU6IGlhbS5JR3JhbnRhYmxlKTogdm9pZCB7XG4gICAgdGhpcy50YWJsZS5ncmFudFJlYWRXcml0ZURhdGEoZ3JhbnRlZSk7XG4gIH1cbn1cbiJdfQ==