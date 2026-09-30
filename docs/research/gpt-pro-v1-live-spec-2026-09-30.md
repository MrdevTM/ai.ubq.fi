# `/v1/live` gateway implementation spec

**As of September 30, 2026: treat the exact `/v1/live` interface as a version-pinned Codex compatibility protocol—not as
an alias for the documented Realtime API.** I found public Codex implementation evidence for that interface, but not a
public API contract promising its availability or stability. OpenAI now documents a **different GPT-Live interface at
`/v1/live/sessions`**. Those paths have materially different request, response, and event schemas.
citeturn465906view0turn118125view4

Below, **documented** means an OpenAI API specification; **observed** means behavior in the retrieved Codex source;
**design** means my gateway recommendation. This was documentation/source analysis, **not an authenticated
interoperability test**.

## 1. Exact `/v1/live`: the observed Codex contract

### Call creation

These are **client implementation facts**, not guarantees about everything the upstream endpoint accepts:

| Component               | Observed behavior                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Non-backend v3 creation | `POST <provider-base>/live`, using multipart `sdp` and `session` parts, exactly as you described.                                |
| Query parameters        | Non-backend frameless/v3 adds neither `intent` nor `architecture`. Its optional model is in `session`.                           |
| ChatGPT-shaped backend  | A base containing `/backend-api` selects JSON `{sdp, session}` at `<base>/realtime/calls?intent=quicksilver&architecture=avas`.  |
| Successful response     | Body is SDP text, not JSON. Mock tests return `200`; that does **not** establish a normative upstream status.                    |
| `Location`              | Required. Codex extracts an `rtc_...` or UUID-shaped path segment, ignoring the query. Relative and absolute locations can work. |

The separate raw-`application/sdp` helper targets `/realtime/calls`, **not `/live`**. It therefore does not establish
raw-SDP support at `/live`; nor does the backend JSON branch establish JSON support there. citeturn465906view0

**AVAS:** the source establishes a routing selector and parser restrictions. I found no public AVAS protocol
specification, supported-parameter inventory, or promise that it is interchangeable with standard Realtime or public
GPT-Live. citeturn465906view0

### The v3 `session` object

The frameless serializer produces this shape:

```json
{
  "instructions": "...",
  "audio": {
    "output": {
      "voice": "<configured voice>"
    }
  },
  "delegation": {
    "type": "client",
    "ack_filler": true
  },
  "model": "<configured model>",
  "initial_items": [
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "..."
        }
      ]
    }
  ]
}
```

`model` and `delegation.ack_filler` are included only when configured; `initial_items` is omitted when empty. History
roles are `developer`, `user`, or `assistant`; assistant content uses `output_text`, while developer/user content uses
`input_text`. This serializer does **not** add `type: "realtime"`. Preserve this dialect rather than validating it
against a standard Realtime session schema. citeturn118125view6

### Sideband WebSocket—and an important routing correction

**Changing the provider base alone does not necessarily send the WebRTC sideband through your gateway.** The retrieved
`RealtimeWebsocketClient` initializes a separate `webrtc_sideband_base_url` to `https://api.openai.com/v1`. It exposes
`with_webrtc_sideband_base_url(...)`; inspect whether your actual caller overrides it. Codex extracts an ID from
`Location` rather than treating that header as the complete socket destination. **Rewriting `Location` alone therefore
cannot reliably redirect this socket.** citeturn402286view0

For the observed v3 sideband:

- The route is `/v1/live/{call_id}`, using configured authentication/header machinery.
- Application messages are JSON WebSocket text messages. No fixed `Sec-WebSocket-Protocol` is hardcoded here;
  **“frameless bidi”/“v3” is not itself evidence of a negotiated subprotocol**.
- Attaching to the existing call does not reinitialize it with a startup session message.
- Codex responds to WebSocket Ping with Pong. Its v3 close path sends `{"type":"session.close"}` and then closes the
  socket. I found no public heartbeat interval or complete endpoint-specific close-code contract for this exact
  interface. citeturn402286view0

The relevant message vocabulary is:

| Direction        | Observed schema examples                                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream → Codex | `session.started`, `session.updated`; `output_audio.delta` with `audio`; `input_transcript.added` / `output_transcript.added` with `item.text`; `turn.done` with `turn.role` and `turn.transcript`; `delegation.created` with a client-targeted delegation `item`; `error`. |
| Codex → upstream | `session.context.append` with text `content` and optional `channel`; `delegation.context.append` additionally carrying `delegation_item_id`; `session.close`. The broader v3 transport also defines `input_audio.append` with `audio`.                                      |

This is the **subset Codex sends or understands**, not an exhaustive upstream schema. A pass-through proxy should not
discard unknown events. citeturn465906view1turn465906view2

## 2. What the public APIs actually document

### Public GPT-Live: `/v1/live/sessions`

**Documented:** WebRTC creation is JSON, with the offer inside a transport object:

```http
POST https://api.openai.com/v1/live/sessions
Authorization: Bearer <project API key>
Content-Type: application/json
```

