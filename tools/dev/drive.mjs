// Plays hands through the HTTP API as the human (calls/checks), printing the action log.
const base = process.argv[2] ?? 'http://127.0.0.1:3095';
const hands = Number(process.argv[3] ?? 1);
const post = (p, b = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const state = () => fetch(`${base}/state`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < hands; i++) {
  let s = await state();
  if (s.status !== 'playing') console.log('next:', JSON.stringify(await post('/api/next')));
  const t0 = Date.now();
  while (true) {
    s = await state();
    if (s.status !== 'playing') break;
    if (s.legal) {
      const a = s.legal.canCheck ? 'check' : 'call';
      console.log(`  me -> ${a}`, JSON.stringify(await post('/api/action', { action: a, turnId: s.legal.turnId })));
    }
    await sleep(300);
  }
  console.log(`hand ${s.handNo} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const e of s.log) console.log(`  [${e.street}] ${s.players[e.seat].name}: ${e.text}${e.say ? ` 「${e.say}」` : ''}${e.ms ? ` ${e.ms}ms` : ''}${e.fallback ? ' FALLBACK' : ''}`);
  console.log('  board', s.board.join(' '), '| result', JSON.stringify(s.result.pots), JSON.stringify(s.result.reveals));
  console.log('  stacks', s.players.map((p) => `${p.name}:${p.stack}`).join(' '), 'sum', s.players.reduce((a, p) => a + p.stack, 0));
}
