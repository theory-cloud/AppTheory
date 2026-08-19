import { Construct } from "constructs";
/**
 * Governed CloudFormation install-parameter contract for a Theory Cloud namespace.
 *
 * The construct keeps templates account-agnostic: every per-install identity
 * value enters through one of the ten required stack parameters and is exposed
 * as a string token for consuming constructs. Parameter patterns and allowed
 * values are evaluated by CloudFormation, not duplicated as synthesis-time
 * validation.
 *
 * CloudFormation Rules cannot use `Fn::Join`, so this construct cannot assert
 * that `DnsHost` equals
 * `cloud-keeper.<NamespaceSlug>.theorycloud.app`. The governed install-profile
 * validator owns that relational check; the `DnsHost` parameter pattern still
 * enforces the `theorycloud.app` suffix during stack evaluation.
 */
export declare class AppTheoryInstallParameters extends Construct {
    /** Exact 12-digit namespace AWS account token. */
    readonly targetAccountId: string;
    /** Theory Cloud namespace slug token. */
    readonly namespaceSlug: string;
    /** Installed AWS account class token. */
    readonly accountClass: string;
    /** Target Theory Cloud application identifier token. */
    readonly targetApplicationId: string;
    /** Autheory tenant identifier token. */
    readonly tenantId: string;
    /** Exact Cloud Keeper DNS host token. */
    readonly dnsHost: string;
    /** Namespace install stage token. */
    readonly stage: string;
    /** Route 53 public hosted-zone identifier token. */
    readonly publicHostedZoneId: string;
    /** Autheory HTTPS authorization-server origin token. */
    readonly authorizationServerOrigin: string;
    /** Autheory HTTPS JWKS URL token. */
    readonly autheoryJwksUrl: string;
    constructor(scope: Construct, id: string);
    private stringParameter;
}
