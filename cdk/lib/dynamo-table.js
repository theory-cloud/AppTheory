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
exports.AppTheoryDynamoTable = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const constructs_1 = require("constructs");
class AppTheoryDynamoTable extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryDynamoTable", version: "4.3.0" };
    table;
    constructor(scope, id, props) {
        super(scope, id);
        const billingMode = props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const ttlAttribute = props.timeToLiveAttribute === undefined ? undefined : String(props.timeToLiveAttribute).trim();
        const enablePITR = props.enablePointInTimeRecovery ?? true;
        const encryption = props.encryption ?? dynamodb.TableEncryption.AWS_MANAGED;
        const enableStream = props.enableStream ?? false;
        if (props.timeToLiveAttribute !== undefined && !ttlAttribute) {
            throw new Error("AppTheoryDynamoTable requires timeToLiveAttribute to be a non-empty string when provided");
        }
        if (encryption === dynamodb.TableEncryption.CUSTOMER_MANAGED && !props.encryptionKey) {
            throw new Error("AppTheoryDynamoTable requires encryptionKey when encryption is CUSTOMER_MANAGED");
        }
        const stream = enableStream
            ? (props.streamViewType ?? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES)
            : undefined;
        this.table = new dynamodb.Table(this, "Table", {
            tableName: props.tableName,
            billingMode,
            partitionKey: {
                name: props.partitionKeyName,
                type: props.partitionKeyType ?? dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: props.sortKeyName,
                type: props.sortKeyType ?? dynamodb.AttributeType.STRING,
            },
            ...(ttlAttribute ? { timeToLiveAttribute: ttlAttribute } : {}),
            removalPolicy,
            deletionProtection: props.deletionProtection,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: enablePITR,
            },
            encryption,
            encryptionKey: props.encryptionKey,
            stream,
            ...(billingMode === dynamodb.BillingMode.PROVISIONED
                ? {
                    readCapacity: props.readCapacity ?? 5,
                    writeCapacity: props.writeCapacity ?? 5,
                }
                : {}),
        });
        for (const gsi of props.globalSecondaryIndexes ?? []) {
            this.table.addGlobalSecondaryIndex({
                indexName: gsi.indexName,
                partitionKey: {
                    name: gsi.partitionKeyName,
                    type: gsi.partitionKeyType ?? dynamodb.AttributeType.STRING,
                },
                sortKey: gsi.sortKeyName
                    ? {
                        name: gsi.sortKeyName,
                        type: gsi.sortKeyType ?? dynamodb.AttributeType.STRING,
                    }
                    : undefined,
                projectionType: gsi.projectionType ?? dynamodb.ProjectionType.ALL,
                nonKeyAttributes: gsi.nonKeyAttributes,
                ...(billingMode === dynamodb.BillingMode.PROVISIONED
                    ? {
                        readCapacity: gsi.readCapacity ?? 5,
                        writeCapacity: gsi.writeCapacity ?? 5,
                    }
                    : {}),
            });
        }
        for (const grantee of props.grantReadTo ?? []) {
            this.table.grantReadData(grantee);
        }
        for (const grantee of props.grantWriteTo ?? []) {
            this.table.grantWriteData(grantee);
        }
        for (const grantee of props.grantReadWriteTo ?? []) {
            this.table.grantReadWriteData(grantee);
        }
        if ((props.grantStreamReadTo ?? []).length > 0 && !enableStream) {
            throw new Error("AppTheoryDynamoTable requires enableStream when using grantStreamReadTo");
        }
        for (const grantee of props.grantStreamReadTo ?? []) {
            this.table.grantStreamRead(grantee);
        }
    }
}
exports.AppTheoryDynamoTable = AppTheoryDynamoTable;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZHluYW1vLXRhYmxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZHluYW1vLXRhYmxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNEM7QUFDNUMsbUVBQXFEO0FBR3JELDJDQUF1QztBQXVDdkMsTUFBYSxvQkFBcUIsU0FBUSxzQkFBUzs7SUFDakMsS0FBSyxDQUFpQjtJQUV0QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWdDO1FBQ3hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWUsQ0FBQztRQUM5RSxNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxJQUFJLDJCQUFhLENBQUMsTUFBTSxDQUFDO1FBQ2xFLE1BQU0sWUFBWSxHQUNoQixLQUFLLENBQUMsbUJBQW1CLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsbUJBQW1CLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNqRyxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMseUJBQXlCLElBQUksSUFBSSxDQUFDO1FBQzNELE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxVQUFVLElBQUksUUFBUSxDQUFDLGVBQWUsQ0FBQyxXQUFXLENBQUM7UUFDNUUsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLFlBQVksSUFBSSxLQUFLLENBQUM7UUFFakQsSUFBSSxLQUFLLENBQUMsbUJBQW1CLEtBQUssU0FBUyxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDN0QsTUFBTSxJQUFJLEtBQUssQ0FBQywwRkFBMEYsQ0FBQyxDQUFDO1FBQzlHLENBQUM7UUFFRCxJQUFJLFVBQVUsS0FBSyxRQUFRLENBQUMs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QUksQ0FBQyxLQUFLLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3BDLENBQUM7UUFDRCxLQUFLLE1BQU0sT0FBTyxJQUFJLEtBQUssQ0FBQyxZQUFZLElBQUksRUFBRSxFQUFFLENBQUM7WUFDL0MsSUFBSSxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDckMsQ0FBQztRQUNELEtBQUssTUFBTSxPQUFPLElBQUksS0FBSyxDQUFDLGdCQUFnQixJQUFJLEVBQUUsRUFBRSxDQUFDO1lBQ25ELElBQUksQ0FBQyxLQUFLLENBQUMsa0JBQWtCLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDekMsQ0FBQztRQUNELElBQUksQ0FBQyxLQUFLLENBQUMsaUJBQWlCLElBQUksRUFBRSxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ2hFLE1BQU0sSUFBSSxLQUFLLENBQUMseUVBQXlFLENBQUMsQ0FBQztRQUM3RixDQUFDO1FBQ0QsS0FBSyxNQUFNLE9BQU8sSUFBSSxLQUFLLENBQUMsaUJBQWlCLElBQUksRUFBRSxFQUFFLENBQUM7WUFDcEQsSUFBSSxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDdEMsQ0FBQztJQUNILENBQUM7O0FBN0ZILG9EQThGQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlEeW5hbW9UYWJsZUdzaVByb3BzIHtcbiAgcmVhZG9ubHkgaW5kZXhOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHBhcnRpdGlvbktleU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcGFydGl0aW9uS2V5VHlwZT86IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGU7XG4gIHJlYWRvbmx5IHNvcnRLZXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBzb3J0S2V5VHlwZT86IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGU7XG4gIHJlYWRvbmx5IHByb2plY3Rpb25UeXBlPzogZHluYW1vZGIuUHJvamVjdGlvblR5cGU7XG4gIHJlYWRvbmx5IG5vbktleUF0dHJpYnV0ZXM/OiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcmVhZENhcGFjaXR5PzogbnVtYmVyO1xuICByZWFkb25seSB3cml0ZUNhcGFjaXR5PzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUR5bmFtb1RhYmxlUHJvcHMge1xuICByZWFkb25seSB0YWJsZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcGFydGl0aW9uS2V5TmFtZTogc3RyaW5nO1xuICByZWFkb25seSBwYXJ0aXRpb25LZXlUeXBlPzogZHluYW1vZGIuQXR0cmlidXRlVHlwZTtcbiAgcmVhZG9ubHkgc29ydEtleU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgc29ydEtleVR5cGU/OiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlO1xuICByZWFkb25seSB0aW1lVG9MaXZlQXR0cmlidXRlPzogc3RyaW5nO1xuICByZWFkb25seSBiaWxsaW5nTW9kZT86IGR5bmFtb2RiLkJpbGxpbmdNb2RlO1xuICByZWFkb25seSByZWFkQ2FwYWNpdHk/OiBudW1iZXI7XG4gIHJlYWRvbmx5IHdyaXRlQ2FwYWNpdHk/OiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBkZWxldGlvblByb3RlY3Rpb24/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVQb2ludEluVGltZVJlY292ZXJ5PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZW5jcnlwdGlvbj86IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbjtcbiAgcmVhZG9ubHkgZW5jcnlwdGlvbktleT86IGttcy5JS2V5O1xuICByZWFkb25seSBlbmFibGVTdHJlYW0/OiBib29sZWFuO1xuICByZWFkb25seSBzdHJlYW1WaWV3VHlwZT86IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlO1xuICByZWFkb25seSBnbG9iYWxTZWNvbmRhcnlJbmRleGVzPzogQXBwVGhlb3J5RHluYW1vVGFibGVHc2lQcm9wc1tdO1xuXG4gIHJlYWRvbmx5IGdyYW50UmVhZFRvPzogaWFtLklHcmFudGFibGVbXTtcbiAgcmVhZG9ubHkgZ3JhbnRXcml0ZVRvPzogaWFtLklHcmFudGFibGVbXTtcbiAgcmVhZG9ubHkgZ3JhbnRSZWFkV3JpdGVUbz86IGlhbS5JR3JhbnRhYmxlW107XG4gIHJlYWRvbmx5IGdyYW50U3RyZWFtUmVhZFRvPzogaWFtLklHcmFudGFibGVbXTtcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUR5bmFtb1RhYmxlIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IHRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5RHluYW1vVGFibGVQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBiaWxsaW5nTW9kZSA9IHByb3BzLmJpbGxpbmdNb2RlID8/IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVDtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCB0dGxBdHRyaWJ1dGUgPVxuICAgICAgcHJvcHMudGltZVRvTGl2ZUF0dHJpYnV0ZSA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogU3RyaW5nKHByb3BzLnRpbWVUb0xpdmVBdHRyaWJ1dGUpLnRyaW0oKTtcbiAgICBjb25zdCBlbmFibGVQSVRSID0gcHJvcHMuZW5hYmxlUG9pbnRJblRpbWVSZWNvdmVyeSA/PyB0cnVlO1xuICAgIGNvbnN0IGVuY3J5cHRpb24gPSBwcm9wcy5lbmNyeXB0aW9uID8/IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRDtcbiAgICBjb25zdCBlbmFibGVTdHJlYW0gPSBwcm9wcy5lbmFibGVTdHJlYW0gPz8gZmFsc2U7XG5cbiAgICBpZiAocHJvcHMudGltZVRvTGl2ZUF0dHJpYnV0ZSAhPT0gdW5kZWZpbmVkICYmICF0dGxBdHRyaWJ1dGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUR5bmFtb1RhYmxlIHJlcXVpcmVzIHRpbWVUb0xpdmVBdHRyaWJ1dGUgdG8gYmUgYSBub24tZW1wdHkgc3RyaW5nIHdoZW4gcHJvdmlkZWRcIik7XG4gICAgfVxuXG4gICAgaWYgKGVuY3J5cHRpb24gPT09IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5DVVNUT01FUl9NQU5BR0VEICYmICFwcm9wcy5lbmNyeXB0aW9uS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlEeW5hbW9UYWJsZSByZXF1aXJlcyBlbmNyeXB0aW9uS2V5IHdoZW4gZW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VEXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IHN0cmVhbSA9IGVuYWJsZVN0cmVhbVxuICAgICAgPyAocHJvcHMuc3RyZWFtVmlld1R5cGUgPz8gZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTKVxuICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICB0aGlzLnRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiVGFibGVcIiwge1xuICAgICAgdGFibGVOYW1lOiBwcm9wcy50YWJsZU5hbWUsXG4gICAgICBiaWxsaW5nTW9kZSxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiBwcm9wcy5wYXJ0aXRpb25LZXlOYW1lLFxuICAgICAgICB0eXBlOiBwcm9wcy5wYXJ0aXRpb25LZXlUeXBlID8/IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogcHJvcHMuc29ydEtleU5hbWUsXG4gICAgICAgIHR5cGU6IHByb3BzLnNvcnRLZXlUeXBlID8/IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIC4uLih0dGxBdHRyaWJ1dGUgPyB7IHRpbWVUb0xpdmVBdHRyaWJ1dGU6IHR0bEF0dHJpYnV0ZSB9IDoge30pLFxuICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogcHJvcHMuZGVsZXRpb25Qcm90ZWN0aW9uLFxuICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IGVuYWJsZVBJVFIsXG4gICAgICB9LFxuICAgICAgZW5jcnlwdGlvbixcbiAgICAgIGVuY3J5cHRpb25LZXk6IHByb3BzLmVuY3J5cHRpb25LZXksXG4gICAgICBzdHJlYW0sXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgIHJlYWRDYXBhY2l0eTogcHJvcHMucmVhZENhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgd3JpdGVDYXBhY2l0eTogcHJvcHMud3JpdGVDYXBhY2l0eSA/PyA1LFxuICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgZm9yIChjb25zdCBnc2kgb2YgcHJvcHMuZ2xvYmFsU2Vjb25kYXJ5SW5kZXhlcyA/PyBbXSkge1xuICAgICAgdGhpcy50YWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICAgIGluZGV4TmFtZTogZ3NpLmluZGV4TmFtZSxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgICAgbmFtZTogZ3NpLnBhcnRpdGlvbktleU5hbWUsXG4gICAgICAgICAgdHlwZTogZ3NpLnBhcnRpdGlvbktleVR5cGUgPz8gZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICAgIH0sXG4gICAgICAgIHNvcnRLZXk6IGdzaS5zb3J0S2V5TmFtZVxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgbmFtZTogZ3NpLnNvcnRLZXlOYW1lLFxuICAgICAgICAgICAgdHlwZTogZ3NpLnNvcnRLZXlUeXBlID8/IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgICAgIH1cbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgcHJvamVjdGlvblR5cGU6IGdzaS5wcm9qZWN0aW9uVHlwZSA/PyBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgICAgIG5vbktleUF0dHJpYnV0ZXM6IGdzaS5ub25LZXlBdHRyaWJ1dGVzLFxuICAgICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICByZWFkQ2FwYWNpdHk6IGdzaS5yZWFkQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IGdzaS53cml0ZUNhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBncmFudGVlIG9mIHByb3BzLmdyYW50UmVhZFRvID8/IFtdKSB7XG4gICAgICB0aGlzLnRhYmxlLmdyYW50UmVhZERhdGEoZ3JhbnRlZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudFdyaXRlVG8gPz8gW10pIHtcbiAgICAgIHRoaXMudGFibGUuZ3JhbnRXcml0ZURhdGEoZ3JhbnRlZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudFJlYWRXcml0ZVRvID8/IFtdKSB7XG4gICAgICB0aGlzLnRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShncmFudGVlKTtcbiAgICB9XG4gICAgaWYgKChwcm9wcy5ncmFudFN0cmVhbVJlYWRUbyA/PyBbXSkubGVuZ3RoID4gMCAmJiAhZW5hYmxlU3RyZWFtKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlEeW5hbW9UYWJsZSByZXF1aXJlcyBlbmFibGVTdHJlYW0gd2hlbiB1c2luZyBncmFudFN0cmVhbVJlYWRUb1wiKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBncmFudGVlIG9mIHByb3BzLmdyYW50U3RyZWFtUmVhZFRvID8/IFtdKSB7XG4gICAgICB0aGlzLnRhYmxlLmdyYW50U3RyZWFtUmVhZChncmFudGVlKTtcbiAgICB9XG4gIH1cbn1cbiJdfQ==