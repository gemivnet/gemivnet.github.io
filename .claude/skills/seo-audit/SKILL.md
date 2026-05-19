---
name: seo-audit
description: Scan all content for SEO issues — missing descriptions, missing alt text, missing featured images, length problems, duplicates. Report and offer fixes.
---

# SEO audit

Use when the user says "seo audit", "check seo", "are my descriptions OK", etc.

## What to check

For each musing (`content/musings/**/index.md`):
- `seo.description` missing, empty, <50 chars, or >160 chars
- `seo.keywords` missing or empty
- `featured_image` missing (warn — used for OG share previews)
- Markdown images without alt text
- Duplicate `seo.description` across posts

For each gallery (`content/media/**/metadata.yaml`):
- `seo.description` missing/short/long
- Any image with missing `alt`
- Gallery missing `title`

For the homepage / index pages (auto-generated):
- Confirm `copy.yaml` `site.description` is set and well-formed.

## Output format

Group issues by severity:
- ✗ **errors** (build-blocking, e.g. missing alt text on a media image)
- ⚠ **warnings** (won't block, but should fix: short descriptions, no featured image)
- ℹ **suggestions** (long-tail keyword could be added)

For each issue, give: file path + the exact field/line + a one-line proposed fix.

## Auto-fix offer

After listing issues, offer to:
1. **Generate missing descriptions** — synthesize from title + tags + first paragraph. Single sentence, <160 chars, never "Blog post about X".
2. **Generate missing keywords** — 5–8 terms: obvious + 2–3 long-tail.
3. **Flag missing alt text** — list lines to edit by hand; never invent alt text.

Wait for user confirmation before writing any file.
