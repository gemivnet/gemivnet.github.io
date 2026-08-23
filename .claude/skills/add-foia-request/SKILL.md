---
name: add-foia-request
description: Add a records request to the /foia archive, or add a new response to one already there. Ingests a dump folder, classifies the documents, reconstructs the request timeline, and publishes to S3. Use when the user drops FOIA/public-records documents in dump/ or says "add this FOIA", "new records request", "another response came in".
---

# Add a FOIA / public-records request

The archive at `/foia` publishes documents obtained through records requests.
**No commentary.** The documents are the point; everything you write around them
is a finding aid.

Two modes. Work out which from what the user says.

- **New request** — a folder in `dump/` that isn't in the archive yet.
- **New response** — documents for a request that already has a
  `content/foia/<slug>/request.yaml`. Responses trickle in over months; this is
  the common case after the first ingest.

## The model, in one paragraph

One `content/foia/<slug>/request.yaml` per request. The documents live on S3,
never in the repo. **A release IS a timeline event** — there is no separate list
of releases; any event carrying `files:` is one. So the timeline is the complete
account of the request, and "the file listing for this dump" falls out of it.
A request that fanned out to several bodies or reference numbers uses `tracks:`,
which renders a JS-free filter.

## Steps

### 1. Inspect

```bash
node scripts/ingest-foia.mjs inspect dump/<folder>
```

Prints a JSON manifest on stdout (sha256, bytes, page count, a text preview per
file) and a human summary plus **PII findings** on stderr. Read the JSON. Nothing
is written and nothing is uploaded.

### 2. Read the correspondence

Any `.txt` in the dump is usually an exported email thread or a portal print-out.
**Read it in full.** It is where the timeline comes from — dates, reference
numbers, extensions, narrowing demands, fee fights, who said what.

Correspondence logs are **not published**. They routinely contain portal session
tokens, client IP addresses, the user's home address and personal phone number,
and third parties' private emails. The timeline replaces them: each exchange
becomes a dated event whose `note` carries the substance. Never copy a home
address, personal phone number, IP address, or session token into a note.

### 3. Triage the PII findings

Judgment, not a rule. Roughly:

- **Fine** — officials' work emails, phone numbers, and office addresses; agency
  general mailboxes; the Public Access Counselor's contact block; reference
  numbers that trip the phone regex.
- **Never** — portal session tokens (`(S(...))`), client IP addresses, the
  user's home address or personal mobile, bank details, SSNs, dates of birth.
- **Ask** — a private individual's personal email or phone inside a document the
  agency released. The user's standing decision is to **publish agency releases
  as received**: republishing a lawfully obtained public record is not a legal
  problem, and the agency owns its own redaction calls. Flag it, don't silently
  drop it, and don't re-raise a call already made.

Add genuinely public official contact details to `.pii-allowlist.yaml` so the
pre-commit hook stops flagging them.

### 4. Write request.yaml

Create `content/foia/<slug>/request.yaml`. Full field reference:
`reference/schema.md`. Rules that matter:

- `filed`, `title`, `agency` are required.
- `statute` names the actual law — `Illinois FOIA (5 ILCS 140)`,
  `Oregon Public Records Law (ORS 192.311–192.478)`, federal FOIA. Get this
  right; it drives the rights notice.
- `rights.note` — federal records are outside copyright under 17 U.S.C. § 105.
  **State, county and municipal records are not.** Never paste the § 105
  boilerplate onto a state or local request.
- `fees` — `quoted` is the standing estimate, `paid` is what actually changed
  hands. They differ constantly: withdrawn, waived, or still pending. The ledger
  on `/foia` strikes through quoted-but-never-paid.
- Event `type` comes from a closed set in `copy.yaml` under `foia.events`. The
  build rejects anything else and lists the valid types.
- Give each document a clean `file:` name — dated and readable
  (`2026-06-04-final-response-letter.pdf`), not the agency's
  `Main__George_-_Response_Letter_-_FOIA__R027405...pdf`. Keep the original in
  `dump_file:`; ingest maps one to the other.
- `dump_file:` is relative to `dump/`, not `dump/<slug>/` — so one archive entry
  can draw on several intake folders.

Write the timeline **oldest first**; the build sorts, but the file should read
as the story. Include the events with no documents — the follow-up when the
statutory clock ran out, the extension, the demand to narrow. That back-and-forth
is most of what a records request actually is, and the timeline is the only place
it's recorded.

### 5. SEO

`seo.description` — one natural sentence under 160 characters saying what the
records are. Never "Documents about X". `seo.keywords` — the obvious terms plus
the reference number and any statute or ordinance number; those are what someone
actually searches.

### 6. Summary (optional)

Only worth writing once a request has real volume. If you write one:

**Descriptive, never interpretive.** Say what the records *are* — counts, date
range, correspondents, document types, exemptions cited. Never what they *mean*,
*reveal*, or *suggest*. "No commentary" is the whole premise of the archive, and
it is also what makes a machine-written summary defensible.

```yaml
summary:
  text: |
    Three releases, 612 pages, between March and June 2026 ...
  generated_by: "Claude (Opus 5)"
  generated_on: 2026-08-22
  reviewed: false        # true once the user has actually read it
```

`generated_by` and `generated_on` are **mandatory** when `text` is present — the
build fails without them. An AI summary cannot ship without its disclosure.

### 7. Publish

```bash
node scripts/ingest-foia.mjs publish <slug>
```

Hashes each file, counts PDF pages, builds a per-release ZIP where a release has
more than one document, uploads everything to S3, rewrites `request.yaml` with
`s3`/`bytes`/`sha256`/`pages`, and **deletes the consumed originals from
`dump/`** — but only after each upload is confirmed.

If the CLI is missing **or has no usable credentials**, it writes
`dump/UPLOAD-<slug>.sh` with the exact commands, deletes nothing, and still
records the final S3 URLs. Those pages 404 until the user runs it. Say so
plainly rather than implying the archive is live.

The CLI is a per-user install at
`%LOCALAPPDATA%\Programs\Amazon\AWSCLIV2\aws.exe`; the script resolves it there
directly because an already-running shell won't have picked up the PATH entry.
Credentials come from `aws login` (temporary, browser-based) or
`aws configure` — both need a **real console window**, not the `!` prefix or a
tool-run shell, which have no TTY and die on the first prompt. If
`aws sts get-caller-identity` fails, stop and ask the user to authenticate
rather than starting an upload that will fail halfway.

### 8. Verify

```bash
npm run build          # must exit 0
npm run check:links
```

Then `npm run dev` and look at `/foia`, the request page, a release, a document.

## Don't

- Don't publish the raw correspondence logs.
- Don't editorialise — no "troubling", "reveals", "stonewalled". Dates,
  citations, and what each side said.
- Don't invent a page count, a hash, or a date. `inspect` produces the first two;
  the correspondence produces the third.
- Don't commit PDFs to the repo. They go to S3.
- Don't put the user's home address, personal mobile, or a client IP in a note.
