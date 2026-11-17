/**
 * UDP adapter for Cloudflare Workers — a throwing stub.
 *
 * Workers has no UDP socket API, so `Platform.network.udp` (required by the
 * `Network` type QUIC consumes) cannot exist here. Every method throws a
 * typed {@link UnsupportedOnWorkersError} that names the consequence: no
 * UDP ⇒ no QUIC ⇒ **no HTTP/3** on this platform. Fetch still succeeds over
 * the TCP-based stacks (HTTP/1.1, HTTP/2), and profiles must not offer
 * `h3`/`alt-svc` upgrades when running on this adapter.
 *
 * @module
 */

import type { DatagramTransport, UdpAddress } from "@browsercore/contracts";
import { UnsupportedOnWorkersError } from "../errors.js";

/** The capability gap, stated once — every UDP operation throws it. */
const NO_UDP = new UnsupportedOnWorkersError(
    "UDP sockets",
    "no QUIC, no HTTP/3 (use the TCP-based HTTP/1.1 / HTTP/2 stacks)",
);

/** Throwing stub satisfying the `DatagramTransport` shape (see module doc). */
export const workersUdp: DatagramTransport = {
    id: "workers-udp-unsupported",
    send(_data: Uint8Array, _address: UdpAddress): Promise<void> {
        return Promise.reject(NO_UDP);
    },
    recv(): Promise<{ readonly data: Uint8Array; readonly from: UdpAddress }> {
        return Promise.reject(NO_UDP);
    },
    close(_reason?: unknown): Promise<void> {
        return Promise.reject(NO_UDP);
    },
};
