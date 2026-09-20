import { assertEquals } from "./assert.ts";
import { sniffImage } from "../src/images.ts";
import { makeGif, makeJpeg, makePng, makeWebpVp8x } from "./helpers.ts";

Deno.test("sniffImage reads PNG dimensions", () => {
  const result = sniffImage(makePng(1920, 1080));
  assertEquals(result, { type: "image/png", width: 1920, height: 1080 });
});

Deno.test("sniffImage reads GIF dimensions", () => {
  assertEquals(sniffImage(makeGif(640, 480)), { type: "image/gif", width: 640, height: 480 });
});

Deno.test("sniffImage reads JPEG dimensions", () => {
  assertEquals(sniffImage(makeJpeg(4032, 3024)), {
    type: "image/jpeg",
    width: 4032,
    height: 3024,
  });
});

Deno.test("sniffImage reads extended WebP dimensions", () => {
  assertEquals(sniffImage(makeWebpVp8x(1200, 900)), {
    type: "image/webp",
    width: 1200,
    height: 900,
  });
});

Deno.test("sniffImage rejects unknown data", () => {
  assertEquals(sniffImage(new TextEncoder().encode("not an image at all")), null);
  assertEquals(sniffImage(new Uint8Array(0)), null);
  assertEquals(sniffImage(makePng(1920, 1080).slice(0, 12)), null);
});
