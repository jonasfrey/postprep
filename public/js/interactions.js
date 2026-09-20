/**
 * Pointer / wheel / drag-and-drop handling for the slide canvas.
 *
 * The controller owns no state of its own beyond the in-flight gesture; it asks
 * the host (app.js) for the current scene and reports edits back through a small
 * callback surface:
 *
 *   getView/setView, getItems, imageMap, getItem, imageFor, getSelectedItem,
 *   select, beginTransform, applyTransform, endTransform, snapTargets,
 *   isSnapEnabled, setGuides, render, setCursor, setDropActive, onFilesDropped
 */

import {
  anchorFor,
  handleAt,
  hitTest,
  moveWithSnap,
  rectOf,
  resizeFromCorner,
  screenToWorld,
  zoomAt,
} from "./geometry.js";

const HANDLE_RADIUS = 12;
const SNAP_PIXELS = 8;

export class CanvasController {
  #canvas;
  #host;
  #drag = null;
  #spaceDown = false;

  constructor(canvas, host) {
    this.#canvas = canvas;
    this.#host = host;

    canvas.addEventListener("pointerdown", (event) => this.#onPointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.#onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.#onPointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.#onPointerUp(event));
    canvas.addEventListener("wheel", (event) => this.#onWheel(event), { passive: false });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerleave", () => {
      if (!this.#drag) this.#host.setCursor("default");
    });

    const stage = canvas.parentElement ?? canvas;
    stage.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      this.#host.setDropActive(true);
    });
    stage.addEventListener("dragleave", (event) => {
      if (event.target === stage) this.#host.setDropActive(false);
    });
    stage.addEventListener("drop", (event) => {
      event.preventDefault();
      this.#host.setDropActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) this.#host.onFilesDropped(files);
    });
  }

  setSpaceDown(value) {
    this.#spaceDown = value;
    if (!this.#drag) this.#host.setCursor(value ? "grab" : "default");
  }

  get isDragging() {
    return this.#drag !== null;
  }

  #screenPoint(event) {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  #onPointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    this.#canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();

    const screen = this.#screenPoint(event);
    const view = this.#host.getView();
    const world = screenToWorld(view, screen);
    const selected = this.#host.getSelectedItem();
    const panMode = event.button === 1 || this.#spaceDown || event.altKey;

    if (!panMode && selected) {
      const image = this.#host.imageFor(selected);
      const handle = image ? handleAt(selected, image, view, screen, HANDLE_RADIUS) : null;
      if (handle) {
        const rect = rectOf(selected, image);
        this.#drag = {
          mode: "resize",
          itemId: selected.id,
          handle,
          anchorWorld: anchorFor(rect, handle),
          startWorld: world,
          original: { ...selected },
        };
        this.#host.beginTransform(selected.id);
        return;
      }
    }

    const hit = panMode ? null : hitTest(this.#host.getItems(), this.#host.imageMap(), world);
    if (hit) {
      this.#host.select(hit.id);
      const item = this.#host.getItem(hit.id) ?? hit;
      this.#drag = {
        mode: "move",
        itemId: item.id,
        startWorld: world,
        original: { ...item },
      };
      this.#host.beginTransform(item.id);
      this.#host.setCursor("move");
      return;
    }

    this.#host.select(null);
    this.#drag = {
      mode: "pan",
      startScreen: screen,
      startPan: { x: view.panX, y: view.panY },
    };
    this.#host.setCursor("grabbing");
  }

  #onPointerMove(event) {
    const screen = this.#screenPoint(event);
    const view = this.#host.getView();

    if (!this.#drag) {
      this.#updateHoverCursor(screen, view);
      return;
    }

    if (this.#drag.mode === "pan") {
      this.#host.setView({
        zoom: view.zoom,
        panX: this.#drag.startPan.x + (screen.x - this.#drag.startScreen.x),
        panY: this.#drag.startPan.y + (screen.y - this.#drag.startScreen.y),
      });
      return;
    }

    const item = this.#host.getItem(this.#drag.itemId);
    const image = item ? this.#host.imageFor(item) : null;
    if (!item || !image) return;
    const world = screenToWorld(view, screen);

    if (this.#drag.mode === "move") {
      const original = this.#drag.original;
      let dx = world.x - this.#drag.startWorld.x;
      let dy = world.y - this.#drag.startWorld.y;
      let guides = { xs: [], ys: [] };

      if (this.#host.isSnapEnabled() && !event.altKey) {
        const proposed = rectOf({ ...original, x: original.x + dx, y: original.y + dy }, image);
        const targets = this.#host.snapTargets(item.id);
        const snap = moveWithSnap(proposed, targets, SNAP_PIXELS / view.zoom);
        dx += snap.dx;
        dy += snap.dy;
        guides = snap.guides;
      }
      this.#host.applyTransform(item.id, {
        x: original.x + dx,
        y: original.y + dy,
        scale: original.scale,
      }, guides);
      return;
    }

    if (this.#drag.mode === "resize") {
      const patch = resizeFromCorner(
        this.#drag.original,
        image,
        this.#drag.handle,
        this.#drag.anchorWorld,
        this.#drag.startWorld,
        world,
      );
      this.#host.applyTransform(item.id, patch, { xs: [], ys: [] });
    }
  }

  #onPointerUp(event) {
    if (!this.#drag) return;
    const drag = this.#drag;
    this.#drag = null;
    this.#canvas.releasePointerCapture?.(event.pointerId);
    this.#host.setGuides({ xs: [], ys: [] });
    if (drag.mode !== "pan") this.#host.endTransform(drag.itemId);
    this.#host.setCursor(this.#spaceDown ? "grab" : "default");
    this.#host.render();
  }

  #onWheel(event) {
    event.preventDefault();
    const screen = this.#screenPoint(event);
    const view = this.#host.getView();

    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      this.#host.setView({ ...view, panX: view.panX - (event.deltaX || event.deltaY) });
      return;
    }
    const factor = Math.exp(-event.deltaY * 0.0018);
    this.#host.setView(zoomAt(view, factor, screen));
  }

  #updateHoverCursor(screen, view) {
    if (this.#spaceDown) {
      this.#host.setCursor("grab");
      return;
    }
    const selected = this.#host.getSelectedItem();
    if (selected) {
      const image = this.#host.imageFor(selected);
      const handle = image ? handleAt(selected, image, view, screen, HANDLE_RADIUS) : null;
      if (handle) {
        this.#host.setCursor(handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize");
        return;
      }
    }
    const world = screenToWorld(view, screen);
    const hit = hitTest(this.#host.getItems(), this.#host.imageMap(), world);
    this.#host.setCursor(hit ? "move" : "default");
  }
}
