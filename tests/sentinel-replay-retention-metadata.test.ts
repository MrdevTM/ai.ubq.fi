/** Native KV metadata expiry/reconciliation fixtures; synthetic rows only, no providers or credentials. */
import assert from "node:assert/strict";
import { SENTINEL_REPLAY_MAX_STATUS_RECORDS } from "../src/sentinel/replay-limits.ts";
import { SENTINEL_REPLAY_REQUEST_PREFIX, type SentinelReplayCaptureStatusRow } from "../src/sentinel/replay-model.ts";
import { reconcileSentinelReplayStatusMetadata } from "../src/sentinel/replay-retention-metadata.ts";
import { admitSentinelReplayStatusMetadata, runSentinelReplayRetentionMaintenance } from "../src/sentinel/replay-retention.ts";
import {
  readSentinelReplayLedgerSnapshot,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_EXPIRED_REASON,
  sentinelReplayMetadataReserve,
  sentinelReplayRequestStatusKey,
  sentinelReplayStatusMetadataBytes,
} from "../src/sentinel/replay-retention-schema.ts";

const kvAvailable = typeof Deno.openKv === "function";
const NOW = 1_702_000_000_000;
const BUDGET_BYTES = 1 * 1_024 * 1_024;

const statusRow = (requestId: string): SentinelReplayCaptureStatusRow => ({
  version: 1,
  request_id: requestId,
  status: "disabled",
  reason: "metadata_fixture",
  captured_at_ms: NOW,
  manifest_key: null,
  fingerprint: null,
  expires_at_ms: null,
});

const tombstoneRow = (index: number) => ({
  version: 1,
  fingerprint: index.toString(16).padStart(64, "0"),
  request_id: `metadata-tombstone-${index}`,
  evicted_at_ms: NOW,
  reason: SENTINEL_REPLAY_EXPIRED_REASON,
});

const ledgerOf = async (kv: Deno.Kv, budgetBytes = BUDGET_BYTES) => {
  const snapshot = await readSentinelReplayLedgerSnapshot(kv, budgetBytes);
  assert.ok(snapshot);
  return snapshot;
};

const admitStatus = (kv: Deno.Kv, requestId: string, ttlMs = 60_000) =>
  admitSentinelReplayStatusMetadata(kv, {
    key: sentinelReplayRequestStatusKey(requestId),
    row: statusRow(requestId),
    now_ms: NOW,
    ttl_ms: ttlMs,
    budget_bytes: BUDGET_BYTES,
  });

/** KV expiry is earliest-after-TTL; observe native absence with a finite deadline rather than advancing a fake clock. */
const waitForExpiry = async (kv: Deno.Kv, keys: Deno.KvKey[]): Promise<void> => {
  // Deno 2.9.7 pins denokv_sqlite 0.14.0: its empty-DB collector fallback is 60s
  // plus 0..1s jitter, and later writes do not reschedule that deadline.
  const started = Date.now();
  const deadline = started + 90_000;
  while (Date.now() < deadline) {
    const entries = await kv.getMany(keys);
    if (entries.every((entry) => entry.value === null)) {
      console.info(JSON.stringify({ fixture: "native_metadata_ttl_absent", elapsed_ms: Date.now() - started, rows: keys.length }));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("native metadata TTL did not disappear within the fixture deadline");
};

const expiringMetadata = async (kv: Deno.Kv): Promise<Deno.KvKey[]> => {
  const keys: Deno.KvKey[] = [];
  for (let index = 0; index < 6; index += 1) {
    const requestId = `ttl-status-${index}`;
    assert.equal(await admitStatus(kv, requestId, 500), true);
    const key = sentinelReplayRequestStatusKey(requestId);
    assert.notEqual((await kv.get(key)).value, null, "positive baseline: native KV really retained the TTL row");
    keys.push(key);
  }
  const row = tombstoneRow(1);
  const key = [...SENTINEL_REPLAY_EVICTION_PREFIX, row.fingerprint];
  assert.equal(await admitSentinelReplayStatusMetadata(kv, { key, row, now_ms: NOW, ttl_ms: 500, budget_bytes: BUDGET_BYTES }), true);
  assert.notEqual((await kv.get(key)).value, null);
  keys.push(key);
  const before = await ledgerOf(kv);
  assert.equal(before.ledger.status_records, 7);
  assert.equal(before.ledger.metadata_bytes + sentinelReplayStatusMetadataBytes(statusRow("ttl-after")) > sentinelReplayMetadataReserve(BUDGET_BYTES), true);
  return keys;
};

const liveMetadata = async (kv: Deno.Kv): Promise<Readonly<{ records: number; bytes: number }>> => {
  let records = 0;
  let bytes = 0;
  for (const prefix of [SENTINEL_REPLAY_REQUEST_PREFIX, SENTINEL_REPLAY_EVICTION_PREFIX]) {
    for await (const entry of kv.list({ prefix })) {
      records += 1;
      bytes += sentinelReplayStatusMetadataBytes(entry.value);
    }
  }
  return { records, bytes };
};

const verifyMaintenanceExpiry = async (kv: Deno.Kv): Promise<void> => {
  await waitForExpiry(kv, await expiringMetadata(kv));
  assert.equal((await ledgerOf(kv)).ledger.status_records, 7, "native TTL deletion leaves the old ledger charge until reconciliation");
  const maintained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + 1, budget_bytes: BUDGET_BYTES });
  assert.equal(maintained.status_records, 0);
  assert.equal(maintained.metadata_bytes, 0);
  assert.equal((await ledgerOf(kv)).ledger.status_pruned_records, 0);
  assert.equal(await admitStatus(kv, "ttl-after"), true);
  assert.equal((await ledgerOf(kv)).ledger.status_records, 1);
};

