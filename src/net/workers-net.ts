/**
 * `Net` adapter for Cloudflare Workers — the ~180-line socket shim from the
 * 2026-11-16 feasibility audit.
 *
 * `cloudflare:sockets`' `connect()` is async and stream-based; the
 * `@browsercore/contracts` `Socket` is a synchronous, event-emitting Node
 * shape. This shim bridges the two without touching `node:net`:
 *
 *   - `Net.connect()` returns a `WorkersSocket` synchronously; the async
 *     establishment happens in the background and fires `once("connect")`
 *     after the socket's `opened` promise resolves.
 *   - Reads: a pump over `readable.getReader()` emits `"data"` chunks, then
 *     `"end"`, then `"close"(false)` when the remote side finishes.
 *   - Writes: one writer is locked onto `writable`; `write()` always returns
 *     `true` and settles its callback when the stream accepts the bytes —
 *     backpressure flows through the write promise (the transport's write
 *     callback just takes longer to fire), so `"drain"` is never emitted.
 *   - `end()` half-closes via `writer.close()` (the connection is opened
 *     with `allowHalfOpen: true` so the read side survives the FIN — Node
 *     `socket.end()` semantics).
 *   - `destroy(err)` force-closes the Workers socket and emits
 *     `"error"` (if err) then `"close"(true)`.
 *
 * Errors surface as plain `Error` events — `@browsercore/transport`'s
 * `TcpTransport` wraps them into its typed errors upstream.
 *
 * @module
 */

import type { ConnectOptions, Net, Socket } from "@browsercore/contracts";
import type { SocketEventName, WorkersConnect, WorkersSocketHandle } from "./types.js";

/** Internal listener storage signature. */
type Listener = (...args: unknown[]) => void;

/**
 * Any specifically-typed listener (`(chunk: Uint8Array) => void`, …) is
 * assignable to this — `never` parameters accept everything under
 * contravariance — letting the typed public overloads funnel into one map.
 */
type SpecificListener = (...args: never[]) => void;

/** Options for {@link createWorkersNet}. */
export interface WorkersNetOptions {
    /** The injected `connect` — the real `cloudflare:sockets` binding, or a test fake. */
    readonly connect: WorkersConnect;
}

/**
 * `Socket` implementation over a Workers `Socket` handle.
 *
 * Constructed synchronously by {@link createWorkersNet}; establishment runs
 * in the background via {@link WorkersSocket.establish}. Consumers interact
 * only through the contracts `Socket` surface.
 */
export class WorkersSocket implements Socket {
    private readonly connect: WorkersConnect;
    private readonly connectOptions: ConnectOptions;
    private readonly listeners = new Map<SocketEventName, Set<Listener>>();
    private handle: WorkersSocketHandle | undefined;
    private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    private socketDestroyed = false;
    private endSent = false;

    constructor(connect: WorkersConnect, options: ConnectOptions) {
        this.connect = connect;
        this.connectOptions = options;
        void this.establish();
    }

    /** @inheritdoc */
    public get destroyed(): boolean {
        return this.socketDestroyed;
    }

    // -------------------------------------------------------------------------
    // Establishment + read pump
    // -------------------------------------------------------------------------

    /**
     * Dial, wait for `opened`, lock the writer, announce `"connect"`, and
     * start the read pump. Any failure here fails the socket with `"error"`
     * + `"close"(true)` — the transport's connect attempt rejects on it.
     */
    private async establish(): Promise<void> {
        let handle: WorkersSocketHandle;
        try {
            // Workers resolves hostnames at the edge, so the DNS layer can
            // pass names straight through. allowHalfOpen keeps the read side
            // alive after writer.close() (end()) — Node FIN semantics.
            // ConnectOptions.noDelay/localAddress/family have no Workers
            // equivalent (TCP_NODELAY is always on at the edge); ignored.
            handle = await this.connect(
                { hostname: this.connectOptions.host, port: this.connectOptions.port },
                { allowHalfOpen: true },
            );
            await handle.opened;
        } catch (cause) {
            // Connect refused / handshake died: destroy() emits the terminal
            // "error" + "close"(true) pair (and is a no-op if the consumer
            // destroyed us mid-handshake — no double events).
            this.destroy(cause instanceof Error ? cause : new Error(String(cause)));
            return;
        }
        if (this.socketDestroyed) {
            // destroy() raced the handshake — the socket is already closed.
            void handle.close().catch(() => {});
            return;
        }
        this.handle = handle;
        this.writer = handle.writable.getWriter();
        this.emitConnect();
        void this.pumpReads(handle.readable.getReader());
    }

    /**
     * Read pump: forward `readable` chunks as `"data"`, then emit
     * `"end"` + `"close"(false)` on natural completion. A stream error
     * surfaces as `"error"` + `"close"(true)` (a reset is not a clean
     * remote close and must not be reported as one).
     */
    private async pumpReads(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
        this.reader = reader;
        try {
            for (;;) {
                // Sequential by necessity: a stream read pump must consume
                // chunks in arrival order — Promise.all would buffer the
                // entire stream and defeat backpressure.
                // eslint-disable-next-line no-await-in-loop -- stream ordering is the point (see comment above)
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                this.emitData(value);
            }
        } catch (cause) {
            // A stream error is a failed connection, not a clean remote
            // close: destroy() closes the handle and emits "error" +
            // "close"(true). No-op if destroy() already ran.
            this.destroy(cause instanceof Error ? cause : new Error(String(cause)));
            return;
        }
        if (this.socketDestroyed) {
            return; // destroy() already emitted the terminal events.
        }
        this.emitEnd();
        this.emitClose(false);
        this.socketDestroyed = true;
    }

