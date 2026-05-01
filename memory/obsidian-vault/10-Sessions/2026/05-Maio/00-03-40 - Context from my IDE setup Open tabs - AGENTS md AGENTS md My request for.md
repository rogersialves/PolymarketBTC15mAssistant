---
title: "Context from my IDE setup Open tabs - AGENTS md AGENTS md My request for"
type: chat-session
status: ended
session_id: "019de0d8-2924-76e3-9058-3cbccb43a462"
project: "PolymarketBTC15mAssistant"
project_dir: "/opt/PolymarketBTC15mAssistant"
created: "2026-05-01T00:03:40.172Z"
updated: "2026-05-01T00:22:35.084Z"
source: "startup"
tags:
  - memory/session
  - codex
aliases:
  - "019de0d8-2924-76e3-9058-3cbccb43a462"
ended: "2026-05-01T00:22:35.084Z"

---

# Sessao iniciada

Links: [[Memory Index]]

## Timeline

### 2026-05-01T00:03:40.177Z - SessionStart

- Fonte: startup
- Projeto: /opt/PolymarketBTC15mAssistant

### 2026-05-01T00:03:40.586Z - UserPromptSubmit

#### User Prompt

# Context from my IDE setup:

## Open tabs:
- AGENTS.md: AGENTS.md

## My request for Codex:
Vamos Atacar nosso Principal Problema do APP que é o travamento aós alguns minutos de operação, leia [MEMORY.md](MEMORY.md) 
E a ultima ação realizada que se provou falha ainda temos problemas.

Solução definitiva entregue
Processo rodando: PID 1639553, 9 minutos, RSS estável 147-151MB (151168KB), heap=33/73MB, GC só minor (1-2ms), zero loopLag spikes, zero alerts.

Diagnóstico (3 rounds de isolamento)
Round	Config	RSS estável?
1	TODOS WS off	✅ 144MB por 4min
2	Binance + Chainlink ON, Polymarket off	❌ Cascade 175→309MB em 90s
3	Polymarket + Chainlink ON, Binance off	✅ 147MB por 4min
Culpado isolado: startBinanceTradeStream mantendo conexão TCP/TLS para stream.binance.com:9443. Tentativa de mitigar via @bookTicker + throttle 200ms falhou — cascade reproduziu (RSS 222→472MB). A conexão TCP/TLS em si aloca buffer pool nativo (fora do GC do V8) que jemalloc não consegue liberar quando event loop fica saturado. Provável reconnect loop ou TLS context renegotiation em background.

Correção aplicada
src/serverScalp.js: Binance WS desabilitado por DEFAULT. Tick usa fetchLastPrice HTTP (1 req/s para api.binance.us). Para reabilitar (não recomendado): SCALP_BINANCE_WS=1.

src/data/binanceWs.js: mudou para @bookTicker + throttle (preservado caso alguém use SCALP_BINANCE_WS=1 ou em Phase 2).

MEMORY.md: documentou Bug #21 com diagnóstico, tentativa que falhou e correção definitiva.

Tradeoff aceito
Binance HTTP polling tem latência ~500ms (vs WS real-time). Para Scalp Force isso é aceitável:

polymarketLiveStream (WS) é fonte primária do preço Polymarket
chainlinkStream (WS+heartbeat) fonte secundária
Binance é só 1 de 3 oracles (Coinbase, Kraken via HTTP funcionam igual)
Janelas Scalp são 5m/15m — 500ms de latência é irrelevante para decisões
App rodando em http://localhost:3000. Pode validar o dashboard agora.


### 2026-05-01T00:13:08.801Z - Stop

- Sessao encerrada pelo hook Stop.

### 2026-05-01T00:13:10.057Z - UserPromptSubmit

#### User Prompt

# Context from my IDE setup:

