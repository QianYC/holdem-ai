import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from '../src/game.js';

function config() {
  return {
    startingStack: 200,
    smallBlind: 10,
    bigBlind: 20,
    minActionDelayMs: 0,
    llm: { baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 2000 },
    ai: Array.from({ length: 7 }, (_, i) => ({ name: `AI${i + 1}`, model: `fake-${i + 1}` })),
  };
}

async function playUntilOver(game, maxHands = 400) {
  game.on('humanTurn', ({ legal, turnId }) => {
    setImmediate(() => game.act(legal.canRaise ? 'raise' : legal.canCall ? 'call' : 'check', legal.maxTo, 'test', turnId));
  });
  const over = new Promise((resolve) => game.once('gameOver', resolve));
  for (let i = 0; i < maxHands && game.status !== 'gameOver'; i++) {
    const r = game.nextHand('test');
    assert.ok(r.ok, r.error);
    await game.running;
  }
  assert.equal(game.status, 'gameOver');
  return over;
}

test('after busting you can spectate until one AI is champion', { timeout: 120000 }, async () => {
  let over;
  for (let tries = 0; tries < 20; tries++) {
    const game = new Game({ ...config(), spectateDelayMs: 1 }, { log: () => {} });
    over = await playUntilOver(game);
    if (over.type !== 'defeat') continue;
    const champion = new Promise((resolve) => game.on('gameOver', (o) => o.type === 'champion' && resolve(o)));
    assert.equal(game.spectate().ok, true);
    assert.equal(game.say('加油！', 'test').ok, true);
    const result = await champion;
    const s = game.state();
    assert.equal(s.status, 'gameOver');
    assert.equal(s.players[result.rival].place, 1);
    assert.equal(s.players.filter((p) => p.stack > 0).length, 1);
    const places = s.players.map((p) => p.place).sort((a, b) => a - b);
    assert.deepEqual(places, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(s.players.reduce((a, p) => a + p.stack, 0), 1600);
    assert.equal(game.spectate().ok, false);
    return;
  }
  assert.fail('never busted in 20 games');
});

test('busted players are eliminated for good and the game ends', { timeout: 120000 }, async () => {
  const game = new Game(config(), { log: () => {} });
  const over = await playUntilOver(game);
  const s = game.state();
  const places = s.players.filter((p) => p.place).map((p) => p.place);
  assert.equal(new Set(places).size, places.length, 'places are unique');
  for (const p of s.players.filter((x) => x.place && x.place > 1)) {
    assert.equal(p.stack, 0);
    assert.equal(p.buyIns, 1, 'no rebuys');
  }
  if (over.type === 'defeat') {
    assert.ok(s.players[0].place >= 2);
    assert.ok(typeof over.rival === 'number' && over.rival !== 0);
  } else {
    assert.equal(s.players[0].place, 1);
    assert.equal(s.players.filter((p) => p.stack > 0).length, 1);
  }
  assert.ok(over.taunt, 'taunt (or fallback) is set');
  assert.equal(game.nextHand('test').ok, false);
  assert.equal(game.rebuy().ok, false);
  assert.equal(s.players.reduce((a, p) => a + p.stack, 0), 1600);
  game.newGame();
  assert.equal(game.status, 'ready');
  assert.ok(game.state().players.every((p) => p.stack === 200 && !p.place));
});

test('auto next hand deals the next hand by itself', { timeout: 60000 }, async () => {
  const game = new Game({ ...config(), autoNextHandMs: 30 }, { log: () => {} });
  game.on('humanTurn', ({ legal, turnId }) => setImmediate(() => game.act(legal.canCheck ? 'check' : 'fold', 0, 'test', turnId)));
  game.nextHand('test');
  const deadline = Date.now() + 20000;
  while (game.table.handNo < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(game.table.handNo >= 3, `only ${game.table.handNo} hands dealt`);
  game.setAutoNext(0);
  await game.running;
  const no = game.table.handNo;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(game.table.handNo, no, 'stops after switching off');
});

test('LAN: several humans share the table, each sees only their own cards', { timeout: 120000 }, async () => {
  const game = new Game({ ...config(), ai: config().ai.slice(0, 3) }, { log: () => {} });
  const tokA = 'a'.repeat(32);
  const tokB = 'b'.repeat(32);
  assert.equal(game.join(tokA, 'Alice').ok, true);
  assert.equal(game.join(tokB, 'Bob').ok, true);
  assert.equal(game.join('c'.repeat(32), 'Alice').ok, false, 'names are unique');
  const seatA = game.seatOfToken(tokA);
  const seatB = game.seatOfToken(tokB);
  assert.ok(seatA > 0 && seatB > 0 && seatA !== seatB, 'guests are seated before the first hand');
  assert.equal(game.table.players.length, 6);
  game.on('humanTurn', ({ player, legal, turnId }) =>
    setImmediate(() => {
      assert.equal(game.act('check', 0, 'test', turnId, (player.seat + 1) % 6).ok, false, 'nobody can act for someone else');
      game.act(legal.canRaise && Math.random() < 0.5 ? 'raise' : legal.canCall ? 'call' : 'check', legal.maxTo, 'test', turnId, player.seat);
    }),
  );
  game.nextHand('test');
  await new Promise((r) => setTimeout(r, 0));
  const view = game.state(seatA);
  assert.equal(view.you, seatA);
  assert.ok(view.players[seatA].hole.every(Boolean), 'Alice sees her cards');
  assert.ok(view.players[seatB].hole.every((c) => c === null), "Alice does not see Bob's cards");
  assert.ok(game.state(0).players[seatA].hole.every((c) => c === null), "the host does not see Alice's cards");
  for (let i = 0; i < 400 && game.status !== 'gameOver'; i++) {
    if (game.running) await game.running;
    if (game.status === 'gameOver') break;
    const r = game.nextHand('test');
    if (!r.ok) break;
    await game.running;
  }
  const s = game.state(0);
  assert.equal(s.status, 'gameOver');
  assert.equal(s.players.reduce((a, p) => a + p.stack, 0), 1200);
  const humansOut = s.players.filter((p) => p.kind === 'human' && p.place && p.place > 1);
  for (const h of humansOut) if (s.gameOver.subject !== h.seat && s.gameOver.type !== 'defeat') assert.ok(game.table.players[h.seat].out || h.place, 'busted humans get a result');
});

test('AIs remember table talk from earlier hands', { timeout: 60000 }, async () => {
  const { buildPrompt } = await import('../src/ai.js');
  const game = new Game(config(), { log: () => {} });
  let said = false;
  game.on('humanTurn', ({ legal, turnId }) =>
    setImmediate(() => {
      if (!said) said = game.say('这把我拿的是 AA，信不信由你', 'test').ok;
      game.act(legal.canCheck ? 'check' : 'fold', 0, 'test', turnId);
    }),
  );
  game.nextHand('test');
  await game.running;
  assert.ok(said);
  assert.ok(game.talk.some((t) => t.say?.includes('AA') && t.hand === 1));
  const ai = game.table.players.find((p) => p.kind === 'ai');
  const prompt = buildPrompt(ai, { canCheck: true, toCall: 0, minTo: 40, maxTo: 200, pot: 30, stack: 200 }, game.table.viewFor(ai), [], game.talk);
  assert.match(prompt, /本局之前各手的牌桌发言/);
  assert.match(prompt, /第1手 房主 说：「这把我拿的是 AA/);
});
