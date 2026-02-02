"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryEventBusTable = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const constructs_1 = require("constructs");
class AppTheoryEventBusTable extends constructs_1.Construct {
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
            pointInTimeRecovery: enablePITR,
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
}
exports.AppTheoryEventBusTable = AppTheoryEventBusTable;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryEventBusTable[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEventBusTable", version: "0.5.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRidXMtdGFibGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJldmVudGJ1cy10YWJsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUE0QztBQUM1QyxxREFBcUQ7QUFDckQsMkNBQXVDO0FBZXZDLE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7SUFHbkQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFxQyxFQUFFO1FBQy9FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWUsQ0FBQztRQUM5RSxNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxJQUFJLDJCQUFhLENBQUMsTUFBTSxDQUFDO1FBQ2xFLE1BQU0sWUFBWSxHQUFHLEtBQUssQ0FBQyxtQkFBbUIsSUFBSSxLQUFLLENBQUM7UUFDeEQsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLHlCQUF5QixJQUFJLElBQUksQ0FBQztRQUMzRCxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsWUFBWSxJQUFJLEtBQUssQ0FBQztRQUVqRCxNQUFNLE1BQU0sR0FBRyxZQUFZO1lBQ3pCLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxjQUFjLElBQUksUUFBUSxDQUFDLGNBQWMsQ0FBQyxTQUFTLENBQUM7WUFDN0QsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUVkLElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7WUFDN0MsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQzFCLFdBQVc7WUFDWCxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtZQUNqRSxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtZQUM1RCxtQkFBbUIsRUFBRSxZQUFZO1lBQ2pDLGFBQWE7WUFDYixtQkFBbUIsRUFBRSxVQUFVO1lBQy9CLFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLFdBQVc7WUFDaEQsTUFBTTtZQUNOLEdBQUcsQ0FBQyxXQUFXLEtBQUssUUFBUSxDQUFDLFdBQVcsQ0FBQyxXQUFXO2dCQUNsRCxDQUFDLENBQUM7b0JBQ0UsWUFBWSxFQUFFLEtBQUssQ0FBQyxZQUFZLElBQUksQ0FBQztvQkFDckMsYUFBYSxFQUFFLEtBQUssQ0FBQyxhQUFhLElBQUksQ0FBQztpQkFDeEM7Z0JBQ0gsQ0FBQyxDQUFDLEVBQUUsQ0FBQztTQUNSLENBQUMsQ0FBQztRQUVILGtFQUFrRTtRQUNsRSxJQUFJLEtBQUssQ0FBQyxrQkFBa0IsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUNyQyxJQUFJLENBQUMsS0FBSyxDQUFDLHVCQUF1QixDQUFDO2dCQUNqQyxTQUFTLEVBQUUsZ0JBQWdCO2dCQUMzQixZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtnQkFDakUsY0FBYyxFQUFFLFFBQVEsQ0FBQyxjQUFjLENBQUMsR0FBRztnQkFDM0MsR0FBRyxDQUFDLFdBQVcsS0FBSyxRQUFRLENBQUMsV0FBVyxDQUFDLFdBQVc7b0JBQ2xELENBQUMsQ0FBQzt3QkFDRSxZQUFZLEVBQUUsQ0FBQzt3QkFDZixhQUFhLEVBQUUsQ0FBQztxQkFDakI7b0JBQ0gsQ0FBQyxDQUFDLEVBQUUsQ0FBQzthQUNSLENBQUMsQ0FBQztRQUNMLENBQUM7UUFFRCwrREFBK0Q7UUFDL0QsSUFBSSxDQUFDLEtBQUssQ0FBQyx1QkFBdUIsQ0FBQztZQUNqQyxTQUFTLEVBQUUsd0JBQXdCO1lBQ25DLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3hFLHNFQUFzRTtZQUN0RSxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsY0FBYyxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtZQUN0RSxjQUFjLEVBQUUsUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHO1lBQzNDLEdBQUcsQ0FBQyxXQUFXLEtBQUssUUFBUSxDQUFDLFdBQVcsQ0FBQyxXQUFXO2dCQUNsRCxDQUFDLENBQUM7b0JBQ0UsWUFBWSxFQUFFLENBQUM7b0JBQ2YsYUFBYSxFQUFFLENBQUM7aUJBQ2pCO2dCQUNILENBQUMsQ0FBQyxFQUFFLENBQUM7U0FDUixDQUFDLENBQUM7SUFDTCxDQUFDOztBQS9ESCx3REFnRUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUV2ZW50QnVzVGFibGVQcm9wcyB7XG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgYmlsbGluZ01vZGU/OiBkeW5hbW9kYi5CaWxsaW5nTW9kZTtcbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IHRpbWVUb0xpdmVBdHRyaWJ1dGU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGVuYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVTdHJlYW0/OiBib29sZWFuO1xuICByZWFkb25seSBzdHJlYW1WaWV3VHlwZT86IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlO1xuICByZWFkb25seSBlbmFibGVFdmVudElkSW5kZXg/OiBib29sZWFuO1xuICByZWFkb25seSByZWFkQ2FwYWNpdHk/OiBudW1iZXI7XG4gIHJlYWRvbmx5IHdyaXRlQ2FwYWNpdHk/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlFdmVudEJ1c1RhYmxlIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IHRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5RXZlbnRCdXNUYWJsZVByb3BzID0ge30pIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgYmlsbGluZ01vZGUgPSBwcm9wcy5iaWxsaW5nTW9kZSA/PyBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1Q7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgdHRsQXR0cmlidXRlID0gcHJvcHMudGltZVRvTGl2ZUF0dHJpYnV0ZSA/PyBcInR0bFwiO1xuICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5lbmFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG4gICAgY29uc3QgZW5hYmxlU3RyZWFtID0gcHJvcHMuZW5hYmxlU3RyZWFtID8/IGZhbHNlO1xuXG4gICAgY29uc3Qgc3RyZWFtID0gZW5hYmxlU3RyZWFtXG4gICAgICA/IChwcm9wcy5zdHJlYW1WaWV3VHlwZSA/PyBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5ORVdfSU1BR0UpXG4gICAgICA6IHVuZGVmaW5lZDtcblxuICAgIHRoaXMudGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJUYWJsZVwiLCB7XG4gICAgICB0YWJsZU5hbWU6IHByb3BzLnRhYmxlTmFtZSxcbiAgICAgIGJpbGxpbmdNb2RlLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwicGtcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJza1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogdHRsQXR0cmlidXRlLFxuICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgIHBvaW50SW5UaW1lUmVjb3Zlcnk6IGVuYWJsZVBJVFIsXG4gICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICBzdHJlYW0sXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhZENhcGFjaXR5OiBwcm9wcy5yZWFkQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IHByb3BzLndyaXRlQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgLy8gUmVxdWlyZWQgYnkgQXBwVGhlb3J5IGBwa2cvc2VydmljZXNgIEV2ZW50QnVzIChHZXRFdmVudCBieSBJRCkuXG4gICAgaWYgKHByb3BzLmVuYWJsZUV2ZW50SWRJbmRleCA/PyB0cnVlKSB7XG4gICAgICB0aGlzLnRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgICAgaW5kZXhOYW1lOiBcImV2ZW50LWlkLWluZGV4XCIsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcImlkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgICAgIC4uLihiaWxsaW5nTW9kZSA9PT0gZHluYW1vZGIuQmlsbGluZ01vZGUuUFJPVklTSU9ORURcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgcmVhZENhcGFjaXR5OiA1LFxuICAgICAgICAgICAgICB3cml0ZUNhcGFjaXR5OiA1LFxuICAgICAgICAgICAgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gUmVxdWlyZWQgZm9yIHRlbmFudC13aWRlIHF1ZXJpZXMgKFF1ZXJ5IHdpdGhvdXQgZXZlbnRfdHlwZSkuXG4gICAgdGhpcy50YWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6IFwidGVuYW50LXRpbWVzdGFtcC1pbmRleFwiLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwidGVuYW50X2lkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAvLyBUYWJsZVRoZW9yeSBzdG9yZXMgYHRpbWUuVGltZWAgYXMgYSBzdHJpbmcsIG1hdGNoaW5nIExpZnQncyBzY2hlbWEuXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6IFwicHVibGlzaGVkX2F0XCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlYWRDYXBhY2l0eTogNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IDUsXG4gICAgICAgICAgfVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcbiAgfVxufVxuIl19