---
name: add-musing
description: Create a new musing (blog post) with frontmatter, directory scaffold, and auto-generated SEO description/keywords.
---

# Add a new musing

Use this skill when the user says "new musing", "new post", "let's write a post", or similar.

## Inputs to collect (ask one at a time if not given)

1. **Title** — what's the post called?
2. **Subtitle** — one sentence under the title (optional, but recommended).
3. **Category path** — e.g. `travel/japan` or `code`. Determines the URL `/musings/<category>/<slug>`.
4. **Tags** — comma-separated. Reusable across folders.

## Steps

1. Slugify title → kebab-case folder name.
2. Create `content/musings/<category>/<slug>/` and `content/musings/<category>/<slug>/media/`.
3. Generate `seo.description` (one natural sentence, <160 chars, never "Blog post about X") and `seo.keywords` (5–8 terms: obvious + 2–3 long-tail variants).
4. Write `index.md` with frontmatter (title, date=today, tags, featured_image:null, draft:false, seo block).
5. Print the path. Offer to open it for editing.

## Constraints

- Required frontmatter: `title`, `date`. Always generate `seo.description` and `seo.keywords` — build won't fail but SEO will suffer.
- Create intermediate category dirs as needed.
- Don't write past a 1–2 sentence placeholder body — that's the human's job.
