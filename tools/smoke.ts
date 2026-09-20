// deno-lint-ignore-file no-explicit-any -- DevTools protocol payloads are untyped JSON.
/**
 * End-to-end smoke test.
 *
 *   deno task smoke
 *
 * Boots the real server on a throwaway data directory, drives the real UI in
 * headless Chrome over the DevTools protocol (create project → upload images →
 * arrange → export), then verifies the exported PNGs on the server. A screenshot
 * of the editor is written next to this script for a quick visual check.
 */

import { startServer } from "../server.ts";
import { sniffImage } from "../src/images.ts";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const DEBUG_PORT = 9333;

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

class Cdp {
  #socket: WebSocket;
  #nextId = 0;
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  errors: string[] = [];

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string);
      if (message.id) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (!pending) return;
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      this.#handleEvent(message);
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`Could not connect to ${url}`));
    });
    return new Cdp(socket);
  }

  #handleEvent(message: { method: string; params: any }): void {
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      this.errors.push(details?.exception?.description ?? details?.text ?? "unknown exception");
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      this.errors.push(
        (message.params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? "").join(" "),
      );
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.#nextId;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text ?? "evaluation failed");
    }
    return result.result.value as T;
  }

  close(): void {
    this.#socket.close();
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  return await response.json();
}

async function waitFor<T>(label: string, fn: () => Promise<T>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`${label} timed out: ${lastError}`);
}

const IN_PAGE_SCRIPT = String.raw`(async () => {
  const app = window.__postprep;
  const log = [];
  const problems = [];
  const makeImage = async (index, from, to) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 900;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 1200, 900);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1200, 900);
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.font = "bold 220px sans-serif";
    ctx.fillText(String(index + 1), 520, 520);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new File([blob], "slide-source-" + (index + 1) + ".png", { type: "image/png" });
  };
  const samplePixel = async (blob, x, y) => {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(x, y, 1, 1).data;
    return [data[0], data[1], data[2]];
  };

  try {
    const created = await app.api.createProject("Smoke test");
    await app.openProject(created.project.id);
    log.push("project " + created.project.id);

    const files = [
      await makeImage(0, "#ff2d2d", "#ffcc00"),
      await makeImage(1, "#1e90ff", "#00d4a0"),
      await makeImage(2, "#af52de", "#ff2d55"),
    ];
    await app.uploadFiles(files);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (app.state.images.length === 3 && app.state.items.length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    log.push("images " + app.state.images.length + " items " + app.state.items.length);

    app.arrange("strip");
    const frames = app.state.frames;
    const items = app.state.items.map((item) => ({ x: item.x, y: item.y, scale: item.scale, imageId: item.imageId }));
    log.push("frames " + frames);

    // Push the last photo below the slide band so part of it is not exported:
    // that off-cut region is what the crop mask talks about.
    app.state.items[2].y = 300;
    app.render();
    const overflowWarning = document.getElementById("status-warning").textContent;

    const snapshot = () =>
      JSON.stringify(
        app.state.items.map((item) => ({
          x: item.x,
          y: item.y,
          scale: item.scale,
          z: item.z,
          imageId: item.imageId,
        })),
      );
    const before = snapshot();
    await app.exportSlides();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const records = app.state.exportRecords;
    const entries = records.reduce((sum, record) => sum + record.entries.length, 0);
    log.push("exported " + entries);

    const blobs = (app.state.lastExport && app.state.lastExport.frames) || [];
    const samples = [];
    if (blobs.length > 1) {
      const second = blobs[1].blob;
      samples.push(await samplePixel(second, 40, 540));
      samples.push(await samplePixel(second, 1040, 540));
    }

    // The crop mask must live on the canvas: the stage darkens, the photos do not.
    const canvasElement = document.getElementById("canvas");
    const context = canvasElement.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const slideRects = app.geometry.frameRects(app.state.view, app.state.frames, 1000, 0);
    const brightnessAt = (cssX, cssY) => {
      const data = context.getImageData(Math.round(cssX * ratio), Math.round(cssY * ratio), 1, 1).data;
      return data[0] + data[1] + data[2];
    };
    const outsidePoint = { x: 3, y: 3 };
    const insidePoint = {
      x: slideRects[0].x + slideRects[0].size / 2,
      y: slideRects[0].y + slideRects[0].size / 2,
    };
    // Just below the slide band, where the third photo now hangs out of frame.
    const overflowPoint = {
      x: slideRects[2].x + slideRects[2].size / 2,
      y: slideRects[2].y + slideRects[2].size + 6,
    };
    const maskButton = document.getElementById("mask-toggle");
    const mask = {
      present: Boolean(maskButton),
      labelOn: maskButton ? maskButton.textContent : null,
      visibleOn: maskButton ? !document.getElementById("stage-tools").hidden : false,
      outsideWithMask: brightnessAt(outsidePoint.x, outsidePoint.y),
      insideWithMask: brightnessAt(insidePoint.x, insidePoint.y),
      overflowWithMask: brightnessAt(overflowPoint.x, overflowPoint.y),
    };
    if (maskButton) {
      maskButton.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      mask.outsideWithoutMask = brightnessAt(outsidePoint.x, outsidePoint.y);
      mask.insideWithoutMask = brightnessAt(insidePoint.x, insidePoint.y);
      mask.overflowWithoutMask = brightnessAt(overflowPoint.x, overflowPoint.y);
      mask.labelOff = maskButton.textContent;
      maskButton.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      mask.outsideAfterRestore = brightnessAt(outsidePoint.x, outsidePoint.y);
    }

    return {
      ok: true,
      log,
      problems,
      frames,
      entries,
      items,
      overflowWarning,
      itemsUnchanged: before === snapshot(),
      samples,
      mask,
      blobSizes: blobs.map((frame) => frame.blob.size),
      exportSize: app.state.project.exportSize,
      selection: app.state.selectionId,
      canvas: {
        width: document.getElementById("canvas").width,
        height: document.getElementById("canvas").height,
      },
      lastRunErrors: [],
    };
  } catch (error) {
    return { ok: false, error: String((error && error.stack) || error), log, problems };
  }
})()`;

