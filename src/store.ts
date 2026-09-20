/**
 * File based persistence for PostPrep.
 *
 * Layout on disk (the whole app stores data as plain files, JSON and JSONL):
 *
 *   <dataDir>/projects.jsonl              append-only registry log (last write wins)
 *   <dataDir>/projects/<id>/project.json  project document (meta + image index)
 *   <dataDir>/projects/<id>/layout.json   arrangement of the images
 *   <dataDir>/projects/<id>/exports.jsonl append-only log of exports
 *   <dataDir>/projects/<id>/images/*      original uploads
 *   <dataDir>/projects/<id>/exports/*     rendered 1:1 slides
 */

import {
  asBool,
  asNumber,
  asString,
  clamp,
  exists,
  isRecord,
  isSafeSegment,
  jsonlLine,
  Mutex,
  newId,
  nowIso,
  parseJsonl,
  readJson,
  sanitizeFilename,
  slugify,
  writeFileAtomic,
  writeJsonAtomic,
} from "./util.ts";
import { extensionFor, MAX_UPLOAD_BYTES, type SniffedImage, sniffImage } from "./images.ts";

/** World units of one slide edge; shared with the client layout maths. */
export const FRAME_SIZE = 1000;
export const MAX_FRAMES = 10;
export const MIN_FRAMES = 1;
export const MAX_EXPORT_SIZE = 4096;
export const MIN_EXPORT_SIZE = 320;
const REGISTRY_COMPACT_THRESHOLD = 2000;

export interface ProjectImage {
  id: string;
  /** Stored file name inside the project's images folder. */
  file: string;
  /** Original upload name, kept for display and downloads. */
  name: string;
  type: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Number of 1:1 slides in the strip. */
  frameCount: number;
  /** When true the client recomputes `frameCount` from the content extent. */
  autoFrames: boolean;
  /** Overlap between neighbouring images used by auto-arrange (0..0.9). */
  overlap: number;
  /** Slide background used for the gaps between images. */
  background: string;
  /** Pixel size of each exported square slide. */
  exportSize: number;
  imageCount: number;
  coverImageId: string | null;
}

export interface Project extends ProjectMeta {
  images: ProjectImage[];
}

export interface LayoutItem {
  id: string;
  imageId: string;
  x: number;
  y: number;
  scale: number;
  z: number;
}

export interface Layout {
  items: LayoutItem[];
}

export interface ExportEntry {
  id: string;
  file: string;
  frame: number;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
}

export interface ExportRecord {
  id: string;
  createdAt: string;
  exportSize: number;
  frameCount: number;
  entries: ExportEntry[];
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface ProjectStoreOptions {
  dataDir: string;
}

export interface IncomingFile {
  name: string;
  bytes: Uint8Array;
}

export class ProjectStore {
  readonly dataDir: string;
  readonly projectsDir: string;
  readonly registryPath: string;

  #registry = new Map<string, ProjectMeta>();
  #registryLines = 0;
  #mutex = new Mutex();
  #ready: Promise<void> | null = null;

  constructor(options: ProjectStoreOptions) {
    this.dataDir = options.dataDir;
    this.projectsDir = `${this.dataDir}/projects`;
    this.registryPath = `${this.dataDir}/projects.jsonl`;
  }

