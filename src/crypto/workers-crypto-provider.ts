/**
 * {@link CryptoProvider} for Cloudflare Workers, implemented entirely against
 * the noble cryptography libraries — pure TypeScript, no WebCrypto.
 *
 * Why not WebCrypto: the `CryptoProvider` contract is deliberately
 * **synchronous** (TLS/QUIC record protection cannot await a SubtleCrypto
 * promise per record without destroying the event-loop economics on
 * Workers), and WebCrypto exposes no sync surface. The noble libraries
 * (@noble/hashes, @noble/ciphers, @noble/curves, @noble/post-quantum) are
 * pure TS with no native bindings, so the identical code path runs on
 * workerd, Node, and the test runner — no cross-runtime behavioral drift in
 * the byte-level TLS work. This is the same property that made
 * `@browsercore/crypto`'s noble backends its recommended defaults.
 *
 * The only `node:*` import in this file is `node:crypto`'s signature
 * verification, which has no noble equivalent: RSA-PSS/PKCS1 verify needs
 * DER/SPKI parsing + a real RSA implementation. On Workers this arrives via
 * the `nodejs_compat` flag (compat_date >= 2026-08-04 — "All node:crypto
 * APIs fully supported" per Cloudflare's compatibility docs); on Node it is
 * native. This package IS a runtime adapter — like browsersmith's node
 * adapters, `node:*` imports are allowed here by design and never leak into
 * the protocol packages above it.
 *
 * @module
 */

import {
    createPublicKey,
    createVerify,
    constants as nodeCryptoConstants,
} from "node:crypto";

