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
exports.AppTheoryKeeperVisibility = exports.AppTheoryVisibilityManifestTier = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
const constructs_1 = require("constructs");
const naming_1 = require("./naming");
/**
 * The SSM parameter tier of the published visibility manifest.
 */
var AppTheoryVisibilityManifestTier;
(function (AppTheoryVisibilityManifestTier) {
    /**
     * Standard tier: a 4096-character value limit.
     */
    AppTheoryVisibilityManifestTier["STANDARD"] = "standard";
    /**
     * Advanced tier: an 8192-character value limit.
     */
    AppTheoryVisibilityManifestTier["ADVANCED"] = "advanced";
})(AppTheoryVisibilityManifestTier || (exports.AppTheoryVisibilityManifestTier = AppTheoryVisibilityManifestTier = {}));
const MANIFEST_VALUE_LIMIT = {
    [AppTheoryVisibilityManifestTier.STANDARD]: 4096,
    [AppTheoryVisibilityManifestTier.ADVANCED]: 8192,
};
/**
 * The reader role, compiled policy and manifest a consumer shares with Keeper.
 *
 * Create this construct only when the consumer passes a reader principal and
 * rules; with no visibility block no role, policy or manifest is created.
 */
class AppTheoryKeeperVisibility extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryKeeperVisibility", version: "7.4.0" };
    /**
     * The reader role Keeper assumes.
     */
    readerRole;
    /**
     * The SSM parameter holding the manifest.
     */
    manifestParameter;
    previewProvider;
    constructor(scope, id, props) {
        super(scope, id);
        const context = props.namingContext;
        const rules = props.rules;
        // Validate the selectors and fail synthesis before creating anything.
        naming_1.AppTheoryResourceNaming.visibilityPreview(context.values(), rules, []);
        const policyJson = naming_1.AppTheoryResourceNaming.compileVisibilityPolicyJson(context.values(), rules);
        const document = iam.PolicyDocument.fromJson(JSON.parse(policyJson));
        this.readerRole = new iam.Role(this, "ReaderRole", {
            roleName: context.physicalName("iam_role", "keeper-reader").name,
            assumedBy: new iam.ArnPrincipal(props.readerPrincipalArn),
            description: `Keeper reader role for ${context.app}/${context.stage}`,
            inlinePolicies: { Visibility: document },
        });
        const memo = {};
        this.previewProvider = () => {
            if (!memo.preview) {
                const sources = props.sources ?? discoverSources(this, context);
                memo.preview = naming_1.AppTheoryResourceNaming.visibilityPreview(context.values(), rules, sources);
            }
            return memo.preview;
        };
        aws_cdk_lib_1.Annotations.of(this).addInfo(aws_cdk_lib_1.Lazy.string({
            produce: () => {
                const preview = this.previewProvider();
                return [
                    `AppTheory keeper visibility preview for ${context.app}/${context.stage}:`,
                    JSON.stringify({
                        rule_version: preview.ruleVersion,
                        matched_now: preview.matchedNow,
                        not_matched_now: preview.notMatchedNow,
                        future: { include: preview.future.include ?? [], exclude: preview.future.exclude ?? [] },
                    }),
                ].join(" ");
            },
        }));
        const tier = props.manifestTier ?? AppTheoryVisibilityManifestTier.STANDARD;
        const limit = MANIFEST_VALUE_LIMIT[tier];
        this.manifestParameter = new ssm.StringParameter(this, "ManifestParameter", {
            parameterName: manifestParameterName(context),
            tier: tier === AppTheoryVisibilityManifestTier.ADVANCED ? ssm.ParameterTier.ADVANCED : ssm.ParameterTier.STANDARD,
            stringValue: aws_cdk_lib_1.Lazy.string({
                produce: () => {
                    const preview = this.previewProvider();
                    const json = naming_1.AppTheoryResourceNaming.manifestJson({
                        ruleVersion: preview.ruleVersion,
                        matchedNow: preview.matchedNow,
                        future: preview.future,
                    });
                    if (json.length > limit) {
                        throw new Error(`AppTheoryKeeperVisibility manifest is ${json.length} characters, over the ${tier} SSM parameter value limit of ${limit}; reduce the rule set or use the advanced tier`);
                    }
                    return json;
                },
            }),
        });
    }
    /**
     * The synth-time preview, including the sources the rules do not match yet.
     */
    preview() {
        return this.previewProvider();
    }
}
exports.AppTheoryKeeperVisibility = AppTheoryKeeperVisibility;
/**
 * The contract's manifest parameter name.
 */