```json
{
  "session": {
    "model": "gpt-live-1",
    "instructions": "...",
    "audio": { "output": { "voice": "marin" } },
    "delegation": { "type": "client" }
  },
  "transport": {
    "type": "webrtc",
    "sdp": "<SDP offer>"
  }
}
```

The documented response is **`201 Created`**, with JSON:

```json
{
  "session": { "id": "live_123" },
  "transport": {
    "type": "webrtc",
    "sdp": "<SDP answer>"
  }
}
```

The documented identifier comes from `session.id`; the contract does not tell clients to discover it through `Location`.
The startup session fields are required `model`, plus optional `audio`, `client`, `delegation`, `input`, `instructions`,
and `store`. Notably, history is **`input`, not `initial_items`**. The reference explicitly says to put the model in
session configuration, **not a URL query parameter**. citeturn118125view4turn118125view5

Its two WebSocket entry points are also different:

| Purpose                                 | Public GPT-Live URL and initialization                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New primary WebSocket session           | `wss://api.openai.com/v1/live/sessions`; send `session.start` containing configuration. No query parameters.                                                                   |
| Sideband for an existing WebRTC session | `wss://api.openai.com/v1/live/sessions/{session_id}/attach`; use the returned ID unchanged and the creating project’s authentication. Do **not** send another `session.start`. |

Public primary audio commands include `session.input_audio.append`, rather than Codex’s unprefixed `input_audio.append`.
citeturn667397view4turn118125view0

Public sideband context commands include `session.instructions.append`, `session.thinking.append`, and
`session.commentary.append`, rather than the Codex `*.context.append` interface. Public Live’s clean shutdown sequence
is `session.close` → receive `session.closed` → disconnect after pending events drain.
citeturn118125view0turn813633view7

### Public Realtime: `/v1/realtime`

The documented Realtime surfaces remain distinct:

| Purpose                          | Public Realtime interface                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Server-mediated WebRTC creation  | `POST /v1/realtime/calls`, multipart SDP plus session configuration.                                          |
| Ephemeral-client WebRTC creation | The documented browser flow posts raw `application/sdp` to `/v1/realtime/calls` with an ephemeral credential. |
| Primary WebSocket                | `wss://api.openai.com/v1/realtime?model=<model>`                                                              |
| Existing-call sideband           | `wss://api.openai.com/v1/realtime?call_id=<call_id>`                                                          |

These are documented flows, **not evidence that `/live` accepts the same encodings or events**.
citeturn374316view0turn667397view6turn667397view4turn118125view1

Public GPT-Live also differs architecturally: its voice frontend delegates backend reasoning/tool work, rather than
simply being another spelling of the Realtime model interface. Consequently, substituting `/realtime` for `/live` is not
a semantics-preserving fallback. citeturn988987view0

### Hosts, credentials, and subscriptions

**Documented availability:** public GPT-Live uses `api.openai.com` and a project API key with GPT-Live access.
citeturn667397view6

**Not established:** that every platform key, ChatGPT subscription, or Codex subscription authorizes the exact
compatibility `/v1/live` route. The source’s ChatGPT branch establishes an alternate request shape—not a public
entitlement promise or proof that ChatGPT itself exposes `/v1/live`. Treat backend authentication and supported models
as separately verified properties of your selected upstream.

## 3. Recommended pass-through gateway design

**Design:** implement an explicit `codex-live-v3` profile. Do not infer the protocol from “voice,” and do not reuse
Responses/SSE middleware.

For a compatible upstream, the intended topology is:

```text
Codex ── call-creation HTTPS ──► gateway ──► compatible upstream
Codex ◄── raw SDP + Location ── gateway ◄── upstream

Codex ◄════ sideband WebSocket ════► gateway ◄════► upstream

Codex ◄──────── negotiated WebRTC media/data ────────► media peer
```

WebRTC signaling and media are separate paths; an HTTP/WebSocket reverse proxy does not automatically relay the media.
citeturn388679view5

### Wire-level checklist

1. **Bind the call to one authorized upstream identity.**\
   Store a record such as `{gateway_user, upstream_profile, upstream_call_id, credential_reference, state}`.
   Authenticate both creation and attachment, and authorize attachment against that record. Do not let a caller supply
   an arbitrary upstream URL or attach to another user’s call. Public Live expressly requires the creating project’s
   authentication and application-level session authorization. citeturn118125view0

2. **Preserve multipart bytes—or regenerate the entire envelope correctly.**\
   For same-dialect relay, forward the body unchanged with its matching `Content-Type` boundary. Preserve SDP line
   endings. When rebuilding multipart, generate a matching boundary/header pair and recalculate body framing; never
   retain the old `Content-Length`. The literal Codex boundary is not a reason to reject other valid multipart
   boundaries in your own parser. citeturn388679view4turn647744view0

3. **Preserve the response representation and useful errors.**\
   Return SDP as SDP—not JSON, SSE, or an HTML success page. Preserve the upstream success status, media type, and call
   identity. A gateway-relative `Location: /v1/live/{id}` is a reasonable outward representation, but separately
   configure the sideband destination as described above. Forward upstream failure status/body rather than manufacturing
   a successful call. Strip hop-by-hop headers and fix authority/framing for each HTTP leg. citeturn647744view0

