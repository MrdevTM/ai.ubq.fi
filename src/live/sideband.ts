// `GET /v1/live/<call_id>`: accept the client's sideband upgrade and bridge it
// to the OpenAI realtime WebSocket upstream with the creating account's auth.
//
// The downstream upgrade response is handed back to the runtime untouched: any
// `new Response(...)` wrapper drops the socket associated with the 101.

import type WebSocket from "ws";
import { getAuthPoolEntry } from "../codex/auth.ts";
import { openaiError } from "../http.ts";
import { isRecord } from "../utils.ts";
import {
  LIVE_SIDEBAND_HANDSHAKE_TIMEOUT_MS,
  LIVE_SIDEBAND_MAX_BUFFERED_BYTES,
  LIVE_SIDEBAND_MAX_PAYLOAD_BYTES,
  LIVE_SIDEBAND_PREOPEN_MAX_FRAMES,
  liveSidebandUpstreamHeaders,
  liveSidebandUrl,
  readLiveCallAccountId,
} from "./upstream.ts";

type DownstreamSocket = ReturnType<typeof Deno.upgradeWebSocket>["socket"];

type UpstreamSocket = WebSocket;

type UpstreamWebSocketConstructor = new (
  url: string,
  options: Readonly<{ headers: Record<string, string>; perMessageDeflate: boolean; maxPayload: number; handshakeTimeout: number }>
) => UpstreamSocket;

/** `WebSocket.readyState` values, mirrored here because the DOM binding is not importable by name. */
const SOCKET_OPEN = 1;
/** The gateway's own failure close: the client can reconnect the sideband. */
const SIDEBAND_FAILURE_CLOSE_CODE = 1011;

let upstreamWebSocketConstructor: UpstreamWebSocketConstructor | null = null;

/**
 * Loads `ws` on first use. Importing it at module scope evaluates code that
 * reads `WS_NO_BUFFER_UTIL` from the environment while the module graph loads,
 * which the repository's strict test env allowlist rejects.
 */
const loadUpstreamWebSocketConstructor = async (): Promise<UpstreamWebSocketConstructor> => {
  if (upstreamWebSocketConstructor) return upstreamWebSocketConstructor;
  const module: unknown = await import("ws");
  const candidate = isRecord(module) ? module.default : undefined;
  if (typeof candidate !== "function") throw new Error("ws module did not expose a WebSocket constructor");
  upstreamWebSocketConstructor = candidate as UpstreamWebSocketConstructor;
  return upstreamWebSocketConstructor;
};

const logLiveSideband = (event: "joined" | "closed" | "rejected", fields: Readonly<Record<string, string | number | null>>): void => {
  try {
    console.info("[ai.ubq.fi] live_sideband", JSON.stringify({ event, ...fields }));
  } catch {
    // Observability must never break the relay.
  }
};

/** `ws` only accepts 1000 or 3000-4999 on the wire; anything else closes bare. */
const upstreamCloseCode = (code: number): number | null => (code === 1000 || (code >= 3000 && code <= 4999) ? code : null);

/** The client accepts 1000-4999 except the three reserved codes. */
const downstreamCloseCode = (code: number): number | null => (code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015 ? code : null);

const frameText = (raw: unknown): string | null => {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return null;
};

const closeDownstream = (socket: DownstreamSocket, code: number, reason: string): void => {
  if (socket.readyState !== 0 && socket.readyState !== SOCKET_OPEN) return;
  const sendable = downstreamCloseCode(code);
  try {
    if (sendable === null) socket.close();
    else socket.close(sendable, reason.slice(0, 100));
  } catch {
    try {
      socket.close();
    } catch {
      // The peer is already gone.
    }
  }
};

const closeUpstream = (socket: UpstreamSocket, code: number, reason: string): void => {
  if (socket.readyState !== SOCKET_OPEN) {
    try {
      socket.terminate();
    } catch {
      // The dial already settled.
    }
    return;
  }
  const sendable = upstreamCloseCode(code);
  try {
    if (sendable === null) socket.close();
    else socket.close(sendable, reason.slice(0, 100));
  } catch {
    try {
      socket.terminate();
    } catch {
      // The dial already settled.
    }
  }
};

type LiveSidebandBridge = Readonly<{ downstream: DownstreamSocket; callId: string; accountId: string; accessToken: string }>;

/**
 * Bridges one downgoing socket to one upstream socket: text frames both ways,
 * close codes propagated, and frames the client sent before the upstream
 * handshake finished held in a small bounded queue rather than dropped or
 * buffered without limit.
 */
