/**
 * The UDP stub must throw a typed error naming the platform limitation
 * (no UDP on Workers ⇒ no QUIC ⇒ no HTTP/3) on every operation.
 */

import { describe, expect, it } from "vitest";

import { workersUdp } from "../src/net/workers-udp.js";
import { UnsupportedOnWorkersError } from "../src/errors.js";

describe("workersUdp stub", () => {
    it("rejects send() with UnsupportedOnWorkersError naming HTTP/3", async () => {
        await expect(
            workersUdp.send(new Uint8Array(1), { address: "127.0.0.1", port: 443, family: 4 }),
        ).rejects.toThrow(UnsupportedOnWorkersError);
        await expect(
            workersUdp.send(new Uint8Array(1), { address: "127.0.0.1", port: 443, family: 4 }),
        ).rejects.toThrow(/HTTP\/3/);
    });

    it("rejects recv() with UnsupportedOnWorkersError", async () => {
        await expect(workersUdp.recv()).rejects.toThrow(UnsupportedOnWorkersError);
    });

    it("rejects close() with UnsupportedOnWorkersError", async () => {
        await expect(workersUdp.close()).rejects.toThrow(UnsupportedOnWorkersError);
    });

    it("carries an id identifying it as the stub", () => {
        expect(workersUdp.id).toBe("workers-udp-unsupported");
    });
});
