---
date: 2026-05-01
severity: high
tags:
  - memory/incident
  - scalp
  - startup
  - rss
aliases:
  - npm start full server cascade
---

# npm start full server cascade

## Symptom

`npm run start:scalp` ficava estavel, mas `npm run start` ainda travava depois de alguns minutos. O log mostrava `Entrypoint: src/server.js`, HTTP em ~22-32 requests por janela, RSS subindo ate 363MB/420MB e restart por limite de memoria.

## Root Cause

Durante a Fase 1, o servidor Scalp isolado (`src/serverScalp.js`) foi criado para pausar todo o legado nao essencial. Porem `npm start` continuou apontando para `src/server.js` completo. Isso reativava os fluxos pausados da Fase 2 e invalidava a validacao feita em `start:scalp`.

## Fix

- `scripts/start-clean.mjs`: Scalp-Only virou default.
- `src/server.js` completo agora e opt-in por `--entry=full`, `ENTRY=full`, `ENTRY=legacy`, `ENTRY=server` ou `ENTRY=web`.
- `package.json`: adicionado `start:full`; `web` agora usa `start-clean --entry=full`.

## Verification

- `npm test`: 9/9 pass.
- `npm run start` agora loga `Entrypoint: src/serverScalp.js`.
- Startup observado: RSS 126MB -> 138MB, `httpDebug req=16 slow=0 err=0`.

## Related

- [[2026-05-01-http-timeout-zombie-sockets]]
- [[Memory Index]]
