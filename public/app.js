import { createAudio } from './audio.js';
import { initSettings, openSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const STREET = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };
let S = null;
// Each browser has its own player token (LAN mode); the host on the server machine needs none.
const TOKEN = (() => {
  let t = localStorage.getItem('holdem.player');
  if (!t) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('holdem.player', t);
  }
  return t;
})();
const isMe = (p) => Boolean(p && S && S.you >= 0 && p.seat === S.you);
// Still playing: has chips and has not left the table (a LAN guest who left keeps a sitting-out seat).
const inPlay = (p) => p.stack > 0 && !p.sittingOut;
const nameOf = (p) => (isMe(p) ? '你' : (p?.name ?? ''));
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
// Server clock minus ours, measured when a fresh state arrives (never from a re-render of an old one).
let clockSkew = 0;
const serverNow = () => Date.now() + clockSkew;
const secondsLeft = (at) => Math.max(0, Math.ceil((at - serverNow()) / 1000));
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
}
audio.onStateChange(updateBgmButton);

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
  if (s.status === 'gameOver' && prev.status !== 'gameOver') {
    // Only your own win of the table gets the fanfare; an AI champion or your defeat gets the sad tune.
    const won = s.gameOver?.type === 'victory' && s.gameOver.subject === s.you;
    audio.sfx(won ? 'victory' : 'gameover');
  } else if (s.myOut && !prev.myOut) audio.sfx('gameover');
  else if (s.knockout && !prev.knockout) audio.sfx('knockout');
  else if (s.status === 'handOver' && prev.status === 'playing' && s.you >= 0 && s.result?.won?.[s.you] > 0) audio.sfx('win');
}

