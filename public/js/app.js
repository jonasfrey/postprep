/**
 * PostPrep — front-end application.
 *
 * Owns the editor state, talks to the JSON API, renders the project sidebar and
 * inspector panels, and drives the canvas through renderer.js / interactions.js.
 */

import * as geo from "./geometry.js";
import { api } from "./api.js";
import { renderScene } from "./renderer.js";
import { CanvasController } from "./interactions.js";
import { CarouselPreview } from "./preview.js";
import { createZip } from "./zip.js";

const FRAME = geo.FRAME;

/* ------------------------------------------------------------------- state */

const state = {
  projects: [],
  project: null,
  images: [],
  imageMap: new Map(),
  items: [],
  frames: 1,
  view: { zoom: 1, panX: 0, panY: 0 },
  selectionId: null,
  snap: true,
  slideGaps: false,
  gapPx: 14,
  /** The crop mask is a stage-level layer; the user can remove it (M). */
  mask: localStorage.getItem("postprep:mask") !== "off",
  guides: { xs: [], ys: [] },
  dropActive: false,
  history: [],
  future: [],
  metaDirty: false,
  saveState: "saved",
  busy: false,
  exportRecords: [],
  lastExport: null,
};

const imageElements = new Map();
const imagePromises = new Map();
let controller = null;
let saveTimer = 0;

/* --------------------------------------------------------------------- dom */

const dom = {};
for (
  const id of [
    "project-list",
    "projects-empty",
    "stage",
    "canvas",
    "stage-empty",
    "stage-hint",
    "stage-tools",
    "mask-toggle",
    "file-input",
    "image-list",
    "images-empty",
    "image-count",
    "layer-list",
    "layers-empty",
    "layer-count",
    "selection-empty",
    "selection-fields",
    "sel-x",
    "sel-y",
    "sel-w",
    "sel-h",
    "sel-scale",
    "sel-frame",
    "export-list",
    "export-count",
    "export-summary",
    "export-progress",
    "export-progress-bar",
    "export-button",
    "export-button-2",
    "preview-button",
    "preview-button-2",
    "preview-modal",
    "preview-viewport",
    "preview-track",
    "preview-dots",
    "preview-counter",
    "preview-meta",
    "preview-status",
    "overlap",
    "overlap-value",
    "frames",
    "frames-auto",
    "toggle-snap",
    "toggle-gaps",
    "background",
    "export-size",
    "zoom-label",
    "status-project",
    "status-frames",
    "status-zoom",
    "status-warning",
    "status-save",
    "toasts",
  ]
) {
  dom[id.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase())] = document.getElementById(id);
}
dom.undo = document.querySelector('[data-action="undo"]');
dom.redo = document.querySelector('[data-action="redo"]');

/* ----------------------------------------------------------------- helpers */

function toast(message, kind = "info") {
  const node = document.createElement("div");
  node.className = `toast${kind === "error" ? " toast--error" : kind === "ok" ? " toast--ok" : ""}`;
  node.textContent = message;
  dom.toasts.append(node);
  setTimeout(() => {
    node.style.transition = "opacity .25s ease";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 260);
  }, kind === "error" ? 6500 : 3200);
}

