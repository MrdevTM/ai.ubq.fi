/**
 * Resumable bootstrap accounting for capture-owned storage.
 *
 * The sweep counts every in-scope row itself, so while it is pending no other
 * writer may also count a row, or the same row is charged twice; every counter
 * mutation is gated behind `bootstrapBeforeMutation`. It counts scanned entries
 * rather than only valid records: an invalid or unreadable in-scope row marks
 * accounting incomplete so new admissions stay refused instead of trusting a
 * zero. Legacy reservation rows are read only to release their charge once.
 */
import {
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_REQUEST_PREFIX,
} from "./replay-model.ts";
import { isSentinelReplayCaptureStatusRow } from "./replay-observation.ts";
import { isSentinelReplayManifest } from "./replay-read.ts";
import {
  accountingKeyMatches,
  BOOTSTRAP_BATCH_ENTRIES,
  commitAccountingMutation,
  counter,
  deleteChunkBatch,
  EVICTION_MAX_CHUNK_DELETES,
  fault,
  isAccountingRow,
  isLegacyReservation,
  manifestKeyMatches,
  readLedger,
  SENTINEL_REPLAY_ACCOUNTING_PREFIX,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_RESERVATION_PREFIX,
  sentinelReplayAccountingKey,
  sentinelReplayManifestCharge,
  sentinelReplayPayloadBudgetBytes,
  sentinelReplayStatusMetadataBytes,
  type SentinelReplayBudgetLedger,
  type SentinelReplayLegacyReservation,
  withBudget,
} from "./replay-retention-schema.ts";

/** Legacy reservation release: read once, delete chunks, then delete the row. */
export const releaseLegacyReservation = async (
  kv: Deno.Kv,
  key: Deno.KvKey,
  reservation: SentinelReplayLegacyReservation,
  budgetBytes: number
): Promise<void> => {
  if (reservation.state === "published") {
    await kv.delete(key);
    return;
  }
  const cleanup = await deleteChunkBatch(kv, reservation.capture_id, EVICTION_MAX_CHUNK_DELETES);
  if (cleanup.remaining > 0) return;
  const entry = await kv.get<SentinelReplayLegacyReservation>(key);
  if (!isLegacyReservation(entry.value)) return;
  await commitAccountingMutation(
    kv,
    key,
    entry.versionstamp,
    (ledger) => ({ ...ledger, reserved_bytes: Math.max(0, ledger.reserved_bytes - reservation.bytes) }),
    (operation) => operation.delete(key),
    budgetBytes
  );
};

/**
 * Prefixes in capture-owned key order. Built lazily: replay-store.ts imports the
 * retention modules, so a top-level array here would read model or store
 * bindings before that module body has initialized them. The order is
 * significant — "accounting" sorts before "manifest", so the accounting sweep is
 * always complete before a manifest is checked for an existing accounting row.
 */
const bootstrapPrefixes = (): readonly Deno.KvKey[] => [
  SENTINEL_REPLAY_ACCOUNTING_PREFIX,
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_REQUEST_PREFIX,
  SENTINEL_REPLAY_RESERVATION_PREFIX,
];

type BootstrapDelta = Readonly<{
  stored_bytes: number;
  reserved_bytes: number;
  records: number;
  status_records: number;
  metadata_bytes: number;
  invalid: boolean;
  legacy_reaped: number;
}>;

const emptyDelta = (): BootstrapDelta => ({
  stored_bytes: 0,
  reserved_bytes: 0,
  records: 0,
  status_records: 0,
  metadata_bytes: 0,
  invalid: false,
  legacy_reaped: 0,
});

const addDelta = (delta: BootstrapDelta, patch: Partial<BootstrapDelta>): BootstrapDelta => ({
  stored_bytes: delta.stored_bytes + (patch.stored_bytes ?? 0),
  reserved_bytes: delta.reserved_bytes + (patch.reserved_bytes ?? 0),
  records: delta.records + (patch.records ?? 0),
  status_records: delta.status_records + (patch.status_records ?? 0),
  metadata_bytes: delta.metadata_bytes + (patch.metadata_bytes ?? 0),
  invalid: delta.invalid || Boolean(patch.invalid),
  legacy_reaped: delta.legacy_reaped + (patch.legacy_reaped ?? 0),
});

const parseCursor = (cursor: string | null): Readonly<{ index: number; inner: string | null }> => {
  if (cursor === null) return { index: 0, inner: null };
  const separator = cursor.indexOf("|");
  if (separator < 0) return { index: 0, inner: null };
  const index = Number.parseInt(cursor.slice(0, separator), 10);
  return { index: Number.isSafeInteger(index) && index >= 0 ? index : 0, inner: cursor.slice(separator + 1) || null };
};

