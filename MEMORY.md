# MEMORY — PolymarketBTC15mAssistant

Arquivo de histórico técnico para rastreamento de bugs, correções e decisões de arquitetura.
Consulte este arquivo antes de depurar comportamentos inesperados.

---

## Sessão: 26/04/2026 — Análise e Correções de Bugs

### Contexto
Análise completa do projeto após série de melhorias visuais e funcionais (rename DRY RUN → Scalp Monitor, criação da página Resolve, endpoint SSE `/api/resolve-trades`).

---

### 🔴 Bug #1 — Double `res.end()` em `/api/resolve-trades` (server.js)

**Problema:** Os dois early-returns dentro do bloco `try` do endpoint SSE chamavam `res.end()` e `resolveJobRunning = false` explicitamente, mas o bloco `finally` também executa ambos. Em JavaScript, `return` dentro de `try` **não** impede a execução do `finally`. Resultado: `res.end()` chamado duas vezes (gera warning no Node.js) e `resolveJobRunning = false` redundante.

**Localização:** `src/server.js` — dentro de `app.post("/api/resolve-trades", ...)`

**Correção:** Remover `res.end()` e `resolveJobRunning = false` dos dois early-returns. O bloco `finally` já cobre todos os caminhos.

---

### 🔴 Bug #2 — `pruneOldLogs` não rotaciona `.jsonl` e `.csv` (utils.js)

**Problema:** A função `pruneOldLogs` filtra apenas arquivos `.json`. Arquivos como `engine_watchdog.jsonl`, `snapshots_5m.csv`, `sim_trades_15m.csv`, `scalp_trades_5m.csv`, `signals.csv` crescem indefinidamente sem rotação.

**Localização:** `src/utils.js` — função `pruneOldLogs`

**Correção:** Adicionar `.jsonl` e `.csv` à condição de filtro.

---

### 🟡 Bug #3 — `parseInt` pode retornar `NaN` em `/api/trade-history` (server.js)

**Problema:** Se `req.query.since` chegar como string não-numérica (ex: `"abc"`), `parseInt` retorna `NaN`. A comparação `timestamp >= NaN` é sempre `false`, fazendo com que o filtro não funcione — retorna todos os registros silenciosamente.

**Localização:** `src/server.js` — dentro de `app.get("/api/trade-history", ...)`

**Correção:** Validar explicitamente com `Number.isFinite()` antes de usar o valor.

---

### 🟡 Bug #4 — `.env.example` com entradas malformadas (sintaxe YAML em vez de dotenv)

**Problema:** As últimas linhas do `.env.example` usam `:` (sintaxe YAML/HTTP header) em vez de `=` (dotenv). O `dotenv` ignora silenciosamente essas entradas:
```
RELAYER_API_KEY: <your-api-key>          ← ignorado pelo dotenv
RELAYER_API_KEY_ADDRESS: 0xca6d78...     ← ignorado pelo dotenv
```
**Localização:** `.env.example` — últimas linhas

**Correção:** Substituir `:` por `=`.

---

### 🟡 Bug #5 — `getBtcSession()` com condições redundantes/enganosas (server.js)

**Problema:** Condições com `hour >= 0` são sempre verdadeiras (UTC é 0–23). Verificações duplas tornam o código difícil de ler e manter. Ex: `hour >= 7 && hour < 16 && hour >= 13` é equivalente a `hour >= 13 && hour < 16`.

**Localização:** `src/server.js` — função `getBtcSession()`

**Correção:** Simplificar as condições para expressões diretas, mantendo o comportamento idêntico.

---

### 🟡 Segurança #6 — `.env.example` expõe endereço de wallet real

**Problema:** `POLY_FUNDER_ADDRESS=0x144a773a56753725B3090942378931f6cFf9E546` — endereço real de carteira no arquivo de exemplo que é versionado no git. Qualquer pessoa com acesso ao repositório sabe qual endereço está sendo monitorado.

**Localização:** `.env.example`

**Correção:** Substituir por placeholder genérico `<your-proxy-wallet-address>`.

---

### 🟢 Segurança #7 — XSS potencial em `innerHTML` com dados externos (app.js)

**Problema:** Múltiplos `innerHTML` renderizam campos que vêm indiretamente da API Polymarket (`marketTitle`, `marketSlug`, `explanation`). Embora a API seja confiável, se comprometida poderia injetar HTML malicioso.

**Localização:** `public/app.js` — múltiplas funções de renderização

**Correção:** Adicionar função `esc()` de escape de HTML entities e aplicar em valores de origem externa nos templates `innerHTML`.

---

### 🟢 Segurança #8 — Sem validação de tipos no body de `/api/resolve-trades` (server.js)

**Problema:** O destructuring `const { since = 0, dryRun = false, reprocessAll = false } = req.body || {}` aceita qualquer tipo para `since` (poderia ser objeto, array, string) e não garante que `dryRun`/`reprocessAll` sejam booleanos.

