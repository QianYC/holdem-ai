import fs from 'node:fs';
import path from 'node:path';
import { cardLabel } from './cards.js';
import { describeAction, STICKER_EMOJI, STICKER_NAMES } from './ai.js';
import { STREET_NAMES } from './engine.js';

const fmt = (n) => Number(n).toLocaleString('en-US');
const stickerTag = (p, id) => {
  const s = p?.stickers?.find((x) => x.id === id);
  return `${s?.emoji ?? STICKER_EMOJI[id] ?? '🖼️'}[${s?.label ?? STICKER_NAMES[id] ?? id}]`;
};
const cards = (cs) => (cs?.length ? cs.map((c) => (c ? `\`${cardLabel(c)}\`` : '`🂠`')).join(' ') : '—');

export function parseCommandText(text) {
  const t = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[，。！!.,\s]+$/g, '');
  let m;
  if (/^(弃|弃牌|丢|fold|f)$/.test(t)) return { kind: 'act', action: 'fold' };
  if (/^(过|过牌|看牌|让牌|check|k|x)$/.test(t)) return { kind: 'act', action: 'check' };
  if (/^(跟|跟注|call|c)$/.test(t)) return { kind: 'act', action: 'call' };
  if (/^(梭哈|全下|all\s*-?\s*in|shove|ai)$/.test(t)) return { kind: 'act', action: 'allin' };
  if ((m = t.match(/^(?:加注|加到|加|下注|raise|bet|r|b)\s*(?:到|to)?\s*(\d+)$/))) return { kind: 'act', action: 'raise', amount: Number(m[1]) };
  if ((m = t.match(/^(\d+)$/))) return { kind: 'act', action: 'raise', amount: Number(m[1]) };
  if (/^(下一手|下一局|继续|发牌|next|n|deal)$/.test(t)) return { kind: 'next' };
  if (/^(观战|继续观战|看戏|spectate|watch)$/.test(t)) return { kind: 'spectate' };
  if (/^(暂停|pause)$/.test(t)) return { kind: 'pause' };
  if (/^(自动|自动下一手|自动发牌|auto)$/.test(t)) return { kind: 'auto', on: true };
  if (/^(手动|关闭自动|取消自动|manual)$/.test(t)) return { kind: 'auto', on: false };
  if (/^(补码|买入|rebuy)$/.test(t)) return { kind: 'rebuy' };
  if (/^(状态|筹码|筹码榜|排行|排行榜|榜|status|board)$/.test(t)) return { kind: 'board' };
  if (/^(新局|新游戏|重开|重新开始|new|restart)$/.test(t)) return { kind: 'newGame' };
  if (/^(停|停止|结束|退出|stop|quit)$/.test(t)) return { kind: 'stop' };
  if ((m = String(text ?? '').trim().match(/^(?:说|聊|say)\s*[:：]?\s*([\s\S]+)$/i))) return { kind: 'say', text: m[1].trim() };
  return { kind: 'help' };
}

const HELP =
  '淘汰赛：筹码归零就出局，没有补码。在本线程里可以直接回复：`过` / `跟` / `弃` / `加注 300`（加到本轮总额 300）/ `梭哈` / `说 你想说的话` / `下一手` / `筹码榜` / `新局` / `停`。也可以点按钮。';

// Mirrors the table into one Slack thread and accepts the human's actions from it.
// Talks to Slack only through a local Slack bridge (see README: POST /api, POST /hook), which also forwards owner
// messages in our threads, our top-level trigger, and our button clicks to POST /slack/hook.
export class SlackMirror {
  constructor(game, cfg, { port, log = console.log, serverScript }) {
    this.game = game;
    this.cfg = cfg;
    this.port = port;
    this.log = log;
    this.serverScript = serverScript;
    this.thread = null;
    this.handMsg = null;
    this.turnMsg = null;
    this.nextMsg = null;
    this.chain = Promise.resolve();
    this.timer = null;
    this.registered = false;
    this.statePath = cfg.stateFile;
    try {
      this.thread = JSON.parse(fs.readFileSync(this.statePath, 'utf8')).thread ?? null;
    } catch {}
    this.bind();
  }

  token() {
    return fs.readFileSync(this.cfg.bridgeTokenFile, 'utf8').trim();
  }

  checkToken(given) {
    try {
      return Boolean(given) && given === this.token();
    } catch {
      return false;
    }
  }

