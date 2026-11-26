import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from './game.js';
import { createSettingsApi, readJson } from './settings.js';
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
// Slack mirroring is opt-in (slack.enabled: true). Settings are read once at startup.
const slackCfg = {
  bridgeUrl: 'http://127.0.0.1:3091',
  bridgeTokenFile: process.env.SLACK_BRIDGE_TOKEN_FILE ?? '',
  stateFile: path.join(DATA, 'slack-state.json'),
  ...(config.slack ?? {}),
};
const slack = config.slack?.enabled === true ? new SlackMirror(game, slackCfg, { port: PORT, log, serverScript: fileURLToPath(import.meta.url), publicDir: PUBLIC }) : null;

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

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
const lanUrls = () => lanAddresses().map((a) => `http://${a}:${PORT}`);

// Host header allowlist: blocks DNS rebinding (a web page whose domain suddenly points at 127.0.0.1 would otherwise be
// treated as the host). Loopback names always; this machine's LAN addresses (and lan.hostnames) in LAN mode.
let lanHostsCache = { at: 0, hosts: [] };
function allowedHost(header) {
  const h = String(header ?? '').toLowerCase();
  const withPort = (name) => (PORT === 80 ? [name, `${name}:80`] : [`${name}:${PORT}`]);
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  if (config.lan?.enabled) {
    if (Date.now() - lanHostsCache.at > 10000) lanHostsCache = { at: Date.now(), hosts: lanAddresses() };
    names.push(...lanHostsCache.hosts, ...(Array.isArray(config.lan.hostnames) ? config.lan.hostnames.map((n) => String(n).toLowerCase()) : []));
  }
  return names.some((n) => withPort(n).includes(h));
}

// What LAN guests (and spectators) may call; everything else under /api/ is the host's.
const GUEST_API = new Set(['/api/join', '/api/leave', '/api/action', '/api/say']);