## Open tabs:
- 00-03-42 - You are a helpful assistant You will be presented with a user prompt and.md: memory/obsidian-vault/10-Sessions/2026/05-Maio/00-03-42 - You are a helpful assistant You will be presented with a user prompt and.md
- 00-03-40 - Context from my IDE setup Open tabs - AGENTS md AGENTS md My request for.md: memory/obsidian-vault/10-Sessions/2026/05-Maio/00-03-40 - Context from my IDE setup Open tabs - AGENTS md AGENTS md My request for.md
- AGENTS.md: AGENTS.md

## My request for Codex:
Durante desenvolvimentos foi criado um start especifico isolado para só indicadores Scalp na tentantiva de recriar a aplicação apenas com as Carterias Scalp que é o foco do projeto todo resto seria desativado assim isolando o problema em partes para tentar encontrar a causa raiz.
passo recomendado: rodar npm run start:scalp e monitorar logs/diagnostics.log. RSS deve oscilar 90-180MB sem cascade. Se confirmar estabilidade, podemos liberar trades LIVE com confiança.


### 2026-05-01T00:13:56.196Z - Stop

- Sessao encerrada pelo hook Stop.

### 2026-05-01T00:18:33.755Z - UserPromptSubmit

#### User Prompt

# Context from my IDE setup:

## Open tabs:
- Memory Index.md: memory/obsidian-vault/Memory Index.md
- 2026-05-01-http-timeout-zombie-sockets.md: memory/obsidian-vault/40-Incidents/2026-05-01-http-timeout-zombie-sockets.md
- 00-03-40 - Context from my IDE setup Open tabs - AGENTS md AGENTS md My request for.md: memory/obsidian-vault/10-Sessions/2026/05-Maio/00-03-40 - Context from my IDE setup Open tabs - AGENTS md AGENTS md My request for.md
- 00-03-42 - You are a helpful assistant You will be presented with a user prompt and.md: memory/obsidian-vault/10-Sessions/2026/05-Maio/00-03-42 - You are a helpful assistant You will be presented with a user prompt and.md
- AGENTS.md: AGENTS.md

## My request for Codex:
ainda temos o problema

root@PolymarketBot:/opt/PolymarketBTC15mAssistant# npm run start

> polyassistent@0.1.0 start
> node scripts/start-clean.mjs

🧹 [start] Liberando porta 3000. PIDs encontrados: 1688855
✅ [start] Processo finalizado: PID 1688855
🚀 [start] Entrypoint: src/server.js
⚙️  [Config] runtime carregado de /opt/PolymarketBTC15mAssistant/logs/trading_config.runtime.json
🚀 Starting BTC Polymarket Web Dashboard...

✅ Postgres trade_history pronto
✅ Dashboard: http://localhost:3000
   Collecting data for 5m and 15m simultaneously

📂 [PolyTrader] Histórico carregado do Postgres: 2920 operações (203 LIVE, 2717 SIM)
🔑 [PolyTrader] Wallet EOA: 0xca6d78F7A7C35806718a4eaa69Af100C7D16CA88
🔗 [PolyTrader] Proxy wallet (env): 0x144a773a56753725B3090942378931f6cFf9E546
🔑 [PolyTrader] Derivando API keys...
[mem] heap=36/69MB rss=131MB ext=4MB ab=0MB gc[major=1/8ms minor=5/52ms incremental=1/2ms]
✅ [PolyTrader] API Key: 1ed590c0...
🔐 [PolyTrader] SignatureType: POLY_PROXY (1)
✅ [PolyTrader] Conectado ao CLOB: OK
💰 [PolyTrader] Saldo USDC: $28.37 (raw="28372519")

