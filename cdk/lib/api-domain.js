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
exports.AppTheoryApiDomain = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const constructs_1 = require("constructs");
const secure_defaults_1 = require("./private/secure-defaults");
class AppTheoryApiDomain extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryApiDomain", version: "7.4.0" };
    domainName;
    apiMapping;
    cnameRecord;
    domainString;
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
            securityPolicy: props.securityPolicy
                ?? ((0, secure_defaults_1.secureDefaults)(props.namingContext) ? secure_defaults_1.RECOMMENDED_HTTP_API_SECURITY_POLICY : undefined),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLWRvbWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFwaS1kb21haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUFrRDtBQUNsRCxzRUFBd0Q7QUFFeEQsaUVBQW1EO0FBQ25ELDJDQUF1QztBQUd2QywrREFBaUc7QUErQmpHLE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7O0lBQy9CLFVBQVUsQ0FBcUI7SUFDL0IsVUFBVSxDQUFxQjtJQUMvQixXQUFXLENBQXVCO0lBQ2xDLFlBQVksQ0FBUztJQUVyQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQThCO1FBQ3RFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxVQUFVLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDekQsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ2hCLE1BQU0sSUFBSSxLQUFLLENBQUMsOENBQThDLENBQUMsQ0FBQztRQUNsRSxDQUFDO1FBRUQsSUFBSSxDQUFDLFlBQVksR0FBRyxVQUFVLENBQUM7UUFFL0IsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ25FLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLElBQUksc0JBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFM0QsTUFBTSxXQUFXLEdBQTRCO1lBQzNDLFVBQVU7WUFDVixXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7WUFDOUIsSUFBSSxFQUFFLEtBQUssQ0FBQyx1QkFBdUI7WUFDbkMsY0FBYyxFQUFFLEtBQUssQ0FBQyxjQUFjO21CQUMvQixDQUFDLElBQUEsZ0NBQWMsRUFBQyxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLHNEQUFvQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7U0FDOUYsQ0FBQztRQUVGLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFFNUUsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQztRQUN4RCxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDWCxNQUFNLElBQUksS0FBSyxDQUFDLDBFQUEwRSxDQUFDLENBQUM7UUFDOUYsQ0FBQztRQUVELElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDM0QsR0FBRyxFQUFFLEtBQUssQ0FBQyxPQUFPO1lBQ2xCLFVBQVUsRUFBRSxJQUFJLENBQUMsVUFBVTtZQUMzQixLQUFLO1lBQ0wsYUFBYSxFQUFFLEtBQUssQ0FBQyxhQUFhO1NBQ25DLENBQUMsQ0FBQztRQUVILElBQUksV0FBVyxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUNwQyxNQUFNLFVBQVUsR0FBRyxtQkFBbUIsQ0FBQyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1lBQ3JFLElBQUksQ0FBQyxXQUFXLEdBQUcsSUFBSSxPQUFPLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQzlELElBQUksRUFBRSxLQUFLLENBQUMsVUFBVTtnQkFDdEIsVUFBVTtnQkFDVixVQUFVLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxrQkFBa0I7Z0JBQzlDLEdBQUcsRUFBRSxTQUFTO2FBQ2YsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUVELElBQUksdUJBQVMsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDdEMsS0FBSyxFQUFFLFVBQVU7WUFDakIsV0FBVyxFQUFFLHdCQUF3QjtTQUN0QyxDQUFDLENBQUM7UUFFSCxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQ3hDLEtBQUssRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDLGtCQUFrQjtZQUN6QyxXQUFXLEVBQUUsa0NBQWtDO1NBQ2hELENBQUMsQ0FBQztJQUNMLENBQUM7O0FBNURILGdEQTZEQztBQUVELFNBQVMsbUJBQW1CLENBQUMsVUFBa0IsRUFBRSxJQUF5QjtJQUN4RSxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDaEUsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNCLElBQUksSUFBSSxLQUFLLFFBQVE7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNqQyxNQUFNLE1BQU0sR0FBRyxJQUFJLFFBQVEsRUFBRSxDQUFDO0lBQzlCLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQzFCLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2QsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmbk91dHB1dCwgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCB0eXBlICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB7IFJFQ09NTUVOREVEX0hUVFBfQVBJX1NFQ1VSSVRZX1BPTElDWSwgc2VjdXJlRGVmYXVsdHMgfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUFwaURvbWFpblByb3BzIHtcbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuICByZWFkb25seSBhcGlNYXBwaW5nS2V5Pzogc3RyaW5nO1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZTtcbiAgcmVhZG9ubHkgaHR0cEFwaTogYXBpZ3d2Mi5JSHR0cEFwaTtcbiAgcmVhZG9ubHkgc3RhZ2U/OiBhcGlnd3YyLklTdGFnZTtcbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xuICByZWFkb25seSByZWNvcmRUdGw/OiBEdXJhdGlvbjtcbiAgcmVhZG9ubHkgY3JlYXRlQ25hbWU/OiBib29sZWFuO1xuICAvKipcbiAgICogVExTIHNlY3VyaXR5IHBvbGljeSBmb3IgdGhlIGN1c3RvbSBkb21haW4uXG4gICAqXG4gICAqIFdpdGggYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0IHRoZSBkZWZhdWx0IGlzIFRMUyAxLjIsIHRoZSBzdHJvbmdlc3QgcG9saWN5XG4gICAqIEFQSSBHYXRld2F5IHYyIG9mZmVycy4gU2VjdXJpdHkgSHViIEFQSUdhdGV3YXkuMTEgYWx3YXlzIGZhaWxzIGEgY3VzdG9tXG4gICAqIGRvbWFpbiBhdHRhY2hlZCB0byBhbiBIVFRQIEFQSSwgc28gbm8gcG9saWN5IGNhbiBzYXRpc2Z5IGl0LlxuICAgKlxuICAgKiBAZGVmYXVsdCBUTFMgMS4yIHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCwgb3RoZXJ3aXNlIHRoZSBBUEkgR2F0ZXdheSBkZWZhdWx0XG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eVBvbGljeT86IGFwaWd3djIuU2VjdXJpdHlQb2xpY3k7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBjb250ZXh0IHRoYXQgc2VsZWN0cyB0aGUgU2VjdXJpdHkgSHViLWFsaWduZWQgZGVmYXVsdHMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlBcGlEb21haW4gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZTogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZzogYXBpZ3d2Mi5BcGlNYXBwaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkO1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluU3RyaW5nOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUFwaURvbWFpblByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgaWYgKCFkb21haW5OYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlBcGlEb21haW4gcmVxdWlyZXMgcHJvcHMuZG9tYWluTmFtZVwiKTtcbiAgICB9XG5cbiAgICB0aGlzLmRvbWFpblN0cmluZyA9IGRvbWFpbk5hbWU7XG5cbiAgICBjb25zdCBjcmVhdGVDbmFtZSA9IHByb3BzLmNyZWF0ZUNuYW1lID8/IEJvb2xlYW4ocHJvcHMuaG9zdGVkWm9uZSk7XG4gICAgY29uc3QgcmVjb3JkVHRsID0gcHJvcHMucmVjb3JkVHRsID8/IER1cmF0aW9uLnNlY29uZHMoMzAwKTtcblxuICAgIGNvbnN0IGRvbWFpblByb3BzOiBhcGlnd3YyLkRvbWFpbk5hbWVQcm9wcyA9IHtcbiAgICAgIGRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZTogcHJvcHMuY2VydGlmaWNhdGUsXG4gICAgICBtdGxzOiBwcm9wcy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICAgIHNlY3VyaXR5UG9saWN5OiBwcm9wcy5zZWN1cml0eVBvbGljeVxuICAgICAgICA/PyAoc2VjdXJlRGVmYXVsdHMocHJvcHMubmFtaW5nQ29udGV4dCkgPyBSRUNPTU1FTkRFRF9IVFRQX0FQSV9TRUNVUklUWV9QT0xJQ1kgOiB1bmRlZmluZWQpLFxuICAgIH07XG5cbiAgICB0aGlzLmRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiQ3VzdG9tRG9tYWluXCIsIGRvbWFpblByb3BzKTtcblxuICAgIGNvbnN0IHN0YWdlID0gcHJvcHMuc3RhZ2UgPz8gcHJvcHMuaHR0cEFwaS5kZWZhdWx0U3RhZ2U7XG4gICAgaWYgKCFzdGFnZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5QXBpRG9tYWluIHJlcXVpcmVzIHByb3BzLnN0YWdlIHdoZW4gaHR0cEFwaSBoYXMgbm8gZGVmYXVsdFN0YWdlXCIpO1xuICAgIH1cblxuICAgIHRoaXMuYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogcHJvcHMuaHR0cEFwaSxcbiAgICAgIGRvbWFpbk5hbWU6IHRoaXMuZG9tYWluTmFtZSxcbiAgICAgIHN0YWdlLFxuICAgICAgYXBpTWFwcGluZ0tleTogcHJvcHMuYXBpTWFwcGluZ0tleSxcbiAgICB9KTtcblxuICAgIGlmIChjcmVhdGVDbmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICBjb25zdCByZWNvcmROYW1lID0gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lLCBwcm9wcy5ob3N0ZWRab25lKTtcbiAgICAgIHRoaXMuY25hbWVSZWNvcmQgPSBuZXcgcm91dGU1My5DbmFtZVJlY29yZCh0aGlzLCBcIkNOQU1FUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgZG9tYWluTmFtZTogdGhpcy5kb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgICAgdHRsOiByZWNvcmRUdGwsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsIFwiQ3VzdG9tRG9tYWluTmFtZVwiLCB7XG4gICAgICB2YWx1ZTogZG9tYWluTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkFQSSBDdXN0b20gRG9tYWluIE5hbWVcIixcbiAgICB9KTtcblxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgXCJSZWdpb25hbERvbWFpbk5hbWVcIiwge1xuICAgICAgdmFsdWU6IHRoaXMuZG9tYWluTmFtZS5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogXCJBUEkgR2F0ZXdheSBSZWdpb25hbCBEb21haW4gTmFtZVwiLFxuICAgIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICBpZiAoZnFkbi5lbmRzV2l0aChzdWZmaXgpKSB7XG4gICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICB9XG4gIHJldHVybiBmcWRuO1xufVxuIl19