import assert from "node:assert/strict";
import type { WebSocket as UpstreamClient } from "ws";
import { CountingKv } from "./helpers/counting-kv.ts";
import { CODEX_REFRESH_TOKEN_URL } from "../src/codex/auth.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, CodexAuthState } from "../src/types.ts";
import { sha256Base64Url } from "../src/utils.ts";

// Hermetic loopback proof for the `GET /v1/live/<call_id>` sideband: the real
// production handler, a disposable in-memory KV, a seeded Codex auth pool, and
// one task-owned loopback WebSocket upstream standing in for the realtime API.
// No production data and no real upstream is touched.
const loopbackPermission = await Deno.permissions.query({ name: "net", host: "127.0.0.1" });

// The narrow `--allow-env` allowlist this suite runs under denies the
// `WS_NO_BUFFER_UTIL` read that `ws/lib/buffer-util.js` performs while the
// module is evaluated, in the gateway's lazy import as much as in this file's.
// `process.env` is replaced with an inert view for this test worker only, so
// `ws` falls back to its JavaScript buffer implementation; the transport itself
// stays the real `ws` client over real loopback TCP.
Object.defineProperty(process, "env", {
  value: new Proxy({}, { get: () => undefined, has: () => false, ownKeys: () => [], getOwnPropertyDescriptor: () => undefined }),
  configurable: true,
  writable: true,
});

const ACCOUNT_A = "live-sideband-http-account-a";
const GONE_ACCOUNT = "live-sideband-http-account-gone";
const KEY_ID = "live-sideband-http-key";
const KEY_ID_B = "live-sideband-http-key-b";
/** The principal the fixture's first API key resolves to; the mapping records it. */
const PRINCIPAL = `api-key:${KEY_ID}`;
const CALL_ID = "rtc_live_sideband_http";
const LEGACY_CALL_ID = "rtc_live_sideband_legacy";
const GONE_ACCOUNT_CALL_ID = "rtc_live_sideband_gone_account";
const UNKNOWN_CALL_ID = "rtc_live_sideband_unknown";
const CLIENT_FRAME = JSON.stringify({ type: "input_audio.append", audio: "AAAA" });
const UPSTREAM_FRAME = JSON.stringify({ type: "output_audio.delta", audio: "BBBB" });

const codexAccount = (accountId: string, nowMs: number): CodexAuthState => ({
  account_id: accountId,
  access_token: `${accountId}-access-token`,
  refresh_token: `${accountId}-refresh-token`,
  updated_at_ms: nowMs,
});

const encodeBase64Url = (value: unknown): string =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/={1,2}$/u, "");

/** A decodable JWT-shaped token; only `exp` matters to the refresh decision. */
const jwtLike = (payload: unknown): string => `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url(payload)}.signature`;

/** A credential whose JWT expiry is already past, so the coordinated path must refresh it. */
const expiredCodexAccount = (accountId: string): CodexAuthState => ({
  account_id: accountId,
  access_token: jwtLike({ exp: Math.floor((Date.now() - 60_000) / 1_000) }),
  refresh_token: `${accountId}-refresh-token`,
  updated_at_ms: Date.now(),
});

/** The synthetic credential pair each controlled refresh answer carries a unique index in. */
const REFRESH_ACCESS_TOKEN = "live-sideband-refreshed-access-token";
const REFRESH_REFRESH_TOKEN = "live-sideband-refreshed-refresh-token";

type RefreshCall = Readonly<{ url: string; refreshToken: string | null; index: number }>;

type RefreshResponder = (call: RefreshCall) => Response;

type SidebandFixtureOptions = Readonly<{ accounts?: readonly CodexAuthState[] }>;

const seedApiKey = async (kv: CountingKv, keyId: string, name: string, token: string, nowMs: number): Promise<void> => {
  const tokenHash = await sha256Base64Url(token);
  const commonPolicy = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: nowMs + 60 * 60_000,
    window_ms: 60 * 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  } satisfies Omit<ApiKeyHashRecord, "id">;
  const keyRecord: ApiKeyRecord = {
    id: keyId,
    name,
    prefix: token.slice(0, 10),
    hash: tokenHash,
    created_at_ms: nowMs,
    ...commonPolicy,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: nowMs,
  };
  await kv.set(["ubq_ai", "api_keys", "id", keyRecord.id], keyRecord);
  await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], { id: keyRecord.id, ...commonPolicy } satisfies ApiKeyHashRecord);
};