function manifestParameterName(context) {
    return `/theorycloud/visibility/${context.app}/${context.stage}/manifest`;
}
/**
 * Discover the logical sources of the log groups this stack declares under the
 * app's bound prefix, excluding other apps' and lookalike groups.
 */
function discoverSources(scope, context) {
    const prefix = context.logSourcePrefix();
    const sources = new Set();
    for (const node of aws_cdk_lib_1.Stack.of(scope).node.findAll()) {
        // Read the L1 property: the L2 getter returns a token even for a concrete
        // name, because it resolves the physical name during synthesis.
        if (!(node instanceof logs.CfnLogGroup))
            continue;
        const name = node.logGroupName;
        if (typeof name !== "string" || aws_cdk_lib_1.Token.isUnresolved(name) || !name.startsWith(prefix))
            continue;
        sources.add(name.slice(prefix.length).replace(/_/g, "/"));
    }
    return [...sources].sort();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia2VlcGVyLXZpc2liaWxpdHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJrZWVwZXItdmlzaWJpbGl0eS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQThEO0FBQzlELHlEQUEyQztBQUMzQywyREFBNkM7QUFDN0MseURBQTJDO0FBQzNDLDJDQUF1QztBQUV2QyxxQ0FJa0I7QUFHbEI7O0dBRUc7QUFDSCxJQUFZLCtCQVVYO0FBVkQsV0FBWSwrQkFBK0I7SUFDekM7O09BRUc7SUFDSCx3REFBcUIsQ0FBQTtJQUVyQjs7T0FFRztJQUNILHdEQUFxQixDQUFBO0FBQ3ZCLENBQUMsRUFWVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQVUxQztBQUVELE1BQU0sb0JBQW9CLEdBQStCO0lBQ3ZELENBQUMsK0JBQStCLENBQUMsUUFBUSxDQUFDLEVBQUUsSUFBSTtJQUNoRCxDQUFDLCtCQUErQixDQUFDLFFBQVEsQ0FBQyxFQUFFLElBQUk7Q0FDakQsQ0FBQztBQW1DRjs7Ozs7R0FLRztBQUNILE1BQWEseUJBQTBCLFNBQVEsc0JBQVM7O0lBQ3REOztPQUVHO0lBQ2EsVUFBVSxDQUFXO0lBRXJDOztPQUVHO0lBQ2EsaUJBQWlCLENBQXNCO0lBRXRDLGVBQWUsQ0FBbUM7SUFFbkUsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFxQztRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxhQUFhLENBQUM7UUFDcEMsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQztRQUUxQixzRUFBc0U7UUFDdEUsZ0NBQXVCLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUV2RSxNQUFNLFVBQVUsR0FBRyxnQ0FBdUIsQ0FB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QUksQ0FBQyxZQUFZLENBQUM7UUFDL0IsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksbUJBQUssQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQztZQUFFLFNBQVM7UUFDL0YsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDNUQsQ0FBQztJQUNELE9BQU8sQ0FBQyxHQUFHLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzdCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBbm5vdGF0aW9ucywgTGF6eSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyBzc20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1zc21cIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7XG4gIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLFxuICB0eXBlIEFwcFRoZW9yeVZpc2liaWxpdHlQcmV2aWV3LFxuICB0eXBlIEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbn0gZnJvbSBcIi4vbmFtaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuXG4vKipcbiAqIFRoZSBTU00gcGFyYW1ldGVyIHRpZXIgb2YgdGhlIHB1Ymxpc2hlZCB2aXNpYmlsaXR5IG1hbmlmZXN0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3RUaWVyIHtcbiAgLyoqXG4gICAqIFN0YW5kYXJkIHRpZXI6IGEgNDA5Ni1jaGFyYWN0ZXIgdmFsdWUgbGltaXQuXG4gICAqL1xuICBTVEFOREFSRCA9IFwic3RhbmRhcmRcIixcblxuICAvKipcbiAgICogQWR2YW5jZWQgdGllcjogYW4gODE5Mi1jaGFyYWN0ZXIgdmFsdWUgbGltaXQuXG4gICAqL1xuICBBRFZBTkNFRCA9IFwiYWR2YW5jZWRcIixcbn1cblxuY29uc3QgTUFOSUZFU1RfVkFMVUVfTElNSVQ6IHsgW3RpZXI6IHN0cmluZ106IG51bWJlciB9ID0ge1xuICBbQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0VGllci5TVEFOREFSRF06IDQwOTYsXG4gIFtBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3RUaWVyLkFEVkFOQ0VEXTogODE5Mixcbn07XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgYW4gYEFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHlgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHlQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtaW5nIGNvbnRleHQuIEl0cyBhcHAsIHN0YWdlIGFuZCBsb2ctc291cmNlIHByZWZpeCBiaW5kIGV2ZXJ5IHJ1bGUuXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgcHJpbmNpcGFsIGFsbG93ZWQgdG8gYXNzdW1lIHRoZSByZWFkZXIgcm9sZTogS2VlcGVyJ3MgcnVudGltZSByb2xlIEFSTi5cbiAgICovXG4gIHJlYWRvbmx5IHJlYWRlclByaW5jaXBhbEFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29uc3VtZXIncyBpbmNsdWRlIGFuZCBleGNsdWRlIHNlbGVjdG9ycy5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXM7XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IGxvZ2ljYWwgc291cmNlcy4gV2hlbiBvbWl0dGVkIHRoZSBzdGFjaydzIGRlY2xhcmVkIGxvZyBncm91cHMgYXJlXG4gICAqIGRpc2NvdmVyZWQgYXQgc3ludGhlc2lzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHNvdXJjZXM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIFNTTSBwYXJhbWV0ZXIgdGllciBvZiB0aGUgbWFuaWZlc3QuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdFRpZXIuU1RBTkRBUkRcbiAgICovXG4gIHJlYWRvbmx5IG1hbmlmZXN0VGllcj86IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdFRpZXI7XG59XG5cbi8qKlxuICogVGhlIHJlYWRlciByb2xlLCBjb21waWxlZCBwb2xpY3kgYW5kIG1hbmlmZXN0IGEgY29uc3VtZXIgc2hhcmVzIHdpdGggS2VlcGVyLlxuICpcbiAqIENyZWF0ZSB0aGlzIGNvbnN0cnVjdCBvbmx5IHdoZW4gdGhlIGNvbnN1bWVyIHBhc3NlcyBhIHJlYWRlciBwcmluY2lwYWwgYW5kXG4gKiBydWxlczsgd2l0aCBubyB2aXNpYmlsaXR5IGJsb2NrIG5vIHJvbGUsIHBvbGljeSBvciBtYW5pZmVzdCBpcyBjcmVhdGVkLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5S2VlcGVyVmlzaWJpbGl0eSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBUaGUgcmVhZGVyIHJvbGUgS2VlcGVyIGFzc3VtZXMuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcmVhZGVyUm9sZTogaWFtLlJvbGU7XG5cbiAgLyoqXG4gICAqIFRoZSBTU00gcGFyYW1ldGVyIGhvbGRpbmcgdGhlIG1hbmlmZXN0LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1hbmlmZXN0UGFyYW1ldGVyOiBzc20uU3RyaW5nUGFyYW1ldGVyO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgcHJldmlld1Byb3ZpZGVyOiAoKSA9PiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5S2VlcGVyVmlzaWJpbGl0eVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IGNvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgIGNvbnN0IHJ1bGVzID0gcHJvcHMucnVsZXM7XG5cbiAgICAvLyBWYWxpZGF0ZSB0aGUgc2VsZWN0b3JzIGFuZCBmYWlsIHN5bnRoZXNpcyBiZWZvcmUgY3JlYXRpbmcgYW55dGhpbmcuXG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmlzaWJpbGl0eVByZXZpZXcoY29udGV4dC52YWx1ZXMoKSwgcnVsZXMsIFtdKTtcblxuICAgIGNvbnN0IHBvbGljeUpzb24gPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5jb21waWxlVmlzaWJpbGl0eVBvbGljeUpzb24oY29udGV4dC52YWx1ZXMoKSwgcnVsZXMpO1xuICAgIGNvbnN0IGRvY3VtZW50ID0gaWFtLlBvbGljeURvY3VtZW50LmZyb21Kc29uKEpTT04ucGFyc2UocG9saWN5SnNvbikgYXMgeyBba2V5OiBzdHJpbmddOiB1bmtub3duIH0pO1xuXG4gICAgdGhpcy5yZWFkZXJSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiUmVhZGVyUm9sZVwiLCB7XG4gICAgICByb2xlTmFtZTogY29udGV4dC5waHlzaWNhbE5hbWUoXCJpYW1fcm9sZVwiLCBcImtlZXBlci1yZWFkZXJcIikubmFtZSxcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5Bcm5QcmluY2lwYWwocHJvcHMucmVhZGVyUHJpbmNpcGFsQXJuKSxcbiAgICAgIGRlc2NyaXB0aW9uOiBgS2VlcGVyIHJlYWRlciByb2xlIGZvciAke2NvbnRleHQuYXBwfS8ke2NvbnRleHQuc3RhZ2V9YCxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7IFZpc2liaWxpdHk6IGRvY3VtZW50IH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBtZW1vOiB7IHByZXZpZXc/OiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB9ID0ge307XG4gICAgdGhpcy5wcmV2aWV3UHJvdmlkZXIgPSAoKSA9PiB7XG4gICAgICBpZiAoIW1lbW8ucHJldmlldykge1xuICAgICAgICBjb25zdCBzb3VyY2VzID0gcHJvcHMuc291cmNlcyA/PyBkaXNjb3ZlclNvdXJjZXModGhpcywgY29udGV4dCk7XG4gICAgICAgIG1lbW8ucHJldmlldyA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZpc2liaWxpdHlQcmV2aWV3KGNvbnRleHQudmFsdWVzKCksIHJ1bGVzLCBzb3VyY2VzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBtZW1vLnByZXZpZXc7XG4gICAgfTtcblxuICAgIEFubm90YXRpb25zLm9mKHRoaXMpLmFkZEluZm8oXG4gICAgICBMYXp5LnN0cmluZyh7XG4gICAgICAgIHByb2R1Y2U6ICgpID0+IHtcbiAgICAgICAgICBjb25zdCBwcmV2aWV3ID0gdGhpcy5wcmV2aWV3UHJvdmlkZXIoKTtcbiAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgYEFwcFRoZW9yeSBrZWVwZXIgdmlzaWJpbGl0eSBwcmV2aWV3IGZvciAke2NvbnRleHQuYXBwfS8ke2NvbnRleHQuc3RhZ2V9OmAsXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgIHJ1bGVfdmVyc2lvbjogcHJldmlldy5ydWxlVmVyc2lvbixcbiAgICAgICAgICAgICAgbWF0Y2hlZF9ub3c6IHByZXZpZXcubWF0Y2hlZE5vdyxcbiAgICAgICAgICAgICAgbm90X21hdGNoZWRfbm93OiBwcmV2aWV3Lm5vdE1hdGNoZWROb3csXG4gICAgICAgICAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBwcmV2aWV3LmZ1dHVyZS5pbmNsdWRlID8/IFtdLCBleGNsdWRlOiBwcmV2aWV3LmZ1dHVyZS5leGNsdWRlID8/IFtdIH0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLmpvaW4oXCIgXCIpO1xuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGNvbnN0IHRpZXIgPSBwcm9wcy5tYW5pZmVzdFRpZXIgPz8gQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0VGllci5TVEFOREFSRDtcbiAgICBjb25zdCBsaW1pdCA9IE1BTklGRVNUX1ZBTFVFX0xJTUlUW3RpZXJdO1xuICAgIHRoaXMubWFuaWZlc3RQYXJhbWV0ZXIgPSBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBcIk1hbmlmZXN0UGFyYW1ldGVyXCIsIHtcbiAgICAgIHBhcmFtZXRlck5hbWU6IG1hbmlmZXN0UGFyYW1ldGVyTmFtZShjb250ZXh0KSxcbiAgICAgIHRpZXI6IHRpZXIgPT09IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdFRpZXIuQURWQU5DRUQgPyBzc20uUGFyYW1ldGVyVGllci5BRFZBTkNFRCA6IHNzbS5QYXJhbWV0ZXJUaWVyLlNUQU5EQVJELFxuICAgICAgc3RyaW5nVmFsdWU6IExhenkuc3RyaW5nKHtcbiAgICAgICAgcHJvZHVjZTogKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHByZXZpZXcgPSB0aGlzLnByZXZpZXdQcm92aWRlcigpO1xuICAgICAgICAgIGNvbnN0IGpzb24gPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5tYW5pZmVzdEpzb24oe1xuICAgICAgICAgICAgcnVsZVZlcnNpb246IHByZXZpZXcucnVsZVZlcnNpb24sXG4gICAgICAgICAgICBtYXRjaGVkTm93OiBwcmV2aWV3Lm1hdGNoZWROb3csXG4gICAgICAgICAgICBmdXR1cmU6IHByZXZpZXcuZnV0dXJlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChqc29uLmxlbmd0aCA+IGxpbWl0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIGBBcHBUaGVvcnlLZWVwZXJWaXNpYmlsaXR5IG1hbmlmZXN0IGlzICR7anNvbi5sZW5ndGh9IGNoYXJhY3RlcnMsIG92ZXIgdGhlICR7dGllcn0gU1NNIHBhcmFtZXRlciB2YWx1ZSBsaW1pdCBvZiAke2xpbWl0fTsgcmVkdWNlIHRoZSBydWxlIHNldCBvciB1c2UgdGhlIGFkdmFuY2VkIHRpZXJgLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGpzb247XG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgc3ludGgtdGltZSBwcmV2aWV3LCBpbmNsdWRpbmcgdGhlIHNvdXJjZXMgdGhlIHJ1bGVzIGRvIG5vdCBtYXRjaCB5ZXQuXG4gICAqL1xuICBwdWJsaWMgcHJldmlldygpOiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gICAgcmV0dXJuIHRoaXMucHJldmlld1Byb3ZpZGVyKCk7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgY29udHJhY3QncyBtYW5pZmVzdCBwYXJhbWV0ZXIgbmFtZS5cbiAqL1xuZnVuY3Rpb24gbWFuaWZlc3RQYXJhbWV0ZXJOYW1lKGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQpOiBzdHJpbmcge1xuICByZXR1cm4gYC90aGVvcnljbG91ZC92aXNpYmlsaXR5LyR7Y29udGV4dC5hcHB9LyR7Y29udGV4dC5zdGFnZX0vbWFuaWZlc3RgO1xufVxuXG4vKipcbiAqIERpc2NvdmVyIHRoZSBsb2dpY2FsIHNvdXJjZXMgb2YgdGhlIGxvZyBncm91cHMgdGhpcyBzdGFjayBkZWNsYXJlcyB1bmRlciB0aGVcbiAqIGFwcCdzIGJvdW5kIHByZWZpeCwgZXhjbHVkaW5nIG90aGVyIGFwcHMnIGFuZCBsb29rYWxpa2UgZ3JvdXBzLlxuICovXG5mdW5jdGlvbiBkaXNjb3ZlclNvdXJjZXMoc2NvcGU6IENvbnN0cnVjdCwgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcHJlZml4ID0gY29udGV4dC5sb2dTb3VyY2VQcmVmaXgoKTtcbiAgY29uc3Qgc291cmNlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IG5vZGUgb2YgU3RhY2sub2Yoc2NvcGUpLm5vZGUuZmluZEFsbCgpKSB7XG4gICAgLy8gUmVhZCB0aGUgTDEgcHJvcGVydHk6IHRoZSBMMiBnZXR0ZXIgcmV0dXJucyBhIHRva2VuIGV2ZW4gZm9yIGEgY29uY3JldGVcbiAgICAvLyBuYW1lLCBiZWNhdXNlIGl0IHJlc29sdmVzIHRoZSBwaHlzaWNhbCBuYW1lIGR1cmluZyBzeW50aGVzaXMuXG4gICAgaWYgKCEobm9kZSBpbnN0YW5jZW9mIGxvZ3MuQ2ZuTG9nR3JvdXApKSBjb250aW51ZTtcbiAgICBjb25zdCBuYW1lID0gbm9kZS5sb2dHcm91cE5hbWU7XG4gICAgaWYgKHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiIHx8IFRva2VuLmlzVW5yZXNvbHZlZChuYW1lKSB8fCAhbmFtZS5zdGFydHNXaXRoKHByZWZpeCkpIGNvbnRpbnVlO1xuICAgIHNvdXJjZXMuYWRkKG5hbWUuc2xpY2UocHJlZml4Lmxlbmd0aCkucmVwbGFjZSgvXy9nLCBcIi9cIikpO1xuICB9XG4gIHJldHVybiBbLi4uc291cmNlc10uc29ydCgpO1xufVxuIl19