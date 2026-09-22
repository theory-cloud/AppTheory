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
exports.AppTheoryS3Ingest = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iamConcrete = __importStar(require("aws-cdk-lib/aws-iam"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3n = __importStar(require("aws-cdk-lib/aws-s3-notifications"));
const constructs_1 = require("constructs");
const queue_1 = require("./queue");
function normalizeFilters(values) {
    if (!values)
        return [];
    const trimmed = values.map((value) => String(value).trim()).filter((value) => value.length > 0);
    return Array.from(new Set(trimmed));
}
/**
 * Secure “front door” S3 ingest wiring for import pipelines.
 *
 * This construct can:
 * - Create a secure bucket (or attach to an existing bucket)
 * - Enable S3 -> EventBridge notifications
 * - Configure S3 -> SQS notifications with prefix/suffix filters
 */
class AppTheoryS3Ingest extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryS3Ingest", version: "4.2.4-rc" };
    bucket;
    queue;
    queueConstruct;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const enableEventBridge = props.enableEventBridge ?? false;
        if (props.bucket && props.bucketName) {
            throw new Error("AppTheoryS3Ingest does not allow bucketName when bucket is provided");
        }
        if (props.queueTarget && props.queueProps) {
            throw new Error("AppTheoryS3Ingest requires at most one of queueTarget or queueProps");
        }
        if (props.encryptionKey && props.encryption !== s3.BucketEncryption.KMS) {
            throw new Error("AppTheoryS3Ingest only supports encryptionKey when encryption is BucketEncryption.KMS");
        }
        if (!props.bucket) {
            const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
            const autoDeleteObjects = props.autoDeleteObjects ?? false;
            const encryption = props.encryption ?? s3.BucketEncryption.S3_MANAGED;
            if (encryption === s3.BucketEncryption.KMS && !props.encryptionKey) {
                throw new Error("AppTheoryS3Ingest requires encryptionKey when encryption is BucketEncryption.KMS");
            }
            this.bucket = new s3.Bucket(this, "Bucket", {
                bucketName: props.bucketName,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                encryption,
                encryptionKey: props.encryptionKey,
                enforceSSL: true,
                objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
                removalPolicy,
                autoDeleteObjects,
                eventBridgeEnabled: enableEventBridge,
            });
        }
        else {
            this.bucket = props.bucket;
            if (enableEventBridge) {
                this.bucket.enableEventBridgeNotification();
            }
        }
        if (props.queueProps) {
            this.queueConstruct = new queue_1.AppTheoryQueue(this, "Queue", props.queueProps);
            this.queue = this.queueConstruct.queue;
        }
        else if (props.queueTarget) {
            this.queue = props.queueTarget;
        }
        if (this.queue) {
            const destination = new s3n.SqsDestination(this.queue);
            const prefixes = normalizeFilters(props.prefixes);
            const suffixes = normalizeFilters(props.suffixes);
            const prefixValues = prefixes.length > 0 ? prefixes : [undefined];
            const suffixValues = suffixes.length > 0 ? suffixes : [undefined];
            for (const prefix of prefixValues) {
                for (const suffix of suffixValues) {
                    if (!prefix && !suffix) {
                        this.bucket.addEventNotification(s3.EventType.OBJECT_CREATED, destination);
                    }
                    else {
                        this.bucket.addEventNotification(s3.EventType.OBJECT_CREATED, destination, {
                            prefix,
                            suffix,
                        });
                    }
                }
            }
        }
        for (const grantee of props.grantReadTo ?? []) {
            this.bucket.grantRead(grantee);
        }
        for (const grantee of props.grantWriteTo ?? []) {
            this.bucket.grantWrite(grantee);
        }
        for (const principal of props.writerPrincipals ?? []) {
            this.bucket.addToResourcePolicy(new iamConcrete.PolicyStatement({
                principals: [principal],
                actions: ["s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
                resources: [this.bucket.bucketArn],
            }));
            this.bucket.addToResourcePolicy(new iamConcrete.PolicyStatement({
                principals: [principal],
                actions: ["s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:PutObject"],
                resources: [this.bucket.arnForObjects("*")],
            }));
        }
    }
}
exports.AppTheoryS3Ingest = AppTheoryS3Ingest;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiczMtaW5nZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiczMtaW5nZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNEM7QUFFNUMsaUVBQW1EO0FBRW5ELHVEQUF5QztBQUN6QyxzRUFBd0Q7QUFFeEQsMkNBQXVDO0FBRXZDLG1DQUF5QztBQUV6QyxTQUFTLGdCQUFnQixDQUFDLE1BQWlCO0lBQ3pDLElBQUksQ0FBQyxNQUFNO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDdkIsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ2hHLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQ3RDLENBQUM7QUF3RkQ7Ozs7Ozs7R0FPRztBQUNILE1BQWEsaUJBQWtCLFNBQVEsc0JBQVM7O0lBQzlCLE1BQU0sQ0FBYTtJQUNuQixLQUFLLENBQWM7SUFDbkIsY0FBYyxDQUFrQjtJQUVoRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLFFBQWdDLEVBQUU7UUFDMUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLGlCQUFpQixHQUFHLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxLQUFLLENBQUM7UUFFM0QsSUFBSSxLQUFLLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUNyQyxNQUFNLElBQUksS0FBSyxDQUFDLHFFQUFxRSxDQUFDLENBQUM7UUFDekYsQ0FBQztRQUVELElBQUksS0FB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Q0gsQ0FBQztZQUNGLElBQUksQ0FBQyxNQUFNLENBQUMsbUJBQW1CLENBQzdCLElBQUksV0FBVyxDQUFDLGVBQWUsQ0FBQztnQkFDOUIsVUFBVSxFQUFFLENBQUMsU0FBUyxDQUFDO2dCQUN2QixPQUFPLEVBQUUsQ0FBQyx5QkFBeUIsRUFBRSw2QkFBNkIsRUFBRSxjQUFjLENBQUM7Z0JBQ25GLFNBQVMsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2FBQzVDLENBQUMsQ0FDSCxDQUFDO1FBQ0osQ0FBQztJQUNILENBQUM7O0FBdEdILDhDQXVHQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB0eXBlICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBpYW1Db25jcmV0ZSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0IHR5cGUgKiBhcyBrbXMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1rbXNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCAqIGFzIHMzbiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzLW5vdGlmaWNhdGlvbnNcIjtcbmltcG9ydCB0eXBlICogYXMgc3FzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc3FzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlRdWV1ZVByb3BzIH0gZnJvbSBcIi4vcXVldWVcIjtcbmltcG9ydCB7IEFwcFRoZW9yeVF1ZXVlIH0gZnJvbSBcIi4vcXVldWVcIjtcblxuZnVuY3Rpb24gbm9ybWFsaXplRmlsdGVycyh2YWx1ZXM/OiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgaWYgKCF2YWx1ZXMpIHJldHVybiBbXTtcbiAgY29uc3QgdHJpbW1lZCA9IHZhbHVlcy5tYXAoKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUpLnRyaW0oKSkuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUubGVuZ3RoID4gMCk7XG4gIHJldHVybiBBcnJheS5mcm9tKG5ldyBTZXQodHJpbW1lZCkpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVMzSW5nZXN0UHJvcHMge1xuICAvKipcbiAgICogT3B0aW9uYWwgZXhpc3RpbmcgUzMgYnVja2V0IHRvIHVzZSBmb3IgaW5nZXN0LlxuICAgKlxuICAgKiBJZiBub3QgcHJvdmlkZWQsIGEgbmV3IGJ1Y2tldCB3aWxsIGJlIGNyZWF0ZWQgd2l0aCBzZWN1cmUgZGVmYXVsdHMuXG4gICAqL1xuICByZWFkb25seSBidWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gIC8qKlxuICAgKiBOYW1lIGZvciB0aGUgaW5nZXN0IGJ1Y2tldCAob25seSB1c2VkIGlmIGJ1Y2tldCBpcyBub3QgcHJvdmlkZWQpLlxuICAgKi9cbiAgcmVhZG9ubHkgYnVja2V0TmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIGNyZWF0ZWQgcmVzb3VyY2VzLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gYXV0by1kZWxldGUgb2JqZWN0cyBpbiBhIGNyZWF0ZWQgYnVja2V0IHdoZW4gcmVtb3ZhbFBvbGljeSBpcyBERVNUUk9ZLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0b0RlbGV0ZU9iamVjdHM/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGVuYWJsZSBFdmVudEJyaWRnZSBub3RpZmljYXRpb25zIGZvciB0aGUgYnVja2V0LlxuICAgKlxuICAgKiBXaGVuIGNyZWF0aW5nIGEgYnVja2V0LCB0aGlzIHNldHMgYGV2ZW50QnJpZGdlRW5hYmxlZGAuXG4gICAqIFdoZW4gdXNpbmcgYW4gZXhpc3RpbmcgYnVja2V0LCB0aGlzIGNhbGxzIGBlbmFibGVFdmVudEJyaWRnZU5vdGlmaWNhdGlvbigpYC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZUV2ZW50QnJpZGdlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgU1FTIHF1ZXVlIHRhcmdldCBmb3IgZGlyZWN0IFMzIC0+IFNRUyBub3RpZmljYXRpb25zLlxuICAgKi9cbiAgcmVhZG9ubHkgcXVldWVUYXJnZXQ/OiBzcXMuSVF1ZXVlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBxdWV1ZSBwcm9wcyB0byBjcmVhdGUgYW4gU1FTIHF1ZXVlIGZvciBkaXJlY3QgUzMgLT4gU1FTIG5vdGlmaWNhdGlvbnMuXG4gICAqXG4gICAqIE11dHVhbGx5IGV4Y2x1c2l2ZSB3aXRoIGBxdWV1ZVRhcmdldGAuXG4gICAqL1xuICByZWFkb25seSBxdWV1ZVByb3BzPzogQXBwVGhlb3J5UXVldWVQcm9wcztcblxuICAvKipcbiAgICogT2JqZWN0IGtleSBwcmVmaXhlcyB0byBtYXRjaCBmb3IgUzMgLT4gU1FTIG5vdGlmaWNhdGlvbnMuXG4gICAqL1xuICByZWFkb25seSBwcmVmaXhlcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBPYmplY3Qga2V5IHN1ZmZpeGVzIHRvIG1hdGNoIGZvciBTMyAtPiBTUVMgbm90aWZpY2F0aW9ucy5cbiAgICovXG4gIHJlYWRvbmx5IHN1ZmZpeGVzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGJ1Y2tldCBlbmNyeXB0aW9uIHNldHRpbmcgKG9ubHkgdXNlZCB3aGVuIGNyZWF0aW5nIGEgYnVja2V0KS5cbiAgICogQGRlZmF1bHQgczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VEXG4gICAqL1xuICByZWFkb25seSBlbmNyeXB0aW9uPzogczMuQnVja2V0RW5jcnlwdGlvbjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgY3VzdG9tZXItbWFuYWdlZCBLTVMga2V5IChvbmx5IHVzZWQgd2hlbiBjcmVhdGluZyBhIGJ1Y2tldCkuXG4gICAqIE9ubHkgdmFsaWQgd2hlbiBgZW5jcnlwdGlvbmAgaXMgYHMzLkJ1Y2tldEVuY3J5cHRpb24uS01TYC5cbiAgICovXG4gIHJlYWRvbmx5IGVuY3J5cHRpb25LZXk/OiBrbXMuSUtleTtcblxuICAvKipcbiAgICogUHJpbmNpcGFscyB0byBncmFudCByZWFkIHBlcm1pc3Npb25zIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgZ3JhbnRSZWFkVG8/OiBpYW0uSUdyYW50YWJsZVtdO1xuXG4gIC8qKlxuICAgKiBQcmluY2lwYWxzIHRvIGdyYW50IHdyaXRlIHBlcm1pc3Npb25zIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgZ3JhbnRXcml0ZVRvPzogaWFtLklHcmFudGFibGVbXTtcblxuICAvKipcbiAgICogQ3Jvc3MtYWNjb3VudCB3cml0ZXIgcHJpbmNpcGFscyB0byBhbGxvdyB2aWEgYnVja2V0IHBvbGljeS5cbiAgICpcbiAgICogVGhpcyBpcyBpbnRlbnRpb25hbGx5IGV4cGxpY2l0IChidWNrZXQgcG9saWN5KSwgcmF0aGVyIHRoYW4gaW1wbGljaXQgbWFnaWMuXG4gICAqL1xuICByZWFkb25seSB3cml0ZXJQcmluY2lwYWxzPzogaWFtQ29uY3JldGUuSVByaW5jaXBhbFtdO1xufVxuXG4vKipcbiAqIFNlY3VyZSDigJxmcm9udCBkb29y4oCdIFMzIGluZ2VzdCB3aXJpbmcgZm9yIGltcG9ydCBwaXBlbGluZXMuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgY2FuOlxuICogLSBDcmVhdGUgYSBzZWN1cmUgYnVja2V0IChvciBhdHRhY2ggdG8gYW4gZXhpc3RpbmcgYnVja2V0KVxuICogLSBFbmFibGUgUzMgLT4gRXZlbnRCcmlkZ2Ugbm90aWZpY2F0aW9uc1xuICogLSBDb25maWd1cmUgUzMgLT4gU1FTIG5vdGlmaWNhdGlvbnMgd2l0aCBwcmVmaXgvc3VmZml4IGZpbHRlcnNcbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVMzSW5nZXN0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IHF1ZXVlPzogc3FzLklRdWV1ZTtcbiAgcHVibGljIHJlYWRvbmx5IHF1ZXVlQ29uc3RydWN0PzogQXBwVGhlb3J5UXVldWU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVMzSW5nZXN0UHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBlbmFibGVFdmVudEJyaWRnZSA9IHByb3BzLmVuYWJsZUV2ZW50QnJpZGdlID8/IGZhbHNlO1xuXG4gICAgaWYgKHByb3BzLmJ1Y2tldCAmJiBwcm9wcy5idWNrZXROYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTM0luZ2VzdCBkb2VzIG5vdCBhbGxvdyBidWNrZXROYW1lIHdoZW4gYnVja2V0IGlzIHByb3ZpZGVkXCIpO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5xdWV1ZVRhcmdldCAmJiBwcm9wcy5xdWV1ZVByb3BzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTM0luZ2VzdCByZXF1aXJlcyBhdCBtb3N0IG9uZSBvZiBxdWV1ZVRhcmdldCBvciBxdWV1ZVByb3BzXCIpO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5lbmNyeXB0aW9uS2V5ICYmIHByb3BzLmVuY3J5cHRpb24gIT09IHMzLkJ1Y2tldEVuY3J5cHRpb24uS01TKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTM0luZ2VzdCBvbmx5IHN1cHBvcnRzIGVuY3J5cHRpb25LZXkgd2hlbiBlbmNyeXB0aW9uIGlzIEJ1Y2tldEVuY3J5cHRpb24uS01TXCIpO1xuICAgIH1cblxuICAgIGlmICghcHJvcHMuYnVja2V0KSB7XG4gICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgICBjb25zdCBlbmNyeXB0aW9uID0gcHJvcHMuZW5jcnlwdGlvbiA/PyBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQ7XG5cbiAgICAgIGlmIChlbmNyeXB0aW9uID09PSBzMy5CdWNrZXRFbmNyeXB0aW9uLktNUyAmJiAhcHJvcHMuZW5jcnlwdGlvbktleSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlTM0luZ2VzdCByZXF1aXJlcyBlbmNyeXB0aW9uS2V5IHdoZW4gZW5jcnlwdGlvbiBpcyBCdWNrZXRFbmNyeXB0aW9uLktNU1wiKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiQnVja2V0XCIsIHtcbiAgICAgICAgYnVja2V0TmFtZTogcHJvcHMuYnVja2V0TmFtZSxcbiAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgZW5jcnlwdGlvbixcbiAgICAgICAgZW5jcnlwdGlvbktleTogcHJvcHMuZW5jcnlwdGlvbktleSxcbiAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuQlVDS0VUX09XTkVSX0VORk9SQ0VELFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgZXZlbnRCcmlkZ2VFbmFibGVkOiBlbmFibGVFdmVudEJyaWRnZSxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmJ1Y2tldCA9IHByb3BzLmJ1Y2tldDtcbiAgICAgIGlmIChlbmFibGVFdmVudEJyaWRnZSkge1xuICAgICAgICB0aGlzLmJ1Y2tldC5lbmFibGVFdmVudEJyaWRnZU5vdGlmaWNhdGlvbigpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChwcm9wcy5xdWV1ZVByb3BzKSB7XG4gICAgICB0aGlzLnF1ZXVlQ29uc3RydWN0ID0gbmV3IEFwcFRoZW9yeVF1ZXVlKHRoaXMsIFwiUXVldWVcIiwgcHJvcHMucXVldWVQcm9wcyk7XG4gICAgICB0aGlzLnF1ZXVlID0gdGhpcy5xdWV1ZUNvbnN0cnVjdC5xdWV1ZTtcbiAgICB9IGVsc2UgaWYgKHByb3BzLnF1ZXVlVGFyZ2V0KSB7XG4gICAgICB0aGlzLnF1ZXVlID0gcHJvcHMucXVldWVUYXJnZXQ7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMucXVldWUpIHtcbiAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gbmV3IHMzbi5TcXNEZXN0aW5hdGlvbih0aGlzLnF1ZXVlKTtcblxuICAgICAgY29uc3QgcHJlZml4ZXMgPSBub3JtYWxpemVGaWx0ZXJzKHByb3BzLnByZWZpeGVzKTtcbiAgICAgIGNvbnN0IHN1ZmZpeGVzID0gbm9ybWFsaXplRmlsdGVycyhwcm9wcy5zdWZmaXhlcyk7XG5cbiAgICAgIGNvbnN0IHByZWZpeFZhbHVlcyA9IHByZWZpeGVzLmxlbmd0aCA+IDAgPyBwcmVmaXhlcyA6IFt1bmRlZmluZWRdO1xuICAgICAgY29uc3Qgc3VmZml4VmFsdWVzID0gc3VmZml4ZXMubGVuZ3RoID4gMCA/IHN1ZmZpeGVzIDogW3VuZGVmaW5lZF07XG5cbiAgICAgIGZvciAoY29uc3QgcHJlZml4IG9mIHByZWZpeFZhbHVlcykge1xuICAgICAgICBmb3IgKGNvbnN0IHN1ZmZpeCBvZiBzdWZmaXhWYWx1ZXMpIHtcbiAgICAgICAgICBpZiAoIXByZWZpeCAmJiAhc3VmZml4KSB7XG4gICAgICAgICAgICB0aGlzLmJ1Y2tldC5hZGRFdmVudE5vdGlmaWNhdGlvbihzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsIGRlc3RpbmF0aW9uKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5idWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oczMuRXZlbnRUeXBlLk9CSkVDVF9DUkVBVEVELCBkZXN0aW5hdGlvbiwge1xuICAgICAgICAgICAgICBwcmVmaXgsXG4gICAgICAgICAgICAgIHN1ZmZpeCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudFJlYWRUbyA/PyBbXSkge1xuICAgICAgdGhpcy5idWNrZXQuZ3JhbnRSZWFkKGdyYW50ZWUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGdyYW50ZWUgb2YgcHJvcHMuZ3JhbnRXcml0ZVRvID8/IFtdKSB7XG4gICAgICB0aGlzLmJ1Y2tldC5ncmFudFdyaXRlKGdyYW50ZWUpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgcHJpbmNpcGFsIG9mIHByb3BzLndyaXRlclByaW5jaXBhbHMgPz8gW10pIHtcbiAgICAgIHRoaXMuYnVja2V0LmFkZFRvUmVzb3VyY2VQb2xpY3koXG4gICAgICAgIG5ldyBpYW1Db25jcmV0ZS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIHByaW5jaXBhbHM6IFtwcmluY2lwYWxdLFxuICAgICAgICAgIGFjdGlvbnM6IFtcInMzOkdldEJ1Y2tldExvY2F0aW9uXCIsIFwiczM6TGlzdEJ1Y2tldE11bHRpcGFydFVwbG9hZHNcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5idWNrZXQuYnVja2V0QXJuXSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgICAgdGhpcy5idWNrZXQuYWRkVG9SZXNvdXJjZVBvbGljeShcbiAgICAgICAgbmV3IGlhbUNvbmNyZXRlLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgcHJpbmNpcGFsczogW3ByaW5jaXBhbF0sXG4gICAgICAgICAgYWN0aW9uczogW1wiczM6QWJvcnRNdWx0aXBhcnRVcGxvYWRcIiwgXCJzMzpMaXN0TXVsdGlwYXJ0VXBsb2FkUGFydHNcIiwgXCJzMzpQdXRPYmplY3RcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5idWNrZXQuYXJuRm9yT2JqZWN0cyhcIipcIildLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbiJdfQ==