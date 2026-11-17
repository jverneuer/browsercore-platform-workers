/**
 * Known-answer and property tests for the WorkersCryptoProvider (pure
 * noble, no WebCrypto).
 *
 * Vector expectations are ported from @browsercore/crypto's suites (the
 * polyrepo's single source of truth for these vectors): RFC 7748 X25519,
 * node:crypto-cross-validated NIST ECDH, NIST SP 800-38D AES-GCM, RFC 8439
 * ChaCha20-Poly1305, RFC 4231 HMAC, RFC 5869 HKDF, and the ML-KEM-768
 * round-trip identity with FIPS 203 parameter sizes. Signature verification
 * is cross-validated against node:crypto-generated keys (an implementation
 * independent of noble).
 */

import {
    constants as nodeCryptoConstants,
    createCipheriv,
    createECDH,
    createHash,
    createHmac,
    createSign,
    generateKeyPairSync,
    hkdfSync,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import { WorkersCryptoProvider } from "../src/crypto/workers-crypto-provider.js";
import {
    CryptoError,
    DecryptError,
    UnsupportedAlgorithmError,
} from "../src/errors.js";

const provider = new WorkersCryptoProvider();
const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// Hashes / HMAC / HKDF
// ---------------------------------------------------------------------------

describe("sha256 / sha384", () => {
    it("sha256('abc') matches the FIPS 180-4 vector", () => {
        expect(toHex(provider.sha256(fromUtf8("abc")))).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    });

    it("sha384('abc') matches node:crypto (independent implementation)", () => {
        const expected = createHash("sha384").update("abc").digest();
        expect(provider.sha384(fromUtf8("abc"))).toEqual(new Uint8Array(expected));
    });
});

describe("hmac — RFC 4231 + node:crypto cross-check", () => {
    it("RFC 4231 Test Case 1 (SHA-256): 20-byte 0x0b key, 'Hi There'", () => {
        const key = new Uint8Array(20).fill(0x0b);
        expect(toHex(provider.hmac("SHA-256", key, fromUtf8("Hi There")))).toBe(
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        );
    });

    it("RFC 4231 Test Case 2 (SHA-256): 'Jefe' key", () => {
        expect(
            toHex(provider.hmac("SHA-256", fromUtf8("Jefe"), fromUtf8("what do ya want for nothing?"))),
        ).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    });

    it("SHA-384 HMAC matches node:crypto createHmac", () => {
        const key = fromHex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        const data = fromUtf8("Hi There");
        const expected = createHmac("sha384", key).update(data).digest();
        expect(provider.hmac("SHA-384", key, data)).toEqual(new Uint8Array(expected));
    });
});

describe("hkdf — RFC 5869 + node:crypto cross-check", () => {
    it("RFC 5869 Test Case 1 (SHA-256)", () => {
        const ikm = new Uint8Array(22).fill(0x0b);
        const salt = fromHex("000102030405060708090a0b0c");
        const info = fromHex("f0f1f2f3f4f5f6f7f8f9");
        expect(toHex(provider.hkdf("SHA-256", salt, ikm, info, 42))).toBe(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
        );
    });

    it("SHA-384 HKDF matches node:crypto hkdfSync", () => {
        const salt = fromHex("0c0c0c0c0c0c0c0c0c0c0c0c0c0c");
        const ikm = fromHex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        const info = new Uint8Array(0);
        const expected = hkdfSync("sha384", ikm, salt, info, 32);
        expect(provider.hkdf("SHA-384", salt, ikm, info, 32)).toEqual(new Uint8Array(expected));
    });
});

describe("randomBytes", () => {
    it("returns the requested length with non-constant bytes", () => {
        const bytes = provider.randomBytes(64);
        expect(bytes).toHaveLength(64);
        expect(bytes.some((b) => b !== 0)).toBe(true);
        expect(provider.randomBytes(64)).not.toEqual(bytes);
    });
});

// ---------------------------------------------------------------------------
// AEAD — NIST SP 800-38D GCM + RFC 8439 ChaCha20-Poly1305
// ---------------------------------------------------------------------------

describe("AES-128-GCM — NIST SP 800-38D vectors", () => {
    it("Test Case 1: empty plaintext, empty AAD → 16-byte tag output", () => {
        const ciphertext = provider.aes128GcmEncrypt(
            fromHex("00000000000000000000000000000000"),
            fromHex("000000000000000000000000"),
            new Uint8Array(0),
            new Uint8Array(0),
        );
        expect(ciphertext).toHaveLength(16);
        expect(toHex(ciphertext)).toBe("58e2fccefa7e3061367f1d57a4e7455a");
    });

    it("Test Case 3: 60-byte plaintext with 20-byte AAD", () => {
        const key = fromHex("feffe9928665731c6d6a8f9467308308");
        const nonce = fromHex("cafebabefacedbaddecaf888");
        const plaintext = fromHex(
            "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72" +
            "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
        );
        const aad = fromHex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
        const expected = fromHex(
            "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e" +
            "21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091" +
            "5bc94fbc3221a5db94fae95ae7121a47",
        );
        const ciphertext = provider.aes128GcmEncrypt(key, nonce, plaintext, aad);
        expect(ciphertext).toHaveLength(plaintext.length + 16);
        expect(ciphertext).toEqual(expected);
        expect(provider.aes128GcmDecrypt(key, nonce, expected, aad)).toEqual(plaintext);
    });
});

describe("AES-256-GCM — NIST SP 800-38D vectors", () => {
    it("Test Case 14: empty plaintext, empty AAD → 16-byte tag output", () => {
        const ciphertext = provider.aes256GcmEncrypt(
            fromHex("0000000000000000000000000000000000000000000000000000000000000000"),
            fromHex("000000000000000000000000"),
            new Uint8Array(0),
            new Uint8Array(0),
        );
        expect(ciphertext).toHaveLength(16);
        expect(toHex(ciphertext)).toBe("530f8afbc74536b9a963b4f1c4cb738b");
    });

    it("Test Case 16: 60-byte plaintext with 20-byte AAD", () => {
        const key = fromHex(
            "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
        );
        const nonce = fromHex("cafebabefacedbaddecaf888");
        const plaintext = fromHex(
            "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72" +
            "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
        );
        const aad = fromHex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
        const expected = fromHex(
            "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa" +
            "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" +
            "76fc6ece0f4e1768cddf8853bb2d551b",
        );
        const ciphertext = provider.aes256GcmEncrypt(key, nonce, plaintext, aad);
        expect(ciphertext).toHaveLength(plaintext.length + 16);
        expect(ciphertext).toEqual(expected);
        expect(provider.aes256GcmDecrypt(key, nonce, expected, aad)).toEqual(plaintext);
    });
});

describe("ChaCha20-Poly1305 — RFC 8439 §2.8.2 vector", () => {
    const key = fromHex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
    const nonce = fromHex("070000004041424344454647");
    const aad = fromHex("50515253c0c1c2c3c4c5c6c7");
    const plaintext = fromHex(
        "4c616469657320616e642047656e746c656d656e206f662074686520636c6173" +
        "73206f66202739393a204966204920636f756c64206f6666657220796f75206f" +
        "6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73" +
        "637265656e20776f756c642062652069742e",
    );
    const expected = fromHex(
        "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6" +
        "3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36" +
        "92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc" +
        "3ff4def08e4b7a9de576d26586cec64b6116" +
        "1ae10b594f09e26a7e902ecbd0600691",
    );

    it("encrypt output matches RFC 8439 ciphertext || tag exactly", () => {
        const ciphertext = provider.chacha20Poly1305Encrypt(key, nonce, plaintext, aad);
        expect(ciphertext).toHaveLength(plaintext.length + 16);
        expect(ciphertext).toEqual(expected);
    });

    it("decrypt the RFC 8439 ciphertext || tag recovers the known plaintext", () => {
        expect(provider.chacha20Poly1305Decrypt(key, nonce, expected, aad)).toEqual(plaintext);
    });
});

describe("AEAD round-trips and error paths — all algorithms", () => {
    const key16 = fromHex("000102030405060708090a0b0c0d0e0f");
    const key32 = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    const nonce = fromHex("101112131415161718191a1b");
    const aad = fromUtf8("tls-13-record");
    const plaintext = fromUtf8("attack at dawn");

    it("encrypt output length === plaintext.length + 16 (tag appended), decrypt round-trips", () => {
        const roundTrips: ReadonlyArray<() => Uint8Array> = [
            () => provider.aes128GcmDecrypt(key16, nonce, provider.aes128GcmEncrypt(key16, nonce, plaintext, aad), aad),
            () => provider.aes256GcmDecrypt(key32, nonce, provider.aes256GcmEncrypt(key32, nonce, plaintext, aad), aad),
            () => provider.chacha20Poly1305Decrypt(key32, nonce, provider.chacha20Poly1305Encrypt(key32, nonce, plaintext, aad), aad),
        ];
        for (const roundTrip of roundTrips) {
            expect(roundTrip()).toEqual(plaintext);
        }
        expect(provider.aes128GcmEncrypt(key16, nonce, plaintext, aad)).toHaveLength(plaintext.length + 16);
    });

    it("works with empty plaintext (tag-only output)", () => {
        const ciphertext = provider.aes256GcmEncrypt(key32, nonce, new Uint8Array(0), aad);
        expect(ciphertext).toHaveLength(16);
        expect(provider.aes256GcmDecrypt(key32, nonce, ciphertext, aad)).toHaveLength(0);
    });

    it("decrypt with tampered ciphertext throws DecryptError", () => {
        const ciphertext = provider.aes256GcmEncrypt(key32, nonce, plaintext, aad);
        const tampered = new Uint8Array(ciphertext);
        tampered[0] = (tampered[0] ?? 0) ^ 1;
        expect(() => provider.aes256GcmDecrypt(key32, nonce, tampered, aad)).toThrow(DecryptError);
    });

    it("decrypt with wrong AAD throws DecryptError", () => {
        const ciphertext = provider.aes256GcmEncrypt(key32, nonce, plaintext, aad);
        expect(() => provider.aes256GcmDecrypt(key32, nonce, ciphertext, fromUtf8("other"))).toThrow(DecryptError);
    });

    it("decrypt with wrong key throws DecryptError", () => {
        const ciphertext = provider.aes256GcmEncrypt(key32, nonce, plaintext, aad);
        expect(() => provider.aes256GcmDecrypt(new Uint8Array(32).fill(1), nonce, ciphertext, aad)).toThrow(DecryptError);
    });

    it("decrypt of input shorter than the tag throws DecryptError", () => {
        expect(() => provider.aes128GcmDecrypt(key16, nonce, new Uint8Array(8), aad)).toThrow(DecryptError);
        expect(() => provider.chacha20Poly1305Decrypt(key32, nonce, new Uint8Array(0), aad)).toThrow(DecryptError);
    });

    it("AES-128-CCM throws UnsupportedAlgorithmError (never offered by profiles)", () => {
        expect(() => provider.aes128CcmEncrypt(key16, nonce, plaintext, aad)).toThrow(UnsupportedAlgorithmError);
        expect(() => provider.aes128CcmDecrypt(key16, nonce, plaintext, aad)).toThrow(UnsupportedAlgorithmError);
    });
});

describe("aesEcbEncrypt — QUIC header protection block", () => {
    it("encrypts exactly one 16-byte block, no padding, matching node:crypto", () => {
        for (const key of [fromHex("000102030405060708090a0b0c0d0e0f"), fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")]) {
            const block = fromHex("00112233445566778899aabbccddeeff");
            const out = provider.aesEcbEncrypt(key, block);
            expect(out).toHaveLength(16);
            // node:crypto cross-check with auto-padding disabled.
            const cipher = createCipheriv(key.length === 16 ? "aes-128-ecb" : "aes-256-ecb", key, new Uint8Array(0));
            cipher.setAutoPadding(false);
            const expected = new Uint8Array(Buffer.concat([cipher.update(block), cipher.final()]));
            expect(out).toEqual(expected);
        }
    });
});

// ---------------------------------------------------------------------------
// X25519 — RFC 7748 vectors (ported from @browsercore/crypto)
// ---------------------------------------------------------------------------

describe("RFC 7748 §5.2 X25519 scalar-multiplication vectors", () => {
    it("Vector 1", () => {
        expect(
            provider.x25519SharedSecret(
                fromHex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"),
                fromHex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"),
            ),
        ).toEqual(fromHex("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"));
    });

    it("Vector 2", () => {
        expect(
            provider.x25519SharedSecret(
                fromHex("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d"),
                fromHex("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493"),
            ),
        ).toEqual(fromHex("95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957"));
    });
});

describe("RFC 7748 §6.1 X25519 Diffie-Hellman vector", () => {
    const alicePriv = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
    const alicePub = fromHex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    const bobPriv = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
    const bobPub = fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    const sharedK = fromHex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");

    it("generateKeyPair derives the public key as X25519(secret, 9)", () => {
        // Deterministic: derive from Alice's published private scalar by
        // generating with a patched random source is not possible — instead
        // assert the mathematical identity via sharedSecret(secret, 9).
        const base9 = new Uint8Array(32);
        base9[0] = 9;
        expect(provider.x25519SharedSecret(alicePriv, base9)).toEqual(alicePub);
        expect(provider.x25519SharedSecret(bobPriv, base9)).toEqual(bobPub);
    });

    it("X25519(a, K_B) === X25519(b, K_A) === published shared secret K", () => {
        expect(provider.x25519SharedSecret(alicePriv, bobPub)).toEqual(sharedK);
        expect(provider.x25519SharedSecret(bobPriv, alicePub)).toEqual(sharedK);
    });

    it("generated key pairs are 32/32 bytes and DH-symmetric", () => {
        const a = provider.x25519GenerateKeyPair();
        const b = provider.x25519GenerateKeyPair();
        expect(a.publicKey).toHaveLength(32);
        expect(a.secretKey).toHaveLength(32);
        expect(provider.x25519SharedSecret(a.secretKey, b.publicKey)).toEqual(
            provider.x25519SharedSecret(b.secretKey, a.publicKey),
        );
    });
});

describe("RFC 7748 §5 degenerate u-coordinates", () => {
    it("all-zero peer yields 32 zero bytes (no throw), across distinct scalars", () => {
        const zero = new Uint8Array(32);
        for (const scalarHex of [
            "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
            "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
        ]) {
            expect(provider.x25519SharedSecret(fromHex(scalarHex), zero)).toEqual(new Uint8Array(32));
        }
    });
});

// ---------------------------------------------------------------------------
// ECDH — NIST curves (vectors cross-validated against node:crypto)
// ---------------------------------------------------------------------------

describe("secp256r1 known-answer vectors", () => {
    const alicePriv = fromHex("7d7dc5f71eb29dd69c349f53f07a7c9e3bbfd2bb3f087a5a6b2e5c3e5e3c3c3a");
    const bobPub = fromHex(
        "042ba465be61472b2a228d9198dc6132869953efc66331151c78ee7183e39552cedc1b13c0ee95f63c21006df723f1322f39b32d8b71c16cff8ec4bd395dd0c10d",
    );
    const bobPriv = fromHex("38f2c5e1a4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a");
    const alicePub = fromHex(
        "04b94d92f039bda5c42c7c1ab999bba5a71e2c31de41fbec4f59d53a3b82d887b850df8aeed6f67542c27288c7bc86e20fdebbbf6fc4ace2bc94aa5a2a353cdc9c",
    );
    const shared = fromHex("1970fbc9aa6e337271f565f7b232b792879af5d812ff63906a83cf9f4439a819");

    it("ECDH(alicePriv, bobPub) === published shared secret (32-byte x-coordinate)", () => {
        const secret = provider.ecdhSharedSecret("secp256r1", alicePriv, bobPub);
        expect(secret).toHaveLength(32);
        expect(secret).toEqual(shared);
    });

    it("ECDH(bobPriv, alicePub) === published shared secret (DH symmetry)", () => {
        expect(provider.ecdhSharedSecret("secp256r1", bobPriv, alicePub)).toEqual(shared);
    });

    it("generateKeyPair returns a 65-byte uncompressed public key (0x04 || x || y)", () => {
        const kp = provider.ecdhGenerateKeyPair("secp256r1");
        expect(kp.curve).toBe("secp256r1");
        expect(kp.secretKey).toHaveLength(32);
        expect(kp.publicKey).toHaveLength(65);
        expect(kp.publicKey[0]).toBe(0x04);
    });
});

describe("secp384r1 known-answer vectors", () => {
    const alicePriv = fromHex(
        "3f2c5e1a4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a7d7dc5f71eb29dd69c349f53f07a7c9e",
    );
    const bobPriv = fromHex(
        "1a2b3c4d5e6f708192030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20212223242526272829",
    );
    const bobPub = fromHex(
        "04db366b54906db9f563142b8dcfde126cb601ab2eb75a797a1e1920e269b4cb21dff09f4e638f7656ed2302cad4242fcc225c0119da57003592f7bb556588624f4393a92c4d33aa931f33dad2cbbfdaba53f084a455e15d6414996d8624cb4a83",
    );
    const shared = fromHex(
        "78f3c4c061455d9be316040f4822c7ad2ce03240c0d8871fb449a1c2bb0e3a677c75e59bd95828093835c4133f5e6612",
    );

    it("ECDH(alicePriv, bobPub) === published shared secret (48-byte x-coordinate)", () => {
        const secret = provider.ecdhSharedSecret("secp384r1", alicePriv, bobPub);
        expect(secret).toHaveLength(48);
        expect(secret).toEqual(shared);
    });

    it("DH symmetry with node:crypto-re-derived peer public key", () => {
        const nodeEcdh = createECDH("secp384r1");
        nodeEcdh.setPrivateKey(Buffer.from(alicePriv));
        const alicePub = new Uint8Array(nodeEcdh.getPublicKey());
        expect(provider.ecdhSharedSecret("secp384r1", bobPriv, alicePub)).toEqual(shared);
    });
});

// ---------------------------------------------------------------------------
// ML-KEM-768 — FIPS 203 round-trip + hybrid composition
// ---------------------------------------------------------------------------

describe("ML-KEM-768", () => {
    it("key pair has the FIPS 203 parameter sizes (1184 / 2400 bytes)", () => {
        const kp = provider.mlkem768GenerateKeyPair();
        expect(kp.publicKey).toHaveLength(1184);
        expect(kp.secretKey).toHaveLength(2400);
    });

    it("encapsulate/decapsulate round-trip via x25519MLKEM768SharedSecret inputs", async () => {
        const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
        const kp = provider.mlkem768GenerateKeyPair();
        const encapsulation = ml_kem768.encapsulate(kp.publicKey);
        expect(encapsulation.cipherText).toHaveLength(1088);
        const decapsulated = provider.mlkem768Decapsulate(kp.secretKey, encapsulation.cipherText);
        expect(decapsulated).toEqual(encapsulation.sharedSecret);
        expect(decapsulated).toHaveLength(32);
    });

    it("decapsulate with malformed ciphertext throws a typed CryptoError", () => {
        const kp = provider.mlkem768GenerateKeyPair();
        expect(() => provider.mlkem768Decapsulate(kp.secretKey, new Uint8Array(10))).toThrow(CryptoError);
    });
});

describe("X25519MLKEM768 hybrid shared secret", () => {
    it("is 64 bytes with the ML-KEM secret FIRST, then X25519 (draft-ietf-tls-ecdhe-mlkem)", async () => {
        const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
        const alicePriv = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
        const bobPub = fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
        const mlkemKp = provider.mlkem768GenerateKeyPair();
        const enc = ml_kem768.encapsulate(mlkemKp.publicKey);

        const hybrid = provider.x25519MLKEM768SharedSecret(alicePriv, bobPub, mlkemKp.secretKey, enc.cipherText);

        expect(hybrid).toHaveLength(64);
        expect(hybrid.subarray(0, 32)).toEqual(provider.mlkem768Decapsulate(mlkemKp.secretKey, enc.cipherText));
        expect(hybrid.subarray(32)).toEqual(provider.x25519SharedSecret(alicePriv, bobPub));
    });
});

// ---------------------------------------------------------------------------
// verifySignature — cross-validated against node:crypto-generated keys
// ---------------------------------------------------------------------------

describe("verifySignature", () => {
    const data = fromUtf8("to-be-signed");

    /** Generate an SPKI DER public key + a node:crypto signer for a scheme. */
    function fixture(scheme: string): { publicKey: Uint8Array; sign: (payload: Uint8Array) => Uint8Array } {
        switch (scheme) {
            case "ecdsa_secp256r1_sha256": {
                const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
                return {
                    publicKey: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
                    sign: (payload) =>
                        new Uint8Array(createSign("sha256").update(payload).sign(privateKey)),
                };
            }
            case "ecdsa_secp384r1_sha384": {
                const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
                return {
                    publicKey: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
                    sign: (payload) =>
                        new Uint8Array(createSign("sha384").update(payload).sign(privateKey)),
                };
            }
            case "rsa_pss_rsae_sha256": {
                const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
                return {
                    publicKey: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
                    sign: (payload) =>
                        new Uint8Array(
                            createSign("sha256").update(payload).sign({
                                key: privateKey,
                                padding: nodeCryptoConstants.RSA_PKCS1_PSS_PADDING,
                                saltLength: 32,
                            }),
                        ),
                };
            }
            case "rsa_pss_rsae_sha384": {
                const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
                return {
                    publicKey: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
                    sign: (payload) =>
                        new Uint8Array(
                            createSign("sha384").update(payload).sign({
                                key: privateKey,
                                padding: nodeCryptoConstants.RSA_PKCS1_PSS_PADDING,
                                saltLength: 48,
                            }),
                        ),
                };
            }
            case "rsa_pkcs1_sha256": {
                const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
                return {
                    publicKey: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
                    sign: (payload) =>
                        new Uint8Array(
                            createSign("sha256").update(payload).sign({
                                key: privateKey,
                                padding: nodeCryptoConstants.RSA_PKCS1_PADDING,
                            }),
                        ),
                };
            }
            default:
                throw new Error(`no fixture for ${scheme}`);
        }
    }

    for (const scheme of [
        "ecdsa_secp256r1_sha256",
        "ecdsa_secp384r1_sha384",
        "rsa_pss_rsae_sha256",
        "rsa_pss_rsae_sha384",
        "rsa_pkcs1_sha256",
    ]) {
        it(`${scheme}: verifies a genuine signature, rejects a tampered one`, () => {
            const { publicKey, sign } = fixture(scheme);
            const signature = sign(data);
            expect(provider.verifySignature(scheme, publicKey, signature, data)).toBe(true);
            const tamperedData = fromUtf8("to-be-tampered");
            expect(provider.verifySignature(scheme, publicKey, signature, tamperedData)).toBe(false);
        });
    }

    it("unknown scheme throws UnsupportedAlgorithmError", () => {
        const { publicKey, sign } = fixture("ecdsa_secp256r1_sha256");
        expect(() =>
            provider.verifySignature("ed25519_ph", publicKey, sign(data), data),
        ).toThrow(UnsupportedAlgorithmError);
    });
});
