// Sends a payload to the game's Slack hook exactly like the Slack bridge does (for testing without Slack).
// usage: node tools/dev/hook.mjs '{"type":"command","text":"德扑","channel":"C0123456789","ts":"1"}'
import fs from 'node:fs';
import { loadConfig } from '../lib.mjs';

const cfg = loadConfig();
const token = fs.readFileSync(cfg.slack.bridgeTokenFile, 'utf8').trim();
const res = await fetch(`http://127.0.0.1:${cfg.port ?? 3095}/slack/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bridge-token': token },
  body: process.argv[2],
});
console.log(res.status, await res.text());
