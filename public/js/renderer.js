/**
 * Canvas renderer for the slide strip.
 *
 * Draw order (the important part):
 *
 *   1. slide backgrounds      — opaque, so the export has a defined backdrop
 *   2. the photos             — full opacity, everywhere: nothing is drawn
 *                               see-through, so overlapping images read correctly
 *   3. gap preview            — repaints each slide with its own window into the
 *                               plane when "Slide gaps" is on
 *   4. crop mask              — a single translucent layer over the whole stage
 *                               with the slide squares punched out; it belongs to
 *                               the window, not to the photos, and can be removed
 *   5. chrome                 — red slide borders, numbers, guides, selection
 */

import {
  FRAME_BORDER_COLOR,
  frameRects,
  handlePositions,
  rectOf,
  worldToScreen,
  zSorted,
} from "./geometry.js";

export const STAGE_BACKGROUND = "#0e1016";
/** Colour of the crop mask drawn over everything that is not exported. */
export const MASK_COLOR = "rgba(8, 9, 13, 0.72)";
const SELECTION_COLOR = "#4da3ff";
const GUIDE_COLOR = "#c46bff";

function crisp(value) {
  return Math.round(value) + 0.5;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} scene
 */
export function renderScene(ctx, scene) {
  const {
    width,
    height,
    dpr,
    view,
    frames,
    frame,
    background,
    items,
    getImage,
    selectionId,
    slideGaps,
    gapPx,
    guides,
    dropActive,
    maskEnabled = true,
  } = scene;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = STAGE_BACKGROUND;
  ctx.fillRect(0, 0, width, height);

  const gap = slideGaps ? gapPx : 0;
  const rects = frameRects(view, frames, frame, gap);
  const origin = worldToScreen(view, { x: 0, y: 0 });
  const zoom = view.zoom;
  const ordered = zSorted(items);
  const drawItems = () => {
    for (const item of ordered) {
      const image = getImage(item);
      if (!image) continue;
      const rect = rectOf(item, image);
      ctx.drawImage(
        image,
        origin.x + rect.x * zoom,
        origin.y + rect.y * zoom,
        rect.w * zoom,
        rect.h * zoom,
      );
    }
  };

  // 1. Opaque slide backgrounds.
  ctx.fillStyle = background;
  for (const rect of rects) ctx.fillRect(rect.x, rect.y, rect.size, rect.size);

  // 2. Every photo at full opacity, including the parts that will be cropped.
  drawItems();

  // 3. "Slide gaps" preview: each slide shows its own window into the plane.
  if (gap > 0) {
    for (const rect of rects) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.size, rect.size);
      ctx.clip();
      ctx.fillStyle = background;
      ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
      ctx.translate(rect.index * gap, 0);
      drawItems();
      ctx.restore();
    }
  }

  // 4. Crop mask: one layer over the stage, with the exported squares cut out.
  if (maskEnabled) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    for (const rect of rects) ctx.rect(rect.x, rect.y, rect.size, rect.size);
    ctx.fillStyle = MASK_COLOR;
    ctx.fill("evenodd");
    ctx.restore();
  }

  // 5. Slide chrome: a thin red border around every 1:1 box.
  ctx.save();
  ctx.strokeStyle = FRAME_BORDER_COLOR;
  ctx.lineWidth = 1;
  for (const rect of rects) {
    const left = crisp(rect.x);
    const top = crisp(rect.y);
    const right = crisp(rect.x + rect.size);
    const bottom = crisp(rect.y + rect.size);
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.stroke();
    // Emphasise the vertical edges: they mark where one slide ends.
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.stroke();
  }
  ctx.restore();

  // 6. Slide numbers.
  ctx.save();
  ctx.fillStyle = maskEnabled ? "rgba(255,255,255,0.62)" : "rgba(255,255,255,0.42)";
  ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const rect of rects) {
    if (rect.size < 26) continue;
    ctx.fillText(String(rect.index + 1), rect.x + rect.size / 2, rect.y - 6);
  }
  ctx.restore();

  // 7. Snap guides.
  if (guides && (guides.xs.length || guides.ys.length)) {
    ctx.save();
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const x of guides.xs) {
      const screenX = crisp(origin.x + x * zoom);
      ctx.beginPath();
      ctx.moveTo(screenX, 0);
      ctx.lineTo(screenX, height);
      ctx.stroke();
    }
    for (const y of guides.ys) {
      const screenY = crisp(origin.y + y * zoom);
      ctx.beginPath();
      ctx.moveTo(0, screenY);
      ctx.lineTo(width, screenY);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 8. Selection.
  const selected = ordered.find((item) => item.id === selectionId) ?? null;
  if (selected) {
    const image = getImage(selected);
    if (image) {
      const rect = rectOf(selected, image);
      const x = origin.x + rect.x * zoom;
      const y = origin.y + rect.y * zoom;
      const w = rect.w * zoom;
      const h = rect.h * zoom;

      ctx.save();
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(crisp(x), crisp(y), Math.round(w), Math.round(h));

      const positions = handlePositions(selected, image, view);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1.5;
      for (const handle of ["nw", "ne", "sw", "se"]) {
        const corner = positions[handle];
        ctx.beginPath();
        ctx.rect(corner.x - 4.5, corner.y - 4.5, 9, 9);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  if (dropActive) {
    ctx.save();
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(4, 4, width - 8, height - 8);
    ctx.restore();
  }
}
