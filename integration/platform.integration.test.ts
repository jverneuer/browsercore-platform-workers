/**
 * Real-workerd integration test for createWorkersPlatform.
 *
 * Runs INSIDE workerd via @cloudflare/vitest-pool-workers (see
 * vitest.workers.config.ts) — the same runtime shape a deployed Worker gets.
 * Proves the package loads and behaves on the actual platform: pure-noble
 * crypto (vectors), nodejs_compat-gated zlib compression, Map events,
 * Web-standard time, and the DI'd socket shim running against an in-memory
 * fake (the real `cloudflare:sockets` binding with outbound TCP is only
 * available to deployed Workers; the DI seam is exactly what lets us test
 * without it).
 */

import { describe, expect, it } from "vitest";

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

import { createWorkersPlatform } from "../src/platform/index.js";
import { WorkersSocket } from "../src/net/workers-net.js";
import { MissingConnectError, UnsupportedOnWorkersError } from "../src/errors.js";
import type { Socket } from "@browsercore/contracts";

const fromHex = (hex: string): Uint8Array =>
    new Uint8Array((hex.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));
const fromUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("createWorkersPlatform on real workerd", () => {
    it("composes and serves the full crypto surface (noble vectors pass on workerd)", () => {
        const platform = createWorkersPlatform({ INTEGRATION: true });
        // RFC 7748 §6.1 — the X25519 DH vector, pure noble, in workerd.
        expect(
            platform.crypto.provider.x25519SharedSecret(
                fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"),
                fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"),
            ),
        ).toEqual(fromHex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"));
        // FIPS 180-4 sha256 vector.
        expect(Buffer.from(platform.crypto.provider.sha256(fromUtf8("abc"))).toString("hex")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        // ML-KEM-768 FIPS 203 sizes + hybrid layout: 64 bytes, PQ first.
        const mlkemKp = platform.crypto.provider.mlkem768GenerateKeyPair();
        expect(mlkemKp.publicKey).toHaveLength(1184);
        const ciphertext = ml_kem768.encapsulate(mlkemKp.publicKey).cipherText;
        const x25519Kp = platform.crypto.provider.x25519GenerateKeyPair();
        const hybrid = platform.crypto.provider.x25519MLKEM768SharedSecret(
            x25519Kp.secretKey,
            x25519Kp.publicKey,
            mlkemKp.secretKey,
            ciphertext,
        );
        expect(hybrid).toHaveLength(64);
        expect(hybrid.subarray(0, 32)).toEqual(
            platform.crypto.provider.mlkem768Decapsulate(mlkemKp.secretKey, ciphertext),
        );
    });

    it("zlib compression works through nodejs_compat on workerd", () => {
        const platform = createWorkersPlatform();
        const body = fromUtf8("workerd round trip ".repeat(8));
        expect(platform.compression.decompress(platform.compression.gzip(body), "gzip")).toEqual(body);
        expect(platform.compression.decompress(platform.compression.brotliCompress(body), "br")).toEqual(body);
    });

    it("events + time behave on workerd", () => {
        const platform = createWorkersPlatform();
        const seen: string[] = [];
        platform.events.on("tick", (...args: unknown[]) => seen.push(args.join(" ")));
        expect(platform.events.emit("tick", "on", "workerd")).toBe(true);
        expect(seen).toEqual(["on workerd"]);
        expect(platform.time.clock.now()).toBeGreaterThan(0);
        expect(platform.time.clock.monotonic()).toBeGreaterThan(0n);
    });

    it("DNS passthrough + UDP stub keep their contracts on workerd", async () => {
        const platform = createWorkersPlatform();
        await expect(platform.network.dns.lookup("example.com", 4)).resolves.toEqual([
            { address: "example.com", family: 4 },
        ]);
        await expect(platform.network.udp.recv()).rejects.toThrow(UnsupportedOnWorkersError);
        expect(() => platform.network.tcp.connect({ host: "h", port: 1 })).toThrow(MissingConnectError);
    });

    it("the socket shim runs on workerd against the DI'd fake connect", async () => {
        const handle = createInMemoryHandle();
        const platform = createWorkersPlatform(undefined, { connect: () => handle.openedHandle });
        const socket: Socket = platform.network.tcp.connect({ host: "example.com", port: 443 });
        expect(socket).toBeInstanceOf(WorkersSocket);
        const events: string[] = [];
        socket.once("connect", () => events.push("connect"));
        socket.on("data", (chunk) => events.push(`data:${new TextDecoder().decode(chunk)}`));
        socket.on("close", (hadError) => events.push(`close:${hadError}`));
        handle.open();
        await settle();
        handle.push(fromUtf8("from workerd"));
        await settle();
        handle.endReadable();
        await settle();
        expect(events).toEqual(["connect", "data:from workerd", "close:false"]);
    });
});

// ---------------------------------------------------------------------------
// Minimal in-memory fake — self-contained (the integration dir does not
// share the unit-suite helpers).
// ---------------------------------------------------------------------------

/** The WorkersSocketHandle subset the shim consumes. */
interface OpenedHandle {
    readonly opened: Promise<void>;
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    close(): Promise<void>;
}

interface InMemoryHandle {
    readonly openedHandle: Promise<OpenedHandle>;
    open(): void;
    push(chunk: Uint8Array): void;
    endReadable(): void;
}

function createInMemoryHandle(): InMemoryHandle {
    let open!: () => void;
    let readController!: ReadableStreamDefaultController<Uint8Array>;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    const readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
            readController = controller;
        },
    });
    const writable = new WritableStream<Uint8Array>();
    const openedHandle = Promise.resolve({
        opened,
        readable,
        writable,
        close: () => Promise.resolve(),
    } satisfies OpenedHandle);
    return {
        openedHandle,
        open,
        push: (chunk: Uint8Array) => readController.enqueue(chunk),
        endReadable: () => readController.close(),
    };
}

/** Let workerd microtasks (shim establish/pump) settle. */
async function settle(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
}
