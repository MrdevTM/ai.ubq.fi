# Codex realtime voice client contract for an OpenAI-compatible gateway (`/v1/live`)

Scope: the exact wire contract the Rust Codex client expects from a gateway that serves the realtime voice feature when
the client's provider base URL points at that gateway (for example `https://ai.ubq.fi/v1`). This is a specification of
observed client behavior, not an implementation proposal.

Reference checkout: `lib/codex` at `60947e234156ac12bdb7fba2477d3965f166bd34` (openai/codex main, 2026-09-30). All paths
below are relative to `lib/codex` unless stated otherwise (`codex-rs/...`). Every non-obvious claim carries a
`file:line` citation.

Terminology used by the code: `v3` = `RealtimeConversationVersion::V3` = `RealtimeEventParser::FramelessBidi`; `v1` =
`RealtimeEventParser::V1`; `v2` = `RealtimeEventParser::RealtimeV2`. "AVAS" is the WebRTC call transport; "quicksilver"
is the legacy alpha codename still used in headers and query params.

## 1. Feature and configuration selection

### 1.1 What enables the feature

- Model-catalog entries are not involved. The gate is a feature flag: `Feature::RealtimeConversation`, key
  `realtime_conversation`, stage `Stable`, `default_enabled: true` (`codex-rs/features/src/lib.rs:1832-1838`). No
  realtime entries exist in the models manager (`codex-rs/models-manager/src/` has no `realtime` hits).
- The TUI additionally requires platform WebRTC support before exposing voice: `RealtimeWebrtcSession::is_supported()`
  (`codex-rs/tui/src/bottom_pane/experimental_features_view.rs:87`) and `voice_supported()` filters the feature list
  (`codex-rs/tui/src/tooltips.rs:55`).
- The TUI is the only caller that reaches the v3/frameless path: it starts realtime with
  `transport: Some(ThreadRealtimeStartTransport::Webrtc { sdp: offer_sdp })` and
  `version: Some(RealtimeConversationVersion::V3)` (`codex-rs/tui/src/app_server_session/realtime.rs:32-53`).

### 1.2 Config keys and defaults

All realtime config keys live in `codex-rs/config/src/config_toml.rs`:

| Key (TOML path)                              | Type                              | Default                                                           | Meaning                                                                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realtime.version`                           | `v1 \| v2 \| v3`                  | `v2`                                                              | Realtime wire version (`config_toml.rs:655-656`; enum default `V2` at `codex-rs/protocol/src/protocol.rs:1712-1719`)                                                                                                            |
| `realtime.type`                              | `conversational \| transcription` | `conversational`                                                  | Session mode (`config_toml.rs:657-658`, `625-629`)                                                                                                                                                                              |
| `realtime.transport`                         | `webrtc \| websocket`             | `webrtc`                                                          | Transport (`config_toml.rs:659`, `631-638`); note the in-session default when a request omits transport is `Websocket` (`codex-rs/core/src/realtime_conversation.rs:1336-1340`)                                                 |
| `realtime.voice`                             | voice name                        | `None` → version default voice                                    | Voice (`config_toml.rs:660`, `core/src/realtime_conversation.rs:1588-1602`)                                                                                                                                                     |
| `experimental_realtime_ws_base_url`          | string                            | `None`                                                            | Overrides only the realtime WS transport base URL (standalone WS and WebRTC sideband) (`config_toml.rs:431-435`)                                                                                                                |
| `experimental_realtime_webrtc_call_base_url` | string                            | `None`                                                            | Overrides only the WebRTC call-creation HTTP base URL (`config_toml.rs:436-439`)                                                                                                                                                |
| `experimental_realtime_ws_model`             | string                            | `None`                                                            | Overrides the realtime model/snapshot (`config_toml.rs:440-442`)                                                                                                                                                                |
| `experimental_realtime_ws_backend_prompt`    | string                            | `None`                                                            | Replaces the synthesized backend prompt (`config_toml.rs:447-450`)                                                                                                                                                              |
| `experimental_realtime_ws_startup_context`   | string                            | `None`                                                            | Replaces synthesized startup context; `""` disables injection (`config_toml.rs:451-454`)                                                                                                                                        |
| `experimental_realtime_start_instructions`   | string                            | `None`                                                            | Developer instructions inserted when realtime becomes active (`config_toml.rs:455-458`)                                                                                                                                         |
| `audio.microphone`, `audio.speaker`          | string                            | `None`                                                            | Machine-local device preferences (`config_toml.rs:427-429`, `663-668`)                                                                                                                                                          |
| `chatgpt_base_url`                           | string                            | `None` (provider default `https://chatgpt.com/backend-api/codex`) | Base URL for ChatGPT requests generally (`config_toml.rs:410-411`); the realtime code paths read the _model provider_ base URL and the `experimental_*` overrides, not this key (`core/src/realtime_conversation.rs:1341-1361`) |

