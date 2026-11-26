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
     * Whether this context is a hosted deployment TheoryCloud.ai places
     * (contract section 1, r5).
     */
    hosted;
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
        this.hosted = props.hosted === true;
        // r5 rev1: a hosted deployment always supplies its namespace; it never
        // defaults to the platform form. Refused here rather than after defaulting,
        // because an absent namespace and the reserved one are different mistakes.
        if (this.hosted && !props.namespace) {
            throw new Error("AppTheoryNamingContext requires a namespace for a hosted deployment; a hosted deployment never defaults to the platform namespace");
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
            hosted: this.hosted,
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
     *
     * The emitted derived-name artifact carries the hosted names of a hosted
     * context verbatim, because every declaration composes through this context
     * (contract section 11.4, r5). The artifact's `context.namespace` is the
     * tenant namespace for a hosted deployment and `theorycloud` for a platform
     * app, so the reader can tell the two apart; the wire schema is unchanged and
     * a platform app's artifact stays byte-identical.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJuYW1pbmctY29udGV4dC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBQUEsNkNBQW9FO0FBQ3BFLDJDQUFtRDtBQUVuRCxxQ0FZa0I7QUFDbEIscUVBQThGO0FBRTlGOzs7O0dBSUc7QUFDSCxNQUFNLHVCQUF1QixHQUFHO0lBQzlCLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUk7Q0FDeEcsQ0FBQztBQWlIRjs7R0FFRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7O0lBQ25EOztPQUVHO0lBQ2EsU0FBUyxDQUFTO0lBRWxDOztPQUVHO0lBQ2EsR0FBRyxDQUFTO0lBRTVCOztPQUVHO0lBQ2EsS0FBSyxDQUFTO0lBRTlCOzs7T0FHRztJQUNhLE9BQU8sQ0FBUztJQUVoQzs7O09BR0c7SUFDYSxNQUFNLENBQVM7SUFFL0I7O09BRUc7SUFDYSxJQUFJLENBQTRCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUFXO0lBRXBDOztPQUVHO0lBQ2MsUUFBUSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFFOUM7Ozs7O09BS0c7SUFDYyxRQUFRLEdBQStCLEVBQUUsQ0FBQztJQUUzRDs7O09BR0c7SUFDYSxNQUFNLENBQVU7SUFFaEM7O09BRUc7SUFDYSxhQUFhLENBQXlCO0lBRXREOztPQUVHO0lBQ2EsY0FBYyxDQUEwQjtJQUV4RDs7T0FFRztJQUNhLGFBQWEsQ0FBUztJQUV0QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtB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QWUsSUFBSSxDQUFDLFNBQVMsVUFBVSxNQUFNLEVBQUUsQ0FDM2IsQ0FBQztJQUNKLENBQUM7SUFFRDs7OztPQUlHO0lBQ0ssV0FBVztRQUNqQixJQUFJLEtBQUssR0FBMkIsSUFBSSxDQUFDO1FBQ3pDLE9BQU8sS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzNCLElBQUksbUJBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDO2dCQUFFLE9BQU8sS0FBSyxDQUFDO1lBQ3ZDLEtBQUssR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUMzQixDQUFDO1FBQ0QsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUVEOztPQUVHO0lBQ0ksWUFBWSxDQUFDLE9BQWU7UUFDakMsT0FBTyxnQ0FBdUIsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ3RFLENBQUM7SUFFRDs7T0FFRztJQUNJLGVBQWU7UUFDcEIsT0FBTyxnQ0FBdUIsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDaEUsQ0FBQzs7QUF4YUgsd0RBeWFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQXBwLCBDZm5SZXNvdXJjZSwgU3RhY2ssIFN0YWdlLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgSUNvbnN0cnVjdCwgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHtcbiAgQXBwVGhlb3J5RGVyaXZlZE5hbWUsXG4gIEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXQsXG4gIEFwcFRoZW9yeURlcml2ZWROYW1lcyxcbiAgQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUsXG4gIEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUsXG4gIEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gIEFwcFRoZW9yeVBoeXNpY2FsTmFtZSxcbiAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcsXG4gIERFUklWRURfTkFNRVNfTUVUQURBVEFfS0VZLFxuICBERVJJVkVEX05BTUVTX1NDSEVNQSxcbiAgUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNULFxufSBmcm9tIFwiLi9uYW1pbmdcIjtcbmltcG9ydCB7IExBTUJEQV9MT0dfR1JPVVBfTEVBRCwgTE9HX1NPVVJDRV9SRU1BSU5ERVJfUkUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZy1zb3VyY2UtZ3JhbW1hclwiO1xuXG4vKipcbiAqIEFjY2VwdGVkIENsb3VkV2F0Y2ggTG9ncyBgUmV0ZW50aW9uSW5EYXlzYCB2YWx1ZXMuIEFXUyByZWplY3RzIGFueSBvdGhlclxuICogdmFsdWUsIHNvIHRoZSBjb250ZXh0IGZhaWxzIHN5bnRoZXNpcyBpbnN0ZWFkIG9mIGRlZmVycmluZyBhIGRlcGxveS10aW1lXG4gKiBlcnJvci5cbiAqL1xuY29uc3QgQUNDRVBURURfUkVURU5USU9OX0RBWVMgPSBbXG4gIDEsIDMsIDUsIDcsIDE0LCAzMCwgNjAsIDkwLCAxMjAsIDE1MCwgMTgwLCAzNjUsIDQwMCwgNTQ1LCA3MzEsIDEwOTYsIDE4MjcsIDIxOTIsIDI1NTcsIDI5MjIsIDMyODgsIDM2NTMsXG5dO1xuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIGFuIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0YC5cbiAqXG4gKiBUaGUgY29udGV4dCBob2xkcyB0aGUgYm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIHZhbHVlcyBmcm9tIHN0YWdlIGNvbmZpZy5cbiAqIENvbnN0cnVjdHMgdGFrZSBpdCBhcyBhbiBvcHRpb25hbCBwcm9wOyB3aXRoIG5vIGNvbnRleHQgZXZlcnkgY29uc3RydWN0XG4gKiBzeW50aGVzaXplcyBleGFjdGx5IGFzIGl0IGRpZCBiZWZvcmUgdGhpcyBjb250cmFjdCBleGlzdGVkLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU5hbWluZ0NvbnRleHRQcm9wcyB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICogQGRlZmF1bHQgXCJ0aGVvcnljbG91ZFwiXG4gICAqL1xuICByZWFkb25seSBuYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFwcCBpbnN0YW5jZSBpZCBmcm9tIHN0YWdlIGNvbmZpZy5cbiAgICovXG4gIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZCBmcm9tIHN0YWdlIGNvbmZpZy5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFR3ZWx2ZS1kaWdpdCBhY2NvdW50IGlkIGZyb20gc3RhZ2UgY29uZmlnLiBBbiB1bnJlc29sdmVkIHRva2VuIGZhaWxzXG4gICAqIHN5bnRoZXNpcy5cbiAgICpcbiAgICogVGhpcyBpcyB0aGUgYWNjb3VudCB0aGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGNsYWltcy4gQXBwVGhlb3J5IGRvZXMgbm90XG4gICAqIGNvbXBhcmUgaXQgd2l0aCB0aGUgYWNjb3VudCBvZiB0aGUgc3RhY2sgdGhhdCBkZWNsYXJlcyBhIHJlc291cmNlO1xuICAgKiBUaGVvcnlDbG91ZC5haSdzIGluc3RhbGxlciB2YWxpZGF0ZXMgdGhlIGFydGlmYWN0J3MgYWNjb3VudCBhZ2FpbnN0IHRoZVxuICAgKiBzdGFjayBpdCBkZXBsb3lzLlxuICAgKi9cbiAgcmVhZG9ubHkgYWNjb3VudDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGdWxsIFJlZ2lvbiBjb2RlLCBmb3IgZXhhbXBsZSBgdXMtZWFzdC0xYC5cbiAgICpcbiAgICogVGhpcyBpcyB0aGUgUmVnaW9uIHRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgY2xhaW1zLiBBcHBUaGVvcnkgZG9lcyBub3RcbiAgICogY29tcGFyZSBpdCB3aXRoIHRoZSBSZWdpb24gb2YgdGhlIHN0YWNrIHRoYXQgZGVjbGFyZXMgYSByZXNvdXJjZTtcbiAgICogVGhlb3J5Q2xvdWQuYWkncyBpbnN0YWxsZXIgdmFsaWRhdGVzIGl0IGFnYWluc3QgdGhlIHN0YWNrIGl0IGRlcGxveXMuXG4gICAqL1xuICByZWFkb25seSByZWdpb246IHN0cmluZztcblxuICAvKipcbiAgICogUGh5c2ljYWwgcGlucyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAsIHVzZWQgdmVyYmF0aW0gdW5kZXIgYSBsZWdhY3lcbiAgICogbmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IHt9XG4gICAqL1xuICByZWFkb25seSBwaW5zPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAvKipcbiAgICogR2VuZXJhdGVkLW5hbWUgZW50cmllcyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuIEFuIGVudHJ5IG1lYW5zXG4gICAqIENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlcyB0aGUgbmFtZSB0b2RheSwgc28gdGhlIGNvbnN0cnVjdCBzZXRzIG5vXG4gICAqIHBoeXNpY2FsLW5hbWUgcHJvcGVydHkuIFZhbGlkIG9ubHkgdW5kZXIgdGhlIGxlZ2FjeSBuYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGdlbmVyYXRlZD86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBgdHJ1ZWAgZm9yIGEgZGVwbG95bWVudCBUaGVvcnlDbG91ZC5haSBwbGFjZXMgb24gYSB0ZW5hbnQncyBiZWhhbGZcbiAgICogKGNvbnRyYWN0IHNlY3Rpb24gMSwgcjUpOiBhIHBvb2xlZCwgaXNvbGF0ZWQgb3IgZGVkaWNhdGVkIG1hbmFnZWQtYWNjb3VudFxuICAgKiBwbGFjZW1lbnQuXG4gICAqXG4gICAqIFRoZW9yeUNsb3VkLmFpIHNldHMgdGhpcyBmbGFnIGFuZCB0aGUgdGVuYW50IGBuYW1lc3BhY2VgIG9uIGV2ZXJ5IGRlcGxveW1lbnRcbiAgICogaXQgcGxhY2VzLCBhbmQgaW5qZWN0cyBgYWNjb3VudGAgYW5kIGByZWdpb25gIGZyb20gaXRzIG93biBwbGFjZW1lbnQgbG9naWMuXG4gICAqIE9ubHkgZmlyc3QtcGFydHkgcGxhdGZvcm0gYXBwcyBvbWl0IGl0OyBmb3IgdGhlbSB0aGUgcGxhdGZvcm0gZGVmYXVsdFxuICAgKiAobmFtZXNwYWNlIGB0aGVvcnljbG91ZGAsIHRoZSByNCBmb3JtcykgaXMgdW5jaGFuZ2VkLlxuICAgKlxuICAgKiBBIGhvc3RlZCBjb250ZXh0IGFsd2F5cyBzdXBwbGllcyBhIGBuYW1lc3BhY2VgLCBuZXZlciB1c2VzIHRoZSByZXNlcnZlZFxuICAgKiBwbGF0Zm9ybSBuYW1lc3BhY2UsIGNhcnJpZXMgdGhlIG5hbWVzcGFjZSBpbiBldmVyeSBkZXJpdmVkIG5hbWUsIGFuZCB0YWtlc1xuICAgKiBubyBsZWdhY3kgbmFtaW5nIHByb2ZpbGUgYW5kIG5vIGdlbmVyYXRlZCBlbnRyaWVzLiBBIGNvbnRleHQgdGhhdCBicmVha3MgYW55XG4gICAqIG9mIHRoZXNlIGZhaWxzIHN5bnRoZXNpcy5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRURcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU/OiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuIGBzdGFuZGFyZGAgb3B0cyBldmVyeSBjb25zdHJ1Y3QgdGhhdCByZWNlaXZlcyB0aGUgY29udGV4dFxuICAgKiBpbnRvIHRoZSBjb250cmFjdCdzIGxvZyBncm91cHMgYW5kIGFjY2VzcyBsb2dnaW5nLiBgbGVnYWN5YCBrZWVwcyBlYWNoXG4gICAqIGNvbnN0cnVjdCdzIHByZS1jb250cmFjdCBiZWhhdmlvdXIuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU/OiBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIGluIGRheXMgZm9yIHN0YW5kYXJkLXByb2ZpbGUgbG9nIGdyb3Vwcy4gTXVzdCBiZSBhIHZhbHVlXG4gICAqIENsb3VkV2F0Y2ggTG9ncyBhY2NlcHRzLlxuICAgKiBAZGVmYXVsdCAzMFxuICAgKi9cbiAgcmVhZG9ubHkgcmV0ZW50aW9uRGF5cz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBPbmUgZGVjbGFyZWQgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZTogdGhlIGNvbXBvc2VkIG5hbWUsIGFuZCB0aGUgY29uc3RydWN0XG4gKiB3aG9zZSBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZSBjYXJyaWVzIGl0LlxuICovXG5pbnRlcmZhY2UgQXBwVGhlb3J5TmFtZURlY2xhcmF0aW9uIHtcbiAgcmVhZG9ubHkgdHlwZTogc3RyaW5nO1xuICByZWFkb25seSBsb2dpY2FsOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGdlbmVyYXRlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgcmVzb3VyY2U6IElDb25zdHJ1Y3Q7XG59XG5cbi8qKlxuICogVGhlIGJvdW5kIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0IHNoYXJlZCBieSBBcHBUaGVvcnkgY29uc3RydWN0cy5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogTmFtZXNwYWNlIHNlZ21lbnQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbmFtZXNwYWNlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFwcCBpbnN0YW5jZSBpZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhcHA6IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgaWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IHN0cmluZztcblxuICAvKipcbiAgICogVHdlbHZlLWRpZ2l0IGFjY291bnQgaWQuIFRoZSBkZXJpdmVkLW5hbWUgYXJ0aWZhY3QgY2xhaW1zIHRoaXMgYWNjb3VudDsgaXRcbiAgICogaXMgbm90IGNvbXBhcmVkIHdpdGggYW55IGRlY2xhcmluZyBzdGFjaydzIGFjY291bnQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjb3VudDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGdWxsIFJlZ2lvbiBjb2RlLiBUaGUgZGVyaXZlZC1uYW1lIGFydGlmYWN0IGNsYWltcyB0aGlzIFJlZ2lvbjsgaXQgaXMgbm90XG4gICAqIGNvbXBhcmVkIHdpdGggYW55IGRlY2xhcmluZyBzdGFjaydzIFJlZ2lvbi5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSByZWdpb246IHN0cmluZztcblxuICAvKipcbiAgICogUGh5c2ljYWwgcGlucyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcGluczogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAvKipcbiAgICogR2VuZXJhdGVkLW5hbWUgZW50cmllcyBrZXllZCBge3R5cGV9Ontsb2dpY2FsfWAuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZ2VuZXJhdGVkOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIG5hbWluZyBlbnRyaWVzIGEgY29uc3RydWN0IGhhcyBjb25zdW1lZCBhdCBzeW50aGVzaXMuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGNvbnN1bWVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgLyoqXG4gICAqIFRoZSBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlcyBhIGNvbnN0cnVjdCBoYXMgZGVjbGFyZWQgKGNvbnRyYWN0IHNlY3Rpb25cbiAgICogMTEuNCkuIEVhY2ggZGVjbGFyYXRpb24gdGllcyBvbmUgY29tcG9zZWQgbmFtZSB0byB0aGUgQ2xvdWRGb3JtYXRpb25cbiAgICogcmVzb3VyY2UgdGhhdCBjYXJyaWVzIGl0LCBzbyBzeW50aGVzaXMgY2FuIHJlZnVzZSBhIGNvbGxpc2lvbiBhbmQgZW1pdCB0aGVcbiAgICogZGVyaXZlZC1uYW1lIGFydGlmYWN0IHRoZSByZXNlcnZhdGlvbiBpbmRleCByZXNlcnZlcy5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgZGVjbGFyZWQ6IEFwcFRoZW9yeU5hbWVEZWNsYXJhdGlvbltdID0gW107XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhpcyBjb250ZXh0IGlzIGEgaG9zdGVkIGRlcGxveW1lbnQgVGhlb3J5Q2xvdWQuYWkgcGxhY2VzXG4gICAqIChjb250cmFjdCBzZWN0aW9uIDEsIHI1KS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBob3N0ZWQ6IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU6IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZ2dpbmcgcHJvZmlsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBsb2dnaW5nUHJvZmlsZTogQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBpbiBkYXlzIGZvciBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cHMuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcmV0ZW50aW9uRGF5czogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChwcm9wcy5hY2NvdW50KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU5hbWluZ0NvbnRleHQgcmVxdWlyZXMgYSBjb25jcmV0ZSBhY2NvdW50IGlkOyB0aGUgbmFtaW5nIGNvbnRyYWN0IGRlcml2ZXMgcGh5c2ljYWwgbmFtZXMgZnJvbSBpdCBhbmQgYW4gdW5yZXNvbHZlZCB0b2tlbiBjYW5ub3QgYmUgdmFsaWRhdGVkIGF0IHN5bnRoZXNpc1wiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChwcm9wcy5yZWdpb24pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJlcXVpcmVzIGEgY29uY3JldGUgcmVnaW9uOyBhbiB1bnJlc29sdmVkIHRva2VuIGNhbm5vdCBiZSB2YWxpZGF0ZWQgYXQgc3ludGhlc2lzXCIpO1xuICAgIH1cblxuICAgIHRoaXMuaG9zdGVkID0gcHJvcHMuaG9zdGVkID09PSB0cnVlO1xuICAgIC8vIHI1IHJldjE6IGEgaG9zdGVkIGRlcGxveW1lbnQgYWx3YXlzIHN1cHBsaWVzIGl0cyBuYW1lc3BhY2U7IGl0IG5ldmVyXG4gICAgLy8gZGVmYXVsdHMgdG8gdGhlIHBsYXRmb3JtIGZvcm0uIFJlZnVzZWQgaGVyZSByYXRoZXIgdGhhbiBhZnRlciBkZWZhdWx0aW5nLFxuICAgIC8vIGJlY2F1c2UgYW4gYWJzZW50IG5hbWVzcGFjZSBhbmQgdGhlIHJlc2VydmVkIG9uZSBhcmUgZGlmZmVyZW50IG1pc3Rha2VzLlxuICAgIGlmICh0aGlzLmhvc3RlZCAmJiAhcHJvcHMubmFtZXNwYWNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TmFtaW5nQ29udGV4dCByZXF1aXJlcyBhIG5hbWVzcGFjZSBmb3IgYSBob3N0ZWQgZGVwbG95bWVudDsgYSBob3N0ZWQgZGVwbG95bWVudCBuZXZlciBkZWZhdWx0cyB0byB0aGUgcGxhdGZvcm0gbmFtZXNwYWNlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLm5hbWVzcGFjZSA9IHByb3BzLm5hbWVzcGFjZSA/PyBcInRoZW9yeWNsb3VkXCI7XG4gICAgdGhpcy5hcHAgPSBwcm9wcy5hcHA7XG4gICAgdGhpcy5zdGFnZSA9IHByb3BzLnN0YWdlO1xuICAgIHRoaXMuYWNjb3VudCA9IHByb3BzLmFjY291bnQ7XG4gICAgdGhpcy5yZWdpb24gPSBwcm9wcy5yZWdpb247XG4gICAgdGhpcy5waW5zID0geyAuLi4ocHJvcHMucGlucyA/PyB7fSkgfTtcbiAgICB0aGlzLmdlbmVyYXRlZCA9IFsuLi4ocHJvcHMuZ2VuZXJhdGVkID8/IFtdKV07XG4gICAgdGhpcy5uYW1pbmdQcm9maWxlID0gcHJvcHMubmFtaW5nUHJvZmlsZSA/PyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQ7XG4gICAgdGhpcy5sb2dnaW5nUHJvZmlsZSA9IHByb3BzLmxvZ2dpbmdQcm9maWxlID8/IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWTtcbiAgICB0aGlzLnJldGVudGlvbkRheXMgPSBwcm9wcy5yZXRlbnRpb25EYXlzID8/IDMwO1xuXG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHRoaXMudmFsdWVzKCkpO1xuXG4gICAgaWYgKCFBQ0NFUFRFRF9SRVRFTlRJT05fREFZUy5pbmNsdWRlcyh0aGlzLnJldGVudGlvbkRheXMpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJldGVudGlvbkRheXMgbXVzdCBiZSBvbmUgb2YgJHtBQ0NFUFRFRF9SRVRFTlRJT05fREFZUy5qb2luKFwiLCBcIil9OyBDbG91ZFdhdGNoIExvZ3MgcmVqZWN0cyBvdGhlciB2YWx1ZXNgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBvcnBoYW5zID0gWy4uLm5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKHRoaXMucGlucyksIC4uLnRoaXMuZ2VuZXJhdGVkXSldLmZpbHRlcihcbiAgICAgICAgICAoa2V5KSA9PiAhdGhpcy5jb25zdW1lZC5oYXMoa2V5KSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBpZiAob3JwaGFucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBuYW1pbmcgZW50cmllcyBtYXRjaCBubyByZXNvdXJjZSBpbiB0aGUgc3RhY2s6ICR7b3JwaGFucy5qb2luKFwiLCBcIil9OyByZW1vdmUgdGhlbSBvciBwYXNzIHRoZSBtYXRjaGluZyBsb2dpY2FsIG5hbWUgdG8gdGhlIGNvbnN0cnVjdCB0aGF0IG93bnMgdGhlIHJlc291cmNlYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZGVjbGFyZWRPbmNlID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICAgIGNvbnN0IGRlY2xhcmF0aW9ucyA9IHRoaXMuZGVjbGFyZWRcbiAgICAgICAgICAubWFwKChlbnRyeSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcmVzb3VyY2UgPSB0aGlzLmNsb3VkRm9ybWF0aW9uUmVzb3VyY2UoZW50cnkpO1xuICAgICAgICAgICAgY29uc3Qgb3duZXIgPSBTdGFjay5vZihyZXNvdXJjZSk7XG4gICAgICAgICAgICBjb25zdCBsb2dpY2FsSWQgPSBTdHJpbmcob3duZXIucmVzb2x2ZShyZXNvdXJjZS5sb2dpY2FsSWQpKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIG93bmVyLFxuICAgICAgICAgICAgICAvLyBBIENsb3VkRm9ybWF0aW9uIGxvZ2ljYWwgaWQgaXMgdW5pcXVlIG9ubHkgaW5zaWRlIG9uZSB0ZW1wbGF0ZSxcbiAgICAgICAgICAgICAgLy8gc28gdGhlIGNvbXBhcmlzb24gcnVucyBvbiBhbiBpZGVudGl0eSB0aGF0IGlzIHVuaXF1ZSBhY3Jvc3MgdGhlXG4gICAgICAgICAgICAgIC8vIHdob2xlIGNvbnRleHQ6IHRoZSBvd25pbmcgc3RhY2sncyBjb25zdHJ1Y3QgcGF0aCBhbmQgdGhlXG4gICAgICAgICAgICAgIC8vIHRlbXBsYXRlLWxvY2FsIGxvZ2ljYWwgaWQgKFNBTklUWS1BVC1OMy0wNSkuIFRoZSBhcnRpZmFjdCByb3dcbiAgICAgICAgICAgICAgLy8ga2VlcHMgdGhlIHRlbXBsYXRlLWxvY2FsIGlkLCB3aGljaCBpcyB3aGF0IHRoZSBpbnN0YWxsZXIgam9pbnNcbiAgICAgICAgICAgICAgLy8gb24uXG4gICAgICAgICAgICAgIGlkZW50aXR5OiBgJHtvd25lci5ub2RlLnBhdGh9LyR7bG9naWNhbElkfWAsXG4gICAgICAgICAgICAgIGlucHV0OiB7XG4gICAgICAgICAgICAgICAgLi4uKGVudHJ5Lm5hbWUgIT09IHVuZGVmaW5lZCA/IHsgbmFtZTogZW50cnkubmFtZSB9IDoge30pLFxuICAgICAgICAgICAgICAgIHR5cGU6IGVudHJ5LnR5cGUsXG4gICAgICAgICAgICAgICAgbG9naWNhbElkLFxuICAgICAgICAgICAgICAgIC4uLihlbnRyeS5nZW5lcmF0ZWQgPyB7IGdlbmVyYXRlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICB9IGFzIEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXQsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLy8gQSByZXNvdXJjZSBkZWNsYXJlZCB0d2ljZSBpcyBvbmUgcmVzb3VyY2U6IGl0IGlzIGFkbWl0dGVkLCBhbmQgdGhlXG4gICAgICAgICAgLy8gYXJ0aWZhY3QgbGlzdHMgaXQgb25jZS5cbiAgICAgICAgICAuZmlsdGVyKChkZWNsYXJhdGlvbikgPT4ge1xuICAgICAgICAgICAgY29uc3Qga2V5ID0gW1xuICAgICAgICAgICAgICBkZWNsYXJhdGlvbi5pZGVudGl0eSxcbiAgICAgICAgICAgICAgZGVjbGFyYXRpb24uaW5wdXQudHlwZSxcbiAgICAgICAgICAgICAgZGVjbGFyYXRpb24uaW5wdXQubmFtZSA/PyBcIlwiLFxuICAgICAgICAgICAgICBkZWNsYXJhdGlvbi5pbnB1dC5nZW5lcmF0ZWQgPT09IHRydWUgPyBcImdlbmVyYXRlZFwiIDogXCJuYW1lZFwiLFxuICAgICAgICAgICAgXS5qb2luKFwiXFx1MDAwMFwiKTtcbiAgICAgICAgICAgIGlmIChkZWNsYXJlZE9uY2UuaGFzKGtleSkpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGRlY2xhcmVkT25jZS5hZGQoa2V5KTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgIGxldCBhcnRpZmFjdDogQXBwVGhlb3J5RGVyaXZlZE5hbWVbXSA9IFtdO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGFydGlmYWN0ID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuc3ludGhDaGVjayhcbiAgICAgICAgICAgIGRlY2xhcmF0aW9ucy5tYXAoKGRlY2xhcmF0aW9uKSA9PiAoeyAuLi5kZWNsYXJhdGlvbi5pbnB1dCwgbG9naWNhbElkOiBkZWNsYXJhdGlvbi5pZGVudGl0eSB9KSksXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0ICR7U3RyaW5nKChlcnJvciBhcyBFcnJvcikubWVzc2FnZSl9OyB0d28gZGlmZmVyZW50IGxvZ2ljYWwgcmVzb3VyY2VzIGluIG9uZSBuYW1pbmcgY29udGV4dCBjYW5ub3Qgc2hhcmUgYSBwaHlzaWNhbCBuYW1lIGluIHRoZSBzYW1lIHNjb3BlYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChlcnJvcnMubGVuZ3RoID4gMCkgcmV0dXJuIGVycm9ycztcblxuICAgICAgICAvLyBFdmVyeSBlbnRyeSBpcyBhdHRyaWJ1dGFibGUgdG8gdGhlIHN0YWNrIHdob3NlIHRlbXBsYXRlIGhvbGRzIGl0c1xuICAgICAgICAvLyBsb2dpY2FsIGlkLCBzbyBhIGNvbnRleHQgc2hhcmVkIGFjcm9zcyBzdGFja3MgZW1pdHMgb25lIGRvY3VtZW50IHBlclxuICAgICAgICAvLyBzdGFjayBpbiB0aGF0IHN0YWNrJ3Mgb3duIGB7c3RhY2t9Lm1ldGFkYXRhLmpzb25gIChjb250cmFjdCBzZWN0aW9uXG4gICAgICAgIC8vIDExLjQpLiBUaGUgcmVmdXNhbCBhYm92ZSBzdGlsbCBzcGFucyB0aGUgd2hvbGUgY29udGV4dDogdHdvIHN0YWNrcyBpblxuICAgICAgICAvLyBvbmUgY29udGV4dCB0aGF0IGRlcml2ZSB0aGUgc2FtZSBuYW1lIGluIG9uZSBzY29wZSBhcmUgb25lIGNvbGxpc2lvbi5cbiAgICAgICAgY29uc3QgYnlTdGFjayA9IG5ldyBNYXA8U3RhY2ssIEFwcFRoZW9yeURlcml2ZWROYW1lW10+KCk7XG4gICAgICAgIGRlY2xhcmF0aW9ucy5mb3JFYWNoKChkZWNsYXJhdGlvbiwgaW5kZXgpID0+IHtcbiAgICAgICAgICBjb25zdCByb3dzID0gYnlTdGFjay5nZXQoZGVjbGFyYXRpb24ub3duZXIpID8/IFtdO1xuICAgICAgICAgIGNvbnN0IHJvdyA9IGFydGlmYWN0W2luZGV4XSBhcyBBcHBUaGVvcnlEZXJpdmVkTmFtZTtcbiAgICAgICAgICByb3dzLnB1c2goeyAuLi5yb3csIGxvZ2ljYWxJZDogKGRlY2xhcmF0aW9uLmlucHV0IGFzIEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXQpLmxvZ2ljYWxJZCB9KTtcbiAgICAgICAgICBieVN0YWNrLnNldChkZWNsYXJhdGlvbi5vd25lciwgcm93cyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFNjZW5hcmlvIDQ6IGV2ZXJ5IHN5bnRoIHdpdGggYSBuYW1pbmcgY29udGV4dCBlbWl0cyB0aGUgYXJ0aWZhY3QsIHNvIGFcbiAgICAgICAgLy8gY29udGV4dCB3aG9zZSBkZWNsYXJhdGlvbnMgYWxsIGF0dHJpYnV0ZSB0byBvdGhlciBzdGFja3Mgc3RpbGwgbGVhdmVzXG4gICAgICAgIC8vIGFuIGV4cGxpY2l0IChlbXB0eSkgZG9jdW1lbnQgb24gaXRzIG93biBzdGFjaywgYW5kIHRoZSBpbnN0YWxsZXIgY2FuXG4gICAgICAgIC8vIHRlbGwgXCJkZWNsYXJlcyBub3RoaW5nXCIgZnJvbSBcIm5vIG5hbWluZyBjb250ZXh0IGF0IGFsbFwiIChzY2VuYXJpbyA1KS5cbiAgICAgICAgY29uc3Qgb3duU3RhY2sgPSB0aGlzLm93bmluZ1N0YWNrKCk7XG4gICAgICAgIGlmIChvd25TdGFjayAhPT0gdW5kZWZpbmVkICYmICFieVN0YWNrLmhhcyhvd25TdGFjaykpIHtcbiAgICAgICAgICBieVN0YWNrLnNldChvd25TdGFjaywgW10pO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yIChjb25zdCBbb3duZXIsIGVudHJpZXNdIG9mIGJ5U3RhY2spIHtcbiAgICAgICAgICBjb25zdCBkb2N1bWVudDogQXBwVGhlb3J5RGVyaXZlZE5hbWVzID0ge1xuICAgICAgICAgICAgY29udHJhY3Q6IFJFU09VUkNFX05BTUlOR19DT05UUkFDVCxcbiAgICAgICAgICAgIHNjaGVtYTogREVSSVZFRF9OQU1FU19TQ0hFTUEsXG4gICAgICAgICAgICBjb250ZXh0OiB0aGlzLnZhbHVlcygpLFxuICAgICAgICAgICAgZW50cmllcyxcbiAgICAgICAgICB9O1xuICAgICAgICAgIG93bmVyLm5vZGUuYWRkTWV0YWRhdGEoREVSSVZFRF9OQU1FU19NRVRBREFUQV9LRVksIEpTT04ucGFyc2UoQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcuZGVyaXZlZE5hbWVzSnNvbihkb2N1bWVudCkpKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gW107XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSBpcyBhY3RpdmUuXG4gICAqL1xuICBwdWJsaWMgZ2V0IHN0YW5kYXJkTG9nZ2luZygpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5sb2dnaW5nUHJvZmlsZSA9PT0gQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuU1RBTkRBUkQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGNvbnRleHQgdmFsdWVzIGFzIGEganNpaSBzdHJ1Y3QuXG4gICAqL1xuICBwdWJsaWMgdmFsdWVzKCk6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lc3BhY2U6IHRoaXMubmFtZXNwYWNlLFxuICAgICAgYXBwOiB0aGlzLmFwcCxcbiAgICAgIHN0YWdlOiB0aGlzLnN0YWdlLFxuICAgICAgYWNjb3VudDogdGhpcy5hY2NvdW50LFxuICAgICAgcmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgIHBpbnM6IHRoaXMucGlucyxcbiAgICAgIGdlbmVyYXRlZDogdGhpcy5nZW5lcmF0ZWQsXG4gICAgICBob3N0ZWQ6IHRoaXMuaG9zdGVkLFxuICAgICAgbmFtaW5nUHJvZmlsZTogdGhpcy5uYW1pbmdQcm9maWxlLFxuICAgICAgbG9nZ2luZ1Byb2ZpbGU6IHRoaXMubG9nZ2luZ1Byb2ZpbGUsXG4gICAgICByZXRlbnRpb25EYXlzOiB0aGlzLnJldGVudGlvbkRheXMsXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21wb3NlIHRoZSBwaHlzaWNhbCBuYW1lIG9mIG9uZSByZXNvdXJjZSB1bmRlciB0aGlzIGNvbnRleHQuXG4gICAqL1xuICBwdWJsaWMgcGh5c2ljYWxOYW1lKHJlc291cmNlVHlwZTogc3RyaW5nLCBsb2dpY2FsOiBzdHJpbmcpOiBBcHBUaGVvcnlQaHlzaWNhbE5hbWUge1xuICAgIGNvbnN0IGNvbXBvc2VkID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcucGh5c2ljYWxOYW1lKHRoaXMudmFsdWVzKCksIHJlc291cmNlVHlwZSwgbG9naWNhbCk7XG4gICAgdGhpcy5jb25zdW1lZC5hZGQoYCR7cmVzb3VyY2VUeXBlfToke2xvZ2ljYWx9YCk7XG4gICAgcmV0dXJuIGNvbXBvc2VkO1xuICB9XG5cbiAgLyoqXG4gICAqIERlY2xhcmUgdGhlIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIHRoYXQgY2FycmllcyBvbmUgY29tcG9zZWQgbmFtZVxuICAgKiAoY29udHJhY3Qgc2VjdGlvbiAxMS40KS5cbiAgICpcbiAgICogU3ludGhlc2lzIHJlZnVzZXMgdHdvIGRpZmZlcmVudCBsb2dpY2FsIHJlc291cmNlcyBpbiBvbmUgbmFtaW5nIGNvbnRleHQgdGhhdFxuICAgKiBkZXJpdmUgdGhlIHNhbWUgbmFtZSBpbiB0aGUgc2FtZSBuYW1pbmcgc2NvcGUsIGFuZCBlbWl0cyB0aGUgZGVyaXZlZC1uYW1lXG4gICAqIGFydGlmYWN0IHRoZSBuYW1lIHJlc2VydmF0aW9uIGluZGV4IHJlc2VydmVzLiBBIGNvbnN0cnVjdCBkZWNsYXJlcyBldmVyeVxuICAgKiBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlIGl0IGNyZWF0ZXM7IGFuIGFwcGxpY2F0aW9uIHRoYXQgbmFtZXMgaXRzIG93blxuICAgKiByZXNvdXJjZSB3aXRoIGBwaHlzaWNhbE5hbWVgIGRlY2xhcmVzIGl0IGhlcmUgb25jZSB0aGUgcmVzb3VyY2UgZXhpc3RzLCBzb1xuICAgKiB0aGUgYXJ0aWZhY3QgY292ZXJzIGl0IHRvby5cbiAgICpcbiAgICogQSBuYW1lIEFwcFRoZW9yeSBvbmx5IHdpcmVzIGZvciBhIHJlc291cmNlIGFub3RoZXIgc3RhY2sgb3ducywgc3VjaCBhc1xuICAgKiBgQXBwVGhlb3J5U3NyU2l0ZWAncyBJU1IgbWV0YWRhdGEgdGFibGUsIHRha2VzIG5vIGRlY2xhcmF0aW9uIGhlcmU6IHRoYXRcbiAgICogc3RhY2sgZGVjbGFyZXMgaXRzIG93biByZXNvdXJjZS5cbiAgICpcbiAgICAgKiBBIGBsb2dfZ3JvdXBgIHR5cGUgZGVjbGFyZXMgYSBsb2ctc291cmNlIG5hbWUgKGNvbnRyYWN0IHNlY3Rpb24gMyk6IGEgbG9nXG4gICAqIGdyb3VwIHRha2VzIG5vIHBpbiBvciBnZW5lcmF0ZWQgZW50cnkuXG4gICAqXG4gICAqIFRoZSBlbWl0dGVkIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCBjYXJyaWVzIHRoZSBob3N0ZWQgbmFtZXMgb2YgYSBob3N0ZWRcbiAgICogY29udGV4dCB2ZXJiYXRpbSwgYmVjYXVzZSBldmVyeSBkZWNsYXJhdGlvbiBjb21wb3NlcyB0aHJvdWdoIHRoaXMgY29udGV4dFxuICAgKiAoY29udHJhY3Qgc2VjdGlvbiAxMS40LCByNSkuIFRoZSBhcnRpZmFjdCdzIGBjb250ZXh0Lm5hbWVzcGFjZWAgaXMgdGhlXG4gICAqIHRlbmFudCBuYW1lc3BhY2UgZm9yIGEgaG9zdGVkIGRlcGxveW1lbnQgYW5kIGB0aGVvcnljbG91ZGAgZm9yIGEgcGxhdGZvcm1cbiAgICogYXBwLCBzbyB0aGUgcmVhZGVyIGNhbiB0ZWxsIHRoZSB0d28gYXBhcnQ7IHRoZSB3aXJlIHNjaGVtYSBpcyB1bmNoYW5nZWQgYW5kXG4gICAqIGEgcGxhdGZvcm0gYXBwJ3MgYXJ0aWZhY3Qgc3RheXMgYnl0ZS1pZGVudGljYWwuXG4gICAqL1xuICBwdWJsaWMgZGVjbGFyZU5hbWUocmVzb3VyY2VUeXBlOiBzdHJpbmcsIGxvZ2ljYWw6IHN0cmluZywgcmVzb3VyY2U6IElDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgICB0aGlzLmFzc2VydFNhbWVTdGFnZShyZXNvdXJjZVR5cGUsIHJlc291cmNlKTtcbiAgICBpZiAocmVzb3VyY2VUeXBlID09PSBcImxvZ19ncm91cFwiKSB7XG4gICAgICBjb25zdCBuYW1lID0gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nR3JvdXBOYW1lKHRoaXMudmFsdWVzKCksIGxvZ2ljYWwpO1xuICAgICAgdGhpcy5kZWNsYXJlZC5wdXNoKHsgdHlwZTogcmVzb3VyY2VUeXBlLCBsb2dpY2FsLCBuYW1lLCBnZW5lcmF0ZWQ6IGZhbHNlLCByZXNvdXJjZSB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgY29tcG9zZWQgPSB0aGlzLnBoeXNpY2FsTmFtZShyZXNvdXJjZVR5cGUsIGxvZ2ljYWwpO1xuICAgIHRoaXMuZGVjbGFyZWQucHVzaCh7XG4gICAgICB0eXBlOiByZXNvdXJjZVR5cGUsXG4gICAgICBsb2dpY2FsLFxuICAgICAgLi4uKGNvbXBvc2VkLmdlbmVyYXRlZCA/IHt9IDogeyBuYW1lOiBjb21wb3NlZC5uYW1lIH0pLFxuICAgICAgZ2VuZXJhdGVkOiBjb21wb3NlZC5nZW5lcmF0ZWQgPT09IHRydWUsXG4gICAgICByZXNvdXJjZSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZWNsYXJlIHRoZSBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZSB0aGF0IGNhcnJpZXMgb25lIG5hbWUgdGhlIGNvbnRyYWN0IGZpeGVzXG4gICAqIHJhdGhlciB0aGFuIGRlcml2ZXMgKGNvbnRyYWN0IHNlY3Rpb24gMTEuNCkuXG4gICAqXG4gICAqIFR3byBuYW1lcyBBcHBUaGVvcnkgY3JlYXRlcyBmYWxsIG91dHNpZGUgdGhlIGRlcml2YXRpb24gdGFibGU6IHRoZSBMYW1iZGFcbiAgICogc2VydmljZSBsb2cgZ3JvdXAgYC9hd3MvbGFtYmRhL3tmdW5jdGlvbiBuYW1lfWAsIGFuZCB0aGUgdmlzaWJpbGl0eSBtYW5pZmVzdFxuICAgKiBwYXJhbWV0ZXIgYC90aGVvcnljbG91ZC92aXNpYmlsaXR5L3thcHB9L3tzdGFnZX0vbWFuaWZlc3RgIChjb250cmFjdCBzZWN0aW9uXG4gICAqIDYpLiBUaGV5IGFyZSBzdGlsbCBuYW1lcyB0aGUgY29udGV4dCBkZXRlcm1pbmVzIGFuZCByZXNvdXJjZXMgdGhlIHN0YWNrXG4gICAqIGNyZWF0ZXMsIHNvIHRoZSBhcnRpZmFjdCBjYXJyaWVzIHRoZW07IHRoZSByZXNlcnZlZCBzY29wZSBpcyB0aGUgdHlwZSdzIHNjb3BlXG4gICAqIGZyb20gY29udHJhY3Qgc2VjdGlvbiAxMS4xLlxuICAgKlxuICAgKiBBbiBhcHBsaWNhdGlvbiB0aGF0IG5hbWVzIGl0cyBvd24gcmVzb3VyY2Ugd2l0aCBhIGZpeGVkIGNvbnRyYWN0IHBhdGhcbiAgICogZGVjbGFyZXMgaXQgaGVyZSB0b28sIHNvIHRoZSBhcnRpZmFjdCBjb3ZlcnMgaXQuXG4gICAqXG4gICAqIEEgZml4ZWQgbmFtZSBpcyBzdGlsbCBhIHBoeXNpY2FsIG5hbWUgb2YgaXRzIHR5cGUsIHNvIGl0IG11c3Qgc2F0aXNmeSB0aGVcbiAgICogY2hhcmFjdGVyIGFuZCBzaGFwZSBydWxlcyBvZiB0aGUgY29udHJhY3QncyBzZWN0aW9uIDIgcnVsZSB0YWJsZSBmb3IgdGhhdFxuICAgKiB0eXBlIChsZW5ndGgsIGNoYXJzZXQsIHRoZSBTMyBzdGFydC9lbmQgcnVsZSwgdGhlIFNTTSBhbmQgS01TIHBhdGggcnVsZXMsXG4gICAqIHRoZSBzZWNyZXQgc3VmZml4IHJ1bGUpLiBBIG5hbWUgb3V0c2lkZSB0aGVtIGZhaWxzIHN5bnRoZXNpcyBpbnN0ZWFkIG9mXG4gICAqIGVudGVyaW5nIHRoZSBhcnRpZmFjdCBhcyBhIG5hbWUgdGhlIGluc3RhbGxlciBjYW4gbmV2ZXIgY3JlYXRlXG4gICAqIChTQU5JVFktQVQtTjMtMDgpLlxuICAgKlxuICAgKiBBIGZpeGVkIGBsb2dfZ3JvdXBgIG5hbWUgaXMgbmFycm93ZWQgZnVydGhlciwgYmVjYXVzZSBhIGxvZy1ncm91cCBuYW1lIGlzXG4gICAqIGVpdGhlciB0aGlzIGNvbnRleHQncyBvd24gbG9nIHNvdXJjZSBvciB0aGUgTGFtYmRhIHNlcnZpY2UgcGF0aCBhbmQgbm90aGluZ1xuICAgKiBlbHNlOiB0aGUgc3RydWN0dXJhbCBjaGVjayBpbiBgdmFsaWRhdGVQaHlzaWNhbE5hbWVgIGNhbm5vdCBrbm93IHRoZSBib3VuZFxuICAgKiBwcmVmaXgsIHNvIHRoZSBjb250ZXh0IGNvbXBsZXRlcyBpdCBoZXJlIChzZWVcbiAgICogYGFzc2VydEZpeGVkTG9nR3JvdXBOYW1lYCkuXG4gICAqL1xuICBwdWJsaWMgZGVjbGFyZUZpeGVkTmFtZShyZXNvdXJjZVR5cGU6IHN0cmluZywgbmFtZTogc3RyaW5nLCByZXNvdXJjZTogSUNvbnN0cnVjdCk6IHZvaWQge1xuICAgIC8vIEEgdHlwZSBvdXRzaWRlIGNvbnRyYWN0IHNlY3Rpb24gMiBoYXMgbm8gc3RhdGVkIHNjb3BlLCBzbyBpdCBjYW5ub3QgYmVcbiAgICAvLyByZXNlcnZlZDogZGVjbGFyZSBpdCBhbmQgc3ludGhlc2lzIGZhaWxzIGNsb3NlZC5cbiAgICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5uYW1pbmdTY29wZShyZXNvdXJjZVR5cGUpO1xuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQobmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgY2Fubm90IGRlY2xhcmUgJHtyZXNvdXJjZVR5cGV9IGJlY2F1c2UgdGhlIG5hbWUgaXMgYW4gdW5yZXNvbHZlZCB0b2tlbjsgYSBuYW1lIHRoZSBhcnRpZmFjdCByZXNlcnZlcyBtdXN0IGJlIHJlc29sdmFibGUgYXQgc3ludGhlc2lzYCxcbiAgICAgICk7XG4gICAgfVxuICAgIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnZhbGlkYXRlUGh5c2ljYWxOYW1lKHJlc291cmNlVHlwZSwgbmFtZSk7XG4gICAgdGhpcy5hc3NlcnRTYW1lU3RhZ2UocmVzb3VyY2VUeXBlLCByZXNvdXJjZSk7XG4gICAgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJsb2dfZ3JvdXBcIikge1xuICAgICAgdGhpcy5hc3NlcnRGaXhlZExvZ0dyb3VwTmFtZShuYW1lKTtcbiAgICB9XG4gICAgdGhpcy5kZWNsYXJlZC5wdXNoKHsgdHlwZTogcmVzb3VyY2VUeXBlLCBsb2dpY2FsOiBuYW1lLCBuYW1lLCBnZW5lcmF0ZWQ6IGZhbHNlLCByZXNvdXJjZSB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgQ2xvdWRGb3JtYXRpb24gcmVzb3VyY2UgYSBkZWNsYXJhdGlvbiBuYW1lcy4gVGhlIGNvbnN0cnVjdCdzIGRlZmF1bHRcbiAgICogY2hpbGQgaXMgdGhlIEwxIHJlc291cmNlIGEgY29uc3RydWN0IGNyZWF0ZXMgZm9yIGl0c2VsZiwgc28gYW4gTDIgY29uc3RydWN0XG4gICAqIGlzIHRoZSBleHBlY3RlZCBhcmd1bWVudC5cbiAgICovXG4gIHByaXZhdGUgY2xvdWRGb3JtYXRpb25SZXNvdXJjZShkZWNsYXJhdGlvbjogQXBwVGhlb3J5TmFtZURlY2xhcmF0aW9uKTogQ2ZuUmVzb3VyY2Uge1xuICAgIGNvbnN0IHJlc291cmNlOiBJQ29uc3RydWN0ID0gZGVjbGFyYXRpb24ucmVzb3VyY2U7XG4gICAgY29uc3QgY2FuZGlkYXRlOiBJQ29uc3RydWN0IHwgdW5kZWZpbmVkID1cbiAgICAgIHJlc291cmNlIGluc3RhbmNlb2YgQ2ZuUmVzb3VyY2UgPyByZXNvdXJjZSA6IHJlc291cmNlLm5vZGUuZGVmYXVsdENoaWxkO1xuICAgIGlmICghKGNhbmRpZGF0ZSBpbnN0YW5jZW9mIENmblJlc291cmNlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBjYW5ub3QgZGVjbGFyZSAke2RlY2xhcmF0aW9uLnR5cGV9OiR7ZGVjbGFyYXRpb24ubG9naWNhbH0gYmVjYXVzZSAke3Jlc291cmNlLm5vZGUucGF0aH0gaGFzIG5vIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIGFzIGl0cyBkZWZhdWx0IGNoaWxkOyBkZWNsYXJlIHRoZSBjb25zdHJ1Y3QgdGhhdCBvd25zIHRoZSBuYW1lZCByZXNvdXJjZWAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gY2FuZGlkYXRlO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlZnVzZSBhIGRlY2xhcmF0aW9uIHdob3NlIG93bmluZyBzdGFjayBpcyBpbiBhIGRpZmZlcmVudCBDREsgU3RhZ2UgZnJvbSB0aGVcbiAgICogY29udGV4dCAoU0FOSVRZLUFULU4zLTAyKS5cbiAgICpcbiAgICogRWFjaCBTdGFnZSBpcyBhIHNlcGFyYXRlIGNsb3VkIGFzc2VtYmx5LCBhbmQgQ0RLIHZhbGlkYXRlcyBhIHRyZWUgc3RhZ2UgYnlcbiAgICogc3RhZ2UsIHNvIHRoZSBzeW50aCBjaGVjayBuZXZlciBzZWVzIHRoZSBvdGhlciBhc3NlbWJseTogYSBjb250ZXh0IGFib3ZlIGFcbiAgICogU3RhZ2UgY2Fubm90IGNvbXBhcmUgaXRzIG5hbWVzLCBhbmQgYSBkb2N1bWVudCB3cml0dGVuIGFmdGVyIHRoYXQgYXNzZW1ibHlcbiAgICogZXhpc3RzIGlzIHNpbGVudGx5IGxvc3QuIEEgY29udGV4dCBhbmQgZXZlcnkgc3RhY2sgZGVjbGFyaW5nIHRocm91Z2ggaXRcbiAgICogdGhlcmVmb3JlIGJlbG9uZyB0byBvbmUgU3RhZ2UgKG9yIHRvIG5vbmUsIGF0IHRoZSBBcHAgcm9vdCkuXG4gICAqL1xuICBwcml2YXRlIGFzc2VydFNhbWVTdGFnZShyZXNvdXJjZVR5cGU6IHN0cmluZywgcmVzb3VyY2U6IElDb25zdHJ1Y3QpOiB2b2lkIHtcbiAgICBjb25zdCBvd25lclN0YWdlID0gU3RhZ2Uub2YoU3RhY2sub2YocmVzb3VyY2UpKTtcbiAgICBjb25zdCBjb250ZXh0U3RhZ2UgPSBTdGFnZS5vZih0aGlzKTtcbiAgICBpZiAob3duZXJTdGFnZSA9PT0gY29udGV4dFN0YWdlKSByZXR1cm47XG4gICAgLy8gYEFwcGAgaXMgYSBgU3RhZ2VgIGluIENESywgc28gYSBjb25zdHJ1Y3QgYWJvdmUgdGhlIHN0YWNrcyByZXBvcnRzIHRoZSBBcHBcbiAgICAvLyBpdHNlbGYgYXMgaXRzIFN0YWdlOyB0aGF0IGlzIHRoZSBBcHAgcm9vdCwgbm90IGEgU3RhZ2UgdGhlIGNhbGxlciBuYW1lZC5cbiAgICBjb25zdCBkZXNjcmliZSA9IChzdGFnZTogU3RhZ2UgfCB1bmRlZmluZWQpOiBzdHJpbmcgPT5cbiAgICAgIHN0YWdlID09PSB1bmRlZmluZWQgfHwgQXBwLmlzQXBwKHN0YWdlKSA/IFwidGhlIEFwcCByb290XCIgOiBgU3RhZ2UgJHtzdGFnZS5ub2RlLnBhdGh9YDtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBjYW5ub3QgZGVjbGFyZSAke3Jlc291cmNlVHlwZX0gaW4gJHtTdGFjay5vZihyZXNvdXJjZSkubm9kZS5wYXRofSBiZWNhdXNlIHRoZSBvd25pbmcgc3RhY2sgaXMgaW4gJHtkZXNjcmliZShvd25lclN0YWdlKX0gd2hpbGUgdGhlIG5hbWluZyBjb250ZXh0IGlzIGluICR7ZGVzY3JpYmUoY29udGV4dFN0YWdlKX07IGEgbmFtaW5nIGNvbnRleHQgYW5kIGV2ZXJ5IHN0YWNrIHRoYXQgZGVjbGFyZXMgdGhyb3VnaCBpdCBtdXN0IHNpdCBpbiB0aGUgc2FtZSBTdGFnZSwgYmVjYXVzZSBlYWNoIFN0YWdlIGlzIGEgc2VwYXJhdGUgY2xvdWQgYXNzZW1ibHkgd2hvc2UgZGVyaXZlZC1uYW1lIGFydGlmYWN0IHRoZSBzeW50aCBjaGVjayBjYW5ub3QgY29tcGFyZSB3aXRoIGFub3RoZXIgU3RhZ2Unc2AsXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZG1pdCBvbmx5IHRoZSB0d28gZml4ZWQgbG9nLWdyb3VwIHNoYXBlcyBjb250cmFjdCBzZWN0aW9uIDMgc3RhdGVzIGZvciBhXG4gICAqIGxvZyBncm91cCB0aGlzIGNvbnRleHQgb3ducyAoU0FOSVRZLUFULU4zLTA4LCByb3VuZCA0KS5cbiAgICpcbiAgICogQSBsb2cgZ3JvdXAgaXMgZWl0aGVyIGEgbG9nIHNvdXJjZSBvZiB0aGlzIGNvbnRleHQg4oCUXG4gICAqIGB0aGVvcnljbG91ZF97bmFtZXNwYWNlfV97YXBwfV97c3RhZ2V9X3tsb2dpY2FsfWAsIGJ1aWx0IGZyb20gdGhpc1xuICAgKiBjb250ZXh0J3Mgb3duIG5hbWVzcGFjZSwgYXBwIGFuZCBzdGFnZSDigJQgb3IgdGhlIExhbWJkYSBzZXJ2aWNlIHBhdGhcbiAgICogYC9hd3MvbGFtYmRhL3tmdW5jdGlvbiBuYW1lfWAuIGB2YWxpZGF0ZVBoeXNpY2FsTmFtZWAgYWxyZWFkeSByZWZ1c2VkIGV2ZXJ5XG4gICAqIG90aGVyIGAvYC1iZWFyaW5nIHNoYXBlLCBidXQgaXQgaXMgc3RydWN0dXJhbDogaXQgaG9sZHMgbm8gY29udGV4dCB2YWx1ZXMsXG4gICAqIHNvIGl0IGFkbWl0cyBhbnkgYC9gLWZyZWUgbmFtZSwgaW5jbHVkaW5nIG9uZSB0aGF0IGlzIG5vIGxvZyBzb3VyY2UgYXQgYWxsXG4gICAqIChgb3JkZXJzYCkgb3Igb25lIHNoYXBlZCBmb3IgYW5vdGhlciBjb250ZXh0XG4gICAqIChgdGhlb3J5Y2xvdWRfb3RoZXJfYXBwX2xhYl94YCkuIEJvdGggd291bGQgZW50ZXIgdGhlIGFydGlmYWN0IGFzIG5hbWVzIHRoZVxuICAgKiBpbnN0YWxsZXIgcmVzZXJ2ZXMgYW5kIHRoaXMgYXBwJ3MgbG9nZ2luZyBuZXZlciB3cml0ZXMsIHNvIHRoZSBjb250ZXh0XG4gICAqIGNvbXBsZXRlcyB0aGUgcnVsZSB3aGVyZSB0aGUgYm91bmQgcHJlZml4IGlzIGtub3duLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3NlcnRGaXhlZExvZ0dyb3VwTmFtZShuYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICAvLyBUaGUgTGFtYmRhIHNlcnZpY2UgcGF0aCBpcyB0aGUgb25lIHNoYXBlIHRoYXQgY2FycmllcyBhIGAvYDogaXRzIGZ1bmN0aW9uXG4gICAgLy8gbmFtZSB3YXMgYWxyZWFkeSBjaGVja2VkIGFnYWluc3QgdGhlIGxhbWJkYV9mdW5jdGlvbiByb3cuXG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChMQU1CREFfTE9HX0dST1VQX0xFQUQpKSByZXR1cm47XG4gICAgY29uc3QgcHJlZml4ID0gdGhpcy5sb2dTb3VyY2VQcmVmaXgoKTtcbiAgICBjb25zdCByZW1haW5kZXIgPSBuYW1lLnN0YXJ0c1dpdGgocHJlZml4KSA/IG5hbWUuc2xpY2UocHJlZml4Lmxlbmd0aCkgOiB1bmRlZmluZWQ7XG4gICAgaWYgKHJlbWFpbmRlciAhPT0gdW5kZWZpbmVkICYmIExPR19TT1VSQ0VfUkVNQUlOREVSX1JFLnRlc3QocmVtYWluZGVyKSkgcmV0dXJuO1xuICAgIGNvbnN0IHF1b3RlZCA9IEpTT04uc3RyaW5naWZ5KG5hbWUpO1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IGNhbm5vdCBkZWNsYXJlIGxvZ19ncm91cCAke3F1b3RlZH0gYmVjYXVzZSBhIGZpeGVkIGxvZy1ncm91cCBuYW1lIGlzIGVpdGhlciB0aGlzIGNvbnRleHQncyBzZWN0aW9uIDMgbG9nIHNvdXJjZSwgJHtKU09OLnN0cmluZ2lmeShwcmVmaXgpfSBmb2xsb3dlZCBieSBcImxvZ3NcIiBhbmQgdGhlIGxvZ2ljYWwgc291cmNlJ3Mgc2VnbWVudHMgam9pbmVkIHdpdGggXCJfXCIsIG9yIHRoZSBMYW1iZGEgc2VydmljZSBwYXRoICR7SlNPTi5zdHJpbmdpZnkoTEFNQkRBX0xPR19HUk9VUF9MRUFEKX0gZm9sbG93ZWQgYnkgYSBuYW1lIHRoYXQgc2F0aXNmaWVzIHRoZSBsYW1iZGFfZnVuY3Rpb24gcm93IChhcHAgJHt0aGlzLmFwcH0sIHN0YWdlICR7dGhpcy5zdGFnZX0sIG5hbWVzcGFjZSAke3RoaXMubmFtZXNwYWNlfSk7IGdvdCAke3F1b3RlZH1gLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIG5lYXJlc3Qgc3RhY2sgYWJvdmUgdGhlIGNvbnRleHQsIGlmIGl0IGhhcyBvbmUuIEEgY29udGV4dCBjcmVhdGVkIGFib3ZlXG4gICAqIHRoZSBzdGFja3MgaGFzIG5vbmU6IGl0cyBhcnRpZmFjdCB0aGVuIGFwcGVhcnMgb24gdGhlIHN0YWNrcyBpdHNcbiAgICogZGVjbGFyYXRpb25zIGF0dHJpYnV0ZSB0by5cbiAgICovXG4gIHByaXZhdGUgb3duaW5nU3RhY2soKTogU3RhY2sgfCB1bmRlZmluZWQge1xuICAgIGxldCBzY29wZTogSUNvbnN0cnVjdCB8IHVuZGVmaW5lZCA9IHRoaXM7XG4gICAgd2hpbGUgKHNjb3BlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChTdGFjay5pc1N0YWNrKHNjb3BlKSkgcmV0dXJuIHNjb3BlO1xuICAgICAgc2NvcGUgPSBzY29wZS5ub2RlLnNjb3BlO1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBwaHlzaWNhbCBsb2ctZ3JvdXAgbmFtZSBvZiBhIGxvZ2ljYWwgc291cmNlIHVuZGVyIHRoaXMgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyBsb2dHcm91cE5hbWUobG9naWNhbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nR3JvdXBOYW1lKHRoaXMudmFsdWVzKCksIGxvZ2ljYWwpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBib3VuZCBwcmVmaXggc2hhcmVkIGJ5IHRoaXMgYXBwJ3MgbG9nIHNvdXJjZXMuXG4gICAqL1xuICBwdWJsaWMgbG9nU291cmNlUHJlZml4KCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ1NvdXJjZVByZWZpeCh0aGlzLnZhbHVlcygpKTtcbiAgfVxufVxuIl19