// Codex-catalog wiring for the OpenRouter upstream: the served catalogue is
// appended after the operator whitelist, so a new upstream model reaches Codex
// clients without an operator re-save while curated gateway ids stay gated.

import assert from "node:assert/strict";

/** URL text of a fetch input (the transports under test always pass a string URL). */
const fetchUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const keyToString = (key: Deno.KvKey): string => JSON.stringify(key);
const kvStore = new Map<string, { value: unknown; versionstamp: string }>();
let versionCounter = 0;
const nextVersion = (): string => String(++versionCounter).padStart(20, "0");
const entryFor = (key: Deno.KvKey): Deno.KvEntryMaybe<unknown> => {
  const stored = kvStore.get(keyToString(key));
  return stored ? { key, value: stored.value, versionstamp: stored.versionstamp } : { key, value: null, versionstamp: null };
};

/** Minimal Deno.Kv stand-in: the catalog paths read, write and checkpoint keys. */
const kvStub = {
  get: (key: Deno.KvKey) => Promise.resolve(entryFor(key)),
  set: (key: Deno.KvKey, value: unknown) => {
    kvStore.set(keyToString(key), { value, versionstamp: nextVersion() });
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: Deno.KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: async function* () {
    // The catalog paths never list KV in this test; the empty iteration keeps
    // the stub's async-iterator shape without inventing entries.
    await Promise.resolve();
    for (const entry of [] as Deno.KvEntry<unknown>[]) yield entry;
  },
  atomic: () => {
    const checks: Deno.KvEntryMaybe<unknown>[] = [];
    const ops: { key: Deno.KvKey; value?: unknown; remove?: boolean }[] = [];
    const chain = {
      check: (entry: Deno.KvEntryMaybe<unknown>) => {
        checks.push(entry);
        return chain;
      },
      set: (key: Deno.KvKey, value: unknown) => {
        ops.push({ key, value });
        return chain;
      },
      delete: (key: Deno.KvKey) => {
        ops.push({ key, remove: true });
        return chain;
      },
      commit: () => {
        const valid = checks.every((expected) => entryFor(expected.key).versionstamp === expected.versionstamp);
        if (!valid) return Promise.resolve({ ok: false } as const);
        for (const op of ops) {
          if (op.remove) kvStore.delete(keyToString(op.key));
          else kvStore.set(keyToString(op.key), { value: op.value, versionstamp: nextVersion() });
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Deno.Kv;

const { handleCodexCatalogModels } = await import("../src/catalog/index.ts");
const { CODEX_CATALOG_AUTH_GENERATION_KEY } = await import("../src/catalog/types.ts");
const { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
const { setKvForTest } = await import("../src/kv.ts");
const { CODEX_MODELS_WHITELIST_KV_KEY } = await import("../src/models/codex-models-whitelist.ts");
const { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest } = await import("../src/models/openrouter-models.ts");
const { resetProviderSelectionCacheForTest } = await import("../src/provider/selection.ts");
const { resetRuntimeConfigCacheForTest } = await import("../src/runtime-config.ts");

const AUTH_GENERATION = "auth-generation-openrouter-catalog";

const seedKv = (): void => {
  kvStore.clear();
  kvStore.set(keyToString(CODEX_CATALOG_AUTH_GENERATION_KEY), { value: AUTH_GENERATION, versionstamp: nextVersion() });
  kvStore.set(keyToString([...CODEX_AUTH_POOL_KV_KEY]), {
    value: {
      accounts: [{ access_token: "server-access", refresh_token: "server-refresh", account_id: "server-account", updated_at_ms: Date.now() }],
      updated_at_ms: Date.now(),
    },
    versionstamp: nextVersion(),
  });
  kvStore.set(keyToString([...CODEX_MODELS_WHITELIST_KV_KEY]), {
    value: { model_ids: ["gpt-0.100.0"], updated_at_ms: 1 },
    versionstamp: nextVersion(),
  });
  setKvForTest(kvStub);
  resetCodexAuthCacheForTest();
  resetProviderSelectionCacheForTest();
  resetRuntimeConfigCacheForTest();
};

Deno.test("codex catalog: openrouter rows append after the whitelist and follow its snapshot", async () => {
  seedKv();
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  const originalFetch = globalThis.fetch;
  Deno.env.set("OPENROUTER_API_KEY", "fixture-openrouter-key");
  resetOpenRouterModelsCacheForTest();
  try {
    await fetchOpenRouterModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              { id: "vendor/alpha" },
              {
                id: "vendor/beta",
                context_length: 32_000,
                top_provider: { context_length: 32_000 },
                reasoning: { supported_efforts: ["high"], default_effort: "high" },
              },
            ],
          })
        ),
    });
    globalThis.fetch = (input) => {
      const version = new URL(fetchUrl(input)).searchParams.get("client_version") ?? "missing";
      return Promise.resolve(
        Response.json({ models: [{ slug: `gpt-${version}` }, { slug: `hidden-${version}` }] }, { headers: { "Content-Type": "application/json" } })
      );
    };

    const request = new Request("https://ai.ubq.fi/v1/models?client_version=0.100.0", { headers: { Authorization: "Bearer gateway-client-token" } });
    const response = await handleCodexCatalogModels(request, "0.100.0");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: Record<string, unknown>[] };
    const slugs = payload.models.map((model) => model.slug);
    assert.equal(slugs.includes("gpt-0.100.0"), true, "a whitelisted stored row survives");
    assert.equal(slugs.includes("hidden-0.100.0"), false, "the whitelist still hides stored rows");
    assert.equal(slugs.includes("vendor/alpha"), true, "a served OpenRouter id is advertised");
    const beta = payload.models.find((model) => model.slug === "vendor/beta");
    assert.ok(beta, "the second served OpenRouter id is advertised");
    assert.deepEqual(beta.supported_endpoint_types, ["openai-response", "openai-chat"]);
    assert.deepEqual(
      (beta.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
      ["high"]
    );
    assert.equal(beta.default_reasoning_level, "high");
    assert.equal(beta.context_window, 32_000);
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetOpenRouterModelsCacheForTest();
    if (originalKey === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", originalKey);
  }
});
