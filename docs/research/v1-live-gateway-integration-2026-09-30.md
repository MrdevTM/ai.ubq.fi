# `/v1/live` realtime voice relay: gateway integration survey (2026-09-30)

Read-only integration survey for adding two routes to this Deno gateway: `POST /v1/live` (multipart SDP call creation,
relayed upstream) and `GET /v1/live/<call_id>` (sideband WebSocket upgrade, relayed upstream).

Method: repository inspection only, no network calls, no servers started, no test or gate runs (the orchestrator runs
gates later). Every claim below is anchored to `file:line` in checkout `/Users/nv/repos/ubiquity/ai.ubq.fi` at
2026-09-30, plus four local runtime probes recorded in §7. Facts the checkout cannot establish are tagged
**LIVE-VERIFY**.

## 1. Routing: how requests reach today's `/v1` handlers

Entry points. `serve.ts:79` builds one `createServeHandler()` at module load; `serve.ts:100-114` exports a
`Deno.ServeDefaultExport` whose `fetch` is that handler (the `--disable-admin-auth` arm only adds a loopback peer hook).
The VPS launcher calls `Deno.serve({ hostname: "127.0.0.1", port: 7999, onListen: handler.onListen }, handler.fetch)`
(`scripts/serve-vps.ts:26`); the Mac launcher calls
`Deno.serve({ hostname: "0.0.0.0", port: 7999, ... }, (request, info) => { configureAdminAuthPeerForRequest(info.remoteAddr, request); return handler.fetch(request, info); })`
(`scripts/serve-mac.ts:28-42`). Both go through `src/handler/serve-handler.ts:30-42`, which attaches a delivery
lifecycle (`info.completed` + downstream abort signal) and does not touch the response.

Dispatch. `src/handler/index.ts:267-296` is the single default handler: OPTIONS short-circuits to 204 (`272-274`),
`normalizePath` strips trailing slashes (`276-277`, implementation `src/handler/http.ts:77-84`), then ordered route
steps run in wire order — static (`279`), health (`281`), auth (`283`), admin (`285`), UOS (`287`), and finally the
terminal inference gate (`290-295`). Every step returns `Response | null`; the first non-null wins and is passed through
`withCors` (`271`, implementation `src/http.ts:52-74`).

Method and path are distinguished three ways. (a) Exact tables of `{ methods, path, run }` matched by `matchExactRoute`
(`src/handler/index.ts:74-85`; `AUTH_ROUTES` `98-102`, `ADMIN_ROUTES` `105-155`). (b) Ad-hoc regex matchers for
parameterised paths (`src/handler/index.ts:215` for `/admin/api-keys/<id>/paid-fallbacks`, `237` for
`/admin/providers/codex/<n>/recheck` — both also demonstrate the 405 reply at `217`). (c) Pure predicates plus a
dispatch table for terminal inference: `terminalRouteForRequest` (`src/handler/http.ts:155-164`) and
`kernelQuotaRouteForRequest` (`166-174`) map `method + path` to a route string, and `dispatchTerminalRoute`
(`src/handler/terminal-route.ts:503-518`) holds `[matches, run]` pairs in wire order.

Handler locations.

| Route                                 | Runner                                          | Handler                                              |
| ------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `POST /v1/responses`                  | `src/handler/terminal-route.ts:497-500`         | `handleResponses` — `src/responses-handler.ts:830`   |
| `POST /v1/chat/completions`           | `src/handler/terminal-route.ts:493-496`         | `handleChatCompletions` — `src/chat/envelope.ts:631` |
| `GET /v1/models`                      | `src/handler/terminal-route.ts:456` + `505`     | `handleModels` — `src/models/catalog.ts:54`          |
| `POST /v1/images/{generations,edits}` | `src/handler/terminal-route.ts:488-492` + `509` | `handleImages` — `src/images.ts:915`                 |

