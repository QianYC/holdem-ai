import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { cardLabel, shuffle } from './cards.js';
import { aiDecide, askModel, describeAction, positionLabels, quickReplies, shownName } from './ai.js';
import { Table } from './engine.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const IMG_EXT = ['.png', '.webp', '.jpg', '.jpeg', '.gif'];

// Tournament-style blind levels: [small, big] pairs; past the end of the list the last level keeps doubling.
export function defaultBlindLevels(sb) {
  return [1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100].map((m) => {
    const s = Math.max(1, Math.round(sb * m));
    return [s, s * 2];
  });
}

export function blindSchedule(config, handIndex) {
  const per = Number(config.handsPerLevel ?? 0);
  const base = [config.smallBlind, config.bigBlind];
  if (!per) return { sb: base[0], bb: base[1], level: 1, nextIn: null, next: null };
  const levels = Array.isArray(config.blindLevels) && config.blindLevels.length ? config.blindLevels : defaultBlindLevels(base[0]);
  const at = (i) => {
    if (i < levels.length) return levels[i];
    const [s, b] = levels.at(-1);
    const k = 2 ** (i - levels.length + 1);
    return [s * k, b * k];
  };
  const lv = Math.floor(handIndex / per);
  const [sb, bb] = at(lv);
  return { sb, bb, level: lv + 1, nextIn: per - (handIndex % per), next: at(lv + 1) };
}

