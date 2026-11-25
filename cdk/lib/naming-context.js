"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryNamingContext = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const constructs_1 = require("constructs");
const naming_1 = require("./naming");
/**
 * Accepted CloudWatch Logs `RetentionInDays` values. AWS rejects any other
 * value, so the context fails synthesis instead of deferring a deploy-time
 * error.
 */
const ACCEPTED_RETENTION_DAYS = [
    1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
];
/**
 * The bound naming and logging context shared by AppTheory constructs.
 */
class AppTheoryNamingContext extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryNamingContext", version: "7.5.0" };
    /**
     * Namespace segment.
     */
    namespace;
    /**
     * App instance id.
     */
    app;
    /**
     * Stage id.
     */
    stage;
    /**
     * Twelve-digit account id.
     */
    account;
    /**
     * Full Region code.
     */
    region;
    /**
     * Physical pins keyed `{type}:{logical}`.
     */
    pins;
    /**
     * Generated-name entries keyed `{type}:{logical}`.
     */
    generated;
    /**
     * The naming entries a construct has consumed at synthesis.
     */
    consumed = new Set();
    /**
     * The physically named resources a construct has declared (contract section
     * 11.4). Each declaration ties one composed name to the CloudFormation
     * resource that carries it, so synthesis can refuse a collision and emit the
     * derived-name artifact the reservation index reserves.
     */
    declared = [];
    /**
     * Naming profile.
     */
    namingProfile;
    /**
     * Logging profile.
     */
    loggingProfile;
    /**
     * Retention in days for standard-profile log groups.
     */
    retentionDays;
    constructor(scope, id, props) {
        super(scope, id);
        if (aws_cdk_lib_1.Token.isUnresolved(props.account)) {
            throw new Error("AppTheoryNamingContext requires a concrete account id; the naming contract derives physical names from it and an unresolved token cannot be validated at synthesis");
        }
        if (aws_cdk_lib_1.Token.isUnresolved(props.region)) {
            throw new Error("AppTheoryNamingContext requires a concrete region; an unresolved token cannot be validated at synthesis");
        }
        this.namespace = props.namespace ?? "theorycloud";
        this.app = props.app;
        this.stage = props.stage;
        this.account = props.account;
        this.region = props.region;
        this.pins = { ...(props.pins ?? {}) };
        this.generated = [...(props.generated ?? [])];
        this.namingProfile = props.namingProfile ?? naming_1.AppTheoryNamingProfile.DERIVED;
        this.loggingProfile = props.loggingProfile ?? naming_1.AppTheoryLoggingProfile.LEGACY;
        this.retentionDays = props.retentionDays ?? 30;
        naming_1.AppTheoryResourceNaming.validateContext(this.values());
        if (!ACCEPTED_RETENTION_DAYS.includes(this.retentionDays)) {
            throw new Error(`AppTheoryNamingContext retentionDays must be one of ${ACCEPTED_RETENTION_DAYS.join(", ")}; CloudWatch Logs rejects other values`);
        }
        this.node.addValidation({
            validate: () => {
                const orphans = [...new Set([...Object.keys(this.pins), ...this.generated])].filter((key) => !this.consumed.has(key));
                const errors = [];
                if (orphans.length > 0) {
                    errors.push(`AppTheoryNamingContext naming entries match no resource in the stack: ${orphans.join(", ")}; remove them or pass the matching logical name to the construct that owns the resource`);
                }
                const declaredOnce = new Set();
                const declarations = this.declared
                    .map((entry) => {
                    const resource = this.cloudFormationResource(entry);
                    const owner = aws_cdk_lib_1.Stack.of(resource);
                    const logicalId = String(owner.resolve(resource.logicalId));
                    return {
                        owner,
                        // A CloudFormation logical id is unique only inside one template,
                        // so the comparison runs on an identity that is unique across the
                        // whole context: the owning stack's construct path and the
                        // template-local logical id (SANITY-AT-N3-05). The artifact row
                        // keeps the template-local id, which is what the installer joins
                        // on.
                        identity: `${owner.node.path}/${logicalId}`,
                        input: {
                            ...(entry.name !== undefined ? { name: entry.name } : {}),
                            type: entry.type,
                            logicalId,
                            ...(entry.generated ? { generated: true } : {}),
                        },
                    };
                })
                    // A resource declared twice is one resource: it is admitted, and the
                    // artifact lists it once.
                    .filter((declaration) => {
                    const key = [
                        declaration.identity,
                        declaration.input.type,
                        declaration.input.name ?? "",
                        declaration.input.generated === true ? "generated" : "named",
                    ].join("\u0000");
                    if (declaredOnce.has(key))
                        return false;
                    declaredOnce.add(key);
                    return true;
                });
                let artifact = [];
                try {
                    artifact = naming_1.AppTheoryResourceNaming.synthCheck(declarations.map((declaration) => ({ ...declaration.input, logicalId: declaration.identity })));
                }
                catch (error) {
                    errors.push(`AppTheoryNamingContext ${String(error.message)}; two different logical resources in one naming context cannot share a physical name in the same scope`);
                }
                if (errors.length > 0)
                    return errors;
                // Every entry is attributable to the stack whose template holds its
                // logical id, so a context shared across stacks emits one document per
                // stack in that stack's own `{stack}.metadata.json` (contract section
                // 11.4). The refusal above still spans the whole context: two stacks in
                // one context that derive the same name in one scope are one collision.
                const byStack = new Map();
                declarations.forEach((declaration, index) => {
                    const rows = byStack.get(declaration.owner) ?? [];
                    const row = artifact[index];
                    rows.push({ ...row, logicalId: declaration.input.logicalId });
                    byStack.set(declaration.owner, rows);
                });
                // Scenario 4: every synth with a naming context emits the artifact, so a
                // context whose declarations all attribute to other stacks still leaves
                // an explicit (empty) document on its own stack, and the installer can
                // tell "declares nothing" from "no naming context at all" (scenario 5).
                const ownStack = this.owningStack();
                if (ownStack !== undefined && !byStack.has(ownStack)) {
                    byStack.set(ownStack, []);
                }
                for (const [owner, entries] of byStack) {
                    const document = {
                        contract: naming_1.RESOURCE_NAMING_CONTRACT,
                        schema: naming_1.DERIVED_NAMES_SCHEMA,
                        context: this.values(),
                        entries,
                    };
                    owner.node.addMetadata(naming_1.DERIVED_NAMES_METADATA_KEY, JSON.parse(naming_1.AppTheoryResourceNaming.derivedNamesJson(document)));
                }
                return [];
            },
        });
    }
    /**
     * Whether the standard logging profile is active.
     */
    get standardLogging() {
        return this.loggingProfile === naming_1.AppTheoryLoggingProfile.STANDARD;
    }
    /**
     * The context values as a jsii struct.
     */
    values() {
        return {
            namespace: this.namespace,
            app: this.app,
            stage: this.stage,
            account: this.account,
            region: this.region,
            pins: this.pins,
            generated: this.generated,
            namingProfile: this.namingProfile,
            loggingProfile: this.loggingProfile,
            retentionDays: this.retentionDays,
        };
    }
    /**
     * Compose the physical name of one resource under this context.
     */
    physicalName(resourceType, logical) {
        const composed = naming_1.AppTheoryResourceNaming.physicalName(this.values(), resourceType, logical);
        this.consumed.add(`${resourceType}:${logical}`);
        return composed;
    }
    /**
     * Declare the CloudFormation resource that carries one composed name
     * (contract section 11.4).
     *
     * Synthesis refuses two different logical resources in one naming context that
     * derive the same name in the same naming scope, and emits the derived-name
     * artifact the name reservation index reserves. A construct declares every
     * physically named resource it creates; an application that names its own
     * resource with `physicalName` declares it here once the resource exists, so
     * the artifact covers it too.
     *
     * A name AppTheory only wires for a resource another stack owns, such as
     * `AppTheorySsrSite`'s ISR metadata table, takes no declaration here: that
     * stack declares its own resource.
     *
     * A `log_group` type declares a log-source name (contract section 3): a log
     * group takes no pin or generated entry.
     */
    declareName(resourceType, logical, resource) {
        this.assertSameStage(resourceType, resource);
        this.assertSameEnvironment(resourceType, resource);
        if (resourceType === "log_group") {
            const name = naming_1.AppTheoryResourceNaming.logGroupName(this.values(), logical);
            this.declared.push({ type: resourceType, logical, name, generated: false, resource });
            return;
        }
        const composed = this.physicalName(resourceType, logical);
        this.declared.push({
            type: resourceType,
            logical,
            ...(composed.generated ? {} : { name: composed.name }),
            generated: composed.generated === true,
            resource,
        });
    }
    /**
     * Declare the CloudFormation resource that carries one name the contract fixes
     * rather than derives (contract section 11.4).
     *
     * Two names AppTheory creates fall outside the derivation table: the Lambda
     * service log group `/aws/lambda/{function name}`, and the visibility manifest
     * parameter `/theorycloud/visibility/{app}/{stage}/manifest` (contract section
     * 6). They are still names the context determines and resources the stack
     * creates, so the artifact carries them; the reserved scope is the type's scope
     * from contract section 11.1.
     *
     * An application that names its own resource with a fixed contract path
     * declares it here too, so the artifact covers it.
     *
     * A fixed name is still a physical name of its type, so it must satisfy the
     * character and shape rules of the contract's section 2 rule table for that
     * type (length, charset, the S3 start/end rule, the SSM and KMS path rules,
     * the secret suffix rule). A name outside them fails synthesis instead of
     * entering the artifact as a name the installer can never create
     * (SANITY-AT-N3-08).
     */
    declareFixedName(resourceType, name, resource) {
        // A type outside contract section 2 has no stated scope, so it cannot be
        // reserved: declare it and synthesis fails closed.
        naming_1.AppTheoryResourceNaming.namingScope(resourceType);
        if (aws_cdk_lib_1.Token.isUnresolved(name)) {
            throw new Error(`AppTheoryNamingContext cannot declare ${resourceType} because the name is an unresolved token; a name the artifact reserves must be resolvable at synthesis`);
        }
        naming_1.AppTheoryResourceNaming.validatePhysicalName(resourceType, name);
        this.assertSameStage(resourceType, resource);
        this.assertSameEnvironment(resourceType, resource);
        this.declared.push({ type: resourceType, logical: name, name, generated: false, resource });
    }
    /**
     * The CloudFormation resource a declaration names. The construct's default
     * child is the L1 resource a construct creates for itself, so an L2 construct
     * is the expected argument.
     */
    cloudFormationResource(declaration) {
        const resource = declaration.resource;
        const candidate = resource instanceof aws_cdk_lib_1.CfnResource ? resource : resource.node.defaultChild;
        if (!(candidate instanceof aws_cdk_lib_1.CfnResource)) {
            throw new Error(`AppTheoryNamingContext cannot declare ${declaration.type}:${declaration.logical} because ${resource.node.path} has no CloudFormation resource as its default child; declare the construct that owns the named resource`);
        }
        return candidate;
    }
    /**
     * Refuse a declaration whose owning stack is in a different CDK Stage from the
     * context (SANITY-AT-N3-02).
     *
     * Each Stage is a separate cloud assembly, and CDK validates a tree stage by
     * stage, so the synth check never sees the other assembly: a context above a
     * Stage cannot compare its names, and a document written after that assembly
     * exists is silently lost. A context and every stack declaring through it
     * therefore belong to one Stage (or to none, at the App root).
     */
    assertSameStage(resourceType, resource) {
        const ownerStage = aws_cdk_lib_1.Stage.of(aws_cdk_lib_1.Stack.of(resource));
        const contextStage = aws_cdk_lib_1.Stage.of(this);
        if (ownerStage === contextStage)
            return;
        // `App` is a `Stage` in CDK, so a construct above the stacks reports the App
        // itself as its Stage; that is the App root, not a Stage the caller named.
        const describe = (stage) => stage === undefined || aws_cdk_lib_1.App.isApp(stage) ? "the App root" : `Stage ${stage.node.path}`;
        throw new Error(`AppTheoryNamingContext cannot declare ${resourceType} in ${aws_cdk_lib_1.Stack.of(resource).node.path} because the owning stack is in ${describe(ownerStage)} while the naming context is in ${describe(contextStage)}; a naming context and every stack that declares through it must sit in the same Stage, because each Stage is a separate cloud assembly whose derived-name artifact the synth check cannot compare with another Stage's`);
    }
    /**
     * Refuse a declaration whose owning stack resolves to an environment the
     * context does not claim (SANITY-AT-N3-06).
     *
     * The derived-name artifact claims the context's account and region, and the
     * reservation index keys a name by its scope in that environment, so a stack
     * in another account or Region would reserve names it cannot create while the
     * check refused or admitted them against the wrong environment. An
     * env-agnostic stack (an unresolved account or region) is admitted: it
     * deploys into the context's environment, which is what the artifact claims.
     */
    assertSameEnvironment(resourceType, resource) {
        const owner = aws_cdk_lib_1.Stack.of(resource);
        const described = (value) => (aws_cdk_lib_1.Token.isUnresolved(value) ? "unresolved" : value);
        const mismatches = [];
        if (!aws_cdk_lib_1.Token.isUnresolved(owner.account) && owner.account !== this.account)
            mismatches.push("account");
        if (!aws_cdk_lib_1.Token.isUnresolved(owner.region) && owner.region !== this.region)
            mismatches.push("region");
        if (mismatches.length === 0)
            return;
        throw new Error(`AppTheoryNamingContext cannot declare ${resourceType} in ${owner.node.path} because the stack resolves to account ${described(owner.account)} and region ${described(owner.region)}, while the naming context claims account ${this.account} and region ${this.region} (app ${this.app}, stage ${this.stage}); the derived-name artifact claims the context's environment, so every stack that declares through it must resolve to that environment or to no environment at all`);
    }
    /**
     * The nearest stack above the context, if it has one. A context created above
     * the stacks has none: its artifact then appears on the stacks its
     * declarations attribute to.
     */
    owningStack() {
        let scope = this;
        while (scope !== undefined) {
            if (aws_cdk_lib_1.Stack.isStack(scope))
                return scope;
            scope = scope.node.scope;
        }
        return undefined;
    }
    /**
     * The physical log-group name of a logical source under this context.
     */
    logGroupName(logical) {
        return naming_1.AppTheoryResourceNaming.logGroupName(this.values(), logical);
    }
    /**
     * The bound prefix shared by this app's log sources.
     */
    logSourcePrefix() {
        return naming_1.AppTheoryResourceNaming.logSourcePrefix(this.values());
    }
}
exports.AppTheoryNamingContext = AppTheoryNamingContext;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJuYW1pbmctY29udGV4dC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBQUEsNkNBQW9FO0FBQ3BFLDJDQUFtRDtBQUVuRCxxQ0FZa0I7QUFFbEI7Ozs7R0FJRztBQUNILE1BQU0sdUJBQXVCLEdBQUc7SUFDOUIsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSTtDQUN4RyxDQUFDO0FBc0ZGOztHQUVHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUzs7SUFDbkQ7O09BRUc7SUFDYSxTQUFTLENBQVM7SUFFbEM7O09BRUc7SUFDYSxHQUFHLENBQVM7SUFFNUI7O09BRUc7SUFDYSxLQUFLLENBQVM7SUFFOUI7O09BRUc7SUFDYSxPQUFPLENBQVM7SUFFaEM7O09BRUc7SUFDYSxNQUFNLENBQVM7SUFFL0I7O09BRUc7SUFDYSxJQUFJLENBQTRCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUFXO0lBRXBDOztPQUVHO0lBQ2MsUUFBUSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFFOUM7Ozs7O09BS0c7SUFDYyxRQUFRLEdBQStCLEVBQUUsQ0FBQztJQUUzRDs7T0FFRztJQUNhLGFBQWEsQ0FBeUI7SUFFdEQ7O09BRUc7SUFDYSxjQUFjLENBQTBCO0lBRXhEOztPQUVHO0lBQ2EsYUFBYSxDQUFTO0lBRXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBa0M7UUFDMUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FB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QUNqQixJQUFJLEtBQUssR0FBMkIsSUFBSSxDQUFDO1FBQ3pDLE9BQU8sS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzNCLElBQUksbUJBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDO2dCQUFFLE9BQU8sS0FBSyxDQUFDO1lBQ3ZDLEtBQUssR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUMzQixDQUFDO1FBQ0QsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUVEOztPQUVHO0lBQ0ksWUFBWSxDQUFDLE9BQWU7UUFDakMsT0FBTyxnQ0FBdUIsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ3RFLENBQUM7SUFFRDs7T0FFRztJQUNJLGVBQWU7UUFDcEIsT0FBTyxnQ0FBdUIsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDaEUsQ0FBQzs7QUFuWUgsd0RBb1lDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQXBwLCBDZm5SZXNvdXJjZSwgU3RhY2ssIFN0YWdlLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgSUNvbnN0cnVjdCwgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHtcbiAgQXBwVGhlb3J5RGVyaXZlZE5hbWUsXG4gIEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXQsXG4gIEFwcFRoZW9yeURlcml2ZWROYW1lcyxcbiAgQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUsXG4gIEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUsXG4gIEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gIEFwcFRoZW9yeVBoeXNpY2FsTmFtZSxcbiAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcsXG4gIERFUklWRURfTkFNRVNfTUVUQURBVEFfS0VZLFxuICBERVJJVkVEX05BTUVTX1NDSEVNQSxcbiAgUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNULFxufSBmcm9tIFwiLi9uYW1pbmdcIjtcblxuLyoqXG4gKiBBY2NlcHRlZCBDbG91ZFdhdGNoIExvZ3MgYFJldGVudGlvbkluRGF5c2AgdmFsdWVzLiBBV1MgcmVqZWN0cyBhbnkgb3RoZXJcbiAqIHZhbHVlLCBzbyB0aGUgY29udGV4dCBmYWlscyBzeW50aGVzaXMgaW5zdGVhZCBvZiBkZWZlcnJpbmcgYSBkZXBsb3ktdGltZVxuICogZXJyb3IuXG4gKi9cbmNvbnN0IEFDQ0VQVEVEX1JFVEVOVElPTl9EQVlTID0gW1xuICAxLCAzLCA1LCA3LCAxNCwgMzAsIDYwLCA5MCwgMTIwLCAxNTAsIDE4MCwgMzY1LCA0MDAsIDU0NSwgNzMxLCAxMDk2LCAxODI3LCAyMTkyLCAyNTU3LCAyOTIyLCAzMjg4LCAzNjUzLFxuXTtcblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBhbiBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dGAuXG4gKlxuICogVGhlIGNvbnRleHQgaG9sZHMgdGhlIGJvdW5kIG5hbWluZyBhbmQgbG9nZ2luZyB2YWx1ZXMgZnJvbSBzdGFnZSBjb25maWcuXG4gKiBDb25zdHJ1Y3RzIHRha2UgaXQgYXMgYW4gb3B0aW9uYWwgcHJvcDsgd2l0aCBubyBjb250ZXh0IGV2ZXJ5IGNvbnN0cnVjdFxuICogc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBpdCBkaWQgYmVmb3JlIHRoaXMgY29udHJhY3QgZXhpc3RlZC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlOYW1pbmdDb250ZXh0UHJvcHMge1xuICAvKipcbiAgICogTmFtZXNwYWNlIHNlZ21lbnQuXG4gICAqIEBkZWZhdWx0IFwidGhlb3J5Y2xvdWRcIlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZXNwYWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBcHAgaW5zdGFuY2UgaWQgZnJvbSBzdGFnZSBjb25maWcuXG4gICAqL1xuICByZWFkb25seSBhcHA6IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgaWQgZnJvbSBzdGFnZSBjb25maWcuXG4gICAqL1xuICByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZCBmcm9tIHN0YWdlIGNvbmZpZy4gQW4gdW5yZXNvbHZlZCB0b2tlbiBmYWlsc1xuICAgKiBzeW50aGVzaXMuXG4gICAqL1xuICByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUsIGZvciBleGFtcGxlIGB1cy1lYXN0LTFgLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLCB1c2VkIHZlcmJhdGltIHVuZGVyIGEgbGVnYWN5XG4gICAqIG5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCB7fVxuICAgKi9cbiAgcmVhZG9ubHkgcGlucz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlZC1uYW1lIGVudHJpZXMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLiBBbiBlbnRyeSBtZWFuc1xuICAgKiBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgdG9kYXksIHNvIHRoZSBjb25zdHJ1Y3Qgc2V0cyBub1xuICAgKiBwaHlzaWNhbC1uYW1lIHByb3BlcnR5LiBWYWxpZCBvbmx5IHVuZGVyIHRoZSBsZWdhY3kgbmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nUHJvZmlsZT86IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZ2dpbmcgcHJvZmlsZS4gYHN0YW5kYXJkYCBvcHRzIGV2ZXJ5IGNvbnN0cnVjdCB0aGF0IHJlY2VpdmVzIHRoZSBjb250ZXh0XG4gICAqIGludG8gdGhlIGNvbnRyYWN0J3MgbG9nIGdyb3VwcyBhbmQgYWNjZXNzIGxvZ2dpbmcuIGBsZWdhY3lgIGtlZXBzIGVhY2hcbiAgICogY29uc3RydWN0J3MgcHJlLWNvbnRyYWN0IGJlaGF2aW91ci5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuTEVHQUNZXG4gICAqL1xuICByZWFkb25seSBsb2dnaW5nUHJvZmlsZT86IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gaW4gZGF5cyBmb3Igc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXBzLiBNdXN0IGJlIGEgdmFsdWVcbiAgICogQ2xvdWRXYXRjaCBMb2dzIGFjY2VwdHMuXG4gICAqIEBkZWZhdWx0IDMwXG4gICAqL1xuICByZWFkb25seSByZXRlbnRpb25EYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIE9uZSBkZWNsYXJlZCBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlOiB0aGUgY29tcG9zZWQgbmFtZSwgYW5kIHRoZSBjb25zdHJ1Y3RcbiAqIHdob3NlIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIGNhcnJpZXMgaXQuXG4gKi9cbmludGVyZmFjZSBBcHBUaGVvcnlOYW1lRGVjbGFyYXRpb24ge1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGxvZ2ljYWw6IHN0cmluZztcbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZ2VuZXJhdGVkOiBib29sZWFuO1xuICByZWFkb25seSByZXNvdXJjZTogSUNvbnN0cnVjdDtcbn1cblxuLyoqXG4gKiBUaGUgYm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQgc2hhcmVkIGJ5IEFwcFRoZW9yeSBjb25zdHJ1Y3RzLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuYW1lc3BhY2U6IHN0cmluZztcblxuICAvKipcbiAgICogQXBwIGluc3RhbmNlIGlkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHBpbnM6IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlZC1uYW1lIGVudHJpZXMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGdlbmVyYXRlZDogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBuYW1pbmcgZW50cmllcyBhIGNvbnN0cnVjdCBoYXMgY29uc3VtZWQgYXQgc3ludGhlc2lzLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBjb25zdW1lZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZXMgYSBjb25zdHJ1Y3QgaGFzIGRlY2xhcmVkIChjb250cmFjdCBzZWN0aW9uXG4gICAqIDExLjQpLiBFYWNoIGRlY2xhcmF0aW9uIHRpZXMgb25lIGNvbXBvc2VkIG5hbWUgdG8gdGhlIENsb3VkRm9ybWF0aW9uXG4gICAqIHJlc291cmNlIHRoYXQgY2FycmllcyBpdCwgc28gc3ludGhlc2lzIGNhbiByZWZ1c2UgYSBjb2xsaXNpb24gYW5kIGVtaXQgdGhlXG4gICAqIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCB0aGUgcmVzZXJ2YXRpb24gaW5kZXggcmVzZXJ2ZXMuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGRlY2xhcmVkOiBBcHBUaGVvcnlOYW1lRGVjbGFyYXRpb25bXSA9IFtdO1xuXG4gIC8qKlxuICAgKiBOYW1pbmcgcHJvZmlsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuYW1pbmdQcm9maWxlOiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU6IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gaW4gZGF5cyBmb3Igc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXBzLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJldGVudGlvbkRheXM6IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMuYWNjb3VudCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJlcXVpcmVzIGEgY29uY3JldGUgYWNjb3VudCBpZDsgdGhlIG5hbWluZyBjb250cmFjdCBkZXJpdmVzIHBoeXNpY2FsIG5hbWVzIGZyb20gaXQgYW5kIGFuIHVucmVzb2x2ZWQgdG9rZW4gY2Fubm90IGJlIHZhbGlkYXRlZCBhdCBzeW50aGVzaXNcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMucmVnaW9uKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TmFtaW5nQ29udGV4dCByZXF1aXJlcyBhIGNvbmNyZXRlIHJlZ2lvbjsgYW4gdW5yZXNvbHZlZCB0b2tlbiBjYW5ub3QgYmUgdmFsaWRhdGVkIGF0IHN5bnRoZXNpc1wiKTtcbiAgICB9XG5cbiAgICB0aGlzLm5hbWVzcGFjZSA9IHByb3BzLm5hbWVzcGFjZSA/PyBcInRoZW9yeWNsb3VkXCI7XG4gICAgdGhpcy5hcHAgPSBwcm9wcy5hcHA7XG4gICAgdGhpcy5zdGFnZSA9IHByb3BzLnN0YWdlO1xuICAgIHRoaXMuYWNjb3VudCA9IHByb3BzLmFjY291bnQ7XG4gICAgdGhpcy5yZWdpb24gPSBwcm9wcy5yZWdpb247XG4gICAgdGhpcy5waW5zID0geyAuLi4ocHJvcHMucGlucyA/PyB7fSkgfTtcbiAgICB0aGlzLmdlbmVyYXRlZCA9IFsuLi4ocHJvcHMuZ2VuZXJhdGVkID8/IFtdKV07XG4gICAgdGhpcy5uYW1pbmdQcm9maWxlID0gcHJvcHMubmFtaW5nUHJvZmlsZSA/PyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQ7XG4gICAgdGhpcy5sb2dnaW5nUHJvZmlsZSA9IHByb3BzLmxvZ2dpbmdQcm9maWxlID8/IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWTtcbiAgICB0aGlzLnJldGVudGlvbkRheXMgPSBwcm9wcy5yZXRlbnRpb25EYXlzID8/IDMwO1xuXG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHRoaXMudmFsdWVzKCkpO1xuXG4gICAgaWYgKCFBQ0NFUFRFRF9SRVRFTlRJT05fREFZUy5pbmNsdWRlcyh0aGlzLnJldGVudGlvbkRheXMpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJldGVudGlvbkRheXMgbXVzdCBiZSBvbmUgb2YgJHtBQ0NFUFRFRF9SRVRFTlRJT05fREFZUy5qb2luKFwiLCBcIil9OyBDbG91ZFdhdGNoIExvZ3MgcmVqZWN0cyBvdGhlciB2YWx1ZXNgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBvcnBoYW5zID0gWy4uLm5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKHRoaXMucGlucyksIC4uLnRoaXMuZ2VuZXJhdGVkXSldLmZpbHRlcihcbiAgICAgICAgICAoa2V5KSA9PiAhdGhpcy5jb25zdW1lZC5oYXMoa2V5KSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBpZiAob3JwaGFucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBuYW1pbmcgZW50cmllcyBtYXRjaCBubyByZXNvdXJjZSBpbiB0aGUgc3RhY2s6ICR7b3JwaGFucy5qb2luKFwiLCBcIil9OyByZW1vdmUgdGhlbSBvciBwYXNzIHRoZSBtYXRjaGluZyBsb2dpY2FsIG5hbWUgdG8gdGhlIGNvbnN0cnVjdCB0aGF0IG93bnMgdGhlIHJlc291cmNlYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZGVjbGFyZWRPbmNlID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICAgIGNvbnN0IGRlY2xhcmF0aW9ucyA9IHRoaXMuZGVjbGFyZWRcbiAgICAgICAgICAubWFwKChlbnRyeSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcmVzb3VyY2UgPSB0aGlzLmNsb3VkRm9ybWF0aW9uUmVzb3VyY2UoZW50cnkpO1xuICAgICAgICAgICAgY29uc3Qgb3duZXIgPSBTdGFjay5vZihyZXNvdXJjZSk7XG4gICAgICAgICAgICBjb25zdCBsb2dpY2FsSWQgPSBTdHJpbmcob3duZXIucmVzb2x2ZShyZXNvdXJjZS5sb2dpY2FsSWQpKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIG93bmVyLFxuICAgICAgICAgICAgICAvLyBBIENsb3VkRm9ybWF0aW9uIGxvZ2ljYWwgaWQgaXMgdW5pcXVlIG9ubHkgaW5zaWRlIG9uZSB0ZW1wbGF0ZSxcbiAgICAgICAgICAgICAgLy8gc28gdGhlIGNvbXBhcmlzb24gcnVucyBvbiBhbiBpZGVudGl0eSB0aGF0IGlzIHVuaXF1ZSBhY3Jvc3MgdGhlXG4gICAgICAgICAgICAgIC8vIHdob2xlIGNvbnRleHQ6IHRoZSBvd25pbmcgc3RhY2sncyBjb25zdHJ1Y3QgcGF0aCBhbmQgdGhlXG4gICAgICAgICAgICAgIC8vIHRlbXBsYXRlLWxvY2FsIGxvZ2ljYWwgaWQgKFNBTklUWS1BVC1OMy0wNSkuIFRoZSBhcnRpZmFjdCByb3dcbiAgICAgICAgICAgICAgLy8ga2VlcHMgdGhlIHRlbXBsYXRlLWxvY2FsIGlkLCB3aGljaCBpcyB3aGF0IHRoZSBpbnN0YWxsZXIgam9pbnNcbiAgICAgICAgICAgICAgLy8gb24uXG4gICAgICAgICAgICAgIGlkZW50aXR5OiBgJHtvd25lci5ub2RlLnBhdGh9LyR7bG9naWNhbElkfWAsXG4gICAgICAgICAgICAgIGlucHV0OiB7XG4gICAgICAgICAgICAgICAgLi4uKGVudHJ5Lm5hbWUgIT09IHVuZGVmaW5lZCA/IHsgbmFtZTogZW50cnkubmFtZSB9IDoge30pLFxuICAgICAgICAgICAgICAgIHR5cGU6IGVudHJ5LnR5cGUsXG4gICAgICAgICAgICAgICAgbG9naWNhbElkLFxuICAgICAgICAgICAgICAgIC4uLihlbnRyeS5nZW5lcmF0ZWQgPyB7IGdlbmVyYXRlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICB9IGFzIEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXQsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLy8gQSByZXNvdXJjZSBkZWNsYXJlZCB0d2ljZSBpcyBvbmUgcmVzb3VyY2U6IGl0IGlzIGFkbWl0dGVkLCBhbmQgdGhlXG4gICAgICAgICAgLy8gYXJ0aWZhY3QgbGlzdHMgaXQgb25jZS5cbiAgICAgICAgICAuZmlsdGVyKChkZWNsYXJhdGlvbikgPT4ge1xuICAgICAgICAgICAgY29uc3Qga2V5ID0gW1xuICAgICAgICAgICAgICBkZWNsYXJhdGlvbi5pZGVudGl0eSxcbiAgICAgICAgICAgICAgZGVjbGFyYXRpb24uaW5wdXQudHlwZSxcbiAgICAgICAgICAgICAgZGVjbGFyYXRpb24uaW5wdXQubmFtZSA/PyBcIlwiLFxuICAgICAgICAgICAgICBkZWNsYXJhdGlvbi5pbnB1dC5nZW5lcmF0ZWQgPT09IHRydWUgPyBcImdlbmVyYXRlZFwiIDogXCJuYW1lZFwiLFxuICAgICAgICAgICAgXS5qb2luKFwiXFx1MDAwMFwiKTtcbiAgICAgICAgICAgIGlmIChkZWNsYXJlZE9uY2UuaGFzKGtleSkpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGRlY2xhcmVkT25jZS5hZGQoa2V5KTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgIGxldCBhcnRpZmFjdDogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXSA9IFtdO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGFydGlmYWN0ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc3ludGhDaGVjayhcbiAgICAgICAgICAgIGRlY2xhcmF0aW9ucy5tYXAoKGRlY2xhcmF0aW9uKSA9PiAoeyAuLi5kZWNsYXJhdGlvbi5pbnB1dCwgbG9naWNhbElkOiBkZWNsYXJhdGlvbi5pZGVudGl0eSB9KSksXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0ICR7U3RyaW5nKChlcnJvciBhcyBFcnJvcikubWVzc2FnZSl9OyB0d28gZGlmZmVyZW50IGxvZ2ljYWwgcmVzb3VyY2VzIGluIG9uZSBuYW1pbmcgY29udGV4dCBjYW5ub3Qgc2hhcmUgYSBwaHlzaWNhbCBuYW1lIGluIHRoZSBzYW1lIHNjb3BlYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChlcnJvcnMubGVuZ3RoID4gMCkgcmV0dXJuIGVycm9ycztcblxuICAgICAgICAvLyBFdmVyeSBlbnRyeSBpcyBhdHRyaWJ1dGFibGUgdG8gdGhlIHN0YWNrIHdob3NlIHRlbXBsYXRlIGhvbGRzIGl0c1xuICAgICAgICAvLyBsb2dpY2FsIGlkLCBzbyBhIGNvbnRleHQgc2hhcmVkIGFjcm9zcyBzdGFja3MgZW1pdHMgb25lIGRvY3VtZW50IHBlclxuICAgICAgICAvLyBzdGFjayBpbiB0aGF0IHN0YWNrJ3Mgb3duIGB7c3RhY2t9Lm1ldGFkYXRhLmpzb25gIChjb250cmFjdCBzZWN0aW9uXG4gICAgICAgIC8vIDExLjQpLiBUaGUgcmVmdXNhbCBhYm92ZSBzdGlsbCBzcGFucyB0aGUgd2hvbGUgY29udGV4dDogdHdvIHN0YWNrcyBpblxuICAgICAgICAvLyBvbmUgY29udGV4dCB0aGF0IGRlcml2ZSB0aGUgc2FtZSBuYW1lIGluIG9uZSBzY29wZSBhcmUgb25lIGNvbGxpc2lvbi5cbiAgICAgICAgY29uc3QgYnlTdGFjayA9IG5ldyBNYXA8U3RhY2ssIEFwcFRoZW9yeURlcml2ZWROYW1lW10+KCk7XG4gICAgICAgIGRlY2xhcmF0aW9ucy5mb3JFYWNoKChkZWNsYXJhdGlvbiwgaW5kZXgpID0+IHtcbiAgICAgICAgICBjb25zdCByb3dzID0gYnlTdGFjay5nZXQoZGVjbGFyYXRpb24ub3duZXIpID8/IFtdO1xuICAgICAgICAgIGNvbnN0IHJvdyA9IGFydGlmYWN0W2luZGV4XSBhcyBBcHBUaGVvcnlEZXJpdmVkTmFtZTtcbiAgICAgICAgICByb3dzLnB1c2goeyAuLi5yb3csIGxvZ2ljYWxJZDogKGRlY2xhcmF0aW9uLmlucHV0IGFzIEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXQpLmxvZ2ljYWxJZCB9KTtcbiAgICAgICAgICBieVN0YWNrLnNldChkZWNsYXJhdGlvbi5vd25lciwgcm93cyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFNjZW5hcmlvIDQ6IGV2ZXJ5IHN5bnRoIHdpdGggYSBuYW1pbmcgY29udGV4dCBlbWl0cyB0aGUgYXJ0aWZhY3QsIHNvIGFcbiAgICAgICAgLy8gY29udGV4dCB3aG9zZSBkZWNsYXJhdGlvbnMgYWxsIGF0dHJpYnV0ZSB0byBvdGhlciBzdGFja3Mgc3RpbGwgbGVhdmVzXG4gICAgICAgIC8vIGFuIGV4cGxpY2l0IChlbXB0eSkgZG9jdW1lbnQgb24gaXRzIG93biBzdGFjaywgYW5kIHRoZSBpbnN0YWxsZXIgY2FuXG4gICAgICAgIC8vIHRlbGwgXCJkZWNsYXJlcyBub3RoaW5nXCIgZnJvbSBcIm5vIG5hbWluZyBjb250ZXh0IGF0IGFsbFwiIChzY2VuYXJpbyA1KS5cbiAgICAgICAgY29uc3Qgb3duU3RhY2sgPSB0aGlzLm93bmluZ1N0YWNrKCk7XG4gICAgICAgIGlmIChvd25TdGFjayAhPT0gdW5kZWZpbmVkICYmICFieVN0YWNrLmhhcyhvd25TdGFjaykpIHtcbiAgICAgICAgICBieVN0YWNrLnNldChvd25TdGFjaywgW10pO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yIChjb25zdCBbb3duZXIsIGVudHJpZXNdIG9mIGJ5U3RhY2spIHtcbiAgICAgICAgICBjb25zdCBkb2N1bWVudDogQXBwVGhlb3J5RGVyaXZlZE5hbWVzID0ge1xuICAgICAgICAgICAgY29udHJhY3Q6IFJFU09VUkNFX05BTUlOR19DT05UUkFDVCxcbiAgICAgICAgICAgIHNjaGVtYTogREVSSVZFRF9OQU1FU19TQ0hFTUEsXG4gICAgICAgICAgICBjb250ZXh0OiB0aGlzLnZhbHVlcygpLFxuICAgICAgICAgICAgZW50cmllcyxcbiAgICAgICAgICB9O1xuICAgICAgICAgIG93bmVyLm5vZGUuYWRkTWV0YWRhdGEoREVSSVZFRF9OQU1FU19NRVRBREFUQV9LRVksIEpTT04ucGFyc2UoQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuZGVyaXZlZE5hbWVzSnNvbihkb2N1bWVudCkpKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gW107XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSBpcyBhY3RpdmUuXG4gICAqL1xuICBwdWJsaWMgZ2V0IHN0YW5kYXJkTG9nZ2luZygpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5sb2dnaW5nUHJvZmlsZSA9PT0gQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuU1RBTkRBUkQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGNvbnRleHQgdmFsdWVzIGFzIGEganNpaSBzdHJ1Y3QuXG4gICAqL1xuICBwdWJsaWMgdmFsdWVzKCk6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lc3BhY2U6IHRoaXMubmFtZXNwYWNlLFxuICAgICAgYXBwOiB0aGlzLmFwcCxcbiAgICAgIHN0YWdlOiB0aGlzLnN0YWdlLFxuICAgICAgYWNjb3VudDogdGhpcy5hY2NvdW50LFxuICAgICAgcmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgIHBpbnM6IHRoaXMucGlucyxcbiAgICAgIGdlbmVyYXRlZDogdGhpcy5nZW5lcmF0ZWQsXG4gICAgICBuYW1pbmdQcm9maWxlOiB0aGlzLm5hbWluZ1Byb2ZpbGUsXG4gICAgICBsb2dnaW5nUHJvZmlsZTogdGhpcy5sb2dnaW5nUHJvZmlsZSxcbiAgICAgIHJldGVudGlvbkRheXM6IHRoaXMucmV0ZW50aW9uRGF5cyxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBvc2UgdGhlIHBoeXNpY2FsIG5hbWUgb2Ygb25lIHJlc291cmNlIHVuZGVyIHRoaXMgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyBwaHlzaWNhbE5hbWUocmVzb3VyY2VUeXBlOiBzdHJpbmcsIGxvZ2ljYWw6IHN0cmluZyk6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZSB7XG4gICAgY29uc3QgY29tcG9zZWQgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5waHlzaWNhbE5hbWUodGhpcy52YWx1ZXMoKSwgcmVzb3VyY2VUeXBlLCBsb2dpY2FsKTtcbiAgICB0aGlzLmNvbnN1bWVkLmFkZChgJHtyZXNvdXJjZVR5cGV9OiR7bG9naWNhbH1gKTtcbiAgICByZXR1cm4gY29tcG9zZWQ7XG4gIH1cblxuICAvKipcbiAgICogRGVjbGFyZSB0aGUgQ2xvdWRGb3JtYXRpb24gcmVzb3VyY2UgdGhhdCBjYXJyaWVzIG9uZSBjb21wb3NlZCBuYW1lXG4gICAqIChjb250cmFjdCBzZWN0aW9uIDExLjQpLlxuICAgKlxuICAgKiBTeW50aGVzaXMgcmVmdXNlcyB0d28gZGlmZmVyZW50IGxvZ2ljYWwgcmVzb3VyY2VzIGluIG9uZSBuYW1pbmcgY29udGV4dCB0aGF0XG4gICAqIGRlcml2ZSB0aGUgc2FtZSBuYW1lIGluIHRoZSBzYW1lIG5hbWluZyBzY29wZSwgYW5kIGVtaXRzIHRoZSBkZXJpdmVkLW5hbWVcbiAgICogYXJ0aWZhY3QgdGhlIG5hbWUgcmVzZXJ2YXRpb24gaW5kZXggcmVzZXJ2ZXMuIEEgY29uc3RydWN0IGRlY2xhcmVzIGV2ZXJ5XG4gICAqIHBoeXNpY2FsbHkgbmFtZWQgcmVzb3VyY2UgaXQgY3JlYXRlczsgYW4gYXBwbGljYXRpb24gdGhhdCBuYW1lcyBpdHMgb3duXG4gICAqIHJlc291cmNlIHdpdGggYHBoeXNpY2FsTmFtZWAgZGVjbGFyZXMgaXQgaGVyZSBvbmNlIHRoZSByZXNvdXJjZSBleGlzdHMsIHNvXG4gICAqIHRoZSBhcnRpZmFjdCBjb3ZlcnMgaXQgdG9vLlxuICAgKlxuICAgKiBBIG5hbWUgQXBwVGhlb3J5IG9ubHkgd2lyZXMgZm9yIGEgcmVzb3VyY2UgYW5vdGhlciBzdGFjayBvd25zLCBzdWNoIGFzXG4gICAqIGBBcHBUaGVvcnlTc3JTaXRlYCdzIElTUiBtZXRhZGF0YSB0YWJsZSwgdGFrZXMgbm8gZGVjbGFyYXRpb24gaGVyZTogdGhhdFxuICAgKiBzdGFjayBkZWNsYXJlcyBpdHMgb3duIHJlc291cmNlLlxuICAgKlxuICAgKiBBIGBsb2dfZ3JvdXBgIHR5cGUgZGVjbGFyZXMgYSBsb2ctc291cmNlIG5hbWUgKGNvbnRyYWN0IHNlY3Rpb24gMyk6IGEgbG9nXG4gICAqIGdyb3VwIHRha2VzIG5vIHBpbiBvciBnZW5lcmF0ZWQgZW50cnkuXG4gICAqL1xuICBwdWJsaWMgZGVjbGFyZU5hbWUocmVzb3VyY2VUeXBlOiBzdHJpbmcsIGxvZ2ljYWw6IHN0cmluZywgcmVzb3VyY2U6IElDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgICB0aGlzLmFzc2VydFNhbWVTdGFnZShyZXNvdXJjZVR5cGUsIHJlc291cmNlKTtcbiAgICB0aGlzLmFzc2VydFNhbWVFbnZpcm9ubWVudChyZXNvdXJjZVR5cGUsIHJlc291cmNlKTtcbiAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcImxvZ19ncm91cFwiKSB7XG4gICAgICBjb25zdCBuYW1lID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nR3JvdXBOYW1lKHRoaXMudmFsdWVzKCksIGxvZ2ljYWwpO1xuICAgICAgdGhpcy5kZWNsYXJlZC5wdXNoKHsgdHlwZTogcmVzb3VyY2VUeXBlLCBsb2dpY2FsLCBuYW1lLCBnZW5lcmF0ZWQ6IGZhbHNlLCByZXNvdXJjZSB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgY29tcG9zZWQgPSB0aGlzLnBoeXNpY2FsTmFtZShyZXNvdXJjZVR5cGUsIGxvZ2ljYWwpO1xuICAgIHRoaXMuZGVjbGFyZWQucHVzaCh7XG4gICAgICB0eXBlOiByZXNvdXJjZVR5cGUsXG4gICAgICBsb2dpY2FsLFxuICAgICAgLi4uKGNvbXBvc2VkLmdlbmVyYXRlZCA/IHt9IDogeyBuYW1lOiBjb21wb3NlZC5uYW1lIH0pLFxuICAgICAgZ2VuZXJhdGVkOiBjb21wb3NlZC5nZW5lcmF0ZWQgPT09IHRydWUsXG4gICAgICByZXNvdXJjZSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZWNsYXJlIHRoZSBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZSB0aGF0IGNhcnJpZXMgb25lIG5hbWUgdGhlIGNvbnRyYWN0IGZpeGVzXG4gICAqIHJhdGhlciB0aGFuIGRlcml2ZXMgKGNvbnRyYWN0IHNlY3Rpb24gMTEuNCkuXG4gICAqXG4gICAqIFR3byBuYW1lcyBBcHBUaGVvcnkgY3JlYXRlcyBmYWxsIG91dHNpZGUgdGhlIGRlcml2YXRpb24gdGFibGU6IHRoZSBMYW1iZGFcbiAgICogc2VydmljZSBsb2cgZ3JvdXAgYC9hd3MvbGFtYmRhL3tmdW5jdGlvbiBuYW1lfWAsIGFuZCB0aGUgdmlzaWJpbGl0eSBtYW5pZmVzdFxuICAgKiBwYXJhbWV0ZXIgYC90aGVvcnljbG91ZC92aXNpYmlsaXR5L3thcHB9L3tzdGFnZX0vbWFuaWZlc3RgIChjb250cmFjdCBzZWN0aW9uXG4gICAqIDYpLiBUaGV5IGFyZSBzdGlsbCBuYW1lcyB0aGUgY29udGV4dCBkZXRlcm1pbmVzIGFuZCByZXNvdXJjZXMgdGhlIHN0YWNrXG4gICAqIGNyZWF0ZXMsIHNvIHRoZSBhcnRpZmFjdCBjYXJyaWVzIHRoZW07IHRoZSByZXNlcnZlZCBzY29wZSBpcyB0aGUgdHlwZSdzIHNjb3BlXG4gICAqIGZyb20gY29udHJhY3Qgc2VjdGlvbiAxMS4xLlxuICAgKlxuICAgKiBBbiBhcHBsaWNhdGlvbiB0aGF0IG5hbWVzIGl0cyBvd24gcmVzb3VyY2Ugd2l0aCBhIGZpeGVkIGNvbnRyYWN0IHBhdGhcbiAgICogZGVjbGFyZXMgaXQgaGVyZSB0b28sIHNvIHRoZSBhcnRpZmFjdCBjb3ZlcnMgaXQuXG4gICAqXG4gICAqIEEgZml4ZWQgbmFtZSBpcyBzdGlsbCBhIHBoeXNpY2FsIG5hbWUgb2YgaXRzIHR5cGUsIHNvIGl0IG11c3Qgc2F0aXNmeSB0aGVcbiAgICogY2hhcmFjdGVyIGFuZCBzaGFwZSBydWxlcyBvZiB0aGUgY29udHJhY3QncyBzZWN0aW9uIDIgcnVsZSB0YWJsZSBmb3IgdGhhdFxuICAgKiB0eXBlIChsZW5ndGgsIGNoYXJzZXQsIHRoZSBTMyBzdGFydC9lbmQgcnVsZSwgdGhlIFNTTSBhbmQgS01TIHBhdGggcnVsZXMsXG4gICAqIHRoZSBzZWNyZXQgc3VmZml4IHJ1bGUpLiBBIG5hbWUgb3V0c2lkZSB0aGVtIGZhaWxzIHN5bnRoZXNpcyBpbnN0ZWFkIG9mXG4gICAqIGVudGVyaW5nIHRoZSBhcnRpZmFjdCBhcyBhIG5hbWUgdGhlIGluc3RhbGxlciBjYW4gbmV2ZXIgY3JlYXRlXG4gICAqIChTQU5JVFktQVQtTjMtMDgpLlxuICAgKi9cbiAgcHVibGljIGRlY2xhcmVGaXhlZE5hbWUocmVzb3VyY2VUeXBlOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgcmVzb3VyY2U6IElDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgICAvLyBBIHR5cGUgb3V0c2lkZSBjb250cmFjdCBzZWN0aW9uIDIgaGFzIG5vIHN0YXRlZCBzY29wZSwgc28gaXQgY2Fubm90IGJlXG4gICAgLy8gcmVzZXJ2ZWQ6IGRlY2xhcmUgaXQgYW5kIHN5bnRoZXNpcyBmYWlscyBjbG9zZWQuXG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubmFtaW5nU2NvcGUocmVzb3VyY2VUeXBlKTtcbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKG5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IGNhbm5vdCBkZWNsYXJlICR7cmVzb3VyY2VUeXBlfSBiZWNhdXNlIHRoZSBuYW1lIGlzIGFuIHVucmVzb2x2ZWQgdG9rZW47IGEgbmFtZSB0aGUgYXJ0aWZhY3QgcmVzZXJ2ZXMgbXVzdCBiZSByZXNvbHZhYmxlIGF0IHN5bnRoZXNpc2AsXG4gICAgICApO1xuICAgIH1cbiAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZVBoeXNpY2FsTmFtZShyZXNvdXJjZVR5cGUsIG5hbWUpO1xuICAgIHRoaXMuYXNzZXJ0U2FtZVN0YWdlKHJlc291cmNlVHlwZSwgcmVzb3VyY2UpO1xuICAgIHRoaXMuYXNzZXJ0U2FtZUVudmlyb25tZW50KHJlc291cmNlVHlwZSwgcmVzb3VyY2UpO1xuICAgIHRoaXMuZGVjbGFyZWQucHVzaCh7IHR5cGU6IHJlc291cmNlVHlwZSwgbG9naWNhbDogbmFtZSwgbmFtZSwgZ2VuZXJhdGVkOiBmYWxzZSwgcmVzb3VyY2UgfSk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIGEgZGVjbGFyYXRpb24gbmFtZXMuIFRoZSBjb25zdHJ1Y3QncyBkZWZhdWx0XG4gICAqIGNoaWxkIGlzIHRoZSBMMSByZXNvdXJjZSBhIGNvbnN0cnVjdCBjcmVhdGVzIGZvciBpdHNlbGYsIHNvIGFuIEwyIGNvbnN0cnVjdFxuICAgKiBpcyB0aGUgZXhwZWN0ZWQgYXJndW1lbnQuXG4gICAqL1xuICBwcml2YXRlIGNsb3VkRm9ybWF0aW9uUmVzb3VyY2UoZGVjbGFyYXRpb246IEFwcFRoZW9yeU5hbWVEZWNsYXJhdGlvbik6IENmblJlc291cmNlIHtcbiAgICBjb25zdCByZXNvdXJjZTogSUNvbnN0cnVjdCA9IGRlY2xhcmF0aW9uLnJlc291cmNlO1xuICAgIGNvbnN0IGNhbmRpZGF0ZTogSUNvbnN0cnVjdCB8IHVuZGVmaW5lZCA9XG4gICAgICByZXNvdXJjZSBpbnN0YW5jZW9mIENmblJlc291cmNlID8gcmVzb3VyY2UgOiByZXNvdXJjZS5ub2RlLmRlZmF1bHRDaGlsZDtcbiAgICBpZiAoIShjYW5kaWRhdGUgaW5zdGFuY2VvZiBDZm5SZXNvdXJjZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgY2Fubm90IGRlY2xhcmUgJHtkZWNsYXJhdGlvbi50eXBlfToke2RlY2xhcmF0aW9uLmxvZ2ljYWx9IGJlY2F1c2UgJHtyZXNvdXJjZS5ub2RlLnBhdGh9IGhhcyBubyBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZSBhcyBpdHMgZGVmYXVsdCBjaGlsZDsgZGVjbGFyZSB0aGUgY29uc3RydWN0IHRoYXQgb3ducyB0aGUgbmFtZWQgcmVzb3VyY2VgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGNhbmRpZGF0ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWZ1c2UgYSBkZWNsYXJhdGlvbiB3aG9zZSBvd25pbmcgc3RhY2sgaXMgaW4gYSBkaWZmZXJlbnQgQ0RLIFN0YWdlIGZyb20gdGhlXG4gICAqIGNvbnRleHQgKFNBTklUWS1BVC1OMy0wMikuXG4gICAqXG4gICAqIEVhY2ggU3RhZ2UgaXMgYSBzZXBhcmF0ZSBjbG91ZCBhc3NlbWJseSwgYW5kIENESyB2YWxpZGF0ZXMgYSB0cmVlIHN0YWdlIGJ5XG4gICAqIHN0YWdlLCBzbyB0aGUgc3ludGggY2hlY2sgbmV2ZXIgc2VlcyB0aGUgb3RoZXIgYXNzZW1ibHk6IGEgY29udGV4dCBhYm92ZSBhXG4gICAqIFN0YWdlIGNhbm5vdCBjb21wYXJlIGl0cyBuYW1lcywgYW5kIGEgZG9jdW1lbnQgd3JpdHRlbiBhZnRlciB0aGF0IGFzc2VtYmx5XG4gICAqIGV4aXN0cyBpcyBzaWxlbnRseSBsb3N0LiBBIGNvbnRleHQgYW5kIGV2ZXJ5IHN0YWNrIGRlY2xhcmluZyB0aHJvdWdoIGl0XG4gICAqIHRoZXJlZm9yZSBiZWxvbmcgdG8gb25lIFN0YWdlIChvciB0byBub25lLCBhdCB0aGUgQXBwIHJvb3QpLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3NlcnRTYW1lU3RhZ2UocmVzb3VyY2VUeXBlOiBzdHJpbmcsIHJlc291cmNlOiBJQ29uc3RydWN0KTogdm9pZCB7XG4gICAgY29uc3Qgb3duZXJTdGFnZSA9IFN0YWdlLm9mKFN0YWNrLm9mKHJlc291cmNlKSk7XG4gICAgY29uc3QgY29udGV4dFN0YWdlID0gU3RhZ2Uub2YodGhpcyk7XG4gICAgaWYgKG93bmVyU3RhZ2UgPT09IGNvbnRleHRTdGFnZSkgcmV0dXJuO1xuICAgIC8vIGBBcHBgIGlzIGEgYFN0YWdlYCBpbiBDREssIHNvIGEgY29uc3RydWN0IGFib3ZlIHRoZSBzdGFja3MgcmVwb3J0cyB0aGUgQXBwXG4gICAgLy8gaXRzZWxmIGFzIGl0cyBTdGFnZTsgdGhhdCBpcyB0aGUgQXBwIHJvb3QsIG5vdCBhIFN0YWdlIHRoZSBjYWxsZXIgbmFtZWQuXG4gICAgY29uc3QgZGVzY3JpYmUgPSAoc3RhZ2U6IFN0YWdlIHwgdW5kZWZpbmVkKTogc3RyaW5nID0+XG4gICAgICBzdGFnZSA9PT0gdW5kZWZpbmVkIHx8IEFwcC5pc0FwcChzdGFnZSkgPyBcInRoZSBBcHAgcm9vdFwiIDogYFN0YWdlICR7c3RhZ2Uubm9kZS5wYXRofWA7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgY2Fubm90IGRlY2xhcmUgJHtyZXNvdXJjZVR5cGV9IGluICR7U3RhY2sub2YocmVzb3VyY2UpLm5vZGUucGF0aH0gYmVjYXVzZSB0aGUgb3duaW5nIHN0YWNrIGlzIGluICR7ZGVzY3JpYmUob3duZXJTdGFnZSl9IHdoaWxlIHRoZSBuYW1pbmcgY29udGV4dCBpcyBpbiAke2Rlc2NyaWJlKGNvbnRleHRTdGFnZSl9OyBhIG5hbWluZyBjb250ZXh0IGFuZCBldmVyeSBzdGFjayB0aGF0IGRlY2xhcmVzIHRocm91Z2ggaXQgbXVzdCBzaXQgaW4gdGhlIHNhbWUgU3RhZ2UsIGJlY2F1c2UgZWFjaCBTdGFnZSBpcyBhIHNlcGFyYXRlIGNsb3VkIGFzc2VtYmx5IHdob3NlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCB0aGUgc3ludGggY2hlY2sgY2Fubm90IGNvbXBhcmUgd2l0aCBhbm90aGVyIFN0YWdlJ3NgLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogUmVmdXNlIGEgZGVjbGFyYXRpb24gd2hvc2Ugb3duaW5nIHN0YWNrIHJlc29sdmVzIHRvIGFuIGVudmlyb25tZW50IHRoZVxuICAgKiBjb250ZXh0IGRvZXMgbm90IGNsYWltIChTQU5JVFktQVQtTjMtMDYpLlxuICAgKlxuICAgKiBUaGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGNsYWltcyB0aGUgY29udGV4dCdzIGFjY291bnQgYW5kIHJlZ2lvbiwgYW5kIHRoZVxuICAgKiByZXNlcnZhdGlvbiBpbmRleCBrZXlzIGEgbmFtZSBieSBpdHMgc2NvcGUgaW4gdGhhdCBlbnZpcm9ubWVudCwgc28gYSBzdGFja1xuICAgKiBpbiBhbm90aGVyIGFjY291bnQgb3IgUmVnaW9uIHdvdWxkIHJlc2VydmUgbmFtZXMgaXQgY2Fubm90IGNyZWF0ZSB3aGlsZSB0aGVcbiAgICogY2hlY2sgcmVmdXNlZCBvciBhZG1pdHRlZCB0aGVtIGFnYWluc3QgdGhlIHdyb25nIGVudmlyb25tZW50LiBBblxuICAgKiBlbnYtYWdub3N0aWMgc3RhY2sgKGFuIHVucmVzb2x2ZWQgYWNjb3VudCBvciByZWdpb24pIGlzIGFkbWl0dGVkOiBpdFxuICAgKiBkZXBsb3lzIGludG8gdGhlIGNvbnRleHQncyBlbnZpcm9ubWVudCwgd2hpY2ggaXMgd2hhdCB0aGUgYXJ0aWZhY3QgY2xhaW1zLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3NlcnRTYW1lRW52aXJvbm1lbnQocmVzb3VyY2VUeXBlOiBzdHJpbmcsIHJlc291cmNlOiBJQ29uc3RydWN0KTogdm9pZCB7XG4gICAgY29uc3Qgb3duZXIgPSBTdGFjay5vZihyZXNvdXJjZSk7XG4gICAgY29uc3QgZGVzY3JpYmVkID0gKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcgPT4gKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgPyBcInVucmVzb2x2ZWRcIiA6IHZhbHVlKTtcbiAgICBjb25zdCBtaXNtYXRjaGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKG93bmVyLmFjY291bnQpICYmIG93bmVyLmFjY291bnQgIT09IHRoaXMuYWNjb3VudCkgbWlzbWF0Y2hlcy5wdXNoKFwiYWNjb3VudFwiKTtcbiAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChvd25lci5yZWdpb24pICYmIG93bmVyLnJlZ2lvbiAhPT0gdGhpcy5yZWdpb24pIG1pc21hdGNoZXMucHVzaChcInJlZ2lvblwiKTtcbiAgICBpZiAobWlzbWF0Y2hlcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBjYW5ub3QgZGVjbGFyZSAke3Jlc291cmNlVHlwZX0gaW4gJHtvd25lci5ub2RlLnBhdGh9IGJlY2F1c2UgdGhlIHN0YWNrIHJlc29sdmVzIHRvIGFjY291bnQgJHtkZXNjcmliZWQob3duZXIuYWNjb3VudCl9IGFuZCByZWdpb24gJHtkZXNjcmliZWQob3duZXIucmVnaW9uKX0sIHdoaWxlIHRoZSBuYW1pbmcgY29udGV4dCBjbGFpbXMgYWNjb3VudCAke3RoaXMuYWNjb3VudH0gYW5kIHJlZ2lvbiAke3RoaXMucmVnaW9ufSAoYXBwICR7dGhpcy5hcHB9LCBzdGFnZSAke3RoaXMuc3RhZ2V9KTsgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBjbGFpbXMgdGhlIGNvbnRleHQncyBlbnZpcm9ubWVudCwgc28gZXZlcnkgc3RhY2sgdGhhdCBkZWNsYXJlcyB0aHJvdWdoIGl0IG11c3QgcmVzb2x2ZSB0byB0aGF0IGVudmlyb25tZW50IG9yIHRvIG5vIGVudmlyb25tZW50IGF0IGFsbGAsXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgbmVhcmVzdCBzdGFjayBhYm92ZSB0aGUgY29udGV4dCwgaWYgaXQgaGFzIG9uZS4gQSBjb250ZXh0IGNyZWF0ZWQgYWJvdmVcbiAgICogdGhlIHN0YWNrcyBoYXMgbm9uZTogaXRzIGFydGlmYWN0IHRoZW4gYXBwZWFycyBvbiB0aGUgc3RhY2tzIGl0c1xuICAgKiBkZWNsYXJhdGlvbnMgYXR0cmlidXRlIHRvLlxuICAgKi9cbiAgcHJpdmF0ZSBvd25pbmdTdGFjaygpOiBTdGFjayB8IHVuZGVmaW5lZCB7XG4gICAgbGV0IHNjb3BlOiBJQ29uc3RydWN0IHwgdW5kZWZpbmVkID0gdGhpcztcbiAgICB3aGlsZSAoc2NvcGUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKFN0YWNrLmlzU3RhY2soc2NvcGUpKSByZXR1cm4gc2NvcGU7XG4gICAgICBzY29wZSA9IHNjb3BlLm5vZGUuc2NvcGU7XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIHBoeXNpY2FsIGxvZy1ncm91cCBuYW1lIG9mIGEgbG9naWNhbCBzb3VyY2UgdW5kZXIgdGhpcyBjb250ZXh0LlxuICAgKi9cbiAgcHVibGljIGxvZ0dyb3VwTmFtZShsb2dpY2FsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5sb2dHcm91cE5hbWUodGhpcy52YWx1ZXMoKSwgbG9naWNhbCk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGJvdW5kIHByZWZpeCBzaGFyZWQgYnkgdGhpcyBhcHAncyBsb2cgc291cmNlcy5cbiAgICovXG4gIHB1YmxpYyBsb2dTb3VyY2VQcmVmaXgoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nU291cmNlUHJlZml4KHRoaXMudmFsdWVzKCkpO1xuICB9XG59XG4iXX0=