**Localização:** `src/server.js` — dentro de `app.post("/api/resolve-trades", ...)`

**Correção:** Validação explícita de tipo para cada campo.

---

---

## Sessão: 25/04/2026 — Indicadores Top3 + Bug crítico do priceToBeat

### Resumo da sessão

Criação dos indicadores `Top3 15m` (Delta 3m + Heiken Ashi + OBV) e `Top3 5m` (Delta 3m + TA Predict + Bollinger) — entradas só quando os 3 base concordam na mesma direção. Posteriormente identificamos um bug crítico que escrevia vitórias falsas no CSV de simulação.

---

### 🆕 Feature — Indicadores compostos `Top3 15m` e `Top3 5m`

**Localização:** `src/server.js` + `public/dry.js` + `public/dry.css`

- `ALL_INDICATORS` recebe `"Top3 15m"` e `"Top3 5m"`
- `ONLY_15M_INDICATORS = new Set(["Top3 15m"])` — bloqueia no loop 5m
- `ONLY_5M_INDICATORS  = new Set(["Top3 5m"])`  — bloqueia no loop 15m
- `SIM_INDICATORS` filter — checa ambos os Sets antes de incluir o indicador no tick
- Sinais disparam só quando os 3 indicadores base concordam (`UP` ou `DOWN`)
- `buildConfigPayload()` envia `only15mIndicators` e `only5mIndicators` ao frontend
- `buildGrid()` em `dry.js` filtra os arrays para não mostrar indicador na aba errada
- `INDICATOR_TOOLTIPS` map em `dry.js` — tooltip nativo (`title`) explicando a composição de cada indicador composto

### Frontend — UX dos cards

- Grid: `minmax(165px → 200px)` em `.config-indicator-grid`
- `.config-indicator-name` com `min-width: 0` + `nowrap + ellipsis` — nomes como "Full Consensus", "Top3 15m" cabem em uma linha sem quebrar

---

### 🔴 Bug crítico #14 — `priceToBeat` latch contaminado por fallback `chainlinkPrice`

**Sintoma observado:** Operação LIVE no mercado `btc-updown-15m-1777232700` (Top3 15m, DOWN, $0.20 stake) **perdeu** ($-0.20) na Polymarket, mas `sim_trades_15m.csv` linha 2100 gravou **vitória falsa** `DOWN, true, +$19.80`. Divergência total entre `trade_history.json` (correto) e CSV de simulação (errado).

**Root cause:**

- Latch do `priceToBeat` em `src/server.js` (~linha 849-857) sempre se inicializava em **um único tick** com fallback para `chainlinkPrice` quando a API Polymarket não retornava PTB extraível.
- `priceToBeatFromMarket()` em `src/data/polymarket.js` chamava `extractNumericFromMarket` (heurística — varre o objeto procurando keys `/(price|strike|threshold|target|beat)/i`) **antes** de `parsePriceToBeatFromText` (parsing canônico do título).
- Heurística capturava campos numéricos próximos do PTB real (ex: `targetPrice`, `nominalStrike`), latcheando valor errado para o resto do mercado.
- Outcome simulado em `server.js:1344` usa `chainlinkPrice >= priceToBeat ? "UP" : "DOWN"` — com PTB errado, o cálculo dá direção errada.

**Reconstrução numérica:**

- PTB real (do título Polymarket): $78,201.58538
- PTB latched (heurística contaminada): $78,281.80857 (~$80 acima)
- Preço final BTC: $78,239.29
- Cálculo com PTB **real**: 78239.29 ≥ 78201.58 → **UP** ✅ (Polymarket resolveu UP)
- Cálculo com PTB **falso**: 78239.29 < 78281.80 → **DOWN** ❌ (CSV gravou DOWN como vencedor)

**Correção aplicada:**

1. **`src/data/polymarket.js`** — invertida a prioridade em `priceToBeatFromMarket`: título primeiro (`parsePriceToBeatFromText`), heurística como fallback. Adicionada `priceToBeatFromMarketWithSource` que retorna `{ value, source }` com `source ∈ {"title", "walk", null}`.

2. **`src/server.js` (latch ~linha 849-857)** — reescrito o latch:
   - State agora rastreia `source` além de `slug`/`value`
   - Sempre tenta extrair PTB a cada tick — permite **upgrade** de `walk` → `title` quando o título passar a ser parseável
   - **Removido** o fallback para `chainlinkPrice` — se nenhuma fonte legítima estiver disponível, `priceToBeat` permanece `null` e a posição não resolve até PTB válido aparecer
   - Inicialização de `priceToBeatState` agora inclui `source: null`

**Comportamento após o fix:**

- Mercados com PTB extraível pelo título: outcome simulado bate com Polymarket
- Mercados sem título parseável: outcome fica indefinido (`null`) → posição não resolve no rollover, evitando gravação errada
- Heurística walk só é usada se título falhar — e pode ser sobrescrita assim que título virar parseável

