import { safeError } from "./errors.js";
import {
  MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  MICROVM_SESSION_REGISTRY_MODEL_NAME,
  MicroVMSafeError,
  type MicroVMClock,
  type MicroVMSessionKey,
  type MicroVMSessionListInput,
  type MicroVMSessionRecord,
  type MicroVMSessionReconstructionHook,
  type MicroVMSessionReconstructionRequest,
  type MicroVMSessionRegistry,
  type MicroVMSessionRegistryRecord,
  type MicroVMTableTheoryClient,
  type ReconstructingMicroVMSessionRegistryOptions,
  type TableTheoryMicroVMSessionRegistryOptions,
} from "./model.js";
import {
  asMicroVMSessionRegistryError,
  cloneMicroVMSessionRegistryRecord,
  microVMSessionRecordIsStale,
  microVMSessionRecordToRegistryRecord,
  microVMSessionRegistryModel,
  microVMSessionRegistryPartitionKey,
  microVMSessionRegistryRecordKey,
  microVMSessionRegistryRecordKeyFromKey,
  microVMSessionRegistrySortKey,
  microVMSessionRegistryTableName,
  microVMSessionFromRegistryRecord,
  normalizeMicroVMSessionKey,
  normalizeMicroVMSessionRecord,
  normalizeMicroVMSessionReconstructionRequest,
  normalizeMicroVMSessionRegistryRecord,
  registryRecordFromTableItem,
  registryRecordToTableItem,
  validateMicroVMSessionKey,
  validateMicroVMSessionRecord,
} from "./session.js";
import { cloneMicroVMDate, validDate } from "./time.js";

// legacySessionRegistryPartitionKey reconstructs the pre-M1 partition key
// "TENANT#<tenant>#NAMESPACE#<namespace>" that an earlier release persisted; both identities are
// trimmed and an empty identity yields "", matching the pre-M1 implementation. It exists only so a
// read can fall back to an item written by an earlier release — the write path never produces it.
function legacySessionRegistryPartitionKey(
  tenantID: string,
  namespace: string,
): string {
  const tenant = String(tenantID ?? "").trim();
  const ns = String(namespace ?? "").trim();
  return tenant && ns ? `TENANT#${tenant}#NAMESPACE#${ns}` : "";
}

// legacyRegistryRecordKey frames a pk/sk pair exactly as microVMSessionRegistryRecordKey does, so a
// legacy-key lookup addresses the same entry the write path would have stored.
function legacyRegistryRecordKey(pk: string, sk: string): string {
  return microVMSessionRegistryRecordKey({
    pk,
    sk,
  } as MicroVMSessionRegistryRecord);
}

// sessionFromRegistryRecordForRead converts a durable item for a read path. When allowLegacyKey is
// set it accepts the pre-M1 partition key carried by an item written by an earlier release and
// validates the item under the canonical key; an item whose key matches neither derivation is still
// rejected.
function sessionFromRegistryRecordForRead(
  record: MicroVMSessionRegistryRecord,
  allowLegacyKey: boolean,
): MicroVMSessionRecord {
  const normalized = normalizeMicroVMSessionRegistryRecord(record);
  if (
    allowLegacyKey &&
    normalized.pk ===
      legacySessionRegistryPartitionKey(
        normalized.tenant_id,
        normalized.namespace,
      )
  ) {
    return microVMSessionFromRegistryRecord({
      ...normalized,
      pk: microVMSessionRegistryPartitionKey(
        normalized.tenant_id,
        normalized.namespace,
      ),
    });
  }
  return microVMSessionFromRegistryRecord(normalized);
}

export class MemoryMicroVMSessionRegistry implements MicroVMSessionRegistry {
  private readonly records = new Map<string, MicroVMSessionRegistryRecord>();

  async put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord> {
    const registry = microVMSessionRecordToRegistryRecord(record);
    this.records.set(
      microVMSessionRegistryRecordKey(registry),
      cloneMicroVMSessionRegistryRecord(registry),
    );
    return microVMSessionFromRegistryRecord(registry);
  }

