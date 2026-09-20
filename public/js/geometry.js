/**
 * PostPrep layout geometry.
 *
 * Pure, DOM-free maths shared by the canvas renderer, the interactions layer,
 * the exporter and the test suite.
 *
 * Coordinate systems
 * ------------------
 * world   — the virtual arrangement plane. One slide is `FRAME` world units
 *           wide and `FRAME` units tall, so slide `i` covers
 *           x ∈ [i*FRAME, (i+1)*FRAME] and y ∈ [0, FRAME]. Content that spans a
 *           frame boundary is what makes neighbouring Instagram slides overlap.
 * screen  — canvas pixels (CSS pixels; the renderer scales by devicePixelRatio).
 *
 * An item is `{id, imageId, x, y, scale, z}` where (x, y) is the top-left corner
 * of the image in world units and `scale` multiplies the intrinsic pixel size.
 */

/** World units of one slide edge. Mirrors FRAME_SIZE in src/store.ts. */
export const FRAME = 1000;
export const MIN_SCALE = 0.01;
export const MAX_SCALE = 200;
export const MAX_FRAMES = 10;
export const FRAME_BORDER_COLOR = "#ff2d55";

/**
 * @typedef {{id: string, imageId: string, x: number, y: number, scale: number, z: number}} Item
 * @typedef {{id: string, width: number, height: number}} ImageMeta
 * @typedef {{zoom: number, panX: number, panY: number}} View
 * @typedef {{x: number, y: number, w: number, h: number}} Rect
 */

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {number} scale
 * @returns {number}
 */
export function clampScale(scale) {
  return clamp(Number.isFinite(scale) ? scale : 1, MIN_SCALE, MAX_SCALE);
}

/**
 * @param {{x: number, y: number, scale: number}} item
 * @param {ImageMeta|undefined} image
 * @returns {Rect}
 */
export function rectOf(item, image) {
  const width = (image?.width ?? 0) * item.scale;
  const height = (image?.height ?? 0) * item.scale;
  return { x: item.x, y: item.y, w: width, h: height };
}

/**
 * @param {ImageMeta[]} images
 * @returns {Map<string, ImageMeta>}
 */
export function imageLookup(images) {
  const map = new Map();
  for (const image of images) map.set(image.id, image);
  return map;
}

/**
 * @param {Item[]} items
 * @returns {Item[]}
 */
export function zSorted(items) {
  return [...items].sort((a, b) => a.z - b.z);
}

/**
 * @param {Item[]} items
 * @returns {number}
 */
export function topZ(items) {
  return items.reduce((max, item) => Math.max(max, item.z), -1);
}

/**
 * @param {Rect} rect
 * @param {{x: number, y: number}} point
 * @returns {boolean}
 */
export function rectContains(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h;
}

/**
 * Bounding box of every placed image, in world units.
 * @param {Item[]} items
 * @param {ImageMeta[]|Map<string, ImageMeta>} images
 * @param {number} [frame]
 * @returns {Rect}
 */
export function contentBounds(items, images, frame = FRAME) {
  const lookup = images instanceof Map ? images : imageLookup(images);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    const image = lookup.get(item.imageId);
    if (!image) continue;
    const rect = rectOf(item, image);
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: frame, h: frame };
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/**
 * Number of 1:1 slides needed to show everything the user has placed.
 * @param {Item[]} items
 * @param {ImageMeta[]|Map<string, ImageMeta>} images
 * @param {number} [frame]
 * @param {number} [maxFrames]
 * @returns {number}
 */
export function autoFrameCount(items, images, frame = FRAME, maxFrames = MAX_FRAMES) {
  const lookup = images instanceof Map ? images : imageLookup(images);
  let maxX = 0;
  for (const item of items) {
    const image = lookup.get(item.imageId);
    if (!image) continue;
    maxX = Math.max(maxX, item.x + image.width * item.scale);
  }
  return clamp(Math.ceil(maxX / frame - 1e-6), 1, maxFrames);
}

/**
 * @param {number} frames
 * @param {number} [frame]
 * @returns {Rect}
 */
export function stripBounds(frames, frame = FRAME) {
  return { x: 0, y: 0, w: Math.max(1, frames) * frame, h: frame };
}

/**
 * Ids of the images that spill outside the exported slide area.
 * @param {Item[]} items
 * @param {ImageMeta[]|Map<string, ImageMeta>} images
 * @param {number} frames
 * @param {number} [frame]
 * @returns {string[]}
 */