---

### 🔴 Bug #15 — Resolução simulada agora consulta `outcomePrices` da Polymarket

**Problema:** `src/server.js` (~linha 1361) calculava `outcome` localmente via `chainlinkPrice >= priceToBeat`, em vez de consultar `outcomePrices` do mercado (única fonte 100% canônica). Combinado com #14, contaminava o CSV mesmo em mercados onde o PTB latched ficou correto.

**Correção aplicada:**

1. **`src/data/polymarket.js`** — adicionada função `resolveMarketOutcome(market)` que retorna `"UP"`, `"DOWN"` ou `null` baseado em `market.closed` + `market.outcomePrices` + `market.outcomes`. Usa `outcomes` para mapear índice → lado (robusto a schema drift).

2. **`src/server.js` (engine state ~linha 692-700)** — adicionado:
   - `pendingSimResolutions` — fila de slugs com posições aguardando resolução
   - `SIM_RESOLUTION_TIMEOUT_MS = 5 * 60 * 1000` — fallback após 5 min
   - `SIM_RESOLUTION_POLL_MS = 30 * 1000` — poll a cada 30s

3. **`src/server.js` (resolver ~linha 740-820)** — adicionadas funções:
   - `finalizeSimResolution(pending, outcome, source)` — escreve a linha no CSV com o outcome final, atualiza `ceWalletBalance`, `resolvedTrades`
   - `processPendingSimResolutions()` — async, com guard `resolverInFlight` para evitar reentrância. Para cada slug pendente: tenta `fetchMarketBySlug` → `resolveMarketOutcome`; se Polymarket não respondeu/não resolveu até timeout, usa `fallbackOutcome` (cálculo local salvo no enqueue)
   - `setInterval(processPendingSimResolutions, SIM_RESOLUTION_POLL_MS)`

4. **`src/server.js` (snapshot ~linha 1361-1380)** — bloco refatorado:
   - Calcula `fallbackOutcome` (chainlink vs PTB) e enfileira em `pendingSimResolutions[slug]` em vez de gravar CSV direto
   - Chama `processPendingSimResolutions()` imediatamente como best-effort (se Polymarket já resolveu, a linha aparece no mesmo tick)
   - `simPositions[marketSlug]` é deletado após o enqueue

**Comportamento agora:**

- Se Polymarket settled o mercado: CSV recebe outcome `polymarket` (canônico)
- Se Polymarket não settled em 5 min: CSV recebe outcome `local_timeout` (fallback)
- Se nenhuma das duas fontes disponível: linha é descartada, log de warning emitido
- Cada resolução loga `✅ [tf] sim resolved <slug> → <outcome> (source=<source>)`

---

### 🔴 Regressão #14b — Scalp Force sem lado por PTB null (corrigida)

**Sintoma observado:** Após aplicar #14 (remoção do fallback `chainlinkPrice` no latch do PTB), os cards Scalp Force passaram a exibir `PTB -` e `bolsas $X.XXX sem lado` permanentemente. A função `advanceScalp` precisa de **algum** PTB de referência para decidir UP vs DOWN; sem PTB, fica em standby.

**Diagnóstico:**

- O fallback original do latch (`priceToBeatState.value = chainlinkPrice`) tinha duplo papel:
  - **Bug** (papel ruim): contaminava a resolução do outcome → vitórias falsas no CSV
  - **Útil** (papel bom): dava ao Scalp Force uma referência estável para escolher lado quando título/heurística falhavam
- Removendo o fallback de uma vez, eliminei o bug mas quebrei o uso legítimo.

**Correção aplicada:**

1. **`src/server.js`** — adicionado latch separado `scalpPtbFallbackState` (slug, value) que latcheia `chainlinkPrice` **uma vez por slug** (estável durante a vela, nunca atualizado mid-candle).

2. **`src/server.js`** — exposta variável `priceToBeatForScalp = priceToBeat ?? scalpFallback`. Usada **apenas** na chamada `advanceScalp(...)`.

3. **`src/server.js`** — outcome resolution e CSV writes continuam usando `priceToBeat` canônico (null se nenhuma fonte legítima — title/walk).

**Garantias:**

- Scalp Force volta a ter referência para decidir lado mesmo quando Polymarket não expõe PTB extraível
- Latch fallback é estável (latcheado uma vez, igual ao comportamento anterior do Scalp), evitando flapping de lado
- Resolução simulada continua usando apenas PTB canônico → não há regressão para o bug original do CSV

---

### 🔴 Bug #16 — `sim_trades_*.csv` agora reconciliado retroativamente

**Problema:** Quando `scripts/resolve-pending-trades.mjs` corrigia um trade LIVE em `trade_history.json`, a linha equivalente em `sim_trades_*.csv` (mesmo `marketSlug` + `indicator` + `mode=LIVE`) ficava errada. As duas verdades conviviam em arquivos diferentes — a UI prioriza a CSV, mostrando carteira simulada inflada.

