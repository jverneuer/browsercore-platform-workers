/**
 * Semantics tests for WorkersTime — the canonical `Clock` contract
 * (contracts 0.2.6+: `Time ≡ Clock`), Web-standard time only (Date.now,
 * performance.now, setTimeout/clearTimeout), no node:timers.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import type { Clock } from "@browsercore/contracts";

import { workersTime } from "../src/time/workers-time.js";

describe("canonical Clock conformance", () => {
    it("Time ≡ Clock — the bundle IS the canonical clock shape", () => {
        // Compile-time proof: contracts 0.2.6 collapsed Time onto Clock; the
        // adapter must satisfy the canonical shape exactly, with no leftover
        // clock/scheduler nesting from the pre-0.2.6 bundle.
        expectTypeOf(workersTime).toEqualTypeOf<Clock>();
    });
});

describe("now", () => {
    it("tracks Date.now() (wall-clock epoch ms)", () => {
        const before = Date.now();
        const now = workersTime.now();
        const after = Date.now();
        expect(now).toBeGreaterThanOrEqual(before);
        expect(now).toBeLessThanOrEqual(after);
    });
});

describe("monotonic", () => {
    it("is millisecond-scale and never goes backwards", () => {
        const first = workersTime.monotonic();
        // Burn a little wall time so the counter has room to advance.
        const spinUntil = Date.now() + 2;
        while (Date.now() < spinUntil) {
            /* spin */
        }
        const second = workersTime.monotonic();
        expect(typeof first).toBe("number"); // ms number — NOT the old ns bigint
        expect(second).toBeGreaterThanOrEqual(first);
        expect(second - first).toBeLessThan(1_000); // < 1s elapsed
    });

    it("reads performance.now() scale (ms), not nanoseconds", () => {
        const first = workersTime.monotonic();
        const spinUntil = Date.now() + 5;
        while (Date.now() < spinUntil) {
            /* spin */
        }
        const elapsed = workersTime.monotonic() - first;
        expect(elapsed).toBeGreaterThan(0);
        // A ~5 ms spin: the old ns clock would read ~5_000_000; ms reads ~5.
        expect(elapsed).toBeLessThan(1_000);
    });
});

describe("sleep", () => {
    it("resolves after the requested milliseconds", async () => {
        const start = Date.now();
        await workersTime.sleep(25);
        expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    });
});

describe("setTimeout / clearTimeout", () => {
    it("setTimeout(ms, fn) — ms FIRST — runs fn once after the delay", async () => {
        let fired = 0;
        const handle = workersTime.setTimeout(10, () => {
            fired += 1;
        });
        await workersTime.sleep(30);
        expect(fired).toBe(1);
        // The handle is an opaque object (boxed on every runtime).
        expect(typeof handle).toBe("object");
    });

    it("clearTimeout cancels a pending timer", async () => {
        let fired = 0;
        const handle = workersTime.setTimeout(10, () => {
            fired += 1;
        });
        workersTime.clearTimeout(handle);
        await workersTime.sleep(30);
        expect(fired).toBe(0);
    });
});
