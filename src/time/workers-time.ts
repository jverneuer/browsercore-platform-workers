/**
 * `Time` adapter for Cloudflare Workers — the canonical `Clock` contract
 * (contracts 0.2.6+ collapsed the old `{ clock, scheduler }` bundle into
 * `Time ≡ Clock`), Web-standard APIs only: no `node:timers` /
 * `node:perf_hooks`.
 *
 * `Date.now()` for wall time, `performance.now()` (monotonic on workerd) in
 * milliseconds for elapsed/deadline math, and `setTimeout`/`clearTimeout`
 * for `sleep`/`setTimeout`/`clearTimeout`. Timer tokens are BOXED so the
 * opaque `TimerHandle` is a genuine object on every runtime: workerd's
 * `setTimeout` hands back a numeric id where Node hands back a `Timeout`
 * object — the box makes both indistinguishable to callers, exactly the
 * opacity the contract demands ("treat it as anything more specific and that
 * is a contract violation").
 *
 * @module
 */

import type { TimerHandle, Time } from "@browsercore/contracts";

/**
 * Boxed timer token — {@link TimerHandle} is `object`, and workerd's
 * `setTimeout` returns a numeric id (only Node's returns an object), so the
 * raw token is wrapped to keep the handle genuinely opaque on every runtime.
 */
interface WorkersTimerHandle {
    readonly token: number | NodeJS.Timeout;
}

/** Workers `Time` bundle — the canonical `Clock`, composed into the Platform. */
export const workersTime: Time = {
    /** Wall-clock epoch ms — `Date.now()`-comparable, may jump (NTP). */
    now: (): number => Date.now(),

    /** Monotonic ms from `performance.now()` — never goes backwards. */
    monotonic: (): number => performance.now(),

    /** Resolve after `ms` milliseconds — the bare `setTimeout`-as-sleep replacement. */
    sleep: (ms: number): Promise<void> =>
        new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        }),

    /** Run `fn` once after `ms` milliseconds; cancel via {@link clearTimeout}. */
    setTimeout: (ms: number, fn: () => void): TimerHandle => ({
        token: setTimeout(fn, ms),
    }),

    /** Cancel a pending timer obtained from {@link setTimeout}. */
    clearTimeout: (handle: TimerHandle): void => {
        clearTimeout((handle as WorkersTimerHandle).token);
    },
};
