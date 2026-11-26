// Character art pipeline. Everything lands in public/characters/<key>/ (git-ignored):
//   portrait.*        base standing portrait            (art.source: download | art.prompt [+ art.reference]: generate)
//   win.png / lose.png  victory / defeat poses          (art.win / art.lose, generated from the portrait)
//   stickers/<id>.png   chat stickers                    (config.stickers[id].prompt, generated from the portrait)
// Images are generated with config.imageModel through the OpenAI-compatible endpoint in config.llm.
//
//   seat.png / dealer.png  cut-outs for the start-page table scene (art.seat / scene.dealerPrompt)
// public/scene/background.png + table.png: the room and the table layer (scene.background / scene.table)
//
// usage: node tools/art.mjs [portraits|poses|stickers|scene|all] [key ...] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { editImage, loadConfig, ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const [stage = 'all', ...keys] = args.filter((a) => a !== '--force');
const cfg = loadConfig();
const chars = cfg.ai.filter((a) => a.key && (!keys.length || keys.includes(a.key)));
const dirOf = (a) => path.join(ROOT, 'public', 'characters', a.key);
const IMG = ['.png', '.webp', '.jpg', '.jpeg', '.gif'];
const findImg = (dir, base) => IMG.map((e) => path.join(dir, base + e)).find((f) => fs.existsSync(f));

const COMMON =
  'Same character as the reference image: keep her face, hair, outfit design, colors and the anime gacha standing-portrait art style. Adult with adult proportions. Full body, plain white background, vertical 2:3, clean lineart, soft cel shading, no text, no watermark.';
const POSE = {
  win: 'Victory pose, bright confident mood.',
  lose: 'Comedic "defeated" gacha sprite after losing a poker game: flustered and sulky, outfit dusty and rumpled with a frayed hem, hair messy, a few scattered playing cards and an empty chip tray nearby.',
};

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function portraits() {
  for (const a of chars) {
    const dir = dirOf(a);
    fs.mkdirSync(dir, { recursive: true });
    if (findImg(dir, 'portrait') && !force) continue;
    const art = a.art ?? {};
    if (art.source) {
      const ext = path.extname(new URL(art.source).pathname).split('-')[0] || '.png';
      await download(art.source, path.join(dir, `portrait${IMG.includes(ext) ? ext : '.png'}`));
      console.log(`portrait ${a.key}: downloaded`);
    } else if (art.prompt) {
      let ref;
      if (art.reference && !/^https?:/i.test(art.reference)) ref = path.resolve(ROOT, art.reference);
      else if (art.reference) {
        ref = path.join(dir, `reference${path.extname(new URL(art.reference).pathname).split('-')[0] || '.png'}`);
        if (!fs.existsSync(ref)) await download(art.reference, ref);
      }
      fs.writeFileSync(path.join(dir, 'portrait.png'), await editImage({ prompt: art.prompt, ref }));
      console.log(`portrait ${a.key}: generated`);
    } else console.log(`portrait ${a.key}: no art.source / art.prompt, skipped (put your own portrait.png there)`);
  }
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
      const out = path.join(dir, `${kind}.png`);
      if ((fs.existsSync(out) && !force) || !a.art?.[kind]) continue;
      const prompt = [COMMON, a.art.look ?? '', POSE[kind], a.art[kind]].join(' ');
      jobs.push({ name: `${a.key}/${kind}`, run: async () => fs.writeFileSync(out, await editImage({ prompt, ref })) });
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
      const out = path.join(dir, 'stickers', `${id}.png`);
      if ((fs.existsSync(out) && !force) || !st.prompt) continue;
      const prompt = [
        'A single chat sticker of the same character as the reference image (keep her face, hair, colors and outfit), drawn as an expressive anime LINE-style sticker:',
        'bust-up framing (head, shoulders and hands), adult, thick white die-cut outline, plain pure white background, square composition, bold clean lineart, flat bright colors, no text, no letters, no watermark.',
        a.art?.look ?? '',
        `Expression: ${st.prompt}.`,
        'Wholesome and non-sexual.',
      ].join(' ');
      jobs.push({ name: `${a.key}/stickers/${id}`, run: async () => fs.writeFileSync(out, await editImage({ prompt, ref, size: '1024x1024' })) });
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
  const bg = path.join(sceneDir, 'background.png');
  if ((!findImg(sceneDir, 'background') || force) && sc.background && !keys.length)
    jobs.push({ name: 'scene/background', run: async () => fs.writeFileSync(bg, await editImage({ prompt: sc.background, size: '1536x1024' })) });
  const table = path.join(sceneDir, 'table.png');
  if ((!fs.existsSync(table) || force) && sc.table && !keys.length)
    jobs.push({ name: 'scene/table', run: async () => fs.writeFileSync(table, await editImage({ prompt: sc.table, size: '1536x1024', background: 'transparent' })) });
  for (const a of chars) {
    const dir = dirOf(a);
    const ref = findImg(dir, 'portrait');
    if (!ref) continue;
    const dealer = a.key === sc.dealer;
    const out = path.join(dir, dealer ? 'dealer.png' : 'seat.png');
    if (fs.existsSync(out) && !force) continue;
    const pose = dealer
      ? sc.dealerPrompt
      : `She is seated at a casino poker table, seen from the front at waist level, as if her forearms rest on the table edge (do not draw the table). ${a.art?.seat ?? 'A stylish casino-night outfit in her own colors; she holds two playing cards.'} Upper body only, down to the hips; nothing below.`;
    const prompt = [
      'Same character as the reference image: keep her face, hair, horns/accessories, colors and the anime gacha art style. Adult woman with adult proportions.',
      a.art?.look ?? '',
      pose,
      'Transparent background, no table, no chair, no floor, no shadow, clean anime lineart, soft cel shading, no text. Tasteful and non-sexual.',
    ].join(' ');
    jobs.push({ name: `${a.key}/${dealer ? 'dealer' : 'seat'}`, run: async () => fs.writeFileSync(out, await editImage({ prompt, ref, size: '1024x1536', background: 'transparent' })) });
  }
  return pool(jobs, 5);
}

if (stage === 'portraits' || stage === 'all') await portraits();
if (stage === 'poses' || stage === 'all') await poses();
if (stage === 'stickers' || stage === 'all') await stickers();
if (stage === 'scene' || stage === 'all') await scene();
console.log('done. Large stickers can be shrunk with: powershell -File tools/shrink.ps1 (Windows)');