  async init(): Promise<void> {
    if (!this.#ready) this.#ready = this.#load();
    return await this.#ready;
  }

  async #load(): Promise<void> {
    await Deno.mkdir(this.projectsDir, { recursive: true });
    this.#registry.clear();
    this.#registryLines = 0;
    let text = "";
    try {
      text = await Deno.readTextFile(this.registryPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    for (const record of parseJsonl(text)) {
      this.#registryLines += 1;
      if (!isRecord(record)) continue;
      const id = asString(record.id);
      if (record.t === "delete" && id) {
        this.#registry.delete(id);
        continue;
      }
      if (record.t === "upsert" && isRecord(record.meta)) {
        const meta = record.meta as unknown as ProjectMeta;
        if (typeof meta.id === "string") this.#registry.set(meta.id, meta);
      }
    }
    // Prune index entries whose folder disappeared (manual edits, crash).
    for (const id of [...this.#registry.keys()]) {
      if (!(await exists(this.#projectDir(id)))) this.#registry.delete(id);
    }
  }

  #projectDir(id: string): string {
    return `${this.projectsDir}/${id}`;
  }

  #projectPath(id: string): string {
    return `${this.#projectDir(id)}/project.json`;
  }

  #layoutPath(id: string): string {
    return `${this.#projectDir(id)}/layout.json`;
  }

  #imagesDir(id: string): string {
    return `${this.#projectDir(id)}/images`;
  }

  #exportsDir(id: string): string {
    return `${this.#projectDir(id)}/exports`;
  }

  #exportsLogPath(id: string): string {
    return `${this.#projectDir(id)}/exports.jsonl`;
  }

  #requireId(id: string): string {
    if (!isSafeSegment(id)) throw new HttpError(400, "Invalid project id");
    return id;
  }

