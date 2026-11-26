// Checks which models answer on the configured endpoint (llm.baseUrl, OpenAI Responses) and how fast.
// usage: node tools/probe-models.mjs [model ...]   (default: the models of the AI seats in the config)
// Seats that use another provider (llm.providers) are skipped: their auth helpers are internal to src/ai.js.
import { llm } from './lib.mjs';

const { cfg, url, auth } = llm();
const seats = cfg.ai ?? [];
const skipped = seats.filter((a) => a.provider);
const models = process.argv.slice(2).length ? process.argv.slice(2) : [...new Set(seats.filter((a) => !a.provider).map((a) => a.model))];
for (const a of skipped) console.log(`${a.model.padEnd(22)} skipped (provider ${a.provider})`);
const prompt =
  'You are playing No-Limit Texas Hold\'em. Your hole cards: Ah Kd. Board: Qs Jh 2c. Pot 300, to call 100, your stack 1900. Reply ONLY with JSON: {"action":"fold|check|call|raise","amount":<total bet if raise>,"say":"<short table talk>"}';
await Promise.all(
  models.map(async (m) => {
    const t = Date.now();
    try {
      const r = await fetch(url('/responses'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ model: m, input: prompt, max_output_tokens: 1500, stream: false }),
        signal: AbortSignal.timeout(60000),
      });
      const b = await r.json().catch(() => ({}));
      const out = b.output_text ?? (b.output ?? []).flatMap((i) => i.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      console.log(`${m.padEnd(22)} ${r.status} ${String(Date.now() - t).padStart(6)} ms  ${JSON.stringify(out).slice(0, 120)}`);
    } catch (e) {
      console.log(`${m.padEnd(22)} ERR ${Date.now() - t} ms ${e}`);
    }
  }),
);
