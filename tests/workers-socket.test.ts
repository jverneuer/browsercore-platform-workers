/**
 * Event-semantics tests for the Workers socket shim, run against the DI'd
 * fake `connect` (in-memory duplex) — no `cloudflare:sockets`, no workerd.
 *
 * Proves the contract `@browsercore/transport`'s TcpTransport depends on:
 * connect → data → end → close ordering, write-callback settlement with
 * promise-borne backpressure, "drain" never emitted, destroy paths, and
 * connect-failure mapping.
 */

import { describe, expect, it, vi } from "vitest";

import { createWorkersNet, WorkersSocket } from "../src/net/workers-net.js";
import { MissingConnectError } from "../src/errors.js";
import type { Socket } from "@browsercore/contracts";
import { createFakeConnect, createFakeHandle, flush } from "./helpers/fake-connect.js";

const fromUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function recordedSocket(): { socket: Socket; events: string[]; handle: ReturnType<typeof createFakeHandle> } {
    const handle = createFakeHandle();
    const { connect } = createFakeConnect(handle);
    const socket = createWorkersNet({ connect }).connect({ host: "example.com", port: 443 });
    const events: string[] = [];
    socket.once("connect", () => events.push("connect"));
    socket.on("data", (chunk) => events.push(`data:${new TextDecoder().decode(chunk)}`));
    socket.on("end", () => events.push("end"));
    socket.on("error", (err) => events.push(`error:${err.message}`));
    socket.on("close", (hadError) => events.push(`close:${hadError}`));
    return { socket, events, handle };
}

describe("createWorkersNet.connect — address translation", () => {
    it("maps ConnectOptions.host to the Workers hostname form and requests half-open", async () => {
        const handle = createFakeHandle();
        const { connect, calls } = createFakeConnect(handle);
        createWorkersNet({ connect }).connect({ host: "example.com", port: 8443 });
        await flush();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.address).toEqual({ hostname: "example.com", port: 8443 });
        // allowHalfOpen keeps the read side alive across end() — Node FIN semantics.
        expect(calls[0]?.options).toEqual({ allowHalfOpen: true });
    });

    it("returns a WorkersSocket synchronously (before the connection is up)", () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const socket = createWorkersNet({ connect }).connect({ host: "example.com", port: 443 });
        expect(socket).toBeInstanceOf(WorkersSocket);
        expect(socket.destroyed).toBe(false);
    });
});

describe("connect → data → end → close ordering", () => {
    it("fires connect once opened, then data chunks in order, then end and close(false)", async () => {
        const { socket, events, handle } = recordedSocket();
        // Data queued BEFORE the handshake completes must still arrive after
        // "connect" — the pump starts only once the socket is open.
        handle.push(fromUtf8("hello "));
        handle.push(fromUtf8("world"));
        handle.open();
        await flush();
        handle.endReadable();
        await flush();
        expect(events).toEqual(["connect", "data:hello ", "data:world", "end", "close:false"]);
        expect(socket.destroyed).toBe(true);
    });

    it("delivers multiple chunks in FIFO order across several pump ticks", async () => {
        const { events, handle } = recordedSocket();
        handle.open();
        await flush();
        handle.push(fromUtf8("a"));
        await flush();
        handle.push(fromUtf8("b"));
        await flush();
        handle.endReadable();
        await flush();
        expect(events).toEqual(["connect", "data:a", "data:b", "end", "close:false"]);
    });

    it("once('connect') fires exactly once", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        const onConnect = vi.fn();
        socket.once("connect", onConnect);
        handle.open();
        await flush();
        handle.push(fromUtf8("x"));
        await flush();
        expect(onConnect).toHaveBeenCalledTimes(1);
    });
});

