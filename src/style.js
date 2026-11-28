// Playing styles (牌风): per-character strategy parameters, turned into concrete per-decision coaching.
// Each decision also gets a random number so the models play mixed strategies (bluffs and slow-plays happen
// "sometimes", not always or never), plus tilt after big losses and push/fold advice when short-stacked.
import { equity, evaluate, rankValue } from './cards.js';

// vpip: share of starting hands played · pfr: share of played hands that are raised · agg: aggression
// bluff: bluff frequency with nothing · cbet: continuation-bet frequency · slow: slow-play strong hands
// call: tendency to call light · risk: willingness to stack off · tilt: how easily she goes on tilt
export const STYLE_PRESETS = {
  tag: { label: '紧凶', desc: '只玩好牌，但一出手就主动加注；很少诈唬，纪律严明', vpip: 0.2, pfr: 0.75, agg: 0.7, bluff: 0.12, cbet: 0.65, slow: 0.1, call: 0.25, risk: 0.4, tilt: 0.1, sizing: 'standard' },
  trapper: { label: '陷阱型', desc: '拿到强牌爱慢打、过牌加注，喜欢设套让对手自己撞上来', vpip: 0.26, pfr: 0.45, agg: 0.45, bluff: 0.15, cbet: 0.45, slow: 0.55, call: 0.45, risk: 0.5, tilt: 0.2, sizing: 'mixed' },
  station: { label: '跟注站', desc: '不服输，烂牌也爱跟到底，很难被诈唬走，很少主动加注', vpip: 0.45, pfr: 0.2, agg: 0.2, bluff: 0.08, cbet: 0.3, slow: 0.2, call: 0.85, risk: 0.55, tilt: 0.5, sizing: 'small' },
  bigpot: { label: '贪婪大底池', desc: '爱抢底池、爱超额下注，强牌一定把底池做大', vpip: 0.32, pfr: 0.6, agg: 0.75, bluff: 0.25, cbet: 0.6, slow: 0.15, call: 0.5, risk: 0.7, tilt: 0.4, sizing: 'overbet' },
  balanced: { label: '平衡型', desc: '价值下注和诈唬按比例混着来，下注尺度一致，最难读', vpip: 0.24, pfr: 0.7, agg: 0.6, bluff: 0.3, cbet: 0.6, slow: 0.25, call: 0.35, risk: 0.5, tilt: 0.05, sizing: 'mixed' },
  mystic: { label: '随机神秘型', desc: '跟着「星象」做混合策略，同样的牌这次跟、下次加，让人摸不透', vpip: 0.33, pfr: 0.5, agg: 0.55, bluff: 0.35, cbet: 0.5, slow: 0.35, call: 0.45, risk: 0.5, tilt: 0.25, sizing: 'mixed' },
  maniac: { label: '疯子', desc: '极松极凶，频繁诈唬、加注和全下，用压力逼对手犯错', vpip: 0.62, pfr: 0.7, agg: 0.9, bluff: 0.55, cbet: 0.85, slow: 0.05, call: 0.55, risk: 0.9, tilt: 0.8, sizing: 'overbet' },
  nit: { label: '紧弱摸鱼', desc: '大多数时候弃牌摸鱼，只玩很强的牌；偶尔憋一个大诈唬吓人', vpip: 0.14, pfr: 0.6, agg: 0.35, bluff: 0.12, cbet: 0.4, slow: 0.2, call: 0.2, risk: 0.3, tilt: 0.15, sizing: 'standard' },
  lag: { label: '松凶推土机', desc: '出手快、玩得多、爱先手全下施压，筹码一短就推', vpip: 0.4, pfr: 0.75, agg: 0.8, bluff: 0.4, cbet: 0.75, slow: 0.05, call: 0.4, risk: 0.85, tilt: 0.6, sizing: 'overbet' },
};
export const STYLE_KEYS = ['vpip', 'pfr', 'agg', 'bluff', 'cbet', 'slow', 'call', 'risk', 'tilt'];
export const SIZINGS = { small: '小额试探（约 1/3–1/2 底池）', standard: '标准（约 2/3 底池）', overbet: '超额下注（约 1–1.5 倍底池）', mixed: '大小混着用' };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const pct = (x) => `${Math.round(x * 100)}%`;

