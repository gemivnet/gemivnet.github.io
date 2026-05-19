// One-off: upload all 5 outback/mona galleries with proper slugs + alt text.
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yaml from 'js-yaml';
import exifr from 'exifr';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUCKET = 'georgemain-com-media';
const BASE = `https://${BUCKET}.s3.amazonaws.com`;

const formatShutter = (t) => t == null ? null : t >= 1 ? t + 's' : '1/' + Math.round(1/t);

function s3up(local, key) {
  execFileSync('aws', ['s3', 'cp', local, `s3://${BUCKET}/${key}`,
    '--content-type', 'image/jpeg',
    '--cache-control', 'public, max-age=31536000, immutable',
    '--no-progress'], { stdio: ['ignore', 'ignore', 'inherit'] });
  return `${BASE}/${key}`;
}

const GALLERIES = [
  {
    folder: 'uluru_outback', path: 'australia/outback/uluru',
    title: 'Uluru', subtitle: 'Ayers Rock at every hour of the day.',
    location: 'Uluru-Kata Tjuta National Park, NT, Australia',
    desc: 'Photos of Uluru (Ayers Rock) from midday through sunset.',
    keywords: ['Uluru', 'Ayers Rock', 'Outback', 'Northern Territory'],
    photos: [
      ['DSC03149.JPG', 'uluru-wide-daytime',     'Uluru from a distance, midday.'],
      ['DSC03282.JPG', 'uluru-sunset',           'Uluru glowing red at sunset.'],
      ['DSC03295.JPG', 'uluru-cliff-detail',     "Cliff face of Uluru at sunset, close-up."],
      ['DSC03308.JPG', 'uluru-profile',          'Side profile of Uluru in evening light.'],
      ['DSC03313.JPG', 'outback-sky-clouds',     'Dramatic clouds with sun breaking through.'],
      ['DSC03326.JPG', 'adventure-tours-bus',    'The Adventure Tours bus.'],
      ['DSC03330.JPG', 'uluru-behind-grass',     'Uluru visible above tall grass and a fence.'],
      ['DSC03337.JPG', 'red-dirt-tire-tracks',   'Tire tracks in red outback dirt.'],
      ['DSC03342.JPG', 'uluru-from-viewpoint',   'Uluru framed by grass at a viewpoint.'],
      ['DSC03346.JPG', 'uluru-dusk',             'Uluru at dusk from the viewing area.'],
      ['DSC03347.JPG', 'uluru-cliff-face-close', "Uluru's cliff face at sunset, close."],
      ['DSC03370.JPG', 'uluru-distant-dusk',     'Uluru in the distance at dusk.'],
      ['DSC03383.JPG', 'outback-sunset',         'Sunset over the outback.'],
    ],
  },
  {
    folder: 'olgas_outback', path: 'australia/outback/kata-tjuta',
    title: 'Kata Tjuta (The Olgas)', subtitle: 'The Valley of the Winds.',
    location: 'Uluru-Kata Tjuta National Park, NT, Australia',
    desc: 'Photos of Kata Tjuta (The Olgas) — the domed rock formations west of Uluru.',
    keywords: ['Kata Tjuta', 'The Olgas', 'Valley of the Winds', 'Outback'],
    photos: [
      ['DSC03146.JPG', 'kata-tjuta-from-lookout',  'The domes of Kata Tjuta from a distant lookout.'],
      ['DSC03177.JPG', 'valley-of-the-winds-entry','Hikers walking between two domes at the entry.'],
      ['DSC03183.JPG', 'valley-of-the-winds-trail','Hikers heading up the Valley of the Winds trail.'],
      ['DSC03184.JPG', 'pitted-rock-wall',         'Pock-marked surface of a Kata Tjuta dome.'],
      ['DSC03187.JPG', 'gum-tree-against-rock',    'A white-trunked gum tree against the red rock.'],
      ['DSC03190.JPG', 'conglomerate-texture',     'Close-up of the red conglomerate rock texture.'],
      ['DSC03194.JPG', 'talus-slope',              'Loose talus rock on a slope.'],
      ['DSC03195.JPG', 'red-scree',                'Red scree slope below a dome.'],
      ['DSC03196.JPG', 'split-boulder',            'A large boulder split open.'],
      ['DSC03197.JPG', 'trail-into-valley',        'Stairs and trail leading into the Valley of the Winds.'],
      ['DSC03198.JPG', 'hikers-on-trail',          'Group of hikers on the rocky trail.'],
      ['DSC03201.JPG', 'boulders-with-grass',      'Cluster of boulders with native grass.'],
      ['DSC03216.JPG', 'gap-between-domes',        'Narrow gap between two Kata Tjuta domes.'],
      ['DSC03230.JPG', 'valley-floor-view',        'View from the Valley of the Winds toward the plain.'],
      ['DSC03242.JPG', 'stone-path',               'Stone path winding between the domes.'],
      ['DSC03246.JPG', 'tour-bus-at-kata-tjuta',   'Tour bus with Kata Tjuta in the background.'],
      ['DSC03251.JPG', 'kata-tjuta-evening',       'The full Kata Tjuta formation at evening.'],
      ['DSC03260.JPG', 'twin-domes',               'Two adjacent domes, close view.'],
    ],
  },
  {
    folder: 'kings_canyon_outback', path: 'australia/outback/kings-canyon',
    title: 'Kings Canyon', subtitle: 'Watarrka National Park.',
    location: 'Watarrka National Park, NT, Australia',
    desc: 'Photos from the Kings Canyon rim walk in Watarrka National Park.',
    keywords: ['Kings Canyon', 'Watarrka', 'Outback', 'Northern Territory'],
    photos: [
      ['DSC03426.JPG', 'balanced-boulder',         'A large boulder balanced on the trailhead at dawn.'],
      ['DSC03454.JPG', 'striated-canyon-wall',     'Detail of the layered canyon walls.'],
      ['DSC03460.JPG', 'first-dome',               'Misty first beehive dome on the rim walk.'],
      ['DSC03463.JPG', 'overhang',                 'Looking up at a cliff overhang.'],
      ['DSC03467.JPG', 'misty-plateau',            'Eroded plateau under low mist.'],
      ['DSC03472.JPG', 'plateau-gum-tree',         'A gum tree growing on the canyon plateau.'],
      ['DSC03477.JPG', 'eroded-rim',               'Eroded canyon rim in the rain.'],
      ['DSC03483.JPG', 'mushroom-rock',            'Mushroom-shaped eroded rock formation.'],
      ['DSC03488.JPG', 'lost-city-domes',          "The 'Lost City' of beehive domes."],
      ['DSC03491.JPG', 'person-on-rim',            'A figure standing on the canyon rim.'],
      ['DSC03492.JPG', 'cliff-detail',             'Close-up of the canyon cliff.'],
      ['DSC03496.JPG', 'shelby-on-rim',            'Shelby on the rim of Kings Canyon.'],
      ['DSC03507.JPG', 'garden-of-eden-hikers',    'Hikers near the Garden of Eden.'],
      ['DSC03526.JPG', 'garden-of-eden-bridge',    'Wooden bridge in the Garden of Eden.'],
      ['DSC03538.JPG', 'garden-of-eden-pool',      'Pool in the Garden of Eden.'],
      ['DSC03556.JPG', 'lost-city-overview',       'Wide view over the Lost City domes.'],
      ['DSC03563.JPG', 'trail-back-down',          'Trail leading back down off the rim.'],
    ],
  },
  {
    folder: 'misc_outback', path: 'australia/outback/misc',
    title: 'Outback (misc)', subtitle: 'Red dirt, long roads, and roadside stops.',
    location: 'Red Centre, Australia',
    desc: 'Loose photos from the Australian Outback — landscapes, roads, and stops between the headline parks.',
    keywords: ['Outback', 'Red Centre', 'Australia road trip', 'Northern Territory'],
    photos: [
      ['DSC03096.JPG', 'roadside-from-bus',         'Outback roadside seen through a bus window at dawn.'],
      ['DSC03109.JPG', 'emu-at-roadhouse',          'An emu in a pen at a roadhouse.'],
      ['DSC03111.JPG', 'kulgera-dawn',              'Roadside sign in early dawn light.'],
      ['DSC03115.JPG', 'outback-petrol-station',    'An empty outback petrol station at dawn.'],
      ['DSC03116.JPG', 'northern-territory-sign',   'Welcome to the Northern Territory sign.'],
      ['DSC03129.JPG', 'bus-fueling',               'Adventure Tours bus at a fuel stop.'],
      ['DSC03130.JPG', 'erldunda-sign',             "Erldunda 'centre of the centre' roadhouse sign."],
      ['DSC03131.JPG', 'outback-junction',          'Quiet outback road junction.'],
      ['DSC03133.JPG', 'uluru-turnoff',             'The turnoff sign for Uluru.'],
      ['DSC03134.JPG', 'erldunda-motel-sign',       'Roadside signs for the Erldunda Motel.'],
      ['DSC03139.JPG', 'memorial-bell',             'Cast-iron memorial bell at a rest stop.'],
      ['DSC03140.JPG', 'cockatiel',                 'A cockatiel perched in a wire cage.'],
      ['DSC03142.JPG', 'red-dirt-campground',       'Red dirt campground with native trees.'],
      ['DSC03143.JPG', 'desert-camp',               'Desert camp buildings from above.'],
      ['DSC03144.JPG', 'road-from-hilltop',         'Outback road seen from a hilltop.'],
      ['DSC03154.JPG', 'desert-oaks',               'Desert oaks dotting the landscape.'],
      ['DSC03156.JPG', 'glamping-tents-overview',   'Glamping tents at a desert camp.'],
      ['DSC03157.JPG', 'camp-from-above',           'Camp from above with tents and trees.'],
      ['DSC03160.JPG', 'glamping-tents',            'Two glamping tents in the red dirt.'],
    ],
  },
  {
    folder: 'mona', path: 'australia/tasmania/mona',
    title: 'MONA', subtitle: 'Museum of Old and New Art.',
    location: 'Berriedale, Hobart, Tasmania, Australia',
    desc: 'Photos from MONA — the Museum of Old and New Art in Hobart, Tasmania.',
    keywords: ['MONA', 'Museum of Old and New Art', 'Hobart', 'Tasmania', 'contemporary art'],
    photos: [
      ['DSC03605.JPG', 'cement-truck',             "Wim Delvoye's intricately patterned cement truck sculpture."],
      ['DSC03612.JPG', 'the-butterfly-text',       "Illuminated 'The Butterfly' text piece in a dark room."],
      ['DSC03621.JPG', 'cloaca-vessels',           'Glass vessels of the Cloaca digestion machine.'],
      ['DSC03623.JPG', 'cloaca-mechanism-detail',  'Inner mechanics of Cloaca — tubes and glass.'],
      ['DSC03633.JPG', 'god-is-your-enemy',        "'God Is Your Enemy' text artwork."],
      ['DSC03634.JPG', 'noodles-on-pedestal',      'Instant noodles arranged as art on a pedestal.'],
      ['DSC03636.JPG', 'drinking-piss-text',       'A red text piece by an artist commenting on artists.'],
      ['DSC03637.JPG', 'so-much-for-optimism',     "'So much for my fucking optimism' text piece."],
      ['DSC03639.JPG', 'fat-car',                  "Erwin Wurm's bulging red 'Fat Car' sculpture."],
      ['DSC03648.JPG', 'bit-fall',                 'Looking up at the bit.fall water-text installation.'],
      ['DSC03649.JPG', 'cloaca-glass-dish',        'Glass dish suspended inside the Cloaca mechanism.'],
      ['DSC03651.JPG', 'cloaca-tubes',             'Backside of Cloaca tubes and pumps.'],
      ['DSC03656.JPG', 'cloaca-output',            'Output of Cloaca on a glass dish.'],
      ['DSC03660.JPG', 'white-temple',             'Carved white timber temple installation.'],
      ['DSC03667.JPG', 'photo-wall',               'Wall of framed photographs.'],
      ['DSC03671.JPG', 'erosion-texture',          'Textural close-up resembling stalactites.'],
      ['DSC03677.JPG', 'bonsai-vitrine',           'A bonsai tree in a glass vitrine.'],
      ['DSC03681.JPG', 'siloam-tunnel',            'Visitors viewing a tapestry through a concrete tunnel.'],
      ['DSC03684.JPG', 'hanging-films',            'Hanging strips of burnt film.'],
      ['DSC03687.JPG', 'snake-installation',       'Inside the snake installation.'],
      ['DSC03694.JPG', 'snake-overview',           'Wide view of the snake installation.'],
      ['DSC03706.JPG', 'glass-ceiling-detail',     'Detail of a glass-and-light ceiling installation.'],
      ['DSC03710.JPG', 'screens-corridor',         'Long corridor with rows of small video screens.'],
    ],
  },
];