describe("write semantics", () => {
    it("always returns true and settles cb(null) once the stream accepts the bytes", async () => {
        const { socket, handle } = recordedSocket();
        handle.open();
        await flush();
        const cb = vi.fn();
        const accepted = socket.write(fromUtf8("ping"), cb);
        expect(accepted).toBe(true);
        await flush();
        expect(cb).toHaveBeenCalledWith(null);
        expect(Buffer.from(handle.written[0] ?? []).toString()).toBe("ping");
    });

    it("backpressure flows through the write promise: cb pends until the stream drains", async () => {
        const { socket, handle } = recordedSocket();
        handle.open();
        await flush();
        handle.blockWrites();
        const cb = vi.fn();
        socket.write(fromUtf8("slow"), cb);
        await flush();
        expect(cb).not.toHaveBeenCalled(); // stream is "full" — cb must not settle
        handle.releaseWrites();
        await flush();
        expect(cb).toHaveBeenCalledWith(null);
    });

    it("never emits 'drain' (backpressure is promise-borne, not event-borne)", async () => {
        const { socket, handle } = recordedSocket();
        const onDrain = vi.fn();
        socket.on("drain", onDrain);
        handle.open();
        await flush();
        handle.blockWrites();
        socket.write(fromUtf8("a"), vi.fn());
        await flush();
        handle.releaseWrites();
        socket.write(fromUtf8("b"), vi.fn());
        await flush();
        expect(onDrain).not.toHaveBeenCalled();
    });

    it("write before connect settles cb with an error naming the state", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        const cb = vi.fn();
        const accepted = socket.write(fromUtf8("early"), cb);
        expect(accepted).toBe(true);
        await flush();
        expect(cb).toHaveBeenCalledTimes(1);
        const err = cb.mock.calls[0]?.[0] as Error | null | undefined;
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toBe("write before connect");
    });

    it("write after destroy settles cb with an error", async () => {
        const { socket, handle } = recordedSocket();
        handle.open();
        await flush();
        socket.destroy();
        await flush();
        const cb = vi.fn();
        socket.write(fromUtf8("late"), cb);
        await flush();
        const err = cb.mock.calls[0]?.[0] as Error | null | undefined;
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toBe("socket destroyed");
    });
});

describe("end() — graceful half-close", () => {
    it("before connect is a no-op (nothing to half-close, no events)", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        const events: string[] = [];
        socket.on("close", (hadError) => events.push(`close:${hadError}`));
        socket.end(); // never opened — must not throw, must not close anything
        await flush();
        expect(handle.endCalled).toBe(false);
        expect(events).toEqual([]);
        expect(socket.destroyed).toBe(false);
    });

    it("closes the writable side without emitting terminal events; readable still delivers", async () => {
        const { socket, events, handle } = recordedSocket();
        handle.open();
        await flush();
        socket.end();
        await flush();
        expect(handle.endCalled).toBe(true);
        expect(events).toEqual(["connect"]); // end() is not a terminal event
        // Half-open: the remote may still send after our FIN.
        handle.push(fromUtf8("bye"));
        handle.endReadable();
        await flush();
        expect(events).toEqual(["connect", "data:bye", "end", "close:false"]);
        expect(socket.destroyed).toBe(true);
    });

    it("is idempotent — a second end() does not throw or double-close", async () => {
        const { socket, handle } = recordedSocket();
        handle.open();
        await flush();
        socket.end();
        socket.end();
        await flush();
        expect(handle.endCalled).toBe(true);
    });
});

describe("destroy() — forceful teardown", () => {
    it("with an error: closes the handle, emits error then close(true)", async () => {
        const { socket, events, handle } = recordedSocket();
        handle.open();
        await flush();
        const boom = new Error("reset");
        socket.destroy(boom);
        await flush();
        expect(handle.closeCalled).toBe(true);
        expect(events).toEqual(["connect", "error:reset", "close:true"]);
        expect(socket.destroyed).toBe(true);
    });

    it("without an error: still close(true), no error event", async () => {
        const { socket, events, handle } = recordedSocket();
        handle.open();
        await flush();
        socket.destroy();
        await flush();
        expect(handle.closeCalled).toBe(true);
        expect(events).toEqual(["connect", "close:true"]);
    });

    it("is idempotent — a second destroy emits nothing further", async () => {
        const { socket, events, handle } = recordedSocket();
        handle.open();
        await flush();
        socket.destroy(new Error("first"));
        socket.destroy(new Error("second"));
        await flush();
        expect(events).toEqual(["connect", "error:first", "close:true"]);
    });

    it("during the handshake: the handle is closed once it appears, no connect fires", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        const events: string[] = [];
        socket.once("connect", () => events.push("connect"));
        socket.on("close", (hadError) => events.push(`close:${hadError}`));
        socket.destroy(new Error("cancelled"));
        handle.open(); // handshake completes after the destroy
        await flush();
        expect(handle.closeCalled).toBe(true);
        expect(events).toEqual(["close:true"]);
        expect(socket.destroyed).toBe(true);
    });
});

