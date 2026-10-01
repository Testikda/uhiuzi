'use strict';
/**
 * Multiplayer Pexeso – autoritativní server.
 *
 * Bezpečnostní principy:
 *  - Pozice a hodnoty karet existují POUZE na serveru. Klient dostane hodnotu karty
 *    jen tehdy, když je otočená (stav "up") nebo nalezená ("matched").
 *  - Každá akce (flip, start, nastavení…) se validuje: typy, rozsahy, oprávnění, pořadí.
 *  - Sanitizace vstupů (nick, název lobby) na serveru + klient vykresluje přes textContent.
 *  - Kryptograficky bezpečné ID (crypto.randomUUID / randomBytes / randomInt).
 *  - Rate limiting (token bucket na spojení, limity na IP, limit pokusů o vstup do lobby).
 *  - Kontrola Origin (ochrana proti Cross-Site WebSocket Hijacking / CSRF).
 *  - Přísné bezpečnostní hlavičky (CSP bez inline skriptů, X-Frame-Options, …).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ───────────────────────── Konfigurace ─────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Další povolené originy (oddělené čárkou), např. "https://pexeso.example.com"
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MAX_PLAYERS = 4;
const MAX_ROOMS = 500;
const MAX_CONN_PER_IP = 12;
const MAX_ROOM_CREATES_PER_MIN_PER_IP = 6;
const MAX_JOIN_FAILS_PER_MIN_PER_IP = 12;
const MAX_MESSAGE_BYTES = 1024;

const TURN_MS = 45_000;           // limit na tah (proti zaseknutí hry AFK hráčem)
const FAST = process.env.PEXESO_FAST === '1'; // jen pro testy
const MATCH_REVEAL_MS = FAST ? 60 : 800;      // jak dlouho je vidět nalezená dvojice před potvrzením
const MISMATCH_REVEAL_MS = FAST ? 80 : 1200;  // jak dlouho jsou vidět nesedící karty
const MIN_FLIP_INTERVAL_MS = FAST ? 10 : 120; // cooldown na otočení karty (per hráč)

const DIFFICULTIES = { easy: 12, medium: 30, hard: 60 };
const THEMES = ['fruit', 'transport', 'animals', 'space', 'food'];
const POOL_SIZE = 60;             // každé téma má 60 symbolů (klient je mapuje podle indexu)
const AVATAR_COUNT = 12;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez 0/O/1/I
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

// ───────────────────────── Pomocné funkce ─────────────────────────
const randInt = (max) => crypto.randomInt(max);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newRoomCode(rooms) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += ROOM_ALPHABET[randInt(ROOM_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

/** Sanitizace jména: NFKC, jen písmena/číslice/mezera/_/-/., žádné řídicí ani neviditelné znaky. */
function sanitizeName(raw, maxLen, fallback) {
  if (typeof raw !== 'string') return fallback;
  let s = raw.normalize('NFKC');
  s = s.replace(/[^\p{L}\p{N} _.\-]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, maxLen).join('').trim();
  return s.length ? s : fallback;
}

function isInt(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max;
}

/** Jednoduchý token bucket. */
class Bucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refill = refillPerSec;
    this.last = Date.now();
  }
  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refill);
    this.last = now;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

