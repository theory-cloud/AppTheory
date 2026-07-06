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
import { safeError } from "./errors.js";
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
  registryRecordFromTableItem,
  registryRecordToTableItem,
  validateMicroVMSessionKey,
  validateMicroVMSessionRecord,
} from "./session.js";
import { cloneMicroVMDate, validDate } from "./time.js";

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
    const record = this.records.get(
      microVMSessionRegistryRecordKeyFromKey(normalized),
    );
    if (!record) {
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

  async delete(key: MicroVMSessionKey): Promise<void> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    this.records.delete(microVMSessionRegistryRecordKeyFromKey(normalized));
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
    const out: MicroVMSessionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.tenant_id !== tenant || record.namespace !== namespace) {
        continue;
      }
      out.push(
        microVMSessionFromRegistryRecord(
          cloneMicroVMSessionRegistryRecord(record),
        ),
      );
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
    try {
      const item = await this.db.get(this.modelName, {
        pk: microVMSessionRegistryPartitionKey(
          normalized.tenant_id,
          normalized.namespace,
        ),
        sk: microVMSessionRegistrySortKey(normalized.session_id),
      });
      return microVMSessionFromRegistryRecord(
        registryRecordFromTableItem(item),
      );
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
    try {
      const items = await this.db.list(this.modelName, {
        pk: microVMSessionRegistryPartitionKey(tenant, namespace),
      });
      return items
        .map((item) =>
          microVMSessionFromRegistryRecord(registryRecordFromTableItem(item)),
        )
        .sort((a, b) => a.session_id.localeCompare(b.session_id));
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
