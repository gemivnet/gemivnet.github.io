// Pull the recipe cards from the recipes project into content/recipes/.
//
//   npm run recipes:import              # every card
//   npm run recipes:import -- bagels    # just these slugs
//
// The cards are Typst files in <recipes.source>/src/. Their shared template
// (template/recipe.typ) drops the card's data into invisible metadata()
// elements, so `typst eval 'query(metadata)'` hands back exactly what the PDF
// was typeset from: header, steps with their ingredients, swaps and notes.
// This script turns that into content/recipes/<slug>/recipe.json and copies the
// card's PDF next to it, so the site build needs neither typst nor the recipes
// folder, and CI can build from the repo alone.
//
// A card whose PDF is older than its source is rebuilt first with the recipes
// project's own build.sh, so the print page is never a stale card.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = yaml.load(await fs.readFile(path.join(ROOT, 'site.config.yaml'), 'utf8')).recipes;
const SRC = path.resolve(ROOT, CFG.source);
const OUT = path.join(ROOT, 'content', 'recipes');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mtime = async (p) => (await fs.stat(p).catch(() => null))?.mtimeMs ?? 0;

// ── Typst content → HTML ─────────────────────────────────────
// Only the node types the cards actually use. Anything else is an error, so a
// new markup feature in a card shows up here rather than vanishing on the site.
function toHtml(node, where) {
  let out = '';
  const emit = (n) => {
    if (n == null) return;
    if (typeof n === 'string' || typeof n === 'number') { out += escapeHtml(n); return; }
    if (Array.isArray(n)) { n.forEach(emit); return; }
    switch (n.func) {
      case 'sequence': n.children.forEach(emit); return;
      case 'text': case 'symbol': out += escapeHtml(n.text); return;
      case 'space': out += ' '; return;
      case 'smartquote': {
        const prev = out.replace(/<[^>]*>/g, '').slice(-1);
        const opening = !prev || /[\s(\[  ]/.test(prev);
        out += n.double ? (opening ? '“' : '”') : (opening ? '‘' : '’');
        return;
      }
      // box = "keep together" (ranges, temperatures); styled = the muted °C.
      case 'box': out += '<span class="rc-nw">'; emit(n.body); out += '</span>'; return;
      case 'styled': out += '<span class="rc-muted">'; emit(n.child); out += '</span>'; return;
      case 'strong': out += '<strong>'; emit(n.body); out += '</strong>'; return;
      case 'emph': out += '<em>'; emit(n.body); out += '</em>'; return;
      default: throw new Error(`${where}: unsupported Typst content '${n.func}'`);
    }
  };
  emit(node);
  return out.trim();
}
const html = (v, where) => (v == null ? null : toHtml(v, where));

// Paperless numbers are the user's own document-archive ids: meaningless to a
// reader, so the credit line drops them. The PDF keeps its footer as printed.
const cleanSource = (s) => s == null ? null : s
  .replace(/,?\s*Paperless #\d+/g, '')
  .replace(/\(\s*\)/g, '')
  .replace(/\s+;/g, ';')
  .replace(/\s{2,}/g, ' ')
  .trim();

function convert(slug, metas) {
  const by = (label) => metas.filter(m => m.label === label).map(m => m.value);
  const [meta] = by('recipe-meta');
  const [steps] = by('recipe-steps');
  if (!meta) throw new Error(`${slug}: no recipe-meta. Is the template up to date?`);
  if (!steps) return null; // a reference card (calorie table), not a recipe
  const w = (field) => `${slug}.${field}`;

  const ing = (i, k) => ({
    name: html(i.name, w(`ing${k}.name`)),
    g: typeof i.g === 'number' ? i.g : html(i.g, w(`ing${k}.g`)),
    vol: html(i.vol, w(`ing${k}.vol`)),
    note: html(i.note, w(`ing${k}.note`)),
    kcal: i.kcal, na: i.na, pro: i.pro,
    counted: i.counted, countedNote: html(i['counted-note'], w(`ing${k}.counted-note`)),
    // Plain name for merging nutrition rows the way the template does.
    key: typeof i.name === 'string' ? i.name : JSON.stringify(i.name),
  });

  const [swaps] = by('recipe-swaps');
  const [notes] = by('recipe-notes');
  return {
    slug,
    title: typeof meta.title === 'string' ? meta.title : toHtml(meta.title, w('title')),
    category: meta.category,
    yield: html(meta.yield, w('yield')),
    servings: meta.servings,
    active: html(meta.active, w('active')),
    total: html(meta.total, w('total')),
    oven: html(meta.oven, w('oven')),
    equipment: (meta.equipment || []).map((e, k) => html(e, w(`equipment${k}`))),
    source: meta.source == null ? null
      : typeof meta.source === 'string' ? escapeHtml(cleanSource(meta.source))
      : cleanSource(toHtml(meta.source, w('source'))),
    revised: meta.revised,
    items: steps.items.map((it, k) => it.kind === 'stage'
      ? { kind: 'stage', name: html(it.name, w(`stage${k}`)) }
      : { kind: 'step', ings: it.ings.map((i, j) => ing(i, `${k}.${j}`)), body: html(it.body, w(`step${k}`)) }),
    nutritionSource: html(steps['nutrition-source'], w('nutrition-source')),
    swaps: swaps ? {
      header: swaps.header.map(h => html(h, w('swaps.header'))),
      rows: swaps.rows.map((r, k) => ({
        original: html(r.original, w(`swap${k}`)),
        alts: r.alts.map(a => html(a, w(`swap${k}.alt`))),
      })),
    } : null,
    notes: notes ? notes.map((n, k) => html(n, w(`note${k}`))) : [],
  };
}

async function main() {
  const wanted = process.argv.slice(2).map(s => s.replace(/\.typ$/, ''));
  const all = (await fs.readdir(path.join(SRC, 'src'))).filter(f => f.endsWith('.typ')).map(f => f.slice(0, -4)).sort();
  const slugs = wanted.length ? wanted : all;
  for (const s of slugs) if (!all.includes(s)) throw new Error(`no card ${s}.typ in ${path.join(SRC, 'src')}`);

  const stale = [];
  for (const s of slugs) {
    if (await mtime(path.join(SRC, 'src', `${s}.typ`)) > await mtime(path.join(SRC, 'pdf', `${s}.pdf`))
      || await mtime(path.join(SRC, 'template', 'recipe.typ')) > await mtime(path.join(SRC, 'pdf', `${s}.pdf`))) stale.push(s);
  }
  if (stale.length) {
    console.log(`· rebuilding ${stale.length} stale PDF(s): ${stale.join(', ')}`);
    execFileSync(path.join(SRC, 'build.sh'), stale, { cwd: SRC, stdio: 'inherit' });
  }

  const skipped = [];
  let written = 0;
  for (const slug of slugs) {
    const raw = execFileSync('typst', [
      'eval', 'query(metadata).map(m => (label: str(m.label), value: m.value))',
      '--root', SRC, '--font-path', path.join(SRC, 'fonts'),
      '--in', path.join(SRC, 'src', `${slug}.typ`), '--format', 'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const recipe = convert(slug, JSON.parse(raw));
    const dir = path.join(OUT, slug);
    if (!recipe) {
      skipped.push(slug);
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }
    const pdf = path.join(SRC, 'pdf', `${slug}.pdf`);
    const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    recipe.pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1]) || 1;
    recipe.pdf = `${slug}.pdf`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify(recipe, null, 2) + '\n');
    await fs.copyFile(pdf, path.join(dir, recipe.pdf));
    written++;
  }

  // A full import mirrors the source: a card deleted there goes here too.
  if (!wanted.length) {
    for (const d of await fs.readdir(OUT).catch(() => [])) {
      if (!all.includes(d)) {
        await fs.rm(path.join(OUT, d), { recursive: true, force: true });
        console.log(`· removed ${d} (no longer in ${CFG.source}/src)`);
      }
    }
  }

  console.log(`✓ ${written} recipe(s) imported into content/recipes/`);
  if (skipped.length) console.log(`· skipped (no steps, not a recipe): ${skipped.join(', ')}`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
