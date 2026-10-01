'use strict';
// Integrační test: spustí server, zahraje hru dvou hráčů a ověří bezpečnostní vlastnosti.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const assert = require('assert');

const PORT = 3999;
const URL = `ws://localhost:${PORT}/ws`;
const ORIGIN = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { headers: origin ? { Origin: origin } : {} });
    const c = { ws, state: null, me: null, errors: [], events: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'state') { c.state = m.state; c.events.push(m.event); }
      if (m.type === 'joined') c.me = m;
      if (m.type === 'error') c.errors.push(m);
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
    c.send = (o) => ws.send(JSON.stringify(o));
  });
}

(async () => {
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, PEXESO_FAST: '1' }, stdio: 'inherit' });
  await sleep(700);
  let ok = 0;
  const pass = (n) => { ok++; console.log('  ✓', n); };
  try {
    // 1) Origin check
    await assert.rejects(client('http://evil.example'), /403|Unexpected/);
    await assert.rejects(client(null), /403|Unexpected/);
    pass('cizí/chybějící Origin je odmítnut');

    // 2) Lobby + sanitizace
    const a = await client(), b = await client();
    a.send({ type: 'create', nick: '<img src=x onerror=alert(1)>Eva', avatar: 2, roomName: '<script>x</script>Hra' });
    await sleep(150);
    assert(a.me && /^[A-HJ-NP-Z2-9]{6}$/.test(a.me.code));
    assert(!/[<>]/.test(a.state.players[0].nick) && !/[<>]/.test(a.state.name));
    assert(/^[0-9a-f]{64}$/.test(a.me.token));
    pass(`lobby ${a.me.code}, nick/název sanitizovány: "${a.state.players[0].nick}" / "${a.state.name}"`);

    b.send({ type: 'join', nick: 'Petr', avatar: 1, code: a.me.code.toLowerCase() });
    await sleep(150);
    assert.strictEqual(b.state.players.length, 2);
    pass('druhý hráč se připojil');

    // 3) Jen host mění nastavení / startuje
    b.send({ type: 'settings', difficulty: 'hard' }); b.send({ type: 'start' });
    await sleep(150);
    assert.strictEqual(a.state.settings.difficulty, 'easy');
    assert.strictEqual(a.state.phase, 'lobby');
    pass('non-host nemůže měnit nastavení ani startovat');

    a.send({ type: 'settings', difficulty: 'medium', theme: 'animals' });
    a.send({ type: 'settings', difficulty: 'evil' });
    await sleep(150);
    assert.strictEqual(a.state.settings.difficulty, 'medium');
    a.send({ type: 'settings', difficulty: 'easy' });
    a.send({ type: 'start' });
    await sleep(250);
    assert.strictEqual(a.state.phase, 'playing');
    const g = a.state.game;
    assert.strictEqual(g.cards.length, 24);

    // 4) Skryté karty nesmí unikat
    assert(g.cards.every((c) => c.s === null && c.st === 'down'));
    assert(!JSON.stringify(g).includes('sym'));
    pass('na začátku hry klient nedostane hodnoty žádné karty');

    // 5) Hra: pořadí a validace
    const byId = { [a.me.playerId]: a, [b.me.playerId]: b };
    const cur = byId[g.turn], other = cur === a ? b : a;
    other.send({ type: 'flip', index: 0 });
    cur.send({ type: 'flip', index: 999 });
    cur.send({ type: 'flip', index: -1 });
    cur.send({ type: 'flip', index: '3' });
    await sleep(200);
    assert(cur.state.game.cards.every((c) => c.st === 'down'));
    pass('flip mimo pořadí / s neplatným indexem je ignorován');

    cur.send({ type: 'flip', index: 0 });
    await sleep(250);
    const up = cur.state.game.cards.filter((c) => c.s !== null);
    assert.strictEqual(up.length, 1);
    pass('po otočení je odhalena právě jedna karta');

    // 6) Rate limit / cooldown: spam nemůže otočit 3 karty
    cur.send({ type: 'flip', index: 1 }); cur.send({ type: 'flip', index: 2 }); cur.send({ type: 'flip', index: 3 });
    await sleep(300);
    assert(cur.state.game.cards.filter((c) => c.st === 'up').length <= 2);
    pass('spam flipů nepřekročí 2 odkryté karty');

    // 7) Dohrát celou hru; hráči si pamatují odhalené karty
    const known = new Map();
    const waitIdle = async () => {
      for (let k = 0; k < 100; k++) {
        const s = a.state;
        if (s.phase !== 'playing') return;
        if (!s.game.locked && s.game.cards.every((c) => c.st !== 'up')) return;
        await sleep(30);
      }
    };
    let guard = 0;
    while (a.state.phase === 'playing' && guard++ < 600) {
      await waitIdle();
      if (a.state.phase !== 'playing') break;
      const gs = a.state.game;
      gs.cards.forEach((c, i) => { if (c.s !== null) known.set(i, c.s); });
      const turnC = byId[gs.turn];
      const down = gs.cards.map((c, i) => i).filter((i) => gs.cards[i].st === 'down');
      const bySym = {};
      for (const i of down) if (known.has(i)) (bySym[known.get(i)] ||= []).push(i);
      const pair = Object.values(bySym).find((x) => x.length === 2);
      const first = pair ? pair[0] : down[0];
      turnC.send({ type: 'flip', index: first });
      await sleep(40);
      const s1 = turnC.state.game.cards[first].s;
      known.set(first, s1);
      let second = pair ? pair[1] : down.find((i) => i !== first && known.get(i) === s1);
      if (second === undefined) second = down.find((i) => i !== first && !known.has(i)) ?? down.find((i) => i !== first);
      turnC.send({ type: 'flip', index: second });
      await sleep(40);
      const s2 = turnC.state.game.cards[second].s;
      if (s2 !== null) known.set(second, s2);
    }
    assert.strictEqual(a.state.phase, 'finished', 'hra měla skončit');
    const total = a.state.players.reduce((s, p) => s + p.score, 0);
    assert.strictEqual(total, 12);
    assert.strictEqual(a.state.ranking.length, 2);
    pass(`hra dohrána, skóre dohromady = 12, pořadí: ${a.state.ranking.map((id) => a.state.players.find((p) => p.id === id).nick + '=' + a.state.players.find((p) => p.id === id).score).join(', ')}`);

    // 8) Rematch ve stejném lobby
    b.send({ type: 'start' });
    await sleep(150);
    assert.strictEqual(a.state.phase, 'finished');
    a.send({ type: 'start' });
    await sleep(300);
    assert.strictEqual(a.state.phase, 'playing');
    assert(a.state.players.every((p) => p.score === 0));
    assert(a.state.game.cards.every((c) => c.s === null));
    pass('rematch ve stejném lobby (jen host), skóre vynulováno, karty opět skryté');

    // 9) Reconnect přes token
    const tok = b.me.token;
    b.ws.close();
    await sleep(300);
    const b2 = await client();
    b2.send({ type: 'resume', token: tok });
    await sleep(250);
    assert.strictEqual(b2.me.playerId, b.me.playerId);
    b2.send({ type: 'resume', token: 'x'.repeat(64) });
    pass('resume přes token funguje');

    // 10) Limit 4 hráčů a neexistující kód
    const l = await client(); l.send({ type: 'create', nick: 'H', avatar: 0 }); await sleep(150);
    const xs = [];
    for (let i = 0; i < 4; i++) { const x = await client(); x.send({ type: 'join', nick: 'P' + i, avatar: i, code: l.me.code }); xs.push(x); await sleep(100); }
    assert.strictEqual(l.state.players.length, 4);
    assert.strictEqual(xs[3].errors[0].code, 'full');
    const z = await client(); z.send({ type: 'join', nick: 'Z', avatar: 0, code: 'AAAAAA' }); await sleep(100);
    assert.strictEqual(z.errors[0].code, 'no_room');
    pass('max 4 hráči, neexistující kód odmítnut');

    // 11) HTTP hlavičky
    const res = await fetch(ORIGIN + '/');
    const csp = res.headers.get('content-security-policy');
    assert(csp.includes("script-src 'self'") && !csp.includes('unsafe-inline'));
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual((await fetch(ORIGIN + '/server.js')).status, 404);
    assert.strictEqual((await fetch(ORIGIN + '/../server.js')).status, 404);
    pass('CSP bez unsafe-inline, server.js není dostupný přes HTTP');

    console.log(`\nVše v pořádku (${ok} bloků testů).`);
  } catch (e) {
    console.error('\nTEST SELHAL:', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
