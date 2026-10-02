import assert from "node:assert/strict";
import { apiKeyHashKey } from "../src/api-keys.ts";
import {
  type ApiKeyPolicy,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  type ApiKeyUsageReservation,
  reserveApiKeyUsageV3,
} from "../src/api-key-policy.ts";
import { kernelQuotaRouteForRequest, terminalRouteForRequest } from "../src/handler/http.ts";
import { getResponseTelemetry, type UsageContext } from "../src/openai-telemetry.ts";
import { OPENROUTER_SYSTEMONE_URL } from "../src/provider/openrouter.ts";
import { handleSystemOne, SYSTEMONE_DEFAULT_MODEL } from "../src/systemone/handlers.ts";
import type { ApiKeyHashRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../src/types.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const jsonBodyOf = (init?: RequestInit): unknown => {
  const body = init?.body;
  return typeof body === "string" ? JSON.parse(body) : null;
};

const request = (body: unknown): Request =>
  new Request("https://ai.ubq.fi/uos/systemone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const state = {
  question: {
    capabilityKey: "search.person.filter_group",
    filterKey: "search.lead.filter.industry",
    prompt: "Which candidate is the filter group container?",
    options: [{ optionId: "g-industry", selector: 'fieldset[data-x-search-filter="INDUSTRY"]' }],
  },
};

const questions = {
  candidate: {
    type: "choice",
    instructions: "Choose one offered candidate or not_stated.",
    criteria: { "g-industry": "The INDUSTRY fieldset.", not_stated: "No sound repair." },
  },
};

const answerPayload = {
  model: "typesafe/jev-1.13-20260917",
  answers: { candidate: { type: "choice", choice: "g-industry", confidence: 0.99 } },
  usage: { input_tokens: 1118, output_tokens: 117, cost: 4.6956e-5 },
};

/**
 * The bounded V3 API-key ledger the terminal wrapper admits requests into: an
 * in-memory KV holding the hash record `reserveApiKeyUsageV3` reads, plus the
 * policy the reservation is built from.
 */
const ledgerFixture = (id: string, usageLimitRequests: number, nowMs = Date.now()): Readonly<{ kv: CountingKv; policy: ApiKeyPolicy }> => {
  const tokenHash = `systemone-${id}`;
  const record: ApiKeyHashRecord = {
    id,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: usageLimitRequests,
    usage_requests: 0,
    usage_reset_at_ms: nowMs + 60 * 60_000,
    window_ms: 60 * 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  const policy = apiKeyPolicyFromHashRecord(tokenHash, record, nowMs);
  if (!policy) throw new Error("test API key policy must be valid");
  const kv = new CountingKv();
  kv.seed(apiKeyHashKey(tokenHash), record);
  return { kv, policy };
};

/** Admits one request through the same deferred path the terminal wrapper uses. */
const admissionFor = async (kv: CountingKv, policy: ApiKeyPolicy, requestId: string): Promise<ApiKeyUsageReservation> => {
  const decision = await reserveApiKeyUsageV3(policy, requestId, "systemone", { kv: kv as unknown as Deno.Kv, deferWhenFull: true });
  if (!decision.ok) throw new Error(`unexpected admission failure: ${decision.response.status}`);
  return decision.reservation;
};

const usageContextWith = (reservation: ApiKeyUsageReservation): UsageContext => ({
  keyId: null,
  kernelRepo: null,
  kernelOrg: null,
  beforeProviderDispatch: reservation.beforeProviderDispatch,
});

const storedWindow = (kv: CountingKv, policy: ApiKeyPolicy): ApiKeyUsageWindowV3 => {
  const window = kv.entries.get(JSON.stringify(apiKeyUsageV3WindowKey(policy)))?.value as ApiKeyUsageWindowV3 | undefined;
  if (!window) throw new Error("expected a V3 usage window");
  return window;
};

const storedRequest = (kv: CountingKv, policy: ApiKeyPolicy, requestId: string): ApiKeyUsageRequestV3 | null =>
  (kv.entries.get(JSON.stringify(apiKeyUsageV3RequestKey(policy, requestId)))?.value as ApiKeyUsageRequestV3 | undefined) ?? null;

Deno.test("systemone commits the api-key request reservation exactly once before dispatch", async () => {
  const { kv, policy } = ledgerFixture("commit-once", 2);
  const reservation = await admissionFor(kv, policy, "systemone-commit-once");
  let fetchCalls = 0;
  const fetcher = (() => {
    fetchCalls += 1;
    return Promise.resolve(Response.json(answerPayload));
  }) as typeof fetch;

  const response = await handleSystemOne(request({ state, questions }), usageContextWith(reservation), { fetcher, apiKey: () => "or-test-key" });

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  const window = storedWindow(kv, policy);
  assert.equal(window.committed_requests, 1);
  assert.equal(window.reserved_requests, 0);
  const row = storedRequest(kv, policy, "systemone-commit-once");
  assert.ok(row);
  assert.equal(row.state, "dispatched");
  assert.equal(row.provider, "openrouter");
});

Deno.test("systemone refuses an exhausted api-key window before the upstream fetch", async () => {
  const { kv, policy } = ledgerFixture("exhausted", 1);
  const first = await admissionFor(kv, policy, "systemone-exhausted-1");
  await first.beforeProviderDispatch("openrouter");
  const second = await admissionFor(kv, policy, "systemone-exhausted-2");
  let fetchCalls = 0;
  const fetcher = (() => {
    fetchCalls += 1;
    return Promise.resolve(Response.json(answerPayload));
  }) as typeof fetch;

  const response = await handleSystemOne(request({ state, questions }), usageContextWith(second), { fetcher, apiKey: () => "or-test-key" });

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "rate_limit_exceeded");
  assert.equal(body.error.type, "rate_limit_error");
  assert.equal(response.headers.get("ratelimit-limit"), "1");
  assert.equal(response.headers.get("ratelimit-remaining"), "0");
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
  assert.equal(fetchCalls, 0);
  const window = storedWindow(kv, policy);
  assert.equal(window.committed_requests, 1);
  assert.equal(window.reserved_requests, 0);
  assert.equal(storedRequest(kv, policy, "systemone-exhausted-2"), null);
});

Deno.test("systemone proxies one typed question set upstream with the server key", async () => {
  const captured: { url: string; headers: Headers | null; body: unknown } = {
    url: "",
    headers: null,
    body: null,
  };
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = urlOf(input);
    captured.headers = new Headers(init?.headers);
    captured.body = jsonBodyOf(init);
    return Promise.resolve(Response.json(answerPayload));
  }) as typeof fetch;

  const response = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher,
    apiKey: () => "or-test-key",
  });

  assert.equal(response.status, 200);
  assert.equal(captured.url, OPENROUTER_SYSTEMONE_URL);
  assert.equal(captured.headers?.get("authorization"), "Bearer or-test-key");
  const sent = captured.body as Record<string, unknown>;
  assert.equal(sent.model, SYSTEMONE_DEFAULT_MODEL);
  assert.deepEqual(sent.state, state);
  assert.deepEqual(sent.questions, questions);
  const payload = await response.json();
  assert.deepEqual(payload.answers.candidate.choice, "g-industry");
  assert.equal(payload.answers.candidate.confidence, 0.99);
});

