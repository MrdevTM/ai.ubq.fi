// OpenRouter upstream provider.
//
// OpenRouter is the gateway's upstream for Typesafe System One decisions
// (`typesafe/jev-*`). Its SystemOne contract is not OpenAI-shaped chat, so this
// provider exposes one typed transport — `fetchOpenRouterSystemOne` — that the
// `/v1/systemone` terminal route serves with the gateway's own quota,
// admission, and telemetry treatment. Nothing here hardcodes a Jev model id:
// callers pass the SystemOne model they want, and the route constrains it to
// the typesafe namespace so a shared credential cannot reach unrelated models.
//
// Chat and model-catalog access is deliberately not wired here yet; the repo
// already reads OpenRouter's public model list for metadata enrichment only.

import { isRecord } from "../utils.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENROUTER_SYSTEMONE_URL = `${OPENROUTER_BASE_URL}/systemone`;
export const OPENROUTER_FETCH_TIMEOUT_MS = 20_000;

export type OpenRouterErrorCode =
  "openrouter_api_key_missing" | "openrouter_upstream_unreachable" | "openrouter_upstream_error" | "openrouter_upstream_invalid_response";

/** A bounded upstream failure; `status` is the client-facing HTTP status. */
export class OpenRouterError extends Error {
  constructor(
    readonly code: OpenRouterErrorCode,
    /** Client-facing status, normalized (e.g. an upstream 401 answers 502). */
    readonly status: number,
    /** The raw upstream status when a response arrived; null otherwise. */
    readonly upstreamStatus: number | null = null
  ) {
    super(code);
    this.name = "OpenRouterError";
  }
}

export type OpenRouterFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const readOpenRouterApiKey = (): string | null => {
  try {
    const value = Deno.env.get(OPENROUTER_API_KEY_ENV)?.trim();
    if (!value) return null;
    return value;
  } catch {
    return null;
  }
};

/**
 * One System One decision call. The body is forwarded verbatim (`model`,
 * `state`, `questions`); the answer shape belongs to the caller, which also
 * owns bounds on the questions it sends.
 */
export const fetchOpenRouterSystemOne = async (input: {
  body: Readonly<Record<string, unknown>>;
  apiKey?: string | null;
  fetcher?: OpenRouterFetch;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> => {
  const apiKey = input.apiKey === undefined ? readOpenRouterApiKey() : input.apiKey;
  if (!apiKey) throw new OpenRouterError("openrouter_api_key_missing", 503);
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(OPENROUTER_SYSTEMONE_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs ?? OPENROUTER_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new OpenRouterError("openrouter_upstream_unreachable", 502);
  }
  if (!response.ok) {
    const status = response.status === 429 || response.status === 400 ? response.status : 502;
    throw new OpenRouterError("openrouter_upstream_error", status, response.status);
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload)) throw new OpenRouterError("openrouter_upstream_invalid_response", 502);
  return payload;
};
