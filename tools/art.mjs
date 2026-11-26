// Character art pipeline. Everything lands in public/characters/<key>/ (the shipped characters' art is committed):
//   portrait.*        base standing portrait            (art.source: download | art.prompt [+ art.reference]: generate)
//   win.png / lose.png  victory / defeat poses          (art.win / art.lose, generated from the portrait)
//   stickers/<id>.png   chat stickers                    (config.stickers[id].prompt, generated from the portrait)
// Images are generated with config.imageModel through the OpenAI-compatible endpoint in config.llm.
//
//   seat.png / dealer.png  cut-outs for the start-page table scene (art.seat / scene.dealerPrompt)
// public/scene/background.png + table.png: the room and the table layer (scene.background / scene.table)
//
// usage: node tools/art.mjs [portraits|poses|stickers|scene|all] [key ...] [--force]
// Exits with code 1 when any image failed (the settings page shows the job as failed).
import fs from 'node:fs';
import path from 'node:path';
import { editImage, loadConfig, ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const [stage = 'all', ...keys] = args.filter((a) => a !== '--force');
const STAGES = ['portraits', 'poses', 'stickers', 'scene', 'all'];
if (!STAGES.includes(stage)) {
  console.error(`unknown stage "${stage}" (use ${STAGES.join(' | ')})`);
  process.exit(2);
}
const cfg = loadConfig();
const chars = cfg.ai.filter((a) => a.key && (!keys.length || keys.includes(a.key)));
const dirOf = (a) => path.join(ROOT, 'public', 'characters', a.key);
const IMG = ['.png', '.webp', '.jpg', '.jpeg', '.gif'];
const findImg = (dir, base) => IMG.map((e) => path.join(dir, base + e)).find((f) => fs.existsSync(f));
// Writes <dir>/<base><ext> and removes other variants (portrait.png next to a new portrait.jpg would win, see IMG order).
function writeImg(dir, base, ext, bytes) {
  for (const e of IMG) if (e !== ext) fs.rmSync(path.join(dir, base + e), { force: true });
  fs.writeFileSync(path.join(dir, base + ext), bytes);
}
// Image extension from a URL path ('.png' when unknown).
function extOf(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return IMG.includes(ext) ? ext : '.png';
}
let failures = 0;

const COMMON =
  'Same character as the reference image: keep her face, hair, outfit design, colors and the anime gacha standing-portrait art style. Adult with adult proportions. Full body, plain white background, vertical 2:3, clean lineart, soft cel shading, no text, no watermark.';
const POSE = {
  win: 'Victory pose, bright confident mood.',
  lose: 'Comedic "defeated" gacha sprite after losing a poker game: flustered and sulky, outfit dusty and rumpled with a frayed hem, hair messy, a few scattered playing cards and an empty chip tray nearby.',
};

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function portraits() {
  for (const a of chars) {
    try {
      await portrait(a);
    } catch (e) {
      console.log(`fail portrait ${a.key}: ${e.message}`);
      failures++;
    }
  }
}

async function portrait(a) {
  const dir = dirOf(a);
  fs.mkdirSync(dir, { recursive: true });
  if (findImg(dir, 'portrait') && !force) return;
  const art = a.art ?? {};
  if (art.source) {
    writeImg(dir, 'portrait', extOf(art.source), await download(art.source));
    console.log(`portrait ${a.key}: downloaded`);
  } else if (art.prompt) {
    let ref;
    if (art.reference && !/^https?:/i.test(art.reference)) ref = path.resolve(ROOT, art.reference);
    else if (art.reference) {
      ref = path.join(dir, `reference${extOf(art.reference)}`);
      if (!fs.existsSync(ref)) fs.writeFileSync(ref, await download(art.reference));
    }
    writeImg(dir, 'portrait', '.png', await editImage({ prompt: art.prompt, ref }));
    console.log(`portrait ${a.key}: generated`);
  } else console.log(`portrait ${a.key}: no art.source / art.prompt, skipped (put your own portrait.png there)`);
}

async function pool(jobs, limit = 4) {
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < jobs.length) {
        const job = jobs[i++];
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await job.run();
            console.log(`ok   ${job.name}`);
            break;
          } catch (e) {
            console.log(`fail ${job.name} (attempt ${attempt}): ${e.message}`);
            if (attempt === 2) failures++;
          }
        }
      }
    }),
  );
}

