// Plays one hand as the human through simulated Slack thread replies, then prints the thread.
// usage: node tools/dev/slack-drive.mjs [text|button]   (needs a running game with a Slack thread open)
import fs from 'node:fs';
import { loadConfig } from '../lib.mjs';

const cfg = loadConfig();
const token = fs.readFileSync(cfg.slack.bridgeTokenFile, 'utf8').trim();
const base = `http://127.0.0.1:${cfg.port ?? 3095}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => fetch(`${base}/state`).then((r) => r.json());
const hook = (payload) =>
  fetch(`${base}/slack/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token }, body: JSON.stringify(payload) }).then((r) => r.status);
const bridge = (method, params) =>
  fetch(`${cfg.slack.bridgeUrl}/api`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token }, body: JSON.stringify({ method, params }) }).then((r) => r.json());

let s = await state();
const { channel, ts } = s.slack;
const say = (text) => hook({ type: 'message', text, channel, ts: String(Date.now() / 1000), thread_ts: ts, user: cfg.slack.mention });
const mode = process.argv[2] ?? 'text';
if (s.status !== 'playing') await say('下一手');
let n = 0;
while (true) {
  await sleep(500);
  s = await state();
  if (s.status !== 'playing') break;
  if (s.legal) {
    n++;
    if (mode === 'button') {
      const a = s.legal.canCheck ? 'check' : 'call';
      console.log('button', a, await hook({ type: 'action', action_id: `hook:poker:act:${a}:0`, value: JSON.stringify({ t: s.legal.turnId, a, n: 0 }), channel, message_ts: 'x', thread_ts: ts }));
    } else {
      const text = n === 1 && s.legal.canRaise ? `加注 ${s.legal.minTo}` : s.legal.canCheck ? '过' : '跟';
      console.log('say', text, await say(text));
    }
    await sleep(1500);
  }
}
await say('筹码榜');
await sleep(4000);
const r = await bridge('conversations.replies', { channel, ts, limit: 50 });
for (const m of r.messages ?? []) console.log(`--- ${m.ts}\n${m.text}${m.blocks?.some((b) => b.type === 'actions') ? '\n[buttons: ' + m.blocks.find((b) => b.type === 'actions').elements.map((e) => e.text.text).join(' | ') + ']' : ''}`);