function stateFor(viewer) {
  const seat = viewer.host ? 0 : game.seatOfToken(viewer.token);
  const s = game.state(seat);
  const guest = viewer.token ? game.guests.find((g) => g.token === viewer.token) : null;
  s.isHost = viewer.host;
  if (!viewer.host) s.slack = null;
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

const sha256 = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
const samePassword = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

// ---------------------------------------------------------------- SSE (one stream per browser, its own view)
const clients = new Map(); // res -> viewer
let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const cache = new Map();
    for (const [res, viewer] of clients) {
      try {
        const key = viewer.host ? 'host' : `t:${viewer.token}`;
        if (!cache.has(key)) cache.set(key, `data: ${JSON.stringify(stateFor(viewer))}\n\n`);
        res.write(cache.get(key));
      } catch (e) {
        log('push failed', String(e?.stack ?? e));
      }
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
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// A file under public/, or null (no traversal out of it, no directories).
function publicFile(pathname) {
  const full = path.resolve(PUBLIC, `.${path.posix.normalize(`/${pathname === '/' ? 'index.html' : pathname}`)}`);
  const rel = path.relative(PUBLIC, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    // Origin-form targets only ("/path?query"); prefixing keeps "//x" a path instead of a host.
    if (!req.url.startsWith('/')) return send(res, 400, { ok: false });
    url = new URL(`http://127.0.0.1:${PORT}${req.url}`);
    if (!allowedHost(req.headers.host)) return send(res, 421, { ok: false, error: 'unknown host' });
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {}
    const viewer = viewerOf(req, url);
    const api = url.pathname.startsWith('/api/');
    if (!viewer.host && api && !(req.method === 'POST' && GUEST_API.has(url.pathname))) return send(res, 403, { ok: false, error: '只有房主可以这样做' });

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(stateFor(viewer))}\n\n`);
      clients.set(res, viewer);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, stateFor(viewer));

    if (req.method === 'POST' && url.pathname === '/slack/hook') {
      if (!slack || !isLoopback(req.socket.remoteAddress) || !slack.checkToken(String(req.headers['x-bridge-token'] ?? ''))) return send(res, 401, { ok: false });
      const payload = await readJson(req);
      send(res, 200, { ok: true });
      log('[slack] hook', payload.type, JSON.stringify(payload.text ?? payload.action_id ?? ''));
      slack.handleHook(payload).catch((e) => log('[slack] hook failed', String(e?.stack ?? e)));
      return;
    }

    // Browser requests that change something: same origin only (blocks other pages from playing for you).
    // The Host header is already known to be ours, so the page's origin must be exactly it.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { ok: false });
    }
    if (api && (await settingsApi(req, res, url, send))) return;

    if (req.method === 'GET') {
      const file = api ? null : publicFile(pathname);
      if (!file) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false });

    const body = await readJson(req);
    const seat = viewer.host ? 0 : viewer.seat;
    switch (url.pathname) {
      case '/api/action':
        return send(res, 200, seat < 0 ? { ok: false, error: '你还没有入座' } : game.act(body.action, body.amount, viewer.host ? 'web' : 'lan', body.turnId, seat));
      case '/api/say':
        return send(res, 200, seat < 0 ? { ok: false, error: '入座之后才能发言' } : game.say(body.text, viewer.host ? 'web' : 'lan', seat));
      case '/api/join': {
        if (viewer.host) return send(res, 200, { ok: false, error: '房主已经在桌上了' });
        if (!config.lan?.enabled) return send(res, 200, { ok: false, error: '房主没有开启局域网模式' });
        // Renaming (a token that already joined) does not ask for the room password again.
        const known = Boolean(viewer.token) && game.guests.some((g) => g.token === viewer.token);
        if (!known && config.lan?.password && !samePassword(body.password, config.lan.password)) return send(res, 200, { ok: false, error: '房间密码不对' });
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
        let error = null;
        await slack.enqueue(() =>
          slack.openThread(body.channel ?? slackCfg.channel).catch((e) => {
            error = e;
          }),
        );
        return send(res, 200, error ? { ok: false, error: String(error?.message ?? error) } : { ok: Boolean(slack.thread), thread: slack.thread });
      }
      case '/api/slack/stop':
        if (!slack) return send(res, 200, { ok: false, error: 'Slack 未启用' });
        slack.stop();
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { ok: false });
    }
  } catch (e) {
    // Path only: guest tokens can ride in the query string.
    log('request failed', req.method, url?.pathname ?? '(bad url)', String(e?.stack ?? e));
    if (!res.headersSent && !res.destroyed) send(res, url ? 500 : 400, { ok: false, error: String(e?.message ?? e) });
  }
});

server.on('error', (e) => log('server error', String(e?.message ?? e)));

// LAN mode listens on every interface; otherwise only on this machine. Re-run after settings change.
// HOLDEM_LISTEN_HOST pins the interface (tests).
const wantedHost = () => process.env.HOLDEM_LISTEN_HOST || (config.lan?.enabled ? '0.0.0.0' : '127.0.0.1');
let boundHost = null;
let binding = false;
let started = false;
function listen(host = wantedHost()) {
  if (binding || host === boundHost) return;
  binding = true;
  const wanted = wantedHost();
  const start = () => {
    const fail = (e) => {
      binding = false;
      log(`cannot listen on ${host}:${PORT}: ${e?.message ?? e}`);
      if (!started) process.exit(1);
      // Keep at least the host's own page reachable.
      if (host !== '127.0.0.1') listen('127.0.0.1');
    };
    server.once('error', fail);
    server.listen(PORT, host, () => {
      server.off('error', fail);
      boundHost = host;
      binding = false;
      log(`holdem-ai listening on http://${host}:${PORT}${host === '0.0.0.0' ? `  LAN: ${lanUrls().join(' ')}` : ''}  (${config.ai.map((a) => a.model).join(', ')})`);
      if (!started && slack) {
        slack.saveState();
        slack.registerWithRetry();
      }
      started = true;
      pushState();
      // Settings changed again while we were rebinding.
      if (wantedHost() !== wanted) listen();
    });
  };
  if (boundHost) {
    boundHost = null;
    for (const res of clients.keys()) res.end();
    clients.clear();
    server.close(() => start());
    server.closeAllConnections?.();
  } else start();
}
listen();