/** Posuvné okno událostí (pro limity na IP). */
class WindowCounter {
  constructor(windowMs) { this.windowMs = windowMs; this.map = new Map(); }
  hit(key) {
    const now = Date.now();
    const arr = (this.map.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.map.set(key, arr);
    return arr.length;
  }
  count(key) {
    const now = Date.now();
    return (this.map.get(key) || []).filter((t) => now - t < this.windowMs).length;
  }
  sweep() {
    const now = Date.now();
    for (const [k, arr] of this.map) {
      const f = arr.filter((t) => now - t < this.windowMs);
      if (f.length) this.map.set(k, f); else this.map.delete(k);
    }
  }
}

// ───────────────────────── Stav ─────────────────────────
/** @type {Map<string, any>} */
const rooms = new Map();
/** token -> { roomCode, playerId } */
const sessions = new Map();
const connPerIp = new Map();
const roomCreates = new WindowCounter(60_000);
const joinFails = new WindowCounter(60_000);

// ───────────────────────── HTTP (statické soubory) ─────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/themes.js': ['themes.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function securityHeaders(req) {
  const host = /^[a-zA-Z0-9.\-:\[\]]{1,255}$/.test(req.headers.host || '') ? req.headers.host : 'localhost';
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ws://${host} wss://${host}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

const server = http.createServer((req, res) => {
  const headers = securityHeaders(req);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
    return res.end();
  }
  const pathname = (req.url || '/').split('?')[0];
  const entry = Object.prototype.hasOwnProperty.call(STATIC, pathname) ? STATIC[pathname] : null;
  if (!entry) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Nenalezeno');
  }
  // Pevný seznam souborů => žádný path traversal.
  fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, data) => {
    if (err) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nenalezeno');
    }
    res.writeHead(200, { ...headers, 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

// ───────────────────────── WebSocket ─────────────────────────
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES * 2,
  perMessageDeflate: false,
  verifyClient: (info, done) => {
    const ip = info.req.socket.remoteAddress || 'unknown';
    if ((connPerIp.get(ip) || 0) >= MAX_CONN_PER_IP) return done(false, 429, 'Too many connections');
    const origin = info.origin || info.req.headers.origin;
    if (!origin) return done(false, 403, 'Origin required');
    let ok = EXTRA_ORIGINS.includes(origin);
    if (!ok) {
      try { ok = new URL(origin).host === info.req.headers.host; } catch { ok = false; }
    }
    if (!ok) return done(false, 403, 'Bad origin');
    done(true);
  },
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  connPerIp.set(ip, (connPerIp.get(ip) || 0) + 1);
  ws.ip = ip;
  ws.bucket = FAST ? new Bucket(500, 500) : new Bucket(15, 8); // burst 15, 8 zpráv/s
  ws.violations = 0;
  ws.ctx = null;                      // { roomCode, playerId }
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > MAX_MESSAGE_BYTES) {
      return ws.close(1009, 'Message too large');
    }
    if (!ws.bucket.take()) {
      ws.violations++;
      if (ws.violations > 20) return ws.close(1008, 'Rate limit');
      return; // zprávu tiše zahodíme
    }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    try {
      handleMessage(ws, msg);
    } catch (e) {
      console.error('Chyba při zpracování zprávy:', e);
      sendError(ws, 'internal', 'Interní chyba serveru.');
    }
  });

  ws.on('close', () => {
    const n = (connPerIp.get(ip) || 1) - 1;
    if (n <= 0) connPerIp.delete(ip); else connPerIp.set(ip, n);
    onDisconnect(ws);
  });

  ws.on('error', () => {});
});

// Heartbeat – odpojí mrtvá spojení.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 25_000).unref();

// ───────────────────────── Logika místností ─────────────────────────
function createPlayer(nick, avatar) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(32).toString('hex'),
    nick, avatar,
    score: 0,
    ws: null,
    connected: false,
    lastSeen: Date.now(),
    lastFlip: 0,
  };
}

function attach(ws, room, player) {
  // Případné staré spojení stejného hráče zavřeme.
  if (player.ws && player.ws !== ws) {
    player.ws.ctx = null;
    try { player.ws.close(4000, 'Replaced'); } catch { /* ignore */ }
  }
  player.ws = ws;
  player.connected = true;
  player.lastSeen = Date.now();
  ws.ctx = { roomCode: room.code, playerId: player.id };
  sessions.set(player.token, { roomCode: room.code, playerId: player.id });
}

function currentRoom(ws) {
  if (!ws.ctx) return null;
  const room = rooms.get(ws.ctx.roomCode);
  if (!room) return null;
  const player = room.players.get(ws.ctx.playerId);
  if (!player) return null;
  return { room, player };
}

function publicState(room) {
  const g = room.game;
  const players = [...room.players.values()].map((p) => ({
    id: p.id, nick: p.nick, avatar: p.avatar, score: p.score, connected: p.connected,
  }));
  let game = null;
  if (g && room.phase !== 'lobby') {
    game = {
      total: g.total,
      matched: g.matched,
      theme: g.theme,
      difficulty: g.difficulty,
      turn: g.order[g.turnIdx] || null,
      turnMsLeft: g.deadline ? Math.max(0, g.deadline - Date.now()) : null,
      turnMsTotal: TURN_MS,
      locked: g.locked,
      // KLÍČOVÉ: hodnota karty se posílá jen pokud je karta otočená / nalezená.
      cards: g.cards.map((c) => ({
        st: c.state,
        s: c.state === 'down' ? null : c.sym,
        o: c.owner || null,
      })),
    };
  }
  let ranking = null;
  if (room.phase === 'finished') {
    ranking = players.slice().sort((a, b) => b.score - a.score).map((p) => p.id);
  }
  return {
    code: room.code,
    name: room.name,
    phase: room.phase,
    hostId: room.hostId,
    settings: room.settings,
    players,
    game,
    ranking,
  };
}

