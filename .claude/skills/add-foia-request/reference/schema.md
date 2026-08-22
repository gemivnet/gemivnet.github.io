# request.yaml — full field reference

One file per request at `content/foia/<slug>/request.yaml`. The folder name is
the slug and becomes `/foia/<slug>`. Reserved slugs the build rejects: `agency`,
`tag`, `tags`, `index`.

## Top level

| Field | Required | Notes |
|---|---|---|
| `title` | **yes** | Plain description of what was sought. Not the reference number. |
| `agency` | **yes** | Full name of the body. Drives `/foia/agency/<slug>`. |
| `agency_short` | | Short form for chips and the ledger. Defaults to `agency`. |
| `also_agencies` | | List of other bodies. Puts a grouped request on their agency pages too. |
| `jurisdiction` | | `us-federal` \| `us-state` \| `us-local` \| `other`. Default `us-federal`. |
| `statute` | | e.g. `Illinois FOIA (5 ILCS 140)`. Default `FOIA`. |
| `tracking` | | Primary reference number. Per-track numbers go on the events. |
| `status` | | `open` \| `partial` \| `complete` \| `denied` \| `appealed` \| `withdrawn` \| `no-records`. Default `open`. |
| `filed` | **yes** | `YYYY-MM-DD`. |
| `closed` | | `YYYY-MM-DD`. |
| `category` | | Single segment, e.g. `aviation`, `streets`. |
| `tags` | | List. Each becomes `/foia/tag/<slug>`. |
| `seo` | | `description` (one sentence, <160 chars) and `keywords` (list). |
| `summary` | | See below. |
| `rights` | | `note:` — the rights statement for these particular records. |
| `fees` | | See below. |
| `tracks` | | See below. Only for multi-pronged requests. |
| `timeline` | **yes** | See below. |

## summary

```yaml
summary:
  text: |
    Free text. Descriptive only.
  generated_by: "Claude (Opus 5)"   # required when text is present
  generated_on: 2026-08-22          # required when text is present
  reviewed: false                   # true = user has read it line by line
```

The build **fails** if `text` is set without `generated_by` and `generated_on`.
`reviewed` selects which of the two disclosure sentences in `copy.yaml`
(`foia.summary.disclosure` / `disclosure_reviewed`) is rendered beneath it.

## fees

```yaml
fees:
  quoted: 780        # standing estimate, number, no currency symbol
  paid: 0            # what actually changed hands
  pending: true      # agreed but not yet paid
  waiver: upheld     # requested | granted | denied | upheld
  note: >-
    Free text explaining the sequence.
```

`quoted` and `paid` differ constantly — withdrawn, waived, or still open. The
ledger on `/foia` strikes through a quoted figure that was never paid, and totals
only `paid`. `waiver: upheld` means denied and the denial survived review.

## tracks

Only when a request fanned out — several agencies, several reference numbers, or
a federal and a local prong of the same investigation. Two or more tracks render
a CSS-only filter above the timeline.

```yaml
tracks:
  - id: village-airport          # slug, referenced by events
    label: Village · R027405     # shown on the chip and in the filter
  - id: faa
    label: FAA · 2026-03294
```

An event with no `track` is never hidden by the filter — it belongs to every
prong. An event naming a track not declared here fails the build.

## timeline

Ordered list. The build sorts oldest-first regardless, but write it in order.

```yaml
timeline:
  - id: 2026-06-05-final       # unique within the request; becomes the URL segment
    date: 2026-06-05           # required
    type: final                # required, closed set — see below
    track: village-airport     # optional, must match a declared track
    title: Final response      # defaults to the type label
    note: >-                   # the substance of this exchange
      What happened, factually.
    tracking: R027405-042826   # optional, per-event reference number
    exemptions: ["(b)(5)"]     # optional, cited withholdings
    files: [...]               # optional — an event with files IS a release
    zip:                       # written by ingest, don't hand-author
      s3: https://...
      bytes: 3900000
      sha256: "..."
```

### Event types

From `copy.yaml` under `foia.events`. The build rejects anything else and prints
the valid list.

| type | meaning |
|---|---|
| `filed` | request submitted |
| `acknowledged` | agency confirms receipt, usually assigning a number |
| `interim` | a release, more to come |
| `partial` | a release with withholdings |
| `final` | the closing release |
| `denial` | denied in full |
| `no-records` | searched, nothing responsive |
| `appeal` | requester appeals or petitions |
| `appeal-decision` | the appeal body rules |
| `referral` | handed to another component or agency |
| `fee` | fee estimate, demand, or agreement |
| `extension` | statutory extension |
| `narrowing-request` | agency asks the requester to narrow |
| `amended` | requester narrows or amends |
| `withdrawn` | requester withdraws |
| `litigation` | suit filed |
| `note` | anything else worth recording |

### files

```yaml
files:
  - id: response-letter                    # URL segment; defaults from the filename
    dump_file: clow-airport-foia/Main__George_-_Response_Letter_...pdf
    file: 2026-06-04-final-response-letter.pdf   # clean published name
    title: Final response letter           # required
    description: >-                        # optional, shown in listings
      What this document is.
    exemptions: ["(b)(6)"]                 # optional
    # written by ingest:
    bytes: 152761
    sha256: "..."
    pages: 6
    s3: https://georgemain-com-media.s3.amazonaws.com/foia/<slug>/<event>/<file>
```

`dump_file` is relative to `dump/`, **not** `dump/<slug>/` — so one archive entry
can pull from several intake folders. `publish` replaces it with `s3` and deletes
the original once the upload is confirmed.

A document needs either an `s3` URL or a local file at
`content/foia/<slug>/files/<event-id>/<file>`. The local path is a fallback for
working without S3; don't commit PDFs that way.

Non-PDF files are fine — spreadsheets, images, CSVs. They get a document page
with metadata and a download, but no in-page viewer.
