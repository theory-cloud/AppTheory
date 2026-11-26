import { createHash } from "node:crypto";

import { LAMBDA_LOG_GROUP_LEAD, LOGICAL_SEGMENT_PATTERN } from "./private/log-source-grammar";

/**
 * The resource-naming contract this module implements.
 */
export const RESOURCE_NAMING_CONTRACT = "theorycloud_resource_naming.v0.1";

/**
 * The schema identifier of the derived-name artifact a naming context emits.
 */
export const DERIVED_NAMES_SCHEMA = "apptheory_resource_naming.derived_names.v1";

/**
 * The cloud-assembly metadata type that carries the derived-name artifact. The
 * artifact lands in `{stack}.metadata.json` in `cdk.out`.
 */
export const DERIVED_NAMES_METADATA_KEY = "apptheory:resource-naming/derived-names";

/**
 * Naming profiles accepted by a naming context.
 */
export enum AppTheoryNamingProfile {
  /**
   * Names derive from the naming context.
   */
  DERIVED = "derived",
  /**
   * Every name comes from a pin.
   */
  LEGACY = "legacy",
}

/**
 * Logging profiles accepted by a naming context.
 */
export enum AppTheoryLoggingProfile {
  /**
   * AppTheory creates standard log groups and access logging.
   */
  STANDARD = "standard",
  /**
   * Each construct keeps its pre-contract logging behaviour.
   */
  LEGACY = "legacy",
}

/**
 * Keeper's answer to a reader request.
 */
export enum AppTheoryKeeperAnswer {
  /**
   * The source is shared and the read returned events.
   */
  EVENTS = "events",
  /**
   * The source is shared and the read returned no events.
   */
  ALLOWED_NO_EVENTS = "allowed_no_events",
  /**
   * The source is not shared, or the read failed closed.
   */
  NOT_SHARED = "not_shared",
}

/**
 * Bound naming and logging context values from stage config.
 */
export interface AppTheoryNamingContextValues {
  /**
   * Namespace segment.
   * @default "theorycloud"
   */
  readonly namespace?: string;

  /**
   * App instance id.
   */
  readonly app: string;

  /**
   * Stage id.
   */
  readonly stage: string;

  /**
   * Twelve-digit account id. An unresolved token fails synthesis.
   */
  readonly account: string;

  /**
   * Full Region code, for example `us-east-1`.
   */
  readonly region: string;

  /**
   * Physical pins keyed `{type}:{logical}`.
   * @default {}
   */
  readonly pins?: { [key: string]: string };

  /**
   * Generated-name entries keyed `{type}:{logical}`. An entry means
   * CloudFormation generates the name today, so the construct sets no
   * physical-name property. Valid only under the legacy naming profile.
   * @default []
   */
  readonly generated?: string[];

  /**
   * `true` for a deployment TheoryCloud.ai places on a tenant's behalf
   * (contract section 1, r5). A hosted deployment always supplies its
   * namespace, never uses the reserved platform namespace, and carries the
   * namespace in every derived name (contract section 2). Only first-party
   * platform apps omit it.
   * @default false
   */
  readonly hosted?: boolean;

  /**
   * Naming profile.
   * @default AppTheoryNamingProfile.DERIVED
   */
  readonly namingProfile?: AppTheoryNamingProfile;

  /**
   * Logging profile.
   * @default AppTheoryLoggingProfile.LEGACY
   */
  readonly loggingProfile?: AppTheoryLoggingProfile;

  /**
   * Log retention in days for standard-profile log groups.
   * @default 30
   */
  readonly retentionDays?: number;
}

/**
 * The composed physical name of one resource.
 */
export interface AppTheoryPhysicalName {
  /**
   * The full physical name. Absent when CloudFormation generates the name.
   * @default undefined
   */
  readonly name?: string;

  /**
   * The account-regional bucket-name prefix, when the type uses one.
   * @default undefined
   */
  readonly bucketNamePrefix?: string;

  /**
   * The bucket namespace, when the type uses one.
   * @default undefined
   */
  readonly bucketNamespace?: string;

  /**
   * Whether the name came from a pin.
   * @default false
   */
  readonly pinned?: boolean;

  /**
   * Whether CloudFormation generates the name, so no physical-name property is
   * set.
   * @default false
   */
  readonly generated?: boolean;
}

/**
 * One physically named resource a stack declares, as the synth check (contract
 * section 11.4) consumes it. A generated entry carries no name: CloudFormation
 * owns the name, so there is nothing to reserve.
 */
export interface AppTheoryDerivedNameInput {
  /**
   * The physical name. Absent for a generated entry.
   * @default undefined
   */
  readonly name?: string;

  /**
   * The contract resource type, for example `lambda_function`.
   */
  readonly type: string;

  /**
   * The CloudFormation logical id of the resource carrying the name, or — when
   * the caller's naming context spans several stacks — the owning stack's
   * construct path plus that logical id, because a logical id is unique only
   * within one template.
   */
  readonly logicalId: string;

  /**
   * Whether CloudFormation generates the name, so nothing is reserved.
   * @default false
   */
  readonly generated?: boolean;
}

