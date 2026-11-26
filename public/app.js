import { createAudio } from './audio.js';
import { initSettings, openSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const STREET = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };
let S = null;
const POSITION_TIPS = {
  BTN: '庄家位（按钮位）：翻牌后最后一个行动，位置最好',
  'BTN/SB': '单挑时庄家同时是小盲：翻牌前先行动，翻牌后最后行动',
  SB: '小盲位：强制下小盲注，翻牌后最先行动',
  BB: '大盲位：强制下大盲注，翻牌前最后行动',
  UTG: '枪口位（Under the Gun）：翻牌前第一个行动，位置最差',
  HJ: '劫持位（Hijack）：庄家前两位',
  CO: '关煞位（Cutoff）：庄家右手边，位置仅次于庄家',
};
const BUBBLE_MS = 3600; // 3 s visible + 0.6 s fade (matches the CSS animation)
let clockSkew = 0;
let raiseValue = 0;
let raiseTurn = null;

// ---------------------------------------------------------------- sound
const audio = createAudio();
let unlocked = false;
function unlock(e) {
  if (unlocked || e?.target?.closest?.('#bgmBtn')) return;
  unlocked = true;
  audio.start();
  updateBgmButton();
}
document.addEventListener('pointerdown', unlock);
document.addEventListener('keydown', unlock);
function updateBgmButton() {
  const b = $('bgmBtn');
  if (!b) return;
  b.textContent = audio.enabled ? (audio.ready ? '🎵 BGM 开' : '🎵 点一下页面开始') : '🔇 BGM 关';
  b.classList.toggle('on', audio.enabled && audio.ready);
}

// Sound cues from the difference between two consecutive states.
function playCues(prev, s) {
  if (!prev || prev.gameId !== s.gameId) return;
  const anyAllIn = s.status === 'playing' && s.players.some((p) => p.inHand && !p.folded && p.allIn);
  audio.setMood(anyAllIn ? 'tense' : 'lounge');
  if (s.handNo !== prev.handNo && s.status === 'playing') audio.sfx('deal');
  else if (s.board.length > prev.board.length) audio.sfx('card');
  if (s.handNo === prev.handNo && s.log.length > prev.log.length) {
    const e = s.log.at(-1);
    if (e.allIn && (e.action === 'raise' || e.action === 'bet' || e.action === 'call')) audio.sfx('allin');
    else if (['raise', 'bet', 'call', 'sb', 'bb'].includes(e.action)) audio.sfx('chips');
    else if (e.action === 'chat') audio.sfx('chat');
    else if (e.action === 'fold') audio.sfx('fold');
    else if (e.action === 'check') audio.sfx('check');
  }
  if (s.legal && s.legal.turnId !== prev.legal?.turnId) audio.sfx('turn');
  if (s.status === 'gameOver' && prev.status !== 'gameOver') audio.sfx(s.gameOver?.type === 'defeat' ? 'gameover' : 'victory');
  else if (s.knockout && !prev.knockout) audio.sfx('knockout');
  else if (s.status === 'handOver' && prev.status === 'playing' && s.result?.won?.[0] > 0) audio.sfx('win');
}

