/** Thin wrapper around the PostPrep JSON API. */

const JSON_HEADERS = { "content-type": "application/json" };

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (cause) {
    throw new Error(`Network error: ${cause.message ?? cause}`);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // keep the generic message
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") ?? "";
  return type.includes("application/json") ? await response.json() : await response.blob();
}

export const api = {
  listProjects: () => request("/api/projects"),

  createProject: (name) =>
    request("/api/projects", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name }),
    }),

  getProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`),

  updateProject: (id, patch) =>
    request(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    }),

  deleteProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getLayout: (id) => request(`/api/projects/${encodeURIComponent(id)}/layout`),

  saveLayout: (id, items) =>
    request(`/api/projects/${encodeURIComponent(id)}/layout`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ items }),
    }),

  uploadImages: (id, files) => {
    const form = new FormData();
    for (const file of files) form.append("images", file, file.name);
    return request(`/api/projects/${encodeURIComponent(id)}/images`, {
      method: "POST",
      body: form,
    });
  },

  deleteImage: (id, imageId) =>
    request(`/api/projects/${encodeURIComponent(id)}/images/${encodeURIComponent(imageId)}`, {
      method: "DELETE",
    }),

  listExports: (id) => request(`/api/projects/${encodeURIComponent(id)}/exports`),

  saveExports: (id, frames, meta) => {
    const form = new FormData();
    for (const frame of frames) form.append("frames", frame.blob, frame.name);
    return request(`/api/projects/${encodeURIComponent(id)}/exports`, {
      method: "POST",
      headers: { "x-postprep-meta": encodeURIComponent(JSON.stringify(meta)) },
      body: form,
    });
  },

  clearExports: (id) =>
    request(`/api/projects/${encodeURIComponent(id)}/exports`, { method: "DELETE" }),

  imageUrl: (id, file) =>
    `/api/projects/${encodeURIComponent(id)}/images/${encodeURIComponent(file)}`,

  exportUrl: (id, file) =>
    `/api/projects/${encodeURIComponent(id)}/exports/${encodeURIComponent(file)}`,
};