function broadcast(room, event) {
  const payload = JSON.stringify({ type: 'state', state: publicState(room), event: event || null });
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

function clearTimers(g) {
  if (!g) return;
  if (g.turnTimer) { clearTimeout(g.turnTimer); g.turnTimer = null; }
  if (g.resolveTimer) { clearTimeout(g.resolveTimer); g.resolveTimer = null; }
}

function connectedOrder(room) {
  const g = room.game;
  return g.order.filter((id) => room.players.get(id)?.connected);
}

/** Spustí (nebo obnoví) časovač tahu pro hráče, který je na řadě. */
function armTurn(room) {
  const g = room.game;
  if (!g) return;
  if (g.turnTimer) { clearTimeout(g.turnTimer); g.turnTimer = null; }
  const alive = connectedOrder(room);
  if (alive.length === 0) { g.deadline = null; return; }
  // Pokud je na řadě odpojený hráč, posuneme se na dalšího připojeného.
  let guard = 0;
  while (!room.players.get(g.order[g.turnIdx])?.connected && guard++ < g.order.length) {
    g.turnIdx = (g.turnIdx + 1) % g.order.length;
  }
  g.deadline = Date.now() + TURN_MS;
  g.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_MS + 50);
}

function advanceTurn(room) {
  const g = room.game;
  g.turnIdx = (g.turnIdx + 1) % g.order.length;
  armTurn(room);
}

function onTurnTimeout(room) {
  const g = room.game;
  if (!g || room.phase !== 'playing' || g.locked) return;
  for (const i of g.flipped) g.cards[i].state = 'down';
  g.flipped = [];
  advanceTurn(room);
  broadcast(room, { kind: 'timeout' });
}

function startGame(room) {
  clearTimers(room.game);
  const pairs = DIFFICULTIES[room.settings.difficulty];
  const symbols = shuffle(Array.from({ length: POOL_SIZE }, (_, i) => i)).slice(0, pairs);
  const cards = shuffle(symbols.flatMap((s) => [s, s])).map((sym) => ({ sym, state: 'down', owner: null }));
  for (const p of room.players.values()) p.score = 0;
  const order = shuffle([...room.players.keys()]);
  room.phase = 'playing';
  room.game = {
    cards, flipped: [], locked: false, matched: 0, total: pairs,
    theme: room.settings.theme, difficulty: room.settings.difficulty,
    order, turnIdx: 0, deadline: null, turnTimer: null, resolveTimer: null,
  };
  armTurn(room);
  broadcast(room, { kind: 'start' });
}

function resolvePair(room) {
  const g = room.game;
  if (!g || room.phase !== 'playing') return;
  g.resolveTimer = null;
  const [a, b] = g.flipped;
  const playerId = g.order[g.turnIdx];
  const player = room.players.get(playerId);
  if (g.cards[a].sym === g.cards[b].sym) {
    g.cards[a].state = g.cards[b].state = 'matched';
    g.cards[a].owner = g.cards[b].owner = playerId;
    g.matched++;
    if (player) player.score++;
    g.flipped = [];
    g.locked = false;
    if (g.matched >= g.total) {
      clearTimers(g);
      g.deadline = null;
      room.phase = 'finished';
      return broadcast(room, { kind: 'finish', indices: [a, b], playerId });
    }
    armTurn(room); // hráč zůstává na tahu, časovač se obnoví
    return broadcast(room, { kind: 'match', indices: [a, b], playerId });
  }
  g.cards[a].state = g.cards[b].state = 'down';
  g.flipped = [];
  g.locked = false;
  advanceTurn(room);
  broadcast(room, { kind: 'mismatch', indices: [a, b], playerId });
}

function removePlayer(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return;
  sessions.delete(p.token);
  room.players.delete(playerId);
  if (room.players.size === 0) { destroyRoom(room); return; }
  if (room.hostId === playerId) {
    const next = [...room.players.values()].find((x) => x.connected) || [...room.players.values()][0];
    room.hostId = next.id;
  }
}

function destroyRoom(room) {
  clearTimers(room.game);
  for (const p of room.players.values()) sessions.delete(p.token);
  rooms.delete(room.code);
}

function onDisconnect(ws) {
  const cr = currentRoom(ws);
  if (!cr) return;
  const { room, player } = cr;
  if (player.ws !== ws) return;
  player.connected = false;
  player.ws = null;
  player.lastSeen = Date.now();
  // Přesun hosta, pokud odešel.
  if (room.hostId === player.id) {
    const next = [...room.players.values()].find((x) => x.connected);
    if (next) room.hostId = next.id;
  }
  // Pokud byl na tahu, hra pokračuje dalším hráčem.
  if (room.phase === 'playing' && room.game && room.game.order[room.game.turnIdx] === player.id && !room.game.locked) {
    for (const i of room.game.flipped) room.game.cards[i].state = 'down';
    room.game.flipped = [];
    advanceTurn(room);
  }
  broadcast(room, { kind: 'presence' });
}

