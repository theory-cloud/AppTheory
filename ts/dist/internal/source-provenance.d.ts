import type { SourceProvenance } from "../types.js";
export declare function unknownSourceProvenance(): SourceProvenance;
export declare function sourceProvenanceFromProviderRequestContext(provider: unknown, sourceIP: unknown): SourceProvenance;
export declare function normalizeSourceProvenance(input: unknown): SourceProvenance;
