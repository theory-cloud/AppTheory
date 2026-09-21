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
exports.AppTheoryFunctionAlarms = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const constructs_1 = require("constructs");
class AppTheoryFunctionAlarms extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryFunctionAlarms", version: "4.2.3" };
    errors;
    throttles;
    constructor(scope, id, props) {
        super(scope, id);
        const period = props.period ?? aws_cdk_lib_1.Duration.minutes(5);
        const errorThreshold = props.errorThreshold ?? 1;
        const throttleThreshold = props.throttleThreshold ?? 1;
        this.errors = new cloudwatch.Alarm(this, "Errors", {
            metric: props.fn.metricErrors({ period }),
            threshold: errorThreshold,
            evaluationPeriods: 1,
        });
        this.throttles = new cloudwatch.Alarm(this, "Throttles", {
            metric: props.fn.metricThrottles({ period }),
            threshold: throttleThreshold,
            evaluationPeriods: 1,
        });
    }
}
exports.AppTheoryFunctionAlarms = AppTheoryFunctionAlarms;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnVuY3Rpb24tYWxhcm1zLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZnVuY3Rpb24tYWxhcm1zLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBdUM7QUFDdkMsdUVBQXlEO0FBRXpELDJDQUF1QztBQVN2QyxNQUFhLHVCQUF3QixTQUFRLHNCQUFTOztJQUNwQyxNQUFNLENBQW1CO0lBQ3pCLFNBQVMsQ0FBbUI7SUFFNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFtQztRQUMzRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sTUFBTSxHQUFHLEtBQUssQ0FBQyxNQUFNLElBQUksc0JBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkQsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxDQUFDLENBQUM7UUFDakQsTUFBTSxpQkFBaUIsR0FBRyxLQUFLLENBQUMsaUJBQWlCLElBQUksQ0FBQyxDQUFDO1FBRXZELElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxVQUFVLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDakQsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUFFLENBQUMsWUFBWSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUM7WUFDekMsU0FBUyxFQUFFLGNBQWM7WUFDekIsaUJBQWlCLEVBQUUsQ0FBQztTQUNyQixDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksVUFBVSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFO1lBQ3ZELE1BQU0sRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLGVBQWUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDO1lBQzVDLFNBQVMsRUFBRSxpQkFBaUI7WUFDNUIsaUJBQWlCLEVBQUUsQ0FBQztTQUNyQixDQUFDLENBQUM7SUFDTCxDQUFDOztBQXRCSCwwREF1QkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgY2xvdWR3YXRjaCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2hcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUZ1bmN0aW9uQWxhcm1zUHJvcHMge1xuICByZWFkb25seSBmbjogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgcGVyaW9kPzogRHVyYXRpb247XG4gIHJlYWRvbmx5IGVycm9yVGhyZXNob2xkPzogbnVtYmVyO1xuICByZWFkb25seSB0aHJvdHRsZVRocmVzaG9sZD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUZ1bmN0aW9uQWxhcm1zIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGVycm9yczogY2xvdWR3YXRjaC5BbGFybTtcbiAgcHVibGljIHJlYWRvbmx5IHRocm90dGxlczogY2xvdWR3YXRjaC5BbGFybTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5RnVuY3Rpb25BbGFybXNQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBwZXJpb2QgPSBwcm9wcy5wZXJpb2QgPz8gRHVyYXRpb24ubWludXRlcyg1KTtcbiAgICBjb25zdCBlcnJvclRocmVzaG9sZCA9IHByb3BzLmVycm9yVGhyZXNob2xkID8/IDE7XG4gICAgY29uc3QgdGhyb3R0bGVUaHJlc2hvbGQgPSBwcm9wcy50aHJvdHRsZVRocmVzaG9sZCA/PyAxO1xuXG4gICAgdGhpcy5lcnJvcnMgPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCBcIkVycm9yc1wiLCB7XG4gICAgICBtZXRyaWM6IHByb3BzLmZuLm1ldHJpY0Vycm9ycyh7IHBlcmlvZCB9KSxcbiAgICAgIHRocmVzaG9sZDogZXJyb3JUaHJlc2hvbGQsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMSxcbiAgICB9KTtcblxuICAgIHRoaXMudGhyb3R0bGVzID0gbmV3IGNsb3Vkd2F0Y2guQWxhcm0odGhpcywgXCJUaHJvdHRsZXNcIiwge1xuICAgICAgbWV0cmljOiBwcm9wcy5mbi5tZXRyaWNUaHJvdHRsZXMoeyBwZXJpb2QgfSksXG4gICAgICB0aHJlc2hvbGQ6IHRocm90dGxlVGhyZXNob2xkLFxuICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDEsXG4gICAgfSk7XG4gIH1cbn1cblxuIl19