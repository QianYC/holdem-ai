// Sends a payload to the game's Slack hook exactly like the Slack bridge does (for testing without Slack).
// usage: node tools/dev/hook.mjs '{"type":"command","text":"德扑","channel":"C0123456789","ts":"1"}'
import { bridgeToken, gameUrl, loadConfig } from '../lib.mjs';

const cfg = loadConfig();
const res = await fetch(`${gameUrl(cfg)}/slack/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bridge-token': bridgeToken(cfg) },
  body: process.argv[2],
});
console.log(res.status, await res.text());
