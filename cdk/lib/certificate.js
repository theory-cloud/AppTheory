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
exports.AppTheoryCertificate = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const constructs_1 = require("constructs");
class AppTheoryCertificate extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryCertificate", version: "4.2.3" };
    certificate;
    constructor(scope, id, props) {
        super(scope, id);
        const domainName = String(props.domainName ?? "").trim();
        if (!domainName) {
            throw new Error("AppTheoryCertificate requires props.domainName");
        }
        const validationZone = props.validationZone ?? props.hostedZone;
        this.certificate = new acm.Certificate(this, "Certificate", {
            domainName,
            subjectAlternativeNames: props.subjectAlternativeNames,
            validation: acm.CertificateValidation.fromDns(validationZone),
            transparencyLoggingEnabled: props.transparencyLoggingEnabled ?? true,
            certificateName: props.certificateName,
        });
    }
    addDependency(dependency) {
        this.certificate.node.addDependency(dependency);
    }
}
exports.AppTheoryCertificate = AppTheoryCertificate;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2VydGlmaWNhdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjZXJ0aWZpY2F0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsd0VBQTBEO0FBRTFELDJDQUF3RDtBQVd4RCxNQUFhLG9CQUFxQixTQUFRLHNCQUFTOztJQUNqQyxXQUFXLENBQWtCO0lBRTdDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBZ0M7UUFDeEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUN6RCxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDaEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxnREFBZ0QsQ0FBQyxDQUFDO1FBQ3BFLENBQUM7UUFFRCxNQUFNLGNBQWMsR0FBRyxLQUFLLENBQUMsY0FBYyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFFaEUsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUMxRCxVQUFVO1lBQ1YsdUJBQXVCLEVBQUUsS0FBSyxDQUFDLHVCQUF1QjtZQUN0RCxVQUFVLEVBQUUsR0FBRyxDQUFDLHFCQUFxQixDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUM7WUFDN0QsMEJBQTBCLEVBQUUsS0FBSyxDQUFDLDBCQUEwQixJQUFJLElBQUk7WUFDcEUsZUFBZSxFQUFFLEtBQUssQ0FBQyxlQUFlO1NBQ3ZDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxhQUFhLENBQUMsVUFBc0I7UUFDbEMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2xELENBQUM7O0FBeEJILG9EQXlCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCwgdHlwZSBJQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlDZXJ0aWZpY2F0ZVByb3BzIHtcbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuICByZWFkb25seSBzdWJqZWN0QWx0ZXJuYXRpdmVOYW1lcz86IHN0cmluZ1tdO1xuICByZWFkb25seSBob3N0ZWRab25lOiByb3V0ZTUzLklIb3N0ZWRab25lO1xuICByZWFkb25seSB2YWxpZGF0aW9uWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIHJlYWRvbmx5IHRyYW5zcGFyZW5jeUxvZ2dpbmdFbmFibGVkPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVOYW1lPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5Q2VydGlmaWNhdGUgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU6IGFjbS5DZXJ0aWZpY2F0ZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5Q2VydGlmaWNhdGVQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICghZG9tYWluTmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5Q2VydGlmaWNhdGUgcmVxdWlyZXMgcHJvcHMuZG9tYWluTmFtZVwiKTtcbiAgICB9XG5cbiAgICBjb25zdCB2YWxpZGF0aW9uWm9uZSA9IHByb3BzLnZhbGlkYXRpb25ab25lID8/IHByb3BzLmhvc3RlZFpvbmU7XG5cbiAgICB0aGlzLmNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgIGRvbWFpbk5hbWUsXG4gICAgICBzdWJqZWN0QWx0ZXJuYXRpdmVOYW1lczogcHJvcHMuc3ViamVjdEFsdGVybmF0aXZlTmFtZXMsXG4gICAgICB2YWxpZGF0aW9uOiBhY20uQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnModmFsaWRhdGlvblpvbmUpLFxuICAgICAgdHJhbnNwYXJlbmN5TG9nZ2luZ0VuYWJsZWQ6IHByb3BzLnRyYW5zcGFyZW5jeUxvZ2dpbmdFbmFibGVkID8/IHRydWUsXG4gICAgICBjZXJ0aWZpY2F0ZU5hbWU6IHByb3BzLmNlcnRpZmljYXRlTmFtZSxcbiAgICB9KTtcbiAgfVxuXG4gIGFkZERlcGVuZGVuY3koZGVwZW5kZW5jeTogSUNvbnN0cnVjdCk6IHZvaWQge1xuICAgIHRoaXMuY2VydGlmaWNhdGUubm9kZS5hZGREZXBlbmRlbmN5KGRlcGVuZGVuY3kpO1xuICB9XG59XG5cbiJdfQ==