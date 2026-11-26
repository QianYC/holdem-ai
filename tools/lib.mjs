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

// POST /images/edits with one reference image; returns PNG bytes.
export async function editImage({ prompt, ref, size = '1024x1536' }) {
  const { url, auth, imageModel } = llm();
  const form = new FormData();
  form.append('model', imageModel);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('n', '1');
  if (ref) form.append('image', new Blob([fs.readFileSync(ref)], { type: ref.endsWith('.png') ? 'image/png' : 'image/webp' }), path.basename(ref));
  const res = await fetch(url(ref ? '/images/edits' : '/images/generations'), {
    method: 'POST',
    headers: ref ? auth : { ...auth, 'content-type': 'application/json' },
    body: ref ? form : JSON.stringify({ model: imageModel, prompt, size, n: 1 }),
    signal: AbortSignal.timeout(300000),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${txt.slice(0, 200)}`);
  return Buffer.from(JSON.parse(txt).data[0].b64_json, 'base64');
}
