import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cardLabel, equity, evaluate } from './cards.js';
import { STREET_NAMES } from './engine.js';

const COPILOT_API_CONFIG = path.join(os.homedir(), '.local', 'share', 'copilot-api', 'config.json');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function isLoopbackUrl(url) {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
const trimSlash = (url) => String(url ?? '').replace(/\/+$/, '');

// Key for the default endpoint (llm.baseUrl): llm.apiKey, else LOCAL_API_KEY, else — only when the endpoint runs on
// this machine — the key of the local copilot-api proxy.
export function apiKey(cfg) {
  if (cfg.apiKey) return cfg.apiKey;
  if (process.env.LOCAL_API_KEY) return process.env.LOCAL_API_KEY;
  if (isLoopbackUrl(cfg.baseUrl)) {
    try {
      const key = JSON.parse(fs.readFileSync(COPILOT_API_CONFIG, 'utf8'))?.auth?.apiKeyConfigs?.[0]?.key;
      if (typeof key === 'string' && key) return key;
    } catch {}
  }
  return 'local';
}

// ---------------------------------------------------------------- model routes
// Default: the OpenAI Responses endpoint in llm.baseUrl. A character with `provider` uses llm.providers[provider]:
//   { type: 'openai-responses' | 'anthropic-messages', baseUrl, apiKey | apiKeyEnv | auth: 'dsh-account', modelsUrl? }
// auth 'dsh-account' (anthropic-messages only) reuses the DeepSeek account you are signed in with in DeepSeek Harness
// (~/.dsh/.credentials.yaml); that token is only ever sent to DSH_ORIGIN.
export const ROUTE_TYPES = ['openai-responses', 'anthropic-messages'];
export const DSH_ORIGIN = 'https://api.deepseek.com';

export function routeOf(cfg, player) {
  const name = player?.provider;
  if (!name) return { name: 'default', type: 'openai-responses', baseUrl: cfg.baseUrl };
  const p = cfg.providers?.[name];
  if (!p) throw new Error(`没有配置模型提供方 ${name}`);
  const route = { ...p, name, type: p.type ?? 'openai-responses' };
  if (!ROUTE_TYPES.includes(route.type)) throw new Error(`提供方 ${name} 的 type 只能是 ${ROUTE_TYPES.join(' / ')}`);
  if (!route.baseUrl) throw new Error(`提供方 ${name} 缺少 baseUrl`);
  if (route.auth === 'dsh-account') {
    if (route.type !== 'anthropic-messages') throw new Error(`提供方 ${name}：auth "dsh-account" 只能配合 anthropic-messages 使用`);
    assertDshOrigin(route.baseUrl, name);
    if (route.modelsUrl) assertDshOrigin(route.modelsUrl, name);
  }
  return route;
}

function assertDshOrigin(url, name) {
  let origin = null;
  try {
    origin = new URL(url).origin;
  } catch {}
  if (origin !== DSH_ORIGIN) throw new Error(`提供方 ${name}：DeepSeek 账号登录只能发往 ${DSH_ORIGIN}`);
}

let dshTokenCache = { at: 0, token: null };
// Reads records → deepseek-account-platform/default → payload → token, staying inside that one YAML block.
function dshAccountToken() {
  if (Date.now() - dshTokenCache.at < 60000 && dshTokenCache.token) return dshTokenCache.token;
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const lines = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8').split(/\r?\n/);
  const indent = (l) => l.length - l.trimStart().length;
  const start = lines.findIndex((l) => /^["']?deepseek-account-platform\/default["']?\s*:/.test(l.trim()));
  let token = null;
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      if (indent(l) <= indent(lines[start])) break;
      const m = /^\s+token:\s*["']?([^"'\s]+)/.exec(l);
      if (m) {
        token = m[1];
        break;
      }
    }
  }
  if (!token) throw new Error('没有找到 DeepSeek 账号登录（先在 DeepSeek Harness 里登录）');
  dshTokenCache = { at: Date.now(), token };
  return token;
}

// Auth headers for one request to `url` on `route`.
function routeHeaders(cfg, route, url) {
  if (route.type === 'anthropic-messages') {
    if (route.auth === 'dsh-account') {
      assertDshOrigin(url, route.name);
      return { 'x-dsh-auth-token': dshAccountToken(), 'anthropic-version': '2023-06-01' };
    }
    const env = route.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    const key = route.apiKey ?? process.env[env];
    if (!key) throw new Error(`提供方 ${route.name} 缺少 API Key（apiKey 或环境变量 ${env}）`);
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  // The default endpoint's key never goes to another provider.
  if (route.name === 'default') return { authorization: `Bearer ${apiKey(cfg)}` };
  const key = route.apiKey ?? (route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined);
  if (!key) throw new Error(`提供方 ${route.name} 缺少 API Key（apiKey${route.apiKeyEnv ? ` 或环境变量 ${route.apiKeyEnv}` : ' / apiKeyEnv'}）`);
  return { authorization: `Bearer ${key}` };
}

// Model ids a provider offers (for the settings dropdown). Anthropic-style providers default to the origin's /models
// (what DeepSeek serves); set `modelsUrl` for others (e.g. https://api.anthropic.com/v1/models).
export async function listModels(cfg, route) {
  const url = route.modelsUrl ?? (route.type === 'anthropic-messages' ? `${new URL(route.baseUrl).origin}/models` : `${trimSlash(route.baseUrl)}/models`);
  const res = await fetch(url, { headers: routeHeaders(cfg, route, url), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body.data ?? body.models ?? []).map((m) => m.id ?? m.name).filter(Boolean).sort();
}

// ---------------------------------------------------------------- usage reporting (for per-character stats)
// Every model call reports { player, purpose, usage: { input, output, reasoning, cached }, ms, ok }.
let usageListener = null;
export function onUsage(fn) {
  usageListener = fn;
}
function normUsage(u = {}) {
  const cacheRead = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  // Messages API: input_tokens excludes cache reads/writes.
  const input = (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    input,
    output: u.output_tokens ?? u.completion_tokens ?? 0,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
    cached: cacheRead,
  };
}
function report(player, body, ms, ok = true) {
  try {
    usageListener?.({ player, purpose: player?.purpose ?? 'decide', usage: normUsage(body?.usage), ms, ok });
  } catch {}
}

// ---------------------------------------------------------------- HTTP
// Per-call timeout. Decisions use the character's own timeoutMs first; helper calls (sideline, lines, quick replies)
// pass a shorter llm.timeoutMs, which then caps the character's setting.
function timeoutOf(cfg, player) {
  const own = Number(player?.timeoutMs) || 0;
  const shared = Number(cfg.timeoutMs) || 0;
  const helper = player?.purpose && player.purpose !== 'decide';
  const ms = helper ? Math.min(own || Infinity, shared || Infinity) : own || shared;
  return Number.isFinite(ms) && ms > 0 ? ms : 45000;
}

// One model call on `route` (Responses: POST {baseUrl}/responses, Messages: POST {baseUrl}/v1/messages), with usage
// reporting for successes and failures alike. `deadline` (optional AbortSignal) bounds the whole decision.
async function callRoute(cfg, route, player, body, deadline) {
  const url = `${trimSlash(route.baseUrl)}${route.type === 'anthropic-messages' ? '/v1/messages' : '/responses'}`;
  const headers = { 'content-type': 'application/json', ...routeHeaders(cfg, route, url) };
  const timeout = AbortSignal.timeout(timeoutOf(cfg, player));
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout });
    if (!res.ok) {
      if (route.auth === 'dsh-account' && (res.status === 401 || res.status === 403)) dshTokenCache = { at: 0, token: null };
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = await res.json();
    report(player, json, Date.now() - t0);
    return json;
  } catch (e) {
    report(player, null, Date.now() - t0, false);
    throw e;
  }
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

function parseAnswer(text) {
  const parsed = firstJsonObject(text);
  if (!parsed) throw new Error(`no JSON: ${String(text ?? '').slice(0, 160)}`);
  return parsed;
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

// ---------------------------------------------------------------- prompt pieces
const cardsText = (cs) => (cs?.length ? cs.map(cardLabel).join(' ') : '（无）');
const emoteTag = (e) => (e.emote ? ` [发了表情：${STICKER_NAMES[e.emote] ?? e.emote}]` : '');

// One remembered line of table talk from an earlier hand.
function talkLine(t) {
  const who = shownName(t.name, t.seat === 0 && t.human);
  const what = t.kind === 'ko' ? '出局时说' : t.act ? `${t.act}时说` : '说';
  return `- 第${t.hand}手 ${who}${t.say ? ` ${what}：「${t.say}」` : ''}${emoteTag(t)}`;
}

// The hand so far (actions, table talk and stickers, street by street) as the models read it.
function historyLines(log, board) {
  let street = '';
  const history = [];
  for (const e of log) {
    if (e.street !== street) {
      street = e.street;
      const boardNow = street === 'flop' ? board.slice(0, 3) : street === 'turn' ? board.slice(0, 4) : board;
      history.push(`【${STREET_NAMES[street]}】${street === 'preflop' ? '' : ` 公共牌 ${cardsText(boardNow)}`}`);
    }
    if (e.action === 'chat') history.push(`  ${shownName(e.name, e.seat === 0)}${e.sideline ? '（场外）' : ''}${e.say ? ` 说：「${e.say}」` : ''}${emoteTag(e)}`);
    else history.push(`  ${shownName(e.name, e.seat === 0)}: ${describeAction(e)}${e.say ? ` —「${e.say}」` : ''}${emoteTag(e)}`);
  }
  return history;
}

function actionOptions(legal) {
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
  return `你现在可选的行动：${options.join('、')}。`;
}

const stickerLines = (player) => (player.stickers?.length ? [`你可用的表情包：${player.stickers.map((s) => (s.label && s.label !== s.id ? `${s.id}（${s.label}）` : s.id)).join('、')}。`] : []);
const emoteField = (player) => (player.stickers?.length ? ', "emote": "<可选：表情包 id；不发就 null>"' : '');
const TALK_HINT = '牌桌交流是可选的：可以只说一句话、只发一个表情包、两者都发，或者什么都不发——不要每次都发言，按局面和人设自然地来（大约一半的时候保持沉默）。';
const decisionFormat = (player) =>
  `{"action": "fold|check|call|raise|allin", "amount": <仅 raise 时需要，本轮总下注额，整数>, "say": "<可选：一句符合人设的牌桌发言，中文，20 字以内，可以虚张声势；不说话就用空字符串>"${emoteField(player)}}`;

const QUICK_STYLES = [
  { style: 'bluff', label: '🎭 欺骗', hint: '故意误导对手对你牌力的判断：强牌装弱，弱牌装强' },
  { style: 'truth', label: '🙂 说实话', hint: '大致透露真实牌力（不要报出具体的牌）' },
  { style: 'taunt', label: '😈 挑衅', hint: '嚣张地挑衅对手，逼他们犯错' },
  { style: 'meek', label: '🥺 认怂', hint: '示弱、求放过' },
  { style: 'flirt', label: '💕 调情', hint: '对牌桌上某个角色撩一句（点名她的人设），俏皮但不露骨' },
];

// Quick replies the human can send at their turn, one per style, written by a fast model on the default endpoint.
export async function quickReplies(cfg, model, human, legal, view) {
  const hole = view.players[human.seat].hole;
  const made = evaluate(hole.concat(view.board));
  const opponents = view.players.filter((p) => p.inHand && !p.folded && p.seat !== human.seat);
  const eq = equity(hole, view.board, Math.max(1, Math.min(opponents.length, 4)), 250);
  const strength = eq * (Math.min(opponents.length, 4) + 1);
  const label = strength > 1.6 ? '很强' : strength > 1.1 ? '中上' : strength > 0.7 ? '一般' : '很弱';
  const who = opponents.map((p) => `${p.name}${p.title ? `（${p.title}）` : ''}`).join('、');
  const prompt = [
    '你是德州扑克游戏里人类玩家的「牌桌发言助手」。这是用户在自己电脑上玩的娱乐游戏，筹码是虚拟的。',
    `现在轮到人类行动（${STREET_NAMES[view.street]}）。他的手牌 ${cardsText(hole)}，公共牌 ${cardsText(view.board)}，当前牌型 ${made.name}，按胜率估算牌力「${label}」。`,
    `底池 ${legal.pot}，需要跟 ${legal.toCall}，他还有 ${legal.stack} 筹码。还在局里的对手：${who || '（无）'}。`,
    '本手到目前的行动和发言：',
    ...historyLines(view.log, view.board).slice(-14),
    '',
    '请为他各写一句可以直接发到牌桌上的中文短句（每句 20 字以内，口语化、有梗，不要报出具体的牌）：',
    ...QUICK_STYLES.map((s) => `- ${s.style}：${s.hint}`),
    `只输出 JSON：{${QUICK_STYLES.map((s) => `"${s.style}": "..."`).join(', ')}}`,
  ].join('\n');
  const helper = { id: 'quick-replies', name: '快速发言', model, purpose: 'quick' };
  const body = await callRoute({ ...cfg, timeoutMs: 20000 }, routeOf(cfg, null), helper, { model, input: prompt, max_output_tokens: 1500, stream: false });
  const d = firstJsonObject(outputText(body)) ?? {};
  return QUICK_STYLES.map((s) => ({ style: s.style, label: s.label, text: typeof d[s.style] === 'string' ? d[s.style].trim().slice(0, 40) : '' })).filter((x) => x.text);
}

// Sideline banter: a folded / all-in character reacts to what just happened at the table.
export function sidelinePrompt(player, view, why) {
  const me = view.players[player.seat];
  const status = me?.folded ? '你这一手已经弃牌了' : me?.allIn ? '你已经全下，只能等结果' : '这一手你暂时不用行动';
  return [
    `第 ${view.handNo} 手 · ${STREET_NAMES[view.street]}，公共牌 ${cardsText(view.board)}，底池 ${view.pot}。${status}。`,
    `你的手牌：${cardsText(me?.hole)}（别人看不到，别直接说出来）`,
    '',
    '本手到目前为止：',
    historyLines(view.log, view.board).join('\n') || '（无）',
    '',
    `刚刚发生的事：${why}`,
    '',
    '你在场边，可以插一句嘴：吐槽、起哄、拱火、替人加油、回应别人点你的名都行；也可以只发一个表情，或者干脆不说话（觉得没必要就别说）。',
    ...stickerLines(player),
    '只输出一个 JSON 对象，不要输出任何其他文字：',
    `{"say": "<一句符合人设的场外发言，中文，20 字以内；不说就用空字符串>"${emoteField(player)}}`,
  ].join('\n');
}

export function buildPrompt(player, legal, view, recent, talk = []) {
  const pos = positionLabels(view);
  const made = evaluate(view.players[player.seat].hole.concat(view.board));
  const rows = view.players
    .filter((p) => p.inHand)
    .map((p) => {
      const status = p.folded ? '已弃牌' : p.allIn ? '已全下' : '在局';
      const me = p.seat === player.seat ? '  ← 你' : '';
      return `- 座位${p.seat} ${shownName(p.name, !p.model)}（${p.model ?? '人类玩家'}）[${pos[p.seat] ?? ''}] 剩余筹码 ${p.stack}，本轮已下 ${p.bet}，本手共投入 ${p.total}，${status}${me}`;
    })
    .join('\n');
  return [
    `第 ${view.handNo} 手，盲注 ${view.smallBlind}/${view.bigBlind}，当前阶段：${STREET_NAMES[view.street]}。`,
    `你的手牌：${cardsText(view.players[player.seat].hole)}`,
    `公共牌：${cardsText(view.board)}`,
    `你目前的牌型：${made.name}`,
    `底池：${view.pot}（含本轮下注）。本轮最高下注 ${legal.currentBet}，你需要跟 ${legal.toCall}，你的剩余筹码 ${legal.stack}。`,
    '',
    '牌桌：',
    rows,
    '',
    '本手行动记录：',
    historyLines(view.log, view.board).join('\n') || '（无）',
    ...(recent?.length ? ['', '最近几手的结果（供你判断对手风格）：', ...recent.map((r) => `- ${r}`)] : []),
    ...(talk?.length ? ['', '本局之前各手的牌桌发言和表情（按时间顺序，可以记仇、接梗、翻旧账）：', ...talk.map(talkLine)] : []),
    '',
    actionOptions(legal),
    TALK_HINT,
    ...stickerLines(player),
    '只输出一个 JSON 对象，不要输出任何其他文字：',
    decisionFormat(player),
  ].join('\n');
}

// Tool mode: the prompt only says it is your turn and what you may do; the model fetches the table itself.
function buildToolPrompt(player, legal, view) {
  return [
    `第 ${view.handNo} 手 · ${STREET_NAMES[view.street]}，轮到你行动。`,
    actionOptions(legal),
    '',
    '你可以自己决定调用工具来了解局面（可以调用多次）：',
    '- get_latest_round：这一手的完整信息——你的手牌和牌型、公共牌、底池、每个人的位置、余额、下注、行动、发言和表情。',
    '- get_history_rounds(count)：最近 count 手已结束牌局的完整记录（含结果、亮出的牌、所有人的发言和表情），用来分析对手风格、回忆谁说过什么；count 最多到本局全部手数。',
    '这次决策期间牌局不会变化，同一个工具一般调用一次就够；信息够了就直接做决定。',
    '',
    TALK_HINT,
    ...stickerLines(player),
    '最终回答只输出一个 JSON 对象，不要输出任何其他文字：',
    decisionFormat(player),
  ].join('\n');
}

const ROUND_TOOLS = [
  {
    name: 'get_latest_round',
    description: '获取最新一手（正在进行的这一手）的牌局信息：你的手牌、下注、余额，公共牌，其他人的下注、行动、发言、表情和余额。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_history_rounds',
    description: '获取最近几手已经结束的牌局信息（从最近的往前数），每手包括你当时的手牌、下注、余额，公共牌，其他人的下注、发言、表情、余额变化，以及结果和摊牌亮出的牌。',
    parameters: {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1, description: '要看最近几手；超过本局已打手数时返回全部' } },
      required: ['count'],
      additionalProperties: false,
    },
  },
];

// Runs one tool call for the model; errors go back to the model as data.
async function runTool(run, name, args, used) {
  let result;
  try {
    result = run?.[name] ? await run[name](args) : { error: `没有这个工具：${name}` };
  } catch (e) {
    result = { error: String(e?.message ?? e) };
  }
  used.push(name === 'get_history_rounds' ? `get_history_rounds(${args?.count ?? ''})` : name);
  return JSON.stringify(result);
}

// Anthropic Messages version of the tool loop (tool_use / tool_result blocks; thinking blocks are passed back as-is).
// Without `run` it is a single plain request.
// Messages API thinking: short lines (sideline, end-screen lines) never think; decisions follow the
// character's reasoning setting: off / low (1k tokens) / medium (4k) / high or unset (the model's default).
function messagesThinking(player) {
  const effort = ['sideline', 'lines', 'quick'].includes(player.purpose) ? 'off' : player.reasoning;
  if (effort === 'off' || effort === 'none') return { thinking: { type: 'disabled' } };
  if (effort === 'low') return { thinking: { type: 'enabled', budget_tokens: 1024 } };
  if (effort === 'medium') return { thinking: { type: 'enabled', budget_tokens: 4096 } };
  return {};
}

async function messagesLoop(cfg, route, player, prompt, tableSize, run, { maxRounds = 5, deadline } = {}) {
  const messages = [{ role: 'user', content: prompt }];
  const used = [];
  const tools = run ? ROUND_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) : null;
  for (let round = 0; round < maxRounds; round++) {
    const body = await callRoute(
      cfg,
      route,
      player,
      {
        model: player.model,
        system: systemPrompt(player, tableSize),
        messages,
        max_tokens: Math.max(2000, player.maxOutputTokens ?? cfg.maxOutputTokens ?? 4000),
        ...messagesThinking(player),
        // Tools must stay defined while the history holds tool_use blocks; the last round forbids calling them.
        ...(tools ? { tools, tool_choice: { type: round === maxRounds - 1 ? 'none' : 'auto' } } : {}),
      },
      deadline,
    );
    const content = body.content ?? [];
    const uses = content.filter((c) => c.type === 'tool_use');
    if (!uses.length || !run) return { parsed: parseAnswer(content.filter((c) => c.type === 'text').map((c) => c.text).join('')), used };
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(run, u.name, u.input ?? {}, used) });
    messages.push({ role: 'user', content: results });
  }
  throw new Error('too many tool rounds');
}

