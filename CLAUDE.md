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
- `content/foia/<slug>/request.yaml` — public-records requests. See below.
- `content/sites/<name>/` — verbatim passthrough to `/sites/<name>/`.
- `design/vendor/pdfjs/` — the only vendored library. Copied to
  `_site/vendor/`. Provenance and re-vendoring steps in its `VENDORED.md`.
- `scripts/lib/` — the two things more than one script needs:
  `pii-patterns.mjs` (shared by the hook and the FOIA pre-flight) and
  `zip.mjs` (zero-dep ZIP writer over `node:zlib`).
- `staging/` — gitignored intake for media. `npm run media` ingests.
- `dump/` — gitignored intake for FOIA documents. `npm run foia:publish`
  consumes and deletes on successful upload.

## Common workflows

```bash
npm run setup        # one-time: installs git hooks
npm run build        # writes _site/
npm run dev          # build + local server on :4321
npm run media        # interactive media ingest from staging/
npm run foia:inspect dump/<folder>   # hash, page-count and PII-scan a dump
npm run foia:publish <slug>          # upload to S3, rewrite yaml, clear dump/
npm run check:pii    # manually run the PII scanner
```

**Shell out to git with `execFileSync`, never `execSync`.** `execSync` routes
through `cmd.exe` on Windows, which refuses a UNC working directory and
silently runs from `C:\Windows` instead. The repo lives on a network share
(`N:` = `\\server\nas`), where that made the PII hook unable to read its own
staged diff — so, failing closed, it refused every commit — and made the
version fall back to `v1` with an empty changelog.

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

**Outstanding:** the `.foia-*` rules at the end of `site.css` are hand-written
(2026-08-22) and marked as ad-hoc. Feed them to Claude Design and fold them
into the next bundle so the prototype and the live site don't drift.

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

## FOIA archive (`/foia`)

A public archive of documents obtained under FOIA and state public-records
law. **No commentary** — the documents are the point; everything written
around them is a finding aid.

One `content/foia/<slug>/request.yaml` per request. Full field reference lives
in `.claude/skills/add-foia-request/reference/schema.md`; use the
`add-foia-request` skill rather than hand-authoring.

**The modelling decision: a release IS a timeline event.** There is no
separate list of releases — any event carrying `files:` is one. The timeline
is therefore the complete account of a request, and "the file listing for this
dump" falls out of it for free. A request that fanned out across agencies or
reference numbers declares `tracks:`, which renders a JS-free lane filter; the
Clow entry interleaves twenty events across three.

Documents live on **S3, never in the repo** — GitHub Pages caps a published
site at 1 GB and one release here is already 23 MB. Each file records its
size, page count and sha256. A local fallback at
`content/foia/<slug>/files/<event-id>/<file>` exists for working without S3;
don't commit PDFs that way.

### Things that will bite you

- **Rights language is per-jurisdiction.** 17 U.S.C. § 105 puts *federal*
  works outside copyright and does **not** cover state, county or municipal
  records. Never paste that boilerplate onto a non-federal request — it would
  be a false claim on the face of the site.
- **S3 needs CORS**, because pdf.js fetches bytes via XHR (unlike `<img>`).
  The bucket allows `https://georgemain.com` and `http://localhost:4321`, and
  exposes `Content-Length`/`Content-Range`/`Accept-Ranges`/`ETag` so range
  requests work — without those the viewer downloads a whole 23 MB file before
  painting page 1.
- **`<a download>` is ignored cross-origin.** The viewer's download button
  builds a Blob from the bytes pdf.js already holds; a plain link to the S3
  object would just navigate.
- `serve.mjs` must map `.mjs` to a real JS type or the module script silently
  never executes under `npm run dev`.
- Correspondence logs (`dump/**/*.txt`) are the **source** for timelines, not
  content. They are never published — they routinely carry portal session
  tokens, client IPs, and the user's home address and personal mobile.

### Design

This was built wrong the first time: a stack of bordered notice boxes above a
seven-column table, with the same requests repeated underneath as cards, and
timeline entries wearing a glyph column, a rail and bordered pills. It read
like a dashboard on a site that is a narrow flat column.

The idiom to reach for is the build log's dated list (`timeline-index.eta`):
rules rather than borders, one muted sub-line for everything secondary, and a
single quiet footnote instead of stacked notices. Procedural events
(acknowledgements, extensions, follow-ups, the requester narrowing again)
collapse into one foldable line. Two constraints on that folding: a run may
never span tracks, or the lane filter can't reach inside it; and anything
carrying documents stays out of a fold whatever its type.

