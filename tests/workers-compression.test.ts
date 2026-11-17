/**
 * Round-trip and dispatch tests for the Workers compression provider
 * (node:zlib sync family under nodejs_compat), mirroring the surface and
 * browser-tolerance semantics of browsersmith's Node zlib adapter.
 */

import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { WorkersCompressionProvider } from "../src/compression/workers-compression.js";
import { DecompressionError, UnsupportedEncodingError } from "../src/errors.js";

const provider = new WorkersCompressionProvider();
const fromUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("round-trips", () => {
    it("gzip → gunzip", () => {
        const body = fromUtf8("compress me, i dare you ".repeat(10));
        const compressed = provider.gzip(body);
        // gzip magic number 0x1f 0x8b.
        expect(compressed[0]).toBe(0x1f);
        expect(compressed[1]).toBe(0x8b);
        expect(provider.gunzip(compressed)).toEqual(body);
    });

    it("deflate → inflate (zlib wrapper: 0x78 first byte)", () => {
        const body = fromUtf8("zlib-wrapped ".repeat(8));
        const compressed = provider.deflate(body);
        expect(compressed[0]).toBe(0x78);
        expect(provider.inflate(compressed)).toEqual(body);
    });

    it("brotli → brotliDecompress", () => {
        const body = fromUtf8("brotli round trip ".repeat(8));
        expect(provider.brotliDecompress(provider.brotliCompress(body))).toEqual(body);
    });

    it("empty bodies round-trip through every codec", () => {
        const empty = new Uint8Array(0);
        expect(provider.gunzip(provider.gzip(empty))).toEqual(empty);
        expect(provider.inflate(provider.deflate(empty))).toEqual(empty);
        expect(provider.brotliDecompress(provider.brotliCompress(empty))).toEqual(empty);
    });

    it("results are standalone Uint8Arrays, not views over a shared pool", () => {
        const body = fromUtf8("ownership");
        const out = provider.gunzip(provider.gzip(body));
        expect(out.constructor).toBe(Uint8Array);
    });
});

describe("decompress(data, encoding) dispatch", () => {
    const body = fromUtf8("dispatch payload ".repeat(6));

    it("routes gzip / deflate / br / identity to the right codec", () => {
        expect(provider.decompress(provider.gzip(body), "gzip")).toEqual(body);
        expect(provider.decompress(provider.deflate(body), "deflate")).toEqual(body);
        expect(provider.decompress(provider.brotliCompress(body), "br")).toEqual(body);
        expect(provider.decompress(body, "identity")).toEqual(body);
    });

    it("is browser-tolerant: case-insensitive, trims whitespace, x-gzip ≡ gzip", () => {
        expect(provider.decompress(provider.gzip(body), " GZIP ")).toEqual(body);
        expect(provider.decompress(provider.gzip(body), "x-gzip")).toEqual(body);
        expect(provider.decompress(body, "")).toEqual(body);
    });

    it("deflate falls back to raw inflate when the zlib wrapper is missing", () => {
        // Some servers send raw deflate under the `deflate` token — browsers
        // tolerate it, and so must we. Build the headerless stream with
        // node:zlib to simulate such a server.
        const raw = new Uint8Array(deflateRawSync(body));
        expect(provider.decompress(raw, "deflate")).toEqual(body);
    });

    it("unknown tokens throw UnsupportedEncodingError", () => {
        expect(() => provider.decompress(body, "compress")).toThrow(UnsupportedEncodingError);
        expect(() => provider.decompress(body, "br, gzip")).toThrow(UnsupportedEncodingError);
    });

    it("corrupt streams throw DecompressionError with the encoding attached", () => {
        const corrupt = new Uint8Array(8).fill(0xff);
        expect(() => provider.decompress(corrupt, "gzip")).toThrow(DecompressionError);
        try {
            provider.decompress(corrupt, "gzip");
        } catch (err) {
            expect(err).toBeInstanceOf(DecompressionError);
            expect((err as DecompressionError).encoding).toBe("gzip");
        }
        expect(() => provider.decompress(corrupt, "br")).toThrow(DecompressionError);
        // Both zlib and raw fail → the fallback rethrows the raw failure.
        expect(() => provider.decompress(corrupt, "deflate")).toThrow(DecompressionError);
    });
});

describe("codec independence", () => {
    it("gzip output is not valid brotli input and vice versa", () => {
        const body = fromUtf8("independence");
        expect(() => provider.brotliDecompress(provider.gzip(body))).toThrow(DecompressionError);
        expect(() => provider.gunzip(provider.brotliCompress(body))).toThrow(DecompressionError);
    });
});
