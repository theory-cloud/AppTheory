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
exports.AppTheoryKinesisStream = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const kinesis = __importStar(require("aws-cdk-lib/aws-kinesis"));
const constructs_1 = require("constructs");
/**
 * AppTheory Kinesis Data Stream construct.
 *
 * Creates or wraps a single Kinesis Data Stream and exposes the stable stream
 * identity plus AppTheory grant helpers. Event source mappings and CloudWatch
 * Logs destinations are intentionally separate constructs.
 */
class AppTheoryKinesisStream extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryKinesisStream", version: "4.4.1-rc" };
    /**
     * The Kinesis stream, created or imported.
     */
    stream;
    /**
     * The ARN of the stream.
     */
    streamArn;
    /**
     * The name of the stream.
     */
    streamName;
    constructor(scope, id, props = {}) {
        super(scope, id);
        if (props.stream) {
            validateImportedStreamProps(props);
            this.stream = props.stream;
        }
        else {
            this.stream = new kinesis.Stream(this, "Stream", streamProps(props));
        }
        this.streamArn = this.stream.streamArn;
        this.streamName = this.stream.streamName;
        for (const grantee of props.grantReadTo ?? []) {
            this.grantRead(grantee);
        }
        for (const grantee of props.grantWriteTo ?? []) {
            this.grantWrite(grantee);
        }
        for (const grantee of props.grantReadWriteTo ?? []) {
            this.grantReadWrite(grantee);
        }
    }
    /**
     * Grant read permissions for this stream and its contents.
     */
    grantRead(grantee) {
        return this.stream.grantRead(grantee);
    }
    /**
     * Grant write permissions for this stream and its contents.
     */
    grantWrite(grantee) {
        return this.stream.grantWrite(grantee);
    }
    /**
     * Grant read/write permissions for this stream and its contents.
     */
    grantReadWrite(grantee) {
        return this.stream.grantReadWrite(grantee);
    }
}
exports.AppTheoryKinesisStream = AppTheoryKinesisStream;
function streamProps(props) {
    const mode = props.mode ?? kinesis.StreamMode.ON_DEMAND;
    const encryption = props.encryption ?? kinesis.StreamEncryption.MANAGED;
    validateModeAndShardCount(mode, props.shardCount);
    validateEncryption(encryption, props.encryptionKey);
    return {
        streamName: props.streamName,
        streamMode: mode,
        shardCount: mode === kinesis.StreamMode.PROVISIONED ? (props.shardCount ?? 1) : undefined,
        retentionPeriod: props.retentionPeriod,
        encryption,
        encryptionKey: props.encryptionKey,
        removalPolicy: props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN,
    };
}
function validateImportedStreamProps(props) {
    const forbidden = [];
    if (props.streamName !== undefined)
        forbidden.push("streamName");
    if (props.mode !== undefined)
        forbidden.push("mode");
    if (props.shardCount !== undefined)
        forbidden.push("shardCount");
    if (props.retentionPeriod !== undefined)
        forbidden.push("retentionPeriod");
    if (props.encryption !== undefined)
        forbidden.push("encryption");
    if (props.encryptionKey !== undefined)
        forbidden.push("encryptionKey");
    if (props.removalPolicy !== undefined)
        forbidden.push("removalPolicy");
    if (forbidden.length > 0) {
        throw new Error(`AppTheoryKinesisStream does not allow create-time properties with an imported stream: ${forbidden.join(", ")}`);
    }
}
function validateModeAndShardCount(mode, shardCount) {
    if (mode === kinesis.StreamMode.ON_DEMAND && shardCount !== undefined) {
        throw new Error("AppTheoryKinesisStream requires mode PROVISIONED when shardCount is provided");
    }
    if (mode !== kinesis.StreamMode.PROVISIONED || shardCount === undefined || aws_cdk_lib_1.Token.isUnresolved(shardCount)) {
        return;
    }
    if (!Number.isInteger(shardCount) || shardCount < 1) {
        throw new Error("AppTheoryKinesisStream requires shardCount to be a positive integer");
    }
}
function validateEncryption(encryption, encryptionKey) {
    if (encryption === kinesis.StreamEncryption.UNENCRYPTED) {
        throw new Error("AppTheoryKinesisStream requires stream encryption");
    }
    if (encryption === kinesis.StreamEncryption.KMS && !encryptionKey) {
        throw new Error("AppTheoryKinesisStream requires encryptionKey when encryption is StreamEncryption.KMS");
    }
    if (encryptionKey && encryption !== kinesis.StreamEncryption.KMS) {
        throw new Error("AppTheoryKinesisStream only supports encryptionKey when encryption is StreamEncryption.KMS");
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia2luZXNpcy1zdHJlYW0uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJraW5lc2lzLXN0cmVhbS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTZEO0FBRzdELGlFQUFtRDtBQUNuRCwyQ0FBdUM7QUFnR3ZDOzs7Ozs7R0FNRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7O0lBQ25EOztPQUVHO0lBQ2EsTUFBTSxDQUFrQjtJQUV4Qzs7T0FFRztJQUNhLFNBQVMsQ0FBUztJQUVsQzs7T0FFRztJQUNhLFVBQVUsQ0FBUztJQUVuQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLFFBQXFDLEVBQUU7UUFDL0UsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNqQiwyQkFBMkIsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNuQyxJQUFJLENBQUMsTUFBTSxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUM7UUFDN0IsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksT0FBTyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQ3ZFLENBQUM7UUFFRCxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDO1FBQ3ZDLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUM7UUFFekMsS0FBSyxNQUFNLE9BQU8sSUFBSSxLQUFLLENBQUMsV0FBVyxJQUFJLEVBQUUsRUFBRSxDQUFDO1lBQzlDLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDMUIsQ0FBQztRQUNELEtBQUssTUFBTSxPQUFPLElBQUksS0FBSyxDQUFDLFlBQVksSUFBSSxFQUFFLEVBQUUsQ0FBQztZQUMvQyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzNCLENBQUM7UUFDRCxLQUFLLE1BQU0sT0FBTyxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsSUFBSSxFQUFFLEVBQUUsQ0FBQztZQUNuRCxJQUFJLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQy9CLENBQUM7SUFDSCxDQUFDO0lBRUQ7O09BRUc7SUFDSSxTQUFTLENBQUMsT0FBdUI7UUFDdEMsT0FBTyxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN4QyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxVQUFVLENBQUMsT0FBdUI7UUFDdkMsT0FBTyxJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN6QyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxjQUFjLENBQUMsT0FBdUI7UUFDM0MsT0FBTyxJQUFJLENBQUMsTUFBTSxDQUFDLGNBQWMsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM3QyxDQUFDOztBQTNESCx3REE0REM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxLQUFrQztJQUNyRCxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsSUFBSSxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsU0FBUyxDQUFDO0lBQ3hELE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxVQUFVLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLE9BQU8sQ0FBQztJQUV4RSx5QkFBeUIsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2xELGtCQUFrQixDQUFDLFVBQVUsRUFBRSxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUM7SUFFcEQsT0FBTztRQUNMLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtRQUM1QixVQUFVLEVBQUUsSUFBSTtRQUNoQixVQUFVLEVBQUUsSUFBSSxLQUFLLE9BQU8sQ0FBQyxVQUFVLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVM7UUFDekYsZUFBZSxFQUFFLEtBQUssQ0FBQyxlQUFlO1FBQ3RDLFVBQVU7UUFDVixhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWE7UUFDbEMsYUFBYSxFQUFFLEtBQUssQ0FBQyxhQUFhLElBQUksMkJBQWEsQ0FBQyxNQUFNO0tBQzNELENBQUM7QUFDSixDQUFDO0FBRUQsU0FBUywyQkFBMkIsQ0FBQyxLQUFrQztJQUNyRSxNQUFNLFNBQVMsR0FBYSxFQUFFLENBQUM7SUFFL0IsSUFBSSxLQUFLLENBQUMsVUFBVSxLQUFLLFNBQVM7UUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ2pFLElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxTQUFTO1FBQUUsU0FBUyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNyRCxJQUFJLEtBQUssQ0FBQyxVQUFVLEtBQUssU0FBUztRQUFFLFNBQVMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7SUFDakUsSUFBSSxLQUFLLENBQUMsZUFBZSxLQUFLLFNBQVM7UUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7SUFDM0UsSUFBSSxLQUFLLENBQUMsVUFBVSxLQUFLLFNBQVM7UUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ2pFLElBQUksS0FBSyxDQUFDLGFBQWEsS0FBSyxTQUFTO1FBQUUsU0FBUyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQztJQUN2RSxJQUFJLEtBQUssQ0FBQyxhQUFhLEtBQUssU0FBUztRQUFFLFNBQVMsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUM7SUFFdkUsSUFBSSxTQUFTLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3pCLE1BQU0sSUFBSSxLQUFLLENBQ2IseUZBQXlGLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FDaEgsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyx5QkFBeUIsQ0FBQyxJQUF3QixFQUFFLFVBQW1CO0lBQzlFLElBQUksSUFBSSxLQUFLLE9BQU8sQ0FBQyxVQUFVLENBQUMsU0FBUyxJQUFJLFVBQVUsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUN0RSxNQUFNLElBQUksS0FBSyxDQUFDLDhFQUE4RSxDQUFDLENBQUM7SUFDbEcsQ0FBQztJQUVELElBQUksSUFBSSxLQUFLLE9BQU8sQ0FBQyxVQUFVLENBQUMsV0FBVyxJQUFJLFVBQVUsS0FBSyxTQUFTLElBQUksbUJBQUssQ0FBQyxZQUFZLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztRQUMxRyxPQUFPO0lBQ1QsQ0FBQztJQUVELElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxJQUFJLFVBQVUsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNwRCxNQUFNLElBQUksS0FBSyxDQUFDLHFFQUFxRSxDQUFDLENBQUM7SUFDekYsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLFVBQW9DLEVBQUUsYUFBd0I7SUFDeEYsSUFBSSxVQUFVLEtBQUssT0FBTyxDQUFDLGdCQUFnQixDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQ3hELE1BQU0sSUFBSSxLQUFLLENBQUMsbURBQW1ELENBQUMsQ0FBQztJQUN2RSxDQUFDO0lBRUQsSUFBSSxVQUFVLEtBQUssT0FBTyxDQUFDLGdCQUFnQixDQUFDLEdBQUcsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1FBQ2xFLE1BQU0sSUFBSSxLQUFLLENBQUMsdUZBQXVGLENBQUMsQ0FBQztJQUMzRyxDQUFDO0lBRUQsSUFBSSxhQUFhLElBQUksVUFBVSxLQUFLLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUNqRSxNQUFNLElBQUksS0FBSyxDQUFDLDRGQUE0RixDQUFDLENBQUM7SUFDaEgsQ0FBQztBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB0eXBlICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0ICogYXMga2luZXNpcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWtpbmVzaXNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgQXBwVGhlb3J5S2luZXNpc1N0cmVhbS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlLaW5lc2lzU3RyZWFtUHJvcHMge1xuICAvKipcbiAgICogRXhpc3RpbmcgS2luZXNpcyBzdHJlYW0gdG8gd3JhcC5cbiAgICpcbiAgICogV2hlbiBwcm92aWRlZCwgY3JlYXRlLXRpbWUgcHJvcGVydGllcyBzdWNoIGFzIHN0cmVhbU5hbWUsIG1vZGUsXG4gICAqIHNoYXJkQ291bnQsIHJldGVudGlvblBlcmlvZCwgZW5jcnlwdGlvbiwgZW5jcnlwdGlvbktleSwgYW5kXG4gICAqIHJlbW92YWxQb2xpY3kgYXJlIHJlamVjdGVkIHNvIGltcG9ydHMgY2Fubm90IGFjY2lkZW50YWxseSBzeW50aGVzaXplIGFcbiAgICogcmVwbGFjZW1lbnQgc3RyZWFtLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIGNyZWF0ZSBhIG5ldyBLaW5lc2lzIERhdGEgU3RyZWFtXG4gICAqL1xuICByZWFkb25seSBzdHJlYW0/OiBraW5lc2lzLklTdHJlYW07XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIHBoeXNpY2FsIHN0cmVhbSBuYW1lIGZvciBhIG5ld2x5IGNyZWF0ZWQgc3RyZWFtLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZCBuYW1lXG4gICAqL1xuICByZWFkb25seSBzdHJlYW1OYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDYXBhY2l0eSBtb2RlIGZvciBhIG5ld2x5IGNyZWF0ZWQgc3RyZWFtLlxuICAgKlxuICAgKiBAZGVmYXVsdCBraW5lc2lzLlN0cmVhbU1vZGUuT05fREVNQU5EXG4gICAqL1xuICByZWFkb25seSBtb2RlPzoga2luZXNpcy5TdHJlYW1Nb2RlO1xuXG4gIC8qKlxuICAgKiBTaGFyZCBjb3VudCBmb3IgcHJvdmlzaW9uZWQgc3RyZWFtcy5cbiAgICpcbiAgICogT25seSB2YWxpZCB3aGVuIG1vZGUgaXMga2luZXNpcy5TdHJlYW1Nb2RlLlBST1ZJU0lPTkVELlxuICAgKlxuICAgKiBAZGVmYXVsdCAxIHdoZW4gbW9kZSBpcyBQUk9WSVNJT05FRFxuICAgKi9cbiAgcmVhZG9ubHkgc2hhcmRDb3VudD86IG51bWJlcjtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3Igc3RyZWFtIHJlY29yZHMuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gS2luZXNpcyBkZWZhdWx0IHJldGVudGlvbiBwZXJpb2RcbiAgICovXG4gIHJlYWRvbmx5IHJldGVudGlvblBlcmlvZD86IER1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBTZXJ2ZXItc2lkZSBlbmNyeXB0aW9uIGZvciBhIG5ld2x5IGNyZWF0ZWQgc3RyZWFtLlxuICAgKlxuICAgKiBBcHBUaGVvcnkgc3VwcG9ydHMgQVdTLW1hbmFnZWQgS2luZXNpcyBlbmNyeXB0aW9uIGFuZCBleHBsaWNpdFxuICAgKiBjdXN0b21lci1tYW5hZ2VkIEtNUyBrZXlzLiBVbmVuY3J5cHRlZCBzdHJlYW1zIGFyZSByZWplY3RlZC5cbiAgICpcbiAgICogQGRlZmF1bHQga2luZXNpcy5TdHJlYW1FbmNyeXB0aW9uLk1BTkFHRURcbiAgICovXG4gIHJlYWRvbmx5IGVuY3J5cHRpb24/OiBraW5lc2lzLlN0cmVhbUVuY3J5cHRpb247XG5cbiAgLyoqXG4gICAqIEN1c3RvbWVyLW1hbmFnZWQgS01TIGtleSBmb3Igc3RyZWFtIGVuY3J5cHRpb24uXG4gICAqXG4gICAqIFJlcXVpcmVzIGVuY3J5cHRpb24gdG8gYmUga2luZXNpcy5TdHJlYW1FbmNyeXB0aW9uLktNUy5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBubyBjdXN0b21lci1tYW5hZ2VkIEtNUyBrZXlcbiAgICovXG4gIHJlYWRvbmx5IGVuY3J5cHRpb25LZXk/OiBrbXMuSUtleTtcblxuICAvKipcbiAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIGEgbmV3bHkgY3JlYXRlZCBzdHJlYW0uXG4gICAqXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAvKipcbiAgICogUHJpbmNpcGFscyB0byBncmFudCByZWFkIHBlcm1pc3Npb25zIHRvLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIE5vIGFkZGl0aW9uYWwgcmVhZCBncmFudHNcbiAgICovXG4gIHJlYWRvbmx5IGdyYW50UmVhZFRvPzogaWFtLklHcmFudGFibGVbXTtcblxuICAvKipcbiAgICogUHJpbmNpcGFscyB0byBncmFudCB3cml0ZSBwZXJtaXNzaW9ucyB0by5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBObyBhZGRpdGlvbmFsIHdyaXRlIGdyYW50c1xuICAgKi9cbiAgcmVhZG9ubHkgZ3JhbnRXcml0ZVRvPzogaWFtLklHcmFudGFibGVbXTtcblxuICAvKipcbiAgICogUHJpbmNpcGFscyB0byBncmFudCByZWFkL3dyaXRlIHBlcm1pc3Npb25zIHRvLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIE5vIGFkZGl0aW9uYWwgcmVhZC93cml0ZSBncmFudHNcbiAgICovXG4gIHJlYWRvbmx5IGdyYW50UmVhZFdyaXRlVG8/OiBpYW0uSUdyYW50YWJsZVtdO1xufVxuXG4vKipcbiAqIEFwcFRoZW9yeSBLaW5lc2lzIERhdGEgU3RyZWFtIGNvbnN0cnVjdC5cbiAqXG4gKiBDcmVhdGVzIG9yIHdyYXBzIGEgc2luZ2xlIEtpbmVzaXMgRGF0YSBTdHJlYW0gYW5kIGV4cG9zZXMgdGhlIHN0YWJsZSBzdHJlYW1cbiAqIGlkZW50aXR5IHBsdXMgQXBwVGhlb3J5IGdyYW50IGhlbHBlcnMuIEV2ZW50IHNvdXJjZSBtYXBwaW5ncyBhbmQgQ2xvdWRXYXRjaFxuICogTG9ncyBkZXN0aW5hdGlvbnMgYXJlIGludGVudGlvbmFsbHkgc2VwYXJhdGUgY29uc3RydWN0cy5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUtpbmVzaXNTdHJlYW0gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogVGhlIEtpbmVzaXMgc3RyZWFtLCBjcmVhdGVkIG9yIGltcG9ydGVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHN0cmVhbToga2luZXNpcy5JU3RyZWFtO1xuXG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBzdHJlYW0uXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RyZWFtQXJuOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBuYW1lIG9mIHRoZSBzdHJlYW0uXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RyZWFtTmFtZTogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlLaW5lc2lzU3RyZWFtUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAocHJvcHMuc3RyZWFtKSB7XG4gICAgICB2YWxpZGF0ZUltcG9ydGVkU3RyZWFtUHJvcHMocHJvcHMpO1xuICAgICAgdGhpcy5zdHJlYW0gPSBwcm9wcy5zdHJlYW07XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc3RyZWFtID0gbmV3IGtpbmVzaXMuU3RyZWFtKHRoaXMsIFwiU3RyZWFtXCIsIHN0cmVhbVByb3BzKHByb3BzKSk7XG4gICAgfVxuXG4gICAgdGhpcy5zdHJlYW1Bcm4gPSB0aGlzLnN0cmVhbS5zdHJlYW1Bcm47XG4gICAgdGhpcy5zdHJlYW1OYW1lID0gdGhpcy5zdHJlYW0uc3RyZWFtTmFtZTtcblxuICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudFJlYWRUbyA/PyBbXSkge1xuICAgICAgdGhpcy5ncmFudFJlYWQoZ3JhbnRlZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudFdyaXRlVG8gPz8gW10pIHtcbiAgICAgIHRoaXMuZ3JhbnRXcml0ZShncmFudGVlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBncmFudGVlIG9mIHByb3BzLmdyYW50UmVhZFdyaXRlVG8gPz8gW10pIHtcbiAgICAgIHRoaXMuZ3JhbnRSZWFkV3JpdGUoZ3JhbnRlZSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IHJlYWQgcGVybWlzc2lvbnMgZm9yIHRoaXMgc3RyZWFtIGFuZCBpdHMgY29udGVudHMuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnRSZWFkKGdyYW50ZWU6IGlhbS5JR3JhbnRhYmxlKTogaWFtLkdyYW50IHtcbiAgICByZXR1cm4gdGhpcy5zdHJlYW0uZ3JhbnRSZWFkKGdyYW50ZWUpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IHdyaXRlIHBlcm1pc3Npb25zIGZvciB0aGlzIHN0cmVhbSBhbmQgaXRzIGNvbnRlbnRzLlxuICAgKi9cbiAgcHVibGljIGdyYW50V3JpdGUoZ3JhbnRlZTogaWFtLklHcmFudGFibGUpOiBpYW0uR3JhbnQge1xuICAgIHJldHVybiB0aGlzLnN0cmVhbS5ncmFudFdyaXRlKGdyYW50ZWUpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdyYW50IHJlYWQvd3JpdGUgcGVybWlzc2lvbnMgZm9yIHRoaXMgc3RyZWFtIGFuZCBpdHMgY29udGVudHMuXG4gICAqL1xuICBwdWJsaWMgZ3JhbnRSZWFkV3JpdGUoZ3JhbnRlZTogaWFtLklHcmFudGFibGUpOiBpYW0uR3JhbnQge1xuICAgIHJldHVybiB0aGlzLnN0cmVhbS5ncmFudFJlYWRXcml0ZShncmFudGVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBzdHJlYW1Qcm9wcyhwcm9wczogQXBwVGhlb3J5S2luZXNpc1N0cmVhbVByb3BzKToga2luZXNpcy5TdHJlYW1Qcm9wcyB7XG4gIGNvbnN0IG1vZGUgPSBwcm9wcy5tb2RlID8/IGtpbmVzaXMuU3RyZWFtTW9kZS5PTl9ERU1BTkQ7XG4gIGNvbnN0IGVuY3J5cHRpb24gPSBwcm9wcy5lbmNyeXB0aW9uID8/IGtpbmVzaXMuU3RyZWFtRW5jcnlwdGlvbi5NQU5BR0VEO1xuXG4gIHZhbGlkYXRlTW9kZUFuZFNoYXJkQ291bnQobW9kZSwgcHJvcHMuc2hhcmRDb3VudCk7XG4gIHZhbGlkYXRlRW5jcnlwdGlvbihlbmNyeXB0aW9uLCBwcm9wcy5lbmNyeXB0aW9uS2V5KTtcblxuICByZXR1cm4ge1xuICAgIHN0cmVhbU5hbWU6IHByb3BzLnN0cmVhbU5hbWUsXG4gICAgc3RyZWFtTW9kZTogbW9kZSxcbiAgICBzaGFyZENvdW50OiBtb2RlID09PSBraW5lc2lzLlN0cmVhbU1vZGUuUFJPVklTSU9ORUQgPyAocHJvcHMuc2hhcmRDb3VudCA/PyAxKSA6IHVuZGVmaW5lZCxcbiAgICByZXRlbnRpb25QZXJpb2Q6IHByb3BzLnJldGVudGlvblBlcmlvZCxcbiAgICBlbmNyeXB0aW9uLFxuICAgIGVuY3J5cHRpb25LZXk6IHByb3BzLmVuY3J5cHRpb25LZXksXG4gICAgcmVtb3ZhbFBvbGljeTogcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgfTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVJbXBvcnRlZFN0cmVhbVByb3BzKHByb3BzOiBBcHBUaGVvcnlLaW5lc2lzU3RyZWFtUHJvcHMpOiB2b2lkIHtcbiAgY29uc3QgZm9yYmlkZGVuOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGlmIChwcm9wcy5zdHJlYW1OYW1lICE9PSB1bmRlZmluZWQpIGZvcmJpZGRlbi5wdXNoKFwic3RyZWFtTmFtZVwiKTtcbiAgaWYgKHByb3BzLm1vZGUgIT09IHVuZGVmaW5lZCkgZm9yYmlkZGVuLnB1c2goXCJtb2RlXCIpO1xuICBpZiAocHJvcHMuc2hhcmRDb3VudCAhPT0gdW5kZWZpbmVkKSBmb3JiaWRkZW4ucHVzaChcInNoYXJkQ291bnRcIik7XG4gIGlmIChwcm9wcy5yZXRlbnRpb25QZXJpb2QgIT09IHVuZGVmaW5lZCkgZm9yYmlkZGVuLnB1c2goXCJyZXRlbnRpb25QZXJpb2RcIik7XG4gIGlmIChwcm9wcy5lbmNyeXB0aW9uICE9PSB1bmRlZmluZWQpIGZvcmJpZGRlbi5wdXNoKFwiZW5jcnlwdGlvblwiKTtcbiAgaWYgKHByb3BzLmVuY3J5cHRpb25LZXkgIT09IHVuZGVmaW5lZCkgZm9yYmlkZGVuLnB1c2goXCJlbmNyeXB0aW9uS2V5XCIpO1xuICBpZiAocHJvcHMucmVtb3ZhbFBvbGljeSAhPT0gdW5kZWZpbmVkKSBmb3JiaWRkZW4ucHVzaChcInJlbW92YWxQb2xpY3lcIik7XG5cbiAgaWYgKGZvcmJpZGRlbi5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeUtpbmVzaXNTdHJlYW0gZG9lcyBub3QgYWxsb3cgY3JlYXRlLXRpbWUgcHJvcGVydGllcyB3aXRoIGFuIGltcG9ydGVkIHN0cmVhbTogJHtmb3JiaWRkZW4uam9pbihcIiwgXCIpfWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU1vZGVBbmRTaGFyZENvdW50KG1vZGU6IGtpbmVzaXMuU3RyZWFtTW9kZSwgc2hhcmRDb3VudD86IG51bWJlcik6IHZvaWQge1xuICBpZiAobW9kZSA9PT0ga2luZXNpcy5TdHJlYW1Nb2RlLk9OX0RFTUFORCAmJiBzaGFyZENvdW50ICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlLaW5lc2lzU3RyZWFtIHJlcXVpcmVzIG1vZGUgUFJPVklTSU9ORUQgd2hlbiBzaGFyZENvdW50IGlzIHByb3ZpZGVkXCIpO1xuICB9XG5cbiAgaWYgKG1vZGUgIT09IGtpbmVzaXMuU3RyZWFtTW9kZS5QUk9WSVNJT05FRCB8fCBzaGFyZENvdW50ID09PSB1bmRlZmluZWQgfHwgVG9rZW4uaXNVbnJlc29sdmVkKHNoYXJkQ291bnQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHNoYXJkQ291bnQpIHx8IHNoYXJkQ291bnQgPCAxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5S2luZXNpc1N0cmVhbSByZXF1aXJlcyBzaGFyZENvdW50IHRvIGJlIGEgcG9zaXRpdmUgaW50ZWdlclwiKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUVuY3J5cHRpb24oZW5jcnlwdGlvbjoga2luZXNpcy5TdHJlYW1FbmNyeXB0aW9uLCBlbmNyeXB0aW9uS2V5Pzoga21zLklLZXkpOiB2b2lkIHtcbiAgaWYgKGVuY3J5cHRpb24gPT09IGtpbmVzaXMuU3RyZWFtRW5jcnlwdGlvbi5VTkVOQ1JZUFRFRCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUtpbmVzaXNTdHJlYW0gcmVxdWlyZXMgc3RyZWFtIGVuY3J5cHRpb25cIik7XG4gIH1cblxuICBpZiAoZW5jcnlwdGlvbiA9PT0ga2luZXNpcy5TdHJlYW1FbmNyeXB0aW9uLktNUyAmJiAhZW5jcnlwdGlvbktleSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUtpbmVzaXNTdHJlYW0gcmVxdWlyZXMgZW5jcnlwdGlvbktleSB3aGVuIGVuY3J5cHRpb24gaXMgU3RyZWFtRW5jcnlwdGlvbi5LTVNcIik7XG4gIH1cblxuICBpZiAoZW5jcnlwdGlvbktleSAmJiBlbmNyeXB0aW9uICE9PSBraW5lc2lzLlN0cmVhbUVuY3J5cHRpb24uS01TKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5S2luZXNpc1N0cmVhbSBvbmx5IHN1cHBvcnRzIGVuY3J5cHRpb25LZXkgd2hlbiBlbmNyeXB0aW9uIGlzIFN0cmVhbUVuY3J5cHRpb24uS01TXCIpO1xuICB9XG59XG4iXX0=