Resolution of the `[realtime]` table into defaults happens in `codex-rs/core/src/config/mod.rs:4444-4452`.

### 1.3 Version and parser selection

- `params.version` (per-request, from app-server `thread/realtime/start`) wins; otherwise `transport == Websocket` uses
  `config.realtime.version`, and `Webrtc`/`ExistingCall` hard-code `V1` (`core/src/realtime_conversation.rs:1362-1367`).
- Version to parser mapping: V1 → `RealtimeEventParser::V1`, V2 → `RealtimeEventParser::RealtimeV2`, V3 →
  `RealtimeEventParser::FramelessBidi` (`core/src/realtime_conversation.rs:1562-1566`).
- Because `realtime.version` itself defaults to `v2`, a v3 frameless session only happens when the caller sends
  `version: v3` or config sets `[realtime] version = "v3"`. The TUI always sends `v3`
  (`tui/src/app_server_session/realtime.rs:51`).

### 1.4 Model and voice defaults

- Model: request `model` → `experimental_realtime_ws_model` → per-version default; V1/V2 default `gpt-realtime-1.5`, V3
  default `gpt-live-1-codex` (`core/src/realtime_conversation.rs:111-112`, `1552-1561`).
- Voice default for V1 and V3 is `RealtimeVoicesList::builtin().default_v1` = `Cove`
  (`core/src/realtime_conversation.rs:1604-1610`, `codex-rs/protocol/src/protocol.rs:353`); V2 default is `Marin`
  (`protocol.rs:354`). The V1/V3 allowlist is Juniper, Maple, Spruce, Ember, Vale, Breeze, Arbor, Sol, Cove
  (`protocol/src/protocol.rs:330-340`); a voice outside it is rejected before any network call
  (`core/src/realtime_conversation.rs:1612-1632`). Voice wire names are snake_case (`protocol/src/protocol.rs:268-269`,
  `291+`).
- Session id: `params.realtime_session_id` or the thread id; always `Some(...)` for new sessions
  (`core/src/realtime_conversation.rs:1592-1596`).

### 1.5 Base URLs actually used for realtime

- HTTP call creation uses the model provider's base URL, or `experimental_realtime_webrtc_call_base_url` when set
  (`core/src/realtime_conversation.rs:1354-1361`, `core/src/client.rs:684-706`). With ChatGPT auth and no override the
  provider default is `https://chatgpt.com/backend-api/codex` (`codex-rs/model-provider-info/src/lib.rs:77`, `421-439`).
- Standalone WS (`transport=websocket`) derives its URL from a provider copy whose `base_url` is replaced by
  `experimental_realtime_ws_base_url` when set (`core/src/realtime_conversation.rs:1346-1353`, `693-700`), then converts
  the scheme and normalizes the path (`codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:859-870`,
  `1160-1209`).
- WebRTC sideband uses only `experimental_realtime_ws_base_url`, else the built-in `https://api.openai.com/v1`; the
  provider base URL is ignored (`core/src/realtime_conversation.rs:1341-1352`, `methods.rs:62`, `993-1006`; test
  `methods.rs:2311-2335` asserts `wss://api.openai.com/v1/live/rtc_test` even when the provider is
  `https://chatgpt.com/backend-api/codex`).
- Consequence for a gateway: the HTTP call creation follows the provider base URL, but the sideband needs
  `experimental_realtime_ws_base_url` to point at the gateway; otherwise the client joins the call on `api.openai.com`.

## 2. Call creation request (exact bytes)

### 2.1 Method, path, query

- Method `POST` (`codex-api/src/endpoint/realtime_call.rs:88-104`, `110-125`).
- URL joining: `Provider::url_for_path` trims a trailing `/` from `base_url`, trims a leading `/` from the path, and
  concatenates with `/` (`codex-rs/codex-client/src/provider.rs:55-75`). Base `https://ai.ubq.fi/v1` + path `live` =
  `https://ai.ubq.fi/v1/live` (asserted in `realtime_call.rs:645-649`). Provider-level `query_params` are appended here
  too when configured (`provider.rs:59-73`).
- Path selection (`realtime_call.rs:66-79`):
  - frameless (V3) and base URL does **not** contain `/backend-api` → `live`;
  - V1/V2 → `realtime/calls`;
  - any parser when `provider.base_url.contains("/backend-api")` → `realtime/calls`.
- Query params (`realtime_call.rs:213-224`): added only for `V1`, or for frameless when the backend shape is in use:
  `intent=quicksilver&architecture=avas`, appended with `?` or `&` (`realtime_call.rs:238-248`). A frameless call
  against an API-shaped gateway gets **no** query params (test `realtime_call.rs:623-655`).

### 2.2 Headers on the call-creation request

Sources: provider static `http_headers`/`env_http_headers` (`model-provider-info/src/lib.rs:391-418`), the per-session
extra headers built in `core/src/realtime_conversation.rs:1409-1428`, auth headers applied by the shared auth provider,
and (WebRTC path) `x-oai-attestation`.

