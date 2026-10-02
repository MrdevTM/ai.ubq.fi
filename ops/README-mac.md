# Mac gateway service

The Mac companion listens on `http://0.0.0.0:7999` (LAN address, for example `http://192.168.4.47:7999`).
`com.ubiquity.ai.local` is a per-user launchd agent: it starts at login and restarts after exit. It does not run before
the user logs in or keep a sleeping Mac awake.

Configuration lives in `ops/com.ubiquity.ai.local.plist`, linked from `~/Library/LaunchAgents/`. The repository-root
`.env` contains the existing upstream credentials. Local KV is `.data/kv.sqlite3`. Code runs from the immutable release
selected by `.data/current`, including that release's Deno configuration. Runtime identity is `mac-<full-git-sha>`.

## Loopback trust boundary

`scripts/serve-mac.ts` enables the keyless path for this listener and binds the TCP peer Deno reports for each request
(`info.remoteAddr`). `src/auth/local-admin.ts` then decides that request:

- The bypass needs a numeric loopback TCP peer (`127.0.0.0/8`, `::1`) **and** a loopback request URL hostname
  (`localhost`, `::1`, or a `127.0.0.0/8` literal). If `Origin` is present it must equal the request URL origin, and if
  `Sec-Fetch-Site` is present it must be `same-origin` or `none`. A request without an observed peer fails closed.
- A qualifying request authenticates as the boot-provisioned local development principal
  (`src/auth/local-development-key.ts`), and on the admin surface as a super-admin (`is_super_admin: true`,
  `method.kind: "disabled"`).
- Every other client — LAN hosts, Tailscale peers, or any connection whose peer address is not loopback — keeps the
  existing gateway credentials for the API and the admin dashboard, even when its `Host` header names `127.0.0.1`.

The check is the connection's peer address, so a process on this Mac that accepts outside traffic and then opens its own
connection to `127.0.0.1:7999` is itself the loopback peer. A caller it forwards reaches the keyless principal only when
the forwarded request also presents a loopback URL hostname and its `Origin` and `Sec-Fetch-Site` headers satisfy or are
omitted from the checks above, as scripted clients normally do and a browser with a foreign `Origin` does not. Do not
place an unauthenticated forwarding path in front of this listener: a local reverse proxy (`nginx`, `caddy`), a tunnel
(`cloudflared`, `ngrok`, Tailscale Funnel/serve), `ssh -R`, or a container/host port map. Authenticate and authorize
callers in the intermediary before it forwards; a forwarded non-loopback `Host` is not sufficient protection, because a
forwarder that preserves a client's loopback `Host` satisfies the URL check too. The service cannot distinguish a local
human client from a local forwarder, so this boundary is operational; this file states the code's contract, and whether
a host runs such an intermediary must come from a live ingress inventory.

## Observed Mac ingress inventory (2026-10-02, bounded)

A read-only listener/process snapshot captured at 2026-10-02 19:29:45 UTC (receipt
`136210b2-9a4d-4a3e-b79d-532e4ab58a0b`) was classified against the entry sources named below. It found no
unauthenticated forwarding path to this listener; it does not prove that none can exist.

- The only 7999 listener was this service (`deno`, PID 61796). A keyless-boundary request to `/uos/auth` answered 200 on
  loopback, 401 from the LAN address, and 401 from the LAN with a forged `Host: 127.0.0.1:7999`; `/health` identities
  were `mac-d239b10…` on the Mac and `vps-d239b10…` publicly.
- PID 996 (`deno`, `*:8787`, all interfaces, no caller authentication of its own) is the fast-jev-compaction Codex
  adapter (`codex/jev-compaction-proxy.ts` in `/Users/nv/repos/0x4007/fast-jev-compaction`). Its product entrypoint
  fixes the upstream at `http://127.0.0.1:8000` and forwards ordinary requests there byte-transparently; it does not
  point at 7999. A live probe of the running process, `GET http://127.0.0.1:8787/healthz`, returned plaintext
  `fast-jev-compaction proxy ready; upstream=http://127.0.0.1:8000; compaction=responses`, and no process listened on
  8000. That closes the running/source gap for this fixed upstream, because the running adapter reports the same
  upstream the reviewed entrypoint fixes; it is a point-in-time observation and does not establish that no exposure is
  possible. Only tests override that upstream.
