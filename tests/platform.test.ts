/**
 * Composition tests for createWorkersPlatform — the Workers counterpart of
 * browsersmith's platform/index.ts shape: defaults compose the Workers
 * adapters, PlatformOptions overrides replace them piecewise, and the
 * connect injection gates TCP.
 */

import { describe, expect, it } from "vitest";

import type { Platform, UdpSocketFactory } from "@browsercore/contracts";

import { createWorkersPlatform } from "../src/platform/index.js";
import { WorkersCompressionProvider } from "../src/compression/workers-compression.js";
import { WorkersCryptoProvider } from "../src/crypto/workers-crypto-provider.js";
import { WorkersEventProvider } from "../src/events/workers-event-provider.js";
import { WorkersSocket } from "../src/net/workers-net.js";
import { MissingConnectError } from "../src/errors.js";
import { createFakeConnect, createFakeHandle, flush } from "./helpers/fake-connect.js";

// Compile-time conformance: the narrower WorkersPlatform return type must
// stay assignable to the canonical contracts Platform — it provides every
// optional bundle, and providing more than a consumer requires always
// satisfies the interface. Read in the defaults test so the gate's
// noUnusedLocals keeps the proof alive.
const asContractPlatform: Platform = createWorkersPlatform();

describe("createWorkersPlatform — defaults", () => {
    it("provides every bundle Workers can back, without any options", () => {
        const platform = createWorkersPlatform();
        expect(asContractPlatform).toBeDefined();
        expect(platform.network).toBeDefined();
        expect(platform.crypto.provider).toBeInstanceOf(WorkersCryptoProvider);
        expect(platform.compression).toBeInstanceOf(WorkersCompressionProvider);
        expect(platform.events).toBeInstanceOf(WorkersEventProvider);
        expect(platform.telemetry).toBeDefined();
        expect(platform.time.now()).toBeGreaterThan(0);
    });

    it("accepts (and reserves) the env bindings object", () => {
        const platform = createWorkersPlatform({ MY_BINDING: "x" });
        expect(platform.crypto.provider.randomBytes(4)).toHaveLength(4);
    });

    it("network.udp is ABSENT — optional bundles express 'no UDP on Workers' as omission", () => {
        const platform = createWorkersPlatform();
        // Absence, not a throwing stub (contracts 0.2.6+): the key is not
        // merely undefined-valued, it is not present on the object at all.
        expect("udp" in platform.network).toBe(false);
        expect(platform.network.udp).toBeUndefined();
    });

    it("an explicit network.udp override still flows through the seam", () => {
        const udpFactory: UdpSocketFactory = {
            // Never dialed — proving injection, not UDP support.
            connect: async () => {
                throw new Error("test factory never opens sockets");
            },
        };
        const platform = createWorkersPlatform(undefined, { network: { udp: udpFactory } });
        expect(platform.network.udp).toBe(udpFactory);
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
