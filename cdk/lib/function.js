"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryFunction = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const constructs_1 = require("constructs");
class AppTheoryFunction extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        this.fn = new lambda.Function(this, "Function", {
            architecture: props.architecture ?? lambda.Architecture.ARM_64,
            tracing: props.tracing ?? lambda.Tracing.ACTIVE,
            memorySize: props.memorySize ?? 256,
            timeout: props.timeout ?? aws_cdk_lib_1.Duration.seconds(10),
            ...props,
        });
    }
}
exports.AppTheoryFunction = AppTheoryFunction;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryFunction[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryFunction", version: "0.2.0-rc.1" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnVuY3Rpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJmdW5jdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUF1QztBQUN2QyxpREFBaUQ7QUFDakQsMkNBQXVDO0FBSXZDLE1BQWEsaUJBQWtCLFNBQVEsc0JBQVM7SUFHOUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE2QjtRQUNyRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxFQUFFLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDOUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxZQUFZLElBQUksTUFBTSxDQUFDLFlBQVksQ0FBQyxNQUFNO1lBQzlELE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTTtZQUMvQyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsSUFBSSxHQUFHO1lBQ25DLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxJQUFJLHNCQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUM5QyxHQUFHLEtBQUs7U0FDVCxDQUFDLENBQUM7SUFDTCxDQUFDOztBQWJILDhDQWNDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlGdW5jdGlvblByb3BzIGV4dGVuZHMgbGFtYmRhLkZ1bmN0aW9uUHJvcHMge31cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUZ1bmN0aW9uIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGZuOiBsYW1iZGEuRnVuY3Rpb247XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUZ1bmN0aW9uUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5mbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJGdW5jdGlvblwiLCB7XG4gICAgICBhcmNoaXRlY3R1cmU6IHByb3BzLmFyY2hpdGVjdHVyZSA/PyBsYW1iZGEuQXJjaGl0ZWN0dXJlLkFSTV82NCxcbiAgICAgIHRyYWNpbmc6IHByb3BzLnRyYWNpbmcgPz8gbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgICAgbWVtb3J5U2l6ZTogcHJvcHMubWVtb3J5U2l6ZSA/PyAyNTYsXG4gICAgICB0aW1lb3V0OiBwcm9wcy50aW1lb3V0ID8/IER1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgLi4ucHJvcHMsXG4gICAgfSk7XG4gIH1cbn1cblxuIl19