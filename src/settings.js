// Settings API for the web UI: read/save config.json, list models, manage character art.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listModels, routeOf } from './ai.js';
import { IMG_EXT, scanArt } from './game.js';

const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const KEY_RE = /^[a-z0-9_-]{1,32}$/i;
const STICKER_RE = /^[^\\/:*?"<>|.\s][^\\/:*?"<>|]{0,39}$/;
const MAX_AI = 9;

// Changes to these need a new game (seats are built from them).
// (A different model in an existing slot just takes over that seat at the next hand.)
const structural = (c) => JSON.stringify([c.startingStack, c.smallBlind, c.bigBlind, c.humanName, (c.ai ?? []).length]);

function slug(s, i) {
  const k = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return k || `ai${i + 1}`;
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('文件太大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createSettingsApi({ root, publicDir, config, game, log, savePath, onSaved }) {
  const target = savePath ?? path.join(root, 'config.json');
  const jobs = new Map();
  let jobSeq = 0;

  function publicConfig() {
    const c = structuredClone(config);
    const hasApiKey = Boolean(c.llm?.apiKey);
    if (c.llm) c.llm.apiKey = '';
    const art = Object.fromEntries((c.ai ?? []).filter((a) => a.key).map((a) => [a.key, scanArt(publicDir, a, c.stickers)]));
    return { ok: true, config: c, hasApiKey, art, maxAi: MAX_AI, file: fs.existsSync(target) ? 'config.json' : 'config.example.json' };
  }

  function validate(next) {
    const num = (v, name, min = 0) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min) throw new Error(`${name} 必须是 ≥ ${min} 的数字`);
      return n;
    };
    next.startingStack = num(next.startingStack, '起始筹码', 1);
    next.smallBlind = num(next.smallBlind, '小盲', 1);
    next.bigBlind = num(next.bigBlind, '大盲', 1);
    if (next.smallBlind >= next.bigBlind) throw new Error('小盲要小于大盲');
    if (next.bigBlind >= next.startingStack) throw new Error('大盲要小于起始筹码');
    for (const k of ['autoNextHandMs', 'spectateDelayMs', 'minActionDelayMs']) if (k in next) next[k] = num(next[k], k);
    if (!Array.isArray(next.ai) || next.ai.length < 1) throw new Error('至少要有 1 个 AI');
    if (next.ai.length > MAX_AI) throw new Error(`最多 ${MAX_AI} 个 AI`);
    const keys = new Set();
    next.ai.forEach((a, i) => {
      if (!String(a.name ?? '').trim()) throw new Error(`第 ${i + 1} 个 AI 缺少名字`);
      if (!String(a.model ?? '').trim()) throw new Error(`${a.name} 缺少模型`);
      a.name = String(a.name).trim().slice(0, 20);
      a.model = String(a.model).trim();
      a.key = KEY_RE.test(a.key ?? '') ? a.key : slug(a.name, i);
      while (keys.has(a.key)) a.key = `${a.key}-${i + 1}`;
      keys.add(a.key);
      if (!a.reasoning) delete a.reasoning;
    });
    if (!next.llm?.baseUrl) throw new Error('缺少模型接口地址');
    if (!next.llm.apiKey) {
      if (config.llm?.apiKey) next.llm.apiKey = config.llm.apiKey;
      else delete next.llm.apiKey;
    }
    return next;
  }

  async function save(body) {
    const next = validate(structuredClone(body.config ?? {}));
    // Keep settings the UI does not edit (slack, port, …) unless sent explicitly.
    const merged = { ...config, ...next };
    const needsNewGame = structural(config) !== structural(merged);
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(merged, null, 2)}\n`);
    fs.renameSync(`${target}.tmp`, target);
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(config, merged);
    game.configPath = target;
    game.reloadTuning();
    game.changed();
    log(`[settings] saved config.json (${merged.ai.length} AI${needsNewGame ? ', new game needed' : ''})`);
    onSaved?.();
    return { ok: true, needsNewGame };
  }

  function autoNext(body) {
    return game.setAutoNext(body.ms);
  }

  // Models of the default endpoint plus every extra provider (llm.providers).
  async function models() {
    let list;
    try {
      list = await listModels(config.llm, routeOf(config.llm, null));
    } catch (e) {
      return { ok: false, error: `接口返回 ${e.message}` };
    }
    const providers = {};
    const errors = {};
    for (const name of Object.keys(config.llm.providers ?? {})) {
      try {
        providers[name] = await listModels(config.llm, routeOf(config.llm, { provider: name }));
      } catch (e) {
        errors[name] = String(e?.message ?? e);
      }
    }
    return { ok: true, models: list, providers, errors };
  }

  function artDir(key) {
    if (!KEY_RE.test(key ?? '')) throw new Error('角色 key 不合法');
    return path.join(publicDir, 'characters', key);
  }

  function slotBase(slot, id) {
    if (['portrait', 'win', 'lose'].includes(slot)) return slot;
    if (slot === 'sticker' && STICKER_RE.test(id ?? '')) return path.join('stickers', id);
    throw new Error('不支持的图片位置或表情名');
  }

  function removeVariants(dir, base) {
    for (const e of IMG_EXT) fs.rmSync(path.join(dir, base + e), { force: true });
  }

  async function upload(req, url) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    const ext = MIME_EXT[type];
    if (!ext) throw new Error('只支持 png / jpg / webp / gif');
    const dir = artDir(url.searchParams.get('key'));
    const base = slotBase(url.searchParams.get('slot'), url.searchParams.get('id'));
    const bytes = await readRaw(req, 15 * 1024 * 1024);
    fs.mkdirSync(path.dirname(path.join(dir, base)), { recursive: true });
    removeVariants(dir, base);
    fs.writeFileSync(path.join(dir, base + ext), bytes);
    game.resolveArt();
    game.changed();
    return publicConfig();
  }

  function remove(body) {
    const dir = artDir(body.key);
    removeVariants(dir, slotBase(body.slot, body.id));
    game.resolveArt();
    game.changed();
    return publicConfig();
  }

  function generate(body) {
    artDir(body.key);
    const stage = ['portraits', 'poses', 'stickers', 'all'].includes(body.stage) ? body.stage : 'all';
    const id = String(++jobSeq);
    const args = [path.join(root, 'tools', 'art.mjs'), stage, body.key, ...(body.force ? ['--force'] : [])];
    const job = { id, key: body.key, stage, status: 'running', log: [], started: Date.now() };
    jobs.set(id, job);
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true });
    const onData = (d) => {
      job.log.push(...String(d).split(/\r?\n/).filter(Boolean));
      if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      job.status = code === 0 ? 'done' : 'failed';
      game.resolveArt();
      game.changed();
      log(`[settings] art ${stage} ${body.key} ${job.status}`);
    });
    child.on('error', (e) => {
      job.status = 'failed';
      job.log.push(String(e));
    });
    return { ok: true, job: id };
  }

  // Returns true when the request was handled.
  return async function handle(req, res, url, send) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/config') return send(res, 200, publicConfig()), true;
    if (req.method === 'GET' && p === '/api/models') return send(res, 200, await models().catch((e) => ({ ok: false, error: String(e.message ?? e) }))), true;
    if (req.method === 'GET' && p === '/api/art/jobs') return send(res, 200, { ok: true, jobs: [...jobs.values()].slice(-20) }), true;
    if (req.method !== 'POST' || !p.startsWith('/api/')) return false;
    const origin = req.headers.origin;
    const port = url.port;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { ok: false }), true;
    try {
      if (p === '/api/art/upload') return send(res, 200, await upload(req, url)), true;
      if (!['/api/config', '/api/art/delete', '/api/art/generate', '/api/auto-next'].includes(p)) return false;
      const chunks = await readRaw(req, 2 * 1024 * 1024);
      const body = JSON.parse(chunks.toString('utf8') || '{}');
      if (p === '/api/config') return send(res, 200, await save(body)), true;
      if (p === '/api/art/delete') return send(res, 200, remove(body)), true;
      if (p === '/api/auto-next') return send(res, 200, autoNext(body)), true;
      if (p === '/api/art/generate') return send(res, 200, generate(body)), true;
    } catch (e) {
      return send(res, 200, { ok: false, error: String(e?.message ?? e) }), true;
    }
    return false;
  };
}