function cardHtml(c, cls = '') {
  if (!c) return `<div class="card back ${cls}"></div>`;
  const red = c[1] === 'h' || c[1] === 'd';
  return `<div class="card ${red ? 'red' : ''} ${cls}"><span class="r">${c[0] === 'T' ? '10' : c[0]}</span><span class="s">${SUIT[c[1]]}</span></div>`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// Character colours come from config.json and go into style attributes: only accept plain CSS colours.
const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i;
const col = (c, fallback) => (COLOR_RE.test(String(c ?? '')) ? c : fallback);
// Same for crop positions ("62% 6%") and image URLs inside CSS url('…').
const pos = (v, fallback) => (/^[\d.%\sa-z-]{1,40}$/i.test(String(v ?? '')) ? v : fallback);
const cssUrl = (u) => esc(String(u ?? '').replace(/['"()\\\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`));
const avatarOf = (p) => esc(p?.avatar ?? '🤖');

function stickerHtml(p, id, cls) {
  const st = p?.stickers?.find((x) => x.id === id);
  if (!st) return '';
  return `<img class="${cls}" src="${esc(st.url)}" alt="${esc(st.label)}" title="${esc(st.label)}">`;
}

// Round avatar: the character's face cropped from the portrait, or the emoji.
function faceHtml(p, cls = 'avatar') {
  if (p.kind === 'human') return `<span class="${cls}" style="background:${isMe(p) ? '#388bfd' : '#8957e5'}">${isMe(p) ? '🙂' : '🧑'}</span>`;
  if (p.portrait) return `<span class="${cls} pic" style="background-image:url('${cssUrl(p.portrait)}');background-position:${pos(p.faceFocus, '50% 12%')};border-color:${col(p.color, '#888')}"></span>`;
  return `<span class="${cls}" style="background:${col(p.color, '#388bfd')}">${avatarOf(p)}</span>`;
}

async function post(url, body = {}) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-player': TOKEN }, body: JSON.stringify(body) });
  } catch {
    toast('连不上服务器');
    return { ok: false, error: '连不上服务器' };
  }
  const j = await r.json().catch(() => ({}));
  if (j && j.ok === false && !j.error && !r.ok) j.error = r.status === 403 ? `没有权限（HTTP 403）` : `请求失败（HTTP ${r.status}）`;
  if (j && j.ok === false && j.error) toast(j.error);
  return j;
}
// Errors show in the banner for a few seconds (renders in between keep them).
let toastText = '';
let toastUntil = 0;
function toast(msg) {
  toastText = msg;
  toastUntil = Date.now() + 2500;
  if (S) render(S);
  else $('banner').textContent = `⚠️ ${msg}`;
  setTimeout(() => S && render(S), 2600);
}

// Fraction of the table box width the oval actually uses (the oval keeps a ~1.6:1 shape on wide screens).
let squeeze = 1;
function seatXY(i, n, rx = 45, ry = 39) {
  const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [50 + rx * squeeze * Math.cos(a), 50 + ry * Math.sin(a)];
}

// Hole cards per seat from the last render: unchanged cards skip the deal animation (seats are re-rendered on every push).
const seatCards = new Map();

function render(s) {
  playCues(S, s);
  S = s;
  const humans = s.players.filter((p) => p.kind === 'human').length;
  const subtitle = humans > 1 ? `${humans} 位真人 vs ${s.players.length - humans} 个 AI` : `你 vs ${s.players.length - 1} 个 AI`;
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
  const base = s.you >= 0 ? s.you : 0;
  s.players.forEach((p) => {
    const i = (p.seat - base + n) % n;
    const [x, y] = seatXY(i, n);
    const acting = s.toAct === p.seat || s.thinking?.seat === p.seat;
    const dead = Boolean(p.place) && p.stack <= 0;
    const cls = ['seat', isMe(p) ? 'me' : p.kind === 'human' ? 'guest' : '', dead ? 'dead' : '', p.folded && p.inHand ? 'folded' : '', (!p.inHand && s.status === 'playing') || p.stack <= 0 ? 'out' : '', acting && s.status === 'playing' ? 'acting' : '', winners.has(p.seat) && (s.status === 'handOver' || s.status === 'gameOver') ? 'winner' : ''].join(' ');
    const cardKey = `${s.gameId}|${s.handNo}|${(p.hole ?? []).join()}`;
    const cards = (p.hole ?? []).map((c) => cardHtml(c, seatCards.get(p.seat) === cardKey ? 'small still' : 'small')).join('');
    seatCards.set(p.seat, cardKey);
    let status = '';
    if (s.thinking?.seat === p.seat) status = '<span class="thinking-dots">思考中</span>';
    else if (s.toAct === p.seat && isMe(p)) status = '<b style="color:var(--gold)">轮到你了</b>';
    else if (s.toAct === p.seat && p.kind === 'human') status = '<span class="thinking-dots">思考中</span>';
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
    const age = talk?.at ? serverNow() - talk.at : 0;
    const bubble =
      talk && age < BUBBLE_MS
        ? `<div class="bubble ${x > 55 ? 'left' : 'right'}${talk.emote ? ' has-sticker' : ''}${talk === lc ? ' chat' : ''}" style="animation-delay:-${Math.max(0, Math.round(age))}ms">${talk.emote ? stickerHtml(p, talk.emote, 'sticker') : ''}${talk.say ? `<span>${esc(talk.say)}</span>` : ''}</div>`
        : '';
    html += `<div class="${cls}" style="left:${x}%;top:${y}%">
      <div class="cards">${cards}</div>
      <div class="plate">${bubble}
        ${p.position ? `<span class="pos" title="${esc(POSITION_TIPS[p.position.split('+')[0]] ?? POSITION_TIPS[p.position] ?? '')}">${esc(p.position)}</span>` : ''}
        <div class="name">${faceHtml(p)}${esc(isMe(p) && humans > 1 && p.name !== '你' ? `${p.name}（你）` : p.name)}</div>
        ${p.model ? `<div class="model">${esc(p.model)}</div>` : `<div class="model">${p.sittingOut ? '已离开' : '真人玩家'}</div>`}
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
      .map((pot) => `🏆 ${pot.winners.map((w) => esc(nameOf(s.players[w]))).join('、')} 赢得 ${fmt(pot.amount)}${pot.hand ? `（${esc(pot.hand)}）` : ''}`)
      .join('<br>');
    for (const e of s.eliminations ?? []) banner += `<br>💀 ${esc(nameOf(s.players[e.seat]))} 出局（第 ${e.place} 名）`;
  } else if (s.status === 'ready') banner = s.eliminationMode ? '淘汰赛：筹码归零即出局。点「开始」发牌' : '点「开始」发牌';
  if (Date.now() < toastUntil) banner = `⚠️ ${esc(toastText)}${banner ? `<br>${banner}` : ''}`;
  $('banner').innerHTML = banner;

  renderLan(s);
  renderStart(s);
  if (!$('statsModal').classList.contains('hidden')) renderStats(s);
  renderControls(s);
  renderChat(s);
  renderLog(s);
  renderBoard(s);
  renderOver(s);
  $('recent').innerHTML = s.recent.slice().reverse().map((r) => `<div>${esc(r)}</div>`).join('') || '<div style="color:var(--muted)">还没有</div>';
}

// "Auto next hand" switch shown in the control bar. Turning it on reuses the last delay set in the settings
// (remembered here while it was on; 5 s if there never was one), turning it off sends 0.
function autoNextToggle(s) {
  return `<label class="autonext" title="一手结束后自动发下一手"><input type="checkbox" id="autoNextChk" ${s.autoNextHandMs > 0 ? 'checked' : ''}> 自动下一手</label>`;
}
function bindAutoNext(s) {
  if (s.autoNextHandMs > 0) localStorage.setItem('holdem.autoNextMs', String(s.autoNextHandMs));
  const chk = $('autoNextChk');
  if (!chk) return;
  chk.onchange = () => post('/api/auto-next', { ms: chk.checked ? Number(localStorage.getItem('holdem.autoNextMs')) || 5000 : 0 });
}
// One ticking interval for every visible countdown (`.autoLeft`); it stops itself when none is left.
let countdown = null;
function startCountdown(at) {
  clearInterval(countdown);
  countdown = setInterval(() => {
    const els = document.querySelectorAll('.autoLeft');
    if (!els.length) return clearInterval(countdown);
    for (const el of els) el.textContent = String(secondsLeft(at));
  }, 250);
}

// The action bar is rebuilt only when the decision itself changes, so state pushes during your turn
// (chat, other seats, quick replies) do not interrupt dragging the slider or typing an amount.
let controlsKey = null;
function renderControls(s) {
  const c = $('controls');
  const me = s.you >= 0 ? s.players[s.you] : null;
  const host = s.isHost;
  const L = s.legal;
  if (!L) {
    controlsKey = null;
    const waitHost = '<span class="muted">等待房主操作…</span>';
    if (!me) {
      // Joined on the LAN but no seat yet, or just watching.
      c.innerHTML = `<div class="info">${s.lan?.joined ? `👋 ${esc(s.lan.myName ?? '')}，你已加入，房主开下一局时入座。` : '👀 你在旁观。'}${s.status === 'playing' ? ' 牌局进行中…' : ''}</div>${s.lan?.joined ? '<button class="ghost" id="leaveBtn">离开</button>' : '<button class="primary" id="joinBtn">加入牌桌</button>'}`;
      if ($('leaveBtn')) $('leaveBtn').onclick = () => post('/api/leave');
      if ($('joinBtn')) $('joinBtn').onclick = () => openJoin(true);
      return;
    }
    if (s.status === 'gameOver') {
      const g = s.gameOver;
      const canSpectate = g?.type === 'defeat' && s.players.filter(inPlay).length >= 2;
      const winner = g?.type === 'victory' || g?.type === 'champion' ? s.players[g.subject ?? g.rival] : null;
      const info = winner ? (isMe(winner) ? '👑 你赢下了整张桌子' : `🏆 ${esc(winner.name)} 夺冠，你最终第 ${me.place ?? '-'} 名`) : `💀 你已出局（第 ${me.place ?? g?.place ?? '-'} 名）`;
      c.innerHTML = `<div class="info">${info}</div><button class="ghost" id="showOverBtn">查看结算</button>${host ? `${canSpectate ? '<button class="ghost" id="spectateBtn">👀 继续观战</button>' : ''}<button class="primary" id="againBtn">🔄 再来一局</button>` : waitHost}`;
      $('showOverBtn').onclick = () => {
        overDismissed = null;
        renderOver(S);
      };
      if ($('spectateBtn')) $('spectateBtn').onclick = () => post('/api/spectate');
      if ($('againBtn')) $('againBtn').onclick = newGameAndDeal;
      return;
    }
    if (s.spectating) {
      const alive = s.players.filter(inPlay).length;
      const who = s.thinking ? s.players[s.thinking.seat] : null;
      c.innerHTML = `<div class="info">👀 观战中 · 场上还剩 <b>${alive}</b> 人${who ? ` · 等待 <b>${esc(who.name)}</b> 思考<span class="thinking-dots"></span>` : ''}${s.spectatePaused ? ' · 已暂停' : ''}</div>
        ${host ? `<button class="ghost" id="pauseBtn">${s.spectatePaused ? '▶ 继续' : '⏸ 暂停'}</button><button class="primary" id="againBtn">🔄 结束观战，开新局</button>` : ''}`;
      if ($('pauseBtn')) $('pauseBtn').onclick = () => post('/api/spectate/pause', { paused: !s.spectatePaused });
      if ($('againBtn'))
        $('againBtn').onclick = () => {
          if (confirm('结束观战并重新开始？')) newGameAndDeal();
        };
      return;
    }
    if (s.status === 'playing') {
      const who = s.thinking ? s.players[s.thinking.seat] : s.waitingFor >= 0 ? s.players[s.waitingFor] : null;
      const out = me.stack <= 0 && me.place;
      c.innerHTML = `<div class="info">${out ? '你已出局，正在观看。' : me.folded && me.inHand ? '你已弃牌，' : ''}${who ? `等待 <b>${esc(nameOf(who))}</b>${who.model ? `（${esc(who.model)}）` : ''}思考<span class="thinking-dots"></span>` : '进行中…'}</div>${host ? autoNextToggle(s) : ''}`;
    } else if (me.stack <= 0 && !s.eliminationMode) {
      c.innerHTML = `<div class="info">你的筹码输光了。</div>${host ? `<button class="gold" id="rebuyBtn">补码 ${fmt(s.startingStack)} 并继续</button>` : waitHost}`;
      if ($('rebuyBtn'))
        $('rebuyBtn').onclick = async () => {
          const r = await post('/api/rebuy');
          if (r.ok) post('/api/next');
        };
    } else {
      const left = s.autoNextAt ? secondsLeft(s.autoNextAt) : null;
      const intro = s.status === 'ready' ? `${s.players.length} 人桌，你的筹码 <b>${fmt(me.stack)}</b>。` : `这一手结束了。${left != null ? `<span class="autoLeft">${left}</span> 秒后自动发下一手` : ''}`;
      c.innerHTML = `<div class="info">${intro}</div>${host ? `${autoNextToggle(s)}<button class="primary" id="nextBtn">${s.status === 'ready' ? '开始' : '下一手 ▶'}</button>` : left != null ? '' : waitHost}`;
      if ($('nextBtn')) $('nextBtn').onclick = () => post('/api/next');
      if (left != null) startCountdown(s.autoNextAt);
    }
    bindAutoNext(s);
    return;
  }
  const step = s.smallBlind || 1;
  const key = JSON.stringify([L.turnId, L.minTo, L.maxTo, L.toCall, L.pot, L.stack, L.currentBet, L.canCall, L.canCheck, L.canRaise, L.isBet, L.deadline, step]);
  if (key === controlsKey) return;
  controlsKey = key;
  if (raiseTurn !== L.turnId) {
    raiseTurn = L.turnId;
    raiseValue = L.minTo;
  }
  raiseValue = Math.max(L.minTo, Math.min(L.maxTo, raiseValue));
  const potAfter = L.pot + L.toCall;
  const presets = [
    ['最小', L.minTo],
    ['½池', L.isBet ? potAfter / 2 : L.currentBet + potAfter / 2],
    ['¾池', L.isBet ? (potAfter * 3) / 4 : L.currentBet + (potAfter * 3) / 4],
    ['1池', L.isBet ? potAfter : L.currentBet + potAfter],
  ].map(([label, v]) => [label, Math.max(L.minTo, Math.min(L.maxTo, Math.round(v / step) * step))]);
  c.innerHTML = `
    <div class="info">底池 <b>${fmt(L.pot)}</b> · ${L.canCall ? `需跟 <b>${fmt(L.toCall)}</b>` : '可以过牌'} · 你的筹码 <b>${fmt(L.stack)}</b>${L.deadline ? ` · <span class="autoLeft">${secondsLeft(L.deadline)}</span> 秒内行动` : ''}</div>
    ${L.canCall ? '<button class="danger" data-a="fold">弃牌</button>' : ''}
    ${L.canCheck ? '<button class="primary" data-a="check">过牌</button>' : `<button class="primary" data-a="call">跟注 ${fmt(L.toCall)}${L.toCall >= L.stack ? '（全下）' : ''}</button>`}
    ${
      L.canRaise
        ? `<div class="raise-box">
        <span class="presets">${presets.map(([label, v]) => `<button data-p="${v}">${label}</button>`).join('')}</span>
        <input type="range" id="rr" min="${L.minTo}" max="${L.maxTo}" step="${step}" value="${raiseValue}">
        <input type="number" id="rn" min="${L.minTo}" max="${L.maxTo}" step="${step}" value="${raiseValue}">
        <button class="gold" data-a="raise">${L.isBet ? '下注' : '加注到'} <span id="rv">${fmt(raiseValue)}</span></button>
        <button class="danger" data-a="allin">全下 ${fmt(L.maxTo)}</button>
      </div>`
        : ''
    }`;
  if (L.deadline) startCountdown(L.deadline);
  const sync = (v) => {
    raiseValue = Math.max(L.minTo, Math.min(L.maxTo, Number(v) || L.minTo));
    if ($('rr')) $('rr').value = raiseValue;
    if ($('rn')) $('rn').value = raiseValue;
    if ($('rv')) $('rv').textContent = fmt(raiseValue);
  };
  if ($('rr')) $('rr').oninput = (e) => sync(e.target.value);
  if ($('rn')) {
    $('rn').onchange = (e) => sync(e.target.value);
    $('rn').onkeydown = (e) => e.key === 'Enter' && sync(e.target.value);
  }
  c.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => sync(b.dataset.p)));
  const buttons = [...c.querySelectorAll('[data-a]')];
  buttons.forEach(
    (b) =>
      (b.onclick = async () => {
        // One action per turn: lock the bar until the answer (it is rebuilt on the next turn anyway).
        buttons.forEach((x) => (x.disabled = true));
        const a = b.dataset.a;
        const r = await post('/api/action', a === 'allin' ? { action: 'raise', amount: L.maxTo, turnId: L.turnId } : { action: a, amount: raiseValue, turnId: L.turnId });
        if (!r.ok) buttons.forEach((x) => (x.disabled = false));
      }),
  );
}

// Chat bar: free text any time during a hand, plus AI-written quick replies on your turn.
let quickKey = null;
function renderChat(s) {
  const bar = $('chatbar');
  bar.classList.toggle('hidden', s.status !== 'playing' || s.you < 0);
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
      out.push(`<div class="street">${STREET[street] ?? ''}</div>`);
    }
    const p = s.players[e.seat];
    const who = `<b style="color:${col(p.color, '#79c0ff')}">${esc(p.name)}</b>`;
    if (e.action === 'chat') {
      out.push(`<div class="chatline${e.sideline ? ' sideline' : ''}">${who} ${e.sideline ? '<span class="side-tag">场外</span>' : '💬'} ${e.say ? `<span class="say">「${esc(e.say)}」</span>` : ''}${e.emote ? ` ${stickerHtml(p, e.emote, 'log-sticker')}` : ''}</div>`);
      continue;
    }
    out.push(
      `<div>${who} ${esc(e.text)}${e.say ? ` <span class="say">「${esc(e.say)}」</span>` : ''}${e.emote ? ` ${stickerHtml(p, e.emote, 'log-sticker')}` : ''}${e.tools ? ` <span class="tools" title="查询了：${esc(e.tools.join('、'))}">🔍${e.tools.length}</span>` : ''}${e.ms ? ` <span class="ms">${(e.ms / 1000).toFixed(1)}s</span>` : ''}${e.fallback ? ' <span class="fallback">⚙托管</span>' : ''}</div>`,
    );
  }
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = out.join('') || '<div style="color:var(--muted)">等待发牌</div>';
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- result overlays (K.O., defeat, victory, champion)
let overDismissed = null;
let overShownKey = null;
let overSig = null;

async function newGameAndDeal() {
  await post('/api/new-game');
  overDismissed = null;
  post('/api/next');
}

function hideOver() {
  const el = $('over');
  el.className = 'over hidden';
  el.innerHTML = '';
  overShownKey = null;
  overSig = null;
}

// Shows one overlay. A new `key` builds it from scratch (with the emoji rain); a changed `sig` (the line arrives,
// the countdown starts, …) only swaps the .box so the rain keeps falling.
function mountOver({ key, sig, cls, crack = '', box, symbols, bind }) {
  const el = $('over');
  if (overShownKey !== key) {
    el.innerHTML = crack + box;
    el.className = cls;
    rain(el, symbols);
  } else if (overSig !== sig) {
    const t = document.createElement('template');
    t.innerHTML = box.trim();
    el.querySelector('.box').replaceWith(t.content.firstElementChild);
  } else return;
  overShownKey = key;
  overSig = sig;
  $('overClose').onclick = () => {
    overDismissed = key;
    renderOver(S);
  };
  bind?.();
}

const smallCards = (cs) => (cs ?? []).map((c) => cardHtml(c, 'small')).join('');
// The character art for a result card: a pose if there is one, else the portrait, else the emoji.
function artHtml(p, posed) {
  const pose = posed ?? p?.portrait;
  if (!pose) return `<span class="emoji">${avatarOf(p)}</span>`;
  return `<img src="${esc(pose)}" alt="" style="object-position:${posed ? '50% 30%' : pos(p.portraitPos, '50% 0%')}">`;
}

function renderKnockout(s) {
  const k = s.knockout;
  const key = `ko-${s.gameId}-${k.handNo}-${k.seat}`;
  if (overDismissed === key) return hideOver();
  const p = s.players[k.seat];
  const alive = s.players.filter(inPlay).length;
  const winner = s.players[k.by ?? 0];
  const byYou = isMe(winner);
  const winnerName = esc(nameOf(winner) || '对手');
  const winnerColor = col(winner?.color, '#fff');
  const left = s.autoNextAt ? secondsLeft(s.autoNextAt) : null;
  const countdownHtml = left != null ? ` · <span class="autoLeft">${left}</span> 秒后自动继续` : '';
  const actions = `<div class="actions">
          <button class="ghost" id="overClose">看看牌桌</button>
          ${s.isHost ? `<button class="${k.style === 'classic' ? 'gold' : 'pink'}" id="overNext">${k.style === 'classic' ? '▶ 继续下一手' : '💗 继续下一手'}</button>` : ''}
        </div>`;
  let box;
  if (k.style === 'classic') {
    box = `
    <div class="box">
      <div class="title">K.O.</div>
      <div class="subtitle">${byYou ? `你把 <span style="color:${col(p.color, '#fff')}">${esc(p.name)}</span> 送出了牌桌` : `${esc(p.name)} 被 <span style="color:${winnerColor}">${winnerName}</span> 淘汰`}</div>
      <div class="place">${k.place}<small> / ${k.players} 名</small></div>
      <div class="rival">${faceHtml(p, 'face')}<div class="quote"><span class="who">${esc(p.name)} · ${esc(p.model ?? '')}</span>${k.line ? esc(k.line) : '<span class="thinking-dots">正在组织语言</span>'}</div></div>
      ${
        k.theirHole
          ? `<div class="showdown">
        <div class="side"><div class="cards">${smallCards(k.myHole)}</div>${winnerName} · ${esc(k.myHand ?? '')}</div>
        <div class="vs">VS</div>
        <div class="side"><div class="cards">${smallCards(k.theirHole)}</div>${esc(p.name)} · ${esc(k.theirHand ?? '')}</div>
        <div class="side"><div class="cards">${smallCards(k.board)}</div>公共牌</div>
      </div>`
          : ''
      }
      <div class="standings">${k.reward ? `<span>🎁 胜者奖励：${esc(k.reward)}</span>` : ''}<span>第 ${k.handNo} 手筹码归零 · 场上还剩 ${alive} 人${countdownHtml}</span></div>
      ${actions}
    </div>`;
  } else {
    box = `
    <div class="box flirty-box ko-box">
      <div class="card-portrait knocked" style="--c:${col(p.color, '#e0559b')}">
        <div class="art">${artHtml(p, p.losePortrait)}</div>
        <div class="stamp">K.O.</div>
        <div class="nm">${esc(p.name)}</div>
        <div class="tt">${esc(p.title ?? '')}</div>
        <div class="md">${esc(p.model ?? '')}${p.portraitCredit && (p.losePortrait || p.portrait) ? ` · ${esc(p.portraitCredit)}` : ''}</div>
      </div>
      <div class="side-text">
        <div class="title">${byYou ? `${esc(p.name)} 被你拿下了♡` : `${esc(p.name)} 出局了…`}</div>
        <div class="subtitle">${byYou ? '' : `被 <b style="color:${winnerColor}">${winnerName}</b> 淘汰 · `}第 ${k.handNo} 手筹码归零 · 第 ${k.place} / ${k.players} 名 · 场上还剩 ${alive} 人</div>
        <div class="bubble-big">${k.line ? `「${esc(k.line)}」` : '<span class="thinking-dots">她正红着脸组织语言</span>'}</div>
        ${k.reward ? `<div class="penalty"><span>🎁 胜者奖励</span>${esc(k.reward)}</div>` : ''}
        ${
          k.theirHole
            ? `<div class="showdown mini"><div class="cards">${smallCards(k.myHole)}</div><span class="vs">vs</span><div class="cards">${smallCards(k.theirHole)}</div><span class="vs">·</span><div class="cards">${smallCards(k.board)}</div></div>
               <div class="mini-stats">${winnerName} <b>${esc(k.myHand ?? '')}</b> 赢了她的 <b>${esc(k.theirHand ?? '')}</b>${countdownHtml}</div>`
            : ''
        }
        ${actions}
      </div>
    </div>`;
  }
  mountOver({
    key,
    sig: JSON.stringify([k.line, k.reward, s.autoNextAt, s.isHost]),
    cls: k.style === 'classic' ? 'over victory' : 'over flirty',
    box,
    symbols: k.style === 'classic' ? ['🪙', '👑', '✨', '🎉', '💰'] : ['💗', '💋', '🌹', '💕', '✨', '🪙'],
    bind: () => {
      if (s.autoNextAt) startCountdown(s.autoNextAt);
      if ($('overNext'))
        $('overNext').onclick = () => {
          overDismissed = key;
          renderOver(S);
          post('/api/next');
        };
    },
  });
}

function renderOver(s) {
  if (s.status === 'handOver' && s.knockout) return renderKnockout(s);
  // A personal defeat (you are out while other people play on) uses the same screen.
  const personal = s.status !== 'gameOver' && s.myOut ? s.myOut : null;
  const g = personal ?? s.gameOver;
  const key = g ? `${personal ? 'out-' : ''}${s.gameId}-${g.handNo}` : null;
  if (!g || (!personal && s.status !== 'gameOver') || overDismissed === key) return hideOver();
  const meP = s.you >= 0 ? s.players[s.you] : null;
  const defeat = g.type === 'defeat';
  // Someone else (an AI or another person) won the table.
  const champ = g.type === 'champion' || (g.type === 'victory' && g.subject !== s.you);
  const rival = g.type === 'victory' && champ ? s.players[g.subject] : s.players[g.rival];
  const rivalColor = col(rival?.color, '#fff');
  const place = meP?.place ?? g.place;
  const stats = meP ? { handsPlayed: meP.handsPlayed, handsWon: meP.handsWon, peakStack: meP.peakStack ?? g.peakStack } : g;
  const canSpectate = !personal && s.isHost && defeat && s.players.filter(inPlay).length >= 2;
  const spectateBtn = canSpectate ? '<button class="ghost" id="overSpectate">👀 继续观战（AI 血战到底）</button>' : '';
  const showdownFor = defeat && g.rivalHole && g.subject === s.you;
  const standings = s.players
    .slice()
    .sort((a, b) => (a.place ?? 0) - (b.place ?? 0) || b.stack - a.stack)
    .map((p) => `<span class="${isMe(p) ? 'me' : ''}">${p.place ? `#${p.place}` : '存活'} ${esc(nameOf(p))}</span>`)
    .join('');
  const flirty = g.style === 'flirty';
  const posed = defeat || champ ? rival?.winPortrait : rival?.losePortrait;
  const closeBtn = `<button class="ghost" id="overClose">${personal ? '继续观看牌局' : '看看牌桌'}</button>`;
  const statsBtn = '<button class="ghost" id="overStats">📊 本局统计</button>';
  const box = flirty
    ? `
    <div class="box flirty-box">
      <div class="card-portrait" style="--c:${col(rival?.color, '#e0559b')}">
        <div class="art">${artHtml(rival, posed)}</div>
        <div class="kiss">💋</div>
        <div class="nm">${esc(rival?.name ?? '')}</div>
        <div class="tt">${esc(rival?.title ?? '')}</div>
        <div class="md">${esc(rival?.model ?? '')}${rival?.portraitCredit && (posed || rival.portrait) ? ` · ${esc(rival.portraitCredit)}` : ''}</div>
      </div>
      <div class="side-text">
        <div class="title">${champ ? `${esc(rival?.name ?? '')} 夺冠！` : defeat ? '你输光了哦～' : '…这次算你赢'}</div>
        <div class="subtitle">${champ ? `把所有对手都送出了牌桌 · 共 ${g.handNo} 手${place ? ` · 你最终第 ${place} / ${g.players} 名` : ''}` : defeat ? `全部筹码都被 <b style="color:${rivalColor}">${esc(rival?.name ?? '对手')}</b> 收下了 · 第 ${place} / ${g.players} 名` : `最后一个被你淘汰的是 <b style="color:${rivalColor}">${esc(rival?.name ?? '')}</b> · 第 1 名`}</div>
        <div class="bubble-big">${g.taunt ? `「${esc(g.taunt)}」` : '<span class="thinking-dots">她/他正凑过来</span>'}</div>
        ${g.penalty ? `<div class="penalty"><span>${champ ? '🎀 给观战者的惩罚' : defeat ? '🎀 惩罚游戏' : '🎁 胜者奖励'}</span>${esc(g.penalty)}</div>` : ''}
        ${showdownFor ? `<div class="showdown mini"><div class="cards">${smallCards(g.myHole)}</div><span class="vs">vs</span><div class="cards">${smallCards(g.rivalHole)}</div><span class="vs">·</span><div class="cards">${smallCards(g.board)}</div></div>` : ''}
        ${meP ? `<div class="mini-stats">坚持 <b>${stats.handsPlayed}</b> 手 · 赢下 <b>${stats.handsWon}</b> 手 · 最高筹码 <b>${fmt(stats.peakStack ?? 0)}</b></div>` : ''}
        <div class="standings">${standings}</div>
        <div class="actions">
          ${closeBtn}
          ${statsBtn}
          ${spectateBtn}
          ${s.isHost && !personal ? `<button class="pink" id="overAgain">${defeat ? '💗 乖乖认输，再来一局' : '💗 再来一局'}</button>` : ''}
        </div>
      </div>
    </div>`
    : `
    <div class="box">
      <div class="title">${champ ? 'CHAMPION' : defeat ? 'GAME OVER' : 'VICTORY'}</div>
      <div class="subtitle">${champ ? `${esc(rival?.name ?? '')} 赢下了整张桌子` : defeat ? `你被 <span style="color:${rivalColor}">${esc(rival?.name ?? '对手')}</span> 送出了牌桌` : `你把 ${s.players.length - 1} 个对手全部送出了牌桌`}</div>
      <div class="place">${place ?? '-'}<small> / ${g.players} 名</small></div>
      <div class="rival">${rival ? faceHtml(rival, 'face') : ''}<div class="quote"><span class="who">${esc(rival?.name ?? '')} · ${esc(rival?.model ?? '')}</span>${g.taunt ? esc(g.taunt) : '<span class="thinking-dots">正在组织语言</span>'}</div></div>
      ${
        showdownFor
          ? `<div class="showdown">
        <div class="side"><div class="cards">${smallCards(g.myHole)}</div>你 · ${esc(g.myHand ?? '')}</div>
        <div class="vs">VS</div>
        <div class="side"><div class="cards">${smallCards(g.rivalHole)}</div>${esc(rival?.name ?? '')} · ${esc(g.rivalHand ?? '')}</div>
        <div class="side"><div class="cards">${smallCards(g.board)}</div>公共牌</div>
      </div>`
          : ''
      }
      <div class="stats">
        <div><b>${stats.handsPlayed ?? '-'}</b><span>坚持手数</span></div>
        <div><b>${stats.handsWon ?? '-'}</b><span>赢下手数</span></div>
        <div><b>${fmt(stats.peakStack ?? 0)}</b><span>最高筹码</span></div>
      </div>
      <div class="standings">${standings}</div>
      <div class="actions">
        ${closeBtn}
        ${statsBtn}
        ${spectateBtn}
        ${s.isHost && !personal ? `<button class="${defeat ? 'danger' : 'gold'}" id="overAgain">🔄 ${defeat ? '不服，再来' : '再来一局'}</button>` : ''}
      </div>
    </div>`;
  mountOver({
    key,
    sig: JSON.stringify([g.taunt, g.penalty, s.isHost, canSpectate]),
    cls: `over ${flirty ? 'flirty' : defeat ? 'defeat' : 'victory'}`,
    crack: !flirty && defeat ? '<div class="crack"></div>' : '',
    box,
    symbols: flirty ? ['💗', '💋', '🌹', '💕', '✨', '🪙'] : defeat ? ['💸', '🪙', '💀', '🃏'] : ['🪙', '👑', '✨', '🎉', '💰'],
    bind: () => {
      if ($('overAgain')) $('overAgain').onclick = newGameAndDeal;
      $('overStats').onclick = () => {
        $('statsModal').classList.remove('hidden');
        renderStats(S);
      };
      if ($('overSpectate'))
        $('overSpectate').onclick = () => {
          overDismissed = key;
          post('/api/spectate');
        };
    },
  });
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

// ---------------------------------------------------------------- start page: the whole cast
// Shown automatically before the first hand of a game, and any time from the 🎴 阵容 button.
let startManual = false;
let startClosedFor = null;
let startKey = null;
function renderStart(s) {
  const el = $('start');
  const fresh = s.status === 'ready' && s.handNo === 0 && startClosedFor !== s.gameId;
  const show = startManual || fresh;
  if (!show) {
    el.classList.add('hidden');
    startKey = null;
    return;
  }
  const ais = s.players.filter((p) => p.kind === 'ai');
  const humans = s.players.filter((p) => p.kind === 'human');
  const key = JSON.stringify([s.gameId, s.status, s.isHost, s.lan?.joined, s.you, s.players.map((p) => [p.name, p.portrait, p.model, p.title])]);
  el.classList.remove('hidden');
  if (key === startKey) return;
  startKey = key;
  const card = (p, i) => `<div class="cast" style="--c:${col(p.color, '#58a6ff')};animation-delay:${i * 90}ms" tabindex="0">
      <div class="art">${artHtml(p)}</div>
      <div class="info">
        <div class="nm">${esc(p.name)}</div>
        <div class="tt">${esc(p.title ?? '')}</div>
        <div class="md">${esc(p.model ?? '')}</div>
        ${p.persona ? `<div class="ps">${esc(p.persona)}</div>` : ''}
      </div>
    </div>`;
  const playing = s.status !== 'ready' || s.handNo > 0;
  const blinds = `起始筹码 ${fmt(s.startingStack)} · 盲注 ${s.smallBlind}/${s.bigBlind}${s.blindsNext || s.handNo === 0 ? ' · 逐级升盲' : ''} · ${s.eliminationMode ? '淘汰赛' : '现金桌'}`;
  const mainBtn = s.isHost
    ? playing
      ? '<button class="primary" id="startBack">↩ 返回牌桌</button>'
      : '<button class="gold big" id="startGo">▶ 开始游戏</button>'
    : s.lan?.joined || s.you >= 0
      ? '<button class="primary" id="startBack">↩ 进入牌桌</button>'
      : '<button class="gold big" id="startJoin">🙋 加入牌桌</button><button class="ghost" id="startBack">先旁观</button>';
  const sc = s.scene;
  const dealer = sc ? ais.find((p) => p.key === sc.dealer && p.dealerArt) : null;
  const seated = ais.filter((p) => p !== dealer);
  if (sc && seated.every((p) => p.seatArt)) {
    el.innerHTML = `
      <div class="scene-wrap">
        <img class="scene-bg" src="${esc(sc.background)}" alt="">
        <div class="stage" id="stage">
          ${seated.map((p, i) => sceneSprite(p, i, seated.length)).join('')}
          <img class="scene-table" src="${esc(sc.table)}" alt="">
          ${dealer ? `<img class="sprite croupier" data-seat="${dealer.seat}" src="${esc(dealer.dealerArt)}" style="--c:${col(dealer.color, '#fff')}" alt="${esc(dealer.name)}">` : ''}
          <div class="scene-tip hidden" id="sceneTip"></div>
        </div>
        <div class="scene-top">
          <div class="start-title">♠♥ 德州扑克 ♦♣</div>
          <div class="start-sub">${humans.length > 1 ? `${humans.length} 位真人` : '你'} vs ${ais.length} 个 AI · ${blinds}${dealer ? ` · 今晚的荷官：${esc(dealer.name)}` : ''}</div>
        </div>
        <div class="scene-bottom">
          ${humans.length > 1 ? `<div class="start-humans">真人玩家：${humans.map((p) => esc(nameOf(p))).join('、')}</div>` : ''}
          <div class="start-actions">${mainBtn}${s.isHost ? '<button class="ghost" id="startSettings">⚙ 设置阵容</button>' : ''}</div>
          <div class="start-hint">把鼠标移到角色身上看人设</div>
        </div>
      </div>`;
    bindScene(s);
  } else {
    el.innerHTML = `
    <div class="start-inner">
      <div class="start-title">♠♥ 德州扑克 ♦♣</div>
      <div class="start-sub">${humans.length > 1 ? `${humans.length} 位真人` : '你'} vs ${ais.length} 个 AI · ${blinds}</div>
      <div class="cast-grid">${ais.map(card).join('')}</div>
      ${humans.length > 1 ? `<div class="start-humans">真人玩家：${humans.map((p) => esc(nameOf(p))).join('、')}</div>` : ''}
      <div class="start-actions">${mainBtn}${s.isHost ? '<button class="ghost" id="startSettings">⚙ 设置阵容</button>' : ''}</div>
      <div class="start-hint">把鼠标移到角色上可以看人设</div>
    </div>`;
    layoutCast();
  }
  const close = () => {
    startManual = false;
    startClosedFor = s.gameId;
    renderStart(S);
  };
  if ($('startGo'))
    $('startGo').onclick = () => {
      close();
      post('/api/next');
    };
  if ($('startBack')) $('startBack').onclick = close;
  if ($('startJoin')) $('startJoin').onclick = () => openJoin(true);
  if ($('startSettings')) $('startSettings').onclick = () => openSettings('ai');
}
// ---------------------------------------------------------------- start page: table scene
// Seats follow the far rail of the table layer (an ellipse): the outer seats sit lower and look closer.
function sceneSprite(p, i, n) {
  const u = n > 1 ? (i / (n - 1)) * 2 - 1 : 0; // -1 … 1 from left to right
  const x = 56 + u * 35; // the dealer stands on the left end
  const near = u * u;
  const h = 40 * (1 + 0.15 * near);
  const bottom = 100 - (47 + 10 * near) - 9; // sprite bottom sits a bit below the rail (hidden by the felt)
  return `<img class="sprite" data-seat="${p.seat}" src="${esc(p.seatArt)}" alt="${esc(p.name)}"
    style="--c:${col(p.color, '#fff')};left:${x}%;bottom:${bottom}%;height:${h}%;z-index:${10 + Math.round(near * 10)}">`;
}

// Hover = the character under the cursor (alpha hit test on the cut-outs), outlined, with her persona.
function bindScene(s) {
  const stage = $('stage');
  const tip = $('sceneTip');
  const sprites = [...stage.querySelectorAll('.sprite')];
  const masks = new Map();
  for (const img of sprites) {
    const load = () => {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = Math.round((128 * img.naturalHeight) / img.naturalWidth) || 192;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, c.width, c.height);
      try {
        masks.set(img, { c, data: g.getImageData(0, 0, c.width, c.height).data });
      } catch {}
    };
    if (img.complete && img.naturalWidth) load();
    else img.addEventListener('load', load, { once: true });
  }
  const hit = (img, x, y) => {
    const r = img.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    const m = masks.get(img);
    if (!m) return false;
    const px = Math.floor(((x - r.left) / r.width) * m.c.width);
    const py = Math.floor(((y - r.top) / r.height) * m.c.height);
    return m.data[(py * m.c.width + px) * 4 + 3] > 40;
  };
  let hot = null;
  stage.onmousemove = (e) => {
    const order = sprites.slice().sort((a, b) => Number(getComputedStyle(b).zIndex) - Number(getComputedStyle(a).zIndex) || (b.classList.contains('croupier') ? 1 : 0) - (a.classList.contains('croupier') ? 1 : 0));
    const found = order.find((img) => hit(img, e.clientX, e.clientY)) ?? null;
    if (found !== hot) {
      hot?.classList.remove('hot');
      hot = found;
      stage.classList.toggle('hovering', Boolean(hot));
      if (hot) {
        hot.classList.add('hot');
        const p = S.players[Number(hot.dataset.seat)];
        const isDealer = hot.classList.contains('croupier');
        tip.innerHTML = `<div class="nm" style="color:${col(p.color, '#fff')}">${esc(p.name)} <span>${esc(p.title ?? '')}${isDealer ? ' · 今晚的荷官' : ''}</span></div><div class="md">${esc(p.model ?? '')}</div>${p.persona ? `<div class="ps">${esc(p.persona)}</div>` : ''}`;
        tip.classList.remove('hidden');
      } else tip.classList.add('hidden');
    }
    if (hot) {
      const r = stage.getBoundingClientRect();
      const left = Math.max(8, Math.min(e.clientX - r.left + 18, r.width - tip.offsetWidth - 8));
      const top = Math.min(Math.max(e.clientY - r.top + 18, 8), r.height - tip.offsetHeight - 8);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }
  };
  stage.onmouseleave = () => {
    hot?.classList.remove('hot');
    hot = null;
    stage.classList.remove('hovering');
    tip.classList.add('hidden');
  };
}

// Make the cast cards as large as the window allows: try 1–3 rows and keep the biggest card size.
function layoutCast() {
  const grid = document.querySelector('#start .cast-grid');
  if (!grid) return;
  const n = grid.children.length;
  const gap = 18;
  const W = Math.min(window.innerWidth * 0.96, 2400);
  const H = window.innerHeight - 250;
  let best = { w: 0, cols: n };
  for (let rows = 1; rows <= 3; rows++) {
    const cols = Math.ceil(n / rows);
    const w = Math.min((W - gap * (cols - 1)) / cols, (H - gap * (rows - 1)) / rows / 1.62, 360);
    if (w > best.w + 1) best = { w, cols };
  }
  const w = Math.max(120, Math.floor(best.w));
  grid.style.setProperty('--cw', `${w}px`);
  grid.style.maxWidth = `${best.cols * w + (best.cols - 1) * gap}px`;
}
window.addEventListener('resize', layoutCast);

$('lineupBtn').onclick = () => {
  startManual = true;
  startKey = null;
  renderStart(S);
};

// ---------------------------------------------------------------- per-character stats
const kfmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : fmt(n ?? 0));
const PURPOSE = { decide: '打牌决策', sideline: '场外互动', lines: '结算台词', quick: '快速发言' };
function renderStats(s) {
  const rows = (s.stats ?? []).slice();
  const tot = (r) => r.tokens.input + r.tokens.output;
  rows.sort((a, b) => (a.kind === 'human') - (b.kind === 'human') || tot(b) - tot(a));
  const max = Math.max(1, ...rows.map(tot));
  const sum = rows.reduce(
    (a, r) => {
      for (const x of ['input', 'output', 'reasoning', 'cached']) a.tokens[x] += r.tokens[x];
      a.calls += r.calls;
      a.decisions += r.decisions;
      a.tools += Object.values(r.toolCalls).reduce((x, y) => x + y, 0);
      return a;
    },
    { tokens: { input: 0, output: 0, reasoning: 0, cached: 0 }, calls: 0, decisions: 0, tools: 0 },
  );
  const acts = (a) => ['fold', 'check', 'call', 'raise'].map((x) => a[x] ?? 0).join(' / ');
  const tools = (t) => (t.get_latest_round || t.get_history_rounds ? `${t.get_latest_round ?? 0} / ${t.get_history_rounds ?? 0}` : '—');
  // Your own row says 你: the host is the stats id 'human'; a LAN guest is matched by name.
  const myName = s.you >= 0 ? s.players[s.you]?.name : null;
  const row = (r) => {
    const p = s.players.find((x) => x.name === r.name);
    const human = r.kind === 'human';
    const mine = human && (s.isHost ? r.id === 'human' : r.name === myName);
    const purposes = Object.entries(r.byPurpose ?? {})
      .map(([key, v]) => `${PURPOSE[key] ?? key}：${v.calls} 次，输入 ${fmt(v.input)} / 输出 ${fmt(v.output)}`)
      .join('\n');
    return `<tr class="${human ? 'human' : ''}">
      <td class="who"><span class="dot" style="background:${col(p?.color, human ? '#388bfd' : '#8b949e')}"></span><b>${esc(mine ? '你' : r.name)}</b><small>${esc(r.model ?? (human ? '真人' : ''))}</small></td>
      <td class="num">${human ? '—' : r.decisions}</td>
      <td class="num" title="${esc(purposes)}">${human ? '—' : `${r.calls}${r.failedCalls ? ` <span class="bad">(${r.failedCalls} 失败)</span>` : ''}`}</td>
      <td class="num" title="查本手 / 查历史（共看了 ${r.historyHands} 手）">${human ? '—' : tools(r.toolCalls)}</td>
      <td class="num">${human ? '—' : kfmt(r.tokens.input)}${r.tokens.cached ? `<small>缓存 ${kfmt(r.tokens.cached)}</small>` : ''}</td>
      <td class="num">${human ? '—' : kfmt(r.tokens.output)}${r.tokens.reasoning ? `<small>思考 ${kfmt(r.tokens.reasoning)}</small>` : ''}</td>
      <td class="bar">${human ? '' : `<div style="width:${(tot(r) / max) * 100}%;background:${col(p?.color, '#58a6ff')}"></div>`}</td>
      <td class="num">${human || !r.decisions ? '—' : `${(r.thinkMs / r.decisions / 1000).toFixed(1)}s`}</td>
      <td class="num">${human ? '—' : r.fallbacks || 0}</td>
      <td class="num">${acts(r.actions)}</td>
      <td class="num">${r.says} / ${r.emotes} / ${r.sideline}</td>
    </tr>`;
  };
  $('statsSub').textContent = ` · 第 ${s.handNo} 手 · ${rows.filter((r) => r.kind === 'ai').length} 个 AI · 共 ${fmt(sum.calls)} 次模型调用、${kfmt(sum.tokens.input + sum.tokens.output)} tokens`;
  $('statsBody').innerHTML = rows.length
    ? `<table class="stats">
      <tr><th>角色</th><th>决策</th><th>模型调用</th><th>工具<br><small>本手/历史</small></th><th>输入 tokens</th><th>输出 tokens</th><th></th><th>平均思考</th><th>托管</th><th>弃/过/跟/加</th><th>发言/表情/场外</th></tr>
      ${rows.map(row).join('')}
      <tr class="total"><td><b>合计</b></td><td class="num">${sum.decisions}</td><td class="num">${sum.calls}</td><td class="num">${sum.tools}</td><td class="num">${kfmt(sum.tokens.input)}<small>缓存 ${kfmt(sum.tokens.cached)}</small></td><td class="num">${kfmt(sum.tokens.output)}${sum.tokens.reasoning ? `<small>思考 ${kfmt(sum.tokens.reasoning)}</small>` : ''}</td><td></td><td></td><td></td><td></td><td></td></tr>
    </table>
    <p class="snote">「模型调用」是和模型的往返次数（一次决策里每调用一轮工具就多一轮），鼠标移上去能看到按用途拆分：打牌决策、场外互动、结算台词、快速发言。统计从这一局开始累计，开新局清零。</p>`
    : '<p class="muted">这一局还没有数据，打几手再来看。</p>';
}
$('statsBtn').onclick = () => {
  $('statsModal').classList.remove('hidden');
  renderStats(S);
};
$('statsClose').onclick = () => $('statsModal').classList.add('hidden');

// ---------------------------------------------------------------- LAN: host panel, join dialog
let joinAsked = false;
function renderLan(s) {
  const lan = s.lan ?? {};
  for (const id of ['settingsBtn', 'newGameBtn', 'slackBtn']) $(id).classList.toggle('hidden', !s.isHost);
  const chip = $('lanChip');
  if (s.isHost) {
    chip.classList.toggle('hidden', !lan.enabled);
    chip.textContent = `📶 局域网 · ${lan.players?.length ?? 0} 人`;
  } else {
    chip.classList.remove('hidden');
    chip.textContent = lan.joined ? `🙋 ${lan.myName ?? ''}` : '🙋 加入牌桌';
    if (!lan.joined && !joinAsked && lan.enabled) {
      joinAsked = true;
      openJoin(false);
    }
  }
  if (!$('lanModal').classList.contains('hidden') && s.isHost) renderHostLan(s);
}

function renderHostLan(s) {
  const lan = s.lan ?? {};
  $('lanTitle').textContent = '📶 局域网模式';
  $('lanBody').innerHTML = `<p class="snote">同一个 Wi-Fi / 局域网里的朋友用浏览器打开下面任一地址，起个名字就能加入。新加入的人在<b>下一局</b>入座（还没开打时会立刻入座）。第一次开启时 Windows 防火墙可能会弹窗，请允许 Node.js 访问专用网络。</p>
    <div class="lanurls">${(lan.urls ?? []).map((u) => `<code>${esc(u)}</code>`).join('') || '<span class="muted">没有找到局域网地址</span>'}</div>
    <h4>玩家（${lan.players?.length ?? 0}）</h4>
    <div class="lanplayers">${(lan.players ?? []).map((p) => `<div>${p.seated ? '🪑' : '⏳'} ${esc(p.name)} <span class="muted">${p.seated ? '已入座' : '下一局入座'}</span> <button type="button" data-kick="${esc(p.id)}">踢出</button></div>`).join('') || '<span class="muted">还没有人加入</span>'}</div>
    <p class="snote">房间密码、开关局域网模式在「⚙ 设置 → 牌局」里。</p>`;
  $('lanBody').querySelectorAll('[data-kick]').forEach((b) => (b.onclick = () => post('/api/lan/kick', { id: b.dataset.kick })));
}

function openJoin(force) {
  const lan = S?.lan ?? {};
  $('lanStatus').textContent = '';
  $('lanModal').classList.remove('hidden');
  if (S?.isHost) return renderHostLan(S);
  $('lanTitle').textContent = '🙋 加入牌桌';
  if (lan.joined) {
    $('lanBody').innerHTML = `<p>你是 <b>${esc(lan.myName ?? '')}</b>。</p><div class="sbtns"><input id="joinName" placeholder="改个名字" maxlength="12"><button type="button" id="renameBtn">改名</button><button type="button" class="danger" id="leaveBtn2">离开牌桌</button></div>`;
    $('renameBtn').onclick = async () => {
      const name = $('joinName').value.trim();
      const r = await post('/api/join', { name, password: sessionStorage.getItem('holdem.roomPass') ?? undefined });
      if (r.ok) {
        localStorage.setItem('holdem.name', name);
        $('lanModal').classList.add('hidden');
      } else $('lanStatus').textContent = r.error ?? '改名失败';
    };
    $('leaveBtn2').onclick = async () => {
      await post('/api/leave');
      $('lanModal').classList.add('hidden');
    };
    return;
  }
  if (!lan.enabled && !force) return $('lanModal').classList.add('hidden');
  $('lanBody').innerHTML = `<p class="snote">起个名字加入牌桌，和桌上的 AI 以及其他朋友一起打。</p>
    <div class="sgrid">
      <label class="sf">你的名字<input id="joinName" maxlength="12" placeholder="比如：小明" value="${esc(localStorage.getItem('holdem.name') ?? '')}"></label>
      ${lan.needPassword ? '<label class="sf">房间密码<input id="joinPass" type="password"></label>' : ''}
    </div>
    <div class="sbtns" style="margin-top:12px"><button type="button" class="primary" id="joinGo">加入</button><span class="muted">也可以先关闭，只旁观。</span></div>`;
  $('joinGo').onclick = async () => {
    const name = $('joinName').value.trim();
    const password = $('joinPass')?.value;
    localStorage.setItem('holdem.name', name);
    const r = await post('/api/join', { name, password });
    if (r.ok) {
      // Kept for this tab only, so renaming later still passes a password-protected room.
      if (password) sessionStorage.setItem('holdem.roomPass', password);
      $('lanModal').classList.add('hidden');
    } else $('lanStatus').textContent = r.error ?? '加入失败';
  };
}
$('lanChip').onclick = () => openJoin(true);
$('lanClose').onclick = () => $('lanModal').classList.add('hidden');

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
  if (sp.has('stats')) setTimeout(() => $('statsBtn').click(), 300);
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
// Shortcuts: F fold, C / space check-call, R raise. Not while typing, holding modifier keys or with a dialog open,
// and space / Enter on a focused button only press that button.
document.addEventListener('keydown', (e) => {
  if (!S?.legal || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const t = e.target;
  if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName)) return;
  if (t?.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
  if (document.querySelector('.modal:not(.hidden)') || !$('over').classList.contains('hidden')) return;
  const L = S.legal;
  const key = e.key.toLowerCase();
  if (key === ' ') e.preventDefault();
  if (key === 'f' && L.canCall) post('/api/action', { action: 'fold', turnId: L.turnId });
  if (key === 'c' || key === ' ') post('/api/action', { action: L.canCheck ? 'check' : 'call', turnId: L.turnId });
  if (key === 'r' && L.canRaise) post('/api/action', { action: 'raise', amount: raiseValue, turnId: L.turnId });
});

// Every fresh state from the server (not a re-render of an old one) re-measures the clock offset.
function onState(s) {
  if (s.serverNow) clockSkew = s.serverNow - Date.now();
  render(s);
}
function connect() {
  const es = new EventSource(`/events?player=${TOKEN}`);
  es.onmessage = (e) => onState(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    $('banner').textContent = '与服务器断开，正在重连…';
    setTimeout(connect, 1500);
  };
}
// The event stream starts with the full state; ?static (no stream, for screenshots) fetches it once instead.
if (new URLSearchParams(location.search).has('static'))
  fetch(`/state?player=${TOKEN}`)
    .then((r) => r.json())
    .then(onState)
    .catch(() => {});
else connect();