**Correção aplicada:**

1. **`scripts/resolve-pending-trades.mjs`** — adicionada função `reconcileSimCsvs(correctedTrades)`:
   - Indexa correções por `${marketSlug}|${indicator}` para lookup O(1)
   - Para cada `sim_trades_*.csv` (5m e 15m), varre linhas `mode=LIVE`
   - Se outcome diverge da verdade da Polymarket, recalcula usando a mesma fórmula do server (`shares = stake / entry_price`, `pnl = returned - stake`)
   - Cria backup `.backup-<timestamp>.csv` antes de reescrever
   - Respeita `--dry-run` (não persiste)

2. Chamada após o save do `trade_history.json` no `main()` — só roda se houve trades corrigidos.

**Uso:**

- `node scripts/resolve-pending-trades.mjs` — resolve pendentes + reconcilia CSVs
- `node scripts/resolve-pending-trades.mjs --dry-run` — só mostra o que seria corrigido
- `node scripts/resolve-pending-trades.mjs --all` — reprocessa todos os trades (também aciona reconciliação retroativa)

---

## Memórias do projeto (auto-memory persistente)

- **`Top3 15m`** — Delta 3m + Heiken Ashi + OBV concordando; criado 2026-04-25; aguardando 30+ trades sim antes de LIVE
- **`Top3 5m`** — Delta 3m + TA Predict + Bollinger concordando; criado 2026-04-25; mesmo critério de validação
- **`Delta 3m`** é aposta de cauda intencional — não ajustar `stake/minSharesFloor`; rejeições são parte do design (1x/dia paga ~$999 sobre $1)

---

## Sessão: 27/04/2026 — Diagnóstico e Correção de Travamento + Crash Fatal

### Contexto
A aplicação travava após ~2 minutos de execução ("Loop principal sem finalizar há Xs") e depois crashava com `Error: CLOB price timeout after 4000ms` não tratado, encerrando o processo Node.js.

---

### 🔴 Bug #17 — Loop principal trava por reentrada de ticks concorrentes

**Sintoma observado:** `engine_watchdog.jsonl` registrava `loop_stalled` com `ageMs` entre 6000–18000ms recorrentemente. A causa era tick anterior ainda em execução quando o próximo era disparado, causando empilhamento de chamadas assíncronas.

**Root cause:**
- O watchdog dispara tick a cada segundo; se uma iteração demora (latência Binance/Polymarket), o próximo tick começa antes do anterior terminar.
- Binance.com entrava em cooldown → failover para `api.binance.us` → 2× `httpTimeoutMs` de espera (8s total).
- `polymarket.snapshot` podia demorar até 32s em casos extremos por fetch CLOB sem budget.

**Localização:** `src/server.js` — `createTimeframeEngine()` e loop principal; `src/data/binance.js` — `fetchBinanceJson()`; `src/config.js`

**Correções aplicadas:**

1. **Guard de reentrada de tick** (`tickInFlightPromise`) em `src/server.js`:
   - State `let tickInFlightPromise = null` por timeframe
   - Se tick anterior ainda está em execução, o novo tick retorna `lastPayload` (stale) imediatamente sem criar nova execução concorrente
   - Log `tick_reentry_blocked` no watchdog para diagnóstico
   - `tickInFlightPromise = null` no `finally` do wrapper

2. **Budget total de failover da Binance** em `src/data/binance.js`:
   - Nova variável `CONFIG.binanceFailoverBudgetMs` (padrão: 7000ms, env: `BINANCE_FAILOVER_BUDGET_MS`)
   - O loop de failover entre `api.binance.com` e `api.binance.us` tem um deadline absoluto — se o budget esgotar, interrompe sem tentar endpoints restantes

3. **Budget de enriquecimento CLOB no snapshot** em `src/server.js`:
   - Nova variável `CONFIG.polymarketSnapshotClobBudgetMs` (padrão: 1000ms, env: `POLYMARKET_SNAPSHOT_CLOB_BUDGET_MS`)
   - `fetchSnapshot()` faz `Promise.race([clobEnrichment, timeoutAfter(budget)])` — se os fetches CLOB demoram mais que o budget, o snapshot retorna usando apenas preços Gamma sem CLOB enrichment

4. **Debounce de gravação do `trade_history.json`** em `src/polyTrader.js`:
   - Substituído save síncrono a cada trade por flush em lote (debounce), reduzindo bloqueio do event loop durante burst de operações

---

### 🔴 Bug #18 — Crash fatal por `unhandledRejection` do CLOB timeout

**Sintoma observado:** Após aplicar o budget CLOB, a aplicação passou a crashar com:
```
Error: CLOB price timeout after 4000ms
    at fetchWithTimeout (src/net/http.js:16:13)
    at runNextTicks (node:internal/process/task_queues:64:5)
    at listOnTimeout (node:internal/timers:547:9)
    at async fetchClobPrice (src/data/polymarket.js:262:15)
    at async Promise.all (index 0)
```