const verifyAdmissionExpiry = async (kv: Deno.Kv): Promise<void> => {
  await waitForExpiry(kv, await expiringMetadata(kv));
  assert.equal(await admitStatus(kv, "ttl-after"), true);
  const after = await ledgerOf(kv);
  assert.equal(after.ledger.status_records, 1);
  assert.equal(after.ledger.metadata_bytes, sentinelReplayStatusMetadataBytes(statusRow("ttl-after")));
  assert.equal(after.ledger.status_pruned_records, 0);
};

const verifyCompleteScan = async (kv: Deno.Kv): Promise<void> => {
  const budgetBytes = 64 * 1_024 * 1_024;
  for (let index = 0; index < 129; index += 1) {
    const status = statusRow(`complete-status-${index}`);
    const tombstone = tombstoneRow(index + 1);
    await kv.set(sentinelReplayRequestStatusKey(status.request_id), status);
    await kv.set([...SENTINEL_REPLAY_EVICTION_PREFIX, tombstone.fingerprint], tombstone);
  }
  let maintained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW, budget_bytes: budgetBytes });
  for (let pass = 0; pass < 20 && !maintained.accounting_complete; pass += 1) {
    maintained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW, budget_bytes: budgetBytes });
  }
  assert.equal(maintained.accounting_complete, true);
  const transient = statusRow("complete-expiring");
  const transientKey = sentinelReplayRequestStatusKey(transient.request_id);
  assert.equal(await admitSentinelReplayStatusMetadata(kv, { key: transientKey, row: transient, now_ms: NOW, ttl_ms: 500, budget_bytes: budgetBytes }), true);
  await waitForExpiry(kv, [transientKey]);
  const expected = await liveMetadata(kv);
  assert.equal(expected.records, 258);
  const after = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + 1, budget_bytes: budgetBytes });
  assert.equal(after.status_records, expected.records);
  assert.equal(after.metadata_bytes, expected.bytes);
  assert.equal((await ledgerOf(kv, budgetBytes)).ledger.status_pruned_records, 0);
};

Deno.test({
  name: "native TTL disappearance restores maintenance admission and complete metadata accounting",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // The three independent collectors start together, so genuine native TTL
    // acceptance costs one bounded fallback interval rather than three in series.
    const stores = await Promise.all([Deno.openKv(":memory:"), Deno.openKv(":memory:"), Deno.openKv(":memory:")]);
    try {
      const outcomes = await Promise.allSettled([verifyMaintenanceExpiry(stores[0]), verifyAdmissionExpiry(stores[1]), verifyCompleteScan(stores[2])]);
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
        .map((outcome) => outcome.reason as unknown);
      if (failures.length > 0) throw new AggregateError(failures, "native metadata TTL controls failed");
    } finally {
      for (const kv of stores) kv.close();
    }
  },
});

