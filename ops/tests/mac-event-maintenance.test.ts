import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureParent = `${root}.cleanup-evidence/mac-event-maintenance-fixtures`;
const revision = "a".repeat(40);
const decoder = new TextDecoder();

const moduleUrl = (path: string): string => new URL(`../../${path}`, import.meta.url).href;
const importSource = (path: string): string => JSON.stringify(moduleUrl(path));

const bootstrapSource = (fixture: string): string => `
import assert from "node:assert/strict";
import { getKv, setKvForTest } from ${importSource("src/kv.ts")};
import { admitPaidFallbackV3, updatePaidFallbackRequestV3 } from ${importSource("src/paid-fallback/ledger-admission.ts")};
import { markPaidFallbackTerminalV3, reconcileDuePaidFallbacksV3 } from ${importSource("src/paid-fallback/ledger-backfill.ts")};
import { recordMeteredTerminal } from ${importSource("src/paid-fallback/index.ts")};
import { paidFallbackRequestV3Key, paidFallbackWindowV3Key, paidFallbackPendingV3Key,
  paidFallbackReconciliationLeaseV3Key } from ${importSource("src/paid-fallback/ledger-state.ts")};
import { recordPromptCacheAnalytics, prunePromptCacheAnalytics, promptCacheAnalyticsCounterKey,
  PROMPT_CACHE_ANALYTICS_BUCKET_MS, PROMPT_CACHE_ANALYTICS_RETENTION_MS } from ${importSource("src/cache/prompt-analytics.ts")};

const fixture = ${JSON.stringify(fixture)};
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const nativeOpen = Deno.openKv;
const mac = await nativeOpen(fixture + "/.data/kv.sqlite3");
const isolated = await nativeOpen(fixture + "/.data/isolated.sqlite3");
await isolated.set(["isolation"], "untouched");
const isolatedBefore = await isolated.get(["isolation"]);
const logRows = [];
const state = { intervalArms: 0, intervalCallbacks: [], startupReconciles: 0, startupPrunes: 0,
  startupSettled: 0, stopCalls: 0, stopSettled: 0, closeCalls: 0, providerReads: 0,
  sameKv: false, nativeOpenCalls: 0, shutdownTelemetry: 0, serveCalls: 0 };
globalThis.maintenanceFixture = state;
globalThis.setInterval = (callback) => { state.intervalArms += 1; state.intervalCallbacks.push(callback); return 1; };
globalThis.clearInterval = () => {};
globalThis.fetch = (input) => {
  const url = new URL(String(input));
  assert.equal(url.origin + url.pathname, "https://api.openlux.ai/api/log/token", "only the provider-log endpoint may run");
  assert.equal(url.searchParams.get("key"), "synthetic-mac-fixture");
  state.providerReads += 1;
  return Promise.resolve(Response.json({ success: true, data: logRows }));
};
const waitFor = async (predicate, description) => {
  const deadline = performance.now() + 5_000;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(description);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const input = requestId => ({ keyId: "fixture-key", requestId, createdAtMs: clock,
  policyVersion: "fixture-policy", limitMicrocredits: 1_000_000, maximumExposureMicrocredits: 250_000,
  initialSettledMicrocredits: 0, quotaPerCredit: 500_000, windowResetAtMs: clock + 8 * 60 * 60_000,
  model: "gpt-5-codex", route: "responses", path: "/v1/responses", stream: false, reasoning: "high" });
const seedBilling = async requestId => {
  const admission = await admitPaidFallbackV3(input(requestId));
  assert.equal(admission.kind, "reserved");
  await updatePaidFallbackRequestV3(admission.reservation, {
    provider: "metered", provider_request_id: "provider-" + requestId, dispatch_state: "dispatched",
  });
  logRows.push({ request_id: "provider-" + requestId, quota: 25_000, prompt_tokens: 5,
    completion_tokens: 6, model_name: "gpt-5-codex", created_at: Math.trunc(clock / 1_000) });
  return admission.reservation;
};
const settled = async requestId =>
  (await mac.get(paidFallbackRequestV3Key("fixture-key", requestId))).value?.billing_state === "settled";
const assertReleased = async reservation => {
  assert.equal(await settled(reservation.request_id), true);
  const window = await mac.get(paidFallbackWindowV3Key("fixture-key", reservation.window_reset_at_ms));
  assert.equal(window.value.reserved_microcredits, 0);
  assert.equal(window.value.pending_count, 0);
};
const expiredCounterKey = () => promptCacheAnalyticsCounterKey(
  Math.floor((clock - PROMPT_CACHE_ANALYTICS_RETENTION_MS - 60_000) / PROMPT_CACHE_ANALYTICS_BUCKET_MS)
    * PROMPT_CACHE_ANALYTICS_BUCKET_MS, "sample_count");

// Positive native baseline establishes the real settlement/prune contract before
// checking that the launcher's helper performs the same work without a timer.
setKvForTest(mac);
const baseline = await seedBilling("baseline");
await markPaidFallbackTerminalV3(baseline, "completed");
const baselineCounter = expiredCounterKey();
await mac.set(baselineCounter, new Deno.KvU64(1n));
assert.equal(await reconcileDuePaidFallbacksV3(clock, mac), 1);
await assertReleased(baseline);
assert.equal((await prunePromptCacheAnalytics({ kv: mac, now: () => clock })).status, "pruned");
assert.equal((await mac.get(baselineCounter)).value, null);

const startup = await seedBilling("startup");
await markPaidFallbackTerminalV3(startup, "completed");
const startupCounter = expiredCounterKey();
await mac.set(startupCounter, new Deno.KvU64(1n));
setKvForTest(null);

let finishServe;
const finished = new Promise(resolve => { finishServe = resolve; });
Deno.serve = () => {
  state.serveCalls += 1;
  return { finished, shutdown: () => { finishServe(); return Promise.resolve(); } };
};
Object.defineProperty(Deno, "openKv", { value: async path => {
  state.nativeOpenCalls += 1;
  assert.equal(path, fixture + "/.data/kv.sqlite3");
  return mac;
} });
const close = mac.close.bind(mac);
mac.close = () => {
  assert.equal(state.stopSettled >= 1, true, "startup jobs must settle before KV close");
  assert.equal(state.shutdownTelemetry, 1);
  state.closeCalls += 1;
  console.log(JSON.stringify({ fixture: "mac-event-maintenance", ...state, intervalCallbacks: undefined }));
  close();
};
const entry = import(${JSON.stringify(`${fixture}/.data/releases/${revision}/scripts/serve-mac.ts`)});
await waitFor(() => state.serveCalls === 1 && state.startupSettled === 2, "startup maintenance did not settle");
assert.equal(await getKv(), mac);
assert.equal(state.sameKv, true);
assert.equal(state.nativeOpenCalls, 1, "the Mac entry must reuse its initialized database");
assert.equal(state.startupReconciles, 1);
assert.equal(state.startupPrunes, 1);
await assertReleased(startup);
assert.equal((await mac.get(startupCounter)).value, null);
assert.equal(state.intervalArms, 0, "the actual Mac entry must not register periodic maintenance");

const readsBeforeIdle = state.providerReads;
clock += 2 * 60 * 60_000;
for (const callback of state.intervalCallbacks) callback();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(state.providerReads, readsBeforeIdle, "clock advance without an event must do no billing work");
assert.equal(state.startupReconciles, 1);
assert.equal(state.startupPrunes, 1);

const later = await seedBilling("later-event");
await recordMeteredTerminal(later, "completed");
await waitFor(() => settled("later-event"), "the existing terminal event did not reconcile the Mac KV");
await assertReleased(later);
await waitFor(async () => (await mac.get(paidFallbackPendingV3Key("fixture-key", "later-event"))).value === null
  && (await mac.get(paidFallbackReconciliationLeaseV3Key("fixture-key"))).value === null,
  "the terminal event must release its native lease before KV shutdown");
const laterCounter = expiredCounterKey();
await mac.set(laterCounter, new Deno.KvU64(1n));
const analytics = await recordPromptCacheAnalytics({ provider: "chatgpt_codex", model: "fixture-model",
  route: "responses", status: 200, completed: true, usageTelemetryStatus: "reported",
  inputTokens: 100, cachedInputTokens: 25, cacheWriteInputTokens: null,
  promptCacheKeyPresent: false, promptCacheMode: "implicit", fallbackReason: null },
  { now: () => clock, release: ${JSON.stringify(revision)} });
assert.equal(analytics.status, "recorded");
await waitFor(async () => (await mac.get(laterCounter)).value === null,
  "the existing new-bucket analytics event did not prune the Mac KV");
assert.deepEqual(await isolated.get(["isolation"]), isolatedBefore);
let isolatedRows = 0;
for await (const unused of isolated.list({ prefix: [] })) isolatedRows += 1;
assert.equal(isolatedRows, 1, "the distinct database must not receive Mac ledger/analytics writes");
isolated.close();
const stop = state.stop;
const firstStop = stop();
assert.equal(stop(), firstStop, "the existing stop closure must stay idempotent");
await firstStop;
finishServe();
await entry;
`;

