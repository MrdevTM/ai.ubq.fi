/** Reconstruct TTL-bound metadata counters only from a complete, unchanged-ledger scan. */
import { HEX_DIGEST, SENTINEL_REPLAY_REQUEST_PREFIX } from "./replay-model.ts";
import { SENTINEL_REPLAY_MAX_STATUS_RECORDS } from "./replay-limits.ts";
import { isSentinelReplayCaptureStatusRow, isSentinelReplayRequestId } from "./replay-observation.ts";
import {
  counter,
  readLedger,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_EVICTION_REASON,
  SENTINEL_REPLAY_EXPIRED_REASON,
  sentinelReplayStatusMetadataBytes,
  withBudget,
} from "./replay-retention-schema.ts";

type MetadataTotals = Readonly<{ records: number; bytes: number }>;

const isTombstone = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    typeof row.fingerprint === "string" &&
    HEX_DIGEST.test(row.fingerprint) &&
    (row.request_id === "" || isSentinelReplayRequestId(row.request_id)) &&
    counter(row.evicted_at_ms) &&
    (row.reason === SENTINEL_REPLAY_EVICTION_REASON || row.reason === SENTINEL_REPLAY_EXPIRED_REASON)
  );
};

const metadataEntryMatches = (entry: Deno.KvEntry<unknown>, prefix: Deno.KvKey): boolean => {
  if (entry.key.length !== prefix.length + 1 || !prefix.every((part, index) => entry.key[index] === part)) return false;
  if (prefix === SENTINEL_REPLAY_REQUEST_PREFIX) {
    return isSentinelReplayCaptureStatusRow(entry.value) && entry.key[prefix.length] === entry.value.request_id;
  }
  return isTombstone(entry.value) && entry.key[prefix.length] === entry.value.fingerprint;
};

const scanMetadata = async (kv: Deno.Kv): Promise<MetadataTotals | null> => {
  let records = 0;
  let bytes = 0;
  for (const prefix of [SENTINEL_REPLAY_REQUEST_PREFIX, SENTINEL_REPLAY_EVICTION_PREFIX]) {
    // One extra entry proves truncation. Both iterators must genuinely exhaust,
    // and the combined row budget remains bounded even for legacy over-cap data.
    const limit = SENTINEL_REPLAY_MAX_STATUS_RECORDS + 1 - records;
    for await (const entry of kv.list({ prefix }, { consistency: "strong", limit, batchSize: 128 })) {
      if (records >= SENTINEL_REPLAY_MAX_STATUS_RECORDS || !metadataEntryMatches(entry, prefix)) return null;
      records += 1;
      bytes += sentinelReplayStatusMetadataBytes(entry.value);
    }
  }
  return { records, bytes };
};

/**
 * Deliberate metadata mutations change the ledger with their rows, so its version
 * must be captured BEFORE listing and checked AFTER both complete prefix scans.
 * Native TTL deletion can only make this count conservatively high; a later pass
 * removes that residual charge. A partial/corrupt scan or CAS loss changes nothing.
 */
export const reconcileSentinelReplayStatusMetadata = async (kv: Deno.Kv, budgetBytes: number): Promise<boolean> => {
  try {
    const state = await readLedger(kv, budgetBytes);
    if (state.kind !== "ok" || !state.ledger.bootstrap_complete || state.ledger.accounting_error !== null) return false;
    const totals = await scanMetadata(kv);
    if (totals === null) return false;
    const ledger = withBudget(state.ledger, budgetBytes);
    const committed = await kv
      .atomic()
      .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: state.versionstamp })
      .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, { ...ledger, status_records: totals.records, metadata_bytes: totals.bytes })
      .commit();
    return committed.ok;
  } catch {
    return false;
  }
};