    // -------------------------------------------------------------------------
    // Socket contract surface
    // -------------------------------------------------------------------------

    /** @inheritdoc */
    public write(data: Uint8Array, cb?: (err?: Error | null) => void): boolean {
        const writer = this.writer;
        if (writer === undefined) {
            this.settleWrite(cb, new Error(this.handle === undefined ? "write before connect" : "socket destroyed"));
            return true;
        }
        // Always true: backpressure flows through the write promise — the
        // callback simply takes longer to settle while the stream is full.
        // "drain" is therefore never emitted. Bridging a Node-style write
        // callback over the stream's promise is this shim's entire job; the
        // stream serializes writes itself, so the callback cannot double-settle.
        void writer.write(data).then(
            // eslint-disable-next-line promise/no-callback-in-promise -- deliberate cb-over-promise bridge (see comment above)
            () => this.settleWrite(cb, null),
            // eslint-disable-next-line promise/no-callback-in-promise -- deliberate cb-over-promise bridge (see comment above)
            (cause: unknown) => this.settleWrite(cb, cause instanceof Error ? cause : new Error(String(cause))),
        );
        return true;
    }

    /**
     * Deliver a write result to the caller's callback and report what was
     * settled (no-op when the callback is absent).
     */
    private settleWrite(cb: ((err?: Error | null) => void) | undefined, error: Error | null): Error | null {
        cb?.(error);
        return error;
    }

    /** @inheritdoc */
    public end(): void {
        if (this.socketDestroyed || this.endSent) {
            return;
        }
        this.endSent = true;
        if (this.writer === undefined) {
            return; // never opened — nothing to half-close.
        }
        // Best-effort FIN: close() rejects if the stream already errored,
        // in which case teardown paths own the terminal events.
        void this.writer.close().catch(() => {});
    }

    /** @inheritdoc */
    public destroy(error?: Error): void {
        if (this.socketDestroyed) {
            return;
        }
        this.socketDestroyed = true;
        this.teardown();
        if (error !== undefined) {
            this.emitError(error);
        }
        this.emitClose(true);
    }

    /** Cancel the pump and close the Workers handle. Best-effort by design. */
    private teardown(): void {
        this.reader?.cancel().catch(() => {});
        if (this.handle !== undefined) {
            void this.handle.close().catch(() => {});
        }
        this.reader = undefined;
        this.writer = undefined;
    }

    // -------------------------------------------------------------------------
    // Typed event surface (contracts Socket overloads)
    // -------------------------------------------------------------------------

    /** @inheritdoc */
    public once(event: "connect" | "close", listener: () => void): void;
    /** @inheritdoc */
    public once(event: "error", listener: (err: Error) => void): void;
    public once(event: SocketEventName, listener: SpecificListener): void {
        const onceListener: Listener = (...args: unknown[]) => {
            this.removeListener(event, onceListener);
            (listener as Listener)(...args);
        };
        this.addListener(event, onceListener);
    }

    /** @inheritdoc */
    public on(event: "data", listener: (chunk: Uint8Array) => void): void;
    /** @inheritdoc */
    public on(event: "drain" | "end", listener: () => void): void;
    /** @inheritdoc */
    public on(event: "error", listener: (err: Error) => void): void;
    /** @inheritdoc */
    public on(event: "close", listener: (hadError: boolean) => void): void;
    public on(event: SocketEventName, listener: SpecificListener): void {
        this.addListener(event, listener as Listener);
    }

    private addListener(event: SocketEventName, listener: Listener): void {
        const set = this.listeners.get(event);
        if (set === undefined) {
            this.listeners.set(event, new Set([listener]));
        } else {
            set.add(listener);
        }
    }

    private removeListener(event: SocketEventName, listener: Listener): void {
        this.listeners.get(event)?.delete(listener);
    }

    /** Invoke listeners over a snapshot, so a `once` removal mid-emit is safe. */
    private invoke(event: SocketEventName, ...args: unknown[]): void {
        const set = this.listeners.get(event);
        if (set === undefined) {
            return;
        }
        for (const listener of Array.from(set)) {
            listener(...args);
        }
    }

    private emitConnect(): void {
        this.invoke("connect");
    }

    private emitData(chunk: Uint8Array): void {
        this.invoke("data", chunk);
    }

    private emitEnd(): void {
        this.invoke("end");
    }

    private emitError(error: Error): void {
        this.invoke("error", error);
    }

    private emitClose(hadError: boolean): void {
        this.invoke("close", hadError);
    }
}

/**
 * Build a Workers `Net` around an injected `connect`.
 *
 * The DI is the point: the Worker passes the real
 * `import { connect } from "cloudflare:sockets"`; tests pass an in-memory
 * fake. Neither side knows about the other (code-standards rule 21).
 *
 * @param options - Must carry the `connect` implementation.
 * @returns A `Net` whose `connect()` synchronously returns a `WorkersSocket`.
 */
export function createWorkersNet(options: WorkersNetOptions): Net {
    return {
        connect: (connectOptions: ConnectOptions): Socket =>
            new WorkersSocket(options.connect, connectOptions),
    };
}