Body reading and limits. JSON bodies go through `readJsonBodyWithLimit` (`src/request.ts:101-121`) with a 32 MiB cap
(`MAX_ACCEPTED_JSON_BODY_BYTES`, `src/request.ts:7`), a `content-length` pre-check (`54-68`), and a streaming byte cap
that cancels the reader on overflow (`63-99`). Non-JSON handling does exist, in exactly one route family:
`/v1/images/edits` multipart. `parseMultipartImageEdit` (`src/images.ts:503-530`) validates the declared length
(`391-403`, cap `IMAGE_MAX_MULTIPART_BODY_BYTES = 64 MiB`, `src/images.ts:34`), reads the raw body with
`readBoundedResponseBody(new Response(req.body), { maxBytes: 64 MiB + 1, timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS, signal: req.signal })`
(`507-515`; helper `src/bounded-response-body.ts:63`, defaults 64 KiB / 1 s at `25-26`), converts it with
`new Request(req.url, { method, headers, body: bytes }).formData()` (`406-414`), and only then re-serialises to JSON for
the upstream. There is no raw-body pass-through to any upstream anywhere in `src/`.

Implication for the new routes. `isTerminalInferencePath` (`src/handler/index.ts:262-263`) already claims every `/v1/*`
path, so today `POST /v1/live` and `GET /v1/live/<id>` both fall into `handleTerminalRoute`, which authenticates first
(`src/handler/terminal-route.ts:176-180`) and then answers 404 through `dispatchTerminalRoute` (`516-517`); an
unauthenticated caller gets 401 before reaching it. Insertion must therefore happen before the gate at
`src/handler/index.ts:290`.

## 2. Upstream Codex calls and the pass-through seam

Correction to the brief: `src/codex/session.ts` does not build upstream requests. It is Codex client-session activity
telemetry (`observeCodexSession`, `src/codex/session.ts:161-221`; KV prefix `10`, TTLs `8-9`). The upstream request
builders are `src/codex/dispatch.ts` (transport + headers), `src/codex/responses-state.ts` (URL, base headers, admission
state), the credential pool in `src/codex/auth.ts`, and account selection in `src/codex/account-routing.ts`.

Base URL. `config.codexBaseUrl` (`src/config.ts:8`), from `CODEX_BASE_URL`, default
`https://chatgpt.com/backend-api/codex`, trailing slashes stripped (`src/config.ts:43`). Usage requests are
`${config.codexBaseUrl}/responses` (`src/codex/responses-state.ts:186`) and `${config.codexBaseUrl}/models`
(`src/codex/dispatch.ts:32-51`). A sibling consumer, `resolveCodexUsageResetCreditEndpoints`, refuses any base whose
layout is not `/backend-api[/codex]` or `/api/codex` (`src/codex/banked-reset-provider.ts:225-245`) — the same
fail-closed layout check a live-call path would inherit if it reuses that resolver style.

Token injection and required headers. `fetchCodexResponseWithAuth` (`src/codex/dispatch.ts:171-216`) copies caller
`baseHeaders`, then sets `Authorization: Bearer ${auth.access_token}` (`181`) and `ChatGPT-Account-ID: auth.account_id`
(`182`), issues `method: "POST"` with `redirect: "manual"` (`194-200`), and wraps the transport in a deadline controller
(`183-187`) that maps a header timeout to `CodexError("...", "gateway_timeout", 504)` (`209`) and a network fault to
`codex_upstream_unreachable` 502 (`212`). The Responses call additionally sets `originator: CODEX_ORIGINATOR`
(`"codex_cli_rs"`, `src/codex/auth.ts:16`), `user-agent` from `codexUserAgent` (`src/codex/auth.ts:58-60`),
`Content-Type: application/json`, `Accept: text/event-stream`, `conversation_id`
(`src/codex/responses-state.ts:180-190`; `applyNativeSessionHeaders` adds
`session-id`/`thread-id`/`x-client-request-id`, `src/codex/dispatch.ts:534-539`). The models call shows the same header
set without `conversation_id` (`src/codex/dispatch.ts:60-66`).

