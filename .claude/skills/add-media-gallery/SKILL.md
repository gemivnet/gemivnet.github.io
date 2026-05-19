---
name: add-media-gallery
description: Create a new photo gallery under content/media/, write metadata.yaml with auto-generated SEO.
---

# Add a media gallery

Use when the user says "new gallery", "new album", "let's add a photo set", etc.

## Inputs

1. **Gallery path** — e.g. `australia/tasmania/mona`. Becomes the URL `/media/<path>`.
2. **Title** — short name shown on the gallery.
3. **Subtitle** — one sentence (optional).
4. **Location** — human-readable, e.g. "Hobart, Tasmania, Australia".
5. **Date** — when photos were taken (YYYY-MM-DD).
6. **Images** — optional; if provided, run `add-images-to-gallery` after.

## Steps

1. Create `content/media/<path>/`.
2. Generate `seo.description` (single sentence, <160 chars, mentions title + location) and `seo.keywords` (4–8 terms).
3. Write `metadata.yaml` with title/subtitle/location/date/seo/images:[]
4. If parent gallery folders don't have a `metadata.yaml`, scaffold one (title = folder name capitalized, empty images list).
5. If images were provided, hand off to `add-images-to-gallery`.

## Constraints

- Required: `title`. Build flags missing titles as errors.
- Date should be the date the photos were taken, not today.
