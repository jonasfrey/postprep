# PostPrep — requirements

The formalised requirements this implementation was built against. The brief at the bottom is the
original note, kept verbatim.

## 1. Purpose

Create the images for an Instagram carousel post. Instagram renders a multi-image post as a
horizontal slide box, so images that visually continue across a slide boundary invite the viewer to
swipe. The app arranges several uploaded photos on a shared plane so they overlap across boundaries,
then exports exactly what each 1:1 slide contains.

## 2. Functional requirements

| #   | Requirement                                                                                                   | Where it lives                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| F1  | The user can create, rename and delete projects.                                                              | `public/js/app.js`, `POST/PATCH/DELETE /api/projects`                                              |
| F2  | A project is a collection of images the user uploads and manages (add, list, remove).                         | Images panel, `POST /api/projects/:id/images`                                                      |
| F3  | Uploads accept PNG, JPEG, GIF and WebP, are validated, and their intrinsic size is read from the file header. | `src/images.ts`                                                                                    |
| F4  | The preview shows **n** 1:1 boxes side by side at 1:1 aspect ratio.                                           | `public/js/renderer.js` (`frameRects`)                                                             |
| F5  | Every box has a clear, thin, **red vertical border** so the user sees what each exported image will contain.  | `FRAME_BORDER_COLOR = #ff2d55` in `geometry.js`, drawn in `renderer.js`                            |
| F6  | All images are placed automatically with a **slight x offset** on load.                                       | `arrange("strip")` — left to right, scaled to slide height, 15 % overlap                           |
| F7  | The user can slide (move) images around to overlap them.                                                      | drag gesture in `interactions.js`                                                                  |
| F8  | The user can resize images.                                                                                   | corner handles, scale/size fields, keyboard nudge                                                  |
| F9  | Content that will be cropped is still visible while arranging.                                                | full-opacity photos in `renderer.js`; everything outside the slides is dimmed by the crop mask     |
| F9b | The mask is a property of the preview window, not of the images (photos are never faded or see-through).      | `MASK_COLOR` layer with the slide squares punched out (`renderer.js`)                              |
| F9c | The mask can be removed and restored.                                                                         | **Remove mask** / **Show mask** button on the canvas overlay, <kbd>M</kbd>, kept in `localStorage` |
| F10 | An **export** button crops the visible content of each 1:1 box into its own image.                            | Export panel → `exportSlides()`                                                                    |
| F11 | The user can download the exported images.                                                                    | per-slide download links + browser-side `.zip` (`zip.js`)                                          |
| F12 | Exports and originals are kept as files.                                                                      | `data/projects/<id>/exports/`, `data/projects/<id>/images/`                                        |
| F13 | The user can preview the result in a 1:1 box and slide through the slides like the gallery does.              | **Preview** button / <kbd>P</kbd>, `public/js/preview.js`                                          |
| F14 | The preview simulates the slide box: dragging shows the neighbouring slide, then snaps to one.                | pointer drag with snapping, arrows, wheel, dots, <kbd>Esc</kbd>                                    |
| F15 | The preview shows the real export frames, not an approximation.                                               | rendered through the same `renderFrameBlob` path as the export                                     |

## 3. Technical requirements

| #  | Requirement                            | How                                                                             |
| -- | -------------------------------------- | ------------------------------------------------------------------------------- |
| T1 | Deno on the server.                    | `server.ts` using `Deno.serve`, standard library only (no imports at all)       |
| T2 | JavaScript on the front end.           | `public/js/*.js` ES modules, no build step                                      |
| T3 | Data stored as files — JSON and JSONL. | `project.json`, `layout.json`, append-only `projects.jsonl` and `exports.jsonl` |
| T4 | The arrangement survives a reload.     | autosaved layout, restored on project open                                      |
| T5 | Sensible limits.                       | ≤ 10 slides (Instagram), ≤ 40 MB per upload, 320–4096 px export size            |
| T6 | Robust HTTP surface.                   | typed errors, path-traversal protection, atomic writes, serialised mutations    |

## 4. Acceptance criteria

1. Creating a project and uploading three landscape photos places them side by side, each
   overlapping the previous one, with the strip growing to as many slides as the content needs.
2. The preview shows the slides adjacent to each other with thin red vertical borders and the slide
   numbers above them.
3. Dragging an image so it straddles a slide boundary makes the exported slides share content: slide
   2 contains part of image 1 and part of image 2.
4. Exporting produces one file per slide, each a square PNG at the configured size, with the slides
   distinguishable from each other.
5. Content outside the boxes stays fully visible (darkened only by the window-level crop mask) and
   is not part of any export. Removing the mask brightens that content without changing the export.
6. Every export can be downloaded individually and all of them as one `.zip`.
7. Removing an image from a project removes it from the arrangement too.
8. The preview button opens a 1:1 box with one rendered slide per slide; dragging reveals the
   neighbouring slide and releasing snaps; arrows, wheel, dots and <kbd>Esc</kbd> work.
9. `deno task test` and `deno task smoke` pass.

`deno task smoke` asserts criteria 1–5 and 8 automatically in a real browser (see `tools/smoke.ts`),
including canvas-pixel checks that the mask darkens the stage but never the photos, and synthetic
pointer drags that prove the preview really shows the neighbouring slide mid-swipe.

## 5. Out of scope (for now)

- Rotation of images.
- Text/sticker overlays.
- Server-side (headless) rendering: the server stores files and never decodes pixels.
- Multi-user accounts, sharing or a database.

## 6. Original brief

> help me define requirements for this app.
>
> it is a webapp , tech stack is
>
> denojs on server side js on frontend data is stored as files and a json files or JSONL files
>
> ---
>
> purpose the goal is to create an app that creates images for an instagram post. since one post
> with many images will display the images in a horizontal slidebox it is interesting to be able to
> arange the images in a way that they overlap a bit so that the user sees something of a different
> image in while sliding around.
>
> this app should have a final export button that exports the new combined and cropped images.
>
> the user can create projects. a project is a collection of images they can upload and manage. the
> preview window will be aspect ratio 1:1 and shows n 1:1 boxes next to each other all the boxes
> have clear thin red vertical borders so the user sees what each exported image will contain. firs
> all images are loaded with a slight x offset. from there the user can slide the images around and
> overlap them or resize them to create an arrangement.
>
> finally with the export button all the visible content each of 1:1 boxes is cropped and exported
> to an image. the user will be able to download the images.
