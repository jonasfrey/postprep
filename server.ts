/**
 * PostPrep — HTTP server.
 *
 * Serves the static single page app from ./public and a small JSON API that
 * persists every project to disk (see src/store.ts).
 *
 *   deno task start          # http://127.0.0.1:8787
 *   deno task dev            # same, with --watch
 */

import { dirname, join, normalize, sep } from "node:path";
import {
  FRAME_SIZE,
  HttpError,
  type IncomingFile,
  MAX_EXPORT_SIZE,
  MAX_FRAMES,
  MIN_EXPORT_SIZE,
  MIN_FRAMES,
  ProjectStore,
} from "./src/store.ts";
import { MAX_UPLOAD_BYTES } from "./src/images.ts";
import { isRecord } from "./src/util.ts";

export { ProjectStore };
export type { Project } from "./src/store.ts";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    if (!isRecord(parsed)) throw new HttpError(400, "Expected a JSON object body");
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Malformed JSON body");
  }
}

async function readUploadedFiles(req: Request, field: string): Promise<IncomingFile[]> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Expected a multipart/form-data upload");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "Upload too large");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Malformed multipart body");
  }
  const files: IncomingFile[] = [];
  for (const entry of form.getAll(field)) {
    if (entry instanceof File) {
      files.push({
        name: entry.name || "upload",
        bytes: new Uint8Array(await entry.arrayBuffer()),
      });
    }
  }
  return files;
}

async function route(req: Request, store: ProjectStore, publicDir: string): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter((part) => part.length > 0);

  if (segments[0] !== "api") return await serveStatic(req, url.pathname, publicDir);

  const method = req.method.toUpperCase();

  if (segments.length === 2 && segments[1] === "health") {
    return json({ ok: true, uptime: performance.now() / 1000 });
  }

  if (segments.length === 2 && segments[1] === "config") {
    return json({
      frameSize: FRAME_SIZE,
      minFrames: MIN_FRAMES,
      maxFrames: MAX_FRAMES,
      minExportSize: MIN_EXPORT_SIZE,
      maxExportSize: MAX_EXPORT_SIZE,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    });
  }

  if (segments[1] !== "projects") throw new HttpError(404, "Unknown endpoint");

  // /api/projects
  if (segments.length === 2) {
    if (method === "GET") return json({ projects: store.list() });
    if (method === "POST") {
      const body = await readJsonBody(req);
      const project = await store.create(typeof body.name === "string" ? body.name : "");
      return json({ project }, 201);
    }
    throw new HttpError(405, `Method ${method} not allowed`);
  }

  const id = decodeURIComponent(segments[2]);

  // /api/projects/:id
  if (segments.length === 3) {
    if (method === "GET") return json({ project: await store.get(id) });
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      return json({ project: await store.update(id, body) });
    }
    if (method === "DELETE") {
      await store.remove(id);
      return noContent();
    }
    throw new HttpError(405, `Method ${method} not allowed`);
  }

  const resource = segments[3];

  // /api/projects/:id/layout
  if (segments.length === 4 && resource === "layout") {
    if (method === "GET") return json({ layout: await store.getLayout(id) });
    if (method === "PUT" || method === "POST") {
      const body = await readJsonBody(req);
      const layout = await store.saveLayout(id, body.items !== undefined ? body : body.layout);
      return json({ layout });
    }
    throw new HttpError(405, `Method ${method} not allowed`);
  }

  // /api/projects/:id/images
  if (segments.length === 4 && resource === "images") {
    if (method === "POST") {
      const files = await readUploadedFiles(req, "images");
      const { project, added } = await store.addImages(id, files);
      return json({ project, added }, 201);
    }
    throw new HttpError(405, `Method ${method} not allowed`);
  }

  // /api/projects/:id/images/:file | :imageId
  if (segments.length === 5 && resource === "images") {
    const target = segments[4];
    if (method === "GET" || method === "HEAD") {
      const path = await store.imagePath(id, decodeURIComponent(target));
      return await serveFile(req, path, { immutable: true });
    }
    if (method === "DELETE") {
      await store.removeImage(id, decodeURIComponent(target));
      return json({ ok: true });
    }
    throw new HttpError(405, `Method ${method} not allowed`);
  }

  // /api/projects/:id/exports
  if (segments.length === 4 && resource === "exports") {
    if (method === "GET") return json({ exports: await store.listExports(id) });
    if (method === "POST") {
      const files = await readUploadedFiles(req, "frames");
      const rawMeta = req.headers.get("x-postprep-meta");
      let meta: { exportSize?: number; frameCount?: number } = {};
      if (rawMeta) {
        try {
          const parsed = JSON.parse(decodeURIComponent(rawMeta));
          if (isRecord(parsed)) meta = parsed as typeof meta;
        } catch {
          meta = {};
        }
      }
      const record = await store.addExport(id, files, meta);
      return json({ export: record }, 201);
    }
    if (method === "DELETE") {
      await store.clearExports(id);
      return noContent();
    }
    throw new HttpError(405, `Method ${method} not allowed`);
  }

  // /api/projects/:id/exports/:file
  if (segments.length === 5 && resource === "exports") {
    if (method === "GET" || method === "HEAD") {
      const path = await store.exportPath(id, decodeURIComponent(segments[4]));
      return await serveFile(req, path, { immutable: true });
    }
    throw new HttpError(405, `Method ${method} not allowed`);
  }

  throw new HttpError(404, "Unknown endpoint");
}

