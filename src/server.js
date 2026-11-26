import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from './game.js';
import { createSettingsApi } from './settings.js';
import { SlackMirror } from './slack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.HOLDEM_DATA ?? path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

// config.json is your local copy (git-ignored); config.example.json is the shipped default.
const CONFIG_PATH = process.env.HOLDEM_CONFIG ?? [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')].find((p) => fs.existsSync(p));
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = Number(process.env.HOLDEM_PORT ?? config.port ?? 3095);

const LOG_FILE = path.join(DATA, 'server.log');
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {}
}
process.on('unhandledRejection', (e) => log('unhandledRejection', String(e?.stack ?? e)));

const game = new Game(config, { log, dataDir: DATA, configPath: CONFIG_PATH, publicDir: PUBLIC });
const settingsApi = createSettingsApi({
  root: ROOT,
  publicDir: PUBLIC,
  config,
  game,
  log,
  savePath: process.env.HOLDEM_CONFIG ?? path.join(ROOT, 'config.json'),
  onSaved: () => listen(),
});
const slackCfg = {
  bridgeUrl: 'http://127.0.0.1:3091',
  bridgeTokenFile: process.env.SLACK_BRIDGE_TOKEN_FILE ?? '',
  stateFile: path.join(DATA, 'slack-state.json'),
  ...(config.slack ?? {}),
};
const slack = config.slack?.enabled === false ? null : new SlackMirror(game, slackCfg, { port: PORT, log, serverScript: fileURLToPath(import.meta.url) });

game.on('action', ({ entry, player }) => {
  if (player.kind === 'ai') log(`[hand ${game.table.handNo}] ${player.name} ${entry.action} ${entry.amount}${entry.fallback ? ' (fallback)' : ''} ${entry.ms ?? ''}ms${entry.tools ? ` 🔍${entry.tools.join(',')}` : ''} ${entry.say ?? ''}`);
});

// ---------------------------------------------------------------- who is asking
// The host is whoever uses the server's own machine (loopback). LAN players identify with the token their
// browser generated and registered through /api/join; everyone else just watches.
const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);

function viewerOf(req, url) {
  const token = String(req.headers['x-player'] ?? url.searchParams.get('player') ?? '');
  const host = isLoopback(req.socket.remoteAddress) && url.searchParams.get('as') !== 'guest';
  if (host) return { host: true, token: '', seat: 0 };
  return { host: false, token, seat: game.seatOfToken(token) };
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

function stateFor(viewer) {
  const seat = viewer.host ? 0 : game.seatOfToken(viewer.token);
  const s = game.state(seat);
  const guest = viewer.token ? game.guests.find((g) => g.token === viewer.token) : null;
  s.isHost = viewer.host;
  s.lan = {
    enabled: Boolean(config.lan?.enabled),
    urls: viewer.host && config.lan?.enabled ? lanUrls() : [],
    needPassword: Boolean(config.lan?.password),
    joined: viewer.host || Boolean(guest),
    myName: guest?.name ?? null,
    players: game.guests.map((g) => ({ name: g.name, seated: game.seatOfToken(g.token) >= 0, id: viewer.host ? g.id : undefined })),
  };
  return s;
}

// ---------------------------------------------------------------- SSE (one stream per browser, its own view)
const clients = new Map(); // res -> viewer
let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const cache = new Map();
    for (const [res, viewer] of clients) {
      const key = viewer.host ? 'host' : `t:${viewer.token}`;
      if (!cache.has(key)) cache.set(key, `data: ${JSON.stringify(stateFor(viewer))}\n\n`);
      res.write(cache.get(key));
    }
  }, 30);
}
game.on('change', pushState);
setInterval(() => {
  for (const res of clients.keys()) res.write(': ping\n\n');
}, 20000).unref();

