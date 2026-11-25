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
const secure_defaults_1 = require("./private/secure-defaults");
/**
 * Opinionated custom EventBridge bus with explicit cross-account publish allowlist.
 */
class AppTheoryEventBridgeBus extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEventBridgeBus", version: "7.5.0" };
    eventBus;
    policies = [];
    /**
     * The owning-account resource policy attached under a derived naming context.
     */
    owningAccountPolicy;
    allowedAccounts = new Set();
    constructor(scope, id, props = {}) {
        super(scope, id);
        this.eventBus = new events.EventBus(this, "Bus", {
            eventBusName: props.eventBusName,
            description: props.description,
        });
        const attachOwningAccountPolicy = props.owningAccountResourcePolicy ?? ((0, secure_defaults_1.secureDefaults)(props.namingContext) ? true : undefined);
        if (attachOwningAccountPolicy === true) {
            this.allowOwningAccount();
        }
        for (const accountId of props.allowedAccountIds ?? []) {
            this.allowAccount(accountId);
        }
    }
    /**
     * Attaches the owning-account resource policy.
     *
     * Security Hub EventBridge.3 requires a custom bus to carry a resource-based
     * policy. The policy grants the owning account `events:*` on this bus, so every
     * same-account principal keeps exactly the access IAM already gives it, and no
     * other account is admitted.
     *
     * Call this at most once. Under a derived naming context the constructor
     * already attaches it, so pass `owningAccountResourcePolicy: false` when you
     * want to choose the moment yourself.
     *
     * @see https://docs.aws.amazon.com/securityhub/latest/userguide/eventbridge-controls.html
     */
    allowOwningAccount() {
        if (this.owningAccountPolicy !== undefined) {
            throw new Error("AppTheoryEventBridgeBus already attaches its owning-account resource policy; pass owningAccountResourcePolicy: false to attach it yourself");
        }
        const stack = aws_cdk_lib_1.Stack.of(this);
        const policy = new events.CfnEventBusPolicy(this, "OwningAccountPolicy", {
            eventBusName: this.eventBus.eventBusName,
            statementId: "AllowOwningAccount",
            statement: {
                Effect: "Allow",
                Action: "events:*",
                Principal: {
                    AWS: stack.formatArn({ service: "iam", region: "", account: stack.account, resource: "root" }),
                },
                Resource: this.eventBus.eventBusArn,
            },
        });
        this.owningAccountPolicy = policy;
        return policy;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRicmlkZ2UtYnVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZXZlbnRicmlkZ2UtYnVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELDJDQUF1QztBQUd2QywrREFBMkQ7QUE2QzNEOztHQUVHO0FBQ0gsTUFBYSx1QkFBd0IsU0FBUSxzQkFBUzs7SUFDcEMsUUFBUSxDQUFrQjtJQUMxQixRQUFRLEdBQStCLEVBQUUsQ0FBQztJQUUxRDs7T0FFRztJQUNhLG1CQUFtQixDQUE0QjtJQUU5QyxlQUFlLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUVyRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLFFBQXNDLEVBQUU7UUFDaEYsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQy9DLFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtZQUNoQyxXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7U0FDL0IsQ0FBQyxDQUFDO1FBRUgsTUFBTSx5QkFBeUIsR0FDN0IsS0FBSyxDQUFDLDJCQUEyQixJQUFJLENBQUMsSUFBQSxnQ0FBYyxFQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUNoRyxJQUFJLHlCQUF5QixLQUFLLElBQUksRUFBRSxDQUFDO1lBQ3ZDLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1FBQzVCLENBQUM7UUFFRCxLQUFLLE1BQU0sU0FBUyxJQUFJLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxFQUFFLEVBQUUsQ0FBQztZQUN0RCxJQUFJLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQy9CLENBQUM7SUFDSCxDQUFDO0lBRUQ7Ozs7Ozs7Ozs7Ozs7T0FhRztJQUNJLGtCQUFrQjtRQUN2QixJQUFJLElBQUksQ0FBQyxtQkFBbUIsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUMzQyxNQUFNLElBQUksS0FBSyxDQUNiLDRJQUE0SSxDQUM3SSxDQUFDO1FBQ0osQ0FBQztRQUNELE1BQU0sS0FBSyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzdCLE1BQU0sTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLGlCQUFpQixDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUN2RSxZQUFZLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZO1lBQ3hDLFdBQVcsRUFBRSxvQkFBb0I7WUFDakMsU0FBUyxFQUFFO2dCQUNULE1BQU0sRUFBRSxPQUFPO2dCQUNmLE1BQU0sRUFBRSxVQUFVO2dCQUNsQixTQUFTLEVBQUU7b0JBQ1QsR0FBRyxFQUFFLEtBQUssQ0FBQyxTQUFTLENBQUMsRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxFQUFFLEVBQUUsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxDQUFDO2lCQUMvRjtnQkFDRCxRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxXQUFXO2FBQ3BDO1NBQ0YsQ0FBQyxDQUFDO1FBQ0YsSUFBMkQsQ0FBQyxtQkFBbUIsR0FBRyxNQUFNLENBQUM7UUFDMUYsT0FBTyxNQUFNLENBQUM7SUFDaEIsQ0FBQztJQUVEOztPQUVHO0lBQ0ksWUFBWSxDQUFDLFNBQWlCO1FBQ25DLE1BQU0sVUFBVSxHQUFHLGtCQUFrQixDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQ2pELGlCQUFpQixDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBRTlCLElBQUksSUFBSSxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztZQUN6QyxNQUFNLElBQUksS0FBSyxDQUFDLHlEQUF5RCxVQUFVLEVBQUUsQ0FBQyxDQUFDO1FBQ3pGLENBQUM7UUFFRCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7UUFDdkMsTUFBTSxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsaUJBQWlCLENBQUMsSUFBSSxFQUFFLGVBQWUsS0FBSyxFQUFFLEVBQUU7WUFDeEUsWUFBWSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsWUFBWTtZQUN4QyxXQUFXLEVBQUUsaUJBQWlCLEtBQUssRUFBRTtZQUNyQyxTQUFTLEVBQUU7Z0JBQ1QsTUFBTSxFQUFFLE9BQU87Z0JBQ2YsTUFBTSxFQUFFLGtCQUFrQjtnQkFDMUIsU0FBUyxFQUFFLEVBQUUsR0FBRyxFQUFFLFVBQVUsRUFBRTtnQkFDOUIsUUFBUSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsV0FBVzthQUNwQztTQUNGLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ3JDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQzNCLE9BQU8sTUFBTSxDQUFDO0lBQ2hCLENBQUM7O0FBN0ZILDBEQThGQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLE1BQU0sQ0FBQyxHQUFHLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDbEMsQ0FBQztBQUVELFNBQVMsaUJBQWlCLENBQUMsU0FBaUI7SUFDMUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1FBQ2YsTUFBTSxJQUFJLEtBQUssQ0FBQyx3RUFBd0UsQ0FBQyxDQUFDO0lBQzVGLENBQUM7SUFDRCxJQUFJLG1CQUFLLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7UUFDbEMsT0FBTztJQUNULENBQUM7SUFDRCxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1FBQ2hDLE1BQU0sSUFBSSxLQUFLLENBQUMsNkVBQTZFLENBQUMsQ0FBQztJQUNqRyxDQUFDO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZXZlbnRzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuaW1wb3J0IHsgc2VjdXJlRGVmYXVsdHMgfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUV2ZW50QnJpZGdlQnVzUHJvcHMge1xuICAvKipcbiAgICogT3B0aW9uYWwgY3VzdG9tIGV2ZW50IGJ1cyBuYW1lLlxuICAgKiBAZGVmYXVsdCAtIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZCBuYW1lXG4gICAqL1xuICByZWFkb25seSBldmVudEJ1c05hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGV2ZW50IGJ1cyBkZXNjcmlwdGlvbi5cbiAgICogQGRlZmF1bHQgLSBubyBkZXNjcmlwdGlvblxuICAgKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IGNyb3NzLWFjY291bnQgYWxsb3dsaXN0IGZvciBgZXZlbnRzOlB1dEV2ZW50c2AuXG4gICAqIFBhcnRuZXJzIGNhbiBiZSBvbmJvYXJkZWQgb25lIGFjY291bnQgYXQgYSB0aW1lIGJ5IGFkZGluZyBJRHMgaGVyZS5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93ZWRBY2NvdW50SWRzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBjb250ZXh0LiBVbmRlciBhIGRlcml2ZWQgY29udGV4dCB0aGUgYnVzIHRha2VzIGFcbiAgICogcmVzb3VyY2UtYmFzZWQgcG9saWN5IHRoYXQgYWRtaXRzIG9ubHkgdGhlIG93bmluZyBhY2NvdW50LCB3aGljaCBpcyB3aGF0XG4gICAqIFNlY3VyaXR5IEh1YiBFdmVudEJyaWRnZS4zIGFza3MgZm9yLlxuICAgKlxuICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogV2hldGhlciB0byBhdHRhY2ggdGhlIG93bmluZy1hY2NvdW50IHJlc291cmNlIHBvbGljeS5cbiAgICpcbiAgICogQXR0YWNoaW5nIGl0IGNsb3NlcyB0aGUgYnVzIHRvIGV2ZXJ5IHByaW5jaXBhbCBleGNlcHQgdGhlIG93bmluZyBhY2NvdW50LFxuICAgKiB3aGljaCBwcmVzZXJ2ZXMgdG9kYXkncyBzYW1lLWFjY291bnQgYmVoYXZpb3VyIHdoaWxlIHNhdGlzZnlpbmdcbiAgICogRXZlbnRCcmlkZ2UuMy4gU2V0IGZhbHNlIHRvIGF0dGFjaCBvbmx5IHlvdXIgb3duIHN0YXRlbWVudHMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWUgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0LCBvdGhlcndpc2UgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvd25pbmdBY2NvdW50UmVzb3VyY2VQb2xpY3k/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9waW5pb25hdGVkIGN1c3RvbSBFdmVudEJyaWRnZSBidXMgd2l0aCBleHBsaWNpdCBjcm9zcy1hY2NvdW50IHB1Ymxpc2ggYWxsb3dsaXN0LlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5RXZlbnRCcmlkZ2VCdXMgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgZXZlbnRCdXM6IGV2ZW50cy5FdmVudEJ1cztcbiAgcHVibGljIHJlYWRvbmx5IHBvbGljaWVzOiBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3lbXSA9IFtdO1xuXG4gIC8qKlxuICAgKiBUaGUgb3duaW5nLWFjY291bnQgcmVzb3VyY2UgcG9saWN5IGF0dGFjaGVkIHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBvd25pbmdBY2NvdW50UG9saWN5PzogZXZlbnRzLkNmbkV2ZW50QnVzUG9saWN5O1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgYWxsb3dlZEFjY291bnRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUV2ZW50QnJpZGdlQnVzUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICB0aGlzLmV2ZW50QnVzID0gbmV3IGV2ZW50cy5FdmVudEJ1cyh0aGlzLCBcIkJ1c1wiLCB7XG4gICAgICBldmVudEJ1c05hbWU6IHByb3BzLmV2ZW50QnVzTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBwcm9wcy5kZXNjcmlwdGlvbixcbiAgICB9KTtcblxuICAgIGNvbnN0IGF0dGFjaE93bmluZ0FjY291bnRQb2xpY3kgPVxuICAgICAgcHJvcHMub3duaW5nQWNjb3VudFJlc291cmNlUG9saWN5ID8/IChzZWN1cmVEZWZhdWx0cyhwcm9wcy5uYW1pbmdDb250ZXh0KSA/IHRydWUgOiB1bmRlZmluZWQpO1xuICAgIGlmIChhdHRhY2hPd25pbmdBY2NvdW50UG9saWN5ID09PSB0cnVlKSB7XG4gICAgICB0aGlzLmFsbG93T3duaW5nQWNjb3VudCgpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgYWNjb3VudElkIG9mIHByb3BzLmFsbG93ZWRBY2NvdW50SWRzID8/IFtdKSB7XG4gICAgICB0aGlzLmFsbG93QWNjb3VudChhY2NvdW50SWQpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBBdHRhY2hlcyB0aGUgb3duaW5nLWFjY291bnQgcmVzb3VyY2UgcG9saWN5LlxuICAgKlxuICAgKiBTZWN1cml0eSBIdWIgRXZlbnRCcmlkZ2UuMyByZXF1aXJlcyBhIGN1c3RvbSBidXMgdG8gY2FycnkgYSByZXNvdXJjZS1iYXNlZFxuICAgKiBwb2xpY3kuIFRoZSBwb2xpY3kgZ3JhbnRzIHRoZSBvd25pbmcgYWNjb3VudCBgZXZlbnRzOipgIG9uIHRoaXMgYnVzLCBzbyBldmVyeVxuICAgKiBzYW1lLWFjY291bnQgcHJpbmNpcGFsIGtlZXBzIGV4YWN0bHkgdGhlIGFjY2VzcyBJQU0gYWxyZWFkeSBnaXZlcyBpdCwgYW5kIG5vXG4gICAqIG90aGVyIGFjY291bnQgaXMgYWRtaXR0ZWQuXG4gICAqXG4gICAqIENhbGwgdGhpcyBhdCBtb3N0IG9uY2UuIFVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB0aGUgY29uc3RydWN0b3JcbiAgICogYWxyZWFkeSBhdHRhY2hlcyBpdCwgc28gcGFzcyBgb3duaW5nQWNjb3VudFJlc291cmNlUG9saWN5OiBmYWxzZWAgd2hlbiB5b3VcbiAgICogd2FudCB0byBjaG9vc2UgdGhlIG1vbWVudCB5b3Vyc2VsZi5cbiAgICpcbiAgICogQHNlZSBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vc2VjdXJpdHlodWIvbGF0ZXN0L3VzZXJndWlkZS9ldmVudGJyaWRnZS1jb250cm9scy5odG1sXG4gICAqL1xuICBwdWJsaWMgYWxsb3dPd25pbmdBY2NvdW50KCk6IGV2ZW50cy5DZm5FdmVudEJ1c1BvbGljeSB7XG4gICAgaWYgKHRoaXMub3duaW5nQWNjb3VudFBvbGljeSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5RXZlbnRCcmlkZ2VCdXMgYWxyZWFkeSBhdHRhY2hlcyBpdHMgb3duaW5nLWFjY291bnQgcmVzb3VyY2UgcG9saWN5OyBwYXNzIG93bmluZ0FjY291bnRSZXNvdXJjZVBvbGljeTogZmFsc2UgdG8gYXR0YWNoIGl0IHlvdXJzZWxmXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIGNvbnN0IHBvbGljeSA9IG5ldyBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3kodGhpcywgXCJPd25pbmdBY2NvdW50UG9saWN5XCIsIHtcbiAgICAgIGV2ZW50QnVzTmFtZTogdGhpcy5ldmVudEJ1cy5ldmVudEJ1c05hbWUsXG4gICAgICBzdGF0ZW1lbnRJZDogXCJBbGxvd093bmluZ0FjY291bnRcIixcbiAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICBFZmZlY3Q6IFwiQWxsb3dcIixcbiAgICAgICAgQWN0aW9uOiBcImV2ZW50czoqXCIsXG4gICAgICAgIFByaW5jaXBhbDoge1xuICAgICAgICAgIEFXUzogc3RhY2suZm9ybWF0QXJuKHsgc2VydmljZTogXCJpYW1cIiwgcmVnaW9uOiBcIlwiLCBhY2NvdW50OiBzdGFjay5hY2NvdW50LCByZXNvdXJjZTogXCJyb290XCIgfSksXG4gICAgICAgIH0sXG4gICAgICAgIFJlc291cmNlOiB0aGlzLmV2ZW50QnVzLmV2ZW50QnVzQXJuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IG93bmluZ0FjY291bnRQb2xpY3k/OiBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3kgfSkub3duaW5nQWNjb3VudFBvbGljeSA9IHBvbGljeTtcbiAgICByZXR1cm4gcG9saWN5O1xuICB9XG5cbiAgLyoqXG4gICAqIEFkZHMgYSBzaW5nbGUgYWNjb3VudCBJRCB0byB0aGUgY3Jvc3MtYWNjb3VudCBwdWJsaXNoIGFsbG93bGlzdC5cbiAgICovXG4gIHB1YmxpYyBhbGxvd0FjY291bnQoYWNjb3VudElkOiBzdHJpbmcpOiBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3kge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVBY2NvdW50SWQoYWNjb3VudElkKTtcbiAgICB2YWxpZGF0ZUFjY291bnRJZChub3JtYWxpemVkKTtcblxuICAgIGlmICh0aGlzLmFsbG93ZWRBY2NvdW50cy5oYXMobm9ybWFsaXplZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5RXZlbnRCcmlkZ2VCdXM6IGR1cGxpY2F0ZSBhbGxvd2VkIGFjY291bnQgSUQgJHtub3JtYWxpemVkfWApO1xuICAgIH1cblxuICAgIGNvbnN0IGluZGV4ID0gdGhpcy5wb2xpY2llcy5sZW5ndGggKyAxO1xuICAgIGNvbnN0IHBvbGljeSA9IG5ldyBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3kodGhpcywgYEFsbG93QWNjb3VudCR7aW5kZXh9YCwge1xuICAgICAgZXZlbnRCdXNOYW1lOiB0aGlzLmV2ZW50QnVzLmV2ZW50QnVzTmFtZSxcbiAgICAgIHN0YXRlbWVudElkOiBgQWxsb3dQdXRFdmVudHMke2luZGV4fWAsXG4gICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgRWZmZWN0OiBcIkFsbG93XCIsXG4gICAgICAgIEFjdGlvbjogXCJldmVudHM6UHV0RXZlbnRzXCIsXG4gICAgICAgIFByaW5jaXBhbDogeyBBV1M6IG5vcm1hbGl6ZWQgfSxcbiAgICAgICAgUmVzb3VyY2U6IHRoaXMuZXZlbnRCdXMuZXZlbnRCdXNBcm4sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5hbGxvd2VkQWNjb3VudHMuYWRkKG5vcm1hbGl6ZWQpO1xuICAgIHRoaXMucG9saWNpZXMucHVzaChwb2xpY3kpO1xuICAgIHJldHVybiBwb2xpY3k7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQWNjb3VudElkKHJhdzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyhyYXcgPz8gXCJcIikudHJpbSgpO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUFjY291bnRJZChhY2NvdW50SWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWFjY291bnRJZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUV2ZW50QnJpZGdlQnVzOiBhbGxvd2VkQWNjb3VudElkcyBjYW5ub3QgY29udGFpbiBlbXB0eSB2YWx1ZXNcIik7XG4gIH1cbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChhY2NvdW50SWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghL15cXGR7MTJ9JC8udGVzdChhY2NvdW50SWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RXZlbnRCcmlkZ2VCdXM6IGFsbG93ZWRBY2NvdW50SWRzIG11c3QgYmUgMTItZGlnaXQgQVdTIGFjY291bnQgSURzXCIpO1xuICB9XG59XG4iXX0=