// Function-calling loop: the model may call the round tools (handlers in `run`) before answering.
async function askWithTools(cfg, player, prompt, tableSize, run, { maxRounds = 5, deadline } = {}) {
  const route = routeOf(cfg, player);
  if (route.type === 'anthropic-messages') return messagesLoop(cfg, route, player, prompt, tableSize, run, { maxRounds, deadline });
  const input = [{ role: 'user', content: prompt }];
  const used = [];
  const tools = ROUND_TOOLS.map((t) => ({ type: 'function', ...t }));
  for (let round = 0; round < maxRounds; round++) {
    const body = await callRoute(
      cfg,
      route,
      player,
      {
        model: player.model,
        instructions: systemPrompt(player, tableSize),
        input,
        tools,
        tool_choice: round === maxRounds - 1 ? 'none' : 'auto',
        max_output_tokens: player.maxOutputTokens ?? cfg.maxOutputTokens ?? 1500,
        stream: false,
        ...(player.reasoning && player.reasoning !== 'off' ? { reasoning: { effort: player.reasoning } } : {}),
      },
      deadline,
    );
    const out = body.output ?? [];
    const calls = out.filter((o) => o.type === 'function_call');
    if (!calls.length) return { parsed: parseAnswer(outputText(body)), used };
    // Reasoning items can only be replayed with their encrypted content; we do not request it (the local proxy may not
    // support `include`), so they are normally dropped and the model re-reasons from the tool results.
    input.push(...out.filter((o) => o.type !== 'reasoning' || o.encrypted_content));
    for (const c of calls) {
      let args = {};
      try {
        args = JSON.parse(c.arguments || '{}');
      } catch {}
      input.push({ type: 'function_call_output', call_id: c.call_id, output: await runTool(run, c.name, args, used) });
    }
  }
  throw new Error('too many tool rounds');
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

// One plain request (no tools) that must answer with a JSON object. opts.deadline: optional AbortSignal.
export async function askModel(cfg, player, prompt, tableSize, { deadline } = {}) {
  const route = routeOf(cfg, player);
  if (route.type === 'anthropic-messages') return (await messagesLoop(cfg, route, player, prompt, tableSize, null, { deadline })).parsed;
  const body = {
    model: player.model,
    instructions: systemPrompt(player, tableSize),
    input: prompt,
    max_output_tokens: player.maxOutputTokens ?? cfg.maxOutputTokens ?? 1500,
    stream: false,
    ...(player.reasoning && player.reasoning !== 'off' ? { reasoning: { effort: player.reasoning } } : {}),
  };
  return parseAnswer(outputText(await callRoute(cfg, route, player, body, deadline)));
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

// Whole-decision budget (all tool rounds and the retry together): llm.decisionTimeoutMs / the character's
// decisionTimeoutMs, by default one call timeout plus 15 s (at least 60 s).
function decisionBudget(cfg, player) {
  const set = Number(player.decisionTimeoutMs ?? cfg.decisionTimeoutMs);
  return set > 0 ? set : Math.max(60000, timeoutOf(cfg, player) + 15000);
}

// run: tool handlers ({ get_latest_round, get_history_rounds }); without them the classic all-in-the-prompt mode is used.
export async function aiDecide(cfg, player, legal, view, recent, log = () => {}, talk = [], run = null) {
  const start = Date.now();
  const deadline = AbortSignal.timeout(decisionBudget(cfg, player));
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // First try: the model looks things up with tools. Retry: everything in the prompt (works without tool support).
      let d;
      let used;
      if (run && attempt === 0) ({ parsed: d, used } = await askWithTools(cfg, player, buildToolPrompt(player, legal, view), view.players.length, run, { deadline }));
      else d = await askModel(cfg, player, buildPrompt(player, legal, view, recent, talk), view.players.length, { deadline });
      const emote = typeof d.emote === 'string' && player.stickers?.some((s) => s.id === d.emote) ? d.emote : undefined;
      return { action: d.action, amount: d.amount, say: typeof d.say === 'string' ? d.say.trim() : undefined, emote, ms: Date.now() - start, tools: used };
    } catch (e) {
      lastError = e;
      log(`[ai] ${player.name} (${player.model}) attempt ${attempt + 1} failed after ${Date.now() - start} ms: ${e?.message ?? e}`);
      if (e?.name === 'TimeoutError' || deadline.aborted || Date.now() - start > 20000) break;
    }
  }
  return { ...fallbackDecision(player, legal, view), ms: Date.now() - start, fallback: true, error: String(lastError?.message ?? lastError) };
}