async function serveFile(
  req: Request,
  path: string,
  options: { immutable?: boolean } = {},
): Promise<Response> {
  const stat = await Deno.stat(path).catch(() => null);
  if (!stat || !stat.isFile) throw new HttpError(404, "Not found");
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const etag = `W/"${stat.size}-${stat.mtime?.getTime() ?? 0}"`;
  const headers: Record<string, string> = {
    "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
    "cache-control": options.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    etag,
  };
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (req.method.toUpperCase() === "HEAD") {
    headers["content-length"] = String(stat.size);
    return new Response(null, { status: 200, headers });
  }
  const body = await Deno.readFile(path);
  return new Response(body, { status: 200, headers });
}

async function serveStatic(req: Request, pathname: string, publicDir: string): Promise<Response> {
  if (req.method.toUpperCase() !== "GET" && req.method.toUpperCase() !== "HEAD") {
    throw new HttpError(405, `Method ${req.method} not allowed`);
  }
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Malformed path");
  }
  if (relative.endsWith("/")) relative += "index.html";
  const root = normalize(publicDir);
  const full = normalize(join(root, relative));
  if (full !== root && !full.startsWith(root + sep)) throw new HttpError(403, "Forbidden");
  const stat = await Deno.stat(full).catch(() => null);
  if (!stat || !stat.isFile) throw new HttpError(404, "Not found");
  return await serveFile(req, full);
}

export function createHandler(
  store: ProjectStore,
  publicDir: string,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      await store.init();
      return await route(req, store, publicDir);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("[postprep] unhandled error:", error);
      return json({ error: "Internal server error" }, 500);
    }
  };
}

export interface StartServerOptions {
  dataDir?: string;
  publicDir?: string;
  port?: number;
  hostname?: string;
}

export interface RunningServer {
  store: ProjectStore;
  server: Deno.HttpServer;
  ready: Promise<{ hostname: string; port: number }>;
}

export function startServer(options: StartServerOptions = {}): RunningServer {
  const root = import.meta.dirname ?? dirname(new URL(import.meta.url).pathname);
  const dataDir = options.dataDir ?? join(root, "data");
  const publicDir = options.publicDir ?? join(root, "public");
  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOST;

  const store = new ProjectStore({ dataDir });
  const handler = createHandler(store, publicDir);

  let resolveListen: (address: { hostname: string; port: number }) => void = () => {};
  const ready = new Promise<{ hostname: string; port: number }>((resolve) => {
    resolveListen = resolve;
  });
  const server = Deno.serve(
    {
      port,
      hostname,
      onListen: (address) => resolveListen({ hostname: address.hostname, port: address.port }),
    },
    handler,
  );
  return { store, server, ready };
}

if (import.meta.main) {
  const { server, ready, store } = startServer({
    port: Deno.env.get("PORT") ? Number(Deno.env.get("PORT")) : undefined,
    hostname: Deno.env.get("HOST") ?? undefined,
    dataDir: Deno.env.get("POSTPREP_DATA") ?? undefined,
  });
  await store.init();
  const address = await ready;
  console.log(`PostPrep running at http://${address.hostname}:${address.port}`);
  console.log(`Data directory: ${store.dataDir}`);
  Deno.addSignalListener("SIGINT", () => {
    console.log("\nShutting down…");
    server.shutdown();
  });
}
