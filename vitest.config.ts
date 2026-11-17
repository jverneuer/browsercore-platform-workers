import { definePackageConfig } from "@browsercore/dev/vitest";

export default definePackageConfig({
    name: "@browsercore/platform-workers",
    coverage: {
        // CI's own gate reads coverage-summary.json at >=93%; this package holds
        // itself to the stricter local bar of 94% statements / 92% branches.
        thresholds: { statements: 94, branches: 92, functions: 94, lines: 94 },
        exclude: [
            // Type-only module: like index.ts, it compiles to no executable
            // lines, so V8 cannot observe it.
            "**/types.ts",
        ],
    },
});
