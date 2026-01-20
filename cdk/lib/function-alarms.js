"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryFunctionAlarms = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudwatch = require("aws-cdk-lib/aws-cloudwatch");
const constructs_1 = require("constructs");
class AppTheoryFunctionAlarms extends constructs_1.Construct {
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
_a = JSII_RTTI_SYMBOL_1;
AppTheoryFunctionAlarms[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryFunctionAlarms", version: "0.2.0-rc.2" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnVuY3Rpb24tYWxhcm1zLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZnVuY3Rpb24tYWxhcm1zLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLHlEQUF5RDtBQUV6RCwyQ0FBdUM7QUFTdkMsTUFBYSx1QkFBd0IsU0FBUSxzQkFBUztJQUlwRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW1DO1FBQzNFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLE1BQU0sSUFBSSxzQkFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNuRCxNQUFNLGNBQWMsR0FBRyxLQUFLLENBQUMsY0FBYyxJQUFJLENBQUMsQ0FBQztRQUNqRCxNQUFNLGlCQUFpQixHQUFHLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxDQUFDLENBQUM7UUFFdkQsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLFVBQVUsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRTtZQUNqRCxNQUFNLEVBQUUsS0FBSyxDQUFDLEVBQUUsQ0FBQyxZQUFZLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQztZQUN6QyxTQUFTLEVBQUUsY0FBYztZQUN6QixpQkFBaUIsRUFBRSxDQUFDO1NBQ3JCLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxTQUFTLEdBQUcsSUFBSSxVQUFVLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUU7WUFDdkQsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUM7WUFDNUMsU0FBUyxFQUFFLGlCQUFpQjtZQUM1QixpQkFBaUIsRUFBRSxDQUFDO1NBQ3JCLENBQUMsQ0FBQztJQUNMLENBQUM7O0FBdEJILDBEQXVCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWR3YXRjaFwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RnVuY3Rpb25BbGFybXNQcm9wcyB7XG4gIHJlYWRvbmx5IGZuOiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBwZXJpb2Q/OiBEdXJhdGlvbjtcbiAgcmVhZG9ubHkgZXJyb3JUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIHJlYWRvbmx5IHRocm90dGxlVGhyZXNob2xkPzogbnVtYmVyO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5RnVuY3Rpb25BbGFybXMgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgZXJyb3JzOiBjbG91ZHdhdGNoLkFsYXJtO1xuICBwdWJsaWMgcmVhZG9ubHkgdGhyb3R0bGVzOiBjbG91ZHdhdGNoLkFsYXJtO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlGdW5jdGlvbkFsYXJtc1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHBlcmlvZCA9IHByb3BzLnBlcmlvZCA/PyBEdXJhdGlvbi5taW51dGVzKDUpO1xuICAgIGNvbnN0IGVycm9yVGhyZXNob2xkID0gcHJvcHMuZXJyb3JUaHJlc2hvbGQgPz8gMTtcbiAgICBjb25zdCB0aHJvdHRsZVRocmVzaG9sZCA9IHByb3BzLnRocm90dGxlVGhyZXNob2xkID8/IDE7XG5cbiAgICB0aGlzLmVycm9ycyA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsIFwiRXJyb3JzXCIsIHtcbiAgICAgIG1ldHJpYzogcHJvcHMuZm4ubWV0cmljRXJyb3JzKHsgcGVyaW9kIH0pLFxuICAgICAgdGhyZXNob2xkOiBlcnJvclRocmVzaG9sZCxcbiAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAxLFxuICAgIH0pO1xuXG4gICAgdGhpcy50aHJvdHRsZXMgPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCBcIlRocm90dGxlc1wiLCB7XG4gICAgICBtZXRyaWM6IHByb3BzLmZuLm1ldHJpY1Rocm90dGxlcyh7IHBlcmlvZCB9KSxcbiAgICAgIHRocmVzaG9sZDogdGhyb3R0bGVUaHJlc2hvbGQsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMSxcbiAgICB9KTtcbiAgfVxufVxuXG4iXX0=