// Shared helpers for the tools: the game config and the OpenAI-compatible endpoint it points at.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey } from '../src/ai.js';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadConfig() {
  const file = process.env.HOLDEM_CONFIG ?? [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')].find((p) => fs.existsSync(p));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function llm() {
  const cfg = loadConfig();
  const base = cfg.llm.baseUrl.replace(/\/$/, '');
  return {
    cfg,
    url: (p) => `${base}${p}`,
    auth: { authorization: `Bearer ${apiKey(cfg.llm)}` },
    imageModel: cfg.imageModel ?? 'github-copilot/gpt-image-2.5-flare',
  };
}

// POST /images/edits with reference images (or /images/generations without); returns PNG bytes.
// background: 'transparent' asks for a cut-out PNG (models that support it).
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
export async function editImage({ prompt, ref, refs, size = '1024x1536', background, quality }) {
  const { url, auth, imageModel } = llm();
  const images = refs ?? (ref ? [ref] : []);
  const extra = { ...(background ? { background, output_format: 'png' } : {}), ...(quality ? { quality } : {}) };
  let res;
  if (images.length) {
    const form = new FormData();
    form.append('model', imageModel);
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('n', '1');
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    for (const f of images) form.append(images.length > 1 ? 'image[]' : 'image', new Blob([fs.readFileSync(f)], { type: MIME[path.extname(f).toLowerCase()] ?? 'image/png' }), path.basename(f));
    res = await fetch(url('/images/edits'), { method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(300000) });
  } else {
    res = await fetch(url('/images/generations'), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: imageModel, prompt, size, n: 1, ...extra }),
      signal: AbortSignal.timeout(300000),
    });
  }
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${txt.slice(0, 200)}`);
  return Buffer.from(JSON.parse(txt).data[0].b64_json, 'base64');
}
