/**
 * Semantics tests for the Map-based WorkersEventProvider — the 8-method
 * contracts surface, no node:events.
 */

import { describe, expect, it, vi } from "vitest";

import { WorkersEventProvider } from "../src/events/workers-event-provider.js";

describe("WorkersEventProvider", () => {
    it("on + emit delivers payloads and returns true when listeners exist", () => {
        const events = new WorkersEventProvider();
        const heard: string[] = [];
        events.on("greeting", (...args: unknown[]) => {
            heard.push(args.join(" "));
        });
        expect(events.emit("greeting", "hello", "world")).toBe(true);
        expect(heard).toEqual(["hello world"]);
        expect(events.emit("nobody-listening")).toBe(false);
    });

    it("multiple listeners fire in registration order", () => {
        const events = new WorkersEventProvider();
        const order: number[] = [];
        events.on("tick", () => order.push(1));
        events.on("tick", () => order.push(2));
        events.emit("tick");
        expect(order).toEqual([1, 2]);
    });

    it("once fires exactly one time, then removes itself", () => {
        const events = new WorkersEventProvider();
        const listener = vi.fn();
        events.once("boot", listener);
        events.emit("boot", 1);
        events.emit("boot", 2);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(1);
        expect(events.listenerCount("boot")).toBe(0);
    });

    it("off / removeListener detach a specific listener (both aliases)", () => {
        const events = new WorkersEventProvider();
        const a = vi.fn();
        const b = vi.fn();
        events.on("x", a);
        events.on("x", b);
        events.off("x", a);
        events.emit("x");
        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledTimes(1);
        events.removeListener("x", b);
        events.emit("x");
        expect(b).toHaveBeenCalledTimes(1);
    });

    it("listenerCount reflects registrations", () => {
        const events = new WorkersEventProvider();
        expect(events.listenerCount("e")).toBe(0);
        events.on("e", () => undefined);
        events.on("e", () => undefined);
        expect(events.listenerCount("e")).toBe(2);
    });

    it("removeAllListeners(event) clears one event; removeAllListeners() clears all", () => {
        const events = new WorkersEventProvider();
        events.on("a", () => undefined);
        events.on("b", () => undefined);
        events.removeAllListeners("a");
        expect(events.listenerCount("a")).toBe(0);
        expect(events.listenerCount("b")).toBe(1);
        events.removeAllListeners();
        expect(events.listenerCount("b")).toBe(0);
    });

    it("a once-listener removing itself mid-emit does not break iteration", () => {
        const events = new WorkersEventProvider();
        const calls: string[] = [];
        events.once("chain", () => calls.push("once"));
        events.on("chain", () => calls.push("always"));
        events.emit("chain");
        events.emit("chain");
        expect(calls).toEqual(["once", "always", "always"]);
    });

    it("the same function can be registered under different events", () => {
        const events = new WorkersEventProvider();
        const listener = vi.fn();
        events.on("a", listener);
        events.on("b", listener);
        events.emit("a", "x");
        expect(listener).toHaveBeenCalledTimes(1);
        events.emit("b", "y");
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
