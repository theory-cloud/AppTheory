import { createHash } from "node:crypto";

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

const SEGMENT_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";
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
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

interface Rule {
  readonly kind: "dash" | "path" | "s3ar" | "log";
  readonly max: number;
  readonly charset: string;
  readonly lead?: string;
}

const RULES: { [type: string]: Rule } = {
  s3_bucket: { kind: "s3ar", max: 63, charset: "[a-z0-9-]" },
  s3_vector_bucket: { kind: "dash", max: 63, charset: "[a-z0-9-]" },
  s3_vector_index: { kind: "dash", max: 63, charset: "[a-z0-9-]" },
  dynamodb_table: { kind: "dash", max: 255, charset: "[A-Za-z0-9_.-]" },
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
    if (!NAMESPACE_RE.test(namespaceOf(values))) fail("namespace");
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
    if (pin !== undefined) return { name: pin, pinned: true };
    if (keepGenerated) return { generated: true };
    if (legacy) {
      fail(`legacy naming profile requires a pin or a generated entry for ${key}`);
    }

    let out: AppTheoryPhysicalName;
    if (rule.kind === "s3ar") {
      const suffix = AppTheoryResourceNaming.s3AccountRegionalSuffix(values);
      const budget = rule.max - suffix.length;
      const prefix = shorten(`${values.app}-${values.stage}-${logical.replace(/\//g, "-")}`, budget);
      out = { name: prefix + suffix, bucketNamePrefix: prefix, bucketNamespace: "account-regional" };
    } else if (rule.kind === "dash") {
      out = { name: shorten(`${values.app}-${values.stage}-${logical.replace(/\//g, "-")}`, rule.max) };
    } else if (rule.kind === "path") {
      const full = `${rule.lead ?? ""}${values.app}/${values.stage}/${logical}`;
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
   * Refuse two different logical resources in one naming context that derive the
   * same name in the same naming scope, and return the derived-name artifact
   * (contract section 11.4). A Lambda function and its IAM role may share a name
   * because their scopes differ, and two APIs may share one because AWS does not
   * keep API names unique. Rows keep the order of the entries.
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
