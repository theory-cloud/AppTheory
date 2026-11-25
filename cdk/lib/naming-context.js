"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryNamingContext = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const constructs_1 = require("constructs");
const naming_1 = require("./naming");
const log_source_grammar_1 = require("./private/log-source-grammar");
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
     * Twelve-digit account id. The derived-name artifact claims this account; it
     * is not compared with any declaring stack's account.
     */
    account;
    /**
     * Full Region code. The derived-name artifact claims this Region; it is not
     * compared with any declaring stack's Region.
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
     *
     * A fixed `log_group` name is narrowed further, because a log-group name is
     * either this context's own log source or the Lambda service path and nothing
     * else: the structural check in `validatePhysicalName` cannot know the bound
     * prefix, so the context completes it here (see
     * `assertFixedLogGroupName`).
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
        if (resourceType === "log_group") {
            this.assertFixedLogGroupName(name);
        }
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
     * Admit only the two fixed log-group shapes contract section 3 states for a
     * log group this context owns (SANITY-AT-N3-08, round 4).
     *
     * A log group is either a log source of this context —
     * `theorycloud_{namespace}_{app}_{stage}_{logical}`, built from this
     * context's own namespace, app and stage — or the Lambda service path
     * `/aws/lambda/{function name}`. `validatePhysicalName` already refused every
     * other `/`-bearing shape, but it is structural: it holds no context values,
     * so it admits any `/`-free name, including one that is no log source at all
     * (`orders`) or one shaped for another context
     * (`theorycloud_other_app_lab_x`). Both would enter the artifact as names the
     * installer reserves and this app's logging never writes, so the context
     * completes the rule where the bound prefix is known.
     */
    assertFixedLogGroupName(name) {
        // The Lambda service path is the one shape that carries a `/`: its function
        // name was already checked against the lambda_function row.
        if (name.startsWith(log_source_grammar_1.LAMBDA_LOG_GROUP_LEAD))
            return;
        const prefix = this.logSourcePrefix();
        const remainder = name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
        if (remainder !== undefined && log_source_grammar_1.LOG_SOURCE_REMAINDER_RE.test(remainder))
            return;
        const quoted = JSON.stringify(name);
        throw new Error(`AppTheoryNamingContext cannot declare log_group ${quoted} because a fixed log-group name is either this context's section 3 log source, ${JSON.stringify(prefix)} followed by "logs" and the logical source's segments joined with "_", or the Lambda service path ${JSON.stringify(log_source_grammar_1.LAMBDA_LOG_GROUP_LEAD)} followed by a name that satisfies the lambda_function row (app ${this.app}, stage ${this.stage}, namespace ${this.namespace}); got ${quoted}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJuYW1pbmctY29udGV4dC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBQUEsNkNBQW9FO0FBQ3BFLDJDQUFtRDtBQUVuRCxxQ0FZa0I7QUFDbEIscUVBQThGO0FBRTlGOzs7O0dBSUc7QUFDSCxNQUFNLHVCQUF1QixHQUFHO0lBQzlCLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUk7Q0FDeEcsQ0FBQztBQStGRjs7R0FFRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7O0lBQ25EOztPQUVHO0lBQ2EsU0FBUyxDQUFTO0lBRWxDOztPQUVHO0lBQ2EsR0FBRyxDQUFTO0lBRTVCOztPQUVHO0lBQ2EsS0FBSyxDQUFTO0lBRTlCOzs7T0FHRztJQUNhLE9BQU8sQ0FBUztJQUVoQzs7O09BR0c7SUFDYSxNQUFNLENBQVM7SUFFL0I7O09BRUc7SUFDYSxJQUFJLENBQTRCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUFXO0lBRXBDOztPQUVHO0lBQ2MsUUFBUSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFFOUM7Ozs7O09BS0c7SUFDYyxRQUFRLEdBQStCLEVBQUUsQ0FBQztJQUUzRDs7T0FFRztJQUNhLGFBQWEsQ0FBeUI7SUFFdEQ7O09BRUc7SUFDYSxjQUFjLENBQTBCO0lBRXhEOztPQUVHO0lBQ2EsYUFBYSxDQUFTO0lBRXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBa0M7UUFDMUUsS0FBSyxDQUFDLEtBQUssRUFB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U0FBUyxDQUFDO0lBQ25CLENBQUM7SUFFRDs7T0FFRztJQUNJLFlBQVksQ0FBQyxPQUFlO1FBQ2pDLE9BQU8sZ0NBQXVCLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUN0RSxDQUFDO0lBRUQ7O09BRUc7SUFDSSxlQUFlO1FBQ3BCLE9BQU8sZ0NBQXVCLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQ2hFLENBQUM7O0FBalpILHdEQWtaQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEFwcCwgQ2ZuUmVzb3VyY2UsIFN0YWNrLCBTdGFnZSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB7IElDb25zdHJ1Y3QsIENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7XG4gIEFwcFRoZW9yeURlcml2ZWROYW1lLFxuICBBcHBUaGVvcnlEZXJpdmVkTmFtZUlucHV0LFxuICBBcHBUaGVvcnlEZXJpdmVkTmFtZXMsXG4gIEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLFxuICBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLFxuICBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzLFxuICBBcHBUaGVvcnlQaHlzaWNhbE5hbWUsXG4gIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLFxuICBERVJJVkVEX05BTUVTX01FVEFEQVRBX0tFWSxcbiAgREVSSVZFRF9OQU1FU19TQ0hFTUEsXG4gIFJFU09VUkNFX05BTUlOR19DT05UUkFDVCxcbn0gZnJvbSBcIi4vbmFtaW5nXCI7XG5pbXBvcnQgeyBMQU1CREFfTE9HX0dST1VQX0xFQUQsIExPR19TT1VSQ0VfUkVNQUlOREVSX1JFIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2ctc291cmNlLWdyYW1tYXJcIjtcblxuLyoqXG4gKiBBY2NlcHRlZCBDbG91ZFdhdGNoIExvZ3MgYFJldGVudGlvbkluRGF5c2AgdmFsdWVzLiBBV1MgcmVqZWN0cyBhbnkgb3RoZXJcbiAqIHZhbHVlLCBzbyB0aGUgY29udGV4dCBmYWlscyBzeW50aGVzaXMgaW5zdGVhZCBvZiBkZWZlcnJpbmcgYSBkZXBsb3ktdGltZVxuICogZXJyb3IuXG4gKi9cbmNvbnN0IEFDQ0VQVEVEX1JFVEVOVElPTl9EQVlTID0gW1xuICAxLCAzLCA1LCA3LCAxNCwgMzAsIDYwLCA5MCwgMTIwLCAxNTAsIDE4MCwgMzY1LCA0MDAsIDU0NSwgNzMxLCAxMDk2LCAxODI3LCAyMTkyLCAyNTU3LCAyOTIyLCAzMjg4LCAzNjUzLFxuXTtcblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBhbiBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dGAuXG4gKlxuICogVGhlIGNvbnRleHQgaG9sZHMgdGhlIGJvdW5kIG5hbWluZyBhbmQgbG9nZ2luZyB2YWx1ZXMgZnJvbSBzdGFnZSBjb25maWcuXG4gKiBDb25zdHJ1Y3RzIHRha2UgaXQgYXMgYW4gb3B0aW9uYWwgcHJvcDsgd2l0aCBubyBjb250ZXh0IGV2ZXJ5IGNvbnN0cnVjdFxuICogc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBpdCBkaWQgYmVmb3JlIHRoaXMgY29udHJhY3QgZXhpc3RlZC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlOYW1pbmdDb250ZXh0UHJvcHMge1xuICAvKipcbiAgICogTmFtZXNwYWNlIHNlZ21lbnQuXG4gICAqIEBkZWZhdWx0IFwidGhlb3J5Y2xvdWRcIlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZXNwYWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBcHAgaW5zdGFuY2UgaWQgZnJvbSBzdGFnZSBjb25maWcuXG4gICAqL1xuICByZWFkb25seSBhcHA6IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgaWQgZnJvbSBzdGFnZSBjb25maWcuXG4gICAqL1xuICByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZCBmcm9tIHN0YWdlIGNvbmZpZy4gQW4gdW5yZXNvbHZlZCB0b2tlbiBmYWlsc1xuICAgKiBzeW50aGVzaXMuXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIGFjY291bnQgdGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBjbGFpbXMuIEFwcFRoZW9yeSBkb2VzIG5vdFxuICAgKiBjb21wYXJlIGl0IHdpdGggdGhlIGFjY291bnQgb2YgdGhlIHN0YWNrIHRoYXQgZGVjbGFyZXMgYSByZXNvdXJjZTtcbiAgICogVGhlb3J5Q2xvdWQuYWkncyBpbnN0YWxsZXIgdmFsaWRhdGVzIHRoZSBhcnRpZmFjdCdzIGFjY291bnQgYWdhaW5zdCB0aGVcbiAgICogc3RhY2sgaXQgZGVwbG95cy5cbiAgICovXG4gIHJlYWRvbmx5IGFjY291bnQ6IHN0cmluZztcblxuICAvKipcbiAgICogRnVsbCBSZWdpb24gY29kZSwgZm9yIGV4YW1wbGUgYHVzLWVhc3QtMWAuXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIFJlZ2lvbiB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGNsYWltcy4gQXBwVGhlb3J5IGRvZXMgbm90XG4gICAqIGNvbXBhcmUgaXQgd2l0aCB0aGUgUmVnaW9uIG9mIHRoZSBzdGFjayB0aGF0IGRlY2xhcmVzIGEgcmVzb3VyY2U7XG4gICAqIFRoZW9yeUNsb3VkLmFpJ3MgaW5zdGFsbGVyIHZhbGlkYXRlcyBpdCBhZ2FpbnN0IHRoZSBzdGFjayBpdCBkZXBsb3lzLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLCB1c2VkIHZlcmJhdGltIHVuZGVyIGEgbGVnYWN5XG4gICAqIG5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCB7fVxuICAgKi9cbiAgcmVhZG9ubHkgcGlucz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlZC1uYW1lIGVudHJpZXMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLiBBbiBlbnRyeSBtZWFuc1xuICAgKiBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgdG9kYXksIHNvIHRoZSBjb25zdHJ1Y3Qgc2V0cyBub1xuICAgKiBwaHlzaWNhbC1uYW1lIHByb3BlcnR5LiBWYWxpZCBvbmx5IHVuZGVyIHRoZSBsZWdhY3kgbmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nUHJvZmlsZT86IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZ2dpbmcgcHJvZmlsZS4gYHN0YW5kYXJkYCBvcHRzIGV2ZXJ5IGNvbnN0cnVjdCB0aGF0IHJlY2VpdmVzIHRoZSBjb250ZXh0XG4gICAqIGludG8gdGhlIGNvbnRyYWN0J3MgbG9nIGdyb3VwcyBhbmQgYWNjZXNzIGxvZ2dpbmcuIGBsZWdhY3lgIGtlZXBzIGVhY2hcbiAgICogY29uc3RydWN0J3MgcHJlLWNvbnRyYWN0IGJlaGF2aW91ci5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuTEVHQUNZXG4gICAqL1xuICByZWFkb25seSBsb2dnaW5nUHJvZmlsZT86IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gaW4gZGF5cyBmb3Igc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXBzLiBNdXN0IGJlIGEgdmFsdWVcbiAgICogQ2xvdWRXYXRjaCBMb2dzIGFjY2VwdHMuXG4gICAqIEBkZWZhdWx0IDMwXG4gICAqL1xuICByZWFkb25seSByZXRlbnRpb25EYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIE9uZSBkZWNsYXJlZCBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlOiB0aGUgY29tcG9zZWQgbmFtZSwgYW5kIHRoZSBjb25zdHJ1Y3RcbiAqIHdob3NlIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIGNhcnJpZXMgaXQuXG4gKi9cbmludGVyZmFjZSBBcHBUaGVvcnlOYW1lRGVjbGFyYXRpb24ge1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGxvZ2ljYWw6IHN0cmluZztcbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZ2VuZXJhdGVkOiBib29sZWFuO1xuICByZWFkb25seSByZXNvdXJjZTogSUNvbnN0cnVjdDtcbn1cblxuLyoqXG4gKiBUaGUgYm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQgc2hhcmVkIGJ5IEFwcFRoZW9yeSBjb25zdHJ1Y3RzLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuYW1lc3BhY2U6IHN0cmluZztcblxuICAvKipcbiAgICogQXBwIGluc3RhbmNlIGlkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZC4gVGhlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBjbGFpbXMgdGhpcyBhY2NvdW50OyBpdFxuICAgKiBpcyBub3QgY29tcGFyZWQgd2l0aCBhbnkgZGVjbGFyaW5nIHN0YWNrJ3MgYWNjb3VudC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUuIFRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgY2xhaW1zIHRoaXMgUmVnaW9uOyBpdCBpcyBub3RcbiAgICogY29tcGFyZWQgd2l0aCBhbnkgZGVjbGFyaW5nIHN0YWNrJ3MgUmVnaW9uLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJlZ2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBQaHlzaWNhbCBwaW5zIGtleWVkIGB7dHlwZX06e2xvZ2ljYWx9YC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBwaW5zOiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9O1xuXG4gIC8qKlxuICAgKiBHZW5lcmF0ZWQtbmFtZSBlbnRyaWVzIGtleWVkIGB7dHlwZX06e2xvZ2ljYWx9YC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBnZW5lcmF0ZWQ6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgbmFtaW5nIGVudHJpZXMgYSBjb25zdHJ1Y3QgaGFzIGNvbnN1bWVkIGF0IHN5bnRoZXNpcy5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgY29uc3VtZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICAvKipcbiAgICogVGhlIHBoeXNpY2FsbHkgbmFtZWQgcmVzb3VyY2VzIGEgY29uc3RydWN0IGhhcyBkZWNsYXJlZCAoY29udHJhY3Qgc2VjdGlvblxuICAgKiAxMS40KS4gRWFjaCBkZWNsYXJhdGlvbiB0aWVzIG9uZSBjb21wb3NlZCBuYW1lIHRvIHRoZSBDbG91ZEZvcm1hdGlvblxuICAgKiByZXNvdXJjZSB0aGF0IGNhcnJpZXMgaXQsIHNvIHN5bnRoZXNpcyBjYW4gcmVmdXNlIGEgY29sbGlzaW9uIGFuZCBlbWl0IHRoZVxuICAgKiBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgdGhlIHJlc2VydmF0aW9uIGluZGV4IHJlc2VydmVzLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBkZWNsYXJlZDogQXBwVGhlb3J5TmFtZURlY2xhcmF0aW9uW10gPSBbXTtcblxuICAvKipcbiAgICogTmFtaW5nIHByb2ZpbGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbmFtaW5nUHJvZmlsZTogQXBwVGhlb3J5TmFtaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogTG9nZ2luZyBwcm9maWxlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGxvZ2dpbmdQcm9maWxlOiBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIGluIGRheXMgZm9yIHN0YW5kYXJkLXByb2ZpbGUgbG9nIGdyb3Vwcy5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSByZXRlbnRpb25EYXlzOiBudW1iZXI7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHByb3BzLmFjY291bnQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TmFtaW5nQ29udGV4dCByZXF1aXJlcyBhIGNvbmNyZXRlIGFjY291bnQgaWQ7IHRoZSBuYW1pbmcgY29udHJhY3QgZGVyaXZlcyBwaHlzaWNhbCBuYW1lcyBmcm9tIGl0IGFuZCBhbiB1bnJlc29sdmVkIHRva2VuIGNhbm5vdCBiZSB2YWxpZGF0ZWQgYXQgc3ludGhlc2lzXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHByb3BzLnJlZ2lvbikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU5hbWluZ0NvbnRleHQgcmVxdWlyZXMgYSBjb25jcmV0ZSByZWdpb247IGFuIHVucmVzb2x2ZWQgdG9rZW4gY2Fubm90IGJlIHZhbGlkYXRlZCBhdCBzeW50aGVzaXNcIik7XG4gICAgfVxuXG4gICAgdGhpcy5uYW1lc3BhY2UgPSBwcm9wcy5uYW1lc3BhY2UgPz8gXCJ0aGVvcnljbG91ZFwiO1xuICAgIHRoaXMuYXBwID0gcHJvcHMuYXBwO1xuICAgIHRoaXMuc3RhZ2UgPSBwcm9wcy5zdGFnZTtcbiAgICB0aGlzLmFjY291bnQgPSBwcm9wcy5hY2NvdW50O1xuICAgIHRoaXMucmVnaW9uID0gcHJvcHMucmVnaW9uO1xuICAgIHRoaXMucGlucyA9IHsgLi4uKHByb3BzLnBpbnMgPz8ge30pIH07XG4gICAgdGhpcy5nZW5lcmF0ZWQgPSBbLi4uKHByb3BzLmdlbmVyYXRlZCA/PyBbXSldO1xuICAgIHRoaXMubmFtaW5nUHJvZmlsZSA9IHByb3BzLm5hbWluZ1Byb2ZpbGUgPz8gQXBwVGhlb3J5TmFtaW5nUHJvZmlsZS5ERVJJVkVEO1xuICAgIHRoaXMubG9nZ2luZ1Byb2ZpbGUgPSBwcm9wcy5sb2dnaW5nUHJvZmlsZSA/PyBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZS5MRUdBQ1k7XG4gICAgdGhpcy5yZXRlbnRpb25EYXlzID0gcHJvcHMucmV0ZW50aW9uRGF5cyA/PyAzMDtcblxuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlQ29udGV4dCh0aGlzLnZhbHVlcygpKTtcblxuICAgIGlmICghQUNDRVBURURfUkVURU5USU9OX0RBWVMuaW5jbHVkZXModGhpcy5yZXRlbnRpb25EYXlzKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCByZXRlbnRpb25EYXlzIG11c3QgYmUgb25lIG9mICR7QUNDRVBURURfUkVURU5USU9OX0RBWVMuam9pbihcIiwgXCIpfTsgQ2xvdWRXYXRjaCBMb2dzIHJlamVjdHMgb3RoZXIgdmFsdWVzYCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdGhpcy5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgICAgY29uc3Qgb3JwaGFucyA9IFsuLi5uZXcgU2V0KFsuLi5PYmplY3Qua2V5cyh0aGlzLnBpbnMpLCAuLi50aGlzLmdlbmVyYXRlZF0pXS5maWx0ZXIoXG4gICAgICAgICAgKGtleSkgPT4gIXRoaXMuY29uc3VtZWQuaGFzKGtleSksXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgaWYgKG9ycGhhbnMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgbmFtaW5nIGVudHJpZXMgbWF0Y2ggbm8gcmVzb3VyY2UgaW4gdGhlIHN0YWNrOiAke29ycGhhbnMuam9pbihcIiwgXCIpfTsgcmVtb3ZlIHRoZW0gb3IgcGFzcyB0aGUgbWF0Y2hpbmcgbG9naWNhbCBuYW1lIHRvIHRoZSBjb25zdHJ1Y3QgdGhhdCBvd25zIHRoZSByZXNvdXJjZWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGRlY2xhcmVkT25jZSA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgICAgICBjb25zdCBkZWNsYXJhdGlvbnMgPSB0aGlzLmRlY2xhcmVkXG4gICAgICAgICAgLm1hcCgoZW50cnkpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc291cmNlID0gdGhpcy5jbG91ZEZvcm1hdGlvblJlc291cmNlKGVudHJ5KTtcbiAgICAgICAgICAgIGNvbnN0IG93bmVyID0gU3RhY2sub2YocmVzb3VyY2UpO1xuICAgICAgICAgICAgY29uc3QgbG9naWNhbElkID0gU3RyaW5nKG93bmVyLnJlc29sdmUocmVzb3VyY2UubG9naWNhbElkKSk7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBvd25lcixcbiAgICAgICAgICAgICAgLy8gQSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIGlzIHVuaXF1ZSBvbmx5IGluc2lkZSBvbmUgdGVtcGxhdGUsXG4gICAgICAgICAgICAgIC8vIHNvIHRoZSBjb21wYXJpc29uIHJ1bnMgb24gYW4gaWRlbnRpdHkgdGhhdCBpcyB1bmlxdWUgYWNyb3NzIHRoZVxuICAgICAgICAgICAgICAvLyB3aG9sZSBjb250ZXh0OiB0aGUgb3duaW5nIHN0YWNrJ3MgY29uc3RydWN0IHBhdGggYW5kIHRoZVxuICAgICAgICAgICAgICAvLyB0ZW1wbGF0ZS1sb2NhbCBsb2dpY2FsIGlkIChTQU5JVFktQVQtTjMtMDUpLiBUaGUgYXJ0aWZhY3Qgcm93XG4gICAgICAgICAgICAgIC8vIGtlZXBzIHRoZSB0ZW1wbGF0ZS1sb2NhbCBpZCwgd2hpY2ggaXMgd2hhdCB0aGUgaW5zdGFsbGVyIGpvaW5zXG4gICAgICAgICAgICAgIC8vIG9uLlxuICAgICAgICAgICAgICBpZGVudGl0eTogYCR7b3duZXIubm9kZS5wYXRofS8ke2xvZ2ljYWxJZH1gLFxuICAgICAgICAgICAgICBpbnB1dDoge1xuICAgICAgICAgICAgICAgIC4uLihlbnRyeS5uYW1lICE9PSB1bmRlZmluZWQgPyB7IG5hbWU6IGVudHJ5Lm5hbWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICB0eXBlOiBlbnRyeS50eXBlLFxuICAgICAgICAgICAgICAgIGxvZ2ljYWxJZCxcbiAgICAgICAgICAgICAgICAuLi4oZW50cnkuZ2VuZXJhdGVkID8geyBnZW5lcmF0ZWQ6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgfSBhcyBBcHBUaGVvcnlEZXJpdmVkTmFtZUlucHV0LFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC8vIEEgcmVzb3VyY2UgZGVjbGFyZWQgdHdpY2UgaXMgb25lIHJlc291cmNlOiBpdCBpcyBhZG1pdHRlZCwgYW5kIHRoZVxuICAgICAgICAgIC8vIGFydGlmYWN0IGxpc3RzIGl0IG9uY2UuXG4gICAgICAgICAgLmZpbHRlcigoZGVjbGFyYXRpb24pID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IFtcbiAgICAgICAgICAgICAgZGVjbGFyYXRpb24uaWRlbnRpdHksXG4gICAgICAgICAgICAgIGRlY2xhcmF0aW9uLmlucHV0LnR5cGUsXG4gICAgICAgICAgICAgIGRlY2xhcmF0aW9uLmlucHV0Lm5hbWUgPz8gXCJcIixcbiAgICAgICAgICAgICAgZGVjbGFyYXRpb24uaW5wdXQuZ2VuZXJhdGVkID09PSB0cnVlID8gXCJnZW5lcmF0ZWRcIiA6IFwibmFtZWRcIixcbiAgICAgICAgICAgIF0uam9pbihcIlxcdTAwMDBcIik7XG4gICAgICAgICAgICBpZiAoZGVjbGFyZWRPbmNlLmhhcyhrZXkpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBkZWNsYXJlZE9uY2UuYWRkKGtleSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9KTtcblxuICAgICAgICBsZXQgYXJ0aWZhY3Q6IEFwcFRoZW9yeURlcml2ZWROYW1lW10gPSBbXTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhcnRpZmFjdCA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnN5bnRoQ2hlY2soXG4gICAgICAgICAgICBkZWNsYXJhdGlvbnMubWFwKChkZWNsYXJhdGlvbikgPT4gKHsgLi4uZGVjbGFyYXRpb24uaW5wdXQsIGxvZ2ljYWxJZDogZGVjbGFyYXRpb24uaWRlbnRpdHkgfSkpLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCAke1N0cmluZygoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UpfTsgdHdvIGRpZmZlcmVudCBsb2dpY2FsIHJlc291cmNlcyBpbiBvbmUgbmFtaW5nIGNvbnRleHQgY2Fubm90IHNoYXJlIGEgcGh5c2ljYWwgbmFtZSBpbiB0aGUgc2FtZSBzY29wZWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXJyb3JzLmxlbmd0aCA+IDApIHJldHVybiBlcnJvcnM7XG5cbiAgICAgICAgLy8gRXZlcnkgZW50cnkgaXMgYXR0cmlidXRhYmxlIHRvIHRoZSBzdGFjayB3aG9zZSB0ZW1wbGF0ZSBob2xkcyBpdHNcbiAgICAgICAgLy8gbG9naWNhbCBpZCwgc28gYSBjb250ZXh0IHNoYXJlZCBhY3Jvc3Mgc3RhY2tzIGVtaXRzIG9uZSBkb2N1bWVudCBwZXJcbiAgICAgICAgLy8gc3RhY2sgaW4gdGhhdCBzdGFjaydzIG93biBge3N0YWNrfS5tZXRhZGF0YS5qc29uYCAoY29udHJhY3Qgc2VjdGlvblxuICAgICAgICAvLyAxMS40KS4gVGhlIHJlZnVzYWwgYWJvdmUgc3RpbGwgc3BhbnMgdGhlIHdob2xlIGNvbnRleHQ6IHR3byBzdGFja3MgaW5cbiAgICAgICAgLy8gb25lIGNvbnRleHQgdGhhdCBkZXJpdmUgdGhlIHNhbWUgbmFtZSBpbiBvbmUgc2NvcGUgYXJlIG9uZSBjb2xsaXNpb24uXG4gICAgICAgIGNvbnN0IGJ5U3RhY2sgPSBuZXcgTWFwPFN0YWNrLCBBcHBUaGVvcnlEZXJpdmVkTmFtZVtdPigpO1xuICAgICAgICBkZWNsYXJhdGlvbnMuZm9yRWFjaCgoZGVjbGFyYXRpb24sIGluZGV4KSA9PiB7XG4gICAgICAgICAgY29uc3Qgcm93cyA9IGJ5U3RhY2suZ2V0KGRlY2xhcmF0aW9uLm93bmVyKSA/PyBbXTtcbiAgICAgICAgICBjb25zdCByb3cgPSBhcnRpZmFjdFtpbmRleF0gYXMgQXBwVGhlb3J5RGVyaXZlZE5hbWU7XG4gICAgICAgICAgcm93cy5wdXNoKHsgLi4ucm93LCBsb2dpY2FsSWQ6IChkZWNsYXJhdGlvbi5pbnB1dCBhcyBBcHBUaGVvcnlEZXJpdmVkTmFtZUlucHV0KS5sb2dpY2FsSWQgfSk7XG4gICAgICAgICAgYnlTdGFjay5zZXQoZGVjbGFyYXRpb24ub3duZXIsIHJvd3MpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBTY2VuYXJpbyA0OiBldmVyeSBzeW50aCB3aXRoIGEgbmFtaW5nIGNvbnRleHQgZW1pdHMgdGhlIGFydGlmYWN0LCBzbyBhXG4gICAgICAgIC8vIGNvbnRleHQgd2hvc2UgZGVjbGFyYXRpb25zIGFsbCBhdHRyaWJ1dGUgdG8gb3RoZXIgc3RhY2tzIHN0aWxsIGxlYXZlc1xuICAgICAgICAvLyBhbiBleHBsaWNpdCAoZW1wdHkpIGRvY3VtZW50IG9uIGl0cyBvd24gc3RhY2ssIGFuZCB0aGUgaW5zdGFsbGVyIGNhblxuICAgICAgICAvLyB0ZWxsIFwiZGVjbGFyZXMgbm90aGluZ1wiIGZyb20gXCJubyBuYW1pbmcgY29udGV4dCBhdCBhbGxcIiAoc2NlbmFyaW8gNSkuXG4gICAgICAgIGNvbnN0IG93blN0YWNrID0gdGhpcy5vd25pbmdTdGFjaygpO1xuICAgICAgICBpZiAob3duU3RhY2sgIT09IHVuZGVmaW5lZCAmJiAhYnlTdGFjay5oYXMob3duU3RhY2spKSB7XG4gICAgICAgICAgYnlTdGFjay5zZXQob3duU3RhY2ssIFtdKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZvciAoY29uc3QgW293bmVyLCBlbnRyaWVzXSBvZiBieVN0YWNrKSB7XG4gICAgICAgICAgY29uc3QgZG9jdW1lbnQ6IEFwcFRoZW9yeURlcml2ZWROYW1lcyA9IHtcbiAgICAgICAgICAgIGNvbnRyYWN0OiBSRVNPVVJDRV9OQU1JTkdfQ09OVFJBQ1QsXG4gICAgICAgICAgICBzY2hlbWE6IERFUklWRURfTkFNRVNfU0NIRU1BLFxuICAgICAgICAgICAgY29udGV4dDogdGhpcy52YWx1ZXMoKSxcbiAgICAgICAgICAgIGVudHJpZXMsXG4gICAgICAgICAgfTtcbiAgICAgICAgICBvd25lci5ub2RlLmFkZE1ldGFkYXRhKERFUklWRURfTkFNRVNfTUVUQURBVEFfS0VZLCBKU09OLnBhcnNlKEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmRlcml2ZWROYW1lc0pzb24oZG9jdW1lbnQpKSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgaXMgYWN0aXZlLlxuICAgKi9cbiAgcHVibGljIGdldCBzdGFuZGFyZExvZ2dpbmcoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMubG9nZ2luZ1Byb2ZpbGUgPT09IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLlNUQU5EQVJEO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBjb250ZXh0IHZhbHVlcyBhcyBhIGpzaWkgc3RydWN0LlxuICAgKi9cbiAgcHVibGljIHZhbHVlcygpOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0VmFsdWVzIHtcbiAgICByZXR1cm4ge1xuICAgICAgbmFtZXNwYWNlOiB0aGlzLm5hbWVzcGFjZSxcbiAgICAgIGFwcDogdGhpcy5hcHAsXG4gICAgICBzdGFnZTogdGhpcy5zdGFnZSxcbiAgICAgIGFjY291bnQ6IHRoaXMuYWNjb3VudCxcbiAgICAgIHJlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICBwaW5zOiB0aGlzLnBpbnMsXG4gICAgICBnZW5lcmF0ZWQ6IHRoaXMuZ2VuZXJhdGVkLFxuICAgICAgbmFtaW5nUHJvZmlsZTogdGhpcy5uYW1pbmdQcm9maWxlLFxuICAgICAgbG9nZ2luZ1Byb2ZpbGU6IHRoaXMubG9nZ2luZ1Byb2ZpbGUsXG4gICAgICByZXRlbnRpb25EYXlzOiB0aGlzLnJldGVudGlvbkRheXMsXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21wb3NlIHRoZSBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZSB1bmRlciB0aGlzIGNvbnRleHQuXG4gICAqL1xuICBwdWJsaWMgcGh5c2ljYWxOYW1lKHJlc291cmNlVHlwZTogc3RyaW5nLCBsb2dpY2FsOiBzdHJpbmcpOiBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAgIGNvbnN0IGNvbXBvc2VkID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcucGh5c2ljYWxOYW1lKHRoaXMudmFsdWVzKCksIHJlc291cmNlVHlwZSwgbG9naWNhbCk7XG4gICAgdGhpcy5jb25zdW1lZC5hZGQoYCR7cmVzb3VyY2VUeXBlfToke2xvZ2ljYWx9YCk7XG4gICAgcmV0dXJuIGNvbXBvc2VkO1xuICB9XG5cbiAgLyoqXG4gICAqIERlY2xhcmUgdGhlIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIHRoYXQgY2FycmllcyBvbmUgY29tcG9zZWQgbmFtZVxuICAgKiAoY29udHJhY3Qgc2VjdGlvbiAxMS40KS5cbiAgICpcbiAgICogU3ludGhlc2lzIHJlZnVzZXMgdHdvIGRpZmZlcmVudCBsb2dpY2FsIHJlc291cmNlcyBpbiBvbmUgbmFtaW5nIGNvbnRleHQgdGhhdFxuICAgKiBkZXJpdmUgdGhlIHNhbWUgbmFtZSBpbiB0aGUgc2FtZSBuYW1pbmcgc2NvcGUsIGFuZCBlbWl0cyB0aGUgZGVyaXZlZC1uYW1lXG4gICAqIGFydGlmYWN0IHRoZSBuYW1lIHJlc2VydmF0aW9uIGluZGV4IHJlc2VydmVzLiBBIGNvbnN0cnVjdCBkZWNsYXJlcyBldmVyeVxuICAgKiBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlIGl0IGNyZWF0ZXM7IGFuIGFwcGxpY2F0aW9uIHRoYXQgbmFtZXMgaXRzIG93blxuICAgKiByZXNvdXJjZSB3aXRoIGBwaHlzaWNhbE5hbWVgIGRlY2xhcmVzIGl0IGhlcmUgb25jZSB0aGUgcmVzb3VyY2UgZXhpc3RzLCBzb1xuICAgKiB0aGUgYXJ0aWZhY3QgY292ZXJzIGl0IHRvby5cbiAgICpcbiAgICogQSBuYW1lIEFwcFRoZW9yeSBvbmx5IHdpcmVzIGZvciBhIHJlc291cmNlIGFub3RoZXIgc3RhY2sgb3ducywgc3VjaCBhc1xuICAgKiBgQXBwVGhlb3J5U3NyU2l0ZWAncyBJU1IgbWV0YWRhdGEgdGFibGUsIHRha2VzIG5vIGRlY2xhcmF0aW9uIGhlcmU6IHRoYXRcbiAgICogc3RhY2sgZGVjbGFyZXMgaXRzIG93biByZXNvdXJjZS5cbiAgICpcbiAgICogQSBgbG9nX2dyb3VwYCB0eXBlIGRlY2xhcmVzIGEgbG9nLXNvdXJjZSBuYW1lIChjb250cmFjdCBzZWN0aW9uIDMpOiBhIGxvZ1xuICAgKiBncm91cCB0YWtlcyBubyBwaW4gb3IgZ2VuZXJhdGVkIGVudHJ5LlxuICAgKi9cbiAgcHVibGljIGRlY2xhcmVOYW1lKHJlc291cmNlVHlwZTogc3RyaW5nLCBsb2dpY2FsOiBzdHJpbmcsIHJlc291cmNlOiBJQ29uc3RydWN0KTogdm9pZCB7XG4gICAgdGhpcy5hc3NlcnRTYW1lU3RhZ2UocmVzb3VyY2VUeXBlLCByZXNvdXJjZSk7XG4gICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJsb2dfZ3JvdXBcIikge1xuICAgICAgY29uc3QgbmFtZSA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ0dyb3VwTmFtZSh0aGlzLnZhbHVlcygpLCBsb2dpY2FsKTtcbiAgICAgIHRoaXMuZGVjbGFyZWQucHVzaCh7IHR5cGU6IHJlc291cmNlVHlwZSwgbG9naWNhbCwgbmFtZSwgZ2VuZXJhdGVkOiBmYWxzZSwgcmVzb3VyY2UgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGNvbXBvc2VkID0gdGhpcy5waHlzaWNhbE5hbWUocmVzb3VyY2VUeXBlLCBsb2dpY2FsKTtcbiAgICB0aGlzLmRlY2xhcmVkLnB1c2goe1xuICAgICAgdHlwZTogcmVzb3VyY2VUeXBlLFxuICAgICAgbG9naWNhbCxcbiAgICAgIC4uLihjb21wb3NlZC5nZW5lcmF0ZWQgPyB7fSA6IHsgbmFtZTogY29tcG9zZWQubmFtZSB9KSxcbiAgICAgIGdlbmVyYXRlZDogY29tcG9zZWQuZ2VuZXJhdGVkID09PSB0cnVlLFxuICAgICAgcmVzb3VyY2UsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogRGVjbGFyZSB0aGUgQ2xvdWRGb3JtYXRpb24gcmVzb3VyY2UgdGhhdCBjYXJyaWVzIG9uZSBuYW1lIHRoZSBjb250cmFjdCBmaXhlc1xuICAgKiByYXRoZXIgdGhhbiBkZXJpdmVzIChjb250cmFjdCBzZWN0aW9uIDExLjQpLlxuICAgKlxuICAgKiBUd28gbmFtZXMgQXBwVGhlb3J5IGNyZWF0ZXMgZmFsbCBvdXRzaWRlIHRoZSBkZXJpdmF0aW9uIHRhYmxlOiB0aGUgTGFtYmRhXG4gICAqIHNlcnZpY2UgbG9nIGdyb3VwIGAvYXdzL2xhbWJkYS97ZnVuY3Rpb24gbmFtZX1gLCBhbmQgdGhlIHZpc2liaWxpdHkgbWFuaWZlc3RcbiAgICogcGFyYW1ldGVyIGAvdGhlb3J5Y2xvdWQvdmlzaWJpbGl0eS97YXBwfS97c3RhZ2V9L21hbmlmZXN0YCAoY29udHJhY3Qgc2VjdGlvblxuICAgKiA2KS4gVGhleSBhcmUgc3RpbGwgbmFtZXMgdGhlIGNvbnRleHQgZGV0ZXJtaW5lcyBhbmQgcmVzb3VyY2VzIHRoZSBzdGFja1xuICAgKiBjcmVhdGVzLCBzbyB0aGUgYXJ0aWZhY3QgY2FycmllcyB0aGVtOyB0aGUgcmVzZXJ2ZWQgc2NvcGUgaXMgdGhlIHR5cGUncyBzY29wZVxuICAgKiBmcm9tIGNvbnRyYWN0IHNlY3Rpb24gMTEuMS5cbiAgICpcbiAgICogQW4gYXBwbGljYXRpb24gdGhhdCBuYW1lcyBpdHMgb3duIHJlc291cmNlIHdpdGggYSBmaXhlZCBjb250cmFjdCBwYXRoXG4gICAqIGRlY2xhcmVzIGl0IGhlcmUgdG9vLCBzbyB0aGUgYXJ0aWZhY3QgY292ZXJzIGl0LlxuICAgKlxuICAgKiBBIGZpeGVkIG5hbWUgaXMgc3RpbGwgYSBwaHlzaWNhbCBuYW1lIG9mIGl0cyB0eXBlLCBzbyBpdCBtdXN0IHNhdGlzZnkgdGhlXG4gICAqIGNoYXJhY3RlciBhbmQgc2hhcGUgcnVsZXMgb2YgdGhlIGNvbnRyYWN0J3Mgc2VjdGlvbiAyIHJ1bGUgdGFibGUgZm9yIHRoYXRcbiAgICogdHlwZSAobGVuZ3RoLCBjaGFyc2V0LCB0aGUgUzMgc3RhcnQvZW5kIHJ1bGUsIHRoZSBTU00gYW5kIEtNUyBwYXRoIHJ1bGVzLFxuICAgKiB0aGUgc2VjcmV0IHN1ZmZpeCBydWxlKS4gQSBuYW1lIG91dHNpZGUgdGhlbSBmYWlscyBzeW50aGVzaXMgaW5zdGVhZCBvZlxuICAgKiBlbnRlcmluZyB0aGUgYXJ0aWZhY3QgYXMgYSBuYW1lIHRoZSBpbnN0YWxsZXIgY2FuIG5ldmVyIGNyZWF0ZVxuICAgKiAoU0FOSVRZLUFULU4zLTA4KS5cbiAgICpcbiAgICogQSBmaXhlZCBgbG9nX2dyb3VwYCBuYW1lIGlzIG5hcnJvd2VkIGZ1cnRoZXIsIGJlY2F1c2UgYSBsb2ctZ3JvdXAgbmFtZSBpc1xuICAgKiBlaXRoZXIgdGhpcyBjb250ZXh0J3Mgb3duIGxvZyBzb3VyY2Ugb3IgdGhlIExhbWJkYSBzZXJ2aWNlIHBhdGggYW5kIG5vdGhpbmdcbiAgICogZWxzZTogdGhlIHN0cnVjdHVyYWwgY2hlY2sgaW4gYHZhbGlkYXRlUGh5c2ljYWxOYW1lYCBjYW5ub3Qga25vdyB0aGUgYm91bmRcbiAgICogcHJlZml4LCBzbyB0aGUgY29udGV4dCBjb21wbGV0ZXMgaXQgaGVyZSAoc2VlXG4gICAqIGBhc3NlcnRGaXhlZExvZ0dyb3VwTmFtZWApLlxuICAgKi9cbiAgcHVibGljIGRlY2xhcmVGaXhlZE5hbWUocmVzb3VyY2VUeXBlOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgcmVzb3VyY2U6IElDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgICAvLyBBIHR5cGUgb3V0c2lkZSBjb250cmFjdCBzZWN0aW9uIDIgaGFzIG5vIHN0YXRlZCBzY29wZSwgc28gaXQgY2Fubm90IGJlXG4gICAgLy8gcmVzZXJ2ZWQ6IGRlY2xhcmUgaXQgYW5kIHN5bnRoZXNpcyBmYWlscyBjbG9zZWQuXG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubmFtaW5nU2NvcGUocmVzb3VyY2VUeXBlKTtcbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKG5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IGNhbm5vdCBkZWNsYXJlICR7cmVzb3VyY2VUeXBlfSBiZWNhdXNlIHRoZSBuYW1lIGlzIGFuIHVucmVzb2x2ZWQgdG9rZW47IGEgbmFtZSB0aGUgYXJ0aWZhY3QgcmVzZXJ2ZXMgbXVzdCBiZSByZXNvbHZhYmxlIGF0IHN5bnRoZXNpc2AsXG4gICAgICApO1xuICAgIH1cbiAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy52YWxpZGF0ZVBoeXNpY2FsTmFtZShyZXNvdXJjZVR5cGUsIG5hbWUpO1xuICAgIHRoaXMuYXNzZXJ0U2FtZVN0YWdlKHJlc291cmNlVHlwZSwgcmVzb3VyY2UpO1xuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwibG9nX2dyb3VwXCIpIHtcbiAgICAgIHRoaXMuYXNzZXJ0Rml4ZWRMb2dHcm91cE5hbWUobmFtZSk7XG4gICAgfVxuICAgIHRoaXMuZGVjbGFyZWQucHVzaCh7IHR5cGU6IHJlc291cmNlVHlwZSwgbG9naWNhbDogbmFtZSwgbmFtZSwgZ2VuZXJhdGVkOiBmYWxzZSwgcmVzb3VyY2UgfSk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIGEgZGVjbGFyYXRpb24gbmFtZXMuIFRoZSBjb25zdHJ1Y3QncyBkZWZhdWx0XG4gICAqIGNoaWxkIGlzIHRoZSBMMSByZXNvdXJjZSBhIGNvbnN0cnVjdCBjcmVhdGVzIGZvciBpdHNlbGYsIHNvIGFuIEwyIGNvbnN0cnVjdFxuICAgKiBpcyB0aGUgZXhwZWN0ZWQgYXJndW1lbnQuXG4gICAqL1xuICBwcml2YXRlIGNsb3VkRm9ybWF0aW9uUmVzb3VyY2UoZGVjbGFyYXRpb246IEFwcFRoZW9yeU5hbWVEZWNsYXJhdGlvbik6IENmblJlc291cmNlIHtcbiAgICBjb25zdCByZXNvdXJjZTogSUNvbnN0cnVjdCA9IGRlY2xhcmF0aW9uLnJlc291cmNlO1xuICAgIGNvbnN0IGNhbmRpZGF0ZTogSUNvbnN0cnVjdCB8IHVuZGVmaW5lZCA9XG4gICAgICByZXNvdXJjZSBpbnN0YW5jZW9mIENmblJlc291cmNlID8gcmVzb3VyY2UgOiByZXNvdXJjZS5ub2RlLmRlZmF1bHRDaGlsZDtcbiAgICBpZiAoIShjYW5kaWRhdGUgaW5zdGFuY2VvZiBDZm5SZXNvdXJjZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgY2Fubm90IGRlY2xhcmUgJHtkZWNsYXJhdGlvbi50eXBlfToke2RlY2xhcmF0aW9uLmxvZ2ljYWx9IGJlY2F1c2UgJHtyZXNvdXJjZS5ub2RlLnBhdGh9IGhhcyBubyBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZSBhcyBpdHMgZGVmYXVsdCBjaGlsZDsgZGVjbGFyZSB0aGUgY29uc3RydWN0IHRoYXQgb3ducyB0aGUgbmFtZWQgcmVzb3VyY2VgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGNhbmRpZGF0ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWZ1c2UgYSBkZWNsYXJhdGlvbiB3aG9zZSBvd25pbmcgc3RhY2sgaXMgaW4gYSBkaWZmZXJlbnQgQ0RLIFN0YWdlIGZyb20gdGhlXG4gICAqIGNvbnRleHQgKFNBTklUWS1BVC1OMy0wMikuXG4gICAqXG4gICAqIEVhY2ggU3RhZ2UgaXMgYSBzZXBhcmF0ZSBjbG91ZCBhc3NlbWJseSwgYW5kIENESyB2YWxpZGF0ZXMgYSB0cmVlIHN0YWdlIGJ5XG4gICAqIHN0YWdlLCBzbyB0aGUgc3ludGggY2hlY2sgbmV2ZXIgc2VlcyB0aGUgb3RoZXIgYXNzZW1ibHk6IGEgY29udGV4dCBhYm92ZSBhXG4gICAqIFN0YWdlIGNhbm5vdCBjb21wYXJlIGl0cyBuYW1lcywgYW5kIGEgZG9jdW1lbnQgd3JpdHRlbiBhZnRlciB0aGF0IGFzc2VtYmx5XG4gICAqIGV4aXN0cyBpcyBzaWxlbnRseSBsb3N0LiBBIGNvbnRleHQgYW5kIGV2ZXJ5IHN0YWNrIGRlY2xhcmluZyB0aHJvdWdoIGl0XG4gICAqIHRoZXJlZm9yZSBiZWxvbmcgdG8gb25lIFN0YWdlIChvciB0byBub25lLCBhdCB0aGUgQXBwIHJvb3QpLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3NlcnRTYW1lU3RhZ2UocmVzb3VyY2VUeXBlOiBzdHJpbmcsIHJlc291cmNlOiBJQ29uc3RydWN0KTogdm9pZCB7XG4gICAgY29uc3Qgb3duZXJTdGFnZSA9IFN0YWdlLm9mKFN0YWNrLm9mKHJlc291cmNlKSk7XG4gICAgY29uc3QgY29udGV4dFN0YWdlID0gU3RhZ2Uub2YodGhpcyk7XG4gICAgaWYgKG93bmVyU3RhZ2UgPT09IGNvbnRleHRTdGFnZSkgcmV0dXJuO1xuICAgIC8vIGBBcHBgIGlzIGEgYFN0YWdlYCBpbiBDREssIHNvIGEgY29uc3RydWN0IGFib3ZlIHRoZSBzdGFja3MgcmVwb3J0cyB0aGUgQXBwXG4gICAgLy8gaXRzZWxmIGFzIGl0cyBTdGFnZTsgdGhhdCBpcyB0aGUgQXBwIHJvb3QsIG5vdCBhIFN0YWdlIHRoZSBjYWxsZXIgbmFtZWQuXG4gICAgY29uc3QgZGVzY3JpYmUgPSAoc3RhZ2U6IFN0YWdlIHwgdW5kZWZpbmVkKTogc3RyaW5nID0+XG4gICAgICBzdGFnZSA9PT0gdW5kZWZpbmVkIHx8IEFwcC5pc0FwcChzdGFnZSkgPyBcInRoZSBBcHAgcm9vdFwiIDogYFN0YWdlICR7c3RhZ2Uubm9kZS5wYXRofWA7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgY2Fubm90IGRlY2xhcmUgJHtyZXNvdXJjZVR5cGV9IGluICR7U3RhY2sub2YocmVzb3VyY2UpLm5vZGUucGF0aH0gYmVjYXVzZSB0aGUgb3duaW5nIHN0YWNrIGlzIGluICR7ZGVzY3JpYmUob3duZXJTdGFnZSl9IHdoaWxlIHRoZSBuYW1pbmcgY29udGV4dCBpcyBpbiAke2Rlc2NyaWJlKGNvbnRleHRTdGFnZSl9OyBhIG5hbWluZyBjb250ZXh0IGFuZCBldmVyeSBzdGFjayB0aGF0IGRlY2xhcmVzIHRocm91Z2ggaXQgbXVzdCBzaXQgaW4gdGhlIHNhbWUgU3RhZ2UsIGJlY2F1c2UgZWFjaCBTdGFnZSBpcyBhIHNlcGFyYXRlIGNsb3VkIGFzc2VtYmx5IHdob3NlIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCB0aGUgc3ludGggY2hlY2sgY2Fubm90IGNvbXBhcmUgd2l0aCBhbm90aGVyIFN0YWdlJ3NgLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQWRtaXQgb25seSB0aGUgdHdvIGZpeGVkIGxvZy1ncm91cCBzaGFwZXMgY29udHJhY3Qgc2VjdGlvbiAzIHN0YXRlcyBmb3IgYVxuICAgKiBsb2cgZ3JvdXAgdGhpcyBjb250ZXh0IG93bnMgKFNBTklUWS1BVC1OMy0wOCwgcm91bmQgNCkuXG4gICAqXG4gICAqIEEgbG9nIGdyb3VwIGlzIGVpdGhlciBhIGxvZyBzb3VyY2Ugb2YgdGhpcyBjb250ZXh0IOKAlFxuICAgKiBgdGhlb3J5Y2xvdWRfe25hbWVzcGFjZX1fe2FwcH1fe3N0YWdlfV97bG9naWNhbH1gLCBidWlsdCBmcm9tIHRoaXNcbiAgICogY29udGV4dCdzIG93biBuYW1lc3BhY2UsIGFwcCBhbmQgc3RhZ2Ug4oCUIG9yIHRoZSBMYW1iZGEgc2VydmljZSBwYXRoXG4gICAqIGAvYXdzL2xhbWJkYS97ZnVuY3Rpb24gbmFtZX1gLiBgdmFsaWRhdGVQaHlzaWNhbE5hbWVgIGFscmVhZHkgcmVmdXNlZCBldmVyeVxuICAgKiBvdGhlciBgL2AtYmVhcmluZyBzaGFwZSwgYnV0IGl0IGlzIHN0cnVjdHVyYWw6IGl0IGhvbGRzIG5vIGNvbnRleHQgdmFsdWVzLFxuICAgKiBzbyBpdCBhZG1pdHMgYW55IGAvYC1mcmVlIG5hbWUsIGluY2x1ZGluZyBvbmUgdGhhdCBpcyBubyBsb2cgc291cmNlIGF0IGFsbFxuICAgKiAoYG9yZGVyc2ApIG9yIG9uZSBzaGFwZWQgZm9yIGFub3RoZXIgY29udGV4dFxuICAgKiAoYHRoZW9yeWNsb3VkX290aGVyX2FwcF9sYWJfeGApLiBCb3RoIHdvdWxkIGVudGVyIHRoZSBhcnRpZmFjdCBhcyBuYW1lcyB0aGVcbiAgICogaW5zdGFsbGVyIHJlc2VydmVzIGFuZCB0aGlzIGFwcCdzIGxvZ2dpbmcgbmV2ZXIgd3JpdGVzLCBzbyB0aGUgY29udGV4dFxuICAgKiBjb21wbGV0ZXMgdGhlIHJ1bGUgd2hlcmUgdGhlIGJvdW5kIHByZWZpeCBpcyBrbm93bi5cbiAgICovXG4gIHByaXZhdGUgYXNzZXJ0Rml4ZWRMb2dHcm91cE5hbWUobmFtZTogc3RyaW5nKTogdm9pZCB7XG4gICAgLy8gVGhlIExhbWJkYSBzZXJ2aWNlIHBhdGggaXMgdGhlIG9uZSBzaGFwZSB0aGF0IGNhcnJpZXMgYSBgL2A6IGl0cyBmdW5jdGlvblxuICAgIC8vIG5hbWUgd2FzIGFscmVhZHkgY2hlY2tlZCBhZ2FpbnN0IHRoZSBsYW1iZGFfZnVuY3Rpb24gcm93LlxuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoTEFNQkRBX0xPR19HUk9VUF9MRUFEKSkgcmV0dXJuO1xuICAgIGNvbnN0IHByZWZpeCA9IHRoaXMubG9nU291cmNlUHJlZml4KCk7XG4gICAgY29uc3QgcmVtYWluZGVyID0gbmFtZS5zdGFydHNXaXRoKHByZWZpeCkgPyBuYW1lLnNsaWNlKHByZWZpeC5sZW5ndGgpIDogdW5kZWZpbmVkO1xuICAgIGlmIChyZW1haW5kZXIgIT09IHVuZGVmaW5lZCAmJiBMT0dfU09VUkNFX1JFTUFJTkRFUl9SRS50ZXN0KHJlbWFpbmRlcikpIHJldHVybjtcbiAgICBjb25zdCBxdW90ZWQgPSBKU09OLnN0cmluZ2lmeShuYW1lKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBjYW5ub3QgZGVjbGFyZSBsb2dfZ3JvdXAgJHtxdW90ZWR9IGJlY2F1c2UgYSBmaXhlZCBsb2ctZ3JvdXAgbmFtZSBpcyBlaXRoZXIgdGhpcyBjb250ZXh0J3Mgc2VjdGlvbiAzIGxvZyBzb3VyY2UsICR7SlNPTi5zdHJpbmdpZnkocHJlZml4KX0gZm9sbG93ZWQgYnkgXCJsb2dzXCIgYW5kIHRoZSBsb2dpY2FsIHNvdXJjZSdzIHNlZ21lbnRzIGpvaW5lZCB3aXRoIFwiX1wiLCBvciB0aGUgTGFtYmRhIHNlcnZpY2UgcGF0aCAke0pTT04uc3RyaW5naWZ5KExBTUJEQV9MT0dfR1JPVVBfTEVBRCl9IGZvbGxvd2VkIGJ5IGEgbmFtZSB0aGF0IHNhdGlzZmllcyB0aGUgbGFtYmRhX2Z1bmN0aW9uIHJvdyAoYXBwICR7dGhpcy5hcHB9LCBzdGFnZSAke3RoaXMuc3RhZ2V9LCBuYW1lc3BhY2UgJHt0aGlzLm5hbWVzcGFjZX0pOyBnb3QgJHtxdW90ZWR9YCxcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBuZWFyZXN0IHN0YWNrIGFib3ZlIHRoZSBjb250ZXh0LCBpZiBpdCBoYXMgb25lLiBBIGNvbnRleHQgY3JlYXRlZCBhYm92ZVxuICAgKiB0aGUgc3RhY2tzIGhhcyBub25lOiBpdHMgYXJ0aWZhY3QgdGhlbiBhcHBlYXJzIG9uIHRoZSBzdGFja3MgaXRzXG4gICAqIGRlY2xhcmF0aW9ucyBhdHRyaWJ1dGUgdG8uXG4gICAqL1xuICBwcml2YXRlIG93bmluZ1N0YWNrKCk6IFN0YWNrIHwgdW5kZWZpbmVkIHtcbiAgICBsZXQgc2NvcGU6IElDb25zdHJ1Y3QgfCB1bmRlZmluZWQgPSB0aGlzO1xuICAgIHdoaWxlIChzY29wZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoU3RhY2suaXNTdGFjayhzY29wZSkpIHJldHVybiBzY29wZTtcbiAgICAgIHNjb3BlID0gc2NvcGUubm9kZS5zY29wZTtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWwgbG9nLWdyb3VwIG5hbWUgb2YgYSBsb2dpY2FsIHNvdXJjZSB1bmRlciB0aGlzIGNvbnRleHQuXG4gICAqL1xuICBwdWJsaWMgbG9nR3JvdXBOYW1lKGxvZ2ljYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ0dyb3VwTmFtZSh0aGlzLnZhbHVlcygpLCBsb2dpY2FsKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgYm91bmQgcHJlZml4IHNoYXJlZCBieSB0aGlzIGFwcCdzIGxvZyBzb3VyY2VzLlxuICAgKi9cbiAgcHVibGljIGxvZ1NvdXJjZVByZWZpeCgpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5sb2dTb3VyY2VQcmVmaXgodGhpcy52YWx1ZXMoKSk7XG4gIH1cbn1cbiJdfQ==