**Root cause:**
- `fetchSnapshot()` usa `Promise.race([clobEnrichment, timeoutAfter(budget)])`.
- Quando o budget (1000ms) vence o race, o `clobEnrichment` (`Promise.all` com 4 fetches CLOB) continua rodando em background.
- Os fetches CLOB individualmente têm `httpTimeoutMs = 4000ms`. Quando expiram, cada um rejeita com `Error: CLOB price timeout after 4000ms`.
- Como o `Promise.all` "perdeu" o race e ninguém mais aguarda sua resolução/rejeição, as rejeições ficam sem handler — o Node.js as trata como `unhandledRejection` e encerra o processo por padrão (comportamento a partir do Node 15+).

**Localização:** `src/server.js` — `fetchSnapshot()` dentro de `createPolymarketResolver()`

**Correções aplicadas:**

1. **Silenciar rejeições do `clobEnrichment` abandonado** em `src/server.js`:
   ```js
   const clobEnrichment = Promise.all([...]);
   // Prevent unhandled rejection if this Promise.all loses the race below
   clobEnrichment.catch(() => {});
   ```
   O `.catch(() => {})` registra um handler vazio imediatamente, garantindo que qualquer rejeição futura dos fetches pendentes seja absorvida silenciosamente.

2. **Handler global `process.on('unhandledRejection', ...)`** em `src/server.js` (antes do `server.listen`):
   ```js
   process.on("unhandledRejection", (reason) => {
     const msg = reason instanceof Error ? reason.message : String(reason);
     logEngineDiagnostic("unhandled_rejection", { message: msg });
     console.error("[unhandledRejection] swallowed:", msg);
   });
   ```
   Segunda linha de defesa: qualquer rejeição não tratada futura é logada via `logEngineDiagnostic` (aparece em `engine_watchdog.jsonl`) sem encerrar o processo.

**Invariante a preservar:** O `clobEnrichment.catch(() => {})` deve ser adicionado **imediatamente após** criar o `Promise.all`, antes do `Promise.race`. Se o race for refatorado no futuro, garantir que as promessas internas sempre tenham um handler de erro registrado quando há possibilidade de serem abandonadas.

---

## Sessão: 27/04/2026 (tarde) — Degradação por timeouts simultâneos

### Sintoma
Logs mostravam todos os endpoints externos expirando ao mesmo tempo:
- `api.binance.com` timeout 4000ms → cooldown 15s
- `api.binance.us` timeout ~980ms (sobra do `binanceFailoverBudgetMs=5000` após o primeiro)
- Coinbase / Kraken tickers timeout 4000ms
- Gamma events timeout 4000ms
- `client.event_loop_lag: 1943ms` no client SSE
- Loops contínuos de 5s → sensação de "travamento"

