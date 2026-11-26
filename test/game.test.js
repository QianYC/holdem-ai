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
