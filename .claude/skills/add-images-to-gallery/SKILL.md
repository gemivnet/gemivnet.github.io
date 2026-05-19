---
name: add-images-to-gallery
description: Copy images into a gallery folder and append their per-image metadata (title, date, location, alt) to metadata.yaml.
---

# Add images to a gallery

Use when the user says "add photos to <gallery>" or drops images on the chat.

## Inputs

1. **Target gallery path** — e.g. `australia/tasmania/mona`.
2. **Image file paths**.
3. For each image: **title**, **date** (defaults to gallery date), **location** (defaults to gallery location), **alt** (REQUIRED).

## Steps

1. Resolve `content/media/<path>/metadata.yaml`. Read it.
2. For each image:
   - Copy to the gallery folder (preserve filename or rename to `img_NNN.jpg`-style if the user prefers).
   - Build an entry: `{ file, title, date, location, alt }`.
3. Append entries to the `images:` list in `metadata.yaml`. Preserve YAML formatting.
4. Print the new `images:` count.

## Constraints

- `alt` is REQUIRED on every image. Build will fail otherwise.
- Don't duplicate entries — if a file by that name is already in `images:`, ask whether to skip or replace.
- Keep ordering: appended images go at the end of the list.
