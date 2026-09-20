import { assert, assertEquals } from "./assert.ts";
import { makePng, startTestServer, type TestServer } from "./helpers.ts";

async function withServer(fn: (server: TestServer) => Promise<void>): Promise<void> {
  const server = await startTestServer();
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

Deno.test("GET /api/health responds", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/health`);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).ok, true);
  });
});

Deno.test("project CRUD over HTTP", async () => {
  await withServer(async ({ base }) => {
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Launch post" }),
    });
    assertEquals(created.status, 201);
    const { project } = await created.json();
    assertEquals(project.name, "Launch post");

    const list = await (await fetch(`${base}/api/projects`)).json();
    assertEquals(list.projects.length, 1);
    assertEquals(list.projects[0].id, project.id);

    const patched = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Launch post v2", frameCount: 3, autoFrames: false }),
    });
    const patchedBody = await patched.json();
    assertEquals(patchedBody.project.name, "Launch post v2");
    assertEquals(patchedBody.project.frameCount, 3);

    const removed = await fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" });
    assertEquals(removed.status, 204);
    const afterDelete = await (await fetch(`${base}/api/projects`)).json();
    assertEquals(afterDelete.projects.length, 0);
  });
});

Deno.test("layout round trips through the API", async () => {
  await withServer(async ({ base }) => {
    const { project } = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "layout" }),
    })).json();

    const form = new FormData();
    form.append("images", new File([makePng(900, 1200)], "portrait.png", { type: "image/png" }));
    form.append("images", new File([makePng(1600, 900)], "landscape.png", { type: "image/png" }));
    const uploaded = await fetch(`${base}/api/projects/${project.id}/images`, {
      method: "POST",
      body: form,
    });
    assertEquals(uploaded.status, 201);
    const uploadBody = await uploaded.json();
    assertEquals(uploadBody.added.length, 2);
    assertEquals(uploadBody.project.imageCount, 2);

    const [first, second] = uploadBody.added;
    const saved = await fetch(`${base}/api/projects/${project.id}/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { imageId: first.id, x: 0, y: 0, scale: 0.8, z: 0 },
          { imageId: second.id, x: 640, y: 12, scale: 1.25, z: 1 },
        ],
      }),
    });
    assertEquals(saved.status, 200);
    const layout = (await saved.json()).layout;
    assertEquals(layout.items.length, 2);

    const reloaded = await (await fetch(`${base}/api/projects/${project.id}/layout`)).json();
    assertEquals(reloaded.layout.items[1].x, 640);

    const served = await fetch(`${base}/api/projects/${project.id}/images/${first.file}`);
    assertEquals(served.status, 200);
    assertEquals(served.headers.get("content-type"), "image/png");
    assertEquals((await served.arrayBuffer()).byteLength, 33);
  });
});

Deno.test("exports can be uploaded, listed and downloaded", async () => {
  await withServer(async ({ base }) => {
    const { project } = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "export" }),
    })).json();

    const form = new FormData();
    form.append("frames", new File([makePng(1080, 1080)], "frame-01.png", { type: "image/png" }));
    form.append("frames", new File([makePng(1080, 1080)], "frame-02.png", { type: "image/png" }));
    const posted = await fetch(`${base}/api/projects/${project.id}/exports`, {
      method: "POST",
      body: form,
      headers: {
        "x-postprep-meta": encodeURIComponent(JSON.stringify({ exportSize: 1080, frameCount: 2 })),
      },
    });
    assertEquals(posted.status, 201);
    const record = (await posted.json()).export;
    assertEquals(record.entries.length, 2);
    assertEquals(record.exportSize, 1080);

    const listed = await (await fetch(`${base}/api/projects/${project.id}/exports`)).json();
    assertEquals(listed.exports.length, 1);

    const downloaded = await fetch(
      `${base}/api/projects/${project.id}/exports/${record.entries[0].file}`,
    );
    assertEquals(downloaded.status, 200);
    assertEquals((await downloaded.arrayBuffer()).byteLength, 33);

    const cleared = await fetch(`${base}/api/projects/${project.id}/exports`, { method: "DELETE" });
    assertEquals(cleared.status, 204);
    const afterClear = await (await fetch(`${base}/api/projects/${project.id}/exports`)).json();
    assertEquals(afterClear.exports.length, 0);
  });
});

Deno.test("the API rejects bad input", async () => {
  await withServer(async ({ base }) => {
    assertEquals((await fetch(`${base}/api/projects/nope`)).status, 404);
    assertEquals((await fetch(`${base}/api/projects`)).status, 200);
    const badJson = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assertEquals(badJson.status, 400);

    const { project } = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "strict" }),
    })).json();

    const textUpload = new FormData();
    textUpload.append("images", new File(["hello"], "notes.txt", { type: "text/plain" }));
    const rejected = await fetch(`${base}/api/projects/${project.id}/images`, {
      method: "POST",
      body: textUpload,
    });
    assertEquals(rejected.status, 415);

    const notMultipart = await fetch(`${base}/api/projects/${project.id}/images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assertEquals(notMultipart.status, 415);

    assertEquals((await fetch(`${base}/api/unknown`)).status, 404);
    assertEquals(
      (await fetch(`${base}/api/projects/${project.id}`, { method: "PUT" })).status,
      405,
    );
  });
});

Deno.test("the static app is served and traversal is blocked", async () => {
  await withServer(async ({ base }) => {
    const index = await fetch(`${base}/`);
    assertEquals(index.status, 200);
    assert((await index.text()).includes("PostPrep"));

    const script = await fetch(`${base}/js/app.js`);
    assertEquals(script.status, 200);
    assert((script.headers.get("content-type") ?? "").includes("javascript"));

    const missing = await fetch(`${base}/nope.js`);
    assertEquals(missing.status, 404);

    // Percent-encoded traversal must never escape the public directory.
    const traversal = await fetch(`${base}/..%2fserver.ts`);
    assertEquals(traversal.status === 404 || traversal.status === 403, true);
  });
});

Deno.test("unsupported uploads do not leave a half-written project behind", async () => {
  await withServer(async ({ base }) => {
    const { project } = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "atomic" }),
    })).json();
    const form = new FormData();
    form.append("images", new File([makePng(10, 10)], "ok.png", { type: "image/png" }));
    form.append("images", new File(["junk"], "bad.png", { type: "image/png" }));
    const response = await fetch(`${base}/api/projects/${project.id}/images`, {
      method: "POST",
      body: form,
    });
    assertEquals(response.status, 415);
    const fresh = await (await fetch(`${base}/api/projects/${project.id}`)).json();
    assertEquals(fresh.project.images.length, 0);
  });
});

Deno.test("a missing project id is a 404, not a crash", async () => {
  await withServer(async ({ base }) => {
    const layout = await fetch(`${base}/api/projects/prj_missing/layout`);
    assertEquals(layout.status, 404);
    const body = await layout.json();
    assert(typeof body.error === "string");

    const images = await fetch(`${base}/api/projects/prj_missing/images/img_1.png`);
    assertEquals(images.status, 404);

    const exports = await fetch(`${base}/api/projects/prj_missing/exports`);
    assertEquals(exports.status, 404);
  });
});