export function itemsOutsideStrip(items, images, frames, frame = FRAME) {
  const lookup = images instanceof Map ? images : imageLookup(images);
  const strip = stripBounds(frames, frame);
  const overflowing = [];
  for (const item of items) {
    const image = lookup.get(item.imageId);
    if (!image) continue;
    const rect = rectOf(item, image);
    const outside = rect.x < -0.5 || rect.y < -0.5 ||
      rect.x + rect.w > strip.w + 0.5 || rect.y + rect.h > strip.h + 0.5;
    if (outside) overflowing.push(item.id);
  }
  return overflowing;
}

/* ------------------------------------------------------------------ scales */

/**
 * @param {ImageMeta} image
 * @param {number} [frame]
 * @returns {number}
 */
export function scaleToHeight(image, frame = FRAME) {
  return clampScale(frame / image.height);
}

/**
 * @param {ImageMeta} image
 * @param {number} [frame]
 * @returns {number}
 */
export function scaleToWidth(image, frame = FRAME) {
  return clampScale(frame / image.width);
}

/**
 * Scale so the image covers the whole slide (may crop).
 * @param {ImageMeta} image
 * @param {number} [frame]
 * @returns {number}
 */
export function scaleToCover(image, frame = FRAME) {
  return clampScale(Math.max(frame / image.width, frame / image.height));
}

/**
 * Scale so the image fits entirely inside the slide.
 * @param {ImageMeta} image
 * @param {number} [frame]
 * @returns {number}
 */
export function scaleToFit(image, frame = FRAME) {
  return clampScale(Math.min(frame / image.width, frame / image.height));
}

/* --------------------------------------------------------------- arranging */

/**
 * Build the initial arrangement.
 *
 * mode "strip"  — images side by side, each overlapping the previous one by
 *                 `overlap` of a slide ("a slight x offset").
 * mode "cascade" — every image near the origin with a small diagonal offset.
 * mode "slides"  — one image per slide, scaled to cover.
 *
 * @param {ImageMeta[]} images
 * @param {{frame?: number, overlap?: number, mode?: "strip"|"cascade"|"slides", startZ?: number, makeId?: () => string}} [options]
 * @returns {Item[]}
 */
export function arrange(images, options = {}) {
  const frame = options.frame ?? FRAME;
  const overlap = clamp(options.overlap ?? 0.15, 0, 0.9);
  const mode = options.mode ?? "strip";
  const startZ = options.startZ ?? 0;
  const makeId = options.makeId ?? (() => `itm_${Math.random().toString(36).slice(2, 10)}`);
  /** @type {Item[]} */
  const items = [];
  if (images.length === 0) return items;

  if (mode === "slides") {
    images.forEach((image, index) => {
      const scale = scaleToCover(image, frame);
      items.push({
        id: makeId(),
        imageId: image.id,
        x: index * frame + (frame - image.width * scale) / 2,
        y: (frame - image.height * scale) / 2,
        scale,
        z: startZ + index,
      });
    });
    return items;
  }

  if (mode === "cascade") {
    const stepX = frame * 0.12;
    const stepY = frame * 0.05;
    images.forEach((image, index) => {
      const scale = scaleToHeight(image, frame);
      items.push({
        id: makeId(),
        imageId: image.id,
        x: index * stepX,
        y: index * stepY,
        scale,
        z: startZ + index,
      });
    });
    return items;
  }

  // "strip": filmstrip with a configurable overlap.
  let cursor = 0;
  images.forEach((image, index) => {
    const scale = scaleToHeight(image, frame);
    items.push({
      id: makeId(),
      imageId: image.id,
      x: cursor,
      y: 0,
      scale,
      z: startZ + index,
    });
    cursor += image.width * scale - overlap * frame;
  });
  return items;
}

/* ------------------------------------------------------------------- views */

/**
 * Fit a world rectangle into the viewport.
 * `extraWidth` reserves screen pixels (used for the slide gap preview).
 */
/**
 * @param {number} viewW
 * @param {number} viewH
 * @param {Rect} world
 * @param {number} [padding]
 * @param {number} [extraWidth]
 * @returns {View}
 */
export function fitView(viewW, viewH, world, padding = 40, extraWidth = 0) {
  const availableW = Math.max(40, viewW - padding * 2 - extraWidth);
  const availableH = Math.max(40, viewH - padding * 2);
  const zoom = clamp(Math.min(availableW / world.w, availableH / world.h), 0.01, 8);
  return {
    zoom,
    panX: viewW / 2 - (world.x + world.w / 2) * zoom,
    panY: viewH / 2 - (world.y + world.h / 2) * zoom,
  };
}

/**
 * @param {View} view
 * @param {{x: number, y: number}} point
 * @returns {{x: number, y: number}}
 */
export function worldToScreen(view, point) {
  return { x: point.x * view.zoom + view.panX, y: point.y * view.zoom + view.panY };
}

/**
 * @param {View} view
 * @param {{x: number, y: number}} point
 * @returns {{x: number, y: number}}
 */
