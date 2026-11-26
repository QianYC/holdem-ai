// Unit checks for src/ai.js (routes, keys, decision deadline) and src/slack.js helpers.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aiDecide, apiKey, DSH_ORIGIN, firstJsonObject, onUsage, routeOf } from '../src/ai.js';
import { parseCommandText, SlackMirror } from '../src/slack.js';

test('routeOf: allowed types only, dsh-account pinned to DeepSeek', () => {
  const cfg = {
    baseUrl: 'http://127.0.0.1:9/v1',
    providers: {
      ds: { type: 'anthropic-messages', baseUrl: `${DSH_ORIGIN}/anthropic`, auth: 'dsh-account' },
      evil: { type: 'anthropic-messages', baseUrl: 'https://evil.example/anthropic', auth: 'dsh-account' },
      wrongType: { type: 'anthropic', baseUrl: 'https://x.example' },
      dshOnResponses: { baseUrl: `${DSH_ORIGIN}/v1`, auth: 'dsh-account' },
      plain: { baseUrl: 'https://x.example/v1', apiKey: 'k' },
    },
  };
  assert.equal(routeOf(cfg, { provider: 'ds' }).type, 'anthropic-messages');
  assert.equal(routeOf(cfg, { provider: 'plain' }).type, 'openai-responses');
  assert.equal(routeOf(cfg, null).name, 'default');
  assert.throws(() => routeOf(cfg, { provider: 'evil' }));
  assert.throws(() => routeOf(cfg, { provider: 'wrongType' }));
  assert.throws(() => routeOf(cfg, { provider: 'dshOnResponses' }));
  assert.throws(() => routeOf(cfg, { provider: 'missing' }));
});

test('apiKey: the local proxy key is only used for an endpoint on this machine', () => {
  const saved = process.env.LOCAL_API_KEY;
  delete process.env.LOCAL_API_KEY;
  try {
    assert.equal(apiKey({ baseUrl: 'https://api.example.com/v1' }), 'local');
    assert.equal(apiKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'mine' }), 'mine');
  } finally {
    if (saved !== undefined) process.env.LOCAL_API_KEY = saved;
  }
});

test('firstJsonObject skips prose and braces inside strings', () => {
  assert.deepEqual(firstJsonObject('ok {"say": "a } b", "n": 1} tail'), { say: 'a } b', n: 1 });
  assert.equal(firstJsonObject('no json'), null);
});

test('aiDecide gives up at the decision deadline and reports the failed call', { timeout: 15000 }, async () => {
  const hung = http.createServer(() => {}); // never answers
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const reports = [];
  onUsage((e) => reports.push(e));
  try {
    const cfg = { baseUrl: `http://127.0.0.1:${hung.address().port}/v1`, apiKey: 'test', timeoutMs: 10000, decisionTimeoutMs: 400 };
    const player = { id: 'ai1', name: 'T', model: 'fake', seat: 0 };
    const legal = { canCheck: true, canCall: false, canRaise: false, toCall: 0, pot: 30, stack: 200, currentBet: 0, minTo: 40, maxTo: 200 };
    const view = {
      handNo: 1,
      street: 'preflop',
      board: [],
      bigBlind: 20,
      log: [],
      players: [
        { seat: 0, hole: ['As', 'Ad'], inHand: true, folded: false },
        { seat: 1, hole: [null, null], inHand: true, folded: false },
      ],
    };
    const t0 = Date.now();
    const d = await aiDecide(cfg, player, legal, view, [], () => {}, [], { get_latest_round: () => ({}) });
    assert.equal(d.fallback, true);
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.ok(reports.some((r) => r.ok === false && r.player === player));
  } finally {
    onUsage(null);
    hung.closeAllConnections();
    hung.close();
  }
});

test('Slack text commands', () => {
  assert.deepEqual(parseCommandText('加注 300'), { kind: 'act', action: 'raise', amount: 300 });
  assert.deepEqual(parseCommandText('跟'), { kind: 'act', action: 'call' });
  assert.equal(parseCommandText('说 你好').text, '你好');
  assert.equal(parseCommandText('???').kind, 'help');
});

test('Slack image paths: cache-busting query ignored, nothing outside public/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-slack-test-'));
  try {
    const pub = path.join(dir, 'public');
    fs.mkdirSync(path.join(pub, 'characters', 'x'), { recursive: true });
    fs.writeFileSync(path.join(pub, 'characters', 'x', 'lose.png'), 'png');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'no');
    const m = new SlackMirror(new EventEmitter(), { stateFile: path.join(dir, 'slack-state.json') }, { port: 1, log: () => {}, publicDir: pub });
    assert.equal(m.localFile('/characters/x/lose.png?v=123'), path.join(pub, 'characters', 'x', 'lose.png'));
    assert.equal(m.localFile('/characters/x/missing.png?v=1'), null);
    assert.equal(m.localFile('/../secret.txt'), null);
    assert.equal(m.localFile('/%2e%2e/secret.txt'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
