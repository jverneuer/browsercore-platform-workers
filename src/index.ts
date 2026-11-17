/**
 * @browsercore/platform-workers — the Cloudflare Workers Platform adapter
 * for the @browsercore stack.
 *
 * Composes the runtime services (`@browsercore/contracts` `Platform`) a
 * Worker needs to run browser-identical TLS: a pure-noble sync crypto
 * provider, a `cloudflare:sockets` TCP shim (DI'd connect), edge DNS
 * passthrough, node:zlib-sync compression, a Map-based event provider, and
 * the canonical `Clock` over Web-standard time. `network.udp` is omitted —
 * contracts 0.2.6+ make every bundle optional, so "no UDP ⇒ no HTTP/3 on
 * Workers" is expressed by absence, not a throwing stub. See
 * `createWorkersPlatform` for the composition root and
 * `examples/demo-worker.ts` for a complete Worker.
 *
 * @packageDocumentation
 */

export { createWorkersPlatform } from "./platform/index.js";
export type {
    Platform,
    PlatformOptions,
    WorkersEnv,
    WorkersNetwork,
    WorkersPlatform,
    WorkersPlatformOptions,
} from "./platform/index.js";

export { createWorkersNet, WorkersSocket } from "./net/workers-net.js";
export type { WorkersNetOptions } from "./net/workers-net.js";
export { workersDns } from "./net/workers-dns.js";
export type {
    SocketEventName,
    WorkersConnect,
    WorkersConnectOptions,
    WorkersSocketAddress,
    WorkersSocketHandle,
} from "./net/types.js";

export { WorkersCryptoProvider, workersCryptoProvider } from "./crypto/workers-crypto-provider.js";
export { WorkersCompressionProvider, workersCompression } from "./compression/workers-compression.js";
export { WorkersEventProvider, workersEventProvider } from "./events/workers-event-provider.js";
export { workersTime } from "./time/workers-time.js";
export { noOpTelemetry } from "./telemetry/no-op-telemetry.js";

export { assertNever } from "./utils.js";
export {
    CryptoError,
    DecryptError,
    DecompressionError,
    MissingConnectError,
    UnsupportedAlgorithmError,
    UnsupportedEncodingError,
    WorkersPlatformError,
} from "./errors.js";
export type { CryptoErrorKind, WorkersPlatformErrorKind } from "./errors.js";
