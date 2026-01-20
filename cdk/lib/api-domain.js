"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryApiDomain = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const route53 = require("aws-cdk-lib/aws-route53");
const constructs_1 = require("constructs");
class AppTheoryApiDomain extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const domainName = String(props.domainName ?? "").trim();
        if (!domainName) {
            throw new Error("AppTheoryApiDomain requires props.domainName");
        }
        this.domainString = domainName;
        const createCname = props.createCname ?? Boolean(props.hostedZone);
        const recordTtl = props.recordTtl ?? aws_cdk_lib_1.Duration.seconds(300);
        const domainProps = {
            domainName,
            certificate: props.certificate,
            mtls: props.mutualTlsAuthentication,
            securityPolicy: props.securityPolicy,
        };
        this.domainName = new apigwv2.DomainName(this, "CustomDomain", domainProps);
        const stage = props.stage ?? props.httpApi.defaultStage;
        if (!stage) {
            throw new Error("AppTheoryApiDomain requires props.stage when httpApi has no defaultStage");
        }
        this.apiMapping = new apigwv2.ApiMapping(this, "ApiMapping", {
            api: props.httpApi,
            domainName: this.domainName,
            stage,
            apiMappingKey: props.apiMappingKey,
        });
        if (createCname && props.hostedZone) {
            const recordName = toRoute53RecordName(domainName, props.hostedZone);
            this.cnameRecord = new route53.CnameRecord(this, "CNAMERecord", {
                zone: props.hostedZone,
                recordName,
                domainName: this.domainName.regionalDomainName,
                ttl: recordTtl,
            });
        }
        new aws_cdk_lib_1.CfnOutput(this, "CustomDomainName", {
            value: domainName,
            description: "API Custom Domain Name",
        });
        new aws_cdk_lib_1.CfnOutput(this, "RegionalDomainName", {
            value: this.domainName.regionalDomainName,
            description: "API Gateway Regional Domain Name",
        });
    }
}
exports.AppTheoryApiDomain = AppTheoryApiDomain;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryApiDomain[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryApiDomain", version: "0.2.0-rc.1" };
function toRoute53RecordName(domainName, zone) {
    const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
    const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
    if (!zoneName)
        return fqdn;
    if (fqdn === zoneName)
        return "";
    const suffix = `.${zoneName}`;
    if (fqdn.endsWith(suffix)) {
        return fqdn.slice(0, -suffix.length);
    }
    return fqdn;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLWRvbWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFwaS1kb21haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBa0Q7QUFDbEQsd0RBQXdEO0FBRXhELG1EQUFtRDtBQUNuRCwyQ0FBdUM7QUFldkMsTUFBYSxrQkFBbUIsU0FBUSxzQkFBUztJQU0vQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQThCO1FBQ3RFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxVQUFVLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDekQsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ2hCLE1BQU0sSUFBSSxLQUFLLENBQUMsOENBQThDLENBQUMsQ0FBQztRQUNsRSxDQUFDO1FBRUQsSUFBSSxDQUFDLFlBQVksR0FBRyxVQUFVLENBQUM7UUFFL0IsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ25FLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLElBQUksc0JBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFM0QsTUFBTSxXQUFXLEdBQTRCO1lBQzNDLFVBQVU7WUFDVixXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7WUFDOUIsSUFBSSxFQUFFLEtBQUssQ0FBQyx1QkFBdUI7WUFDbkMsY0FBYyxFQUFFLEtBQUssQ0FBQyxjQUFjO1NBQ3JDLENBQUM7UUFFRixJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBRTVFLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUM7UUFDeEQsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ1gsTUFBTSxJQUFJLEtBQUssQ0FBQywwRUFBMEUsQ0FBQyxDQUFDO1FBQzlGLENBQUM7UUFFRCxJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQzNELEdBQUcsRUFBRSxLQUFLLENBQUMsT0FBTztZQUNsQixVQUFVLEVBQUUsSUFBSSxDQUFDLFVBQVU7WUFDM0IsS0FBSztZQUNMLGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYTtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLFdBQVcsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDcEMsTUFBTSxVQUFVLEdBQUcsbUJBQW1CLENBQUMsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztZQUNyRSxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksT0FBTyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO2dCQUM5RCxJQUFJLEVBQUUsS0FBSyxDQUFDLFVBQVU7Z0JBQ3RCLFVBQVU7Z0JBQ1YsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUMsa0JBQWtCO2dCQUM5QyxHQUFHLEVBQUUsU0FBUzthQUNmLENBQUMsQ0FBQztRQUNMLENBQUM7UUFFRCxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQ3RDLEtBQUssRUFBRSxVQUFVO1lBQ2pCLFdBQVcsRUFBRSx3QkFBd0I7U0FDdEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUN4QyxLQUFLLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxrQkFBa0I7WUFDekMsV0FBVyxFQUFFLGtDQUFrQztTQUNoRCxDQUFDLENBQUM7SUFDTCxDQUFDOztBQTNESCxnREE0REM7OztBQUVELFNBQVMsbUJBQW1CLENBQUMsVUFBa0IsRUFBRSxJQUF5QjtJQUN4RSxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDaEUsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNCLElBQUksSUFBSSxLQUFLLFFBQVE7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNqQyxNQUFNLE1BQU0sR0FBRyxJQUFJLFFBQVEsRUFBRSxDQUFDO0lBQzlCLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQzFCLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2QsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmbk91dHB1dCwgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCB0eXBlICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlBcGlEb21haW5Qcm9wcyB7XG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgYXBpTWFwcGluZ0tleT86IHN0cmluZztcbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGU7XG4gIHJlYWRvbmx5IGh0dHBBcGk6IGFwaWd3djIuSUh0dHBBcGk7XG4gIHJlYWRvbmx5IHN0YWdlPzogYXBpZ3d2Mi5JU3RhZ2U7XG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuICByZWFkb25seSBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbj86IGFwaWd3djIuTVRMU0NvbmZpZztcbiAgcmVhZG9ubHkgcmVjb3JkVHRsPzogRHVyYXRpb247XG4gIHJlYWRvbmx5IGNyZWF0ZUNuYW1lPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlnd3YyLlNlY3VyaXR5UG9saWN5O1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5QXBpRG9tYWluIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbk5hbWU6IGFwaWd3djIuRG9tYWluTmFtZTtcbiAgcHVibGljIHJlYWRvbmx5IGFwaU1hcHBpbmc6IGFwaWd3djIuQXBpTWFwcGluZztcbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpblN0cmluZzogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlBcGlEb21haW5Qcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICghZG9tYWluTmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5QXBpRG9tYWluIHJlcXVpcmVzIHByb3BzLmRvbWFpbk5hbWVcIik7XG4gICAgfVxuXG4gICAgdGhpcy5kb21haW5TdHJpbmcgPSBkb21haW5OYW1lO1xuXG4gICAgY29uc3QgY3JlYXRlQ25hbWUgPSBwcm9wcy5jcmVhdGVDbmFtZSA/PyBCb29sZWFuKHByb3BzLmhvc3RlZFpvbmUpO1xuICAgIGNvbnN0IHJlY29yZFR0bCA9IHByb3BzLnJlY29yZFR0bCA/PyBEdXJhdGlvbi5zZWNvbmRzKDMwMCk7XG5cbiAgICBjb25zdCBkb21haW5Qcm9wczogYXBpZ3d2Mi5Eb21haW5OYW1lUHJvcHMgPSB7XG4gICAgICBkb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGU6IHByb3BzLmNlcnRpZmljYXRlLFxuICAgICAgbXRsczogcHJvcHMubXV0dWFsVGxzQXV0aGVudGljYXRpb24sXG4gICAgICBzZWN1cml0eVBvbGljeTogcHJvcHMuc2VjdXJpdHlQb2xpY3ksXG4gICAgfTtcblxuICAgIHRoaXMuZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJDdXN0b21Eb21haW5cIiwgZG9tYWluUHJvcHMpO1xuXG4gICAgY29uc3Qgc3RhZ2UgPSBwcm9wcy5zdGFnZSA/PyBwcm9wcy5odHRwQXBpLmRlZmF1bHRTdGFnZTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlBcGlEb21haW4gcmVxdWlyZXMgcHJvcHMuc3RhZ2Ugd2hlbiBodHRwQXBpIGhhcyBubyBkZWZhdWx0U3RhZ2VcIik7XG4gICAgfVxuXG4gICAgdGhpcy5hcGlNYXBwaW5nID0gbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgYXBpOiBwcm9wcy5odHRwQXBpLFxuICAgICAgZG9tYWluTmFtZTogdGhpcy5kb21haW5OYW1lLFxuICAgICAgc3RhZ2UsXG4gICAgICBhcGlNYXBwaW5nS2V5OiBwcm9wcy5hcGlNYXBwaW5nS2V5LFxuICAgIH0pO1xuXG4gICAgaWYgKGNyZWF0ZUNuYW1lICYmIHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWUsIHByb3BzLmhvc3RlZFpvbmUpO1xuICAgICAgdGhpcy5jbmFtZVJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ05BTUVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lLFxuICAgICAgICBkb21haW5OYW1lOiB0aGlzLmRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgICB0dGw6IHJlY29yZFR0bCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgXCJDdXN0b21Eb21haW5OYW1lXCIsIHtcbiAgICAgIHZhbHVlOiBkb21haW5OYW1lLFxuICAgICAgZGVzY3JpcHRpb246IFwiQVBJIEN1c3RvbSBEb21haW4gTmFtZVwiLFxuICAgIH0pO1xuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCBcIlJlZ2lvbmFsRG9tYWluTmFtZVwiLCB7XG4gICAgICB2YWx1ZTogdGhpcy5kb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkFQSSBHYXRld2F5IFJlZ2lvbmFsIERvbWFpbiBOYW1lXCIsXG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcoem9uZS56b25lTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3Qgc3VmZml4ID0gYC4ke3pvbmVOYW1lfWA7XG4gIGlmIChmcWRuLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICByZXR1cm4gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCk7XG4gIH1cbiAgcmV0dXJuIGZxZG47XG59XG4iXX0=