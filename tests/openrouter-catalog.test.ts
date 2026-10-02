// Codex-catalog wiring for the OpenRouter upstream: its served catalogue
// contributes rows to the versioned catalog before the operator whitelist, so
// an id the operator enabled keeps the upstream's snapshot metadata while a row
// the operator did not enable stays out of the catalog Codex selects. An empty
// whitelist is no filter at all, so those rows then list on the upstream TTL.

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
const { storeCodexCatalog } = await import("../src/catalog/store.ts");
const { CODEX_CATALOG_AUTH_GENERATION_KEY } = await import("../src/catalog/types.ts");
const { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
const { setKvForTest } = await import("../src/kv.ts");
const { CODEX_MODELS_WHITELIST_KV_KEY } = await import("../src/models/codex-models-whitelist.ts");
const { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest } = await import("../src/models/openrouter-models.ts");
const { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } = await import("../src/provider/selection.ts");
const { resetRuntimeConfigCacheForTest } = await import("../src/runtime-config.ts");

const AUTH_GENERATION = "auth-generation-openrouter-catalog";

const seedKv = (whitelistModelIds: readonly string[]): void => {
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
    value: { model_ids: whitelistModelIds, updated_at_ms: 1 },
    versionstamp: nextVersion(),
  });
  setKvForTest(kvStub);
  resetCodexAuthCacheForTest();
  resetProviderSelectionCacheForTest();
  resetRuntimeConfigCacheForTest();
};

/** Credentials that append rows this suite does not assert. */
const PROVIDER_KEY_ENVS = ["DEEPSEEK_API_KEY", "LITHOSAI_API_KEY", "CEREBRAS_API_KEY", "METERED_API_KEY", "SURPLUS_API_KEY"] as const;

/** Run with every ambient provider credential cleared, then restore it. */
const withoutProviderKeys = async (run: () => Promise<void>): Promise<void> => {
  const saved = PROVIDER_KEY_ENVS.map((name) => [name, Deno.env.get(name)] as const);
  for (const [name] of saved) Deno.env.delete(name);
  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
};

/** The served OpenRouter catalogue: one id with metadata and one bare id. */
const servedCatalogue = async (): Promise<void> => {
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
};

/** The upstream Codex catalog for a version: one id the operator could enable and one hidden id. */
const upstreamCodexCatalogFetch =
  (): typeof fetch =>
  (input): Promise<Response> => {
    const version = new URL(fetchUrl(input)).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(
      Response.json({ models: [{ slug: `gpt-${version}` }, { slug: `hidden-${version}` }] }, { headers: { "Content-Type": "application/json" } })
    );
  };

/** Seed KV, the served catalogue and the OpenRouter credential, then run one case. */
const withFixture = async (whitelistModelIds: readonly string[], run: () => Promise<void>): Promise<void> => {
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "fixture-openrouter-key");
  resetOpenRouterModelsCacheForTest();
  try {
    await withoutProviderKeys(async () => {
      seedKv(whitelistModelIds);
      await servedCatalogue();
      await run();
    });
  } finally {
    setKvForTest(null);
    resetOpenRouterModelsCacheForTest();
    resetProviderSelectionCacheForTest();
    resetRuntimeConfigCacheForTest();
    if (originalKey === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", originalKey);
  }
};

const codexCatalogRequest = (): Request =>
  new Request("https://ai.ubq.fi/v1/models?client_version=0.100.0", { headers: { Authorization: "Bearer gateway-client-token" } });

Deno.test("codex catalog: OpenRouter rows follow the operator whitelist and keep their snapshot metadata", async () => {
  await withFixture(["gpt-0.100.0", "vendor/beta"], async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = upstreamCodexCatalogFetch();
    try {
      const response = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { models: Record<string, unknown>[] };
      const slugs = payload.models.map((model) => model.slug);
      assert.equal(slugs.includes("gpt-0.100.0"), true, "a whitelisted stored row survives");
      assert.equal(slugs.includes("hidden-0.100.0"), false, "the whitelist still hides stored rows");
      assert.equal(slugs.includes("vendor/alpha"), false, "an OpenRouter id the operator did not enable stays out of the catalog Codex selects");
      const beta = payload.models.find((model) => model.slug === "vendor/beta");
      assert.ok(beta, "a whitelisted OpenRouter id is advertised");
      assert.deepEqual(beta.supported_endpoint_types, ["openai-response", "openai-chat"]);
      assert.deepEqual(
        (beta.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
        ["high"]
      );
      assert.equal(beta.default_reasoning_level, "high");
      assert.equal(beta.context_window, 32_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("codex catalog: an empty whitelist is no filter and OpenRouter rows still list", async () => {
  await withFixture([], async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = upstreamCodexCatalogFetch();
    try {
      const response = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { models: Record<string, unknown>[] };
      assert.deepEqual(
        payload.models.map((model) => model.slug),
        ["gpt-0.100.0", "hidden-0.100.0", "vendor/alpha", "vendor/beta"]
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("codex catalog: an active whitelist filters a fresh stored-catalog hit instead of short-circuiting", async () => {
  await withFixture(["gpt-0.100.0"], async () => {
    kvStore.set(keyToString([...PROVIDER_SELECTION_KV_KEY]), { value: { provider_ids: ["codex"], updated_at_ms: 1 }, versionstamp: nextVersion() });
    resetProviderSelectionCacheForTest();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("a fresh stored-catalog hit must not reach upstream"));
    try {
      const stored = await storeCodexCatalog(kvStub, {
        clientVersion: "0.100.0",
        authGeneration: AUTH_GENERATION,
        body: JSON.stringify({ models: [{ slug: "gpt-0.100.0" }, { slug: "hidden-0.100.0" }] }),
        contentType: "application/json",
        fetchedAtMs: Date.now(),
      });
      assert.equal(stored, true, "the stored catalog seeds the fresh-cache hit path");
      const response = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-uos-cache"), "hit");
      const payload = (await response.json()) as { models: Record<string, unknown>[] };
      assert.deepEqual(
        payload.models.map((model) => model.slug),
        ["gpt-0.100.0"],
        "the enabled-model policy narrows the stored body"
      );
      assert.match(response.headers.get("ETag") ?? "", /^"uos-catalog-/, "the unfiltered upstream body's tag is not forwarded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