Account selection and failover. `getAuthPoolEntry(true, true)` performs the strong KV read of the credential pool
(`src/codex/auth.ts:538-555`; seed from `CODEX_AUTH_JSON_B64`, `src/config.ts:44`), `selectCodexRoutingAccountsStrong`
classifies eligible accounts (`src/codex/account-routing.ts:369-374`), and the one-account serial admission loop bounds
reselection at 3 (`src/codex/dispatch.ts:576-594`; constant `src/codex/auth.ts:23`). Routing responses and the degraded
circuit are built by `routingErrorResponse` (`224-244`) and `upstreamTimeoutCircuitResponse` (`246-252`). Provider
health is recorded by `recordCodexResponseHealth` (`100-130`: 401/403 `auth_invalid`, 429 `quota_exhausted` + capacity
sample, 5xx `upstream_error`, 2xx success) — it is called by the attempt loop, not inside `fetchCodexResponseWithAuth`,
so any new caller must invoke it explicitly, exactly as `src/codex/experiment.ts:299-300` does. Routing telemetry goes
through `logCodexRouting` (`482-491`).

Response propagation. Because every upstream call uses `redirect: "manual"`, an upstream `Location` arrives untouched in
the returned `Response`. Header rewrites downstream are additive: `withRequestId` copies headers into a new `Headers`
(`src/handler/http.ts:86-94`) and `withCors` copies plus sets CORS/gateway headers (`src/http.ts:52-74`), so an upstream
`Location` survives both — but no code in `src/` reads, rewrites, or whitelists it (no `Location` reference outside
unrelated "location" strings). Note `EXPOSED_RESPONSE_HEADERS` (`src/http.ts:7-22`) does not list `Location`, so a
browser client could not read it from a cross-origin response without that list changing.

Smallest reuse seam.
`fetchCodexResponseWithAuth(auth, url, serializedBody, baseHeaders, signal?, beforeTransport?, onDispatch?)` is exported
(`src/codex/dispatch.ts:609`) and is already called with a caller-chosen URL and header set by the cache-scope
experiment (`src/codex/experiment.ts:255-300`), which is the closest existing precedent for a non-`/responses` upstream
POST with Codex auth. For a multipart SDP relay it can be reused as-is when the body is passed as a text string (a
`multipart/form-data` SDP envelope is ASCII/UTF-8 text; boundaries and CRLFs survive a latin1/UTF-8 round-trip) with the
inbound `Content-Type` (including `boundary`) placed in `baseHeaders`. Two constraints of that helper matter: it accepts
a `string`, so a binary-safe body would require either an optional `BodyInit` parameter or a small
`src/live/upstream.ts` sibling that mirrors `171-216`, and its 30-minute `BUFFERED_INFERENCE_DEADLINE_MS` header
deadline (`src/inference-deadline.ts:34-35`) is generous for a call-creation POST but is the only bound the helper
applies.

## 3. WebSocket feasibility

Current serving model. There is no `Deno.upgradeWebSocket` use anywhere in `src/`, `serve.ts`, or the launchers; the
only WebSocket traffic is the outbound Codex supervisor client, which lazily loads the `ws` npm package
(`src/codex/supervisor-transport.ts:1`, `68-72`) and connects with
`new WebSocket(url, { headers, perMessageDeflate: false, maxPayload, handshakeTimeout })` (`112-118`);
`"ws": "npm:ws@8.18.3"` is in the import map (`deno.json`, imports block). Routing is unchanged by HTTP framing: both
launchers pass the same `fetch` into `Deno.serve`, so an upgraded request is visible to `src/handler/index.ts:267` like
any other.

Runtime capability, verified locally on `deno 2.9.7 (stable, release, aarch64-apple-darwin)` (§7 probes).
`Deno.upgradeWebSocket` exists; the returned response has `status: 101`, `body === null`, and carries Deno-internal own
symbols including `Symbol([[associated_ws]])`; `Response.prototype` has no `webSocket` member. The bundled type docs
state the contract literally: "The original request must be responded to with the returned response for the websocket
upgrade to be successful" (`deno types`, `upgradeWebSocket` doc block). A reconstructed
`new Response(up.response.body, { status: 101, headers })` succeeds as an HTTP object but has no associated socket, so
every existing response decorator — `withCors` (`src/http.ts:52-74`), `withRequestId` (`src/handler/http.ts:86-94`),
`withTerminalRequestLog` (`src/handler/terminal-log.ts:229`) — destroys the upgrade if applied to it.
`UpgradeWebSocketOptions` exposes only `protocol?` and `idleTimeout?` (default 30 s ping/pong; `0` disables), so a 101
response cannot carry a gateway request id or CORS header through that option; a probe confirmed extra headers passed to
`upgradeWebSocket` are ignored. Also from the same docs: "If the request body is disturbed (read from) before the
upgrade is completed, upgrading fails" — the sideband handler must not read `req.body` (or run the body-reading paths)
before upgrading.

