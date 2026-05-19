# CLAUDE.md

Notes for future Claude sessions working on this repo. Read this before editing.

## What this is

`georgemain.com` — a static personal site. Custom Node SSG, deployed via GitHub
Actions to GitHub Pages. Source of truth is the working tree on `main`.

## Architecture (one file at a time)

- `scripts/build.mjs` — the entire SSG. Reads `content/`, writes `_site/`.
  Single file on purpose. Don't pull in a framework.
- `templates/` — Eta templates. `_base.eta` is the layout; everything else is
  rendered then injected as `body`.
- `design/` — `tokens.css` and `site.css` from Claude Design. Copied verbatim
  into `_site/` at build time. **Don't hand-edit these as the primary source
  of design changes** — request a new bundle from Claude Design and replace
  the files. Small ad-hoc additions are appended at the end with a comment.
- `copy.yaml` — every human-facing string on the site. Edit here, not in
  templates. If you're tempted to add a template literal in an Eta file,
  put it in `copy.yaml` instead.
- `content/musings/<category>/<slug>/index.md` — blog posts. Markdown +
  frontmatter. `media/` subfolder for images.
- `content/media/<path>/metadata.yaml` — standalone photo galleries.
- `content/sites/<name>/` — verbatim passthrough to `/sites/<name>/`.
- `staging/` — gitignored intake for media. `npm run media` ingests.

## Common workflows

```bash
npm run setup     # one-time: installs git hooks
npm run build     # writes _site/
npm run dev       # build + local server on :4321
npm run media     # interactive media ingest from staging/
npm run check:pii # manually run the PII scanner
```

## Design source-of-truth flow

The user iterates on the visual design in Claude Design (claude.ai/design).
When a new bundle arrives:

1. Read the bundle's `README.md` and the chat transcript first.
2. Replace `design/tokens.css` and `design/site.css` verbatim with the new files.
3. Update templates to match new structural patterns (new class names,
   nested elements, etc.) — the chat transcript usually highlights what
   moved.
4. Build, push, then summarize the deltas back so the user can paste them
   into Claude Design to keep the prototype in sync with the live site.

The Eta `<%-` raw-output tag is **NOT** valid in Eta 3. Use `<%~` for
raw or `<%=` (which is also raw since the build runs with `autoEscape:false`).

Eta has an ASI gotcha: `<% (foo).bar() %>` is parsed as a method call on
the preceding string output. Prefix with `;`: `<% ;(foo).bar() %>`.

## Musings → media galleries (auto-synthesis)

Any musing with images in its body or `featured_image` automatically
becomes a media gallery at a derived path. Default:

- Post at `content/musings/travel/japan/suggestions/` → gallery at
  `/media/japan/suggestions` (first category segment dropped).
- Post at `content/musings/code/foo/` → gallery at `/media/code/foo`.

Override or opt out in frontmatter:

```yaml
gallery:
  path: australia/cairns/great-barrier-reef   # explicit override
  title: Great Barrier Reef                   # default = post title
  subtitle: Photos from a rough day.
  location: "Cairns, QLD, Australia"
  date: 2024-08-15
```

```yaml
gallery: false   # skip synthesis for this post
```

Synthesized galleries:
- Reuse the post's media files in place (no duplication, no separate thumb/med).
- Auto-create virtual ancestor gallery nodes so breadcrumbs + album tree work.
- Show a `↩ from the musing: <title>` link back to the source post.

## Adding a post

1. Create `content/musings/<category-path>/<slug>/index.md` with the required
   frontmatter (`title`, `date`, `tags`, `seo.description`, `seo.keywords`).
2. Generate `seo.description` (single natural sentence, < 160 chars — never
   "Blog post about X") and `seo.keywords` (obvious terms + 2–3 long-tail).
3. Write the body in markdown. Image syntax:
   - Full-width: `![alt](media/file.jpg)`
   - Inline (floated): `![alt](media/file.jpg){.inline}`
4. **Alt text** is the caption *and* the accessibility label *and* the
   image SEO. Keep it short. Don't pile in extra observations the user
   didn't ask for. "Vending machine on a random mountain." beats "A drink
   vending machine on a quiet path on a wooded mountain in Japan, with a
   small wooden bench beside it."

## Adding photos to a post

```bash
# put images in the post's media/ folder OR use staging/:
cp my-photos/*.jpg staging/
npm run media
```

The ingest script scrubs all EXIF (including GPS), groups bursts by
filename + capture time, and asks per-image alt + per-batch
gallery/date/location. Alt is required.

If you process images by hand instead, use `sharp` to resize (max 1800px
wide) and `mozjpeg` quality 85 — and strip metadata (sharp's default
behavior, just don't call `.withMetadata()`).

## Versioning

`v<N>` shown in the footer is `git rev-list --count HEAD`. Auto-increments
per commit. No manual bumping.

## PII pre-commit hook

`scripts/check-pii.mjs` runs on every commit (installed via `npm run setup`,
which sets `core.hooksPath` to `.githooks`). Scans the staged diff for:

- emails (outside `.pii-allowlist.yaml`)
- phone numbers, SSNs, credit-card-like (Luhn-checked)
- GPS coordinates in text
- precise ISO timestamps
- US street addresses (heuristic)
- EXIF GPS in staged image files

Allowlist known-public strings in `.pii-allowlist.yaml`. Bypass once with
`git commit --no-verify`. Don't bypass habitually.

## Build failures the script enforces

- Broken internal link (page route doesn't exist; asset extensions skipped)
- Missing image referenced from markdown
- Malformed frontmatter
- Missing required fields (`title`, `date` on musings; `title` on galleries)
- Missing `alt` on a `metadata.yaml` image entry
- `gallery.path` collision (musing-synthesized vs. real gallery)

## CI

`.github/workflows/deploy.yml` — on push to `main`: checkout (fetch-depth:
0 so the version-count works), `npm ci`, `npm run build`, upload
`_site` as the Pages artifact, deploy. No tests yet.

GitHub Pages is configured for **workflow** deploy (not legacy branch).
If you ever re-clone the repo and Pages is set to legacy, switch via:
`gh api -X PUT repos/<owner>/<repo>/pages -f build_type=workflow`.

## Tone & voice for me, claude

When writing copy, alt text, descriptions, or anything in the user's
voice: be terse. The user prefers short, plain, human writing over
descriptive AI-flavored prose. If asked to write a sentence, write one
sentence — not three with adjectives. When in doubt, write less.

When in doubt about content decisions, ASK before generating placeholder
text. The user wants to own the copy; the system is theirs to fill in.

## Don't add

- Frameworks, build tools beyond what's already here.
- "Smart" features the user didn't ask for (dark-mode auto-detect,
  reading progress bars, share buttons, comments, analytics).
- Hand-written SVGs more complex than basic shapes.
- Drop shadows, gradients, rounded SaaS-style cards. The aesthetic is
  late-90s/early-blogspot — flat, narrow column, mono chrome.
