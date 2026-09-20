/**
 * Small shared helpers for the PostPrep server.
 * No external dependencies: only Deno built-ins.
 */

/** Generate a short, url/file safe identifier such as `prj_9f2c41ab77d1`. */
export function newId(prefix: string): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `${prefix}_${uuid.slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Turn any user supplied name into a safe single path segment. */
export function sanitizeFilename(name: string, fallback = "file"): string {
  const base = name.split(/[\\/]/).pop() ?? fallback;
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-96);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** True when `segment` is safe to use as a single path segment. */
export function isSafeSegment(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) && !segment.includes("..");
}

export function extname(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "post";
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** Write a file atomically (write to a temp sibling, then rename). */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  if (typeof data === "string") {
    await Deno.writeTextFile(tmp, data);
  } else {
    await Deno.writeFile(tmp, data);
  }
  await Deno.rename(tmp, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Serialise async work so that concurrent HTTP requests cannot interleave
 * read-modify-write cycles on the same store.
 */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}

/** Parse a JSONL document into records, skipping blank/corrupt lines. */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A partially written trailing line is expected on crash: skip it.
    }
  }
  return out;
}

export function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
