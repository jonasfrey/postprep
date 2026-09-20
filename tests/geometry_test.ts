import { assert, assertEquals } from "./assert.ts";
import {
  anchorFor,
  arrange,
  autoFrameCount,
  centerInFrame,
  fitView,
  FRAME,
  frameRects,
  handleAt,
  hitTest,
  itemsOutsideStrip,
  moveWithSnap,
  rectOf,
  resizeFromCorner,
  scaleToCover,
  scaleToFit,
  scaleToHeight,
  screenToWorld,
  serializeItems,
  snapTargets,
  worldToScreen,
  zoomAt,
} from "../public/js/geometry.js";

const landscape = { id: "img_l", width: 2000, height: 1000 };
const portrait = { id: "img_p", width: 1000, height: 2000 };
const square = { id: "img_s", width: 800, height: 800 };
const images = [landscape, portrait, square];

function makeIdFactory() {
  let counter = 0;
  return () => `itm_${++counter}`;
}

Deno.test("rectOf applies the item scale to the intrinsic size", () => {
  assertEquals(rectOf({ x: 10, y: 20, scale: 0.5 }, landscape), { x: 10, y: 20, w: 1000, h: 500 });
});

Deno.test("arrange('strip') lays images out with a slight overlap", () => {
  const items = arrange(images, { mode: "strip", overlap: 0.25, makeId: makeIdFactory() });
  assertEquals(items.length, 3);
  assertEquals(items[0].x, 0);
  assertEquals(items[0].scale, 1); // 1000 tall / 1000 intrinsic height
  // the landscape image is 2000 wide at scale 1, so the next one starts 250 units earlier
  assertEquals(items[1].x, 2000 - 250);
  assertEquals(items[1].scale, 0.5); // portrait 1000x2000 -> half scale
  // portrait is 500 wide at that scale
  assertEquals(items[2].x, items[1].x + 500 - 250);
  assertEquals(items.map((item) => item.z), [0, 1, 2]);
});

Deno.test("arrange('slides') puts one covered image per slide", () => {
  const items = arrange(images, { mode: "slides", makeId: makeIdFactory() });
  assertEquals(items.length, 3);
  assertEquals(items[0].scale, scaleToCover(landscape));
  const rect = rectOf(items[1], portrait);
  assertEquals(rect.x, FRAME + (FRAME - rect.w) / 2);
  assert(rect.w >= FRAME - 1e-9);
});

Deno.test("autoFrameCount follows the content extent, clamped to Instagram's ten slides", () => {
  assertEquals(autoFrameCount([], images), 1);
  const items = arrange(images, { mode: "slides", makeId: makeIdFactory() });
  assertEquals(autoFrameCount(items, images, FRAME), 3);
  const wide = [{ id: "a", imageId: square.id, x: 9500, y: 0, scale: 1, z: 0 }];
  assertEquals(autoFrameCount(wide, [square], FRAME), 10);
});

Deno.test("itemsOutsideStrip reports cropped content", () => {
  const items = [
    { id: "a", imageId: square.id, x: 0, y: 0, scale: 1, z: 0 },
    { id: "b", imageId: square.id, x: 1200, y: 0, scale: 1, z: 1 },
  ];
  assertEquals(itemsOutsideStrip(items, [square], 1, FRAME), ["b"]);
  assertEquals(itemsOutsideStrip(items, [square], 2, FRAME), []);
  // vertical overflow also counts
  const tall = [{ id: "c", imageId: square.id, x: 0, y: 900, scale: 1, z: 0 }];
  assertEquals(itemsOutsideStrip(tall, [square], 1, FRAME), ["c"]);
});

Deno.test("views round trip between world and screen space", () => {
  const view = { zoom: 0.4, panX: 120, panY: -30 };
  const world = { x: 640, y: 210 };
  const screen = worldToScreen(view, world);
  assertEquals(screenToWorld(view, screen), world);
});

Deno.test("fitView centres the strip and keeps it inside the viewport", () => {
  const view = fitView(1000, 600, { x: 0, y: 0, w: 3000, h: 1000 }, 40);
  const left = worldToScreen(view, { x: 0, y: 0 }).x;
  const right = worldToScreen(view, { x: 3000, y: 1000 }).x;
  assert(left >= 39 && right <= 961, `strip should fit: ${left}..${right}`);
  assert(Math.abs(left - (1000 - right)) < 0.001, "strip should be centred");
});