type CommitObservation = { before: () => Promise<void>; after: (result: Deno.KvCommitResult | Deno.KvCommitError) => void };

const observedAtomic = (operation: Deno.AtomicOperation, observation: CommitObservation): Deno.AtomicOperation =>
  new Proxy(operation, {
    get(target, property) {
      if (property === "commit") {
        return async () => {
          await observation.before();
          const result = await target.commit();
          observation.after(result);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => observedAtomic(Reflect.apply(value, target, args) as Deno.AtomicOperation, observation);
    },
  });

const observeCommits = (kv: Deno.Kv, observation: CommitObservation): Deno.Kv =>
  new Proxy(kv, {
    get(target, property) {
      if (property === "atomic") return () => observedAtomic(target.atomic(), observation);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

Deno.test({
  name: "a concurrent native status admission invalidates the whole metadata recount CAS",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    const outcomes: boolean[] = [];
    const wrapped = observeCommits(kv, {
      before: async () => {
        assert.equal(await admitStatus(kv, "added-during-recount"), true);
      },
      after: (result) => {
        outcomes.push(result.ok);
      },
    });
    try {
      assert.equal(await admitStatus(kv, "before-recount"), true);
      assert.equal(await reconcileSentinelReplayStatusMetadata(wrapped, BUDGET_BYTES), false);
      assert.deepEqual(outcomes, [false], "the real native ledger version check rejects the stale scanned totals");
      const expected = await liveMetadata(kv);
      const after = await ledgerOf(kv);
      assert.equal(expected.records, 2);
      assert.equal(after.ledger.status_records, expected.records);
      assert.equal(after.ledger.metadata_bytes, expected.bytes);
      assert.equal(await reconcileSentinelReplayStatusMetadata(kv, BUDGET_BYTES), true);
    } finally {
      kv.close();
    }
  },
});

const withList = (kv: Deno.Kv, list: (selector: Deno.KvListSelector, options?: Deno.KvListOptions) => AsyncIterable<Deno.KvEntry<unknown>>): Deno.Kv =>
  new Proxy(kv, {
    get(target, property) {
      if (property === "list") return list;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

async function* interruptedList(kv: Deno.Kv, selector: Deno.KvListSelector, options?: Deno.KvListOptions) {
  for await (const entry of kv.list(selector, options)) {
    yield entry;
    throw new Error("metadata_fixture_list_failure");
  }
}

async function* overLimitRows(limit: number) {
  for (let index = 0; index < limit; index += 1) {
    const row = statusRow(`scan-bound-${index}`);
    yield await Promise.resolve({ key: sentinelReplayRequestStatusKey(row.request_id), value: row, versionstamp: "fixture" });
  }
}

Deno.test({
  name: "corruption partial-list failure and an over-limit scan never lower metadata counters",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    try {
      assert.equal(await admitStatus(kv, "preserved-row"), true);
      const before = await ledgerOf(kv);
      const corruptKey = sentinelReplayRequestStatusKey("wrong-key-owner");
      await kv.set(corruptKey, statusRow("different-owner"));
      assert.equal(await reconcileSentinelReplayStatusMetadata(kv, BUDGET_BYTES), false);
      assert.deepEqual(await ledgerOf(kv), before);
      await kv.delete(corruptKey);

      const failed = withList(kv, (selector, options) => interruptedList(kv, selector, options));
      assert.equal(await reconcileSentinelReplayStatusMetadata(failed, BUDGET_BYTES), false);
      assert.deepEqual(await ledgerOf(kv), before);

      const requested: Deno.KvListOptions[] = [];
      const overLimit = withList(kv, (_selector, options) => {
        requested.push(options ?? {});
        return overLimitRows(Math.min(options?.limit ?? 0, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 1));
      });
      assert.equal(await reconcileSentinelReplayStatusMetadata(overLimit, BUDGET_BYTES), false);
      assert.deepEqual(await ledgerOf(kv), before);
      assert.equal(requested[0].consistency, "strong");
      assert.equal(requested[0].limit, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 1);
    } finally {
      kv.close();
    }
  },
});