// Úklid: odpojení hráči v lobby se po 30 s odstraní, prázdné místnosti po 2 min zaniknou.
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.phase !== 'playing') {
      let changed = false;
      for (const p of [...room.players.values()]) {
        if (!p.connected && now - p.lastSeen > 30_000) { removePlayer(room, p.id); changed = true; }
      }
      if (!rooms.has(room.code)) continue;
      if (changed) broadcast(room, { kind: 'presence' });
    }
    const anyConnected = [...room.players.values()].some((p) => p.connected);
    const lastSeen = Math.max(0, ...[...room.players.values()].map((p) => p.lastSeen));
    if (!anyConnected && now - lastSeen > 120_000) destroyRoom(room);
  }
  roomCreates.sweep();
  joinFails.sweep();
}, 10_000).unref();

// ───────────────────────── Zpracování zpráv ─────────────────────────
function validProfile(msg) {
  const nick = sanitizeName(msg.nick, 16, '');
  if (!nick) return null;
  if (!isInt(msg.avatar, 0, AVATAR_COUNT - 1)) return null;
  return { nick, avatar: msg.avatar };
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      if (ws.ctx) return sendError(ws, 'already', 'Už jsi v místnosti.');
      const profile = validProfile(msg);
      if (!profile) return sendError(ws, 'bad_profile', 'Zadej přezdívku (1–16 znaků) a vyber avatar.');
      if (roomCreates.hit(ws.ip) > MAX_ROOM_CREATES_PER_MIN_PER_IP) {
        return sendError(ws, 'rate', 'Příliš mnoho nových místností. Zkus to za chvíli.');
      }
      if (rooms.size >= MAX_ROOMS) return sendError(ws, 'full_server', 'Server je plný, zkus to později.');
      const code = newRoomCode(rooms);
      if (!code) return sendError(ws, 'internal', 'Nepodařilo se vytvořit místnost.');
      const player = createPlayer(profile.nick, profile.avatar);
      const room = {
        code,
        name: sanitizeName(msg.roomName, 24, `Lobby ${profile.nick}`),
        phase: 'lobby',
        hostId: player.id,
        settings: { difficulty: 'easy', theme: 'fruit' },
        players: new Map([[player.id, player]]),
        game: null,
      };
      rooms.set(code, room);
      attach(ws, room, player);
      send(ws, { type: 'joined', playerId: player.id, token: player.token, code });
      return broadcast(room, { kind: 'presence' });
    }

    case 'join': {
      if (ws.ctx) return sendError(ws, 'already', 'Už jsi v místnosti.');
      if (joinFails.count(ws.ip) >= MAX_JOIN_FAILS_PER_MIN_PER_IP) {
        return sendError(ws, 'rate', 'Příliš mnoho neúspěšných pokusů. Zkus to za chvíli.');
      }
      const profile = validProfile(msg);
      if (!profile) return sendError(ws, 'bad_profile', 'Zadej přezdívku (1–16 znaků) a vyber avatar.');
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const room = ROOM_CODE_RE.test(code) ? rooms.get(code) : null;
      if (!room) {
        joinFails.hit(ws.ip);
        return sendError(ws, 'no_room', 'Lobby s tímto kódem neexistuje.');
      }
      if (room.phase === 'playing') return sendError(ws, 'in_game', 'Hra už běží. Počkej na další kolo.');
      if (room.players.size >= MAX_PLAYERS) return sendError(ws, 'full', 'Lobby je plné (max. 4 hráči).');
      const player = createPlayer(profile.nick, profile.avatar);
      room.players.set(player.id, player);
      attach(ws, room, player);
      send(ws, { type: 'joined', playerId: player.id, token: player.token, code });
      return broadcast(room, { kind: 'presence' });
    }

    case 'resume': {
      if (ws.ctx) return;
      const token = typeof msg.token === 'string' && /^[0-9a-f]{64}$/.test(msg.token) ? msg.token : null;
      const sess = token ? sessions.get(token) : null;
      const room = sess ? rooms.get(sess.roomCode) : null;
      const player = room ? room.players.get(sess.playerId) : null;
      if (!player || player.token !== token) return send(ws, { type: 'resume_failed' });
      attach(ws, room, player);
      send(ws, { type: 'joined', playerId: player.id, token: player.token, code: room.code });
      if (room.phase === 'playing' && room.game && !room.game.turnTimer && !room.game.locked) armTurn(room);
      return broadcast(room, { kind: 'presence' });
    }

    case 'leave': {
      const cr = currentRoom(ws);
      if (!cr) return;
      const { room, player } = cr;
      ws.ctx = null;
      if (room.phase === 'playing') {
        // Během hry hráče jen odpojíme (jeho skóre zůstává v tabulce).
        player.ws = null; player.connected = false; player.lastSeen = Date.now();
        sessions.delete(player.token);
        player.token = crypto.randomBytes(32).toString('hex'); // starý token přestane platit
        if (room.hostId === player.id) {
          const next = [...room.players.values()].find((x) => x.connected);
          if (next) room.hostId = next.id;
        }
        if (room.game.order[room.game.turnIdx] === player.id && !room.game.locked) {
          for (const i of room.game.flipped) room.game.cards[i].state = 'down';
          room.game.flipped = [];
          advanceTurn(room);
        }
        broadcast(room, { kind: 'presence' });
      } else {
        removePlayer(room, player.id);
        if (rooms.has(room.code)) broadcast(room, { kind: 'presence' });
      }
      return send(ws, { type: 'left' });
    }

    case 'settings': {
      const cr = currentRoom(ws);
      if (!cr) return;
      const { room, player } = cr;
      if (player.id !== room.hostId) return sendError(ws, 'forbidden', 'Nastavení může měnit jen host.');
      if (room.phase === 'playing') return;
      const next = { ...room.settings };
      if (msg.difficulty !== undefined) {
        if (typeof msg.difficulty !== 'string' || !Object.prototype.hasOwnProperty.call(DIFFICULTIES, msg.difficulty)) return;
        next.difficulty = msg.difficulty;
      }
      if (msg.theme !== undefined) {
        if (typeof msg.theme !== 'string' || !THEMES.includes(msg.theme)) return;
        next.theme = msg.theme;
      }
      room.settings = next;
      return broadcast(room, { kind: 'settings' });
    }

    case 'start': {
      const cr = currentRoom(ws);
      if (!cr) return;
      const { room, player } = cr;
      if (player.id !== room.hostId) return sendError(ws, 'forbidden', 'Hru může spustit jen host.');
      if (room.phase === 'playing') return;
      const connected = [...room.players.values()].filter((p) => p.connected);
      // Odpojené hráče před novou hrou odstraníme.
      for (const p of [...room.players.values()]) if (!p.connected) removePlayer(room, p.id);
      if (connected.length < 2) return sendError(ws, 'few_players', 'Pro start jsou potřeba alespoň 2 hráči.');
      return startGame(room);
    }

    case 'lobby': { // návrat do lobby po hře (změna nastavení)
      const cr = currentRoom(ws);
      if (!cr) return;
      const { room, player } = cr;
      if (player.id !== room.hostId || room.phase !== 'finished') return;
      clearTimers(room.game);
      room.game = null;
      room.phase = 'lobby';
      for (const p of room.players.values()) p.score = 0;
      return broadcast(room, { kind: 'lobby' });
    }

    case 'flip': {
      const cr = currentRoom(ws);
      if (!cr) return;
      const { room, player } = cr;
      const g = room.game;
      if (room.phase !== 'playing' || !g || g.locked) return;
      if (g.order[g.turnIdx] !== player.id) return;                 // nejsi na řadě
      if (!isInt(msg.index, 0, g.cards.length - 1)) return;         // neplatný index
      const now = Date.now();
      if (now - player.lastFlip < MIN_FLIP_INTERVAL_MS) return;     // cooldown
      const card = g.cards[msg.index];
      if (card.state !== 'down' || g.flipped.length >= 2) return;   // už otočená / nalezená
      player.lastFlip = now;
      card.state = 'up';
      g.flipped.push(msg.index);
      if (g.flipped.length === 2) {
        g.locked = true;
        if (g.turnTimer) { clearTimeout(g.turnTimer); g.turnTimer = null; }
        const isMatch = g.cards[g.flipped[0]].sym === g.cards[g.flipped[1]].sym;
        g.resolveTimer = setTimeout(() => resolvePair(room), isMatch ? MATCH_REVEAL_MS : MISMATCH_REVEAL_MS);
      }
      return broadcast(room, { kind: 'flip', indices: [msg.index], playerId: player.id });
    }

    default:
      return; // neznámé zprávy ignorujeme
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Pexeso běží na http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

module.exports = { server, sanitizeName }; // pro testy
