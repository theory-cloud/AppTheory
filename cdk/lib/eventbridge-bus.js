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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEventBridgeBus", version: "7.4.0" };
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
            this.owningAccountPolicy = this.allowOwningAccount();
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
     * @see https://docs.aws.amazon.com/securityhub/latest/userguide/eventbridge-controls.html
     */
    allowOwningAccount() {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRicmlkZ2UtYnVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZXZlbnRicmlkZ2UtYnVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELDJDQUF1QztBQUd2QywrREFBMkQ7QUE2QzNEOztHQUVHO0FBQ0gsTUFBYSx1QkFBd0IsU0FBUSxzQkFBUzs7SUFDcEMsUUFBUSxDQUFrQjtJQUMxQixRQUFRLEdBQStCLEVBQUUsQ0FBQztJQUUxRDs7T0FFRztJQUNhLG1CQUFtQixDQUE0QjtJQUU5QyxlQUFlLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUVyRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLFFBQXNDLEVBQUU7UUFDaEYsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQy9DLFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtZQUNoQyxXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7U0FDL0IsQ0FBQyxDQUFDO1FBRUgsTUFBTSx5QkFBeUIsR0FDN0IsS0FBSyxDQUFDLDJCQUEyQixJQUFJLENBQUMsSUFBQSxnQ0FBYyxFQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUNoRyxJQUFJLHlCQUF5QixLQUFLLElBQUksRUFBRSxDQUFDO1lBQ3ZDLElBQUksQ0FBQyxtQkFBbUIsR0FBRyxJQUFJLENBQUMsa0JBQWtCLEVBQUUsQ0FBQztRQUN2RCxDQUFDO1FBRUQsS0FBSyxNQUFNLFNBQVMsSUFBSSxLQUFLLENBQUMsaUJBQWlCLElBQUksRUFBRSxFQUFFLENBQUM7WUFDdEQsSUFBSSxD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LWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGV2ZW50cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWV2ZW50c1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB7IHNlY3VyZURlZmF1bHRzIH0gZnJvbSBcIi4vcHJpdmF0ZS9zZWN1cmUtZGVmYXVsdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlFdmVudEJyaWRnZUJ1c1Byb3BzIHtcbiAgLyoqXG4gICAqIE9wdGlvbmFsIGN1c3RvbSBldmVudCBidXMgbmFtZS5cbiAgICogQGRlZmF1bHQgLSBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZVxuICAgKi9cbiAgcmVhZG9ubHkgZXZlbnRCdXNOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBldmVudCBidXMgZGVzY3JpcHRpb24uXG4gICAqIEBkZWZhdWx0IC0gbm8gZGVzY3JpcHRpb25cbiAgICovXG4gIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCBjcm9zcy1hY2NvdW50IGFsbG93bGlzdCBmb3IgYGV2ZW50czpQdXRFdmVudHNgLlxuICAgKiBQYXJ0bmVycyBjYW4gYmUgb25ib2FyZGVkIG9uZSBhY2NvdW50IGF0IGEgdGltZSBieSBhZGRpbmcgSURzIGhlcmUuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBhbGxvd2VkQWNjb3VudElkcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBuYW1pbmcgY29udGV4dC4gVW5kZXIgYSBkZXJpdmVkIGNvbnRleHQgdGhlIGJ1cyB0YWtlcyBhXG4gICAqIHJlc291cmNlLWJhc2VkIHBvbGljeSB0aGF0IGFkbWl0cyBvbmx5IHRoZSBvd25pbmcgYWNjb3VudCwgd2hpY2ggaXMgd2hhdFxuICAgKiBTZWN1cml0eSBIdWIgRXZlbnRCcmlkZ2UuMyBhc2tzIGZvci5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gYXR0YWNoIHRoZSBvd25pbmctYWNjb3VudCByZXNvdXJjZSBwb2xpY3kuXG4gICAqXG4gICAqIEF0dGFjaGluZyBpdCBjbG9zZXMgdGhlIGJ1cyB0byBldmVyeSBwcmluY2lwYWwgZXhjZXB0IHRoZSBvd25pbmcgYWNjb3VudCxcbiAgICogd2hpY2ggcHJlc2VydmVzIHRvZGF5J3Mgc2FtZS1hY2NvdW50IGJlaGF2aW91ciB3aGlsZSBzYXRpc2Z5aW5nXG4gICAqIEV2ZW50QnJpZGdlLjMuIFNldCBmYWxzZSB0byBhdHRhY2ggb25seSB5b3VyIG93biBzdGF0ZW1lbnRzLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlIHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCwgb3RoZXJ3aXNlIHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3duaW5nQWNjb3VudFJlc291cmNlUG9saWN5PzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBPcGluaW9uYXRlZCBjdXN0b20gRXZlbnRCcmlkZ2UgYnVzIHdpdGggZXhwbGljaXQgY3Jvc3MtYWNjb3VudCBwdWJsaXNoIGFsbG93bGlzdC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUV2ZW50QnJpZGdlQnVzIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGV2ZW50QnVzOiBldmVudHMuRXZlbnRCdXM7XG4gIHB1YmxpYyByZWFkb25seSBwb2xpY2llczogZXZlbnRzLkNmbkV2ZW50QnVzUG9saWN5W10gPSBbXTtcblxuICAvKipcbiAgICogVGhlIG93bmluZy1hY2NvdW50IHJlc291cmNlIHBvbGljeSBhdHRhY2hlZCB1bmRlciBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgb3duaW5nQWNjb3VudFBvbGljeT86IGV2ZW50cy5DZm5FdmVudEJ1c1BvbGljeTtcblxuICBwcml2YXRlIHJlYWRvbmx5IGFsbG93ZWRBY2NvdW50cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlFdmVudEJyaWRnZUJ1c1Byb3BzID0ge30pIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5ldmVudEJ1cyA9IG5ldyBldmVudHMuRXZlbnRCdXModGhpcywgXCJCdXNcIiwge1xuICAgICAgZXZlbnRCdXNOYW1lOiBwcm9wcy5ldmVudEJ1c05hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgfSk7XG5cbiAgICBjb25zdCBhdHRhY2hPd25pbmdBY2NvdW50UG9saWN5ID1cbiAgICAgIHByb3BzLm93bmluZ0FjY291bnRSZXNvdXJjZVBvbGljeSA/PyAoc2VjdXJlRGVmYXVsdHMocHJvcHMubmFtaW5nQ29udGV4dCkgPyB0cnVlIDogdW5kZWZpbmVkKTtcbiAgICBpZiAoYXR0YWNoT3duaW5nQWNjb3VudFBvbGljeSA9PT0gdHJ1ZSkge1xuICAgICAgdGhpcy5vd25pbmdBY2NvdW50UG9saWN5ID0gdGhpcy5hbGxvd093bmluZ0FjY291bnQoKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGFjY291bnRJZCBvZiBwcm9wcy5hbGxvd2VkQWNjb3VudElkcyA/PyBbXSkge1xuICAgICAgdGhpcy5hbGxvd0FjY291bnQoYWNjb3VudElkKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQXR0YWNoZXMgdGhlIG93bmluZy1hY2NvdW50IHJlc291cmNlIHBvbGljeS5cbiAgICpcbiAgICogU2VjdXJpdHkgSHViIEV2ZW50QnJpZGdlLjMgcmVxdWlyZXMgYSBjdXN0b20gYnVzIHRvIGNhcnJ5IGEgcmVzb3VyY2UtYmFzZWRcbiAgICogcG9saWN5LiBUaGUgcG9saWN5IGdyYW50cyB0aGUgb3duaW5nIGFjY291bnQgYGV2ZW50czoqYCBvbiB0aGlzIGJ1cywgc28gZXZlcnlcbiAgICogc2FtZS1hY2NvdW50IHByaW5jaXBhbCBrZWVwcyBleGFjdGx5IHRoZSBhY2Nlc3MgSUFNIGFscmVhZHkgZ2l2ZXMgaXQsIGFuZCBub1xuICAgKiBvdGhlciBhY2NvdW50IGlzIGFkbWl0dGVkLlxuICAgKlxuICAgKiBAc2VlIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9zZWN1cml0eWh1Yi9sYXRlc3QvdXNlcmd1aWRlL2V2ZW50YnJpZGdlLWNvbnRyb2xzLmh0bWxcbiAgICovXG4gIHB1YmxpYyBhbGxvd093bmluZ0FjY291bnQoKTogZXZlbnRzLkNmbkV2ZW50QnVzUG9saWN5IHtcbiAgICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIGNvbnN0IHBvbGljeSA9IG5ldyBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3kodGhpcywgXCJPd25pbmdBY2NvdW50UG9saWN5XCIsIHtcbiAgICAgIGV2ZW50QnVzTmFtZTogdGhpcy5ldmVudEJ1cy5ldmVudEJ1c05hbWUsXG4gICAgICBzdGF0ZW1lbnRJZDogXCJBbGxvd093bmluZ0FjY291bnRcIixcbiAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICBFZmZlY3Q6IFwiQWxsb3dcIixcbiAgICAgICAgQWN0aW9uOiBcImV2ZW50czoqXCIsXG4gICAgICAgIFByaW5jaXBhbDoge1xuICAgICAgICAgIEFXUzogc3RhY2suZm9ybWF0QXJuKHsgc2VydmljZTogXCJpYW1cIiwgcmVnaW9uOiBcIlwiLCBhY2NvdW50OiBzdGFjay5hY2NvdW50LCByZXNvdXJjZTogXCJyb290XCIgfSksXG4gICAgICAgIH0sXG4gICAgICAgIFJlc291cmNlOiB0aGlzLmV2ZW50QnVzLmV2ZW50QnVzQXJuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICByZXR1cm4gcG9saWN5O1xuICB9XG5cbiAgLyoqXG4gICAqIEFkZHMgYSBzaW5nbGUgYWNjb3VudCBJRCB0byB0aGUgY3Jvc3MtYWNjb3VudCBwdWJsaXNoIGFsbG93bGlzdC5cbiAgICovXG4gIHB1YmxpYyBhbGxvd0FjY291bnQoYWNjb3VudElkOiBzdHJpbmcpOiBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3kge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVBY2NvdW50SWQoYWNjb3VudElkKTtcbiAgICB2YWxpZGF0ZUFjY291bnRJZChub3JtYWxpemVkKTtcblxuICAgIGlmICh0aGlzLmFsbG93ZWRBY2NvdW50cy5oYXMobm9ybWFsaXplZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5RXZlbnRCcmlkZ2VCdXM6IGR1cGxpY2F0ZSBhbGxvd2VkIGFjY291bnQgSUQgJHtub3JtYWxpemVkfWApO1xuICAgIH1cblxuICAgIGNvbnN0IGluZGV4ID0gdGhpcy5wb2xpY2llcy5sZW5ndGggKyAxO1xuICAgIGNvbnN0IHBvbGljeSA9IG5ldyBldmVudHMuQ2ZuRXZlbnRCdXNQb2xpY3kodGhpcywgYEFsbG93QWNjb3VudCR7aW5kZXh9YCwge1xuICAgICAgZXZlbnRCdXNOYW1lOiB0aGlzLmV2ZW50QnVzLmV2ZW50QnVzTmFtZSxcbiAgICAgIHN0YXRlbWVudElkOiBgQWxsb3dQdXRFdmVudHMke2luZGV4fWAsXG4gICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgRWZmZWN0OiBcIkFsbG93XCIsXG4gICAgICAgIEFjdGlvbjogXCJldmVudHM6UHV0RXZlbnRzXCIsXG4gICAgICAgIFByaW5jaXBhbDogeyBBV1M6IG5vcm1hbGl6ZWQgfSxcbiAgICAgICAgUmVzb3VyY2U6IHRoaXMuZXZlbnRCdXMuZXZlbnRCdXNBcm4sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5hbGxvd2VkQWNjb3VudHMuYWRkKG5vcm1hbGl6ZWQpO1xuICAgIHRoaXMucG9saWNpZXMucHVzaChwb2xpY3kpO1xuICAgIHJldHVybiBwb2xpY3k7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQWNjb3VudElkKHJhdzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyhyYXcgPz8gXCJcIikudHJpbSgpO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUFjY291bnRJZChhY2NvdW50SWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWFjY291bnRJZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUV2ZW50QnJpZGdlQnVzOiBhbGxvd2VkQWNjb3VudElkcyBjYW5ub3QgY29udGFpbiBlbXB0eSB2YWx1ZXNcIik7XG4gIH1cbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChhY2NvdW50SWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghL15cXGR7MTJ9JC8udGVzdChhY2NvdW50SWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RXZlbnRCcmlkZ2VCdXM6IGFsbG93ZWRBY2NvdW50SWRzIG11c3QgYmUgMTItZGlnaXQgQVdTIGFjY291bnQgSURzXCIpO1xuICB9XG59XG4iXX0=