| Header                                               | When                                                                                                           | Evidence                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `authorization: Bearer <token>`                      | whenever the auth provider has a token (API key or ChatGPT access token)                                       | `model-provider/src/bearer_auth_provider.rs:30-36`, `model-provider/src/auth.rs:316-324`                     |
| `ChatGPT-Account-ID: <id>`                           | ChatGPT/account-scoped auth                                                                                    | `model-provider/src/bearer_auth_provider.rs:38-42`; `X-OpenAI-Fedramp: true` for FedRAMP accounts (`:44-46`) |
| `openai-alpha: quicksilver=v1`                       | V1 parser                                                                                                      | `core/src/realtime_conversation.rs:1903-1906`                                                                |
| `openai-alpha: quicksilver=v2`                       | frameless bidi (V3)                                                                                            | `core/src/realtime_conversation.rs:1907-1909`                                                                |
| `x-session-id: <session id>`                         | always (session id defaults to the thread id)                                                                  | `core/src/realtime_conversation.rs:1913-1917`, `1592-1596`                                                   |
| `session-id: <session id>`, `thread-id: <thread id>` | always                                                                                                         | `core/src/realtime_conversation.rs:1424-1427`, `codex-api/src/requests/headers.rs:5-14`                      |
| `x-codex-turn-metadata: {"thread_source":"..."}`     | when the thread has a source, ≤ 256 bytes                                                                      | `core/src/realtime_conversation.rs:95`, `1419-1428`                                                          |
| `originator: <string>`                               | only when it differs from the client's default originator                                                      | `login/src/auth/default_client.rs:125-139`                                                                   |
| `x-oai-attestation: <token>`                         | WebRTC call creation when attestation generation succeeds                                                      | `core/src/client.rs:686-689`, `core/src/attestation.rs:7`                                                    |
| `content-type`                                       | `multipart/form-data; boundary=codex-realtime-call-boundary` (API shape) or `application/json` (backend shape) | `realtime_call.rs:25`, `203-206`; `http-client/src/request.rs:234`, `270`                                    |

The standalone-WS path passes the resolved realtime API key explicitly (`core/src/realtime_conversation.rs:1411-1419`);
the WebRTC path passes `None` there and relies on the shared auth provider for both the HTTP call and the sideband
upgrade (`core/src/realtime_conversation.rs:1420-1428`, `core/src/client.rs:686-693`). The Codex user-agent is not part
of the HTTP call-creation header set; it is added on the WebSocket upgrade through `default_headers()`
(`login/src/auth/default_client.rs:456-469`).

### 2.3 Body — OpenAI/API shape (multipart, exact bytes)

Boundary is the literal `codex-realtime-call-boundary`; content type is
`multipart/form-data; boundary=codex-realtime-call-boundary` (`realtime_call.rs:25-26`). The body is hand-assembled with
CRLF (`realtime_call.rs:170-182`) and sent as a raw byte body (`realtime_call.rs:203-207`):

```
--codex-realtime-call-boundary\r\n
Content-Disposition: form-data; name="sdp"\r\n
Content-Type: application/sdp\r\n
\r\n
<SDP offer bytes>\r\n
--codex-realtime-call-boundary\r\n
Content-Disposition: form-data; name="session"\r\n
Content-Type: application/json\r\n
\r\n
<compact JSON session>\r\n
--codex-realtime-call-boundary--\r\n
```

Field order is `sdp` then `session`; the test asserting the byte-for-byte body is `realtime_call.rs:487-520`. The
session JSON is produced by `serde_json::to_string` (compact, no pretty printing) (`realtime_call.rs:166-169`), and
`session.id` is removed before encoding (`realtime_call.rs:131-134`).

### 2.4 Body — backend shape (JSON)

When `base_url.contains("/backend-api")`, the body is `serde_json` of `BackendRealtimeCallRequest { sdp, session }` →
`{"sdp":"<sdp offer>","session":{...}}` (`realtime_call.rs:39-43`, `146-163`; test `realtime_call.rs:695-745`). The
`session` object is the same JSON as the multipart `session` part (with `id` removed).

### 2.5 `session` object for the v3/frameless path

Produced by `frameless_session_json` (`codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs:53-96`),
called from `session_update_session_json` (`methods_common.rs:141-168`) and from the call-creation encoder
(`realtime_call.rs:246-249`).

