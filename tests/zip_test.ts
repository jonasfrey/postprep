import { assert, assertEquals } from "./assert.ts";
import { crc32, createZip } from "../public/js/zip.js";

Deno.test("crc32 matches the reference implementation", () => {
  const bytes = new TextEncoder().encode("hello");
  assertEquals(crc32(bytes), 0x3610a686);
  assertEquals(crc32(new Uint8Array(0)), 0);
});

Deno.test("createZip writes a readable store-only archive", async () => {
  const data = new TextEncoder().encode("hello");
  const blob = createZip([{ name: "a.txt", data }], new Date(2024, 0, 2, 3, 4, 5));
  // 30 + 5 (local header + name) + 5 (data) + 46 + 5 (central) + 22 (EOCD)
  assertEquals(blob.size, 113);
  assertEquals(blob.type, "application/zip");

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assertEquals(view.getUint32(0, true), 0x04034b50);
  assertEquals(view.getUint32(14, true), 0x3610a686); // CRC of the payload
  assertEquals(view.getUint32(18, true), 5);
  assertEquals(new TextDecoder().decode(bytes.slice(30, 35)), "a.txt");
  assertEquals(new TextDecoder().decode(bytes.slice(35, 40)), "hello");
  assertEquals(view.getUint32(40, true), 0x02014b50); // central directory
  assertEquals(view.getUint32(blob.size - 22, true), 0x06054b50); // EOCD
  assertEquals(view.getUint16(blob.size - 22 + 10, true), 1); // one entry
});

Deno.test("createZip stores multiple entries with correct offsets", async () => {
  const encoder = new TextEncoder();
  const blob = createZip([
    { name: "slide-01.png", data: encoder.encode("one") },
    { name: "slide-02.png", data: encoder.encode("two!") },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const firstLocal = 30 + "slide-01.png".length;
  const secondOffset = firstLocal + 3;
  assertEquals(view.getUint32(secondOffset, true), 0x04034b50);
  assertEquals(view.getUint32(secondOffset + 14, true), crc32(encoder.encode("two!")));
  const eocd = blob.size - 22;
  assertEquals(view.getUint16(eocd + 10, true), 2);
  // central directory starts right after the second payload and is recorded in EOCD
  const centralOffset = view.getUint32(eocd + 16, true);
  assertEquals(view.getUint32(centralOffset, true), 0x02014b50);
  assert(centralOffset > secondOffset);
});
