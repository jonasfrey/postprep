/**
 * A tiny zero-dependency replacement for `@std/assert`.
 *
 * Keeping the suite free of remote imports means `deno task test` works
 * completely offline and inside restricted sandboxes.
 */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert(condition: unknown, message = "Expected a truthy value"): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new AssertionError(
      message ??
        `Values are not equal.\n  actual:   ${format(actual)}\n  expected: ${format(expected)}`,
    );
  }
}

export function assertNotEquals<T>(actual: T, expected: T, message?: string): void {
  if (deepEqual(actual, expected)) {
    throw new AssertionError(message ?? `Expected values to differ, both were ${format(actual)}`);
  }
}

export function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new AssertionError(
      `Expected string to include ${format(expected)}\n  actual: ${format(actual)}`,
    );
  }
}

export function assertMatch(actual: string, pattern: RegExp): void {
  if (!pattern.test(actual)) {
    throw new AssertionError(`Expected ${format(actual)} to match ${pattern}`);
  }
}

export async function assertRejects(
  fn: () => Promise<unknown> | unknown,
  // deno-lint-ignore no-explicit-any
  errorClass?: new (...args: any[]) => Error,
  messageIncludes?: string,
): Promise<Error> {
  let thrown: unknown;
  let didThrow = false;
  try {
    await fn();
  } catch (error) {
    thrown = error;
    didThrow = true;
  }
  if (!didThrow) throw new AssertionError("Expected the call to reject, but it resolved");
  if (errorClass && !(thrown instanceof errorClass)) {
    throw new AssertionError(
      `Expected rejection of type ${errorClass.name}, got ${format(thrown)}`,
    );
  }
  if (messageIncludes && !(thrown instanceof Error && thrown.message.includes(messageIncludes))) {
    throw new AssertionError(`Expected error message to include ${format(messageIncludes)}`);
  }
  return thrown as Error;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) if (!deepEqual(value, b.get(key))) return false;
    return true;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
