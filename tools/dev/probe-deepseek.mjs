// Probe the DeepSeek account route (Anthropic Messages + x-dsh-auth-token): plain tool calling in two steps.
// Never prints the token, and only sends it to https://api.deepseek.com.
// usage: node tools/dev/probe-deepseek.mjs [model ...]   (default: deepseek-flash deepseek-v4-pro)
// The game itself reads the token in src/ai.js (not exported); this one-off probe keeps the same block-scoped lookup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function dshToken() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const lines = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8').split(/\r?\n/);
  const indent = (l) => l.length - l.trimStart().length;
  const start = lines.findIndex((l) => /^["']?deepseek-account-platform\/default["']?\s*:/.test(l.trim()));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indent(l) <= indent(lines[start])) break;
    const m = /^\s+token:\s*["']?([^"'\s]+)/.exec(l);
    if (m) return m[1];
  }
  return null;
}
const token = dshToken();
console.log('token found:', Boolean(token), token ? token.length : 0);
if (!token) process.exit(1);
const base = 'https://api.deepseek.com/anthropic';
const call = (body) =>
  fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-dsh-auth-token': token },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(90000),
  }).then(async (r) => {
    const raw = await r.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }
    return { status: r.status, body };
  });

const tools = [{ name: 'get_latest_round', description: 'Get the latest poker hand.', input_schema: { type: 'object', properties: {} } }];
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['deepseek-flash', 'deepseek-v4-pro'];
for (const model of models) {
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