type UpstreamSideband = {
  path: string;
  headers: Headers;
  socket: WebSocket;
  messages: string[];
  closed: { code: number; reason: string } | null;
};

type SidebandFixture = {
  readonly kv: CountingKv;
  readonly token: string;
  readonly tokenB: string;
  readonly gatewayWsBaseUrl: string;
  readonly upstreamSidebands: UpstreamSideband[];
  readonly refreshCalls: RefreshCall[];
  waitForUpstreamSideband: (index?: number) => Promise<UpstreamSideband>;
  setRefreshResponder: (responder: RefreshResponder) => void;
  setAuthPool: (accounts: readonly CodexAuthState[]) => Promise<void>;
  close: () => Promise<void>;
};

const startSidebandFixture = async (options: SidebandFixtureOptions = {}): Promise<SidebandFixture> => {
  const { setKvForTest } = await import("../src/kv.ts");
  const { resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
  const { resetCodexAccountRoutingForTest } = await import("../src/codex/account-routing.ts");
  const { default: handler } = await import("../src/handler/index.ts");
  const { createServeHandler } = await import("../src/handler/serve-handler.ts");
  const { setLiveUpstreamBasesForTest } = await import("../src/live/upstream.ts");
  const { config } = await import("../src/config.ts");

  const kv = new CountingKv();
  const upstreamSidebands: UpstreamSideband[] = [];
  const openSidebands: WebSocket[] = [];
  const refreshCalls: RefreshCall[] = [];
  let activeRefreshResponder: RefreshResponder = (call) =>
    Response.json({ access_token: `${REFRESH_ACCESS_TOKEN}-${call.index}`, refresh_token: `${REFRESH_REFRESH_TOKEN}-${call.index}` });
  const originalDeployFlag = config.isDeploy;
  const originalInfo = console.info;
  const originalWarn = console.warn;

  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  console.info = () => {};
  console.warn = () => {};
  // A loopback caller would otherwise receive the passwordless local principal
  // instead of an API key decision, which would hide the 401 arm.
  (config as { isDeploy: boolean }).isDeploy = true;

  const now = Date.now();
  const accounts = options.accounts ?? [codexAccount(ACCOUNT_A, now)];
  await kv.set(["ubq_ai", "codex_auth"], { accounts, updated_at_ms: now });
  await kv.set(
    ["uos_ai", "codex_live_calls", "v1", CALL_ID],
    { account_id: ACCOUNT_A, principal_id: PRINCIPAL, created_at_ms: now },
    { expireIn: 60 * 60_000 }
  );
  // A record written before principal binding: no `principal_id`, so no join
  // can ever be authorized against it.
  await kv.set(["uos_ai", "codex_live_calls", "v1", LEGACY_CALL_ID], { account_id: ACCOUNT_A, created_at_ms: now }, { expireIn: 60 * 60_000 });
  // A mapping whose account left the pool: the join must fail closed.
  await kv.set(
    ["uos_ai", "codex_live_calls", "v1", GONE_ACCOUNT_CALL_ID],
    { account_id: GONE_ACCOUNT, principal_id: PRINCIPAL, created_at_ms: now },
    { expireIn: 60 * 60_000 }
  );
  const token = `u_${"d".repeat(64)}`;
  const tokenB = `u_${"e".repeat(64)}`;
  await seedApiKey(kv, KEY_ID, "Live sideband HTTP key", token, now);
  await seedApiKey(kv, KEY_ID_B, "Live sideband HTTP key B", tokenB, now);

  // The refresh URL is a module constant, so the fixture redirects that exact
  // URL to a real loopback endpoint; no production refresh code or upstream
  // auth server is involved.
  const refreshServer = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    const call: RefreshCall = {
      url: request.url,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      index: refreshCalls.length + 1,
    };
    refreshCalls.push(call);
    return activeRefreshResponder(call);
  });
  const refreshEndpointUrl = `http://127.0.0.1:${(refreshServer.addr as Deno.NetAddr).port}/oauth/token`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let target: string;
    if (typeof input === "string") target = input;
    else if (input instanceof URL) target = input.href;
    else target = input.url;
    return originalFetch(target === CODEX_REFRESH_TOKEN_URL ? refreshEndpointUrl : input, init);
  };

  const upstreamServer = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (request) => {
    const url = new URL(request.url);
    if (url.pathname !== `/v1/live/${CALL_ID}`) return new Response("not found", { status: 404 });
    // The upgraded request is closed once its response is returned, so its
    // headers must be copied while the handshake is still in scope.
    const record: UpstreamSideband = {
      path: url.pathname,
      headers: new Headers(request.headers),
      socket: null as unknown as WebSocket,
      messages: [],
      closed: null,
    };
    const upgrade = Deno.upgradeWebSocket(request);
    record.socket = upgrade.socket;
    openSidebands.push(upgrade.socket);
    upgrade.socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") record.messages.push(event.data);
    };
    upgrade.socket.onclose = (event: CloseEvent) => {
      record.closed = { code: event.code, reason: event.reason };
    };
    upstreamSidebands.push(record);
    return upgrade.response;
  });
  setLiveUpstreamBasesForTest({
    callsBaseUrl: null,
    sidebandBaseUrl: `ws://127.0.0.1:${(upstreamServer.addr as Deno.NetAddr).port}/v1/live`,
  });

  const gatewayServer = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, createServeHandler(handler));

  return {
    kv,
    token,
    tokenB,
    gatewayWsBaseUrl: `ws://127.0.0.1:${(gatewayServer.addr as Deno.NetAddr).port}/v1/live`,
    upstreamSidebands,
    refreshCalls,
    waitForUpstreamSideband: async (index = 0) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const sideband = upstreamSidebands.at(index);
        if (sideband !== undefined) return sideband;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the gateway never dialed the upstream sideband");
    },
    setRefreshResponder: (next) => {
      activeRefreshResponder = next;
    },
    setAuthPool: async (nextAccounts) => {
      await kv.set(["ubq_ai", "codex_auth"], { accounts: nextAccounts, updated_at_ms: Date.now() });
    },
    close: async () => {
      for (const socket of openSidebands) {
        try {
          socket.close();
        } catch {
          // The sideband already ended.
        }
      }
      console.info = originalInfo;
      console.warn = originalWarn;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
      globalThis.fetch = originalFetch;
      setLiveUpstreamBasesForTest({ callsBaseUrl: null, sidebandBaseUrl: null });
      setKvForTest(null);
      resetCodexAuthCacheForTest();
      resetCodexAccountRoutingForTest();
      await gatewayServer.shutdown();
      await upstreamServer.shutdown();
      await refreshServer.shutdown();
    },
  };
};