  async get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    let record = this.records.get(
      microVMSessionRegistryRecordKeyFromKey(normalized),
    );
    if (!record) {
      record = this.legacyRecord(normalized);
      if (record) {
        // The in-memory store has no TTL, so move the legacy entry rather than copy it, which keeps
        // a later list from returning the same session twice.
        const migrated = microVMSessionRecordToRegistryRecord(
          sessionFromRegistryRecordForRead(
            cloneMicroVMSessionRegistryRecord(record),
            true,
          ),
        );
        this.records.set(
          microVMSessionRegistryRecordKey(migrated),
          cloneMicroVMSessionRegistryRecord(migrated),
        );
        this.records.delete(
          legacyRegistryRecordKey(
            legacySessionRegistryPartitionKey(
              normalized.tenant_id,
              normalized.namespace,
            ),
            microVMSessionRegistrySortKey(normalized.session_id),
          ),
        );
        return microVMSessionFromRegistryRecord(migrated);
      }
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session registry record not found",
        "",
      );
    }
    return microVMSessionFromRegistryRecord(
      cloneMicroVMSessionRegistryRecord(record),
    );
  }

  // legacyRecord looks up the pre-M1 entry for a key, requiring it to be exactly the requested
  // identity so a colliding pre-M1 partition key cannot return another tenant's item.
  private legacyRecord(
    normalized: MicroVMSessionKey,
  ): MicroVMSessionRegistryRecord | undefined {
    const legacyPK = legacySessionRegistryPartitionKey(
      normalized.tenant_id,
      normalized.namespace,
    );
    if (
      !legacyPK ||
      legacyPK ===
        microVMSessionRegistryPartitionKey(
          normalized.tenant_id,
          normalized.namespace,
        )
    ) {
      return undefined;
    }
    const record = this.records.get(
      legacyRegistryRecordKey(
        legacyPK,
        microVMSessionRegistrySortKey(normalized.session_id),
      ),
    );
    if (
      record &&
      (record.tenant_id !== normalized.tenant_id ||
        record.namespace !== normalized.namespace ||
        record.session_id !== normalized.session_id)
    ) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session registry tenant/session key mismatch",
        "",
      );
    }
    return record;
  }

  async delete(key: MicroVMSessionKey): Promise<void> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    this.records.delete(microVMSessionRegistryRecordKeyFromKey(normalized));
    // Also drop the pre-M1 entry so a deleted session cannot be resurrected by the dual-read fallback.
    const legacyPK = legacySessionRegistryPartitionKey(
      normalized.tenant_id,
      normalized.namespace,
    );
    if (
      legacyPK &&
      legacyPK !==
        microVMSessionRegistryPartitionKey(
          normalized.tenant_id,
          normalized.namespace,
        )
    ) {
      this.records.delete(
        legacyRegistryRecordKey(
          legacyPK,
          microVMSessionRegistrySortKey(normalized.session_id),
        ),
      );
    }
  }

  async list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]> {
    const tenant = String(input?.tenant_id ?? "").trim();
    const namespace = String(input?.namespace ?? "").trim();
    if (!tenant || !namespace) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session list is incomplete",
        String(input?.request_id ?? "").trim(),
      );
    }
    const canonicalPK = microVMSessionRegistryPartitionKey(tenant, namespace);
    const out: MicroVMSessionRecord[] = [];
    const seen = new Set<string>();
    for (const record of this.records.values()) {
      if (
        record.tenant_id !== tenant ||
        record.namespace !== namespace ||
        record.pk !== canonicalPK
      ) {
        continue;
      }
      const session = microVMSessionFromRegistryRecord(
        cloneMicroVMSessionRegistryRecord(record),
      );
      seen.add(session.session_id);
      out.push(session);
    }
    for (const record of this.records.values()) {
      if (
        record.tenant_id !== tenant ||
        record.namespace !== namespace ||
        record.pk === canonicalPK
      ) {
        continue;
      }
      if (seen.has(record.session_id)) continue;
      const session = sessionFromRegistryRecordForRead(
        cloneMicroVMSessionRegistryRecord(record),
        true,
      );
      seen.add(session.session_id);
      out.push(session);
    }
    out.sort((a, b) => a.session_id.localeCompare(b.session_id));
    return out;
  }
}

export function createMemoryMicroVMSessionRegistry(): MemoryMicroVMSessionRegistry {
  return new MemoryMicroVMSessionRegistry();
}

export async function reconstructMicroVMSessionRecord(
  request: MicroVMSessionReconstructionRequest,
  hook?: MicroVMSessionReconstructionHook | null,
): Promise<MicroVMSessionRecord> {
  const normalized = normalizeMicroVMSessionReconstructionRequest(request);
  validateMicroVMSessionKey(normalized);
  if (!hook) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm registry reconstruction requires a product hook",
      normalized.request_id ?? "",
    );
  }
  let record: MicroVMSessionRecord;
  try {
    record = await hook(normalized);
  } catch {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm registry reconstruction hook failed",
      normalized.request_id ?? "",
    );
  }
  const reconstructed = normalizeMicroVMSessionRecord(record);
  if (
    reconstructed.tenant_id !== normalized.tenant_id ||
    reconstructed.namespace !== normalized.namespace ||
    reconstructed.session_id !== normalized.session_id
  ) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm registry reconstruction tenant/session mismatch",
      normalized.request_id ?? "",
    );
  }
  validateMicroVMSessionRecord(reconstructed);
  const now = cloneMicroVMDate(normalized.now ?? new Date(Number.NaN));
  if (validDate(now) && reconstructed.expires_at.valueOf() <= now.valueOf()) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm registry reconstruction returned stale state",
      normalized.request_id ?? "",
    );
  }
  return reconstructed;
}