function cardHtml(c, cls = '') {
  if (!c) return `<div class="card back ${cls}"></div>`;
  const red = c[1] === 'h' || c[1] === 'd';
  return `<div class="card ${red ? 'red' : ''} ${cls}"><span class="r">${c[0] === 'T' ? '10' : c[0]}</span><span class="s">${SUIT[c[1]]}</span></div>`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const STICKER_NAMES = { smug: '得意', shock: '震惊', cry: '哭哭', think: '思考', angry: '生气', love: '比心' };
function stickerHtml(p, id, cls) {
  const st = p?.stickers?.find((x) => x.id === id);
  if (!st) return '';
  return `<img class="${cls}" src="${esc(st.url)}" alt="${esc(st.label)}" title="${esc(st.label)}">`;
}

// Round avatar: the character's face cropped from the portrait, or the emoji.
function faceHtml(p, cls = 'avatar') {
  if (p.kind === 'human') return `<span class="${cls}" style="background:#388bfd">🙂</span>`;
  if (p.portrait) return `<span class="${cls} pic" style="background-image:url('${esc(p.portrait)}');background-position:${esc(p.faceFocus ?? '50% 12%')};border-color:${p.color ?? '#888'}"></span>`;
  return `<span class="${cls}" style="background:${p.color ?? '#388bfd'}">${p.avatar ?? '🤖'}</span>`;
}

async function post(url, body = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (j && j.ok === false && j.error) toast(j.error);
  return j;
}
function toast(msg) {
  $('banner').textContent = `⚠️ ${msg}`;
  setTimeout(() => S && render(S), 2500);
}

// Fraction of the table box width the oval actually uses (the oval keeps a ~1.6:1 shape on wide screens).
let squeeze = 1;
function seatXY(i, n, rx = 45, ry = 39) {
  const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [50 + rx * squeeze * Math.cos(a), 50 + ry * Math.sin(a)];
}

function render(s) {
  if (s.serverNow) clockSkew = s.serverNow - Date.now();
  playCues(S, s);
  S = s;
  const subtitle = `你 vs ${s.players.length - 1} 个 AI`;
  if ($('brandSub').textContent !== subtitle) {
    $('brandSub').textContent = subtitle;
    document.title = `德州扑克 · ${subtitle}`;
  }
  const n = s.players.length;
  $('meta').innerHTML = s.handNo
    ? `第 <b>${s.handNo}</b> 手 · 盲注 <b>${s.smallBlind}/${s.bigBlind}</b>${s.blindsNext ? `（第 ${s.blindLevel} 级${s.blindsNextIn != null ? `，${s.blindsNextIn} 手后升到 ${s.blindsNext[0]}/${s.blindsNext[1]}` : ''}）` : ''}${s.street && s.status === 'playing' ? ` · ${STREET[s.street]}` : ''}`
    : `盲注 <b>${s.smallBlind}/${s.bigBlind}</b> · 起始筹码 <b>${fmt(s.startingStack)}</b>`;
  const slackBtn = $('slackBtn');
  slackBtn.classList.toggle('on', Boolean(s.slack));
  slackBtn.textContent = s.slack ? 'Slack 已同步 ✓' : '同步到 Slack';
  slackBtn.title = s.slack ? '点击停止同步；在 Slack 里打开线程：' + (s.slack.link ?? '') : '在 Slack 频道里开一个线程同步牌局';

  const winners = new Set((s.result?.pots ?? []).flatMap((p) => p.winners));
  const reveals = new Map((s.result?.reveals ?? []).map((r) => [r.seat, r]));
  let html = '';
  s.players.forEach((p, i) => {
    const [x, y] = seatXY(i, n);
    const acting = s.toAct === p.seat || s.thinking?.seat === p.seat;
    const dead = Boolean(p.place) && p.stack <= 0;
    const cls = ['seat', p.kind === 'human' ? 'me' : '', dead ? 'dead' : '', p.folded && p.inHand ? 'folded' : '', (!p.inHand && s.status === 'playing') || p.stack <= 0 ? 'out' : '', acting && s.status === 'playing' ? 'acting' : '', winners.has(p.seat) && (s.status === 'handOver' || s.status === 'gameOver') ? 'winner' : ''].join(' ');
    const cards = (p.hole ?? []).map((c) => cardHtml(c, 'small')).join('');
    let status = '';
    if (s.thinking?.seat === p.seat) status = '<span class="thinking-dots">思考中</span>';
    else if (s.toAct === p.seat && p.kind === 'human') status = '<b style="color:var(--gold)">轮到你了</b>';
    else if (p.lastAction) status = esc(p.lastAction.text) + (p.lastAction.fallback ? ' <span class="fallback" title="模型调用失败，用了内置策略">⚙托管</span>' : '');
    else if (p.allIn) status = '全下';
    if (s.status === 'handOver' && reveals.has(p.seat)) status = esc(reveals.get(p.seat).hand);
    if (s.status === 'handOver' && s.result?.won?.[p.seat]) status += ` <b style="color:var(--gold)">+${fmt(s.result.won[p.seat])}</b>`;
    if (dead) status = `<span class="rip">💀 出局 · 第 ${p.place} 名</span>`;
    const la = p.lastAction;
    const lc = p.lastChat;
    const actTalk = la && la.street === s.street && (la.say || la.emote) ? la : null;
    const talk = lc && (!actTalk || (lc.idx ?? 0) > (actTalk.idx ?? 0)) ? lc : actTalk;
    // Speech bubbles sit beside the seat (never over the cards) and fade out after 3 s.
    const age = talk?.at ? Date.now() + clockSkew - talk.at : 0;
    const bubble =
      talk && age < BUBBLE_MS
        ? `<div class="bubble ${x > 55 ? 'left' : 'right'}${talk.emote ? ' has-sticker' : ''}${talk === lc ? ' chat' : ''}" style="animation-delay:-${Math.max(0, Math.round(age))}ms">${talk.emote ? stickerHtml(p, talk.emote, 'sticker') : ''}${talk.say ? `<span>${esc(talk.say)}</span>` : ''}</div>`
        : '';
    html += `<div class="${cls}" style="left:${x}%;top:${y}%">
      <div class="cards">${cards}</div>
      <div class="plate">${bubble}
        ${p.position ? `<span class="pos" title="${esc(POSITION_TIPS[p.position.split('+')[0]] ?? POSITION_TIPS[p.position] ?? '')}">${p.position}</span>` : ''}
        <div class="name">${faceHtml(p)}${esc(p.name)}</div>
        ${p.model ? `<div class="model">${esc(p.model)}</div>` : '<div class="model">人类玩家</div>'}
        <div class="stack">${fmt(p.stack)}</div>
        <div class="status">${status}</div>
      </div></div>`;
    if (p.bet > 0 && s.status === 'playing') {
      const [bx, by] = seatXY(i, n, 30, 25);
      html += `<div class="bet" style="left:${bx}%;top:${by}%">${fmt(p.bet)}</div>`;
    }
    if (s.button === p.seat) {
      const [dx, dy] = seatXY(i + 0.38, n, 33, 30);
      html += `<div class="dealer" style="left:${dx}%;top:${dy}%">D</div>`;
    }
  });
  $('seats').innerHTML = html;

  $('pot').textContent = s.pot ? `底池 ${fmt(s.pot)}` : '';
  const board = s.board.map((c) => cardHtml(c)).join('');
  if ($('board').dataset.key !== s.board.join()) {
    $('board').innerHTML = board;
    $('board').dataset.key = s.board.join();
  }
  let banner = '';
  if ((s.status === 'handOver' || s.status === 'gameOver') && s.result) {
    banner = s.result.pots
      .map((pot) => `🏆 ${pot.winners.map((w) => (w === 0 ? '你' : s.players[w].name)).join('、')} 赢得 ${fmt(pot.amount)}${pot.hand ? `（${pot.hand}）` : ''}`)
      .join('<br>');
    for (const e of s.eliminations ?? []) banner += `<br>💀 ${e.seat === 0 ? '你' : esc(e.name)} 出局（第 ${e.place} 名）`;
  } else if (s.status === 'ready') banner = s.eliminationMode ? '淘汰赛：筹码归零即出局。点「开始」发牌' : '点「开始」发牌';
  $('banner').innerHTML = banner;

  renderControls(s);
  renderChat(s);
  renderLog(s);
  renderBoard(s);
  renderOver(s);
  $('recent').innerHTML = s.recent.slice().reverse().map((r) => `<div>${esc(r)}</div>`).join('') || '<div style="color:var(--muted)">还没有</div>';
}

// "Auto next hand" switch shown in the control bar; the delay comes from settings (default 5 s).
function autoNextToggle(s) {
  return `<label class="autonext" title="一手结束后自动发下一手"><input type="checkbox" id="autoNextChk" ${s.autoNextHandMs > 0 ? 'checked' : ''}> 自动下一手</label>`;
}
function bindAutoNext(s) {
  const chk = $('autoNextChk');
  if (!chk) return;
  chk.onchange = () => post('/api/auto-next', { ms: chk.checked ? Number(localStorage.getItem('holdem.autoNextMs') || 5000) : 0 });
}
let countdown = null;
function startCountdown(at) {
  clearInterval(countdown);
  countdown = setInterval(() => {
    const els = document.querySelectorAll('.autoLeft');
    if (!els.length) return clearInterval(countdown);
    for (const el of els) el.textContent = String(Math.max(0, Math.ceil((at - Date.now()) / 1000)));

  }, 250);
}

function renderControls(s) {
  const c = $('controls');
  const me = s.players[0];
  const L = s.legal;
  if (!L) {
    if (s.status === 'gameOver') {
      const g = s.gameOver;
      const canSpectate = g?.type === 'defeat' && s.players.filter((p) => p.stack > 0).length >= 2;
      const info =
        g?.type === 'victory' ? '👑 你赢下了整张桌子' : g?.type === 'champion' ? `🏆 ${esc(s.players[g.rival]?.name ?? '')} 夺冠，你最终第 ${g.place} 名` : `💀 你已出局（第 ${g?.place ?? '-'} 名）`;
      c.innerHTML = `<div class="info">${info}</div><button class="ghost" id="showOverBtn">查看结算</button>${canSpectate ? '<button class="ghost" id="spectateBtn">👀 继续观战</button>' : ''}<button class="primary" id="againBtn">🔄 再来一局</button>`;
      $('showOverBtn').onclick = () => {
        overDismissed = null;
        renderOver(S);
      };
      if ($('spectateBtn')) $('spectateBtn').onclick = () => post('/api/spectate');
      $('againBtn').onclick = newGameAndDeal;
      return;
    }
    if (s.spectating) {
      const alive = s.players.filter((p) => p.stack > 0).length;
      const who = s.thinking ? s.players[s.thinking.seat] : null;
      c.innerHTML = `<div class="info">👀 观战中 · 场上还剩 <b>${alive}</b> 人${who ? ` · 等待 <b>${esc(who.name)}</b> 思考<span class="thinking-dots"></span>` : ''}${s.spectatePaused ? ' · 已暂停' : ''}</div>
        <button class="ghost" id="pauseBtn">${s.spectatePaused ? '▶ 继续' : '⏸ 暂停'}</button>
        <button class="primary" id="againBtn">🔄 结束观战，开新局</button>`;
      $('pauseBtn').onclick = () => post('/api/spectate/pause', { paused: !s.spectatePaused });
      $('againBtn').onclick = () => {
        if (confirm('结束观战并重新开始？')) newGameAndDeal();
      };
      return;
    }
    if (s.status === 'playing') {
      const who = s.thinking ? s.players[s.thinking.seat] : null;
      c.innerHTML = `<div class="info">${me.folded && me.inHand ? '你已弃牌，' : ''}${who ? `等待 <b>${esc(who.name)}</b>（${esc(who.model)}）思考<span class="thinking-dots"></span>` : '进行中…'}</div>${autoNextToggle(s)}`;
    } else if (me.stack <= 0) {
      c.innerHTML = `<div class="info">你的筹码输光了。</div><button class="gold" id="rebuyBtn">补码 ${fmt(s.startingStack)} 并继续</button>`;
      $('rebuyBtn').onclick = async () => {
        const r = await post('/api/rebuy');
        if (r.ok) post('/api/next');
      };
    } else {
      const left = s.autoNextAt ? Math.max(0, Math.ceil((s.autoNextAt - Date.now()) / 1000)) : null;
      c.innerHTML = `<div class="info">${s.status === 'ready' ? `${s.players.length} 人桌，你的筹码 <b>${fmt(me.stack)}</b>。` : `这一手结束了。${left != null ? `<span class="autoLeft">${left}</span> 秒后自动发下一手` : ''}`}</div>${autoNextToggle(s)}<button class="primary" id="nextBtn">${s.status === 'ready' ? '开始' : '下一手 ▶'}</button>`;
      $('nextBtn').onclick = () => post('/api/next');
      if (left != null) startCountdown(s.autoNextAt);
    }
    bindAutoNext(s);
    return;
  }
  if (raiseTurn !== L.turnId) {
    raiseTurn = L.turnId;
    raiseValue = L.minTo;
  }
  const step = s.smallBlind || 1;
  const potAfter = L.pot + L.toCall;
  const presets = [
    ['最小', L.minTo],
    ['½池', L.isBet ? potAfter / 2 : L.currentBet + potAfter / 2],
    ['¾池', L.isBet ? (potAfter * 3) / 4 : L.currentBet + (potAfter * 3) / 4],
    ['1池', L.isBet ? potAfter : L.currentBet + potAfter],
  ].map(([k, v]) => [k, Math.max(L.minTo, Math.min(L.maxTo, Math.round(v / step) * step))]);
  c.innerHTML = `
    <div class="info">底池 <b>${fmt(L.pot)}</b> · ${L.canCall ? `需跟 <b>${fmt(L.toCall)}</b>` : '可以过牌'} · 你的筹码 <b>${fmt(L.stack)}</b></div>
    ${L.canCall ? '<button class="danger" data-a="fold">弃牌</button>' : ''}
    ${L.canCheck ? '<button class="primary" data-a="check">过牌</button>' : `<button class="primary" data-a="call">跟注 ${fmt(L.toCall)}${L.toCall >= L.stack ? '（全下）' : ''}</button>`}
    ${
      L.canRaise
        ? `<div class="raise-box">
        <span class="presets">${presets.map(([k, v]) => `<button data-p="${v}">${k}</button>`).join('')}</span>
        <input type="range" id="rr" min="${L.minTo}" max="${L.maxTo}" step="${step}" value="${raiseValue}">
        <input type="number" id="rn" min="${L.minTo}" max="${L.maxTo}" step="${step}" value="${raiseValue}">
        <button class="gold" data-a="raise">${L.isBet ? '下注' : '加注到'} <span id="rv">${fmt(raiseValue)}</span></button>
        <button class="danger" data-a="allin">全下 ${fmt(L.maxTo)}</button>
      </div>`
        : ''
    }`;
  const sync = (v) => {
    raiseValue = Math.max(L.minTo, Math.min(L.maxTo, Number(v) || L.minTo));
    if ($('rr')) $('rr').value = raiseValue;
    if ($('rn')) $('rn').value = raiseValue;
    if ($('rv')) $('rv').textContent = fmt(raiseValue);
  };
  if ($('rr')) $('rr').oninput = (e) => sync(e.target.value);
  if ($('rn')) $('rn').onchange = (e) => sync(e.target.value);
  c.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => sync(b.dataset.p)));
  c.querySelectorAll('[data-a]').forEach(
    (b) =>
      (b.onclick = () => {
        const a = b.dataset.a;
        if (a === 'allin') return post('/api/action', { action: 'raise', amount: L.maxTo, turnId: L.turnId });
        post('/api/action', { action: a, amount: raiseValue, turnId: L.turnId });
      }),
  );
}