🎯 [PolyTrader] Modo: 📡 SCALP MONITOR (SIM) | Max Stake: $40
[mem] heap=36/70MB rss=140MB ext=5MB ab=1MB gc[major=1/12ms minor=1/6ms incremental=1/2ms]
[httpDebug] ERR GET https://polymarket.com/event/btc-updown-5m-1777594500 total=198ms ttfb=194ms err=20
[httpDebug] ERR GET https://polymarket.com/event/btc-updown-15m-1777594500 total=49ms ttfb=44ms err=20
[mem] heap=37/72MB rss=144MB ext=5MB ab=1MB gc[major=1/6ms minor=2/11ms incremental=1/1ms]
[mem] heap=38/72MB rss=144MB ext=6MB ab=2MB gc[minor=1/0ms]
[mem] heap=38/72MB rss=145MB ext=6MB ab=2MB gc[minor=1/4ms]
[mem] heap=39/73MB rss=145MB ext=6MB ab=2MB gc[minor=1/6ms]
[loopLag] window=5.0s max=569ms p99=115ms p50=20ms mean=25.8ms
[httpDebug] req=32 slow=2 err=2
[mem] heap=39/73MB rss=145MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=39/73MB rss=145MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=39/73MB rss=145MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=40/73MB rss=146MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=40/73MB rss=146MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=40/73MB rss=146MB ext=6MB ab=2MB gc[minor=1/2ms]
[httpDebug] req=22 slow=0 err=0
[mem] heap=40/73MB rss=146MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=40/74MB rss=147MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=40/74MB rss=147MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=40/74MB rss=147MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=41/74MB rss=147MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=41/74MB rss=147MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=41/74MB rss=147MB ext=6MB ab=2MB gc[minor=1/2ms]
[httpDebug] req=27 slow=0 err=0
[mem] heap=41/74MB rss=147MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=41/75MB rss=147MB ext=6MB ab=2MB gc[minor=1/4ms]
[mem] heap=41/75MB rss=147MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=42/75MB rss=148MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=42/75MB rss=149MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=42/75MB rss=149MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=42/75MB rss=149MB ext=6MB ab=2MB gc[minor=1/1ms]
[httpDebug] req=24 slow=0 err=0
[mem] heap=42/75MB rss=150MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=42/76MB rss=150MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=42/76MB rss=150MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=43/76MB rss=150MB ext=6MB ab=2MB gc[minor=1/1ms]
[mem] heap=43/76MB rss=151MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=43/76MB rss=151MB ext=6MB ab=2MB gc[minor=1/2ms]
[httpDebug] req=27 slow=0 err=0
[mem] heap=43/76MB rss=151MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=43/76MB rss=151MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=43/77MB rss=152MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=43/77MB rss=152MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=43/77MB rss=152MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=43/77MB rss=152MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=44/77MB rss=153MB ext=6MB ab=2MB gc[minor=1/2ms]
[httpDebug] req=22 slow=0 err=0
[mem] heap=44/77MB rss=153MB ext=6MB ab=2MB gc[minor=1/3ms]
[mem] heap=44/78MB rss=153MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=44/78MB rss=153MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=44/78MB rss=153MB ext=6MB ab=2MB gc[minor=1/1ms]
[mem] heap=45/78MB rss=154MB ext=6MB ab=3MB gc[minor=1/2ms]
[mem] heap=45/78MB rss=154MB ext=7MB ab=2MB gc[minor=1/12ms]
[mem] heap=45/78MB rss=155MB ext=7MB ab=2MB gc[minor=1/4ms]
[httpDebug] req=29 slow=0 err=0
[mem] heap=45/78MB rss=155MB ext=6MB ab=2MB gc[minor=1/3ms]
[mem] heap=45/79MB rss=156MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=45/79MB rss=156MB ext=6MB ab=2MB gc[minor=1/3ms]
[mem] heap=46/79MB rss=156MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=46/79MB rss=156MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=46/79MB rss=156MB ext=6MB ab=2MB gc[minor=1/4ms]
[httpDebug] req=22 slow=0 err=0
[mem] heap=46/79MB rss=156MB ext=6MB ab=2MB gc[minor=1/2ms]
[mem] heap=46/80MB rss=156MB ext=6MB ab=3MB gc[minor=1/2ms]
[mem] heap=46/80MB rss=157MB ext=6MB ab=3MB gc[minor=1/2ms]
[mem] heap=35/80MB rss=152MB ext=4MB ab=0MB gc[major=1/14ms minor=1/2ms incremental=1/2ms]
[mem] heap=35/80MB rss=152MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=35/80MB rss=152MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=35/80MB rss=152MB ext=4MB ab=0MB gc[minor=1/2ms]
[httpDebug] req=27 slow=0 err=0
[mem] heap=36/80MB rss=151MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=36/80MB rss=151MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=36/80MB rss=152MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=36/80MB rss=152MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=37/80MB rss=152MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=37/80MB rss=152MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=37/80MB rss=153MB ext=5MB ab=0MB gc[minor=1/2ms]
[httpDebug] req=23 slow=0 err=0
[mem] heap=37/80MB rss=153MB ext=5MB ab=0MB gc[minor=1/2ms]
[mem] heap=37/80MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=37/80MB rss=153MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=38/80MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=38/80MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=38/80MB rss=153MB ext=4MB ab=1MB gc[minor=1/2ms]
[httpDebug] req=28 slow=0 err=0
[mem] heap=38/80MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=38/80MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=39/80MB rss=154MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=39/80MB rss=155MB ext=4MB ab=1MB gc[minor=1/2ms]
[mem] heap=34/71MB rss=153MB ext=4MB ab=0MB gc[major=1/29ms minor=1/3ms incremental=1/3ms]
[mem] heap=34/71MB rss=153MB ext=4MB ab=0MB gc[minor=1/1ms]
[mem] heap=34/71MB rss=153MB ext=4MB ab=0MB gc[minor=1/4ms]
[httpDebug] req=22 slow=0 err=0
[mem] heap=33/72MB rss=152MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=33/72MB rss=152MB ext=4MB ab=0MB gc[major=1/49ms minor=1/3ms]
[mem] heap=34/72MB rss=152MB ext=4MB ab=0MB gc[minor=1/1ms]
[mem] heap=34/72MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=34/72MB rss=152MB ext=4MB ab=0MB gc[minor=1/4ms]
[mem] heap=34/72MB rss=152MB ext=4MB ab=0MB gc[minor=1/4ms]
[mem] heap=34/72MB rss=152MB ext=4MB ab=0MB gc[minor=1/3ms]
[httpDebug] req=27 slow=0 err=0
[mem] heap=35/72MB rss=154MB ext=5MB ab=0MB gc[minor=1/2ms]
[mem] heap=35/72MB rss=153MB ext=5MB ab=1MB gc[minor=1/3ms]
[mem] heap=35/72MB rss=153MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=34/72MB rss=154MB ext=4MB ab=0MB gc[major=1/8ms minor=1/2ms incremental=1/1ms]
[mem] heap=35/72MB rss=155MB ext=4MB ab=0MB gc[minor=1/1ms]
[mem] heap=36/72MB rss=155MB ext=4MB ab=0MB gc[minor=1/3ms]
[httpDebug] req=24 slow=0 err=0
[mem] heap=33/72MB rss=153MB ext=4MB ab=0MB gc[major=1/6ms minor=1/5ms incremental=1/1ms]
[mem] heap=34/72MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=34/72MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=34/73MB rss=153MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=34/73MB rss=156MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=35/73MB rss=154MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=35/73MB rss=154MB ext=4MB ab=0MB gc[minor=1/3ms]
[httpDebug] req=26 slow=0 err=0
[mem] heap=35/73MB rss=154MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=34/72MB rss=155MB ext=4MB ab=0MB gc[major=1/14ms minor=1/3ms incremental=1/3ms]
[mem] heap=34/72MB rss=154MB ext=4MB ab=0MB gc[minor=1/1ms]
[mem] heap=34/72MB rss=154MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=35/73MB rss=156MB ext=4MB ab=0MB gc[major=1/8ms minor=1/4ms incremental=1/3ms]
[mem] heap=34/73MB rss=157MB ext=4MB ab=0MB gc[major=1/8ms minor=1/1ms incremental=1/1ms]
[mem] heap=36/73MB rss=158MB ext=4MB ab=0MB gc[minor=1/2ms]
[httpDebug] req=23 slow=0 err=0
[mem] heap=34/73MB rss=155MB ext=4MB ab=0MB gc[major=1/9ms minor=1/5ms incremental=1/3ms]
[mem] heap=35/73MB rss=155MB ext=5MB ab=0MB gc[minor=1/2ms]
[mem] heap=35/73MB rss=155MB ext=4MB ab=0MB gc[minor=1/5ms]
[mem] heap=35/73MB rss=155MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=36/73MB rss=162MB ext=4MB ab=0MB gc[minor=1/2ms incremental=1/1ms]
[mem] heap=34/74MB rss=156MB ext=4MB ab=0MB gc[major=1/7ms minor=1/7ms]
[httpDebug] req=28 slow=0 err=0
[mem] heap=35/74MB rss=156MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=35/74MB rss=156MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=34/73MB rss=161MB ext=4MB ab=0MB gc[major=1/10ms minor=1/3ms incremental=1/1ms]
[mem] heap=35/73MB rss=156MB ext=4MB ab=0MB gc[minor=1/3ms]
[mem] heap=36/73MB rss=158MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=38/76MB rss=176MB ext=4MB ab=0MB gc[major=1/19ms minor=1/7ms incremental=2/2ms]
[mem] http paused rss=176MB>168MB — novas requests bloqueadas
[mem] http paused: full GC triggered
[loopLag] window=5.0s max=696ms p99=140ms p50=20ms mean=30.9ms
[httpDebug] req=19 slow=0 err=0
[mem] heap=39/78MB rss=176MB ext=4MB ab=0MB gc[major=3/73ms minor=1/5ms incremental=1/1ms]
⚠️  Binance last price refresh falhou; mantendo preço em cache: Binance last price failed: https://api.binance.us: Binance last price https://api.binance.us paused (RSS limit, try later) | https://api.binance.com: cooldown 511s
[mem] heap=40/79MB rss=178MB ext=5MB ab=0MB gc[major=1/7ms minor=3/18ms incremental=1/1ms]
[mem] heap=38/79MB rss=164MB ext=4MB ab=0MB gc[major=1/9ms minor=1/4ms incremental=1/1ms]
[mem] heap=38/79MB rss=164MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=40/79MB rss=167MB ext=4MB ab=0MB gc[minor=1/3ms]
⚠️  Binance ticker falhou: Binance ticker failed: https://api.binance.us: cooldown 12s | https://api.binance.com: cooldown 507s
⚠️  Coinbase ticker falhou: Coinbase ticker paused (RSS limit, try later)
⚠️  Kraken ticker falhou: Kraken ticker paused (RSS limit, try later)
[mem] heap=38/78MB rss=179MB ext=4MB ab=0MB gc[major=1/25ms minor=1/5ms incremental=2/2ms]
[loopLag] window=5.0s max=667ms p99=291ms p50=20ms mean=42.3ms
[mem] heap=38/77MB rss=163MB ext=5MB ab=0MB gc[major=1/7ms minor=1/4ms]
[mem] heap=38/77MB rss=163MB ext=4MB ab=0MB gc[minor=1/2ms]
⚠️  Binance klines refresh falhou; mantendo candles em cache: Binance klines failed: https://api.binance.us: cooldown 10s | https://api.binance.com: cooldown 505s
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=40/77MB rss=170MB ext=4MB ab=0MB gc[minor=1/2ms incremental=1/1ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=38/77MB rss=167MB ext=5MB ab=0MB gc[major=2/17ms minor=1/8ms incremental=1/1ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=38/77MB rss=163MB ext=4MB ab=0MB gc[minor=1/2ms]
[mem] heap=39/77MB rss=166MB ext=4MB ab=0MB gc[minor=1/4ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[loopLag] window=5.7s max=994ms p99=141ms p50=20ms mean=29.7ms
[mem] heap=41/80MB rss=178MB ext=4MB ab=0MB gc[major=1/18ms minor=2/13ms incremental=2/5ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=46/85MB rss=225MB ext=4MB ab=0MB gc[major=2/18ms minor=2/10ms incremental=1/1ms]
⚠️  Binance last price refresh falhou; mantendo preço em cache: Binance last price failed: https://api.binance.us: cooldown 4s | https://api.binance.com: cooldown 499s
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=52/92MB rss=253MB ext=5MB ab=1MB gc[major=2/18ms minor=2/14ms incremental=2/5ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Binance ticker falhou: Binance ticker failed: https://api.binance.us: cooldown 2s | https://api.binance.com: cooldown 497s
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=54/93MB rss=252MB ext=4MB ab=0MB gc[major=2/35ms minor=1/6ms incremental=2/4ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Binance klines refresh falhou; mantendo candles em cache: Binance klines failed: https://api.binance.us: Binance klines https://api.binance.us paused (RSS limit, try later) | https://api.binance.com: cooldown 495s
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[loopLag] window=5.6s max=1872ms p99=1872ms p50=873ms mean=1009.4ms
[mem] heap=55/95MB rss=291MB ext=4MB ab=0MB gc[major=3/47ms minor=3/26ms incremental=3/5ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=49/93MB rss=273MB ext=4MB ab=0MB gc[major=1/51ms minor=1/5ms incremental=1/1ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=53/93MB rss=275MB ext=4MB ab=1MB gc[major=2/86ms minor=2/18ms incremental=2/5ms]
[mem] heap=52/94MB rss=262MB ext=4MB ab=0MB gc[major=2/32ms minor=1/6ms incremental=2/5ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[loopLag] window=5.1s max=1607ms p99=1607ms p50=566ms mean=782.8ms
[mem] heap=43/96MB rss=247MB ext=4MB ab=0MB gc[major=2/132ms minor=1/3ms incremental=2/7ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=44/87MB rss=239MB ext=5MB ab=1MB gc[major=2/45ms minor=1/2ms incremental=2/5ms]
⚠️  Binance last price refresh falhou; mantendo preço em cache: Binance last price failed: https://api.binance.us: cooldown 9s | https://api.binance.com: cooldown 489s
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=45/87MB rss=246MB ext=4MB ab=0MB gc[major=1/37ms minor=1/2ms incremental=1/1ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Binance ticker falhou: Binance ticker failed: https://api.binance.us: cooldown 6s | https://api.binance.com: cooldown 486s
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=48/84MB rss=237MB ext=4MB ab=0MB gc[major=1/75ms minor=1/3ms incremental=1/3ms]
[mem] heap=59/93MB rss=287MB ext=4MB ab=1MB gc[major=4/89ms minor=1/10ms incremental=4/8ms]
[loopLag] window=6.4s max=1417ms p99=1417ms p50=321ms mean=488.7ms
⚠️  Binance klines refresh falhou; mantendo candles em cache: Binance klines failed: https://api.binance.us: cooldown 4s | https://api.binance.com: cooldown 484s
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=54/98MB rss=285MB ext=7MB ab=1MB gc[major=3/65ms minor=1/19ms incremental=3/7ms]
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[mem] heap=67/109MB rss=363MB ext=4MB ab=1MB gc[major=4/70ms minor=1/3ms incremental=4/8ms]
[mem] RSS 363MB > limit 320MB — aviso 1/2 (aguardando GC)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
⚠️  Binance last price refresh falhou; mantendo preço em cache: Binance last price failed: https://api.binance.us: Binance last price https://api.binance.us paused (RSS limit, try later) | https://api.binance.com: cooldown 476s
⚠️  Binance ticker falhou: Binance ticker failed: https://api.binance.us: cooldown 15s | https://api.binance.com: cooldown 476s
⚠️  Coinbase ticker falhou: Coinbase ticker paused (RSS limit, try later)
⚠️  Kraken ticker falhou: Kraken ticker paused (RSS limit, try later)
⚠️  Polymarket fetch falhou; usando mercado em cache: Gamma events by series paused (RSS limit, try later)
[loopLag] window=10.9s max=2739ms p99=2739ms p50=2017ms mean=1872.5ms
[mem] heap=76/120MB rss=420MB ext=4MB ab=0MB gc[major=5/139ms minor=3/24ms incremental=6/28ms]
[mem] RSS 420MB > limit 320MB — exiting for restart


### 2026-05-01T00:22:35.085Z - Stop

- Sessao encerrada pelo hook Stop.