/** Accounting rows own the durable charge, so the sweep counts them directly. */
const bootstrapAccountingDelta = (key: Deno.KvKey, value: unknown, delta: BootstrapDelta): BootstrapDelta => {
  if (!isAccountingRow(value) || !accountingKeyMatches(key, value)) return addDelta(delta, { invalid: true });
  if (value.state === "stored" || value.state === "evicting") return addDelta(delta, { stored_bytes: value.bytes, records: 1 });
  return addDelta(delta, { reserved_bytes: value.bytes });
};

/** A manifest without its own accounting row is a pre-accounting capture, charged conservatively. */
const bootstrapManifestDelta = async (kv: Deno.Kv, key: Deno.KvKey, value: unknown, delta: BootstrapDelta): Promise<BootstrapDelta> => {
  if (!isSentinelReplayManifest(value) || !manifestKeyMatches(key, value)) return addDelta(delta, { invalid: true });
  const accounting = await kv.get(sentinelReplayAccountingKey(value.captured_at_ms, value.capture_id));
  if (isAccountingRow(accounting.value)) return delta;
  return addDelta(delta, { stored_bytes: sentinelReplayManifestCharge(value), records: 1 });
};

/** Request status rows are capture-owned metadata and consume the metadata reserve. */
const bootstrapStatusDelta = (value: unknown, delta: BootstrapDelta): BootstrapDelta => {
  if (!isSentinelReplayCaptureStatusRow(value)) return addDelta(delta, { invalid: true });
  return addDelta(delta, { status_records: 1, metadata_bytes: sentinelReplayStatusMetadataBytes(value) });
};

/** Eviction and expiry tombstones are capture-owned metadata too. */
const bootstrapTombstoneDelta = (value: unknown, delta: BootstrapDelta): BootstrapDelta => {
  const tombstone = value as { fingerprint?: unknown; reason?: unknown } | null;
  if (typeof tombstone !== "object" || tombstone === null || typeof tombstone.fingerprint !== "string" || typeof tombstone.reason !== "string") {
    return addDelta(delta, { invalid: true });
  }
  return addDelta(delta, { status_records: 1, metadata_bytes: sentinelReplayStatusMetadataBytes(tombstone) });
};

/** Legacy reservation rows are read only to release their own charge once. */
const bootstrapLegacyDelta = async (kv: Deno.Kv, key: Deno.KvKey, value: unknown, delta: BootstrapDelta, budgetBytes: number): Promise<BootstrapDelta> => {
  if (!isLegacyReservation(value)) return addDelta(delta, { invalid: true });
  await releaseLegacyReservation(kv, key, value, budgetBytes);
  return addDelta(delta, { legacy_reaped: 1 });
};

/** Chunk rows carry no independent charge, but a malformed key must fail closed. */
const bootstrapChunkDelta = (key: Deno.KvKey, delta: BootstrapDelta): BootstrapDelta => {
  if (key.length !== SENTINEL_REPLAY_CHUNK_PREFIX.length + 2 || typeof key[4] !== "string" || !counter(key[5])) return addDelta(delta, { invalid: true });
  return delta;
};

/** A dedupe row must reference a well-formed manifest key. */
const bootstrapDedupeDelta = (value: unknown, delta: BootstrapDelta): BootstrapDelta => {
  const dedupe = value as { manifest_key?: unknown } | null;
  if (typeof dedupe !== "object" || dedupe === null || !Array.isArray(dedupe.manifest_key) || dedupe.manifest_key.length !== 7) {
    return addDelta(delta, { invalid: true });
  }
  return delta;
};

/**
 * Fold one scanned in-scope row into the running bootstrap delta. Rows that do
 * not match their own prefix's contract are counted as invalid rather than
 * trusted or deleted on a guess, which keeps discovery fail-closed.
 */
const bootstrapEntryDelta = async (
  kv: Deno.Kv,
  prefix: Deno.KvKey,
  entry: Deno.KvEntry<unknown>,
  delta: BootstrapDelta,
  budgetBytes: number
): Promise<BootstrapDelta> => {
  if (prefix === SENTINEL_REPLAY_ACCOUNTING_PREFIX) return bootstrapAccountingDelta(entry.key, entry.value, delta);
  if (prefix === SENTINEL_REPLAY_MANIFEST_PREFIX) return await bootstrapManifestDelta(kv, entry.key, entry.value, delta);
  if (prefix === SENTINEL_REPLAY_REQUEST_PREFIX) return bootstrapStatusDelta(entry.value, delta);
  if (prefix === SENTINEL_REPLAY_EVICTION_PREFIX) return bootstrapTombstoneDelta(entry.value, delta);
  if (prefix === SENTINEL_REPLAY_RESERVATION_PREFIX) return await bootstrapLegacyDelta(kv, entry.key, entry.value, delta, budgetBytes);
  if (prefix === SENTINEL_REPLAY_CHUNK_PREFIX) return bootstrapChunkDelta(entry.key, delta);
  return bootstrapDedupeDelta(entry.value, delta);
};