// Chat bar: free text any time during a hand, plus AI-written quick replies on your turn.
let quickKey = null;
function renderChat(s) {
  const bar = $('chatbar');
  bar.classList.toggle('hidden', s.status !== 'playing');
  const q = s.quickReplies;
  const key = q ? `${s.legal?.turnId}-${Array.isArray(q) ? q.length : 'loading'}` : 'none';
  if (key === quickKey) return;
  quickKey = key;
  const box = $('quick');
  if (!q) box.innerHTML = '';
  else if (q === 'loading') box.innerHTML = '<span class="qhint thinking-dots">正在帮你想台词</span>';
  else {
    box.innerHTML = q.map((x, i) => `<button type="button" class="qr qr-${esc(x.style)}" data-i="${i}" title="${esc(x.label)}"><b>${esc(x.label)}</b>${esc(x.text)}</button>`).join('');
    box.querySelectorAll('.qr').forEach((b) => {
      b.onclick = async () => {
        const r = await post('/api/say', { text: q[Number(b.dataset.i)].text });
        if (r.ok) b.classList.add('sent');
      };
    });
  }
}
$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  const r = await post('/api/say', { text });
  if (r.ok) input.value = '';
};

function renderLog(s) {
  let street = '';
  const out = [];
  for (const e of s.log) {
    if (e.street !== street) {
      street = e.street;
      out.push(`<div class="street">${STREET[street]}</div>`);
    }
    const p = s.players[e.seat];
    if (e.action === 'chat') {
      out.push(`<div class="chatline"><b style="color:${p.color ?? '#79c0ff'}">${esc(p.name)}</b> 💬 <span class="say">「${esc(e.say)}」</span></div>`);
      continue;
    }
    out.push(
      `<div><b style="color:${p.color ?? '#79c0ff'}">${esc(p.name)}</b> ${esc(e.text)}${e.say ? ` <span class="say">「${esc(e.say)}」</span>` : ''}${e.emote ? ` ${stickerHtml(p, e.emote, 'log-sticker')}` : ''}${e.ms ? ` <span class="ms">${(e.ms / 1000).toFixed(1)}s</span>` : ''}${e.fallback ? ' <span class="fallback">⚙托管</span>' : ''}</div>`,
    );
  }
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = out.join('') || '<div style="color:var(--muted)">等待发牌</div>';
  if (atBottom) log.scrollTop = log.scrollHeight;
}

