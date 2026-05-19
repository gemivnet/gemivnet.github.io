---
name: add-images-to-musing
description: Copy image files into a musing's media/ folder, prompt for alt text, and insert markdown image references.
---

# Add images to a musing

Use when the user says "add this image to <post>", "drop these photos into the japan post", etc.

## Inputs

1. **Target musing** — slug or path. If ambiguous, list candidates from `content/musings/**/index.md`.
2. **Image source paths** — absolute or relative.
3. **For each image**: alt text (REQUIRED — accessibility + image SEO), caption (defaults to alt), and inline vs full-width.

## Steps

1. Verify the target musing exists. Read its `index.md`.
2. For each image:
   - Copy to `content/musings/<path>/media/<filename>`.
   - Confirm/strip EXIF if the user wants (offer; default = keep).
3. Append markdown image references to the post body. Syntax:
   - Full-width: `![<alt>](media/<file>)`
   - Inline (floated, wrapped by text): `![<alt>](media/<file>){.inline}`
4. If `featured_image:` is `null` and this is the first image being added, offer to set the first image as featured (OG image for shares).
5. Print summary.

## Constraints

- Alt text is REQUIRED — refuse to insert a markdown image without it.
- Never invent alt text; ask the user.
- Don't rewrite existing image references in the body.
