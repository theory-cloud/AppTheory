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
exports.AppTheoryHostedZone = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
const constructs_1 = require("constructs");
const string_utils_1 = require("./private/string-utils");
class AppTheoryHostedZone extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHostedZone", version: "4.4.2-rc" };
    hostedZone;
    hostedZoneId;
    zoneName;
    isImported;
    constructor(scope, id, props) {
        super(scope, id);
        const zoneName = String(props.zoneName ?? "").trim();
        if (!zoneName) {
            throw new Error("AppTheoryHostedZone requires props.zoneName");
        }
        this.zoneName = zoneName;
        const importIfExists = props.importIfExists ?? false;
        const enableSsmExport = props.enableSsmExport ?? false;
        const enableCfnExport = props.enableCfnExport ?? false;
        if (importIfExists && props.existingZoneId) {
            this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
                hostedZoneId: props.existingZoneId,
                zoneName,
            });
            this.hostedZoneId = props.existingZoneId;
            this.isImported = true;
        }
        else {
            const zone = new route53.PublicHostedZone(this, "HostedZone", {
                zoneName,
                comment: props.comment,
            });
            this.hostedZone = zone;
            this.hostedZoneId = zone.hostedZoneId;
            this.isImported = false;
            if (props.tags) {
                for (const [key, value] of Object.entries(props.tags)) {
                    aws_cdk_lib_1.Tags.of(zone).add(key, value);
                }
            }
        }
        if (enableSsmExport) {
            const parameterName = props.ssmParameterPath ?? `/route53/zones/${zoneName}/id`;
            new ssm.StringParameter(this, "ZoneIdParameter", {
                parameterName,
                stringValue: this.hostedZoneId,
                description: `Hosted Zone ID for ${zoneName}`,
            });
        }
        if (enableCfnExport) {
            const exportName = props.cfnExportName ?? sanitizeCloudFormationExportName(`HostedZoneId-${zoneName}`);
            new aws_cdk_lib_1.CfnOutput(this, "ZoneIdOutput", {
                value: this.hostedZoneId,
                description: `Hosted Zone ID for ${zoneName}`,
                exportName,
            });
        }
    }
    nameServers() {
        if (this.isImported)
            return undefined;
        return this.hostedZone.hostedZoneNameServers;
    }
    addNsRecord(recordName, targetNameServers, ttl) {
        return new route53.NsRecord(this, `NSRecord-${sanitizeConstructIdSuffix(recordName)}`, {
            zone: this.hostedZone,
            recordName,
            values: targetNameServers,
            ttl,
        });
    }
    addCnameRecord(recordName, domainName, ttl) {
        return new route53.CnameRecord(this, `CNAMERecord-${sanitizeConstructIdSuffix(recordName)}`, {
            zone: this.hostedZone,
            recordName,
            domainName,
            ttl,
        });
    }
}
exports.AppTheoryHostedZone = AppTheoryHostedZone;
function sanitizeCloudFormationExportName(name) {
    const input = String(name ?? "").trim();
    if (!input)
        return "export";
    let out = "";
    let lastWasDash = false;
    for (const r of input) {
        const isAllowed = (r >= "a" && r <= "z") ||
            (r >= "A" && r <= "Z") ||
            (r >= "0" && r <= "9") ||
            r === ":" ||
            r === "-";
        if (isAllowed) {
            out += r;
            lastWasDash = r === "-";
            continue;
        }
        if (!lastWasDash) {
            out += "-";
            lastWasDash = true;
        }
    }
    out = (0, string_utils_1.trimRepeatedChar)(out, "-");
    return out ? out : "export";
}
function sanitizeConstructIdSuffix(input) {
    const raw = String(input ?? "").trim();
    if (!raw)
        return "record";
    const out = (0, string_utils_1.trimRepeatedChar)(raw.replace(/[^a-zA-Z0-9]+/g, "-"), "-");
    return out ? out : "record";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaG9zdGVkLXpvbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJob3N0ZWQtem9uZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXdEO0FBQ3hELGlFQUFtRDtBQUNuRCx5REFBMkM7QUFDM0MsMkNBQXVDO0FBRXZDLHlEQUEwRDtBQWMxRCxNQUFhLG1CQUFvQixTQUFRLHNCQUFTOztJQUNoQyxVQUFVLENBQXNCO0lBQ2hDLFlBQVksQ0FBUztJQUNyQixRQUFRLENBQVM7SUFDakIsVUFBVSxDQUFVO0lBRXBDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBK0I7UUFDdkUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNyRCxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLDZDQUE2QyxDQUFDLENBQUM7UUFDakUsQ0FBQztRQUVELElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO1FBRXpCLE1BQU0sY0FBYyxHQUFHLEtBQUssQ0FBQyxjQUFjLElBQUksS0FBSyxDQUFDO1FBQ3JELE1BQU0sZUFBZSxHQUFHLEtBQUssQ0FBQyxlQUFlLElBQUksS0FBSyxDQUFDO1FBQ3ZELE1BQU0sZUFBZSxHQUFHLEtBQUssQ0FBQyxlQUFlLElBQUksS0FBSyxDQUFDO1FBRXZELElBQUksY0FBYyxJQUFJLEtBQUssQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUMzQyxJQUFJLENBQUMsVUFBVSxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtnQkFDaEYsWUFBWSxFQUFFLEtBQUssQ0FBQyxjQUFjO2dCQUNsQyxRQUFR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O0lBQ3RFLE9BQU8sR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUM5QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ2ZuT3V0cHV0LCBEdXJhdGlvbiwgVGFncyB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHNzbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNzbVwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SG9zdGVkWm9uZVByb3BzIHtcbiAgcmVhZG9ubHkgem9uZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgY29tbWVudD86IHN0cmluZztcbiAgcmVhZG9ubHkgaW1wb3J0SWZFeGlzdHM/OiBib29sZWFuO1xuICByZWFkb25seSBleGlzdGluZ1pvbmVJZD86IHN0cmluZztcbiAgcmVhZG9ubHkgZW5hYmxlU3NtRXhwb3J0PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgc3NtUGFyYW1ldGVyUGF0aD86IHN0cmluZztcbiAgcmVhZG9ubHkgZW5hYmxlQ2ZuRXhwb3J0PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY2ZuRXhwb3J0TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgdGFncz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlIb3N0ZWRab25lIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGhvc3RlZFpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIHB1YmxpYyByZWFkb25seSBob3N0ZWRab25lSWQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IHpvbmVOYW1lOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBpc0ltcG9ydGVkOiBib29sZWFuO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlIb3N0ZWRab25lUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcocHJvcHMuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICghem9uZU5hbWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUhvc3RlZFpvbmUgcmVxdWlyZXMgcHJvcHMuem9uZU5hbWVcIik7XG4gICAgfVxuXG4gICAgdGhpcy56b25lTmFtZSA9IHpvbmVOYW1lO1xuXG4gICAgY29uc3QgaW1wb3J0SWZFeGlzdHMgPSBwcm9wcy5pbXBvcnRJZkV4aXN0cyA/PyBmYWxzZTtcbiAgICBjb25zdCBlbmFibGVTc21FeHBvcnQgPSBwcm9wcy5lbmFibGVTc21FeHBvcnQgPz8gZmFsc2U7XG4gICAgY29uc3QgZW5hYmxlQ2ZuRXhwb3J0ID0gcHJvcHMuZW5hYmxlQ2ZuRXhwb3J0ID8/IGZhbHNlO1xuXG4gICAgaWYgKGltcG9ydElmRXhpc3RzICYmIHByb3BzLmV4aXN0aW5nWm9uZUlkKSB7XG4gICAgICB0aGlzLmhvc3RlZFpvbmUgPSByb3V0ZTUzLkhvc3RlZFpvbmUuZnJvbUhvc3RlZFpvbmVBdHRyaWJ1dGVzKHRoaXMsIFwiSG9zdGVkWm9uZVwiLCB7XG4gICAgICAgIGhvc3RlZFpvbmVJZDogcHJvcHMuZXhpc3Rpbmdab25lSWQsXG4gICAgICAgIHpvbmVOYW1lLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmhvc3RlZFpvbmVJZCA9IHByb3BzLmV4aXN0aW5nWm9uZUlkO1xuICAgICAgdGhpcy5pc0ltcG9ydGVkID0gdHJ1ZTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgem9uZSA9IG5ldyByb3V0ZTUzLlB1YmxpY0hvc3RlZFpvbmUodGhpcywgXCJIb3N0ZWRab25lXCIsIHtcbiAgICAgICAgem9uZU5hbWUsXG4gICAgICAgIGNvbW1lbnQ6IHByb3BzLmNvbW1lbnQsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuaG9zdGVkWm9uZSA9IHpvbmU7XG4gICAgICB0aGlzLmhvc3RlZFpvbmVJZCA9IHpvbmUuaG9zdGVkWm9uZUlkO1xuICAgICAgdGhpcy5pc0ltcG9ydGVkID0gZmFsc2U7XG5cbiAgICAgIGlmIChwcm9wcy50YWdzKSB7XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHByb3BzLnRhZ3MpKSB7XG4gICAgICAgICAgVGFncy5vZih6b25lKS5hZGQoa2V5LCB2YWx1ZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZW5hYmxlU3NtRXhwb3J0KSB7XG4gICAgICBjb25zdCBwYXJhbWV0ZXJOYW1lID0gcHJvcHMuc3NtUGFyYW1ldGVyUGF0aCA/PyBgL3JvdXRlNTMvem9uZXMvJHt6b25lTmFtZX0vaWRgO1xuICAgICAgbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgXCJab25lSWRQYXJhbWV0ZXJcIiwge1xuICAgICAgICBwYXJhbWV0ZXJOYW1lLFxuICAgICAgICBzdHJpbmdWYWx1ZTogdGhpcy5ob3N0ZWRab25lSWQsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgSG9zdGVkIFpvbmUgSUQgZm9yICR7em9uZU5hbWV9YCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChlbmFibGVDZm5FeHBvcnQpIHtcbiAgICAgIGNvbnN0IGV4cG9ydE5hbWUgPVxuICAgICAgICBwcm9wcy5jZm5FeHBvcnROYW1lID8/IHNhbml0aXplQ2xvdWRGb3JtYXRpb25FeHBvcnROYW1lKGBIb3N0ZWRab25lSWQtJHt6b25lTmFtZX1gKTtcblxuICAgICAgbmV3IENmbk91dHB1dCh0aGlzLCBcIlpvbmVJZE91dHB1dFwiLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLmhvc3RlZFpvbmVJZCxcbiAgICAgICAgZGVzY3JpcHRpb246IGBIb3N0ZWQgWm9uZSBJRCBmb3IgJHt6b25lTmFtZX1gLFxuICAgICAgICBleHBvcnROYW1lLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgbmFtZVNlcnZlcnMoKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xuICAgIGlmICh0aGlzLmlzSW1wb3J0ZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIHRoaXMuaG9zdGVkWm9uZS5ob3N0ZWRab25lTmFtZVNlcnZlcnM7XG4gIH1cblxuICBhZGROc1JlY29yZChyZWNvcmROYW1lOiBzdHJpbmcsIHRhcmdldE5hbWVTZXJ2ZXJzOiBzdHJpbmdbXSwgdHRsOiBEdXJhdGlvbik6IHJvdXRlNTMuTnNSZWNvcmQge1xuICAgIHJldHVybiBuZXcgcm91dGU1My5Oc1JlY29yZCh0aGlzLCBgTlNSZWNvcmQtJHtzYW5pdGl6ZUNvbnN0cnVjdElkU3VmZml4KHJlY29yZE5hbWUpfWAsIHtcbiAgICAgIHpvbmU6IHRoaXMuaG9zdGVkWm9uZSxcbiAgICAgIHJlY29yZE5hbWUsXG4gICAgICB2YWx1ZXM6IHRhcmdldE5hbWVTZXJ2ZXJzLFxuICAgICAgdHRsLFxuICAgIH0pO1xuICB9XG5cbiAgYWRkQ25hbWVSZWNvcmQocmVjb3JkTmFtZTogc3RyaW5nLCBkb21haW5OYW1lOiBzdHJpbmcsIHR0bDogRHVyYXRpb24pOiByb3V0ZTUzLkNuYW1lUmVjb3JkIHtcbiAgICByZXR1cm4gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgYENOQU1FUmVjb3JkLSR7c2FuaXRpemVDb25zdHJ1Y3RJZFN1ZmZpeChyZWNvcmROYW1lKX1gLCB7XG4gICAgICB6b25lOiB0aGlzLmhvc3RlZFpvbmUsXG4gICAgICByZWNvcmROYW1lLFxuICAgICAgZG9tYWluTmFtZSxcbiAgICAgIHR0bCxcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBzYW5pdGl6ZUNsb3VkRm9ybWF0aW9uRXhwb3J0TmFtZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBpbnB1dCA9IFN0cmluZyhuYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCFpbnB1dCkgcmV0dXJuIFwiZXhwb3J0XCI7XG5cbiAgbGV0IG91dCA9IFwiXCI7XG4gIGxldCBsYXN0V2FzRGFzaCA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgciBvZiBpbnB1dCkge1xuICAgIGNvbnN0IGlzQWxsb3dlZCA9XG4gICAgICAociA+PSBcImFcIiAmJiByIDw9IFwielwiKSB8fFxuICAgICAgKHIgPj0gXCJBXCIgJiYgciA8PSBcIlpcIikgfHxcbiAgICAgIChyID49IFwiMFwiICYmIHIgPD0gXCI5XCIpIHx8XG4gICAgICByID09PSBcIjpcIiB8fFxuICAgICAgciA9PT0gXCItXCI7XG4gICAgaWYgKGlzQWxsb3dlZCkge1xuICAgICAgb3V0ICs9IHI7XG4gICAgICBsYXN0V2FzRGFzaCA9IHIgPT09IFwiLVwiO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghbGFzdFdhc0Rhc2gpIHtcbiAgICAgIG91dCArPSBcIi1cIjtcbiAgICAgIGxhc3RXYXNEYXNoID0gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICBvdXQgPSB0cmltUmVwZWF0ZWRDaGFyKG91dCwgXCItXCIpO1xuICByZXR1cm4gb3V0ID8gb3V0IDogXCJleHBvcnRcIjtcbn1cblxuZnVuY3Rpb24gc2FuaXRpemVDb25zdHJ1Y3RJZFN1ZmZpeChpbnB1dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3ID0gU3RyaW5nKGlucHV0ID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCFyYXcpIHJldHVybiBcInJlY29yZFwiO1xuICBjb25zdCBvdXQgPSB0cmltUmVwZWF0ZWRDaGFyKHJhdy5yZXBsYWNlKC9bXmEtekEtWjAtOV0rL2csIFwiLVwiKSwgXCItXCIpO1xuICByZXR1cm4gb3V0ID8gb3V0IDogXCJyZWNvcmRcIjtcbn1cbiJdfQ==