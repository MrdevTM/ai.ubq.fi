import assert from "node:assert/strict";
import { kernelQuotaRouteForRequest, terminalRouteForRequest } from "../src/handler/http.ts";
import { getResponseTelemetry } from "../src/openai-telemetry.ts";
import { OPENROUTER_SYSTEMONE_URL } from "../src/provider/openrouter.ts";
import { handleSystemOne, SYSTEMONE_DEFAULT_MODEL } from "../src/systemone/handlers.ts";

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
