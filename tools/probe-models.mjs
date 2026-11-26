// Checks which models answer on the configured endpoint and how fast.
// usage: node tools/probe-models.mjs [model ...]   (default: the models in the config)
import { llm } from './lib.mjs';

const { cfg, url, auth } = llm();
const models = process.argv.slice(2).length ? process.argv.slice(2) : cfg.ai.map((a) => a.model);
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
