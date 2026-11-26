// Probe: do the configured models support function calling through /responses (two-step loop)?
import { llm } from './lib.mjs';

const { cfg, url, auth } = llm();
const models = process.argv.slice(2).length ? process.argv.slice(2) : cfg.ai.map((a) => a.model);
const tools = [
  {
    type: 'function',
    name: 'get_latest_round',
    description: 'Get the latest poker hand: your cards, board, bets and stacks.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];
const ask = (input) =>
  fetch(url('/responses'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: process.env.M, input, tools, tool_choice: 'auto', max_output_tokens: 1500, stream: false }),
    signal: AbortSignal.timeout(60000),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

for (const m of models) {
  process.env.M = m;
  const t = Date.now();
  try {
    const first = [{ role: 'user', content: 'You are playing poker. First call get_latest_round, then reply ONLY with JSON {"action":"call|fold|check"}.' }];
    const r1 = await ask(first);
    const calls = (r1.body.output ?? []).filter((o) => o.type === 'function_call');
    if (!calls.length) {
      console.log(`${m.padEnd(20)} step1 ${r1.status} no function_call; output types: ${(r1.body.output ?? []).map((o) => o.type).join(',')} ${JSON.stringify(r1.body.error ?? '').slice(0, 120)}`);
      continue;
    }
    const c = calls[0];
    const r2 = await ask([
      ...first,
      ...r1.body.output.filter((o) => o.type !== 'reasoning' || o.encrypted_content),
      { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify({ hand: 3, myCards: ['As', 'Ad'], board: [], toCall: 20 }) },
    ]);
    const text = r2.body.output_text ?? (r2.body.output ?? []).flatMap((o) => o.content ?? []).map((x) => x.text ?? '').join('');
    console.log(`${m.padEnd(20)} call=${c.name}(${c.arguments}) step2 ${r2.status} ${Date.now() - t}ms -> ${JSON.stringify(text).slice(0, 80)} ${r2.status !== 200 ? JSON.stringify(r2.body).slice(0, 200) : ''}`);
  } catch (e) {
    console.log(`${m.padEnd(20)} ERR ${e}`);
  }
}
