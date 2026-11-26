// Settings API for the web UI: read/save config.json, list models, manage character art.
// Host-only: server.js checks the Host / Origin headers and that the request comes from this machine before calling it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listModels, routeOf } from './ai.js';
import { IMG_EXT, scanArt } from './game.js';

const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const KEY_RE = /^[a-z0-9_-]{1,32}$/i;
const STICKER_RE = /^[^\\/:*?"<>|.\s][^\\/:*?"<>|]{0,39}$/;
const MAX_AI = 9;
const MAX_JOBS = 50;

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

// Request body as a Buffer; rejects (and drops the connection) past `limit` bytes.
export function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求太大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('close', () => reject(new Error('连接已关闭')));
  });
}

export async function readJson(req, limit = 1e6) {
  const text = (await readRaw(req, limit)).toString('utf8');
  return JSON.parse(text || '{}');
}

// Drops keys explicitly set to null (so the settings page can clear a setting) — recursively in plain objects.
function dropNulls(v) {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (!v || typeof v !== 'object') return v;
  for (const [k, x] of Object.entries(v)) {
    if (x === null) delete v[k];
    else v[k] = dropNulls(x);
  }
  return v;
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function createSettingsApi({ root, publicDir, config, game, log, savePath, onSaved }) {
  const target = savePath ?? path.join(root, 'config.json');
  const jobs = new Map();
  let jobSeq = 0;

  // The config as the settings page sees it: API keys are never sent back, only whether one is set.
  function publicConfig() {
    const c = structuredClone(config);
    const hasApiKey = Boolean(c.llm?.apiKey);
    if (c.llm) c.llm.apiKey = '';
    const providerKeys = {};
    for (const [name, p] of Object.entries(c.llm?.providers ?? {})) {
      if (!isPlainObject(p)) continue;
      providerKeys[name] = Boolean(p.apiKey);
      if ('apiKey' in p) p.apiKey = '';
    }
    const art = Object.fromEntries((c.ai ?? []).filter((a) => a.key).map((a) => [a.key, scanArt(publicDir, a, c.stickers)]));
    return { ok: true, config: c, hasApiKey, providerKeys, art, maxAi: MAX_AI, file: fs.existsSync(target) ? 'config.json' : 'config.example.json' };
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
    if ('blindLevels' in next) {
      if (!Array.isArray(next.blindLevels)) throw new Error('盲注级别必须是 [小盲, 大盲] 的列表');
      next.blindLevels = next.blindLevels.map((lv, i) => {
        if (!Array.isArray(lv) || lv.length !== 2) throw new Error(`第 ${i + 1} 级盲注必须是 [小盲, 大盲]`);
        return [num(lv[0], `第 ${i + 1} 级小盲`, 1), num(lv[1], `第 ${i + 1} 级大盲`, 1)];
      });
      // An empty list means "use the default schedule": remove the key.
      if (!next.blindLevels.length) delete next.blindLevels;
    }
    if (!Array.isArray(next.ai) || next.ai.length < 1) throw new Error('至少要有 1 个 AI');
    if (next.ai.length > MAX_AI) throw new Error(`最多 ${MAX_AI} 个 AI`);
    if (!isPlainObject(next.llm) || !next.llm.baseUrl) throw new Error('缺少模型接口地址');
    if (!/^https?:\/\//i.test(String(next.llm.baseUrl))) throw new Error('模型接口地址必须以 http:// 或 https:// 开头');
    // Keys left blank on the page keep their saved value.
    if (!next.llm.apiKey) {
      if (config.llm?.apiKey) next.llm.apiKey = config.llm.apiKey;
      else delete next.llm.apiKey;
    }
    if (next.llm.providers !== undefined && !isPlainObject(next.llm.providers)) throw new Error('llm.providers 必须是对象');
    for (const [name, p] of Object.entries(next.llm.providers ?? {})) {
      if (!isPlainObject(p)) throw new Error(`提供方 ${name} 的配置不对`);
      if (!p.apiKey) {
        const saved = config.llm?.providers?.[name]?.apiKey;
        if (saved) p.apiKey = saved;
        else delete p.apiKey;
      }
      routeOf(next.llm, { provider: name }); // type / baseUrl / dsh-account origin checks
    }
    const keys = new Set();
    next.ai.forEach((a, i) => {
      if (!String(a.name ?? '').trim()) throw new Error(`第 ${i + 1} 个 AI 缺少名字`);
      if (!String(a.model ?? '').trim()) throw new Error(`${a.name} 缺少模型`);
      a.name = String(a.name).trim().slice(0, 20);
      a.model = String(a.model).trim();
      if (a.provider && !next.llm.providers?.[a.provider]) throw new Error(`${a.name} 用的模型提供方 ${a.provider} 没有配置`);
      if (!a.provider) delete a.provider;
      if (!KEY_RE.test(a.key ?? '')) a.key = slug(a.name, i);
      const base = a.key.slice(0, 28);
      for (let n = 2; keys.has(a.key); n++) a.key = `${base}-${n}`;
      keys.add(a.key);
      if (!a.reasoning) delete a.reasoning;
    });
    return next;
  }

  function save(body) {
    const next = validate(dropNulls(structuredClone(body.config ?? {})));
    // Keep settings the UI does not edit (slack, port, …) unless sent explicitly; null clears a setting.
    const merged = { ...config, ...next };
    for (const [k, v] of Object.entries(body.config ?? {})) if (v === null || (k === 'blindLevels' && Array.isArray(v) && !v.length)) delete merged[k];
    const needsNewGame = structural(config) !== structural(merged);
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(merged, null, 2)}\n`);
    fs.renameSync(`${target}.tmp`, target);
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(config, merged);
    game.configPath = target;
    game.reloadTuning();
    game.changed();
    log(`[settings] saved config.json (${merged.ai.length} AI${needsNewGame ? ', new game needed' : ''})`);
    return { ok: true, needsNewGame };
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
    if ([...jobs.values()].some((j) => j.key === body.key && j.status === 'running')) return { ok: false, error: '这个角色的立绘正在生成中，等它结束再来' };
    const stage = ['portraits', 'poses', 'stickers', 'all'].includes(body.stage) ? body.stage : 'all';
    const id = String(++jobSeq);
    const args = [path.join(root, 'tools', 'art.mjs'), stage, body.key, ...(body.force ? ['--force'] : [])];
    const job = { id, key: body.key, stage, status: 'running', log: [], started: Date.now() };
    jobs.set(id, job);
    for (const old of jobs.keys()) if (jobs.size > MAX_JOBS && jobs.get(old).status !== 'running') jobs.delete(old);
    const finish = (status) => {
      if (job.status !== 'running') return;
      job.status = status;
      game.resolveArt();
      game.changed();
      log(`[settings] art ${stage} ${body.key} ${status}`);
    };
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true });
    const onData = (d) => {
      job.log.push(...String(d).split(/\r?\n/).filter(Boolean));
      if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => finish(code === 0 ? 'done' : 'failed'));
    child.on('error', (e) => {
      job.log.push(String(e));
      finish('failed');
    });
    return { ok: true, job: id };
  }

  // Returns true when the request was handled.
  return async function handle(req, res, url, send) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/config') return send(res, 200, publicConfig()), true;
    if (req.method === 'GET' && p === '/api/models') return send(res, 200, await models().catch((e) => ({ ok: false, error: String(e.message ?? e) }))), true;
    if (req.method === 'GET' && p === '/api/art/jobs') return send(res, 200, { ok: true, jobs: [...jobs.values()].slice(-20) }), true;
    if (req.method !== 'POST' || !['/api/config', '/api/art/upload', '/api/art/delete', '/api/art/generate', '/api/auto-next'].includes(p)) return false;
    try {
      if (p === '/api/art/upload') return send(res, 200, await upload(req, url)), true;
      const body = await readJson(req, 2 * 1024 * 1024);
      if (p === '/api/config') {
        const result = save(body);
        // Saving may switch LAN mode, which rebinds the server and drops connections: answer first.
        res.once('finish', () => onSaved?.());
        return send(res, 200, result), true;
      }
      if (p === '/api/art/delete') return send(res, 200, remove(body)), true;
      if (p === '/api/auto-next') return send(res, 200, game.setAutoNext(body.ms)), true;
      if (p === '/api/art/generate') return send(res, 200, generate(body)), true;
    } catch (e) {
      if (!res.headersSent) send(res, 200, { ok: false, error: String(e?.message ?? e) });
      return true;
    }
    return false;
  };
}