What an upstream bridge requires. A downstream `Deno.upgradeWebSocket(req)` socket plus an upstream client socket, with
message/close/error relayed both ways and backpressure handled. The browser-shaped global `WebSocket` client cannot set
handshake headers, so upstream Codex auth (`Authorization` + `ChatGPT-Account-ID`) needs the `ws` npm client already in
the import map, following `src/codex/supervisor-transport.ts:112-118`. Client authentication on the downstream side is
the harder constraint: `authenticateClient` sources the bearer token from the `Authorization` header
(`src/auth/index.ts:345-350`; parser `src/http.ts:126-137`) with a passkey-cookie fallback when no bearer is present
(`src/auth/index.ts:256-274`), so a Codex-CLI-style client can send a header while a browser client can only send
cookies (WebSocket constructor takes a URL and subprotocols, not headers) — that is an auth-surface decision for the
orchestrator, not something this survey picks.

Ops and proxy path. Origin: `ops/Caddyfile` serves `ai.ubq.fi` with a Cloudflare Origin CA cert and
`reverse_proxy 127.0.0.1:7999 { flush_interval -1 }`; `ops/caddy-ai-ubq-fi.conf` is the Caddy systemd drop-in that
bind-mounts `ops/` read-only. No websocket-specific directive exists, and none is expected: an upgrade request is an
ordinary proxied request, and `flush_interval -1` disables response buffering. Service unit: `ops/ai-ubq-fi.service`
runs
`/usr/local/bin/deno run --frozen --env-file=.env --unstable-kv --allow-env --allow-net --allow-read=<root> --allow-write=<root>/.data <release>/scripts/serve-vps.ts`;
the Mac launch agent is `ops/com.ubiquity.ai.local.plist` (same flags, `scripts/serve-mac.ts`, `0.0.0.0:7999`, loopback
peers get the passwordless local development principal via `src/auth/local-admin.ts`). DNS/proxy: the proxied
`ai.ubq.fi` A record and the no-script Worker exclusion route are **not** in `ops/` as code — they are documented only
in prose at `ops/README.md:75-78` and live in the Cloudflare dashboard; both are required and must remain unchanged.
Whether the Cloudflare-proxied record passes WebSocket upgrades for this hostname and whether the VPS Deno build matches
the Mac's 2.9.7 are both **LIVE-VERIFY** (a real upgrade through `wss://ai.ubq.fi` and a `/health` identity check at the
time of the change).

## 4. Tests and gates

Layout and conventions. Tests are flat in `tests/` (169 files, hyphenated `*.test.ts`) plus `ops/tests/` for deployment
guards. Suites are split by task in `deno.json`: `test`, `test:vps`, `test:measurement`, `test:stress`, `test:e2e`,
`sentinel:test-local`. Route-level tests use three patterns, all of them reusable here:

1. Real loopback HTTP end-to-end with the production handler and a controlled upstream —
   `tests/oss-gateway-http.test.ts:362`, `488`, `662`, `806`; the file header (`19-46`) documents the hermetic setup:
   one task-owned loopback upstream, real `createServeHandler`, real KV (`:memory:`), no paid provider, and a
   `Deno.permissions.query({ name: "net", host: "127.0.0.1" })` guard.
2. Handler-level HTTP with a stub handler and real client — `tests/serve-delivery-http.test.ts:34`, which drives
   `createServeHandler(async (request, delivery) => ...)` and asserts delivery/cancellation; timeouts and deadlines are
   replaced through exported `...ForTest` setters (`src/inference-deadline.ts` tail) rather than mocks.