let overDismissed = null;
let overShownKey = null;

async function newGameAndDeal() {
  await post('/api/new-game');
  overDismissed = null;
  post('/api/next');
}

function renderKnockout(s) {
  const el = $('over');
  const k = s.knockout;
  const key = `ko-${s.gameId}-${k.handNo}-${k.seat}`;
  if (overDismissed === key) {
    el.className = 'over hidden';
    el.innerHTML = '';
    overShownKey = null;
    return;
  }
  const p = s.players[k.seat];
  const cards = (cs) => (cs ?? []).map((c) => cardHtml(c, 'small')).join('');
  const pose = p.losePortrait ?? p.portrait;
  const portrait = pose
    ? `<img src="${esc(pose)}" alt="" style="object-position:${esc(p.losePortrait ? '50% 30%' : (p.portraitPos ?? '50% 0%'))}">`
    : `<span class="emoji">${p.avatar ?? '🤖'}</span>`;
  const alive = s.players.filter((x) => x.stack > 0).length;
  const byHuman = k.byHuman !== false;
  const winner = s.players[k.by ?? 0];
  const winnerName = byHuman ? '你' : esc(winner?.name ?? '对手');
  const left = s.autoNextAt ? Math.max(0, Math.ceil((s.autoNextAt - Date.now()) / 1000)) : null;
  const html = `
    <div class="box flirty-box ko-box">
      <div class="card-portrait knocked" style="--c:${p.color ?? '#e0559b'}">
        <div class="art">${portrait}</div>
        <div class="stamp">K.O.</div>
        <div class="nm">${esc(p.name)}</div>
        <div class="tt">${esc(p.title ?? '')}</div>
        <div class="md">${esc(p.model ?? '')}${p.portraitCredit && pose ? ` · ${esc(p.portraitCredit)}` : ''}</div>
      </div>
      <div class="side-text">
        <div class="title">${byHuman ? `${esc(p.name)} 被你拿下了♡` : `${esc(p.name)} 出局了…`}</div>
        <div class="subtitle">${byHuman ? '' : `被 <b style="color:${winner?.color ?? '#fff'}">${winnerName}</b> 淘汰 · `}第 ${k.handNo} 手筹码归零 · 第 ${k.place} / ${k.players} 名 · 场上还剩 ${alive} 人</div>
        <div class="bubble-big">${k.line ? `「${esc(k.line)}」` : '<span class="thinking-dots">她正红着脸组织语言</span>'}</div>
        ${k.reward ? `<div class="penalty"><span>🎁 胜者奖励</span>${esc(k.reward)}</div>` : ''}
        ${
          k.theirHole
            ? `<div class="showdown mini"><div class="cards">${cards(k.myHole)}</div><span class="vs">vs</span><div class="cards">${cards(k.theirHole)}</div><span class="vs">·</span><div class="cards">${cards(k.board)}</div></div>
               <div class="mini-stats">${winnerName} <b>${esc(k.myHand ?? '')}</b> 赢了她的 <b>${esc(k.theirHand ?? '')}</b>${left != null ? ` · <span class="autoLeft">${left}</span> 秒后自动继续` : ''}</div>`
            : ''
        }
        <div class="actions">
          <button class="ghost" id="overClose">看看牌桌</button>
          <button class="pink" id="overNext">💗 继续下一手</button>
        </div>
      </div>
    </div>`;
  if (overShownKey !== key || el.dataset.taunt !== String(k.line)) {
    el.innerHTML = html;
    el.dataset.taunt = String(k.line);
    el.className = 'over flirty';
    if (overShownKey !== key) rain(el, ['💗', '💋', '🌹', '💕', '✨', '🪙']);
    overShownKey = key;
    if (s.autoNextAt) startCountdown(s.autoNextAt);
    $('overClose').onclick = () => {
      overDismissed = key;
      renderOver(S);
    };
    $('overNext').onclick = () => {
      overDismissed = key;
      renderOver(S);
      post('/api/next');
    };
  }
}

