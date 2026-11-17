/**
 * Platform composition root for Cloudflare Workers.
 *
 * The Workers counterpart of `browsersmith/src/platform/index.ts`: assembles
 * every runtime adapter into a `Platform` (from `@browsercore/contracts`)
 * that `@browsercore/fetch` consumes. Zero `node:*` imports of its own — the
 * only two in this package are the compat-gated choices inside the adapters
 * (RSA/signature verify via `node:crypto`, zlib via `node:zlib`), each
 * documented at its import site.
 *
 *   createWorkersPlatform (composition root)
 *     ├── network:  cloudflare:sockets shim (DI'd connect) + edge DNS
 *     │             passthrough; udp OMITTED — no UDP on Workers, and
 *     │             contracts 0.2.6+ express that as absence, not a stub
 *     │             (no UDP ⇒ no HTTP/3)
 *     ├── crypto:   @noble/* pure-TS provider (WorkersCryptoProvider)
 *     ├── compression: node:zlib sync family (WorkersCompressionProvider)
 *     ├── events:   Map-based EventProvider (WorkersEventProvider)
 *     ├── telemetry: no-op (zero-cost default)
 *     └── time:     the canonical Clock — now / monotonic(ms) / sleep /
 *                  setTimeout(ms, fn) / clearTimeout (workersTime)
 *
 * `connect` is injected, not imported: `cloudflare:sockets` is only available
 * inside a Worker, so the Worker passes the real binding and tests pass
 * fakes. TCP without an injected `connect` fails loudly with a typed
 * {@link MissingConnectError} at connect time — the Platform itself still
 * builds (crypto/compression-only consumers never notice).
 *
 * @module
 */

import type {
    Compression,
    Crypto,
    DnsResolver,
    EventProvider,
    Net,
    Network,
    Platform as ContractPlatform,
    PlatformOptions as ContractPlatformOptions,
    Telemetry,
    Time,
} from "@browsercore/contracts";

import { workersCryptoProvider } from "../crypto/workers-crypto-provider.js";
import { workersCompression } from "../compression/workers-compression.js";
import { workersEventProvider } from "../events/workers-event-provider.js";
import { createWorkersNet } from "../net/workers-net.js";
import { workersDns } from "../net/workers-dns.js";
import { noOpTelemetry } from "../telemetry/no-op-telemetry.js";
import { workersTime } from "../time/workers-time.js";
import { MissingConnectError } from "../errors.js";
import type { WorkersConnect } from "../net/types.js";

/** The Platform type — re-exported from @browsercore/contracts (single source of truth). */
export type Platform = ContractPlatform;

/** Platform override options — re-exported from @browsercore/contracts. */
export type PlatformOptions = ContractPlatformOptions;

/**
 * The Worker's `env` bindings object.
 *
 * None of the current adapters consume bindings, but the parameter is part
 * of the signature so call sites never change as binding-backed adapters
 * arrive (e.g. a Durable-Object-backed DNS or KV-backed profile cache) —
 * the same reason `createPlatform(options)` grew without breaking
 * browsersmith call sites.
 */
export type WorkersEnv = Record<string, unknown>;

/** Platform options with the Workers-specific `connect` injection. */
export interface WorkersPlatformOptions extends PlatformOptions {
    /**
     * The real `import { connect } from "cloudflare:sockets"` binding (or a
     * test fake). Omit it only when no TCP is needed — `network.tcp.connect`
     * then throws {@link MissingConnectError}.
     */
    readonly connect?: WorkersConnect;
}

/**
 * The network bundle `createWorkersPlatform` always assembles: TCP (the
 * connect-injected shim, or the {@link MissingConnectError} shim when no
 * `connect` was injected) and edge DNS passthrough are UNCONDITIONAL, so the
 * type says so. `udp` stays optional — Workers has no UDP socket API, and
 * contracts 0.2.6+ express that as the field's absence, never a stub.
 */
export interface WorkersNetwork extends Omit<Network, "tcp" | "dns"> {
    readonly tcp: Net;
    readonly dns: DnsResolver;
}

