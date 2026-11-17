import { defineConfig } from "oxlint";
import base from "@browsercore/dev/oxlint";

// The rule set lives in @browsercore/dev so every package lints identically —
// drift here is how the polyrepo rots. Package-specific exceptions go in
// `rules` below `extends`, never by editing the base.
export default defineConfig({
    extends: [base],
    rules: {
        // The crypto provider is the deliberate aggregation point of the noble
        // suite (sha2, hmac, hkdf, aes, chacha, ed25519, nist, ml-kem = 8
        // module imports) plus node:crypto verify, contracts, and errors; the
        // platform root composes the seven adapter modules. That fan-in is
        // the adapter seam's design, not dependency drift.
        "import/max-dependencies": ["error", { max: 12 }],
    },
});
