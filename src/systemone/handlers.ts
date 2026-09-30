// System One (Typesafe Jev) decision proxy.
//
// Jev answers typed questions (`noul`, `choice`, `score`) over a caller-supplied
// state object; it is the gateway's first decisions route. OpenRouter serves the
// same contract as the Typesafe host and is the only reachable route for this
// account. The gateway holds the OpenRouter credential so product clients keep
// using their existing UOS API key and no other surface learns the key.
//
// Bounds: the request body is capped, only `state`/`questions`/`model` are
// accepted, every question must carry a known primitive type, and `model` is
// constrained to the typesafe namespace so a shared credential cannot be used
// to reach unrelated OpenRouter models.

import { openaiError } from "../http.ts";
import { readJsonBody } from "../request.ts";
import { getString, isRecord } from "../utils.ts";

export const SYSTEMONE_UPSTREAM_URL = "https://openrouter.ai/api/v1/systemone";
export const SYSTEMONE_API_KEY_ENV = "OPENROUTER_API_KEY";
export const SYSTEMONE_DEFAULT_MODEL = "~typesafe/jev-latest";
export const SYSTEMONE_MAX_BODY_BYTES = 262_144;
export const SYSTEMONE_MAX_QUESTIONS = 24;
export const SYSTEMONE_MAX_MODEL_LENGTH = 80;
export const SYSTEMONE_TIMEOUT_MS = 20_000;

const SYSTEMONE_REQUEST_KEYS = ["state", "questions", "model"] as const;
const SYSTEMONE_QUESTION_TYPES = new Set(["noul", "choice", "score"]);
const SYSTEMONE_MODEL_PATTERN = /^~?typesafe\/[a-z0-9][a-z0-9._-]{0,63}$/u;

export type SystemOneHandlerDeps = Readonly<{
  fetcher?: typeof fetch;
  apiKey?: () => string | null;
}>;

export const readSystemOneApiKey = (): string | null => {
  try {
    const value = Deno.env.get(SYSTEMONE_API_KEY_ENV)?.trim();
    if (!value) return null;
    return value;
  } catch {
    return null;
  }
};

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

const dispatchSystemOne = async (fetcher: typeof fetch, apiKey: string, body: Record<string, unknown>): Promise<Response> => {
  let upstream: Response;
  try {
    upstream = await fetcher(SYSTEMONE_UPSTREAM_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYSTEMONE_TIMEOUT_MS),
    });
  } catch {
    return openaiError(502, "System One upstream unreachable", "systemone_upstream_unreachable");
  }
  if (!upstream.ok) {
    const status = upstream.status === 429 || upstream.status === 400 ? upstream.status : 502;
    return openaiError(status, "System One upstream error", "systemone_upstream_error");
  }
  const payload = await upstream.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    return openaiError(502, "System One upstream invalid response", "systemone_upstream_invalid_response");
  }
  return Response.json(payload);
};

export const handleSystemOne = async (req: Request, deps: SystemOneHandlerDeps = {}): Promise<Response> => {
  const apiKey = (deps.apiKey ?? readSystemOneApiKey)();
  if (!apiKey) {
    return openaiError(503, "System One is not configured", "systemone_not_configured");
  }

  const raw = await readJsonBody(req, SYSTEMONE_MAX_BODY_BYTES);
  if (!isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const unsupported = unsupportedKeyError(raw);
  if (unsupported) return unsupported;
  if (!isRecord(raw.state)) return openaiError(400, "state must be an object", "invalid_request_error");
  const questionFailure = questionsError(raw.questions);
  if (questionFailure) return questionFailure;
  const invalidModel = modelError(raw);
  if (invalidModel) return invalidModel;
  const model = modelOf(raw);

  return await dispatchSystemOne(deps.fetcher ?? fetch, apiKey, {
    model,
    state: raw.state,
    questions: raw.questions,
  });
};
