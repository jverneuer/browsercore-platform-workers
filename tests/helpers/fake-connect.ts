/**
 * In-memory fake for `cloudflare:sockets`' `connect` + `Socket` handle.
 *
 * The socket shim is dependency-injected by design — this fake is the test
 * side of that seam (code-standards rule 21). It gives the test full control
 * over the three things the shim consumes: when `opened` resolves, what the
 * readable side delivers, and when the writable side accepts bytes.
 */

import type {
    WorkersConnect,
    WorkersConnectOptions,
    WorkersSocketAddress,
    WorkersSocketHandle,
} from "../../src/net/types.js";

/** A deferred with externally-held settle handles. */
export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
}

export function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Everything a test wants to observe about one fake connection. */
export interface FakeHandle extends WorkersSocketHandle {
    /** Resolve to make `opened` settle — the shim fires "connect" after this. */
    open(): void;
    /** Reject `opened` — simulates a handshake failure. */
    failOpen(error: Error): void;
    /** Deliver a chunk to the readable side (emits "data" on the shim). */
    push(chunk: Uint8Array): void;
    /** Finish the readable side (emits "end" then "close"(false)). */
    endReadable(): void;
    /** Error the readable side mid-stream (pump emits "error" + "close"(true)). */
    errorReadable(error: Error): void;
    /** Bytes accepted by the writable sink, in order. */
    readonly written: Uint8Array[];
    /** Gate the writable sink: writes settle their cbs only after `release()`. */
    blockWrites(): void;
    releaseWrites(): void;
    /** Fail the pending gated write (pending write cbs receive the error). */
    failPendingWrite(error: unknown): void;
    /** Whether the sink saw writer.close() (the shim's end()). */
    readonly endCalled: boolean;
    /** Whether the shim called handle.close() (destroy path). */
    readonly closeCalled: boolean;
}

/** Build a fully controllable fake socket handle. */
export function createFakeHandle(): FakeHandle {
    const opened = deferred<void>();
    let readController!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
            readController = controller;
        },
    });

    const written: Uint8Array[] = [];
    let writeGate: Promise<void> | undefined;
    let writeGateRelease: (() => void) | undefined;
    let pendingWriteReject: ((error: Error) => void) | undefined;
    let endCalled = false;
    let closeCalled = false;

    const writable = new WritableStream<Uint8Array>({
        write: (chunk) =>
            new Promise<void>((resolve, reject) => {
                written.push(chunk);
                pendingWriteReject = reject;
                if (writeGate === undefined) {
                    resolve();
                    return;
                }
                void writeGate.then(resolve, reject);
            }),
        close: () => {
            endCalled = true;
            return Promise.resolve();
        },
    });

    return {
        opened: opened.promise,
        readable,
        writable,
        close: () => {
            closeCalled = true;
            return Promise.resolve();
        },
        open: () => opened.resolve(),
        failOpen: (error: Error) => opened.reject(error),
        push: (chunk: Uint8Array) => readController.enqueue(chunk),
        endReadable: () => readController.close(),
        errorReadable: (error: Error) => readController.error(error),
        written,
        blockWrites: () => {
            writeGate = new Promise<void>((resolve) => {
                writeGateRelease = resolve;
            });
        },
        releaseWrites: () => {
            writeGateRelease?.();
            writeGate = undefined;
            writeGateRelease = undefined;
        },
        failPendingWrite: (error: unknown) => {
            pendingWriteReject?.(error as Error);
            pendingWriteReject = undefined;
        },
        get endCalled(): boolean {
            return endCalled;
        },
        get closeCalled(): boolean {
            return closeCalled;
        },
    };
}

/** Recorded arguments of every `connect` call the fake received. */
export interface RecordedConnectCall {
    readonly address: WorkersSocketAddress;
    readonly options: WorkersConnectOptions | undefined;
}

/**
 * Fake `connect` returning `handle` (or rejecting with `failure`), recording
 * every call.
 */
export function createFakeConnect(handle?: FakeHandle, failure?: Error): {
    connect: WorkersConnect;
    calls: RecordedConnectCall[];
} {
    const calls: RecordedConnectCall[] = [];
    const connect: WorkersConnect = async (address, options) => {
        calls.push({ address, options });
        if (failure !== undefined) {
            throw failure;
        }
        if (handle === undefined) {
            throw new Error("fake connect: no handle configured");
        }
        return handle;
    };
    return { connect, calls };
}

/** Let pending microtasks (the shim's async establish/pump) settle. */
export async function flush(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
}