/** A non-101 handshake is surfaced as its HTTP status rather than a socket error. */
class SidebandHandshakeError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`sideband handshake answered ${status}`);
    this.name = "SidebandHandshakeError";
    this.status = status;
  }
}

const loadClientConstructor = async (): Promise<typeof UpstreamClient> => {
  const module: unknown = await import("ws");
  const candidate = (module as { default?: unknown }).default;
  assert.equal(typeof candidate, "function");
  return candidate as typeof UpstreamClient;
};

const connectSideband = async (url: string, headers: Record<string, string> = {}): Promise<UpstreamClient> => {
  const CLIENT_CONSTRUCTOR = await loadClientConstructor();
  return await new Promise<UpstreamClient>((resolve, reject) => {
    const socket = new CLIENT_CONSTRUCTOR(url, { headers, perMessageDeflate: false });
    socket.on("open", () => {
      resolve(socket);
    });
    socket.on("unexpected-response", (_request, response) => {
      reject(new SidebandHandshakeError(response.statusCode ?? 0));
    });
    socket.on("error", (error: Error) => {
      reject(error);
    });
  });
};

const nextFrame = (socket: UpstreamClient, timeoutMs = 5_000): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for a sideband frame"));
    }, timeoutMs);
    socket.once("message", (data: unknown) => {
      clearTimeout(timer);
      resolve(String(data));
    });
  });

