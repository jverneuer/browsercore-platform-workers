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
 *     │             passthrough + throwing UDP stub (no UDP ⇒ no HTTP/3)
 *     ├── crypto:   @noble/* pure-TS provider (WorkersCryptoProvider)
 *     ├── compression: node:zlib sync family (WorkersCompressionProvider)
 *     ├── events:   Map-based EventProvider (WorkersEventProvider)
 *     ├── telemetry: no-op (zero-cost default)
 *     └── time:     Date.now / performance.now / setTimeout (workersTime)
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
    Net,
    Platform as ContractPlatform,
    PlatformOptions as ContractPlatformOptions,
} from "@browsercore/contracts";

import { workersCryptoProvider } from "../crypto/workers-crypto-provider.js";
import { workersCompression } from "../compression/workers-compression.js";
import { workersEventProvider } from "../events/workers-event-provider.js";
import { createWorkersNet } from "../net/workers-net.js";
import { workersDns } from "../net/workers-dns.js";
import { workersUdp } from "../net/workers-udp.js";
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
 * @param env    The Worker's env bindings (reserved seam — see {@link WorkersEnv}).
 * @param options Override individual adapters; `connect` enables TCP.
 * @returns A fully-assembled Platform for `@browsercore/fetch`.
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
): Platform {
    void env; // Reserved bindings seam — documented on WorkersEnv.
    const connect = options?.connect;
    return {
        network: {
            tcp: options?.network?.tcp ?? (connect === undefined ? missingConnectNet : createWorkersNet({ connect })),
            dns: options?.network?.dns ?? workersDns,
            udp: options?.network?.udp ?? workersUdp,
        },
        crypto: {
            provider: options?.crypto?.provider ?? workersCryptoProvider,
        },
        compression: options?.compression ?? workersCompression,
        events: options?.events ?? workersEventProvider,
        telemetry: options?.telemetry ?? noOpTelemetry,
        time: options?.time ?? workersTime,
    };
}