const fixtureSources = (fixture: string): Record<string, string> => ({
  "src/config.ts": `export const config = { isDeploy: false }; export const runtimeGitSha = () => ${JSON.stringify(revision)};`,
  "src/kv.ts": `import { initializeKv as install, getKv } from ${importSource("src/kv.ts")};
    export { getKv }; export const initializeKv = kv => { install(kv); globalThis.maintenanceFixture.sameKv = true; };`,
  "src/codex/reset-settings.ts": `export const migrateLegacyCodexResetOptOut = () => Promise.resolve("not_required");`,
  "src/auth/local-admin.ts": `export const parseServeRuntimeOptions = () => ({ disableAdminAuth: false });
    export const configureAdminAuthForListener = () => false;
    export const configureAdminAuthPeerForRequest = () => {};
    export const configureMacLocalAdminAuthBypassForListener = () => {};`,
  "src/auth/local-development-key.ts": `export const ensureLocalDevelopmentApiKey = () => Promise.resolve("exists");`,
  "src/cache/prompt-analytics.ts": `import { prunePromptCacheAnalytics as prune } from ${importSource("src/cache/prompt-analytics.ts")};
    export const closeOptionalPromptCacheAnalytics = () => Promise.resolve();
    export const optionalPromptCacheAnalyticsSnapshot = () => null;
    export const prunePromptCacheAnalytics = async options => {
      globalThis.maintenanceFixture.startupPrunes += 1;
      const value = await prune(options); globalThis.maintenanceFixture.startupSettled += 1; return value;
    };`,
  "src/paid-fallback/ledger-backfill.ts": `import { reconcileDuePaidFallbacksV3 as reconcile } from ${importSource("src/paid-fallback/ledger-backfill.ts")};
    export const reconcileDuePaidFallbacksV3 = async (now, kv) => {
      globalThis.maintenanceFixture.startupReconciles += 1;
      const value = await reconcile(now, kv); globalThis.maintenanceFixture.startupSettled += 1; return value;
    };`,
  "src/handler/serve-handler.ts": `export const createServeHandler = () => () => new Response("fixture");`,
  "serve.ts": `import handler, { startMacMaintenance as start, shutdownOptionalTelemetry as drain } from "./maintenance.ts";
    export default handler;
    export const startMacMaintenance = kv => {
      const stop = start(kv); globalThis.maintenanceFixture.stop = stop;
      return () => {
        globalThis.maintenanceFixture.stopCalls += 1;
        const pending = stop(); pending.then(() => { globalThis.maintenanceFixture.stopSettled += 1; }); return pending;
      };
    };
    export const shutdownOptionalTelemetry = async () => {
      await drain(); globalThis.maintenanceFixture.shutdownTelemetry += 1;
    };`,
  "bootstrap.ts": bootstrapSource(fixture),
});

