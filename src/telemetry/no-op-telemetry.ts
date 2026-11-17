/**
 * No-op `Telemetry` for Cloudflare Workers.
 *
 * Mirrors browsersmith's `noOpTelemetry`: the zero-cost default so
 * `Platform.telemetry` is always present. Consumers that want observability
 * inject a real implementation via `createWorkersPlatform(env, { telemetry })`.
 *
 * @module
 */

import type { Logger, Metrics, Span, Telemetry, Tracer } from "@browsercore/contracts";

/** A span that records nothing and costs nothing. */
const noOpSpan: Span = {
    setAttribute: () => noOpSpan,
    end: () => {},
};

const noOpLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

const noOpTracer: Tracer = {
    startSpan: () => noOpSpan,
};

const noOpMetrics: Metrics = {
    add: () => {},
};

/** Zero-cost telemetry bundle — the Platform default. */
export const noOpTelemetry: Telemetry = {
    logger: noOpLogger,
    tracer: noOpTracer,
    metrics: noOpMetrics,
};
