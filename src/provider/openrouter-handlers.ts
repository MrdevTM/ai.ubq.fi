// Direct OpenRouter serving: Chat Completions and Responses.
//
// OpenRouter exposes both OpenAI-compatible wires, so this route forwards the
// client's own body with the model swapped and relays the upstream payload —
// no translation layer is involved. The catalogue, capabilities, and dispatch
// all read `openRouterServableModelIds()`, so the offered set and the served
// set can never disagree, and a new upstream model becomes callable as soon as
// the cached public list refreshes.

import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { markChatSemanticOutput } from "../chat/stream-translation.ts";
import { json, openaiError } from "../http.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { inferenceSignal } from "../openai.ts";
import {
  extractChatUsageTokens,
  extractUsageTokens,
  recordAttemptedProvider,
  recordCompletionUsage,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
  recordRequestUsage,
  recordStreamTerminalType,
  type UsageContext,
} from "../openai-telemetry.ts";
import { chatCompletionHasAnswerBearingOutput, providerRequestIdFromResponse, toOpenAiUpstreamErrorResponse } from "../upstream-wire.ts";
import { recordOpenRouterProviderHealth } from "./health.ts";
import {
  fetchOpenRouterChatCompletions,
  fetchOpenRouterResponses,
  openRouterUpstreamModelFor,
  OpenRouterError,
  type OpenRouterDispatchHooks,
} from "./openrouter.ts";

type OpenRouterRouteTransport = (
  body: Readonly<Record<string, unknown>>,
  init: Readonly<{ signal: AbortSignal; hooks?: OpenRouterDispatchHooks }>
) => Promise<Response>;

export type OpenRouterHandlerDeps = Readonly<{
  /** Test seam: the OpenRouter transport for each wire. */
  fetchChat?: OpenRouterRouteTransport;
  fetchResponses?: OpenRouterRouteTransport;
}>;

const OPENROUTER_UPSTREAM_LABEL = "openrouter";

/** Mirrors the other providers' health classification for both routes. */
const recordOpenRouterResponseHealth = (status: number): void => {
  if (status === 401 || status === 403) {
    void recordOpenRouterProviderHealth("auth_invalid", status, Date.now);
    return;
  }
  if (status === 429) {
    void recordOpenRouterProviderHealth("quota_exhausted", status, Date.now);
    return;
  }
  if (status >= 500) {
    void recordOpenRouterProviderHealth("upstream_error", status, Date.now);
    return;
  }
  if (status >= 400) {
    void recordOpenRouterProviderHealth("reachable", status, Date.now);
    return;
  }
  void recordOpenRouterProviderHealth("success", status, Date.now);
};

const dispatchFailure = (error: unknown): Response => {
  if (error instanceof OpenRouterError && error.code === "openrouter_api_key_missing") {
    return openaiError(503, "OpenRouter is not configured", "openrouter_api_key_missing");
  }
  void recordOpenRouterProviderHealth("upstream_error", null, Date.now);
  if (isAbortLike(error)) {
    return openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error", param: null });
  }
  return openaiError(502, "OpenRouter upstream unreachable", "openrouter_upstream_unreachable");
};

const isAbortLike = (error: unknown): boolean => {
  if (error instanceof Error) return error.name === "AbortError" || error.name === "TimeoutError";
  return false;
};

const streamedResponse = (upstream: Response): Response => {
  const headers = new Headers(upstream.headers);
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("x-uos-upstream", OPENROUTER_UPSTREAM_LABEL);
  return new Response(upstream.body, { status: 200, headers });
};

type Dispatched = Readonly<{ response: Response; providerRequestId: string | null }>;

const dispatchUpstream = async (attempt: () => Promise<Response>, requestSignal: AbortSignal, usageContext: UsageContext | undefined): Promise<Dispatched> => {
  let upstream: Response;
  try {
    upstream = await attempt();
  } catch (error) {
    return { response: dispatchFailure(error), providerRequestId: null };
  }
  const providerRequestId = providerRequestIdFromResponse(upstream);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;
  recordOpenRouterResponseHealth(upstream.status);
  if (!upstream.ok) {
    return {
      response: await toOpenAiUpstreamErrorResponse(upstream, OPENROUTER_UPSTREAM_LABEL, requestSignal),
      providerRequestId,
    };
  }
  return { response: upstream, providerRequestId };
};