/**
 * Opens the carousel preview and slides through it: buttons, drag-to-slide with
 * the neighbouring slide peeking in, dots, and Escape to close.
 */
const PREVIEW_SCRIPT = String.raw`(async () => {
  const app = window.__postprep;
  const errors = [];
  window.addEventListener("error", (event) => errors.push(String(event.message)));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { errors };

  const button = document.getElementById("preview-button");
  out.buttonExists = Boolean(button);
  out.buttonDisabled = button ? button.disabled : null;
  if (!button) return out;
  button.click();

  const modal = document.getElementById("preview-modal");
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!modal.hidden && document.querySelectorAll(".preview__slide").length > 0) break;
    await sleep(50);
  }

  const viewport = document.getElementById("preview-viewport");
  const track = document.getElementById("preview-track");
  const counter = document.getElementById("preview-counter");
  const slides = Array.from(document.querySelectorAll(".preview__slide"));
  const dots = Array.from(document.querySelectorAll(".preview__dot"));
  const offsetOf = () => {
    const match = /translate3d\((-?[\d.]+)px/.exec(track.style.transform || "");
    return match ? Number(match[1]) : 0;
  };

  out.modalOpen = !modal.hidden;
  out.slideCount = slides.length;
  out.dotCount = dots.length;
  out.rect = {
    width: Math.round(viewport.getBoundingClientRect().width),
    height: Math.round(viewport.getBoundingClientRect().height),
  };
  out.imageSize = slides.length ? { w: slides[0].naturalWidth, h: slides[0].naturalHeight } : null;
  out.meta = document.getElementById("preview-meta").textContent;
  out.statusHidden = document.getElementById("preview-status").hidden;
  out.counterStart = counter.textContent;
  out.offsetStart = offsetOf();

  document.querySelector("[data-action='preview-next']").click();
  await sleep(360);
  out.counterAfterNext = counter.textContent;
  out.offsetAfterNext = offsetOf();

  // Drag back half a slide: the previous slide must be visible while dragging.
  const rect = viewport.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  const pointer = (type, x) =>
    viewport.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      }),
    );
  pointer("pointerdown", rect.left + rect.width * 0.2);
  pointer("pointermove", rect.left + rect.width * 0.7);
  out.dragOffset = offsetOf();
  out.dragCounter = counter.textContent;
  out.dragActiveDot = dots.findIndex((dot) => dot.classList.contains("preview__dot--active"));
  pointer("pointerup", rect.left + rect.width * 0.7);
  await sleep(360);
  out.afterDragCounter = counter.textContent;
  out.afterDragOffset = offsetOf();
  out.activeDot = dots.findIndex((dot) => dot.classList.contains("preview__dot--active"));

  const target = dots[Math.min(2, dots.length - 1)];
  if (target) {
    target.click();
    await sleep(360);
  }
  out.counterAfterDot = counter.textContent;

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(200);
  out.closedByEscape = modal.hidden;
  out.slidesAfterClose = document.querySelectorAll(".preview__slide").length;
  return out;
})()`;