3. Direct `handler/index.ts` import against intercepted upstreams — `tests/codex-serial-routing-http.test.ts:112`
   (`const { default: handler } = await import("../src/handler/index.ts")`), with a documented `fetchInputUrl` helper
   and disposable in-memory KV; this is the closest template for a route that relays to an upstream. Multipart-shaped
   route tests live in `tests/images.test.ts` (`:192`, `:246`, `:311`, `:329`, `:435`) and build real multipart bodies,
   which is the pattern for an SDP POST test.

Gate. `sh scripts/verify.sh` (`scripts/verify.sh:1-45`) runs, and reports all failures rather than stopping early:
`deno types`, Prettier `--check .`, ESLint (`tools/eslint.config.mjs`), knip, the file-size ratchet, `deno fmt --check`,
`deno lint`, `deno task build`, the VPS deploy-guard tests, release retention, `deno task test`, and the sentinel-local
suite. Repository policy for these gates is `AGENTS.md` ("Lint, Format and Type Gates").

File-size ratchet. `scripts/file-size-ratchet.ts` caps source files at 1000 lines and tests at 1500
(`SOURCE_CAP`/`TEST_CAP`, script header) with per-file ceilings in `file-size-baseline.json` — currently `{}`, i.e. no
grandfathered debt and no file may cross a cap. Current sizes: `src/images.ts` 934 (near the cap, so multipart live code
must not extend it), `src/handler/index.ts` 296, `src/handler/terminal-route.ts` 555, `src/handler/http.ts` 185,
`src/responses-handler.ts` 830, `src/codex/dispatch.ts` 623, `src/codex/auth.ts` 583, `src/auth/index.ts` 777. New code
belongs in new files; growth of an existing file must stay under 1000.

Formatting ownership. Prettier owns `*.ts` (`printWidth: 160`), `deno fmt` owns Markdown/JSON/CSS/HTML (`deno.json`
`fmt.exclude` lists `**/*.ts`, `**/*.mjs`); `deno fmt` is the writer for this document, which is why this file must not
be Prettier-formatted.

## 5. Concrete integration sketch

Proposed layout (new directory, names follow existing conventions: one concern per file, `handle...` exports, pure
matchers beside the handler).

