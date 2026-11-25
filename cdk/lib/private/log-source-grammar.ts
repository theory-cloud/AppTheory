/**
 * The `theorycloud_resource_naming.v0.1` section 3 log-source grammar, shared by
 * the derivation and the fixed-name check so the two cannot drift apart.
 *
 * Section 1 defines one logical segment as `[a-z0-9]+(-[a-z0-9]+)*`; section 3
 * names a log group `theorycloud_{namespace}_{app}_{stage}_{logical}`, where the
 * logical source's `/` separators become `_` (one grammar then also satisfies
 * CloudFront's `[\w-]` destination). The remainder of such a name after its
 * bound prefix is therefore `logs`, then one or more logical segments joined
 * with `_`.
 */

/**
 * One logical-name segment (`[a-z0-9]+(-[a-z0-9]+)*`), the grammar of a
 * namespace, an app id, a stage's siblings and every logical-name segment.
 */
export const LOGICAL_SEGMENT_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";

/**
 * The Lambda service log-group path lead (contract section 3): the second shape a
 * fixed log-group name may take, `/aws/lambda/{function name}`.
 */
export const LAMBDA_LOG_GROUP_LEAD = "/aws/lambda/";

/**
 * The remainder of a section 3 log-source name after its bound
 * `theorycloud_{namespace}_{app}_{stage}_` prefix: the literal `logs` segment,
 * then one or more logical segments joined with `_`, and nothing else.
 */
export const LOG_SOURCE_REMAINDER_RE = new RegExp(`^logs(?:_${LOGICAL_SEGMENT_PATTERN})+$`);
