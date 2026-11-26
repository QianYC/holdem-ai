import assert from 'node:assert/strict';
import test from 'node:test';
import { compareScores, evaluate } from '../src/cards.js';
import { Table } from '../src/engine.js';

const ev = (s) => evaluate(s.split(' '));

test('hand categories', () => {
  assert.equal(ev('Ah Kh Qh Jh Th 2c 3d').name, '皇家同花顺');
  assert.equal(ev('5h 4h 3h 2h Ah Kc Kd').name, '同花顺（5 高）');
  assert.equal(ev('9s 9h 9d 9c 2h 3c Kd').score.join(), '7,9,13');
  assert.equal(ev('9s 9h 9d Kc Kh 3c 3d').score.join(), '6,9,13');
  assert.equal(ev('9s 9h 9d Kc Kh Kd 3d').score.join(), '6,13,9');
  assert.equal(ev('2h 7h 9h Jh Kh Ah 3c').score.join(), '5,14,13,11,9,7');
  assert.equal(ev('Ac 2d 3h 4s 5c 9d Kd').score.join(), '4,5');
  assert.equal(ev('Tc Jd Qh Ks Ac 9d 2d').score.join(), '4,14');
  assert.equal(ev('7c 7d 7h Ks 2c 9d 4d').score.join(), '3,7,13,9');
  assert.equal(ev('7c 7d 5h 5s 2c 2d Ad').score.join(), '2,7,5,14');
  assert.equal(ev('7c 7d 5h 5s 3c 3d 2d').score.join(), '2,7,5,3');
  assert.equal(ev('7c 7d 5h 4s 2c Jd Ad').score.join(), '1,7,14,11,5');
  assert.equal(ev('Ac Kd').score.join(), '0,14,13');
  assert.ok(compareScores(ev('Ac Ad 2c 3d 9h').score, ev('Kc Kd Ah Qd Jh').score) > 0);
});

function scripted(moves) {
  return async (p, legal) => {
    const m = moves.shift();
    if (!m) return { action: legal.canCheck ? 'check' : 'call' };
    assert.equal(m.seat, p.seat, `expected seat ${m.seat} to act, got ${p.seat}`);
    if (m.legal) m.legal(legal);
    return m;
  };
}

function stackedDeck(cards) {
  // engine pops from the end: hole cards first (two rounds), then burn+board.
  return () => cards.slice().reverse();
}

test('side pots with three all-ins', async () => {
  // button seat 0 -> sb 1, bb 2; deal order 1,2,0,1,2,0.
  const deck = stackedDeck([
    'Ah', '2c', 'Kh', //   first card to seats 1,2,0
    'Ad', '7d', 'Kd', //   second card
    '3s', 'Qc', 'Jc', '4h', // burn + flop
    '5s', '8h', // burn + turn
    '6s', '9c', // burn + river
  ]);
  const t = new Table({
    seats: [
      { name: 'A', stack: 1000 },
      { name: 'B', stack: 300 },
      { name: 'C', stack: 600 },
    ],
    smallBlind: 10,
    bigBlind: 20,
    button: 2,
    makeDeck: deck,
    decide: scripted([
      { seat: 0, action: 'allin' },
      { seat: 1, action: 'call' },
      { seat: 2, action: 'call' },
    ]),
  });
  const r = await t.playHand();
  assert.equal(t.button, 0);
  // seat1 AA wins main pot 900; seat 0 KK beats seat 2 (2-7) for the side pot 600; 400 refunded to seat 0.
  assert.deepEqual(r.refund, { seat: 0, amount: 400 });
  assert.equal(t.players[1].stack, 900);
  assert.equal(t.players[0].stack, 1000);
  assert.equal(t.players[2].stack, 0);
  assert.equal(t.players.reduce((s, p) => s + p.stack, 0), 1900);
});

test('incomplete all-in raise does not reopen action', async () => {
  const t = new Table({
    seats: [
      { name: 'A', stack: 1000 },
      { name: 'B', stack: 1000 },
      { name: 'C', stack: 130 },
    ],
    smallBlind: 10,
    bigBlind: 20,
    button: 2,
    decide: scripted([
      { seat: 0, action: 'raise', amount: 100 },
      { seat: 1, action: 'call' },
      { seat: 2, action: 'allin' },
      { seat: 0, action: 'raise', amount: 500, legal: (l) => assert.equal(l.canRaise, false) },
      { seat: 1, action: 'call', legal: (l) => assert.equal(l.toCall, 30) },
    ]),
  });
  // seat 0 is button (button=2 -> next is 0); sb=1, bb=2; first to act preflop = 0.
  await t.playHand();
  const log = t.hand.log.filter((e) => e.street === 'preflop');
  assert.deepEqual(
    log.map((e) => [e.seat, e.action, e.amount]),
    [
      [1, 'sb', 10],
      [2, 'bb', 20],
      [0, 'raise', 100],
      [1, 'call', 90],
      [2, 'raise', 130],
      [0, 'call', 30],
      [1, 'call', 30],
    ],
  );
});

test('heads-up: button posts small blind and acts first preflop', async () => {
  const order = [];
  const t = new Table({
    seats: [
      { name: 'A', stack: 500 },
      { name: 'B', stack: 500 },
    ],
    smallBlind: 5,
    bigBlind: 10,
    button: 1,
    decide: async (p, legal) => {
      order.push([t.hand.street, p.seat]);
      return { action: legal.canCheck ? 'check' : 'call' };
    },
  });
  await t.playHand();
  assert.equal(t.hand.sbSeat, 0);
  assert.equal(t.hand.button, 0);
  assert.deepEqual(order.slice(0, 4), [
    ['preflop', 0],
    ['preflop', 1],
    ['flop', 1],
    ['flop', 0],
  ]);
});

test('random play conserves chips and terminates', async () => {
  for (let game = 0; game < 30; game++) {
    const t = new Table({
      seats: Array.from({ length: 8 }, (_, i) => ({ name: `P${i}`, stack: 200 + i * 37 })),
      smallBlind: 5,
      bigBlind: 10,
      decide: async (p, legal) => {
        const r = Math.random();
        if (r < 0.15) return { action: 'fold' };
        if (r < 0.3 && legal.canRaise) return { action: 'raise', amount: legal.minTo + Math.floor(Math.random() * legal.maxTo) };
        if (r < 0.35) return { action: 'allin' };
        if (r < 0.4) return { action: 'gibberish' };
        return { action: legal.canCheck ? 'check' : 'call' };
      },
    });
    const total = t.players.reduce((s, p) => s + p.stack, 0);
    let hands = 0;
    while (t.live().length > 1 && hands < 400) {
      await t.playHand();
      hands++;
      assert.equal(t.players.reduce((s, p) => s + p.stack, 0), total);
      assert.ok(t.players.every((p) => p.stack >= 0 && Number.isInteger(p.stack)));
      const r = t.hand.result;
      assert.equal(Object.values(r.net).reduce((s, x) => s + x, 0), 0);
    }
  }
});