const nextClose = (socket: UpstreamClient, timeoutMs = 5_000): Promise<{ code: number; reason: string }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for a sideband close"));
    }, timeoutMs);
    socket.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });

/**
 * A raw sideband client hosted in a Worker. The worker owns its own event loop,
 * so it puts its first frame on the wire the moment it observes the gateway's
 * 101 - while the gateway itself is still loading the upstream WebSocket client.
 * Frames, the handshake, and client-side masking are all real bytes on loopback.
 */
const rawSidebandWorkerSource = (url: string, headers: Readonly<Record<string, string>>, frames: readonly string[]): string => `
const target = new URL(${JSON.stringify(url)});
const headers = ${JSON.stringify(headers)};
const frames = ${JSON.stringify(frames)};
const maskedTextFrame = (text, seed) => {
  const payload = new TextEncoder().encode(text);
  const mask = new Uint8Array([(seed >>> 24) & 0xff, (seed >>> 16) & 0xff, (seed >>> 8) & 0xff, seed & 0xff]);
  const frame = new Uint8Array(2 + 4 + payload.byteLength);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.byteLength;
  frame.set(mask, 2);
  for (let index = 0; index < payload.byteLength; index += 1) frame[6 + index] = payload[index] ^ mask[index % 4];
  return frame;
};
const requestHead = [
  "GET " + target.pathname + " HTTP/1.1",
  "Host: " + target.host,
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: " + btoa("live-sideband-r"),
  "Sec-WebSocket-Version: 13",
  ...Object.entries(headers).map(([name, value]) => name + ": " + value),
].join("\\r\\n");
const conn = await Deno.connect({ hostname: target.hostname, port: Number(target.port) });
await conn.write(new TextEncoder().encode(requestHead + "\\r\\n\\r\\n"));
const decoder = new TextDecoder();
const buffer = new Uint8Array(2048);
let response = "";
while (!response.includes("\\r\\n\\r\\n")) {
  const read = await conn.read(buffer);
  if (read === null) break;
  response += decoder.decode(buffer.subarray(0, read), { stream: true });
}
self.postMessage({ event: "upgraded", status: response.split("\\r\\n")[0] });
const framed = frames.map((frame, index) => maskedTextFrame(frame, 0x9a2b7c4d + index));
const wire = new Uint8Array(framed.reduce((total, frame) => total + frame.byteLength, 0));
let offset = 0;
for (const frame of framed) {
  wire.set(frame, offset);
  offset += frame.byteLength;
}
await conn.write(wire);
self.postMessage({ event: "sent" });
self.onmessage = () => conn.close();
`;

type RawSidebandClient = Readonly<{ worker: Worker; waitForEvent: (event: string) => Promise<Record<string, unknown>> }>;

const startRawSidebandClient = (url: string, headers: Readonly<Record<string, string>>, frames: readonly string[]): RawSidebandClient => {
  const events: Record<string, unknown>[] = [];
  const worker = new Worker(`data:text/javascript,${encodeURIComponent(rawSidebandWorkerSource(url, headers, frames))}`, { type: "module" });
  worker.onmessage = (event: MessageEvent) => {
    events.push(event.data as Record<string, unknown>);
  };
  return {
    worker,
    waitForEvent: async (event) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const found = events.find((candidate) => candidate.event === event);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`the raw sideband client never reported ${event}`);
    },
  };
};

/** Bounded polling on the upstream fixture; no arbitrary sleep. */
const waitForUpstreamFrames = async (sideband: UpstreamSideband, expected: number): Promise<string[]> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (sideband.messages.length >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return sideband.messages;
};

const expectHandshakeStatus = async (url: string, headers: Record<string, string>, status: number): Promise<void> => {
  try {
    const socket = await connectSideband(url, headers);
    socket.close();
    assert.fail(`expected the sideband to answer ${status}`);
  } catch (error) {
    assert.ok(error instanceof SidebandHandshakeError, String(error));
    assert.equal(error.status, status);
  }
};

