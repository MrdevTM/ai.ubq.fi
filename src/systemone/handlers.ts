// System One (Typesafe Jev) decisions route.
//
// Served as a terminal inference route (`POST /v1/systemone`) so it carries the
// same API-key authentication, admission, kernel quota route, telemetry, and
// usage accounting as every other provider call. The upstream is the OpenRouter
// provider (`src/provider/openrouter.ts`), which holds the credential.
//
// Bounds: the request body is capped, only `state`/`questions`/`model` are
// accepted, every question must carry a known primitive type, and `model` is
// constrained to the typesafe namespace so a shared credential cannot be used
// to reach unrelated OpenRouter models.

import { openaiError } from "../http.ts";
import { extractUsageTokens, recordCompletionUsage, recordRequestUsage, recordTerminalUsage, type UsageContext } from "../openai-telemetry.ts";
import { fetchOpenRouterSystemOne, OpenRouterError, type OpenRouterFetch } from "../provider/openrouter.ts";
import { readJsonBody } from "../request.ts";
import { getString, isRecord } from "../utils.ts";

export const SYSTEMONE_DEFAULT_MODEL = "~typesafe/jev-latest";
export const SYSTEMONE_MAX_BODY_BYTES = 262_144;
export const SYSTEMONE_MAX_QUESTIONS = 24;
export const SYSTEMONE_MAX_MODEL_LENGTH = 80;

const SYSTEMONE_REQUEST_KEYS = ["state", "questions", "model"] as const;
const SYSTEMONE_QUESTION_TYPES = new Set(["noul", "choice", "score"]);
const SYSTEMONE_MODEL_PATTERN = /^~?typesafe\/[a-z0-9][a-z0-9._-]{0,63}$/u;

export type SystemOneHandlerDeps = Readonly<{
  fetcher?: OpenRouterFetch;
  apiKey?: () => string | null;
}>;

const validQuestion = (value: unknown): boolean => isRecord(value) && typeof value.type === "string" && SYSTEMONE_QUESTION_TYPES.has(value.type);

const unsupportedKeyError = (raw: Record<string, unknown>): Response | null => {
  const unknown = Object.keys(raw).find((key) => !(SYSTEMONE_REQUEST_KEYS as readonly string[]).includes(key));
  return unknown === undefined ? null : openaiError(400, `Unsupported key: ${unknown}`, "invalid_request_error");
};

const questionsError = (questions: unknown): Response | null => {
  if (!isRecord(questions)) {
    return openaiError(400, "questions must be an object", "invalid_request_error");
  }
  const entries = Object.entries(questions);
  if (entries.length === 0 || entries.length > SYSTEMONE_MAX_QUESTIONS) {
    return openaiError(400, "questions must hold between 1 and 24 questions", "invalid_request_error");
  }
  for (const [name, question] of entries) {
    if (!name.trim() || name.length > 120 || !validQuestion(question)) {
      return openaiError(400, "questions must be typed noul, choice, or score objects", "invalid_request_error");
    }
  }
  return null;
};

const modelError = (raw: Record<string, unknown>): Response | null => {
  if (raw.model === undefined) return null;
  const requested = getString(raw.model);
  if (requested === null) {
    return openaiError(400, "model must be a string", "invalid_request_error");
  }
  if (requested.length > SYSTEMONE_MAX_MODEL_LENGTH || !SYSTEMONE_MODEL_PATTERN.test(requested)) {
    return openaiError(400, "model must be a typesafe model id", "invalid_request_error");
  }
  return null;
};

const modelOf = (raw: Record<string, unknown>): string => getString(raw.model) ?? SYSTEMONE_DEFAULT_MODEL;

/**
 * Normalizes OpenRouter's SystemOne usage onto the gateway's canonical token
 * shape so the shared telemetry and metering read it. System One reports no
 * prompt caching, so the cache-read counter is an explicit zero rather than a
 * missing field that would downgrade otherwise complete telemetry.
 */
const normalizedUsage = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  const input = value.input_tokens;
  const output = value.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const usage: Record<string, unknown> = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: 0 },
  };
  if (typeof value.cost === "number") usage.cost = value.cost;
  return usage;
};

type SystemOneRequest = Readonly<{
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
}>;

const SYSTEMONE_ERROR_MESSAGES: Readonly<Record<OpenRouterError["code"], string>> = Object.freeze({
  openrouter_api_key_missing: "System One upstream is not configured",
  openrouter_upstream_unreachable: "System One upstream unreachable",
  openrouter_upstream_error: "System One upstream error",
  openrouter_upstream_invalid_response: "System One upstream invalid response",
});

/** Validates the bounded request envelope; a `Response` is the client-facing refusal. */
const parseSystemOneRequest = (raw: Record<string, unknown>): SystemOneRequest | Response => {
  const unsupported = unsupportedKeyError(raw);
  if (unsupported) return unsupported;
  if (!isRecord(raw.state)) return openaiError(400, "state must be an object", "invalid_request_error");
  const questionFailure = questionsError(raw.questions);
  if (questionFailure) return questionFailure;
  const invalidModel = modelError(raw);
  if (invalidModel) return invalidModel;
  return {
    model: modelOf(raw),
    state: raw.state,
    questions: raw.questions as Record<string, unknown>,
  };
};

export const handleSystemOne = async (req: Request, usageContext?: UsageContext, deps: SystemOneHandlerDeps = {}): Promise<Response> => {
  const raw = await readJsonBody(req, SYSTEMONE_MAX_BODY_BYTES);
  if (!isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const request = parseSystemOneRequest(raw);
  if (request instanceof Response) return request;
  const { model } = request;

  await recordRequestUsage(usageContext, { model, route: "systemone", stream: false, reasoning: null });

  let payload: Record<string, unknown>;
  try {
    payload = await fetchOpenRouterSystemOne({
      body: { model, state: request.state, questions: request.questions },
      ...(deps.apiKey ? { apiKey: deps.apiKey() } : {}),
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    });
  } catch (error) {
    if (error instanceof OpenRouterError) {
      return openaiError(error.status, SYSTEMONE_ERROR_MESSAGES[error.code], error.code);
    }
    throw error;
  }

  if (!isRecord(payload.answers)) {
    return openaiError(502, "System One upstream invalid response", "openrouter_upstream_invalid_response");
  }

  const usage = extractUsageTokens(normalizedUsage(payload.usage));
  await recordCompletionUsage(usageContext, usage);
  recordTerminalUsage(usageContext, usage, true);
  return Response.json(payload);
};