  async bridge(route, body) {
    const res = await fetch(`${this.cfg.bridgeUrl.replace(/\/$/, '')}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': this.token() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!json.ok) throw new Error(`${route} ${body.method ?? ''}: ${json.error ?? res.status}`);
    return json;
  }

  api(method, params) {
    return this.bridge('/api', { method, params });
  }

  async register(extra = {}) {
    await this.bridge('/hook', {
      name: 'poker',
      url: `http://127.0.0.1:${this.port}/slack/hook`,
      trigger: this.cfg.trigger ?? '^(德扑|德州扑克|poker)(\\s|$)',
      start: this.serverScript ? { cmd: process.execPath, args: [this.serverScript], cwd: path.dirname(path.dirname(this.serverScript)) } : undefined,
      ...extra,
    });
    this.registered = true;
  }

  async registerWithRetry() {
    try {
      await this.register();
      this.log('[slack] hook registered with the Slack bridge');
    } catch (e) {
      this.log(`[slack] bridge not reachable (${e.message}); retrying in 60 s`);
      setTimeout(() => this.registerWithRetry(), 60000).unref();
    }
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({ thread: this.thread }, null, 2));
    } catch {}
    this.game.slackInfo = this.thread ? { channel: this.thread.channel, ts: this.thread.ts, link: this.thread.link } : null;
    this.game.changed();
  }

  enqueue(fn) {
    this.chain = this.chain.then(fn).catch((e) => this.log(`[slack] ${e?.message ?? e}`));
    return this.chain;
  }

  post(text, blocks) {
    return this.api('chat.postMessage', {
      channel: this.thread.channel,
      thread_ts: this.thread.ts,
      text,
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  update(ts, text, blocks) {
    return this.api('chat.update', { channel: this.thread.channel, ts, text, blocks: blocks ?? [] });
  }

  bind() {
    const g = this.game;
    g.on('handStart', () => {
      if (!this.thread) return;
      const no = g.table.handNo;
      this.closeNext(`▶ 第 ${no} 手开始`);
      const msg = { no, ts: null };
      this.handMsg = msg;
      this.enqueue(async () => {
        msg.ts = (await this.post(this.handText())).ts;
      });
    });
    for (const ev of ['dealt', 'street', 'action']) g.on(ev, () => this.thread && this.scheduleHandUpdate());
    g.on('action', ({ entry }) => {
      if (!this.thread || entry.seat !== 0 || entry.action === 'chat' || !this.turnMsg) return;
      const via = g.lastHumanSource === 'slack' ? '' : '（在网页上）';
      this.closeTurn(`✅ 你${via}：${describeAction(entry)}`);
    });
    g.on('humanTurn', ({ legal, turnId, player }) => {
      if (!this.thread || player.seat !== 0) return;
      this.flushHandUpdate();
      const { text, blocks } = this.turnMessage(legal, turnId);
      const msg = { ts: null, turnId, legal };
      this.turnMsg = msg;
      this.enqueue(async () => {
        msg.ts = (await this.post(text, blocks)).ts;
      });
    });
    g.on('quickReplies', ({ turnId, items }) => {
      const msg = this.turnMsg;
      if (!this.thread || !msg || msg.turnId !== turnId) return;
      const { text, blocks } = this.turnMessage(msg.legal, turnId, items);
      this.enqueue(() => msg.ts && this.turnMsg === msg && this.update(msg.ts, text, blocks));
    });
    g.on('handEnd', () => {
      if (!this.thread) return;
      this.flushHandUpdate();
    });
    g.on('spectate', () => {
      if (!this.thread) return;
      const alive = g.table.players.filter((p) => p.stack > 0).map((p) => p.name);
      this.reply(`👀 *观战模式*：剩下的 ${alive.length} 个 AI（${alive.join('、')}）血战到底，每手自动开始。观战视角能看到所有人的底牌，每手的每一轮行动都会实时更新在这里。回复 \`暂停\` / \`继续\`，也可以 \`说 …\` 在场边喊话。`);
    });
    g.on('change', () => {
      if (this.thread && g.status === 'handOver' && !g.running && !g.spectating && !this.nextMsg && this.handMsg?.no === g.table.handNo) {
        this.flushHandUpdate();
        this.postNext();
      }
    });
    g.on('knockout', (k) => {
      if (!this.thread) return;
      this.flushHandUpdate();
      const { text, blocks } = this.knockoutMessage(k);
      const p = g.table.players[k.seat];
      this.enqueue(() => this.post(text, blocks));
      if (p?.media?.lose) this.enqueue(() => this.uploadImage(p.media.lose, `${p.name} 战败`));
    });
    g.on('gameOver', (over) => {
      if (!this.thread) return;
      this.flushHandUpdate();
      const { text, blocks } = this.gameOverMessage(over);
      this.enqueue(() => this.post(text, blocks));
      const rival = g.table.players[over.rival];
      const pose = over.type === 'victory' ? rival?.media?.lose : rival?.media?.win;
      if (pose) this.enqueue(() => this.uploadImage(pose, `${rival.name} ${over.type === 'victory' ? '战败' : '胜利'}`));
    });
    g.on('newGame', () => {
      this.closeTurn('⏹ 牌局已重开');
      this.closeNext('⏹ 新的一局开始了');
      this.handMsg = null;
      if (this.thread) this.postNext(`🔄 新的一局：所有人筹码重置为 ${fmt(g.config.startingStack)}，座位重新随机。\n${this.seating()}`);
    });
  }

  postNext(prefix) {
    const { text, blocks } = this.nextMessage();
    if (prefix) blocks[0].text.text = `${prefix}\n${text}`;
    const msg = { ts: null };
    this.nextMsg = msg;
    this.enqueue(async () => {
      msg.ts = (await this.post(prefix ? `${prefix}\n${text}` : text, blocks)).ts;
    });
  }

  closeTurn(text) {
    const msg = this.turnMsg;
    this.turnMsg = null;
    if (msg) this.enqueue(() => msg.ts && this.update(msg.ts, text));
  }

  closeNext(text) {
    const msg = this.nextMsg;
    this.nextMsg = null;
    if (msg) this.enqueue(() => msg.ts && this.update(msg.ts, text));
  }

  scheduleHandUpdate() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueue(() => this.pushHandUpdate());
    }, this.cfg.updateDebounceMs ?? 1500);
  }

  flushHandUpdate() {
    clearTimeout(this.timer);
    this.timer = null;
    this.enqueue(() => this.pushHandUpdate());
  }

  async pushHandUpdate() {
    if (!this.handMsg?.ts || this.handMsg.no !== this.game.table.handNo) return;
    await this.update(this.handMsg.ts, this.handText());
  }

  handText() {
    const g = this.game;
    const s = g.state();
    const me = s.players[0];
    const btn = s.players[s.button];
    const watching = s.spectating && !me.inHand;
    const lines = [
      `*${watching ? '👀 观战 · ' : '🃏 '}第 ${s.handNo} 手*  ·  盲注 ${s.smallBlind}/${s.bigBlind}${s.blindsNext ? `（第 ${s.blindLevel} 级${s.blindsNextIn === 1 ? '，下手升盲' : ''}）` : ''}  ·  庄家 ${btn?.name ?? '-'}`,
      ...(watching
        ? s.players
            .filter((p) => p.inHand)
            .map((p) => `${p.folded ? '~' : ''}${p.name}${p.position ? `（${p.position}）` : ''} ${cards(p.hole)}  筹码 ${fmt(p.stack)}${p.folded ? '~' : ''}`)
        : [`你的手牌：${cards(me.hole)}${me.position ? `  （${me.position}）` : ''}   筹码 ${fmt(me.stack)}`]),
      `公共牌：${cards(s.board)}   底池 *${fmt(s.pot)}*`,
    ];
    let street = '';
    for (const e of s.log) {
      if (e.street !== street) {
        street = e.street;
        lines.push(`*— ${STREET_NAMES[street]} —*`);
      }
      const p = s.players[e.seat];
      const who = p.seat === 0 ? '*你*' : `*${p.name}*`;
      const flag = e.fallback ? ' ⚙️' : '';
      if (e.action === 'chat') {
        lines.push(`• ${who} 💬 _「${e.say}」_`);
        continue;
      }
      lines.push(`• ${who} ${e.text}${e.say ? `  _「${e.say}」_` : ''}${e.emote ? `  ${stickerTag(p, e.emote)}` : ''}${flag}`);
    }
    if (s.status === 'playing' && s.thinking) lines.push(`_${s.players[s.thinking.seat].name} 思考中…_`);
    if (s.result && (s.status === 'handOver' || s.status === 'gameOver')) {
      lines.push('*— 结果 —*');
      for (const pot of s.result.pots) {
        const names = pot.winners.map((w) => (w === 0 ? '*你*' : `*${s.players[w].name}*`)).join('、');
        lines.push(`🏆 ${names} 赢得 ${fmt(pot.amount)}${pot.hand ? `（${pot.hand}）` : ''}`);
      }
      for (const r of s.result.reveals) lines.push(`   ${r.seat === 0 ? '你' : s.players[r.seat].name}：${cards(r.hole)}  ${r.hand}`);
      const net = s.result.net[0];
      if (net !== undefined) lines.push(`你这手 ${net >= 0 ? '+' : ''}${fmt(net)}，现有筹码 ${fmt(me.stack)}`);
      for (const e of s.eliminations ?? []) {
        const killer = s.players[e.by];
        lines.push(`💀 *${e.seat === 0 ? '你' : e.name}* 筹码归零，出局（第 ${e.place} 名）${killer ? `，淘汰者：${killer.seat === 0 ? '你' : killer.name}` : ''}`);
      }
      const alive = s.players.filter((p) => p.stack > 0).length;
      if (s.eliminationMode && s.status !== 'gameOver') lines.push(`_场上还剩 ${alive} 人_`);
    }
    return lines.join('\n');
  }

  raisePresets(legal) {
    const s = this.game.state();
    const step = s.smallBlind || 1;
    const round = (x) => Math.round(x / step) * step;
    const potAfterCall = legal.pot + legal.toCall;
    const raw = legal.isBet
      ? [legal.minTo, round(potAfterCall / 2), round(potAfterCall)]
      : [legal.minTo, round(legal.currentBet + potAfterCall / 2), round(legal.currentBet + potAfterCall)];
    const out = [];
    for (const v of raw) {
      const x = Math.max(legal.minTo, Math.min(legal.maxTo, v));
      if (x < legal.maxTo && !out.includes(x)) out.push(x);
    }
    return out;
  }

  turnMessage(legal, turnId, quickItems = 'loading') {
    const s = this.game.state();
    const me = s.players[0];
    const mention = this.cfg.mention ? `<@${this.cfg.mention}> ` : '';
    const text = `${mention}*轮到你了*（第 ${s.handNo} 手 · ${STREET_NAMES[s.street]}）\n你的手牌 ${cards(me.hole)}  ·  公共牌 ${cards(s.board)}\n底池 *${fmt(legal.pot)}*  ·  ${legal.canCall ? `需跟注 *${fmt(legal.toCall)}*` : '可以过牌'}  ·  你的筹码 ${fmt(legal.stack)}`;
    const btn = (label, a, n, style) => ({
      type: 'button',
      text: { type: 'plain_text', text: label, emoji: true },
      action_id: `hook:poker:act:${a}:${n ?? 0}`,
      value: JSON.stringify({ t: turnId, a, n }),
      ...(style ? { style } : {}),
    });
    const elements = [];
    if (legal.canCall) elements.push(btn('弃牌', 'fold'));
    elements.push(legal.canCheck ? btn('过牌', 'check', 0, 'primary') : btn(`跟注 ${fmt(legal.toCall)}${legal.toCall >= legal.stack ? '（全下）' : ''}`, 'call', 0, 'primary'));
    if (legal.canRaise) {
      for (const v of this.raisePresets(legal)) elements.push(btn(`${legal.isBet ? '下注' : '加注到'} ${fmt(v)}`, 'raise', v));
      elements.push(btn(`全下 ${fmt(legal.maxTo)}`, 'allin', legal.maxTo, 'danger'));
    }
    const hint = [
      legal.canRaise ? `自定义金额：回复 \`加注 ${fmt(legal.minTo)}\`（${fmt(legal.minTo)} ~ ${fmt(legal.maxTo)}，指本轮总下注额）` : '',
      '发言：回复 `说 你想说的话`',
    ]
      .filter(Boolean)
      .join('　·　');
    const quick = Array.isArray(quickItems) && quickItems.length
      ? [
          { type: 'context', elements: [{ type: 'mrkdwn', text: '*快速发言*（只发言，不行动）' }] },
          {
            type: 'actions',
            block_id: `quick-${turnId}`,
            elements: quickItems.slice(0, 5).map((x, i) => ({
              type: 'button',
              text: { type: 'plain_text', text: `${x.label} ${x.text}`.slice(0, 75), emoji: true },
              action_id: `hook:poker:say:${i}`,
              value: JSON.stringify({ t: turnId, i }),
            })),
          },
        ]
      : quickItems === 'loading'
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: '_正在帮你想几句台词…_' }] }]
        : [];
    return {
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        { type: 'actions', block_id: `turn-${turnId}`, elements },
        ...quick,
        { type: 'context', elements: [{ type: 'mrkdwn', text: hint }] },
      ],
    };
  }

  seating() {
    const s = this.game.state();
    const n = s.players.length;
    return s.players
      .map((p) => {
        const where = p.seat === 0 ? '' : p.seat === 1 ? '（你的左手边，在你之后行动）' : p.seat === n - 1 ? '（你的右手边）' : '';
        return `${p.seat === 0 ? '🙂' : (p.avatar ?? '🤖')} 座位${p.seat} ${p.seat === 0 ? '*你*' : p.kind === 'human' ? `*${p.name}*（真人）` : `*${p.name}*  \`${p.model}\``}${where}`;
      })
      .join('\n');
  }

  // Uploads a local image into the thread (files.getUploadURLExternal → POST bytes → completeUploadExternal).
  async uploadImage(webPath, title) {
    if (!webPath || !this.serverScript) return;
    const file = path.join(path.dirname(path.dirname(this.serverScript)), 'public', ...decodeURIComponent(webPath).replace(/^\//, '').split('/'));
    if (!fs.existsSync(file)) return;
    const bytes = fs.readFileSync(file);
    const { upload_url, file_id } = await this.api('files.getUploadURLExternal', { filename: path.basename(file), length: bytes.length });
    const res = await fetch(upload_url, { method: 'POST', body: bytes, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`upload ${res.status}`);
    await this.api('files.completeUploadExternal', { files: JSON.stringify([{ id: file_id, title }]), channel_id: this.thread.channel, thread_ts: this.thread.ts });
  }

  knockoutMessage(k) {
    const s = this.game.state();
    const p = s.players[k.seat];
    const who = `${p.name}${p.title ? `（${p.title}）` : ''}`;
    const winner = s.players[k.by ?? 0];
    const byHuman = k.byHuman !== false;
    const head = byHuman
      ? `💔 *${who} 被你送出了牌桌！*  第 ${k.handNo} 手出局，第 ${k.place} / ${k.players} 名`
      : `💔 *${who} 出局了* —— 被 *${winner?.name ?? '对手'}* 淘汰，第 ${k.handNo} 手，第 ${k.place} / ${k.players} 名`;
    const showdown = k.theirHole ? `\n${byHuman ? '你' : (winner?.name ?? '')} ${cards(k.myHole)}${k.myHand ? ` ${k.myHand}` : ''}  vs  ${p.name} ${cards(k.theirHole)}${k.theirHand ? ` ${k.theirHand}` : ''}\n公共牌 ${cards(k.board)}` : '';
    const quote = k.line ? `\n\n${p.avatar ?? '🤖'} *${p.name}*：_「${k.line}」_` : '';
    const reward = k.reward ? `\n🎁 *胜者奖励*：${k.reward}` : '';
    const text = `${head}${showdown}${quote}${reward}`;
    const section = { type: 'section', text: { type: 'mrkdwn', text } };
    if (p.portraitUrl) section.accessory = { type: 'image', image_url: p.portraitUrl, alt_text: p.name };
    return { text, blocks: [section, { type: 'context', elements: [{ type: 'mrkdwn', text: `场上还剩 ${s.players.filter((x) => x.stack > 0).length} 人${p.portraitCredit && p.portrait ? ` · ${p.portraitCredit}` : ''}` }] }] };
  }

  gameOverMessage(over) {
    const s = this.game.state();
    const rival = s.players[over.rival];
    const rivalName = rival ? `${rival.name}（${rival.model}）` : '对手';
    const standings = s.players
      .slice()
      .sort((a, b) => (a.place ?? 0) - (b.place ?? 0) || b.stack - a.stack)
      .map((p) => `${p.place ? `第 ${p.place} 名` : '存活'}  ${p.seat === 0 ? '*你*' : p.name}${p.place ? '' : `  ${fmt(p.stack)}`}`)
      .join('\n');
    const flirty = over.style === 'flirty';
    const head =
      over.type === 'defeat'
        ? flirty
          ? `💋 *你输光了哦～ 全部筹码都被 ${rivalName} 收下了*\n第 ${over.handNo} 手出局，最终 *第 ${over.place} / ${over.players} 名*`
          : `💀 *GAME OVER — 你被 ${rivalName} 淘汰了*\n第 ${over.handNo} 手筹码归零，最终 *第 ${over.place} / ${over.players} 名*`
        : over.type === 'champion'
          ? `🏆 *${rivalName} 夺冠！* 剩下的 AI 打到第 ${over.handNo} 手，她赢下了整张桌子\n你最终 *第 ${over.place} / ${over.players} 名*`
          : `👑 *VICTORY — 你赢下了整张桌子！*\n第 ${over.handNo} 手淘汰了最后一个 AI：${rivalName}`;
    const showdown =
      over.type === 'defeat' && over.rivalHole
        ? `\n最后一手：你 ${cards(over.myHole)}${over.myHand ? ` ${over.myHand}` : ''}  vs  ${rival?.name} ${cards(over.rivalHole)}${over.rivalHand ? ` ${over.rivalHand}` : ''}\n公共牌 ${cards(over.board)}`
        : '';
    const stats = `坚持 ${over.handsPlayed} 手 · 赢下 ${over.handsWon} 手 · 最高筹码 ${fmt(over.peakStack)}`;
    const text = `${head}${showdown}\n${stats}`;
    return {
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        ...(over.taunt
          ? [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: `${rival?.avatar ?? '🤖'} *${rival?.name ?? ''}*${rival?.title ? `（${rival.title}）` : ''}：_「${over.taunt}」_` },
                ...(rival?.portraitUrl ? { accessory: { type: 'image', image_url: rival.portraitUrl, alt_text: rival.name } } : {}),
              },
            ]
          : []),
        ...(over.penalty ? [{ type: 'section', text: { type: 'mrkdwn', text: `${over.type === 'champion' ? '🎀 *给观战者的惩罚*' : over.type === 'defeat' ? '🎀 *惩罚游戏*' : '🎁 *胜者奖励*'}：${over.penalty}` } }] : []),
        { type: 'section', text: { type: 'mrkdwn', text: `*最终排名*\n${standings}` } },
        {
          type: 'actions',
          block_id: `over-${over.handNo}`,
          elements: [
            ...(over.type === 'defeat' && s.players.filter((p) => p.stack > 0).length >= 2
              ? [{ type: 'button', text: { type: 'plain_text', text: '👀 继续观战（AI 血战到底）' }, action_id: 'hook:poker:spectate', value: 'spectate' }]
              : []),
            { type: 'button', text: { type: 'plain_text', text: '🔄 再来一局' }, action_id: 'hook:poker:newgame', value: 'newgame', style: 'primary' },
          ],
        },
      ],
    };
  }

  nextMessage() {
    const g = this.game;
    const me = g.human;
    const elements = [];
    if (me.stack > 0) elements.push({ type: 'button', text: { type: 'plain_text', text: '▶ 下一手' }, action_id: 'hook:poker:next', value: 'next', style: 'primary' });
    else if (!g.eliminationMode()) elements.push({ type: 'button', text: { type: 'plain_text', text: `补码 ${fmt(g.config.startingStack)}` }, action_id: 'hook:poker:rebuy', value: 'rebuy', style: 'primary' });
    elements.push({ type: 'button', text: { type: 'plain_text', text: '📊 筹码榜' }, action_id: 'hook:poker:board', value: 'board' });
    const auto = g.config.autoNextHandMs > 0 && me.stack > 0;
    const text = me.stack > 0 ? (auto ? `⏩ ${Math.round(g.config.autoNextHandMs / 1000)} 秒后自动发下一手（回复 \`手动\` 关闭）` : '准备好了就开始下一手。回复 `自动` 可开启自动下一手。') : '你的筹码输光了，可以补码继续。';
    return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', block_id: `next-${g.table.handNo}`, elements }] };
  }

  leaderboard() {
    const s = this.game.state();
    const rows = s.players
      .slice()
      .sort((a, b) => b.net - a.net)
      .map((p, i) => {
        const who = p.seat === 0 ? '*你*' : p.kind === 'human' ? `*${p.name}*（真人）` : `*${p.name}*（${p.model}）`;
        const rb = p.buyIns > 1 ? `，买入 ${p.buyIns} 次` : '';
        return `${i + 1}. ${who}  筹码 ${fmt(p.stack)}  净 ${p.net >= 0 ? '+' : ''}${fmt(p.net)}  胜 ${p.handsWon}/${p.handsPlayed}${rb}`;
      });
    return `*📊 筹码榜*（第 ${s.handNo} 手后）\n${rows.join('\n')}`;
  }

  // Start (or move) the mirror into a new thread in `channel`.
  async openThread(channel, { replyTo } = {}) {
    const g = this.game;
    const s = g.state();
    const lineup = this.seating();
    const text = `*♠♥ 德州扑克 · 你 vs ${s.players.length - 1} 个 AI ♦♣*\n盲注 ${s.smallBlind}/${s.bigBlind}，起始筹码 ${fmt(s.startingStack)}\n${lineup}\n本地网页：http://127.0.0.1:${this.port}  （网页和 Slack 同步，哪边操作都行）\n👇 牌局在这个线程里进行`;
    if (this.turnMsg) {
      const msg = this.turnMsg;
      this.turnMsg = null;
      await this.update(msg.ts, '↪ 牌局已移到新的线程').catch(() => {});
    }
    if (this.nextMsg?.ts) await this.update(this.nextMsg.ts, '↪ 牌局已移到新的线程').catch(() => {});
    this.nextMsg = null;
    const r = await this.api('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false, ...(replyTo ? {} : {}) });
    let link;
    try {
      link = (await this.api('chat.getPermalink', { channel, message_ts: r.ts })).permalink;
    } catch {}
    this.thread = { channel, ts: r.ts, link };
    this.handMsg = null;
    this.saveState();
    await this.register({ addThread: `${channel}:${r.ts}` });
    await this.post(HELP);
    if (g.status === 'playing') {
      const p = await this.post(this.handText());
      this.handMsg = { no: g.table.handNo, ts: p.ts };
      if (g.pending) {
        const quick = g.quick?.turnId === g.pending.turnId ? (g.quick.items ?? 'loading') : null;
        const { text: t2, blocks } = this.turnMessage(g.pending.legal, g.pending.turnId, quick);
        const m = await this.post(t2, blocks);
        this.turnMsg = { ts: m.ts, turnId: g.pending.turnId, legal: g.pending.legal };
      }
    } else if (g.status === 'handOver') {
      const p = await this.post(this.handText());
      this.handMsg = { no: g.table.handNo, ts: p.ts };
      const { text: t3, blocks } = this.nextMessage();
      this.nextMsg = { ts: (await this.post(t3, blocks)).ts };
    } else if (g.status === 'gameOver' && g.gameOver) {
      await this.post(this.handText());
      const { text: t4, blocks } = this.gameOverMessage(g.gameOver);
      await this.post(t4, blocks);
    }
    return this.thread;
  }

  stop() {
    this.thread = null;
    this.handMsg = null;
    this.turnMsg = null;
    this.nextMsg = null;
    this.saveState();
  }

  reply(text) {
    if (this.thread) this.enqueue(() => this.post(text));
  }

  // Payload forwarded by the Slack bridge: {type: 'command'|'message'|'action', ...}.
  async handleHook(p) {
    const g = this.game;
    if (p.type === 'command') {
      const arg = String(p.text ?? '')
        .replace(/^(德扑|德州扑克|poker)\s*/i, '')
        .trim();
      const cmd = arg ? parseCommandText(arg) : { kind: 'open' };
      if (cmd.kind === 'stop') {
        this.stop();
        await this.api('chat.postMessage', { channel: p.channel, thread_ts: p.ts, text: '好的，牌局不再同步到 Slack（网页端照常可玩）。发 `德扑` 可以重新接入。' });
        return;
      }
      if (cmd.kind === 'newGame') g.newGame();
      await this.enqueue(() => this.openThread(p.channel));
      if (g.status === 'ready' || (cmd.kind === 'next' && g.status === 'handOver')) g.nextHand('slack');
      return;
    }
    if (!this.thread || p.channel !== this.thread.channel || (p.thread_ts && p.thread_ts !== this.thread.ts)) {
      if (p.type === 'action' && p.channel && p.message_ts) {
        await this.api('chat.update', { channel: p.channel, ts: p.message_ts, text: '⏹ 这条消息已过期（牌局在别的线程）', blocks: [] }).catch(() => {});
      }
      return;
    }
    let cmd;
    if (p.type === 'action') {
      const id = String(p.action_id ?? '');
      if (id.startsWith('hook:poker:say:')) {
        let v = {};
        try {
          v = JSON.parse(p.value ?? '{}');
        } catch {}
        const item = g.quick?.turnId === v.t ? g.quick.items?.[v.i] : null;
        if (!item) return this.reply('⚠️ 这句台词已经过期了');
        cmd = { kind: 'say', text: item.text };
      } else if (id.startsWith('hook:poker:act:')) {
        let v = {};
        try {
          v = JSON.parse(p.value ?? '{}');
        } catch {}
        cmd = { kind: 'act', action: v.a, amount: v.n, turnId: v.t };
      } else if (id === 'hook:poker:next') cmd = { kind: 'next' };
      else if (id === 'hook:poker:spectate') {
        await this.api('chat.update', { channel: p.channel, ts: p.message_ts, text: '👀 已进入观战模式', blocks: [] }).catch(() => {});
        cmd = { kind: 'spectate' };
      }
      else if (id === 'hook:poker:rebuy') cmd = { kind: 'rebuy' };
      else if (id === 'hook:poker:newgame') {
        await this.api('chat.update', { channel: p.channel, ts: p.message_ts, text: '🔄 已开新局', blocks: [] }).catch(() => {});
        cmd = { kind: 'newGame', start: true };
      }
      else if (id === 'hook:poker:board') cmd = { kind: 'board' };
      else return;
    } else cmd = parseCommandText(p.text);
    await this.run(cmd);
  }

  async run(cmd) {
    const g = this.game;
    switch (cmd.kind) {
      case 'act': {
        let { action, amount } = cmd;
        if (action === 'allin') {
          const legal = g.pending?.legal;
          if (legal?.canRaise) {
            action = 'raise';
            amount = legal.maxTo;
          } else action = 'call';
        }
        const r = g.act(action, amount, 'slack', cmd.turnId);
        if (!r.ok) this.reply(`⚠️ ${r.error}`);
        return;
      }
      case 'spectate': {
        const r = g.spectate();
        if (!r.ok) this.reply(`⚠️ ${r.error}`);
        return;
      }
      case 'auto': {
        g.setAutoNext(cmd.on ? (g.config.autoNextHandMs || 5000) : 0);
        this.reply(cmd.on ? `⏩ 已开启自动下一手：每手结束 ${Math.round((g.config.autoNextHandMs || 5000) / 1000)} 秒后自动发牌。回复 \`手动\` 关闭。` : '⏸ 已关闭自动下一手，回复 `下一手` 继续。');
        if (cmd.on && g.status === 'handOver' && !g.running) g.scheduleAutoNext();
        return;
      }
      case 'pause': {
        const r = g.setSpectatePaused(true);
        this.reply(r.ok ? '⏸ 观战已暂停，回复 `继续` 接着看。' : `⚠️ ${r.error}`);
        return;
      }
      case 'next': {
        if (g.spectating) {
          const r = g.setSpectatePaused(false);
          if (!r.ok) this.reply(`⚠️ ${r.error}`);
          return;
        }
        const r = g.nextHand('slack');
        if (!r.ok) this.reply(`⚠️ ${r.error}`);
        return;
      }
      case 'rebuy': {
        const r = g.rebuy();
        if (!r.ok) return this.reply(`⚠️ ${r.error}`);
        this.closeNext(`💰 已补码 ${fmt(g.config.startingStack)}`);
        g.nextHand('slack');
        return;
      }
      case 'say': {
        const r = g.say(cmd.text, 'slack');
        if (!r.ok) this.reply(`⚠️ ${r.error}`);
        return;
      }
      case 'board':
        return this.reply(this.leaderboard());
      case 'newGame':
        g.newGame();
        if (cmd.start) g.nextHand('slack');
        return;
      case 'stop':
        this.reply('好的，牌局不再同步到 Slack。发 `德扑` 可以重新接入。');
        await this.chain;
        return this.stop();
      default:
        return this.reply(`没看懂 🤔 ${HELP}`);
    }
  }
}
