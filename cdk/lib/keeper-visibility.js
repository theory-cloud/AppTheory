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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryKeeperVisibility", version: "7.5.0" };
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
        const readerAccount = readerAccountFromArn(props.readerPrincipalArn);
        this.readerRole = new iam.Role(this, "ReaderRole", {
            roleName: context.physicalName("iam_role", "keeper-reader").name,
            // r3 (contract section 6): name the reader's account as the principal and
            // restrict it with `aws:PrincipalArn`. AWS rewrites a role ARN in a trust
            // Principal to the role's unique ID, so a direct role-ARN principal breaks
            // when Keeper deletes and recreates its role. The condition key is not
            // rewritten, so the trust survives that cycle and deploys before Keeper's
            // role exists.
            assumedBy: new ReaderRolePrincipal(readerAccount, props.readerPrincipalArn),
            description: `Keeper reader role for ${context.app}/${context.stage}`,
            inlinePolicies: { Visibility: document },
        });
        // Contract section 11.4: declare the resource carrying the composed name.
        context.declareName("iam_role", "keeper-reader", this.readerRole);
        const memo = {};
        this.previewProvider = () => {
            if (!memo.preview) {
                const sources = props.sources ?? discoverSources(this, context);
                memo.preview = naming_1.AppTheoryResourceNaming.visibilityPreview(context.values(), rules, sources);
            }
            return memo.preview;
        };
        aws_cdk_lib_1.Aspects.of(aws_cdk_lib_1.Stack.of(this)).add(new VisibilityPreviewAnnotation(this, () => {
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
        }));
        const tier = props.manifestTier ?? AppTheoryVisibilityManifestTier.STANDARD;
        const limit = MANIFEST_VALUE_LIMIT[tier];
        const parameterName = manifestParameterName(context);
        this.manifestParameter = new ssm.StringParameter(this, "ManifestParameter", {
            parameterName,
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
        // Contract section 11.4: the manifest parameter's name is the fixed section
        // 6 path, not a derived one, so it declares through the fixed-name path and
        // the artifact carries it. Two visibility constructs in one context would
        // otherwise contend for one parameter with no synth-time sign.
        context.declareFixedName("ssm_parameter", parameterName, this.manifestParameter);
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
 * Render the visibility preview as a concrete info annotation once the
 * construct tree is complete. Annotations are not resolved like template
 * tokens, so a `Lazy.string` prints `${Token[...]}`. The aspect computes the
 * preview at synthesis and adds the rendered text instead.
 */
class VisibilityPreviewAnnotation {
    owner;
    render;
    emitted = false;
    constructor(owner, render) {
        this.owner = owner;
        this.render = render;
    }
    visit(_node) {
        if (this.emitted)
            return;
        this.emitted = true;
        aws_cdk_lib_1.Annotations.of(this.owner).addInfo(this.render());
    }
}
/**
 * The reader-role trust principal: the reader account as `Principal`, restricted
 * with an `aws:PrincipalArn` condition on Keeper's role ARN. Naming the account
 * rather than the role ARN keeps the trust valid across a delete-and-recreate of
 * Keeper's role, because AWS converts a role ARN in a trust `Principal` to the
 * role's unique ID but does not convert condition-key ARNs.
 */
class ReaderRolePrincipal {
    principalArn;
    grantPrincipal = this;
    assumeRoleAction = "sts:AssumeRole";
    principalAccount;
    delegate;
    constructor(account, principalArn) {
        this.principalArn = principalArn;
        this.principalAccount = account;
        // The literal `arn:aws:iam::{account}:root` matches the contract's
        // `Principal: {"AWS": ...}` shape rather than a partition token.
        this.delegate = new iam.ArnPrincipal(`arn:aws:iam::${account}:root`);
    }
    get policyFragment() {
        return this.delegate.policyFragment;
    }
    addToPolicy(statement) {
        return this.delegate.addToPolicy(statement);
    }
    addToPrincipalPolicy(statement) {
        return this.delegate.addToPrincipalPolicy(statement);
    }
    addToAssumeRolePolicy(document) {
        document.addStatements(new iam.PolicyStatement({
            actions: [this.assumeRoleAction],
            principals: [this.delegate],
            conditions: { ArnEquals: { "aws:PrincipalArn": this.principalArn } },
        }));
    }
}
const READER_PRINCIPAL_ARN_RE = /^arn:aws:iam::([0-9]{12}):role\/.+$/;
/**
 * Parse the reader account from Keeper's runtime role ARN. The trust policy
 * needs the account as its principal, and an unresolved token or a malformed
 * ARN cannot be validated at synthesis.
 */
function readerAccountFromArn(arn) {
    if (aws_cdk_lib_1.Token.isUnresolved(arn)) {
        throw new Error("AppTheoryKeeperVisibility requires a resolved readerPrincipalArn; the reader account is parsed from it and an unresolved token cannot be validated at synthesis");
    }
    // The reader trust restricts the account principal with `ArnEquals` on
    // `aws:PrincipalArn`; `ArnEquals` matches `*` and `?`, so a wildcard would
    // admit every role the pattern matches (FAC-1312-R1-1).
    if (arn.includes("*") || arn.includes("?")) {
        throw new Error(`AppTheoryKeeperVisibility readerPrincipalArn must not contain a wildcard (got ${JSON.stringify(arn)}); the reader trust uses ArnEquals on aws:PrincipalArn, which matches wildcards and would admit every role the pattern matches`);
    }
    const match = READER_PRINCIPAL_ARN_RE.exec(arn);
    if (!match) {
        throw new Error(`AppTheoryKeeperVisibility readerPrincipalArn must be an arn:aws:iam::<12 digits>:role/... ARN (got ${JSON.stringify(arn)})`);
    }
    return match[1];
}
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia2VlcGVyLXZpc2liaWxpdHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJrZWVwZXItdmlzaWJpbGl0eS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQWdGO0FBQ2hGLHlEQUEyQztBQUMzQywyREFBNkM7QUFDN0MseURBQTJDO0FBQzNDLDJDQUFtRDtBQUVuRCxxQ0FJa0I7QUFHbEI7O0dBRUc7QUFDSCxJQUFZLCtCQVVYO0FBVkQsV0FBWSwrQkFBK0I7SUFDekM7O09BRUc7SUFDSCx3REFBcUIsQ0FBQTtJQUVyQjs7T0FFRztJQUNILHdEQUFxQixDQUFBO0FBQ3ZCLENBQUMsRUFWVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQVUxQztBQUVELE1BQU0sb0JBQW9CLEdBQStCO0lBQ3ZELENBQUMsK0JBQStCLENBQUMsUUFBUSxDQUFDLEVBQUUsSUFBSTtJQUNoRCxDQUFDLCtCQUErQixDQUFDLFFBQVEsQ0FBQyxFQUFFLElBQUk7Q0FDakQsQ0FBQztBQW1DRjs7Ozs7R0FLRztBQUNILE1BQWEseUJBQTBCLFNBQVEsc0JBQVM7O0lBQ3REOztPQUVHO0lBQ2EsVUFBVSxDQUFXO0lBRXJDOztPQUVHO0lBQ2EsaUJBQWlCLENBQXNCO0lBRXRDLGVBQWUsQ0FBbUM7SUFFbkUsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFxQztRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxhQUFhLENBQUM7UUFDcEMsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQztRQUUxQixzRUFBc0U7UUFDdEUsZ0NBQXVCLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUV2RSxNQUFNLFVBQVUsR0FBRyxnQ0FBdUIsQ0FB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QUM1RCxPQUFPLDJCQUEyQixPQUFPLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxLQUFLLFdBQVcsQ0FBQztBQUM1RSxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsU0FBUyxlQUFlLENBQUMsS0FBZ0IsRUFBRSxPQUErQjtJQUN4RSxNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsZUFBZSxFQUFFLENBQUM7SUFDekMsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUNsQyxLQUFLLE1BQU0sSUFBSSxJQUFJLG1CQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO1FBQ2xELDBFQUEwRTtRQUMxRSxnRUFBZ0U7UUFDaEUsSUFBSSxDQUFDLENBQUMsSUFBSSxZQUFZLElBQUksQ0FBQyxXQUFXLENBQUM7WUFBRSxTQUFTO1FBQ2xELE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUM7UUFDL0IsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksbUJBQUssQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQztZQUFFLFNBQVM7UUFDL0YsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDNUQsQ0FBQztJQUNELE9BQU8sQ0FBQyxHQUFHLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzdCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBbm5vdGF0aW9ucywgQXNwZWN0cywgSUFzcGVjdCwgTGF6eSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyBzc20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1zc21cIjtcbmltcG9ydCB7IENvbnN0cnVjdCwgSUNvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7XG4gIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLFxuICB0eXBlIEFwcFRoZW9yeVZpc2liaWxpdHlQcmV2aWV3LFxuICB0eXBlIEFwcFRoZW9yeVZpc2liaWxpdHlSdWxlcyxcbn0gZnJvbSBcIi4vbmFtaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuXG4vKipcbiAqIFRoZSBTU00gcGFyYW1ldGVyIHRpZXIgb2YgdGhlIHB1Ymxpc2hlZCB2aXNpYmlsaXR5IG1hbmlmZXN0LlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3RUaWVyIHtcbiAgLyoqXG4gICAqIFN0YW5kYXJkIHRpZXI6IGEgNDA5Ni1jaGFyYWN0ZXIgdmFsdWUgbGltaXQuXG4gICAqL1xuICBTVEFOREFSRCA9IFwic3RhbmRhcmRcIixcblxuICAvKipcbiAgICogQWR2YW5jZWQgdGllcjogYW4gODE5Mi1jaGFyYWN0ZXIgdmFsdWUgbGltaXQuXG4gICAqL1xuICBBRFZBTkNFRCA9IFwiYWR2YW5jZWRcIixcbn1cblxuY29uc3QgTUFOSUZFU1RfVkFMVUVfTElNSVQ6IHsgW3RpZXI6IHN0cmluZ106IG51bWJlciB9ID0ge1xuICBbQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0VGllci5TVEFOREFSRF06IDQwOTYsXG4gIFtBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3RUaWVyLkFEVkFOQ0VEXTogODE5Mixcbn07XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgYW4gYEFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHlgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHlQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtaW5nIGNvbnRleHQuIEl0cyBhcHAsIHN0YWdlIGFuZCBsb2ctc291cmNlIHByZWZpeCBiaW5kIGV2ZXJ5IHJ1bGUuXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgcHJpbmNpcGFsIGFsbG93ZWQgdG8gYXNzdW1lIHRoZSByZWFkZXIgcm9sZTogS2VlcGVyJ3MgcnVudGltZSByb2xlIEFSTi5cbiAgICovXG4gIHJlYWRvbmx5IHJlYWRlclByaW5jaXBhbEFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29uc3VtZXIncyBpbmNsdWRlIGFuZCBleGNsdWRlIHNlbGVjdG9ycy5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bGVzOiBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXM7XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IGxvZ2ljYWwgc291cmNlcy4gV2hlbiBvbWl0dGVkIHRoZSBzdGFjaydzIGRlY2xhcmVkIGxvZyBncm91cHMgYXJlXG4gICAqIGRpc2NvdmVyZWQgYXQgc3ludGhlc2lzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHNvdXJjZXM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIFNTTSBwYXJhbWV0ZXIgdGllciBvZiB0aGUgbWFuaWZlc3QuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdFRpZXIuU1RBTkRBUkRcbiAgICovXG4gIHJlYWRvbmx5IG1hbmlmZXN0VGllcj86IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdFRpZXI7XG59XG5cbi8qKlxuICogVGhlIHJlYWRlciByb2xlLCBjb21waWxlZCBwb2xpY3kgYW5kIG1hbmlmZXN0IGEgY29uc3VtZXIgc2hhcmVzIHdpdGggS2VlcGVyLlxuICpcbiAqIENyZWF0ZSB0aGlzIGNvbnN0cnVjdCBvbmx5IHdoZW4gdGhlIGNvbnN1bWVyIHBhc3NlcyBhIHJlYWRlciBwcmluY2lwYWwgYW5kXG4gKiBydWxlczsgd2l0aCBubyB2aXNpYmlsaXR5IGJsb2NrIG5vIHJvbGUsIHBvbGljeSBvciBtYW5pZmVzdCBpcyBjcmVhdGVkLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5S2VlcGVyVmlzaWJpbGl0eSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBUaGUgcmVhZGVyIHJvbGUgS2VlcGVyIGFzc3VtZXMuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcmVhZGVyUm9sZTogaWFtLlJvbGU7XG5cbiAgLyoqXG4gICAqIFRoZSBTU00gcGFyYW1ldGVyIGhvbGRpbmcgdGhlIG1hbmlmZXN0LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1hbmlmZXN0UGFyYW1ldGVyOiBzc20uU3RyaW5nUGFyYW1ldGVyO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgcHJldmlld1Byb3ZpZGVyOiAoKSA9PiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5S2VlcGVyVmlzaWJpbGl0eVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IGNvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgIGNvbnN0IHJ1bGVzID0gcHJvcHMucnVsZXM7XG5cbiAgICAvLyBWYWxpZGF0ZSB0aGUgc2VsZWN0b3JzIGFuZCBmYWlsIHN5bnRoZXNpcyBiZWZvcmUgY3JlYXRpbmcgYW55dGhpbmcuXG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmlzaWJpbGl0eVByZXZpZXcoY29udGV4dC52YWx1ZXMoKSwgcnVsZXMsIFtdKTtcblxuICAgIGNvbnN0IHBvbGljeUpzb24gPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5jb21waWxlVmlzaWJpbGl0eVBvbGljeUpzb24oY29udGV4dC52YWx1ZXMoKSwgcnVsZXMpO1xuICAgIGNvbnN0IGRvY3VtZW50ID0gaWFtLlBvbGljeURvY3VtZW50LmZyb21Kc29uKEpTT04ucGFyc2UocG9saWN5SnNvbikgYXMgeyBba2V5OiBzdHJpbmddOiB1bmtub3duIH0pO1xuICAgIGNvbnN0IHJlYWRlckFjY291bnQgPSByZWFkZXJBY2NvdW50RnJvbUFybihwcm9wcy5yZWFkZXJQcmluY2lwYWxBcm4pO1xuXG4gICAgdGhpcy5yZWFkZXJSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiUmVhZGVyUm9sZVwiLCB7XG4gICAgICByb2xlTmFtZTogY29udGV4dC5waHlzaWNhbE5hbWUoXCJpYW1fcm9sZVwiLCBcImtlZXBlci1yZWFkZXJcIikubmFtZSxcbiAgICAgIC8vIHIzIChjb250cmFjdCBzZWN0aW9uIDYpOiBuYW1lIHRoZSByZWFkZXIncyBhY2NvdW50IGFzIHRoZSBwcmluY2lwYWwgYW5kXG4gICAgICAvLyByZXN0cmljdCBpdCB3aXRoIGBhd3M6UHJpbmNpcGFsQXJuYC4gQVdTIHJld3JpdGVzIGEgcm9sZSBBUk4gaW4gYSB0cnVzdFxuICAgICAgLy8gUHJpbmNpcGFsIHRvIHRoZSByb2xlJ3MgdW5pcXVlIElELCBzbyBhIGRpcmVjdCByb2xlLUFSTiBwcmluY2lwYWwgYnJlYWtzXG4gICAgICAvLyB3aGVuIEtlZXBlciBkZWxldGVzIGFuZCByZWNyZWF0ZXMgaXRzIHJvbGUuIFRoZSBjb25kaXRpb24ga2V5IGlzIG5vdFxuICAgICAgLy8gcmV3cml0dGVuLCBzbyB0aGUgdHJ1c3Qgc3Vydml2ZXMgdGhhdCBjeWNsZSBhbmQgZGVwbG95cyBiZWZvcmUgS2VlcGVyJ3NcbiAgICAgIC8vIHJvbGUgZXhpc3RzLlxuICAgICAgYXNzdW1lZEJ5OiBuZXcgUmVhZGVyUm9sZVByaW5jaXBhbChyZWFkZXJBY2NvdW50LCBwcm9wcy5yZWFkZXJQcmluY2lwYWxBcm4pLFxuICAgICAgZGVzY3JpcHRpb246IGBLZWVwZXIgcmVhZGVyIHJvbGUgZm9yICR7Y29udGV4dC5hcHB9LyR7Y29udGV4dC5zdGFnZX1gLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHsgVmlzaWJpbGl0eTogZG9jdW1lbnQgfSxcbiAgICB9KTtcbiAgICAvLyBDb250cmFjdCBzZWN0aW9uIDExLjQ6IGRlY2xhcmUgdGhlIHJlc291cmNlIGNhcnJ5aW5nIHRoZSBjb21wb3NlZCBuYW1lLlxuICAgIGNvbnRleHQuZGVjbGFyZU5hbWUoXCJpYW1fcm9sZVwiLCBcImtlZXBlci1yZWFkZXJcIiwgdGhpcy5yZWFkZXJSb2xlKTtcblxuICAgIGNvbnN0IG1lbW86IHsgcHJldmlldz86IEFwcFRoZW9yeVZpc2liaWxpdHlQcmV2aWV3IH0gPSB7fTtcbiAgICB0aGlzLnByZXZpZXdQcm92aWRlciA9ICgpID0+IHtcbiAgICAgIGlmICghbWVtby5wcmV2aWV3KSB7XG4gICAgICAgIGNvbnN0IHNvdXJjZXMgPSBwcm9wcy5zb3VyY2VzID8/IGRpc2NvdmVyU291cmNlcyh0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgbWVtby5wcmV2aWV3ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmlzaWJpbGl0eVByZXZpZXcoY29udGV4dC52YWx1ZXMoKSwgcnVsZXMsIHNvdXJjZXMpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG1lbW8ucHJldmlldztcbiAgICB9O1xuXG4gICAgQXNwZWN0cy5vZihTdGFjay5vZih0aGlzKSkuYWRkKFxuICAgICAgbmV3IFZpc2liaWxpdHlQcmV2aWV3QW5ub3RhdGlvbih0aGlzLCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHByZXZpZXcgPSB0aGlzLnByZXZpZXdQcm92aWRlcigpO1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgIGBBcHBUaGVvcnkga2VlcGVyIHZpc2liaWxpdHkgcHJldmlldyBmb3IgJHtjb250ZXh0LmFwcH0vJHtjb250ZXh0LnN0YWdlfTpgLFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIHJ1bGVfdmVyc2lvbjogcHJldmlldy5ydWxlVmVyc2lvbixcbiAgICAgICAgICAgIG1hdGNoZWRfbm93OiBwcmV2aWV3Lm1hdGNoZWROb3csXG4gICAgICAgICAgICBub3RfbWF0Y2hlZF9ub3c6IHByZXZpZXcubm90TWF0Y2hlZE5vdyxcbiAgICAgICAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBwcmV2aWV3LmZ1dHVyZS5pbmNsdWRlID8/IFtdLCBleGNsdWRlOiBwcmV2aWV3LmZ1dHVyZS5leGNsdWRlID8/IFtdIH0sXG4gICAgICAgICAgfSksXG4gICAgICAgIF0uam9pbihcIiBcIik7XG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgY29uc3QgdGllciA9IHByb3BzLm1hbmlmZXN0VGllciA/PyBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3RUaWVyLlNUQU5EQVJEO1xuICAgIGNvbnN0IGxpbWl0ID0gTUFOSUZFU1RfVkFMVUVfTElNSVRbdGllcl07XG4gICAgY29uc3QgcGFyYW1ldGVyTmFtZSA9IG1hbmlmZXN0UGFyYW1ldGVyTmFtZShjb250ZXh0KTtcbiAgICB0aGlzLm1hbmlmZXN0UGFyYW1ldGVyID0gbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgXCJNYW5pZmVzdFBhcmFtZXRlclwiLCB7XG4gICAgICBwYXJhbWV0ZXJOYW1lLFxuICAgICAgdGllcjogdGllciA9PT0gQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0VGllci5BRFZBTkNFRCA/IHNzbS5QYXJhbWV0ZXJUaWVyLkFEVkFOQ0VEIDogc3NtLlBhcmFtZXRlclRpZXIuU1RBTkRBUkQsXG4gICAgICBzdHJpbmdWYWx1ZTogTGF6eS5zdHJpbmcoe1xuICAgICAgICBwcm9kdWNlOiAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcHJldmlldyA9IHRoaXMucHJldmlld1Byb3ZpZGVyKCk7XG4gICAgICAgICAgY29uc3QganNvbiA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLm1hbmlmZXN0SnNvbih7XG4gICAgICAgICAgICBydWxlVmVyc2lvbjogcHJldmlldy5ydWxlVmVyc2lvbixcbiAgICAgICAgICAgIG1hdGNoZWROb3c6IHByZXZpZXcubWF0Y2hlZE5vdyxcbiAgICAgICAgICAgIGZ1dHVyZTogcHJldmlldy5mdXR1cmUsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgaWYgKGpzb24ubGVuZ3RoID4gbGltaXQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYEFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHkgbWFuaWZlc3QgaXMgJHtqc29uLmxlbmd0aH0gY2hhcmFjdGVycywgb3ZlciB0aGUgJHt0aWVyfSBTU00gcGFyYW1ldGVyIHZhbHVlIGxpbWl0IG9mICR7bGltaXR9OyByZWR1Y2UgdGhlIHJ1bGUgc2V0IG9yIHVzZSB0aGUgYWR2YW5jZWQgdGllcmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ganNvbjtcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgIH0pO1xuICAgIC8vIENvbnRyYWN0IHNlY3Rpb24gMTEuNDogdGhlIG1hbmlmZXN0IHBhcmFtZXRlcidzIG5hbWUgaXMgdGhlIGZpeGVkIHNlY3Rpb25cbiAgICAvLyA2IHBhdGgsIG5vdCBhIGRlcml2ZWQgb25lLCBzbyBpdCBkZWNsYXJlcyB0aHJvdWdoIHRoZSBmaXhlZC1uYW1lIHBhdGggYW5kXG4gICAgLy8gdGhlIGFydGlmYWN0IGNhcnJpZXMgaXQuIFR3byB2aXNpYmlsaXR5IGNvbnN0cnVjdHMgaW4gb25lIGNvbnRleHQgd291bGRcbiAgICAvLyBvdGhlcndpc2UgY29udGVuZCBmb3Igb25lIHBhcmFtZXRlciB3aXRoIG5vIHN5bnRoLXRpbWUgc2lnbi5cbiAgICBjb250ZXh0LmRlY2xhcmVGaXhlZE5hbWUoXCJzc21fcGFyYW1ldGVyXCIsIHBhcmFtZXRlck5hbWUsIHRoaXMubWFuaWZlc3RQYXJhbWV0ZXIpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBzeW50aC10aW1lIHByZXZpZXcsIGluY2x1ZGluZyB0aGUgc291cmNlcyB0aGUgcnVsZXMgZG8gbm90IG1hdGNoIHlldC5cbiAgICovXG4gIHB1YmxpYyBwcmV2aWV3KCk6IEFwcFRoZW9yeVZpc2liaWxpdHlQcmV2aWV3IHtcbiAgICByZXR1cm4gdGhpcy5wcmV2aWV3UHJvdmlkZXIoKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlbmRlciB0aGUgdmlzaWJpbGl0eSBwcmV2aWV3IGFzIGEgY29uY3JldGUgaW5mbyBhbm5vdGF0aW9uIG9uY2UgdGhlXG4gKiBjb25zdHJ1Y3QgdHJlZSBpcyBjb21wbGV0ZS4gQW5ub3RhdGlvbnMgYXJlIG5vdCByZXNvbHZlZCBsaWtlIHRlbXBsYXRlXG4gKiB0b2tlbnMsIHNvIGEgYExhenkuc3RyaW5nYCBwcmludHMgYCR7VG9rZW5bLi4uXX1gLiBUaGUgYXNwZWN0IGNvbXB1dGVzIHRoZVxuICogcHJldmlldyBhdCBzeW50aGVzaXMgYW5kIGFkZHMgdGhlIHJlbmRlcmVkIHRleHQgaW5zdGVhZC5cbiAqL1xuY2xhc3MgVmlzaWJpbGl0eVByZXZpZXdBbm5vdGF0aW9uIGltcGxlbWVudHMgSUFzcGVjdCB7XG4gIHByaXZhdGUgZW1pdHRlZCA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgb3duZXI6IENvbnN0cnVjdCwgcHJpdmF0ZSByZWFkb25seSByZW5kZXI6ICgpID0+IHN0cmluZykge31cblxuICBwdWJsaWMgdmlzaXQoX25vZGU6IElDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5lbWl0dGVkKSByZXR1cm47XG4gICAgdGhpcy5lbWl0dGVkID0gdHJ1ZTtcbiAgICBBbm5vdGF0aW9ucy5vZih0aGlzLm93bmVyKS5hZGRJbmZvKHRoaXMucmVuZGVyKCkpO1xuICB9XG59XG5cbi8qKlxuICogVGhlIHJlYWRlci1yb2xlIHRydXN0IHByaW5jaXBhbDogdGhlIHJlYWRlciBhY2NvdW50IGFzIGBQcmluY2lwYWxgLCByZXN0cmljdGVkXG4gKiB3aXRoIGFuIGBhd3M6UHJpbmNpcGFsQXJuYCBjb25kaXRpb24gb24gS2VlcGVyJ3Mgcm9sZSBBUk4uIE5hbWluZyB0aGUgYWNjb3VudFxuICogcmF0aGVyIHRoYW4gdGhlIHJvbGUgQVJOIGtlZXBzIHRoZSB0cnVzdCB2YWxpZCBhY3Jvc3MgYSBkZWxldGUtYW5kLXJlY3JlYXRlIG9mXG4gKiBLZWVwZXIncyByb2xlLCBiZWNhdXNlIEFXUyBjb252ZXJ0cyBhIHJvbGUgQVJOIGluIGEgdHJ1c3QgYFByaW5jaXBhbGAgdG8gdGhlXG4gKiByb2xlJ3MgdW5pcXVlIElEIGJ1dCBkb2VzIG5vdCBjb252ZXJ0IGNvbmRpdGlvbi1rZXkgQVJOcy5cbiAqL1xuY2xhc3MgUmVhZGVyUm9sZVByaW5jaXBhbCBpbXBsZW1lbnRzIGlhbS5JQXNzdW1lUm9sZVByaW5jaXBhbCB7XG4gIHB1YmxpYyByZWFkb25seSBncmFudFByaW5jaXBhbDogaWFtLklQcmluY2lwYWwgPSB0aGlzO1xuICBwdWJsaWMgcmVhZG9ubHkgYXNzdW1lUm9sZUFjdGlvbiA9IFwic3RzOkFzc3VtZVJvbGVcIjtcbiAgcHVibGljIHJlYWRvbmx5IHByaW5jaXBhbEFjY291bnQ6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBkZWxlZ2F0ZTogaWFtLkFyblByaW5jaXBhbDtcblxuICBjb25zdHJ1Y3RvcihhY2NvdW50OiBzdHJpbmcsIHByaXZhdGUgcmVhZG9ubHkgcHJpbmNpcGFsQXJuOiBzdHJpbmcpIHtcbiAgICB0aGlzLnByaW5jaXBhbEFjY291bnQgPSBhY2NvdW50O1xuICAgIC8vIFRoZSBsaXRlcmFsIGBhcm46YXdzOmlhbTo6e2FjY291bnR9OnJvb3RgIG1hdGNoZXMgdGhlIGNvbnRyYWN0J3NcbiAgICAvLyBgUHJpbmNpcGFsOiB7XCJBV1NcIjogLi4ufWAgc2hhcGUgcmF0aGVyIHRoYW4gYSBwYXJ0aXRpb24gdG9rZW4uXG4gICAgdGhpcy5kZWxlZ2F0ZSA9IG5ldyBpYW0uQXJuUHJpbmNpcGFsKGBhcm46YXdzOmlhbTo6JHthY2NvdW50fTpyb290YCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0IHBvbGljeUZyYWdtZW50KCk6IGlhbS5QcmluY2lwYWxQb2xpY3lGcmFnbWVudCB7XG4gICAgcmV0dXJuIHRoaXMuZGVsZWdhdGUucG9saWN5RnJhZ21lbnQ7XG4gIH1cblxuICBwdWJsaWMgYWRkVG9Qb2xpY3koc3RhdGVtZW50OiBpYW0uUG9saWN5U3RhdGVtZW50KTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuZGVsZWdhdGUuYWRkVG9Qb2xpY3koc3RhdGVtZW50KTtcbiAgfVxuXG4gIHB1YmxpYyBhZGRUb1ByaW5jaXBhbFBvbGljeShzdGF0ZW1lbnQ6IGlhbS5Qb2xpY3lTdGF0ZW1lbnQpOiBpYW0uQWRkVG9QcmluY2lwYWxQb2xpY3lSZXN1bHQge1xuICAgIHJldHVybiB0aGlzLmRlbGVnYXRlLmFkZFRvUHJpbmNpcGFsUG9saWN5KHN0YXRlbWVudCk7XG4gIH1cblxuICBwdWJsaWMgYWRkVG9Bc3N1bWVSb2xlUG9saWN5KGRvY3VtZW50OiBpYW0uUG9saWN5RG9jdW1lbnQpOiB2b2lkIHtcbiAgICBkb2N1bWVudC5hZGRTdGF0ZW1lbnRzKFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbdGhpcy5hc3N1bWVSb2xlQWN0aW9uXSxcbiAgICAgICAgcHJpbmNpcGFsczogW3RoaXMuZGVsZWdhdGVdLFxuICAgICAgICBjb25kaXRpb25zOiB7IEFybkVxdWFsczogeyBcImF3czpQcmluY2lwYWxBcm5cIjogdGhpcy5wcmluY2lwYWxBcm4gfSB9LFxuICAgICAgfSksXG4gICAgKTtcbiAgfVxufVxuXG5jb25zdCBSRUFERVJfUFJJTkNJUEFMX0FSTl9SRSA9IC9eYXJuOmF3czppYW06OihbMC05XXsxMn0pOnJvbGVcXC8uKyQvO1xuXG4vKipcbiAqIFBhcnNlIHRoZSByZWFkZXIgYWNjb3VudCBmcm9tIEtlZXBlcidzIHJ1bnRpbWUgcm9sZSBBUk4uIFRoZSB0cnVzdCBwb2xpY3lcbiAqIG5lZWRzIHRoZSBhY2NvdW50IGFzIGl0cyBwcmluY2lwYWwsIGFuZCBhbiB1bnJlc29sdmVkIHRva2VuIG9yIGEgbWFsZm9ybWVkXG4gKiBBUk4gY2Fubm90IGJlIHZhbGlkYXRlZCBhdCBzeW50aGVzaXMuXG4gKi9cbmZ1bmN0aW9uIHJlYWRlckFjY291bnRGcm9tQXJuKGFybjogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChhcm4pKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlLZWVwZXJWaXNpYmlsaXR5IHJlcXVpcmVzIGEgcmVzb2x2ZWQgcmVhZGVyUHJpbmNpcGFsQXJuOyB0aGUgcmVhZGVyIGFjY291bnQgaXMgcGFyc2VkIGZyb20gaXQgYW5kIGFuIHVucmVzb2x2ZWQgdG9rZW4gY2Fubm90IGJlIHZhbGlkYXRlZCBhdCBzeW50aGVzaXNcIixcbiAgICApO1xuICB9XG4gIC8vIFRoZSByZWFkZXIgdHJ1c3QgcmVzdHJpY3RzIHRoZSBhY2NvdW50IHByaW5jaXBhbCB3aXRoIGBBcm5FcXVhbHNgIG9uXG4gIC8vIGBhd3M6UHJpbmNpcGFsQXJuYDsgYEFybkVxdWFsc2AgbWF0Y2hlcyBgKmAgYW5kIGA/YCwgc28gYSB3aWxkY2FyZCB3b3VsZFxuICAvLyBhZG1pdCBldmVyeSByb2xlIHRoZSBwYXR0ZXJuIG1hdGNoZXMgKEZBQy0xMzEyLVIxLTEpLlxuICBpZiAoYXJuLmluY2x1ZGVzKFwiKlwiKSB8fCBhcm4uaW5jbHVkZXMoXCI/XCIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHkgcmVhZGVyUHJpbmNpcGFsQXJuIG11c3Qgbm90IGNvbnRhaW4gYSB3aWxkY2FyZCAoZ290ICR7SlNPTi5zdHJpbmdpZnkoYXJuKX0pOyB0aGUgcmVhZGVyIHRydXN0IHVzZXMgQXJuRXF1YWxzIG9uIGF3czpQcmluY2lwYWxBcm4sIHdoaWNoIG1hdGNoZXMgd2lsZGNhcmRzIGFuZCB3b3VsZCBhZG1pdCBldmVyeSByb2xlIHRoZSBwYXR0ZXJuIG1hdGNoZXNgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgbWF0Y2ggPSBSRUFERVJfUFJJTkNJUEFMX0FSTl9SRS5leGVjKGFybik7XG4gIGlmICghbWF0Y2gpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5S2VlcGVyVmlzaWJpbGl0eSByZWFkZXJQcmluY2lwYWxBcm4gbXVzdCBiZSBhbiBhcm46YXdzOmlhbTo6PDEyIGRpZ2l0cz46cm9sZS8uLi4gQVJOIChnb3QgJHtKU09OLnN0cmluZ2lmeShhcm4pfSlgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG1hdGNoWzFdO1xufVxuXG4vKipcbiAqIFRoZSBjb250cmFjdCdzIG1hbmlmZXN0IHBhcmFtZXRlciBuYW1lLlxuICovXG5mdW5jdGlvbiBtYW5pZmVzdFBhcmFtZXRlck5hbWUoY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCk6IHN0cmluZyB7XG4gIHJldHVybiBgL3RoZW9yeWNsb3VkL3Zpc2liaWxpdHkvJHtjb250ZXh0LmFwcH0vJHtjb250ZXh0LnN0YWdlfS9tYW5pZmVzdGA7XG59XG5cbi8qKlxuICogRGlzY292ZXIgdGhlIGxvZ2ljYWwgc291cmNlcyBvZiB0aGUgbG9nIGdyb3VwcyB0aGlzIHN0YWNrIGRlY2xhcmVzIHVuZGVyIHRoZVxuICogYXBwJ3MgYm91bmQgcHJlZml4LCBleGNsdWRpbmcgb3RoZXIgYXBwcycgYW5kIGxvb2thbGlrZSBncm91cHMuXG4gKi9cbmZ1bmN0aW9uIGRpc2NvdmVyU291cmNlcyhzY29wZTogQ29uc3RydWN0LCBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0KTogc3RyaW5nW10ge1xuICBjb25zdCBwcmVmaXggPSBjb250ZXh0LmxvZ1NvdXJjZVByZWZpeCgpO1xuICBjb25zdCBzb3VyY2VzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3Qgbm9kZSBvZiBTdGFjay5vZihzY29wZSkubm9kZS5maW5kQWxsKCkpIHtcbiAgICAvLyBSZWFkIHRoZSBMMSBwcm9wZXJ0eTogdGhlIEwyIGdldHRlciByZXR1cm5zIGEgdG9rZW4gZXZlbiBmb3IgYSBjb25jcmV0ZVxuICAgIC8vIG5hbWUsIGJlY2F1c2UgaXQgcmVzb2x2ZXMgdGhlIHBoeXNpY2FsIG5hbWUgZHVyaW5nIHN5bnRoZXNpcy5cbiAgICBpZiAoIShub2RlIGluc3RhbmNlb2YgbG9ncy5DZm5Mb2dHcm91cCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IG5hbWUgPSBub2RlLmxvZ0dyb3VwTmFtZTtcbiAgICBpZiAodHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIgfHwgVG9rZW4uaXNVbnJlc29sdmVkKG5hbWUpIHx8ICFuYW1lLnN0YXJ0c1dpdGgocHJlZml4KSkgY29udGludWU7XG4gICAgc291cmNlcy5hZGQobmFtZS5zbGljZShwcmVmaXgubGVuZ3RoKS5yZXBsYWNlKC9fL2csIFwiL1wiKSk7XG4gIH1cbiAgcmV0dXJuIFsuLi5zb3VyY2VzXS5zb3J0KCk7XG59XG4iXX0=