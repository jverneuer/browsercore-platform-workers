/**
 * {@link EventProvider} for Cloudflare Workers — a plain `Map`, no
 * `node:events`.
 *
 * workerd has no `EventEmitter`; the contracts surface (the 8-method
 * `EventProvider`) is all the stack consumes, so a minimal Map-based
 * implementation with EventEmitter-compatible semantics (once-fires-once,
 * `emit` returns whether anyone listened) is the whole adapter.
 *
 * @module
 */

import type { EventProvider } from "@browsercore/contracts";

/** Internal listener storage signature. */
type Listener = (...args: unknown[]) => void;

/** Map-based {@link EventProvider} for Workers. */
export class WorkersEventProvider implements EventProvider {
    private readonly listeners = new Map<string, Set<Listener>>();

    public on(event: string, listener: (...args: unknown[]) => void): void {
        this.addListener(event, listener);
    }

    public once(event: string, listener: (...args: unknown[]) => void): void {
        const onceListener: Listener = (...args: unknown[]) => {
            this.off(event, onceListener);
            listener(...args);
        };
        this.addListener(event, onceListener);
    }

    public off(event: string, listener: (...args: unknown[]) => void): void {
        this.listeners.get(event)?.delete(listener);
    }

    public removeListener(event: string, listener: (...args: unknown[]) => void): void {
        this.listeners.get(event)?.delete(listener);
    }

    public emit(event: string, ...args: unknown[]): boolean {
        const set = this.listeners.get(event);
        if (set === undefined || set.size === 0) {
            return false;
        }
        // Snapshot so a `once` listener removing itself mid-emit cannot
        // mutate the set being iterated.
        for (const listener of Array.from(set)) {
            listener(...args);
        }
        return true;
    }

    public listenerCount(event: string): number {
        return this.listeners.get(event)?.size ?? 0;
    }

    public removeAllListeners(event?: string): void {
        if (event === undefined) {
            this.listeners.clear();
        } else {
            this.listeners.delete(event);
        }
    }

    private addListener(event: string, listener: Listener): void {
        const set = this.listeners.get(event);
        if (set === undefined) {
            this.listeners.set(event, new Set([listener]));
        } else {
            set.add(listener);
        }
    }
}

/** Default Workers event provider — composed into the Platform. */
export const workersEventProvider: EventProvider = new WorkersEventProvider();