/** Outcome of sweeping one bootstrap prefix within the remaining entry budget. */
type BootstrapSweep = Readonly<{ delta: BootstrapDelta; scanned: number; cursor: string | null; exhausted: boolean }>;

/**
 * Sweep one prefix up to `budget` entries. `exhausted` means the sweep consumed
 * its whole budget mid-prefix, so the caller must resume from `cursor` at the
 * same prefix instead of advancing.
 */
const sweepBootstrapPrefix = async (
  kv: Deno.Kv,
  prefix: Deno.KvKey,
  cursor: string | null,
  budget: number,
  delta: BootstrapDelta,
  budgetBytes: number
): Promise<BootstrapSweep> => {
  const iterator = kv.list({ prefix }, { cursor: cursor ?? undefined, limit: budget });
  let scanned = 0;
  for await (const entry of iterator) {
    scanned += 1;
    delta = await bootstrapEntryDelta(kv, prefix, entry, delta, budgetBytes);
    if (scanned >= budget) return { delta, scanned, cursor: iterator.cursor, exhausted: true };
  }
  return { delta, scanned, cursor: null, exhausted: false };
};

/**
 * One bounded, resumable bootstrap sweep across EVERY capture-owned prefix that
 * holds retained bytes or metadata. It counts scanned entries, not just valid
 * records: an invalid or unreadable in-scope row marks accounting incomplete so
 * new admissions stay refused instead of trusting a zero.
 */
export const runBootstrapBatch = async (
  kv: Deno.Kv,
  ledger: SentinelReplayBudgetLedger,
  versionstamp: string | null,
  budgetBytes: number,
  nowMs: number
): Promise<SentinelReplayBudgetLedger> => {
  let { index, inner } = parseCursor(ledger.bootstrap_cursor);
  const prefixes = bootstrapPrefixes();
  // A fresh sweep clears the sticky error so a removed corrupt row can resolve it.
  let error = ledger.bootstrap_cursor === null ? null : ledger.accounting_error;
  let delta = emptyDelta();
  let scanned = 0;
  while (index < prefixes.length && scanned < BOOTSTRAP_BATCH_ENTRIES) {
    const sweep = await sweepBootstrapPrefix(kv, prefixes[index], inner, BOOTSTRAP_BATCH_ENTRIES - scanned, delta, budgetBytes);
    delta = sweep.delta;
    scanned += sweep.scanned;
    if (sweep.exhausted) {
      // Keep this prefix and its cursor: the next pass resumes exactly here.
      inner = sweep.cursor;
      break;
    }
    index += 1;
    inner = null;
  }
  const complete = index >= prefixes.length;
  if (delta.invalid) error = "invalid_in_scope_row";
  const next: SentinelReplayBudgetLedger = {
    ...ledger,
    budget_bytes: budgetBytes,
    stored_bytes: ledger.stored_bytes + delta.stored_bytes,
    reserved_bytes: ledger.reserved_bytes + delta.reserved_bytes,
    records: ledger.records + delta.records,
    status_records: ledger.status_records + delta.status_records,
    metadata_bytes: ledger.metadata_bytes + delta.metadata_bytes,
    bootstrap_complete: complete && error === null,
    bootstrap_cursor: complete ? null : `${index}|${inner ?? ""}`,
    accounting_error: error,
    over_budget: ledger.stored_bytes + delta.stored_bytes > sentinelReplayPayloadBudgetBytes(budgetBytes),
    last_warning_at_ms: ledger.stored_bytes + delta.stored_bytes > sentinelReplayPayloadBudgetBytes(budgetBytes) ? nowMs : ledger.last_warning_at_ms,
  };
  fault("commit");
  const committed = await kv.atomic().check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp }).set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, next).commit();
  if (committed.ok) return next;
  const reread = await readLedger(kv, budgetBytes);
  if (reread.kind === "corrupt") return ledger;
  return withBudget(reread.ledger, budgetBytes);
};

/**
 * Ensure the resumable sweep has finished before any counter mutation. The sweep
 * counts every in-scope row itself, so while it is pending no other writer may
 * also count a row, or the same row is charged twice. Returns the fresh ledger
 * when accounting is authoritative, and null when the ledger is corrupt or the
 * sweep is still incomplete, in which case no counter may move.
 */
export const bootstrapBeforeMutation = async (kv: Deno.Kv, budgetBytes: number, nowMs: number): Promise<SentinelReplayBudgetLedger | null> => {
  const state = await readLedger(kv, budgetBytes);
  if (state.kind === "corrupt") return null;
  const ledger = withBudget(state.ledger, budgetBytes);
  if (ledger.bootstrap_complete) return ledger;
  const bootstrapped = await runBootstrapBatch(kv, ledger, state.versionstamp, budgetBytes, nowMs);
  return bootstrapped.bootstrap_complete ? bootstrapped : null;
};
