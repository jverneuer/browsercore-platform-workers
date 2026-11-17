/**
 * {@link CompressionProvider} for Cloudflare Workers, backed by `node:zlib`'s
 * synchronous family via the `nodejs_compat` flag.
 *
 * Mirrors browsersmith's Node zlib adapter one-for-one (same methods, same
 * browser-tolerant `content-encoding` parsing, same zlib-first/raw-fallback
 * for `deflate`) so bodies decode identically on both platforms. This is the
 * second of the two compat-gated `node:*` imports in this package (the first
 * is RSA verify in the crypto provider): workerd implements the zlib sync
 * APIs under `nodejs_compat` (compat_date >= 2026-08-04), and on Node they
 * are native. There is no synchronous WebCompressionStream on Workers, so
 * zlib compat is the only sync route — and the contract is sync.
 *
 * @module
 */

import {
    brotliCompressSync,
    brotliDecompressSync,
    deflateSync,
    gunzipSync,
    gzipSync,
    inflateRawSync,
    inflateSync,
} from "node:zlib";

import type { CompressionProvider, ContentEncoding } from "@browsercore/contracts";
import { DecompressionError, UnsupportedEncodingError } from "../errors.js";
import { assertNever } from "../utils.js";

/** zlib's output is a Node `Buffer` (a `Uint8Array` subclass); callers get plain `Uint8Array`. */
type ZlibOutput = Uint8Array;

/** Detach from the Buffer pool — canonicalize at the boundary. */
function toUint8Array(data: ZlibOutput): Uint8Array {
    return new Uint8Array(data);
}

/**
 * Parse a free-form `content-encoding` header value into a known
 * {@link ContentEncoding}. Browser-tolerant: case-insensitive, trims
 * whitespace, treats `x-gzip` as gzip and the empty token as identity.
 */
function parseEncoding(encoding: string): ContentEncoding | null {
    switch (encoding.trim().toLowerCase()) {
        case "gzip":
        case "x-gzip":
            return "gzip";
        case "deflate":
            return "deflate";
        case "br":
            return "br";
        case "identity":
        case "":
            return "identity";
        default:
            return null;
    }
}

/** Run a zlib sync decoder, wrapping any failure as a typed {@link DecompressionError}. */
function decodeWith(
    fn: (data: Uint8Array) => ZlibOutput,
    data: Uint8Array,
    encoding: ContentEncoding,
): Uint8Array {
    try {
        return toUint8Array(fn(data));
    } catch (cause) {
        throw new DecompressionError(encoding, {
            cause: cause instanceof Error ? cause : new Error(String(cause)),
        });
    }
}

/**
 * `node:zlib`-backed {@link CompressionProvider} for Workers — composed into
 * the Platform by `createWorkersPlatform`.
 */
export class WorkersCompressionProvider implements CompressionProvider {
    public gzip(data: Uint8Array): Uint8Array {
        return toUint8Array(gzipSync(data));
    }

    public gunzip(data: Uint8Array): Uint8Array {
        return decodeWith((b) => gunzipSync(b), data, "gzip");
    }

    public deflate(data: Uint8Array): Uint8Array {
        return toUint8Array(deflateSync(data));
    }

    public inflate(data: Uint8Array): Uint8Array {
        return decodeWith((b) => inflateSync(b), data, "deflate");
    }

    public inflateRaw(data: Uint8Array): Uint8Array {
        return decodeWith((b) => inflateRawSync(b), data, "deflate");
    }

    public brotliCompress(data: Uint8Array): Uint8Array {
        return toUint8Array(brotliCompressSync(data));
    }

    public brotliDecompress(data: Uint8Array): Uint8Array {
        return decodeWith((b) => brotliDecompressSync(b), data, "br");
    }

    public decompress(data: Uint8Array, encoding: string): Uint8Array {
        const parsed = parseEncoding(encoding);
        if (parsed === null) {
            throw new UnsupportedEncodingError(encoding);
        }
        switch (parsed) {
            case "gzip":
                return this.gunzip(data);
            case "deflate": {
                // Servers disagree on framing: some send a zlib-wrapped
                // stream (what the RFC calls for), some send raw deflate.
                // Browsers tolerate both — try zlib first, fall back to raw.
                // decodeWith guarantees any inflate failure surfaces as a
                // DecompressionError (never a foreign throw), so the
                // fallback needs no further error-class discrimination; if
                // raw inflate also fails, its own DecompressionError
                // propagates to the caller.
                try {
                    return this.inflate(data);
                } catch {
                    return this.inflateRaw(data);
                }
            }
            case "br":
                return this.brotliDecompress(data);
            case "identity":
                return data;
            default:
                return assertNever(parsed);
        }
    }
}

/** Default Workers compression adapter — composed into the Platform. */
export const workersCompression: CompressionProvider = new WorkersCompressionProvider();
