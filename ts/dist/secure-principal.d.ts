/** Classification assigned after application-owned credential verification. */
export type PrincipalKind = "external" | "internal";
/** Normalized principal used by SecureApp gates. */
export interface SecurePrincipal {
    identity: string;
    scopes: string[];
    claims: Record<string, unknown>;
    kind: PrincipalKind | "" | string;
}
export declare function cloneSecurePrincipal(principal: SecurePrincipal | null | undefined): SecurePrincipal | null;
export declare function normalizeSecurePrincipal(principal: SecurePrincipal | null | undefined): {
    principal: SecurePrincipal | null;
    invalidKind: boolean;
};
//# sourceMappingURL=secure-principal.d.ts.map