function renderOver(s) {
  if (s.status === 'handOver' && s.knockout) return renderKnockout(s);
  const el = $('over');
  const g = s.gameOver;
  const key = g ? `${s.gameId}-${g.handNo}` : null;
  if (!g || s.status !== 'gameOver' || overDismissed === key) {
    el.className = 'over hidden';
    el.innerHTML = '';
    overShownKey = null;
    return;
  }
  const rival = s.players[g.rival];
  const defeat = g.type === 'defeat';
  const champ = g.type === 'champion';
  const canSpectate = defeat && s.players.filter((p) => p.stack > 0).length >= 2;
  const spectateBtn = canSpectate ? '<button class="ghost" id="overSpectate">👀 继续观战（AI 血战到底）</button>' : '';
  const cards = (cs) => (cs ?? []).map((c) => cardHtml(c, 'small')).join('');
  const standings = s.players
    .slice()
    .sort((a, b) => (a.place ?? 0) - (b.place ?? 0) || b.stack - a.stack)
    .map((p) => `<span class="${p.kind === 'human' ? 'me' : ''}">${p.place ? `#${p.place}` : '存活'} ${p.kind === 'human' ? '你' : esc(p.name)}</span>`)
    .join('');
  const quote = `<div class="quote"><span class="who">${esc(rival?.name ?? '')} · ${esc(rival?.model ?? '')}</span>${g.taunt ? esc(g.taunt) : '<span class="thinking-dots">正在组织语言</span>'}</div>`;
  const flirty = g.style === 'flirty';
  const posed = defeat || champ ? rival?.winPortrait : rival?.losePortrait;
  const pose = posed ?? rival?.portrait;
  const portrait = pose
    ? `<img src="${esc(pose)}" alt="" style="object-position:${esc(posed ? '50% 30%' : (rival.portraitPos ?? '50% 0%'))}">`
    : `<span class="emoji">${rival?.avatar ?? '🤖'}</span>`;
  const flirtyHtml = `
    <div class="box flirty-box">
      <div class="card-portrait" style="--c:${rival?.color ?? '#e0559b'}">
        <div class="art">${portrait}</div>
        <div class="kiss">💋</div>
        <div class="nm">${esc(rival?.name ?? '')}</div>
        <div class="tt">${esc(rival?.title ?? '')}</div>
        <div class="md">${esc(rival?.model ?? '')}${rival?.portraitCredit && pose ? ` · ${esc(rival.portraitCredit)}` : ''}</div>
      </div>
      <div class="side-text">
        <div class="title">${champ ? `${esc(rival?.name ?? '')} 夺冠！` : defeat ? '你输光了哦～' : '…这次算你赢'}</div>
        <div class="subtitle">${champ ? `她把所有对手都送出了牌桌 · 共 ${g.handNo} 手 · 你最终第 ${g.place} / ${g.players} 名` : defeat ? `全部筹码都被 <b style="color:${rival?.color ?? '#fff'}">${esc(rival?.name ?? '对手')}</b> 收下了 · 第 ${g.place} / ${g.players} 名` : `最后一个被你淘汰的是 <b style="color:${rival?.color ?? '#fff'}">${esc(rival?.name ?? '')}</b> · 第 1 名`}</div>
        <div class="bubble-big">${g.taunt ? `「${esc(g.taunt)}」` : '<span class="thinking-dots">她/他正凑过来</span>'}</div>
        ${g.penalty ? `<div class="penalty"><span>${champ ? '🎀 给观战者的惩罚' : defeat ? '🎀 惩罚游戏' : '🎁 胜者奖励'}</span>${esc(g.penalty)}</div>` : ''}
        ${
          defeat && g.rivalHole
            ? `<div class="showdown mini"><div class="cards">${cards(g.myHole)}</div><span class="vs">vs</span><div class="cards">${cards(g.rivalHole)}</div><span class="vs">·</span><div class="cards">${cards(g.board)}</div></div>`
            : ''
        }
        <div class="mini-stats">坚持 <b>${g.handsPlayed}</b> 手 · 赢下 <b>${g.handsWon}</b> 手 · 最高筹码 <b>${fmt(g.peakStack)}</b></div>
        <div class="standings">${standings}</div>
        <div class="actions">
          <button class="ghost" id="overClose">看看牌桌</button>
          ${spectateBtn}
          <button class="pink" id="overAgain">${defeat ? '💗 乖乖认输，再来一局' : '💗 再来一局'}</button>
        </div>
      </div>
    </div>`;
  const html = flirty
    ? flirtyHtml
    : `
    ${defeat ? '<div class="crack"></div>' : ''}
    <div class="box">
      <div class="title">${champ ? 'CHAMPION' : defeat ? 'GAME OVER' : 'VICTORY'}</div>
      <div class="subtitle">${champ ? `${esc(rival?.name ?? '')} 赢下了整张桌子` : defeat ? `你被 <span style="color:${rival?.color ?? '#fff'}">${esc(rival?.name ?? '对手')}</span> 送出了牌桌` : `你把 ${s.players.length - 1} 个 AI 全部送回了机房`}</div>
      <div class="place">${g.place}<small> / ${g.players} 名</small></div>
      <div class="rival">${rival ? faceHtml(rival, 'face') : ''}${quote}</div>
      ${
        defeat && g.rivalHole
          ? `<div class="showdown">
        <div class="side"><div class="cards">${cards(g.myHole)}</div>你 · ${esc(g.myHand ?? '')}</div>
        <div class="vs">VS</div>
        <div class="side"><div class="cards">${cards(g.rivalHole)}</div>${esc(rival?.name ?? '')} · ${esc(g.rivalHand ?? '')}</div>
        <div class="side"><div class="cards">${cards(g.board)}</div>公共牌</div>
      </div>`
          : ''
      }
      <div class="stats">
        <div><b>${g.handsPlayed}</b><span>坚持手数</span></div>
        <div><b>${g.handsWon}</b><span>赢下手数</span></div>
        <div><b>${fmt(g.peakStack)}</b><span>最高筹码</span></div>
      </div>
      <div class="standings">${standings}</div>
      <div class="actions">
        <button class="ghost" id="overClose">看看牌桌</button>
        ${spectateBtn}
        <button class="${defeat ? 'danger' : 'gold'}" id="overAgain">🔄 ${defeat ? '不服，再来' : '再来一局'}</button>
      </div>
    </div>`;
  if (overShownKey !== key || el.dataset.taunt !== String(g.taunt)) {
    el.innerHTML = html;
    el.dataset.taunt = String(g.taunt);
    el.className = `over ${flirty ? 'flirty' : defeat ? 'defeat' : 'victory'}`;
    if (overShownKey !== key) rain(el, flirty ? ['💗', '💋', '🌹', '💕', '✨', '🪙'] : defeat ? ['💸', '🪙', '💀', '🃏'] : ['🪙', '👑', '✨', '🎉', '💰']);
    overShownKey = key;
    $('overClose').onclick = () => {
      overDismissed = key;
      renderOver(S);
    };
    $('overAgain').onclick = newGameAndDeal;
    if ($('overSpectate')) {
      $('overSpectate').onclick = () => {
        overDismissed = key;
        post('/api/spectate');
      };
    }
  }
}

function rain(el, symbols) {
  for (let i = 0; i < 36; i++) {
    const d = document.createElement('div');
    d.className = 'chip-rain';
    d.textContent = symbols[i % symbols.length];
    d.style.left = `${Math.random() * 100}%`;
    d.style.animationDuration = `${2.5 + Math.random() * 3}s`;
    d.style.animationDelay = `${Math.random() * 1.5}s`;
    el.appendChild(d);
  }
}

function renderBoard(s) {
  $('board-list').innerHTML = s.players
    .slice()
    .sort((a, b) => b.net - a.net)
    .map(
      (p, i) =>
        `<div class="row"><span>${i + 1}</span><span class="who">${faceHtml(p, 'mface')} ${esc(p.name)} <span class="m">${esc(p.model ?? '')}</span></span><span class="${p.net >= 0 ? 'pos-net' : 'neg-net'}">${p.net >= 0 ? '+' : ''}${fmt(p.net)}</span><span class="m">${p.handsWon}胜${p.buyIns > 1 ? ` ·${p.buyIns}买入` : ''}</span></div>`,
    )
    .join('');
}

$('bgmBtn').onclick = (e) => {
  e.stopPropagation();
  if (!unlocked) {
    unlocked = true;
    audio.start();
    if (!audio.enabled) audio.toggle();
  } else audio.toggle();
  updateBgmButton();
};
$('volume').value = String(audio.volume);
$('volume').oninput = (e) => audio.setVolume(Number(e.target.value));
updateBgmButton();

initSettings();

// Scale seats, cards and chips with the table so everything fits the window at any zoom level.
const TABLE_RATIO = 1.6; // oval width : table height
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  const used = Math.min(width, height * TABLE_RATIO);
  const s = Math.max(0.5, Math.min(1, used / 1000, height / 640));
  const t = $('table');
  t.style.setProperty('--s', s.toFixed(3));
  t.style.setProperty('--fx', `${Math.round((width - used) / 2 + used * 0.08)}px`);
  const next = used / width;
  if (Math.abs(next - squeeze) > 0.005) {
    squeeze = next;
    if (S) render(S);
  }
}).observe($('table'));
$('settingsBtn').onclick = () => openSettings();
{
  const sp = new URLSearchParams(location.search);
  if (sp.has('settings')) openSettings(sp.get('settings') || 'game', sp.get('open'));
}

