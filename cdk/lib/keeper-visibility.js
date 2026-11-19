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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryKeeperVisibility", version: "7.5.0-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia2VlcGVyLXZpc2liaWxpdHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJrZWVwZXItdmlzaWJpbGl0eS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQThEO0FBQzlELHlEQUEyQztBQUMzQywyREFBNkM7QUFDN0MseURBQTJDO0FBQzNDLDJDQUF1QztBQUV2QyxxQ0FJa0I7QUFHbEI7O0dBRUc7QUFDSCxJQUFZLCtCQVVYO0FBVkQsV0FBWSwrQkFBK0I7SUFDekM7O09BRUc7SUFDSCx3REFBcUIsQ0FBQTtJQUVyQjs7T0FFRztJQUNILHdEQUFxQixDQUFBO0FBQ3ZCLENBQUMsRUFWVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQVUxQztBQUVELE1BQU0sb0JBQW9CLEdBQStCO0lBQ3ZELENBQUMsK0JBQStCLENBQUMsUUFBUSxDQUFDLEVBQUUsSUFBSTtJQUNoRCxDQUFDLCtCQUErQixDQUFDLFFBQVEsQ0FBQyxFQUFFLElBQUk7Q0FDakQsQ0FBQztBQW1DRjs7Ozs7R0FLRztBQUNILE1BQWEseUJBQTBCLFNBQVEsc0JBQVM7O0lBQ3REOztPQUVHO0lBQ2EsVUFBVSxDQUFXO0lBRXJDOztPQUVHO0lBQ2EsaUJBQWlCLENBQXNCO0lBRXRDLGVBQWUsQ0FBbUM7SUFFbkUsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFxQztRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxhQUFhLENBQUM7UUFDcEMsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQztRQUUxQixzRUFBc0U7UUFDdEUsZ0NBQXVCLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUV2RSxNQUFNLFVBQVUsR0FBRyxnQ0FBdUIsQ0FB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LE9BQU8sS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUM7QUFFRDs7R0FFRztBQUNILFNBQVMscUJBQXFCLENBQUMsT0FBK0I7SUFDNUQsT0FBTywyQkFBMkIsT0FBTyxDQUFDLEdBQUcsSUFBSSxPQUFPLENBQUMsS0FBSyxXQUFXLENBQUM7QUFDNUUsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQVMsZUFBZSxDQUFDLEtBQWdCLEVBQUUsT0FBK0I7SUFDeEUsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLGVBQWUsRUFBRSxDQUFDO0lBQ3pDLE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFDbEMsS0FBSyxNQUFNLElBQUksSUFBSSxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQztRQUNsRCwwRUFBMEU7UUFDMUUsZ0VBQWdFO1FBQ2hFLElBQUksQ0FBQyxDQUFDLElBQUksWUFBWSxJQUFJLENBQUMsV0FBVyxDQUFDO1lBQUUsU0FBUztRQUNsRCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDO1FBQy9CLElBQUksT0FBTyxJQUFJLEtBQUssUUFBUSxJQUFJLG1CQUFLLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUM7WUFBRSxTQUFTO1FBQy9GLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQzVELENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxPQUFPLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUM3QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQW5ub3RhdGlvbnMsIExhenksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgc3NtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc3NtXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQge1xuICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZyxcbiAgdHlwZSBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyxcbiAgdHlwZSBBcHBUaGVvcnlWaXNpYmlsaXR5UnVsZXMsXG59IGZyb20gXCIuL25hbWluZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcblxuLyoqXG4gKiBUaGUgU1NNIHBhcmFtZXRlciB0aWVyIG9mIHRoZSBwdWJsaXNoZWQgdmlzaWJpbGl0eSBtYW5pZmVzdC5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0VGllciB7XG4gIC8qKlxuICAgKiBTdGFuZGFyZCB0aWVyOiBhIDQwOTYtY2hhcmFjdGVyIHZhbHVlIGxpbWl0LlxuICAgKi9cbiAgU1RBTkRBUkQgPSBcInN0YW5kYXJkXCIsXG5cbiAgLyoqXG4gICAqIEFkdmFuY2VkIHRpZXI6IGFuIDgxOTItY2hhcmFjdGVyIHZhbHVlIGxpbWl0LlxuICAgKi9cbiAgQURWQU5DRUQgPSBcImFkdmFuY2VkXCIsXG59XG5cbmNvbnN0IE1BTklGRVNUX1ZBTFVFX0xJTUlUOiB7IFt0aWVyOiBzdHJpbmddOiBudW1iZXIgfSA9IHtcbiAgW0FwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdFRpZXIuU1RBTkRBUkRdOiA0MDk2LFxuICBbQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0VGllci5BRFZBTkNFRF06IDgxOTIsXG59O1xuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIGFuIGBBcHBUaGVvcnlLZWVwZXJWaXNpYmlsaXR5YC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlLZWVwZXJWaXNpYmlsaXR5UHJvcHMge1xuICAvKipcbiAgICogVGhlIG5hbWluZyBjb250ZXh0LiBJdHMgYXBwLCBzdGFnZSBhbmQgbG9nLXNvdXJjZSBwcmVmaXggYmluZCBldmVyeSBydWxlLlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogVGhlIHByaW5jaXBhbCBhbGxvd2VkIHRvIGFzc3VtZSB0aGUgcmVhZGVyIHJvbGU6IEtlZXBlcidzIHJ1bnRpbWUgcm9sZSBBUk4uXG4gICAqL1xuICByZWFkb25seSByZWFkZXJQcmluY2lwYWxBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvbnN1bWVyJ3MgaW5jbHVkZSBhbmQgZXhjbHVkZSBzZWxlY3RvcnMuXG4gICAqL1xuICByZWFkb25seSBydWxlczogQXBwVGhlb3J5VmlzaWJpbGl0eVJ1bGVzO1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCBsb2dpY2FsIHNvdXJjZXMuIFdoZW4gb21pdHRlZCB0aGUgc3RhY2sncyBkZWNsYXJlZCBsb2cgZ3JvdXBzIGFyZVxuICAgKiBkaXNjb3ZlcmVkIGF0IHN5bnRoZXNpcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzb3VyY2VzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBTU00gcGFyYW1ldGVyIHRpZXIgb2YgdGhlIG1hbmlmZXN0LlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3RUaWVyLlNUQU5EQVJEXG4gICAqL1xuICByZWFkb25seSBtYW5pZmVzdFRpZXI/OiBBcHBUaGVvcnlWaXNpYmlsaXR5TWFuaWZlc3RUaWVyO1xufVxuXG4vKipcbiAqIFRoZSByZWFkZXIgcm9sZSwgY29tcGlsZWQgcG9saWN5IGFuZCBtYW5pZmVzdCBhIGNvbnN1bWVyIHNoYXJlcyB3aXRoIEtlZXBlci5cbiAqXG4gKiBDcmVhdGUgdGhpcyBjb25zdHJ1Y3Qgb25seSB3aGVuIHRoZSBjb25zdW1lciBwYXNzZXMgYSByZWFkZXIgcHJpbmNpcGFsIGFuZFxuICogcnVsZXM7IHdpdGggbm8gdmlzaWJpbGl0eSBibG9jayBubyByb2xlLCBwb2xpY3kgb3IgbWFuaWZlc3QgaXMgY3JlYXRlZC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogVGhlIHJlYWRlciByb2xlIEtlZXBlciBhc3N1bWVzLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJlYWRlclJvbGU6IGlhbS5Sb2xlO1xuXG4gIC8qKlxuICAgKiBUaGUgU1NNIHBhcmFtZXRlciBob2xkaW5nIHRoZSBtYW5pZmVzdC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtYW5pZmVzdFBhcmFtZXRlcjogc3NtLlN0cmluZ1BhcmFtZXRlcjtcblxuICBwcml2YXRlIHJlYWRvbmx5IHByZXZpZXdQcm92aWRlcjogKCkgPT4gQXBwVGhlb3J5VmlzaWJpbGl0eVByZXZpZXc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHlQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBjb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICBjb25zdCBydWxlcyA9IHByb3BzLnJ1bGVzO1xuXG4gICAgLy8gVmFsaWRhdGUgdGhlIHNlbGVjdG9ycyBhbmQgZmFpbCBzeW50aGVzaXMgYmVmb3JlIGNyZWF0aW5nIGFueXRoaW5nLlxuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZpc2liaWxpdHlQcmV2aWV3KGNvbnRleHQudmFsdWVzKCksIHJ1bGVzLCBbXSk7XG5cbiAgICBjb25zdCBwb2xpY3lKc29uID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuY29tcGlsZVZpc2liaWxpdHlQb2xpY3lKc29uKGNvbnRleHQudmFsdWVzKCksIHJ1bGVzKTtcbiAgICBjb25zdCBkb2N1bWVudCA9IGlhbS5Qb2xpY3lEb2N1bWVudC5mcm9tSnNvbihKU09OLnBhcnNlKHBvbGljeUpzb24pIGFzIHsgW2tleTogc3RyaW5nXTogdW5rbm93biB9KTtcbiAgICBjb25zdCByZWFkZXJBY2NvdW50ID0gcmVhZGVyQWNjb3VudEZyb21Bcm4ocHJvcHMucmVhZGVyUHJpbmNpcGFsQXJuKTtcblxuICAgIHRoaXMucmVhZGVyUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBcIlJlYWRlclJvbGVcIiwge1xuICAgICAgcm9sZU5hbWU6IGNvbnRleHQucGh5c2ljYWxOYW1lKFwiaWFtX3JvbGVcIiwgXCJrZWVwZXItcmVhZGVyXCIpLm5hbWUsXG4gICAgICAvLyByMyAoY29udHJhY3Qgc2VjdGlvbiA2KTogbmFtZSB0aGUgcmVhZGVyJ3MgYWNjb3VudCBhcyB0aGUgcHJpbmNpcGFsIGFuZFxuICAgICAgLy8gcmVzdHJpY3QgaXQgd2l0aCBgYXdzOlByaW5jaXBhbEFybmAuIEFXUyByZXdyaXRlcyBhIHJvbGUgQVJOIGluIGEgdHJ1c3RcbiAgICAgIC8vIFByaW5jaXBhbCB0byB0aGUgcm9sZSdzIHVuaXF1ZSBJRCwgc28gYSBkaXJlY3Qgcm9sZS1BUk4gcHJpbmNpcGFsIGJyZWFrc1xuICAgICAgLy8gd2hlbiBLZWVwZXIgZGVsZXRlcyBhbmQgcmVjcmVhdGVzIGl0cyByb2xlLiBUaGUgY29uZGl0aW9uIGtleSBpcyBub3RcbiAgICAgIC8vIHJld3JpdHRlbiwgc28gdGhlIHRydXN0IHN1cnZpdmVzIHRoYXQgY3ljbGUgYW5kIGRlcGxveXMgYmVmb3JlIEtlZXBlcidzXG4gICAgICAvLyByb2xlIGV4aXN0cy5cbiAgICAgIGFzc3VtZWRCeTogbmV3IFJlYWRlclJvbGVQcmluY2lwYWwocmVhZGVyQWNjb3VudCwgcHJvcHMucmVhZGVyUHJpbmNpcGFsQXJuKSxcbiAgICAgIGRlc2NyaXB0aW9uOiBgS2VlcGVyIHJlYWRlciByb2xlIGZvciAke2NvbnRleHQuYXBwfS8ke2NvbnRleHQuc3RhZ2V9YCxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7IFZpc2liaWxpdHk6IGRvY3VtZW50IH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBtZW1vOiB7IHByZXZpZXc/OiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB9ID0ge307XG4gICAgdGhpcy5wcmV2aWV3UHJvdmlkZXIgPSAoKSA9PiB7XG4gICAgICBpZiAoIW1lbW8ucHJldmlldykge1xuICAgICAgICBjb25zdCBzb3VyY2VzID0gcHJvcHMuc291cmNlcyA/PyBkaXNjb3ZlclNvdXJjZXModGhpcywgY29udGV4dCk7XG4gICAgICAgIG1lbW8ucHJldmlldyA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZpc2liaWxpdHlQcmV2aWV3KGNvbnRleHQudmFsdWVzKCksIHJ1bGVzLCBzb3VyY2VzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBtZW1vLnByZXZpZXc7XG4gICAgfTtcblxuICAgIEFubm90YXRpb25zLm9mKHRoaXMpLmFkZEluZm8oXG4gICAgICBMYXp5LnN0cmluZyh7XG4gICAgICAgIHByb2R1Y2U6ICgpID0+IHtcbiAgICAgICAgICBjb25zdCBwcmV2aWV3ID0gdGhpcy5wcmV2aWV3UHJvdmlkZXIoKTtcbiAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgYEFwcFRoZW9yeSBrZWVwZXIgdmlzaWJpbGl0eSBwcmV2aWV3IGZvciAke2NvbnRleHQuYXBwfS8ke2NvbnRleHQuc3RhZ2V9OmAsXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgIHJ1bGVfdmVyc2lvbjogcHJldmlldy5ydWxlVmVyc2lvbixcbiAgICAgICAgICAgICAgbWF0Y2hlZF9ub3c6IHByZXZpZXcubWF0Y2hlZE5vdyxcbiAgICAgICAgICAgICAgbm90X21hdGNoZWRfbm93OiBwcmV2aWV3Lm5vdE1hdGNoZWROb3csXG4gICAgICAgICAgICAgIGZ1dHVyZTogeyBpbmNsdWRlOiBwcmV2aWV3LmZ1dHVyZS5pbmNsdWRlID8/IFtdLCBleGNsdWRlOiBwcmV2aWV3LmZ1dHVyZS5leGNsdWRlID8/IFtdIH0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLmpvaW4oXCIgXCIpO1xuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGNvbnN0IHRpZXIgPSBwcm9wcy5tYW5pZmVzdFRpZXIgPz8gQXBwVGhlb3J5VmlzaWJpbGl0eU1hbmlmZXN0VGllci5TVEFOREFSRDtcbiAgICBjb25zdCBsaW1pdCA9IE1BTklGRVNUX1ZBTFVFX0xJTUlUW3RpZXJdO1xuICAgIHRoaXMubWFuaWZlc3RQYXJhbWV0ZXIgPSBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBcIk1hbmlmZXN0UGFyYW1ldGVyXCIsIHtcbiAgICAgIHBhcmFtZXRlck5hbWU6IG1hbmlmZXN0UGFyYW1ldGVyTmFtZShjb250ZXh0KSxcbiAgICAgIHRpZXI6IHRpZXIgPT09IEFwcFRoZW9yeVZpc2liaWxpdHlNYW5pZmVzdFRpZXIuQURWQU5DRUQgPyBzc20uUGFyYW1ldGVyVGllci5BRFZBTkNFRCA6IHNzbS5QYXJhbWV0ZXJUaWVyLlNUQU5EQVJELFxuICAgICAgc3RyaW5nVmFsdWU6IExhenkuc3RyaW5nKHtcbiAgICAgICAgcHJvZHVjZTogKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHByZXZpZXcgPSB0aGlzLnByZXZpZXdQcm92aWRlcigpO1xuICAgICAgICAgIGNvbnN0IGpzb24gPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5tYW5pZmVzdEpzb24oe1xuICAgICAgICAgICAgcnVsZVZlcnNpb246IHByZXZpZXcucnVsZVZlcnNpb24sXG4gICAgICAgICAgICBtYXRjaGVkTm93OiBwcmV2aWV3Lm1hdGNoZWROb3csXG4gICAgICAgICAgICBmdXR1cmU6IHByZXZpZXcuZnV0dXJlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChqc29uLmxlbmd0aCA+IGxpbWl0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIGBBcHBUaGVvcnlLZWVwZXJWaXNpYmlsaXR5IG1hbmlmZXN0IGlzICR7anNvbi5sZW5ndGh9IGNoYXJhY3RlcnMsIG92ZXIgdGhlICR7dGllcn0gU1NNIHBhcmFtZXRlciB2YWx1ZSBsaW1pdCBvZiAke2xpbWl0fTsgcmVkdWNlIHRoZSBydWxlIHNldCBvciB1c2UgdGhlIGFkdmFuY2VkIHRpZXJgLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGpzb247XG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgc3ludGgtdGltZSBwcmV2aWV3LCBpbmNsdWRpbmcgdGhlIHNvdXJjZXMgdGhlIHJ1bGVzIGRvIG5vdCBtYXRjaCB5ZXQuXG4gICAqL1xuICBwdWJsaWMgcHJldmlldygpOiBBcHBUaGVvcnlWaXNpYmlsaXR5UHJldmlldyB7XG4gICAgcmV0dXJuIHRoaXMucHJldmlld1Byb3ZpZGVyKCk7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgcmVhZGVyLXJvbGUgdHJ1c3QgcHJpbmNpcGFsOiB0aGUgcmVhZGVyIGFjY291bnQgYXMgYFByaW5jaXBhbGAsIHJlc3RyaWN0ZWRcbiAqIHdpdGggYW4gYGF3czpQcmluY2lwYWxBcm5gIGNvbmRpdGlvbiBvbiBLZWVwZXIncyByb2xlIEFSTi4gTmFtaW5nIHRoZSBhY2NvdW50XG4gKiByYXRoZXIgdGhhbiB0aGUgcm9sZSBBUk4ga2VlcHMgdGhlIHRydXN0IHZhbGlkIGFjcm9zcyBhIGRlbGV0ZS1hbmQtcmVjcmVhdGUgb2ZcbiAqIEtlZXBlcidzIHJvbGUsIGJlY2F1c2UgQVdTIGNvbnZlcnRzIGEgcm9sZSBBUk4gaW4gYSB0cnVzdCBgUHJpbmNpcGFsYCB0byB0aGVcbiAqIHJvbGUncyB1bmlxdWUgSUQgYnV0IGRvZXMgbm90IGNvbnZlcnQgY29uZGl0aW9uLWtleSBBUk5zLlxuICovXG5jbGFzcyBSZWFkZXJSb2xlUHJpbmNpcGFsIGltcGxlbWVudHMgaWFtLklBc3N1bWVSb2xlUHJpbmNpcGFsIHtcbiAgcHVibGljIHJlYWRvbmx5IGdyYW50UHJpbmNpcGFsOiBpYW0uSVByaW5jaXBhbCA9IHRoaXM7XG4gIHB1YmxpYyByZWFkb25seSBhc3N1bWVSb2xlQWN0aW9uID0gXCJzdHM6QXNzdW1lUm9sZVwiO1xuICBwdWJsaWMgcmVhZG9ubHkgcHJpbmNpcGFsQWNjb3VudDogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGRlbGVnYXRlOiBpYW0uQXJuUHJpbmNpcGFsO1xuXG4gIGNvbnN0cnVjdG9yKGFjY291bnQ6IHN0cmluZywgcHJpdmF0ZSByZWFkb25seSBwcmluY2lwYWxBcm46IHN0cmluZykge1xuICAgIHRoaXMucHJpbmNpcGFsQWNjb3VudCA9IGFjY291bnQ7XG4gICAgLy8gVGhlIGxpdGVyYWwgYGFybjphd3M6aWFtOjp7YWNjb3VudH06cm9vdGAgbWF0Y2hlcyB0aGUgY29udHJhY3Qnc1xuICAgIC8vIGBQcmluY2lwYWw6IHtcIkFXU1wiOiAuLi59YCBzaGFwZSByYXRoZXIgdGhhbiBhIHBhcnRpdGlvbiB0b2tlbi5cbiAgICB0aGlzLmRlbGVnYXRlID0gbmV3IGlhbS5Bcm5QcmluY2lwYWwoYGFybjphd3M6aWFtOjoke2FjY291bnR9OnJvb3RgKTtcbiAgfVxuXG4gIHB1YmxpYyBnZXQgcG9saWN5RnJhZ21lbnQoKTogaWFtLlByaW5jaXBhbFBvbGljeUZyYWdtZW50IHtcbiAgICByZXR1cm4gdGhpcy5kZWxlZ2F0ZS5wb2xpY3lGcmFnbWVudDtcbiAgfVxuXG4gIHB1YmxpYyBhZGRUb1BvbGljeShzdGF0ZW1lbnQ6IGlhbS5Qb2xpY3lTdGF0ZW1lbnQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5kZWxlZ2F0ZS5hZGRUb1BvbGljeShzdGF0ZW1lbnQpO1xuICB9XG5cbiAgcHVibGljIGFkZFRvUHJpbmNpcGFsUG9saWN5KHN0YXRlbWVudDogaWFtLlBvbGljeVN0YXRlbWVudCk6IGlhbS5BZGRUb1ByaW5jaXBhbFBvbGljeVJlc3VsdCB7XG4gICAgcmV0dXJuIHRoaXMuZGVsZWdhdGUuYWRkVG9QcmluY2lwYWxQb2xpY3koc3RhdGVtZW50KTtcbiAgfVxuXG4gIHB1YmxpYyBhZGRUb0Fzc3VtZVJvbGVQb2xpY3koZG9jdW1lbnQ6IGlhbS5Qb2xpY3lEb2N1bWVudCk6IHZvaWQge1xuICAgIGRvY3VtZW50LmFkZFN0YXRlbWVudHMoXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFt0aGlzLmFzc3VtZVJvbGVBY3Rpb25dLFxuICAgICAgICBwcmluY2lwYWxzOiBbdGhpcy5kZWxlZ2F0ZV0sXG4gICAgICAgIGNvbmRpdGlvbnM6IHsgQXJuRXF1YWxzOiB7IFwiYXdzOlByaW5jaXBhbEFyblwiOiB0aGlzLnByaW5jaXBhbEFybiB9IH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9XG59XG5cbmNvbnN0IFJFQURFUl9QUklOQ0lQQUxfQVJOX1JFID0gL15hcm46YXdzOmlhbTo6KFswLTldezEyfSk6cm9sZVxcLy4rJC87XG5cbi8qKlxuICogUGFyc2UgdGhlIHJlYWRlciBhY2NvdW50IGZyb20gS2VlcGVyJ3MgcnVudGltZSByb2xlIEFSTi4gVGhlIHRydXN0IHBvbGljeVxuICogbmVlZHMgdGhlIGFjY291bnQgYXMgaXRzIHByaW5jaXBhbCwgYW5kIGFuIHVucmVzb2x2ZWQgdG9rZW4gb3IgYSBtYWxmb3JtZWRcbiAqIEFSTiBjYW5ub3QgYmUgdmFsaWRhdGVkIGF0IHN5bnRoZXNpcy5cbiAqL1xuZnVuY3Rpb24gcmVhZGVyQWNjb3VudEZyb21Bcm4oYXJuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKGFybikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeUtlZXBlclZpc2liaWxpdHkgcmVxdWlyZXMgYSByZXNvbHZlZCByZWFkZXJQcmluY2lwYWxBcm47IHRoZSByZWFkZXIgYWNjb3VudCBpcyBwYXJzZWQgZnJvbSBpdCBhbmQgYW4gdW5yZXNvbHZlZCB0b2tlbiBjYW5ub3QgYmUgdmFsaWRhdGVkIGF0IHN5bnRoZXNpc1wiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgbWF0Y2ggPSBSRUFERVJfUFJJTkNJUEFMX0FSTl9SRS5leGVjKGFybik7XG4gIGlmICghbWF0Y2gpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5S2VlcGVyVmlzaWJpbGl0eSByZWFkZXJQcmluY2lwYWxBcm4gbXVzdCBiZSBhbiBhcm46YXdzOmlhbTo6PDEyIGRpZ2l0cz46cm9sZS8uLi4gQVJOIChnb3QgJHtKU09OLnN0cmluZ2lmeShhcm4pfSlgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG1hdGNoWzFdO1xufVxuXG4vKipcbiAqIFRoZSBjb250cmFjdCdzIG1hbmlmZXN0IHBhcmFtZXRlciBuYW1lLlxuICovXG5mdW5jdGlvbiBtYW5pZmVzdFBhcmFtZXRlck5hbWUoY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCk6IHN0cmluZyB7XG4gIHJldHVybiBgL3RoZW9yeWNsb3VkL3Zpc2liaWxpdHkvJHtjb250ZXh0LmFwcH0vJHtjb250ZXh0LnN0YWdlfS9tYW5pZmVzdGA7XG59XG5cbi8qKlxuICogRGlzY292ZXIgdGhlIGxvZ2ljYWwgc291cmNlcyBvZiB0aGUgbG9nIGdyb3VwcyB0aGlzIHN0YWNrIGRlY2xhcmVzIHVuZGVyIHRoZVxuICogYXBwJ3MgYm91bmQgcHJlZml4LCBleGNsdWRpbmcgb3RoZXIgYXBwcycgYW5kIGxvb2thbGlrZSBncm91cHMuXG4gKi9cbmZ1bmN0aW9uIGRpc2NvdmVyU291cmNlcyhzY29wZTogQ29uc3RydWN0LCBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0KTogc3RyaW5nW10ge1xuICBjb25zdCBwcmVmaXggPSBjb250ZXh0LmxvZ1NvdXJjZVByZWZpeCgpO1xuICBjb25zdCBzb3VyY2VzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3Qgbm9kZSBvZiBTdGFjay5vZihzY29wZSkubm9kZS5maW5kQWxsKCkpIHtcbiAgICAvLyBSZWFkIHRoZSBMMSBwcm9wZXJ0eTogdGhlIEwyIGdldHRlciByZXR1cm5zIGEgdG9rZW4gZXZlbiBmb3IgYSBjb25jcmV0ZVxuICAgIC8vIG5hbWUsIGJlY2F1c2UgaXQgcmVzb2x2ZXMgdGhlIHBoeXNpY2FsIG5hbWUgZHVyaW5nIHN5bnRoZXNpcy5cbiAgICBpZiAoIShub2RlIGluc3RhbmNlb2YgbG9ncy5DZm5Mb2dHcm91cCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IG5hbWUgPSBub2RlLmxvZ0dyb3VwTmFtZTtcbiAgICBpZiAodHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIgfHwgVG9rZW4uaXNVbnJlc29sdmVkKG5hbWUpIHx8ICFuYW1lLnN0YXJ0c1dpdGgocHJlZml4KSkgY29udGludWU7XG4gICAgc291cmNlcy5hZGQobmFtZS5zbGljZShwcmVmaXgubGVuZ3RoKS5yZXBsYWNlKC9fL2csIFwiL1wiKSk7XG4gIH1cbiAgcmV0dXJuIFsuLi5zb3VyY2VzXS5zb3J0KCk7XG59XG4iXX0=