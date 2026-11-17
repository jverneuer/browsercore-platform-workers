/**
 * DI seam types for `cloudflare:sockets`.
 *
 * The socket shim never imports `cloudflare:sockets` itself — the Worker
 * passes the real `connect` in, tests pass fakes. These types are the
 * structural subset of `typeof import("cloudflare:sockets")["connect"]` that
 * the shim actually consumes, declared locally so the package (and its CI)
 * typecheck without ambient Workers types while remaining assignable from
 * the real module binding.
 *
 * @module
 */

/** Target address for a Workers TCP connection (Cloudflare spells it `hostname`). */
export interface WorkersSocketAddress {
    readonly hostname: string;
    readonly port: number;
}

/** Options `connect` accepts; the shim only sets `allowHalfOpen`. */
export interface WorkersConnectOptions {
    readonly secureTransport?: "off" | "start" | "starttls";
    readonly allowHalfOpen?: boolean;
}

/**
 * The piece of a Workers `Socket` the shim consumes: the `opened` handshake
 * promise, the raw stream pair, and `close()`.
 */
export interface WorkersSocketHandle {
    readonly opened: Promise<void>;
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    close(): Promise<void>;
}

/**
 * Dependency-injected `connect` — structurally compatible with
 * `cloudflare:sockets`' `connect`.
 */
export type WorkersConnect = (
    address: WorkersSocketAddress,
    options?: WorkersConnectOptions,
) => Promise<WorkersSocketHandle>;

/** Every event name the socket shim can emit. */
export type SocketEventName = "connect" | "data" | "end" | "drain" | "error" | "close";
