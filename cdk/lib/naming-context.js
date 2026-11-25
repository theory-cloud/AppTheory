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
                const entries = this.declared.map((entry) => ({
                    ...(entry.name !== undefined ? { name: entry.name } : {}),
                    type: entry.type,
                    logicalId: this.cloudFormationLogicalId(entry),
                    ...(entry.generated ? { generated: true } : {}),
                }));
                let artifact = [];
                try {
                    artifact = naming_1.AppTheoryResourceNaming.synthCheck(entries);
                }
                catch (error) {
                    errors.push(`AppTheoryNamingContext ${String(error.message)}; two different logical resources in one naming context cannot share a physical name in the same scope`);
                }
                if (errors.length > 0)
                    return errors;
                const document = {
                    contract: naming_1.RESOURCE_NAMING_CONTRACT,
                    schema: naming_1.DERIVED_NAMES_SCHEMA,
                    context: this.values(),
                    entries: artifact,
                };
                this.node.addMetadata(naming_1.DERIVED_NAMES_METADATA_KEY, JSON.parse(naming_1.AppTheoryResourceNaming.derivedNamesJson(document)));
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
     * The CloudFormation logical id of the resource a declaration names. The
     * construct's default child is the L1 resource a construct creates for itself,
     * so an L2 construct is the expected argument.
     */
    cloudFormationLogicalId(declaration) {
        const resource = declaration.resource;
        const candidate = resource instanceof aws_cdk_lib_1.CfnResource ? resource : resource.node.defaultChild;
        if (!(candidate instanceof aws_cdk_lib_1.CfnResource)) {
            throw new Error(`AppTheoryNamingContext cannot declare ${declaration.type}:${declaration.logical} because ${resource.node.path} has no CloudFormation resource as its default child; declare the construct that owns the named resource`);
        }
        return String(aws_cdk_lib_1.Stack.of(candidate).resolve(candidate.logicalId));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJuYW1pbmctY29udGV4dC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBQUEsNkNBQXdEO0FBQ3hELDJDQUFtRDtBQUVuRCxxQ0FZa0I7QUFFbEI7Ozs7R0FJRztBQUNILE1BQU0sdUJBQXVCLEdBQUc7SUFDOUIsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSTtDQUN4RyxDQUFDO0FBc0ZGOztHQUVHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUzs7SUFDbkQ7O09BRUc7SUFDYSxTQUFTLENBQVM7SUFFbEM7O09BRUc7SUFDYSxHQUFHLENBQVM7SUFFNUI7O09BRUc7SUFDYSxLQUFLLENBQVM7SUFFOUI7O09BRUc7SUFDYSxPQUFPLENBQVM7SUFFaEM7O09BRUc7SUFDYSxNQUFNLENBQVM7SUFFL0I7O09BRUc7SUFDYSxJQUFJLENBQTRCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUFXO0lBRXBDOztPQUVHO0lBQ2MsUUFBUSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFFOUM7Ozs7O09BS0c7SUFDYyxRQUFRLEdBQStCLEVBQUUsQ0FBQztJQUUzRDs7T0FFRztJQUNhLGFBQWEsQ0FBeUI7SUFFdEQ7O09BRUc7SUFDYSxjQUFjLENBQTBCO0lBRXhEOztPQUVHO0lBQ2EsYUFBYSxDQUFTO0lBRXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBa0M7UUFDMUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FB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QUFDLENBQUM7SUFDaEUsQ0FBQzs7QUF6T0gsd0RBME9DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ2ZuUmVzb3VyY2UsIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgSUNvbnN0cnVjdCwgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHtcbiAgQXBwVGhlb3J5RGVyaXZlZE5hbWUsXG4gIEFwcFRoZW9yeURlcml2ZWROYW1lSW5wdXQsXG4gIEFwcFRoZW9yeURlcml2ZWROYW1lcyxcbiAgQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUsXG4gIEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUsXG4gIEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMsXG4gIEFwcFRoZW9yeVBoeXNpY2FsTmFtZSxcbiAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcsXG4gIERFUklWRURfTkFNRVNfTUVUQURBVEFfS0VZLFxuICBERVJJVkVEX05BTUVTX1NDSEVNQSxcbiAgUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNULFxufSBmcm9tIFwiLi9uYW1pbmdcIjtcblxuLyoqXG4gKiBBY2NlcHRlZCBDbG91ZFdhdGNoIExvZ3MgYFJldGVudGlvbkluRGF5c2AgdmFsdWVzLiBBV1MgcmVqZWN0cyBhbnkgb3RoZXJcbiAqIHZhbHVlLCBzbyB0aGUgY29udGV4dCBmYWlscyBzeW50aGVzaXMgaW5zdGVhZCBvZiBkZWZlcnJpbmcgYSBkZXBsb3ktdGltZVxuICogZXJyb3IuXG4gKi9cbmNvbnN0IEFDQ0VQVEVEX1JFVEVOVElPTl9EQVlTID0gW1xuICAxLCAzLCA1LCA3LCAxNCwgMzAsIDYwLCA5MCwgMTIwLCAxNTAsIDE4MCwgMzY1LCA0MDAsIDU0NSwgNzMxLCAxMDk2LCAxODI3LCAyMTkyLCAyNTU3LCAyOTIyLCAzMjg4LCAzNjUzLFxuXTtcblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBhbiBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dGAuXG4gKlxuICogVGhlIGNvbnRleHQgaG9sZHMgdGhlIGJvdW5kIG5hbWluZyBhbmQgbG9nZ2luZyB2YWx1ZXMgZnJvbSBzdGFnZSBjb25maWcuXG4gKiBDb25zdHJ1Y3RzIHRha2UgaXQgYXMgYW4gb3B0aW9uYWwgcHJvcDsgd2l0aCBubyBjb250ZXh0IGV2ZXJ5IGNvbnN0cnVjdFxuICogc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBpdCBkaWQgYmVmb3JlIHRoaXMgY29udHJhY3QgZXhpc3RlZC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlOYW1pbmdDb250ZXh0UHJvcHMge1xuICAvKipcbiAgICogTmFtZXNwYWNlIHNlZ21lbnQuXG4gICAqIEBkZWZhdWx0IFwidGhlb3J5Y2xvdWRcIlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZXNwYWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBcHAgaW5zdGFuY2UgaWQgZnJvbSBzdGFnZSBjb25maWcuXG4gICAqL1xuICByZWFkb25seSBhcHA6IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgaWQgZnJvbSBzdGFnZSBjb25maWcuXG4gICAqL1xuICByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZCBmcm9tIHN0YWdlIGNvbmZpZy4gQW4gdW5yZXNvbHZlZCB0b2tlbiBmYWlsc1xuICAgKiBzeW50aGVzaXMuXG4gICAqL1xuICByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUsIGZvciBleGFtcGxlIGB1cy1lYXN0LTFgLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLCB1c2VkIHZlcmJhdGltIHVuZGVyIGEgbGVnYWN5XG4gICAqIG5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCB7fVxuICAgKi9cbiAgcmVhZG9ubHkgcGlucz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlZC1uYW1lIGVudHJpZXMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLiBBbiBlbnRyeSBtZWFuc1xuICAgKiBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZXMgdGhlIG5hbWUgdG9kYXksIHNvIHRoZSBjb25zdHJ1Y3Qgc2V0cyBub1xuICAgKiBwaHlzaWNhbC1uYW1lIHByb3BlcnR5LiBWYWxpZCBvbmx5IHVuZGVyIHRoZSBsZWdhY3kgbmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBnZW5lcmF0ZWQ/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTmFtaW5nIHByb2ZpbGUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGUuREVSSVZFRFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nUHJvZmlsZT86IEFwcFRoZW9yeU5hbWluZ1Byb2ZpbGU7XG5cbiAgLyoqXG4gICAqIExvZ2dpbmcgcHJvZmlsZS4gYHN0YW5kYXJkYCBvcHRzIGV2ZXJ5IGNvbnN0cnVjdCB0aGF0IHJlY2VpdmVzIHRoZSBjb250ZXh0XG4gICAqIGludG8gdGhlIGNvbnRyYWN0J3MgbG9nIGdyb3VwcyBhbmQgYWNjZXNzIGxvZ2dpbmcuIGBsZWdhY3lgIGtlZXBzIGVhY2hcbiAgICogY29uc3RydWN0J3MgcHJlLWNvbnRyYWN0IGJlaGF2aW91ci5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuTEVHQUNZXG4gICAqL1xuICByZWFkb25seSBsb2dnaW5nUHJvZmlsZT86IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gaW4gZGF5cyBmb3Igc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXBzLiBNdXN0IGJlIGEgdmFsdWVcbiAgICogQ2xvdWRXYXRjaCBMb2dzIGFjY2VwdHMuXG4gICAqIEBkZWZhdWx0IDMwXG4gICAqL1xuICByZWFkb25seSByZXRlbnRpb25EYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIE9uZSBkZWNsYXJlZCBwaHlzaWNhbGx5IG5hbWVkIHJlc291cmNlOiB0aGUgY29tcG9zZWQgbmFtZSwgYW5kIHRoZSBjb25zdHJ1Y3RcbiAqIHdob3NlIENsb3VkRm9ybWF0aW9uIHJlc291cmNlIGNhcnJpZXMgaXQuXG4gKi9cbmludGVyZmFjZSBBcHBUaGVvcnlOYW1lRGVjbGFyYXRpb24ge1xuICByZWFkb25seSB0eXBlOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGxvZ2ljYWw6IHN0cmluZztcbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZ2VuZXJhdGVkOiBib29sZWFuO1xuICByZWFkb25seSByZXNvdXJjZTogSUNvbnN0cnVjdDtcbn1cblxuLyoqXG4gKiBUaGUgYm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQgc2hhcmVkIGJ5IEFwcFRoZW9yeSBjb25zdHJ1Y3RzLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuYW1lc3BhY2U6IHN0cmluZztcblxuICAvKipcbiAgICogQXBwIGluc3RhbmNlIGlkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHBpbnM6IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlZC1uYW1lIGVudHJpZXMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGdlbmVyYXRlZDogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBuYW1pbmcgZW50cmllcyBhIGNvbnN0cnVjdCBoYXMgY29uc3VtZWQgYXQgc3ludGhlc2lzLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBjb25zdW1lZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8qKlxuICAgKiBUaGUgcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZXMgYSBjb25zdHJ1Y3QgaGFzIGRlY2xhcmVkIChjb250cmFjdCBzZWN0aW9uXG4gICAqIDExLjQpLiBFYWNoIGRlY2xhcmF0aW9uIHRpZXMgb25lIGNvbXBvc2VkIG5hbWUgdG8gdGhlIENsb3VkRm9ybWF0aW9uXG4gICAqIHJlc291cmNlIHRoYXQgY2FycmllcyBpdCwgc28gc3ludGhlc2lzIGNhbiByZWZ1c2UgYSBjb2xsaXNpb24gYW5kIGVtaXQgdGhlXG4gICAqIGRlcml2ZWQtbmFtZSBhcnRpZmFjdCB0aGUgcmVzZXJ2YXRpb24gaW5kZXggcmVzZXJ2ZXMuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGRlY2xhcmVkOiBBcHBUaGVvcnlOYW1lRGVjbGFyYXRpb25bXSA9IFtdO1xuXG4gIC8qKlxuICAgKiBOYW1pbmcgcHJvZmlsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuYW1pbmdQcm9maWxlOiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU6IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gaW4gZGF5cyBmb3Igc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXBzLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJldGVudGlvbkRheXM6IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMuYWNjb3VudCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJlcXVpcmVzIGEgY29uY3JldGUgYWNjb3VudCBpZDsgdGhlIG5hbWluZyBjb250cmFjdCBkZXJpdmVzIHBoeXNpY2FsIG5hbWVzIGZyb20gaXQgYW5kIGFuIHVucmVzb2x2ZWQgdG9rZW4gY2Fubm90IGJlIHZhbGlkYXRlZCBhdCBzeW50aGVzaXNcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMucmVnaW9uKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TmFtaW5nQ29udGV4dCByZXF1aXJlcyBhIGNvbmNyZXRlIHJlZ2lvbjsgYW4gdW5yZXNvbHZlZCB0b2tlbiBjYW5ub3QgYmUgdmFsaWRhdGVkIGF0IHN5bnRoZXNpc1wiKTtcbiAgICB9XG5cbiAgICB0aGlzLm5hbWVzcGFjZSA9IHByb3BzLm5hbWVzcGFjZSA/PyBcInRoZW9yeWNsb3VkXCI7XG4gICAgdGhpcy5hcHAgPSBwcm9wcy5hcHA7XG4gICAgdGhpcy5zdGFnZSA9IHByb3BzLnN0YWdlO1xuICAgIHRoaXMuYWNjb3VudCA9IHByb3BzLmFjY291bnQ7XG4gICAgdGhpcy5yZWdpb24gPSBwcm9wcy5yZWdpb247XG4gICAgdGhpcy5waW5zID0geyAuLi4ocHJvcHMucGlucyA/PyB7fSkgfTtcbiAgICB0aGlzLmdlbmVyYXRlZCA9IFsuLi4ocHJvcHMuZ2VuZXJhdGVkID8/IFtdKV07XG4gICAgdGhpcy5uYW1pbmdQcm9maWxlID0gcHJvcHMubmFtaW5nUHJvZmlsZSA/PyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQ7XG4gICAgdGhpcy5sb2dnaW5nUHJvZmlsZSA9IHByb3BzLmxvZ2dpbmdQcm9maWxlID8/IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWTtcbiAgICB0aGlzLnJldGVudGlvbkRheXMgPSBwcm9wcy5yZXRlbnRpb25EYXlzID8/IDMwO1xuXG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHRoaXMudmFsdWVzKCkpO1xuXG4gICAgaWYgKCFBQ0NFUFRFRF9SRVRFTlRJT05fREFZUy5pbmNsdWRlcyh0aGlzLnJldGVudGlvbkRheXMpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJldGVudGlvbkRheXMgbXVzdCBiZSBvbmUgb2YgJHtBQ0NFUFRFRF9SRVRFTlRJT05fREFZUy5qb2luKFwiLCBcIil9OyBDbG91ZFdhdGNoIExvZ3MgcmVqZWN0cyBvdGhlciB2YWx1ZXNgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBvcnBoYW5zID0gWy4uLm5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKHRoaXMucGlucyksIC4uLnRoaXMuZ2VuZXJhdGVkXSldLmZpbHRlcihcbiAgICAgICAgICAoa2V5KSA9PiAhdGhpcy5jb25zdW1lZC5oYXMoa2V5KSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBpZiAob3JwaGFucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBuYW1pbmcgZW50cmllcyBtYXRjaCBubyByZXNvdXJjZSBpbiB0aGUgc3RhY2s6ICR7b3JwaGFucy5qb2luKFwiLCBcIil9OyByZW1vdmUgdGhlbSBvciBwYXNzIHRoZSBtYXRjaGluZyBsb2dpY2FsIG5hbWUgdG8gdGhlIGNvbnN0cnVjdCB0aGF0IG93bnMgdGhlIHJlc291cmNlYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZW50cmllczogQXBwVGhlb3J5RGVyaXZlZE5hbWVJbnB1dFtdID0gdGhpcy5kZWNsYXJlZC5tYXAoKGVudHJ5KSA9PiAoe1xuICAgICAgICAgIC4uLihlbnRyeS5uYW1lICE9PSB1bmRlZmluZWQgPyB7IG5hbWU6IGVudHJ5Lm5hbWUgfSA6IHt9KSxcbiAgICAgICAgICB0eXBlOiBlbnRyeS50eXBlLFxuICAgICAgICAgIGxvZ2ljYWxJZDogdGhpcy5jbG91ZEZvcm1hdGlvbkxvZ2ljYWxJZChlbnRyeSksXG4gICAgICAgICAgLi4uKGVudHJ5LmdlbmVyYXRlZCA/IHsgZ2VuZXJhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICAgIH0pKTtcblxuICAgICAgICBsZXQgYXJ0aWZhY3Q6IEFwcFRoZW9yeURlcml2ZWROYW1lW10gPSBbXTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhcnRpZmFjdCA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnN5bnRoQ2hlY2soZW50cmllcyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCAke1N0cmluZygoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UpfTsgdHdvIGRpZmZlcmVudCBsb2dpY2FsIHJlc291cmNlcyBpbiBvbmUgbmFtaW5nIGNvbnRleHQgY2Fubm90IHNoYXJlIGEgcGh5c2ljYWwgbmFtZSBpbiB0aGUgc2FtZSBzY29wZWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXJyb3JzLmxlbmd0aCA+IDApIHJldHVybiBlcnJvcnM7XG5cbiAgICAgICAgY29uc3QgZG9jdW1lbnQ6IEFwcFRoZW9yeURlcml2ZWROYW1lcyA9IHtcbiAgICAgICAgICBjb250cmFjdDogUkVTT1VSQ0VfTkFNSU5HX0NPTlRSQUNULFxuICAgICAgICAgIHNjaGVtYTogREVSSVZFRF9OQU1FU19TQ0hFTUEsXG4gICAgICAgICAgY29udGV4dDogdGhpcy52YWx1ZXMoKSxcbiAgICAgICAgICBlbnRyaWVzOiBhcnRpZmFjdCxcbiAgICAgICAgfTtcbiAgICAgICAgdGhpcy5ub2RlLmFkZE1ldGFkYXRhKERFUklWRURfTkFNRVNfTUVUQURBVEFfS0VZLCBKU09OLnBhcnNlKEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmRlcml2ZWROYW1lc0pzb24oZG9jdW1lbnQpKSk7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIGlzIGFjdGl2ZS5cbiAgICovXG4gIHB1YmxpYyBnZXQgc3RhbmRhcmRMb2dnaW5nKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmxvZ2dpbmdQcm9maWxlID09PSBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZS5TVEFOREFSRDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgY29udGV4dCB2YWx1ZXMgYXMgYSBqc2lpIHN0cnVjdC5cbiAgICovXG4gIHB1YmxpYyB2YWx1ZXMoKTogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWVzcGFjZTogdGhpcy5uYW1lc3BhY2UsXG4gICAgICBhcHA6IHRoaXMuYXBwLFxuICAgICAgc3RhZ2U6IHRoaXMuc3RhZ2UsXG4gICAgICBhY2NvdW50OiB0aGlzLmFjY291bnQsXG4gICAgICByZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgcGluczogdGhpcy5waW5zLFxuICAgICAgZ2VuZXJhdGVkOiB0aGlzLmdlbmVyYXRlZCxcbiAgICAgIG5hbWluZ1Byb2ZpbGU6IHRoaXMubmFtaW5nUHJvZmlsZSxcbiAgICAgIGxvZ2dpbmdQcm9maWxlOiB0aGlzLmxvZ2dpbmdQcm9maWxlLFxuICAgICAgcmV0ZW50aW9uRGF5czogdGhpcy5yZXRlbnRpb25EYXlzLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogQ29tcG9zZSB0aGUgcGh5c2ljYWwgbmFtZSBvZiBvbmUgcmVzb3VyY2UgdW5kZXIgdGhpcyBjb250ZXh0LlxuICAgKi9cbiAgcHVibGljIHBoeXNpY2FsTmFtZShyZXNvdXJjZVR5cGU6IHN0cmluZywgbG9naWNhbDogc3RyaW5nKTogQXBwVGhlb3J5UGh5c2ljYWxOYW1lIHtcbiAgICBjb25zdCBjb21wb3NlZCA9IEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLnBoeXNpY2FsTmFtZSh0aGlzLnZhbHVlcygpLCByZXNvdXJjZVR5cGUsIGxvZ2ljYWwpO1xuICAgIHRoaXMuY29uc3VtZWQuYWRkKGAke3Jlc291cmNlVHlwZX06JHtsb2dpY2FsfWApO1xuICAgIHJldHVybiBjb21wb3NlZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZWNsYXJlIHRoZSBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZSB0aGF0IGNhcnJpZXMgb25lIGNvbXBvc2VkIG5hbWVcbiAgICogKGNvbnRyYWN0IHNlY3Rpb24gMTEuNCkuXG4gICAqXG4gICAqIFN5bnRoZXNpcyByZWZ1c2VzIHR3byBkaWZmZXJlbnQgbG9naWNhbCByZXNvdXJjZXMgaW4gb25lIG5hbWluZyBjb250ZXh0IHRoYXRcbiAgICogZGVyaXZlIHRoZSBzYW1lIG5hbWUgaW4gdGhlIHNhbWUgbmFtaW5nIHNjb3BlLCBhbmQgZW1pdHMgdGhlIGRlcml2ZWQtbmFtZVxuICAgKiBhcnRpZmFjdCB0aGUgbmFtZSByZXNlcnZhdGlvbiBpbmRleCByZXNlcnZlcy4gQSBjb25zdHJ1Y3QgZGVjbGFyZXMgZXZlcnlcbiAgICogcGh5c2ljYWxseSBuYW1lZCByZXNvdXJjZSBpdCBjcmVhdGVzOyBhbiBhcHBsaWNhdGlvbiB0aGF0IG5hbWVzIGl0cyBvd25cbiAgICogcmVzb3VyY2Ugd2l0aCBgcGh5c2ljYWxOYW1lYCBkZWNsYXJlcyBpdCBoZXJlIG9uY2UgdGhlIHJlc291cmNlIGV4aXN0cywgc29cbiAgICogdGhlIGFydGlmYWN0IGNvdmVycyBpdCB0b28uXG4gICAqXG4gICAqIEEgbmFtZSBBcHBUaGVvcnkgb25seSB3aXJlcyBmb3IgYSByZXNvdXJjZSBhbm90aGVyIHN0YWNrIG93bnMsIHN1Y2ggYXNcbiAgICogYEFwcFRoZW9yeVNzclNpdGVgJ3MgSVNSIG1ldGFkYXRhIHRhYmxlLCB0YWtlcyBubyBkZWNsYXJhdGlvbiBoZXJlOiB0aGF0XG4gICAqIHN0YWNrIGRlY2xhcmVzIGl0cyBvd24gcmVzb3VyY2UuXG4gICAqXG4gICAqIEEgYGxvZ19ncm91cGAgdHlwZSBkZWNsYXJlcyBhIGxvZy1zb3VyY2UgbmFtZSAoY29udHJhY3Qgc2VjdGlvbiAzKTogYSBsb2dcbiAgICogZ3JvdXAgdGFrZXMgbm8gcGluIG9yIGdlbmVyYXRlZCBlbnRyeS5cbiAgICovXG4gIHB1YmxpYyBkZWNsYXJlTmFtZShyZXNvdXJjZVR5cGU6IHN0cmluZywgbG9naWNhbDogc3RyaW5nLCByZXNvdXJjZTogSUNvbnN0cnVjdCk6IHZvaWQge1xuICAgIGlmIChyZXNvdXJjZVR5cGUgPT09IFwibG9nX2dyb3VwXCIpIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5sb2dHcm91cE5hbWUodGhpcy52YWx1ZXMoKSwgbG9naWNhbCk7XG4gICAgICB0aGlzLmRlY2xhcmVkLnB1c2goeyB0eXBlOiByZXNvdXJjZVR5cGUsIGxvZ2ljYWwsIG5hbWUsIGdlbmVyYXRlZDogZmFsc2UsIHJlc291cmNlIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjb21wb3NlZCA9IHRoaXMucGh5c2ljYWxOYW1lKHJlc291cmNlVHlwZSwgbG9naWNhbCk7XG4gICAgdGhpcy5kZWNsYXJlZC5wdXNoKHtcbiAgICAgIHR5cGU6IHJlc291cmNlVHlwZSxcbiAgICAgIGxvZ2ljYWwsXG4gICAgICAuLi4oY29tcG9zZWQuZ2VuZXJhdGVkID8ge30gOiB7IG5hbWU6IGNvbXBvc2VkLm5hbWUgfSksXG4gICAgICBnZW5lcmF0ZWQ6IGNvbXBvc2VkLmdlbmVyYXRlZCA9PT0gdHJ1ZSxcbiAgICAgIHJlc291cmNlLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIGlkIG9mIHRoZSByZXNvdXJjZSBhIGRlY2xhcmF0aW9uIG5hbWVzLiBUaGVcbiAgICogY29uc3RydWN0J3MgZGVmYXVsdCBjaGlsZCBpcyB0aGUgTDEgcmVzb3VyY2UgYSBjb25zdHJ1Y3QgY3JlYXRlcyBmb3IgaXRzZWxmLFxuICAgKiBzbyBhbiBMMiBjb25zdHJ1Y3QgaXMgdGhlIGV4cGVjdGVkIGFyZ3VtZW50LlxuICAgKi9cbiAgcHJpdmF0ZSBjbG91ZEZvcm1hdGlvbkxvZ2ljYWxJZChkZWNsYXJhdGlvbjogQXBwVGhlb3J5TmFtZURlY2xhcmF0aW9uKTogc3RyaW5nIHtcbiAgICBjb25zdCByZXNvdXJjZTogSUNvbnN0cnVjdCA9IGRlY2xhcmF0aW9uLnJlc291cmNlO1xuICAgIGNvbnN0IGNhbmRpZGF0ZTogSUNvbnN0cnVjdCB8IHVuZGVmaW5lZCA9XG4gICAgICByZXNvdXJjZSBpbnN0YW5jZW9mIENmblJlc291cmNlID8gcmVzb3VyY2UgOiByZXNvdXJjZS5ub2RlLmRlZmF1bHRDaGlsZDtcbiAgICBpZiAoIShjYW5kaWRhdGUgaW5zdGFuY2VvZiBDZm5SZXNvdXJjZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgY2Fubm90IGRlY2xhcmUgJHtkZWNsYXJhdGlvbi50eXBlfToke2RlY2xhcmF0aW9uLmxvZ2ljYWx9IGJlY2F1c2UgJHtyZXNvdXJjZS5ub2RlLnBhdGh9IGhhcyBubyBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZSBhcyBpdHMgZGVmYXVsdCBjaGlsZDsgZGVjbGFyZSB0aGUgY29uc3RydWN0IHRoYXQgb3ducyB0aGUgbmFtZWQgcmVzb3VyY2VgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIFN0cmluZyhTdGFjay5vZihjYW5kaWRhdGUpLnJlc29sdmUoY2FuZGlkYXRlLmxvZ2ljYWxJZCkpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBwaHlzaWNhbCBsb2ctZ3JvdXAgbmFtZSBvZiBhIGxvZ2ljYWwgc291cmNlIHVuZGVyIHRoaXMgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyBsb2dHcm91cE5hbWUobG9naWNhbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nR3JvdXBOYW1lKHRoaXMudmFsdWVzKCksIGxvZ2ljYWwpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBib3VuZCBwcmVmaXggc2hhcmVkIGJ5IHRoaXMgYXBwJ3MgbG9nIHNvdXJjZXMuXG4gICAqL1xuICBwdWJsaWMgbG9nU291cmNlUHJlZml4KCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeVJlc291cmNlTmFtaW5nLmxvZ1NvdXJjZVByZWZpeCh0aGlzLnZhbHVlcygpKTtcbiAgfVxufVxuIl19