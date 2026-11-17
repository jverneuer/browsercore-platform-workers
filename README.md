# @browsercore/platform-workers

[![npm version](https://img.shields.io/npm/v/@browsercore/platform-workers)](https://www.npmjs.com/package/@browsercore/platform-workers)
[![CI](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-platform-workers/ci.yml?label=ci)](https://github.com/jverneuer/browsercore-platform-workers/actions/workflows/ci.yml)

**Cloudflare Workers Platform adapter for the @browsercore stack** — the composition root
that lets `@browsercore/fetch` run browser-identical TLS (ClientHello, HTTP/2 SETTINGS,
header order) on Workers, instead of through Node's runtime adapters.

This package IS a runtime adapter: like browsersmith's `src/platform/*/node/` adapters, it
is the one place `node:*` imports are allowed by design — except here there are exactly
**two**, both compat-gated and documented at their import sites:

| Capability | Backend | Why |
|---|---|---|
| crypto | **pure noble** (`@noble/hashes`, `-ciphers`, `-curves`, `-post-quantum`) | The `CryptoProvider` contract is **synchronous**; WebCrypto is async-only. noble is pure TS — the identical code path runs on workerd, Node, and tests. AES-GCM, ChaCha20-Poly1305, X25519, P-256/P-384 ECDH, ML-KEM-768 (X25519MLKEM768 hybrid), HKDF/HMAC/SHA — all sync. |
| signature verify | `node:crypto` compat | RSA-PSS/PKCS1 (and ECDSA) verify needs DER/SPKI + RSA — no noble equivalent. Requires `nodejs_compat` with `compatibility_date >= 2026-08-04` ("All node:crypto APIs fully supported"). |
| TCP | `cloudflare:sockets` shim | ~180-line `Socket` bridge: sync-return `connect()`, `once("connect")` after `opened`, read pump over `readable`, promise-borne write backpressure (never emits `"drain"`), `end()` = half-close FIN, `destroy()` = `close()` + `"error"`? + `"close"(true)`. **`connect` is dependency-injected** — the Worker passes the real module binding, tests pass in-memory fakes. |
| DNS | edge passthrough | Workers `connect()` resolves hostnames at the edge; `lookup` passes the name through unchanged. |
| UDP | throwing stub | **No UDP on Workers ⇒ no QUIC ⇒ no HTTP/3.** `Platform.network.udp` is required by the type, so it throws a typed `UnsupportedOnWorkersError` naming that consequence. |
| compression | `node:zlib` sync family (compat) | Mirrors browsersmith's Node zlib adapter one-for-one, including the browser-tolerant raw-deflate fallback. |
| events | Map-based `EventProvider` | The 8-method contracts surface; no `node:events` on workerd. |
| time | Web standards | `Date.now` / `performance.now` / `setTimeout` / `AbortSignal.timeout`; no `node:timers`. |

## Install

```bash
npm install @browsercore/platform-workers @browsercore/fetch
```

## Usage

```ts
import { connect } from "cloudflare:sockets";
import { createClient } from "@browsercore/fetch"; // NOT browsersmith's barrel — see below
import { createWorkersPlatform } from "@browsercore/platform-workers";

export default {
    async fetch(request: Request, env: Record<string, unknown>) {
        const platform = createWorkersPlatform(env, { connect });
        const client = createClient({
            platform,
            profile: "chrome-140",
            idleTimeoutMs: 0, // no idle pool to keep warm between requests
        });
        try {
            const response = await client.fetch("https://tls.peet.ws/api/all");
            return new Response(await response.text(), { status: response.status });
        } finally {
            await client.close();
        }
    },
} satisfies ExportedHandler;
```

A complete, deployable version lives in [`examples/demo-worker.ts`](examples/demo-worker.ts)
with [`examples/wrangler.jsonc`](examples/wrangler.jsonc)
(`compatibility_date: "2026-08-04"`, `compatibility_flags: ["nodejs_compat"]`).

**Import `createClient` from `@browsercore/fetch`, not from browsersmith's root barrel.**
The barrel re-exports its eager Node platform singleton (`wiring.ts` builds
`node:net`/`node:dns`/`node:dgram` adapters at import time) — the tree-shaking trap the
2026-11-16 feasibility audit flagged.

## The DI design: why `connect` is injected

`cloudflare:sockets` only exists inside a Worker. If this package imported it directly,
its unit tests (and every consumer doing a plain `npm install` on Node) would crash at
import time. Instead `createWorkersPlatform(env, { connect })` takes the binding as a
parameter: the Worker passes the real `connect`, tests pass an in-memory duplex fake, and
the socket shim (`createWorkersNet`) is exercised against the same event semantics
`@browsercore/transport` depends on. A platform built **without** `connect` still works
for crypto/compression-only use; the first `network.tcp.connect()` throws a typed
`MissingConnectError` naming the fix.

## Platform notes (read before deploying)

- **Simultaneous connection limit — 6.** Workers caps simultaneously open `connect()` TCP
  sockets at 6 per invocation. @browsercore's connection pooling will happily try to open
  more under concurrency. Guidance: create the client per request (as the demo does),
  close it in `finally`, set `idleTimeoutMs: 0`, and keep request-level concurrency at or
  below 6; or front concurrent fetches through a queue.
- **No HTTP/3.** No UDP ⇒ no QUIC ⇒ the `udp` stub throws. Profiles must not offer
  `h3`/`alt-svc` upgrades on this adapter; HTTP/1.1 and HTTP/2 over TCP are unaffected.
- **CPU time is paid-plan territory.** A TLS 1.3 handshake + HTTP/2 exchange in pure-TS
  noble crypto burns well past the free plan's 10 ms CPU cap. Run on a paid plan
  (Bundled/Standard with higher CPU limits) — this is a PoC measured against Workers'
  paid tier, not the free tier.
- **`compatibility_date >= 2026-08-04` + `nodejs_compat`** are required for `node:crypto`
  verify and `node:zlib`; both are load-bearing, see `examples/wrangler.jsonc`.

## Verifying the fingerprint (JA4) — recipe

The unit suite proves the adapter's primitives (vectors) but not the wire; the live
gate needs a real deploy and is intentionally **out of scope for CI here**. Verify
manually, exactly like `@browsercore/crawlee`'s live gate:

1. Deploy the demo worker (`npx wrangler deploy` from a project holding
   `examples/wrangler.jsonc` + `examples/demo-worker.ts`).
2. `curl -s "https://<your-worker>.<account>.workers.dev/?url=https://tls.peet.ws/api/all"`
   — the demo fetches the peet.ws echo oracle **through the @browsercore stack** and
   returns its JSON.
3. In the JSON, assert the fingerprint fields exactly (no prefix matching):
   - `tls.ja4` must equal the golden real-Chrome JA4 the polyrepo pins:
     **`t13d1516h2_8daaf6152771_d8a2da3f94cd`** (real Chrome 146 via tls.browserleaks.com,
     2026-10-31 — the same golden browsersmith's and crawlee's suites hold).
   - `http2.akamai_fingerprint` must equal
     **`1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`**.
4. Any drift means the wire is no longer browser-identical — treat it as a regression.

## Development

```bash
npm install
npm run typecheck
npm run lint -- --deny-warnings
npm test -- --coverage   # thresholds: 94% stmts / 92% branches
npm run build
```

Integration test against real workerd (not run in CI — needs the workerd binary;
verified locally with workerd 2026-08-15 + `nodejs_compat`, 5/5 green — the suite
proves the package loads and every adapter behaves inside actual workerd):

```bash
npm install --no-save @cloudflare/vitest-pool-workers   # deprecated → @cloudflare/vitest-plugin, still works
npx vitest run -c vitest.workers.config.ts
```

## License

MIT
