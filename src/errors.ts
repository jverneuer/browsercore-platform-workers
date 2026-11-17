/**
 * Typed errors for @browsercore/platform-workers.
 *
 * Errors are part of the API — every failure mode is an explicit type so
 * callers can match on `kind` instead of parsing messages (code-standards
 * rule 16). Upstream protocol packages wrap anything thrown here into their
 * own typed errors with the original on `cause` — they never `instanceof`
 * these classes — so declaring them locally (instead of depending on
 * `@browsercore/crypto` / `@browsercore/compression` for theirs) keeps this
 * adapter's dependency surface at contracts + noble only, with zero
 * behavioral change for consumers.
 *
 * @module
 */

// ===========================================================================
// Crypto errors — mirror the @browsercore/crypto error surface
// ===========================================================================

/** The set of all crypto-error discriminator values. */
export type CryptoErrorKind = "CryptoError" | "UnsupportedAlgorithmError" | "DecryptError";

/** Base class for all crypto errors raised by the Workers crypto provider. */
export class CryptoError extends Error {
    /** Discriminator for narrowing — always `"CryptoError"` on the base class. */
    public readonly kind: CryptoErrorKind = "CryptoError";
    /** Algorithm identifier that triggered the error, when applicable. */
    public readonly algorithm: string | undefined;
    /** `Error | undefined` (not `?`) so assignment is valid under exactOptionalPropertyTypes. */
    public override readonly cause: Error | undefined;

    /**
     * Create a {@link CryptoError}.
     *
     * @param message   Human-readable error message.
     * @param algorithm Algorithm identifier that triggered the error, when applicable.
     * @param options   Optional cause chain.
     */
    constructor(
        message: string,
        algorithm?: string,
        options?: { cause?: Error },
    ) {
        super(message, options);
        this.name = new.target.name;
        this.algorithm = algorithm;
        this.cause = options?.cause;
    }
}

/** The requested algorithm is not supported by this provider. */
export class UnsupportedAlgorithmError extends CryptoError {
    public override readonly kind = "UnsupportedAlgorithmError" as const;
    public override readonly algorithm: string;

    /**
     * Create an {@link UnsupportedAlgorithmError}.
     *
     * @param algorithm The algorithm identifier that is not supported.
     */
    constructor(algorithm: string) {
        super(`Unsupported crypto algorithm: ${algorithm}`, algorithm);
        this.algorithm = algorithm;
    }
}

/** Decryption failed — authentication tag mismatch or corrupt input. */
export class DecryptError extends CryptoError {
    public override readonly kind = "DecryptError" as const;
    public override readonly algorithm: string;
    /** `Error | undefined` (not `?`) so assignment is valid under exactOptionalPropertyTypes. */
    public override readonly cause: Error | undefined;

    /**
     * Create a {@link DecryptError}.
     *
     * @param algorithm The algorithm identifier being decoded when the failure happened.
     * @param options   Optional cause chain.
     */
    constructor(algorithm: string, options?: { cause?: Error }) {
        super(
            `Decryption failed for ${algorithm}: authentication mismatch or corrupt input`,
            algorithm,
            options,
        );
        this.algorithm = algorithm;
        this.cause = options?.cause;
    }
}

/**
 * Narrow a caught error to a typed crypto error, or wrap it in {@link CryptoError}.
 *
 * Mirrors `@browsercore/crypto`'s exported helper of the same name: use at
 * provider boundaries so every thrown value is a typed {@link CryptoError}
 * subclass — callers match on `kind` instead of parsing messages.
 *
 * @param e         The caught unknown value.
 * @param algorithm Optional algorithm identifier to attach to the wrapped error.
 * @returns `e` itself (if already typed) or a new wrapping instance.
 */
export function ensureCryptoError(e: unknown, algorithm?: string): CryptoError {
    if (e instanceof CryptoError) {
        return e;
    }
    if (e instanceof Error) {
        return new CryptoError(e.message, algorithm, { cause: e });
    }
    return new CryptoError(typeof e === "string" ? e : "unknown crypto error", algorithm);
}

// ===========================================================================
// Workers platform errors
// ===========================================================================

/** The set of all Workers-platform-error discriminator values. */
export type WorkersPlatformErrorKind =
    | "WorkersPlatformError"
    | "MissingConnectError";

/** Base class for all Workers platform adapter errors. */
export class WorkersPlatformError extends Error {
    /** Discriminator for narrowing — always `"WorkersPlatformError"` on the base class. */
    public readonly kind: WorkersPlatformErrorKind = "WorkersPlatformError";

    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/**
 * `cloudflare:sockets`' `connect` was not injected into the platform.
 *
 * The socket shim is dependency-injected by design (tests pass fakes, the
 * Worker passes the real module binding), so TCP is unavailable until
 * `connect` is provided via `createWorkersPlatform(env, { connect })`.
 */
export class MissingConnectError extends WorkersPlatformError {
    public override readonly kind = "MissingConnectError" as const;
    /** Copy-paste-able fix, surfaced on the error itself. */
    public readonly remedy: string;

    /**
     * Create a {@link MissingConnectError}.
     *
     * @param whatIsMissing  What TCP needs, e.g. `"network.tcp is unavailable"`.
     * @param remedy         How to fix it — appended to the message.
     */
    constructor(whatIsMissing: string, remedy: string) {
        super(`${whatIsMissing}: ${remedy}`);
        this.remedy = remedy;
    }
}

// ===========================================================================
// Compression errors — mirror the @browsercore/compression error surface
// ===========================================================================

/** Decompression of a body failed (corrupt or truncated stream). */
export class DecompressionError extends Error {
    /** Discriminator for narrowing. */
    public readonly kind = "DecompressionError" as const;
    /** The content-encoding token being decoded when the failure happened. */
    public readonly encoding: string;
    /** `Error | undefined` (not `?`) so assignment is valid under exactOptionalPropertyTypes. */
    public override readonly cause: Error | undefined;

    /**
     * Create a {@link DecompressionError}.
     *
     * @param encoding The content-encoding token being decoded.
     * @param options  Optional cause chain.
     */
    constructor(encoding: string, options?: { cause?: Error }) {
        super(`Decompression failed for encoding "${encoding}"`, options);
        this.name = new.target.name;
        this.encoding = encoding;
        this.cause = options?.cause;
    }
}

/** The `content-encoding` token is not recognized by this provider. */
export class UnsupportedEncodingError extends Error {
    /** Discriminator for narrowing. */
    public readonly kind = "UnsupportedEncodingError" as const;
    /** The unrecognized header value. */
    public readonly encoding: string;

    /**
     * Create an {@link UnsupportedEncodingError}.
     *
     * @param encoding The unrecognized `content-encoding` header value.
     */
    constructor(encoding: string) {
        super(`Unsupported content-encoding: "${encoding}"`);
        this.name = new.target.name;
        this.encoding = encoding;
    }
}