const sha256 = async (value: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");

Deno.test("Mac entry preserves startup and same-KV event maintenance without periodic intervals", async () => {
  const launcher = await Deno.readTextFile(`${root}scripts/serve-mac.ts`);
  const maintenance = await Deno.readTextFile(`${root}serve.ts`);
  await Deno.mkdir(fixtureParent, { recursive: true });
  const fixture = await Deno.makeTempDir({ dir: fixtureParent, prefix: "native-" });
  const release = `${fixture}/.data/releases/${revision}`;
  const hashes: Record<string, string> = {};
  try {
    await Deno.mkdir(`${fixture}/.data`, { recursive: true });
    for (const [path, source] of Object.entries(fixtureSources(fixture))) {
      const absolute = path === "bootstrap.ts" ? `${fixture}/${path}` : `${release}/${path}`;
      await Deno.mkdir(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(absolute, source);
      hashes[path] = await sha256(await Deno.readTextFile(absolute));
    }
    await Deno.mkdir(`${release}/scripts`, { recursive: true });
    await Deno.writeTextFile(`${release}/scripts/serve-mac.ts`, launcher);
    await Deno.writeTextFile(`${release}/maintenance.ts`, maintenance);
    assert.equal(await sha256(await Deno.readTextFile(`${release}/scripts/serve-mac.ts`)), await sha256(launcher));
    assert.equal(await sha256(await Deno.readTextFile(`${release}/maintenance.ts`)), await sha256(maintenance));
    hashes["scripts/serve-mac.ts"] = await sha256(launcher);
    hashes["maintenance.ts"] = await sha256(maintenance);
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        "--no-prompt",
        `--config=${root}deno.json`,
        `--lock=${root}deno.lock`,
        "--unstable-kv",
        `--allow-read=${fixture},${root}src`,
        `--allow-write=${fixture}`,
        "--allow-env=DENO_DEPLOY,DENO_DEPLOYMENT_ID,DENO_DEPLOY_BUILD_ID,DENO_REGION,DENO_TIMELINE,METERED_API_KEY",
        `${fixture}/bootstrap.ts`,
      ],
      cwd: fixture,
      clearEnv: true,
      env: { METERED_API_KEY: "synthetic-mac-fixture" },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20_000);
    let result: Deno.CommandOutput;
    try {
      result = await child.output();
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(result.code, 0, `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`);
    const probeLine = decoder
      .decode(result.stdout)
      .split("\n")
      .find((line) => line.startsWith('{"fixture":"mac-event-maintenance"'));
    assert.ok(probeLine, "the actual entry must reach KV close with its completed probe");
    const probe = JSON.parse(probeLine) as Record<string, unknown>;
    assert.equal(probe.intervalArms, 0);
    assert.equal(probe.startupReconciles, 1);
    assert.equal(probe.startupPrunes, 1);
    assert.equal(probe.sameKv, true);
    assert.equal(probe.closeCalls, 1);
    assert.equal(probe.nativeOpenCalls, 1);
    assert.equal(probe.serveCalls, 1);
    assert.equal(probe.shutdownTelemetry, 1);
    console.info(JSON.stringify({ fixtureManifest: hashes, probe }));
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});