export class ReconstructingMicroVMSessionRegistry implements MicroVMSessionRegistry {
  private readonly registry: MicroVMSessionRegistry;
  private readonly hook: MicroVMSessionReconstructionHook;
  private readonly staleAfterMs: number;
  private readonly clock: MicroVMClock;

  constructor(
    registry: MicroVMSessionRegistry,
    hook: MicroVMSessionReconstructionHook,
    options: ReconstructingMicroVMSessionRegistryOptions = {},
  ) {
    if (!registry) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm registry reconstruction requires a session registry",
        "",
      );
    }
    if (!hook) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm registry reconstruction requires a product hook",
        "",
      );
    }
    this.registry = registry;
    this.hook = hook;
    const staleAfterMs = Math.trunc(Number(options.stale_after_ms) || 0);
    this.staleAfterMs = staleAfterMs > 0 ? staleAfterMs : 0;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord> {
    return await this.registry.put(record);
  }

  async get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    const now = this.clock.now();
    let existing: MicroVMSessionRecord | undefined;
    try {
      const record = await this.registry.get(normalized);
      if (!microVMSessionRecordIsStale(record, now, this.staleAfterMs)) {
        return record;
      }
      existing = record;
    } catch {
      existing = undefined;
    }
    const request: MicroVMSessionReconstructionRequest = {
      tenant_id: normalized.tenant_id,
      namespace: normalized.namespace,
      session_id: normalized.session_id,
      now,
    };
    if (existing) request.existing = existing;
    const reconstructed = await reconstructMicroVMSessionRecord(
      request,
      this.hook,
    );
    return await this.registry.put(reconstructed);
  }

  async delete(key: MicroVMSessionKey): Promise<void> {
    await this.registry.delete(key);
  }

  async list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]> {
    if (typeof this.registry.list !== "function") {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm registry reconstruction requires tenant-bound list support",
        String(input?.request_id ?? "").trim(),
      );
    }
    return await this.registry.list(input);
  }
}

export function createReconstructingMicroVMSessionRegistry(
  registry: MicroVMSessionRegistry,
  hook: MicroVMSessionReconstructionHook,
  options: ReconstructingMicroVMSessionRegistryOptions = {},
): ReconstructingMicroVMSessionRegistry {
  return new ReconstructingMicroVMSessionRegistry(registry, hook, options);
}

export class TableTheoryMicroVMSessionRegistry implements MicroVMSessionRegistry {
  private readonly db: MicroVMTableTheoryClient;
  private readonly modelName: string;

