---
name: add-tab
description: Add a new top-nav tab. Creates the content directory, edits copy.yaml, and scaffolds a landing-page template if needed.
---

# Add a nav tab

Use when the user says "add a tab for X", "add the RV-12iS section", "I want a resume tab", etc.

## Inputs

1. **Tab label** — what shows in the nav.
2. **URL slug** — e.g. `rv12is`. Becomes `/rv12is`.
3. **Content type** — one of:
   - `musings-like` (markdown posts in folders)
   - `gallery-like` (photo grids)
   - `static` (a single hand-written page; user owns the HTML)

## Steps

1. Append the tab to `nav.tabs` in `copy.yaml` (label + href).
2. Create `content/<slug>/` directory.
3. For `musings-like`: same shape as `content/musings/` (categories → posts as index.md). Tell the build script to wire a new handler (or extend the existing one if it's identical).
4. For `gallery-like`: same shape as `content/media/`.
5. For `static`: create `templates/<slug>.eta` with a stub and add a render call in `scripts/build.mjs`.
6. Add SEO defaults to `copy.yaml` under the new key (title + description + intro).

## Constraints

- Don't extend the build script for content types that already exist — reuse them.
- Tab labels are lowercase by convention in this site.
- A new content type means a new handler in `build.mjs`. Keep it isolated: one function that takes the content dir and returns a list of pages to render.
