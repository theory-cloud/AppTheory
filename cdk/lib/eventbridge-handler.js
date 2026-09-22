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
exports.AppTheoryEventBridgeHandler = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const events = __importStar(require("aws-cdk-lib/aws-events"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const constructs_1 = require("constructs");
class AppTheoryEventBridgeHandler extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEventBridgeHandler", version: "4.2.4" };
    rule;
    constructor(scope, id, props) {
        super(scope, id);
        this.rule = new events.Rule(this, "Rule", {
            ruleName: props.ruleName,
            description: props.description,
            schedule: props.schedule,
            enabled: props.enabled,
        });
        this.rule.addTarget(new targets.LambdaFunction(props.handler, props.targetProps));
    }
}
exports.AppTheoryEventBridgeHandler = AppTheoryEventBridgeHandler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRicmlkZ2UtaGFuZGxlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImV2ZW50YnJpZGdlLWhhbmRsZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLCtEQUFpRDtBQUNqRCx3RUFBMEQ7QUFFMUQsMkNBQXVDO0FBZXZDLE1BQWEsMkJBQTRCLFNBQVEsc0JBQVM7O0lBQ3hDLElBQUksQ0FBYztJQUVsQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXVDO1FBQy9FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLE1BQU0sRUFBRTtZQUN4QyxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7WUFDeEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUTtZQUN4QixPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU87U0FDdkIsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxPQUFPLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7SUFDcEYsQ0FBQzs7QUFkSCxrRUFlQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGV2ZW50cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWV2ZW50c1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWV2ZW50cy10YXJnZXRzXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlFdmVudEJyaWRnZUhhbmRsZXJQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IHNjaGVkdWxlOiBldmVudHMuU2NoZWR1bGU7XG4gIHJlYWRvbmx5IHJ1bGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBlbmFibGVkPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBPcHRpb25hbCBjb25maWd1cmF0aW9uIGZvciB0aGUgTGFtYmRhIHRhcmdldCAoRExRLCBpbnB1dCwgcmV0cmllcywgbWF4IGV2ZW50IGFnZSwgZXRjKS5cbiAgICogUGFzc2VkIHRocm91Z2ggdG8gYGF3cy1ldmVudHMtdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbmAuXG4gICAqL1xuICByZWFkb25seSB0YXJnZXRQcm9wcz86IHRhcmdldHMuTGFtYmRhRnVuY3Rpb25Qcm9wcztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUV2ZW50QnJpZGdlSGFuZGxlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBydWxlOiBldmVudHMuUnVsZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5RXZlbnRCcmlkZ2VIYW5kbGVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5ydWxlID0gbmV3IGV2ZW50cy5SdWxlKHRoaXMsIFwiUnVsZVwiLCB7XG4gICAgICBydWxlTmFtZTogcHJvcHMucnVsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgICBzY2hlZHVsZTogcHJvcHMuc2NoZWR1bGUsXG4gICAgICBlbmFibGVkOiBwcm9wcy5lbmFibGVkLFxuICAgIH0pO1xuXG4gICAgdGhpcy5ydWxlLmFkZFRhcmdldChuZXcgdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbihwcm9wcy5oYW5kbGVyLCBwcm9wcy50YXJnZXRQcm9wcykpO1xuICB9XG59XG4iXX0=