# Pexeso Online

Multiplayer pexeso (2–4 hráči) se serverově autoritativní logikou. Node.js + WebSocket (`ws`), frontend bez frameworku a bez inline skriptů.

## Spuštění

```bash
npm install
npm start          # http://localhost:3000
npm test           # integrační test (spustí vlastní server na portu 3999)
```

Proměnné prostředí: `PORT`, `HOST`, `ALLOWED_ORIGINS` (další povolené originy, oddělené čárkou, např. `https://pexeso.example.com`).

Za reverzní proxy (nginx, Caddy…) musí být povolený WebSocket upgrade na `/ws` a předávaná hlavička `Host`. Pro veřejné nasazení použij HTTPS (klient pak automaticky použije `wss://`).

## Struktura

| Soubor | Účel |
|---|---|
| `server.js` | HTTP + WebSocket server, lobby, pravidla hry, bezpečnost |
| `public/index.html` | Obrazovky (úvod, lobby, hra, konec hry) |
| `public/style.css` | Glassmorphism dark/neon design, 3D flip karet |
| `public/app.js` | Klient: vykreslení, WebSocket, konfety |
| `public/themes.js` | 5 témat × 60 emoji symbolů, avatary |
| `test.js` | Integrační test pravidel a bezpečnosti |

## Bezpečnost – co je kde ošetřeno

- **Skryté karty:** server drží rozložení karet jen u sebe. Klient dostane hodnotu karty (`s`) pouze ve stavu `up` / `matched`; skryté karty mají `s: null`. V DOMu se hodnota po otočení zpět maže. V DevTools tedy není co číst.
- **Autorita serveru:** otočení karty, vyhodnocení shody, bodování a střídání hráčů řeší výhradně server. Klient posílá jen „chci otočit kartu N“. Server ověří fázi hry, pořadí, typ a rozsah indexu a stav karty.
- **XSS:** server nick a název lobby normalizuje (NFKC) a ponechá jen písmena, číslice, mezeru a `_ - .`. Klient nikdy nepoužívá `innerHTML`, jen `textContent`. CSP navíc zakazuje inline skripty i styly.
- **Rate limiting:** token bucket na spojení (burst 15, 8 zpráv/s), cooldown 120 ms na otočení karty, limit spojení na IP, limit zakládání lobby a neúspěšných pokusů o vstup za minutu, max. velikost zprávy 1 KB, heartbeat.
- **Bezpečná ID:** hráčské ID `crypto.randomUUID()`, relační token `crypto.randomBytes(32)`, kód lobby (6 znaků) z `crypto.randomInt`, zamíchání karet Fisher–Yates přes `crypto.randomInt`.
- **CSRF / Cross-Site WebSocket Hijacking:** server odmítne spojení bez shodného `Origin`. Neexistuje žádný HTTP endpoint měnící stav (statické soubory jen GET/HEAD z pevného seznamu, žádný path traversal).
- **Hlavičky:** CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, COOP/CORP.
- **Limit tahu:** 45 s na tah, aby AFK hráč nezablokoval hru. Odpojený hráč je přeskakován a může se vrátit (token v `sessionStorage`).

## Poznámky

- Odkaz na lobby má tvar `https://tvoje-domena/#KOD`. Kód v části za `#` se na server neposílá.
- Rematch: host zvolí „Hrát znovu“ (okamžitý restart se stejnými hráči a nastavením) nebo „Zpět do lobby“ (změna obtížnosti/tématu).
- Stav je v paměti procesu. Pro více instancí by bylo potřeba sdílené úložiště (např. Redis) a sticky sessions.
