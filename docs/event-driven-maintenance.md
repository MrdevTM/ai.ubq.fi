# Event-driven maintenance

No cron, interval, or timer runs in this service. Every piece of recurring maintenance is attached to the event that
makes it necessary, and `deno.json` does not enable the `cron` unstable feature, so `Deno.cron` is not available to
call. This document is the mapping from each retired job to the event that replaced it.

| Retired job                       | Used to run                 | Now triggered by                                                                                                                                       | Where                                                                                                                             |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Reconcile pending metered billing | every minute                | A paid-fallback request reaching a terminal state (completed, failed, incomplete, cancelled, ambiguous)                                                | `recordMeteredTerminal` / `recordMeteredAmbiguous` in `src/paid_fallback.ts` call `reconcileDuePaidFallbacksV3()` fire-and-forget |
| Reconcile pending metered billing | every minute                | An operator reading a key's paid-fallback ledger                                                                                                       | `handleAdminApiKeysPaidFallbacks` in `src/admin.ts`                                                                               |
| Sample Codex provider capacity    | every 15 minutes            | A capacity observation: quota exhaustion (429), an upstream outage, an unreachable upstream, a verified banked reset, or a successfully served request | `triggerProviderCapacitySample()` calls in `src/codex.ts`                                                                         |
| Sample Codex provider capacity    | every 15 minutes            | A normal admin capacity read older than 30 s, which revalidates through the shared lease and persists; `?refresh=live` still forces an immediate probe | `refreshProviderCapacity()` in `src/provider/capacity.ts`                                                                         |
| Prune prompt cache analytics      | hourly at :07               | The first analytics write of a new bucket                                                                                                              | `recordPromptCacheAnalytics()` in `src/prompt_cache_analytics.ts`                                                                 |
| Sample Mac provider capacity      | every 15 minutes on the Mac | The same capacity observations, because the Mac runs the same Codex path                                                                               | `src/codex.ts`                                                                                                                    |

## What the design guarantees

- **Nothing runs because time passed.** With no traffic and no operator, no work happens. That is deliberate: the
  gateway should not spend provider probes, KV writes, or log reads on an idle system.
- **Durable state waits, it does not leak.** Pending reconciliation markers, capacity snapshots, and retained analytics
  rows are all stored durably. Their next event settles, samples, or prunes them; none of them expires or is lost
  because a job did not run.
- **Debounce is a bucket for event sampling, and a shared lease for read revalidation.** Event-driven capacity sampling
  keeps one probe per fifteen-minute history bucket (`PROVIDER_CAPACITY_HISTORY_BUCKET_MS`), and analytics pruning keeps
  one scan per analytics bucket. A normal capacity read revalidates at most once per `PROVIDER_CAPACITY_READ_FRESH_MS`
  (30 s) through the same durable lease, so two processes still cannot probe at once, and a same-bucket refresh
  overwrites that bucket's point instead of adding one.
- **Maintenance never delays a user request.** Every hook is fired fire-and-forget, and the reconciliation sweep is
  gate-guarded, so a sweep with nothing due costs one KV read.
- **Reconciliation has a manual path.** Reading a key's paid-fallback ledger schedules best-effort reconciliation of due
  work without awaiting it; the response can still contain unreconciled rows.

## What an operator should expect

- Capacity history converges on the next request or the next admin read: a normal capacity read is at most one 30-second
  freshness window behind (`PROVIDER_CAPACITY_READ_FRESH_MS`), while the durable capacity history bucket remains fifteen
  minutes. Paid-fallback terminal events and ledger reads schedule best-effort reconciliation; a ledger read can return
  before settlement. `?refresh=live` on the capacity endpoint still forces an immediate probe.
- On a busy gateway the events arrive continuously, so cadence is effectively the same as the retired jobs were, without
  the idle-time work.
