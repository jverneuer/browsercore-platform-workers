/**
 * Semantics tests for WorkersTime — Web-standard time only (Date.now,
 * performance.now, setTimeout, AbortSignal.timeout), no node:timers.
 */

import { describe, expect, it } from "vitest";

import { Duration } from "@browsercore/contracts";

import { workersTime } from "../src/time/workers-time.js";

describe("clock", () => {
    it("now() tracks Date.now()", () => {
        const before = Date.now();
        const now = workersTime.clock.now();
        const after = Date.now();
        expect(now).toBeGreaterThanOrEqual(before);
        expect(now).toBeLessThanOrEqual(after);
    });

    it("monotonic() is nanosecond-scale and never goes backwards", () => {
        const first = workersTime.clock.monotonic();
        // Burn a little wall time so the counter has room to advance.
        const spinUntil = Date.now() + 2;
        while (Date.now() < spinUntil) {
            /* spin */
        }
        const second = workersTime.clock.monotonic();
        expect(typeof first).toBe("bigint");
        expect(second).toBeGreaterThanOrEqual(first);
        expect(second - first).toBeLessThan(1_000_000_000n); // < 1s elapsed
    });
});

describe("scheduler.delay", () => {
    it("resolves after the requested duration", async () => {
        const start = Date.now();
        await workersTime.scheduler.delay(Duration.milliseconds(25));
        expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    });

    it("rejects when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort(new Error("nope"));
        await expect(workersTime.scheduler.delay(Duration.milliseconds(5), controller.signal)).rejects.toThrow("nope");
    });

    it("rejects when the signal aborts mid-delay", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error("cancelled")), 5);
        await expect(workersTime.scheduler.delay(Duration.seconds(30), controller.signal)).rejects.toThrow("cancelled");
    });

    it("normalizes a non-Error abort reason into a plain Error", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort("just a string"), 5);
        await expect(workersTime.scheduler.delay(Duration.seconds(30), controller.signal)).rejects.toThrow("aborted");
    });

    it("cleanly detaches the abort listener after resolving", async () => {
        const controller = new AbortController();
        await workersTime.scheduler.delay(Duration.milliseconds(1), controller.signal);
        // Aborting after settlement must not throw into a settled promise.
        controller.abort();
    });
});

describe("scheduler.timeout / deadline", () => {
    it("timeout() returns a signal that aborts after the duration", async () => {
        const signal = workersTime.scheduler.timeout(Duration.milliseconds(10));
        expect(signal.aborted).toBe(false);
        await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        expect(signal.aborted).toBe(true);
    });

    it("deadline() pairs an aborting signal with a monotonic expiry", async () => {
        const before = workersTime.clock.monotonic();
        const deadline = workersTime.scheduler.deadline(Duration.milliseconds(50));
        expect(deadline.expiresAt).toBeGreaterThanOrEqual(before);
        expect(deadline.expiresAt - before).toBeGreaterThanOrEqual(50_000_000n);
        expect(deadline.signal.aborted).toBe(false);
        expect(deadline.expiresAt).toBeLessThanOrEqual(workersTime.clock.monotonic() + 60_000_000n);
    });
});