/**
 * What `createWorkersPlatform` returns — the canonical `Platform` with every
 * bundle Workers can back REQUIRED. The factory populates network, crypto,
 * compression, events, telemetry, and time unconditionally; the all-optional
 * contract shape is the ceiling of what a runtime MAY provide, not a claim
 * that this one might withhold them, so the signature carries the narrower
 * truth. Consumers (and the test suite) never re-guard what the type already
 * proves; `network.udp` remains the sole optional member.
 *
 * Assignable to `Platform` in every direction that matters — providing more
 * than a consumer requires always satisfies the interface — so `fetch` and
 * every `Platform`-typed seam keep accepting it unchanged.
 */
export interface WorkersPlatform
    extends Omit<
        ContractPlatform,
        "network" | "crypto" | "compression" | "events" | "telemetry" | "time"
    > {
    readonly network: WorkersNetwork;
    readonly crypto: Crypto;
    readonly compression: Compression;
    readonly events: EventProvider;
    readonly telemetry: Telemetry;
    readonly time: Time;
}

/** `Net` that names the fix the moment TCP is attempted without an injection. */
const missingConnectNet: Net = {
    connect: (): never => {
        throw new MissingConnectError(
            "network.tcp is unavailable",
            "pass cloudflare:sockets' connect via createWorkersPlatform(env, { connect })",
        );
    },
};

/**
 * Build a Workers `Platform`.
 *
 * Since contracts 0.2.6 every Platform bundle is OPTIONAL — a platform
 * carries exactly the capabilities its runtime has. This adapter provides
 * every bundle Workers can back (network TCP+DNS, crypto, compression,
 * events, telemetry, time — an implementation that provides more than a
 * consumer requires always satisfies the interface) and omits exactly one:
 * `network.udp`, because Workers has no UDP socket API. "No UDP ⇒ no QUIC ⇒
 * no HTTP/3" is expressed by the field's ABSENCE, never by a throwing stub —
 * consumers dereference defensively (`platform.network?.udp`) and raise
 * their own typed error naming the missing capability, the sanctioned
 * pattern from `@browsercore/fetch`'s `proxyDialPlatform`.
 *
 * @param env    The Worker's env bindings (reserved seam — see {@link WorkersEnv}).
 * @param options Override individual adapters; `connect` enables TCP.
 * @returns A fully-assembled {@link WorkersPlatform} (a `Platform` with every
 *   Workers-backable bundle required) for `@browsercore/fetch`.
 *
 * @example
 * ```ts
 * import { connect } from "cloudflare:sockets";
 * import { createWorkersPlatform } from "@browsercore/platform-workers";
 *
 * export default {
 *     async fetch(request: Request, env: unknown) {
 *         const platform = createWorkersPlatform(env, { connect });
 *         // … createClient({ platform, profile: "chrome-140" }) …
 *     },
 * } satisfies ExportedHandler;
 * ```
 */
export function createWorkersPlatform(
    env?: WorkersEnv,
    options?: WorkersPlatformOptions,
): WorkersPlatform {
    void env; // Reserved bindings seam — documented on WorkersEnv.
    const connect = options?.connect;
    const udpOverride = options?.network?.udp;
    const network: WorkersNetwork = {
        tcp: options?.network?.tcp ?? (connect === undefined ? missingConnectNet : createWorkersNet({ connect })),
        dns: options?.network?.dns ?? workersDns,
        // No UDP on Workers: the field stays ABSENT unless a caller injects a
        // factory (tests, or a future runtime that grows UDP). The conditional
        // spread — not `udp: options?.network?.udp` — because
        // exactOptionalPropertyTypes forbids explicitly writing `undefined`
        // into an optional field.
        ...(udpOverride === undefined ? {} : { udp: udpOverride }),
    };
    return {
        network,
        crypto: {
            provider: options?.crypto?.provider ?? workersCryptoProvider,
        },
        compression: options?.compression ?? workersCompression,
        events: options?.events ?? workersEventProvider,
        telemetry: options?.telemetry ?? noOpTelemetry,
        time: options?.time ?? workersTime,
    };
}
