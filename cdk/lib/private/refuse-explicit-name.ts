import { AppTheoryNamingProfile } from "../naming";
import type { AppTheoryNamingContext } from "../naming-context";

/**
 * Refuse an explicit physical-name prop when a naming context is present.
 *
 * Under either naming profile the name comes from derivation, a pin or a
 * generated entry, never from a hand-built prop (contract section 4). The
 * message names the entry the caller should use instead.
 */
export function refuseExplicitName(
  context: AppTheoryNamingContext | undefined,
  construct: string,
  propName: string,
  resourceType: string,
  logical: string | undefined,
  isSet: boolean,
): void {
  if (!context || !isSet) return;
  const key = logical ? `${resourceType}:${logical}` : `${resourceType}:<logical>`;
  const hint =
    context.namingProfile === AppTheoryNamingProfile.LEGACY
      ? `declare ${key} in naming.pins (or in naming.generated when CloudFormation generates the name today)`
      : `remove it and let the naming context derive ${key}, or move the resource to naming.pins`;
  throw new Error(
    `${construct} cannot honor props.${propName} when a naming context is present; ${hint}`,
  );
}
