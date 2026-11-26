// HTTP-level checks of src/server.js: runs a real server on a free port with a temp config and data dir.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LAN = 'lan-test.local';
let port;
let dir;
let child;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const host = () => ({ origin: `http://127.0.0.1:${port}` });
const guest = () => ({ host: `${LAN}:${port}`, origin: `http://${LAN}:${port}`, 'x-player': TOKEN });

before(async () => {
  port = await freePort();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-server-test-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  cfg.ai = cfg.ai.filter((a) => !a.provider).slice(0, 3);
  cfg.slack = { enabled: false };
  cfg.quickReplies = false;
  cfg.lan = { enabled: true, password: 'pw', hostnames: [LAN] };
  cfg.llm.providers.testprov = { type: 'anthropic-messages', baseUrl: 'https://example.invalid', apiKey: 'sk-test-not-real' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, HOLDEM_PORT: String(port), HOLDEM_CONFIG: path.join(dir, 'config.json'), HOLDEM_DATA: path.join(dir, 'data'), HOLDEM_LISTEN_HOST: '127.0.0.1' },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await request('GET', '/state')).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  child?.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

test('unknown Host headers are refused (DNS rebinding)', async () => {
  assert.equal((await request('GET', '/api/config', { headers: { host: `evil.example:${port}` } })).status, 421);
  assert.equal((await request('GET', '/state', { headers: { host: `evil.example:${port}` } })).status, 421);
  assert.equal((await request('GET', '/state')).json.isHost, true);
});

test('cross-origin POSTs are refused; same-origin ones pass', async () => {
  assert.equal((await request('POST', '/api/rebuy', { headers: { origin: `http://evil.example:${port}` }, body: {} })).status, 403);
  assert.equal((await request('POST', '/api/rebuy', { headers: host(), body: {} })).status, 200);
});

test('API keys are not sent to the settings page', async () => {
  const r = await request('GET', '/api/config');
  assert.equal(r.json.config.llm.providers.testprov.apiKey, '');
  assert.equal(r.json.providerKeys.testprov, true);
  assert.ok(!r.text.includes('sk-test-not-real'));
});

test('LAN guests can join (password once), act on guest routes only, and do not see Slack info', async () => {
  const bad = await request('POST', '/api/join?as=guest', { headers: guest(), body: { name: 'Bob', password: 'nope' } });
  assert.equal(bad.json.ok, false);
  const ok = await request('POST', '/api/join?as=guest', { headers: guest(), body: { name: 'Bob', password: 'pw' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true, ok.json.error);
  const rename = await request('POST', '/api/join?as=guest', { headers: guest(), body: { name: 'Bobby' } });
  assert.equal(rename.json.ok, true, rename.json.error);
  assert.equal((await request('GET', '/api/config?as=guest', { headers: guest() })).status, 403);
  assert.equal((await request('POST', '/api/new-game?as=guest', { headers: guest(), body: {} })).status, 403);
  assert.equal((await request('POST', '/api/spectate/pause?as=guest', { headers: guest(), body: {} })).status, 403);
  const s = (await request('GET', `/state?as=guest&player=${TOKEN}`, { headers: { host: `${LAN}:${port}` } })).json;
  assert.equal(s.isHost, false);
  assert.equal(s.slack, null);
  assert.equal(s.lan.myName, 'Bobby');
});

test('static files stay inside public/', async () => {
  assert.equal((await request('GET', '/')).status, 200);
  assert.equal((await request('GET', '/..%2F..%2Fconfig.example.json')).status, 404);
  assert.equal((await request('GET', '/..%5C..%5Cconfig.example.json')).status, 404);
  assert.equal((await request('GET', '//api/config')).status, 404);
});

test('a malformed request target gets an answer', async () => {
  const line = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET http://[bad/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
    let d = '';
    s.on('data', (c) => {
      d += c;
      resolve(d.split('\r\n')[0]);
      s.destroy();
    });
    s.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  assert.match(line, /^HTTP\/1\.1 400/);
});

test('settings save: null / [] clear keys, blank keys keep their value, dsh-account is pinned', async () => {
  const current = (await request('GET', '/api/config')).json.config;
  const save = (config) => request('POST', '/api/config', { headers: host(), body: { config } });
  let r = await save({ ...current, blindLevels: [[10, 20], [20, 40]] });
  assert.equal(r.json.ok, true, r.json.error);
  let file = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(file.blindLevels, [[10, 20], [20, 40]]);
  assert.equal(file.llm.providers.testprov.apiKey, 'sk-test-not-real');
  r = await save({ ...current, blindLevels: [], handsPerLevel: null });
  assert.equal(r.json.ok, true, r.json.error);
  file = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(!('blindLevels' in file));
  assert.ok(!('handsPerLevel' in file));
  const evil = structuredClone(current);
  evil.llm.providers.testprov = { type: 'anthropic-messages', baseUrl: 'https://evil.example', auth: 'dsh-account' };
  r = await save(evil);
  assert.equal(r.json.ok, false);
  const badType = structuredClone(current);
  badType.llm.providers.testprov = { type: 'anthropic', baseUrl: 'https://example.invalid', apiKey: 'x' };
  assert.equal((await save(badType)).json.ok, false);
});
