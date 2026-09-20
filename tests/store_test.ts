import { assert, assertEquals, assertRejects } from "./assert.ts";
import { HttpError, ProjectStore } from "../src/store.ts";
import { makeGif, makePng } from "./helpers.ts";

async function withStore(fn: (store: ProjectStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "postprep-store-" });
  try {
    const store = new ProjectStore({ dataDir: dir });
    await store.init();
    await fn(store, dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("store creates, lists and reads a project", async () => {
  await withStore(async (store) => {
    const project = await store.create("  My   carousel  ");
    assertEquals(project.name, "My carousel");
    assertEquals(project.images.length, 0);
    assertEquals(store.list().length, 1);

    const reloaded = await store.get(project.id);
    assertEquals(reloaded.id, project.id);
    assertEquals(reloaded.frameCount, 1);
  });
});

Deno.test("store rejects unsupported uploads", async () => {
  await withStore(async (store) => {
    const project = await store.create("bad upload");
    await assertRejects(
      () =>
        store.addImages(project.id, [{ name: "notes.txt", bytes: new TextEncoder().encode("hi") }]),
      HttpError,
    );
  });
});

Deno.test("store stores images on disk and prunes the layout when they are removed", async () => {
  await withStore(async (store, dir) => {
    const project = await store.create("images");
    const { project: withImages, added } = await store.addImages(project.id, [
      { name: "one.png", bytes: makePng(800, 600) },
      { name: "two.gif", bytes: makeGif(400, 400) },
    ]);
    assertEquals(added.length, 2);
    assertEquals(withImages.images[0].width, 800);
    assertEquals(withImages.images[1].type, "image/gif");
    assertEquals(withImages.coverImageId, withImages.images[0].id);

    const storedPath = `${dir}/projects/${project.id}/images/${added[0].file}`;
    assert((await Deno.stat(storedPath)).isFile);

    await store.saveLayout(project.id, {
      items: added.map((image, index) => ({
        id: `item-${index}`,
        imageId: image.id,
        x: index * 10,
        y: 5,
        scale: 1.5,
        z: index,
      })),
    });
    const layout = await store.getLayout(project.id);
    assertEquals(layout.items.length, 2);
    assertEquals(layout.items[1].x, 10);

    await store.removeImage(project.id, added[0].id);
    const afterRemove = await store.getLayout(project.id);
    assertEquals(afterRemove.items.length, 1);
    assertEquals(afterRemove.items[0].imageId, added[1].id);
  });
});

Deno.test("store ignores layout items that reference unknown images", async () => {
  await withStore(async (store) => {
    const project = await store.create("orphans");
    await store.addImages(project.id, [{ name: "one.png", bytes: makePng(100, 100) }]);
    const layout = await store.saveLayout(project.id, {
      items: [{ imageId: "img_missing", x: 1, y: 2, scale: 1, z: 0 }],
    });
    assertEquals(layout.items.length, 0);
  });
});

Deno.test("store records exports as PNG files", async () => {
  await withStore(async (store, dir) => {
    const project = await store.create("exporting");
    const record = await store.addExport(
      project.id,
      [
        { name: "frame-01.png", bytes: makePng(1080, 1080) },
        { name: "frame-02.png", bytes: makePng(1080, 1080) },
      ],
      { exportSize: 1080, frameCount: 2 },
    );
    assertEquals(record.entries.length, 2);
    assertEquals(record.entries[1].width, 1080);
    assert(
      (await Deno.stat(`${store.dataDir}/projects/${project.id}/exports/${record.entries[0].file}`))
        .isFile,
    );

    const listed = await store.listExports(project.id);
    assertEquals(listed.length, 1);
    assertEquals(listed[0].id, record.id);

    await store.clearExports(project.id);
    assertEquals((await store.listExports(project.id)).length, 0);
    assert((await Deno.stat(`${dir}/projects/${project.id}/exports`)).isDirectory);
  });
});

Deno.test("store rejects non PNG export frames", async () => {
  await withStore(async (store) => {
    const project = await store.create("bad export");
    await assertRejects(
      () => store.addExport(project.id, [{ name: "frame.png", bytes: makeGif(10, 10) }], {}),
      HttpError,
    );
  });
});

Deno.test("store rebuilds its index from the JSONL registry and honours deletes", async () => {
  await withStore(async (store, dir) => {
    const keep = await store.create("keep me");
    const drop = await store.create("drop me");
    await store.update(keep.id, { name: "renamed", frameCount: 4, autoFrames: false });
    await store.remove(drop.id);

    const reopened = new ProjectStore({ dataDir: dir });
    await reopened.init();
    assertEquals(reopened.list().map((project) => project.name), ["renamed"]);
    const reloaded = await reopened.get(keep.id);
    assertEquals(reloaded.frameCount, 4);
    assertEquals(reloaded.autoFrames, false);
    await assertRejects(() => reopened.get(drop.id), HttpError);
  });
});

Deno.test("store validates ids and ranges", async () => {
  await withStore(async (store) => {
    await assertRejects(() => store.get("../etc"), HttpError);
    await assertRejects(() => store.get("prj_doesnotexist"), HttpError);
    const project = await store.create("clamps");
    const updated = await store.update(project.id, { frameCount: 99, overlap: 5, exportSize: 10 });
    assertEquals(updated.frameCount, 10);
    assertEquals(updated.overlap, 0.9);
    assertEquals(updated.exportSize, 320);
  });
});

Deno.test("store persists layout.json and project.json as readable JSON", async () => {
  await withStore(async (store, dir) => {
    const project = await store.create("files");
    await store.addImages(project.id, [{ name: "one.png", bytes: makePng(300, 300) }]);
    const doc = JSON.parse(await Deno.readTextFile(`${dir}/projects/${project.id}/project.json`));
    assertEquals(doc.images.length, 1);
    const layout = JSON.parse(await Deno.readTextFile(`${dir}/projects/${project.id}/layout.json`));
    assertEquals(Array.isArray(layout.items), true);
  });
});