/**
 * One row of the derived-name artifact: the complete set the name reservation
 * index (contract section 11.2) reserves.
 */
export interface AppTheoryDerivedName {
  /**
   * The physical name. Absent for a generated entry.
   * @default undefined
   */
  readonly name?: string;

  /**
   * The contract resource type.
   */
  readonly type: string;

  /**
   * The scope in which AWS requires the name to be unique: `account`,
   * `account_region`, or `not_unique`.
   */
  readonly scope: string;

  /**
   * The CloudFormation logical id of the resource carrying the name.
   */
  readonly logicalId: string;

  /**
   * Whether CloudFormation generates the name, so nothing is reserved.
   * @default false
   */
  readonly generated?: boolean;
}

/**
 * The derived-name artifact a naming context emits at synthesis (contract
 * section 11.4), keyed `{stack}.metadata.json` in the cloud assembly.
 */
export interface AppTheoryDerivedNames {
  /**
   * The contract identifier.
   */
  readonly contract: string;

  /**
   * The artifact schema identifier.
   */
  readonly schema: string;

  /**
   * The naming context that produced the artifact.
   */
  readonly context: AppTheoryNamingContextValues;

  /**
   * Every physically named resource the context declares, sorted by `scope`,
   * `type`, `name` and `logicalId`.
   */
  readonly entries: AppTheoryDerivedName[];
}

/**
 * The naming scopes of contract section 11.1.
 */
export enum AppTheoryNamingScope {
  /**
   * AWS keeps the name unique across the whole account, whatever the Region.
   */
  ACCOUNT = "account",
  /**
   * AWS keeps the name unique per account and Region.
   */
  ACCOUNT_REGION = "account_region",
  /**
   * AWS does not keep the name unique, so nothing is reserved for it.
   */
  NOT_UNIQUE = "not_unique",
}

/**
 * Include and exclude visibility selectors.
 */
export interface AppTheoryVisibilityRules {
  /**
   * Selectors whose sources are shared.
   * @default []
   */
  readonly include?: string[];

  /**
   * Selectors whose sources are never shared. Exclusions win.
   * @default []
   */
  readonly exclude?: string[];
}

/**
 * The synth-time visibility preview.
 */
export interface AppTheoryVisibilityPreview {
  /**
   * First 12 hex characters of the canonical rules hash.
   */
  readonly ruleVersion: string;

  /**
   * Current synthesized sources the rules share.
   */
  readonly matchedNow: string[];

  /**
   * Current synthesized sources the rules do not share.
   */
  readonly notMatchedNow: string[];

  /**
   * The selectors, as the statement of what future sources will match.
   */
  readonly future: AppTheoryVisibilityRules;
}

/**
 * The published SSM manifest: the preview minus `notMatchedNow`.
 */
export interface AppTheoryVisibilityManifest {
  /**
   * First 12 hex characters of the canonical rules hash.
   */
  readonly ruleVersion: string;

  /**
   * Current synthesized sources the rules share.
   */
  readonly matchedNow: string[];

  /**
   * The selectors, as the statement of what future sources will match.
   */
  readonly future: AppTheoryVisibilityRules;
}

const SEGMENT_PATTERN = LOGICAL_SEGMENT_PATTERN;
const LOGICAL_RE = new RegExp(`^${SEGMENT_PATTERN}(?:/${SEGMENT_PATTERN})*$`);
const APP_RE = new RegExp(`^${SEGMENT_PATTERN}$`);
const STAGE_RE = /^[a-z][a-z0-9]{0,7}$/;
const NAMESPACE_RE = new RegExp(`^${SEGMENT_PATTERN}$`);
const ACCOUNT_RE = /^[0-9]{12}$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;
const SECRET_TAIL_RE = /-[A-Za-z0-9]{6}$/;
const S3_EDGES_RE = /^[a-z0-9].*[a-z0-9]$/;
const LOG_PREFIX = "theorycloud";
const ROLE_POLICY_MAX = 10240;
/** The longest hosted namespace label, in characters (contract section 1, r5 rev1). */
const HOSTED_NAMESPACE_MAX = 12;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

interface Rule {
  readonly kind: "dash" | "path" | "s3ar" | "log";
  readonly max: number;
  /**
   * The lower bound contract section 2 states for the type, when it states one.
   * A row that states only an upper limit has none here, so the table stays the
   * section 2 table and not a stricter private one.
   */
  readonly min?: number;
  readonly charset: string;
  readonly lead?: string;
}

