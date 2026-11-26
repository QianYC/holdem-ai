import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Table } from '../src/engine.js';
import { blindSchedule, Game } from '../src/game.js';

// Models point at a closed port: every AI call fails fast and falls back to the built-in strategy.
function config(ais = 3) {
  return {
    startingStack: 200,
    smallBlind: 10,
    bigBlind: 20,
    minActionDelayMs: 0,
    quickReplies: false,
    sideline: { enabled: false },
    llm: { baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 2000 },
    ai: Array.from({ length: ais }, (_, i) => ({ name: `AI${i + 1}`, model: `fake-${i + 1}` })),
  };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOK_A = 'a'.repeat(32);

// Everyone still at the table checks or calls.
function autoPlay(game, onTurn) {
  game.on('humanTurn', ({ player, legal, turnId }) =>
    setImmediate(() => {
      if (onTurn?.(player, legal) === false) return;
      game.act(legal.canCheck ? 'check' : 'call', 0, 'test', turnId, player.seat);
    }),
  );
}

test('a guest leaving mid-hand folds at once, and rejoining keeps the seat', { timeout: 30000 }, async () => {
  const game = new Game(config(), { log: () => {} });
  assert.equal(game.join(TOK_A, 'Alice').ok, true);
  const seat = game.seatOfToken(TOK_A);
  assert.ok(seat > 0);
  assert.ok(game.guests[0].id.length > 20, 'guest ids are random, not derived from the token');
  let left = false;
  // The host makes Alice walk away on the host's first turn of a hand Alice is still playing.
  autoPlay(game, (player) => {
    const alice = game.table.players[seat];
    if (!left && player.seat === 0 && alice.inHand && !alice.folded && !alice.allIn) {
      assert.equal(game.leave(TOK_A).ok, true);
      left = true;
    }
  });
  for (let i = 0; i < 20 && !left; i++) {
    assert.equal(game.nextHand('test').ok, true);
    const t0 = Date.now();
    await game.running;
    assert.ok(Date.now() - t0 < 10000, 'the table never waits for a player who left');
  }
  assert.ok(left, 'Alice got to leave during a hand');
  const alice = game.table.players[seat];
  assert.equal(alice.sittingOut, true);
  assert.ok(alice.folded, 'her hand was folded, not checked along');
  assert.equal(game.pending, null);
  assert.equal(game.state(0).waitingFor, -1);
  assert.equal(game.seatOfToken(TOK_A), -1);

  const r = game.join(TOK_A, 'Alice');
  assert.equal(r.ok, true);
  assert.equal(r.seat, seat, 'same browser, same seat');
  assert.equal(game.table.players[seat].sittingOut, false);
  if (game.status !== 'gameOver' && game.table.players[seat].stack > 0) {
    assert.equal(game.nextHand('test').ok, true);
    assert.equal(game.table.players[seat].inHand, true, 'dealt in again');
    await game.running;
  }
});

test('restore keeps the seat of a guest who left (as sitting out)', { timeout: 30000 }, async () => {
  const dataDir = tmpDir();
  try {
    const a = new Game(config(), { log: () => {}, dataDir });
    assert.equal(a.join(TOK_A, 'Alice').ok, true);
    const seat = a.seatOfToken(TOK_A);
    autoPlay(a);
    assert.equal(a.nextHand('test').ok, true);
    await a.running;
    assert.equal(a.leave(TOK_A).ok, true);
    const stacks = a.table.players.map((p) => p.stack);

    const logs = [];
    const b = new Game(config(), { log: (m) => logs.push(m), dataDir });
    assert.equal(b.table.handNo, 1, `restored (${logs.join(' | ')})`);
    assert.equal(b.gameId, a.gameId);
    assert.deepEqual(b.table.players.map((p) => p.id), a.table.players.map((p) => p.id));
    assert.deepEqual(b.table.players.map((p) => p.stack), stacks);
    assert.equal(b.table.players[seat].name, 'Alice');
    assert.equal(b.table.players[seat].sittingOut, true);
    assert.equal(b.seatOfToken(TOK_A), -1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the tournament ends when the last opponent leaves between hands', { timeout: 30000 }, async () => {
  const game = new Game(config(0), { log: () => {} });
  assert.equal(game.join(TOK_A, 'Alice').ok, true);
  assert.equal(game.table.players.length, 2);
  autoPlay(game);
  assert.equal(game.nextHand('test').ok, true);
  await game.running;
  if (game.status === 'gameOver') return; // someone busted heads-up in one hand: nothing left to check
  assert.equal(game.leave(TOK_A).ok, true);
  const r = game.nextHand('test');
  assert.equal(r.ok, false);
  assert.equal(game.status, 'gameOver');
  assert.equal(game.gameOver.type, 'victory');
  assert.equal(game.gameOver.subject, 0);
  assert.equal(game.human.place, 1);
});

test('pausing spectate cancels the next hand that was already scheduled', { timeout: 30000 }, async () => {
  const game = new Game({ ...config(), spectateDelayMs: 60 }, { log: () => {} });
  autoPlay(game);
  assert.equal(game.nextHand('test').ok, true);
  await game.running;
  if (game.status !== 'handOver') return;
  // Pretend the host is watching: the next hand is due in 60 ms.
  game.spectating = true;
  game.scheduleAutoNext();
  assert.ok(game.autoNextAt);
  assert.equal(game.setSpectatePaused(true).ok, true);
  assert.equal(game.autoNextAt, null);
  const no = game.table.handNo;
  await sleep(200);
  assert.equal(game.table.handNo, no, 'still paused');
  assert.equal(game.setSpectatePaused(false).ok, true);
  assert.equal(game.table.handNo, no + 1, 'resuming deals right away');
  game.setSpectatePaused(true); // no further hands after this one
  await game.running;
  assert.equal(game.autoNextAt, null);
  game.spectating = false;
});

test('turn ids differ between games and failed quick replies stop loading', { timeout: 30000 }, async () => {
  const game = new Game({ ...config(), quickReplies: true }, { log: () => {} });
  const ids = [];
  const turn = () => new Promise((resolve) => game.once('humanTurn', resolve));
  for (let i = 0; i < 2; i++) {
    let t;
    for (let tries = 0; tries < 20 && !t; tries++) {
      const next = turn();
      assert.equal(game.nextHand('test').ok, true);
      t = await Promise.race([next, game.running.then(() => null)]);
    }
    assert.ok(t, 'the host got a turn');
    ids.push(t.turnId);
    for (let k = 0; k < 50 && game.state(0).quickReplies === 'loading'; k++) await sleep(20);
    assert.ok(Array.isArray(game.state(0).quickReplies), 'quick replies end up as a list, not "loading" forever');
    game.newGame();
    await sleep(0);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('a forced fold is not turned into a check', async () => {
  const t = new Table({
    seats: [
      { name: 'A', stack: 500 },
      { name: 'B', stack: 500 },
    ],
    smallBlind: 5,
    bigBlind: 10,
    button: 1,
    decide: async (p, legal) => (p.seat === 1 ? { action: 'fold', forceFold: true } : { action: legal.canCheck ? 'check' : 'call' }),
  });
  await t.playHand();
  assert.equal(t.players[1].folded, true);
  assert.deepEqual(t.hand.result.won, { 0: 20 });
  assert.equal(t.players[0].stack, 510);
});

test('blind levels follow the configured big blind', () => {
  assert.deepEqual(blindSchedule({ smallBlind: 10, bigBlind: 25, handsPerLevel: 5 }, 0), { sb: 10, bb: 25, level: 1, nextIn: 5, next: [15, 38] });
  const doubled = blindSchedule({ smallBlind: 10, bigBlind: 20, handsPerLevel: 5 }, 5);
  assert.deepEqual([doubled.sb, doubled.bb], [15, 30]);
});
