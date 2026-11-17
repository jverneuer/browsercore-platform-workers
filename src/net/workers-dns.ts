/**
 * DNS adapter for Cloudflare Workers — a pass-through.
 *
 * Workers `connect()` resolves hostnames itself at the edge, so there is no
 * client-side resolver to delegate to. `lookup` returns the hostname as the
 * "resolved" address (in the requested family) and the socket shim hands
 * that name straight to `connect()`, which does the real resolution.
 *
 * This keeps `@browsercore/transport`'s address-candidate loop (resolve →
 * connect per candidate) working unchanged: every lookup "resolves" to
 * exactly one candidate, and the edge performs the actual DNS + Happy
 * Eyeballs selection.
 *
 * @module
 */

import type { DnsResolver, IPAddress } from "@browsercore/contracts";

/** Pass-through DNS resolver — resolution happens at the Cloudflare edge. */
export const workersDns: DnsResolver = {
    lookup: (hostname: string, family: 4 | 6): Promise<readonly IPAddress[]> => {
        const passthrough: IPAddress = { address: hostname, family };
        return Promise.resolve([passthrough]);
    },
};
