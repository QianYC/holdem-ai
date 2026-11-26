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

// ---------------------------------------------------------------- model routes
// Default: the OpenAI Responses endpoint in llm.baseUrl. A character with `provider` uses llm.providers[provider]:
//   { type: 'anthropic-messages', baseUrl, apiKey | apiKeyEnv | auth: 'dsh-account' }
// auth 'dsh-account' reuses the DeepSeek account you are signed in with in DeepSeek Harness (~/.dsh/.credentials.yaml).
export function routeOf(cfg, player) {
  const name = player?.provider;
  if (!name) return { name: 'default', type: 'openai-responses', baseUrl: cfg.baseUrl };
  const p = cfg.providers?.[name];
  if (!p) throw new Error(`没有配置模型提供方 ${name}`);
  return { name, type: 'openai-responses', ...p };
}

let dshTokenCache = { at: 0, token: null };
function dshAccountToken() {
  if (Date.now() - dshTokenCache.at < 60000 && dshTokenCache.token) return dshTokenCache.token;
  const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  const at = text.indexOf('deepseek-account-platform/default:');
  const m = at >= 0 ? /\n\s+token:\s*["']?([^"'\r\n]+)/.exec(text.slice(at)) : null;
  if (!m) throw new Error('没有找到 DeepSeek 账号登录（先在 DeepSeek Harness 里登录）');
  dshTokenCache = { at: Date.now(), token: m[1].trim() };
  return dshTokenCache.token;
}

function routeHeaders(cfg, route) {
  if (route.type === 'anthropic-messages') {
    if (route.auth === 'dsh-account') return { 'x-dsh-auth-token': dshAccountToken(), 'anthropic-version': '2023-06-01' };
    const key = route.apiKey ?? process.env[route.apiKeyEnv ?? 'ANTHROPIC_API_KEY'];
    if (!key) throw new Error(`提供方 ${route.name} 缺少 API Key（apiKey 或环境变量 ${route.apiKeyEnv ?? 'ANTHROPIC_API_KEY'}）`);
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${route.apiKey ?? (route.apiKeyEnv ? process.env[route.apiKeyEnv] : apiKey(cfg))}` };
}

// Model ids a provider offers (for the settings dropdown).
export async function listModels(cfg, route) {
  const url = route.type === 'anthropic-messages' ? `${new URL(route.baseUrl).origin}/models` : `${route.baseUrl.replace(/\/$/, '')}/models`;
  const res = await fetch(url, { headers: routeHeaders(cfg, route), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body.data ?? body.models ?? []).map((m) => m.id ?? m.name).filter(Boolean).sort();
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

// Tool mode: the prompt only says it is your turn and what you may do; the model fetches the table itself.
export function buildToolPrompt(player, legal, view) {
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
    `第 ${view.handNo} 手 · ${STREET_NAMES[view.street]}，轮到你行动。`,
    `你现在可选的行动：${options.join('、')}。`,
    '',
    '你可以自己决定调用工具来了解局面（可以调用多次）：',
    '- get_latest_round：这一手的完整信息——你的手牌和牌型、公共牌、底池、每个人的位置、余额、下注、行动、发言和表情。',
    '- get_history_rounds(count)：最近 count 手已结束牌局的完整记录（含结果、亮出的牌、所有人的发言和表情），用来分析对手风格、回忆谁说过什么；count 最多到本局全部手数。',
    '这次决策期间牌局不会变化，同一个工具一般调用一次就够；信息够了就直接做决定。',
    '',
    '牌桌交流是可选的：可以只说一句话、只发一个表情包、两者都发，或者什么都不发——不要每次都发言，按局面和人设自然地来（大约一半的时候保持沉默）。',
    ...(player.stickers?.length ? [`你可用的表情包：${player.stickers.map((s) => (s.label && s.label !== s.id ? `${s.id}（${s.label}）` : s.id)).join('、')}。`] : []),
    '最终回答只输出一个 JSON 对象，不要输出任何其他文字：',
    `{"action": "fold|check|call|raise|allin", "amount": <仅 raise 时需要，本轮总下注额，整数>, "say": "<可选：一句符合人设的牌桌发言，中文，20 字以内，可以虚张声势；不说话就用空字符串>"${player.stickers?.length ? ', "emote": "<可选：表情包 id；不发就 null>"' : ''}}`,
  ].join('\n');
}

export const ROUND_TOOLS = [
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

async function callResponses(cfg, player, body) {
  const route = routeOf(cfg, player);
  const res = await fetch(`${route.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...routeHeaders(cfg, route) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(player.timeoutMs ?? cfg.timeoutMs ?? 45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Function-calling loop: the model may call the round tools (handlers in `run`) before answering.
async function callMessages(cfg, route, player, body) {
  const res = await fetch(`${route.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...routeHeaders(cfg, route) },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(player.timeoutMs ?? cfg.timeoutMs ?? 45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Anthropic Messages version of the loop (tool_use / tool_result blocks; thinking blocks are passed back as-is).
async function messagesLoop(cfg, route, player, prompt, tableSize, run, maxRounds = 5) {
  const messages = [{ role: 'user', content: prompt }];
  const used = [];
  const tools = run ? ROUND_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) : null;
  for (let round = 0; round < maxRounds; round++) {
    const body = await callMessages(cfg, route, player, {
      model: player.model,
      system: systemPrompt(player, tableSize),
      messages,
      max_tokens: Math.max(2000, player.maxOutputTokens ?? cfg.maxOutputTokens ?? 4000),
      ...(tools ? { tools, tool_choice: { type: round === maxRounds - 1 ? 'none' : 'auto' } } : {}),
    });
    const content = body.content ?? [];
    const uses = content.filter((c) => c.type === 'tool_use');
    if (!uses.length || !run) {
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      const parsed = firstJsonObject(text);
      if (!parsed) throw new Error(`no JSON: ${text.slice(0, 160)}`);
      return { parsed, used };
    }
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const u of uses) {
      let result;
      try {
        result = run[u.name] ? await run[u.name](u.input ?? {}) : { error: `没有这个工具：${u.name}` };
      } catch (e) {
        result = { error: String(e?.message ?? e) };
      }
      used.push(u.name === 'get_history_rounds' ? `get_history_rounds(${u.input?.count ?? ''})` : u.name);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('too many tool rounds');
}

export async function askWithTools(cfg, player, prompt, tableSize, run, maxRounds = 5) {
  const route = routeOf(cfg, player);
  if (route.type === 'anthropic-messages') return messagesLoop(cfg, route, player, prompt, tableSize, run, maxRounds);
  const input = [{ role: 'user', content: prompt }];
  const used = [];
  const tools = ROUND_TOOLS.map((t) => ({ type: 'function', ...t }));
  for (let round = 0; round < maxRounds; round++) {
    const body = await callResponses(cfg, player, {
      model: player.model,
      instructions: systemPrompt(player, tableSize),
      input,
      tools,
      tool_choice: round === maxRounds - 1 ? 'none' : 'auto',
      max_output_tokens: player.maxOutputTokens ?? cfg.maxOutputTokens ?? 1500,
      stream: false,
      ...(player.reasoning ? { reasoning: { effort: player.reasoning } } : {}),
    });
    const out = body.output ?? [];
    const calls = out.filter((o) => o.type === 'function_call');
    if (!calls.length) {
      const text = outputText(body);
      const parsed = firstJsonObject(text);
      if (!parsed) throw new Error(`no JSON: ${text.slice(0, 160)}`);
      return { parsed, used };
    }
    input.push(...out.filter((o) => o.type !== 'reasoning' || o.encrypted_content));
    for (const c of calls) {
      let args = {};
      try {
        args = JSON.parse(c.arguments || '{}');
      } catch {}
      let result;
      try {
        result = run[c.name] ? await run[c.name](args) : { error: `没有这个工具：${c.name}` };
      } catch (e) {
        result = { error: String(e?.message ?? e) };
      }
      used.push(c.name === 'get_history_rounds' ? `get_history_rounds(${args.count ?? ''})` : c.name);
      input.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) });
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

export async function askModel(cfg, player, prompt, tableSize) {
  const route = routeOf(cfg, player);
  if (route.type === 'anthropic-messages') return (await messagesLoop(cfg, route, player, prompt, tableSize, null)).parsed;
  const body = {
    model: player.model,
    instructions: systemPrompt(player, tableSize),
    input: prompt,
    max_output_tokens: player.maxOutputTokens ?? cfg.maxOutputTokens ?? 1500,
    stream: false,
    ...(player.reasoning ? { reasoning: { effort: player.reasoning } } : {}),
  };
  const text = outputText(await callResponses(cfg, player, body));
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

// run: tool handlers ({ get_latest_round, get_history_rounds }); without them the classic all-in-the-prompt mode is used.
export async function aiDecide(cfg, player, legal, view, recent, log = () => {}, talk = [], run = null) {
  const start = Date.now();
  const prompt = buildPrompt(player, legal, view, recent, talk);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // First try: the model looks things up with tools. Retry: everything in the prompt (works without tool support).
      let d;
      let used;
      if (run && attempt === 0) ({ parsed: d, used } = await askWithTools(cfg, player, buildToolPrompt(player, legal, view), view.players.length, run));
      else d = await askModel(cfg, player, prompt, view.players.length);
      const emote = typeof d.emote === 'string' && player.stickers?.some((s) => s.id === d.emote) ? d.emote : undefined;
      return { action: d.action, amount: d.amount, say: typeof d.say === 'string' ? d.say.trim() : undefined, emote, ms: Date.now() - start, tools: used };
    } catch (e) {
      lastError = e;
      log(`[ai] ${player.name} (${player.model}) attempt ${attempt + 1} failed after ${Date.now() - start} ms: ${e?.message ?? e}`);
      if (e?.name === 'TimeoutError' || Date.now() - start > 20000) break;
    }
  }
  return { ...fallbackDecision(player, legal, view), ms: Date.now() - start, fallback: true, error: String(lastError?.message ?? lastError) };
}