| File                   | Contents                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/live/routes.ts`   | Pure matcher: `liveRouteForRequest(method, path)` → `{ kind: "calls" } \| { kind: "sideband"; callId: string } \| null`, in the style of `terminalRouteForRequest` (`src/handler/http.ts:155-164`); regex `^\/v1\/live\/([^/]+)$` with `decodeURIComponent`, mirroring `src/handler/index.ts:215-226`.              |
| `src/live/calls.ts`    | `handleLiveCallCreate(req, deps)`: `authenticateClient`, bounded body read (reuse `readBoundedResponseBody`, `src/bounded-response-body.ts:63`, or `readJsonBodyWithLimit`-style streaming read), upstream POST, then relay the upstream body and `Location` with CORS + `x-uos-request-id`.                        |
| `src/live/sideband.ts` | `handleLiveSideband(req, callId, deps)`: `authenticateClient` **before** any body access, `Deno.upgradeWebSocket(req, { idleTimeout })`, lazy `ws` upstream dial, bidirectional relay, close/error propagation, and `recordCodexResponseHealth`-style observability hooks.                                          |
| `src/live/upstream.ts` | Upstream URL construction from `config.codexBaseUrl` (fail-closed on an unknown layout, following `src/codex/banked-reset-provider.ts:225-245`), Codex account choice (`getAuthPoolEntry` + `selectCodexRoutingAccountsStrong`), thin wrapper over `fetchCodexResponseWithAuth`, and the `ws` dial options builder. |
| `src/live/types.ts`    | Test seams only if needed (`Deps` with `dispatch`/`upgrade`/`now` overrides); fold into the files above if unused.                                                                                                                                                                                                  |

Routing insertion points, in preference order.

1. Preferred (keeps the upgrade response untouched and keeps live calls out of the inference quota machinery): in
   `src/handler/index.ts`, between the UOS step (`src/handler/index.ts:287-288`) and the terminal gate
   (`src/handler/index.ts:290`), add a live step that returns its response **directly**, without the `withCors` wrapper
   used by the other steps, e.g.
   `const liveResponse = await handleLiveRoute(req, path, delivery, requestId); if (liveResponse) return liveResponse;`.
   `handleLiveRoute` applies `withCors`/`withRequestId` itself to the `POST /v1/live` response and returns the raw
   `up.response` for the upgrade.
2. Alternative if the orchestrator wants live calls metered and admission-controlled: run `POST /v1/live` through the
   terminal route by adding a runner beside `runResponsesRoute` (`src/handler/terminal-route.ts:497-500`) and one
   `[req.method === "POST" && path === "/v1/live", runLiveCallRoute]` entry to the table at
   `src/handler/terminal-route.ts:504-512`, plus matching entries in `terminalRouteForRequest`
   (`src/handler/http.ts:155-164`), `kernelQuotaRouteForRequest` (`166-174`), and `ADMISSION_ROUTES`
   (`src/handler/admission.ts:26-34`) — four edit points, and the sideband upgrade still needs insertion point 1 because
   `withTerminalRequestLog` rebuilds the response (`src/handler/terminal-log.ts:229`).

Reuse versus add. Reuse `authenticateClient` (`src/auth/index.ts:345`), `withCors`/`withRequestId` (`src/http.ts:52`,
`src/handler/http.ts:86`), `openaiError` (`src/http.ts:93`), `notFound` (`src/http.ts:117`), `normalizePath`
(`src/handler/http.ts:77`), `readBoundedResponseBody` (`src/bounded-response-body.ts:63`), `fetchCodexResponseWithAuth`
(`src/codex/dispatch.ts:171`), `getAuthPoolEntry` (`src/codex/auth.ts:538`), `selectCodexRoutingAccountsStrong`
(`src/codex/account-routing.ts:369`), `codexUserAgent`/`CODEX_ORIGINATOR` (`src/codex/auth.ts:58`/`16`),
`recordCodexResponseHealth` (`src/codex/dispatch.ts:100`), `logCodexRouting` (`src/codex/dispatch.ts:482`), and the `ws`
import (`deno.json`). Add: the `src/live/` modules, the one dispatch step at `src/handler/index.ts:290`, `Location` in
`EXPOSED_RESPONSE_HEADERS` (`src/http.ts:7-22`) if a browser client must read it, and tests
`tests/live-calls-http.test.ts` + `tests/live-sideband-http.test.ts` modelled on
`tests/codex-serial-routing-http.test.ts:112` and `tests/oss-gateway-http.test.ts:362`.

Open risks, each with the evidence that produced it.

- Upstream live route is unknown. No `realtime`, `sideband`, `sdp`, or `call_id` (voice) reference exists in `src/`,
  `docs/`, `ops/`, or `tests/`; the checkout cannot name the v1 path or method this relay must call. This is the first
  thing to pin, and `config.codexBaseUrl` (default `https://chatgpt.com/backend-api/codex`, `src/config.ts:43`) may not
  be the right origin for a live API at all.
- Upgrade response decorators. Any `new Response(...)` around the 101 loses the associated socket (§3), so the live step
  must bypass `withCors` at `src/handler/index.ts:271` and the terminal wrapper — a deliberate deviation from the file's
  uniform pattern that must be commented where it happens.
- No headers on the 101. `UpgradeWebSocketOptions` is `{ protocol?, idleTimeout? }` only, and extra headers are ignored
  in 2.9.7, so `x-uos-request-id`/CORS cannot be attached to the handshake; the client id must travel on the accepted
  socket or the URL.
- Request-body access before upgrade fails the handshake ("If the request body is disturbed ... upgrading fails"), so
  `authenticateClient` must run first and no shared body helper may touch `req.body` on this path.
