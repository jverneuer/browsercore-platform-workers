/**
 * vitest config for the REAL-workerd integration suite (`integration/`).
 *
 * NOT part of `npm test` (the default config only includes `tests/`): the
 * pool needs the workerd binary, which is a dev-machine concern. Run with:
 *
 *     npm install --no-save @cloudflare/vitest-pool-workers
 *     npx vitest run -c vitest.workers.config.ts
 *
 * compat mirrors examples/wrangler.jsonc: nodejs_compat +
 * a compatibility_date on/after 2026-08-04 (all node:crypto APIs supported).
 */
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
    test: {
        include: ["integration/**/*.test.ts"],
    },
    plugins: [
        cloudflareTest({
            miniflare: {
                compatibilityFlags: ["nodejs_compat"],
                compatibilityDate: "2026-08-15",
            },
        }),
    ],
});