  constructor(
    db: MicroVMTableTheoryClient,
    options: TableTheoryMicroVMSessionRegistryOptions = {},
  ) {
    if (!db) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session registry requires TableTheory client",
        "",
      );
    }
    this.db = db;
    this.modelName =
      String(options.model_name ?? "").trim() ||
      MICROVM_SESSION_REGISTRY_MODEL_NAME;
    if (options.auto_register !== false && this.db.register) {
      this.db.register(
        microVMSessionRegistryModel(
          String(options.table_name ?? "").trim() ||
            microVMSessionRegistryTableName(),
        ),
      );
    }
  }

  async put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord> {
    const registry = microVMSessionRecordToRegistryRecord(record);
    try {
      await this.db.save(this.modelName, registryRecordToTableItem(registry));
      return microVMSessionFromRegistryRecord(registry);
    } catch (err) {
      throw asMicroVMSessionRegistryError(err, registry.last_command_id);
    }
  }

  async get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    const canonicalPK = microVMSessionRegistryPartitionKey(
      normalized.tenant_id,
      normalized.namespace,
    );
    const sk = microVMSessionRegistrySortKey(normalized.session_id);
    try {
      let item: Record<string, unknown> | undefined;
      try {
        item = await this.db.get(this.modelName, { pk: canonicalPK, sk });
      } catch {
        // The client does not distinguish a miss from an error, so treat a failed canonical read as a
        // candidate miss and let the legacy fallback (or the error below) decide.
        item = undefined;
      }
      if (item) {
        return microVMSessionFromRegistryRecord(
          registryRecordFromTableItem(item),
        );
      }
      const legacyPK = legacySessionRegistryPartitionKey(
        normalized.tenant_id,
        normalized.namespace,
      );
      if (!legacyPK || legacyPK === canonicalPK) {
        throw safeError(
          MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
          "apptheory: microvm session registry record not found",
          "",
        );
      }
      const legacyItem = await this.db.get(this.modelName, {
        pk: legacyPK,
        sk,
      });
      if (!legacyItem) {
        throw safeError(
          MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
          "apptheory: microvm session registry record not found",
          "",
        );
      }
      const legacyRecord = registryRecordFromTableItem(legacyItem);
      // A colliding pre-M1 key can address more than one identity; require the item to be exactly
      // the one requested before accepting it.
      if (
        legacyRecord.tenant_id !== normalized.tenant_id ||
        legacyRecord.namespace !== normalized.namespace ||
        legacyRecord.session_id !== normalized.session_id
      ) {
        throw safeError(
          MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
          "apptheory: microvm session registry tenant/session key mismatch",
          "",
        );
      }
      const session = sessionFromRegistryRecordForRead(legacyRecord, true);
      try {
        // Lazy re-write: migrate the item on touch. Best-effort, because the read already succeeded.
        await this.db.save(
          this.modelName,
          registryRecordToTableItem(
            microVMSessionRecordToRegistryRecord(session),
          ),
        );
      } catch {
        // Ignore: the legacy item keeps resolving until its TTL retires it.
      }
      return session;
    } catch (err) {
      throw asMicroVMSessionRegistryError(err, "");
    }
  }

  async delete(key: MicroVMSessionKey): Promise<void> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    try {
      await this.db.delete(this.modelName, {
        pk: microVMSessionRegistryPartitionKey(
          normalized.tenant_id,
          normalized.namespace,
        ),
        sk: microVMSessionRegistrySortKey(normalized.session_id),
      });
      // Also drop the pre-M1 item so a deleted session cannot be resurrected by the dual-read fallback.
      const legacyPK = legacySessionRegistryPartitionKey(
        normalized.tenant_id,
        normalized.namespace,
      );
      if (
        legacyPK &&
        legacyPK !==
          microVMSessionRegistryPartitionKey(
            normalized.tenant_id,
            normalized.namespace,
          )
      ) {
        await this.db.delete(this.modelName, {
          pk: legacyPK,
          sk: microVMSessionRegistrySortKey(normalized.session_id),
        });
      }
    } catch (err) {
      throw asMicroVMSessionRegistryError(err, "");
    }
  }

  async list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]> {
    const tenant = String(input?.tenant_id ?? "").trim();
    const namespace = String(input?.namespace ?? "").trim();
    if (!tenant || !namespace) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session list is incomplete",
        String(input?.request_id ?? "").trim(),
      );
    }
    if (typeof this.db.list !== "function") {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session registry requires tenant-bound list support",
        String(input?.request_id ?? "").trim(),
      );
    }
    const canonicalPK = microVMSessionRegistryPartitionKey(tenant, namespace);
    try {
      const items = await this.db.list(this.modelName, { pk: canonicalPK });
      const out: MicroVMSessionRecord[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const session = microVMSessionFromRegistryRecord(
          registryRecordFromTableItem(item),
        );
        seen.add(session.session_id);
        out.push(session);
      }
      // Union in the pre-M1 partition so un-migrated items stay listable; the canonical item wins.
      const legacyPK = legacySessionRegistryPartitionKey(tenant, namespace);
      if (legacyPK && legacyPK !== canonicalPK) {
        const legacyItems = await this.db.list(this.modelName, {
          pk: legacyPK,
        });
        for (const item of legacyItems) {
          const record = registryRecordFromTableItem(item);
          if (
            record.tenant_id !== tenant ||
            record.namespace !== namespace ||
            seen.has(record.session_id)
          ) {
            continue;
          }
          const session = sessionFromRegistryRecordForRead(record, true);
          seen.add(session.session_id);
          out.push(session);
        }
      }
      out.sort((a, b) => a.session_id.localeCompare(b.session_id));
      return out;
    } catch (err) {
      if (err instanceof MicroVMSafeError) throw err;
      throw asMicroVMSessionRegistryError(err, String(input?.request_id ?? ""));
    }
  }
}

export function createTableTheoryMicroVMSessionRegistry(
  db: MicroVMTableTheoryClient,
  options: TableTheoryMicroVMSessionRegistryOptions = {},
): TableTheoryMicroVMSessionRegistry {
  return new TableTheoryMicroVMSessionRegistry(db, options);
}