  /** Throw 404 unless the project is known to the index or present on disk. */
  async #requireProject(id: string): Promise<void> {
    if (this.#registry.has(id)) return;
    if (await exists(this.#projectPath(id))) return;
    throw new HttpError(404, "Project not found");
  }

  list(): ProjectMeta[] {
    return [...this.#registry.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Project> {
    await this.init();
    this.#requireId(id);
    const meta = this.#registry.get(id);
    const doc = await readJson<Project>(this.#projectPath(id));
    if (!doc) {
      if (meta) this.#registry.delete(id);
      throw new HttpError(404, "Project not found");
    }
    return normalizeProject(doc);
  }

  async create(name: string): Promise<Project> {
    await this.init();
    return await this.#mutex.run(async () => {
      const id = newId("prj");
      const timestamp = nowIso();
      const project: Project = {
        id,
        name: normalizeProjectName(name),
        createdAt: timestamp,
        updatedAt: timestamp,
        frameCount: 1,
        autoFrames: true,
        overlap: 0.15,
        background: "#ffffff",
        exportSize: 1080,
        imageCount: 0,
        coverImageId: null,
        images: [],
      };
      await Deno.mkdir(this.#imagesDir(id), { recursive: true });
      await Deno.mkdir(this.#exportsDir(id), { recursive: true });
      await writeJsonAtomic(this.#projectPath(id), project);
      await writeJsonAtomic(this.#layoutPath(id), { items: [] });
      await writeFileAtomic(this.#exportsLogPath(id), "");
      await this.#writeRegistry({ t: "upsert", meta: metaOf(project) });
      this.#registry.set(id, metaOf(project));
      return project;
    });
  }

  async update(id: string, patch: Record<string, unknown>): Promise<Project> {
    return await this.#mutate(id, (project) => {
      if (typeof patch.name === "string") project.name = normalizeProjectName(patch.name);
      if (patch.frameCount !== undefined) {
        project.frameCount = clamp(
          Math.round(asNumber(patch.frameCount, project.frameCount)),
          MIN_FRAMES,
          MAX_FRAMES,
        );
      }
      if (patch.autoFrames !== undefined) {
        project.autoFrames = asBool(patch.autoFrames, project.autoFrames);
      }
      if (patch.overlap !== undefined) {
        project.overlap = clamp(asNumber(patch.overlap, project.overlap), 0, 0.9);
      }
      if (typeof patch.background === "string" && /^#[0-9a-fA-F]{3,8}$/.test(patch.background)) {
        project.background = patch.background.toLowerCase();
      }
      if (patch.exportSize !== undefined) {
        project.exportSize = clamp(
          Math.round(asNumber(patch.exportSize, project.exportSize)),
          MIN_EXPORT_SIZE,
          MAX_EXPORT_SIZE,
        );
      }
      if (
        typeof patch.coverImageId === "string" &&
        project.images.some((i) => i.id === patch.coverImageId)
      ) {
        project.coverImageId = patch.coverImageId;
      }
      return project;
    });
  }

  async remove(id: string): Promise<void> {
    await this.init();
    this.#requireId(id);
    await this.#mutex.run(async () => {
      if (!this.#registry.has(id) && !(await exists(this.#projectDir(id)))) {
        throw new HttpError(404, "Project not found");
      }
      this.#registry.delete(id);
      await Deno.remove(this.#projectDir(id), { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await this.#writeRegistry({ t: "delete", id });
    });
  }

  async getLayout(id: string): Promise<Layout> {
    await this.init();
    this.#requireId(id);
    await this.#requireProject(id);
    const raw = await readJson<unknown>(this.#layoutPath(id));
    return normalizeLayout(raw);
  }

  async saveLayout(id: string, raw: unknown): Promise<Layout> {
    return await this.#mutate(id, async (project) => {
      const layout = normalizeLayout(raw);
      const known = new Set(project.images.map((image) => image.id));
      layout.items = layout.items.filter((item) => known.has(item.imageId));
      await writeJsonAtomic(this.#layoutPath(id), layout);
      return layout;
    });
  }

  async addImages(
    id: string,
    files: IncomingFile[],
  ): Promise<{ project: Project; added: ProjectImage[] }> {
    if (files.length === 0) throw new HttpError(400, "No files were uploaded");
    return await this.#mutate(id, async (project) => {
      const added: ProjectImage[] = [];
      const bytesUsed = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
      if (bytesUsed > MAX_UPLOAD_BYTES) {
        throw new HttpError(413, `Upload is larger than ${formatBytes(MAX_UPLOAD_BYTES)}`);
      }
      try {
        for (const file of files) {
          const sniffed = sniffImage(file.bytes);
          if (!sniffed) {
            throw new HttpError(415, `Unsupported image: ${sanitizeFilename(file.name)}`);
          }
          const image = await this.#writeImage(id, file, sniffed);
          added.push(image);
          project.images.push(image);
        }
      } catch (error) {
        // Nothing is persisted: drop the files written by this failed batch so
        // the project folder never keeps orphans.
        project.images = project.images.filter((image) => !added.includes(image));
        for (const image of added) {
          await Deno.remove(`${this.#imagesDir(id)}/${image.file}`).catch(() => {});
        }
        throw error;
      }
      project.imageCount = project.images.length;
      if (!project.coverImageId) project.coverImageId = project.images[0]?.id ?? null;
      return { project, added };
    });
  }

  async #writeImage(id: string, file: IncomingFile, sniffed: SniffedImage): Promise<ProjectImage> {
    const imageId = newId("img");
    const storedName = `${imageId}${extensionFor(sniffed.type)}`;
    await Deno.mkdir(this.#imagesDir(id), { recursive: true });
    await writeFileAtomic(`${this.#imagesDir(id)}/${storedName}`, file.bytes);
    return {
      id: imageId,
      file: storedName,
      name: sanitizeFilename(file.name, storedName),
      type: sniffed.type,
      width: sniffed.width,
      height: sniffed.height,
      bytes: file.bytes.byteLength,
      createdAt: nowIso(),
    };
  }

  async removeImage(id: string, imageId: string): Promise<Project> {
    return await this.#mutate(id, async (project) => {
      const index = project.images.findIndex((image) => image.id === imageId);
      if (index === -1) throw new HttpError(404, "Image not found");
      const [removed] = project.images.splice(index, 1);
      await Deno.remove(`${this.#imagesDir(id)}/${removed.file}`).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      project.imageCount = project.images.length;
      if (project.coverImageId === imageId) project.coverImageId = project.images[0]?.id ?? null;
      const layout = normalizeLayout(await readJson<unknown>(this.#layoutPath(id)));
      layout.items = layout.items.filter((item) => item.imageId !== imageId);
      await writeJsonAtomic(this.#layoutPath(id), layout);
      return project;
    });
  }

  async imagePath(id: string, file: string): Promise<string> {
    await this.init();
    this.#requireId(id);
    await this.#requireProject(id);
    if (!isSafeSegment(file)) throw new HttpError(400, "Invalid file name");
    const path = `${this.#imagesDir(id)}/${file}`;
    if (!(await exists(path))) throw new HttpError(404, "Image not found");
    return path;
  }

  async addExport(
    id: string,
    files: IncomingFile[],
    meta: { exportSize?: number; frameCount?: number },
  ): Promise<ExportRecord> {
    if (files.length === 0) throw new HttpError(400, "No frames were uploaded");
    return await this.#mutate(id, async () => {
      const exportId = newId("exp");
      const createdAt = nowIso();
      await Deno.mkdir(this.#exportsDir(id), { recursive: true });
      const entries: ExportEntry[] = [];
      for (let index = 0; index < files.length; index++) {
        const frame = index + 1;
        const stored = `${exportId}-${String(frame).padStart(2, "0")}.png`;
        const sniffed = sniffImage(files[index].bytes);
        if (!sniffed || sniffed.type !== "image/png") {
          throw new HttpError(415, "Exported frames must be PNG images");
        }
        await writeFileAtomic(`${this.#exportsDir(id)}/${stored}`, files[index].bytes);
        entries.push({
          id: `${exportId}-${frame}`,
          file: stored,
          frame,
          width: sniffed.width,
          height: sniffed.height,
          bytes: files[index].bytes.byteLength,
          createdAt,
        });
      }
      const record: ExportRecord = {
        id: exportId,
        createdAt,
        exportSize: clamp(
          Math.round(asNumber(meta.exportSize, 0)) || 1080,
          MIN_EXPORT_SIZE,
          MAX_EXPORT_SIZE,
        ),
        frameCount: clamp(
          Math.round(asNumber(meta.frameCount, files.length)),
          MIN_FRAMES,
          MAX_FRAMES,
        ),
        entries,
      };
      await Deno.writeTextFile(this.#exportsLogPath(id), jsonlLine({ t: "export", record }), {
        append: true,
        create: true,
      });
      return record;
    }, { persist: false });
  }

  async listExports(id: string): Promise<ExportRecord[]> {
    await this.init();
    this.#requireId(id);
    await this.#requireProject(id);
    let text = "";
    try {
      text = await Deno.readTextFile(this.#exportsLogPath(id));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    const records: ExportRecord[] = [];
    for (const line of parseJsonl(text)) {
      if (!isRecord(line)) continue;
      if (line.t === "clear") {
        records.length = 0;
        continue;
      }
      if (line.t === "export" && isRecord(line.record)) {
        records.push(line.record as unknown as ExportRecord);
      }
    }
    return records.reverse();
  }

  async clearExports(id: string): Promise<void> {
    return await this.#mutate(id, async () => {
      await Deno.remove(this.#exportsDir(id), { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await Deno.mkdir(this.#exportsDir(id), { recursive: true });
      await Deno.writeTextFile(this.#exportsLogPath(id), jsonlLine({ t: "clear" }), {
        append: true,
        create: true,
      });
    }, { persist: false });
  }

  async exportPath(id: string, file: string): Promise<string> {
    await this.init();
    this.#requireId(id);
    await this.#requireProject(id);
    if (!isSafeSegment(file)) throw new HttpError(400, "Invalid file name");
    const path = `${this.#exportsDir(id)}/${file}`;
    if (!(await exists(path))) throw new HttpError(404, "Export not found");
    return path;
  }

  /** Slug used to build friendly download names for the project's slides. */
  slugFor(project: Project): string {
    return slugify(project.name);
  }

  async #persistProject(project: Project): Promise<void> {
    project.updatedAt = nowIso();
    project.imageCount = project.images.length;
    await writeJsonAtomic(this.#projectPath(project.id), project);
    this.#registry.set(project.id, metaOf(project));
    await this.#writeRegistry({ t: "upsert", meta: metaOf(project) });
  }

  async #mutate<T>(
    id: string,
    fn: (project: Project) => Promise<T> | T,
    options: { persist?: boolean } = {},
  ): Promise<T> {
    await this.init();
    this.#requireId(id);
    return await this.#mutex.run(async () => {
      const project = await this.get(id);
      const result = await fn(project);
      if (options.persist !== false) await this.#persistProject(project);
      return result;
    });
  }

  async #writeRegistry(record: unknown): Promise<void> {
    await Deno.mkdir(this.dataDir, { recursive: true });
    await Deno.writeTextFile(this.registryPath, jsonlLine(record), { append: true, create: true });
    this.#registryLines += 1;
    if (this.#registryLines > REGISTRY_COMPACT_THRESHOLD) await this.#compactRegistry();
  }

  async #compactRegistry(): Promise<void> {
    const lines = [...this.#registry.values()].map((meta) => jsonlLine({ t: "upsert", meta }));
    await writeFileAtomic(this.registryPath, lines.join(""));
    this.#registryLines = lines.length;
  }
}