Deno.test("zoomAt keeps the anchor point stable", () => {
  const view = { zoom: 1, panX: 0, panY: 0 };
  const anchor = { x: 200, y: 150 };
  const before = screenToWorld(view, anchor);
  const zoomed = zoomAt(view, 2, anchor);
  const after = screenToWorld(zoomed, anchor);
  assert(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assertEquals(zoomed.zoom, 2);
});

Deno.test("frameRects places the slides next to each other, with an optional gap", () => {
  const view = { zoom: 0.5, panX: 0, panY: 0 };
  const rects = frameRects(view, 3, FRAME, 0);
  assertEquals(rects.length, 3);
  assertEquals(rects[1].x - rects[0].x, 500);
  assertEquals(rects[0].size, 500);
  const gapped = frameRects(view, 3, FRAME, 20);
  assertEquals(gapped[1].x - gapped[0].x, 520);
});

Deno.test("hitTest picks the topmost image", () => {
  const items = [
    { id: "a", imageId: square.id, x: 0, y: 0, scale: 1, z: 0 },
    { id: "b", imageId: square.id, x: 100, y: 100, scale: 1, z: 5 },
  ];
  assertEquals(hitTest(items, [square], { x: 200, y: 200 })?.id, "b");
  assertEquals(hitTest(items, [square], { x: 50, y: 50 })?.id, "a");
  assertEquals(hitTest(items, [square], { x: 5000, y: 5000 }), null);
});

Deno.test("handleAt finds the resize corners", () => {
  const view = { zoom: 1, panX: 0, panY: 0 };
  const item = { id: "a", imageId: square.id, x: 100, y: 100, scale: 1, z: 0 };
  assertEquals(handleAt(item, square, view, { x: 900, y: 900 }), "se");
  assertEquals(handleAt(item, square, view, { x: 100, y: 100 }), "nw");
  assertEquals(handleAt(item, square, view, { x: 500, y: 500 }), null);
});

Deno.test("resizing from a corner keeps the opposite corner pinned", () => {
  const item = { id: "a", imageId: square.id, x: 100, y: 100, scale: 1, z: 0 };
  const rect = rectOf(item, square);
  // Dragging the south-east handle pins the north-west corner, and vice versa.
  const anchor = anchorFor(rect, "se");
  assertEquals(anchor, { x: 100, y: 100 });
  assertEquals(anchorFor(rect, "nw"), { x: 900, y: 900 });

  const patch = resizeFromCorner(
    item,
    square,
    "se",
    anchor,
    { x: 900, y: 900 }, // grabbed the corner
    { x: 1100, y: 1100 }, // dragged outwards
  );
  assertEquals(patch.x, 100);
  assertEquals(patch.y, 100);
  assertEquals(patch.scale, 1.25);
  assertEquals(rectOf({ ...item, ...patch }, square).w, 1000);

  const northWest = anchorFor(rect, "nw");
  const nwPatch = resizeFromCorner(item, square, "nw", northWest, { x: 100, y: 100 }, {
    x: 300,
    y: 300,
  });
  assertEquals(nwPatch.x + square.width * nwPatch.scale, 900);
  assertEquals(nwPatch.y + square.height * nwPatch.scale, 900);
  assert(nwPatch.scale < 1);
});

Deno.test("moveWithSnap aligns edges to slide boundaries", () => {
  const targets = snapTargets([], [square], 2, FRAME);
  const rect = { x: 996, y: 3, w: 200, h: 200 };
  const snap = moveWithSnap(rect, targets, 8);
  assertEquals(snap.dx, 4); // left edge lands on the slide boundary at x = 1000
  assert(snap.guides.xs.includes(1000));
  assertEquals(snap.dy, -3); // top edge snaps to y = 0

  const far = moveWithSnap({ x: 400, y: 400, w: 200, h: 200 }, targets, 8);
  assertEquals(far.dx, 0);
  assertEquals(far.dy, 0);
});

Deno.test("snapTargets include other images' edges", () => {
  const items = [{ id: "a", imageId: square.id, x: 250, y: 30, scale: 1, z: 0 }];
  const targets = snapTargets(items, [square], 1, FRAME, null);
  assert(targets.xs.includes(250) && targets.xs.includes(1050) && targets.xs.includes(650));
  const withoutSelf = snapTargets(items, [square], 1, FRAME, "a");
  assertEquals(withoutSelf.xs.includes(250), false);
});

Deno.test("centreInFrame centres an image in the chosen slide", () => {
  const placement = centerInFrame(square, 2, FRAME);
  const scale = scaleToFit(square, FRAME);
  assertEquals(placement.scale, scale);
  assertEquals(placement.x + (square.width * scale) / 2, 2 * FRAME + FRAME / 2);
  assertEquals(placement.y + (square.height * scale) / 2, FRAME / 2);
});

Deno.test("scale helpers match their names", () => {
  assertEquals(scaleToHeight(landscape, FRAME), 1);
  assertEquals(scaleToFit(landscape, FRAME), 0.5);
  assertEquals(scaleToCover(landscape, FRAME), 1);
});

Deno.test("serializeItems rounds values and reindexes z", () => {
  const items = [
    { id: "a", imageId: square.id, x: 1.23456, y: 2.98765, scale: 0.12345678, z: 9 },
    { id: "b", imageId: square.id, x: 0, y: 0, scale: 1, z: -3 },
  ];
  const serialized = serializeItems(items);
  assertEquals(serialized.map((item) => item.id), ["b", "a"]);
  assertEquals(serialized.map((item) => item.z), [0, 1]);
  assertEquals(serialized[1].x, 1.235);
  assertEquals(serialized[1].y, 2.988);
  assertEquals(serialized[1].scale, 0.12346);
});
