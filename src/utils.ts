/**
 * Exhaustiveness guard for switch statements over discriminated unions.
 *
 * If a switch covers every member of a union and falls through to this call,
 * assigning the (unreachable) narrowed value to `never` fails to compile the
 * moment a new member is added — the compile error is the point.
 *
 * Mirrors the helper of the same name in `@browsercore/crypto`; re-declared
 * here because the platform adapter deliberately depends only on
 * `@browsercore/contracts` and the noble libraries.
 *
 * @param value - The value a caller proved unreachable by exhaustive handling.
 * @returns Never.
 */
export function assertNever(value: never): never {
    throw new Error(`unhandled variant: ${String(value)}`);
}
