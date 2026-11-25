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
     * check refused or admitted them against the wrong environment.
     *
     * The comparison runs on the value **after** `Stack.resolve`, because a
     * stack's account or Region is not always a literal: `env: { region:
     * Lazy.string(...) }` and any other token leave a placeholder on
     * `Stack.region` that `Stack.resolve` turns into the concrete literal the
     * stack will deploy into. Comparing the raw value would admit a token that
     * resolves to another environment and let its rows claim the context's instead
     * (SANITY-AT-N3-06, round 2), so:
     *
     * - a value that resolves to a concrete literal must equal the context's;
     * - a value that is still unresolved after `Stack.resolve` — an `Aws` pseudo
     *   parameter such as `{Ref: AWS::AccountId}`, or a value only known at deploy
     *   time — is admitted: the stack is genuinely environment-agnostic and
     *   deploys into the context's environment, which is what the artifact claims.
     */
    assertSameEnvironment(resourceType, resource) {
        const owner = aws_cdk_lib_1.Stack.of(resource);
        const account = AppTheoryNamingContext.resolvedEnvironmentValue(owner, owner.account);
        const region = AppTheoryNamingContext.resolvedEnvironmentValue(owner, owner.region);
        const mismatches = [];
        if (account !== undefined && account !== this.account)
            mismatches.push("account");
        if (region !== undefined && region !== this.region)
            mismatches.push("region");
        if (mismatches.length === 0)
            return;
        const described = (value) => value ?? "unresolved";
        throw new Error(`AppTheoryNamingContext cannot declare ${resourceType} in ${owner.node.path} because the stack resolves to account ${described(account)} and region ${described(region)}, while the naming context claims account ${this.account} and region ${this.region} (app ${this.app}, stage ${this.stage}); the derived-name artifact claims the context's environment, so every stack that declares through it must resolve to that environment or to no environment at all`);
    }
    /**
     * The concrete literal a stack's account or Region resolves to, or `undefined`
     * when the value stays environment-dependent at synthesis.
     *
     * `Stack.resolve` turns a `Lazy` or any other token into the literal it
     * produces. A pseudo parameter or a reference resolved in a stack without a
     * concrete environment resolves to a CloudFormation intrinsic object instead
     * of a string, which is why the result is typed rather than passed to
     * `Token.isUnresolved` alone: an intrinsic is not a literal and the stack that
     * carries it deploys wherever it is deployed.
     */
    static resolvedEnvironmentValue(owner, value) {
        const resolved = owner.resolve(value);
        if (typeof resolved === "string")
            return aws_cdk_lib_1.Token.isUnresolved(resolved) ? undefined : resolved;
        if (typeof resolved === "number")
            return String(resolved);
        return undefined;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJuYW1pbmctY29udGV4dC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBQUEsNkNBQW9FO0FBQ3BFLDJDQUFtRDtBQUVuRCxxQ0FZa0I7QUFFbEI7Ozs7R0FJRztBQUNILE1BQU0sdUJBQXVCLEdBQUc7SUFDOUIsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSTtDQUN4RyxDQUFDO0FBc0ZGOztHQUVHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUzs7SUFDbkQ7O09BRUc7SUFDYSxTQUFTLENBQVM7SUFFbEM7O09BRUc7SUFDYSxHQUFHLENBQVM7SUFFNUI7O09BRUc7SUFDYSxLQUFLLENBQVM7SUFFOUI7O09BRUc7SUFDYSxPQUFPLENBQVM7SUFFaEM7O09BRUc7SUFDYSxNQUFNLENBQVM7SUFFL0I7O09BRUc7SUFDYSxJQUFJLENBQTRCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUFXO0lBRXBDOztPQUVHO0lBQ2MsUUFBUSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFFOUM7Ozs7O09BS0c7SUFDYyxRQUFRLEdBQStCLEVBQUUsQ0FBQztJQUUzRDs7T0FFRztJQUNhLGFBQWEsQ0FBeUI7SUFFdEQ7O09BRUc7SUFDYSxjQUFjLENBQTBCO0lBRXhEOztPQUVHO0lBQ2EsYUFBYSxDQUFTO0lBRXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBa0M7UUFDMUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FB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O0lBQ0ssTUFBTSxDQUFDLHdCQUF3QixDQUFDLEtBQVksRUFBRSxLQUFhO1FBQ2pFLE1BQU0sUUFBUSxHQUFZLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDL0MsSUFBSSxPQUFPLFFBQVEsS0FBSyxRQUFRO1lBQUUsT0FBTyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7UUFDN0YsSUFBSSxPQUFPLFFBQVEsS0FBSyxRQUFRO1lBQUUsT0FBTyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDMUQsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUVEOzs7O09BSUc7SUFDSyxXQUFXO1FBQ2pCLElBQUksS0FBSyxHQUEyQixJQUFJLENBQUM7UUFDekMsT0FBTyxLQUFLLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDM0IsSUFBSSxtQkFBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUM7Z0JBQUUsT0FBTyxLQUFLLENBQUM7WUFDdkMsS0FBSyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDO1FBQzNCLENBQUM7UUFDRCxPQUFPLFNBQVMsQ0FBQztJQUNuQixDQUFDO0lBRUQ7O09BRUc7SUFDSSxZQUFZLENBQUMsT0FBZTtRQUNqQyxPQUFPLGdDQUF1QixDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDdEUsQ0FBQztJQUVEOztPQUVHO0lBQ0ksZUFBZTtRQUNwQixPQUFPLGdDQUF1QixDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUNoRSxDQUFDOztBQW5hSCx3REFvYUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBcHAsIENmblJlc291cmNlLCBTdGFjaywgU3RhZ2UsIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBJQ29uc3RydWN0LCBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQge1xuICBBcHBUaGVvcnlEZXJpdmVkTmFtZSxcbiAgQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dCxcbiAgQXBwVGhlb3J5RGVyaXZlZE5hbWVzLFxuICBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZSxcbiAgQXBwVGhlb3J5TmFtaW5nUHJvZmlsZSxcbiAgQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgQXBwVGhlb3J5UGh5c2ljYWxOYW1lLFxuICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZyxcbiAgREVSSVZFRF9OQU1FU19NRVRBREFUQV9LRVksXG4gIERFUklWRURfTkFNRVNfU0NIRU1BLFxuICBSRVNPVVJDRV9OQU1JTkdfQ09OVFJBQ1QsXG59IGZyb20gXCIuL25hbWluZ1wiO1xuXG4vKipcbiAqIEFjY2VwdGVkIENsb3VkV2F0Y2ggTG9ncyBgUmV0ZW50aW9uSW5EYXlzYCB2YWx1ZXMuIEFXUyByZWplY3RzIGFueSBvdGhlclxuICogdmFsdWUsIHNvIHRoZSBjb250ZXh0IGZhaWxzIHN5bnRoZXNpcyBpbnN0ZWFkIG9mIGRlZmVycmluZyBhIGRlcGxveS10aW1lXG4gKiBlcnJvci5cbiAqL1xuY29uc3QgQUNDRVBURURfUkVURU5USU9OX0RBWVMgPSBbXG4gIDEsIDMsIDUsIDcsIDE0LCAzMCwgNjAsIDkwLCAxMjAsIDE1MCwgMTgwLCAzNjUsIDQwMCwgNTQ1LCA3MzEsIDEwOTYsIDE4MjcsIDIxOTIsIDI1NTcsIDI5MjIsIDMyODgsIDM2NTMsXG5dO1xuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIGFuIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0YC5cbiAqXG4gKiBUaGUgY29udGV4dCBob2xkcyB0aGUgYm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIHZhbHVlcyBmcm9tIHN0YWdlIGNvbmZpZy5cbiAqIENvbnN0cnVjdHMgdGFrZSBpdCBhcyBhbiBvcHRpb25hbCBwcm9wOyB3aXRoIG5vIGNvbnRleHQgZXZlcnkgY29uc3RydWN0XG4gKiBzeW50aGVzaXplcyBleGFjdGx5IGFzIGl0IGRpZCBiZWZvcmUgdGhpcyBjb250cmFjdCBleGlzdGVkLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU5hbWluZ0NvbnRleHRQcm9wcyB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICogQGRlZmF1bHQgXCJ0aGVvcnljbG91ZFwiXG4gICAqL1xuICByZWFkb25seSBuYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFwcCBpbnN0YW5jZSBpZCBmcm9tIHN0YWdlIGNvbmZpZy5cbiAgICovXG4gIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZCBmcm9tIHN0YWdlIGNvbmZpZy5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFR3ZWx2ZS1kaWdpdCBhY2NvdW50IGlkIGZyb20gc3RhZ2UgY29uZmlnLiBBbiB1bnJlc29sdmVkIHRva2VuIGZhaWxzXG4gICAqIHN5bnRoZXNpcy5cbiAgICovXG4gIHJlYWRvbmx5IGFjY291bnQ6IHN0cmluZztcblxuICAvKipcbiAgICogRnVsbCBSZWdpb24gY29kZSwgZm9yIGV4YW1wbGUgYHVzLWVhc3QtMWAuXG4gICAqL1xuICByZWFkb25seSByZWdpb246IHN0cmluZztcblxuICAvKipcbiAgICogUGh5c2ljYWwgcGlucyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAsIHVzZWQgdmVyYmF0aW0gdW5kZXIgYSBsZWdhY3lcbiAgICogbmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IHt9XG4gICAqL1xuICByZWFkb25seSBwaW5zPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAvKipcbiAgICogR2VuZXJhdGVkLW5hbWUgZW50cmllcyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuIEFuIGVudHJ5IG1lYW5zXG4gICAqIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSB0b2RheSwgc28gdGhlIGNvbnN0cnVjdCBzZXRzIG5vXG4gICAqIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkuIFZhbGlkIG9ubHkgdW5kZXIgdGhlIGxlZ2FjeSBuYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBOYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5ERVJJVkVEXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdQcm9maWxlPzogQXBwVGhlb3J5TmFtaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nZ2luZyBwcm9maWxlLiBgc3RhbmRhcmRgIG9wdHMgZXZlcnkgY29uc3RydWN0IHRoYXQgcmVjZWl2ZXMgdGhlIGNvbnRleHRcbiAgICogaW50byB0aGUgY29udHJhY3QncyBsb2cgZ3JvdXBzIGFuZCBhY2Nlc3MgbG9nZ2luZy4gYGxlZ2FjeWAga2VlcHMgZWFjaFxuICAgKiBjb25zdHJ1Y3QncyBwcmUtY29udHJhY3QgYmVoYXZpb3VyLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZS5MRUdBQ1lcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2dpbmdQcm9maWxlPzogQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBpbiBkYXlzIGZvciBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cHMuIE11c3QgYmUgYSB2YWx1ZVxuICAgKiBDbG91ZFdhdGNoIExvZ3MgYWNjZXB0cy5cbiAgICogQGRlZmF1bHQgMzBcbiAgICovXG4gIHJlYWRvbmx5IHJldGVudGlvbkRheXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogT25lIGRlY2xhcmVkIHBoeXNpY2FsbHkgbmFtZWQgcmVzb3VyY2U6IHRoZSBjb21wb3NlZCBuYW1lLCBhbmQgdGhlIGNvbnN0cnVjdFxuICogd2hvc2UgQ2xvdWRGb3JtYXRpb24gcmVzb3VyY2UgY2FycmllcyBpdC5cbiAqL1xuaW50ZXJmYWNlIEFwcFRoZW9yeU5hbWVEZWNsYXJhdGlvbiB7XG4gIHJlYWRvbmx5IHR5cGU6IHN0cmluZztcbiAgcmVhZG9ubHkgbG9naWNhbDogc3RyaW5nO1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBnZW5lcmF0ZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHJlc291cmNlOiBJQ29uc3RydWN0O1xufVxuXG4vKipcbiAqIFRoZSBib3VuZCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dCBzaGFyZWQgYnkgQXBwVGhlb3J5IGNvbnN0cnVjdHMuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIE5hbWVzcGFjZSBzZWdtZW50LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG5hbWVzcGFjZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBcHAgaW5zdGFuY2UgaWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYXBwOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGlkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFR3ZWx2ZS1kaWdpdCBhY2NvdW50IGlkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFjY291bnQ6IHN0cmluZztcblxuICAvKipcbiAgICogRnVsbCBSZWdpb24gY29kZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSByZWdpb246IHN0cmluZztcblxuICAvKipcbiAgICogUGh5c2ljYWwgcGlucyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcGluczogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAvKipcbiAgICogR2VuZXJhdGVkLW5hbWUgZW50cmllcyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZ2VuZXJhdGVkOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIG5hbWluZyBlbnRyaWVzIGEgY29uc3RydWN0IGhhcyBjb25zdW1lZCBhdCBzeW50aGVzaXMuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGNvbnN1bWVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgLyoqXG4gICAqIFRoZSBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlcyBhIGNvbnN0cnVjdCBoYXMgZGVjbGFyZWQgKGNvbnRyYWN0IHNlY3Rpb25cbiAgICogMTEuNCkuIEVhY2ggZGVjbGFyYXRpb24gdGllcyBvbmUgY29tcG9zZWQgbmFtZSB0byB0aGUgQ2xvdWRGb3JtYXRpb25cbiAgICogcmVzb3VyY2UgdGhhdCBjYXJyaWVzIGl0LCBzbyBzeW50aGVzaXMgY2FuIHJlZnVzZSBhIGNvbGxpc2lvbiBhbmQgZW1pdCB0aGVcbiAgICogZGVyaXZlZC1uYW1lIGFydGlmYWN0IHRoZSByZXNlcnZhdGlvbiBpbmRleCByZXNlcnZlcy5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgZGVjbGFyZWQ6IEFwcFRoZW9yeU5hbWVEZWNsYXJhdGlvbltdID0gW107XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU6IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZ2dpbmcgcHJvZmlsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBsb2dnaW5nUHJvZmlsZTogQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBpbiBkYXlzIGZvciBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cHMuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcmV0ZW50aW9uRGF5czogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChwcm9wcy5hY2NvdW50KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU5hbWluZ0NvbnRleHQgcmVxdWlyZXMgYSBjb25jcmV0ZSBhY2NvdW50IGlkOyB0aGUgbmFtaW5nIGNvbnRyYWN0IGRlcml2ZXMgcGh5c2ljYWwgbmFtZXMgZnJvbSBpdCBhbmQgYW4gdW5yZXNvbHZlZCB0b2tlbiBjYW5ub3QgYmUgdmFsaWRhdGVkIGF0IHN5bnRoZXNpc1wiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChwcm9wcy5yZWdpb24pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJlcXVpcmVzIGEgY29uY3JldGUgcmVnaW9uOyBhbiB1bnJlc29sdmVkIHRva2VuIGNhbm5vdCBiZSB2YWxpZGF0ZWQgYXQgc3ludGhlc2lzXCIpO1xuICAgIH1cblxuICAgIHRoaXMubmFtZXNwYWNlID0gcHJvcHMubmFtZXNwYWNlID8/IFwidGhlb3J5Y2xvdWRcIjtcbiAgICB0aGlzLmFwcCA9IHByb3BzLmFwcDtcbiAgICB0aGlzLnN0YWdlID0gcHJvcHMuc3RhZ2U7XG4gICAgdGhpcy5hY2NvdW50ID0gcHJvcHMuYWNjb3VudDtcbiAgICB0aGlzLnJlZ2lvbiA9IHByb3BzLnJlZ2lvbjtcbiAgICB0aGlzLnBpbnMgPSB7IC4uLihwcm9wcy5waW5zID8/IHt9KSB9O1xuICAgIHRoaXMuZ2VuZXJhdGVkID0gWy4uLihwcm9wcy5nZW5lcmF0ZWQgPz8gW10pXTtcbiAgICB0aGlzLm5hbWluZ1Byb2ZpbGUgPSBwcm9wcy5uYW1pbmdQcm9maWxlID8/IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRDtcbiAgICB0aGlzLmxvZ2dpbmdQcm9maWxlID0gcHJvcHMubG9nZ2luZ1Byb2ZpbGUgPz8gQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuTEVHQUNZO1xuICAgIHRoaXMucmV0ZW50aW9uRGF5cyA9IHByb3BzLnJldGVudGlvbkRheXMgPz8gMzA7XG5cbiAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZUNvbnRleHQodGhpcy52YWx1ZXMoKSk7XG5cbiAgICBpZiAoIUFDQ0VQVEVEX1JFVEVOVElPTl9EQVlTLmluY2x1ZGVzKHRoaXMucmV0ZW50aW9uRGF5cykpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgcmV0ZW50aW9uRGF5cyBtdXN0IGJlIG9uZSBvZiAke0FDQ0VQVEVEX1JFVEVOVElPTl9EQVlTLmpvaW4oXCIsIFwiKX07IENsb3VkV2F0Y2ggTG9ncyByZWplY3RzIG90aGVyIHZhbHVlc2AsXG4gICAgICApO1xuICAgIH1cblxuICAgIHRoaXMubm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICAgIGNvbnN0IG9ycGhhbnMgPSBbLi4ubmV3IFNldChbLi4uT2JqZWN0LmtleXModGhpcy5waW5zKSwgLi4udGhpcy5nZW5lcmF0ZWRdKV0uZmlsdGVyKFxuICAgICAgICAgIChrZXkpID0+ICF0aGlzLmNvbnN1bWVkLmhhcyhrZXkpLFxuICAgICAgICApO1xuICAgICAgICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGlmIChvcnBoYW5zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IG5hbWluZyBlbnRyaWVzIG1hdGNoIG5vIHJlc291cmNlIGluIHRoZSBzdGFjazogJHtvcnBoYW5zLmpvaW4oXCIsIFwiKX07IHJlbW92ZSB0aGVtIG9yIHBhc3MgdGhlIG1hdGNoaW5nIGxvZ2ljYWwgbmFtZSB0byB0aGUgY29uc3RydWN0IHRoYXQgb3ducyB0aGUgcmVzb3VyY2VgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkZWNsYXJlZE9uY2UgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAgICAgY29uc3QgZGVjbGFyYXRpb25zID0gdGhpcy5kZWNsYXJlZFxuICAgICAgICAgIC5tYXAoKGVudHJ5KSA9PiB7XG4gICAgICAgICAgICBjb25zdCByZXNvdXJjZSA9IHRoaXMuY2xvdWRGb3JtYXRpb25SZXNvdXJjZShlbnRyeSk7XG4gICAgICAgICAgICBjb25zdCBvd25lciA9IFN0YWNrLm9mKHJlc291cmNlKTtcbiAgICAgICAgICAgIGNvbnN0IGxvZ2ljYWxJZCA9IFN0cmluZyhvd25lci5yZXNvbHZlKHJlc291cmNlLmxvZ2ljYWxJZCkpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgb3duZXIsXG4gICAgICAgICAgICAgIC8vIEEgQ2xvdWRGb3JtYXRpb24gbG9naWNhbCBpZCBpcyB1bmlxdWUgb25seSBpbnNpZGUgb25lIHRlbXBsYXRlLFxuICAgICAgICAgICAgICAvLyBzbyB0aGUgY29tcGFyaXNvbiBydW5zIG9uIGFuIGlkZW50aXR5IHRoYXQgaXMgdW5pcXVlIGFjcm9zcyB0aGVcbiAgICAgICAgICAgICAgLy8gd2hvbGUgY29udGV4dDogdGhlIG93bmluZyBzdGFjaydzIGNvbnN0cnVjdCBwYXRoIGFuZCB0aGVcbiAgICAgICAgICAgICAgLy8gdGVtcGxhdGUtbG9jYWwgbG9naWNhbCBpZCAoU0FOSVRZLUFULU4zLTA1KS4gVGhlIGFydGlmYWN0IHJvd1xuICAgICAgICAgICAgICAvLyBrZWVwcyB0aGUgdGVtcGxhdGUtbG9jYWwgaWQsIHdoaWNoIGlzIHdoYXQgdGhlIGluc3RhbGxlciBqb2luc1xuICAgICAgICAgICAgICAvLyBvbi5cbiAgICAgICAgICAgICAgaWRlbnRpdHk6IGAke293bmVyLm5vZGUucGF0aH0vJHtsb2dpY2FsSWR9YCxcbiAgICAgICAgICAgICAgaW5wdXQ6IHtcbiAgICAgICAgICAgICAgICAuLi4oZW50cnkubmFtZSAhPT0gdW5kZWZpbmVkID8geyBuYW1lOiBlbnRyeS5uYW1lIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgdHlwZTogZW50cnkudHlwZSxcbiAgICAgICAgICAgICAgICBsb2dpY2FsSWQsXG4gICAgICAgICAgICAgICAgLi4uKGVudHJ5LmdlbmVyYXRlZCA/IHsgZ2VuZXJhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgIH0gYXMgQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfSlcbiAgICAgICAgICAvLyBBIHJlc291cmNlIGRlY2xhcmVkIHR3aWNlIGlzIG9uZSByZXNvdXJjZTogaXQgaXMgYWRtaXR0ZWQsIGFuZCB0aGVcbiAgICAgICAgICAvLyBhcnRpZmFjdCBsaXN0cyBpdCBvbmNlLlxuICAgICAgICAgIC5maWx0ZXIoKGRlY2xhcmF0aW9uKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBrZXkgPSBbXG4gICAgICAgICAgICAgIGRlY2xhcmF0aW9uLmlkZW50aXR5LFxuICAgICAgICAgICAgICBkZWNsYXJhdGlvbi5pbnB1dC50eXBlLFxuICAgICAgICAgICAgICBkZWNsYXJhdGlvbi5pbnB1dC5uYW1lID8/IFwiXCIsXG4gICAgICAgICAgICAgIGRlY2xhcmF0aW9uLmlucHV0LmdlbmVyYXRlZCA9PT0gdHJ1ZSA/IFwiZ2VuZXJhdGVkXCIgOiBcIm5hbWVkXCIsXG4gICAgICAgICAgICBdLmpvaW4oXCJcXHUwMDAwXCIpO1xuICAgICAgICAgICAgaWYgKGRlY2xhcmVkT25jZS5oYXMoa2V5KSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgZGVjbGFyZWRPbmNlLmFkZChrZXkpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgbGV0IGFydGlmYWN0OiBBcHBUaGVvcnlEZXJpdmVkTmFtZVtdID0gW107XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXJ0aWZhY3QgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5zeW50aENoZWNrKFxuICAgICAgICAgICAgZGVjbGFyYXRpb25zLm1hcCgoZGVjbGFyYXRpb24pID0+ICh7IC4uLmRlY2xhcmF0aW9uLmlucHV0LCBsb2dpY2FsSWQ6IGRlY2xhcmF0aW9uLmlkZW50aXR5IH0pKSxcbiAgICAgICAgICApO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgJHtTdHJpbmcoKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlKX07IHR3byBkaWZmZXJlbnQgbG9naWNhbCByZXNvdXJjZXMgaW4gb25lIG5hbWluZyBjb250ZXh0IGNhbm5vdCBzaGFyZSBhIHBoeXNpY2FsIG5hbWUgaW4gdGhlIHNhbWUgc2NvcGVgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGVycm9ycy5sZW5ndGggPiAwKSByZXR1cm4gZXJyb3JzO1xuXG4gICAgICAgIC8vIEV2ZXJ5IGVudHJ5IGlzIGF0dHJpYnV0YWJsZSB0byB0aGUgc3RhY2sgd2hvc2UgdGVtcGxhdGUgaG9sZHMgaXRzXG4gICAgICAgIC8vIGxvZ2ljYWwgaWQsIHNvIGEgY29udGV4dCBzaGFyZWQgYWNyb3NzIHN0YWNrcyBlbWl0cyBvbmUgZG9jdW1lbnQgcGVyXG4gICAgICAgIC8vIHN0YWNrIGluIHRoYXQgc3RhY2sncyBvd24gYHtzdGFja30ubWV0YWRhdGEuanNvbmAgKGNvbnRyYWN0IHNlY3Rpb25cbiAgICAgICAgLy8gMTEuNCkuIFRoZSByZWZ1c2FsIGFib3ZlIHN0aWxsIHNwYW5zIHRoZSB3aG9sZSBjb250ZXh0OiB0d28gc3RhY2tzIGluXG4gICAgICAgIC8vIG9uZSBjb250ZXh0IHRoYXQgZGVyaXZlIHRoZSBzYW1lIG5hbWUgaW4gb25lIHNjb3BlIGFyZSBvbmUgY29sbGlzaW9uLlxuICAgICAgICBjb25zdCBieVN0YWNrID0gbmV3IE1hcDxTdGFjaywgQXBwVGhlb3J5RGVyaXZlZE5hbWVbXT4oKTtcbiAgICAgICAgZGVjbGFyYXRpb25zLmZvckVhY2goKGRlY2xhcmF0aW9uLCBpbmRleCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJvd3MgPSBieVN0YWNrLmdldChkZWNsYXJhdGlvbi5vd25lcikgPz8gW107XG4gICAgICAgICAgY29uc3Qgcm93ID0gYXJ0aWZhY3RbaW5kZXhdIGFzIEFwcFRoZW9yeURlcml2ZWROYW1lO1xuICAgICAgICAgIHJvd3MucHVzaCh7IC4uLnJvdywgbG9naWNhbElkOiAoZGVjbGFyYXRpb24uaW5wdXQgYXMgQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dCkubG9naWNhbElkIH0pO1xuICAgICAgICAgIGJ5U3RhY2suc2V0KGRlY2xhcmF0aW9uLm93bmVyLCByb3dzKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gU2NlbmFyaW8gNDogZXZlcnkgc3ludGggd2l0aCBhIG5hbWluZyBjb250ZXh0IGVtaXRzIHRoZSBhcnRpZmFjdCwgc28gYVxuICAgICAgICAvLyBjb250ZXh0IHdob3NlIGRlY2xhcmF0aW9ucyBhbGwgYXR0cmlidXRlIHRvIG90aGVyIHN0YWNrcyBzdGlsbCBsZWF2ZXNcbiAgICAgICAgLy8gYW4gZXhwbGljaXQgKGVtcHR5KSBkb2N1bWVudCBvbiBpdHMgb3duIHN0YWNrLCBhbmQgdGhlIGluc3RhbGxlciBjYW5cbiAgICAgICAgLy8gdGVsbCBcImRlY2xhcmVzIG5vdGhpbmdcIiBmcm9tIFwibm8gbmFtaW5nIGNvbnRleHQgYXQgYWxsXCIgKHNjZW5hcmlvIDUpLlxuICAgICAgICBjb25zdCBvd25TdGFjayA9IHRoaXMub3duaW5nU3RhY2soKTtcbiAgICAgICAgaWYgKG93blN0YWNrICE9PSB1bmRlZmluZWQgJiYgIWJ5U3RhY2suaGFzKG93blN0YWNrKSkge1xuICAgICAgICAgIGJ5U3RhY2suc2V0KG93blN0YWNrLCBbXSk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGNvbnN0IFtvd25lciwgZW50cmllc10gb2YgYnlTdGFjaykge1xuICAgICAgICAgIGNvbnN0IGRvY3VtZW50OiBBcHBUaGVvcnlEZXJpdmVkTmFtZXMgPSB7XG4gICAgICAgICAgICBjb250cmFjdDogUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNULFxuICAgICAgICAgICAgc2NoZW1hOiBERVJJVkVEX05BTUVTX1NDSEVNQSxcbiAgICAgICAgICAgIGNvbnRleHQ6IHRoaXMudmFsdWVzKCksXG4gICAgICAgICAgICBlbnRyaWVzLFxuICAgICAgICAgIH07XG4gICAgICAgICAgb3duZXIubm9kZS5hZGRNZXRhZGF0YShERVJJVkVEX05BTUVTX01FVEFEQVRBX0tFWSwgSlNPTi5wYXJzZShBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5kZXJpdmVkTmFtZXNKc29uKGRvY3VtZW50KSkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBbXTtcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIGlzIGFjdGl2ZS5cbiAgICovXG4gIHB1YmxpYyBnZXQgc3RhbmRhcmRMb2dnaW5nKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmxvZ2dpbmdQcm9maWxlID09PSBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZS5TVEFOREFSRDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgY29udGV4dCB2YWx1ZXMgYXMgYSBqc2lpIHN0cnVjdC5cbiAgICovXG4gIHB1YmxpYyB2YWx1ZXMoKTogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWVzcGFjZTogdGhpcy5uYW1lc3BhY2UsXG4gICAgICBhcHA6IHRoaXMuYXBwLFxuICAgICAgc3RhZ2U6IHRoaXMuc3RhZ2UsXG4gICAgICBhY2NvdW50OiB0aGlzLmFjY291bnQsXG4gICAgICByZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgcGluczogdGhpcy5waW5zLFxuICAgICAgZ2VuZXJhdGVkOiB0aGlzLmdlbmVyYXRlZCxcbiAgICAgIG5hbWluZ1Byb2ZpbGU6IHRoaXMubmFtaW5nUHJvZmlsZSxcbiAgICAgIGxvZ2dpbmdQcm9maWxlOiB0aGlzLmxvZ2dpbmdQcm9maWxlLFxuICAgICAgcmV0ZW50aW9uRGF5czogdGhpcy5yZXRlbnRpb25EYXlzLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogQ29tcG9zZSB0aGUgcGh5c2ljYWwgbmFtZSBvZiBvbmUgcmVzb3VyY2UgdW5kZXIgdGhpcyBjb250ZXh0LlxuICAgKi9cbiAgcHVibGljIHBoeXNpY2FsTmFtZShyZXNvdXJjZVR5cGU6IHN0cmluZywgbG9naWNhbDogc3RyaW5nKTogQXBwVGhlb3J5UGh5c2ljYWxOYW1lIHtcbiAgICBjb25zdCBjb21wb3NlZCA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnBoeXNpY2FsTmFtZSh0aGlzLnZhbHVlcygpLCByZXNvdXJjZVR5cGUsIGxvZ2ljYWwpO1xuICAgIHRoaXMuY29uc3VtZWQuYWRkKGAke3Jlc291cmNlVHlwZX06JHtsb2dpY2FsfWApO1xuICAgIHJldHVybiBjb21wb3NlZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZWNsYXJlIHRoZSBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZSB0aGF0IGNhcnJpZXMgb25lIGNvbXBvc2VkIG5hbWVcbiAgICogKGNvbnRyYWN0IHNlY3Rpb24gMTEuNCkuXG4gICAqXG4gICAqIFN5bnRoZXNpcyByZWZ1c2VzIHR3byBkaWZmZXJlbnQgbG9naWNhbCByZXNvdXJjZXMgaW4gb25lIG5hbWluZyBjb250ZXh0IHRoYXRcbiAgICogZGVyaXZlIHRoZSBzYW1lIG5hbWUgaW4gdGhlIHNhbWUgbmFtaW5nIHNjb3BlLCBhbmQgZW1pdHMgdGhlIGRlcml2ZWQtbmFtZVxuICAgKiBhcnRpZmFjdCB0aGUgbmFtZSByZXNlcnZhdGlvbiBpbmRleCByZXNlcnZlcy4gQSBjb25zdHJ1Y3QgZGVjbGFyZXMgZXZlcnlcbiAgICogcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSBpdCBjcmVhdGVzOyBhbiBhcHBsaWNhdGlvbiB0aGF0IG5hbWVzIGl0cyBvd25cbiAgICogcmVzb3VyY2Ugd2l0aCBgcGh5c2ljYWxOYW1lYCBkZWNsYXJlcyBpdCBoZXJlIG9uY2UgdGhlIHJlc291cmNlIGV4aXN0cywgc29cbiAgICogdGhlIGFydGlmYWN0IGNvdmVycyBpdCB0b28uXG4gICAqXG4gICAqIEEgbmFtZSBBcHBUaGVvcnkgb25seSB3aXJlcyBmb3IgYSByZXNvdXJjZSBhbm90aGVyIHN0YWNrIG93bnMsIHN1Y2ggYXNcbiAgICogYEFwcFRoZW9yeVNzclNpdGVgJ3MgSVNSIG1ldGFkYXRhIHRhYmxlLCB0YWtlcyBubyBkZWNsYXJhdGlvbiBoZXJlOiB0aGF0XG4gICAqIHN0YWNrIGRlY2xhcmVzIGl0cyBvd24gcmVzb3VyY2UuXG4gICAqXG4gICAqIEEgYGxvZ19ncm91cGAgdHlwZSBkZWNsYXJlcyBhIGxvZy1zb3VyY2UgbmFtZSAoY29udHJhY3Qgc2VjdGlvbiAzKTogYSBsb2dcbiAgICogZ3JvdXAgdGFrZXMgbm8gcGluIG9yIGdlbmVyYXRlZCBlbnRyeS5cbiAgICovXG4gIHB1YmxpYyBkZWNsYXJlTmFtZShyZXNvdXJjZVR5cGU6IHN0cmluZywgbG9naWNhbDogc3RyaW5nLCByZXNvdXJjZTogSUNvbnN0cnVjdCk6IHZvaWQge1xuICAgIHRoaXMuYXNzZXJ0U2FtZVN0YWdlKHJlc291cmNlVHlwZSwgcmVzb3VyY2UpO1xuICAgIHRoaXMuYXNzZXJ0U2FtZUVudmlyb25tZW50KHJlc291cmNlVHlwZSwgcmVzb3VyY2UpO1xuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwibG9nX2dyb3VwXCIpIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5sb2dHcm91cE5hbWUodGhpcy52YWx1ZXMoKSwgbG9naWNhbCk7XG4gICAgICB0aGlzLmRlY2xhcmVkLnB1c2goeyB0eXBlOiByZXNvdXJjZVR5cGUsIGxvZ2ljYWwsIG5hbWUsIGdlbmVyYXRlZDogZmFsc2UsIHJlc291cmNlIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjb21wb3NlZCA9IHRoaXMucGh5c2ljYWxOYW1lKHJlc291cmNlVHlwZSwgbG9naWNhbCk7XG4gICAgdGhpcy5kZWNsYXJlZC5wdXNoKHtcbiAgICAgIHR5cGU6IHJlc291cmNlVHlwZSxcbiAgICAgIGxvZ2ljYWwsXG4gICAgICAuLi4oY29tcG9zZWQuZ2VuZXJhdGVkID8ge30gOiB7IG5hbWU6IGNvbXBvc2VkLm5hbWUgfSksXG4gICAgICBnZW5lcmF0ZWQ6IGNvbXBvc2VkLmdlbmVyYXRlZCA9PT0gdHJ1ZSxcbiAgICAgIHJlc291cmNlLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIERlY2xhcmUgdGhlIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIHRoYXQgY2FycmllcyBvbmUgbmFtZSB0aGUgY29udHJhY3QgZml4ZXNcbiAgICogcmF0aGVyIHRoYW4gZGVyaXZlcyAoY29udHJhY3Qgc2VjdGlvbiAxMS40KS5cbiAgICpcbiAgICogVHdvIG5hbWVzIEFwcFRoZW9yeSBjcmVhdGVzIGZhbGwgb3V0c2lkZSB0aGUgZGVyaXZhdGlvbiB0YWJsZTogdGhlIExhbWJkYVxuICAgKiBzZXJ2aWNlIGxvZyBncm91cCBgL2F3cy9sYW1iZGEve2Z1bmN0aW9uIG5hbWV9YCwgYW5kIHRoZSB2aXNpYmlsaXR5IG1hbmlmZXN0XG4gICAqIHBhcmFtZXRlciBgL3RoZW9yeWNsb3VkL3Zpc2liaWxpdHkve2FwcH0ve3N0YWdlfS9tYW5pZmVzdGAgKGNvbnRyYWN0IHNlY3Rpb25cbiAgICogNikuIFRoZXkgYXJlIHN0aWxsIG5hbWVzIHRoZSBjb250ZXh0IGRldGVybWluZXMgYW5kIHJlc291cmNlcyB0aGUgc3RhY2tcbiAgICogY3JlYXRlcywgc28gdGhlIGFydGlmYWN0IGNhcnJpZXMgdGhlbTsgdGhlIHJlc2VydmVkIHNjb3BlIGlzIHRoZSB0eXBlJ3Mgc2NvcGVcbiAgICogZnJvbSBjb250cmFjdCBzZWN0aW9uIDExLjEuXG4gICAqXG4gICAqIEFuIGFwcGxpY2F0aW9uIHRoYXQgbmFtZXMgaXRzIG93biByZXNvdXJjZSB3aXRoIGEgZml4ZWQgY29udHJhY3QgcGF0aFxuICAgKiBkZWNsYXJlcyBpdCBoZXJlIHRvbywgc28gdGhlIGFydGlmYWN0IGNvdmVycyBpdC5cbiAgICpcbiAgICogQSBmaXhlZCBuYW1lIGlzIHN0aWxsIGEgcGh5c2ljYWwgbmFtZSBvZiBpdHMgdHlwZSwgc28gaXQgbXVzdCBzYXRpc2Z5IHRoZVxuICAgKiBjaGFyYWN0ZXIgYW5kIHNoYXBlIHJ1bGVzIG9mIHRoZSBjb250cmFjdCdzIHNlY3Rpb24gMiBydWxlIHRhYmxlIGZvciB0aGF0XG4gICAqIHR5cGUgKGxlbmd0aCwgY2hhcnNldCwgdGhlIFMzIHN0YXJ0L2VuZCBydWxlLCB0aGUgU1NNIGFuZCBLTVMgcGF0aCBydWxlcyxcbiAgICogdGhlIHNlY3JldCBzdWZmaXggcnVsZSkuIEEgbmFtZSBvdXRzaWRlIHRoZW0gZmFpbHMgc3ludGhlc2lzIGluc3RlYWQgb2ZcbiAgICogZW50ZXJpbmcgdGhlIGFydGlmYWN0IGFzIGEgbmFtZSB0aGUgaW5zdGFsbGVyIGNhbiBuZXZlciBjcmVhdGVcbiAgICogKFNBTklUWS1BVC1OMy0wOCkuXG4gICAqL1xuICBwdWJsaWMgZGVjbGFyZUZpeGVkTmFtZShyZXNvdXJjZVR5cGU6IHN0cmluZywgbmFtZTogc3RyaW5nLCByZXNvdXJjZTogSUNvbnN0cnVjdCk6IHZvaWQge1xuICAgIC8vIEEgdHlwZSBvdXRzaWRlIGNvbnRyYWN0IHNlY3Rpb24gMiBoYXMgbm8gc3RhdGVkIHNjb3BlLCBzbyBpdCBjYW5ub3QgYmVcbiAgICAvLyByZXNlcnZlZDogZGVjbGFyZSBpdCBhbmQgc3ludGhlc2lzIGZhaWxzIGNsb3NlZC5cbiAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5uYW1pbmdTY29wZShyZXNvdXJjZVR5cGUpO1xuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQobmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgY2Fubm90IGRlY2xhcmUgJHtyZXNvdXJjZVR5cGV9IGJlY2F1c2UgdGhlIG5hbWUgaXMgYW4gdW5yZXNvbHZlZCB0b2tlbjsgYSBuYW1lIHRoZSBhcnRpZmFjdCByZXNlcnZlcyBtdXN0IGJlIHJlc29sdmFibGUgYXQgc3ludGhlc2lzYCxcbiAgICAgICk7XG4gICAgfVxuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlUGh5c2ljYWxOYW1lKHJlc291cmNlVHlwZSwgbmFtZSk7XG4gICAgdGhpcy5hc3NlcnRTYW1lU3RhZ2UocmVzb3VyY2VUeXBlLCByZXNvdXJjZSk7XG4gICAgdGhpcy5hc3NlcnRTYW1lRW52aXJvbm1lbnQocmVzb3VyY2VUeXBlLCByZXNvdXJjZSk7XG4gICAgdGhpcy5kZWNsYXJlZC5wdXNoKHsgdHlwZTogcmVzb3VyY2VUeXBlLCBsb2dpY2FsOiBuYW1lLCBuYW1lLCBnZW5lcmF0ZWQ6IGZhbHNlLCByZXNvdXJjZSB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgQ2xvdWRGb3JtYXRpb24gcmVzb3VyY2UgYSBkZWNsYXJhdGlvbiBuYW1lcy4gVGhlIGNvbnN0cnVjdCdzIGRlZmF1bHRcbiAgICogY2hpbGQgaXMgdGhlIEwxIHJlc291cmNlIGEgY29uc3RydWN0IGNyZWF0ZXMgZm9yIGl0c2VsZiwgc28gYW4gTDIgY29uc3RydWN0XG4gICAqIGlzIHRoZSBleHBlY3RlZCBhcmd1bWVudC5cbiAgICovXG4gIHByaXZhdGUgY2xvdWRGb3JtYXRpb25SZXNvdXJjZShkZWNsYXJhdGlvbjogQXBwVGhlb3J5TmFtZURlY2xhcmF0aW9uKTogQ2ZuUmVzb3VyY2Uge1xuICAgIGNvbnN0IHJlc291cmNlOiBJQ29uc3RydWN0ID0gZGVjbGFyYXRpb24ucmVzb3VyY2U7XG4gICAgY29uc3QgY2FuZGlkYXRlOiBJQ29uc3RydWN0IHwgdW5kZWZpbmVkID1cbiAgICAgIHJlc291cmNlIGluc3RhbmNlb2YgQ2ZuUmVzb3VyY2UgPyByZXNvdXJjZSA6IHJlc291cmNlLm5vZGUuZGVmYXVsdENoaWxkO1xuICAgIGlmICghKGNhbmRpZGF0ZSBpbnN0YW5jZW9mIENmblJlc291cmNlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBjYW5ub3QgZGVjbGFyZSAke2RlY2xhcmF0aW9uLnR5cGV9OiR7ZGVjbGFyYXRpb24ubG9naWNhbH0gYmVjYXVzZSAke3Jlc291cmNlLm5vZGUucGF0aH0gaGFzIG5vIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIGFzIGl0cyBkZWZhdWx0IGNoaWxkOyBkZWNsYXJlIHRoZSBjb25zdHJ1Y3QgdGhhdCBvd25zIHRoZSBuYW1lZCByZXNvdXJjZWAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gY2FuZGlkYXRlO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlZnVzZSBhIGRlY2xhcmF0aW9uIHdob3NlIG93bmluZyBzdGFjayBpcyBpbiBhIGRpZmZlcmVudCBDREsgU3RhZ2UgZnJvbSB0aGVcbiAgICogY29udGV4dCAoU0FOSVRZLUFULU4zLTAyKS5cbiAgICpcbiAgICogRWFjaCBTdGFnZSBpcyBhIHNlcGFyYXRlIGNsb3VkIGFzc2VtYmx5LCBhbmQgQ0RLIHZhbGlkYXRlcyBhIHRyZWUgc3RhZ2UgYnlcbiAgICogc3RhZ2UsIHNvIHRoZSBzeW50aCBjaGVjayBuZXZlciBzZWVzIHRoZSBvdGhlciBhc3NlbWJseTogYSBjb250ZXh0IGFib3ZlIGFcbiAgICogU3RhZ2UgY2Fubm90IGNvbXBhcmUgaXRzIG5hbWVzLCBhbmQgYSBkb2N1bWVudCB3cml0dGVuIGFmdGVyIHRoYXQgYXNzZW1ibHlcbiAgICogZXhpc3RzIGlzIHNpbGVudGx5IGxvc3QuIEEgY29udGV4dCBhbmQgZXZlcnkgc3RhY2sgZGVjbGFyaW5nIHRocm91Z2ggaXRcbiAgICogdGhlcmVmb3JlIGJlbG9uZyB0byBvbmUgU3RhZ2UgKG9yIHRvIG5vbmUsIGF0IHRoZSBBcHAgcm9vdCkuXG4gICAqL1xuICBwcml2YXRlIGFzc2VydFNhbWVTdGFnZShyZXNvdXJjZVR5cGU6IHN0cmluZywgcmVzb3VyY2U6IElDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgICBjb25zdCBvd25lclN0YWdlID0gU3RhZ2Uub2YoU3RhY2sub2YocmVzb3VyY2UpKTtcbiAgICBjb25zdCBjb250ZXh0U3RhZ2UgPSBTdGFnZS5vZih0aGlzKTtcbiAgICBpZiAob3duZXJTdGFnZSA9PT0gY29udGV4dFN0YWdlKSByZXR1cm47XG4gICAgLy8gYEFwcGAgaXMgYSBgU3RhZ2VgIGluIENESywgc28gYSBjb25zdHJ1Y3QgYWJvdmUgdGhlIHN0YWNrcyByZXBvcnRzIHRoZSBBcHBcbiAgICAvLyBpdHNlbGYgYXMgaXRzIFN0YWdlOyB0aGF0IGlzIHRoZSBBcHAgcm9vdCwgbm90IGEgU3RhZ2UgdGhlIGNhbGxlciBuYW1lZC5cbiAgICBjb25zdCBkZXNjcmliZSA9IChzdGFnZTogU3RhZ2UgfCB1bmRlZmluZWQpOiBzdHJpbmcgPT5cbiAgICAgIHN0YWdlID09PSB1bmRlZmluZWQgfHwgQXBwLmlzQXBwKHN0YWdlKSA/IFwidGhlIEFwcCByb290XCIgOiBgU3RhZ2UgJHtzdGFnZS5ub2RlLnBhdGh9YDtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBjYW5ub3QgZGVjbGFyZSAke3Jlc291cmNlVHlwZX0gaW4gJHtTdGFjay5vZihyZXNvdXJjZSkubm9kZS5wYXRofSBiZWNhdXNlIHRoZSBvd25pbmcgc3RhY2sgaXMgaW4gJHtkZXNjcmliZShvd25lclN0YWdlKX0gd2hpbGUgdGhlIG5hbWluZyBjb250ZXh0IGlzIGluICR7ZGVzY3JpYmUoY29udGV4dFN0YWdlKX07IGEgbmFtaW5nIGNvbnRleHQgYW5kIGV2ZXJ5IHN0YWNrIHRoYXQgZGVjbGFyZXMgdGhyb3VnaCBpdCBtdXN0IHNpdCBpbiB0aGUgc2FtZSBTdGFnZSwgYmVjYXVzZSBlYWNoIFN0YWdlIGlzIGEgc2VwYXJhdGUgY2xvdWQgYXNzZW1ibHkgd2hvc2UgZGVyaXZlZC1uYW1lIGFydGlmYWN0IHRoZSBzeW50aCBjaGVjayBjYW5ub3QgY29tcGFyZSB3aXRoIGFub3RoZXIgU3RhZ2Unc2AsXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWZ1c2UgYSBkZWNsYXJhdGlvbiB3aG9zZSBvd25pbmcgc3RhY2sgcmVzb2x2ZXMgdG8gYW4gZW52aXJvbm1lbnQgdGhlXG4gICAqIGNvbnRleHQgZG9lcyBub3QgY2xhaW0gKFNBTklUWS1BVC1OMy0wNikuXG4gICAqXG4gICAqIFRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgY2xhaW1zIHRoZSBjb250ZXh0J3MgYWNjb3VudCBhbmQgcmVnaW9uLCBhbmQgdGhlXG4gICAqIHJlc2VydmF0aW9uIGluZGV4IGtleXMgYSBuYW1lIGJ5IGl0cyBzY29wZSBpbiB0aGF0IGVudmlyb25tZW50LCBzbyBhIHN0YWNrXG4gICAqIGluIGFub3RoZXIgYWNjb3VudCBvciBSZWdpb24gd291bGQgcmVzZXJ2ZSBuYW1lcyBpdCBjYW5ub3QgY3JlYXRlIHdoaWxlIHRoZVxuICAgKiBjaGVjayByZWZ1c2VkIG9yIGFkbWl0dGVkIHRoZW0gYWdhaW5zdCB0aGUgd3JvbmcgZW52aXJvbm1lbnQuXG4gICAqXG4gICAqIFRoZSBjb21wYXJpc29uIHJ1bnMgb24gdGhlIHZhbHVlICoqYWZ0ZXIqKiBgU3RhY2sucmVzb2x2ZWAsIGJlY2F1c2UgYVxuICAgKiBzdGFjaydzIGFjY291bnQgb3IgUmVnaW9uIGlzIG5vdCBhbHdheXMgYSBsaXRlcmFsOiBgZW52OiB7IHJlZ2lvbjpcbiAgICogTGF6eS5zdHJpbmcoLi4uKSB9YCBhbmQgYW55IG90aGVyIHRva2VuIGxlYXZlIGEgcGxhY2Vob2xkZXIgb25cbiAgICogYFN0YWNrLnJlZ2lvbmAgdGhhdCBgU3RhY2sucmVzb2x2ZWAgdHVybnMgaW50byB0aGUgY29uY3JldGUgbGl0ZXJhbCB0aGVcbiAgICogc3RhY2sgd2lsbCBkZXBsb3kgaW50by4gQ29tcGFyaW5nIHRoZSByYXcgdmFsdWUgd291bGQgYWRtaXQgYSB0b2tlbiB0aGF0XG4gICAqIHJlc29sdmVzIHRvIGFub3RoZXIgZW52aXJvbm1lbnQgYW5kIGxldCBpdHMgcm93cyBjbGFpbSB0aGUgY29udGV4dCdzIGluc3RlYWRcbiAgICogKFNBTklUWS1BVC1OMy0wNiwgcm91bmQgMiksIHNvOlxuICAgKlxuICAgKiAtIGEgdmFsdWUgdGhhdCByZXNvbHZlcyB0byBhIGNvbmNyZXRlIGxpdGVyYWwgbXVzdCBlcXVhbCB0aGUgY29udGV4dCdzO1xuICAgKiAtIGEgdmFsdWUgdGhhdCBpcyBzdGlsbCB1bnJlc29sdmVkIGFmdGVyIGBTdGFjay5yZXNvbHZlYCDigJQgYW4gYEF3c2AgcHNldWRvXG4gICAqICAgcGFyYW1ldGVyIHN1Y2ggYXMgYHtSZWY6IEFXUzo6QWNjb3VudElkfWAsIG9yIGEgdmFsdWUgb25seSBrbm93biBhdCBkZXBsb3lcbiAgICogICB0aW1lIOKAlCBpcyBhZG1pdHRlZDogdGhlIHN0YWNrIGlzIGdlbnVpbmVseSBlbnZpcm9ubWVudC1hZ25vc3RpYyBhbmRcbiAgICogICBkZXBsb3lzIGludG8gdGhlIGNvbnRleHQncyBlbnZpcm9ubWVudCwgd2hpY2ggaXMgd2hhdCB0aGUgYXJ0aWZhY3QgY2xhaW1zLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3NlcnRTYW1lRW52aXJvbm1lbnQocmVzb3VyY2VUeXBlOiBzdHJpbmcsIHJlc291cmNlOiBJQ29uc3RydWN0KTogdm9pZCB7XG4gICAgY29uc3Qgb3duZXIgPSBTdGFjay5vZihyZXNvdXJjZSk7XG4gICAgY29uc3QgYWNjb3VudCA9IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQucmVzb2x2ZWRFbnZpcm9ubWVudFZhbHVlKG93bmVyLCBvd25lci5hY2NvdW50KTtcbiAgICBjb25zdCByZWdpb24gPSBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LnJlc29sdmVkRW52aXJvbm1lbnRWYWx1ZShvd25lciwgb3duZXIucmVnaW9uKTtcbiAgICBjb25zdCBtaXNtYXRjaGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChhY2NvdW50ICE9PSB1bmRlZmluZWQgJiYgYWNjb3VudCAhPT0gdGhpcy5hY2NvdW50KSBtaXNtYXRjaGVzLnB1c2goXCJhY2NvdW50XCIpO1xuICAgIGlmIChyZWdpb24gIT09IHVuZGVmaW5lZCAmJiByZWdpb24gIT09IHRoaXMucmVnaW9uKSBtaXNtYXRjaGVzLnB1c2goXCJyZWdpb25cIik7XG4gICAgaWYgKG1pc21hdGNoZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZGVzY3JpYmVkID0gKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcgPT4gdmFsdWUgPz8gXCJ1bnJlc29sdmVkXCI7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgY2Fubm90IGRlY2xhcmUgJHtyZXNvdXJjZVR5cGV9IGluICR7b3duZXIubm9kZS5wYXRofSBiZWNhdXNlIHRoZSBzdGFjayByZXNvbHZlcyB0byBhY2NvdW50ICR7ZGVzY3JpYmVkKGFjY291bnQpfSBhbmQgcmVnaW9uICR7ZGVzY3JpYmVkKHJlZ2lvbil9LCB3aGlsZSB0aGUgbmFtaW5nIGNvbnRleHQgY2xhaW1zIGFjY291bnQgJHt0aGlzLmFjY291bnR9IGFuZCByZWdpb24gJHt0aGlzLnJlZ2lvbn0gKGFwcCAke3RoaXMuYXBwfSwgc3RhZ2UgJHt0aGlzLnN0YWdlfSk7IHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgY2xhaW1zIHRoZSBjb250ZXh0J3MgZW52aXJvbm1lbnQsIHNvIGV2ZXJ5IHN0YWNrIHRoYXQgZGVjbGFyZXMgdGhyb3VnaCBpdCBtdXN0IHJlc29sdmUgdG8gdGhhdCBlbnZpcm9ubWVudCBvciB0byBubyBlbnZpcm9ubWVudCBhdCBhbGxgLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGNvbmNyZXRlIGxpdGVyYWwgYSBzdGFjaydzIGFjY291bnQgb3IgUmVnaW9uIHJlc29sdmVzIHRvLCBvciBgdW5kZWZpbmVkYFxuICAgKiB3aGVuIHRoZSB2YWx1ZSBzdGF5cyBlbnZpcm9ubWVudC1kZXBlbmRlbnQgYXQgc3ludGhlc2lzLlxuICAgKlxuICAgKiBgU3RhY2sucmVzb2x2ZWAgdHVybnMgYSBgTGF6eWAgb3IgYW55IG90aGVyIHRva2VuIGludG8gdGhlIGxpdGVyYWwgaXRcbiAgICogcHJvZHVjZXMuIEEgcHNldWRvIHBhcmFtZXRlciBvciBhIHJlZmVyZW5jZSByZXNvbHZlZCBpbiBhIHN0YWNrIHdpdGhvdXQgYVxuICAgKiBjb25jcmV0ZSBlbnZpcm9ubWVudCByZXNvbHZlcyB0byBhIENsb3VkRm9ybWF0aW9uIGludHJpbnNpYyBvYmplY3QgaW5zdGVhZFxuICAgKiBvZiBhIHN0cmluZywgd2hpY2ggaXMgd2h5IHRoZSByZXN1bHQgaXMgdHlwZWQgcmF0aGVyIHRoYW4gcGFzc2VkIHRvXG4gICAqIGBUb2tlbi5pc1VucmVzb2x2ZWRgIGFsb25lOiBhbiBpbnRyaW5zaWMgaXMgbm90IGEgbGl0ZXJhbCBhbmQgdGhlIHN0YWNrIHRoYXRcbiAgICogY2FycmllcyBpdCBkZXBsb3lzIHdoZXJldmVyIGl0IGlzIGRlcGxveWVkLlxuICAgKi9cbiAgcHJpdmF0ZSBzdGF0aWMgcmVzb2x2ZWRFbnZpcm9ubWVudFZhbHVlKG93bmVyOiBTdGFjaywgdmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgcmVzb2x2ZWQ6IHVua25vd24gPSBvd25lci5yZXNvbHZlKHZhbHVlKTtcbiAgICBpZiAodHlwZW9mIHJlc29sdmVkID09PSBcInN0cmluZ1wiKSByZXR1cm4gVG9rZW4uaXNVbnJlc29sdmVkKHJlc29sdmVkKSA/IHVuZGVmaW5lZCA6IHJlc29sdmVkO1xuICAgIGlmICh0eXBlb2YgcmVzb2x2ZWQgPT09IFwibnVtYmVyXCIpIHJldHVybiBTdHJpbmcocmVzb2x2ZWQpO1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIG5lYXJlc3Qgc3RhY2sgYWJvdmUgdGhlIGNvbnRleHQsIGlmIGl0IGhhcyBvbmUuIEEgY29udGV4dCBjcmVhdGVkIGFib3ZlXG4gICAqIHRoZSBzdGFja3MgaGFzIG5vbmU6IGl0cyBhcnRpZmFjdCB0aGVuIGFwcGVhcnMgb24gdGhlIHN0YWNrcyBpdHNcbiAgICogZGVjbGFyYXRpb25zIGF0dHJpYnV0ZSB0by5cbiAgICovXG4gIHByaXZhdGUgb3duaW5nU3RhY2soKTogU3RhY2sgfCB1bmRlZmluZWQge1xuICAgIGxldCBzY29wZTogSUNvbnN0cnVjdCB8IHVuZGVmaW5lZCA9IHRoaXM7XG4gICAgd2hpbGUgKHNjb3BlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChTdGFjay5pc1N0YWNrKHNjb3BlKSkgcmV0dXJuIHNjb3BlO1xuICAgICAgc2NvcGUgPSBzY29wZS5ub2RlLnNjb3BlO1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBwaHlzaWNhbCBsb2ctZ3JvdXAgbmFtZSBvZiBhIGxvZ2ljYWwgc291cmNlIHVuZGVyIHRoaXMgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyBsb2dHcm91cE5hbWUobG9naWNhbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nR3JvdXBOYW1lKHRoaXMudmFsdWVzKCksIGxvZ2ljYWwpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBib3VuZCBwcmVmaXggc2hhcmVkIGJ5IHRoaXMgYXBwJ3MgbG9nIHNvdXJjZXMuXG4gICAqL1xuICBwdWJsaWMgbG9nU291cmNlUHJlZml4KCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ1NvdXJjZVByZWZpeCh0aGlzLnZhbHVlcygpKTtcbiAgfVxufVxuIl19