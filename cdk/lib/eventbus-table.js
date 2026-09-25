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
class AppTheoryEventBusTable extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEventBusTable", version: "4.4.1" };
    table;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const billingMode = props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const ttlAttribute = props.timeToLiveAttribute ?? "ttl";
        const enablePITR = props.enablePointInTimeRecovery ?? true;
        const enableStream = props.enableStream ?? false;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRidXMtdGFibGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJldmVudGJ1cy10YWJsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTRDO0FBQzVDLG1FQUFxRDtBQUVyRCwyQ0FBdUM7QUErQnZDLE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7O0lBQ25DLEtBQUssQ0FBaUI7SUFFdEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFxQyxFQUFFO1FBQy9FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWUsQ0FBQztRQUM5RSxNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxJQUFJLDJCQUFhLENBQUMsTUFBTSxDQUFDO1FBQ2xFLE1BQU0sWUFBWSxHQUFHLEtBQUssQ0FBQyxtQkFBbUIsSUFBSSxLQUFLLENBQUM7UUFDeEQsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLHlCQUF5QixJQUFJLElBQUksQ0FBQztRQUMzRCxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsWUFBWSxJQUFJLEtBQUssQ0FBQztRQUVqRCxNQUFNLE1BQU0sR0FBRyxZQUFZO1lBQ3pCLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxjQUFjLElBQUksUUFBUSxDQUFDLGNBQWMsQ0FBQyxTQUFTLENBQUM7WUFDN0QsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUVkLElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7WUFDN0MsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQzFCLFdBQVc7WUFDWCxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLENB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TyxPQUFPLENBQUMsY0FBYyxLQUFLLFVBQVUsRUFBRSxDQUFDO1lBQ2hGLE9BQU8sQ0FBQyxjQUFjLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3JDLENBQUM7SUFDSCxDQUFDOztBQTVGSCx3REE2RkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlFdmVudEJ1c1RhYmxlUHJvcHMge1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGJpbGxpbmdNb2RlPzogZHluYW1vZGIuQmlsbGluZ01vZGU7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSB0aW1lVG9MaXZlQXR0cmlidXRlPzogc3RyaW5nO1xuICByZWFkb25seSBlbmFibGVQb2ludEluVGltZVJlY292ZXJ5PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZW5hYmxlU3RyZWFtPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgc3RyZWFtVmlld1R5cGU/OiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZTtcbiAgcmVhZG9ubHkgZW5hYmxlRXZlbnRJZEluZGV4PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgcmVhZENhcGFjaXR5PzogbnVtYmVyO1xuICByZWFkb25seSB3cml0ZUNhcGFjaXR5PzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUV2ZW50QnVzVGFibGVCaW5kaW5nT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBHcmFudCByZWFkLW9ubHkgYWNjZXNzIGZvciByZXBsYXkvcXVlcnkgY29uc3VtZXJzLlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgaGFuZGxlciByZWNlaXZlcyByZWFkL3dyaXRlIGFjY2VzcyBmb3IgcHVibGlzaCArIHJlcGxheSBmbG93cy5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHJlYWRPbmx5PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRW52aXJvbm1lbnQgdmFyaWFibGUgbmFtZSB1c2VkIGZvciB0aGUgdGFibGUgbmFtZSBiaW5kaW5nLlxuICAgKiBBcHBUaGVvcnkgcnVudGltZSBjb2RlIHJlYWRzIGBBUFBUSEVPUllfRVZFTlRCVVNfVEFCTEVfTkFNRWAgYnkgZGVmYXVsdC5cbiAgICogQGRlZmF1bHQgQVBQVEhFT1JZX0VWRU5UQlVTX1RBQkxFX05BTUVcbiAgICovXG4gIHJlYWRvbmx5IGVudlZhck5hbWU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlFdmVudEJ1c1RhYmxlIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IHRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5RXZlbnRCdXNUYWJsZVByb3BzID0ge30pIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgYmlsbGluZ01vZGUgPSBwcm9wcy5iaWxsaW5nTW9kZSA/PyBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1Q7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgdHRsQXR0cmlidXRlID0gcHJvcHMudGltZVRvTGl2ZUF0dHJpYnV0ZSA/PyBcInR0bFwiO1xuICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5lbmFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG4gICAgY29uc3QgZW5hYmxlU3RyZWFtID0gcHJvcHMuZW5hYmxlU3RyZWFtID8/IGZhbHNlO1xuXG4gICAgY29uc3Qgc3RyZWFtID0gZW5hYmxlU3RyZWFtXG4gICAgICA/IChwcm9wcy5zdHJlYW1WaWV3VHlwZSA/PyBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5ORVdfSU1BR0UpXG4gICAgICA6IHVuZGVmaW5lZDtcblxuICAgIHRoaXMudGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJUYWJsZVwiLCB7XG4gICAgICB0YWJsZU5hbWU6IHByb3BzLnRhYmxlTmFtZSxcbiAgICAgIGJpbGxpbmdNb2RlLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwicGtcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJza1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogdHRsQXR0cmlidXRlLFxuICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiBlbmFibGVQSVRSLFxuICAgICAgfSxcbiAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIHN0cmVhbSxcbiAgICAgIC4uLihiaWxsaW5nTW9kZSA9PT0gZHluYW1vZGIuQmlsbGluZ01vZGUuUFJPVklTSU9ORURcbiAgICAgICAgPyB7XG4gICAgICAgICAgICByZWFkQ2FwYWNpdHk6IHByb3BzLnJlYWRDYXBhY2l0eSA/PyA1LFxuICAgICAgICAgICAgd3JpdGVDYXBhY2l0eTogcHJvcHMud3JpdGVDYXBhY2l0eSA/PyA1LFxuICAgICAgICAgIH1cbiAgICAgICAgOiB7fSksXG4gICAgfSk7XG5cbiAgICAvLyBSZXF1aXJlZCBieSBBcHBUaGVvcnkgYHBrZy9zZXJ2aWNlc2AgRXZlbnRCdXMgKEdldEV2ZW50IGJ5IElEKS5cbiAgICBpZiAocHJvcHMuZW5hYmxlRXZlbnRJZEluZGV4ID8/IHRydWUpIHtcbiAgICAgIHRoaXMudGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgICBpbmRleE5hbWU6IFwiZXZlbnQtaWQtaW5kZXhcIixcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwiaWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgICByZWFkQ2FwYWNpdHk6IDUsXG4gICAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IDUsXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiB7fSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBSZXF1aXJlZCBmb3IgdGVuYW50LXdpZGUgcXVlcmllcyAoUXVlcnkgd2l0aG91dCBldmVudF90eXBlKS5cbiAgICB0aGlzLnRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogXCJ0ZW5hbnQtdGltZXN0YW1wLWluZGV4XCIsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJ0ZW5hbnRfaWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIC8vIFRhYmxlVGhlb3J5IHN0b3JlcyBgdGltZS5UaW1lYCBhcyBhIHN0cmluZywgbWF0Y2hpbmcgTGlmdCdzIHNjaGVtYS5cbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJwdWJsaXNoZWRfYXRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhZENhcGFjaXR5OiA1LFxuICAgICAgICAgICAgd3JpdGVDYXBhY2l0eTogNSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIEJpbmRzIHRoZSB0YWJsZSB0byBhIExhbWJkYSBmdW5jdGlvbiBmb3IgRXZlbnRCdXMgcHVibGlzaC9xdWVyeS9yZXBsYXkgZmxvd3MuXG4gICAqL1xuICBwdWJsaWMgYmluZChoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLCBvcHRpb25zOiBBcHBUaGVvcnlFdmVudEJ1c1RhYmxlQmluZGluZ09wdGlvbnMgPSB7fSk6IHZvaWQge1xuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RXZlbnRCdXNUYWJsZTogaGFuZGxlciBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBpZiAob3B0aW9ucy5yZWFkT25seSkge1xuICAgICAgdGhpcy50YWJsZS5ncmFudFJlYWREYXRhKGhhbmRsZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShoYW5kbGVyKTtcbiAgICB9XG5cbiAgICB0aGlzLmFkZEVudmlyb25tZW50KFxuICAgICAgaGFuZGxlcixcbiAgICAgIG9wdGlvbnMuZW52VmFyTmFtZSA/PyBcIkFQUFRIRU9SWV9FVkVOVEJVU19UQUJMRV9OQU1FXCIsXG4gICAgICB0aGlzLnRhYmxlLnRhYmxlTmFtZSxcbiAgICApO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRFbnZpcm9ubWVudChoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChcImFkZEVudmlyb25tZW50XCIgaW4gaGFuZGxlciAmJiB0eXBlb2YgaGFuZGxlci5hZGRFbnZpcm9ubWVudCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBoYW5kbGVyLmFkZEVudmlyb25tZW50KGtleSwgdmFsdWUpO1xuICAgIH1cbiAgfVxufVxuIl19