// The character's style (preset + overrides) with tilt applied.
export function styleOf(player, tilt = 0) {
  const s = player?.style ?? {};
  const base = STYLE_PRESETS[s.preset] ?? null;
  if (!base) return null;
  const out = { preset: s.preset, label: base.label, desc: base.desc, sizing: s.sizing ?? base.sizing };
  for (const k of STYLE_KEYS) out[k] = clamp01(Number.isFinite(Number(s[k])) ? Number(s[k]) : base[k]);
  if (tilt > 0) {
    out.vpip = clamp01(out.vpip + 0.25 * tilt);
    out.agg = clamp01(out.agg + 0.25 * tilt);
    out.bluff = clamp01(out.bluff + 0.3 * tilt);
    out.call = clamp01(out.call + 0.2 * tilt);
    out.risk = clamp01(out.risk + 0.3 * tilt);
  }
  return out;
}

// ---------------------------------------------------------------- preflop hand ranking (Chen formula → percentile)
function chen(hi, lo, suited) {
  const pts = (v) => (v === 14 ? 10 : v === 13 ? 8 : v === 12 ? 7 : v === 11 ? 6 : v / 2);
  if (hi === lo) return Math.max(5, pts(hi) * 2);
  let s = pts(hi);
  if (suited) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) s += 1;
  return Math.ceil(s);
}
const PERCENTILE = (() => {
  const classes = [];
  for (let a = 14; a >= 2; a--)
    for (let b = a; b >= 2; b--) {
      if (a === b) classes.push({ key: `${a}-${b}-p`, score: chen(a, b, false), combos: 6, tie: a * 100 });
      else {
        classes.push({ key: `${a}-${b}-s`, score: chen(a, b, true), combos: 4, tie: a * 10 + b });
        classes.push({ key: `${a}-${b}-o`, score: chen(a, b, false), combos: 12, tie: a * 10 + b - 0.5 });
      }
    }
  classes.sort((x, y) => y.score - x.score || y.tie - x.tie);
  const map = new Map();
  let cum = 0;
  for (const c of classes) {
    cum += c.combos;
    map.set(c.key, cum / 1326);
  }
  return map;
})();

// "Top x" share of all starting hands (0.005 = top 0.5%, 1 = worst).
export function preflopPercentile(hole) {
  const [a, b] = hole.map(rankValue).sort((x, y) => y - x);
  const kind = a === b ? 'p' : hole[0][1] === hole[1][1] ? 's' : 'o';
  return PERCENTILE.get(`${a}-${b}-${kind}`) ?? 1;
}

// ---------------------------------------------------------------- per-decision coaching
const round = (v, step) => Math.max(step, Math.round(v / step) * step);

function sizeFor(style, legal, r) {
  const potAfter = legal.pot + legal.toCall;
  const frac = style.sizing === 'small' ? 0.4 : style.sizing === 'overbet' ? 1.25 : style.sizing === 'mixed' ? [0.4, 0.7, 1.2][Math.floor(r * 3) % 3] : 0.7;
  const to = (legal.isBet ? 0 : legal.currentBet) + potAfter * frac;
  return Math.max(legal.minTo, Math.min(legal.maxTo, Math.round(to)));
}

