---
date: 2026-05-01
severity: high
tags:
  - memory/incident
  - scalp
  - http
  - rss
aliases:
  - HTTP timeout zombie sockets
---

# HTTP timeout zombie sockets

## Symptom

App ainda travava apos alguns minutos mesmo com Binance WS desabilitado. A assinatura persistente era RSS escalando para >320MB, loopLag alto e major GCs, apesar de heap V8 baixo/moderado.

## Root Cause

`src/net/http.js` usava `Promise.race` dentro de `fetchWithTimeout`. Quando o timeout vencia, a funcao retornava erro e liberava os semaforos global/por-host antes do `fetch()` real encerrar. O socket/TLS podia continuar vivo em background, enquanto novas requisicoes entravam na vaga liberada. Isso recriava o padrao de zombie sockets e alocacao nativa fora do GC.

Segundo problema: o pause global de HTTP (`httpPauseChanged`) era aplicado ao sinal de fila, mas nao ao sinal do `fetch()` ativo. Ou seja, requests ja em voo nao eram abortados pelo pause.

## Fix

- Removido `Promise.race` de `fetchWithTimeout`.
- `fetchWithTimeout` agora aguarda o `fetch()` abortavel resolver/rejeitar antes de liberar semaforos.
- O `AbortSignal` ativo inclui deadline, signal externo e pause global.
- Adicionados testes para timeout abortar fetch ativo e pause global abortar fetch ativo.

## Verification

- `npm test`: 9/9 pass.
- Runtime `npm run start:scalp`: processo `src/serverScalp.js` passou varios minutos estavel.
- RSS observado: ~141-149MB, com queda apos major GC; sem cascade para 300MB+.
- HTTP debug: `slow=0 err=0` durante a janela observada.

## Related

- [[Memory Index]]
- Bug #21 em `MEMORY.md`: Binance WS era um fator, mas a acao anterior nao eliminava zombie sockets HTTP remanescentes.
