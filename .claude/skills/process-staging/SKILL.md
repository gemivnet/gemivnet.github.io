---
name: process-staging
description: Walk the staging/ folder, scrub EXIF, prompt for per-image metadata, and move into the right gallery.
---

# Process staging media

Use when the user says "process staging", "ingest those photos", "add the staging images", or has just dropped files into `staging/`.

This skill is the friendly Claude-Code wrapper around `npm run media`. The interactive Node script does the heavy lifting; this skill lets the user run it from a chat without remembering the command.

## Steps

1. Check `staging/` for image files (jpg/jpeg/png/heic/heif/webp).
2. If empty: tell the user to drop files in `staging/` and try again.
3. If files exist: tell the user you're going to run `npm run media`, and that the script will:
   - Group files into bursts (same filename prefix + capture time within 30 min).
   - Read EXIF for date + GPS hint (GPS is **stripped on save**).
   - Ask gallery (existing # or new path), batch date, batch location, rename?
   - For each image, ask title (optional) and **alt** (REQUIRED).
   - Strip ALL metadata on output.
   - Move file from staging into `content/media/<gallery>/`.
   - Append entry to `metadata.yaml`.
4. After the script finishes, suggest the user run `npm run build` and review `_site/media/`.

## Tips

- If the user wants to *batch-set* gallery and metadata without per-file prompting, run with everything in one staging burst — the script asks gallery/date/location once per burst.
- The pre-commit PII hook also scans staged image EXIF — even if you skip this script and just copy files in manually, GPS leaks will be caught at commit time.
- Original filenames are preserved by default unless the user opts into `img_NNN` renaming.