/**
 * Re-opens the preview and leaves it mid-drag so the screenshot shows the
 * neighbouring slide peeking in — the whole point of the overlap arrangement.
 */
const PREVIEW_SHOT_SCRIPT = String.raw`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  document.getElementById("preview-button").click();
  const modal = document.getElementById("preview-modal");
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!modal.hidden && document.querySelectorAll(".preview__slide").length > 0) break;
    await sleep(50);
  }
  document.querySelector("[data-action='preview-next']").click();
  await sleep(400);
  const viewport = document.getElementById("preview-viewport");
  const rect = viewport.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  const pointer = (type, x) =>
    viewport.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      }),
    );
  pointer("pointerdown", rect.left + rect.width * 0.1);
  pointer("pointermove", rect.left + rect.width * 0.55);
  await sleep(150);
  window.__releasePreviewDrag = () => {
    pointer("pointerup", rect.left + rect.width * 0.55);
    window.__postprep.actions["close-preview"]();
  };
  return true;
})()`;

/**
 * Clicks the real toolbar buttons to prove the `data-action` wiring works, and
 * that acting on an empty project degrades to a message instead of an exception.
 */
const WIRING_SCRIPT = String.raw`(async () => {
  const app = window.__postprep;
  const errors = [];
  const clicks = [];
  window.addEventListener("error", (event) => errors.push(String(event.message)));
  const click = (selector) => {
    const element = document.querySelector(selector);
    if (!element) {
      errors.push("missing " + selector);
      return;
    }
    element.click();
    clicks.push(selector);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const realPrompt = window.prompt;
  window.prompt = () => "Wiring test";
  click('[data-action="new-project"]');
  await sleep(900);
  window.prompt = realPrompt;

  const stageEmpty = document.getElementById("stage-empty");
  const stageHint = document.getElementById("stage-hint");

  click('[data-action="frames-plus"]');
  await sleep(250);
  const frames = app.state.frames;
  const autoFrames = app.state.project ? app.state.project.autoFrames : null;

  for (const selector of [
    '[data-action="frames-minus"]',
    '[data-action="zoom-in"]',
    '[data-action="zoom-out"]',
    '[data-action="zoom-fit"]',
    '[data-action="arrange-strip"]',
    '[data-action="arrange-cascade"]',
    '[data-action="arrange-slides"]',
    '[data-action="clear-canvas"]',
    '[data-action="sel-cover"]',
    '[data-action="sel-fit"]',
    '[data-action="sel-height"]',
    '[data-action="sel-center"]',
    '[data-action="sel-front"]',
    '[data-action="sel-back"]',
    '[data-action="sel-remove"]',
    '[data-action="undo"]',
    '[data-action="redo"]',
    '[data-action="export"]',
    '[data-action="download-zip"]',
    '[data-action="upload"]',
  ]) {
    click(selector);
    await sleep(30);
  }
  await sleep(400);

  return {
    clicks,
    errors,
    projectName: app.state.project ? app.state.project.name : null,
    emptyHidden: stageEmpty.hidden,
    hintHidden: stageHint.hidden,
    frames,
    autoFrames,
    zoom: app.state.view.zoom,
  };
})()`;