const hooksFor = (usageContext: UsageContext | undefined) => ({
  beforeDispatch: () => usageContext?.beforeProviderDispatch?.("openrouter") ?? Promise.resolve(undefined),
  onDispatch: () => {
    recordAttemptedProvider(usageContext, "openrouter");
    recordFirstProviderDispatch(usageContext);
  },
  onHeaders: () => {
    recordFirstProviderHeaders(usageContext);
  },
  sentinelUpstreamRecorder: usageContext?.sentinelUpstreamRecorder,
});

export const handleOpenRouterChatCompletions = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext,
  deps: OpenRouterHandlerDeps = {}
): Promise<Response> => {
  const upstreamModel = openRouterUpstreamModelFor(modelRaw);
  if (!upstreamModel) {
    return openaiError(400, "The requested model is not served by OpenRouter.", "openrouter_request_invalid", { param: "model" });
  }
  const clientWantsStream = rawRecord.stream === true;
  const body: Record<string, unknown> = { ...rawRecord, model: upstreamModel, stream: clientWantsStream };
  if (clientWantsStream) {
    // The gateway needs the upstream usage frame to meter the call.
    if (body.stream_options === undefined) body.stream_options = { include_usage: true };
  } else {
    delete body.stream_options;
  }
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = OPENROUTER_UPSTREAM_LABEL;
    usageContext.responseTelemetry.outputTokenAllowance = typeof rawRecord.max_completion_tokens === "number" ? rawRecord.max_completion_tokens : null;
  }
  await recordRequestUsage(usageContext, { model: modelRaw, route: "chat.completions", stream: clientWantsStream, reasoning: null });

  const requestSignal = inferenceSignal(req, usageContext);
  const transport = deps.fetchChat ?? fetchOpenRouterChatCompletions;
  const dispatched = await dispatchUpstream(
    async () => await transport(body, { signal: requestSignal, hooks: hooksFor(usageContext) }),
    requestSignal,
    usageContext
  );
  if (!dispatched.response.ok || clientWantsStream) return streamedResponse(dispatched.response);

  const captured = await readBoundedResponseBody(dispatched.response, {
    signal: requestSignal,
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "OpenRouter Chat Completions response was incomplete",
  });
  if (!captured.complete) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter Chat Completions response was incomplete", "openrouter_upstream_incomplete");
  }
  const payload = parseJsonRecord(captured.bytes);
  if (!payload) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter returned an unusable body", "openrouter_upstream_invalid_response");
  }
  if (chatCompletionHasAnswerBearingOutput(payload)) markChatSemanticOutput(usageContext);
  await recordCompletionUsage(usageContext, extractChatUsageTokens(payload.usage));
  recordStreamTerminalType(usageContext, "response.completed");
  return json(200, payload, { "x-uos-upstream": OPENROUTER_UPSTREAM_LABEL });
};

export const handleOpenRouterResponses = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext,
  deps: OpenRouterHandlerDeps = {}
): Promise<Response> => {
  const upstreamModel = openRouterUpstreamModelFor(modelRaw);
  if (!upstreamModel) {
    return openaiError(400, "The requested model is not served by OpenRouter.", "openrouter_request_invalid", { param: "model" });
  }
  const clientWantsStream = rawRecord.stream === true;
  const body: Record<string, unknown> = { ...rawRecord, model: upstreamModel };
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = OPENROUTER_UPSTREAM_LABEL;
  }
  await recordRequestUsage(usageContext, { model: modelRaw, route: "responses", stream: clientWantsStream, reasoning: null });

  const requestSignal = inferenceSignal(req, usageContext);
  const transport = deps.fetchResponses ?? fetchOpenRouterResponses;
  const dispatched = await dispatchUpstream(
    async () => await transport(body, { signal: requestSignal, hooks: hooksFor(usageContext) }),
    requestSignal,
    usageContext
  );
  if (!dispatched.response.ok || clientWantsStream) return streamedResponse(dispatched.response);

  const captured = await readBoundedResponseBody(dispatched.response, {
    signal: requestSignal,
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "OpenRouter Responses response was incomplete",
  });
  if (!captured.complete) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter Responses response was incomplete", "openrouter_upstream_incomplete");
  }
  const payload = parseJsonRecord(captured.bytes);
  if (!payload) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter returned an unusable body", "openrouter_upstream_invalid_response");
  }
  if (Array.isArray(payload.output) && payload.output.length > 0) markChatSemanticOutput(usageContext);
  await recordCompletionUsage(usageContext, extractUsageTokens(payload.usage));
  recordStreamTerminalType(usageContext, "response.completed");
  return json(200, payload, { "x-uos-upstream": OPENROUTER_UPSTREAM_LABEL });
};

const parseJsonRecord = (bytes: Uint8Array): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