Deno.test("systemone accepts an explicit typesafe model and rejects other models", async () => {
  const seen: string[] = [];
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push((jsonBodyOf(init) as { model: string }).model);
    return Promise.resolve(Response.json(answerPayload));
  }) as typeof fetch;

  const ok = await handleSystemOne(request({ state, questions, model: "~typesafe/jev-1.13.0" }), undefined, {
    fetcher,
    apiKey: () => "or-test-key",
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, ["~typesafe/jev-1.13.0"]);

  for (const model of ["openai/gpt-6-sol", "typesafe/", "~typesafe/" + "a".repeat(90)]) {
    const rejected = await handleSystemOne(request({ state, questions, model }), undefined, {
      fetcher,
      apiKey: () => "or-test-key",
    });
    assert.equal(rejected.status, 400);
  }
  assert.deepEqual(seen, ["~typesafe/jev-1.13.0"]);
});

Deno.test("systemone requires configuration and refuses malformed question sets", async () => {
  const unconfigured = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher: (() => Promise.resolve(Response.json(answerPayload))) as typeof fetch,
    apiKey: () => null,
  });
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error.code, "openrouter_api_key_missing");

  const fetcher = (() => Promise.reject(new Error("must not reach upstream"))) as typeof fetch;
  const apiKey = () => "or-test-key";
  const cases: unknown[] = [
    { state, questions, extra: true },
    { state: "not-an-object", questions },
    { state, questions: {} },
    { state, questions: { a: { type: "unsupported" } } },
    { state, questions: { a: { instructions: "missing type" } } },
  ];
  for (const body of cases) {
    const response = await handleSystemOne(request(body), undefined, { fetcher, apiKey });
    assert.equal(response.status, 400);
  }
});

