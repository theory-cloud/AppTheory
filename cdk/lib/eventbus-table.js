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
exports.AppTheoryEventBusTable = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const constructs_1 = require("constructs");
const secure_defaults_1 = require("./private/secure-defaults");
class AppTheoryEventBusTable extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEventBusTable", version: "7.4.0" };
    table;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const billingMode = props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const ttlAttribute = props.timeToLiveAttribute ?? "ttl";
        const enablePITR = props.enablePointInTimeRecovery ?? true;
        const enableStream = props.enableStream ?? false;
        const deletionProtection = (0, secure_defaults_1.defaultDeletionProtection)(props.namingContext, removalPolicy, props.deletionProtection);
        const stream = enableStream
            ? (props.streamViewType ?? dynamodb.StreamViewType.NEW_IMAGE)
            : undefined;
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
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            stream,
            ...(billingMode === dynamodb.BillingMode.PROVISIONED
                ? {
                    readCapacity: props.readCapacity ?? 5,
                    writeCapacity: props.writeCapacity ?? 5,
                }
                : {}),
        });
        // Required by AppTheory `pkg/services` EventBus (GetEvent by ID).
        if (props.enableEventIdIndex ?? true) {
            this.table.addGlobalSecondaryIndex({
                indexName: "event-id-index",
                partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
                projectionType: dynamodb.ProjectionType.ALL,
                ...(billingMode === dynamodb.BillingMode.PROVISIONED
                    ? {
                        readCapacity: 5,
                        writeCapacity: 5,
                    }
                    : {}),
            });
        }
        // Required for tenant-wide queries (Query without event_type).
        this.table.addGlobalSecondaryIndex({
            indexName: "tenant-timestamp-index",
            partitionKey: { name: "tenant_id", type: dynamodb.AttributeType.STRING },
            // TableTheory stores `time.Time` as a string, matching Lift's schema.
            sortKey: { name: "published_at", type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
            ...(billingMode === dynamodb.BillingMode.PROVISIONED
                ? {
                    readCapacity: 5,
                    writeCapacity: 5,
                }
                : {}),
        });
    }
    /**
     * Binds the table to a Lambda function for EventBus publish/query/replay flows.
     */
    bind(handler, options = {}) {
        if (!handler) {
            throw new Error("AppTheoryEventBusTable: handler is required");
        }
        if (options.readOnly) {
            this.table.grantReadData(handler);
        }
        else {
            this.table.grantReadWriteData(handler);
        }
        this.addEnvironment(handler, options.envVarName ?? "APPTHEORY_EVENTBUS_TABLE_NAME", this.table.tableName);
    }
    addEnvironment(handler, key, value) {
        if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
            handler.addEnvironment(key, value);
        }
    }
}
exports.AppTheoryEventBusTable = AppTheoryEventBusTable;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRidXMtdGFibGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJldmVudGJ1cy10YWJsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTRDO0FBQzVDLG1FQUFxRDtBQUVyRCwyQ0FBdUM7QUFHdkMsK0RBQXNFO0FBK0N0RSxNQUFhLHNCQUF1QixTQUFRLHNCQUFTOztJQUNuQyxLQUFLLENBQWlCO0lBRXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBcUMsRUFBRTtRQUMvRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxXQUFXLElBQUksUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlLENBQUM7UUFDOUUsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsSUFBSSwyQkFBYSxDQUFDLE1BQU0sQ0FBQztRQUNsRSxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsbUJBQW1CLElBQUksS0FBSyxDQUFDO1FBQ3hELE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyx5QkFBeUIsSUFBSSxJQUFJLENBQUM7UUFDM0QsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLFlBQVksSUFBSSxLQUFLLENBQUM7UUFDakQsTUFBTSxrQkFBa0IsR0FBRyxJQUFBLDJDQUF5QixFQUNsRCxLQUFLLENBQUMsYUFBYSxFQUNuQixhQUFhLEVBQ2IsS0FBSyxDQUFDLGtCQUFrQixDQUN6QixDQUFDO1FBRUYsTUFBTSxNQUFNLEdBQUcsWUFBWTtZQUN6QixDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsY0FBYyxJQUFJLFFBQVEsQ0FBQyxjQUFjLENBQUMsU0FBUyxDQUFDO1lBQzdELENBQUMsQ0FBQyxTQUFTLENBQUM7UUFFZCxJQUFJLENBQUMsS0FBSyxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVB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LCtCQUErQixFQUNyRCxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FDckIsQ0FBQztJQUNKLENBQUM7SUFFTyxjQUFjLENBQUMsT0FBeUIsRUFBRSxHQUFXLEVBQUUsS0FBYTtRQUMxRSxJQUFJLGdCQUFnQixJQUFJLE9BQU8sSUFBSSxPQUFPLE9BQU8sQ0FBQyxjQUFjLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDaEYsT0FBTyxDQUFDLGNBQWMsQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDckMsQ0FBQztJQUNILENBQUM7O0FBbEdILHdEQW1HQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuaW1wb3J0IHsgZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbiB9IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RXZlbnRCdXNUYWJsZVByb3BzIHtcbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBiaWxsaW5nTW9kZT86IGR5bmFtb2RiLkJpbGxpbmdNb2RlO1xuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgdGltZVRvTGl2ZUF0dHJpYnV0ZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZW5hYmxlUG9pbnRJblRpbWVSZWNvdmVyeT86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBXaGV0aGVyIGRlbGV0aW9uIHByb3RlY3Rpb24gc2hvdWxkIGJlIGVuYWJsZWQgZm9yIHRoZSB0YWJsZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkICh3aXRoIG5vIG5hbWluZyBjb250ZXh0OiB0aGUgQVdTIGRlZmF1bHQsIG5vIGRlbGV0aW9uXG4gICAqIHByb3RlY3Rpb247IHdpdGggYSBuYW1pbmcgY29udGV4dDogb24gZm9yIGEgUkVUQUlOIHRhYmxlLCBvZmYgb3RoZXJ3aXNlKVxuICAgKi9cbiAgcmVhZG9ubHkgZGVsZXRpb25Qcm90ZWN0aW9uPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZW5hYmxlU3RyZWFtPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgc3RyZWFtVmlld1R5cGU/OiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZTtcbiAgcmVhZG9ubHkgZW5hYmxlRXZlbnRJZEluZGV4PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgcmVhZENhcGFjaXR5PzogbnVtYmVyO1xuICByZWFkb25seSB3cml0ZUNhcGFjaXR5PzogbnVtYmVyO1xuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGNvbnRleHQuIFdoZW4gcHJlc2VudCB0aGUgdGFibGUgdGFrZXMgdGhlIGNvbnRyYWN0J3NcbiAgICogU2VjdXJpdHkgSHViLWFsaWduZWQgZGVmYXVsdHM6IHBvaW50LWluLXRpbWUgcmVjb3Zlcnkgb24sIGFuZCBkZWxldGlvblxuICAgKiBwcm90ZWN0aW9uIG9uIGZvciBhIFJFVEFJTiB0YWJsZS5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RXZlbnRCdXNUYWJsZUJpbmRpbmdPcHRpb25zIHtcbiAgLyoqXG4gICAqIEdyYW50IHJlYWQtb25seSBhY2Nlc3MgZm9yIHJlcGxheS9xdWVyeSBjb25zdW1lcnMuXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBoYW5kbGVyIHJlY2VpdmVzIHJlYWQvd3JpdGUgYWNjZXNzIGZvciBwdWJsaXNoICsgcmVwbGF5IGZsb3dzLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcmVhZE9ubHk/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZSBuYW1lIHVzZWQgZm9yIHRoZSB0YWJsZSBuYW1lIGJpbmRpbmcuXG4gICAqIEFwcFRoZW9yeSBydW50aW1lIGNvZGUgcmVhZHMgYEFQUFRIRU9SWV9FVkVOVEJVU19UQUJMRV9OQU1FYCBieSBkZWZhdWx0LlxuICAgKiBAZGVmYXVsdCBBUFBUSEVPUllfRVZFTlRCVVNfVEFCTEVfTkFNRVxuICAgKi9cbiAgcmVhZG9ubHkgZW52VmFyTmFtZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUV2ZW50QnVzVGFibGUgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgdGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlFdmVudEJ1c1RhYmxlUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBiaWxsaW5nTW9kZSA9IHByb3BzLmJpbGxpbmdNb2RlID8/IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVDtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCB0dGxBdHRyaWJ1dGUgPSBwcm9wcy50aW1lVG9MaXZlQXR0cmlidXRlID8/IFwidHRsXCI7XG4gICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmVuYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcbiAgICBjb25zdCBlbmFibGVTdHJlYW0gPSBwcm9wcy5lbmFibGVTdHJlYW0gPz8gZmFsc2U7XG4gICAgY29uc3QgZGVsZXRpb25Qcm90ZWN0aW9uID0gZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbihcbiAgICAgIHByb3BzLm5hbWluZ0NvbnRleHQsXG4gICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgcHJvcHMuZGVsZXRpb25Qcm90ZWN0aW9uLFxuICAgICk7XG5cbiAgICBjb25zdCBzdHJlYW0gPSBlbmFibGVTdHJlYW1cbiAgICAgID8gKHByb3BzLnN0cmVhbVZpZXdUeXBlID8/IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlLk5FV19JTUFHRSlcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgdGhpcy50YWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlRhYmxlXCIsIHtcbiAgICAgIHRhYmxlTmFtZTogcHJvcHMudGFibGVOYW1lLFxuICAgICAgYmlsbGluZ01vZGUsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJwa1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiBcInNrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiB0dGxBdHRyaWJ1dGUsXG4gICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBkZWxldGlvblByb3RlY3Rpb24sXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogZW5hYmxlUElUUixcbiAgICAgIH0sXG4gICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICBzdHJlYW0sXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhZENhcGFjaXR5OiBwcm9wcy5yZWFkQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IHByb3BzLndyaXRlQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgLy8gUmVxdWlyZWQgYnkgQXBwVGhlb3J5IGBwa2cvc2VydmljZXNgIEV2ZW50QnVzIChHZXRFdmVudCBieSBJRCkuXG4gICAgaWYgKHByb3BzLmVuYWJsZUV2ZW50SWRJbmRleCA/PyB0cnVlKSB7XG4gICAgICB0aGlzLnRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgICAgaW5kZXhOYW1lOiBcImV2ZW50LWlkLWluZGV4XCIsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcImlkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgICAgIC4uLihiaWxsaW5nTW9kZSA9PT0gZHluYW1vZGIuQmlsbGluZ01vZGUuUFJPVklTSU9ORURcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgcmVhZENhcGFjaXR5OiA1LFxuICAgICAgICAgICAgICB3cml0ZUNhcGFjaXR5OiA1LFxuICAgICAgICAgICAgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gUmVxdWlyZWQgZm9yIHRlbmFudC13aWRlIHF1ZXJpZXMgKFF1ZXJ5IHdpdGhvdXQgZXZlbnRfdHlwZSkuXG4gICAgdGhpcy50YWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6IFwidGVuYW50LXRpbWVzdGFtcC1pbmRleFwiLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwidGVuYW50X2lkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAvLyBUYWJsZVRoZW9yeSBzdG9yZXMgYHRpbWUuVGltZWAgYXMgYSBzdHJpbmcsIG1hdGNoaW5nIExpZnQncyBzY2hlbWEuXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6IFwicHVibGlzaGVkX2F0XCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlYWRDYXBhY2l0eTogNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IDUsXG4gICAgICAgICAgfVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBCaW5kcyB0aGUgdGFibGUgdG8gYSBMYW1iZGEgZnVuY3Rpb24gZm9yIEV2ZW50QnVzIHB1Ymxpc2gvcXVlcnkvcmVwbGF5IGZsb3dzLlxuICAgKi9cbiAgcHVibGljIGJpbmQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwgb3B0aW9uczogQXBwVGhlb3J5RXZlbnRCdXNUYWJsZUJpbmRpbmdPcHRpb25zID0ge30pOiB2b2lkIHtcbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUV2ZW50QnVzVGFibGU6IGhhbmRsZXIgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuXG4gICAgaWYgKG9wdGlvbnMucmVhZE9ubHkpIHtcbiAgICAgIHRoaXMudGFibGUuZ3JhbnRSZWFkRGF0YShoYW5kbGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy50YWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaGFuZGxlcik7XG4gICAgfVxuXG4gICAgdGhpcy5hZGRFbnZpcm9ubWVudChcbiAgICAgIGhhbmRsZXIsXG4gICAgICBvcHRpb25zLmVudlZhck5hbWUgPz8gXCJBUFBUSEVPUllfRVZFTlRCVVNfVEFCTEVfTkFNRVwiLFxuICAgICAgdGhpcy50YWJsZS50YWJsZU5hbWUsXG4gICAgKTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cbn1cbiJdfQ==