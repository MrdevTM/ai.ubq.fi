import assert from "node:assert/strict";

import { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest, setOpenRouterModelsFetchForTest } from "../src/models/openrouter-models.ts";
import { openRouterUpstreamModelFor } from "../src/provider/openrouter.ts";
import { handleOpenRouterChatCompletions, handleOpenRouterResponses } from "../src/provider/openrouter-handlers.ts";

const catalogue = {
  data: [
    { id: "vendor/alpha", context_length: 1_000, top_provider: { context_length: 1_000 }, reasoning: { supported_efforts: ["high"], default_effort: "high" } },
    { id: "vendor/beta" },
  ],
};

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const withServedCatalogue = async (fn: () => Promise<void> | void): Promise<void> => {
  resetOpenRouterModelsCacheForTest();
  Deno.env.set("OPENROUTER_API_KEY", "fixture-openrouter-key");
  setOpenRouterModelsFetchForTest((() => Promise.resolve(jsonResponse(catalogue))) as typeof fetch);
  try {
    await fetchOpenRouterModels();
    await fn();
  } finally {
    setOpenRouterModelsFetchForTest(null);
    resetOpenRouterModelsCacheForTest();
    Deno.env.delete("OPENROUTER_API_KEY");
  }
};

Deno.test("openrouter serves every cached catalogue id and refuses the rest", async () => {
  await withServedCatalogue(() => {
    assert.equal(openRouterUpstreamModelFor("vendor/alpha"), "vendor/alpha");
    assert.equal(openRouterUpstreamModelFor("vendor/beta"), "vendor/beta");
    assert.equal(openRouterUpstreamModelFor("vendor/gamma"), null);
  });
});

Deno.test("openrouter chat forwards the client body with the served model", async () => {
  await withServedCatalogue(async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    const response = await handleOpenRouterChatCompletions(
      new Request("https://ai.ubq.fi/v1/chat/completions", { method: "POST" }),
      { model: "vendor/alpha", messages: [{ role: "user", content: "hi" }] },
      "vendor/alpha",
      undefined,
      {
        fetchChat: (body) => {
          captured.body = body as Record<string, unknown>;
          return Promise.resolve(
            jsonResponse({
              id: "gen-1",
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            })
          );
        },
      }
    );
    assert.equal(response.status, 200);
    assert.equal(captured.body?.model, "vendor/alpha");
    assert.equal(response.headers.get("x-uos-upstream"), "openrouter");
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    assert.equal(body.choices?.[0]?.message?.content, "hello");
  });
});

Deno.test("openrouter refuses a model outside the catalogue on both wires", async () => {
  await withServedCatalogue(async () => {
    const chat = await handleOpenRouterChatCompletions(
      new Request("https://ai.ubq.fi/v1/chat/completions", { method: "POST" }),
      { model: "vendor/gamma" },
      "vendor/gamma"
    );
    assert.equal(chat.status, 400);
    const responses = await handleOpenRouterResponses(
      new Request("https://ai.ubq.fi/v1/responses", { method: "POST" }),
      { model: "vendor/gamma", input: "hi" },
      "vendor/gamma"
    );
    assert.equal(responses.status, 400);
  });
});

Deno.test("openrouter responses forwards the client body and reports the upstream", async () => {
  await withServedCatalogue(async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    const response = await handleOpenRouterResponses(
      new Request("https://ai.ubq.fi/v1/responses", { method: "POST" }),
      { model: "vendor/beta", input: "hi" },
      "vendor/beta",
      undefined,
      {
        fetchResponses: (body) => {
          captured.body = body as Record<string, unknown>;
          return Promise.resolve(
            jsonResponse({
              id: "resp_1",
              object: "response",
              status: "completed",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
              usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
            })
          );
        },
      }
    );
    assert.equal(response.status, 200);
    assert.equal(captured.body?.model, "vendor/beta");
    assert.equal(response.headers.get("x-uos-upstream"), "openrouter");
  });
});