Deno.test({
  name: "GET /v1/live/<call_id> keeps the frames a client sends immediately after the 101, in order",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture();
    const frames = [1, 2, 3].map((seq) => JSON.stringify({ type: "input_audio.append", seq }));
    const client = startRawSidebandClient(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, frames);
    try {
      const upgraded = await client.waitForEvent("upgraded");
      assert.match(String(upgraded.status), /^HTTP\/1\.1 101 /u);
      await client.waitForEvent("sent");
      const upstream = await fixture.waitForUpstreamSideband();
      const received = await waitForUpstreamFrames(upstream, frames.length);
      assert.deepEqual(received, frames, "the upstream sideband is missing frames the client sent after the 101");
    } finally {
      client.worker.postMessage("close");
      client.worker.terminate();
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> bridges the sideband to the mapped account's upstream and relays frames both ways",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture();
    const client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    try {
      const upstream = await fixture.waitForUpstreamSideband();
      assert.equal(upstream.path, `/v1/live/${CALL_ID}`);
      assert.equal(upstream.headers.get("authorization"), `Bearer ${ACCOUNT_A}-access-token`);
      assert.equal(upstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
      assert.equal(upstream.headers.get("originator"), "codex_cli_rs");
      assert.equal(upstream.headers.get("openai-alpha"), "quicksilver=v2");
      assert.match(upstream.headers.get("user-agent") ?? "", /^codex_cli_rs\//u);

      // The client's frame reaches upstream, and the upstream's frame reaches back.
      const upstreamFrame = nextFrame(client);
      const receivedUpstream = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("upstream never received the client frame"));
        }, 5_000);
        upstream.socket.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          clearTimeout(timer);
          upstream.messages.push(event.data);
          resolve();
        };
      });
      client.send(CLIENT_FRAME);
      await receivedUpstream;
      assert.deepEqual(upstream.messages, [CLIENT_FRAME]);

      upstream.socket.send(UPSTREAM_FRAME);
      assert.equal(await upstreamFrame, UPSTREAM_FRAME);

      // A clean client close propagates to the upstream as a normal close, and
      // the gateway completes the close handshake back to the client. Both
      // listeners are armed before the close frame is sent.
      const downstreamClosed = nextClose(client);
      const upstreamClosed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("upstream never observed the close"));
        }, 5_000);
        upstream.socket.onclose = (event: CloseEvent) => {
          clearTimeout(timer);
          resolve({ code: event.code, reason: event.reason });
        };
      });
      client.close(1000, "session complete");
      assert.equal((await downstreamClosed).code, 1000);
      assert.equal((await upstreamClosed).code, 1000);
    } finally {
      try {
        client.terminate();
      } catch {
        // Already closed.
      }
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> rejects an unauthenticated upgrade without dialing upstream",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture();
    try {
      await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, {}, 401);
      assert.equal(fixture.upstreamSidebands.length, 0);
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> answers 404 for an unknown call id without dialing upstream",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture();
    try {
      await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${UNKNOWN_CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, 404);
      assert.equal(fixture.upstreamSidebands.length, 0);
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> answers 403 for a different valid principal without dialing upstream",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture();
    try {
      await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.tokenB}` }, 403);
      assert.equal(fixture.upstreamSidebands.length, 0, "an unauthorized principal never reaches the upstream");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> fails closed for a mapping with no recorded principal",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture();
    try {
      await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${LEGACY_CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, 403);
      assert.equal(fixture.upstreamSidebands.length, 0, "a legacy mapping is never joined on an unproven principal");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> lets the creating principal reconnect on the same upstream account",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture();
    try {
      const first = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
      const firstUpstream = await fixture.waitForUpstreamSideband(0);
      assert.equal(firstUpstream.headers.get("authorization"), `Bearer ${ACCOUNT_A}-access-token`);
      assert.equal(firstUpstream.headers.get("chatgpt-account-id"), ACCOUNT_A);

      const firstClosed = nextClose(first);
      first.close(1000, "reconnect");
      await firstClosed;

      const second = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
      try {
        const secondUpstream = await fixture.waitForUpstreamSideband(1);
        assert.equal(secondUpstream.path, `/v1/live/${CALL_ID}`);
        assert.equal(secondUpstream.headers.get("authorization"), `Bearer ${ACCOUNT_A}-access-token`, "the reconnect maps the same upstream account");
        assert.equal(secondUpstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
      } finally {
        second.terminate();
      }
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> refreshes the mapped account's expired token before dialing upstream",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture({ accounts: [expiredCodexAccount(ACCOUNT_A)] });
    const client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    try {
      const upstream = await fixture.waitForUpstreamSideband();
      assert.equal(
        upstream.headers.get("authorization"),
        `Bearer ${REFRESH_ACCESS_TOKEN}-1`,
        "the handshake carries the refreshed credential instead of the expired cached bearer"
      );
      assert.equal(upstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
      assert.equal(fixture.refreshCalls.length, 1, "the expired mapped account is refreshed exactly once");
      assert.equal(fixture.refreshCalls[0]?.refreshToken, `${ACCOUNT_A}-refresh-token`, "the refresh re-read the mapped account by identity");

      const storedPool = fixture.kv.entries.get(JSON.stringify(["ubq_ai", "codex_auth"]))?.value as { accounts?: CodexAuthState[] } | undefined;
      const refreshed = storedPool?.accounts?.find((account) => account.account_id === ACCOUNT_A);
      assert.equal(refreshed?.access_token, `${REFRESH_ACCESS_TOKEN}-1`, "the rotated credential is persisted under the same account identity");
      assert.equal(refreshed.refresh_token, `${REFRESH_REFRESH_TOKEN}-1`);

      const mapping = fixture.kv.entries.get(JSON.stringify(["uos_ai", "codex_live_calls", "v1", CALL_ID]))?.value;
      assert.equal((mapping as { account_id?: unknown } | undefined)?.account_id, ACCOUNT_A, "the call keeps its mapped account identity");
      assert.equal((mapping as { principal_id?: unknown } | undefined)?.principal_id, PRINCIPAL, "the creator-principal binding is preserved");
    } finally {
      client.terminate();
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> refreshes again on reconnect when the mapped credential expired again",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture({ accounts: [expiredCodexAccount(ACCOUNT_A)] });
    try {
      const first = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
      const firstUpstream = await fixture.waitForUpstreamSideband(0);
      assert.equal(firstUpstream.headers.get("authorization"), `Bearer ${REFRESH_ACCESS_TOKEN}-1`);

      const firstClosed = nextClose(first);
      first.close(1000, "reconnect");
      await firstClosed;
      assert.equal(fixture.refreshCalls.length, 1);

      // The credential expires again before the sideband reconnects, so the
      // reconnect must run the coordinated path rather than reuse the previous
      // in-memory bearer.
      await fixture.setAuthPool([expiredCodexAccount(ACCOUNT_A)]);

      const second = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
      try {
        const secondUpstream = await fixture.waitForUpstreamSideband(1);
        assert.equal(secondUpstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
        assert.equal(secondUpstream.headers.get("authorization"), `Bearer ${REFRESH_ACCESS_TOKEN}-2`, "the reconnect dispatches a newly refreshed credential");
        assert.equal(fixture.refreshCalls.length, 2, "the reconnect refreshed the expired mapped account again");
        assert.equal(fixture.refreshCalls[1]?.refreshToken, `${ACCOUNT_A}-refresh-token`);
      } finally {
        second.terminate();
      }
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "GET /v1/live/<call_id> answers 404 when the mapped account is no longer configured",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startSidebandFixture();
    try {
      await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${GONE_ACCOUNT_CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, 404);
      assert.equal(fixture.upstreamSidebands.length, 0, "a disappeared mapped account never reaches the upstream");
      assert.equal(fixture.refreshCalls.length, 0);
    } finally {
      await fixture.close();
    }
  },
});
