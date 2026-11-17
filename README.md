# @browsercore/platform-workers

[![npm version](https://img.shields.io/npm/v/@browsercore/platform-workers)](https://www.npmjs.com/package/@browsercore/platform-workers)
[![coverage](https://img.shields.io/endpoint?url=https://jverneuer.github.io/browsercore-platform-workers/badge.json)](https://jverneuer.github.io/browsercore-platform-workers/COVERAGE.md)
[![CI](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-platform-workers/ci.yml?label=ci)](https://github.com/jverneuer/browsercore-platform-workers/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@browsercore/platform-workers.svg)](LICENSE)

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
| UDP | **absent** | **No UDP on Workers ⇒ no QUIC ⇒ no HTTP/3.** Contracts 0.2.6+ make every Platform bundle optional, so "no UDP" is expressed by omitting `network.udp` entirely — absence, not a throwing stub. Consumers that need it dereference defensively and raise their own typed error naming the capability. |
| compression | `node:zlib` sync family (compat) | Mirrors browsersmith's Node zlib adapter one-for-one, including the browser-tolerant raw-deflate fallback. |
| events | Map-based `EventProvider` | The 8-method contracts surface; no `node:events` on workerd. |
| time | Web standards | The canonical `Clock` (contracts 0.2.6+: `Time ≡ Clock`): `now` (`Date.now`), `monotonic` in ms (`performance.now`), `sleep`, `setTimeout(ms, fn)` / `clearTimeout` over Web `setTimeout` with a boxed opaque `TimerHandle`; no `node:timers`. |

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

## Platform semantics (contracts ≥ 0.2.6)

Contracts 0.2.6 re-cut the `Platform` interface around two invariants; this adapter
implements both exactly:

1. **Every bundle is optional.** A platform carries exactly the capabilities its runtime
   has — the optionality exists so runtimes never have to FAKE capabilities they lack
   (the pre-0.2.6 required `network.udp` forced UDP-less runtimes to ship a lying stub).
   `createWorkersPlatform` provides every bundle Workers can back — network TCP+DNS,
   crypto, compression, events, telemetry, time — which is always valid: an
   implementation that provides more than a consumer requires satisfies the interface.
   The single omission is `network.udp`: Workers has no UDP socket API, so the field is
   **absent** (the key is not on the object at all), never a throwing stub. Consumers
   follow the sanctioned pattern from `@browsercore/fetch`'s `proxyDialPlatform`:
   dereference defensively (`platform.network?.udp`) and raise a typed error naming the
   missing capability if a code path needs it.
2. **`Time` is the canonical `Clock`.** The old `{ clock, scheduler }` bundle is gone;
   `Time ≡ Clock = { now, monotonic, sleep, setTimeout(ms, fn), clearTimeout }` with an
   opaque `TimerHandle`. `workersTime` implements it over Web standards only:
   `now()` = `Date.now()` (wall epoch ms), `monotonic()` = `performance.now()`
   (monotonic ms on workerd), `sleep`/`setTimeout`/`clearTimeout` over the global
   `setTimeout`/`clearTimeout` — with the timer token **boxed**, because workerd returns
   a numeric id where Node returns a `Timeout` object; the box keeps the handle a
   genuine opaque object on every runtime.

## Platform notes (read before deploying)

- **Simultaneous connection limit — 6.** Workers caps simultaneously open `connect()` TCP
  sockets at 6 per invocation. @browsercore's connection pooling will happily try to open
  more under concurrency. Guidance: create the client per request (as the demo does),
  close it in `finally`, set `idleTimeoutMs: 0`, and keep request-level concurrency at or
  below 6; or front concurrent fetches through a queue.
- **No HTTP/3.** No UDP ⇒ no QUIC ⇒ `network.udp` is simply absent from the platform
  (see [Platform semantics](#platform-semantics-contracts--026)). Profiles must not offer
  `h3`/`alt-svc` upgrades on this adapter; HTTP/1.1 and HTTP/2 over TCP are unaffected.
- **CPU time is paid-plan territory.** A TLS 1.3 handshake + HTTP/2 exchange in pure-TS
  noble crypto burns well past the free plan's 10 ms CPU cap. Run on a paid plan
  (Bundled/Standard with higher CPU limits) — the PoC was measured against Workers'
  paid tier, not the free tier. (Observed 2026-11-17: single handshakes *did* complete
  on a free-plan deploy — Cloudflare's free-tier CPU enforcement is bursty — but treat
  free deploys as smoke tests, not throughput evidence.)
- **workerd's `node:crypto` rejects `KeyObject` in `Verify.verify()`/`Sign.sign()`
  options objects** (Node accepts both). The provider therefore feeds raw DER with
  `format`/`type` — the one form both runtimes accept (fixed in 0.1.1; see
  `WorkersCryptoProvider.verifySignature`). Unit tests run on Node and cannot catch
  this class of drift: when touching the crypto surface, extend
  `integration/platform.integration.test.ts`, which runs against real workerd.
- **`compatibility_date >= 2026-08-04` + `nodejs_compat`** are required for `node:crypto`
  verify and `node:zlib`; both are load-bearing, see `examples/wrangler.jsonc`.

## Verifying the fingerprint (JA4) — recipe

The unit suite proves the adapter's primitives (vectors) but not the wire; the live
gate needs a real deploy and is intentionally **out of scope for CI here**. Verify
manually, exactly like `@browsercore/crawlee`'s live gate:

1. Deploy the demo worker — wrangler resolves config paths relative to the config
   file's directory, so point at the config explicitly:

   ```bash
   npx wrangler deploy -c examples/wrangler.jsonc   # from the repo root
   ```

   **Rebuild first:** the demo bundles the package's built `dist/` (package-exports
   self-reference), not `src/` — run `npm run build` after editing the provider, or
   the change silently doesn't ship.
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

**First live gate — 2026-11-17 (v0.1.1, real deployed Worker): PASS.** JA4 and
`akamai_fingerprint` exact-golden-matched across 5 fetches (`tls.peet.ws` ×4,
`tls.browserleaks.com` ×1), h2 negotiated, ~0.9–1.3 s wall per fetch. A same-day
real-world probe (Airbnb Türkiye search through the stack) hit **no challenge** where
plain-curl TLS was served a mismatched cached page — evidence Airbnb's edge
distinguishes fingerprints at the TLS/H2 layer. Note Airbnb listings hydrate
client-side (niobe GraphQL), so a raw HTML fetch of such SPA search pages returns
the shell without results regardless of fingerprint.

## Development

```bash
npm install
npm run typecheck
npm run lint -- --deny-warnings
npm test -- --coverage   # thresholds: 94% stmts / 92% branches
npm run build
```

Integration test against real workerd (not run in CI — needs the workerd binary;
verified locally with workerd 2026-08-15 + `nodejs_compat`, 6/6 green — the suite
proves the package loads and every adapter behaves inside actual workerd, including
`verifySignature` across all five TLS schemes with keys generated inside workerd):

```bash
npm install --no-save @cloudflare/vitest-pool-workers   # deprecated → @cloudflare/vitest-plugin, still works
npx vitest run -c vitest.workers.config.ts
```

## License

MIT