// ---------------------------------------------------------------- HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const HOST_ONLY = ['/api/config', '/api/models', '/api/art/', '/api/auto-next', '/api/next', '/api/new-game', '/api/rebuy', '/api/spectate', '/api/slack/', '/api/lan/kick'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {}
  const viewer = viewerOf(req, url);
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(stateFor(viewer))}\n\n`);
      clients.set(res, viewer);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, stateFor(viewer));
    if (!viewer.host && HOST_ONLY.some((p) => url.pathname === p || (p.endsWith('/') && url.pathname.startsWith(p)) || url.pathname.startsWith(`${p}/`))) {
      return send(res, 403, { ok: false, error: '只有房主可以这样做' });
    }
    if (url.pathname.startsWith('/api/') && (await settingsApi(req, res, url, send))) return;
    if (req.method === 'GET') {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      const full = path.join(PUBLIC, path.normalize(file));
      if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(full), TYPES[path.extname(full)] ?? 'application/octet-stream');
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false });

    if (url.pathname === '/slack/hook') {
      if (!slack || !isLoopback(req.socket.remoteAddress) || !slack.checkToken(String(req.headers['x-bridge-token'] ?? ''))) return send(res, 401, { ok: false });
      const payload = await readBody(req);
      send(res, 200, { ok: true });
      log('[slack] hook', payload.type, JSON.stringify(payload.text ?? payload.action_id ?? ''));
      slack.handleHook(payload).catch((e) => log('[slack] hook failed', String(e?.stack ?? e)));
      return;
    }

    // Browser endpoints: same-origin only (blocks other pages from playing for you).
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { ok: false });
    const body = await readBody(req);
    const seat = viewer.host ? 0 : viewer.seat;
    switch (url.pathname) {
      case '/api/action':
        return send(res, 200, seat < 0 ? { ok: false, error: '你还没有入座' } : game.act(body.action, body.amount, viewer.host ? 'web' : 'lan', body.turnId, seat));
      case '/api/say':
        return send(res, 200, seat < 0 ? { ok: false, error: '入座之后才能发言' } : game.say(body.text, viewer.host ? 'web' : 'lan', seat));
      case '/api/join': {
        if (viewer.host) return send(res, 200, { ok: false, error: '房主已经在桌上了' });
        if (!config.lan?.enabled) return send(res, 200, { ok: false, error: '房主没有开启局域网模式' });
        if (config.lan?.password && body.password !== config.lan.password) return send(res, 200, { ok: false, error: '房间密码不对' });
        return send(res, 200, game.join(viewer.token, body.name));
      }
      case '/api/leave':
        return send(res, 200, game.leave(viewer.token));
      case '/api/lan/kick': {
        const g = game.guests.find((x) => x.id === body.id);
        return send(res, 200, g ? game.leave(g.token) : { ok: false, error: '没有这个玩家' });
      }
      case '/api/spectate':
        return send(res, 200, game.spectate());
      case '/api/spectate/pause':
        return send(res, 200, game.setSpectatePaused(body.paused));
      case '/api/next':
        return send(res, 200, game.nextHand('web'));
      case '/api/rebuy':
        return send(res, 200, game.rebuy());
      case '/api/new-game':
        game.newGame();
        return send(res, 200, { ok: true });
      case '/api/slack/open': {
        if (!slack) return send(res, 200, { ok: false, error: 'Slack 未启用' });
        await slack.enqueue(() => slack.openThread(body.channel ?? slackCfg.channel));
        return send(res, 200, { ok: Boolean(slack.thread), thread: slack.thread });
      }
      case '/api/slack/stop':
        slack?.stop();
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { ok: false });
    }
  } catch (e) {
    log('request failed', req.url, String(e?.stack ?? e));
    if (!res.headersSent) send(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

server.on('error', (e) => {
  log('server error', String(e?.message ?? e));
  if (e.code === 'EADDRINUSE') process.exit(1);
});

// LAN mode listens on every interface; otherwise only on this machine. Re-run after settings change.
let boundHost = null;
let started = false;
function listen() {
  const host = config.lan?.enabled ? '0.0.0.0' : '127.0.0.1';
  if (host === boundHost) return;
  const start = () =>
    server.listen(PORT, host, () => {
      boundHost = host;
      log(`holdem-ai listening on http://${host}:${PORT}${host === '0.0.0.0' ? `  LAN: ${lanUrls().join(' ')}` : ''}  (${config.ai.map((a) => a.model).join(', ')})`);
      if (!started && slack) {
        slack.saveState();
        slack.registerWithRetry();
      }
      started = true;
      pushState();
    });
  if (boundHost) {
    for (const res of clients.keys()) res.end();
    clients.clear();
    server.close(() => start());
    server.closeAllConnections?.();
  } else start();
}
listen();
