import type { ManualClock } from "../clock.js";
import { type StoreConformanceCase, type Stores } from "./store.js";
/**
 * Executes the transactional-family rows of the shared store conformance table.
 * The handlers are deliberately in their own module so the main switch stays
 * readable; every row uses only the public store methods a custom store must
 * implement.
 */
export declare function runFamilyConformanceCase(stores: Stores, testCase: StoreConformanceCase, clock: ManualClock): Promise<Record<string, unknown>>;
//# sourceMappingURL=family-conformance.d.ts.map