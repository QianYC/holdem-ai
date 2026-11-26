// Shared helpers for the tools: the game config and the OpenAI-compatible endpoint it points at.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey } from '../src/ai.js';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Same lookup as the server: $HOLDEM_CONFIG, else config.json, else the shipped config.example.json.
export function loadConfig() {
  const file = process.env.HOLDEM_CONFIG ?? [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')].find((p) => fs.existsSync(p));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Default image model when config.imageModel is missing (older configs); config.example.json sets the same one.
const DEFAULT_IMAGE_MODEL = 'github-copilot/gpt-image-2.5-flare';

// Base URL of the running game (dev scripts): $HOLDEM_PORT or config.port, like the server.
export const gameUrl = (cfg = loadConfig()) => `http://127.0.0.1:${process.env.HOLDEM_PORT ?? cfg.port ?? 3095}`;

// The Slack bridge token (dev scripts): slack.bridgeTokenFile, else $SLACK_BRIDGE_TOKEN_FILE, like the server.
export function bridgeToken(cfg = loadConfig()) {
  const file = cfg.slack?.bridgeTokenFile || process.env.SLACK_BRIDGE_TOKEN_FILE;
  if (!file) throw new Error('no Slack bridge token: set slack.bridgeTokenFile in config.json or SLACK_BRIDGE_TOKEN_FILE');
  return fs.readFileSync(file, 'utf8').trim();
}

export function llm(cfg = loadConfig()) {
  const base = cfg.llm.baseUrl.replace(/\/$/, '');
  return {
    cfg,
    url: (p) => `${base}${p}`,
    auth: { authorization: `Bearer ${apiKey(cfg.llm)}` },
    imageModel: cfg.imageModel ?? DEFAULT_IMAGE_MODEL,
  };
}

// POST /images/edits with a reference image (or /images/generations without); returns PNG bytes.
// background: 'transparent' asks for a cut-out PNG (models that support it).
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export async function editImage({ prompt, ref, size = '1024x1536', background }) {
  const { url, auth, imageModel } = llm();
  const extra = background ? { background, output_format: 'png' } : {};
  let res;
  if (ref) {
    const form = new FormData();
    form.append('model', imageModel);
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('n', '1');
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    form.append('image', new Blob([fs.readFileSync(ref)], { type: MIME[path.extname(ref).toLowerCase()] ?? 'image/png' }), path.basename(ref));
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
