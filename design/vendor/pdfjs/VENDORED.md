# Vendored pdf.js

Third-party code. **Do not hand-edit any file in this folder.** To change
versions, re-vendor from npm following the steps below.

| | |
|---|---|
| Package | [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) (Mozilla) |
| Version | **4.10.38** |
| Build | `legacy` |
| License | Apache-2.0 — see `LICENSE` |
| Vendored | 2026-08-22 |

## Why this is here

The FOIA archive (`/foia`) needs a PDF reader that works the same everywhere.
Handing a PDF to the browser's own viewer in an `<iframe>` is free, but iOS
Safari and Chrome on Android routinely refuse to render one inline and fall back
to a download prompt — which would make the reader desktop-only. pdf.js renders
to a canvas, so it behaves identically on every browser.

This is the only vendored library in the site build. `content/sites/*` also
contains built third-party bundles, but those are separate self-contained apps
passed through verbatim; this one is loaded by the site's own templates.

## What's here, and what isn't

| Path | Size | Why |
|---|---|---|
| `pdf.min.mjs` | 389 KB | The API. Loaded by `templates/foia-document.eta`. |
| `pdf.worker.min.mjs` | 1.4 MB | Parsing/rendering worker. Fetched by the API, never imported directly. |
| `standard_fonts/` | 804 KB | Substitutes for the 14 PDF standard fonts. |
| `LICENSE` | | Apache-2.0. |

`standard_fonts/` is **not optional here.** PDFs are allowed to reference
Helvetica, Times, Courier, Symbol, and ZapfDingbats without embedding them, and
agency FOIA releases very often do. Without this folder those documents render
with missing or wrong glyphs.

**`cmaps/` is deliberately excluded** (1.5 MB, 169 files). It supplies character
maps for CJK text. US federal records essentially never need it, and a document
that does will still render — only its CJK runs would be missing. Add the folder
and set `cMapUrl` in the viewer if that ever turns up.

The `legacy` build is used rather than the modern one. It costs ~90 KB more, and
in exchange it supports older browsers and is the build Mozilla documents for
running under Node — which `scripts/ingest-foia.mjs` relies on to count pages.

## Integrity

```
44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72  pdf.min.mjs
bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d  pdf.worker.min.mjs
```

Verify with `sha256sum design/vendor/pdfjs/*.mjs`.

## Re-vendoring

```bash
cd "$(mktemp -d)"
npm pack pdfjs-dist@<version>
tar -xzf pdfjs-dist-<version>.tgz

cd /path/to/gemivnet.github.io
cp "$TMP/package/legacy/build/pdf.min.mjs"        design/vendor/pdfjs/
cp "$TMP/package/legacy/build/pdf.worker.min.mjs" design/vendor/pdfjs/
cp "$TMP/package/standard_fonts/"*                design/vendor/pdfjs/standard_fonts/
cp "$TMP/package/LICENSE"                         design/vendor/pdfjs/
sha256sum design/vendor/pdfjs/*.mjs   # update the table above
```

`pdfjs-dist` is intentionally **not** in `package.json`. Adding it would pull a
25 MB package into `npm ci` on every CI run to ship two files. `copyDesign()` in
`scripts/build.mjs` copies this folder to `_site/vendor/pdfjs/`.

After re-vendoring, check the API surface the viewer actually uses still exists —
`getDocument`, `GlobalWorkerOptions.workerSrc`, `doc.numPages`,
`page.getViewport`, `page.render`. pdf.js has broken these across majors before.