- PID 1011 (`deno`, `*:8765`) is the Capture release download server (`server.ts` in
  `~/.local/share/prospector-release`). It answers GET/HEAD for a fixed local file set and makes no outbound request, so
  it is not a forwarding path.
- PID 17379 (`python3`, `*:8700`) was in the snapshot but no longer exists; no cwd or entry was captured, so it stays
  unclassified rather than assumed harmless.
- The other non-loopback listeners are macOS services (`rapportd` 60315, ControlCenter 5000/7000) and were not read.
  Tailscale serve and funnel are tailnet-only to `127.0.0.1:3080` and `/dsh` to `3081`, never 7999. `~/.cloudflared`
  exists with no running process observed.
- Limits: a point-in-time snapshot cannot see a forwarder started later, short-lived processes, IPv6-only sockets not
  bound at capture, or a custom launcher that imports `startProxy` with another `upstreamOrigin`. The running argv
  behind PIDs 996 and 1011 was not inspected: PID 996's classification rests on its entry source, the
  fixed-configuration decision (D4), and the live `/healthz` above, while PID 1011's rests on its entry source.

PID 996 is the concrete shape this boundary prohibits: an unauthenticated listener on all interfaces that forwards to a
loopback upstream. It does not reach 7999 today; starting a dev gateway on 8000 while it runs would create the
prohibited shape unless that adapter is authenticated or restricted. If its `upstreamOrigin` ever names 7999, a
forwarded caller becomes a loopback peer of this service only when its forwarded request passes the URL-host and
`Origin`/`Sec-Fetch-Site` checks above. Keep any such intermediary authenticated, and re-observe the host before relying
on this inventory.

Supported access:

- Local, keyless: `http://127.0.0.1:7999` — the Codex provider below and the local admin dashboard.
- LAN, authenticated: `http://192.168.4.47:7999` with existing gateway credentials; an unauthenticated `/v1/models` must
  be 401.
- Remote, authenticated: `https://ai.ubq.fi` through the VPS gateway, which serves its own loopback listener and never
  enables this bypass (`scripts/serve-vps.ts`). `GET /health` reports the identity it answered from:
  `vps-<full-git-sha>` for the VPS, `mac-<full-git-sha>` for the Mac. A public endpoint reporting a `mac-` identity
  means the Mac service is reachable through some ingress, and that ingress must be removed.

Provider quota is sampled at startup and every fifteen minutes into local KV so the Providers dashboard has current
capacity and accumulates its own history.

The daemon can read the existing synced `~/.codex/auth.json` through the gateway's normal local credential loader. Keep
the existing sign-in and cross-machine sync. This uses the gateway's existing KV credential-pool behavior after initial
loading; it does not change the synced auth file. Production scheduled billing remains on the VPS. Local capped paid
billing maintenance is tracked in [#266](https://github.com/ubiquity/ai.ubq.fi/issues/266).

From the clean Mac repository root, `deno task deploy:mac` installs the committed release and loads the launch agent.
Verify authenticated local inference after deployment before changing Codex routing. The task's health check alone does
not establish provider readiness.

```sh
launchctl print gui/501/com.ubiquity.ai.local
launchctl kickstart -k gui/501/com.ubiquity.ai.local
curl --fail http://127.0.0.1:7999/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7999/v1/models # 200: loopback needs no credential
# From another LAN host the same request must be 401 without a credential:
#   curl -s -o /dev/null -w '%{http_code}\n' http://192.168.4.47:7999/v1/models
tail -n 50 .data/mac.stderr.log
```

Use a custom Codex provider with base URL `http://127.0.0.1:7999/v1` and the Responses wire API. Loopback requests need
no credential, and an existing `UOS_AI_TOKEN` in that profile keeps working unchanged. Keep the remote `uos` provider
available for an explicit remote profile. Local inference avoids the VPS round trip; traffic between the Mac and
upstream model providers still uses the internet. The two gateways have independent usage and routing state.
