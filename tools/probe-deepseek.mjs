// Probe the DeepSeek account route (Anthropic Messages + x-dsh-auth-token). Never prints the token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function dshToken() {
  const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const i = text.indexOf('deepseek-account-platform/default:');
  const m = /\n\s+token:\s*["']?([^"'\r\n]+)/.exec(text.slice(i));
  return m?.[1];
}
const token = dshToken();
console.log('token found:', Boolean(token), token ? token.length : 0);
const base = 'https://api.deepseek.com/anthropic';
const call = (body) =>
  fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-dsh-auth-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(async () => ({ raw: await r.text() })) }));

const tools = [{ name: 'get_latest_round', description: 'Get the latest poker hand.', input_schema: { type: 'object', properties: {} } }];
for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
  const t = Date.now();
  const user = { role: 'user', content: 'You are playing poker. First call get_latest_round, then reply ONLY with JSON {"action":"call|fold|check"}.' };
  const r1 = await call({ model, max_tokens: 2000, messages: [user], tools });
  const types = (r1.body.content ?? []).map((c) => c.type);
  const use = (r1.body.content ?? []).find((c) => c.type === 'tool_use');
  if (r1.status !== 200 || !use) {
    console.log(model, 'step1', r1.status, types.join(','), JSON.stringify(r1.body).slice(0, 300));
    continue;
  }
  const r2 = await call({
    model,
    max_tokens: 2000,
    tools,
    messages: [user, { role: 'assistant', content: r1.body.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ myCards: ['As', 'Ad'], toCall: 20 }) }] }],
  });
  const text = (r2.body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  console.log(model, 'step1 types', types.join(','), 'step2', r2.status, Date.now() - t, 'ms', JSON.stringify(text).slice(0, 100), r2.status !== 200 ? JSON.stringify(r2.body).slice(0, 300) : '');
}
