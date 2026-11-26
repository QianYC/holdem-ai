import crypto from 'node:crypto';

export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';
export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK_NAME = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };

export function newDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

export function shuffle(deck, randomInt = crypto.randomInt) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export const rankValue = (card) => RANKS.indexOf(card[0]) + 2;
export const rankName = (v) => RANK_NAME[v];

export function cardLabel(card) {
  return `${card[0] === 'T' ? '10' : card[0]}${SUIT_SYMBOL[card[1]]}`;
}

function straightTop(values) {
  const set = new Set(values);
  if (set.has(14)) set.add(1);
  for (let top = 14; top >= 5; top--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      if (!set.has(top - k)) {
        ok = false;
        break;
      }
    }
    if (ok) return top;
  }
  return 0;
}

// Best poker hand from 1-7 cards. score compares lexicographically: [category, ...tiebreakers].
export function evaluate(cards) {
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const bySuit = new Map();
  for (const c of cards) {
    if (!bySuit.has(c[1])) bySuit.set(c[1], []);
    bySuit.get(c[1]).push(rankValue(c));
  }
  let flush = null;
  for (const vs of bySuit.values()) if (vs.length >= 5) flush = vs.sort((a, b) => b - a);

  if (flush) {
    const sf = straightTop(flush);
    if (sf) return result([8, sf]);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ranksWith = (n) => groups.filter(([, c]) => c >= n).map(([v]) => v);
  const kickers = (exclude, n) => values.filter((v) => !exclude.includes(v)).filter((v, i, a) => a.indexOf(v) === i).slice(0, n);

  if (groups[0][1] === 4) {
    const q = groups[0][0];
    return result([7, q, ...kickers([q], 1)]);
  }
  const trips = ranksWith(3);
  if (trips.length) {
    const t = trips[0];
    const pairForBoat = ranksWith(2).filter((v) => v !== t);
    if (pairForBoat.length) return result([6, t, pairForBoat[0]]);
  }
  if (flush) return result([5, ...flush.slice(0, 5)]);
  const st = straightTop(values);
  if (st) return result([4, st]);
  if (trips.length) return result([3, trips[0], ...kickers([trips[0]], 2)]);
  const pairs = ranksWith(2);
  if (pairs.length >= 2) return result([2, pairs[0], pairs[1], ...kickers([pairs[0], pairs[1]], 1)]);
  if (pairs.length === 1) return result([1, pairs[0], ...kickers([pairs[0]], 3)]);
  return result([0, ...values.slice(0, 5)]);
}

function result(score) {
  return { score, category: score[0], name: describe(score) };
}

function describe(score) {
  const [cat, a, b] = score;
  switch (cat) {
    case 8:
      return a === 14 ? '皇家同花顺' : `同花顺（${rankName(a)} 高）`;
    case 7:
      return `四条 ${rankName(a)}`;
    case 6:
      return `葫芦（${rankName(a)} 带 ${rankName(b)}）`;
    case 5:
      return `同花（${rankName(a)} 高）`;
    case 4:
      return `顺子（${rankName(a)} 高）`;
    case 3:
      return `三条 ${rankName(a)}`;
    case 2:
      return `两对 ${rankName(a)} 和 ${rankName(b)}`;
    case 1:
      return `一对 ${rankName(a)}`;
    default:
      return `高牌 ${rankName(a)}`;
  }
}

export function compareScores(x, y) {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Monte Carlo equity of `hole` against `opponents` random hands given a partial board.
export function equity(hole, board, opponents, iterations = 400) {
  const known = new Set([...hole, ...board]);
  const rest = newDeck().filter((c) => !known.has(c));
  let score = 0;
  for (let it = 0; it < iterations; it++) {
    const deck = rest.slice();
    const need = 5 - board.length + opponents * 2;
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (deck.length - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const fullBoard = board.concat(deck.slice(0, 5 - board.length));
    const mine = evaluate(hole.concat(fullBoard)).score;
    let best = 1;
    let ties = 1;
    for (let o = 0; o < opponents; o++) {
      const off = 5 - board.length + o * 2;
      const theirs = evaluate(deck.slice(off, off + 2).concat(fullBoard)).score;
      const cmp = compareScores(mine, theirs);
      if (cmp < 0) {
        best = 0;
        break;
      }
      if (cmp === 0) ties++;
    }
    if (best) score += 1 / ties;
  }
  return score / iterations;
}
