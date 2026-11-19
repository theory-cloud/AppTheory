import type { AppTheoryNamingContext } from "../naming-context";
/**
 * Refuse an explicit physical-name prop when a naming context is present.
 *
 * Under either naming profile the name comes from derivation, a pin or a
 * generated entry, never from a hand-built prop (contract section 4). The
 * message names the entry the caller should use instead.
 */
export declare function refuseExplicitName(context: AppTheoryNamingContext | undefined, construct: string, propName: string, resourceType: string, logical: string | undefined, isSet: boolean): void;