- Idle ping default 30 s (`UpgradeWebSocketOptions.idleTimeout`) will close a quiet sideband unless chosen deliberately;
  `0` disables. Session lifetime also interacts with `createServeHandler`'s `info.completed` handoff
  (`src/handler/serve-handler.ts:30-42`), which today is keyed to HTTP response delivery, not to a live socket.
- Body cap and limits. There is no multipart pass-through precedent; the closest cap is 64 MiB for image edits
  (`src/images.ts:34`), while the JSON cap is 32 MiB (`src/request.ts:7`) and the generic upstream-body read defaults to
  64 KiB / 1 s (`src/bounded-response-body.ts:25-26`). An SDP offer is small, so a tight cap (with a `413` in the
  `openaiError` shape) is the safe default; streaming the request body upstream is only needed if the orchestrator wants
  large bodies, and nothing in the repo does that today.
- `Location` rewriting. `redirect: "manual"` (`src/codex/dispatch.ts:198`) preserves whatever upstream returns, but if
  upstream returns an absolute `chatgpt.com` URL, clients cannot follow it through this gateway; whether the gateway
  rewrites `Location` to its own origin (and how it maps the returned call id) is an integration decision with no
  precedent in the repo.
- Account selection cost and side effects. Reusing `getAuthPoolEntry(true, true)` + `selectCodexRoutingAccountsStrong`
  gives correct credential choice but performs a strong KV read and routing classification per call, and
  `recordCodexResponseHealth` will feed capacity sampling for the new route (`src/codex/dispatch.ts:100-130`) —
  deliberate, but it means live calls become capacity observations.
- Metering is absent for the new route unless insertion point 2 is chosen; with insertion point 1, `POST /v1/live`
  consumes no API-key quota reservation and writes no terminal log line, which is a policy decision, not an accident.
- Cloudflare/Caddy/Deno-version pass-through is unproven in-repo (LIVE-VERIFY): `ops/README.md:75-78` documents the
  proxied record and Worker exclusion prose only, `ops/Caddyfile` has no websocket directive (auto-upgrade assumed), and
  the VPS Deno build is `/usr/local/bin/deno` with no version pin (`ops/ai-ubq-fi.service`).
- Browser authentication is unresolved: `authenticateClient` is bearer-first (`src/auth/index.ts:345-350`) and
  `Access-Control-Allow-Headers` (`src/http.ts:43-44`) does not include a websocket-specific mechanism; a browser
  sideband therefore depends on the passkey-cookie path (`src/auth/index.ts:256-274`).

## 6. Verification performed

Read-only: `pwd` confirmed `/Users/nv/repos/ubiquity/ai.ubq.fi`; all citations read from the working tree; `grep` sweeps
for `upgradeWebSocket`/`WebSocket`, `Location`, `sdp`/`realtime`/`sideband`/`call_id`, `codexBaseUrl`,
`originator`/`ChatGPT-Account-ID`, `arrayBuffer()`/`formData()`/`content-length`; `wc -l` on candidate files;
`cat file-size-baseline.json` (`{}`). No network calls, no servers, no test or gate runs, no edits outside this
document.

Runtime probes (four `deno eval` one-liners, no server started): `Deno.upgradeWebSocket` exists and accepts a synthetic
upgrade `Request`, returning a response with `status: 101`, `body === null`, and own symbols including
`Symbol([[associated_ws]])`; `new Response(up.response.body, { status: 101, headers })` yields a 101 with no associated
socket; `UpgradeWebSocketOptions` rejects an unknown property at type level and ignores an extra `headers` option at
runtime; `deno types` doc blocks quote the "must be responded to with the returned response" contract and the
`idleTimeout` default of 30 seconds.

## 7. Notes for the orchestrator (decisions this survey does not make)

Which upstream origin and path serves the live API, and whether `config.codexBaseUrl` is reused or a new configuration
key is introduced; whether live calls are metered/admitted through the terminal route (insertion point 2) or stay
outside it (insertion point 1); which downstream auth a browser sideband uses; whether `Location` is rewritten to the
gateway origin; and the body cap for `POST /v1/live`. `AGENTS.md` requires approval before adding a product environment
variable, which is the constraint on the first of these.
