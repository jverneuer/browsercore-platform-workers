/**
 * Direct tests for the small platform pieces: no-op telemetry, the typed
 * error helpers (ensureCryptoError), and the assertNever exhaustiveness
 * guard (exercised through the provider's exhaustive switches via
 * out-of-union casts — the only way the guards are runtime-reachable).
 */

import { describe, expect, it } from "vitest";

import { noOpTelemetry } from "../src/telemetry/no-op-telemetry.js";
import { CryptoError, DecryptError, UnsupportedAlgorithmError, ensureCryptoError } from "../src/errors.js";
import { assertNever } from "../src/utils.js";
import { WorkersCryptoProvider } from "../src/crypto/workers-crypto-provider.js";
import type { HashId } from "@browsercore/contracts";

describe("noOpTelemetry", () => {
    it("accepts every call without throwing (logger, tracer, metrics)", () => {
        expect(() => {
            const { logger, tracer, metrics } = noOpTelemetry;
            logger.debug("m", { k: 1 });
            logger.info("m");
            logger.warn("m");
            logger.error("m", { err: true });
            const span = tracer.startSpan("span", { a: 1 });
            expect(span.setAttribute("k", "v")).toBe(span); // fluent: returns itself
            span.end();
            metrics.add("counter", 1, { tag: "x" });
        }).not.toThrow();
    });
});

describe("ensureCryptoError", () => {
    it("passes typed CryptoError subclasses through unchanged", () => {
        const original = new DecryptError("AES-256-GCM");
        expect(ensureCryptoError(original)).toBe(original);
        const unsupported = new UnsupportedAlgorithmError("AES-128-CCM");
        expect(ensureCryptoError(unsupported)).toBe(unsupported);
    });

    it("wraps a plain Error, preserving message and cause", () => {
        const inner = new Error("tag mismatch");
        const wrapped = ensureCryptoError(inner, "AES-128-GCM");
        expect(wrapped).toBeInstanceOf(CryptoError);
        expect(wrapped.message).toBe("tag mismatch");
        expect(wrapped.algorithm).toBe("AES-128-GCM");
        expect(wrapped.cause).toBe(inner);
    });

    it("wraps non-Error throws (string / undefined)", () => {
        expect(ensureCryptoError("boom", "ML-KEM-768").message).toBe("boom");
        expect(ensureCryptoError(undefined).message).toBe("unknown crypto error");
    });
});

describe("assertNever exhaustiveness guard", () => {
    it("throws for any value that reaches it", () => {
        expect(() => assertNever("rogue" as never)).toThrow(/unhandled variant/);
    });

    it("guards the provider's exhaustive HashId switches at runtime", () => {
        const provider = new WorkersCryptoProvider();
        const rogue = "SHA-512" as HashId; // outside the contract union
        expect(() => provider.hmac(rogue, new Uint8Array(4), new Uint8Array(4))).toThrow(
            /unhandled variant/,
        );
        expect(() =>
            provider.hkdf(rogue, new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), 8),
        ).toThrow(/unhandled variant/);
    });
});
