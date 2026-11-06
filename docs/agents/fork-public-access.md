# Cloudflare public access + server port — fork notes

Settings › General › **Server** holds two things the upstream project has nowhere:
the port this server listens on, and a Cloudflare tunnel that publishes it on the
internet. Both are reachable only from this computer (any write route is local-only),
and the tunnel is refused outright without a web password.

The feature is a port of cc-haha's tunnel management, minus the parts that do not
apply here: **no pairing, no QR code, no device list, no second listener, no proxy
bridge.** Authentication is the existing `PI_WEB_PASSWORD`; the Next server that
serves the browser is itself the thing the tunnel points at, so there is no gateway
process to manage.

## Config layer (`lib/public-access/settings.ts`, `lib/server-port.ts`)

Both live in the file the fork already uses for web settings,
`~/.pi/agent/pi-web/settings.json` (see `remoteAccessSettingsPath()`):

```jsonc
{
  "serverPort": 30141,          // applies after a restart
  "publicAccess": {
    "enabled": false,
    "mode": "quick",            // "quick" | "named"
    "token": "",                // named only, written 0600, never read back to the UI
    "customUrl": "",
    "autoStart": false,
    "consentVersion": 1,
    "origin": ""                // runtime field: set only while online
  }
}
```

- `normalizePublicAccessOrigin()` accepts **https origins only** (no userinfo, path,
  query or fragment). `readCloudflareTunnelToken()` decodes the token just far enough to
  report its `tunnelId`; the secret never leaves the server.
- `parsePublicAccessUpdate()` **keeps the stored token when the body omits it**, and
  accepts a whole pasted `cloudflared service install ...` command, not just the bare token.
- Reads are fail-closed and cached by mtime+size. `serverPort` is validated as
  1024–65535 by `isServerPort()`; `bin/pi-web-settings.js` is the plain-CJS mirror the
  launchers require (they run before any TypeScript can be loaded).

## Spawner (`lib/public-access/tunnel.ts`)

`cloudflared --no-autoupdate --config <tmp>/config.yml tunnel --metrics 127.0.0.1:0
--protocol http2`, then `--url http://127.0.0.1:<port>` (quick) or `run` (named, token
via `TUNNEL_TOKEN` in the env, never in argv). The child env drops `*_proxy`, `TUNNEL_`
and `CLOUDFLARED_` and points `HOME` at a scratch directory.

Ready means **both**: a `trycloudflare.com` URL appeared (the `api.trycloudflare.com`
control host excluded) **and** `Registered tunnel connection` showed up. A URL alone is
a tunnel that has not connected yet. Stop escalates SIGTERM → 2s → SIGKILL → 2s and
reports `stopUnconfirmed` if the process still lives, which blocks a new start.

## Gateway probe (`lib/public-access/gateway.ts`)

`GET /health` (see `app/health/route.ts`) returns `{status:"ok", gatewayId}`. The route
is deliberately **outside the proxy matcher** (`/`, `/login`, `/api/:path*`), so the
tunnel can fetch it without credentials — that is the whole point of the probe. After a
tunnel reports ready, `verifyPublicGateway(origin)` fetches `https://<origin>/health`
with `redirect: "manual"` and confirms the `gatewayId` is this process's own. A public
hostname that answers with someone else's id is not trusted. Keep this route free of
anything else.

## State machine (`lib/public-access/manager.ts`, `runtime.ts`)

`unconfigured | disabled | connecting | online | reconnecting | failed`, each with a
`phase` and a classified `error` (network / configuration / token / route / runtime /
stop). Starts are single-flight per generation; only network-class errors retry, with
backoff `min(30s, 1s·2^n)`. `restore()` runs at server start through
`instrumentation-node.ts` and requires autoStart, the consent version, a saved config
**and a web password**. The manager is a `globalThis` singleton (`lib/public-access/runtime.ts`)
so dev hot-reload cannot spawn a second tunnel.

`publicAccess.origin` is written only on `online` and cleared on stop, failure and exit.
This is what links "a hostname is trusted" to "the tunnel is actually up".

## Host allow-list binding (`lib/request-security.ts`, `proxy.ts`)

`isApiRequestHostAllowed()` takes a fourth argument (the public-access config) and trusts
the tunnel hostname only when **both** hold:

1. the request Host matches the stored `origin` (https-only, normalized), and
2. `isWebPasswordEnabled()` is true.

So editing `settings.json` by hand to add a hostname changes nothing without a password,
and with a password the request still has to pass the normal `/login` or Basic path.
`proxy.ts` answers an unauthenticated tunnel request with an explicit 403 that names
the missing password, instead of the generic "untrusted".

## cloudflared binary (`lib/public-access/binary.ts`, `scripts/prepare-cloudflared.mjs`)

`resolveCloudflaredBinary()` looks at `PI_WEB_CLOUDFLARED`, then
`$PI_DESKTOP_RESOURCE_DIR/cloudflared/`, then `<repo>/vendor/cloudflared/`, then `PATH`.
`npm run prepare:cloudflared` downloads the pinned release (version + SHA256 table in the
script), verifies the digest, untars when needed and writes it atomically, leaving a
`.json` manifest beside it. A digest mismatch aborts. Nothing is fetched at runtime
until the user presses Download in Settings (`lib/public-access/install.ts` shells out to
the same script, so the digest table stays in one place). The staged binaries under
`vendor/cloudflared/` are gitignored.

## The port

`serverPort` is read by the launchers through `bin/pi-web-options.js`
(`--port` > `PORT` > saved port > 30141). The running port reported by
`GET /api/server-settings` comes from `process.env.PORT`, which Next's own
start-server sets from the `-p` argument — so it is correct for `dev` and `start`
alike, and nothing has to be mirrored into the child. `scripts/lan-server.mjs`
no longer hard-codes 30141. Tauri's `choose_port` prefers the saved port too. Changing the
port takes effect on restart; the UI says so.

## Not implemented (on purpose)

Pairing / QR / device management, cc-haha's separate second listener and its
phone-visible path allow-list, the `cloudflareProxy.ts` network-proxy bridge, bundling
cloudflared into the Tauri resources, and telling a phone when a quick-tunnel address
changes.
