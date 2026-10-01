'use strict';
/**
 * Klient Pexeso Online.
 *  - Nikdy nepoužívá innerHTML: veškerý uživatelský text jde přes textContent (ochrana proti XSS).
 *  - Klient neví nic o neotočených kartách; hodnotu dostane od serveru jen u otočených/nalezených.
 *  - Všechny akce jsou jen "žádosti" – o výsledku rozhoduje server.
 */
(() => {
  const THEMES = window.PEXESO_THEMES;
  const AVATARS = window.PEXESO_AVATARS;
  const COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24'];
  const DIFF_LABEL = { easy: 'Easy (12 dvojic)', medium: 'Medium (30 dvojic)', hard: 'Hard (60 dvojic)' };
  const COLS = { easy: [6, 4], medium: [10, 6], hard: [15, 8] }; // [desktop, mobil]
  const TOKEN_KEY = 'pexeso.token';
  const PROFILE_KEY = 'pexeso.profile';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ───────────── Úložiště (bez pádu, když je zakázané) ─────────────
  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
    set(area, key, val) { try { window[area].setItem(key, val); } catch { /* ignore */ } },
    del(area, key) { try { window[area].removeItem(key); } catch { /* ignore */ } },
  };

  // ───────────── Stav ─────────────
  let ws = null;
  let reconnectDelay = 500;
  let me = null;            // { id, token, code }
  let state = null;         // poslední veřejný stav od serveru
  let cardEls = [];
  let selectedAvatar = 0;
  let lastFlipAt = 0;
  const chipEls = new Map();
  const timer = { end: 0, total: 1, frozen: true, ratio: 1 };

  // ───────────── Toast ─────────────
  let toastTimer = null;
  function toast(msg, ok = false, ms = 3200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('ok', ok);
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ───────────── WebSocket ─────────────
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
    toast('Nejsi připojen k serveru. Zkus to za okamžik.');
    return false;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      reconnectDelay = 500;
      $('conn').classList.add('hidden');
      const token = store.get('sessionStorage', TOKEN_KEY);
      if (token) ws.send(JSON.stringify({ type: 'resume', token }));
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m.type === 'string') onMessage(m);
    };
    ws.onclose = () => {
      $('conn').classList.remove('hidden');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 8000);
    };
    ws.onerror = () => { /* onclose se postará o zbytek */ };
  }

  function onMessage(m) {
    switch (m.type) {
      case 'joined':
        me = { id: m.playerId, token: m.token, code: m.code };
        store.set('sessionStorage', TOKEN_KEY, m.token);
        break;
      case 'state': {
        const prev = state;
        state = m.state;
        render(prev, m.event);
        break;
      }
      case 'error':
        toast(typeof m.message === 'string' ? m.message : 'Něco se nepovedlo.');
        break;
      case 'resume_failed':
        store.del('sessionStorage', TOKEN_KEY);
        me = null; state = null; render(null, null);
        break;
      case 'left':
        store.del('sessionStorage', TOKEN_KEY);
        me = null; state = null;
        history.replaceState(null, '', location.pathname);
        render(null, null);
        break;
      default: break;
    }
  }

  // ───────────── Přepínání obrazovek ─────────────
  function showScreen(name) {
    for (const n of ['home', 'lobby', 'game']) $(`screen-${n}`).classList.toggle('hidden', n !== name);
  }

  function render(prev, ev) {
    if (!state || !me) {
      $('modal-finish').classList.add('hidden');
      showScreen('home');
      return;
    }
    if (state.phase === 'lobby') {
      $('modal-finish').classList.add('hidden');
      resetBoard();
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      renderGame(prev, ev);
      if (state.phase === 'finished') renderFinish(ev); else $('modal-finish').classList.add('hidden');
    }
    if (ev && ev.kind === 'timeout') toast('Čas na tah vypršel.', false, 1800);
  }

  const playerIndex = (id) => state.players.findIndex((p) => p.id === id);
  const playerById = (id) => state.players.find((p) => p.id === id);

  // ───────────── Úvod ─────────────
  function buildAvatars() {
    const box = $('avatars');
    AVATARS.forEach((a, i) => {
      const b = mk('button', 'avatar', a);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', `Avatar ${i + 1}`);
      b.dataset.i = String(i);
      box.appendChild(b);
    });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.avatar');
      if (!b) return;
      selectAvatar(Number(b.dataset.i));
    });
  }

  function selectAvatar(i) {
    selectedAvatar = i;
    for (const b of $('avatars').children) b.setAttribute('aria-checked', String(Number(b.dataset.i) === i));
    saveProfile();
  }

  function saveProfile() {
    store.set('localStorage', PROFILE_KEY, JSON.stringify({ nick: $('nick').value.slice(0, 16), avatar: selectedAvatar }));
  }

  function loadProfile() {
    let p = null;
    try { p = JSON.parse(store.get('localStorage', PROFILE_KEY) || 'null'); } catch { p = null; }
    if (p && typeof p.nick === 'string') $('nick').value = p.nick.slice(0, 16);
    selectAvatar(p && Number.isInteger(p.avatar) && p.avatar >= 0 && p.avatar < AVATARS.length
      ? p.avatar : Math.floor(Math.random() * AVATARS.length));
  }

  function profileOrToast() {
    const nick = $('nick').value.trim();
    if (!nick) { toast('Nejdřív si zadej přezdívku.'); $('nick').focus(); return null; }
    return { nick, avatar: selectedAvatar };
  }

  function cleanCode(v) { return v.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6); }

  // ───────────── Lobby ─────────────
  function buildThemes() {
    const box = $('themes');
    for (const [key, t] of Object.entries(THEMES)) {
      const b = mk('button', 'theme');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = key;
      b.append(mk('span', 'ti', t.icon), mk('span', null, t.label));
      box.appendChild(b);
    }
  }

  function playerRow(p, i, isHost) {
    const li = mk('li', `p${i}`);
    li.append(mk('span', 'av', AVATARS[p.avatar] || '🙂'), mk('span', 'nm', p.nick));
    if (p.id === me.id) li.appendChild(mk('span', 'badge', 'Ty'));
    if (isHost) li.appendChild(mk('span', 'badge', 'Host'));
    if (!p.connected) li.appendChild(mk('span', 'badge off', 'Offline'));
    return li;
  }

  function renderLobby() {
    $('lobby-name').textContent = state.name;
    $('lobby-code').textContent = state.code;
    $('player-count').textContent = `${state.players.length}/4`;
    const list = $('lobby-players');
    list.textContent = '';
    state.players.forEach((p, i) => list.appendChild(playerRow(p, i, p.id === state.hostId)));

    const isHost = state.hostId === me.id;
    $('host-settings').classList.toggle('hidden', !isHost);
    $('guest-wait').classList.toggle('hidden', isHost);
    for (const b of $('difficulty').children) b.setAttribute('aria-checked', String(b.dataset.value === state.settings.difficulty));
    for (const b of $('themes').children) b.setAttribute('aria-checked', String(b.dataset.value === state.settings.theme));
    $('guest-settings').textContent = `${DIFF_LABEL[state.settings.difficulty]}, ${THEMES[state.settings.theme].label}`;

    const online = state.players.filter((p) => p.connected).length;
    $('btn-start').disabled = online < 2;
    $('btn-start').textContent = online < 2 ? 'Čekáme na dalšího hráče…' : 'Spustit hru';
  }

  function shareLink() { return `${location.origin}/#${state ? state.code : ''}`; }

  async function copy(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg, true, 1800);
    } catch {
      toast('Kopírování se nepodařilo. Označ a zkopíruj ručně.');
    }
  }

  // ───────────── Hra ─────────────
  function resetBoard() {
    $('board').textContent = '';
    cardEls = [];
    chipEls.clear();
    $('hud-players').textContent = '';
    timer.frozen = true;
  }

  function applyCols(difficulty) {
    const mobile = window.innerWidth < 700;
    const [d, m] = COLS[difficulty] || COLS.easy;
    $('board').style.setProperty('--cols', String(mobile ? m : d));
  }

  function buildBoard(g) {
    const board = $('board');
    board.textContent = '';
    board.dataset.difficulty = g.difficulty;
    board.dataset.theme = g.theme;
    applyCols(g.difficulty);
    cardEls = g.cards.map((_, i) => {
      const b = mk('button', 'card');
      b.type = 'button';
      b.dataset.i = String(i);
      b.setAttribute('role', 'gridcell');
      const inner = mk('span', 'inner');
      const back = mk('span', 'face back');
      const front = mk('span', 'face front');
      const sym = mk('span');
      front.appendChild(sym);
      inner.append(back, front);
      b.appendChild(inner);
      board.appendChild(b);
      b._sym = sym;
      return b;
    });
  }

  function renderGame(prev, ev) {
    const g = state.game;
    if (!g) return;
    const board = $('board');
    if ((ev && ev.kind === 'start') || cardEls.length !== g.cards.length || board.dataset.theme !== g.theme) {
      buildBoard(g);
    }
    const symbols = THEMES[g.theme].symbols;

    g.cards.forEach((c, i) => {
      const e = cardEls[i];
      e.classList.toggle('up', c.st === 'up');
      e.classList.toggle('matched', c.st === 'matched');
      if (c.s !== null) {
        clearTimeout(e._t);
        const sym = symbols[c.s] || '❔';
        if (e._sym.textContent !== sym) e._sym.textContent = sym;
      } else if (e._sym.textContent) {
        // Hodnotu z DOMu mažeme hned po dokončení animace otočení zpět.
        clearTimeout(e._t);
        e._t = setTimeout(() => { if (!e.classList.contains('up') && !e.classList.contains('matched')) e._sym.textContent = ''; }, 650);
      }
      for (let k = 0; k < 4; k++) e.classList.remove(`p${k}`);
      if (c.o) { const oi = playerIndex(c.o); if (oi >= 0) e.classList.add(`p${oi}`); }
      e.setAttribute('aria-label', c.s !== null ? `Karta ${i + 1}: ${symbols[c.s]}` : `Karta ${i + 1}, skrytá`);
    });

    const myTurn = state.phase === 'playing' && g.turn === me.id;
    board.classList.toggle('locked', g.locked);
    board.classList.toggle('notmine', !myTurn);

    renderHud(prev, g, myTurn);

    if (ev && (ev.kind === 'match' || ev.kind === 'finish')) {
      const oi = Math.max(0, playerIndex(ev.playerId));
      for (const i of ev.indices) burstAtCard(i, COLORS[oi]);
    }
    if (ev && ev.kind === 'mismatch') {
      for (const i of ev.indices) {
        const e = cardEls[i];
        e.classList.add('shake');
        setTimeout(() => e.classList.remove('shake'), 500);
      }
    }
  }

  function renderHud(prev, g, myTurn) {
    const box = $('hud-players');
    const seen = new Set();
    state.players.forEach((p, i) => {
      seen.add(p.id);
      let chip = chipEls.get(p.id);
      if (!chip) {
        chip = mk('div', 'chip');
        chip._av = mk('span', 'av');
        chip._nm = mk('span', 'nm');
        chip._sc = mk('span', 'sc', '0');
        const info = mk('span', 'info');
        info.append(chip._nm, chip._sc);
        chip.append(chip._av, info);
        chipEls.set(p.id, chip);
      }
      chip.className = `chip p${i}`;
      chip.classList.toggle('active', state.phase === 'playing' && g.turn === p.id);
      chip.classList.toggle('off', !p.connected);
      chip._av.textContent = AVATARS[p.avatar] || '🙂';
      chip._nm.textContent = p.nick;
      const before = prev && prev.players.find((x) => x.id === p.id);
      if (chip._sc.textContent !== String(p.score)) {
        chip._sc.textContent = String(p.score);
        if (before && p.score > before.score) {
          chip._sc.classList.remove('bump');
          void chip._sc.offsetWidth; // restart animace
          chip._sc.classList.add('bump');
        }
      }
      box.appendChild(chip); // appendChild existující uzel jen přeřadí => zachová animaci
    });
    for (const [id, chip] of chipEls) if (!seen.has(id)) { chip.remove(); chipEls.delete(id); }

    const banner = $('turn-banner');
    const tp = g.turn ? playerById(g.turn) : null;
    banner.classList.toggle('mine', myTurn);
    if (state.phase === 'finished') banner.textContent = 'Hra skončila';
    else if (myTurn) banner.textContent = 'Jsi na řadě!';
    else banner.textContent = tp ? `Na tahu: ${tp.nick}` : 'Čekáme na hráče…';
    $('progress').textContent = `${g.matched} / ${g.total} dvojic`;

    if (state.phase === 'playing' && !g.locked && g.turnMsLeft !== null) {
      timer.end = performance.now() + g.turnMsLeft;
      timer.total = g.turnMsTotal;
      timer.frozen = false;
    } else {
      timer.frozen = true;
    }
  }

  function tickTimer() {
    if (!timer.frozen) timer.ratio = Math.max(0, Math.min(1, (timer.end - performance.now()) / timer.total));
    $('timer-bar').style.transform = `scaleX(${timer.ratio.toFixed(3)})`;
    requestAnimationFrame(tickTimer);
  }

  // ───────────── Konec hry ─────────────
  const MEDALS = ['🥇', '🥈', '🥉'];
  function renderFinish(ev) {
    const order = (state.ranking || []).map(playerById).filter(Boolean);
    const top = order.length ? order[0].score : 0;
    const winners = order.filter((p) => p.score === top);
    $('finish-title').textContent = winners.length === 1 ? `Vyhrává ${winners[0].nick}!` : 'Remíza!';
    $('finish-sub').textContent = winners.length === 1
      ? `${top} nalezených dvojic. Gratulujeme!`
      : `${winners.map((w) => w.nick).join(', ')} mají shodně ${top} dvojic.`;

    const list = $('leaderboard');
    list.textContent = '';
    let pos = 0;
    order.forEach((p, i) => {
      if (i === 0 || p.score < order[i - 1].score) pos = i;
      const li = mk('li', `p${Math.max(0, playerIndex(p.id))}${p.score === top ? ' win' : ''}`);
      li.append(
        mk('span', 'pos', MEDALS[pos] || `${pos + 1}.`),
        mk('span', 'av', AVATARS[p.avatar] || '🙂'),
        mk('span', 'nm', p.nick),
      );
      const pts = mk('span', 'pts', String(p.score));
      pts.append(document.createTextNode(' '), mk('small', null, 'dvojic'));
      li.appendChild(pts);
      list.appendChild(li);
    });

    const isHost = state.hostId === me.id;
    $('btn-rematch').classList.toggle('hidden', !isHost);
    $('btn-tolobby').classList.toggle('hidden', !isHost);
    $('finish-wait').classList.toggle('hidden', isHost);
    $('modal-finish').classList.remove('hidden');
    if (ev && ev.kind === 'finish') confettiRain(4200);
  }

  // ───────────── Konfety / částice ─────────────
  const fx = $('fx');
  const ctx = fx.getContext('2d');
  let particles = [];
  let rainUntil = 0;
  let fxRunning = false;

  function sizeFx() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.width = Math.floor(window.innerWidth * dpr);
    fx.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(x, y, n, colors, power, spread = Math.PI * 2, angle = 0) {
    if (reduceMotion) n = Math.ceil(n / 5);
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = power * (0.4 + Math.random() * 0.8);
      particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        g: 0.18 + Math.random() * 0.12, r: 3 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        life: 70 + Math.random() * 50, max: 120, c: colors[Math.floor(Math.random() * colors.length)],
        shape: Math.random() < 0.5 ? 0 : 1,
      });
    }
    startFx();
  }

  function burstAtCard(i, color) {
    const e = cardEls[i];
    if (!e) return;
    const r = e.getBoundingClientRect();
    spawn(r.left + r.width / 2, r.top + r.height / 2, 26, [color, '#ffffff', '#34d399', '#fde68a'], 7);
  }

  function confettiRain(ms) { rainUntil = performance.now() + ms; startFx(); }

  function startFx() {
    if (fxRunning) return;
    fxRunning = true;
    requestAnimationFrame(stepFx);
  }

  function stepFx(now) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (now < rainUntil && Math.random() < 0.9) {
      const w = window.innerWidth;
      spawn(Math.random() * w, -10, 4, COLORS.concat(['#ffffff', '#a78bfa']), 3, Math.PI / 3, Math.PI / 2);
    }
    particles = particles.filter((p) => p.life > 0 && p.y < window.innerHeight + 30);
    for (const p of particles) {
      p.vy += p.g; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life / 30);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      if (p.shape) { ctx.beginPath(); ctx.arc(0, 0, p.r * 0.6, 0, 6.3); ctx.fill(); }
      else ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    }
    if (particles.length || now < rainUntil) requestAnimationFrame(stepFx);
    else { fxRunning = false; ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
  }

  // ───────────── Události UI ─────────────
  function bind() {
    $('nick').addEventListener('input', saveProfile);
    $('joinCode').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });
    $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
    $('nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('joinCode').value ? $('btn-join') : $('btn-create')).click(); });

    $('btn-create').addEventListener('click', () => {
      const p = profileOrToast();
      if (p) send({ type: 'create', nick: p.nick, avatar: p.avatar, roomName: $('roomName').value });
    });
    $('btn-join').addEventListener('click', () => {
      const p = profileOrToast();
      if (!p) return;
      const code = cleanCode($('joinCode').value);
      if (code.length !== 6) { toast('Kód lobby má 6 znaků.'); $('joinCode').focus(); return; }
      send({ type: 'join', nick: p.nick, avatar: p.avatar, code });
    });

    $('btn-leave').addEventListener('click', () => send({ type: 'leave' }));
    $('btn-finish-leave').addEventListener('click', () => send({ type: 'leave' }));
    $('btn-copy-code').addEventListener('click', () => state && copy(state.code, 'Kód zkopírován.'));
    $('btn-copy-link').addEventListener('click', () => state && copy(shareLink(), 'Odkaz zkopírován.'));

    $('difficulty').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (b) send({ type: 'settings', difficulty: b.dataset.value });
    });
    $('themes').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (b) send({ type: 'settings', theme: b.dataset.value });
    });
    $('btn-start').addEventListener('click', () => send({ type: 'start' }));
    $('btn-rematch').addEventListener('click', () => send({ type: 'start' }));
    $('btn-tolobby').addEventListener('click', () => send({ type: 'lobby' }));

    $('board').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card || !state || state.phase !== 'playing' || !state.game) return;
      const g = state.game;
      const i = Number(card.dataset.i);
      const c = g.cards[i];
      if (g.turn !== me.id || g.locked || !c || c.st !== 'down') return;
      const now = performance.now();
      if (now - lastFlipAt < 150) return; // lokální cooldown (server má vlastní)
      lastFlipAt = now;
      send({ type: 'flip', index: i });
    });

    window.addEventListener('resize', () => { sizeFx(); if (state && state.game) applyCols(state.game.difficulty); });
    window.addEventListener('hashchange', prefillFromHash);
  }

  function prefillFromHash() {
    const code = cleanCode(location.hash.replace('#', ''));
    if (code.length === 6) $('joinCode').value = code;
  }

  // ───────────── Start ─────────────
  buildAvatars();
  buildThemes();
  loadProfile();
  prefillFromHash();
  bind();
  sizeFx();
  requestAnimationFrame(tickTimer);
  showScreen('home');
  connect();
})();