export function screenToWorld(view, point) {
  return { x: (point.x - view.panX) / view.zoom, y: (point.y - view.panY) / view.zoom };
}

/**
 * @param {View} view
 * @param {number} factor
 * @param {{x: number, y: number}} anchor
 * @returns {View}
 */
export function zoomAt(view, factor, anchor) {
  const zoom = clamp(view.zoom * factor, 0.02, 16);
  const world = screenToWorld(view, anchor);
  return {
    zoom,
    panX: anchor.x - world.x * zoom,
    panY: anchor.y - world.y * zoom,
  };
}

/**
 * Screen rectangles of the slides. `gap` (screen px) separates the slides so the
 * user can preview them the way Instagram's carousel shows them.
 * @param {View} view
 * @param {number} frames
 * @param {number} [frame]
 * @param {number} [gap]
 * @returns {{index: number, x: number, y: number, size: number}[]}
 */
export function frameRects(view, frames, frame = FRAME, gap = 0) {
  const size = frame * view.zoom;
  const originX = worldToScreen(view, { x: 0, y: 0 }).x;
  const originY = worldToScreen(view, { x: 0, y: 0 }).y;
  const rects = [];
  for (let index = 0; index < frames; index++) {
    rects.push({ index, x: originX + index * (size + gap), y: originY, size });
  }
  return rects;
}

/* ------------------------------------------------------------- hit testing */

/**
 * Topmost item under a world point, or null.
 * @param {Item[]} items
 * @param {ImageMeta[]|Map<string, ImageMeta>} images
 * @param {{x: number, y: number}} point
 * @returns {Item|null}
 */
export function hitTest(items, images, point) {
  const lookup = images instanceof Map ? images : imageLookup(images);
  const ordered = zSorted(items);
  for (let index = ordered.length - 1; index >= 0; index--) {
    const item = ordered[index];
    const image = lookup.get(item.imageId);
    if (!image) continue;
    if (rectContains(rectOf(item, image), point)) return item;
  }
  return null;
}

/**
 * @param {Item} item
 * @param {ImageMeta} image
 * @param {View} view
 * @returns {Record<"nw"|"ne"|"sw"|"se", {x: number, y: number}> & {anchor: Record<"nw"|"ne"|"sw"|"se", {x: number, y: number}>}}
 */
export function handlePositions(item, image, view) {
  const rect = rectOf(item, image);
  const corners = {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.w, y: rect.y },
    sw: { x: rect.x, y: rect.y + rect.h },
    se: { x: rect.x + rect.w, y: rect.y + rect.h },
  };
  return {
    nw: worldToScreen(view, corners.nw),
    ne: worldToScreen(view, corners.ne),
    sw: worldToScreen(view, corners.sw),
    se: worldToScreen(view, corners.se),
    anchor: {
      nw: worldToScreen(view, corners.se),
      ne: worldToScreen(view, corners.sw),
      sw: worldToScreen(view, corners.ne),
      se: worldToScreen(view, corners.nw),
    },
  };
}

/**
 * Which resize handle (if any) is under a screen point.
 * @param {Item} item
 * @param {ImageMeta} image
 * @param {View} view
 * @param {{x: number, y: number}} point
 * @param {number} [radius]
 * @returns {"nw"|"ne"|"sw"|"se"|null}
 */
export function handleAt(item, image, view, point, radius = 11) {
  const positions = handlePositions(item, image, view);
  for (const handle of ["nw", "ne", "sw", "se"]) {
    const corner = positions[handle];
    if (Math.hypot(corner.x - point.x, corner.y - point.y) <= radius) return handle;
  }
  return null;
}

/**
 * The corner of the item that stays put while `handle` is dragged.
 * @param {Rect} rect
 * @param {"nw"|"ne"|"sw"|"se"} handle
 * @returns {{x: number, y: number}}
 */
export function anchorFor(rect, handle) {
  switch (handle) {
    case "nw":
      return { x: rect.x + rect.w, y: rect.y + rect.h };
    case "ne":
      return { x: rect.x, y: rect.y + rect.h };
    case "sw":
      return { x: rect.x + rect.w, y: rect.y };
    default:
      return { x: rect.x, y: rect.y };
  }
}

/**
 * Placement whose `handle` corner sits at `anchor` and whose scale is `scale`.
 * @param {ImageMeta} image
 * @param {"nw"|"ne"|"sw"|"se"} handle
 * @param {{x: number, y: number}} anchor
 * @param {number} scale
 * @returns {{x: number, y: number, scale: number}}
 */