export function metaOf(project: Project): ProjectMeta {
  const { images: _images, ...meta } = project;
  return meta;
}

function normalizeProjectName(name: string): string {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return trimmed.length > 0 ? trimmed : "Untitled post";
}

function normalizeProject(raw: unknown): Project {
  const doc = isRecord(raw) ? raw : {};
  const images: ProjectImage[] = [];
  if (Array.isArray(doc.images)) {
    for (const entry of doc.images) {
      if (!isRecord(entry)) continue;
      const id = asString(entry.id);
      const file = asString(entry.file);
      if (!id || !file) continue;
      images.push({
        id,
        file,
        name: asString(entry.name) ?? file,
        type: asString(entry.type) ?? "image/png",
        width: Math.max(1, Math.round(asNumber(entry.width, 1))),
        height: Math.max(1, Math.round(asNumber(entry.height, 1))),
        bytes: Math.max(0, Math.round(asNumber(entry.bytes, 0))),
        createdAt: asString(entry.createdAt) ?? nowIso(),
      });
    }
  }
  const id = asString(doc.id) ?? newId("prj");
  return {
    id,
    name: normalizeProjectName(asString(doc.name) ?? "Untitled post"),
    createdAt: asString(doc.createdAt) ?? nowIso(),
    updatedAt: asString(doc.updatedAt) ?? nowIso(),
    frameCount: clamp(Math.round(asNumber(doc.frameCount, 1)), MIN_FRAMES, MAX_FRAMES),
    autoFrames: asBool(doc.autoFrames, true),
    overlap: clamp(asNumber(doc.overlap, 0.15), 0, 0.9),
    background: typeof doc.background === "string" ? doc.background : "#ffffff",
    exportSize: clamp(Math.round(asNumber(doc.exportSize, 1080)), MIN_EXPORT_SIZE, MAX_EXPORT_SIZE),
    imageCount: images.length,
    coverImageId: asString(doc.coverImageId),
    images,
  };
}

export function normalizeLayout(raw: unknown): Layout {
  const source = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  const items: LayoutItem[] = [];
  source.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const imageId = asString(entry.imageId);
    if (!imageId) return;
    const scale = clamp(asNumber(entry.scale, 1), 0.01, 200);
    items.push({
      id: asString(entry.id) ?? newId("itm"),
      imageId,
      x: Math.round(asNumber(entry.x, 0) * 1000) / 1000,
      y: Math.round(asNumber(entry.y, 0) * 1000) / 1000,
      scale: Math.round(scale * 100000) / 100000,
      z: Math.round(asNumber(entry.z, index)),
    });
  });
  items.sort((a, b) => a.z - b.z);
  return { items };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