### AI disclosure

The timelines, titles, descriptions and summaries are machine-written and must
say so. `/foia` and every request page carry a standing disclosure, and **the
build fails if `summary.text` has no `generated_by` + `generated_on`.** A
summary must be descriptive — what the records *are*, their counts, dates,
correspondents, cited exemptions — and never interpretive. That is what "no
commentary" requires and what keeps a machine-written summary defensible.

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
- portal session tokens and bank/DOB shapes (added for the FOIA archive)
- EXIF GPS in staged image files

The patterns live in `scripts/lib/pii-patterns.mjs` so the FOIA ingest
pre-flight scans documents against exactly the same rules. Edit them there,
not in the hook.

Allowlist known-public strings in `.pii-allowlist.yaml`. Bypass once with
`git commit --no-verify`. Don't bypass habitually.

**If it starts crying wolf, fix the pattern, not the allowlist.** Records
reference numbers (`S106782-061225`) and sha256 substrings both read as phone
numbers until the pattern gained lookarounds rejecting digit runs inside a
longer alphanumeric token. A scanner that fires on every commit in a section
just teaches you `--no-verify`, which is worse than no scanner. Minified
vendored bundles are skipped wholesale for the same reason — `4294967296` is
2³², not a phone number.

The hook **fails closed**: if it can't read the diff it refuses the commit
rather than waving it through. That is correct, and it means an unrelated
breakage (see the `execFileSync` note above) presents as "every commit is
blocked".

## Build failures the script enforces

- Broken internal link (page route doesn't exist; asset extensions skipped)
- Missing image referenced from markdown
- Malformed frontmatter
- Missing required fields (`title`, `date` on musings; `title` on galleries;
  `title`/`agency`/`filed` on FOIA requests)
- Missing `alt` on a `metadata.yaml` image entry
- `gallery.path` collision (musing-synthesized vs. real gallery)
- FOIA: unknown event `type`, an event referencing an undeclared `track`,
  duplicate event or document ids, a request slug shadowing a reserved route
  (`agency`, `tag`, `tags`, `index`), a document with neither an `s3` URL nor
  a local file, an unknown `fees.waiver` value
- FOIA: `summary.text` without `summary.generated_by` + `summary.generated_on`
  — an AI summary cannot ship without its disclosure

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
sentence, not three with adjectives. When in doubt, write less.

When in doubt about content decisions, ASK before generating placeholder
text. The user wants to own the copy; the system is theirs to fill in.

**Terseness governs what I write, never what the user wrote.** Reproduce
their copy verbatim. Do not tighten, compress, or drop sentences to fit the
rule above; the only reason to remove their words is PII or a change already
agreed. If a caption looks long for alt text, ship it and say why you'd
shorten it. Flag every editorial change to their wording individually, even
a name swap. (Learned the hard way 2026-08-24: nine build-log captions came
back compressed, four of them missing real content.)

### No em dashes. Anywhere.

Site-wide rule as of 2026-08-24: never use `—` (U+2014). Use a period or a
comma. A period where the dash joined two independent clauses, a comma where
it set off an appositive or introduced a list.

This covers prose, alt text, `copy.yaml`, template strings, page `<title>`
separators, commit messages, and code comments. Where `—` was doing duty as
an empty-value glyph (an unpriced table cell, a missing stat) use `-`. Where
it was a leading marker before a parenthetical, drop it.

`scripts/build.mjs` keeps `mdash: '—'` in its HTML-entity decode map. That is
a decoder, not output; leave it.

The one place em dashes survive is `/changelog`, which renders git commit
subjects and so reflects ten historical commits written before this rule.

## Don't add

- Frameworks, build tools beyond what's already here.
- "Smart" features the user didn't ask for (dark-mode auto-detect,
  reading progress bars, share buttons, comments, analytics).
- Hand-written SVGs more complex than basic shapes.
- Drop shadows, gradients, rounded SaaS-style cards. The aesthetic is
  late-90s/early-blogspot — flat, narrow column, mono chrome.
- Bordered boxes stacked on bordered boxes. Rules beat borders; one muted
  sub-line beats a grid of labelled cells; a footnote beats a callout. If a
  new page type is growing notice blocks above the content, or showing the
  same records twice in two shapes, it has drifted into dashboard and needs
  subtracting from. Check what an existing page type already does before
  inventing a layout — the answer is usually the dated list.
