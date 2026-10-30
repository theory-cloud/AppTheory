import { BrokerExpiredError, BrokerFamilyExistsError, BrokerFamilyMismatchError, BrokerFamilyStateUnavailableError, BrokerLegacyLineageUnsupportedError, BrokerLockedError, BrokerNotFoundError, BrokerRevokedError, BrokerSuccessorExistsError, BrokerVersionConflictError, hashKey, } from "./store.js";
/**
 * Executes the transactional-family rows of the shared store conformance table.
 * The handlers are deliberately in their own module so the main switch stays
 * readable; every row uses only the public store methods a custom store must
 * implement.
 */
export async function runFamilyConformanceCase(stores, testCase, clock) {
    const params = testCase.params ?? {};
    const key = testCase.id;
    const family = transactionalFamilyStore(stores);
    switch (testCase.scenario) {
        case "family_create": {
            const familyHash = `${key}-family`;
            const created = await outcomeRecord(() => family.createFamily(familyRoot(familyHash)));
            const second = await familyOutcome(() => family.createFamily(familyRoot(familyHash)));
            const stored = await readRecord(stores, familyHash);
            return {
                create: created.outcome,
                root_version: created.record?.version ?? -1,
                root_generation: created.record?.chainGeneration ?? -1,
                root_family_is_self: created.record !== null &&
                    created.record.familyHash === created.record.handleHash,
                second_create: second,
                root_after_second_version: stored?.version ?? -1,
                root_get: stored === null ? "not_found" : "ok",
            };
        }
        case "family_create_binding": {
            const familyHash = `${key}-family`;
            const root = familyRoot(familyHash);
            root.chainGeneration = numberParam(params, "generation", 0);
            if (params["family_binding"] === "other") {
                root.familyHash = `${key}-other-family`;
            }
            const create = await familyOutcome(() => family.createFamily(root));
            const stored = await readRecord(stores, root.handleHash);
            return { create, root_get: stored === null ? "not_found" : "ok" };
        }
        case "family_rotate": {
            const familyHash = `${key}-family`;
            await family.createFamily(familyRoot(familyHash));
            const root = await requireRecord(stores, familyHash);
            const locked = await stores.routeRefreshBroker.acquireLock(root.handleHash, "conformance-owner", root.version);
            const successorKey = `${key}-successor`;
            const rotate = await familyOutcome(() => rotateFamily(family, locked, successorKey, familyHash));
            const successor = await readRecord(stores, successorKey);
            const presented = await readRecord(stores, root.handleHash);
            return {
                rotate,
                successor_get: successor === null ? "not_found" : "ok",
                successor_version: successor?.version ?? -1,
                successor_generation: successor?.chainGeneration ?? -1,
                successor_family_matches: successor?.familyHash === familyHash,
                presented_get: presented === null ? "not_found" : "ok",
                presented_version: presented?.version ?? -1,
                presented_status: presented?.status ?? "none",
                presented_grace_set: (presented?.encryptedGraceRefreshResponse ?? "") !== "" &&
                    presented?.graceExpiresAt !== undefined,
                presented_lock_cleared: !presented?.refreshLockOwner &&
                    presented?.refreshLockExpiresAt === undefined,
            };
        }
        case "family_rotate_wrong_owner": {
            const familyHash = `${key}-family`;
            const locked = await createAndLock(stores, family, familyHash);
            const rotate = await familyOutcome(() => rotateFamily(family, locked, `${key}-successor`, familyHash, {
                lockOwner: "another-owner",
            }));
            const presented = await readRecord(stores, locked.handleHash);
            const successor = await readRecord(stores, `${key}-successor`);
            return {
                rotate,
                successor_get: successor === null ? "not_found" : "ok",
                presented_version: presented?.version ?? -1,
                presented_status: presented?.status ?? "none",
            };
        }
        case "family_rotate_stale_version": {
            const familyHash = `${key}-family`;
            const locked = await createAndLock(stores, family, familyHash);
            const rotate = await familyOutcome(() => rotateFamily(family, locked, `${key}-successor`, familyHash, {
                expectedVersion: locked.version - 1,
            }));
            const successor = await readRecord(stores, `${key}-successor`);
            return { rotate, successor_get: successor === null ? "not_found" : "ok" };
        }
        case "family_rotate_existing_successor": {
            const familyHash = `${key}-family`;
            const locked = await createAndLock(stores, family, familyHash);
            const successorKey = `${key}-successor`;
            await seedFamilyMember(stores, successorKey, familyHash, (locked.chainGeneration ?? 0) + 1);
            const rotate = await familyOutcome(() => rotateFamily(family, locked, successorKey, familyHash));
            const presented = await readRecord(stores, locked.handleHash);
            const successor = await readRecord(stores, successorKey);
            return {
                rotate,
                successor_status_after: successor?.status ?? "none",
                successor_version_after: successor?.version ?? -1,
                presented_status_after: presented?.status ?? "none",
                presented_version_after: presented?.version ?? -1,
            };
        }
        case "family_rotate_generation_mismatch":
        case "family_rotate_family_mismatch": {
            const familyHash = `${key}-family`;
            const locked = await createAndLock(stores, family, familyHash);
            const successorKey = `${key}-successor`;
            const generation = testCase.scenario === "family_rotate_generation_mismatch"
                ? (locked.chainGeneration ?? 0) + 2
                : (locked.chainGeneration ?? 0) + 1;
            const successorFamily = testCase.scenario === "family_rotate_family_mismatch"
                ? `${key}-other-family`
                : familyHash;
            const rotate = await familyOutcome(() => rotateFamily(family, locked, successorKey, successorFamily, {
                generation,
            }));
            const successor = await readRecord(stores, successorKey);
            return { rotate, successor_get: successor === null ? "not_found" : "ok" };
        }
        case "family_rotate_legacy": {
            const legacyKey = `${key}-legacy`;
            await seedBrokerRecord(stores, legacyRecord(legacyKey));
            const legacy = await requireRecord(stores, legacyKey);
            const locked = await stores.routeRefreshBroker.acquireLock(legacyKey, "conformance-owner", legacy.version);
            const rotate = await familyOutcome(() => family.rotateFamily({
                presentedHandleHash: legacyKey,
                lockOwner: "conformance-owner",
                expectedVersion: locked.version,
                successor: familyMember(locked, `${key}-successor`, "", 2),
                graceRefreshResponse: `{"refresh_token":"${key}-successor"}`,
                graceExpiresAt: new Date(clock.now().getTime() + 60_000),
            }));
            const presented = await readRecord(stores, legacyKey);
            const successor = await readRecord(stores, `${key}-successor`);
            return {
                rotate,
                successor_get: successor === null ? "not_found" : "ok",
                presented_version: presented?.version ?? -1,
                presented_status: presented?.status ?? "none",
            };
        }
        case "family_missing_state": {
            const familyHash = `${key}-family`;
            const memberKey = `${key}-member`;
            await seedFamilyMember(stores, memberKey, familyHash, 1);
            const get = await familyOutcome(async () => {
                await stores.routeRefreshBroker.get(memberKey);
            });
            const lock = await familyOutcome(() => stores.routeRefreshBroker.acquireLock(memberKey, "conformance-owner", 1));
            const rotate = await familyOutcome(() => family.rotateFamily({
                presentedHandleHash: memberKey,
                lockOwner: "conformance-owner",
                expectedVersion: 1,
                successor: familyMember(familyRoot(familyHash), `${key}-successor`, familyHash, 2),
                graceRefreshResponse: `{"refresh_token":"${key}-successor"}`,
                graceExpiresAt: new Date(clock.now().getTime() + 60_000),
            }));
            const revoke = await familyOutcome(() => family.revokeFamily(familyHash));
            const listed = await family.listFamily(familyHash);
            const successor = await readRecord(stores, `${key}-successor`);
            return {
                get,
                lock,
                rotate,
                revoke,
                list: "ok",
                listed: listed.length,
                record_status: "none",
                successor_get: successor === null ? "not_found" : "ok",
            };
        }
        case "family_mixed_lineage": {
            const familyHash = `${key}-family`;
            await family.createFamily(familyRoot(familyHash));
            const root = await requireRecord(stores, familyHash);
            const locked = await stores.routeRefreshBroker.acquireLock(root.handleHash, "conformance-owner", root.version);
            const successorKey = `${key}-successor`;
            const successor = await rotateFamily(family, locked, successorKey, familyHash);
            const legacyKey = `${key}-legacy`;
            const legacy = legacyRecord(legacyKey);
            legacy.encryptedGraceRefreshResponse = `{"refresh_token":"${successorKey}"}`;
            await seedBrokerRecord(stores, legacy);
            const storedLegacy = await requireRecord(stores, legacyKey);
            const legacyLock = await familyOutcome(() => stores.routeRefreshBroker.acquireLock(legacyKey, "conformance-owner", storedLegacy.version));
            const legacyRotate = await familyOutcome(() => family.rotateFamily({
                presentedHandleHash: legacyKey,
                lockOwner: "conformance-owner",
                expectedVersion: storedLegacy.version + 1,
                successor: familyMember(storedLegacy, `${key}-legacy-successor`, successor.familyHash ?? familyHash, 2),
                graceRefreshResponse: `{"refresh_token":"${key}-legacy-successor"}`,
                graceExpiresAt: new Date(clock.now().getTime() + 60_000),
            }));
            const listed = await family.listFamily(familyHash);
            return {
                legacy_lock: legacyLock,
                legacy_rotate: legacyRotate,
                list: "ok",
                listed: listed.length,
                legacy_listed: listed.some((record) => record.handleHash === legacyKey),
                successor_get: "ok",
                successor_generation: successor.chainGeneration ?? -1,
            };
        }
        case "family_tombstone_every_member": {
            const familyHash = `${key}-family`;
            await family.createFamily(familyRoot(familyHash));
            let current = await requireRecord(stores, familyHash);
            const rotations = numberParam(params, "rotations", 1);
            for (let index = 0; index < rotations; index += 1) {
                const locked = await stores.routeRefreshBroker.acquireLock(current.handleHash, `owner-${index}`, current.version);
                current = await family.rotateFamily({
                    presentedHandleHash: locked.handleHash,
                    lockOwner: `owner-${index}`,
                    expectedVersion: locked.version,
                    successor: familyMember(locked, `${key}-successor-${index}`, familyHash, (locked.chainGeneration ?? 0) + 1),
                    graceRefreshResponse: `{"refresh_token":"${key}-successor-${index}"}`,
                    graceExpiresAt: new Date(clock.now().getTime() + 60_000),
                });
            }
            const revoked = await family.revokeFamily(familyHash);
            const listed = await family.listFamily(familyHash);
            const headGet = await familyOutcome(async () => {
                await stores.routeRefreshBroker.get(current.handleHash);
            });
            const headLock = await familyOutcome(() => stores.routeRefreshBroker.acquireLock(current.handleHash, "late-owner", -1));
            const headRotate = await familyOutcome(() => family.rotateFamily({
                presentedHandleHash: current.handleHash,
                lockOwner: "late-owner",
                expectedVersion: -1,
                successor: familyMember(current, `${key}-late-successor`, familyHash, (current.chainGeneration ?? 0) + 1),
                graceRefreshResponse: `{"refresh_token":"${key}-late-successor"}`,
                graceExpiresAt: new Date(clock.now().getTime() + 60_000),
            }));
            const lateGet = await readRecord(stores, `${key}-late-successor`);
            const createAgain = await familyOutcome(() => family.createFamily(familyRoot(familyHash)));
            const revokedAgain = await family.revokeFamily(familyHash);
            return {
                revoke: "ok",
                revoked: revoked.length,
                list: "ok",
                listed: listed.length,
                all_listed_revoked: listed.every((record) => record.status === "revoked"),
                head_get: headGet,
                head_lock: headLock,
                head_rotate: headRotate,
                late_successor_get: lateGet === null ? "not_found" : "ok",
                create_again: createAgain,
                revoke_again: "ok",
                revoke_again_count: revokedAgain.length,
            };
        }
        case "family_tombstone_beyond_batch": {
            const familyHash = `${key}-family`;
            await family.createFamily(familyRoot(familyHash));
            const members = numberParam(params, "members", 1);
            for (let index = 0; index < members; index += 1) {
                await seedFamilyMember(stores, `${key}-member-${index}`, familyHash, index + 2);
            }
            const revoked = await family.revokeFamily(familyHash);
            const listed = await family.listFamily(familyHash);
            const firstGet = await familyOutcome(async () => {
                await stores.routeRefreshBroker.get(`${key}-member-0`);
            });
            const lastGet = await familyOutcome(async () => {
                await stores.routeRefreshBroker.get(`${key}-member-${members - 1}`);
            });
            const createAgain = await familyOutcome(() => family.createFamily(familyRoot(familyHash)));
            return {
                revoke: "ok",
                revoked: revoked.length,
                list: "ok",
                listed: listed.length,
                all_listed_revoked: listed.every((record) => record.status === "revoked"),
                first_get: firstGet,
                last_get: lastGet,
                create_again: createAgain,
            };
        }
        case "family_revocation_first": {
            const familyHash = `${key}-family`;
            const locked = await createAndLock(stores, family, familyHash);
            const revoked = await family.revokeFamily(familyHash);
            const rotate = await familyOutcome(() => rotateFamily(family, locked, `${key}-successor`, familyHash, {
                expectedVersion: locked.version,
            }));
            const presentedGet = await familyOutcome(async () => {
                await stores.routeRefreshBroker.get(locked.handleHash);
            });
            const successor = await readRecord(stores, `${key}-successor`);
            const lockAgain = await familyOutcome(() => stores.routeRefreshBroker.acquireLock(locked.handleHash, "late-owner", -1));
            const revokeAgain = await familyOutcome(() => family.revokeFamily(familyHash));
            return {
                revoke: "ok",
                revoked: revoked.length,
                rotate,
                presented_get: presentedGet,
                successor_get: successor === null ? "not_found" : "ok",
                lock_again: lockAgain,
                revoke_again: revokeAgain,
            };
        }
        case "family_rotation_first": {
            const familyHash = `${key}-family`;
            const locked = await createAndLock(stores, family, familyHash);
            const successor = await rotateFamily(family, locked, `${key}-successor`, familyHash);
            const revoked = await family.revokeFamily(familyHash);
            const successorGet = await familyOutcome(async () => {
                await stores.routeRefreshBroker.get(successor.handleHash);
            });
            const successorLock = await familyOutcome(() => stores.routeRefreshBroker.acquireLock(successor.handleHash, "late-owner", -1));
            const successorRotate = await familyOutcome(() => family.rotateFamily({
                presentedHandleHash: successor.handleHash,
                lockOwner: "late-owner",
                expectedVersion: -1,
                successor: familyMember(successor, `${key}-late-successor`, familyHash, (successor.chainGeneration ?? 0) + 1),
                graceRefreshResponse: `{"refresh_token":"${key}-late-successor"}`,
                graceExpiresAt: new Date(clock.now().getTime() + 60_000),
            }));
            const lateGet = await readRecord(stores, `${key}-late-successor`);
            return {
                revoke: "ok",
                revoked: revoked.length,
                successor_get: successorGet,
                successor_lock: successorLock,
                successor_rotate: successorRotate,
                late_successor_get: lateGet === null ? "not_found" : "ok",
            };
        }
        case "family_tombstone_survives_expiry": {
            const familyHash = `${key}-family`;
            await family.createFamily(familyRoot(familyHash));
            await family.revokeFamily(familyHash);
            clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
            const get = await familyOutcome(async () => {
                await stores.routeRefreshBroker.get(familyHash);
            });
            const listed = await family.listFamily(familyHash);
            const createAgain = await familyOutcome(() => family.createFamily(familyRoot(familyHash)));
            const revokedAgain = await family.revokeFamily(familyHash);
            return {
                list: "ok",
                listed: listed.length,
                get,
                create_again: createAgain,
                revoke_again: "ok",
                revoke_again_count: revokedAgain.length,
            };
        }
        default:
            throw new Error(`unknown family scenario ${testCase.scenario}`);
    }
}
function transactionalFamilyStore(stores) {
    const broker = stores.routeRefreshBroker;
    if (typeof broker.createFamily !== "function" ||
        typeof broker.rotateFamily !== "function" ||
        typeof broker.listFamily !== "function" ||
        typeof broker.revokeFamily !== "function") {
        throw new Error("store conformance: broker lacks the transactional family capability");
    }
    return broker;
}
function familyRoot(familyHash) {
    return {
        handleHash: familyHash,
        issuer: "https://auth.example.test",
        stage: "lab",
        canonicalResource: "https://mcp.example.test/mcp",
        clientNamespace: "conformance",
        endpointKind: "namespace",
        partnerId: "",
        agentId: "",
        clientIdHash: "client-hash",
        subjectIdHash: "subject-hash",
        scopes: ["mcp:tools"],
        scopeFingerprint: "scope-fingerprint",
        encryptedUpstreamRefreshToken: "",
        upstreamRefreshTokenHash: hashKey("upstream-refresh-root"),
        upstreamClientId: "upstream-client",
        status: "issued",
        version: 0,
        chainGeneration: 1,
        familyHash,
    };
}
function familyMember(presented, handleHash, familyHash, generation) {
    const member = {
        ...structuredClone(presented),
        handleHash,
        familyHash,
        chainGeneration: generation,
        status: "issued",
        version: 0,
        encryptedUpstreamRefreshToken: "upstream-refresh-successor",
        upstreamRefreshTokenHash: hashKey("upstream-refresh-successor"),
    };
    delete member.refreshLockOwner;
    delete member.refreshLockExpiresAt;
    return member;
}
function legacyRecord(handleHash) {
    return {
        handleHash,
        issuer: "https://auth.example.test",
        stage: "lab",
        canonicalResource: "https://mcp.example.test/mcp",
        clientNamespace: "",
        endpointKind: "",
        partnerId: "",
        agentId: "",
        clientIdHash: "",
        subjectIdHash: "",
        scopes: [],
        scopeFingerprint: "",
        encryptedUpstreamRefreshToken: "",
        upstreamRefreshTokenHash: "",
        upstreamClientId: "",
        status: "active",
        version: 0,
        chainGeneration: 0,
        familyHash: "",
    };
}
async function seedBrokerRecord(stores, record) {
    const seeder = stores.routeRefreshBroker;
    if (typeof seeder.put !== "function") {
        throw new Error("store conformance: broker store is not seedable");
    }
    await seeder.put(record);
}
async function seedFamilyMember(stores, handleHash, familyHash, generation) {
    const record = familyRoot(familyHash);
    record.handleHash = handleHash;
    record.chainGeneration = generation;
    record.status = "issued";
    await seedBrokerRecord(stores, record);
}
async function readRecord(stores, handleHash) {
    try {
        return await stores.routeRefreshBroker.get(handleHash);
    }
    catch {
        return null;
    }
}
async function requireRecord(stores, handleHash) {
    const record = await stores.routeRefreshBroker.get(handleHash);
    if (record === null)
        throw new Error(`missing broker record ${handleHash}`);
    return record;
}
async function createAndLock(stores, family, familyHash) {
    await family.createFamily(familyRoot(familyHash));
    const root = await requireRecord(stores, familyHash);
    return stores.routeRefreshBroker.acquireLock(root.handleHash, "conformance-owner", root.version);
}
async function rotateFamily(family, locked, successorKey, familyHash, options = {}) {
    const rotation = {
        presentedHandleHash: locked.handleHash,
        lockOwner: options.lockOwner ?? "conformance-owner",
        expectedVersion: options.expectedVersion ?? locked.version,
        successor: familyMember(locked, successorKey, familyHash, options.generation ?? (locked.chainGeneration ?? 0) + 1),
        graceRefreshResponse: `{"refresh_token":"${successorKey}"}`,
        graceExpiresAt: new Date(Date.now() + 60_000),
    };
    return family.rotateFamily(rotation);
}
async function familyOutcome(operation) {
    try {
        await operation();
        return "ok";
    }
    catch (err) {
        if (err instanceof BrokerFamilyExistsError)
            return "family_exists";
        if (err instanceof BrokerFamilyStateUnavailableError)
            return "family_state_unavailable";
        if (err instanceof BrokerFamilyMismatchError)
            return "family_mismatch";
        if (err instanceof BrokerSuccessorExistsError)
            return "successor_exists";
        if (err instanceof BrokerLegacyLineageUnsupportedError)
            return "legacy_lineage_unsupported";
        if (err instanceof BrokerRevokedError)
            return "revoked";
        if (err instanceof BrokerLockedError)
            return "locked";
        if (err instanceof BrokerVersionConflictError)
            return "version_conflict";
        if (err instanceof BrokerNotFoundError)
            return "not_found";
        if (err instanceof BrokerExpiredError)
            return "expired";
        throw err;
    }
}
async function outcomeRecord(operation) {
    try {
        return { outcome: "ok", record: await operation() };
    }
    catch {
        return { outcome: "error", record: null };
    }
}
function numberParam(params, name, fallback) {
    const value = params[name];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
//# sourceMappingURL=family-conformance.js.map