| Field                   | Type                      | Required                                             | Default / notes                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`                 | string                    | present when `RealtimeSessionConfig.model` is `Some` | Always `Some` on this path (`core/src/realtime_conversation.rs:1552-1561`); wire default `gpt-live-1-codex`. Omitted only by the WS `session.update` builder when no model is passed (`methods_frameless_bidi.rs:32-43`, `70-72`)                                                                                                                                                    |
| `instructions`          | string                    | always present                                       | `experimental_realtime_ws_backend_prompt` → else request `prompt` → else built-in `BACKEND_PROMPT` with the user's first name substituted (`core/src/realtime_prompt.rs:5-24`); explicit `Some(None)` means empty string (`:15-18`); startup context is appended as `"{prompt}\n\n{startup_context}"` when `include_startup_context` (`core/src/realtime_conversation.rs:1505-1524`) |
| `audio.output.voice`    | string (snake_case voice) | always present                                       | `Cove`/`cove` for v3 (`core/src/realtime_conversation.rs:1604-1610`)                                                                                                                                                                                                                                                                                                                 |
| `delegation`            | object                    | always present                                       | `{"type":"client"}` (`methods_frameless_bidi.rs:59-77`)                                                                                                                                                                                                                                                                                                                              |
| `delegation.ack_filler` | bool                      | optional                                             | only when `delegation_ack_filler` is `Some` (`methods_frameless_bidi.rs:73-75`)                                                                                                                                                                                                                                                                                                      |
| `initial_items`         | array                     | only when non-empty                                  | each item `{"type":"message","role":"user"\|"developer"\|"assistant","content":[{"type":"input_text"\|"output_text","text":...}]}`; user/developer → `input_text`, assistant → `output_text` (`methods_frameless_bidi.rs:76-94`; tests `methods_frameless_bidi_tests.rs:52-101`)                                                                                                     |
| `id`                    | —                         | never present                                        | not emitted for frameless; `create_with_session_and_headers` also removes `id` defensively (`realtime_call.rs:131-134`)                                                                                                                                                                                                                                                              |

Fields that the _other_ versions add and frameless does not: `session.type` (`quicksilver`/`realtime`/`transcription`),
`audio.input.format` (`audio/pcm`, rate 24000), `output_modalities`, `tools`, `tool_choice`, `noise_reduction`,
`turn_detection`, `id` (`methods_v1.rs:60-95`, `methods_v2.rs:88-177`; `protocol.rs:88-130`). `session_mode` and
`output_modality` are normalized/ignored for frameless (`methods_common.rs:35-42`), and text output modality is rejected
for anything but v2 (`core/src/realtime_conversation.rs:1567-1573`).

### 2.6 Client-side validation that aborts before any request

- V2 is rejected for AVAS call creation: `invalid request: AVAS realtime calls require realtime v1 or v3`
  (`realtime_call.rs:226-236`, test `:675-693`).
- AVAS WebRTC start requires v1/v3 and `conversational` session type (`core/src/realtime_conversation.rs:1462-1481`).
- `initial_items` require v3 and are bounded to 128 items, 8192 estimated tokens per item and in total
  (`core/src/realtime_conversation.rs:104-105`, `1527-1550`).
- Start/end instructions are capped at 8192 estimated tokens each (`core/src/realtime_conversation.rs:106`,
  `1492-1502`).
- Existing-call attachment rejects any session configuration options (`core/src/realtime_conversation.rs:1374-1390`).

## 3. Response handling

- Success means any 2xx. The HTTP transport turns every non-2xx into
  `TransportError::Http { status, url, headers, body, retry_after }` (`codex-rs/http-client/src/transport.rs:185-205`),
  surfaced to the caller as `CodexErr::UnexpectedStatus` after mapping (`codex-api/src/api_bridge.rs:91-110`).
- Retries: the model provider retry config is `retry_429: false`, `retry_5xx: true`, `retry_transport: true`, max
  attempts from the provider config (`model-provider-info/src/lib.rs:447-453`); the retry decision is in
  `codex-client/src/retry.rs:22-35` and the loop in `:94-124`. Sideband call-creation retries use the same policy
  through `EndpointSession::execute_with` (`codex-api/src/endpoint/session.rs:99-135`).
- Redirects: the configured-provider route uses `ClientRedirectPolicy::Default` (follow)
  (`core/src/client.rs:1060-1064`), downgraded to `Reject` only when the provider carries account-routing headers
  (`core/src/client.rs:1188-1195`). A 3xx therefore will not be observed as a `Location`-bearing response by the client.
- SDP answer: the **entire** response body is decoded as UTF-8 and used verbatim as the answer SDP
  (`realtime_call.rs:251-256`). No validation, no JSON envelope, no multipart parsing.
- Call id: taken from the `Location` response header (`realtime_call.rs:259-275`). Missing header →
  `stream error: realtime call response missing Location`; a `Location` with no acceptable segment →
  `stream error: realtime call Location does not contain a call id: <location>` (`realtime_call.rs:260-275`; tests
  `:748-795`).
- `Location` parsing rules (`realtime_call.rs:259-291`): the query string is discarded at the first `?`; the remainder
  is split on `/`; the _rightmost_ segment satisfying one of these is used:
  - starts with `rtc_` and has at least one more character, or
  - is exactly 36 characters in 8-4-4-4-12 hex form (UUID). Accepted examples from tests: `/v1/realtime/calls/rtc_test`
    → `rtc_test`; `/v1/realtime/calls/calls/rtc_backend_test` → `rtc_backend_test`; `/v1/live/rtc_frameless` →
    `rtc_frameless`; `/v1/realtime/calls/019eb97d-8e9a-7ff3-94b0-ea019babd5d7` → that UUID (`realtime_call.rs:435-470`,
    `623-655`, `675-693`, `786-795`).
- WebSocket handshake failures are mapped to `ApiError::Api { status, message: "realtime websocket handshake failed" }`,
  preserving the HTTP status (`methods.rs:1112-1123`); 404 and 410 are classified as a terminated call and stop sideband
  reconnect attempts (`methods.rs:1104-1110`, `core/src/realtime_conversation/sideband.rs:41-44`).

## 4. Sideband WebSocket for frameless bidi

### 4.1 URL construction

Shared normalization for frameless (`methods.rs:1249-1262`): given the base path,

- `""`, `/`, `/v1`, `/v1/` → set to `/v1/live`;
- a path ending in `/realtime` → replaced with `/live` (e.g. `/v1/realtime` → `/v1/live`);
- a path ending in `/live/` → trailing slash trimmed;
- any other path is left unchanged (for example `/api/v1` stays `/api/v1`; only the exact `/v1` form is rewritten).

Scheme: `http` → `ws`, `https` → `wss`; `ws`/`wss` pass through; anything else errors (`methods.rs:1166-1178`).

Query for the standalone connection (`methods.rs:1181-1207`): `intent` is not added for frameless (`websocket_intent`
returns `None` at `methods_common.rs:172-177`); `model=<model>` is appended when a model is present; remaining provider
`query_params` are appended except `intent` and (when a model was appended) `model`. So with base `https://ai.ubq.fi/v1`
and the v3 default model the URL is `wss://ai.ubq.fi/v1/live?model=gpt-live-1-codex` (V1 equivalent asserted at
`methods.rs:2143-2157`; frameless rewrite asserted at `methods.rs:2194-2207`).

