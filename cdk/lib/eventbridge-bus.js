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
exports.AppTheoryEventBridgeBus = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const events = __importStar(require("aws-cdk-lib/aws-events"));
const constructs_1 = require("constructs");
/**
 * Opinionated custom EventBridge bus with explicit cross-account publish allowlist.
 */
class AppTheoryEventBridgeBus extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEventBridgeBus", version: "4.3.0-rc" };
    eventBus;
    policies = [];
    allowedAccounts = new Set();
    constructor(scope, id, props = {}) {
        super(scope, id);
        this.eventBus = new events.EventBus(this, "Bus", {
            eventBusName: props.eventBusName,
            description: props.description,
        });
        for (const accountId of props.allowedAccountIds ?? []) {
            this.allowAccount(accountId);
        }
    }
    /**
     * Adds a single account ID to the cross-account publish allowlist.
     */
    allowAccount(accountId) {
        const normalized = normalizeAccountId(accountId);
        validateAccountId(normalized);
        if (this.allowedAccounts.has(normalized)) {
            throw new Error(`AppTheoryEventBridgeBus: duplicate allowed account ID ${normalized}`);
        }
        const index = this.policies.length + 1;
        const policy = new events.CfnEventBusPolicy(this, `AllowAccount${index}`, {
            eventBusName: this.eventBus.eventBusName,
            statementId: `AllowPutEvents${index}`,
            statement: {
                Effect: "Allow",
                Action: "events:PutEvents",
                Principal: { AWS: normalized },
                Resource: this.eventBus.eventBusArn,
            },
        });
        this.allowedAccounts.add(normalized);
        this.policies.push(policy);
        return policy;
    }
}
exports.AppTheoryEventBridgeBus = AppTheoryEventBridgeBus;
function normalizeAccountId(raw) {
    return String(raw ?? "").trim();
}
function validateAccountId(accountId) {
    if (!accountId) {
        throw new Error("AppTheoryEventBridgeBus: allowedAccountIds cannot contain empty values");
    }
    if (aws_cdk_lib_1.Token.isUnresolved(accountId)) {
        return;
    }
    if (!/^\d{12}$/.test(accountId)) {
        throw new Error("AppTheoryEventBridgeBus: allowedAccountIds must be 12-digit AWS account IDs");
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRicmlkZ2UtYnVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZXZlbnRicmlkZ2UtYnVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBb0M7QUFDcEMsK0RBQWlEO0FBQ2pELDJDQUF1QztBQXVCdkM7O0dBRUc7QUFDSCxNQUFhLHVCQUF3QixTQUFRLHNCQUFTOztJQUNwQyxRQUFRLENBQWtCO0lBQzFCLFFBQVEsR0FBK0IsRUFBRSxDQUFDO0lBRXpDLGVBQWUsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBRXJELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBc0MsRUFBRTtRQUNoRixLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDL0MsWUFBWSxFQUFFLEtBQUssQ0FBQyxZQUFZO1lBQ2hDLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVztTQUMvQixDQUFDLENBQUM7UUFFSCxLQUFLLE1BQU0sU0FBUyxJQUFJLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxFQUFFLEVBQUUsQ0FBQztZQUN0RCxJQUFJLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQy9CLENBQUM7SUFDSCxDQUFDO0lBRUQ7O09BRUc7SUFDSSxZQUFZLENBQUMsU0FBaUI7UUFDbkMsTUFBTSxVQUFVLEdBQUcsa0JBQWtCLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDakQsaUJBQWlCLENBQUMsVUFBVSxDQUFDLENBQUM7UUFFOUIsSUFBSSxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDO1lBQ3pDLE1BQU0sSUFBSSxLQUFLLENBQUMseURBQXlELFVBQVUsRUFBRSxDQUFDLENBQUM7UUFDekYsQ0FBQztRQUVELE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztRQUN2QyxNQUFNLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsZUFBZSxLQUFLLEVBQUUsRUFBRTtZQUN4RSxZQUFZLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZO1lBQ3hDLFdBQVcsRUFBRSxpQkFBaUIsS0FBSyxFQUFFO1lBQ3JDLFNBQVMsRUFBRTtnQkFDVCxNQUFNLEVBQUUsT0FBTztnQkFDZixNQUFNLEVBQUUsa0JBQWtCO2dCQUMxQixTQUFTLEVBQUUsRUFBRSxHQUFHLEVBQUUsVUFBVSxFQUFFO2dCQUM5QixRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxXQUFXO2FBQ3BDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDckMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDM0IsT0FBTyxNQUFNLENBQUM7SUFDaEIsQ0FBQzs7QUE3Q0gsMERBOENDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxHQUFXO0lBQ3JDLE9BQU8sTUFBTSxDQUFDLEdBQUcsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNsQyxDQUFDO0FBRUQsU0FBUyxpQkFBaUIsQ0FBQyxTQUFpQjtJQUMxQyxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7UUFDZixNQUFNLElBQUksS0FBSyxDQUFDLHdFQUF3RSxDQUFDLENBQUM7SUFDNUYsQ0FBQztJQUNELElBQUksbUJBQUssQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztRQUNsQyxPQUFPO0lBQ1QsQ0FBQztJQUNELElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7UUFDaEMsTUFBTSxJQUFJLEtBQUssQ0FBQyw2RUFBNkUsQ0FBQyxDQUFDO0lBQ2pHLENBQUM7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGV2ZW50cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWV2ZW50c1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlFdmVudEJyaWRnZUJ1c1Byb3BzIHtcbiAgLyoqXG4gICAqIE9wdGlvbmFsIGN1c3RvbSBldmVudCBidXMgbmFtZS5cbiAgICogQGRlZmF1bHQgLSBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZVxuICAgKi9cbiAgcmVhZG9ubHkgZXZlbnRCdXNOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBldmVudCBidXMgZGVzY3JpcHRpb24uXG4gICAqIEBkZWZhdWx0IC0gbm8gZGVzY3JpcHRpb25cbiAgICovXG4gIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCBjcm9zcy1hY2NvdW50IGFsbG93bGlzdCBmb3IgYGV2ZW50czpQdXRFdmVudHNgLlxuICAgKiBQYXJ0bmVycyBjYW4gYmUgb25ib2FyZGVkIG9uZSBhY2NvdW50IGF0IGEgdGltZSBieSBhZGRpbmcgSURzIGhlcmUuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBhbGxvd2VkQWNjb3VudElkcz86IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIE9waW5pb25hdGVkIGN1c3RvbSBFdmVudEJyaWRnZSBidXMgd2l0aCBleHBsaWNpdCBjcm9zcy1hY2NvdW50IHB1Ymxpc2ggYWxsb3dsaXN0LlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5RXZlbnRCcmlkZ2VCdXMgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgZXZlbnRCdXM6IGV2ZW50cy5FdmVudEJ1cztcbiAgcHVibGljIHJlYWRvbmx5IHBvbGljaWVzOiBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3lbXSA9IFtdO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgYWxsb3dlZEFjY291bnRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUV2ZW50QnJpZGdlQnVzUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICB0aGlzLmV2ZW50QnVzID0gbmV3IGV2ZW50cy5FdmVudEJ1cyh0aGlzLCBcIkJ1c1wiLCB7XG4gICAgICBldmVudEJ1c05hbWU6IHByb3BzLmV2ZW50QnVzTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBwcm9wcy5kZXNjcmlwdGlvbixcbiAgICB9KTtcblxuICAgIGZvciAoY29uc3QgYWNjb3VudElkIG9mIHByb3BzLmFsbG93ZWRBY2NvdW50SWRzID8/IFtdKSB7XG4gICAgICB0aGlzLmFsbG93QWNjb3VudChhY2NvdW50SWQpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBBZGRzIGEgc2luZ2xlIGFjY291bnQgSUQgdG8gdGhlIGNyb3NzLWFjY291bnQgcHVibGlzaCBhbGxvd2xpc3QuXG4gICAqL1xuICBwdWJsaWMgYWxsb3dBY2NvdW50KGFjY291bnRJZDogc3RyaW5nKTogZXZlbnRzLkNmbkV2ZW50QnVzUG9saWN5IHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplQWNjb3VudElkKGFjY291bnRJZCk7XG4gICAgdmFsaWRhdGVBY2NvdW50SWQobm9ybWFsaXplZCk7XG5cbiAgICBpZiAodGhpcy5hbGxvd2VkQWNjb3VudHMuaGFzKG5vcm1hbGl6ZWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeUV2ZW50QnJpZGdlQnVzOiBkdXBsaWNhdGUgYWxsb3dlZCBhY2NvdW50IElEICR7bm9ybWFsaXplZH1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBpbmRleCA9IHRoaXMucG9saWNpZXMubGVuZ3RoICsgMTtcbiAgICBjb25zdCBwb2xpY3kgPSBuZXcgZXZlbnRzLkNmbkV2ZW50QnVzUG9saWN5KHRoaXMsIGBBbGxvd0FjY291bnQke2luZGV4fWAsIHtcbiAgICAgIGV2ZW50QnVzTmFtZTogdGhpcy5ldmVudEJ1cy5ldmVudEJ1c05hbWUsXG4gICAgICBzdGF0ZW1lbnRJZDogYEFsbG93UHV0RXZlbnRzJHtpbmRleH1gLFxuICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgICBBY3Rpb246IFwiZXZlbnRzOlB1dEV2ZW50c1wiLFxuICAgICAgICBQcmluY2lwYWw6IHsgQVdTOiBub3JtYWxpemVkIH0sXG4gICAgICAgIFJlc291cmNlOiB0aGlzLmV2ZW50QnVzLmV2ZW50QnVzQXJuLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWxsb3dlZEFjY291bnRzLmFkZChub3JtYWxpemVkKTtcbiAgICB0aGlzLnBvbGljaWVzLnB1c2gocG9saWN5KTtcbiAgICByZXR1cm4gcG9saWN5O1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUFjY291bnRJZChyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcocmF3ID8/IFwiXCIpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVBY2NvdW50SWQoYWNjb3VudElkOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFhY2NvdW50SWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlFdmVudEJyaWRnZUJ1czogYWxsb3dlZEFjY291bnRJZHMgY2Fubm90IGNvbnRhaW4gZW1wdHkgdmFsdWVzXCIpO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQoYWNjb3VudElkKSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIS9eXFxkezEyfSQvLnRlc3QoYWNjb3VudElkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUV2ZW50QnJpZGdlQnVzOiBhbGxvd2VkQWNjb3VudElkcyBtdXN0IGJlIDEyLWRpZ2l0IEFXUyBhY2NvdW50IElEc1wiKTtcbiAgfVxufVxuIl19