export function placementForAnchor(image, handle, anchor, scale) {
  const width = image.width * scale;
  const height = image.height * scale;
  // `anchor` is the corner opposite the dragged handle, so it stays pinned.
  switch (handle) {
    case "nw":
      return { x: anchor.x - width, y: anchor.y - height, scale };
    case "ne":
      return { x: anchor.x, y: anchor.y - height, scale };
    case "sw":
      return { x: anchor.x - width, y: anchor.y, scale };
    default:
      return { x: anchor.x, y: anchor.y, scale };
  }
}

/**
 * Proportional resize from a corner drag.
 * @param {{x: number, y: number, scale: number}} item
 * @param {ImageMeta} image
 * @param {"nw"|"ne"|"sw"|"se"} handle
 * @param {{x: number, y: number}} anchorWorld
 * @param {{x: number, y: number}} startPointerWorld
 * @param {{x: number, y: number}} pointerWorld
 * @returns {{x: number, y: number, scale: number}}
 */
export function resizeFromCorner(
  item,
  image,
  handle,
  anchorWorld,
  startPointerWorld,
  pointerWorld,
) {
  const startDistance = Math.hypot(
    startPointerWorld.x - anchorWorld.x,
    startPointerWorld.y - anchorWorld.y,
  );
  const distance = Math.hypot(pointerWorld.x - anchorWorld.x, pointerWorld.y - anchorWorld.y);
  const ratio = startDistance > 1e-6 ? distance / startDistance : 1;
  const scale = clampScale(item.scale * ratio);
  return placementForAnchor(image, handle, anchorWorld, scale);
}

/* ----------------------------------------------------------------- snapping */

/**
 * Edges that moving items like to align with: slide boundaries plus every other
 * item's edges.
 * @param {Item[]} items
 * @param {ImageMeta[]|Map<string, ImageMeta>} images
 * @param {number} frames
 * @param {number} [frame]
 * @param {string|null} [excludeId]
 * @returns {{xs: number[], ys: number[]}}
 */
export function snapTargets(items, images, frames, frame = FRAME, excludeId = null) {
  const lookup = images instanceof Map ? images : imageLookup(images);
  const xs = [];
  const ys = [];
  for (let index = 0; index <= frames; index++) xs.push(index * frame);
  xs.push(0);
  ys.push(0, frame, frame / 2);
  for (const item of items) {
    if (item.id === excludeId) continue;
    const image = lookup.get(item.imageId);
    if (!image) continue;
    const rect = rectOf(item, image);
    xs.push(rect.x, rect.x + rect.w, rect.x + rect.w / 2);
    ys.push(rect.y, rect.y + rect.h, rect.y + rect.h / 2);
  }
  return { xs: [...new Set(xs)], ys: [...new Set(ys)] };
}

/**
 * Offset that snaps a proposed rectangle to the nearest target edge.
 * @param {Rect} rect
 * @param {{xs: number[], ys: number[]}} targets
 * @param {number} threshold
 * @returns {{dx: number, dy: number, guides: {xs: number[], ys: number[]}}}
 */
export function moveWithSnap(rect, targets, threshold) {
  const guides = { xs: [], ys: [] };
  let dx = 0;
  let dy = 0;

  const xEdges = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  let bestX = threshold;
  for (const target of targets.xs) {
    for (const edge of xEdges) {
      const distance = Math.abs(edge - target);
      if (distance <= bestX) {
        bestX = distance;
        dx = target - edge;
        guides.xs = [target];
      }
    }
  }

  const yEdges = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
  let bestY = threshold;
  for (const target of targets.ys) {
    for (const edge of yEdges) {
      const distance = Math.abs(edge - target);
      if (distance <= bestY) {
        bestY = distance;
        dy = target - edge;
        guides.ys = [target];
      }
    }
  }

  return { dx, dy, guides };
}

/**
 * Centre an image inside a given slide.
 * @param {ImageMeta} image
 * @param {number} frameIndex
 * @param {number} [frame]
 * @param {number|null} [scale]
 * @returns {{x: number, y: number, scale: number}}
 */
export function centerInFrame(image, frameIndex, frame = FRAME, scale = null) {
  const effective = clampScale(scale ?? scaleToFit(image, frame));
  const width = image.width * effective;
  const height = image.height * effective;
  return {
    x: frameIndex * frame + (frame - width) / 2,
    y: (frame - height) / 2,
    scale: effective,
  };
}

/**
 * Serialise a layout for the API (numbers rounded, ordered by z).
 * @param {Item[]} items
 * @returns {Item[]}
 */
export function serializeItems(items) {
  return zSorted(items).map((item, index) => ({
    id: item.id,
    imageId: item.imageId,
    x: Math.round(item.x * 1000) / 1000,
    y: Math.round(item.y * 1000) / 1000,
    scale: Math.round(clampScale(item.scale) * 100000) / 100000,
    z: index,
  }));
}