Query for the call sideband (`methods.rs:1212-1242`): provider `query_params` are **not** passed
(`websocket_url_from_api_url_for_call(..., /*query_params*/ None, ...)` at `methods.rs:997-1005`), no `model` is
appended, and the call id is appended as exactly one path segment (`pop_if_empty().push(call_id)`, percent-encoding as
needed). Call ids `.` and `..` are rejected with `invalid request: invalid realtime call id: <id>`
(`methods.rs:1223-1235`; tests `:2274-2308`). Example: `wss://ai.ubq.fi/v1/live/rtc_abc`; with no
`experimental_realtime_ws_base_url` the same call joins `wss://api.openai.com/v1/live/rtc_abc` (`methods.rs:2311-2335`).

### 4.2 Upgrade request headers and subprotocols

- Built from the URL plus merged headers: provider headers, then the session extra headers (with `x-session-id` inserted
  from the session id), then `default_headers()` inserted only for names still vacant (`methods.rs:1015-1030`,
  `1125-1154`).
- Header set therefore includes `openai-alpha: quicksilver=v2` (frameless), `x-session-id`, `session-id`, `thread-id`,
  `originator`, `user-agent: <originator>/<version> (<os> <os-version>; <arch>) <terminal-ua>`,
  `authorization: Bearer <token>` and `ChatGPT-Account-ID` for the sideband path (WebRTC: `sideband_headers` =
  attestation + auth headers, `core/src/client.rs:684-693`, `core/src/realtime_conversation/sideband.rs:70-81`).
- No WebSocket subprotocol is requested: the request is built with `into_client_request()` and only headers are added;
  no `Sec-WebSocket-Protocol` appears anywhere in the realtime or websocket-client crates (`methods.rs:1015-1023`; grep
  for `protocols|Sec-WebSocket-Protocol|subprotocol` in `codex-rs/codex-api` and `codex-rs/websocket-client` returns
  nothing). The handshake must return 101; `WebSocketConfig::default()` is used, so there is no client-side
  read/write/message-size override (`methods.rs:1156-1158`).

### 4.3 First messages in each direction

Standalone frameless session (transport `websocket`; not the TUI path):

1. Client → server, immediately after the upgrade: `{"type":"session.update","session":{...}}` with the frameless
   session JSON, `model` included; `id` absent (`methods.rs:1074-1093`; `methods_common.rs:141-168`; builder
   `methods_frameless_bidi.rs:32-43`).
2. Server → client: the client blocks until it can parse a `session.started` or `session.updated` event
   (`methods.rs:1080-1101`, `607-621`). That event **must** contain `session.id` as a string, otherwise the event is
   dropped and the client keeps waiting (`protocol_common.rs:31-47`; the parser returns `None` for a missing id). An
   `error` event fails the connect with the event message; any other event fails with
   `frameless realtime session received an event before session.started` (`methods.rs:607-621`). Connection closure
   before that event → `frameless realtime session ended before session.started` (`methods.rs:608-612`).