### Diagnóstico
1. **Causa primária externa:** rede local degradada — VPN/DNS/ISP bloqueando ou lento. App não crasha (cache fallback do Bug #17 funciona), mas degrada visivelmente.
2. **Causa secundária no código:** `binanceFailoverBudgetMs=5000` deixava só ~1s para o segundo endpoint após o primeiro consumir 4s — failover sempre falhava.
3. **Causa terciária (Melhoria #11):** `writeTradeHistoryFileAtomic` usava `fs.writeFileSync` síncrono no flush debounced → bloqueava event loop em bursts de trade.

### Correções aplicadas

1. **`src/config.js`** — `binanceFailoverBudgetMs` default 5000 → **9000ms** (> 2× `httpTimeoutMs` para o segundo endpoint ter chance real).

2. **`.env.example`** — adicionados `BINANCE_FAILOVER_BUDGET_MS=9000`, `POLYMARKET_SNAPSHOT_CLOB_BUDGET_MS=1500`, `TRADE_HISTORY_SAVE_DEBOUNCE_MS=250` para tornar os tunables visíveis.

3. **`src/tradeHistoryMerge.js`** — adicionada `writeTradeHistoryFileAtomicAsync` usando `fs.promises.writeFile` + `fs.promises.rename`. A versão síncrona foi mantida (compatibilidade com outros consumidores se houver).

4. **`src/polyTrader.js`** — `_flushHistoryNow` agora `async` e usa o writer assíncrono. `_scheduleHistoryFlush` aguarda o flush via `await`. `_saveHistory()` continua síncrono na chamada (apenas agenda o timer).

### Verificação ANTES de mexer em código novamente
Sempre testar conectividade primeiro — se `curl -m 5 https://api.binance.com/api/v3/ping` falhar do shell do usuário, **nenhuma mudança no código resolve**. O problema está na rede/firewall/VPN.

---

## Sessão: 28/04/2026 — Chainlink real-time + Sistema de debug HTTP/event-loop

### Contexto
Falhas massivas de timeout em todos os endpoints externos (Chainlink RPC, Binance, Coinbase, Kraken, Polymarket Gamma) com loops continuamente `loop_stalled`. Usuário pediu ação definitiva e atualização em tempo real dos dados Chainlink.

### Diagnóstico inicial — conectividade direta do host

| Endpoint | Status | Diagnóstico |
|---|---|---|
| `polygon-rpc.com` (POST JSON-RPC) | 401 | passou a exigir API key |
| `polygon.llamarpc.com` | DNS/connect fail | inalcançável daqui (gastava 1.5s/tick em timeout) |
| `rpc.ankr.com/polygon` | 200 com body "Unauthorized" | exige API key |
| `polygon-bor-rpc.publicnode.com` | 200 (~100ms) | ✅ HTTP + WSS sem auth |
| `polygon.drpc.org` | 200 (~150ms) | ✅ HTTP + WSS sem auth |
| `api.binance.com` | 451 | geo-blocked (tratado em outra sessão) |
| `gamma-api.polymarket.com` | 200 (264ms) curl | OK em isolado, falha sob carga |

---

### 🔴 Bug #19 — Chainlink WS stream nunca subscrevia (POLYGON_WSS_URLS vazio)

**Sintoma:** `chainlinkStream.getLast()` sempre retornava null → tick loop caía no fallback HTTP `fetchChainlinkBtcUsd()` a cada segundo, gastando 3-7s por tick com RPCs quebrados consumindo timeout serial. Watchdog logava `slow_step chainlink.price durationMs=3000-7000`.

**Root cause:**

1. `src/data/chainlinkWs.js` já tinha infra completa de `eth_subscribe` para `AnswerUpdated`, mas o factory retornava no-op stub se `wssUrls.length === 0` — e `POLYGON_WSS_URLS` não estava no `.env`.
2. RPCs default em `src/data/chainlink.js` (`polygon-rpc.com`, `rpc.ankr.com/polygon`, `polygon.llamarpc.com`) tinham **0/3** funcionando sem API key em 2026-04.
3. `polygonRpcUrl` default em `src/config.js` era o quebrado `polygon-rpc.com`, sempre incluído no candidate list mesmo com `POLYGON_RPC_URLS` setado.

**Correções aplicadas:**

1. **`.env`** — bloco novo:
   ```
   POLYGON_RPC_URLS=https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org
   POLYGON_WSS_URLS=wss://polygon-bor-rpc.publicnode.com,wss://polygon.drpc.org
   CHAINLINK_HTTP_HEARTBEAT_MS=10000
   ```

2. **`src/data/chainlink.js`** (`getRpcCandidates`) — defaults trocados para os endpoints validados; removidos polygon-rpc.com, ankr e llamarpc.

3. **`src/config.js`** — `polygonRpcUrl` default mudado de `"https://polygon-rpc.com"` para `""` (sem fallback no quebrado).

4. **`src/data/chainlinkWs.js`** — adicionado **heartbeat HTTP** de 10s integrado ao stream:
   - Importa `fetchChainlinkBtcUsd` de `./chainlink.js`
   - `runHeartbeat()` chama `fetchChainlinkBtcUsd()` e popula `lastPrice` se WS estiver parado por mais que `WS_FRESHNESS_WINDOW_MS` (30s)
   - `startHeartbeat()` faz seed imediato + `setInterval(runHeartbeat, HTTP_HEARTBEAT_MS).unref()`
   - Factory agora roda heartbeat mesmo se `wssUrls.length === 0` — só retorna stub se `aggregator` estiver missing
   - WS message handler marca `lastSource = "chainlink_ws"`; heartbeat marca `"chainlink_http"` — getLast() expõe a fonte real

**Comportamento agora:**

- Stream sobe → seed em ~180ms → `getLast()` já retorna preço real
- Tick loop em `src/server.js:1143-1144` toma sempre o ramo `chainlinkLivePrice !== null` → `chainlink.price` step ~0ms
- Se WS pushar `AnswerUpdated`, vira fonte primária por 30s; se cair, heartbeat segura
- `fetchChainlinkBtcUsd()` HTTP só executa via heartbeat (a cada 10s, com cache interno de 2s no próprio módulo)

**Invariante a preservar:** `chainlinkWs.js` importa de `chainlink.js`, não o contrário. Não criar ciclo. O `cachedFetchedAtMs`/`MIN_FETCH_INTERVAL_MS=2000` em `chainlink.js` é o que torna seguro chamar `fetchChainlinkBtcUsd()` em alta frequência (heartbeat + fallback do tick loop coexistem sem dobrar tráfego).

---

### 🟡 Diagnóstico em andamento — timeouts escalando após fix Chainlink

**Sintoma residual:** Mesmo com Chainlink corrigido, `polymarket.snapshot` continua expirando com pattern **escalando** 5s → 7s → 8s → 9s entre ticks consecutivos. Coinbase/Kraken também timeout 4s, mas `curl -m 5` direto resolve em <300ms.

**Reprodução isolada (4 URLs × 9 ticks/seg = 36 reqs em 9s):** ZERO timeouts. Confirma que problema é **dentro do processo Node**, não rede.

**Hipóteses ranqueadas:**
1. Event-loop bloqueado (CPU sync work em parsing JSON gigante, indicators math, GC pauses) — `setTimeout` do timeout não dispara porque loop está parado
2. DNS thread pool do libuv esgotado (default 4 threads) — `EAI_AGAIN` flagado em smoke test
3. Undici socket pool/agent fila

---

### 🆕 Sistema de debug HTTP + event-loop

**Arquivos criados:**

- **`src/diagnostics/eventLoopMonitor.js`** — `perf_hooks.monitorEventLoopDelay({ resolution: 20 })`. Loga max/p99/p50/mean por janela de 5s quando max ≥ `EVENT_LOOP_WARN_MS` (default 200ms). Histograma resetado a cada janela.

- **`src/diagnostics/httpDebug.js`** — subscribe via `node:diagnostics_channel` aos eventos undici:
  - `undici:request:create` / `:headers` / `:trailers` / `:error` — per-request timing (total + TTFB) por `WeakMap<request, entry>`
  - `undici:client:beforeConnect` / `:connected` / `:connectError` — DNS/connect lifecycle, contador `socketsConnecting` por origin
  - In-flight counter por origem (Map); relatório periódico a cada 5s logando `req=N slow=N err=N inflight[...] connecting[...]`
  - Loga `[httpDebug] SLOW/ERR <method> <origin><path> total=Xms ttfb=Yms` quando request ≥ `HTTP_DEBUG_SLOW_MS` (default 1500ms) ou erro
  - `getHttpDebugSnapshot()` exportado para futuro endpoint de health

**Plugado em `src/server.js:12-19`** (logo após `dotenv/config`, antes de qualquer import que faça HTTP). Crítico: subscribe deve preceder o primeiro request senão a primeira janela perde eventos.

**Toggles via env (default ON):**
```
HTTP_DEBUG=0                   # desliga (qualquer valor != "0" liga)
HTTP_DEBUG_SLOW_MS=1500
HTTP_DEBUG_REPORT_MS=5000
EVENT_LOOP_DEBUG=0             # desliga
EVENT_LOOP_WARN_MS=200
EVENT_LOOP_RESOLUTION_MS=20
EVENT_LOOP_REPORT_MS=5000
```

**Smoke test confirmou:** instrumentação detecta `EAI_AGAIN`, captura SLOW requests com TTFB ≈ total, mede event-loop block injetado de 350ms (loga max=377ms na janela). Subscribe via `safeSubscribe()` com try/catch — falhas em channels inexistentes são silenciosas, nunca quebram o processo.

**Heurística de diagnóstico (a aplicar quando logs do app real chegarem):**
1. `[loopLag] max=2000ms+` sincronizado com timeouts → event-loop bloqueado → identificar trabalho síncrono pesado nos ticks
2. `[httpDebug] connectError ... EAI_AGAIN` repetido → DNS pool esgotado → fix: `UV_THREADPOOL_SIZE=16` em `.env`/`NODE_OPTIONS`, considerar `cacheable-lookup`
3. `[httpDebug] inflight[origin=20+]` com baixo `req=` delta → fila de sockets undici → fix: configurar Agent customizado com `connections` maior + `pipelining`
4. TTFB ≈ total alto → servidor remoto realmente lento → fix: circuit breaker / aumentar timeout / backoff
5. loopLag baixo, sem connectError, TTFB OK → race do `fetchWithTimeout` disparando antes da resposta natural completar — sintoma é falso positivo, ajustar timeout

**Invariante a preservar:** Os módulos diagnostic devem ser **opt-out**, nunca lançar exceção que quebre o host. Toda subscribe envolvida em try/catch. Timers via `.unref()` para não segurar exit.

---

## Melhorias Pendentes (ainda não aplicadas)

### 🟡 Melhoria #9 — `resolve-pending-trades.mjs` sem timeout no `fetch`

**Problema:** A função `fetchJson()` usa `fetch()` puro sem `AbortController`. Se a API Polymarket não responder, o script trava indefinidamente.

**Localização:** `scripts/resolve-pending-trades.mjs` — função `fetchJson()`

**Solução sugerida:** Usar `AbortController` com `setTimeout` (mesmo padrão de `src/net/http.js` — `fetchWithTimeout`).

```js
async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}
```

---

### 🟡 Melhoria #10 — Lógica de resolução duplicada em dois lugares

**Problema:** A resolução via Gamma slug + CLOB midpoint está implementada identicamente em `src/server.js` (dentro de `app.post("/api/resolve-trades")`) e em `scripts/resolve-pending-trades.mjs`. Uma mudança em um não reflete no outro — risco de divergência.

**Localização:** `src/server.js` ~linha 1700 e `scripts/resolve-pending-trades.mjs`

**Solução sugerida:** Extrair a lógica de resolução para um módulo compartilhado, ex: `src/utils/resolveMarket.mjs`, com as funções `resolveViaSlug(slug)` e `resolveViaTokenMidpoint(tokenId)`. Ambos os arquivos importam desse módulo.

---

### 🟡 Melhoria #11 — `_saveHistory()` usa `writeFileSync` em contexto assíncrono (polyTrader.js)

**Problema:** Toda operação de trade chama `_saveHistory()` que usa `writeFileSync`, bloqueando o event loop do Node.js durante a escrita. Em modo LIVE com múltiplos indicadores disparando simultaneamente, isso pode causar latência perceptível no WebSocket e no loop de tick.

**Localização:** `src/polyTrader.js` — métodos `_saveHistory()`, `placeTrade()`, `resolveScalpPair()`, `refreshTradeResults()`

**Solução sugerida:** Substituir `writeFileSync` por `writeFile` assíncrono com um flag de escrita pendente para evitar gravações concorrentes:

```js
_saveHistory() {
  if (this._savePending) return; // já tem gravação agendada
  this._savePending = true;
  fs.writeFile(this._historyPath, JSON.stringify(this.orderHistory, null, 2), () => {
    this._savePending = false;
  });
}
```

**Atenção:** Preservar o comportamento de "write-via-rename via tmp" para segurança dos dados.

---

### 🟢 Melhoria #12 — `minShareRejectedEntryKeys` cresce sem limite (server.js)

**Problema:** O `Set` `minShareRejectedEntryKeys` acumula chaves `${marketSlug}:${name}:${side}` sem nunca ser limpo. Após semanas de operação, acumula centenas de entradas em memória.

**Localização:** `src/server.js` — dentro de `createTimeframeEngine()`, ~linha 686

**Solução sugerida:** Limpar o Set no rollover de candle (quando `marketSlug` muda), junto com a limpeza de `simPositions`:

```js
// Na detecção de novo slug/candle:
if (snapshotSavedForSlug !== null && snapshotSavedForSlug !== marketSlug) {
  minShareRejectedEntryKeys.clear(); // limpa no rollover
}
```

---

### 🟢 Melhoria #13 — `package.json` com versões `^` (semver permissivo)

**Problema:** Dependências críticas como `ethers` (`^6.11.1`) e `@polymarket/clob-client` (`^5.8.1`) usam o prefixo `^`, que permite instalar minor versions mais novas automaticamente. Em um sistema de trading financeiro, uma atualização automática de biblioteca pode introduzir quebras inesperadas.

**Localização:** `package.json`

**Solução sugerida:** Fixar todas as dependências em versões exatas (remover `^`), garantindo reprodutibilidade total. O `package-lock.json` já mitiga o risco localmente, mas fixar no `package.json` é a prática correta para produção financeira.

```json
"dependencies": {
  "@polymarket/clob-client": "5.8.1",
  "ethers": "6.11.1",
  ...
}
```

---

## Arquitetura — Decisões importantes

### Nomenclatura funcional preservada
Os termos `dryRun`, `t.dryRun`, `tradeRecord.status = "dry_run"`, `POLY_DRY_RUN`, `DRY_${Date.now()}` são **código funcional** — NÃO renomear. Apenas labels visíveis ao usuário foram alterados para "Scalp Monitor / SIM".

### Resolução de trades — duas estratégias
1. **Gamma API** via `GET /events?slug=<marketSlug>` — preferencial, retorna `outcomePrices: ["1","0"]` ou `["0","1"]` quando resolvido
2. **CLOB midpoint** via `GET /midpoint?token_id=<tokenId>` — fallback, retorna `mid: 1` (ganhou) ou `mid: 0` (perdeu)

### Auto-resolução LIVE (60s)
`polyTrader.refreshTradeResults()` roda a cada 60s no loop principal mas **apenas para trades LIVE** (`!t.dryRun`). Trades SIM não são auto-resolvidos — apenas pela página Resolve ou pelo script CLI.

### Backup automático antes de salvar
Antes de sobrescrever `trade_history.json`, o sistema cria `trade_history.backup-<timestamp>.json`. NÃO deletar backups sem confirmar que o arquivo principal está correto.

### Config persistida
`logs/trading_config.runtime.json` — salvo com write-via-rename (`.tmp` → rename) para atomicidade. Carregado automaticamente no startup do servidor.

### Scalp Force isolado
O Scalp Force tem seu próprio state machine (`scalpRuntime`) completamente separado de `simPositions`. Nunca inserir lógica de Scalp no loop `SIM_INDICATORS` — eles têm fluxos de deduplicação e dispatch diferentes.