const RULES: { [type: string]: Rule } = {
  s3_bucket: { kind: "s3ar", max: 63, charset: "[a-z0-9-]" },
  s3_vector_bucket: { kind: "dash", max: 63, charset: "[a-z0-9-]" },
  s3_vector_index: { kind: "dash", max: 63, charset: "[a-z0-9-]" },
  // Section 2: "255 (plain-name limit 3–255; the 1024 limit applies to the ARN
  // form)". The lower bound is part of the row, so a fixed name of one or two
  // characters is refused (SANITY-AT-N3-08).
  dynamodb_table: { kind: "dash", max: 255, min: 3, charset: "[A-Za-z0-9_.-]" },
  lambda_function: { kind: "dash", max: 64, charset: "[A-Za-z0-9_-]" },
  sqs_queue: { kind: "dash", max: 80, charset: "[A-Za-z0-9_-]" },
  sns_topic: { kind: "dash", max: 256, charset: "[A-Za-z0-9_-]" },
  secret: { kind: "path", max: 512, charset: "[A-Za-z0-9/_+=.@-]" },
  ssm_parameter: { kind: "path", max: 900, charset: "[A-Za-z0-9_./-]", lead: "/" },
  kms_alias: { kind: "path", max: 256, charset: "[A-Za-z0-9/_-]", lead: "alias/" },
  event_bus: { kind: "dash", max: 256, charset: "[A-Za-z0-9._-]" },
  event_rule: { kind: "dash", max: 64, charset: "[A-Za-z0-9._-]" },
  schedule: { kind: "dash", max: 64, charset: "[A-Za-z0-9._-]" },
  alarm: { kind: "dash", max: 255, charset: "[A-Za-z0-9_.-]" },
  dashboard: { kind: "dash", max: 255, charset: "[A-Za-z0-9_-]" },
  iam_role: { kind: "dash", max: 64, charset: "[A-Za-z0-9+=,.@_-]" },
  iam_managed_policy: { kind: "dash", max: 128, charset: "[A-Za-z0-9+=,.@_-]" },
  state_machine: { kind: "dash", max: 80, charset: "[A-Za-z0-9_-]" },
  codebuild_project: { kind: "dash", max: 150, charset: "[A-Za-z0-9_-]" },
  api_rest: { kind: "dash", max: 128, charset: "[A-Za-z0-9_-]" },
  api_http: { kind: "dash", max: 128, charset: "[A-Za-z0-9_-]" },
  api_websocket: { kind: "dash", max: 128, charset: "[A-Za-z0-9_-]" },
  log_delivery_source: { kind: "dash", max: 60, charset: "[A-Za-z0-9_-]" },
  log_delivery_destination: { kind: "dash", max: 60, charset: "[A-Za-z0-9_-]" },
  log_group: { kind: "log", max: 512, charset: "[A-Za-z0-9_-]" },
};

/**
 * The rules of one contract type, or `undefined` when the contract states none
 * (contract section 2). The lookup is an own-property check, so an inherited
 * name such as `constructor`, `toString`, `__proto__` or `hasOwnProperty` is an
 * unknown type, never a type with rules.
 */
function namingRule(resourceType: string): Rule | undefined {
  if (!Object.hasOwn(RULES, resourceType)) return undefined;
  return RULES[resourceType];
}

/**
 * API name types. The CDK defaults an API Name today, so a name for one is
 * explicit and takes a pin, never a generated entry (r3, ADV-1312-3).
 */
const API_TYPES = new Set(["api_rest", "api_http", "api_websocket"]);

/**
 * Types whose section 2 row adds the S3 start/end-alphanumeric rule.
 */
const S3_TYPES = new Set(["s3_bucket", "s3_vector_bucket", "s3_vector_index"]);

/**
 * Types whose fixed-name charset differs from the derived-name charset of their
 * section 2 row. A log group is the only one: one of its two fixed shapes is the
 * Lambda service path `/aws/lambda/{function name}` (section 3), so `/` is part
 * of the charset even though no derived log-group name contains one. The shape
 * rule below is what narrows it again: every other `/`-bearing log group is
 * refused.
 */
const FIXED_NAME_CHARSETS = new Map([["log_group", "[A-Za-z0-9_/-]"]]);

/**
 * The KMS alias path lead (contract section 2).
 */
const KMS_ALIAS_LEAD = "alias/";

/**
 * An absolute SSM parameter path: a lead `/`, then at least one non-empty
 * segment, with no empty segment anywhere (contract section 2).
 */
const SSM_PATH_RE = /^\/[^/]+(?:\/[^/]+)*$/;

/**
 * Whether a fixed log-group name is one of the two shapes contract section 3
 * states, and nothing else:
 *
 * - a log-source name, `theorycloud_{namespace}_{app}_{stage}_{logical}`. Its
 *   segments are joined with `_` precisely so the one grammar also satisfies
 *   CloudFront's `[\w-]` destination, so such a name carries no `/` at all;
 * - the Lambda service path `/aws/lambda/{function name}`, whose function name
 *   satisfies the `lambda_function` row of section 2 (length and charset).
 *
 * Any other `/`-bearing name is refused: `arbitrary/path` is neither shape
 * (SANITY-AT-N3-08).
 *
 * The log-source branch here is a shape test only, not an identity test: it
 * cannot tell whose context a name belongs to. `AppTheoryNamingContext`
 * narrows it to the context's own `theorycloud_{namespace}_{app}_{stage}_`
 * prefix and remainder grammar when it declares a fixed name.
 */
function isFixedLogGroupShape(name: string): boolean {
  if (!name.includes("/")) return true;
  if (!name.startsWith(LAMBDA_LOG_GROUP_LEAD)) return false;
  const functionName = name.slice(LAMBDA_LOG_GROUP_LEAD.length);
  const lambda = RULES.lambda_function;
  if (functionName.length > lambda.max) return false;
  if (lambda.min !== undefined && functionName.length < lambda.min) return false;
  return new RegExp(`^(?:${lambda.charset})+$`).test(functionName);
}

