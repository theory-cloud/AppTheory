"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryCodeBuildJobRunner = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const codebuild = require("aws-cdk-lib/aws-codebuild");
const events = require("aws-cdk-lib/aws-events");
const iam = require("aws-cdk-lib/aws-iam");
const logs = require("aws-cdk-lib/aws-logs");
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
_a = JSII_RTTI_SYMBOL_1;
AppTheoryCodeBuildJobRunner[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryCodeBuildJobRunner", version: "0.19.0-rc.1" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29kZWJ1aWxkLWpvYi1ydW5uZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjb2RlYnVpbGQtam9iLXJ1bm5lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUF1QztBQUN2Qyx1REFBdUQ7QUFFdkQsaURBQWlEO0FBQ2pELDJDQUEyQztBQUUzQyw2Q0FBNkM7QUFHN0MsMkNBQXVDO0FBbUd2Qzs7Ozs7Ozs7R0FRRztBQUNILE1BQWEsMkJBQTRCLFNBQVEsc0JBQVM7SUFNeEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF1QztRQUMvRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUU7WUFDckMsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHlCQUF5QixDQUFDO1NBQy9ELENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxRQUFRO1lBQ1gsS0FBSyxDQUFDLFFBQVE7Z0JBQ2QsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7b0JBQ2xDLFNBQVMsRUFBRSxLQUFLLENBQUMsWUFBWSxJQUFJLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUztpQkFDOUQsQ0FBQyxDQUFDO1FBQ0wsSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRXBDLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxTQUFTLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDcEQsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJO1lBQ2YsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVztZQUM5QixHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDakQsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQzFCLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxJQUFJLHNCQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUM5QyxXQUFXLEVBQUU7Z0JBQ1gsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVLElBQUksU0FBUyxDQUFDLGVBQWUsQ0FBQyxZQUFZO2dCQUN0RSxXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVcsSUFBSSxTQUFTLENBQUMsV0FBVyxDQUFDLEtBQUs7Z0JBQzdELG9CQUFvQixFQUFFLEtBQUssQ0FBQyxvQkFBb0I7YUFDakQ7WUFDRCxhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWE7WUFDbEMsT0FBTyxFQUFFO2dCQUNQLFVBQVUsRUFBRTtvQkFDVixRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVE7aUJBQ3hCO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFFSCxLQUFLLE1BQU0sU0FBUyxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsSUFBSSxFQUFFLEVBQUUsQ0FBQztZQUN6RCxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUNuQyxDQUFDO1FBRUQsSUFBSSxLQUFLLENBQUMscUJBQXFCLEVBQUUsQ0FBQztZQUNoQyxJQUFJLENBQUMsZUFBZSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7Z0JBQzlELFFBQVEsRUFBRSxLQUFLLENBQUMsbUJBQW1CO2dCQUNuQyxXQUFXLEVBQUUsS0FBSyxDQUFDLDBCQUEwQjtnQkFDN0MsT0FBTyxFQUFFLEtBQUssQ0FBQyxzQkFBc0IsSUFBSSxJQUFJO2dCQUM3QyxRQUFRLEVBQUUsS0FBSyxDQUFDLG1CQUFtQjtnQkFDbkMsWUFBWSxFQUFFO29CQUNaLE1BQU0sRUFBRSxDQUFDLGVBQWUsQ0FBQztvQkFDekIsVUFBVSxFQUFFLENBQUMsOEJBQThCLENBQUM7b0JBQzVDLE1BQU0sRUFBRTt3QkFDTixjQUFjLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQztxQkFDM0M7aUJBQ0Y7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDO0lBQ0gsQ0FBQztJQUVEOztPQUVHO0lBQ0ksV0FBVyxDQUFDLE1BQWtCO1FBQ25DLE1BQU0sQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFFRDs7T0FFRztJQUNJLFlBQVksQ0FBQyxNQUFrQjtRQUNwQyxNQUFNLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNsQyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxlQUFlLENBQUMsS0FBc0I7UUFDM0MsS0FBSyxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDcEMsQ0FBQztJQUVEOztPQUVHO0lBQ0ksZ0JBQWdCLENBQUMsS0FBc0I7UUFDNUMsS0FBSyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDckMsQ0FBQztJQUVEOztPQUVHO0lBQ0ksZUFBZSxDQUFDLE1BQThCO1FBQ25ELE1BQU0sQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFFRDs7T0FFRztJQUNJLGVBQWUsQ0FBQyxTQUE4QjtRQUNuRCxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUNuQyxDQUFDOztBQXJHSCxrRUFzR0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgY29kZWJ1aWxkIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY29kZWJ1aWxkXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGV2ZW50cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWV2ZW50c1wiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB0eXBlICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHR5cGUgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUNvZGVCdWlsZEpvYlJ1bm5lclByb3BzIHtcbiAgLyoqXG4gICAqIE9wdGlvbmFsIHByb2plY3QgbmFtZS5cbiAgICogQGRlZmF1bHQgLSBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZVxuICAgKi9cbiAgcmVhZG9ubHkgcHJvamVjdE5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGRlc2NyaXB0aW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEJ1aWxkIHNwZWNpZmljYXRpb24uXG4gICAqL1xuICByZWFkb25seSBidWlsZFNwZWM6IGNvZGVidWlsZC5CdWlsZFNwZWM7XG5cbiAgLyoqXG4gICAqIENvZGVCdWlsZCBzb3VyY2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgLSBOb1NvdXJjZVxuICAgKi9cbiAgcmVhZG9ubHkgc291cmNlPzogY29kZWJ1aWxkLklTb3VyY2U7XG5cbiAgLyoqXG4gICAqIEJ1aWxkIGltYWdlLlxuICAgKiBAZGVmYXVsdCBjb2RlYnVpbGQuTGludXhCdWlsZEltYWdlLlNUQU5EQVJEXzdfMFxuICAgKi9cbiAgcmVhZG9ubHkgYnVpbGRJbWFnZT86IGNvZGVidWlsZC5JQnVpbGRJbWFnZTtcblxuICAvKipcbiAgICogQ29tcHV0ZSB0eXBlLlxuICAgKiBAZGVmYXVsdCBjb2RlYnVpbGQuQ29tcHV0ZVR5cGUuU01BTExcbiAgICovXG4gIHJlYWRvbmx5IGNvbXB1dGVUeXBlPzogY29kZWJ1aWxkLkNvbXB1dGVUeXBlO1xuXG4gIC8qKlxuICAgKiBUaW1lb3V0IGZvciBhIHNpbmdsZSBidWlsZC5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24ubWludXRlcyg2MClcbiAgICovXG4gIHJlYWRvbmx5IHRpbWVvdXQ/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogRW52aXJvbm1lbnQgdmFyaWFibGVzLlxuICAgKi9cbiAgcmVhZG9ubHkgZW52aXJvbm1lbnRWYXJpYWJsZXM/OiBSZWNvcmQ8c3RyaW5nLCBjb2RlYnVpbGQuQnVpbGRFbnZpcm9ubWVudFZhcmlhYmxlPjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgS01TIGtleSBmb3IgZW5jcnlwdGluZyBidWlsZCBhcnRpZmFjdHMvbG9ncy5cbiAgICovXG4gIHJlYWRvbmx5IGVuY3J5cHRpb25LZXk/OiBrbXMuSUtleTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBJQU0gcG9saWN5IHN0YXRlbWVudHMgdG8gYXR0YWNoIHRvIHRoZSBDb2RlQnVpbGQgcm9sZS5cbiAgICovXG4gIHJlYWRvbmx5IGFkZGl0aW9uYWxTdGF0ZW1lbnRzPzogaWFtLlBvbGljeVN0YXRlbWVudFtdO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBsb2cgZ3JvdXAgdG8gdXNlIGZvciBDb2RlQnVpbGQgbG9ncy5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBmb3IgYXV0by1tYW5hZ2VkIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgbG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhbiBFdmVudEJyaWRnZSBydWxlIGZvciBidWlsZCBzdGF0ZSBjaGFuZ2VzLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU3RhdGVDaGFuZ2VSdWxlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgcnVsZSBuYW1lIGZvciB0aGUgc3RhdGUgY2hhbmdlIHJ1bGUuXG4gICAqIEBkZWZhdWx0IC0gQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkIG5hbWVcbiAgICovXG4gIHJlYWRvbmx5IHN0YXRlQ2hhbmdlUnVsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIHJ1bGUgZGVzY3JpcHRpb24gZm9yIHRoZSBzdGF0ZSBjaGFuZ2UgcnVsZS5cbiAgICovXG4gIHJlYWRvbmx5IHN0YXRlQ2hhbmdlUnVsZURlc2NyaXB0aW9uPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBzdGF0ZSBjaGFuZ2UgcnVsZSBzaG91bGQgYmUgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhdGVDaGFuZ2VSdWxlRW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEV2ZW50QnVzIGZvciB0aGUgc3RhdGUgY2hhbmdlIHJ1bGUuXG4gICAqIEBkZWZhdWx0IC0gRGVmYXVsdCBldmVudCBidXNcbiAgICovXG4gIHJlYWRvbmx5IHN0YXRlQ2hhbmdlRXZlbnRCdXM/OiBldmVudHMuSUV2ZW50QnVzO1xufVxuXG4vKipcbiAqIE9waW5pb25hdGVkIENvZGVCdWlsZCB3cmFwcGVyIGZvciBydW5uaW5nIGltcG9ydC9iYXRjaCBqb2JzIG91dHNpZGUgTGFtYmRhLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGNyZWF0ZXMgYSBDb2RlQnVpbGQgcHJvamVjdCB3aXRoOlxuICogLSBzYWZlIGRlZmF1bHRzIGZvciBpbWFnZS9jb21wdXRlL3RpbWVvdXRcbiAqIC0gZGV0ZXJtaW5pc3RpYyBsb2cgZ3JvdXAgcmV0ZW50aW9uIChhdXRvLW1hbmFnZWQgYnkgZGVmYXVsdClcbiAqIC0gYW4gb3B0aW9uYWwgRXZlbnRCcmlkZ2Ugc3RhdGUtY2hhbmdlIHJ1bGUgaG9va1xuICogLSBlcmdvbm9taWMgZ3JhbnQgaGVscGVycyBmb3IgY29tbW9uIEFXUyByZXNvdXJjZXNcbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUNvZGVCdWlsZEpvYlJ1bm5lciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBwcm9qZWN0OiBjb2RlYnVpbGQuUHJvamVjdDtcbiAgcHVibGljIHJlYWRvbmx5IHJvbGU6IGlhbS5Sb2xlO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nR3JvdXA6IGxvZ3MuSUxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhdGVDaGFuZ2VSdWxlPzogZXZlbnRzLlJ1bGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUNvZGVCdWlsZEpvYlJ1bm5lclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHRoaXMucm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBcIlJvbGVcIiwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJjb2RlYnVpbGQuYW1hem9uYXdzLmNvbVwiKSxcbiAgICB9KTtcblxuICAgIHRoaXMubG9nR3JvdXAgPVxuICAgICAgcHJvcHMubG9nR3JvdXAgPz9cbiAgICAgIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiTG9nR3JvdXBcIiwge1xuICAgICAgICByZXRlbnRpb246IHByb3BzLmxvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgfSk7XG4gICAgdGhpcy5sb2dHcm91cC5ncmFudFdyaXRlKHRoaXMucm9sZSk7XG5cbiAgICB0aGlzLnByb2plY3QgPSBuZXcgY29kZWJ1aWxkLlByb2plY3QodGhpcywgXCJQcm9qZWN0XCIsIHtcbiAgICAgIHJvbGU6IHRoaXMucm9sZSxcbiAgICAgIHByb2plY3ROYW1lOiBwcm9wcy5wcm9qZWN0TmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBwcm9wcy5kZXNjcmlwdGlvbixcbiAgICAgIC4uLihwcm9wcy5zb3VyY2UgPyB7IHNvdXJjZTogcHJvcHMuc291cmNlIH0gOiB7fSksXG4gICAgICBidWlsZFNwZWM6IHByb3BzLmJ1aWxkU3BlYyxcbiAgICAgIHRpbWVvdXQ6IHByb3BzLnRpbWVvdXQgPz8gRHVyYXRpb24ubWludXRlcyg2MCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBidWlsZEltYWdlOiBwcm9wcy5idWlsZEltYWdlID8/IGNvZGVidWlsZC5MaW51eEJ1aWxkSW1hZ2UuU1RBTkRBUkRfN18wLFxuICAgICAgICBjb21wdXRlVHlwZTogcHJvcHMuY29tcHV0ZVR5cGUgPz8gY29kZWJ1aWxkLkNvbXB1dGVUeXBlLlNNQUxMLFxuICAgICAgICBlbnZpcm9ubWVudFZhcmlhYmxlczogcHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXMsXG4gICAgICB9LFxuICAgICAgZW5jcnlwdGlvbktleTogcHJvcHMuZW5jcnlwdGlvbktleSxcbiAgICAgIGxvZ2dpbmc6IHtcbiAgICAgICAgY2xvdWRXYXRjaDoge1xuICAgICAgICAgIGxvZ0dyb3VwOiB0aGlzLmxvZ0dyb3VwLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHByb3BzLmFkZGl0aW9uYWxTdGF0ZW1lbnRzID8/IFtdKSB7XG4gICAgICB0aGlzLnJvbGUuYWRkVG9Qb2xpY3koc3RhdGVtZW50KTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuZW5hYmxlU3RhdGVDaGFuZ2VSdWxlKSB7XG4gICAgICB0aGlzLnN0YXRlQ2hhbmdlUnVsZSA9IG5ldyBldmVudHMuUnVsZSh0aGlzLCBcIlN0YXRlQ2hhbmdlUnVsZVwiLCB7XG4gICAgICAgIHJ1bGVOYW1lOiBwcm9wcy5zdGF0ZUNoYW5nZVJ1bGVOYW1lLFxuICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuc3RhdGVDaGFuZ2VSdWxlRGVzY3JpcHRpb24sXG4gICAgICAgIGVuYWJsZWQ6IHByb3BzLnN0YXRlQ2hhbmdlUnVsZUVuYWJsZWQgPz8gdHJ1ZSxcbiAgICAgICAgZXZlbnRCdXM6IHByb3BzLnN0YXRlQ2hhbmdlRXZlbnRCdXMsXG4gICAgICAgIGV2ZW50UGF0dGVybjoge1xuICAgICAgICAgIHNvdXJjZTogW1wiYXdzLmNvZGVidWlsZFwiXSxcbiAgICAgICAgICBkZXRhaWxUeXBlOiBbXCJDb2RlQnVpbGQgQnVpbGQgU3RhdGUgQ2hhbmdlXCJdLFxuICAgICAgICAgIGRldGFpbDoge1xuICAgICAgICAgICAgXCJwcm9qZWN0LW5hbWVcIjogW3RoaXMucHJvamVjdC5wcm9qZWN0TmFtZV0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBHcmFudCBTMyByZWFkIHBlcm1pc3Npb25zIHRvIHRoZSBwcm9qZWN0LlxuICAgKi9cbiAgcHVibGljIGdyYW50UzNSZWFkKGJ1Y2tldDogczMuSUJ1Y2tldCk6IHZvaWQge1xuICAgIGJ1Y2tldC5ncmFudFJlYWQodGhpcy5wcm9qZWN0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHcmFudCBTMyB3cml0ZSBwZXJtaXNzaW9ucyB0byB0aGUgcHJvamVjdC5cbiAgICovXG4gIHB1YmxpYyBncmFudFMzV3JpdGUoYnVja2V0OiBzMy5JQnVja2V0KTogdm9pZCB7XG4gICAgYnVja2V0LmdyYW50V3JpdGUodGhpcy5wcm9qZWN0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHcmFudCBEeW5hbW9EQiByZWFkIHBlcm1pc3Npb25zIHRvIHRoZSBwcm9qZWN0LlxuICAgKi9cbiAgcHVibGljIGdyYW50RHluYW1vUmVhZCh0YWJsZTogZHluYW1vZGIuSVRhYmxlKTogdm9pZCB7XG4gICAgdGFibGUuZ3JhbnRSZWFkRGF0YSh0aGlzLnByb2plY3QpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IER5bmFtb0RCIHdyaXRlIHBlcm1pc3Npb25zIHRvIHRoZSBwcm9qZWN0LlxuICAgKi9cbiAgcHVibGljIGdyYW50RHluYW1vV3JpdGUodGFibGU6IGR5bmFtb2RiLklUYWJsZSk6IHZvaWQge1xuICAgIHRhYmxlLmdyYW50V3JpdGVEYXRhKHRoaXMucHJvamVjdCk7XG4gIH1cblxuICAvKipcbiAgICogR3JhbnQgU2VjcmV0cyBNYW5hZ2VyIHJlYWQgcGVybWlzc2lvbnMgdG8gdGhlIHByb2plY3QuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnRTZWNyZXRSZWFkKHNlY3JldDogc2VjcmV0c21hbmFnZXIuSVNlY3JldCk6IHZvaWQge1xuICAgIHNlY3JldC5ncmFudFJlYWQodGhpcy5wcm9qZWN0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBdHRhY2ggYSBwb2xpY3kgc3RhdGVtZW50IHRvIHRoZSBDb2RlQnVpbGQgcm9sZS5cbiAgICovXG4gIHB1YmxpYyBhZGRUb1JvbGVQb2xpY3koc3RhdGVtZW50OiBpYW0uUG9saWN5U3RhdGVtZW50KTogdm9pZCB7XG4gICAgdGhpcy5yb2xlLmFkZFRvUG9saWN5KHN0YXRlbWVudCk7XG4gIH1cbn1cbiJdfQ==