$('newGameBtn').onclick = () => {
  if (confirm('重新开始？所有人的筹码会重置。')) post('/api/new-game');
};
$('slackBtn').onclick = async () => {
  if (S?.slack) {
    if (S.slack.link && confirm('已经同步到 Slack。确定 = 打开 Slack 线程；取消 = 停止同步')) window.open(S.slack.link, '_blank');
    else if (!S.slack.link || confirm('停止同步到 Slack？')) post('/api/slack/stop');
    return;
  }
  $('slackBtn').textContent = '连接中…';
  const r = await post('/api/slack/open');
  if (!r.ok) toast(r.error ?? '连接 Slack 失败（Slack 桥接服务在运行吗？config.json 里 slack 配好了吗？）');
};
document.addEventListener('keydown', (e) => {
  if (!S?.legal || e.target.tagName === 'INPUT') return;
  const L = S.legal;
  const k = e.key.toLowerCase();
  if (k === 'f' && L.canCall) post('/api/action', { action: 'fold', turnId: L.turnId });
  if (k === 'c' || k === ' ') post('/api/action', { action: L.canCheck ? 'check' : 'call', turnId: L.turnId });
  if (k === 'r' && L.canRaise) post('/api/action', { action: 'raise', amount: raiseValue, turnId: L.turnId });
});

function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    $('banner').textContent = '与服务器断开，正在重连…';
    setTimeout(connect, 1500);
  };
}
fetch('/state')
  .then((r) => r.json())
  .then(render)
  .catch(() => {});
if (!new URLSearchParams(location.search).has('static')) connect();
