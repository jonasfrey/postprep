/**
 * Instagram-style carousel preview.
 *
 * Opens a modal with a 1:1 viewport and the *actually rendered* slides (the same
 * frames the export produces), then lets the user slide through them the way a
 * post's gallery behaves — dragging reveals the neighbouring slide, which is
 * exactly the effect the overlapping arrangement is for.
 *
 * The module owns the DOM behaviour and the object-URL lifecycle; the app hands
 * it a `render` callback that produces one blob per slide.
 */

const SWIPE_RATIO = 0.18;
const WHEEL_COOLDOWN_MS = 220;

export class CarouselPreview {
  #modal;
  #viewport;
  #track;
  #dots;
  #counter;
  #meta;
  #status;
  #frames = [];
  #urls = [];
  #size = 0;
  #index = 0;
  #open = false;
  #drag = null;
  #wheelStamp = 0;
  #onClose;

  constructor(elements, options = {}) {
    this.#modal = elements.modal;
    this.#viewport = elements.viewport;
    this.#track = elements.track;
    this.#dots = elements.dots;
    this.#counter = elements.counter;
    this.#meta = elements.meta;
    this.#status = elements.status;
    this.#onClose = options.onClose;

    this.#viewport.addEventListener("pointerdown", (event) => this.#onPointerDown(event));
    this.#viewport.addEventListener("pointermove", (event) => this.#onPointerMove(event));
    this.#viewport.addEventListener("pointerup", (event) => this.#onPointerUp(event));
    this.#viewport.addEventListener("pointercancel", (event) => this.#onPointerUp(event));
    this.#viewport.addEventListener("wheel", (event) => this.#onWheel(event), { passive: false });
    window.addEventListener("keydown", (event) => this.#onKeyDown(event));
    window.addEventListener("resize", () => {
      if (this.#open) this.#apply(false);
    });
  }

  get isOpen() {
    return this.#open;
  }

  get count() {
    return this.#frames.length;
  }

  get index() {
    return this.#index;
  }

  /**
   * @param {{render: (onProgress?: (done: number, total: number) => void) => Promise<{frames: {blob: Blob, width: number, height: number}[], size: number}>}} options
   */
  async open({ render }) {
    if (this.#open) return;
    this.#open = true;
    this.#modal.hidden = false;
    this.#reset();
    this.#setStatus("Rendering slides…");

    try {
      const { frames, size } = await render((done, total) => {
        this.#setStatus(`Rendering slide ${done} of ${total}…`);
      });
      if (!this.#open) return;
      this.#frames = frames;
      this.#size = size;
      this.#urls = frames.map((frame) => URL.createObjectURL(frame.blob));
      this.#buildTrack();
      this.#setStatus("");
      this.goTo(0, { animate: false });
      this.#viewport.focus({ preventScroll: true });
    } catch (error) {
      this.#setStatus(`Could not build the preview: ${error.message ?? error}`);
    }
  }

  close() {
    if (!this.#open) return;
    this.#open = false;
    this.#modal.hidden = true;
    this.#drag = null;
    this.#reset();
    this.#onClose?.();
  }

  goTo(index, { animate = true } = {}) {
    if (this.#frames.length === 0) return;
    this.#index = Math.min(this.#frames.length - 1, Math.max(0, index));
    this.#apply(animate);
  }

  next() {
    this.goTo(this.#index + 1);
  }

  prev() {
    this.goTo(this.#index - 1);
  }

  /* --------------------------------------------------------------- internals */

  #reset() {
    for (const url of this.#urls) URL.revokeObjectURL(url);
    this.#urls = [];
    this.#frames = [];
    this.#track.replaceChildren();
    this.#dots.replaceChildren();
    this.#track.style.transition = "none";
    this.#track.style.transform = "translate3d(0, 0, 0)";
    this.#index = 0;
    this.#writeLabels();
  }

  #setStatus(text) {
    this.#status.textContent = text;
    this.#status.hidden = text.length === 0;
  }

  #buildTrack() {
    this.#track.replaceChildren();
    this.#dots.replaceChildren();
    this.#frames.forEach((frame, index) => {
      const image = document.createElement("img");
      image.className = "preview__slide";
      image.src = this.#urls[index];
      image.alt = `Slide ${index + 1} of ${this.#frames.length}`;
      image.draggable = false;
      image.width = frame.width;
      image.height = frame.height;
      this.#track.append(image);

      const dot = document.createElement("button");
      dot.className = "preview__dot";
      dot.type = "button";
      dot.dataset.action = "preview-goto";
      dot.dataset.index = String(index);
      dot.title = `Slide ${index + 1}`;
      dot.setAttribute("aria-label", `Slide ${index + 1}`);
      this.#dots.append(dot);
    });
    this.#meta.textContent = `${this.#frames.length} slide${
      this.#frames.length === 1 ? "" : "s"
    } · ${this.#size}×${this.#size} px`;
  }

  #apply(animate) {
    const width = this.#viewport.clientWidth || 1;
    this.#track.style.transition = animate ? "transform 260ms cubic-bezier(.22,.61,.36,1)" : "none";
    this.#track.style.transform = `translate3d(${-this.#index * width}px, 0, 0)`;
    this.#writeLabels();
  }

  #setOffset(offset) {
    this.#track.style.transition = "none";
    this.#track.style.transform = `translate3d(${offset}px, 0, 0)`;
  }

  #writeLabels() {
    const total = Math.max(1, this.#frames.length);
    this.#counter.textContent = `${this.#index + 1} / ${total}`;
    this.#counter.hidden = this.#frames.length === 0;
    for (const [position, dot] of Array.from(this.#dots.children).entries()) {
      dot.classList.toggle("preview__dot--active", position === this.#index);
      dot.setAttribute("aria-current", position === this.#index ? "true" : "false");
    }
    for (const button of this.#modal.querySelectorAll("[data-action='preview-prev']")) {
      button.disabled = this.#index === 0;
    }
    for (const button of this.#modal.querySelectorAll("[data-action='preview-next']")) {
      button.disabled = this.#index >= this.#frames.length - 1;
    }
  }

  #onPointerDown(event) {
    if (!this.#open || event.button !== 0 || this.#frames.length < 2) return;
    // Synthetic events (tests) have no active pointer, so capture may fail.
    try {
      this.#viewport.setPointerCapture(event.pointerId);
    } catch {
      // not fatal: the move/up listeners are on the viewport itself
    }
    this.#drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: -this.#index * (this.#viewport.clientWidth || 1),
      dx: 0,
      dy: 0,
    };
  }

  #onPointerMove(event) {
    const drag = this.#drag;
    if (!this.#open || !drag || event.pointerId !== drag.id) return;
    const width = this.#viewport.clientWidth || 1;
    drag.dx = event.clientX - drag.startX;
    drag.dy = event.clientY - drag.startY;
    const minimum = -(this.#frames.length - 1) * width;
    let offset = drag.base + drag.dx;
    if (offset > 0) offset *= 0.35; // rubber band at the first slide
    if (offset < minimum) offset = minimum + (offset - minimum) * 0.35; // …and the last
    this.#setOffset(offset);
  }

  #onPointerUp(event) {
    const drag = this.#drag;
    if (!this.#open || !drag || event.pointerId !== drag.id) return;
    this.#drag = null;
    try {
      this.#viewport.releasePointerCapture(event.pointerId);
    } catch {
      // never captured
    }
    const width = this.#viewport.clientWidth || 1;
    const ratio = (event.clientX - drag.startX) / width;
    let index = this.#index;
    if (Math.abs(ratio) >= SWIPE_RATIO) {
      // A flick moves at least one slide; a long drag moves as many as it covered.
      const slides = Math.max(1, Math.round(Math.abs(ratio)));
      index += ratio < 0 ? slides : -slides;
    }
    this.goTo(index);
  }

  #onWheel(event) {
    if (!this.#open || this.#frames.length < 2) return;
    event.preventDefault();
    const now = performance.now();
    if (now - this.#wheelStamp < WHEEL_COOLDOWN_MS) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(delta) < 2) return;
    this.#wheelStamp = now;
    if (delta > 0) this.next();
    else this.prev();
  }

  #onKeyDown(event) {
    if (!this.#open) return;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        this.close();
        break;
      case "ArrowRight":
        event.preventDefault();
        this.next();
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.prev();
        break;
      case "Home":
        event.preventDefault();
        this.goTo(0);
        break;
      case "End":
        event.preventDefault();
        this.goTo(this.#frames.length - 1);
        break;
      default:
        break;
    }
  }
}
