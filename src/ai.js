import fs from 'node:fs';
import path from 'node:path';
import { cardLabel, equity, evaluate } from './cards.js';
import { STREET_NAMES } from './engine.js';

const COPILOT_API_CONFIG = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'share', 'copilot-api', 'config.json');

export function apiKey(cfg) {
  if (cfg.apiKey) return cfg.apiKey;
  if (process.env.LOCAL_API_KEY) return process.env.LOCAL_API_KEY;
  try {
    const key = JSON.parse(fs.readFileSync(COPILOT_API_CONFIG, 'utf8'))?.auth?.apiKeyConfigs?.[0]?.key;
    if (typeof key === 'string' && key) return key;
  } catch {}
  return 'local';
}

export function firstJsonObject(text) {
  const s = String(text ?? '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

export function positionLabels(view) {
  const n = view.players.length;
  const seats = [];
  for (let k = 0; k < n; k++) {
    const p = view.players[(view.sbSeat + k) % n];
    if (p.inHand) seats.push(p.seat);
  }
  const labels = {};
  if (seats.length === 2) {
    labels[view.button] = 'BTN/SB';
    labels[view.bbSeat] = 'BB';
    return labels;
  }
  seats.forEach((seat, i) => {
    const fromEnd = seats.length - 1 - i;
    const early = i - 2;
    if (i === 0) labels[seat] = 'SB';
    else if (i === 1) labels[seat] = 'BB';
    else if (fromEnd === 0) labels[seat] = 'BTN';
    else if (fromEnd === 1 && early > 0) labels[seat] = 'CO';
    else if (fromEnd === 2 && early > 0) labels[seat] = 'HJ';
    else labels[seat] = early === 0 ? 'UTG' : `UTG+${early}`;
  });
  return labels;
}

const ACTION_CN = { sb: '小盲', bb: '大盲', fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注到' };

export const STICKER_NAMES = { smug: '得意', shock: '震惊', cry: '哭哭', think: '思考', angry: '生气', love: '比心' };
export const STICKER_EMOJI = { smug: '😏', shock: '😱', cry: '😭', think: '🤔', angry: '😤', love: '🥰' };

export function describeAction(e) {
  if (e.action === 'chat') return '说';
  const verb = ACTION_CN[e.action] ?? e.action;
  const amt = ['fold', 'check'].includes(e.action) ? '' : ` ${e.amount}`;
  return `${verb}${amt}${e.allIn ? '（全下）' : ''}`;
}

// The host's default display name is 「你」, which would confuse the models (and other people): call them by role.
export const shownName = (name, isHuman) => (isHuman && (!name || name === '你') ? '房主' : name);

// One remembered line of table talk from an earlier hand.
export function talkLine(t) {
  const who = shownName(t.name, t.seat === 0 && t.human);
  const what = t.kind === 'ko' ? '出局时说' : t.act ? `${t.act}时说` : '说';
  return `- 第${t.hand}手 ${who}${t.say ? ` ${what}：「${t.say}」` : ''}${t.emote ? ` [发了表情：${STICKER_NAMES[t.emote] ?? t.emote}]` : ''}`;
}

// Table talk lines as the models read them.
function historyLines(log, board, cards) {
  let street = '';
  const history = [];
  for (const e of log) {
    if (e.street !== street) {
      street = e.street;
      const boardNow = street === 'flop' ? board.slice(0, 3) : street === 'turn' ? board.slice(0, 4) : board;
      history.push(`【${STREET_NAMES[street]}】${street === 'preflop' ? '' : ` 公共牌 ${cards(boardNow)}`}`);
    }
    if (e.action === 'chat') history.push(`  ${shownName(e.name, e.seat === 0)} 说：「${e.say}」`);
    else history.push(`  ${shownName(e.name, e.seat === 0)}: ${describeAction(e)}${e.say ? ` —「${e.say}」` : ''}${e.emote ? ` [发了表情：${STICKER_NAMES[e.emote] ?? e.emote}]` : ''}`);
  }
  return history;
}

export const QUICK_STYLES = [
  { style: 'bluff', label: '🎭 欺骗', hint: '故意误导对手对你牌力的判断：强牌装弱，弱牌装强' },
  { style: 'truth', label: '🙂 说实话', hint: '大致透露真实牌力（不要报出具体的牌）' },
  { style: 'taunt', label: '😈 挑衅', hint: '嚣张地挑衅对手，逼他们犯错' },
  { style: 'meek', label: '🥺 认怂', hint: '示弱、求放过' },
  { style: 'flirt', label: '💕 调情', hint: '对牌桌上某个角色撩一句（点名她的人设），俏皮但不露骨' },
];

// Quick replies the human can send at their turn, one per style, written by a fast model.
export async function quickReplies(cfg, model, human, legal, view) {
  const cards = (cs) => (cs?.length ? cs.map(cardLabel).join(' ') : '（无）');
  const hole = view.players[human.seat].hole;
  const made = evaluate(hole.concat(view.board));
  const opponents = view.players.filter((p) => p.inHand && !p.folded && p.seat !== human.seat);
  const eq = equity(hole, view.board, Math.max(1, Math.min(opponents.length, 4)), 250);
  const strength = eq * (Math.min(opponents.length, 4) + 1);
  const label = strength > 1.6 ? '很强' : strength > 1.1 ? '中上' : strength > 0.7 ? '一般' : '很弱';
  const who = opponents.map((p) => `${p.name}${p.title ? `（${p.title}）` : ''}`).join('、');
  const prompt = [
    '你是德州扑克游戏里人类玩家的「牌桌发言助手」。这是用户在自己电脑上玩的娱乐游戏，筹码是虚拟的。',
    `现在轮到人类行动（${STREET_NAMES[view.street]}）。他的手牌 ${cards(hole)}，公共牌 ${cards(view.board)}，当前牌型 ${made.name}，按胜率估算牌力「${label}」。`,
    `底池 ${legal.pot}，需要跟 ${legal.toCall}，他还有 ${legal.stack} 筹码。还在局里的对手：${who || '（无）'}。`,
    '本手到目前的行动和发言：',
    ...historyLines(view.log, view.board, cards).slice(-14),
    '',
    '请为他各写一句可以直接发到牌桌上的中文短句（每句 20 字以内，口语化、有梗，不要报出具体的牌）：',
    ...QUICK_STYLES.map((s) => `- ${s.style}：${s.hint}`),
    `只输出 JSON：{${QUICK_STYLES.map((s) => `"${s.style}": "..."`).join(', ')}}`,
  ].join('\n');
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey(cfg)}` },
    body: JSON.stringify({ model, input: prompt, max_output_tokens: 1500, stream: false }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = firstJsonObject(outputText(await res.json())) ?? {};
  return QUICK_STYLES.map((s) => ({ style: s.style, label: s.label, text: typeof d[s.style] === 'string' ? d[s.style].trim().slice(0, 40) : '' })).filter((x) => x.text);
}

export function buildPrompt(player, legal, view, recent, talk = []) {
  const pos = positionLabels(view);
  const cards = (cs) => (cs?.length ? cs.map(cardLabel).join(' ') : '（无）');
  const made = evaluate(view.players[player.seat].hole.concat(view.board));
  const rows = view.players
    .filter((p) => p.inHand)
    .map((p) => {
      const status = p.folded ? '已弃牌' : p.allIn ? '已全下' : '在局';
      const me = p.seat === player.seat ? '  ← 你' : '';
      return `- 座位${p.seat} ${shownName(p.name, !p.model)}（${p.model ?? '人类玩家'}）[${pos[p.seat] ?? ''}] 剩余筹码 ${p.stack}，本轮已下 ${p.bet}，本手共投入 ${p.total}，${status}${me}`;
    })
    .join('\n');
  const history = historyLines(view.log, view.board, cards);
  const options = [];
  if (legal.canCheck) options.push('"check"（过牌）');
  if (legal.canCall) options.push(`"call"（跟注 ${legal.toCall}${legal.toCall >= legal.stack ? '，即全下' : ''}）`, '"fold"（弃牌）');
  if (legal.canRaise) {
    options.push(
      legal.minTo >= legal.maxTo
        ? `"allin"（全下到 ${legal.maxTo}）`
        : `"raise"（${legal.isBet ? '下注' : '加注'}，amount 为本轮你的总下注额，范围 ${legal.minTo} ~ ${legal.maxTo}；${legal.maxTo} 即全下）`,
    );
  }
  return [
    `第 ${view.handNo} 手，盲注 ${view.smallBlind}/${view.bigBlind}，当前阶段：${STREET_NAMES[view.street]}。`,
    `你的手牌：${cards(view.players[player.seat].hole)}`,
    `公共牌：${cards(view.board)}`,
    `你目前的牌型：${made.name}`,
    `底池：${view.pot}（含本轮下注）。本轮最高下注 ${legal.currentBet}，你需要跟 ${legal.toCall}，你的剩余筹码 ${legal.stack}。`,
    '',
    '牌桌：',
    rows,
    '',
    '本手行动记录：',
    history.join('\n') || '（无）',
    ...(recent?.length ? ['', '最近几手的结果（供你判断对手风格）：', ...recent.map((r) => `- ${r}`)] : []),
    ...(talk?.length ? ['', '本局之前各手的牌桌发言和表情（按时间顺序，可以记仇、接梗、翻旧账）：', ...talk.map(talkLine)] : []),
    '',
    `你现在可选的行动：${options.join('、')}。`,
    '牌桌交流是可选的：可以只说一句话、只发一个表情包、两者都发，或者什么都不发——不要每次都发言，按局面和人设自然地来（大约一半的时候保持沉默）。',
    ...(player.stickers?.length ? [`你可用的表情包：${player.stickers.map((s) => (s.label && s.label !== s.id ? `${s.id}（${s.label}）` : s.id)).join('、')}。`] : []),
    '只输出一个 JSON 对象，不要输出任何其他文字：',
    `{"action": "fold|check|call|raise|allin", "amount": <仅 raise 时需要，本轮总下注额，整数>, "say": "<可选：一句符合人设的牌桌发言，中文，20 字以内，可以虚张声势；不说话就用空字符串>"${player.stickers?.length ? ', "emote": "<可选：表情包 id；不发就 null>"' : ''}}`,
  ].join('\n');
}

function systemPrompt(player, tableSize) {
  return [
    `你是「${player.name}」，一个由 ${player.model} 驱动的德州扑克 AI 玩家，正坐在一张 ${tableSize} 人无限注德州扑克现金桌上，对手里有人类玩家，也有其他 AI 模型。`,
    '这是用户在自己电脑上运行的娱乐性扑克游戏，筹码是虚拟的，不涉及真钱；用户邀请各个 AI 模型同桌对战，你只需要正常打牌。',
    ...(player.persona ? [`你的角色形象（${player.title ?? player.name}）：${player.persona} 牌桌发言要符合这个人设，可以俏皮、暧昧、撩人，但不要露骨。`] : []),
    '目标是长期赢下尽可能多的筹码。请像高水平玩家一样思考：位置、底池赔率、对手范围、筹码深度，适度诈唬。',
    '回答必须是单个 JSON 对象，不要解释，不要 Markdown。',
  ].join('\n');
}

function outputText(body) {
  if (typeof body.output_text === 'string') return body.output_text;
  return (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === 'output_text' || c.type === 'text')
    .map((c) => c.text)
    .join('');
}

export async function askModel(cfg, player, prompt, tableSize) {
  const body = {
    model: player.model,
    instructions: systemPrompt(player, tableSize),
    input: prompt,
    max_output_tokens: player.maxOutputTokens ?? cfg.maxOutputTokens ?? 1500,
    stream: false,
    ...(player.reasoning ? { reasoning: { effort: player.reasoning } } : {}),
  };
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey(cfg)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(player.timeoutMs ?? cfg.timeoutMs ?? 45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = outputText(await res.json());
  const parsed = firstJsonObject(text);
  if (!parsed) throw new Error(`no JSON: ${text.slice(0, 160)}`);
  return parsed;
}

// Simple equity-driven fallback used when a model call fails or times out.
export function fallbackDecision(player, legal, view) {
  const hole = view.players[player.seat].hole;
  const opponents = Math.max(1, view.players.filter((p) => p.inHand && !p.folded && p.seat !== player.seat).length);
  const eq = equity(hole, view.board, Math.min(opponents, 4), 300);
  const strength = eq * (Math.min(opponents, 4) + 1);
  const potOdds = legal.toCall / (legal.pot + legal.toCall || 1);
  if (legal.canRaise && strength > 1.8) {
    const target = legal.currentBet + Math.round((legal.pot * 0.75) / 10) * 10;
    return { action: 'raise', amount: Math.max(legal.minTo, Math.min(legal.maxTo, target)) };
  }
  if (legal.canCheck) return { action: 'check' };
  if (eq >= potOdds + 0.03 || legal.toCall <= view.bigBlind / 2) return { action: 'call' };
  return { action: 'fold' };
}

export async function aiDecide(cfg, player, legal, view, recent, log = () => {}, talk = []) {
  const start = Date.now();
  const prompt = buildPrompt(player, legal, view, recent, talk);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await askModel(cfg, player, prompt, view.players.length);
      const emote = typeof d.emote === 'string' && player.stickers?.some((s) => s.id === d.emote) ? d.emote : undefined;
      return { action: d.action, amount: d.amount, say: typeof d.say === 'string' ? d.say.trim() : undefined, emote, ms: Date.now() - start };
    } catch (e) {
      lastError = e;
      log(`[ai] ${player.name} (${player.model}) attempt ${attempt + 1} failed after ${Date.now() - start} ms: ${e?.message ?? e}`);
      if (e?.name === 'TimeoutError' || Date.now() - start > 20000) break;
    }
  }
  return { ...fallbackDecision(player, legal, view), ms: Date.now() - start, fallback: true, error: String(lastError?.message ?? lastError) };
}
