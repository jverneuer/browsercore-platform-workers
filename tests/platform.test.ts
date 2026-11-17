/**
 * Composition tests for createWorkersPlatform — the Workers counterpart of
 * browsersmith's platform/index.ts shape: defaults compose the Workers
 * adapters, PlatformOptions overrides replace them piecewise, and the
 * connect injection gates TCP.
 */

import { describe, expect, it } from "vitest";

import type { Platform } from "@browsercore/contracts";

import { createWorkersPlatform } from "../src/platform/index.js";
import { WorkersCompressionProvider } from "../src/compression/workers-compression.js";
import { WorkersCryptoProvider } from "../src/crypto/workers-crypto-provider.js";
import { WorkersEventProvider } from "../src/events/workers-event-provider.js";
import { WorkersSocket } from "../src/net/workers-net.js";
import { MissingConnectError, UnsupportedOnWorkersError } from "../src/errors.js";
import { createFakeConnect, createFakeHandle, flush } from "./helpers/fake-connect.js";

describe("createWorkersPlatform — defaults", () => {
    it("fills every Platform field without any options", () => {
        const platform: Platform = createWorkersPlatform();
        expect(platform.network).toBeDefined();
        expect(platform.crypto.provider).toBeInstanceOf(WorkersCryptoProvider);
        expect(platform.compression).toBeInstanceOf(WorkersCompressionProvider);
        expect(platform.events).toBeInstanceOf(WorkersEventProvider);
        expect(platform.telemetry).toBeDefined();
        expect(platform.time.clock.now()).toBeGreaterThan(0);
    });

    it("accepts (and reserves) the env bindings object", () => {
        const platform = createWorkersPlatform({ MY_BINDING: "x" });
        expect(platform.crypto.provider.randomBytes(4)).toHaveLength(4);
    });

    it("network.udp is the throwing stub (no UDP ⇒ no HTTP/3)", async () => {
        const platform = createWorkersPlatform();
        await expect(platform.network.udp.recv()).rejects.toThrow(UnsupportedOnWorkersError);
    });

    it("network.dns passes hostnames through for edge resolution", async () => {
        const platform = createWorkersPlatform();
        await expect(platform.network.dns.lookup("example.com", 4)).resolves.toEqual([
            { address: "example.com", family: 4 },
        ]);
        await expect(platform.network.dns.lookup("example.com", 6)).resolves.toEqual([
            { address: "example.com", family: 6 },
        ]);
    });

    it("network.tcp without connect throws MissingConnectError", () => {
        const platform = createWorkersPlatform();
        expect(() => platform.network.tcp.connect({ host: "h", port: 1 })).toThrow(MissingConnectError);
    });
});

describe("createWorkersPlatform — connect injection", () => {
    it("with connect: tcp dials through the injected function", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const platform = createWorkersPlatform(undefined, { connect });
        const socket = platform.network.tcp.connect({ host: "example.com", port: 443 });
        expect(socket).toBeInstanceOf(WorkersSocket);
        handle.open();
        await flush();
        expect(socket.destroyed).toBe(false);
        socket.destroy();
    });

    it("the injected connect can be overridden again via network.tcp", async () => {
        const handle = createFakeHandle();
        const { connect } = createFakeConnect(handle);
        const customTcp = createWorkersPlatform({ connect }).network.tcp;
        const platform = createWorkersPlatform(undefined, { connect, network: { tcp: customTcp } });
        expect(platform.network.tcp).toBe(customTcp);
    });
});

describe("createWorkersPlatform — adapter overrides", () => {
    it("PlatformOptions fields replace the Workers defaults piecewise", async () => {
        const fakeEvents = new WorkersEventProvider(); // any impl proves the seam
        const fakeDns = { lookup: async (hostname: string, family: 4 | 6) => [{ address: `resolved:${hostname}`, family }] };
        const platform = createWorkersPlatform(undefined, {
            crypto: { provider: new WorkersCryptoProvider() },
            events: fakeEvents,
            network: { dns: fakeDns },
        });
        expect(platform.events).toBe(fakeEvents);
        expect(platform.network.dns).toBe(fakeDns);
        await expect(platform.network.dns.lookup("x", 4)).resolves.toEqual([
            { address: "resolved:x", family: 4 },
        ]);
        // Un-overridden fields keep their Workers defaults.
        expect(platform.compression).toBeInstanceOf(WorkersCompressionProvider);
    });
});