import { sha256 as nobleSha256, sha384 as nobleSha384 } from "@noble/hashes/sha2.js";
import { hmac as nobleHmac } from "@noble/hashes/hmac.js";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { gcm as nobleGcm, ecb as nobleEcb } from "@noble/ciphers/aes.js";
import { chacha20poly1305 as nobleChacha20Poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { p256, p384 } from "@noble/curves/nist.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

import type {
    CryptoProvider,
    EcdhCurve,
    EcdhKeyPair,
    HashId,
    MLKEM768KeyPair,
    X25519KeyPair,
} from "@browsercore/contracts";
import { DecryptError, UnsupportedAlgorithmError, ensureCryptoError } from "../errors.js";
import { assertNever } from "../utils.js";

/** AEAD authentication-tag length in bytes for every cipher supported here. */
const AEAD_TAG_LENGTH = 16;


/** Field-element size in bytes for each supported NIST curve. */
const FIELD_BYTES: Readonly<Record<EcdhCurve, number>> = Object.freeze({
    secp256r1: 32,
    secp384r1: 48,
});

/**
 * The noble-curves API for each supported curve — `p256`/`p384` satisfy the
 * same subset (`keygen`, `getPublicKey`, `getSharedSecret`).
 */
interface NobleEcdhApi {
    keygen(): { secretKey: Uint8Array; publicKey: Uint8Array };
    getPublicKey(secretKey: Uint8Array, isCompressed?: boolean): Uint8Array;
    getSharedSecret(secretKey: Uint8Array, publicKey: Uint8Array, isCompressed?: boolean): Uint8Array;
}

const CURVE_API: Readonly<Record<EcdhCurve, NobleEcdhApi>> = Object.freeze({
    secp256r1: p256,
    secp384r1: p384,
});

/**
 * RFC 7748 §5: an all-zero (small-order) peer u-coordinate is degenerate and
 * MUST yield the all-zero shared secret rather than aborting. noble-curves
 * rejects it with a validation error, so the case is pre-checked — mirroring
 * `@browsercore/crypto`'s NobleX25519Backend exactly.
 */
function isAllZero(bytes: Uint8Array): boolean {
    for (const byte of bytes) {
        if (byte !== 0) {
            return false;
        }
    }
    return true;
}

/** Concatenate two byte arrays into a fresh copy. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * Workers implementation of {@link CryptoProvider} — pure noble, fully
 * synchronous.
 *
 * Satisfies the contract as-is (no async shims, no WebCrypto). Injected via
 * `Platform.crypto.provider` by `createWorkersPlatform`; protocol packages
 * never import this class directly.
 */
export class WorkersCryptoProvider implements CryptoProvider {
    public randomBytes(length: number): Uint8Array {
        // getRandomValues is synchronous on Workers (and everywhere with
        // globalThis.crypto) — unlike the rest of WebCrypto.
        return globalThis.crypto.getRandomValues(new Uint8Array(length));
    }

    public sha256(data: Uint8Array): Uint8Array {
        return nobleSha256(data);
    }

    public sha384(data: Uint8Array): Uint8Array {
        return nobleSha384(data);
    }

    public hkdf(
        hash: HashId,
        salt: Uint8Array,
        ikm: Uint8Array,
        info: Uint8Array,
        length: number,
    ): Uint8Array {
        // Exhaustive inline switch (not a lookup helper): noble's callable-
        // hash generics only line up when the concrete constructor is passed.
        switch (hash) {
            case "SHA-256":
                return nobleHkdf(nobleSha256, ikm, salt, info, length);
            case "SHA-384":
                return nobleHkdf(nobleSha384, ikm, salt, info, length);
            default:
                return assertNever(hash);
        }
    }

    public hmac(hash: HashId, key: Uint8Array, data: Uint8Array): Uint8Array {
        switch (hash) {
            case "SHA-256":
                return nobleHmac(nobleSha256, key, data);
            case "SHA-384":
                return nobleHmac(nobleSha384, key, data);
            default:
                return assertNever(hash);
        }
    }

    public aes128GcmEncrypt(
        key: Uint8Array,
        nonce: Uint8Array,
        plaintext: Uint8Array,
        aad: Uint8Array,
    ): Uint8Array {
        // noble's gcm returns ciphertext with the 16-byte tag appended — the
        // exact TLS record-layer layout the contract specifies.
        return nobleGcm(key, nonce, aad).encrypt(plaintext);
    }

    public aes128GcmDecrypt(
        key: Uint8Array,
        nonce: Uint8Array,
        ciphertext: Uint8Array,
        aad: Uint8Array,
    ): Uint8Array {
        return this.aeadDecrypt("AES-128-GCM", key, nonce, ciphertext, aad);
    }

    public aes256GcmEncrypt(
        key: Uint8Array,
        nonce: Uint8Array,
        plaintext: Uint8Array,
        aad: Uint8Array,
    ): Uint8Array {
        return nobleGcm(key, nonce, aad).encrypt(plaintext);
    }

    public aes256GcmDecrypt(
        key: Uint8Array,
        nonce: Uint8Array,
        ciphertext: Uint8Array,
        aad: Uint8Array,
    ): Uint8Array {
        return this.aeadDecrypt("AES-256-GCM", key, nonce, ciphertext, aad);
    }

    public aes128CcmEncrypt(
        _key: Uint8Array,
        _nonce: Uint8Array,
        _plaintext: Uint8Array,
        _aad: Uint8Array,
    ): Uint8Array {
        // Deliberately unsupported. TLS_AES_128_CCM_SHA256 appears in no
        // browser profile the stack ships (Chrome/Firefox negotiate
        // AES-GCM and ChaCha20-Poly1305 only), so no ClientHello we emit
        // ever offers it and no server can select it — throwing here has
        // ZERO fingerprint impact while keeping the unsupported path typed
        // and loud instead of silently wrong. (@noble/ciphers ships no CCM,
        // so a pure-noble implementation was never on the table.)
        throw new UnsupportedAlgorithmError("AES-128-CCM");
    }

    public aes128CcmDecrypt(
        _key: Uint8Array,
        _nonce: Uint8Array,
        _ciphertext: Uint8Array,
        _aad: Uint8Array,
    ): Uint8Array {
        throw new UnsupportedAlgorithmError("AES-128-CCM");
    }

    public chacha20Poly1305Encrypt(
        key: Uint8Array,
        nonce: Uint8Array,
        plaintext: Uint8Array,
        aad: Uint8Array,
    ): Uint8Array {
        return nobleChacha20Poly1305(key, nonce, aad).encrypt(plaintext);
    }

    public chacha20Poly1305Decrypt(
        key: Uint8Array,
        nonce: Uint8Array,
        ciphertext: Uint8Array,
        aad: Uint8Array,
    ): Uint8Array {
        return this.aeadDecrypt("ChaCha20-Poly1305", key, nonce, ciphertext, aad);
    }

    public x25519GenerateKeyPair(): X25519KeyPair {
        // Raw 32-byte scalar in, raw u-coordinate out; noble clamps per
        // RFC 7748 §5 internally — same code path as the Node provider's
        // noble backend.
        const secretKey = this.randomBytes(32);
        return { publicKey: x25519.getPublicKey(secretKey), secretKey };
    }

    public x25519SharedSecret(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
        if (isAllZero(peerPublicKey)) {
            return new Uint8Array(32);
        }
        return x25519.getSharedSecret(secretKey, peerPublicKey);
    }

    public ecdhGenerateKeyPair(curve: EcdhCurve): EcdhKeyPair {
        const api = CURVE_API[curve];
        // keygen returns the secret scalar; re-derive the public key
        // UNCOMPRESSED (0x04 || x || y) — the TLS 1.3 KeyShareEntry layout.
        const { secretKey } = api.keygen();
        return { curve, publicKey: api.getPublicKey(secretKey, false), secretKey };
    }

    public ecdhSharedSecret(
        curve: EcdhCurve,
        secretKey: Uint8Array,
        peerPublicKey: Uint8Array,
    ): Uint8Array {
        const api = CURVE_API[curve];
        // Uncompressed shared point; the TLS 1.3 shared secret is the
        // x-coordinate at bytes [1 .. 1+fieldBytes).
        return api
            .getSharedSecret(secretKey, peerPublicKey, false)
            .subarray(1, 1 + FIELD_BYTES[curve]);
    }

    public verifySignature(
        scheme: string,
        publicKey: Uint8Array,
        signature: Uint8Array,
        data: Uint8Array,
    ): boolean {
        // node:crypto compat import — the single non-noble piece. On Workers
        // this requires `nodejs_compat` with compat_date >= 2026-08-04
        // (all node:crypto APIs supported); on Node it is native. RSA-PSS
        // salt length MUST equal the digest length (RFC 8017 §8.1.1).
        const key = createPublicKey({ key: publicKey, format: "der", type: "spki" });
        switch (scheme) {
            case "ecdsa_secp256r1_sha256":
                return createVerify("sha256").update(data).verify(key, signature);
            case "ecdsa_secp384r1_sha384":
                return createVerify("sha384").update(data).verify(key, signature);
            case "rsa_pss_rsae_sha256":
                return createVerify("sha256").update(data).verify(
                    { key, padding: nodeCryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
                    signature,
                );
            case "rsa_pss_rsae_sha384":
                return createVerify("sha384").update(data).verify(
                    { key, padding: nodeCryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 48 },
                    signature,
                );
            case "rsa_pkcs1_sha256":
                return createVerify("sha256").update(data).verify(
                    { key, padding: nodeCryptoConstants.RSA_PKCS1_PADDING },
                    signature,
                );
            default:
                throw new UnsupportedAlgorithmError(`unsupported signature scheme: ${scheme}`);
        }
    }

    public aesEcbEncrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
        // QUIC header protection (RFC 9001 §5.4.1): raw AES-ECB over one
        // 16-byte block, PKCS#7 padding disabled. noble selects AES-128 vs
        // AES-256 by key length — exactly the two QUIC uses.
        return nobleEcb(key, { disablePadding: true }).encrypt(block);
    }

    public mlkem768GenerateKeyPair(): MLKEM768KeyPair {
        try {
            return ml_kem768.keygen();
        } catch (cause) {
            throw ensureCryptoError(cause, "ML-KEM-768");
        }
    }

    public mlkem768Decapsulate(secretKey: Uint8Array, ciphertext: Uint8Array): Uint8Array {
        try {
            return ml_kem768.decapsulate(ciphertext, secretKey);
        } catch (cause) {
            throw ensureCryptoError(cause, "ML-KEM-768");
        }
    }

    public x25519MLKEM768SharedSecret(
        x25519SecretKey: Uint8Array,
        x25519PeerPublicKey: Uint8Array,
        mlkemSecretKey: Uint8Array,
        mlkemCiphertext: Uint8Array,
    ): Uint8Array {
        // draft-ietf-tls-ecdhe-mlkem: ML-KEM shared secret || X25519 shared
        // secret (post-quantum FIRST), fed to the key schedule as one 64-byte
        // secret. Order verified against OpenSSL's X25519MLKEM768 peer —
        // identical to the Node provider.
        const postQuantum = this.mlkem768Decapsulate(mlkemSecretKey, mlkemCiphertext);
        const classical = this.x25519SharedSecret(x25519SecretKey, x25519PeerPublicKey);
        return concat(postQuantum, classical);
    }

    /**
     * Shared AEAD decrypt: expects ciphertext||tag, throws {@link DecryptError}
     * on authentication failure or short input (mirrors the Node provider's
     * `aeadDecrypt` semantics so upstream error handling is identical).
     */
    private aeadDecrypt(
        algorithm: "AES-128-GCM" | "AES-256-GCM" | "ChaCha20-Poly1305",
        key: Uint8Array,
        nonce: Uint8Array,
        ciphertext: Uint8Array,
        aad: Uint8Array,
    ): Uint8Array {
        if (ciphertext.length < AEAD_TAG_LENGTH) {
            throw new DecryptError(algorithm);
        }
        const cipher =
            algorithm === "ChaCha20-Poly1305"
                ? nobleChacha20Poly1305(key, nonce, aad)
                : nobleGcm(key, nonce, aad);
        try {
            return cipher.decrypt(ciphertext);
        } catch (cause) {
            throw new DecryptError(algorithm, {
                cause: cause instanceof Error ? cause : new Error(String(cause)),
            });
        }
    }
}

/** Default Workers crypto adapter — composed into the Platform by `createWorkersPlatform`. */
export const workersCryptoProvider: CryptoProvider = new WorkersCryptoProvider();
