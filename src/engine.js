import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { compareScores, evaluate, newDeck, shuffle } from './cards.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river'];
export const STREET_NAMES = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

// No-limit hold'em table. `decide(player, legal, view)` returns {action, amount?, say?}; actions are
// fold | check | call | raise (amount = total bet this street, "raise to") | allin.
export class Table extends EventEmitter {
  constructor({ seats, smallBlind, bigBlind, decide, makeDeck = () => shuffle(newDeck()), button }) {
    super();
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.decide = decide;
    this.makeDeck = makeDeck;
    this.players = seats.map((s, i) => ({
      ...s,
      seat: i,
      hole: [],
      bet: 0,
      total: 0,
      folded: true,
      allIn: false,
      acted: false,
      inHand: false,
    }));
    this.button = button ?? crypto.randomInt(this.players.length);
    this.handNo = 0;
    this.hand = null;
  }

  next(from, pred) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const p = this.players[(from + k + n) % n];
      if (pred(p)) return p.seat;
    }
    return -1;
  }

  findFrom(from, pred) {
    const n = this.players.length;
    for (let k = 0; k < n; k++) {
      const p = this.players[(from + k) % n];
      if (pred(p)) return p;
    }
    return null;
  }

  live() {
    return this.players.filter((p) => p.stack > 0 && !p.sittingOut);
  }
  contenders() {
    return this.players.filter((p) => p.inHand && !p.folded);
  }
  actors() {
    return this.contenders().filter((p) => !p.allIn);
  }
  pot() {
    return this.players.reduce((s, p) => s + p.total, 0);
  }

  put(p, amount) {
    const amt = Math.max(0, Math.min(amount, p.stack));
    p.stack -= amt;
    p.bet += amt;
    p.total += amt;
    if (p.stack === 0) p.allIn = true;
    return amt;
  }

  async playHand() {
    const live = this.live();
    if (live.length < 2) throw new Error('not enough players');
    const h = {
      no: ++this.handNo,
      board: [],
      street: 'preflop',
      currentBet: 0,
      minRaise: this.bigBlind,
      log: [],
      deck: this.makeDeck(),
      toAct: -1,
      result: null,
    };
    this.hand = h;
    for (const p of this.players) {
      const playing = p.stack > 0 && !p.sittingOut;
      Object.assign(p, { hole: [], bet: 0, total: 0, folded: !playing, allIn: false, acted: false, inHand: playing, lastAction: null, lastChat: null, shown: false });
    }
    const inHand = (p) => p.inHand;
    this.button = this.next(this.button, inHand);
    if (live.length === 2) {
      h.sbSeat = this.button;
      h.bbSeat = this.next(h.sbSeat, inHand);
    } else {
      h.sbSeat = this.next(this.button, inHand);
      h.bbSeat = this.next(h.sbSeat, inHand);
    }
    h.button = this.button;
    this.emit('handStart', { hand: h });

    const sb = this.players[h.sbSeat];
    const bb = this.players[h.bbSeat];
    this.record(sb, 'sb', this.put(sb, this.smallBlind));
    this.record(bb, 'bb', this.put(bb, this.bigBlind));
    h.currentBet = this.bigBlind;
    h.minRaise = this.bigBlind;

    for (let round = 0; round < 2; round++) {
      let seat = h.button;
      for (let i = 0; i < live.length; i++) {
        seat = this.next(seat, inHand);
        this.players[seat].hole.push(h.deck.pop());
      }
    }
    this.emit('dealt', { hand: h });

    await this.bettingRound(this.next(h.bbSeat, inHand));
    for (const street of ['flop', 'turn', 'river']) {
      if (this.contenders().length <= 1) break;
      for (const p of this.players) {
        p.bet = 0;
        p.acted = false;
      }
      h.currentBet = 0;
      h.minRaise = this.bigBlind;
      h.street = street;
      h.deck.pop();
      h.board.push(...h.deck.splice(-(street === 'flop' ? 3 : 1)));
      this.emit('street', { hand: h, street });
      if (this.actors().length >= 2) await this.bettingRound(this.next(h.button, inHand));
    }
    h.toAct = -1;
    h.result = this.settle();
    this.emit('handEnd', { hand: h, result: h.result });
    return h.result;
  }

  needsAction(p) {
    const h = this.hand;
    return p.inHand && !p.folded && !p.allIn && (!p.acted || p.bet < h.currentBet);
  }

  legalActions(p) {
    const h = this.hand;
    const toCall = Math.min(Math.max(0, h.currentBet - p.bet), p.stack);
    const maxTo = p.bet + p.stack;
    const opponentsCanAct = this.actors().some((q) => q !== p);
    const canRaise = !p.acted && opponentsCanAct && maxTo > h.currentBet;
    return {
      toCall,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canRaise,
      minTo: Math.min(h.currentBet + h.minRaise, maxTo),
      maxTo,
      currentBet: h.currentBet,
      isBet: h.currentBet === 0,
      pot: this.pot(),
      stack: p.stack,
      bet: p.bet,
    };
  }

  async bettingRound(start) {
    const h = this.hand;
    let from = start;
    while (true) {
      if (this.contenders().length <= 1) return;
      const p = this.findFrom(from, (q) => this.needsAction(q));
      if (!p) return;
      const legal = this.legalActions(p);
      if (!legal.canCall && !legal.canRaise && legal.canCheck && !this.actors().some((q) => q !== p)) {
        p.acted = true;
        from = p.seat + 1;
        continue;
      }
      h.toAct = p.seat;
      this.emit('turn', { hand: h, player: p, legal });
      let decision;
      try {
        decision = await this.decide(p, legal, this.viewFor(p));
      } catch (e) {
        decision = { action: legal.canCheck ? 'check' : 'fold', note: `error: ${e?.message ?? e}` };
      }
      this.apply(p, decision ?? {}, legal);
      from = p.seat + 1;
    }
  }

  normalize(decision, legal) {
    let action = String(decision.action ?? '').toLowerCase().replace(/[\s_-]/g, '');
    let amount = Math.round(Number(decision.amount));
    if (action === 'bet') action = 'raise';
    if (action === 'allin' || action === 'shove') {
      if (legal.canRaise) {
        action = 'raise';
        amount = legal.maxTo;
      } else action = legal.canCall ? 'call' : 'check';
    }
    if (action === 'raise' && !legal.canRaise) action = legal.canCall ? 'call' : 'check';
    if (action === 'call' && !legal.canCall) action = 'check';
    if (action === 'fold' && legal.canCheck) action = 'check';
    if (action === 'check' && !legal.canCheck) action = 'fold';
    if (!['fold', 'check', 'call', 'raise'].includes(action)) action = legal.canCheck ? 'check' : 'fold';
    if (action === 'raise') {
      if (!Number.isFinite(amount)) amount = legal.minTo;
      amount = Math.max(legal.minTo, Math.min(legal.maxTo, amount));
      if (amount <= legal.currentBet) action = legal.canCall ? 'call' : 'check';
    }
    return { action, amount };
  }

  apply(p, decision, legal) {
    const h = this.hand;
    const { action, amount } = this.normalize(decision, legal);
    let shown = action;
    let value = 0;
    if (action === 'fold') p.folded = true;
    else if (action === 'call') value = this.put(p, legal.toCall);
    else if (action === 'raise') {
      const prev = h.currentBet;
      this.put(p, amount - p.bet);
      value = p.bet;
      const size = p.bet - prev;
      if (size >= h.minRaise) {
        h.minRaise = size;
        for (const q of this.actors()) if (q !== p) q.acted = false;
      }
      h.currentBet = Math.max(h.currentBet, p.bet);
      shown = prev === 0 ? 'bet' : 'raise';
    }
    p.acted = true;
    this.record(p, shown, value, decision);
    h.toAct = -1;
  }

  // Table talk outside of an action (the human's chat). Recorded in the hand log for everyone to read.
  chat(p, text) {
    const h = this.hand;
    if (!h) return null;
    const entry = { street: h.street, seat: p.seat, name: p.name, action: 'chat', amount: 0, say: String(text).slice(0, 80), pot: this.pot(), stack: p.stack, idx: h.log.length };
    p.lastChat = entry;
    h.log.push(entry);
    this.emit('action', { hand: h, entry, player: p });
    return entry;
  }

  record(p, action, amount, decision = {}) {
    const h = this.hand;
    const entry = {
      idx: h.log.length,
      street: h.street,
      seat: p.seat,
      name: p.name,
      action,
      amount,
      allIn: p.allIn && action !== 'fold' && action !== 'check',
      say: decision.say ? String(decision.say).slice(0, 80) : undefined,
      emote: decision.emote || undefined,
      pot: this.pot(),
      stack: p.stack,
      ms: decision.ms,
      fallback: decision.fallback || undefined,
    };
    p.lastAction = entry;
    h.log.push(entry);
    this.emit('action', { hand: h, entry, player: p });
  }

  settle() {
    const h = this.hand;
    const inHand = this.players.filter((p) => p.inHand);
    const byTotal = inHand.slice().sort((a, b) => b.total - a.total);
    let refund = null;
    if (byTotal.length > 1 && byTotal[0].total > byTotal[1].total) {
      const top = byTotal[0];
      const amount = top.total - byTotal[1].total;
      top.total -= amount;
      top.stack += amount;
      if (top.stack > 0) top.allIn = false;
      refund = { seat: top.seat, amount };
    }
    const contenders = this.contenders();
    const potTotal = this.pot();
    const pots = [];
    const reveals = [];
    if (contenders.length === 1) {
      const w = contenders[0];
      w.stack += potTotal;
      pots.push({ amount: potTotal, winners: [w.seat], eligible: [w.seat], hand: null });
    } else {
      for (const p of contenders) {
        p.eval = evaluate(p.hole.concat(h.board));
        p.shown = true;
        reveals.push({ seat: p.seat, hole: p.hole, hand: p.eval.name });
      }
      const levels = [...new Set(contenders.map((p) => p.total))].sort((a, b) => a - b);
      let prev = 0;
      for (const level of levels) {
        const amount = inHand.reduce((s, p) => s + Math.min(p.total, level) - Math.min(p.total, prev), 0);
        const eligible = contenders.filter((p) => p.total >= level).map((p) => p.seat);
        const last = pots.at(-1);
        if (last && last.eligible.length === eligible.length) last.amount += amount;
        else if (amount > 0) pots.push({ amount, eligible });
        prev = level;
      }
      const assigned = pots.reduce((s, x) => s + x.amount, 0);
      if (assigned < potTotal) pots.at(-1).amount += potTotal - assigned;
      for (const pot of pots) {
        const elig = pot.eligible.map((s) => this.players[s]);
        let best = [];
        for (const p of elig) {
          const cmp = best.length ? compareScores(p.eval.score, best[0].eval.score) : 1;
          if (cmp > 0) best = [p];
          else if (cmp === 0) best.push(p);
        }
        const order = best.slice().sort((a, b) => this.seatOrderFromButton(a.seat) - this.seatOrderFromButton(b.seat));
        const share = Math.floor(pot.amount / order.length);
        let odd = pot.amount - share * order.length;
        for (const w of order) {
          w.stack += share + (odd > 0 ? 1 : 0);
          odd--;
        }
        pot.winners = order.map((w) => w.seat);
        pot.hand = order[0].eval.name;
      }
    }
    const won = {};
    for (const pot of pots) {
      const share = Math.floor(pot.amount / pot.winners.length);
      pot.winners.forEach((s, i) => {
        won[s] = (won[s] ?? 0) + share + (i < pot.amount - share * pot.winners.length ? 1 : 0);
      });
    }
    const net = {};
    for (const p of inHand) net[p.seat] = (won[p.seat] ?? 0) - p.total;
    return { pots, reveals, refund, won, net, board: h.board.slice(), showdown: contenders.length > 1 };
  }

  seatOrderFromButton(seat) {
    const n = this.players.length;
    return (seat - this.button - 1 + n) % n;
  }

  viewFor(viewer) {
    const h = this.hand;
    return {
      handNo: h.no,
      street: h.street,
      board: h.board.slice(),
      pot: this.pot(),
      currentBet: h.currentBet,
      button: h.button,
      sbSeat: h.sbSeat,
      bbSeat: h.bbSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      log: h.log.slice(),
      players: this.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        model: p.model,
        title: p.title,
        stack: p.stack,
        bet: p.bet,
        total: p.total,
        inHand: p.inHand,
        folded: p.folded,
        allIn: p.allIn,
        hole: p === viewer || p.shown ? p.hole.slice() : null,
      })),
    };
  }
}
