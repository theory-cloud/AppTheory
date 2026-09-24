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
class AppTheoryApiDomain extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryApiDomain", version: "4.4.0-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLWRvbWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFwaS1kb21haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUFrRDtBQUNsRCxzRUFBd0Q7QUFFeEQsaUVBQW1EO0FBQ25ELDJDQUF1QztBQWV2QyxNQUFhLGtCQUFtQixTQUFRLHNCQUFTOztJQUMvQixVQUFVLENBQXFCO0lBQy9CLFVBQVUsQ0FBcUI7SUFDL0IsV0FBVyxDQUF1QjtJQUNsQyxZQUFZLENBQVM7SUFFckMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE4QjtRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sVUFBVSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3pELElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUNoQixNQUFNLElBQUksS0FBSyxDQUFDLDhDQUE4QyxDQUFDLENBQUM7UUFDbEUsQ0FBQztRQUVELElBQUksQ0FBQyxZQUFZLEdBQUcsVUFBVSxDQUFDO1FBRS9CLE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxXQUFXLElBQUksT0FBTyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUNuRSxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsU0FBUyxJQUFJLHNCQUFRLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBRTNELE1BQU0sV0FBVyxHQUE0QjtZQUMzQyxVQUFVO1lBQ1YsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLElBQUksRUFBRSxLQUFLLENBQUMsdUJBQXVCO1lBQ25DLGNBQWMsRUFBRSxLQUFLLENBQUMsY0FBYztTQUNyQyxDQUFDO1FBRUYsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUU1RSxNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDO1FBQ3hELElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUNYLE1BQU0sSUFBSSxLQUFLLENBQUMsMEVBQTBFLENBQUMsQ0FBQztRQUM5RixDQUFDO1FBRUQsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUMzRCxHQUFHLEVBQUUsS0FBSyxDQUFDLE9BQU87WUFDbEIsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVO1lBQzNCLEtBQUs7WUFDTCxhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWE7U0FDbkMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxXQUFXLElBQUksS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ3BDLE1BQU0sVUFBVSxHQUFHLG1CQUFtQixDQUFDLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDckUsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLE9BQU8sQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtnQkFDOUQsSUFBSSxFQUFFLEtBQUssQ0FBQyxVQUFVO2dCQUN0QixVQUFVO2dCQUNWLFVBQVUsRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDLGtCQUFrQjtnQkFDOUMsR0FBRyxFQUFFLFNBQVM7YUFDZixDQUFDLENBQUM7UUFDTCxDQUFDO1FBRUQsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUN0QyxLQUFLLEVBQUUsVUFBVTtZQUNqQixXQUFXLEVBQUUsd0JBQXdCO1NBQ3RDLENBQUMsQ0FBQztRQUVILElBQUksdUJBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDeEMsS0FBSyxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUMsa0JBQWtCO1lBQ3pDLFdBQVcsRUFBRSxrQ0FBa0M7U0FDaEQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQzs7QUEzREgsZ0RBNERDO0FBRUQsU0FBUyxtQkFBbUIsQ0FBQyxVQUFrQixFQUFFLElBQXlCO0lBQ3hFLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxVQUFVLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUNoRSxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3ZFLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0IsSUFBSSxJQUFJLEtBQUssUUFBUTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ2pDLE1BQU0sTUFBTSxHQUFHLElBQUksUUFBUSxFQUFFLENBQUM7SUFDOUIsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDMUIsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN2QyxDQUFDO0lBQ0QsT0FBTyxJQUFJLENBQUM7QUFDZCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ2ZuT3V0cHV0LCBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUFwaURvbWFpblByb3BzIHtcbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuICByZWFkb25seSBhcGlNYXBwaW5nS2V5Pzogc3RyaW5nO1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZTtcbiAgcmVhZG9ubHkgaHR0cEFwaTogYXBpZ3d2Mi5JSHR0cEFwaTtcbiAgcmVhZG9ubHkgc3RhZ2U/OiBhcGlnd3YyLklTdGFnZTtcbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xuICByZWFkb25seSByZWNvcmRUdGw/OiBEdXJhdGlvbjtcbiAgcmVhZG9ubHkgY3JlYXRlQ25hbWU/OiBib29sZWFuO1xuICByZWFkb25seSBzZWN1cml0eVBvbGljeT86IGFwaWd3djIuU2VjdXJpdHlQb2xpY3k7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlBcGlEb21haW4gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZTogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZzogYXBpZ3d2Mi5BcGlNYXBwaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkO1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluU3RyaW5nOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUFwaURvbWFpblByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgaWYgKCFkb21haW5OYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlBcGlEb21haW4gcmVxdWlyZXMgcHJvcHMuZG9tYWluTmFtZVwiKTtcbiAgICB9XG5cbiAgICB0aGlzLmRvbWFpblN0cmluZyA9IGRvbWFpbk5hbWU7XG5cbiAgICBjb25zdCBjcmVhdGVDbmFtZSA9IHByb3BzLmNyZWF0ZUNuYW1lID8/IEJvb2xlYW4ocHJvcHMuaG9zdGVkWm9uZSk7XG4gICAgY29uc3QgcmVjb3JkVHRsID0gcHJvcHMucmVjb3JkVHRsID8/IER1cmF0aW9uLnNlY29uZHMoMzAwKTtcblxuICAgIGNvbnN0IGRvbWFpblByb3BzOiBhcGlnd3YyLkRvbWFpbk5hbWVQcm9wcyA9IHtcbiAgICAgIGRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZTogcHJvcHMuY2VydGlmaWNhdGUsXG4gICAgICBtdGxzOiBwcm9wcy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICAgIHNlY3VyaXR5UG9saWN5OiBwcm9wcy5zZWN1cml0eVBvbGljeSxcbiAgICB9O1xuXG4gICAgdGhpcy5kb21haW5OYW1lID0gbmV3IGFwaWd3djIuRG9tYWluTmFtZSh0aGlzLCBcIkN1c3RvbURvbWFpblwiLCBkb21haW5Qcm9wcyk7XG5cbiAgICBjb25zdCBzdGFnZSA9IHByb3BzLnN0YWdlID8/IHByb3BzLmh0dHBBcGkuZGVmYXVsdFN0YWdlO1xuICAgIGlmICghc3RhZ2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUFwaURvbWFpbiByZXF1aXJlcyBwcm9wcy5zdGFnZSB3aGVuIGh0dHBBcGkgaGFzIG5vIGRlZmF1bHRTdGFnZVwiKTtcbiAgICB9XG5cbiAgICB0aGlzLmFwaU1hcHBpbmcgPSBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICBhcGk6IHByb3BzLmh0dHBBcGksXG4gICAgICBkb21haW5OYW1lOiB0aGlzLmRvbWFpbk5hbWUsXG4gICAgICBzdGFnZSxcbiAgICAgIGFwaU1hcHBpbmdLZXk6IHByb3BzLmFwaU1hcHBpbmdLZXksXG4gICAgfSk7XG5cbiAgICBpZiAoY3JlYXRlQ25hbWUgJiYgcHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgY29uc3QgcmVjb3JkTmFtZSA9IHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZSwgcHJvcHMuaG9zdGVkWm9uZSk7XG4gICAgICB0aGlzLmNuYW1lUmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDTkFNRVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IHByb3BzLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgIGRvbWFpbk5hbWU6IHRoaXMuZG9tYWluTmFtZS5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICAgIHR0bDogcmVjb3JkVHRsLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCBcIkN1c3RvbURvbWFpbk5hbWVcIiwge1xuICAgICAgdmFsdWU6IGRvbWFpbk5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogXCJBUEkgQ3VzdG9tIERvbWFpbiBOYW1lXCIsXG4gICAgfSk7XG5cbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsIFwiUmVnaW9uYWxEb21haW5OYW1lXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgZGVzY3JpcHRpb246IFwiQVBJIEdhdGV3YXkgUmVnaW9uYWwgRG9tYWluIE5hbWVcIixcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgaWYgKGZxZG4uZW5kc1dpdGgoc3VmZml4KSkge1xuICAgIHJldHVybiBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gZnFkbjtcbn1cbiJdfQ==