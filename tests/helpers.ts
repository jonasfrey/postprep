/** Shared helpers for the PostPrep test suite. */

import { join } from "node:path";
import { createHandler, ProjectStore } from "../server.ts";

export function writeUint32BE(
  target: Uint8Array<ArrayBuffer>,
  offset: number,
  value: number,
): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** A minimal but structurally valid PNG header (IHDR only). */
export function makePng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeUint32BE(bytes, 8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // colour type: RGBA
  return bytes;
}

export function makeGif(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(16);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}

export function makeJpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xc0], 2); // SOF0
  bytes[4] = 0x00;
  bytes[5] = 0x11; // segment length = 17
  bytes[6] = 8; // precision
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  bytes.set([0xff, 0xd9], 11); // EOI
  return bytes;
}

export function makeWebpVp8x(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

export interface TestServer {
  base: string;
  dataDir: string;
  store: ProjectStore;
  stop: () => Promise<void>;
}

/** Boot a throwaway server on an ephemeral port with a temp data directory. */
export async function startTestServer(): Promise<TestServer> {
  const dataDir = await Deno.makeTempDir({ prefix: "postprep-test-" });
  const publicDir = join(import.meta.dirname!, "..", "public");
  const store = new ProjectStore({ dataDir });
  await store.init();
  const handler = createHandler(store, publicDir);
  let resolveListen: (address: { hostname: string; port: number }) => void = () => {};
  const ready = new Promise<{ hostname: string; port: number }>((resolve) => {
    resolveListen = resolve;
  });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: (address) => resolveListen(address) },
    handler,
  );
  const address = await ready;
  return {
    base: `http://127.0.0.1:${address.port}`,
    dataDir,
    store,
    stop: async () => {
      await server.shutdown();
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    },
  };
}