/**
 * Types AWS keeps unique across Regions (contract section 11.1).
 */
const ACCOUNT_GLOBAL_TYPES = new Set(["iam_role", "iam_managed_policy", "dashboard"]);

/**
 * API display names AWS does not keep unique, so nothing is reserved for them.
 */
const NOT_UNIQUE_TYPES = new Set(["api_rest", "api_http", "api_websocket"]);

/**
 * The refusal for a type the contract states no naming scope for: it cannot be
 * reserved, so it cannot be deployed through the index until a revision states
 * its scope.
 */
const UNKNOWN_NAMING_SCOPE = "a type with no stated naming scope cannot be reserved";

const KEEPER_ACTIONS_GROUP = ["logs:FilterLogEvents", "logs:DescribeLogStreams"];
const KEEPER_ACTIONS_STREAM = ["logs:GetLogEvents"];

function fail(message: string): never {
  throw new Error(message);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function base32Lower(text: string): string {
  const bytes = createHash("sha256").update(text, "utf8").digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function shorten(full: string, limit: number): string {
  if (full.length <= limit) return full;
  const head = full.slice(0, limit - 9).replace(/[-_./]+$/, "");
  return `${head}-${base32Lower(full).slice(0, 8)}`;
}

function namespaceOf(values: AppTheoryNamingContextValues): string {
  return values.namespace ?? LOG_PREFIX;
}

/**
 * Apply the hosted namespace label rule (contract section 1, r5 rev1): a
 * namespace other than the reserved platform one is at most
 * `HOSTED_NAMESPACE_MAX` characters and never starts with `aws` or `ssm`. Those
 * two prefixes are reserved by AWS, so a name carrying them cannot be created.
 */
function validateHostedNamespace(namespace: string): void {
  if (namespace === LOG_PREFIX) return;
  if (namespace.length > HOSTED_NAMESPACE_MAX) {
    fail("hosted namespace longer than 12 characters");
  }
  if (namespace.startsWith("aws") || namespace.startsWith("ssm")) {
    fail("hosted namespace must not start with aws or ssm");
  }
}

/**
 * Whether every derived name carries the namespace (contract section 2, r5):
 * true for a hosted deployment and for any namespace other than the reserved
 * platform one. The platform namespace keeps the compatibility form byte for
 * byte, so the live hard gate (contract section 4) is unchanged.
 */
function namespaced(values: AppTheoryNamingContextValues): boolean {
  return values.hosted === true || namespaceOf(values) !== LOG_PREFIX;
}

/**
 * The `{namespace}-{app}-{stage}-{logical}` stem of a `dash` name or an S3
 * account-regional prefix, with `/` in the logical name replaced by `-`.
 */
function dashStem(values: AppTheoryNamingContextValues, logical: string): string {
  const parts = [values.app, values.stage, logical.replace(/\//g, "-")];
  if (namespaced(values)) parts.unshift(namespaceOf(values));
  return parts.join("-");
}

/**
 * The `{namespace}/{app}/{stage}/{logical}` stem of a `path` name.
 */
function pathStem(values: AppTheoryNamingContextValues, logical: string): string {
  const parts = [values.app, values.stage, logical];
  if (namespaced(values)) parts.unshift(namespaceOf(values));
  return parts.join("/");
}

/**
 * The leading namespace component a hosted pin must carry, exactly where the
 * derived form puts it (contract section 4, r5 rev1, rev2). Containing the
 * namespace elsewhere is not enough: `shop-lab-events` is not a pin for
 * namespace `hop`.
 */
function hostedPinLead(values: AppTheoryNamingContextValues, rule: Rule): string {
  const namespace = namespaceOf(values);
  if (rule.kind === "path") return `${rule.lead ?? ""}${namespace}/`;
  if (rule.kind === "log") return `${LOG_PREFIX}_${namespace}_`;
  return `${namespace}-`;
}

function sortedCopy(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function logPrefix(values: AppTheoryNamingContextValues): string {
  return [LOG_PREFIX, namespaceOf(values), values.app, values.stage].join("_") + "_";
}

/**
 * The `theorycloud_resource_naming.v0.1` primitives, exposed for jsii so the Go
 * and Python CDK bindings share one implementation.
 */
export class AppTheoryResourceNaming {
  private constructor() {}

  /**
   * Validate the bound context grammar. Throws on an invalid context.
   */
  public static validateContext(values: AppTheoryNamingContextValues): void {
    if (!APP_RE.test(values.app)) fail("app");
    if (!STAGE_RE.test(values.stage)) fail("stage");
    if (!ACCOUNT_RE.test(values.account)) fail("account");
    if (!REGION_RE.test(values.region)) fail("region");
    // r5 rev1: a hosted deployment always supplies its namespace; it never
    // defaults to the platform form.
    if (values.hosted === true && !values.namespace) {
      fail("a hosted deployment must supply its namespace");
    }
    const namespace = namespaceOf(values);
    if (!NAMESPACE_RE.test(namespace)) fail("namespace");
    // r5 rev1: `theorycloud` is reserved for first-party platform apps. A hosted
    // deployment may never use it, because its names would then collide with the
    // platform app's in a pooled account.
    if (values.hosted === true && namespace === LOG_PREFIX) {
      fail(`namespace ${LOG_PREFIX} is reserved for first-party platform apps`);
    }
    validateHostedNamespace(namespace);
  }

  /**
   * Apply the hosted namespace label rule to one namespace (contract section 1,
   * r5 rev1): a namespace other than the reserved platform one is at most 12
   * characters and never starts with `aws` or `ssm`. Throws on a namespace
   * outside it.
   */
  public static validateHostedNamespace(namespace: string): void {
    validateHostedNamespace(namespace);
  }

  /**
   * Whether every derived name under these values carries the namespace
   * (contract section 2, r5): true for a hosted deployment and for any namespace
   * other than the reserved platform one.
   */
  public static namespaced(values: AppTheoryNamingContextValues): boolean {
    return namespaced(values);
  }

  /**
   * The CloudFormation-appended account-regional bucket suffix.
   */
  public static s3AccountRegionalSuffix(values: AppTheoryNamingContextValues): string {
    return `-${values.account}-${values.region}-an`;
  }

  /**
   * The bound prefix shared by every log source of the app.
   */
  public static logSourcePrefix(values: AppTheoryNamingContextValues): string {
    return logPrefix(values);
  }

  /**
   * Map a logical log source to its physical log-group name.
   */
  public static logGroupName(values: AppTheoryNamingContextValues, logical: string): string {
    if (!logical.startsWith("logs/")) fail("log logical must start with logs/");
    return logPrefix(values) + logical.replace(/\//g, "_");
  }

  /**
   * Compose the physical name of one resource. A pin always wins. A generated
   * entry means CloudFormation generates the name today and the construct sets
   * no physical-name property. Generated entries are legacy-only; a legacy
   * profile needs exactly one of a pin or a generated entry.
   *
   * A hosted deployment (`hosted: true`, or any namespace other than the
   * platform one) carries the namespace as the first component of every derived
   * name, its S3 bucket-name prefix included, so it reaches the shortened
   * over-budget form sooner (contract section 2.4). It takes no generated entry
   * and no legacy profile, and a pin must start with its namespace component
   * (contract sections 2 and 4, r5).
   */
  public static physicalName(
    values: AppTheoryNamingContextValues,
    resourceType: string,
    logical: string,
  ): AppTheoryPhysicalName {
    AppTheoryResourceNaming.validateContext(values);
    if (!LOGICAL_RE.test(logical)) fail("logical");
    const rule = namingRule(resourceType);
    if (!rule) fail(`resource type ${resourceType}`);
    const generated = values.generated ?? [];
    const legacy = (values.namingProfile ?? AppTheoryNamingProfile.DERIVED) === AppTheoryNamingProfile.LEGACY;
    // r5 rev2: the legacy profile and generated entries are first-party
    // live-compatibility tools only. A hosted deployment takes neither, because a
    // pinned or CloudFormation-generated name carries no namespace and would
    // collide across tenants in a pooled account.
    if (namespaced(values) && (legacy || generated.length > 0)) {
      fail("a hosted deployment takes no legacy profile or generated entries");
    }
    if (generated.length > 0 && !legacy) {
      fail("generated entries are only valid under the legacy naming profile");
    }
    const key = `${resourceType}:${logical}`;
    const pin = values.pins?.[key];
    const keepGenerated = generated.includes(key);
    // r3, ADV-1312-3: CDK defaults an API Name today, so it is an explicit name
    // and takes a pin, never a generated entry.
    if (keepGenerated && API_TYPES.has(resourceType)) {
      fail("an API name takes a pin, never a generated entry");
    }
    if (pin !== undefined && keepGenerated) fail("a resource has both a pin and a generated entry");
    if (pin !== undefined) {
      // r5 rev2: a hosted pin starts with its namespace component, as the
      // derived form does. A namespace that merely appears somewhere in the name
      // is not the namespace component.
      if (namespaced(values) && !pin.startsWith(hostedPinLead(values, rule))) {
        fail("a hosted pin must start with the namespace component");
      }
      return { name: pin, pinned: true };
    }
    if (keepGenerated) return { generated: true };
    if (legacy) {
      fail(`legacy naming profile requires a pin or a generated entry for ${key}`);
    }

    let out: AppTheoryPhysicalName;
    if (rule.kind === "s3ar") {
      const suffix = AppTheoryResourceNaming.s3AccountRegionalSuffix(values);
      const budget = rule.max - suffix.length;
      const prefix = shorten(dashStem(values, logical), budget);
      out = { name: prefix + suffix, bucketNamePrefix: prefix, bucketNamespace: "account-regional" };
    } else if (rule.kind === "dash") {
      out = { name: shorten(dashStem(values, logical), rule.max) };
    } else if (rule.kind === "path") {
      const full = `${rule.lead ?? ""}${pathStem(values, logical)}`;
      if (resourceType === "secret" && SECRET_TAIL_RE.test(full)) {
        fail("secret name must not end with a hyphen and six characters");
      }
      if (resourceType === "ssm_parameter" && (full.match(/\//g)?.length ?? 0) > 15) {
        fail("ssm hierarchy deeper than 15");
      }
      if (full.length > rule.max) fail("path name over limit");
      out = { name: full };
    } else if (rule.kind === "log") {
      const name = AppTheoryResourceNaming.logGroupName(values, logical);
      if (name.length > rule.max) fail("log group over limit");
      out = { name };
    } else {
      fail(`unsupported kind ${String(rule.kind)}`);
    }

    const name = out.name as string;
    if (!new RegExp(`^(?:${rule.charset})+$`).test(name)) fail("charset");
    if (name.length > rule.max) fail("length");
    if (rule.min !== undefined && name.length < rule.min) fail("length");
    if (["s3_bucket", "s3_vector_bucket", "s3_vector_index"].includes(resourceType) && !S3_EDGES_RE.test(name)) {
      fail("s3 start/end");
    }
    return out;
  }

  /**
   * The scope in which AWS requires a type's names to be unique (contract
   * section 11.1). A type the contract states no scope for is refused: it cannot
   * be reserved, so it cannot be deployed through the index until a revision
   * states its scope.
   */
  public static namingScope(resourceType: string): AppTheoryNamingScope {
    if (namingRule(resourceType) === undefined) fail(UNKNOWN_NAMING_SCOPE);
    if (NOT_UNIQUE_TYPES.has(resourceType)) return AppTheoryNamingScope.NOT_UNIQUE;
    if (ACCOUNT_GLOBAL_TYPES.has(resourceType)) return AppTheoryNamingScope.ACCOUNT;
    return AppTheoryNamingScope.ACCOUNT_REGION;
  }

  /**
   * Validate a physical name the contract fixes rather than derives against the
   * character and shape rules of the type's section 2 row: charset, the length
   * range (**both** bounds when the row states a lower one, not only the upper),
   * the S3 start/end rule, the path rules (lead, non-empty segments, depth,
   * reserved prefixes, the `alias/aws/` namespace) and the secret ARN-suffix
   * rule. Throws on a name outside them.
   *
   * This is the section 2 table, not a second one: it reads the same rule rows
   * the derivation uses. A `log_group` accepts `/` in addition to the section 2
   * charset, but only for the two fixed shapes contract section 3 states: a
   * log-source name (which carries no `/` at all, because section 3 joins its
   * segments with `_`) or the Lambda service path `/aws/lambda/{function name}`,
   * whose function name satisfies the `lambda_function` row. Any other
   * `/`-bearing log group is refused (SANITY-AT-N3-08).
   *
   * The check is **structural**: it holds no context values, so it cannot tell
   * whether a log-source-shaped name is this naming context's own source. The
   * context completes that rule in `AppTheoryNamingContext.declareFixedName`,
   * which owns the bound `theorycloud_{namespace}_{app}_{stage}_` prefix
   * (SANITY-AT-N3-08, round 4).
   */
  public static validatePhysicalName(resourceType: string, name: string): void {
    const rule = namingRule(resourceType);
    if (rule === undefined) fail(UNKNOWN_NAMING_SCOPE);
    const charset = FIXED_NAME_CHARSETS.get(resourceType) ?? rule.charset;
    const quoted = JSON.stringify(name);
    if (name.length === 0 || !new RegExp(`^(?:${charset})+$`).test(name)) {
      fail(`a fixed ${resourceType} name must match ${charset} (contract section 2), got ${quoted}`);
    }
    if (name.length > rule.max) {
      fail(`a fixed ${resourceType} name must be at most ${rule.max} characters, got ${name.length}`);
    }
    if (rule.min !== undefined && name.length < rule.min) {
      fail(`a fixed ${resourceType} name must be at least ${rule.min} characters (contract section 2), got ${name.length}`);
    }
    if (rule.lead !== undefined && !name.startsWith(rule.lead)) {
      fail(`a fixed ${resourceType} name must start with ${JSON.stringify(rule.lead)} (contract section 2), got ${quoted}`);
    }
    if (S3_TYPES.has(resourceType) && !S3_EDGES_RE.test(name)) {
      fail(`a fixed ${resourceType} name must start and end with a letter or digit (contract section 2), got ${quoted}`);
    }
    if (resourceType === "secret" && SECRET_TAIL_RE.test(name)) {
      fail(`a fixed secret name must not end with a hyphen and six characters (contract section 2), got ${quoted}`);
    }
    if (resourceType === "ssm_parameter") {
      // A path name carries at least one non-empty segment after its lead `/`,
      // and no empty segment: `/` and `/a//b` name nothing AWS can create.
      if (!SSM_PATH_RE.test(name)) {
        fail(
          `a fixed ssm_parameter name must carry at least one non-empty segment after its lead "/" and no empty segment (contract section 2), got ${quoted}`,
        );
      }
      if ((name.match(/\//g)?.length ?? 0) > 15) {
        fail(`a fixed ssm_parameter name must have at most 15 levels (contract section 2), got ${quoted}`);
      }
      if (/^\/?(?:aws|ssm)(?:\/|$)/i.test(name)) {
        fail(`a fixed ssm_parameter name must not begin with aws or ssm (contract section 2), got ${quoted}`);
      }
    }
    if (resourceType === "kms_alias") {
      // `alias/` alone names no alias: the name after the lead is the alias.
      if (name.length <= KMS_ALIAS_LEAD.length) {
        fail(
          `a fixed kms_alias name must carry a non-empty name after its ${JSON.stringify(KMS_ALIAS_LEAD)} lead (contract section 2), got ${quoted}`,
        );
      }
      if (name.startsWith("alias/aws/")) {
        fail(`a fixed kms_alias name must not be in the alias/aws/ namespace (contract section 2), got ${quoted}`);
      }
    }
    if (resourceType === "log_group") {
      if (name.startsWith("aws/")) {
        fail(`a fixed log_group name must not begin with aws/ (contract section 3), got ${quoted}`);
      } else if (!isFixedLogGroupShape(name)) {
        fail(
          `a fixed log_group name must be either a section 3 log-source name (no "/") or the Lambda service path ${JSON.stringify(LAMBDA_LOG_GROUP_LEAD)} followed by a name that satisfies the lambda_function row (contract section 3), got ${quoted}`,
        );
      }
    }
  }

  /**
   * Refuse two different logical resources in one naming context that derive the
   * same name in the same naming scope, and return the derived-name artifact
   * (contract section 11.4). A Lambda function and its IAM role may share a name
   * because their scopes differ, and two APIs may share one because AWS does not
   * keep API names unique. Rows keep the order of the entries.
   *
   * `logicalId` is the resource's identity inside the naming context: its
   * CloudFormation logical id, or the owning stack's construct path plus that
   * logical id when the context spans several stacks. A CloudFormation logical id
   * is unique only inside one template, so a caller that owns more than one
   * template must pass the qualified form; otherwise two resources in different
   * stacks with the same local logical id look like one re-declared resource
   * (SANITY-AT-N3-05). The returned row echoes the identity it was given.
   */
  public static synthCheck(entries: AppTheoryDerivedNameInput[]): AppTheoryDerivedName[] {
    const seen = new Map<string, string>();
    const artifact: AppTheoryDerivedName[] = [];
    for (const entry of entries) {
      const scope = AppTheoryResourceNaming.namingScope(entry.type);
      const generated = entry.generated === true;
      artifact.push({
        ...(entry.name !== undefined && !generated ? { name: entry.name } : {}),
        type: entry.type,
        scope,
        logicalId: entry.logicalId,
        ...(generated ? { generated: true } : {}),
      });
      if (scope === AppTheoryNamingScope.NOT_UNIQUE || generated) continue;
      const key = `${scope}\u0000${entry.type}\u0000${entry.name ?? ""}`;
      const held = seen.get(key);
      if (held !== undefined && held !== entry.logicalId) {
        fail(`${held} and ${entry.logicalId} derive ${entry.name ?? ""} in scope ${scope}`);
      }
      seen.set(key, entry.logicalId);
    }
    return artifact;
  }

  /**
   * The derived-name artifact as the cloud-assembly metadata document, with the
   * contract's snake_case wire keys and a deterministic entry order.
   */
  public static derivedNamesJson(artifact: AppTheoryDerivedNames): string {
    const entries = [...artifact.entries]
      .map((entry) => ({
        ...(entry.name !== undefined && !entry.generated ? { name: entry.name } : {}),
        type: entry.type,
        scope: entry.scope,
        logical_id: entry.logicalId,
        ...(entry.generated ? { generated: true } : {}),
      }))
      .sort((a, b) => {
        const key = (row: typeof a): string =>
          [row.scope, row.type, row.name ?? "", row.logical_id].join("\u0000");
        const left = key(a);
        const right = key(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    return JSON.stringify({
      contract: artifact.contract,
      schema: artifact.schema,
      context: {
        namespace: artifact.context.namespace ?? LOG_PREFIX,
        app: artifact.context.app,
        stage: artifact.context.stage,
        account: artifact.context.account,
        region: artifact.context.region,
      },
      entries,
    });
  }

  /**
   * Validate one selector. Throws on a selector outside the grammar.
   */
  public static validateSelector(selector: string): void {
    const base = selector.endsWith("/*") ? selector.slice(0, -2) : selector;
    if (!LOGICAL_RE.test(base) || base.split("/")[0] !== "logs" || (base === "logs" && !selector.endsWith("/*"))) {
      fail(`selector ${selector}`);
    }
    if (base.includes("*")) fail("wildcard only as trailing /*");
  }

  /**
   * Whether a selector matches a logical source. A trailing `/*` matches
   * descendants only.
   */
  public static selectorMatches(selector: string, logical: string): boolean {
    if (selector.endsWith("/*")) return logical.startsWith(selector.slice(0, -1));
    return logical === selector;
  }

  /**
   * Whether a source is visible: an include matches and no exclude does.
   */
  public static sourceVisible(rules: AppTheoryVisibilityRules, logical: string): boolean {
    const included = (rules.include ?? []).some((selector) => AppTheoryResourceNaming.selectorMatches(selector, logical));
    if (!included) return false;
    return !(rules.exclude ?? []).some((selector) => AppTheoryResourceNaming.selectorMatches(selector, logical));
  }

  /**
   * The first 12 hex characters of SHA-256 over the canonical rules.
   */
  public static ruleVersion(rules: AppTheoryVisibilityRules): string {
    const canonical = `{"exclude":${JSON.stringify(sortedCopy(rules.exclude))},"include":${JSON.stringify(sortedCopy(rules.include))}}`;
    return sha256Hex(canonical).slice(0, 12);
  }

  /**
   * Compile the rules into the reader-role inline policy document. The return
   * value is the contract JSON, so a consumer can compare it byte for byte.
   */
  public static compileVisibilityPolicyJson(
    values: AppTheoryNamingContextValues,
    rules: AppTheoryVisibilityRules,
  ): string {
    for (const selector of [...(rules.include ?? []), ...(rules.exclude ?? [])]) {
      AppTheoryResourceNaming.validateSelector(selector);
    }
    const base = `arn:aws:logs:${values.region}:${values.account}:log-group:`;
    const arnsFor = (selector: string): string[] => {
      if (selector.endsWith("/*")) {
        return [base + logPrefix(values) + selector.slice(0, -1).replace(/\//g, "_") + "*"];
      }
      const name = logPrefix(values) + selector.replace(/\//g, "_");
      return [base + name, base + name + ":*"];
    };
    const actions = [...KEEPER_ACTIONS_GROUP, ...KEEPER_ACTIONS_STREAM];
    const statements: { Sid: string; Effect: string; Action: string[]; Resource: string[] }[] = [
      {
        Sid: "ReadManifest",
        Effect: "Allow",
        Action: ["ssm:GetParameter"],
        Resource: [
          `arn:aws:ssm:${values.region}:${values.account}:parameter/${LOG_PREFIX}/visibility/${values.app}/${values.stage}/manifest`,
        ],
      },
    ];
    const included = sortedCopy(rules.include).flatMap(arnsFor);
    const excluded = sortedCopy(rules.exclude).flatMap(arnsFor);
    if (included.length > 0) statements.push({ Sid: "ReadIncluded", Effect: "Allow", Action: actions, Resource: included });
    if (excluded.length > 0) statements.push({ Sid: "DenyExcluded", Effect: "Deny", Action: actions, Resource: excluded });
    const document = JSON.stringify({ Version: "2012-10-17", Statement: statements });
    if (document.length > ROLE_POLICY_MAX) fail("compiled policy over role policy size");
    return document;
  }

  /**
   * Assemble the synth-time visibility preview.
   */
  public static visibilityPreview(
    values: AppTheoryNamingContextValues,
    rules: AppTheoryVisibilityRules,
    sources: string[],
  ): AppTheoryVisibilityPreview {
    AppTheoryResourceNaming.validateContext(values);
    for (const selector of [...(rules.include ?? []), ...(rules.exclude ?? [])]) {
      AppTheoryResourceNaming.validateSelector(selector);
    }
    return {
      ruleVersion: AppTheoryResourceNaming.ruleVersion(rules),
      matchedNow: sources.filter((source) => AppTheoryResourceNaming.sourceVisible(rules, source)).sort(),
      notMatchedNow: sources.filter((source) => !AppTheoryResourceNaming.sourceVisible(rules, source)).sort(),
      future: { include: sortedCopy(rules.include), exclude: sortedCopy(rules.exclude) },
    };
  }

  /**
   * Assemble the published manifest (the preview minus `notMatchedNow`).
   */
  public static visibilityManifest(
    values: AppTheoryNamingContextValues,
    rules: AppTheoryVisibilityRules,
    sources: string[],
  ): AppTheoryVisibilityManifest {
    const preview = AppTheoryResourceNaming.visibilityPreview(values, rules, sources);
    return { ruleVersion: preview.ruleVersion, matchedNow: preview.matchedNow, future: preview.future };
  }

  /**
   * Serialize a manifest to the contract JSON shape written to SSM.
   */
  public static manifestJson(manifest: AppTheoryVisibilityManifest): string {
    return JSON.stringify({
      rule_version: manifest.ruleVersion,
      matched_now: manifest.matchedNow,
      future: { include: manifest.future.include ?? [], exclude: manifest.future.exclude ?? [] },
    });
  }

  /**
   * Keeper's read decision, in the runtimes' parameter order. Fails closed on a
   * denial or an unreachable account.
   */
  public static keeperDecision(
    rules: AppTheoryVisibilityRules,
    logical: string,
    awsResult: string,
  ): AppTheoryKeeperAnswer {
    if (!rules || !AppTheoryResourceNaming.sourceVisible(rules, logical)) {
      return AppTheoryKeeperAnswer.NOT_SHARED;
    }
    if (awsResult === "events") return AppTheoryKeeperAnswer.EVENTS;
    if (awsResult === "empty" || awsResult === "not_found") return AppTheoryKeeperAnswer.ALLOWED_NO_EVENTS;
    return AppTheoryKeeperAnswer.NOT_SHARED;
  }
}