4. **Use two real WebSocket connections, not a generic fetch stream.**\
   Establish the upstream handshake and bridge application messages bidirectionally with bounded buffering and preserved
   ordering. Each leg has its own handshake keys, masking, extensions, and control frames; do not copy
   `Sec-WebSocket-Key`/`Sec-WebSocket-Accept` between independently terminated handshakes. Preserve text versus binary
   message type and unknown application events. Handle Ping/Pong and Close on both legs without inventing
   application-level heartbeat messages or subprotocols. citeturn388679view3

5. **Leave negotiated SDP/media information untouched.**\
   Do not replace ICE candidates, credentials, DTLS fingerprints, or codec negotiation with your gateway hostname. The
   client must reach the negotiated media peer, directly or through the applicable relay infrastructure. Requiring _all_
   media to traverse your infrastructure is a separate TURN/media-relay or WebRTC-termination project—not a `Location`
   rewrite. citeturn388679view5

6. **Separate signaling deadlines from long-lived connection policy.**\
   Use distinct POST, WebSocket-connect, and established-connection timeouts. Do not apply your ordinary “no response
   tokens received” timeout to quiet voice calls. Avoid automatically replaying a call-creation POST after an ambiguous
   timeout: the first creation may have succeeded. Implement backpressure and bounded queues instead of accumulating
   audio/events indefinitely. HTTP does not make POST inherently idempotent. citeturn647744view0

7. **Do not impose an invented HTTP-version requirement on SDP.**\
   I found no documented HTTP/1.1-only requirement for the SDP POST. WebSocket upgrade support is a separate transport
   requirement; the conventional RFC 6455 handshake uses HTTP/1.1 Upgrade. Fix that connection path rather than globally
   forcing every voice-related POST to HTTP/1.1. citeturn388679view3

8. **Handle browser security separately from native Codex.**\
   For browser-facing HTTP, support the required preflight and allowed origins/headers; expose `Location` when
   JavaScript must read it. Browser WebSockets use Origin checks, not ordinary fetch CORS authorization. Native Codex is
   not subject to browser CORS. Keep upstream API keys server-side and replace gateway authentication with the selected
   upstream credential rather than blindly forwarding it. citeturn647744view1turn388679view3turn647744view2

## 4. When translation is unavoidable

### Gateway → ChatGPT-shaped Codex backend

**Design:** use an explicit adapter for the backend branch: multipart fields become `{sdp, session}` JSON, with the
corresponding backend path/query selection. Configure the sideband authority independently. This is only viable with an
upstream authentication flow that actually authorizes the call; changing JSON shape does not establish entitlement.

### Gateway → documented public GPT-Live

**This is a protocol adapter, not pass-through.** At minimum:

| Layer               | Required work                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Creation            | Wrap SDP in `transport`; validate the public session schema; adapt history to `input`. `ack_filler` has no equivalent documented in the inspected startup schema—do not silently claim feature parity. |
| Response/identity   | Extract `transport.sdp`. Maintain an opaque upstream-ID mapping behind a Codex-compatible gateway call ID rather than assuming public `live_...` IDs satisfy Codex’s parser.                           |
| Sideband            | Attach through the public session endpoint and translate event/context semantics, including identifiers and incremental transcript behavior—not merely event-name prefixes.                            |
| Direct data channel | Check what Codex consumes over WebRTC itself. An HTTP/sideband-only gateway cannot translate application messages on a direct encrypted WebRTC data channel it does not terminate.                     |

These differences follow from the two session/event schemas and the separation between signaling and WebRTC transport.
citeturn118125view4turn118125view6turn465906view1turn465906view2turn388679view5

**Implementation decision:** first prove creation, sideband attachment, bidirectional speech, delegation, and shutdown
against **one authorized, same-dialect upstream**. Then implement byte-preserving relay. When targeting the documented
public Live API instead, updating the client transport is likely simpler and safer than pretending the existing Codex
dialect is already compatible.

## Primary-source URLs

The Codex links below target moving `main`; pin your implementation/tests to your deployed commit rather than treating
them as a versioned service contract.

| Source                         | Exact URL                                                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex call creation            | [realtime_call.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/realtime_call.rs)                                                                                                                                                            |
| Codex v3 session serialization | [methods_frameless_bidi.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs)                                                                                                                       |
| Codex socket routing/lifecycle | [methods.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs)                                                                                                                                                     |
| Codex event schemas            | [Inbound parser](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs) · [Outbound messages](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs) |
| Public Live creation           | [Live API reference](https://developers.openai.com/api/reference/resources/live/methods/create)                                                                                                                                                                           |
| Public Realtime creation       | [Realtime calls reference](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create)                                                                                                                                              |
| Public connection protocols    | [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc) · [WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets) · [Sideband controls](https://developers.openai.com/api/docs/guides/voice-server-controls)                            |

**Remaining uncertainty:** the public sources establish the client wire behavior and the separately documented APIs, but
do not settle the exact compatibility `/v1/live` endpoint’s entitlement matrix, accepted alternative encodings,
supported model inventory, server heartbeat policy, or stability guarantees.