const bridgeLiveSideband = async (input: LiveSidebandBridge): Promise<void> => {
  const { downstream, callId, accountId, accessToken } = input;
  let upstream: UpstreamSocket;
  try {
    const WEB_SOCKET_CONSTRUCTOR = await loadUpstreamWebSocketConstructor();
    upstream = new WEB_SOCKET_CONSTRUCTOR(liveSidebandUrl(callId), {
      headers: liveSidebandUpstreamHeaders(accessToken, accountId),
      perMessageDeflate: false,
      maxPayload: LIVE_SIDEBAND_MAX_PAYLOAD_BYTES,
      handshakeTimeout: LIVE_SIDEBAND_HANDSHAKE_TIMEOUT_MS,
    });
  } catch {
    logLiveSideband("rejected", { call_id: callId, reason: "upstream_dial_failed" });
    closeDownstream(downstream, SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream unavailable");
    return;
  }

  const preopenFrames: string[] = [];
  let upstreamOpen = false;
  let settled = false;

  const finish = (code: number, reason: string): void => {
    if (settled) return;
    settled = true;
    preopenFrames.length = 0;
    closeUpstream(upstream, code, reason);
    closeDownstream(downstream, code, reason);
    logLiveSideband("closed", { call_id: callId, account_id: accountId, code });
  };

  downstream.onmessage = (event: MessageEvent) => {
    // The frameless sideband is JSON text; a binary frame is a protocol error.
    const text = frameText(event.data);
    if (text === null) return;
    if (!upstreamOpen) {
      if (preopenFrames.length >= LIVE_SIDEBAND_PREOPEN_MAX_FRAMES) {
        finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime sideband frame queue overflow");
        return;
      }
      preopenFrames.push(text);
      return;
    }
    if (upstream.bufferedAmount > LIVE_SIDEBAND_MAX_BUFFERED_BYTES) {
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream is not draining frames");
      return;
    }
    try {
      upstream.send(text);
    } catch {
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream send failed");
    }
  };
  downstream.onclose = (event: CloseEvent) => {
    finish(event.code, event.reason);
  };
  downstream.onerror = () => {
    finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime sideband error");
  };

  upstream.on("open", () => {
    upstreamOpen = true;
    logLiveSideband("joined", { call_id: callId, account_id: accountId });
    for (const frame of preopenFrames.splice(0)) {
      try {
        upstream.send(frame);
      } catch {
        finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream send failed");
        return;
      }
    }
  });
  upstream.on("message", (data: unknown, isBinary: boolean) => {
    if (isBinary) return;
    const text = frameText(data);
    if (text === null || downstream.readyState !== SOCKET_OPEN || downstream.bufferedAmount > LIVE_SIDEBAND_MAX_BUFFERED_BYTES) {
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime sideband is not writable");
      return;
    }
    downstream.send(text);
  });
  upstream.on("close", (code: number, reason: unknown) => {
    finish(code, frameText(reason) ?? "");
  });
  upstream.on("error", () => {
    finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream error");
  });
  upstream.on("unexpected-response", () => {
    finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream rejected the sideband");
  });
};

type LiveCallAccountToken = Readonly<{ ok: true; accessToken: string }> | Readonly<{ ok: false; response: Response }>;

/** The mapped account's current token; a missing account fails closed. */
const liveCallAccountToken = async (accountId: string): Promise<LiveCallAccountToken> => {
  try {
    const pool = (await getAuthPoolEntry(true, true)).pool;
    const account = pool.accounts.find((candidate) => candidate.account_id === accountId);
    if (!account) return { ok: false, response: openaiError(404, "The realtime call's account is no longer configured.", "invalid_request_error") };
    return { ok: true, accessToken: account.access_token };
  } catch {
    return { ok: false, response: openaiError(503, "Codex auth pool is temporarily unavailable; retry the request.", "codex_auth_missing") };
  }
};

/**
 * Joins one call's sideband.
 *
 * A call id with no durable mapping is answered with 404 *before* upgrading:
 * the mapping is the gateway's only routing signal for the upstream account,
 * and the Codex client stops reconnecting on 404/410 exactly as it would for a
 * finished upstream call.
 */
export const handleLiveSideband = async (req: Request, callId: string): Promise<Response> => {
  const accountId = await readLiveCallAccountId(callId);
  if (accountId === null) {
    logLiveSideband("rejected", { call_id: callId, reason: "unknown_call" });
    return openaiError(404, "Unknown realtime call.", "invalid_request_error");
  }
  const account = await liveCallAccountToken(accountId);
  if (!account.ok) {
    logLiveSideband("rejected", { call_id: callId, reason: "account_unavailable" });
    return account.response;
  }
  if ((req.headers.get("upgrade") ?? "").trim().toLowerCase() !== "websocket") {
    return openaiError(426, "The realtime sideband requires a WebSocket upgrade.", "invalid_request_error");
  }

  const upgrade = Deno.upgradeWebSocket(req);
  void bridgeLiveSideband({ downstream: upgrade.socket, callId, accountId, accessToken: account.accessToken });
  return upgrade.response;
};
