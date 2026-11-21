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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryNamingContext", version: "7.5.0-rc.1" };
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
                if (orphans.length === 0)
                    return [];
                return [
                    `AppTheoryNamingContext naming entries match no resource in the stack: ${orphans.join(", ")}; remove them or pass the matching logical name to the construct that owns the resource`,
                ];
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFtaW5nLWNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJuYW1pbmctY29udGV4dC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBQUEsNkNBQW9DO0FBQ3BDLDJDQUF1QztBQUV2QyxxQ0FNa0I7QUFFbEI7Ozs7R0FJRztBQUNILE1BQU0sdUJBQXVCLEdBQUc7SUFDOUIsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSTtDQUN4RyxDQUFDO0FBMEVGOztHQUVHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUzs7SUFDbkQ7O09BRUc7SUFDYSxTQUFTLENBQVM7SUFFbEM7O09BRUc7SUFDYSxHQUFHLENBQVM7SUFFNUI7O09BRUc7SUFDYSxLQUFLLENBQVM7SUFFOUI7O09BRUc7SUFDYSxPQUFPLENBQVM7SUFFaEM7O09BRUc7SUFDYSxNQUFNLENBQVM7SUFFL0I7O09BRUc7SUFDYSxJQUFJLENBQTRCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUFXO0lBRXBDOztPQUVHO0lBQ2MsUUFBUSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFFOUM7O09BRUc7SUFDYSxhQUFhLENBQXlCO0lBRXREOztPQUVHO0lBQ2EsY0FBYyxDQUEwQjtJQUV4RDs7T0FFRztJQUNhLGFBQWEsQ0FBUztJQUV0QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWtDO1FBQzFFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxtQkFBSyxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUN0QyxNQUFNLElBQUksS0FBSyxDQUNiLG9LQUFvSyxDQUNySyxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksbUJBQUssQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7WUFDckMsTUFBTSxJQUFJLEtBQUssQ0FBQyx5R0FBeUcsQ0FBQyxDQUFDO1FBQzdILENBQUM7UUFFRCxJQUFJLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLElBQUksYUFBYSxDQUFDO1FBQ2xELElBQUksQ0FBQyxHQUFHLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQztRQUNyQixJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUM7UUFDekIsSUFBSSxDQUFDLE9BQU8sR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDO1FBQzdCLElBQUksQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQztRQUMzQixJQUFJLENBQUMsSUFBSSxHQUFHLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQztRQUN0QyxJQUFJLENBQUMsU0FBUyxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxTQUFTLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztRQUM5QyxJQUFJLENBQUMsYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLElBQUksK0JBQXNCLENBQUMsT0FBTyxDQUFDO1FBQzNFLElBQUksQ0FBQyxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxnQ0FBdUIsQ0FBQyxNQUFNLENBQUM7UUFDN0UsSUFBSSxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxJQUFJLEVBQUUsQ0FBQztRQUUvQyxnQ0FBdUIsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7UUFFdkQsSUFBSSxDQUFDLHVCQUF1QixDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLEVBQUUsQ0FBQztZQUMxRCxNQUFNLElBQUksS0FBSyxDQUNiLHVEQUF1RCx1QkFBdUIsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLHdDQUF3QyxDQUNsSSxDQUFDO1FBQ0osQ0FBQztRQUVELElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDO1lBQ3RCLFFBQVEsRUFBRSxHQUFHLEVBQUU7Z0JBQ2IsTUFBTSxPQUFPLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUNqRixDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FDakMsQ0FBQztnQkFDRixJQUFJLE9BQU8sQ0FBQyxNQUFNLEtBQUssQ0FBQztvQkFBRSxPQUFPLEVBQUUsQ0FBQztnQkFDcEMsT0FBTztvQkFDTCx5RUFBeUUsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMseUZBQXlGO2lCQUNyTCxDQUFDO1lBQ0osQ0FBQztTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRDs7T0FFRztJQUNILElBQVcsZUFBZTtRQUN4QixPQUFPLElBQUksQ0FBQyxjQUFjLEtBQUssZ0NBQXVCLENBQUMsUUFBUSxDQUFDO0lBQ2xFLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU07UUFDWCxPQUFPO1lBQ0wsU0FBUyxFQUFFLElBQUksQ0FBQyxTQUFTO1lBQ3pCLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztZQUNiLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSztZQUNqQixPQUFPLEVBQUUsSUFBSSxDQUFDLE9BQU87WUFDckIsTUFBTSxFQUFFLElBQUksQ0FBQyxNQUFNO1lBQ25CLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSTtZQUNmLFNBQVMsRUFBRSxJQUFJLENBQUMsU0FBUztZQUN6QixhQUFhLEVBQUUsSUFBSSxDQUFDLGFBQWE7WUFDakMsY0FBYyxFQUFFLElBQUksQ0FBQyxjQUFjO1lBQ25DLGFBQWEsRUFBRSxJQUFJLENBQUMsYUFBYTtTQUNsQyxDQUFDO0lBQ0osQ0FBQztJQUVEOztPQUVHO0lBQ0ksWUFBWSxDQUFDLFlBQW9CLEVBQUUsT0FBZTtRQUN2RCxNQUFNLFFBQVEsR0FBRyxnQ0FBdUIsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFLFlBQVksRUFBRSxPQUFPLENBQUMsQ0FBQztRQUM1RixJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxHQUFHLFlBQVksSUFBSSxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQ2hELE9BQU8sUUFBUSxDQUFDO0lBQ2xCLENBQUM7SUFFRDs7T0FFRztJQUNJLFlBQVksQ0FBQyxPQUFlO1FBQ2pDLE9BQU8sZ0NBQXVCLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUN0RSxDQUFDO0lBRUQ7O09BRUc7SUFDSSxlQUFlO1FBQ3BCLE9BQU8sZ0NBQXVCLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQ2hFLENBQUM7O0FBbEpILHdEQW1KQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQge1xuICBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZSxcbiAgQXBwVGhlb3J5TmFtaW5nUHJvZmlsZSxcbiAgQXBwVGhlb3J5TmFtaW5nQ29udGV4dFZhbHVlcyxcbiAgQXBwVGhlb3J5UGh5c2ljYWxOYW1lLFxuICBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZyxcbn0gZnJvbSBcIi4vbmFtaW5nXCI7XG5cbi8qKlxuICogQWNjZXB0ZWQgQ2xvdWRXYXRjaCBMb2dzIGBSZXRlbnRpb25JbkRheXNgIHZhbHVlcy4gQVdTIHJlamVjdHMgYW55IG90aGVyXG4gKiB2YWx1ZSwgc28gdGhlIGNvbnRleHQgZmFpbHMgc3ludGhlc2lzIGluc3RlYWQgb2YgZGVmZXJyaW5nIGEgZGVwbG95LXRpbWVcbiAqIGVycm9yLlxuICovXG5jb25zdCBBQ0NFUFRFRF9SRVRFTlRJT05fREFZUyA9IFtcbiAgMSwgMywgNSwgNywgMTQsIDMwLCA2MCwgOTAsIDEyMCwgMTUwLCAxODAsIDM2NSwgNDAwLCA1NDUsIDczMSwgMTA5NiwgMTgyNywgMjE5MiwgMjU1NywgMjkyMiwgMzI4OCwgMzY1Myxcbl07XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgYW4gYEFwcFRoZW9yeU5hbWluZ0NvbnRleHRgLlxuICpcbiAqIFRoZSBjb250ZXh0IGhvbGRzIHRoZSBib3VuZCBuYW1pbmcgYW5kIGxvZ2dpbmcgdmFsdWVzIGZyb20gc3RhZ2UgY29uZmlnLlxuICogQ29uc3RydWN0cyB0YWtlIGl0IGFzIGFuIG9wdGlvbmFsIHByb3A7IHdpdGggbm8gY29udGV4dCBldmVyeSBjb25zdHJ1Y3RcbiAqIHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgaXQgZGlkIGJlZm9yZSB0aGlzIGNvbnRyYWN0IGV4aXN0ZWQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TmFtaW5nQ29udGV4dFByb3BzIHtcbiAgLyoqXG4gICAqIE5hbWVzcGFjZSBzZWdtZW50LlxuICAgKiBAZGVmYXVsdCBcInRoZW9yeWNsb3VkXCJcbiAgICovXG4gIHJlYWRvbmx5IG5hbWVzcGFjZT86IHN0cmluZztcblxuICAvKipcbiAgICogQXBwIGluc3RhbmNlIGlkIGZyb20gc3RhZ2UgY29uZmlnLlxuICAgKi9cbiAgcmVhZG9ubHkgYXBwOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGlkIGZyb20gc3RhZ2UgY29uZmlnLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U6IHN0cmluZztcblxuICAvKipcbiAgICogVHdlbHZlLWRpZ2l0IGFjY291bnQgaWQgZnJvbSBzdGFnZSBjb25maWcuIEFuIHVucmVzb2x2ZWQgdG9rZW4gZmFpbHNcbiAgICogc3ludGhlc2lzLlxuICAgKi9cbiAgcmVhZG9ubHkgYWNjb3VudDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGdWxsIFJlZ2lvbiBjb2RlLCBmb3IgZXhhbXBsZSBgdXMtZWFzdC0xYC5cbiAgICovXG4gIHJlYWRvbmx5IHJlZ2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBQaHlzaWNhbCBwaW5zIGtleWVkIGB7dHlwZX06e2xvZ2ljYWx9YCwgdXNlZCB2ZXJiYXRpbSB1bmRlciBhIGxlZ2FjeVxuICAgKiBuYW1pbmcgcHJvZmlsZS5cbiAgICogQGRlZmF1bHQge31cbiAgICovXG4gIHJlYWRvbmx5IHBpbnM/OiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9O1xuXG4gIC8qKlxuICAgKiBHZW5lcmF0ZWQtbmFtZSBlbnRyaWVzIGtleWVkIGB7dHlwZX06e2xvZ2ljYWx9YC4gQW4gZW50cnkgbWVhbnNcbiAgICogQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGVzIHRoZSBuYW1lIHRvZGF5LCBzbyB0aGUgY29uc3RydWN0IHNldHMgbm9cbiAgICogcGh5c2ljYWwtbmFtZSBwcm9wZXJ0eS4gVmFsaWQgb25seSB1bmRlciB0aGUgbGVnYWN5IG5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZ2VuZXJhdGVkPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE5hbWluZyBwcm9maWxlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRURcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ1Byb2ZpbGU/OiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuIGBzdGFuZGFyZGAgb3B0cyBldmVyeSBjb25zdHJ1Y3QgdGhhdCByZWNlaXZlcyB0aGUgY29udGV4dFxuICAgKiBpbnRvIHRoZSBjb250cmFjdCdzIGxvZyBncm91cHMgYW5kIGFjY2VzcyBsb2dnaW5nLiBgbGVnYWN5YCBrZWVwcyBlYWNoXG4gICAqIGNvbnN0cnVjdCdzIHByZS1jb250cmFjdCBiZWhhdmlvdXIuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU/OiBBcHBUaGVvcnlMb2dnaW5nUHJvZmlsZTtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIGluIGRheXMgZm9yIHN0YW5kYXJkLXByb2ZpbGUgbG9nIGdyb3Vwcy4gTXVzdCBiZSBhIHZhbHVlXG4gICAqIENsb3VkV2F0Y2ggTG9ncyBhY2NlcHRzLlxuICAgKiBAZGVmYXVsdCAzMFxuICAgKi9cbiAgcmVhZG9ubHkgcmV0ZW50aW9uRGF5cz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBUaGUgYm91bmQgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQgc2hhcmVkIGJ5IEFwcFRoZW9yeSBjb25zdHJ1Y3RzLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBOYW1lc3BhY2Ugc2VnbWVudC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuYW1lc3BhY2U6IHN0cmluZztcblxuICAvKipcbiAgICogQXBwIGluc3RhbmNlIGlkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwcDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBpZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUd2VsdmUtZGlnaXQgYWNjb3VudCBpZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhY2NvdW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZ1bGwgUmVnaW9uIGNvZGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcmVnaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBoeXNpY2FsIHBpbnMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHBpbnM6IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlZC1uYW1lIGVudHJpZXMga2V5ZWQgYHt0eXBlfTp7bG9naWNhbH1gLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGdlbmVyYXRlZDogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBuYW1pbmcgZW50cmllcyBhIGNvbnN0cnVjdCBoYXMgY29uc3VtZWQgYXQgc3ludGhlc2lzLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBjb25zdW1lZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8qKlxuICAgKiBOYW1pbmcgcHJvZmlsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuYW1pbmdQcm9maWxlOiBBcHBUaGVvcnlOYW1pbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIHByb2ZpbGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nZ2luZ1Byb2ZpbGU6IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gaW4gZGF5cyBmb3Igc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXBzLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJldGVudGlvbkRheXM6IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TmFtaW5nQ29udGV4dFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMuYWNjb3VudCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJlcXVpcmVzIGEgY29uY3JldGUgYWNjb3VudCBpZDsgdGhlIG5hbWluZyBjb250cmFjdCBkZXJpdmVzIHBoeXNpY2FsIG5hbWVzIGZyb20gaXQgYW5kIGFuIHVucmVzb2x2ZWQgdG9rZW4gY2Fubm90IGJlIHZhbGlkYXRlZCBhdCBzeW50aGVzaXNcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMucmVnaW9uKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TmFtaW5nQ29udGV4dCByZXF1aXJlcyBhIGNvbmNyZXRlIHJlZ2lvbjsgYW4gdW5yZXNvbHZlZCB0b2tlbiBjYW5ub3QgYmUgdmFsaWRhdGVkIGF0IHN5bnRoZXNpc1wiKTtcbiAgICB9XG5cbiAgICB0aGlzLm5hbWVzcGFjZSA9IHByb3BzLm5hbWVzcGFjZSA/PyBcInRoZW9yeWNsb3VkXCI7XG4gICAgdGhpcy5hcHAgPSBwcm9wcy5hcHA7XG4gICAgdGhpcy5zdGFnZSA9IHByb3BzLnN0YWdlO1xuICAgIHRoaXMuYWNjb3VudCA9IHByb3BzLmFjY291bnQ7XG4gICAgdGhpcy5yZWdpb24gPSBwcm9wcy5yZWdpb247XG4gICAgdGhpcy5waW5zID0geyAuLi4ocHJvcHMucGlucyA/PyB7fSkgfTtcbiAgICB0aGlzLmdlbmVyYXRlZCA9IFsuLi4ocHJvcHMuZ2VuZXJhdGVkID8/IFtdKV07XG4gICAgdGhpcy5uYW1pbmdQcm9maWxlID0gcHJvcHMubmFtaW5nUHJvZmlsZSA/PyBBcHBUaGVvcnlOYW1pbmdQcm9maWxlLkRFUklWRUQ7XG4gICAgdGhpcy5sb2dnaW5nUHJvZmlsZSA9IHByb3BzLmxvZ2dpbmdQcm9maWxlID8/IEFwcFRoZW9yeUxvZ2dpbmdQcm9maWxlLkxFR0FDWTtcbiAgICB0aGlzLnJldGVudGlvbkRheXMgPSBwcm9wcy5yZXRlbnRpb25EYXlzID8/IDMwO1xuXG4gICAgQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcudmFsaWRhdGVDb250ZXh0KHRoaXMudmFsdWVzKCkpO1xuXG4gICAgaWYgKCFBQ0NFUFRFRF9SRVRFTlRJT05fREFZUy5pbmNsdWRlcyh0aGlzLnJldGVudGlvbkRheXMpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IHJldGVudGlvbkRheXMgbXVzdCBiZSBvbmUgb2YgJHtBQ0NFUFRFRF9SRVRFTlRJT05fREFZUy5qb2luKFwiLCBcIil9OyBDbG91ZFdhdGNoIExvZ3MgcmVqZWN0cyBvdGhlciB2YWx1ZXNgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBvcnBoYW5zID0gWy4uLm5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKHRoaXMucGlucyksIC4uLnRoaXMuZ2VuZXJhdGVkXSldLmZpbHRlcihcbiAgICAgICAgICAoa2V5KSA9PiAhdGhpcy5jb25zdW1lZC5oYXMoa2V5KSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKG9ycGhhbnMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgYEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgbmFtaW5nIGVudHJpZXMgbWF0Y2ggbm8gcmVzb3VyY2UgaW4gdGhlIHN0YWNrOiAke29ycGhhbnMuam9pbihcIiwgXCIpfTsgcmVtb3ZlIHRoZW0gb3IgcGFzcyB0aGUgbWF0Y2hpbmcgbG9naWNhbCBuYW1lIHRvIHRoZSBjb25zdHJ1Y3QgdGhhdCBvd25zIHRoZSByZXNvdXJjZWAsXG4gICAgICAgIF07XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSBpcyBhY3RpdmUuXG4gICAqL1xuICBwdWJsaWMgZ2V0IHN0YW5kYXJkTG9nZ2luZygpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5sb2dnaW5nUHJvZmlsZSA9PT0gQXBwVGhlb3J5TG9nZ2luZ1Byb2ZpbGUuU1RBTkRBUkQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGNvbnRleHQgdmFsdWVzIGFzIGEganNpaSBzdHJ1Y3QuXG4gICAqL1xuICBwdWJsaWMgdmFsdWVzKCk6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHRWYWx1ZXMge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lc3BhY2U6IHRoaXMubmFtZXNwYWNlLFxuICAgICAgYXBwOiB0aGlzLmFwcCxcbiAgICAgIHN0YWdlOiB0aGlzLnN0YWdlLFxuICAgICAgYWNjb3VudDogdGhpcy5hY2NvdW50LFxuICAgICAgcmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgIHBpbnM6IHRoaXMucGlucyxcbiAgICAgIGdlbmVyYXRlZDogdGhpcy5nZW5lcmF0ZWQsXG4gICAgICBuYW1pbmdQcm9maWxlOiB0aGlzLm5hbWluZ1Byb2ZpbGUsXG4gICAgICBsb2dnaW5nUHJvZmlsZTogdGhpcy5sb2dnaW5nUHJvZmlsZSxcbiAgICAgIHJldGVudGlvbkRheXM6IHRoaXMucmV0ZW50aW9uRGF5cyxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXBvc2UgdGhlIHBoeXNpY2FsIG5hbWUgb2Ygb25lIHJlc291cmNlIHVuZGVyIHRoaXMgY29udGV4dC5cbiAgICovXG4gIHB1YmxpYyBwaHlzaWNhbE5hbWUocmVzb3VyY2VUeXBlOiBzdHJpbmcsIGxvZ2ljYWw6IHN0cmluZyk6IEFwcFRoZW9yeVBoeXNpY2FsTmFtZSB7XG4gICAgY29uc3QgY29tcG9zZWQgPSBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5waHlzaWNhbE5hbWUodGhpcy52YWx1ZXMoKSwgcmVzb3VyY2VUeXBlLCBsb2dpY2FsKTtcbiAgICB0aGlzLmNvbnN1bWVkLmFkZChgJHtyZXNvdXJjZVR5cGV9OiR7bG9naWNhbH1gKTtcbiAgICByZXR1cm4gY29tcG9zZWQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIHBoeXNpY2FsIGxvZy1ncm91cCBuYW1lIG9mIGEgbG9naWNhbCBzb3VyY2UgdW5kZXIgdGhpcyBjb250ZXh0LlxuICAgKi9cbiAgcHVibGljIGxvZ0dyb3VwTmFtZShsb2dpY2FsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlSZXNvdXJjZU5hbWluZy5sb2dHcm91cE5hbWUodGhpcy52YWx1ZXMoKSwgbG9naWNhbCk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGJvdW5kIHByZWZpeCBzaGFyZWQgYnkgdGhpcyBhcHAncyBsb2cgc291cmNlcy5cbiAgICovXG4gIHB1YmxpYyBsb2dTb3VyY2VQcmVmaXgoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5UmVzb3VyY2VOYW1pbmcubG9nU291cmNlUHJlZml4KHRoaXMudmFsdWVzKCkpO1xuICB9XG59XG4iXX0=