WebRTC/frameless sideband (the TUI path):

1. Client → server: nothing. For frameless the client deliberately skips `session.update` on the sideband
   (`methods.rs:1074-1080`: `LegacyWebrtcSideband => event_parser != FramelessBidi`, `ExistingCall => false`) and does
   not wait for `session.started` (`:1093-1099`).
2. Server → client: no mandatory first message; the session is expected to be running already, configured by the HTTP
   call-creation `session` payload (`realtime_call.rs:126-130`).

Client-sent traffic afterwards (frameless): audio via `{"type":"input_audio.append","audio":"<base64 PCM>"}`
(`methods.rs:345-356`; note V1/V2 use `input_audio_buffer.append`), text/context via `session.context.append`,
delegation output via `delegation.context.append` (both with `channel` optional, `content` =
`[{"type":"input_text","text":...}]`, chunked at 500 bytes on UTF-8 boundaries) (`methods_frameless_bidi.rs:15-52`,
`98-113`; `methods.rs:468-503`). `response.create` and `conversation.item.truncate` exist in the enum but are only sent
on the v2 path (`protocol.rs:53-80`, `methods.rs:413-417`; gated in `core/src/realtime_conversation.rs:2541-2600`).

Close: the client sends `{"type":"session.close"}` and then a WebSocket Close frame (`methods.rs:440-461`).

### 4.4 Inbound event set accepted by the frameless parser

`parse_frameless_bidi_event` (`codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:8-30`):

| `type`                               | Required fields                                                                                                             | Client interpretation                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `session.started`, `session.updated` | `session.id` (string); `session.instructions` optional                                                                      | `SessionUpdated` (`protocol_common.rs:31-47`)                                |
| `output_audio.delta`                 | `audio` (base64 string)                                                                                                     | `AudioOut` fixed at 24000 Hz, 1 channel (`protocol_frameless_bidi.rs:32-42`) |
| `input_transcript.added`             | `item.text`                                                                                                                 | `InputTranscriptDelta` (`:44-52`)                                            |
| `output_transcript.added`            | `item.text`                                                                                                                 | `OutputTranscriptDelta` (`:44-52`)                                           |
| `turn.done`                          | `turn.role` ∈ {`user`,`assistant`}, `turn.transcript`                                                                       | `InputTranscriptDone` / `OutputTranscriptDone` (`:54-69`)                    |
| `delegation.created`                 | `item.type == "delegation"`, `item.target == "client"`, `item.id`, `item.content[].type == "input_text"` texts concatenated | `HandoffRequested` (`:71-92`)                                                |
| `error`                              | `message`, or `error.message`, or any `error` value stringified                                                             | `Error` (`protocol_common.rs:68-83`)                                         |

Unknown `type` values are logged and ignored (`protocol_frameless_bidi.rs:24-29`); invalid JSON or a missing `type` is
ignored (`protocol_common.rs:8-28`); binary frames produce `Error("unexpected binary realtime websocket event")`
(`methods.rs:586-590`). Extra fields such as `offset_ms`, `start_ms`, `end_ms` are tolerated (test fixture
`protocol_frameless_bidi_tests.rs:20-31`).

### 4.5 Keepalive, close, errors, reconnect

- Ping/pong: the pump answers a server `Ping` with a matching `Pong` and ignores `Pong` (`methods.rs:132-142`). There is
  no client-initiated periodic ping or keepalive timer in the realtime client.
- Inbound Close: `1000` Normal → clean end; any other code →
  `realtime websocket closed unexpectedly: code=... reason=...`; no code → `... without a status code`
  (`methods.rs:566-585`). For frameless, the read stream ending without a Close frame is an error
  (`realtime websocket event stream ended unexpectedly`, `methods.rs:551-560`).
- Send failures while closed are mapped through the same connect-error mapping (`methods.rs:510-525`).
- Sideband reconnect: only for frameless, with 200 ms → 5 s exponential backoff and a rapid-disconnect counter, aborting
  on 404/410 or network-policy denial (`core/src/realtime_conversation/sideband.rs:20-21`, `109-131`). Standalone WS
  sessions do not reconnect (`core/src/realtime_conversation.rs:2019-2083` reports transport loss and stops).

## 5. Backend-shape differences and what a gateway would relay

- The shape switch is a plain substring test on the provider base URL: `base_url.contains("/backend-api")`
  (`realtime_call.rs:77-79`). It changes only path selection, body encoding and whether the frameless call gets the
  legacy query params (`realtime_call.rs:66-79`, `146-163`, `213-224`).
- Backend shape for ChatGPT accounts posts to `<chatgpt_base>/realtime/calls?intent=quicksilver&architecture=avas` with
  the JSON `{sdp, session}` body; with the default provider that is
  `https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`
  (`model-provider-info/src/lib.rs:77`; test `realtime_call.rs:587-620`). The frameless backend test
  `realtime_call.rs:695-745` asserts the same URL for a v3 session, confirming v3 over the backend shape still uses
  `realtime/calls`, not `live`.
