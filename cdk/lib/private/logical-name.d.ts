import type { Construct } from "constructs";
/**
 * Convert a construct id to a contract logical-name segment.
 *
 * Logical segments use `[a-z0-9]+(-[a-z0-9]+)*`; a construct id is the
 * consumer's declaration site, so it is a stable default when the consumer does
 * not pass an explicit logical name.
 */
export declare function defaultLogicalName(scope: Construct): string;