function poses() {
  const jobs = [];
  for (const a of chars) {
    const dir = dirOf(a);
    const ref = findImg(dir, 'portrait');
    if (!ref) continue;
    for (const kind of ['win', 'lose']) {
      if ((findImg(dir, kind) && !force) || !a.art?.[kind]) continue;
      const prompt = [COMMON, a.art.look ?? '', POSE[kind], a.art[kind]].join(' ');
      jobs.push({ name: `${a.key}/${kind}`, run: async () => writeImg(dir, kind, '.png', await editImage({ prompt, ref })) });
    }
  }
  return pool(jobs);
}

function stickers() {
  const jobs = [];
  for (const a of chars) {
    const dir = dirOf(a);
    const ref = findImg(dir, 'portrait');
    if (!ref) continue;
    fs.mkdirSync(path.join(dir, 'stickers'), { recursive: true });
    for (const [id, st] of Object.entries(cfg.stickers ?? {})) {
      if ((findImg(path.join(dir, 'stickers'), id) && !force) || !st.prompt) continue;
      const prompt = [
        'A single chat sticker of the same character as the reference image (keep her face, hair, colors and outfit), drawn as an expressive anime LINE-style sticker:',
        'bust-up framing (head, shoulders and hands), adult, thick white die-cut outline, plain pure white background, square composition, bold clean lineart, flat bright colors, no text, no letters, no watermark.',
        a.art?.look ?? '',
        `Expression: ${st.prompt}.`,
        'Wholesome and non-sexual.',
      ].join(' ');
      jobs.push({ name: `${a.key}/stickers/${id}`, run: async () => writeImg(path.join(dir, 'stickers'), id, '.png', await editImage({ prompt, ref, size: '1024x1024' })) });
    }
  }
  return pool(jobs, 5);
}

// Start-page scene: transparent cut-outs of every character seated at the table, one of them as the dealer.
function scene() {
  const sc = cfg.scene ?? {};
  const jobs = [];
  const sceneDir = path.join(ROOT, 'public', 'scene');
  fs.mkdirSync(sceneDir, { recursive: true });
  if ((!findImg(sceneDir, 'background') || force) && sc.background && !keys.length)
    jobs.push({ name: 'scene/background', run: async () => writeImg(sceneDir, 'background', '.png', await editImage({ prompt: sc.background, size: '1536x1024' })) });
  if ((!findImg(sceneDir, 'table') || force) && sc.table && !keys.length)
    jobs.push({ name: 'scene/table', run: async () => writeImg(sceneDir, 'table', '.png', await editImage({ prompt: sc.table, size: '1536x1024', background: 'transparent' })) });
  for (const a of chars) {
    const dir = dirOf(a);
    const ref = findImg(dir, 'portrait');
    if (!ref) continue;
    const dealer = a.key === sc.dealer;
    const base = dealer ? 'dealer' : 'seat';
    if (findImg(dir, base) && !force) continue;
    const pose = dealer
      ? sc.dealerPrompt
      : `She is seated at a casino poker table, seen from the front at waist level, as if her forearms rest on the table edge (do not draw the table). ${a.art?.seat ?? 'A stylish casino-night outfit in her own colors; she holds two playing cards.'} Upper body only, down to the hips; nothing below.`;
    const prompt = [
      'Same character as the reference image: keep her face, hair, horns/accessories, colors and the anime gacha art style. Adult woman with adult proportions.',
      a.art?.look ?? '',
      pose,
      'Transparent background, no table, no chair, no floor, no shadow, clean anime lineart, soft cel shading, no text. Tasteful and non-sexual.',
    ].join(' ');
    jobs.push({ name: `${a.key}/${base}`, run: async () => writeImg(dir, base, '.png', await editImage({ prompt, ref, size: '1024x1536', background: 'transparent' })) });
  }
  return pool(jobs, 5);
}

if (stage === 'portraits' || stage === 'all') await portraits();
if (stage === 'poses' || stage === 'all') await poses();
if (stage === 'stickers' || stage === 'all') await stickers();
if (stage === 'scene' || stage === 'all') await scene();
if (failures) {
  console.log(`done with ${failures} failed image(s).`);
  process.exitCode = 1;
} else console.log('done. Large stickers can be shrunk with: powershell -File tools/shrink.ps1 (Windows)');
