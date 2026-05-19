---
name: pii-audit
description: Deep audit of staged or all content for sensitive information before publishing — beyond the regex pre-commit check.
---

# PII audit

Use before a push that includes new content, or when the user says "pii audit", "is this safe to publish", etc.

## What this is

The pre-commit hook (`scripts/check-pii.mjs`) catches obvious patterns: emails, phone numbers, SSNs, CC#s, GPS coords, precise timestamps, US street addresses. That's a sieve, not a guarantee.

This skill is a deeper, judgment-based audit. Use it when stakes are higher — e.g. publishing a travelogue with friends' names, or any post that mentions a workplace, a home, or a private person.

## Steps

1. Identify scope:
   - `staged` (default): `git diff --cached --unified=0` — what's about to be committed.
   - `recent`: last commit. (`git show HEAD`)
   - `all`: every file under `content/`.

2. For each chunk of new text, evaluate against this list:
   - **Other people's full names** — first names only is fine for friends; full names usually aren't, especially with a city.
   - **Home / workplace addresses** — any street-level location for a private person.
   - **Children's identifying info** — names, schools, birthdays.
   - **Health info** — diagnoses, medications, mental-health detail involving a private person.
   - **Financial detail** — exact salaries, account info, debt amounts tied to a person.
   - **Real-time location** — "I'm at X right now" style.
   - **Credentials** — API keys, passwords, anything that looks like a secret.
   - **License plates, VINs, account numbers.**

3. What's FINE (don't flag):
   - The author's own city, country, employer (if public).
   - Public figures' names and statements.
   - Restaurants, museums, public landmarks.
   - Generic dates (a vacation week, a trip year).

4. Output:
   - Group by severity: **block**, **review**, **note**.
   - For each: file + snippet + why + suggested redaction.

5. Never edit files automatically. Always wait for the user to decide.

## Allowlist

Strings in `.pii-allowlist.yaml` are pre-approved. Suggest adding to the allowlist when the user clears a flagged item that will recur.
