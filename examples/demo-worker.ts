/**
 * Demo Worker — one fetch through the full @browsercore stack on Workers.
 *
 * This file is example code, excluded from the package build; it typechecks
 * against `@cloudflare/workers-types` (or `wrangler types`) in your Worker
 * project. Notably it imports `createClient` from **@browsercore/fetch**
 * directly, NOT from browsersmith's root barrel — that barrel re-exports the
 * eager Node platform singleton (`wiring.ts`'s `platform = createPlatform()`
 * runs `node:net`/`node:dns`/`node:dgram` imports at module load), which is
 * the tree-shaking trap the 2026-11-16 feasibility audit flagged.
 *
 * Deploy: `npx wrangler deploy` from the directory holding wrangler.jsonc
 * (see examples/wrangler.jsonc). Do NOT point `main` at the npm package —
 * bundle this entry with the deps listed below.
 */

import { connect } from "cloudflare:sockets";
// IMPORTANT: from @browsercore/fetch, not browsersmith (see header comment).
import { createClient } from "@browsercore/fetch";
import { createWorkersPlatform } from "@browsercore/platform-workers";

/** Worker env bindings — none consumed yet; the seam is reserved. */
interface Env {
    // Example: ORIGIN_HOST?: string;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const platform = createWorkersPlatform(env, { connect });
        const client = createClient({
            platform,
            profile: "chrome-140",
            // Workers have no idle socket pool to keep warm between requests:
            // disable the idle reaper so nothing schedules timers that outlive
            // the request's lifetime.
            idleTimeoutMs: 0,
        });
        try {
            const url = new URL(request.url);
            const target = url.searchParams.get("url") ?? "https://tls.peet.ws/api/all";
            const response = await client.fetch(target);
            const body = await response.text();
            return new Response(body, {
                status: response.status,
                headers: { "content-type": "application/json" },
            });
        } catch (cause) {
            // Surface upstream failures as JSON instead of an edge 1101 page —
            // e.g. a malformed ?url= should not look like a Worker crash.
            const message = cause instanceof Error ? cause.message : String(cause);
            return new Response(JSON.stringify({ error: message }), {
                status: 502,
                headers: { "content-type": "application/json" },
            });
        } finally {
            await client.close();
        }
    },
} satisfies ExportedHandler<Env>;