Deno.test("systemone maps upstream upsets to bounded errors", async () => {
  const apiKey = () => "or-test-key";

  const unreachable = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher: (() => Promise.reject(new Error("connect timeout"))) as typeof fetch,
    apiKey,
  });
  assert.equal(unreachable.status, 502);
  assert.equal((await unreachable.json()).error.code, "openrouter_upstream_unreachable");

  for (const [status, expected] of [
    [429, 429],
    [500, 502],
    [503, 502],
  ] as const) {
    const failed = await handleSystemOne(request({ state, questions }), undefined, {
      fetcher: (() => Promise.resolve(new Response("{}", { status }))) as typeof fetch,
      apiKey,
    });
    assert.equal(failed.status, expected);
  }

  const invalid = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher: (() => Promise.resolve(Response.json({ model: "typesafe/jev-1.13-20260917" }))) as typeof fetch,
    apiKey,
  });
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error.code, "openrouter_upstream_invalid_response");
});

Deno.test("systemone is a terminal inference route with its own quota route", () => {
  assert.equal(terminalRouteForRequest("POST", "/v1/systemone"), "systemone");
  assert.equal(kernelQuotaRouteForRequest("POST", "/v1/systemone"), "systemone");
  // Hard cutover: the previous UOS platform path no longer routes.
  assert.equal(terminalRouteForRequest("POST", "/uos/systemone"), null);
});

Deno.test("systemone attaches reported usage telemetry to its response", async () => {
  const fetcher = (() =>
    Promise.resolve(
      Response.json({
        model: "typesafe/jev-1.13-20260917",
        answers: { candidate: { type: "choice", choice: "yes", confidence: 0.9 } },
        usage: { input_tokens: 310, output_tokens: 20, cost: 0.00001302 },
      })
    )) as typeof fetch;
  const response = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher,
    apiKey: () => "or-test-key",
  });
  assert.equal(response.status, 200);
  const telemetry = getResponseTelemetry(response);
  assert.ok(telemetry);
  assert.equal(telemetry.model, SYSTEMONE_DEFAULT_MODEL);
  assert.equal(telemetry.provider, "openrouter");
  assert.equal(telemetry.inputTokens, 310);
  assert.equal(telemetry.cachedInputTokens, 0);
  assert.equal(telemetry.outputTokens, 20);
  assert.equal(telemetry.totalTokens, 330);
  assert.equal(telemetry.usageObserved, true);
  assert.equal(telemetry.usageTelemetryStatus, "reported");
  assert.equal(telemetry.completed, true);
  assert.equal(telemetry.stream, false);
});