describe("connect failure mapping", () => {
    it("connect() rejection emits error + close(true)", async () => {
        const { connect } = createFakeConnect(undefined, new Error("refused"));
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        const events: string[] = [];
        socket.on("error", (err) => events.push(`error:${err.message}`));
        socket.on("close", (hadError) => events.push(`close:${hadError}`));
        await flush();
        expect(events).toEqual(["error:refused", "close:true"]);
        expect(socket.destroyed).toBe(true);
    });

    it("opened() rejection (handshake dies mid-flight) emits error + close(true)", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        const events: string[] = [];
        socket.on("error", (err) => events.push(`error:${err.message}`));
        socket.on("close", (hadError) => events.push(`close:${hadError}`));
        handle.failOpen(new Error("tls broke"));
        await flush();
        expect(events).toEqual(["error:tls broke", "close:true"]);
    });

    it("non-Error rejection values are normalized to plain Error events", async () => {
        const connect: import("../src/net/types.js").WorkersConnect = () =>
            Promise.reject("string failure");
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        const events: string[] = [];
        socket.on("error", (err) => events.push(`error:${err.message}`));
        socket.on("close", (hadError) => events.push(`close:${hadError}`));
        await flush();
        expect(events).toEqual(["error:string failure", "close:true"]);
    });
});

describe("read-side failure mapping", () => {
    it("a readable stream error mid-pump emits error + close(true), not a clean close", async () => {
        const { socket, events, handle } = recordedSocket();
        handle.open();
        await flush();
        handle.push(fromUtf8("partial"));
        await flush();
        handle.errorReadable(new Error("stream reset"));
        await flush();
        expect(events).toEqual(["connect", "data:partial", "error:stream reset", "close:true"]);
        expect(socket.destroyed).toBe(true);
        expect(handle.closeCalled).toBe(true); // stream error ⇒ connection dead ⇒ close handle
    });

    it("a readable error arriving after destroy() emits nothing further", async () => {
        const { socket, events, handle } = recordedSocket();
        handle.open();
        await flush();
        socket.destroy(new Error("first"));
        await flush();
        handle.errorReadable(new Error("late stream error"));
        await flush();
        expect(events).toEqual(["connect", "error:first", "close:true"]);
    });
});

describe("listener-registration edge cases", () => {
    it("supports multiple simultaneous 'data' listeners — all receive every chunk", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        const first: string[] = [];
        const second: string[] = [];
        socket.on("data", (chunk) => first.push(new TextDecoder().decode(chunk)));
        socket.on("data", (chunk) => second.push(new TextDecoder().decode(chunk)));
        handle.open();
        await flush();
        handle.push(fromUtf8("broadcast"));
        await flush();
        expect(first).toEqual(["broadcast"]);
        expect(second).toEqual(["broadcast"]);
    });

    it("a write rejected with a non-Error value normalizes to a plain Error in cb", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const socket = createWorkersNet({ connect }).connect({ host: "h", port: 1 });
        handle.open();
        await flush();
        handle.blockWrites();
        const cb = vi.fn();
        socket.write(fromUtf8("doomed"), cb);
        await flush();
        handle.failPendingWrite("writable exploded");
        await flush();
        const err = cb.mock.calls[0]?.[0] as Error | null | undefined;
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toBe("writable exploded");
    });
});

describe("platform TCP without injected connect", () => {
    it("createWorkersPlatform's default tcp throws MissingConnectError on connect", async () => {
        const { createWorkersPlatform } = await import("../src/platform/index.js");
        const platform = createWorkersPlatform();
        expect(() => platform.network.tcp.connect({ host: "h", port: 1 })).toThrow(MissingConnectError);
    });
});