// Art of one character `{key, portrait?, winPortrait?, losePortrait?}` as web paths (undefined when missing).
export function scanArt(publicDir, a, stickerMeta = {}) {
  const dir = path.join(publicDir, 'characters', a.key);
  const web = (f) => `/characters/${encodeURIComponent(a.key)}/${f.split('/').map(encodeURIComponent).join('/')}?v=${Math.floor(fs.statSync(path.join(dir, f)).mtimeMs)}`;
  const find = (base) => {
    const f = IMG_EXT.map((e) => base + e).find((x) => fs.existsSync(path.join(dir, x)));
    return f ? web(f) : undefined;
  };
  const exists = (url) => url && fs.existsSync(path.join(publicDir, ...decodeURIComponent(url.split('?')[0]).replace(/^\//, '').split('/')));
  let stickers = [];
  try {
    stickers = fs
      .readdirSync(path.join(dir, 'stickers'))
      .filter((f) => IMG_EXT.includes(path.extname(f).toLowerCase()))
      .map((f) => {
        const id = path.basename(f, path.extname(f));
        return { id, label: stickerMeta[id]?.label ?? id, emoji: stickerMeta[id]?.emoji, url: web(`stickers/${f}`) };
      });
  } catch {}
  return {
    portrait: exists(a.portrait) ? a.portrait : find('portrait'),
    win: exists(a.winPortrait) ? a.winPortrait : find('win'),
    lose: exists(a.losePortrait) ? a.losePortrait : find('lose'),
    stickers,
  };
}
export const MAX_SEATS = 10;
const ART_KEYS = ['key', 'title', 'persona', 'avatar', 'color', 'portrait', 'winPortrait', 'losePortrait', 'portraitPos', 'faceFocus', 'portraitCredit', 'portraitUrl'];

// One table session: the human (seat 0) plus AI seats. Clients (web, Slack) observe `change` /
// table events and drive the human through act(), nextHand(), rebuy(), newGame().
export class Game extends EventEmitter {
  constructor(config, { log = console.log, dataDir, configPath, publicDir } = {}) {
    super();
    this.config = config;
    this.publicDir = publicDir;
    this.configPath = configPath;
    this.log = log;
    this.dataDir = dataDir;
    this.guests = this.loadGuests();
    this.newGame();
    this.restore();
    this.ready = true;
    if (this.spectating || this.config.autoNextHandMs) setTimeout(() => this.scheduleAutoNext(), 1000);
  }

  // ---------------------------------------------------------------- LAN players
  // Seat 0 is always the host (the person at the server's keyboard). Other people on the LAN join with a
  // token kept in their browser; they get a seat when a new game is set up.
  guestsPath() {
    return this.dataDir ? path.join(this.dataDir, 'lan.json') : null;
  }

  loadGuests() {
    try {
      return JSON.parse(fs.readFileSync(this.guestsPath(), 'utf8')).guests ?? [];
    } catch {
      return [];
    }
  }

  saveGuests() {
    const file = this.guestsPath();
    if (!file) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ guests: this.guests }, null, 2));
    } catch (e) {
      this.log(`[game] cannot save LAN players: ${e}`);
    }
  }

  seatOfToken(token) {
    const g = token && this.guests.find((x) => x.token === token);
    return g ? this.table.players.findIndex((p) => p.id === g.id) : -1;
  }

  join(token, name) {
    if (!/^[a-z0-9]{16,64}$/i.test(String(token ?? ''))) return { ok: false, error: '无效的玩家标识' };
    const nick = String(name ?? '').trim().slice(0, 12);
    if (!nick) return { ok: false, error: '起个名字吧' };
    const taken = [this.config.humanName ?? '你', ...this.config.ai.map((a) => a.name), ...this.guests.filter((g) => g.token !== token).map((g) => g.name)];
    if (taken.includes(nick)) return { ok: false, error: '这个名字已经有人用了' };
    let g = this.guests.find((x) => x.token === token);
    if (g) g.name = nick;
    else {
      if (1 + this.guests.length + this.config.ai.length >= MAX_SEATS) return { ok: false, error: `桌子坐满了（最多 ${MAX_SEATS} 人）` };
      g = { id: `g-${token.slice(0, 8)}`, token, name: nick, joinedAt: Date.now() };
      this.guests.push(g);
    }
    this.saveGuests();
    const seat = this.seatOfToken(token);
    if (seat >= 0) this.table.players[seat].name = nick;
    // Nobody has played yet: rebuild the table right away so the newcomer sits down.
    else if (this.status === 'ready' && this.table.handNo === 0 && !this.running) this.newGame();
    this.log(`[lan] ${nick} joined`);
    this.emit('lanChange');
    this.changed();
    const now = this.seatOfToken(token);
    return { ok: true, seat: now, queued: now < 0 };
  }

  leave(token) {
    const g = this.guests.find((x) => x.token === token);
    if (!g) return { ok: false, error: '不在桌上' };
    this.guests = this.guests.filter((x) => x !== g);
    this.saveGuests();
    const seat = this.table.players.findIndex((p) => p.id === g.id);
    if (seat >= 0) {
      const p = this.table.players[seat];
      p.sittingOut = true;
      if (this.pending?.seat === seat) this.pending.resolve({ action: 'fold', source: 'left' });
      if (this.status === 'ready' && this.table.handNo === 0 && !this.running) this.newGame();
    }
    this.log(`[lan] ${g.name} left`);
    this.emit('lanChange');
    this.changed();
    return { ok: true };
  }

  snapshotPath() {
    return this.dataDir ? path.join(this.dataDir, 'table.json') : null;
  }

  save() {
    const file = this.snapshotPath();
    if (!file || !this.ready) return;
    const t = this.table;
    const snap = {
      gameId: this.gameId,
      handNo: t.handNo,
      button: t.button,
      recent: this.recent,
      status: this.status === 'gameOver' ? 'gameOver' : undefined,
      spectating: this.spectating || undefined,
      spectatePaused: this.spectatePaused || undefined,
      defeat: this.defeat ?? undefined,
      gameOver: this.gameOver ?? undefined,
      knockout: this.status === 'handOver' ? (this.knockout ?? undefined) : undefined,
      players: t.players.map((p) => ({
        id: p.id,
        model: p.model,
        stack: p.stack,
        buyIns: p.buyIns,
        handsWon: p.handsWon,
        handsPlayed: p.handsPlayed,
        place: p.place,
        eliminatedHand: p.eliminatedHand,
        eliminatedBy: p.eliminatedBy,
        peakStack: p.peakStack,
      })),
    };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      this.log(`[game] cannot save table: ${e}`);
    }
  }

  // Restores stacks and stats saved after the last finished hand (a hand cut off by a restart is void).
  restore() {
    const file = this.snapshotPath();
    if (!file || !fs.existsSync(file)) return;
    try {
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      const byId = new Map(this.table.players.map((p) => [p.id, p]));
      if (snap.players?.length !== byId.size || snap.players.some((p) => !byId.has(p.id)) || snap.players[0].id !== 'human') return;
      if (snap.players.some((p, i) => p.id !== this.table.players[i].id)) this.newGame({ order: snap.players.slice(1).map((p) => p.id) });
      const t = this.table;
      snap.players.forEach((p, i) =>
        Object.assign(t.players[i], {
          stack: p.stack,
          buyIns: p.buyIns,
          handsWon: p.handsWon,
          handsPlayed: p.handsPlayed,
          place: p.place,
          eliminatedHand: p.eliminatedHand,
          eliminatedBy: p.eliminatedBy,
          peakStack: p.peakStack ?? p.stack,
        }),
      );
      t.handNo = snap.handNo ?? 0;
      if (t.handNo > 0) {
        this.blinds = blindSchedule(this.config, t.handNo - 1);
        t.smallBlind = this.blinds.sb;
        t.bigBlind = this.blinds.bb;
      }
      t.button = snap.button ?? t.button;
      this.gameId = snap.gameId ?? this.gameId;
      this.recent = snap.recent ?? [];
      if (t.handNo > 0) this.status = snap.status === 'gameOver' ? 'gameOver' : 'handOver';
      this.gameOver = snap.gameOver ?? null;
      this.spectating = Boolean(snap.spectating);
      this.spectatePaused = Boolean(snap.spectatePaused);
      this.defeat = snap.defeat ?? null;
      this.knockout = snap.knockout ?? null;
      const go = this.gameOver;
      if (go && go.taunt == null) {
        this.fetchTaunt(go.type, t.players[go.rival]).then(({ say, penalty }) => {
          if (this.gameOver !== go) return;
          go.taunt = say;
          go.penalty = penalty;
          this.save();
          this.emit('gameOver', go);
          this.changed();
        });
      }
      const k = this.knockout;
      if (k && !k.line && t.players[k.seat]) {
        this.fetchKnockoutLine(t.players[k.seat], k).then(({ line, reward }) => {
          k.line = line;
          k.reward = reward;
          this.save();
          this.emit('knockout', k);
          this.changed();
        });
      }
      this.log(`[game] restored table after hand ${t.handNo}`);
    } catch (e) {
      this.log(`[game] cannot restore table: ${e}`);
    }
  }

  newGame({ order } = {}) {
    const c = this.config;
    if (this.pending) this.pending.resolve({ action: 'fold', source: 'reset' });
    this.gameId = Date.now().toString(36);
    const ais = c.ai.map((a, i) => ({ id: `ai${i + 1}`, kind: 'ai', ...a, stack: c.startingStack }));
    const guests = (this.guests ?? []).map((g) => ({ id: g.id, name: g.name, kind: 'human', guest: true, stack: c.startingStack }));
    const others = [...guests, ...ais];
    // Every new game seats everyone else in a random order around the host (each viewer is drawn at the bottom).
    let seated = order ? order.map((id) => others.find((a) => a.id === id)).filter(Boolean) : c.randomSeats === false ? others : shuffle(others.slice());
    if (seated.length !== others.length) seated = others;
    const seats = [{ id: 'human', name: c.humanName ?? '你', kind: 'human', stack: c.startingStack }, ...seated];
    const table = new Table({
      seats,
      smallBlind: c.smallBlind,
      bigBlind: c.bigBlind,
      decide: (p, legal, view) => {
        if (this.table !== table) throw new Error('game reset');
        return this.decide(p, legal, view);
      },
    });
    this.table = table;
    for (const p of this.table.players) {
      p.out = null;
      p.buyIns = 1;
      p.handsWon = 0;
      p.handsPlayed = 0;
      p.peakStack = p.stack;
    }
    this.resolveArt();
    for (const ev of ['handStart', 'dealt', 'street', 'action', 'turn', 'handEnd']) {
      table.on(ev, (data) => {
        if (this.table !== table) return;
        this.emit(ev, data);
        this.changed();
      });
    }
    this.status = 'ready';
    this.pending = null;
    this.thinking = null;
    this.recent = [];
    this.lastResult = null;
    this.gameOver = null;
    this.eliminations = [];
    this.knockout = null;
    this.blinds = null;
    this.spectating = false;
    this.spectatePaused = false;
    this.defeat = null;
    this.running = null;
    this.emit('newGame');
    this.save();
    this.changed();
  }

  changed() {
    this.emit('change');
  }

  get human() {
    return this.table.players[0];
  }

  async decide(p, legal, view) {
    if (p.kind === 'human') {
      return new Promise((resolve) => {
        this.pending = { resolve, legal, seat: p.seat, handNo: view.handNo, turnId: `${view.handNo}-${view.log.length}` };
        // LAN players who walk away should not stall the table: check / fold for them after a while.
        const limit = p.guest ? Number(this.config.lan?.turnTimeoutMs ?? 90000) : 0;
        if (limit > 0) {
          const pending = this.pending;
          pending.deadline = Date.now() + limit;
          setTimeout(() => {
            if (this.pending === pending) this.act(legal.canCheck ? 'check' : 'fold', 0, 'timeout', pending.turnId, p.seat);
          }, limit);
        }
        this.emit('humanTurn', { player: p, legal, view, turnId: this.pending.turnId });
        this.makeQuickReplies(p, legal, view, this.pending.turnId);
        this.changed();
      });
    }
    this.thinking = { seat: p.seat, since: Date.now() };
    this.changed();
    const minDelay = sleep(this.config.minActionDelayMs ?? 600);
    const d = await aiDecide(this.config.llm, p, legal, view, this.recent.slice(-5), this.log);
    await minDelay;
    this.thinking = null;
    return d;
  }

  makeQuickReplies(p, legal, view, turnId) {
    if (this.config.quickReplies === false) return;
    this.quick = { turnId, items: null };
    const model = this.config.quickReplyModel ?? 'gpt-6-luna';
    quickReplies(this.config.llm, model, p, legal, view)
      .then((items) => {
        if (this.quick?.turnId !== turnId) return;
        this.quick.items = items;
        this.emit('quickReplies', { turnId, items });
        this.changed();
      })
      .catch((e) => this.log(`[game] quick replies failed: ${e?.message ?? e}`));
  }

  // The human's table talk (any time during a hand).
  say(text, source = 'web', seat = 0) {
    const t = String(text ?? '').trim();
    if (!t) return { ok: false, error: '说点什么呀' };
    const h = this.table.hand;
    if (!h || this.status !== 'playing') return { ok: false, error: '牌局进行中才能发言' };
    const p = this.table.players[seat];
    if (!p || p.kind !== 'human') return { ok: false, error: '入座之后才能发言' };
    const mine = h.log.filter((e) => e.action === 'chat' && e.seat === seat && e.street === h.street).length;
    if (mine >= 5) return { ok: false, error: '这一轮说得够多啦，等下一轮' };
    this.table.chat(p, t);
    this.lastHumanSource = source;
    return { ok: true };
  }

  act(action, amount, source = 'web', turnId, seat = 0) {
    if (!this.pending || this.pending.seat !== seat) return { ok: false, error: '现在不是你的回合' };
    if (turnId && turnId !== this.pending.turnId) return { ok: false, error: '这个按钮已经过期了' };
    const { resolve, legal } = this.pending;
    let a = String(action).toLowerCase();
    if (a === 'checkcall') a = legal.canCheck ? 'check' : 'call';
    if (a === 'raise' && !(Number(amount) > 0)) return { ok: false, error: '加注需要金额' };
    if (a === 'raise' && legal.canRaise && Number(amount) > legal.maxTo) amount = legal.maxTo;
    if (a === 'check' && !legal.canCheck) return { ok: false, error: `现在需要跟注 ${legal.toCall}，不能过牌` };
    if (a === 'raise' && !legal.canRaise) return { ok: false, error: '现在不能加注' };
    this.pending = null;
    this.lastHumanSource = source;
    resolve({ action: a, amount: Number(amount), source });
    return { ok: true };
  }

  nextHand(source = 'web') {
    if (this.running) return { ok: false, error: '这一手还没结束' };
    if (this.status === 'gameOver') return { ok: false, error: '这一局已经结束了，开新局再来' };
    this.reloadTuning();
    const humansIn = this.table.players.some((p) => p.kind === 'human' && p.stack > 0 && !p.sittingOut);
    if (!humansIn && !this.spectating) return { ok: false, error: this.eliminationMode() ? '你已经出局了，开新局再来' : '你的筹码输光了，先补码（rebuy）' };
    const c = this.config;
    for (const p of this.table.players) {
      if (p.kind === 'ai' && p.stack <= 0 && !this.eliminationMode() && c.aiAutoRebuy !== false) {
        p.stack = c.startingStack;
        p.buyIns++;
        this.emit('rebuy', { player: p });
      }
    }
    if (this.table.live().length < 2) return { ok: false, error: '没有对手了' };
    clearTimeout(this.autoTimer);
    this.autoNextAt = null;
    this.blinds = blindSchedule(this.config, this.table.handNo);
    this.table.smallBlind = this.blinds.sb;
    this.table.bigBlind = this.blinds.bb;
    this.status = 'playing';
    this.lastResult = null;
    this.eliminations = [];
    this.knockout = null;
    this.nextSource = source;
    const table = this.table;
    const run = table
      .playHand()
      .then((result) => {
        if (this.table === table) this.afterHand(result);
      })
      .catch((e) => {
        this.log(`[game] hand crashed: ${e?.stack ?? e}`);
        if (this.table === table) this.status = 'ready';
      })
      .finally(() => {
        if (this.running !== run) return;
        this.running = null;
        this.changed();
        this.scheduleAutoNext();
      });
    this.running = run;
    this.changed();
    return { ok: true };
  }

  // LLM settings (timeouts, token caps, reasoning) apply from the next hand without a restart.
  reloadTuning() {
    if (!this.configPath) return;
    try {
      const fresh = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      this.config.llm = fresh.llm ?? this.config.llm;
      for (const key of ['minActionDelayMs', 'autoNextHandMs', 'aiAutoRebuy', 'eliminateBusted', 'defeatStyle', 'randomSeats', 'handsPerLevel', 'blindLevels', 'quickReplies', 'quickReplyModel', 'revealAllCards', 'spectateDelayMs', 'imageModel']) if (key in fresh) this.config[key] = fresh[key];
      (fresh.ai ?? []).forEach((a, i) => {
        const p = this.table.players.find((x) => x.id === `ai${i + 1}`);
        if (!p) return;
        // A different model in this slot: between hands the newcomer takes over the seat and its chips.
        const swap = p.model !== a.model;
        if (swap && this.running) return;
        if (swap) {
          this.log(`[game] seat ${p.seat}: ${p.name} (${p.model}) replaced by ${a.name} (${a.model})`);
          this.emit('seatSwap', { seat: p.seat, from: { name: p.name, model: p.model }, to: { name: a.name, model: a.model } });
          p.model = a.model;
        }
        // Everything except the seat identity can change between hands.
        for (const key of new Set([...Object.keys(a), ...ART_KEYS, 'reasoning', 'timeoutMs', 'maxOutputTokens'])) {
          if (key === 'model' || key === 'id') continue;
          if (key in a) p[key] = a[key];
          else delete p[key];
        }
      });
      if (fresh.stickers) this.config.stickers = fresh.stickers;
      this.resolveArt();
    } catch (e) {
      this.log(`[game] cannot reload config: ${e}`);
    }
  }

  // Character art lives in public/characters/<key>/: portrait.*, win.*, lose.* and stickers/*.
  // Explicit paths in the config (portrait / winPortrait / losePortrait) take precedence.
  resolveArt() {
    for (const p of this.table.players) {
      p.media = {};
      p.stickers = [];
      if (p.kind !== 'ai' || !this.publicDir || !p.key) continue;
      const art = scanArt(this.publicDir, p, this.config.stickers);
      p.media = { portrait: art.portrait, win: art.win, lose: art.lose };
      p.stickers = art.stickers;
    }
  }

  scheduleAutoNext() {
    clearTimeout(this.autoTimer);
    this.autoNextAt = null;
    let ms = this.spectating ? (this.spectatePaused ? 0 : (this.config.spectateDelayMs ?? 3000)) : (this.config.autoNextHandMs ?? 0);
    if (!ms || this.status !== 'handOver' || (!this.spectating && !this.table.players.some((p) => p.kind === 'human' && p.stack > 0 && !p.sittingOut))) return;
    // Leave time to read a defeat screen before the next hand starts.
    if (this.knockout) ms = Math.max(ms, this.config.knockoutDelayMs ?? 12000);
    const no = this.table.handNo;
    this.autoNextAt = Date.now() + ms;
    this.autoTimer = setTimeout(() => {
      this.autoNextAt = null;
      if (!this.running && this.table.handNo === no && this.status === 'handOver') this.nextHand('auto');
    }, ms);
  }

  // Turns automatic dealing of the next hand on (ms > 0) or off.
  setAutoNext(ms) {
    this.config.autoNextHandMs = Math.max(0, Math.round(Number(ms) || 0));
    // Persist it, or the next hand's config reload would switch it back.
    if (this.configPath) {
      try {
        const file = path.basename(this.configPath) === 'config.example.json' ? path.join(path.dirname(this.configPath), 'config.json') : this.configPath;
        const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : structuredClone(this.config);
        saved.autoNextHandMs = this.config.autoNextHandMs;
        fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
        this.configPath = file;
      } catch (e) {
        this.log(`[game] cannot save autoNextHandMs: ${e}`);
      }
    }
    if (this.config.autoNextHandMs) this.scheduleAutoNext();
    else {
      clearTimeout(this.autoTimer);
      this.autoNextAt = null;
    }
    this.changed();
    return { ok: true, autoNextHandMs: this.config.autoNextHandMs };
  }

  eliminationMode() {
    return this.config.eliminateBusted !== false;
  }

  rebuy() {
    if (this.eliminationMode()) return { ok: false, error: '淘汰赛：输光就出局，不能补码。开新局再来吧' };
    if (this.running) return { ok: false, error: '这一手结束后才能补码' };
    if (this.human.stack > 0) return { ok: false, error: '还有筹码，不需要补码' };
    this.human.stack = this.config.startingStack;
    this.human.buyIns++;
    this.save();
    this.changed();
    return { ok: true };
  }

  afterHand(result) {
    const t = this.table;
    const h = t.hand;
    for (const p of t.players) if (p.inHand) p.handsPlayed++;
    const winners = new Set(result.pots.flatMap((x) => x.winners));
    for (const s of winners) t.players[s].handsWon++;
    this.lastResult = result;
    this.status = 'handOver';
    for (const p of t.players) p.peakStack = Math.max(p.peakStack ?? 0, p.stack);
    this.recent.push(this.summarize(result));
    if (this.recent.length > 20) this.recent.shift();
    if (this.eliminationMode()) this.eliminate(result);
    this.save();
    if (this.dataDir) {
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.appendFileSync(
          path.join(this.dataDir, 'hands.jsonl'),
          `${JSON.stringify({
            game: this.gameId,
            hand: h.no,
            at: new Date().toISOString(),
            button: h.button,
            board: h.board,
            holes: Object.fromEntries(t.players.filter((p) => p.inHand).map((p) => [p.name, p.hole])),
            log: h.log,
            result,
          })}\n`,
        );
      } catch (e) {
        this.log(`[game] cannot write history: ${e}`);
      }
    }
  }

  // Busted players leave the table for good; the human busting (or being the last one standing) ends the game.
  eliminate(result) {
    const t = this.table;
    const h = t.hand;
    const busted = t.players.filter((p) => p.inHand && p.stack === 0 && !p.place).sort((a, b) => b.total - a.total);
    if (!busted.length) return;
    const remaining = t.players.filter((p) => p.stack > 0).length;
    busted.forEach((p, i) => {
      const pot = result.pots.find((x) => x.eligible?.includes(p.seat)) ?? result.pots[0];
      p.place = remaining + 1 + i;
      p.eliminatedHand = h.no;
      p.eliminatedBy = pot?.winners?.[0];
      this.eliminations.push({ seat: p.seat, name: p.name, place: p.place, by: p.eliminatedBy });
      this.emit('eliminated', { player: p, by: t.players[p.eliminatedBy] });
      this.log(`[game] ${p.name} eliminated in hand ${h.no}, place ${p.place}, by ${t.players[p.eliminatedBy]?.name}`);
    });
    const isHuman = (p) => p?.kind === 'human';
    const bustedHumans = busted.filter(isHuman);
    const humansAlive = t.players.filter((p) => isHuman(p) && p.stack > 0 && !p.sittingOut);
    // One defeat screen per hand: prefer an AI a human knocked out.
    const shown = busted.filter((p) => p.kind === 'ai').sort((a, b) => (isHuman(t.players[b.eliminatedBy]) ? 1 : 0) - (isHuman(t.players[a.eliminatedBy]) ? 1 : 0))[0];
    if (shown && !bustedHumans.length && remaining > 1) this.knockOut(shown);
    if (bustedHumans.length && !humansAlive.length && !this.spectating) {
      // The last human is out: the game is over for the people at the table (they may watch the AIs finish).
      this.finish('defeat', bustedHumans.sort((a, b) => a.place - b.place)[0]);
    } else if (remaining === 1) {
      const winner = t.players.find((p) => p.stack > 0);
      winner.place = 1;
      this.spectating = false;
      this.finish(isHuman(winner) ? 'victory' : 'champion', winner);
    } else for (const p of bustedHumans) this.personalDefeat(p);
  }

  // A human busts while other humans play on: a defeat screen just for them.
  personalDefeat(p) {
    const h = this.table.hand;
    const reveal = (seat) => this.lastResult?.reveals?.find((r) => r.seat === seat);
    const rival = this.table.players[p.eliminatedBy];
    const out = {
      type: 'defeat',
      style: this.config.defeatStyle === 'classic' ? 'classic' : 'flirty',
      subject: p.seat,
      place: p.place,
      players: this.table.players.length,
      handNo: h.no,
      rival: rival?.seat,
      board: h.board.slice(),
      myHole: p.hole.slice(),
      myHand: reveal(p.seat)?.hand ?? null,
      rivalHole: reveal(rival?.seat)?.hole ?? null,
      rivalHand: reveal(rival?.seat)?.hand ?? null,
      peakStack: p.peakStack,
      handsPlayed: p.handsPlayed,
      handsWon: p.handsWon,
      taunt: null,
    };
    p.out = out;
    this.fetchTaunt('defeat', rival, out, p).then(({ say, penalty }) => {
      out.taunt = say;
      out.penalty = penalty;
      this.emit('personalDefeat', { player: p, out });
      this.changed();
    });
  }

  // After you bust: the remaining AIs keep playing until one is left (hands deal themselves).
  spectate() {
    if (this.status !== 'gameOver' || this.gameOver?.type !== 'defeat') return { ok: false, error: '只有你出局之后才能观战' };
    if (this.table.live().length < 2) return { ok: false, error: '桌上只剩一个人了' };
    this.spectating = true;
    this.spectatePaused = false;
    this.defeat = this.gameOver;
    this.gameOver = null;
    this.status = 'handOver';
    this.save();
    this.emit('spectate');
    this.changed();
    return this.nextHand('spectate');
  }

  setSpectatePaused(paused) {
    if (!this.spectating) return { ok: false, error: '现在没有在观战' };
    this.spectatePaused = Boolean(paused);
    this.changed();
    if (!paused && !this.running && this.status === 'handOver') this.nextHand('spectate');
    return { ok: true };
  }

  // Every AI that busts gets its own defeat screen (the game goes on). `by` is the seat that took her last chips.
  knockOut(p) {
    const h = this.table.hand;
    const reveal = (seat) => this.lastResult?.reveals?.find((r) => r.seat === seat);
    const by = p.eliminatedBy ?? 0;
    const k = {
      seat: p.seat,
      by,
      byHuman: this.table.players[by]?.kind === 'human',
      handNo: h.no,
      place: p.place,
      players: this.table.players.length,
      style: this.config.defeatStyle === 'classic' ? 'classic' : 'flirty',
      myHole: reveal(by)?.hole ?? (by === 0 ? this.human.hole.slice() : null),
      myHand: reveal(by)?.hand ?? null,
      theirHole: reveal(p.seat)?.hole ?? null,
      theirHand: reveal(p.seat)?.hand ?? null,
      board: h.board.slice(),
      line: null,
      reward: null,
    };
    this.knockout = k;
    this.fetchKnockoutLine(p, k).then(({ line, reward }) => {
      k.line = line;
      k.reward = reward;
      this.save();
      this.emit('knockout', k);
      this.changed();
    });
  }

  async fetchKnockoutLine(p, k) {
    const flirty = k.style === 'flirty';
    const winner = this.table.players[k.by];
    const fallback = k.byHuman
      ? flirty
        ? { line: '呜……居然输给你了。这次、这次只是手滑而已！', reward: '奖励你：下次见面我先打招呼。' }
        : { line: '这把算你狠，下一局我会回来的。' }
      : { line: `${winner?.name ?? '你'}……给我记住，下一局一定讨回来！` };
    if (!p.model) return fallback;
    const cards = (cs) => (cs?.length ? cs.map(cardLabel).join(' ') : '未亮牌');
    const role = p.persona ? `你的角色形象（${p.title ?? p.name}）：${p.persona}\n` : '';
    const who = k.byHuman ? `人类玩家「${winner?.name ?? '你'}」` : `${winner?.name}${winner?.title ? `（${winner.title}）` : ''}`;
    const situation = `德州扑克淘汰赛第 ${k.handNo} 手，你（${p.name}）被${who}打到筹码归零，淘汰出局，最终第 ${k.place} 名。你的牌 ${cards(k.theirHole)}${k.theirHand ? `（${k.theirHand}）` : ''}，对方的牌 ${cards(k.myHole)}${k.myHand ? `（${k.myHand}）` : ''}，公共牌 ${cards(k.board)}。`;
    const ask = !k.byHuman
      ? `这是你的战败画面，人类玩家在一旁看着。用你的人设说一句不甘心又带点羞恼的出局台词（中文，40 字以内），可以冲着淘汰你的${winner?.name ?? '对手'}放句狠话，也可以对观战的人类撒个娇。可以调情，但不要露骨，不涉及性行为或裸露。`
      : flirty
        ? '这是你的战败画面。用你的人设说一句不甘心、害羞又带点暧昧的认输台词（中文，40 字以内），再给赢了你的人类一个俏皮的小奖励（中文，30 字以内）。可以调情，但不要露骨，不涉及性行为或裸露。'
        : '说一句不服气但有风度的告别台词，中文，40 字以内。';
    const withReward = flirty && k.byHuman;
    try {
      const d = await this.askTwice(
        { ...this.config.llm, timeoutMs: 25000 },
        p,
        `${role}${situation}${ask}\n只输出 JSON：${withReward ? '{"say": "...", "reward": "..."}' : '{"say": "..."}'}`,
        this.table.players.length,
      );
      const clean = (x, n) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null);
      return { line: clean(d.say, 80) ?? fallback.line, reward: withReward ? (clean(d.reward, 60) ?? fallback.reward) : undefined };
    } catch (e) {
      this.log(`[game] knockout line failed: ${e?.message ?? e}`);
      return fallback;
    }
  }

  // type: defeat (subject = last human out), victory (subject = winning human), champion (subject = winning AI).
  finish(type, subject) {
    const t = this.table;
    const h = t.hand;
    const me = type === 'champion' ? this.human : (subject ?? this.human);
    const reveal = (seat) => this.lastResult?.reveals?.find((r) => r.seat === seat);
    const rival =
      type === 'champion'
        ? subject
        : type === 'defeat'
          ? t.players[me.eliminatedBy]
          : t.players.filter((p) => p !== me).sort((a, b) => (a.place ?? 99) - (b.place ?? 99))[0];
    this.status = 'gameOver';
    this.gameOver = {
      type,
      subject: subject?.seat ?? me.seat,
      place: me.place,
      players: t.players.length,
      handNo: h.no,
      rival: rival?.seat,
      board: h.board.slice(),
      myHole: me.hole.slice(),
      myHand: reveal(me.seat)?.hand ?? null,
      rivalHole: reveal(rival?.seat)?.hole ?? null,
      rivalHand: reveal(rival?.seat)?.hand ?? null,
      peakStack: me.peakStack,
      handsPlayed: me.handsPlayed,
      handsWon: me.handsWon,
      taunt: null,
    };
    const no = h.no;
    this.gameOver.style = this.config.defeatStyle === 'classic' ? 'classic' : 'flirty';
    this.fetchTaunt(type, rival, this.gameOver, me).then(({ say, penalty }) => {
      if (!this.gameOver || this.gameOver.handNo !== no) return;
      this.gameOver.taunt = say;
      this.gameOver.penalty = penalty;
      this.save();
      this.emit('gameOver', this.gameOver);
      this.changed();
    });
  }

  async fetchTaunt(type, rival, g = this.gameOver, subject = this.human) {
    const human = `人类玩家「${subject?.name ?? '你'}」`;
    const flirty = g.style === 'flirty';
    const fallback =
      type === 'champion'
        ? flirty
          ? { say: '最后站着的是我哦～这张桌子，连同你的心，一起收下了。', penalty: '早早出局的你，下一局开场要先给冠军鼓掌三十秒。' }
          : { say: '冠军是我。下一局，你可要撑久一点。' }
        : type === 'defeat'
        ? flirty
          ? { say: '输光了呀～筹码我就收下了，人嘛……下次再说。', penalty: '下一局开始前，要乖乖叫我一声「赢家大人」。' }
          : { say: '筹码我先替你保管了，下次带够了再来。' }
        : flirty
          ? { say: '哼……这次就让你赢好了，别得意太久哦。', penalty: '作为奖励，下一局我第一手不加注你。' }
          : { say: '……这把算你狠。下一局我不会再手软。' };
    if (!rival?.model) return fallback;
    const cards = (cs) => (cs?.length ? cs.map(cardLabel).join(' ') : '未亮牌');
    const mine = `${cards(g.rivalHole)}${g.rivalHand ? `（${g.rivalHand}）` : ''}`;
    const theirs = `${cards(g.myHole)}${g.myHand ? `（${g.myHand}）` : ''}`;
    const role = rival.persona ? `你的角色形象（${rival.title ?? rival.name}）：${rival.persona}\n` : '';
    const situation =
      type === 'champion'
        ? `德州扑克淘汰赛打到第 ${g.handNo} 手，你（${rival.name}）把其他 AI 全部淘汰，赢下整张桌子成为冠军。人类玩家早就出局了，一直在旁边观战。`
        : type === 'defeat'
          ? `德州扑克淘汰赛第 ${g.handNo} 手，你（${rival.name}）把${human}打到筹码归零，对方被淘汰出局，最终第 ${g.place} 名。你的牌 ${mine}，对方的牌 ${theirs}，公共牌 ${cards(g.board)}。`
          : `德州扑克淘汰赛打到最后，你（${rival.name}）是最后一个被${human}淘汰的对手，对方赢下了整张桌子。`;
    const ask =
      type === 'champion'
        ? flirty
          ? '这是冠军结算画面。用你的人设说一句得意又撩人的夺冠宣言（中文，40 字以内，可以调侃一下早早出局还在观战的人类），再给那个人类定一个俏皮的小惩罚（中文，30 字以内）。可以调情，但不要露骨，不涉及性行为或裸露。'
          : '用你的人设说一句夺冠宣言，中文，40 字以内。'
        : flirty
      ? type === 'defeat'
        ? '这是战败结算画面。用你的人设对刚输光的人类说一句暧昧、撩人又得意的赢家台词（中文，40 字以内），再给对方定一个俏皮的小惩罚（中文，30 字以内，比如叫你昵称、下一局让你先说一句情话之类）。可以调情，但不要露骨，不涉及性行为或裸露。'
        : '这是人类的胜利结算画面。用你的人设说一句不服气又带点暧昧的认输台词（中文，40 字以内），再给对方一个俏皮的小奖励（中文，30 字以内）。可以调情，但不要露骨，不涉及性行为或裸露。'
      : type === 'defeat'
        ? '对着刚被你淘汰的人类说一句得意、毒舌又俏皮的赢家台词，中文，40 字以内。'
        : '说一句不服气但有风度的告别台词，中文，40 字以内。';
    try {
      const d = await this.askTwice(
        { ...this.config.llm, timeoutMs: 25000 },
        rival,
        `${role}${situation}${ask}\n只输出 JSON：${flirty ? '{"say": "...", "penalty": "..."}' : '{"say": "..."}'}`,
        this.table.players.length,
      );
      const clean = (x, n) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null);
      return { say: clean(d.say, 80) ?? fallback.say, penalty: flirty ? (clean(d.penalty, 60) ?? fallback.penalty) : undefined };
    } catch (e) {
      this.log(`[game] taunt failed: ${e?.message ?? e}`);
      return fallback;
    }
  }

  async askTwice(cfg, player, prompt, tableSize) {
    try {
      return await askModel(cfg, player, prompt, tableSize);
    } catch (e) {
      this.log(`[game] ${player.name} line attempt 1 failed: ${e?.message ?? e}`);
      return askModel(cfg, player, prompt, tableSize);
    }
  }

  summarize(result) {
    const t = this.table;
    const h = t.hand;
    const parts = result.pots.map((pot) => {
      const names = pot.winners.map((s) => t.players[s].name).join('、');
      return `${names} 赢得 ${pot.amount}${pot.hand ? `（${pot.hand}）` : '（其他人弃牌）'}`;
    });
    const shown = result.reveals.map((r) => `${t.players[r.seat].name} 亮出 ${r.hole.map(cardLabel).join(' ')}`).join('；');
    const board = h.board.length ? `公共牌 ${h.board.map(cardLabel).join(' ')}，` : '';
    return `第 ${h.no} 手：${board}${parts.join('；')}${shown ? `。摊牌：${shown}` : ''}`;
  }

  // Public state for the human's clients: AI hole cards stay hidden until shown down.
  // viewer: the seat this client plays (-1 = watching). Private cards and turn controls follow it.
  state(viewer = 0) {
    const t = this.table;
    const humanInHand = t.players.some((p) => p.kind === 'human' && p.inHand);
    const h = t.hand;
    // Spectators (after you bust) see every hole card, like a TV broadcast.
    const showAll = this.config.revealAllCards === true || (this.spectating && !humanInHand);
    const labels = h ? positionLabels(t.viewFor(null)) : {};
    return {
      gameId: this.gameId,
      status: this.status,
      handNo: t.handNo,
      smallBlind: t.smallBlind,
      serverNow: Date.now(),
      blindLevel: this.blinds?.level ?? 1,
      autoNextHandMs: this.config.autoNextHandMs ?? 0,
      autoNextAt: this.autoNextAt ?? null,
      blindsNextIn: this.blinds?.nextIn ?? null,
      blindsNext: this.blinds?.next ?? null,
      bigBlind: t.bigBlind,
      startingStack: this.config.startingStack,
      button: h?.button ?? -1,
      street: h?.street ?? null,
      board: h?.board ?? [],
      pot: t.pot(),
      currentBet: h?.currentBet ?? 0,
      toAct: h?.toAct ?? -1,
      thinking: this.thinking,
      players: t.players.map((p) => ({
        seat: p.seat,
        name: p.seat === 0 && viewer !== 0 ? shownName(p.name, true) : p.name,
        kind: p.kind,
        model: p.model,
        avatar: p.avatar,
        color: p.color,
        title: p.title,
        portrait: p.media?.portrait,
        winPortrait: p.media?.win,
        losePortrait: p.media?.lose,
        portraitPos: p.portraitPos,
        faceFocus: p.faceFocus,
        portraitCredit: p.portraitCredit,
        portraitUrl: p.portraitUrl,
        stickers: p.stickers?.length ? p.stickers : undefined,
        stack: p.stack,
        bet: p.bet,
        total: p.total,
        inHand: p.inHand,
        folded: p.folded,
        allIn: p.allIn,
        position: labels[p.seat] ?? '',
        hole: p.seat === viewer || p.shown || showAll ? p.hole : p.inHand && !p.folded ? p.hole.map(() => null) : [],
        guest: p.guest || undefined,
        sittingOut: p.sittingOut || undefined,
        lastAction: p.lastAction && h && p.lastAction.street === h.street ? { ...p.lastAction, text: describeAction(p.lastAction) } : null,
        lastSay: p.lastAction?.say ?? null,
        lastChat: p.lastChat && h && p.lastChat.street === h.street ? p.lastChat : null,
        buyIns: p.buyIns,
        net: p.stack - p.buyIns * this.config.startingStack,
        handsWon: p.handsWon,
        handsPlayed: p.handsPlayed,
        peakStack: p.peakStack,
        place: p.place ?? null,
        eliminatedBy: p.eliminatedBy ?? null,
        eliminatedHand: p.eliminatedHand ?? null,
      })),
      eliminations: this.eliminations,
      gameOver: this.gameOver,
      knockout: this.status === 'handOver' ? this.knockout : null,
      eliminationMode: this.eliminationMode(),
      spectating: this.spectating,
      spectatePaused: this.spectatePaused,
      defeat: this.defeat,
      log: (h?.log ?? []).map((e) => ({ ...e, text: describeAction(e) })),
      result: this.lastResult,
      recent: this.recent.slice(-8),
      you: viewer,
      waitingFor: this.pending?.seat ?? -1,
      myOut: t.players[viewer]?.out ?? null,
      legal: this.pending && this.pending.seat === viewer ? { ...this.pending.legal, turnId: this.pending.turnId, deadline: this.pending.deadline } : null,
      quickReplies: this.pending && this.pending.seat === viewer && this.quick?.turnId === this.pending.turnId ? (this.quick.items ?? 'loading') : null,
      slack: this.slackInfo ?? null,
    };
  }
}