for (const g of GALLERIES) {
  const stagingDir = path.join(ROOT, 'staging', g.folder);
  console.log(`\n=== ${g.title} → /media/${g.path} ===`);

  const images = [];
  let galleryDate = null;
  for (let n = 0; n < g.photos.length; n++) {
    const [srcName, slug, alt] = g.photos[n];
    const srcAbs = path.join(stagingDir, srcName);
    try { await fs.access(srcAbs); }
    catch { console.log(`  [${n+1}/${g.photos.length}] ${srcName} — missing, skip`); continue; }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const full = path.join(os.tmpdir(), `bulk-${id}-full.jpg`);
    const med = path.join(os.tmpdir(), `bulk-${id}-med.jpg`);
    const thumb = path.join(os.tmpdir(), `bulk-${id}-thumb.jpg`);

    await sharp(srcAbs).rotate().jpeg({ quality: 92, progressive: true, mozjpeg: true }).toFile(full);
    await sharp(srcAbs).rotate().resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 82, progressive: true, mozjpeg: true }).toFile(med);
    await sharp(srcAbs).rotate().resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 78, progressive: true, mozjpeg: true }).toFile(thumb);

    const bytes = (await fs.stat(full)).size;
    const fullMeta = await sharp(full).metadata();
    const ex = await exifr.parse(srcAbs, { exif: true, tiff: true });

    const key = `${g.path}/${slug}`;
    process.stdout.write(`  [${n+1}/${g.photos.length}] ${srcName} → ${slug} (${(bytes/1024/1024).toFixed(1)}MB)…`);
    const s3 = s3up(full, `${key}.jpg`);
    const s3_med = s3up(med, `${key}__med.jpg`);
    const s3_thumb = s3up(thumb, `${key}__thumb.jpg`);
    console.log(' ✓');

    await fs.unlink(full); await fs.unlink(med); await fs.unlink(thumb);
    await fs.unlink(srcAbs);

    const exif = {};
    if (ex?.Make || ex?.Model) exif.camera = [ex.Make, ex.Model].filter(Boolean).join(' ').trim();
    if (ex?.LensModel) exif.lens = ex.LensModel;
    if (ex?.ISO) exif.iso = ex.ISO;
    if (ex?.FNumber) exif.aperture = 'f/' + ex.FNumber;
    if (ex?.ExposureTime) exif.shutter = formatShutter(ex.ExposureTime);
    if (ex?.FocalLength) exif.focal_length = Math.round(ex.FocalLength) + 'mm';
    if (fullMeta?.width) exif.width = fullMeta.width;
    if (fullMeta?.height) exif.height = fullMeta.height;

    const captureDate = ex?.DateTimeOriginal ? ex.DateTimeOriginal.toISOString().slice(0, 10) : null;
    if (!galleryDate && captureDate) galleryDate = captureDate;

    images.push({
      file: `${slug}.jpg`,
      alt,
      ...(captureDate ? { date: captureDate } : {}),
      s3, s3_med, s3_thumb, bytes,
      exif,
    });
  }

  try { await fs.rmdir(stagingDir); } catch {}

  const galleryDir = path.join(ROOT, 'content/media', g.path);
  await fs.mkdir(galleryDir, { recursive: true });
  const meta = {
    title: g.title, subtitle: g.subtitle, location: g.location,
    ...(galleryDate ? { date: galleryDate } : {}),
    seo: { description: g.desc, keywords: g.keywords },
    images,
  };
  await fs.writeFile(path.join(galleryDir, 'metadata.yaml'), yaml.dump(meta, { lineWidth: 100, noRefs: true, quotingType: '"' }));
  console.log(`  → wrote ${galleryDir}/metadata.yaml`);
}

console.log('\nALL DONE.');
