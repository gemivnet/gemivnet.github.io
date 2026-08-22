// PII detection patterns, shared by the pre-commit hook and the FOIA ingest
// pre-flight.
//
// Extracted from check-pii.mjs so both callers use one definition. It lives in
// its own module because check-pii.mjs runs its scan at import time and calls
// process.exit() — importing it to borrow the patterns would run the whole
// pre-commit scan as a side effect.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export const luhn = (s) => {
  const d = s.replace(/\D/g, '').split('').reverse().map(Number);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = d[i];
    if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
};

/** Read .pii-allowlist.yaml and return an `isAllowed(match)` predicate. */
export function loadAllowlist(root) {
  const p = path.join(root, '.pii-allowlist.yaml');
  const allowed = new Set();
  if (existsSync(p)) {
    try {
      const y = yaml.load(readFileSync(p, 'utf8'));
      (y?.allowed || []).forEach((s) => allowed.add(String(s)));
    } catch (e) {
      console.error('[pii] failed to read .pii-allowlist.yaml:', e.message);
    }
  }
  return (m) => {
    if (allowed.has(m)) return true;
    for (const a of allowed) if (a && m.includes(a)) return true;
    return false;
  };
}

/** Build the pattern list. `isAllowed` comes from loadAllowlist(). */
export function buildPatterns(isAllowed) {
  return [
    {
      name: 'email',
      re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      test: (m) => !isAllowed(m),
    },
    {
      name: 'phone (US/intl)',
      // The lookarounds keep this off digit runs that are part of a longer
      // alphanumeric token. Without them the FOIA archive trips it constantly:
      // records reference numbers (S106782-061225, R027405-042826, Or2024-0013710)
      // and 12-digit substrings of a sha256 all read as phone numbers, and a
      // scanner that cries wolf on every commit just teaches you --no-verify.
      // A real number is still caught — "(630) 226-8416" matches from the 6,
      // preceded by "(", which is not alphanumeric.
      re: /(?<![A-Za-z0-9])\+?\d[\d ()\-.]{8,}\d(?![A-Za-z0-9])/g,
      test: (m) => {
        const digits = m.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) return false;
        if (luhn(digits)) return false; // probably a CC, separately flagged
        return true;
      },
    },
    { name: 'SSN-like', re: /\b\d{3}-\d{2}-\d{4}\b/g, test: () => true },
    { name: 'credit card-like', re: /\b(?:\d[ -]?){13,19}\b/g, test: (m) => luhn(m) },
    { name: 'GPS coordinates', re: /-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/g, test: () => true },
    { name: 'precise timestamp', re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\b/g, test: () => true },
    {
      name: 'US street address',
      re: /\b\d{1,5}\s+([A-Z][a-z]+\s){1,3}(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Court|Ct|Pl|Place)\b\.?/g,
      test: (m) => !isAllowed(m),
    },
    // ── FOIA-specific ────────────────────────────────────────
    // Records portals (GovQA, NextRequest) put a session id straight in the URL.
    // Publishing one is a live-credential leak, and it turns up in pasted email
    // threads constantly — which is exactly what the correspondence log is.
    {
      name: 'session token in URL',
      re: /\(S\([a-z0-9]{16,}\)\)|[?&](sid|sessionid|token|auth)=[A-Za-z0-9._-]{12,}/gi,
      test: () => true,
    },
    // Bank routing/account pairs occasionally survive a bad redaction on
    // invoices and payment records.
    {
      name: 'bank routing-like',
      re: /\b(?:routing|aba|acct|account)\s*(?:#|no\.?|number)?\s*:?\s*\d{6,17}\b/gi,
      test: () => true,
    },
    {
      name: 'date of birth',
      re: /\b(?:DOB|D\.O\.B\.|date of birth)\s*:?\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/gi,
      test: () => true,
    },
  ];
}

/**
 * Run every pattern over a blob of text.
 * @returns {{type: string, match: string, context: string}[]}
 */
export function scanText(text, isAllowed) {
  const patterns = buildPatterns(isAllowed);
  const hits = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      const match = m[0];
      if (isAllowed(match)) continue;
      if (!p.test(match)) continue;
      const at = m.index;
      hits.push({
        type: p.name,
        match,
        context: text.slice(Math.max(0, at - 50), at + match.length + 50).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return hits;
}