// Returns { text, r, advice: { action, amount? }, strength } — advice is a suggestion, the model decides.
export function coachAdvice(player, legal, view, { tilt = 0, r = Math.random(), opponents } = {}) {
  const style = styleOf(player, tilt);
  if (!style) return null;
  const me = view.players[player.seat];
  const hole = me.hole;
  const bb = view.bigBlind;
  const live = opponents ?? Math.max(1, view.players.filter((p) => p.inHand && !p.folded && p.seat !== player.seat).length);
  const potOdds = legal.toCall > 0 ? legal.toCall / (legal.pot + legal.toCall) : 0;
  const stackBB = (me.stack + me.bet) / bb;
  const lines = [];
  let advice;
  let strength;
  const raiseTo = (to) => ({ action: legal.canRaise ? 'raise' : legal.canCall ? 'call' : 'check', amount: legal.canRaise ? Math.max(legal.minTo, Math.min(legal.maxTo, Math.round(to))) : undefined });
  const passive = () => (legal.canCheck ? { action: 'check' } : { action: 'fold' });
  if (view.street === 'preflop') {
    const top = preflopPercentile(hole);
    strength = `这手起手牌排在全部起手牌的前 ${pct(top)}`;
    const playRange = style.vpip;
    const raiseRange = style.vpip * style.pfr;
    const facingRaise = legal.toCall > bb * 1.01 - (me.bet || 0) && legal.currentBet > bb;
    const shoveBB = 8 + style.risk * 10;
    if (stackBB <= shoveBB) {
      lines.push(`你只剩约 ${Math.round(stackBB)} 个大盲：按「全下或弃牌」来打。`);
      advice = top <= playRange * (0.6 + style.risk * 0.8) || r < style.bluff * 0.25 ? raiseTo(legal.maxTo) : passive();
    } else if (top <= raiseRange) {
      if (top <= 0.03 && r < style.slow) {
        lines.push(`顶级牌，随机数 ${r.toFixed(2)} < 慢打倾向 ${pct(style.slow)}：这次平跟设套，不要加注暴露。`);
        advice = legal.canCheck ? { action: 'check' } : { action: 'call' };
      } else advice = raiseTo(facingRaise ? legal.currentBet * 3 : bb * (2.5 + (style.sizing === 'overbet' ? 1 : 0)) + legal.currentBet - bb);
    } else if (top <= playRange) {
      const callable = !facingRaise || potOdds < 0.3 + style.call * 0.25 || top <= raiseRange * 1.6;
      if (r < style.agg * 0.35 && legal.canRaise) advice = raiseTo(facingRaise ? legal.currentBet * 3 : bb * 3);
      else advice = callable ? (legal.canCheck ? { action: 'check' } : { action: 'call' }) : passive();
    } else if (r < style.bluff * 0.35 && legal.canRaise && !facingRaise) {
      lines.push(`牌在你的入池范围外，但随机数 ${r.toFixed(2)} 很小：这次偷一把盲注。`);
      advice = raiseTo(bb * 2.5 + legal.currentBet - bb);
    } else advice = passive();
  } else {
    const eq = equity(hole, view.board, Math.min(live, 4), 400);
    const share = eq * (Math.min(live, 4) + 1);
    const made = evaluate(hole.concat(view.board));
    const cls = share >= 1.6 ? 'strong' : share >= 1.15 ? 'medium' : share >= 0.7 ? 'draw' : 'air';
    const CLS = { strong: '强', medium: '中等', draw: '一般 / 听牌', air: '几乎没有' };
    strength = `你现在是「${made.name}」，对 ${Math.min(live, 4)} 个对手的胜率约 ${pct(eq)}，牌力${CLS[cls]}`;
    const wasAggressor = view.log.filter((e) => e.street === 'preflop' && e.action === 'raise').at(-1)?.seat === player.seat;
    const bet = sizeFor(style, legal, r);
    if (cls === 'strong') {
      if (r < style.slow) {
        lines.push(`随机数 ${r.toFixed(2)} < 慢打倾向 ${pct(style.slow)}：这次装弱，过牌或只跟注，等对手下注再说。`);
        advice = legal.canCheck ? { action: 'check' } : { action: 'call' };
      } else advice = raiseTo(legal.toCall > 0 ? Math.max(legal.currentBet * 2.5, bet) : bet);
    } else if (cls === 'medium') {
      if (legal.toCall > 0) advice = eq + style.call * 0.15 >= potOdds ? (r < style.agg * 0.25 ? raiseTo(legal.currentBet * 2.5) : { action: 'call' }) : passive();
      else advice = r < style.agg * 0.7 || (wasAggressor && r < style.cbet) ? raiseTo(bet) : { action: 'check' };
    } else if (cls === 'draw') {
      if (legal.toCall > 0) {
        if (r < style.bluff * 0.5 && style.agg > 0.5) advice = raiseTo(legal.currentBet * 2.5);
        else advice = eq + style.call * 0.2 >= potOdds ? { action: 'call' } : passive();
      } else advice = r < style.bluff || (wasAggressor && r < style.cbet * 0.8) ? raiseTo(bet) : { action: 'check' };
    } else {
      if (legal.toCall > 0) {
        if (r < style.bluff * 0.25 && legal.canRaise) {
          lines.push(`几乎没牌，但随机数 ${r.toFixed(2)} 极小：这次反加诈唬。`);
          advice = raiseTo(legal.currentBet * 2.8);
        } else advice = r < style.call * 0.25 && potOdds < 0.3 ? { action: 'call' } : passive();
      } else if ((wasAggressor && view.street === 'flop' && r < style.cbet) || r < style.bluff) {
        lines.push(`几乎没牌，但随机数 ${r.toFixed(2)} < ${wasAggressor && view.street === 'flop' ? `持续下注频率 ${pct(style.cbet)}` : `诈唬频率 ${pct(style.bluff)}`}：这次下注诈唬。`);
        advice = raiseTo(bet);
      } else advice = { action: 'check' };
    }
    // Low risk appetite: don't stack off without a strong hand.
    if (advice.action === 'raise' && advice.amount >= (me.stack + me.bet) * 0.6 && cls !== 'strong' && r > style.risk) advice = legal.toCall > 0 ? { action: 'call' } : { action: 'check' };
  }
  if (advice.action === 'raise' && advice.amount >= legal.maxTo) advice = { action: 'allin', amount: legal.maxTo };
  const say = { fold: '弃牌', check: '过牌', call: `跟注 ${legal.toCall}`, raise: `${legal.isBet ? '下注' : '加注'}到 ${advice.amount}`, allin: `全下（${legal.maxTo}）` }[advice.action];
  const text = [
    `【你的牌风：${style.label}】${style.desc}。`,
    `参数：入池约前 ${pct(style.vpip)} 的起手牌（其中约 ${pct(style.pfr)} 加注入池）；激进 ${pct(style.agg)}；没牌时诈唬 ${pct(style.bluff)}；翻牌持续下注 ${pct(style.cbet)}；强牌慢打 ${pct(style.slow)}；跟注倾向 ${pct(style.call)}；冒险 ${pct(style.risk)}；下注习惯：${SIZINGS[style.sizing] ?? style.sizing}。`,
    ...(tilt > 0.15 ? [`你刚输了大底池，现在有点上头（上头程度 ${pct(tilt)}）：这段时间会比平时更松、更凶。`] : []),
    `【本次参考】（程序按你的牌风算好的，最终由你决定；同样的牌不必每次打法一样，也别让下注大小直接暴露牌力）`,
    `- 牌力：${strength}。`,
    ...(legal.toCall > 0 ? [`- 底池赔率：跟注需要约 ${pct(potOdds)} 的胜率。`] : []),
    `- 本次随机数：${r.toFixed(2)}`,
    ...lines.map((l) => `- ${l}`),
    `- 按牌风的建议：${say}`,
  ].join('\n');
  return { text, r, advice, style: style.preset, tilt };
}

// ---------------------------------------------------------------- tilt
// After a hand: a big loss (or losing a showdown with a strong hand) raises tilt by the character's tilt
// susceptibility; otherwise it cools down.
export function nextTilt(prev, { lostShare = 0, badBeat = false, susceptibility = 0 }) {
  let t = (prev ?? 0) * 0.7;
  if (lostShare >= 0.35 || badBeat) t = Math.min(1, t + susceptibility * (0.5 + Math.min(lostShare, 1) * 0.5) + (badBeat ? susceptibility * 0.3 : 0));
  return t < 0.05 ? 0 : t;
}
