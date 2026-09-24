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
exports.AppTheoryCodeBuildJobRunner = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const codebuild = __importStar(require("aws-cdk-lib/aws-codebuild"));
const events = __importStar(require("aws-cdk-lib/aws-events"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const constructs_1 = require("constructs");
/**
 * Opinionated CodeBuild wrapper for running import/batch jobs outside Lambda.
 *
 * This construct creates a CodeBuild project with:
 * - safe defaults for image/compute/timeout
 * - deterministic log group retention (auto-managed by default)
 * - an optional EventBridge state-change rule hook
 * - ergonomic grant helpers for common AWS resources
 */
class AppTheoryCodeBuildJobRunner extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryCodeBuildJobRunner", version: "4.4.0-rc" };
    project;
    role;
    logGroup;
    stateChangeRule;
    constructor(scope, id, props) {
        super(scope, id);
        this.role = new iam.Role(this, "Role", {
            assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
        });
        this.logGroup =
            props.logGroup ??
                new logs.LogGroup(this, "LogGroup", {
                    retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
                });
        this.logGroup.grantWrite(this.role);
        this.project = new codebuild.Project(this, "Project", {
            role: this.role,
            projectName: props.projectName,
            description: props.description,
            ...(props.source ? { source: props.source } : {}),
            buildSpec: props.buildSpec,
            timeout: props.timeout ?? aws_cdk_lib_1.Duration.minutes(60),
            environment: {
                buildImage: props.buildImage ?? codebuild.LinuxBuildImage.STANDARD_7_0,
                computeType: props.computeType ?? codebuild.ComputeType.SMALL,
                environmentVariables: props.environmentVariables,
            },
            encryptionKey: props.encryptionKey,
            logging: {
                cloudWatch: {
                    logGroup: this.logGroup,
                },
            },
        });
        for (const statement of props.additionalStatements ?? []) {
            this.role.addToPolicy(statement);
        }
        if (props.enableStateChangeRule) {
            this.stateChangeRule = new events.Rule(this, "StateChangeRule", {
                ruleName: props.stateChangeRuleName,
                description: props.stateChangeRuleDescription,
                enabled: props.stateChangeRuleEnabled ?? true,
                eventBus: props.stateChangeEventBus,
                eventPattern: {
                    source: ["aws.codebuild"],
                    detailType: ["CodeBuild Build State Change"],
                    detail: {
                        "project-name": [this.project.projectName],
                    },
                },
            });
        }
    }
    /**
     * Grant S3 read permissions to the project.
     */
    grantS3Read(bucket) {
        bucket.grantRead(this.project);
    }
    /**
     * Grant S3 write permissions to the project.
     */
    grantS3Write(bucket) {
        bucket.grantWrite(this.project);
    }
    /**
     * Grant DynamoDB read permissions to the project.
     */
    grantDynamoRead(table) {
        table.grantReadData(this.project);
    }
    /**
     * Grant DynamoDB write permissions to the project.
     */
    grantDynamoWrite(table) {
        table.grantWriteData(this.project);
    }
    /**
     * Grant Secrets Manager read permissions to the project.
     */
    grantSecretRead(secret) {
        secret.grantRead(this.project);
    }
    /**
     * Attach a policy statement to the CodeBuild role.
     */
    addToRolePolicy(statement) {
        this.role.addToPolicy(statement);
    }
}
exports.AppTheoryCodeBuildJobRunner = AppTheoryCodeBuildJobRunner;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29kZWJ1aWxkLWpvYi1ydW5uZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjb2RlYnVpbGQtam9iLXJ1bm5lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLHFFQUF1RDtBQUV2RCwrREFBaUQ7QUFDakQseURBQTJDO0FBRTNDLDJEQUE2QztBQUc3QywyQ0FBdUM7QUFtR3ZDOzs7Ozs7OztHQVFHO0FBQ0gsTUFBYSwyQkFBNEIsU0FBUSxzQkFBUzs7SUFDeEMsT0FBTyxDQUFvQjtJQUMzQixJQUFJLENBQVc7SUFDZixRQUFRLENBQWlCO0lBQ3pCLGVBQWUsQ0FBZTtJQUU5QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXVDO1FBQy9FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLE1BQU0sRUFBRTtZQUNyQyxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMseUJBQXlCLENBQUM7U0FDL0QsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLFFBQVE7WUFDWCxLQUFLLENBQUMsUUFBUTtnQkFDZCxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtvQkFDbEMsU0FBUyxFQUFFLEtBQUssQ0FBQyxZQUFZLElBQUksSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTO2lCQUM5RCxDQUFDLENBQUM7UUFDTCxJQUFJLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFFcEMsSUFBSSxDQUFDLE9BQU8sR0FBRyxJQUFJLFNBQVMsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtZQUNwRCxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUk7WUFDZixXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7WUFDOUIsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLEdBQUcsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUNqRCxTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVM7WUFDMUIsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPLElBQUksc0JBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQzlDLFdBQVcsRUFBRTtnQkFDWCxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsSUFBSSxTQUFTLENBQUMsZUFBZSxDQUFDLFlBQVk7Z0JBQ3RFLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVyxJQUFJLFNBQVMsQ0FBQyxXQUFXLENBQUMsS0FBSztnQkFDN0Qsb0JBQW9CLEVBQUUsS0FBSyxDQUFDLG9CQUFvQjthQUNqRDtZQUNELGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYTtZQUNsQyxPQUFPLEVBQUU7Z0JBQ1AsVUFBVSxFQUFFO29CQUNWLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUTtpQkFDeEI7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILEtBQUssTUFBTSxTQUFTLElBQUksS0FBSyxDQUFDLG9CQUFvQixJQUFJLEVBQUUsRUFBRSxDQUFDO1lBQ3pELElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQ25DLENBQUM7UUFFRCxJQUFJLEtBQUssQ0FBQyxxQkFBcUIsRUFBRSxDQUFDO1lBQ2hDLElBQUksQ0FBQyxlQUFlLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtnQkFDOUQsUUFBUSxFQUFFLEtBQUssQ0FBQyxtQkFBbUI7Z0JBQ25DLFdBQVcsRUFBRSxLQUFLLENBQUMsMEJBQTBCO2dCQUM3QyxPQUFPLEVBQUUsS0FBSyxDQUFDLHNCQUFzQixJQUFJLElBQUk7Z0JBQzdDLFFBQVEsRUFBRSxLQUFLLENBQUMsbUJBQW1CO2dCQUNuQyxZQUFZLEVBQUU7b0JBQ1osTUFBTSxFQUFFLENBQUMsZUFBZSxDQUFDO29CQUN6QixVQUFVLEVBQUUsQ0FBQyw4QkFBOEIsQ0FBQztvQkFDNUMsTUFBTSxFQUFFO3dCQUNOLGNBQWMsRUFBRSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDO3FCQUMzQztpQkFDRjthQUNGLENBQUMsQ0FBQztRQUNMLENBQUM7SUFDSCxDQUFDO0lBRUQ7O09BRUc7SUFDSSxXQUFXLENBQUMsTUFBa0I7UUFDbkMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDakMsQ0FBQztJQUVEOztPQUVHO0lBQ0ksWUFBWSxDQUFDLE1BQWtCO1FBQ3BDLE1BQU0sQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2xDLENBQUM7SUFFRDs7T0FFRztJQUNJLGVBQWUsQ0FBQyxLQUFzQjtRQUMzQyxLQUFLLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNwQyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxnQkFBZ0IsQ0FBQyxLQUFzQjtRQUM1QyxLQUFLLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNyQyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxlQUFlLENBQUMsTUFBOEI7UUFDbkQsTUFBTSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDakMsQ0FBQztJQUVEOztPQUVHO0lBQ0ksZUFBZSxDQUFDLFNBQThCO1FBQ25ELElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ25DLENBQUM7O0FBckdILGtFQXNHQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBjb2RlYnVpbGQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jb2RlYnVpbGRcIjtcbmltcG9ydCB0eXBlICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZXZlbnRzXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHR5cGUgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgdHlwZSAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXJcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5Q29kZUJ1aWxkSm9iUnVubmVyUHJvcHMge1xuICAvKipcbiAgICogT3B0aW9uYWwgcHJvamVjdCBuYW1lLlxuICAgKiBAZGVmYXVsdCAtIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZCBuYW1lXG4gICAqL1xuICByZWFkb25seSBwcm9qZWN0TmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgZGVzY3JpcHRpb24uXG4gICAqL1xuICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcblxuICAvKipcbiAgICogQnVpbGQgc3BlY2lmaWNhdGlvbi5cbiAgICovXG4gIHJlYWRvbmx5IGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYztcblxuICAvKipcbiAgICogQ29kZUJ1aWxkIHNvdXJjZSBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCAtIE5vU291cmNlXG4gICAqL1xuICByZWFkb25seSBzb3VyY2U/OiBjb2RlYnVpbGQuSVNvdXJjZTtcblxuICAvKipcbiAgICogQnVpbGQgaW1hZ2UuXG4gICAqIEBkZWZhdWx0IGNvZGVidWlsZC5MaW51eEJ1aWxkSW1hZ2UuU1RBTkRBUkRfN18wXG4gICAqL1xuICByZWFkb25seSBidWlsZEltYWdlPzogY29kZWJ1aWxkLklCdWlsZEltYWdlO1xuXG4gIC8qKlxuICAgKiBDb21wdXRlIHR5cGUuXG4gICAqIEBkZWZhdWx0IGNvZGVidWlsZC5Db21wdXRlVHlwZS5TTUFMTFxuICAgKi9cbiAgcmVhZG9ubHkgY29tcHV0ZVR5cGU/OiBjb2RlYnVpbGQuQ29tcHV0ZVR5cGU7XG5cbiAgLyoqXG4gICAqIFRpbWVvdXQgZm9yIGEgc2luZ2xlIGJ1aWxkLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5taW51dGVzKDYwKVxuICAgKi9cbiAgcmVhZG9ubHkgdGltZW91dD86IER1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZXMuXG4gICAqL1xuICByZWFkb25seSBlbnZpcm9ubWVudFZhcmlhYmxlcz86IFJlY29yZDxzdHJpbmcsIGNvZGVidWlsZC5CdWlsZEVudmlyb25tZW50VmFyaWFibGU+O1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBLTVMga2V5IGZvciBlbmNyeXB0aW5nIGJ1aWxkIGFydGlmYWN0cy9sb2dzLlxuICAgKi9cbiAgcmVhZG9ubHkgZW5jcnlwdGlvbktleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIElBTSBwb2xpY3kgc3RhdGVtZW50cyB0byBhdHRhY2ggdG8gdGhlIENvZGVCdWlsZCByb2xlLlxuICAgKi9cbiAgcmVhZG9ubHkgYWRkaXRpb25hbFN0YXRlbWVudHM/OiBpYW0uUG9saWN5U3RhdGVtZW50W107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGxvZyBncm91cCB0byB1c2UgZm9yIENvZGVCdWlsZCBsb2dzLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIGZvciBhdXRvLW1hbmFnZWQgbG9nIGdyb3VwLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBsb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gY3JlYXRlIGFuIEV2ZW50QnJpZGdlIHJ1bGUgZm9yIGJ1aWxkIHN0YXRlIGNoYW5nZXMuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTdGF0ZUNoYW5nZVJ1bGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBydWxlIG5hbWUgZm9yIHRoZSBzdGF0ZSBjaGFuZ2UgcnVsZS5cbiAgICogQGRlZmF1bHQgLSBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhdGVDaGFuZ2VSdWxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgcnVsZSBkZXNjcmlwdGlvbiBmb3IgdGhlIHN0YXRlIGNoYW5nZSBydWxlLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhdGVDaGFuZ2VSdWxlRGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHN0YXRlIGNoYW5nZSBydWxlIHNob3VsZCBiZSBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzdGF0ZUNoYW5nZVJ1bGVFbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgRXZlbnRCdXMgZm9yIHRoZSBzdGF0ZSBjaGFuZ2UgcnVsZS5cbiAgICogQGRlZmF1bHQgLSBEZWZhdWx0IGV2ZW50IGJ1c1xuICAgKi9cbiAgcmVhZG9ubHkgc3RhdGVDaGFuZ2VFdmVudEJ1cz86IGV2ZW50cy5JRXZlbnRCdXM7XG59XG5cbi8qKlxuICogT3BpbmlvbmF0ZWQgQ29kZUJ1aWxkIHdyYXBwZXIgZm9yIHJ1bm5pbmcgaW1wb3J0L2JhdGNoIGpvYnMgb3V0c2lkZSBMYW1iZGEuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgY3JlYXRlcyBhIENvZGVCdWlsZCBwcm9qZWN0IHdpdGg6XG4gKiAtIHNhZmUgZGVmYXVsdHMgZm9yIGltYWdlL2NvbXB1dGUvdGltZW91dFxuICogLSBkZXRlcm1pbmlzdGljIGxvZyBncm91cCByZXRlbnRpb24gKGF1dG8tbWFuYWdlZCBieSBkZWZhdWx0KVxuICogLSBhbiBvcHRpb25hbCBFdmVudEJyaWRnZSBzdGF0ZS1jaGFuZ2UgcnVsZSBob29rXG4gKiAtIGVyZ29ub21pYyBncmFudCBoZWxwZXJzIGZvciBjb21tb24gQVdTIHJlc291cmNlc1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5Q29kZUJ1aWxkSm9iUnVubmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IHByb2plY3Q6IGNvZGVidWlsZC5Qcm9qZWN0O1xuICBwdWJsaWMgcmVhZG9ubHkgcm9sZTogaWFtLlJvbGU7XG4gIHB1YmxpYyByZWFkb25seSBsb2dHcm91cDogbG9ncy5JTG9nR3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBzdGF0ZUNoYW5nZVJ1bGU/OiBldmVudHMuUnVsZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5Q29kZUJ1aWxkSm9iUnVubmVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5yb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiUm9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImNvZGVidWlsZC5hbWF6b25hd3MuY29tXCIpLFxuICAgIH0pO1xuXG4gICAgdGhpcy5sb2dHcm91cCA9XG4gICAgICBwcm9wcy5sb2dHcm91cCA/P1xuICAgICAgbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJMb2dHcm91cFwiLCB7XG4gICAgICAgIHJldGVudGlvbjogcHJvcHMubG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICB9KTtcbiAgICB0aGlzLmxvZ0dyb3VwLmdyYW50V3JpdGUodGhpcy5yb2xlKTtcblxuICAgIHRoaXMucHJvamVjdCA9IG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCBcIlByb2plY3RcIiwge1xuICAgICAgcm9sZTogdGhpcy5yb2xlLFxuICAgICAgcHJvamVjdE5hbWU6IHByb3BzLnByb2plY3ROYW1lLFxuICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgLi4uKHByb3BzLnNvdXJjZSA/IHsgc291cmNlOiBwcm9wcy5zb3VyY2UgfSA6IHt9KSxcbiAgICAgIGJ1aWxkU3BlYzogcHJvcHMuYnVpbGRTcGVjLFxuICAgICAgdGltZW91dDogcHJvcHMudGltZW91dCA/PyBEdXJhdGlvbi5taW51dGVzKDYwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIGJ1aWxkSW1hZ2U6IHByb3BzLmJ1aWxkSW1hZ2UgPz8gY29kZWJ1aWxkLkxpbnV4QnVpbGRJbWFnZS5TVEFOREFSRF83XzAsXG4gICAgICAgIGNvbXB1dGVUeXBlOiBwcm9wcy5jb21wdXRlVHlwZSA/PyBjb2RlYnVpbGQuQ29tcHV0ZVR5cGUuU01BTEwsXG4gICAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiBwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICAgIH0sXG4gICAgICBlbmNyeXB0aW9uS2V5OiBwcm9wcy5lbmNyeXB0aW9uS2V5LFxuICAgICAgbG9nZ2luZzoge1xuICAgICAgICBjbG91ZFdhdGNoOiB7XG4gICAgICAgICAgbG9nR3JvdXA6IHRoaXMubG9nR3JvdXAsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2YgcHJvcHMuYWRkaXRpb25hbFN0YXRlbWVudHMgPz8gW10pIHtcbiAgICAgIHRoaXMucm9sZS5hZGRUb1BvbGljeShzdGF0ZW1lbnQpO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5lbmFibGVTdGF0ZUNoYW5nZVJ1bGUpIHtcbiAgICAgIHRoaXMuc3RhdGVDaGFuZ2VSdWxlID0gbmV3IGV2ZW50cy5SdWxlKHRoaXMsIFwiU3RhdGVDaGFuZ2VSdWxlXCIsIHtcbiAgICAgICAgcnVsZU5hbWU6IHByb3BzLnN0YXRlQ2hhbmdlUnVsZU5hbWUsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBwcm9wcy5zdGF0ZUNoYW5nZVJ1bGVEZXNjcmlwdGlvbixcbiAgICAgICAgZW5hYmxlZDogcHJvcHMuc3RhdGVDaGFuZ2VSdWxlRW5hYmxlZCA/PyB0cnVlLFxuICAgICAgICBldmVudEJ1czogcHJvcHMuc3RhdGVDaGFuZ2VFdmVudEJ1cyxcbiAgICAgICAgZXZlbnRQYXR0ZXJuOiB7XG4gICAgICAgICAgc291cmNlOiBbXCJhd3MuY29kZWJ1aWxkXCJdLFxuICAgICAgICAgIGRldGFpbFR5cGU6IFtcIkNvZGVCdWlsZCBCdWlsZCBTdGF0ZSBDaGFuZ2VcIl0sXG4gICAgICAgICAgZGV0YWlsOiB7XG4gICAgICAgICAgICBcInByb2plY3QtbmFtZVwiOiBbdGhpcy5wcm9qZWN0LnByb2plY3ROYW1lXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IFMzIHJlYWQgcGVybWlzc2lvbnMgdG8gdGhlIHByb2plY3QuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnRTM1JlYWQoYnVja2V0OiBzMy5JQnVja2V0KTogdm9pZCB7XG4gICAgYnVja2V0LmdyYW50UmVhZCh0aGlzLnByb2plY3QpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IFMzIHdyaXRlIHBlcm1pc3Npb25zIHRvIHRoZSBwcm9qZWN0LlxuICAgKi9cbiAgcHVibGljIGdyYW50UzNXcml0ZShidWNrZXQ6IHMzLklCdWNrZXQpOiB2b2lkIHtcbiAgICBidWNrZXQuZ3JhbnRXcml0ZSh0aGlzLnByb2plY3QpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IER5bmFtb0RCIHJlYWQgcGVybWlzc2lvbnMgdG8gdGhlIHByb2plY3QuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnREeW5hbW9SZWFkKHRhYmxlOiBkeW5hbW9kYi5JVGFibGUpOiB2b2lkIHtcbiAgICB0YWJsZS5ncmFudFJlYWREYXRhKHRoaXMucHJvamVjdCk7XG4gIH1cblxuICAvKipcbiAgICogR3JhbnQgRHluYW1vREIgd3JpdGUgcGVybWlzc2lvbnMgdG8gdGhlIHByb2plY3QuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnREeW5hbW9Xcml0ZSh0YWJsZTogZHluYW1vZGIuSVRhYmxlKTogdm9pZCB7XG4gICAgdGFibGUuZ3JhbnRXcml0ZURhdGEodGhpcy5wcm9qZWN0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHcmFudCBTZWNyZXRzIE1hbmFnZXIgcmVhZCBwZXJtaXNzaW9ucyB0byB0aGUgcHJvamVjdC5cbiAgICovXG4gIHB1YmxpYyBncmFudFNlY3JldFJlYWQoc2VjcmV0OiBzZWNyZXRzbWFuYWdlci5JU2VjcmV0KTogdm9pZCB7XG4gICAgc2VjcmV0LmdyYW50UmVhZCh0aGlzLnByb2plY3QpO1xuICB9XG5cbiAgLyoqXG4gICAqIEF0dGFjaCBhIHBvbGljeSBzdGF0ZW1lbnQgdG8gdGhlIENvZGVCdWlsZCByb2xlLlxuICAgKi9cbiAgcHVibGljIGFkZFRvUm9sZVBvbGljeShzdGF0ZW1lbnQ6IGlhbS5Qb2xpY3lTdGF0ZW1lbnQpOiB2b2lkIHtcbiAgICB0aGlzLnJvbGUuYWRkVG9Qb2xpY3koc3RhdGVtZW50KTtcbiAgfVxufVxuIl19