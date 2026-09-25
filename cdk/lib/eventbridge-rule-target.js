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
exports.AppTheoryEventBridgeRuleTarget = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const events = __importStar(require("aws-cdk-lib/aws-events"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const constructs_1 = require("constructs");
/**
 * Opinionated wiring for an EventBridge rule with a Lambda target.
 *
 * This construct intentionally enforces `eventPattern` XOR `schedule` (fail closed).
 * For schedule-only back-compat, see `AppTheoryEventBridgeHandler`.
 */
class AppTheoryEventBridgeRuleTarget extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEventBridgeRuleTarget", version: "4.4.2-rc" };
    rule;
    constructor(scope, id, props) {
        super(scope, id);
        const hasEventPattern = props.eventPattern !== undefined;
        const hasSchedule = props.schedule !== undefined;
        if (hasEventPattern === hasSchedule) {
            throw new Error("AppTheoryEventBridgeRuleTarget requires exactly one of eventPattern or schedule");
        }
        this.rule = new events.Rule(this, "Rule", {
            ruleName: props.ruleName,
            description: props.description,
            enabled: props.enabled,
            eventBus: props.eventBus,
            eventPattern: props.eventPattern,
            schedule: props.schedule,
        });
        this.rule.addTarget(new targets.LambdaFunction(props.handler, props.targetProps));
    }
}
exports.AppTheoryEventBridgeRuleTarget = AppTheoryEventBridgeRuleTarget;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRicmlkZ2UtcnVsZS10YXJnZXQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJldmVudGJyaWRnZS1ydWxlLXRhcmdldC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsK0RBQWlEO0FBQ2pELHdFQUEwRDtBQUUxRCwyQ0FBdUM7QUFvRHZDOzs7OztHQUtHO0FBQ0gsTUFBYSw4QkFBK0IsU0FBUSxzQkFBUzs7SUFDM0MsSUFBSSxDQUFjO0lBRWxDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBMEM7UUFDbEYsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLGVBQWUsR0FBRyxLQUFLLENBQUMsWUFBWSxLQUFLLFNBQVMsQ0FBQztRQUN6RCxNQUFNLFdBQVcsR0FBRyxLQUFLLENBQUMsUUFBUSxLQUFLLFNBQVMsQ0FBQztRQUVqRCxJQUFJLGVBQWUsS0FBSyxXQUFXLEVBQUUsQ0FBQztZQUNwQyxNQUFNLElBQUksS0FBSyxDQUFDLGlGQUFpRixDQUFDLENBQUM7UUFDckcsQ0FBQztRQUVELElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUU7WUFDeEMsUUFBUSxFQUFFLEtBQUssQ0FBQyxRQUFRO1lBQ3hCLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVztZQUM5QixPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU87WUFDdEIsUUFBUSxFQUFFLEtBQUssQ0FBQyxRQUFRO1lBQ3hCLFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtZQUNoQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7U0FDekIsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxPQUFPLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7SUFDcEYsQ0FBQzs7QUF2Qkgsd0VBd0JDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZXZlbnRzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZXZlbnRzLXRhcmdldHNcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUV2ZW50QnJpZGdlUnVsZVRhcmdldFByb3BzIHtcbiAgLyoqXG4gICAqIFRoZSBMYW1iZGEgZnVuY3Rpb24gdG8gaW52b2tlIHdoZW4gdGhlIHJ1bGUgbWF0Y2hlcy5cbiAgICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIEV2ZW50QnJpZGdlIGV2ZW50IHBhdHRlcm4gZm9yIHJ1bGUgbWF0Y2hpbmcuXG4gICAqXG4gICAqIE11dHVhbGx5IGV4Y2x1c2l2ZSB3aXRoIGBzY2hlZHVsZWAuXG4gICAqL1xuICByZWFkb25seSBldmVudFBhdHRlcm4/OiBldmVudHMuRXZlbnRQYXR0ZXJuO1xuXG4gIC8qKlxuICAgKiBTY2hlZHVsZSBmb3IgcnVsZSB0cmlnZ2VyaW5nLlxuICAgKlxuICAgKiBNdXR1YWxseSBleGNsdXNpdmUgd2l0aCBgZXZlbnRQYXR0ZXJuYC5cbiAgICovXG4gIHJlYWRvbmx5IHNjaGVkdWxlPzogZXZlbnRzLlNjaGVkdWxlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBldmVudCBidXMgdG8gYXR0YWNoIHRoZSBydWxlIHRvLlxuICAgKiBAZGVmYXVsdCAtIHRoZSBhY2NvdW50IGRlZmF1bHQgZXZlbnQgYnVzXG4gICAqL1xuICByZWFkb25seSBldmVudEJ1cz86IGV2ZW50cy5JRXZlbnRCdXM7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIHJ1bGUgbmFtZS5cbiAgICogQGRlZmF1bHQgLSBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZVxuICAgKi9cbiAgcmVhZG9ubHkgcnVsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHJ1bGUgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIHJ1bGUgZGVzY3JpcHRpb24uXG4gICAqL1xuICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgY29uZmlndXJhdGlvbiBmb3IgdGhlIExhbWJkYSB0YXJnZXQgKERMUSwgaW5wdXQsIHJldHJpZXMsIG1heCBldmVudCBhZ2UsIGV0YykuXG4gICAqIFBhc3NlZCB0aHJvdWdoIHRvIGBhd3MtZXZlbnRzLXRhcmdldHMuTGFtYmRhRnVuY3Rpb25gLlxuICAgKi9cbiAgcmVhZG9ubHkgdGFyZ2V0UHJvcHM/OiB0YXJnZXRzLkxhbWJkYUZ1bmN0aW9uUHJvcHM7XG59XG5cbi8qKlxuICogT3BpbmlvbmF0ZWQgd2lyaW5nIGZvciBhbiBFdmVudEJyaWRnZSBydWxlIHdpdGggYSBMYW1iZGEgdGFyZ2V0LlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGludGVudGlvbmFsbHkgZW5mb3JjZXMgYGV2ZW50UGF0dGVybmAgWE9SIGBzY2hlZHVsZWAgKGZhaWwgY2xvc2VkKS5cbiAqIEZvciBzY2hlZHVsZS1vbmx5IGJhY2stY29tcGF0LCBzZWUgYEFwcFRoZW9yeUV2ZW50QnJpZGdlSGFuZGxlcmAuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlFdmVudEJyaWRnZVJ1bGVUYXJnZXQgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgcnVsZTogZXZlbnRzLlJ1bGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUV2ZW50QnJpZGdlUnVsZVRhcmdldFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IGhhc0V2ZW50UGF0dGVybiA9IHByb3BzLmV2ZW50UGF0dGVybiAhPT0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGhhc1NjaGVkdWxlID0gcHJvcHMuc2NoZWR1bGUgIT09IHVuZGVmaW5lZDtcblxuICAgIGlmIChoYXNFdmVudFBhdHRlcm4gPT09IGhhc1NjaGVkdWxlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlFdmVudEJyaWRnZVJ1bGVUYXJnZXQgcmVxdWlyZXMgZXhhY3RseSBvbmUgb2YgZXZlbnRQYXR0ZXJuIG9yIHNjaGVkdWxlXCIpO1xuICAgIH1cblxuICAgIHRoaXMucnVsZSA9IG5ldyBldmVudHMuUnVsZSh0aGlzLCBcIlJ1bGVcIiwge1xuICAgICAgcnVsZU5hbWU6IHByb3BzLnJ1bGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgZW5hYmxlZDogcHJvcHMuZW5hYmxlZCxcbiAgICAgIGV2ZW50QnVzOiBwcm9wcy5ldmVudEJ1cyxcbiAgICAgIGV2ZW50UGF0dGVybjogcHJvcHMuZXZlbnRQYXR0ZXJuLFxuICAgICAgc2NoZWR1bGU6IHByb3BzLnNjaGVkdWxlLFxuICAgIH0pO1xuXG4gICAgdGhpcy5ydWxlLmFkZFRhcmdldChuZXcgdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbihwcm9wcy5oYW5kbGVyLCBwcm9wcy50YXJnZXRQcm9wcykpO1xuICB9XG59XG5cbiJdfQ==