- The SIWC TODO sits directly above that branch:
  `// TODO(aibrahim): Align the SIWC route with the API multipart shape and remove this branch.`
  (`realtime_call.rs:146-147`). It states that the Sign-in-with-ChatGPT route is the odd one out and the intended
  convergence is the OpenAI API multipart shape, i.e. the form a gateway implemented at `<base>/live` must speak.
- Related auth TODO: realtime auth is still described as "temporary" API-key auth for ChatGPT/SIWC sessions in
  `core/src/realtime_conversation.rs:1884-1890` (`realtime_message`: "Remove this temporary fallback once realtime auth
  no longer requires API key auth for ChatGPT/SIWC sessions"), and `realtime conversation requires API key auth` is the
  error when no key exists (`:1891-1893`).
- The sideband join is independent of the shape: it always uses `experimental_realtime_ws_base_url`/`api.openai.com`
  plus the frameless path-segment call id (`methods.rs:993-1006`, `1212-1242`). A gateway therefore needs its own WS
  base URL configured on the client, and the call id in `Location` must be a `rtc_*` or UUID segment.
- Relay implication: an upstream relay for a subscription account must forward the OpenAI-API-shaped multipart
  `POST <base>/live` and the `wss://<wsbase>/v1/live/<call_id>` sideband to whatever upstream serves the same contract;
  the client's only routing signals are the base URLs plus the `openai-alpha: quicksilver=v2` header and the call id.
  Upstream endpoint names evidenced anywhere else in this checkout are listed in section 7 (open items).

## 6. Gateway requirements

Wire-level checklist derived from sections 2–4. "Client" = Codex CLI/TUI at revision 60947e2341.

### 6.1 HTTP: must accept from the client

1. `POST <provider-base>/live` for v3/frameless when the provider base URL does not contain `/backend-api`;
   `<provider-base>` is the configured model provider base URL such as `https://ai.ubq.fi/v1` (`realtime_call.rs:66-79`,
   `provider.rs:55-75`).
2. `containing` request semantics: no required query params on that path (`intent`/`architecture` are added only for V1
   there) (`realtime_call.rs:213-224`).
3. `content-type: multipart/form-data; boundary=codex-realtime-call-boundary` with exactly the two parts `sdp`
   (`application/sdp`) and `session` (`application/json`) in that order, CRLF delimited, terminated by the boundary line
   (`realtime_call.rs:166-182`; byte-exact fixture `:487-520`).
4. Headers may include `authorization`, `chatgpt-account-id`, `openai-alpha: quicksilver=v2`, `x-session-id`,
   `session-id`, `thread-id`, `x-codex-turn-metadata`, `originator`, `x-oai-attestation` (section 2.2). The gateway must
   not require any header the client does not send, and must tolerate all of them.
5. The `session` JSON fields are exactly those in section 2.5; unknown fields must be ignored, and the gateway must
   accept the absence of `initial_items` and `delegation.ack_filler` (the common case from the TUI:
   `initial_items: None`, `delegation_ack_filler: None`, `model: None`, `prompt: None`,
   `include_startup_context: Some(false)` — `tui/src/app_server_session/realtime.rs:32-53`,
   `app-server/src/request_processors/turn_processor.rs:1231-1281`).

### 6.2 HTTP: must return

1. A 2xx status (2xx is the only success path; 3xx is followed by the client and 4xx/5xx become transport errors,
   `http-client/src/transport.rs:185-205`, `core/src/client.rs:1060-1064`).
2. `location` header whose final `/`-separated segment (query string ignored) starts with `rtc_` and is non-empty, or is
   a canonical 36-char UUID; anything else fails the session (`realtime_call.rs:259-291`).
3. A body that is the SDP answer as raw UTF-8 text, with no JSON wrapper (`realtime_call.rs:251-256`).
4. On failure, any 4xx (not retried) or 5xx (retried per provider policy) body; a 404/410 on the _WebSocket_ sideband is
   interpreted as "call finished" and stops reconnect (`methods.rs:1104-1110`).

### 6.3 WebSocket: must accept from the client

1. Upgrade to `wss://<ws-base>/v1/live/<call_id>` where `<ws-base>` is the client's `experimental_realtime_ws_base_url`
   and `<call_id>` is a single percent-encoded path segment; the base path must be exactly `/v1` (or empty/`/`, or
   already ending in `/live` or `/realtime`) for the client's normalization to append `/live` — a base like
   `https://host/api/v1` is left as `/api/v1` with the call id appended (`methods.rs:1249-1262`, `1212-1242`).
2. The upgrade request with no subprotocol, carrying `openai-alpha`, `x-session-id`, `authorization`,
   `chatgpt-account-id`, `originator`, `session-id`, `thread-id`, `user-agent` (section 4.2).
3. Text JSON frames; the client never sends binary frames (`methods.rs:345-356`, `468-525`).
4. The frameless message set: `session.update` (standalone sessions only), `input_audio.append`,
   `session.context.append`, `delegation.context.append`, `session.close`, then a Close frame (`methods.rs:340-503`).
5. Client answers server Pings, so the gateway may rely on ping/pong but should not require client-initiated pings
   (`methods.rs:132-142`).

### 6.4 WebSocket: must return

1. HTTP 101 on upgrade; any other status surfaces as an API error with the handshake status (`methods.rs:1112-1123`).
2. For standalone frameless sessions only: a first parseable `session.started` or `session.updated` containing
   `session.id` (string), else the connect fails or hangs (`methods.rs:607-621`, `protocol_common.rs:31-47`). Sideband
   sessions need no first message (section 4.3).
3. Server events as text JSON using the types in section 4.4, with `session.id`, `item.text`,
   `turn.role`/`turn.transcript`, `audio` and `delegation` fields as specified. Unknown types are ignored, so additive
   events are safe (`protocol_frameless_bidi.rs:24-29`).
4. Close code 1000 for a clean end; any other code is an error; dropping the TCP connection without a Close frame is an
   error for frameless (`methods.rs:551-585`).

### 6.5 Specific things that break the client

- Returning no `Location`, or a `Location` whose last segment is neither `rtc_*` nor a UUID (`/v1/realtime/calls` alone
  fails; `realtime_call.rs:259-291`, test `:772-784`).
- Returning a 3xx with the real answer in `Location` — the HTTP client follows redirects by default, so the client sees
  the redirect target's response instead (`core/src/client.rs:1060-1064`).
- Returning a JSON envelope, multipart response, or non-UTF-8 SDP body (`realtime_call.rs:251-256`).
- Requiring a WebSocket subprotocol, or rejecting the upgrade without `Sec-WebSocket-Protocol` (`methods.rs:1015-1023`;
  no subprotocol exists in the client).
- Requiring a client-created sideband session to start with `session.update` — frameless sidebands never send one
  (`methods.rs:1074-1080`).
- Sending any event before `session.started` on a standalone frameless connection (`methods.rs:613-621`).
- Omitting `session.id` from `session.started`/`session.updated`: the event is silently dropped and the standalone
  handshake waits until timeout/close (`protocol_common.rs:31-47`).
- Using a non-`/v1` base path (e.g. `/api/v1`) with the client configured to the same URL for HTTP and WS: the HTTP path
  becomes `/api/v1/live` while the WS path becomes `/api/v1/<call_id>` (no `/live`), so the two halves disagree
  (`provider.rs:55-75` vs `methods.rs:1249-1262`).
- Expecting `response.create`/`conversation.item.create`/`conversation.handoff.append` on a v3 session: those are
  v1/v2-only message types (`methods.rs:361-417`, `protocol.rs:53-80`).
- Treating the frameless sideband as reconnect-free: the client reconnects with backoff unless the join returns 404/410
  (`core/src/realtime_conversation/sideband.rs:109-131`).

## 7. Open questions and uncertainties

- The client never validates that the SDP answer is a real SDP; it stores bytes verbatim, so this document cannot state
  what media constraints the upstream expects beyond "UTF-8 text" (`realtime_call.rs:251-256`). Any requirement that the
  answer must match the offer (codecs, ICE) is WebRTC-level and outside this checkout's code path.
- `input_audio.append` payload framing (base64 PCM16, 24 kHz mono) is inferred from the outbound builder and the inbound
  `output_audio.delta` constant (`methods.rs:345-356`, `protocol_frameless_bidi.rs:34-42`); the frameless path never
  sends `audio.input.format` in the session payload, so the gateway/upstream must already assume that format (contrast
  V1/V2 at `methods_v1.rs:71-76`).
- Whether a real ChatGPT-subscription upstream will accept the OpenAI-API-shaped multipart call at `/v1/live` (rather
  than the `/backend-api` JSON shape) is not answerable from this checkout; the SIWC TODO suggests convergence but does
  not state that the API shape is served on the backend route today (`realtime_call.rs:146-147`).
- The `openai-alpha: quicksilver=v2` header and `intent=quicksilver&architecture=avas` params are the only
  version-selection sentinels visible on the wire; it is unclear whether the upstream uses them to select the frameless
  parser or only for routing/telemetry (they are set from the local parser and, for the query params, only on v1/backend
  paths: `core/src/realtime_conversation.rs:1899-1912`, `realtime_call.rs:213-224`).
- No evidence in this checkout of a public OpenAI `/v1/live` REST documentation page or of any gateway-facing spec
  beyond the client code; the deliverable is therefore behavior-derived.
- The TUI is the only in-repo caller that exercises the v3+WebRTC path; the standalone-websocket v3 path
  (`transport=websocket`, `version=v3`) is reachable via app-server `thread/realtime/start` but is not used by the TUI
  (`tui/src/app_server_session/realtime.rs:32-53`).
