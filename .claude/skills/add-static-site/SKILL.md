---
name: add-static-site
description: Create a new standalone static site under content/sites/ that gets copied verbatim to /sites/<name>/ on the live site.
---

# Add a static site

Use when the user says "new static site", "add a site under /sites/", "I want to publish a tool".

## Inputs

1. **Folder name** — becomes the URL slug under `/sites/`.
2. Optional: list of files to seed (or "just a stub").

## Steps

1. Create `content/sites/<name>/`.
2. Write `content/sites/<name>/index.html` with a minimal stub (head + body + a "hello, edit me" placeholder).
3. Optionally seed `style.css`, `app.js`, or whatever the user named.
4. Confirm the path. Mention: this directory is copied as-is, no templating, no image processing, no nav, no analytics — bring your own CSS/JS.

## Constraints

- Do NOT add the site to `copy.yaml` `nav.tabs` — static sites are unlisted by design.
- Do NOT process anything inside `content/sites/`. The build copies the tree verbatim.
- Live URL: `https://georgemain.com/sites/<name>/`.
