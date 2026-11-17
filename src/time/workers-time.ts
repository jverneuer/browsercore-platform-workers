/**
 * `Time` adapter for Cloudflare Workers — Web-standard APIs only, no
 * `node:timers` / `node:perf_hooks`.
 *
 * `Date.now()` for wall time, `performance.now()` (monotonic on workerd)
 * scaled to nanoseconds for `clock.monotonic()`, `setTimeout`/`clearTimeout`
 * for delays, and `AbortSignal.timeout` for cancellation windows — the exact
 * surface the contracts `Time` shape consumes.
 *
 * @module
 */

import type { Deadline, Duration, Scheduler, Time } from "@browsercore/contracts";

/** Milliseconds → nanoseconds, as the `Time` contract's monotonic clock speaks ns. */
const MS_TO_NS = 1_000_000n;

/** The abort reason Workers/Node attach — fall back if it is not an Error. */
function abortReason(signal: AbortSignal | undefined): Error {
    return signal?.reason instanceof Error ? signal.reason : new Error("aborted");
}

/** `scheduler.delay` over setTimeout with AbortSignal support. */
function delay(duration: Duration, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal === undefined) {
            setTimeout(() => {
                resolve();
            }, duration.milliseconds);
            return;
        }
        if (signal.aborted) {
            reject(abortReason(signal));
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(abortReason(signal));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, duration.milliseconds);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** Build the scheduler once — pure functions over Web-standard timers. */
const workersScheduler: Scheduler = {
    delay,
    timeout: (duration: Duration): AbortSignal => AbortSignal.timeout(duration.milliseconds),
    deadline: (duration: Duration): Deadline => ({
        signal: AbortSignal.timeout(duration.milliseconds),
        expiresAt: workersMonotonic() + BigInt(duration.milliseconds) * MS_TO_NS,
    }),
};

/** Monotonic nanoseconds from `performance.now()` — never goes backwards. */
function workersMonotonic(): bigint {
    return BigInt(Math.round(performance.now() * 1_000_000));
}

/** Workers `Time` bundle — composed into the Platform. */
export const workersTime: Time = {
    clock: {
        now: () => Date.now(),
        monotonic: workersMonotonic,
    },
    scheduler: workersScheduler,
};