async function main(): Promise<void> {
  const chromePath = CHROME_CANDIDATES.find((path) => {
    try {
      return Deno.statSync(path).isFile;
    } catch {
      return false;
    }
  });
  if (!chromePath) {
    console.error("No Chrome/Chromium binary found; skipping the browser smoke test.");
    Deno.exit(0);
  }

  const dataDir = await Deno.makeTempDir({ prefix: "postprep-smoke-data-" });
  const profileDir = await Deno.makeTempDir({ prefix: "postprep-smoke-profile-" });
  const publicDir = join(import.meta.dirname!, "..", "public");
  const { store, server, ready } = startServer({ dataDir, publicDir, port: 0 });
  await store.init();
  const address = await ready;
  const appUrl = `http://127.0.0.1:${address.port}/`;
  console.log(`Server:  ${appUrl}\nData:    ${dataDir}\nChrome:  ${chromePath}\n`);

  const chrome = new Deno.Command(chromePath, {
    args: [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--window-size=1500,940",
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();

  let cdp: Cdp | null = null;
  let failures = 0;
  try {
    await waitFor("chrome devtools", async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      return await response.json();
    });

    const target = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
      method: "PUT",
    });
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");

    await cdp.send("Page.navigate", { url: appUrl });
    await waitFor("app boot", async () => {
      const ready = await cdp!.evaluate<boolean>(
        "Boolean(window.__postprep && window.__postprep.state)",
      );
      if (!ready) throw new Error("app not booted yet");
      return true;
    });

    const result = await cdp.evaluate<any>(IN_PAGE_SCRIPT);
    console.log("In-page run:");
    for (const line of result.log ?? []) console.log(`  · ${line}`);
    if (!result.ok) {
      console.error(`  ✗ in-page error: ${result.error}`);
      failures++;
    }
    check("UI flow completed without exceptions", Boolean(result.ok), result.error ?? "");

    // ---------------------------------------------------------- UI assertions
    check(
      "three images uploaded and placed",
      result.items?.length === 3,
      `items=${result.items?.length}`,
    );
    check("auto slide count grew with the content", result.frames >= 4, `frames=${result.frames}`);
    check(
      "images overlap (second starts before the first ends)",
      (result.items?.[1]?.x ?? 0) < (result.items?.[0]?.x ?? 0) + 1200,
      `x1=${Math.round(result.items?.[1]?.x ?? 0)}`,
    );
    check(
      "images are scaled to fill the slide height",
      Math.abs((result.items?.[0]?.scale ?? 0) - 1000 / 900) < 1e-6,
    );
    check("layout untouched by the export", result.itemsUnchanged === true);
    check(
      "export produced one PNG per slide",
      result.entries === result.frames,
      `${result.entries}/${result.frames}`,
    );
    check(
      "exported PNGs are not empty",
      (result.blobSizes ?? []).every((size: number) => size > 2000),
      `${result.blobSizes?.join(", ")}`,
    );
    const [left, right] = result.samples ?? [];
    check(
      "slide 2 shows two different images (overlap is cropped into the slide)",
      Boolean(left && right) &&
        (left[0] !== right[0] || left[1] !== right[1] || left[2] !== right[2]),
      `left=rgb(${left}) right=rgb(${right})`,
    );
    check("canvas is sized for the device pixel ratio", (result.canvas?.width ?? 0) > 100);

    // ------------------------------------------------------------ crop mask
    const mask = result.mask ?? {};
    check(
      "the crop mask has a remove button on the canvas overlay",
      mask.present === true && mask.visibleOn === true,
    );
    check(
      "that button reads “Remove mask” while the mask is shown",
      String(mask.labelOn).toLowerCase().includes("remove mask"),
      String(mask.labelOn),
    );
    check(
      "removing the mask brightens the stage outside the slides",
      typeof mask.outsideWithMask === "number" && mask.outsideWithoutMask > mask.outsideWithMask,
      `${mask.outsideWithMask} → ${mask.outsideWithoutMask}`,
    );
    check(
      "the mask never darkens the photos inside a slide",
      mask.insideWithMask === mask.insideWithoutMask,
      `inside ${mask.insideWithMask} vs ${mask.insideWithoutMask}`,
    );
    check(
      "off-cut content stays visible under the mask, brighter than bare stage",
      mask.overflowWithMask > mask.outsideWithMask,
      `off-cut ${mask.overflowWithMask} vs empty stage ${mask.outsideWithMask}`,
    );
    check(
      "removing the mask lights the off-cut content fully",
      mask.overflowWithoutMask > mask.overflowWithMask,
      `${mask.overflowWithMask} → ${mask.overflowWithoutMask}`,
    );
    check(
      "content hanging outside the slides is reported in the status bar",
      String(result.overflowWarning ?? "").includes("not exported"),
      String(result.overflowWarning),
    );
    check(
      "the same button brings the mask back",
      mask.outsideAfterRestore === mask.outsideWithMask &&
        String(mask.labelOff).toLowerCase().includes("show mask"),
      `label was “${mask.labelOff}”, brightness ${mask.outsideAfterRestore}`,
    );

    check("no console errors or page exceptions", cdp.errors.length === 0, cdp.errors.join(" | "));

    // ------------------------------------------------------- server assertions
    const projectId = (result.log ?? []).find((line: string) => line.startsWith("project "))?.slice(
      8,
    );
    const records = await store.listExports(projectId);
    check("server stored one export record", records.length === 1, `records=${records.length}`);
    const entries = records[0]?.entries ?? [];
    check(
      "server stored every slide",
      entries.length === result.frames,
      `${entries.length}/${result.frames}`,
    );

    const sizes = new Set<string>();
    const checksums = new Set<string>();
    for (const entry of entries) {
      const path = await store.exportPath(projectId, entry.file);
      const bytes = await Deno.readFile(path);
      const sniffed = sniffImage(bytes);
      sizes.add(`${sniffed?.width}x${sniffed?.height}:${sniffed?.type}`);
      checksums.add(String(entry.bytes));
    }
    check(
      "every exported file is a 1080×1080 PNG",
      sizes.size === 1 && sizes.has("1080x1080:image/png"),
      [...sizes].join(", "),
    );
    check(
      "slides are distinct images",
      checksums.size === result.frames,
      `${checksums.size} distinct`,
    );

    const project = await store.get(projectId);
    check(
      "project.json kept the layout metadata",
      project.imageCount === 3 && project.autoFrames === true,
    );

    // ------------------------------------------------------------- screenshot
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const screenshotPath = join(import.meta.dirname!, "smoke-screenshot.png");
    await Deno.writeFile(
      screenshotPath,
      Uint8Array.from(atob(screenshot.data), (char) => char.charCodeAt(0)),
    );
    console.log(`\nScreenshot: ${screenshotPath}`);

    // ------------------------------------------------------ carousel preview
    const carousel = await cdp.evaluate<any>(PREVIEW_SCRIPT);
    const total = result.frames;
    check(
      "the Preview button is enabled once something is on the canvas",
      carousel.buttonExists === true && carousel.buttonDisabled === false,
    );
    check(
      "the preview opens a 1:1 box with one rendered slide per slide",
      carousel.modalOpen === true && carousel.slideCount === total &&
        Math.abs(carousel.rect.width - carousel.rect.height) <= 1,
      `${carousel.rect?.width}×${carousel.rect?.height} with ${carousel.slideCount}/${total} slides`,
    );
    check(
      "preview slides are rendered at the export size",
      carousel.imageSize?.w === 1080 && carousel.imageSize?.h === 1080,
      `${carousel.imageSize?.w}×${carousel.imageSize?.h}`,
    );
    check(
      "the arrows move to the next slide",
      carousel.counterAfterNext === `2 / ${total}` &&
        carousel.offsetAfterNext < carousel.offsetStart - 1,
      `${carousel.counterAfterNext} at ${carousel.offsetAfterNext}px`,
    );
    check(
      "dragging reveals the neighbouring slide while the finger is down",
      carousel.dragOffset > carousel.offsetAfterNext && carousel.dragOffset < 0,
      `partially dragged to ${carousel.dragOffset}px (from ${carousel.offsetAfterNext}px)`,
    );
    check(
      "the counter and dots stay on the settled slide while dragging",
      carousel.dragCounter === `2 / ${total}` && carousel.dragActiveDot === 1,
      `counter ${carousel.dragCounter}, dot ${carousel.dragActiveDot}`,
    );
    check(
      "releasing snaps to a slide",
      carousel.afterDragCounter === `1 / ${total}` && Math.abs(carousel.afterDragOffset) < 1,
      `${carousel.afterDragCounter} at ${carousel.afterDragOffset}px`,
    );
    check(
      "dots mirror the slide count and jump to a slide",
      carousel.dotCount === total && carousel.activeDot === 0 &&
        carousel.counterAfterDot === `3 / ${total}`,
      `${carousel.dotCount} dots, active ${carousel.activeDot}, then ${carousel.counterAfterDot}`,
    );
    check(
      "Escape closes the preview and drops its slides",
      carousel.closedByEscape === true && carousel.slidesAfterClose === 0,
    );
    check(
      "the preview raised no errors",
      carousel.errors.length === 0,
      carousel.errors.join(" | "),
    );

    // Screenshot the preview mid-swipe, with the neighbouring slide peeking in.
    await cdp.evaluate<any>(PREVIEW_SHOT_SCRIPT);
    const previewShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const previewShotPath = join(import.meta.dirname!, "smoke-preview.png");
    await Deno.writeFile(
      previewShotPath,
      Uint8Array.from(atob(previewShot.data), (char) => char.charCodeAt(0)),
    );
    await cdp.evaluate<any>("(window.__releasePreviewDrag(), true)");
    await new Promise((resolve) => setTimeout(resolve, 250));
    check(
      "the preview snapshot was taken mid-swipe",
      (await Deno.stat(previewShotPath)).size > 10_000,
      previewShotPath,
    );

    // ------------------------------------------------- toolbar wiring (clicks)
    const wiring = await cdp.evaluate<any>(WIRING_SCRIPT);
    check(
      "“New project” button creates and opens a project",
      wiring.projectName === "Wiring test",
      String(wiring.projectName),
    );
    check(
      "an empty project shows the drop hint instead of the splash",
      wiring.emptyHidden === true && wiring.hintHidden === false,
      `empty=${wiring.emptyHidden} hint=${wiring.hintHidden}`,
    );
    check(
      "the slides button switches to a manual slide count",
      wiring.frames === 2 && wiring.autoFrames === false,
      `frames=${wiring.frames}`,
    );
    check(
      "zoom buttons keep the view sane",
      Number.isFinite(wiring.zoom) && wiring.zoom > 0.02,
      `zoom=${wiring.zoom}`,
    );
    check(
      "clicking every toolbar action raised no errors",
      wiring.errors.length === 0,
      wiring.errors.join(" | "),
    );
  } catch (error) {
    console.error(`\nSmoke test crashed: ${error instanceof Error ? error.message : error}`);
    if (cdp?.errors.length) {
      console.error("Page errors:");
      for (const message of cdp.errors) console.error(`  ! ${message}`);
    }
    failures++;
  } finally {
    cdp?.close();
    try {
      chrome.kill("SIGKILL");
    } catch {
      // already gone
    }
    await chrome.status;
    await server.shutdown();
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    await Deno.remove(profileDir, { recursive: true }).catch(() => {});
  }

  const failed = checks.filter((entry) => !entry.ok).length + failures;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  Deno.exit(failed === 0 ? 0 : 1);
}

await main();
