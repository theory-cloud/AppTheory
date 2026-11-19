import { Token } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * Convert a construct id to a contract logical-name segment.
 *
 * Logical segments use `[a-z0-9]+(-[a-z0-9]+)*`; a construct id is the
 * consumer's declaration site, so it is a stable default when the consumer does
 * not pass an explicit logical name.
 */
export function defaultLogicalName(scope: Construct): string {
  const id = scope.node.id;
  if (Token.isUnresolved(id)) {
    throw new Error(
      `AppTheory cannot derive a logical name from the token-valued construct id ${JSON.stringify(id)}; pass an explicit logicalName`,
    );
  }
  const kebab = id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (!kebab) {
    throw new Error(`AppTheory cannot derive a logical name from the construct id ${JSON.stringify(id)}; pass an explicit logicalName`);
  }
  return kebab;
}