function slugify(value) {
  return (
    (value || "post")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "post"
  );
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function newItemId() {
  return `itm_${Math.random().toString(36).slice(2, 10)}`;
}

/** Set an input's value without disturbing the user's focus. */
function setInputValue(input, value) {
  if (!input || document.activeElement === input) return;
  const next = String(value);
  if (input.value !== next) input.value = next;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/* ------------------------------------------------------------ image loading */

function setProjectImages(images) {
  state.images = images;
  state.imageMap = new Map(images.map((image) => [image.id, image]));
  for (const id of [...imageElements.keys()]) {
    if (!state.imageMap.has(id)) imageElements.delete(id);
  }
  for (const id of [...imagePromises.keys()]) {
    if (!state.imageMap.has(id)) imagePromises.delete(id);
  }
}

function getLoadedImage(item) {
  const image = state.imageMap.get(item.imageId);
  if (!image) return null;
  const element = imageElements.get(image.id);
  return element && element.complete && element.naturalWidth > 0 ? element : null;
}

function loadImage(image) {
  if (!image || !state.project) return Promise.resolve(null);
  if (imagePromises.has(image.id)) return imagePromises.get(image.id);
  const promise = new Promise((resolve, reject) => {
    const element = new Image();
    element.decoding = "async";
    element.onload = () => {
      imageElements.set(image.id, element);
      render();
      resolve(element);
    };
    element.onerror = () => {
      imagePromises.delete(image.id);
      reject(new Error(`Could not load “${image.name}”`));
    };
    element.src = api.imageUrl(state.project.id, image.file);
  });
  imagePromises.set(image.id, promise);
  return promise;
}

function preloadImages() {
  for (const image of state.images) loadImage(image).catch(() => {});
}

/* ------------------------------------------------------------------ drawing */

function resizeCanvas() {
  const canvas = dom.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  return { width, height, dpr };
}

function render() {
  const { width, height, dpr } = resizeCanvas();
  const ctx = dom.canvas.getContext("2d");
  renderScene(ctx, {
    width,
    height,
    dpr,
    view: state.view,
    frames: state.frames,
    frame: FRAME,
    background: state.project?.background ?? "#ffffff",
    items: state.items,
    getImage: getLoadedImage,
    selectionId: state.selectionId,
    slideGaps: state.slideGaps,
    gapPx: state.gapPx,
    guides: state.guides,
    dropActive: state.dropActive,
    maskEnabled: state.mask,
  });
  updateStatus();
}

function fitViewToStrip(padding = 60) {
  const rect = dom.canvas.getBoundingClientRect();
  const extra = state.slideGaps ? Math.max(0, state.frames - 1) * state.gapPx : 0;
  state.view = geo.fitView(
    Math.max(1, rect.width),
    Math.max(1, rect.height),
    geo.stripBounds(state.frames, FRAME),
    padding,
    extra,
  );
}

function zoomBy(factor) {
  const rect = dom.canvas.getBoundingClientRect();
  state.view = geo.zoomAt(state.view, factor, { x: rect.width / 2, y: rect.height / 2 });
  render();
}

/** Show or hide the stage-level crop mask (remembered between visits). */
function toggleMask(next = !state.mask) {
  state.mask = next;
  localStorage.setItem("postprep:mask", state.mask ? "on" : "off");
  updateStatus();
  render();
}

function refreshFrames({ recompute = true } = {}) {
  if (!state.project) {
    state.frames = 1;
    return state.frames;
  }
  if (state.project.autoFrames && recompute) {
    const auto = geo.autoFrameCount(state.items, state.imageMap, FRAME, geo.MAX_FRAMES);
    if (auto !== state.frames) {
      state.frames = auto;
      state.project.frameCount = auto;
      state.metaDirty = true;
    }
    return state.frames;
  }
  state.frames = geo.clamp(Math.round(state.project.frameCount), 1, geo.MAX_FRAMES);
  return state.frames;
}

/* ----------------------------------------------------------------- history */

function snapshotItems() {
  return geo.serializeItems(state.items);
}

function pushHistory() {
  const current = JSON.stringify(snapshotItems());
  if (state.history[state.history.length - 1] === current) return;
  state.history.push(current);
  if (state.history.length > 80) state.history.shift();
  state.future.length = 0;
}

function restoreItems(serialized) {
  state.items = JSON.parse(serialized).map((item) => ({ ...item }));
  if (!state.items.some((item) => item.id === state.selectionId)) state.selectionId = null;
  refreshFrames();
  renderAll();
  scheduleSave();
}

function undo() {
  if (state.history.length === 0) return;
  state.future.push(JSON.stringify(snapshotItems()));
  restoreItems(state.history.pop());
}

function redo() {
  if (state.future.length === 0) return;
  state.history.push(JSON.stringify(snapshotItems()));
  restoreItems(state.future.pop());
}

/* ------------------------------------------------------------------ saving */

function scheduleSave() {
  if (!state.project) return;
  state.saveState = "dirty";
  updateStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 600);
}

async function saveNow() {
  if (!state.project) return;
  clearTimeout(saveTimer);
  const project = state.project;
  const metaDirty = state.metaDirty;
  state.metaDirty = false;
  state.saveState = "saving";
  updateStatus();
  try {
    if (metaDirty) {
      const { project: updated } = await api.updateProject(project.id, {
        frameCount: state.frames,
        autoFrames: project.autoFrames,
        overlap: project.overlap,
        background: project.background,
        exportSize: project.exportSize,
      });
      state.project = { ...state.project, ...updated };
    }
    await api.saveLayout(project.id, snapshotItems());
    // A newer edit may have marked the project dirty while we were saving.
    if (state.saveState === "saving") state.saveState = "saved";
  } catch (error) {
    state.saveState = "error";
    toast(`Save failed: ${error.message}`, "error");
  }
  updateStatus();
}

/* --------------------------------------------------------- project actions */

async function refreshProjects() {
  try {
    const { projects } = await api.listProjects();
    state.projects = projects;
  } catch (error) {
    toast(error.message, "error");
  }
  renderProjects();
}

async function createProject() {
  const name = window.prompt("Project name", "New carousel");
  if (name === null) return;
  try {
    const { project } = await api.createProject(name);
    await refreshProjects();
    await openProject(project.id);
    toast(`Created “${project.name}”`, "ok");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renameProject(id) {
  const project = state.projects.find((entry) => entry.id === id);
  if (!project) return;
  const name = window.prompt("Rename project", project.name);
  if (name === null || name.trim() === project.name) return;
  try {
    const { project: updated } = await api.updateProject(id, { name });
    if (state.project?.id === id) state.project = { ...state.project, ...updated };
    await refreshProjects();
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteProject(id) {
  const project = state.projects.find((entry) => entry.id === id);
  if (!project) return;
  if (!window.confirm(`Delete “${project.name}” and all of its images? This cannot be undone.`)) {
    return;
  }
  try {
    await api.deleteProject(id);
    if (state.project?.id === id) {
      state.project = null;
      state.items = [];
      setProjectImages([]);
      state.selectionId = null;
      state.exportRecords = [];
      state.history.length = 0;
      state.future.length = 0;
      localStorage.removeItem("postprep:lastProject");
    }
    await refreshProjects();
    renderAll();
    toast("Project deleted");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openProject(id) {
  if (state.busy) return;
  state.busy = true;
  try {
    const [{ project }, { layout }, exportList] = await Promise.all([
      api.getProject(id),
      api.getLayout(id),
      api.listExports(id),
    ]);
    state.project = project;
    setProjectImages(project.images);
    state.items = layout.items.filter((item) => state.imageMap.has(item.imageId));
    state.frames = project.autoFrames
      ? geo.autoFrameCount(state.items, state.imageMap, FRAME, geo.MAX_FRAMES)
      : geo.clamp(project.frameCount, 1, geo.MAX_FRAMES);
    state.selectionId = null;
    state.history.length = 0;
    state.future.length = 0;
    state.exportRecords = exportList.exports;
    state.lastExport = null;
    state.metaDirty = false;
    state.saveState = "saved";
    localStorage.setItem("postprep:lastProject", id);
    preloadImages();
    fitViewToStrip();
    renderAll();
    await refreshProjects();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.busy = false;
  }
}

/* ------------------------------------------------------------ arrangement */

function placeImageAtEnd(image) {
  const scale = geo.scaleToHeight(image, FRAME);
  const last = geo.zSorted(state.items).at(-1);
  let x = 0;
  if (last) {
    const lastImage = state.imageMap.get(last.imageId);
    if (lastImage) {
      x = last.x + lastImage.width * last.scale - (state.project?.overlap ?? 0.15) * FRAME;
    }
  }
  const item = {
    id: newItemId(),
    imageId: image.id,
    x: Math.round(x),
    y: 0,
    scale,
    z: geo.topZ(state.items) + 1,
  };
  state.items.push(item);
  return item;
}

function arrange(mode) {
  if (!state.project || state.images.length === 0) {
    toast("Upload images first", "error");
    return;
  }
  pushHistory();
  state.items = geo.arrange(state.images, {
    mode,
    frame: FRAME,
    overlap: state.project.overlap,
    makeId: newItemId,
  });
  state.selectionId = state.items[0]?.id ?? null;
  refreshFrames();
  fitViewToStrip();
  renderAll();
  scheduleSave();
}

function clearCanvas() {
  if (state.items.length === 0) return;
  pushHistory();
  state.items = [];
  state.selectionId = null;
  refreshFrames();
  renderAll();
  scheduleSave();
}

function addImageToCanvas(imageId) {
  const image = state.imageMap.get(imageId);
  if (!image) return;
  pushHistory();
  const item = placeImageAtEnd(image);
  state.selectionId = item.id;
  refreshFrames();
  renderAll();
  scheduleSave();
}

async function uploadFiles(fileList) {
  if (!state.project) {
    toast("Create or open a project first", "error");
    return;
  }
  const files = Array.from(fileList).filter(
    (file) => file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(file.name),
  );
  if (files.length === 0) {
    toast("Only PNG, JPEG, GIF and WebP images are supported", "error");
    return;
  }
  state.busy = true;
  updateStatus();
  try {
    const { project, added } = await api.uploadImages(state.project.id, files);
    state.project = { ...state.project, ...project };
    setProjectImages(project.images);
    for (const image of added) loadImage(image).catch((error) => toast(error.message, "error"));
    pushHistory();
    for (const image of added) placeImageAtEnd(image);
    refreshFrames();
    fitViewToStrip();
    renderAll();
    await refreshProjects();
    scheduleSave();
    toast(`Added ${added.length} image${added.length === 1 ? "" : "s"}`, "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.busy = false;
    updateStatus();
  }
}

async function removeImage(imageId) {
  if (!state.project) return;
  const image = state.imageMap.get(imageId);
  if (!image) return;
  if (!window.confirm(`Remove “${image.name}” from the project?`)) return;
  try {
    const { project } = await api.deleteImage(state.project.id, imageId);
    state.project = { ...state.project, ...project };
    setProjectImages(project.images);
    state.items = state.items.filter((item) => item.imageId !== imageId);
    refreshFrames();
    renderAll();
    await refreshProjects();
    scheduleSave();
  } catch (error) {
    toast(error.message, "error");
  }
}

/* -------------------------------------------------------------- selection */

function selectedItem() {
  return state.items.find((item) => item.id === state.selectionId) ?? null;
}

function selectedImage() {
  const item = selectedItem();
  return item ? state.imageMap.get(item.imageId) ?? null : null;
}

function updateSelected(patch, { withHistory = true } = {}) {
  const item = selectedItem();
  if (!item) return;
  if (withHistory) pushHistory();
  Object.assign(item, patch);
  refreshFrames();
  renderAll();
  scheduleSave();
}

function selectedSlideIndex() {
  const item = selectedItem();
  const image = selectedImage();
  if (!item || !image) return 1;
  const centre = item.x + (image.width * item.scale) / 2;
  return geo.clamp(Math.floor(centre / FRAME) + 1, 1, geo.MAX_FRAMES);
}

/* ----------------------------------------------------------------- export */

function setExportProgress(value) {
  if (value === null) {
    dom.exportProgress.hidden = true;
    dom.exportProgressBar.style.width = "0%";
    return;
  }
  dom.exportProgress.hidden = false;
  dom.exportProgressBar.style.width = `${Math.round(value * 100)}%`;
}

function renderFrameBlob(ctx, canvas, index, size, background) {
  const scale = size / FRAME;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(scale, scale);
  ctx.translate(-index * FRAME, 0);
  for (const item of geo.zSorted(state.items)) {
    const image = state.imageMap.get(item.imageId);
    const element = image ? imageElements.get(image.id) : null;
    if (!element || !element.naturalWidth) continue;
    ctx.drawImage(
      element,
      item.x,
      item.y,
      element.naturalWidth * item.scale,
      element.naturalHeight * item.scale,
    );
  }
  ctx.restore();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (
        blob,
      ) => (blob ? resolve(blob) : reject(new Error("The browser could not encode the image"))),
      "image/png",
    );
  });
}

async function exportSlides() {
  if (!state.project) {
    toast("Create or open a project first", "error");
    return;
  }
  if (state.items.length === 0) {
    toast("Place at least one image on the canvas", "error");
    return;
  }
  if (state.busy) return;

  state.busy = true;
  updateStatus();
  setExportProgress(0);
  try {
    const used = state.images.filter((image) =>
      state.items.some((item) => item.imageId === image.id)
    );
    await Promise.all(used.map((image) => loadImage(image)));

    const size = state.project.exportSize;
    const background = state.project.background;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const slug = slugify(state.project.name);
    const frames = [];

    for (let index = 0; index < state.frames; index++) {
      const blob = await renderFrameBlob(ctx, canvas, index, size, background);
      frames.push({ blob, name: `${slug}-${pad2(index + 1)}.png` });
      setExportProgress(((index + 1) / state.frames) * 0.85);
    }

    const { export: record } = await api.saveExports(state.project.id, frames, {
      exportSize: size,
      frameCount: state.frames,
    });
    state.lastExport = { record, frames };
    setExportProgress(1);
    await refreshExports();
    toast(
      `Exported ${frames.length} slide${frames.length === 1 ? "" : "s"} · ${size}×${size}px`,
      "ok",
    );
  } catch (error) {
    toast(`Export failed: ${error.message}`, "error");
  } finally {
    state.busy = false;
    updateStatus();
    setTimeout(() => setExportProgress(null), 500);
  }
}

async function refreshExports() {
  if (!state.project) {
    state.exportRecords = [];
    renderExports();
    return;
  }
  try {
    const { exports } = await api.listExports(state.project.id);
    state.exportRecords = exports;
  } catch (error) {
    toast(error.message, "error");
  }
  renderExports();
}

async function downloadZip() {
  if (!state.project) return;
  try {
    const slug = slugify(state.project.name);
    let files = null;
    if (state.lastExport) {
      files = await Promise.all(
        state.lastExport.frames.map(async (frame) => ({
          name: frame.name,
          data: new Uint8Array(await frame.blob.arrayBuffer()),
        })),
      );
    } else if (state.exportRecords.length > 0) {
      const record = state.exportRecords[0];
      files = await Promise.all(
        record.entries.map(async (entry) => {
          const response = await fetch(api.exportUrl(state.project.id, entry.file));
          if (!response.ok) throw new Error("Could not download the exported slide");
          return {
            name: `${slug}-${pad2(entry.frame)}.png`,
            data: new Uint8Array(await response.arrayBuffer()),
          };
        }),
      );
    }
    if (!files || files.length === 0) {
      toast("Export the slides first", "error");
      return;
    }
    downloadBlob(createZip(files), `${slug}-carousel.zip`);
    toast(`Packed ${files.length} slide${files.length === 1 ? "" : "s"} into a .zip`, "ok");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearExports() {
  if (!state.project) return;
  if (!window.confirm("Delete all exported files for this project?")) return;
  try {
    await api.clearExports(state.project.id);
    state.lastExport = null;
    await refreshExports();
    toast("Export history cleared");
  } catch (error) {
    toast(error.message, "error");
  }
}

/* ------------------------------------------------------- carousel preview */

const preview = new CarouselPreview({
  modal: dom.previewModal,
  viewport: dom.previewViewport,
  track: dom.previewTrack,
  dots: dom.previewDots,
  counter: dom.previewCounter,
  meta: dom.previewMeta,
  status: dom.previewStatus,
});

/** Render every slide exactly like the export does, for the preview modal. */
async function renderPreviewFrames(onProgress) {
  const used = state.images.filter((image) =>
    state.items.some((item) => item.imageId === image.id)
  );
  await Promise.all(used.map((image) => loadImage(image)));

  const size = state.project.exportSize;
  const background = state.project.background;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const frames = [];
  for (let index = 0; index < state.frames; index++) {
    onProgress?.(index + 1, state.frames);
    const blob = await renderFrameBlob(ctx, canvas, index, size, background);
    frames.push({ blob, width: size, height: size });
  }
  return { frames, size };
}

async function openPreview() {
  if (!state.project) {
    toast("Create or open a project first", "error");
    return;
  }
  if (state.items.length === 0) {
    toast("Place at least one image on the canvas", "error");
    return;
  }
  if (state.busy) return;
  await preview.open({ render: renderPreviewFrames });
}

/* --------------------------------------------------------------- rendering */

function renderProjects() {
  const list = dom.projectList;
  list.textContent = "";
  dom.projectsEmpty.hidden = state.projects.length > 0;
  for (const project of state.projects) {
    const li = document.createElement("li");
    li.className = `project${state.project?.id === project.id ? " project--active" : ""}`;
    li.dataset.action = "open-project";
    li.dataset.id = project.id;

    const main = document.createElement("div");
    main.className = "project__main";
    const name = document.createElement("span");
    name.className = "project__name";
    name.textContent = project.name;
    const meta = document.createElement("span");
    meta.className = "project__meta";
    meta.textContent = `${project.imageCount} image${
      project.imageCount === 1 ? "" : "s"
    } · ${project.frameCount} slide${project.frameCount === 1 ? "" : "s"} · ${
      formatDateTime(project.updatedAt)
    }`;
    main.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "project__actions";
    const rename = document.createElement("button");
    rename.className = "btn btn--icon btn--ghost";
    rename.title = "Rename";
    rename.textContent = "✎";
    rename.dataset.action = "rename-project";
    rename.dataset.id = project.id;
    const remove = document.createElement("button");
    remove.className = "btn btn--icon btn--ghost";
    remove.title = "Delete";
    remove.textContent = "🗑";
    remove.dataset.action = "delete-project";
    remove.dataset.id = project.id;
    actions.append(rename, remove);

    li.append(main, actions);
    list.append(li);
  }
}

function renderImages() {
  const list = dom.imageList;
  list.textContent = "";
  dom.imageCount.textContent = String(state.images.length);
  dom.imagesEmpty.hidden = state.images.length > 0;
  const placed = new Set(state.items.map((item) => item.imageId));

  for (const image of state.images) {
    const li = document.createElement("li");
    li.className = "thumb";

    const thumb = document.createElement("img");
    thumb.className = "thumb__image";
    thumb.loading = "lazy";
    thumb.alt = "";
    thumb.src = api.imageUrl(state.project.id, image.file);

    const main = document.createElement("div");
    main.className = "thumb__main";
    const name = document.createElement("span");
    name.className = "thumb__name";
    name.textContent = image.name;
    name.title = image.name;
    const meta = document.createElement("span");
    meta.className = "thumb__meta";
    meta.textContent = `${image.width}×${image.height} · ${formatBytes(image.bytes)}`;
    main.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "row";
    const add = document.createElement("button");
    add.className = "btn btn--small";
    add.textContent = placed.has(image.id) ? "Placed" : "Add";
    add.title = "Place this image on the canvas";
    add.disabled = placed.has(image.id);
    add.dataset.action = "image-add";
    add.dataset.id = image.id;
    const remove = document.createElement("button");
    remove.className = "btn btn--small btn--danger";
    remove.textContent = "✕";
    remove.title = "Remove from the project";
    remove.dataset.action = "image-remove";
    remove.dataset.id = image.id;
    actions.append(add, remove);

    li.append(thumb, main, actions);
    list.append(li);
  }
}

function renderLayers() {
  const list = dom.layerList;
  list.textContent = "";
  dom.layerCount.textContent = String(state.items.length);
  dom.layersEmpty.hidden = state.items.length > 0;
  const ordered = geo.zSorted(state.items).reverse();

  ordered.forEach((item, index) => {
    const image = state.imageMap.get(item.imageId);
    const li = document.createElement("li");
    li.className = `layer${item.id === state.selectionId ? " layer--active" : ""}`;
    li.dataset.action = "layer-select";
    li.dataset.id = item.id;

    const name = document.createElement("span");
    name.className = "layer__name";
    name.textContent = image?.name ?? "Missing image";
    name.title = name.textContent;

    const z = document.createElement("span");
    z.className = "layer__z";
    z.textContent = `#${ordered.length - index}`;

    const up = document.createElement("button");
    up.className = "btn btn--icon btn--ghost";
    up.textContent = "↑";
    up.title = "Move forward";
    up.disabled = index === 0;
    up.dataset.action = "layer-up";
    up.dataset.id = item.id;

    const down = document.createElement("button");
    down.className = "btn btn--icon btn--ghost";
    down.textContent = "↓";
    down.title = "Move backward";
    down.disabled = index === ordered.length - 1;
    down.dataset.action = "layer-down";
    down.dataset.id = item.id;

    const remove = document.createElement("button");
    remove.className = "btn btn--icon btn--ghost";
    remove.textContent = "✕";
    remove.title = "Remove from the layout";
    remove.dataset.action = "layer-remove";
    remove.dataset.id = item.id;

    li.append(name, z, up, down, remove);
    list.append(li);
  });
}

function renderSelection() {
  const item = selectedItem();
  const image = selectedImage();
  const has = Boolean(item && image);
  dom.selectionEmpty.hidden = has;
  dom.selectionFields.hidden = !has;
  if (!has) return;

  const width = Math.round(image.width * item.scale);
  const height = Math.round(image.height * item.scale);
  setInputValue(dom.selX, Math.round(item.x));
  setInputValue(dom.selY, Math.round(item.y));
  setInputValue(dom.selW, width);
  setInputValue(dom.selH, height);
  setInputValue(dom.selScale, Math.round(item.scale * 100));
  setInputValue(dom.selFrame, selectedSlideIndex());
}

function renderExports() {
  const list = dom.exportList;
  list.textContent = "";
  const total = state.exportRecords.reduce((sum, record) => sum + record.entries.length, 0);
  dom.exportCount.textContent = String(total);

  if (!state.project) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Open a project to export slides.";
    list.append(empty);
    return;
  }
  if (state.exportRecords.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No exports yet.";
    list.append(empty);
    return;
  }

  const slug = slugify(state.project.name);
  for (const record of state.exportRecords) {
    const group = document.createElement("li");
    group.className = "explorers";
    const head = document.createElement("span");
    head.className = "hint";
    head.textContent = `${
      formatDateTime(record.createdAt)
    } · ${record.entries.length} slides · ${record.exportSize}px`;
    group.append(head);

    for (const entry of record.entries) {
      const row = document.createElement("div");
      row.className = "export-item";
      const thumb = document.createElement("img");
      thumb.loading = "lazy";
      thumb.alt = "";
      thumb.src = api.exportUrl(state.project.id, entry.file);
      const link = document.createElement("a");
      link.href = api.exportUrl(state.project.id, entry.file);
      link.download = `${slug}-${pad2(entry.frame)}.png`;
      link.textContent = `Slide ${entry.frame}`;
      const meta = document.createElement("span");
      meta.className = "export-item__name";
      meta.textContent = `${entry.width}×${entry.height} · ${formatBytes(entry.bytes)}`;
      row.append(thumb, link, meta);
      group.append(row);
    }
    list.append(group);
  }
}

function updateStatus() {
  const hasProject = Boolean(state.project);
  dom.statusProject.textContent = hasProject ? state.project.name : "No project open";
  dom.statusFrames.textContent = hasProject
    ? `${state.frames} slide${state.frames === 1 ? "" : "s"}`
    : "";
  const zoomText = `${Math.round(state.view.zoom * 100)}%`;
  dom.statusZoom.textContent = hasProject ? `Zoom ${zoomText}` : "";
  dom.zoomLabel.textContent = zoomText;

  const outside = hasProject
    ? geo.itemsOutsideStrip(state.items, state.imageMap, state.frames, FRAME)
    : [];
  const outsideCount = outside.length;
  dom.statusWarning.textContent = outsideCount > 0
    ? `${outsideCount} image${outsideCount === 1 ? "" : "s"} ${
      outsideCount === 1 ? "extends" : "extend"
    } past the slides — that part is not exported`
    : "";

  dom.statusSave.textContent = !hasProject
    ? ""
    : state.saveState === "saving"
    ? "Saving…"
    : state.saveState === "dirty"
    ? "Unsaved changes"
    : state.saveState === "error"
    ? "Save failed"
    : "All changes saved";

  setInputValue(dom.frames, state.frames);
  dom.framesAuto.checked = Boolean(state.project?.autoFrames);
  const overlapPercent = Math.round((state.project?.overlap ?? 0.15) * 100);
  setInputValue(dom.overlap, overlapPercent);
  dom.overlapValue.textContent = `${overlapPercent}%`;
  if (document.activeElement !== dom.background) {
    dom.background.value = state.project?.background ?? "#ffffff";
  }
  setInputValue(dom.exportSize, String(state.project?.exportSize ?? 1080));
  dom.toggleSnap.checked = state.snap;
  dom.toggleGaps.checked = state.slideGaps;

  dom.stageEmpty.hidden = hasProject;
  dom.stageHint.hidden = !hasProject || state.images.length > 0;
  // The crop mask only makes sense once something is on the canvas.
  dom.stageTools.hidden = !hasProject || state.items.length === 0;
  dom.maskToggle.textContent = state.mask ? "Remove mask" : "Show mask";
  dom.maskToggle.classList.toggle("btn--primary", !state.mask);
  dom.maskToggle.title = state.mask
    ? "Hide the dark crop mask so the whole arrangement is fully lit (M)"
    : "Show the dark crop mask over everything outside the slides (M)";
  dom.undo.disabled = state.history.length === 0;
  dom.redo.disabled = state.future.length === 0;

  const label = `Export ${state.frames} slide${state.frames === 1 ? "" : "s"}`;
  const disabled = !hasProject || state.busy || state.items.length === 0;
  for (const button of [dom.exportButton, dom.exportButton2]) {
    button.textContent = state.busy ? "Working…" : label;
    button.disabled = disabled;
  }
  dom.previewButton.disabled = disabled;
  dom.previewButton2.disabled = disabled;
  dom.previewButton2.textContent = `Preview ${state.frames} slide${
    state.frames === 1 ? "" : "s"
  } as a carousel`;
  dom.exportSummary.textContent = hasProject
    ? `Each of the ${state.frames} red boxes becomes one ${state.project.exportSize}×${state.project.exportSize} PNG.`
    : "Everything visible in each red box is cropped into its own square image.";
}

function renderAll() {
  renderImages();
  renderLayers();
  renderSelection();
  renderExports();
  renderProjects();
  render();
}

const renderAllDebounced = (() => {
  let frame = 0;
  return () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderAll();
    });
  };
})();

/* -------------------------------------------------------------- controller */

const host = {
  getView: () => state.view,
  setView: (view) => {
    state.view = view;
    render();
  },
  getItems: () => state.items,
  imageMap: () => state.imageMap,
  getItem: (id) => state.items.find((item) => item.id === id) ?? null,
  imageFor: (item) => (item ? state.imageMap.get(item.imageId) ?? null : null),
  getSelectedItem: selectedItem,
  select: (id) => {
    state.selectionId = id;
    renderLayers();
    renderSelection();
    render();
  },
  beginTransform: () => pushHistory(),
  applyTransform: (id, patch, guides) => {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    Object.assign(item, patch);
    state.guides = guides ?? { xs: [], ys: [] };
    renderSelection();
    render();
  },
  endTransform: () => {
    state.guides = { xs: [], ys: [] };
    refreshFrames();
    renderAll();
    scheduleSave();
  },
  snapTargets: (excludeId) =>
    geo.snapTargets(state.items, state.imageMap, state.frames, FRAME, excludeId),
  isSnapEnabled: () => state.snap,
  setGuides: (guides) => {
    state.guides = guides;
  },
  render,
  setCursor: (cursor) => {
    dom.canvas.style.cursor = cursor;
  },
  setDropActive: (active) => {
    state.dropActive = active;
    render();
  },
  onFilesDropped: (files) => uploadFiles(files),
};

/* ---------------------------------------------------------------- actions */

function moveLayer(itemId, direction) {
  const ordered = geo.zSorted(state.items);
  const index = ordered.findIndex((item) => item.id === itemId);
  if (index === -1) return;
  const target = index + direction;
  if (target < 0 || target >= ordered.length) return;
  pushHistory();
  const [moved] = ordered.splice(index, 1);
  ordered.splice(target, 0, moved);
  ordered.forEach((item, position) => {
    item.z = position;
  });
  renderAll();
  scheduleSave();
}

function removeItem(itemId) {
  const index = state.items.findIndex((item) => item.id === itemId);
  if (index === -1) return;
  pushHistory();
  state.items.splice(index, 1);
  if (state.selectionId === itemId) state.selectionId = null;
  refreshFrames();
  renderAll();
  scheduleSave();
}

function setFrames(next, { manual = true } = {}) {
  if (!state.project) return;
  const clamped = geo.clamp(Math.round(next), 1, geo.MAX_FRAMES);
  if (manual) state.project.autoFrames = false;
  state.project.frameCount = clamped;
  state.frames = clamped;
  state.metaDirty = true;
  renderAll();
  scheduleSave();
}

function toggleAutoFrames(enabled) {
  if (!state.project) return;
  state.project.autoFrames = enabled;
  state.metaDirty = true;
  if (enabled) refreshFrames();
  fitViewToStrip();
  renderAll();
  scheduleSave();
}

const actions = {
  "new-project": () => createProject(),
  "open-project": (id) => openProject(id),
  "rename-project": (id) => renameProject(id),
  "delete-project": (id) => deleteProject(id),
  upload: () => dom.fileInput.click(),
  "arrange-strip": () => arrange("strip"),
  "arrange-cascade": () => arrange("cascade"),
  "arrange-slides": () => arrange("slides"),
  "clear-canvas": () => clearCanvas(),
  "frames-minus": () => setFrames(state.frames - 1),
  "frames-plus": () => setFrames(state.frames + 1),
  "zoom-in": () => zoomBy(1.25),
  "zoom-out": () => zoomBy(1 / 1.25),
  "zoom-fit": () => {
    fitViewToStrip();
    render();
  },
  "toggle-mask": () => toggleMask(),
  undo: () => undo(),
  redo: () => redo(),
  export: () => exportSlides(),
  preview: () => openPreview(),
  "close-preview": () => preview.close(),
  "preview-prev": () => preview.prev(),
  "preview-next": () => preview.next(),
  "preview-first": () => preview.goTo(0),
  "preview-goto": (_id, trigger) => preview.goTo(Number(trigger?.dataset.index ?? 0)),
  "download-zip": () => downloadZip(),
  "clear-exports": () => clearExports(),
  "sel-cover": () => {
    const image = selectedImage();
    if (image) updateSelected({ scale: geo.scaleToCover(image, FRAME) });
  },
  "sel-fit": () => {
    const image = selectedImage();
    if (image) updateSelected({ scale: geo.scaleToFit(image, FRAME) });
  },
  "sel-height": () => {
    const image = selectedImage();
    if (image) updateSelected({ scale: geo.scaleToHeight(image, FRAME) });
  },
  "sel-center": () => {
    const image = selectedImage();
    const item = selectedItem();
    if (image && item) {
      updateSelected(geo.centerInFrame(image, selectedSlideIndex() - 1, FRAME, item.scale));
    }
  },
  "sel-front": () => {
    const item = selectedItem();
    if (item) moveLayer(item.id, state.items.length);
  },
  "sel-back": () => {
    const item = selectedItem();
    if (item) moveLayer(item.id, -state.items.length);
  },
  "sel-remove": () => {
    const item = selectedItem();
    if (item) removeItem(item.id);
  },
  "image-add": (id) => addImageToCanvas(id),
  "image-remove": (id) => removeImage(id),
  "layer-select": (id) => host.select(id),
  "layer-up": (id) => moveLayer(id, 1),
  "layer-down": (id) => moveLayer(id, -1),
  "layer-remove": (id) => removeItem(id),
};

/* ----------------------------------------------------------------- events */

function attachEvents() {
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    const handler = actions[trigger.dataset.action];
    if (!handler) return;
    event.preventDefault();
    event.stopPropagation();
    handler(trigger.dataset.id, trigger);
  });

  dom.fileInput.addEventListener("change", () => {
    const files = Array.from(dom.fileInput.files ?? []);
    dom.fileInput.value = "";
    if (files.length) uploadFiles(files);
  });

  dom.frames.addEventListener("change", () => setFrames(Number(dom.frames.value) || 1));
  dom.framesAuto.addEventListener("change", () => toggleAutoFrames(dom.framesAuto.checked));

  dom.overlap.addEventListener("input", () => {
    const percent = Number(dom.overlap.value) || 0;
    dom.overlapValue.textContent = `${percent}%`;
    if (!state.project) return;
    state.project.overlap = percent / 100;
    state.metaDirty = true;
    scheduleSave();
  });

  dom.toggleSnap.addEventListener("change", () => {
    state.snap = dom.toggleSnap.checked;
  });

  dom.toggleGaps.addEventListener("change", () => {
    state.slideGaps = dom.toggleGaps.checked;
    fitViewToStrip();
    render();
  });

  dom.background.addEventListener("input", () => {
    if (!state.project) return;
    state.project.background = dom.background.value;
    state.metaDirty = true;
    render();
    scheduleSave();
  });

  dom.exportSize.addEventListener("change", () => {
    if (!state.project) return;
    state.project.exportSize = Number(dom.exportSize.value) || 1080;
    state.metaDirty = true;
    updateStatus();
    scheduleSave();
  });

  dom.selX.addEventListener("change", () => updateSelected({ x: Number(dom.selX.value) || 0 }));
  dom.selY.addEventListener("change", () => updateSelected({ y: Number(dom.selY.value) || 0 }));
  dom.selW.addEventListener("change", () => {
    const image = selectedImage();
    const width = Number(dom.selW.value) || 0;
    if (image && width > 0) updateSelected({ scale: geo.clampScale(width / image.width) });
  });
  dom.selH.addEventListener("change", () => {
    const image = selectedImage();
    const height = Number(dom.selH.value) || 0;
    if (image && height > 0) updateSelected({ scale: geo.clampScale(height / image.height) });
  });
  dom.selScale.addEventListener("change", () => {
    const percent = Number(dom.selScale.value) || 100;
    updateSelected({ scale: geo.clampScale(percent / 100) });
  });
  dom.selFrame.addEventListener("change", () => {
    const image = selectedImage();
    const item = selectedItem();
    if (!image || !item) return;
    const index = geo.clamp(Math.round(Number(dom.selFrame.value) || 1) - 1, 0, geo.MAX_FRAMES - 1);
    updateSelected(geo.centerInFrame(image, index, FRAME, item.scale));
  });

  window.addEventListener("resize", () => renderAllDebounced());

  window.addEventListener("keydown", (event) => {
    // The carousel preview owns the keyboard while it is open.
    if (preview.isOpen) return;
    const active = document.activeElement;
    const typing = active instanceof HTMLElement &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" ||
        active.isContentEditable);
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (event.code === "Space" && !typing) {
      event.preventDefault();
      controller?.setSpaceDown(true);
      return;
    }
    if (typing) return;

    if (event.key.startsWith("Arrow")) {
      const item = selectedItem();
      if (!item) return;
      event.preventDefault();
      const step = event.shiftKey ? 25 : 1;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      updateSelected({ x: item.x + dx, y: item.y + dy });
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      const item = selectedItem();
      if (!item) return;
      event.preventDefault();
      removeItem(item.id);
      return;
    }
    if (event.key === "Escape") {
      host.select(null);
      return;
    }
    if (event.key === "+" || event.key === "=") {
      zoomBy(1.25);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      zoomBy(1 / 1.25);
      return;
    }
    if (event.key.toLowerCase() === "f") {
      fitViewToStrip();
      render();
      return;
    }
    if (event.key.toLowerCase() === "m") {
      toggleMask();
      return;
    }
    if (event.key.toLowerCase() === "p") {
      openPreview();
      return;
    }
    if (event.key === "[" || event.key === "]") {
      const item = selectedItem();
      if (item) moveLayer(item.id, event.key === "]" ? 1 : -1);
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") controller?.setSpaceDown(false);
  });

  window.addEventListener("beforeunload", () => {
    if (!state.project || state.saveState !== "dirty") return;
    // A debounced PUT would be cancelled, so beacon the layout instead and stop
    // the last few edits from being lost when the tab closes.
    try {
      const body = new Blob([JSON.stringify({ items: snapshotItems() })], {
        type: "application/json",
      });
      navigator.sendBeacon(`/api/projects/${encodeURIComponent(state.project.id)}/layout`, body);
    } catch {
      saveNow();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.saveState === "dirty") saveNow();
  });
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  attachEvents();
  controller = new CanvasController(dom.canvas, host);
  await refreshProjects();

  const last = localStorage.getItem("postprep:lastProject");
  if (last && state.projects.some((project) => project.id === last)) {
    await openProject(last);
  } else {
    if (last) localStorage.removeItem("postprep:lastProject");
    renderAll();
  }

  window.__postprep = {
    state,
    actions,
    api,
    geometry: geo,
    controller,
    openProject,
    createProject,
    uploadFiles,
    arrange,
    exportSlides,
    downloadZip,
    saveNow,
    setFrames,
    render,
    preview,
    openPreview,
  };
}

boot();
