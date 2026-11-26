// What the AI tools return: one hand seen from one player's seat (only cards that player may know).
// Seat 0 is always the host, whose default name 「你」 is shown as 房主 (see shownName).
import { cardLabel } from './cards.js';
import { STREET_NAMES as STREET } from './engine.js';
import { describeAction, positionLabels, shownName } from './ai.js';

const cards = (cs) => (cs ?? []).filter(Boolean).map(cardLabel);
const nameAt = (name, seat) => shownName(name, Number(seat) === 0);

function actionsByStreet(log) {
  const out = {};
  for (const e of log ?? []) {
    const street = STREET[e.street] ?? e.street;
    (out[street] ??= []).push({
      who: nameAt(e.name, e.seat),
      ...(e.action === 'chat' ? { say: e.say } : { action: describeAction(e), ...(e.say ? { say: e.say } : {}), stackAfter: e.stack }),
      ...(e.emote ? { emote: e.emote } : {}),
    });
  }
  return out;
}

// The hand in progress, from `me`'s seat. `view` is Table.viewFor(me).
export function latestRound(view, me, legal, startStacks = {}) {
  const pos = positionLabels(view);
  const mine = view.players[me.seat];
  return {
    hand: view.handNo,
    street: STREET[view.street],
    blinds: `${view.smallBlind}/${view.bigBlind}`,
    board: cards(view.board),
    pot: view.pot,
    you: {
      seat: me.seat,
      name: me.name,
      position: pos[me.seat],
      holeCards: cards(mine.hole),
      stack: mine.stack,
      betThisStreet: mine.bet,
      investedThisHand: mine.total,
      startStack: startStacks[me.seat],
    },
    toAct: legal ? { toCall: legal.toCall, minRaiseTo: legal.canRaise ? legal.minTo : null, maxRaiseTo: legal.canRaise ? legal.maxTo : null } : undefined,
    players: view.players
      .filter((p) => p.inHand)
      .map((p) => ({
        seat: p.seat,
        name: nameAt(p.name, p.seat),
        model: p.model ?? '真人玩家',
        position: pos[p.seat],
        stack: p.stack,
        startStack: startStacks[p.seat],
        betThisStreet: p.bet,
        investedThisHand: p.total,
        status: p.folded ? '已弃牌' : p.allIn ? '已全下' : '在局',
        ...(p.seat === me.seat ? { isYou: true } : {}),
      })),
    actions: actionsByStreet(view.log),
  };
}

// A finished hand (a hands.jsonl record), from `seat`'s point of view.
export function historyRound(rec, seat) {
  const shown = new Set((rec.result?.reveals ?? []).map((r) => r.seat));
  const seats = Object.keys(rec.start ?? {}).map(Number);
  const nameBySeat = rec.names ?? {};
  const players = seats.map((s) => {
    const start = rec.start?.[s];
    const end = rec.end?.[s];
    const hole = rec.holesBySeat?.[s];
    return {
      seat: s,
      name: nameAt(nameBySeat[s], s),
      model: rec.models?.[s] ?? '真人玩家',
      startStack: start,
      endStack: end,
      net: start != null && end != null ? end - start : undefined,
      ...(hole && (s === seat || shown.has(s)) ? { holeCards: cards(hole) } : {}),
      ...(s === seat ? { isYou: true } : {}),
    };
  });
  return {
    hand: rec.hand,
    blinds: rec.blinds,
    board: cards(rec.board),
    you: players.find((p) => p.isYou) ?? { seat, note: '你没有参与这一手' },
    players,
    actions: actionsByStreet(rec.log),
    result: (rec.result?.pots ?? []).map((pot) => ({
      winners: pot.winners.map((w) => nameAt(nameBySeat[w] ?? rec.log?.find((e) => e.seat === w)?.name, w)),
      amount: pot.amount,
      hand: pot.hand ?? '其他人弃牌',
    })),
    showdown: (rec.result?.reveals ?? []).map((r) => ({ name: nameAt(nameBySeat[r.seat], r.seat), holeCards: cards(r.hole), hand: r.hand })),
  };
}
