# MEMORY — PolymarketBTC15mAssistant

Arquivo de histórico técnico para rastreamento de bugs, correções e decisões de arquitetura.
Consulte este arquivo antes de depurar comportamentos inesperados.

---

## Sessão: 30/04/2026 — Obsidian como memória do projeto

- Criado vault Obsidian local em `memory/obsidian-vault`.
- Criado hook `scripts/obsidian-memory-hook.mjs` para registrar eventos de chat.
- Registrados hooks do Codex em `/root/.codex/hooks.json` para `SessionStart`, `UserPromptSubmit` e `Stop`.
- O `MEMORY.md` permanece como histórico legado; novas memórias estruturadas devem ser promovidas para o vault, principalmente `20-Decisions/`, `30-Runbooks/` e `40-Incidents/`.
- Instaladas skills Obsidian de `kepano/obsidian-skills`: `defuddle`, `json-canvas`, `obsidian-bases`, `obsidian-cli`, `obsidian-markdown`.
- Adicionados `Sessions.base`, `Project Memory.canvas` e runbook `Session Lifecycle` para conectar sessões no vault.

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

## Sessão: 29/04/2026 — Loop de estabilização RSS (Runs 26 a 30)

### Contexto
Objetivo desta sessão: executar ciclo completo "corrigir -> rodar -> analisar logs -> corrigir" para eliminar o crash por `RSS > 320MB` durante congelamentos com `loopLag` alto.

---

### Ações aplicadas nesta sessão

1. **Fix BP (malloc)** — `scripts/start-clean.mjs`
   - Habilitado jemalloc:
     - `LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2`
     - `MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0`
   - Mantido `MALLOC_ARENA_MAX=1` como fallback.

2. **Fix BQ (pause mais cedo)** — `src/diagnostics/memoryMonitor.js`
   - Janela de pause/resume ajustada para reagir antes da cascata.

3. **Fix BR (análise Postgres durante pause)** — `src/server.js`
   - `computeSimAnalysis()` passou a retornar `null` quando `process._httpPaused=true`.
   - Evita alocação pesada de objetos de análise durante janela crítica de memória.

4. **Fix BS (redução de cardinalidade da análise)** — `src/storage/tradeHistoryStore.js`
   - `listTradeHistoryForAnalysis()` limitado aos **1000** registros resolvidos mais recentes.
   - Query passou a usar subquery `ORDER BY timestamp_ms DESC LIMIT 1000` + ordenação final ASC.

5. **Fix BT (heap alvo menor)** — `scripts/start-clean.mjs`
   - `--max-old-space-size` reduzido de 150 para **100**.

6. **Fix BU (GC explícito ao pausar)** — `src/diagnostics/memoryMonitor.js`
   - Ao ativar `httpPaused`, dispara `global.gc()` (major GC) e loga `http paused: full GC triggered`.

7. **Fix BV/BW (detecção antecipada)** — `src/diagnostics/memoryMonitor.js`
   - Threshold final desta sessão:
     - `HTTP_PAUSE_RSS_MB=168`
     - `HTTP_RESUME_RSS_MB=152`
   - `MEMORY_REPORT_MS` default reduzido para **750ms** (era 2000ms).

8. **Fix BX (fila de host ao pausar)** — `src/net/http.js`
   - Em `_hostRelease()`, quando `process._httpPaused=true`, a fila por host é drenada com rejeição (`resolve(false)`) em vez de admitir próximo request.

9. **Fix BY (abort global em transição de pause)** — `src/net/http.js` + `src/diagnostics/memoryMonitor.js`
   - Adicionado canal de evento `process.emit("httpPauseChanged", <bool>)` no monitor.
   - `http.js` passou a manter `_httpPauseController` global e compor sinal via `AbortSignal.any([...,_httpPauseController.signal])`.
   - Efeito: requests enfileiradas/em progresso recebem abort imediato quando o pause ativa.

---

### Resumo dos runs desta sessão

- **Run 26:** mostrou que mesmo com pause de HTTP, o processo ainda podia escalar RSS por trabalho interno; identificada pressão adicional da análise Postgres.
- **Run 27:** após BR/BS, crash persistiu com salto rápido de RSS em janela curta.
- **Run 28:** mesmo com BT/BU, houve subida brusca após região de threshold (detecção ainda tardia em alguns ciclos).
- **Run 29:** baseline ficou estável por longo período (RSS ~149-156MB), mas ainda ocorreram cascatas tardias.
- **Run 30 (log final desta sessão):**
  - Fase estável longa em ~150MB.
  - Pause ativado cedo em 179MB, com queda parcial para ~160MB.
  - Nova escalada posterior mesmo com sistema em estado de pause (`Gamma ... paused`, Binance/Coinbase/Kraken pausados), chegando a 333MB e saída por limite.

---

### Falha que ainda persiste (estado atual)

**Sintoma persistente:** ainda existe uma cascata tardia de memória/latência que eleva RSS para >320MB mesmo após bloqueio agressivo de HTTP e abort de requisições.

**Assinatura observada no último log:**
- `loopLag` sobe para faixa de ~1.4s-2.4s.
- Sequência de major GCs com duração acumulada alta.
- `heapTotal` cresce junto da crise (ex.: ~95MB -> ~105MB).
- RSS escala para ~331-333MB e o monitor reinicia o processo.

**Leitura técnica atual:**
- O gargalo remanescente não é apenas "novas conexões HTTP".
- Há componente interno de alocação/fragmentação sob freeze (trabalho do loop, buffers e crescimento de heap durante períodos de lag) que ainda consegue sustentar a escalada mesmo em modo degradado com cache.

**Status:** parcialmente mitigado (estabilidade inicial muito melhor), porém **não resolvido**; ainda ocorre restart por `RSS limit` em cenários de lag prolongado.

---

## Sessão: 29-30/04/2026 — Fase 1 Operacional Scalp-Only

### Decisão estratégica

Após 5 runs (26-30 da sessão 29/04) tentando estabilizar RSS via fixes em `http.js` + `memoryMonitor.js` + `chainlink.js`, o problema persiste em cenários de loopLag prolongado. Decidido isolar o operacional crítico do robô (Scalp 5m/15m, DRY+LIVE) num servidor lean (`src/serverScalp.js`), pausando temporariamente todo o resto.

### Entrypoint Fase 1

- `npm run start:scalp` → `src/serverScalp.js` (lean, ~700 linhas)
- `npm start` (server.js completo) — preservado intocado, retomado em Fase 2
- Toggle via env: `ENTRY=scalp npm start` ou `npm start -- --entry=scalp`
- Implementação: `scripts/start-clean.mjs` resolve `entryPath` via `--entry=scalp` flag

### Pausado para Fase 2 (NÃO ESQUECER)

1. **Análises de carteira**
   - `buildTradeHistoryAnalysis`, `refreshAnalysisCache`, `computeSimAnalysis`, `analysisByMode`
   - `listTradeHistoryRecords`, `listTradeHistoryForAnalysis`
   - Endpoint `GET /api/analysis/:tf` retorna 503 em modo Scalp-Only
   - WebSocket action `analyze` retorna estrutura vazia compatível
   - Tabs DRY/SIMULATION do dashboard ficam vazias

2. **Históricos complexos**
   - Dispatch SIM de Top3 5m/15m, Full Consensus, Heiken+OBV, 5+ Agree, Consensus Edge, Delta 3m Fade — desabilitado
   - APENAS Scalp Force registra entradas em CSV + Postgres (`runtime_events` via `persistRuntimeRow`)
   - LIVE Scalp grava em Postgres `trade_history` via `polyTrader._saveHistory()`
   - `backfillSimTradesFromHistory`, `sendCsvReconciliation`, `persistSimCsvTokenColumns` — não importados
   - `minShareRejectedEntryKeys` — não criado (sem dispatch não há rejeição a contabilizar)
   - `simPositions`, `pendingSimResolutions` — não criados

3. **Sincronização de resultados**
   - `processPendingSimResolutions` interval — desligado
   - `polyTrader.refreshTradeResults` interval (60s) — desligado (não chamado pelo runner)
   - `POST /api/resolve-trades` SSE endpoint — retorna 503
   - `pendingSimResolutions` queue — não populada
   - Resolução de outcome canônico (Polymarket settled `outcomePrices`) — Scalp resolve internamente via state machine; sync com Polymarket é Fase 2

4. **Endpoints HTTP omitidos / 503**
   - `GET /api/trade-history` — 503 (cascateava em listTradeHistoryRecords pesado)
   - `POST /api/resolve-trades` — 503
   - `GET /api/analysis/:tf` — 503
   - Modais de reconciliação — sem rota
   - **Novo**: `GET /api/scalp/wallet` — retorna estado in-memory de Scalp 5m + 15m (sem Postgres hit)

5. **Helpers duplicados intencionalmente**
   - `persistRuntimeRow`, `applyScalpTradeToWallet`, `readScalpWalletFromCsv` (versão simplificada — sem trade_history.json lookup)
   - `createPolymarketResolver` simplificado: sem `fetchOrderBook`, sem `ensureEventPagePtb` (PTB direto de `priceToBeatFromMarketWithSource` parsing canônico)
   - Phase 2: extrair para `src/scalp/scalpServerHelpers.js` compartilhado entre os dois servers

### Invariantes a preservar

- Em `serverScalp.js`: NUNCA importar `tradeHistoryAnalysis.js`, `tradeHistoryStore.listTradeHistoryRecords`, nem `simTradeHistoryBackfill.js`. Esses são as fontes primárias de carga.
- Scalp INSERT em Postgres `runtime_events` continua via `insertRuntimeEvent` (gravação leve, ~1 row por trade fechado).
- Scalp LIVE INSERT em Postgres `trade_history` via `polyTrader._saveHistory()` (BUY + SELL = 2 rows por par).
- `fetchOrderBook` e `ensureEventPagePtb` NÃO devem ser chamados em modo Scalp-Only — eliminam 4-6 requests/tick.
- `polyTrader.refreshTradeResults` NÃO é invocado pelo `startEngineRunner` em `serverScalp.js`.
- HTTP_PAUSE_RSS_MB=168 / RESUME=152 / RSS_LIMIT=320 mantidos como rede de segurança em `memoryMonitor.js`, mas devem raramente ativar em modo Scalp-Only.
- Os semáforos HTTP_MAX=2, HOST_MAX=1, HOST_QUEUE=1 em `net/http.js` ficam ativos. Em modo Scalp-Only a carga é tão menor que esses sistemas devem permanecer dormentes.

### Arquivos criados / modificados nesta sessão

| Arquivo | Ação |
|---|---|
| `src/serverScalp.js` | **CRIADO** — entrypoint mínimo Scalp-Only |
| `package.json` | adicionado `npm run start:scalp` (via start-clean) e `npm run scalp` (direto) |
| `scripts/start-clean.mjs` | aceita `--entry=scalp` ou `ENTRY=scalp` env, despacha para serverScalp.js |
| `MEMORY.md` | esta seção adicionada |
| `src/server.js` | **NÃO TOCADO** — preservado para Fase 2 |

### Plano de retomada Fase 2

Quando Scalp-Only estiver estável por 24h+ (RSS estável, zero crashes), retomar:

1. **Análise de carteira** em modo lazy: compute on-demand quando aba é aberta (não em interval), com cache invalidação por mtime do trade_history. Mover `buildTradeHistoryAnalysis` para Worker thread separado.
2. **Dispatch SIM de não-Scalp** via worker thread separado (não bloqueia tick loop). Considerar process isolation via child_process.
3. **Sync de resultados** com Polymarket via cron job externo (`scripts/resolve-pending-trades.mjs` agendado), não via interval no event loop.
4. **Reunificação dos helpers** Scalp em `src/scalp/scalpServerHelpers.js` compartilhado entre os dois servers (eliminar duplicação intencional da Fase 1).
5. **Reavaliar fixes acumulados** em `http.js` (HTTP_MAX_CONCURRENT, HOST_MAX_QUEUE), `memoryMonitor.js` (HTTP_PAUSE_RSS_MB), `chainlink.js` (RPC cooldowns) — alguns podem ser desnecessários sob a carga reduzida do modo Scalp-Only e do trabalho movido para workers.

### 🔴 Bug #20 — Cascade RSS persistente mesmo no Scalp-Only (corrigido 30/04/2026)

**Sintoma observado:** Mesmo com Scalp-Only rodando estável a RSS=144MB por ~4 minutos, uma única conexão TLS pendurada com `clob.polymarket.com` triggava cascata:

```
21:17:08  rss=165MB  inflight[clob=1] connecting[clob=1]   ← TLS handshake abrindo
21:17:10  rss=196MB                                         ← +31MB em 1.7s (TLS context buffer)
21:17:10  http paused (threshold 168MB)
21:17:10  CLOB ERR ttfb=-1 total=2323ms                     ← socket morreu
21:17:13  rss=247MB loopLag mean=680ms                      ← cascata começa
21:17:25  loopLag mean=1064ms
21:17:33  loopLag mean=3223ms
21:17:39  rss=444MB                                         ← processo morto
```

**Root cause:** Cada chamada `fetchClobPrice` aloca ~30MB de TLS context em memória nativa. Quando a clob.polymarket.com fica intermitente (latência variável 100ms-2000ms+), o socket TLS fica pendurado durante o handshake. AbortSignal cancela o JS-level mas o kernel mantém TCP buffer + TLS context por segundos depois. Múltiplos sockets nesse estado intermediário acumulam memória nativa fora do controle do GC. heap V8 fica em 30-40MB enquanto RSS escala para 444MB+.

**Heap V8 estável + RSS escalando = memória nativa fora do GC.** Esta é a assinatura: jemalloc com `dirty_decay_ms:0` deveria liberar, mas o socket ainda em FIN_WAIT/CLOSE_WAIT mantém as páginas alocadas pelo libuv.

**Correção aplicada:** Tirar TODAS as chamadas CLOB do path do tick. Background fetcher fire-and-forget com:
- `_clobCache` — Map de tokenId → { price, fetchedAt }, TTL de 5s
- `_maybeRefreshClobPrice(tokenId)` — fire-and-forget, NUNCA awaitada pelo tick
- Throttle: max 1 fetch por tokenId a cada `POLYMARKET_CLOB_FETCH_INTERVAL_MS` (3s default)
- Dedupe: `_clobInFlight` Set previne 2 fetches concorrentes do mesmo tokenId
- Circuit breaker: 3 falhas consecutivas → suspende fetches por 60s
- Timeout agressivo: 1500ms hardcoded
- **Fallback automático para `gammaPrices`** quando CLOB indisponível

**Arquivo:** `src/serverScalp.js` — função `fetchSnapshot` reescrita:
- Snapshot agora SÓ chama `resolve()` (Gamma /events, cacheado por `polymarketResolveCacheMs`)
- CLOB prices vêm do cache em background, lidos via `_getClobPrice(tokenId)` (sync, instantâneo)
- Se CLOB cache stale ou breaker aberto, usa `gammaPrices` (do `outcomePrices` do Gamma)
- `priceFresh` é true se CLOB OU gamma estiver disponível

**Invariantes a preservar:**
- NUNCA awaitar `_maybeRefreshClobPrice` no path do tick — sempre fire-and-forget
- `_clobCache` é shared entre engines 5m e 15m (Set/Map module-level)
- Quando breaker abrir, `priceSource` será `"gamma"` no payload — frontend deve aceitar
- gammaPrices vêm de `market.outcomePrices` (atualizado a cada Gamma fetch, ~15s)
- Scalp continua operando porque `polymarketPricesFresh = true` quando finalUp/finalDown não são null

**Toggles via env:**
```
POLYMARKET_CLOB_CACHE_TTL_MS=5000
POLYMARKET_CLOB_FETCH_INTERVAL_MS=3000
POLYMARKET_CLOB_FETCH_TIMEOUT_MS=1500
```

---

### 🔴 Bug #21 — Binance `@trade` stream causava cascade RSS no serverScalp (corrigido 30/04/2026)

**Sintoma observado:** Mesmo após Bug #20 (CLOB fora do tick path), a cascata RSS persistia. Pattern:
- RSS estável a 144MB por 4+ minutos
- Subiu gradualmente 144 → 165 → 175MB
- HTTP pause em 168MB não conteve — sockets já abertos continuaram
- Cascada: 175 → 219 → 269 → 309 → 540MB → processo morto pelo limit

Mesmo padrão acontecia EM TODAS as variantes:
- Com CLOB circuit breaker aberto (cascade ainda escala)
- Com Polymarket WS desabilitado (cascade ainda escala)
- Heap V8 sempre estável em 30-50MB → leak é em **memória nativa fora do GC**

**Diagnóstico via isolamento (3 rounds de teste):**

| Round | Config | Resultado |
|---|---|---|
| 1 | TODOS WS desabilitados (HTTP-only) | RSS estável 144MB por 4min ✅ |
| 2 | Só Polymarket WS off (Binance + Chainlink ON) | Cascade em 90s (175→309MB) ❌ |
| 3 | Só Binance WS off (Polymarket + Chainlink ON) | RSS estável 144-147MB por 4min ✅ |

**Conclusão**: `startBinanceTradeStream` é o culpado.

**Root cause:** `@trade` stream do Binance envia CADA execução individual. BTCUSDT recebe 10-50 mensagens/seg em horário ativo. Cada mensagem:
1. Aloca Buffer nativo (libuv, fora do GC do V8)
2. `buf.toString()` cria string nova
3. `JSON.parse(...)` aloca object descartado imediatamente
4. Buffer pool nativo acumula páginas que jemalloc tem dificuldade de liberar quando event loop fica ocupado

Sob alta frequência sustentada (~30 msgs/seg × 24h = 2.5M mensagens/dia), o **Buffer pool nativo** acumula páginas de memória que **NÃO aparecem no heap V8**. Heap snapshot capturado em rss=236MB confirmou: snapshot tinha 47MB total, mas RSS estava 5x maior — leak EXTERNO ao V8.

**Tentativa #1 (FALHOU):** `src/data/binanceWs.js` — trocou `@trade` por `@bookTicker` + throttle 200ms. Resultado: cascade ainda aconteceu (RSS 222→472MB em ~80s). bookTicker reduz frequência mas a conexão TCP/TLS para `stream.binance.com:9443` continua alocando. Hipótese: reconnect loop ou TLS context renegotiation acumula buffers nativos independentemente da frequência de mensagens.

**Correção definitiva aplicada** (`src/serverScalp.js`):

**Binance WS DESABILITADO por DEFAULT.** O tick loop usa `fetchLastPrice` HTTP (1 req/s para `api.binance.us`) — Round 3 do diagnóstico provou que SEM Binance WS o RSS estabiliza em 144-147MB indefinidamente.

```js
const binanceStream = process.env.SCALP_BINANCE_WS === "1"
  ? startBinanceTradeStream({ symbol: CONFIG.symbol })  // opt-in, NÃO recomendado
  : noopStream;  // default: HTTP fetchLastPrice por tick
```

Tradeoff aceito: latência de ~1s no preço Binance (vs real-time WS). Para Scalp Force isso é aceitável porque:
- Já usa `polymarketLiveStream` (WS live) como fonte primária
- `chainlinkStream` (WS+heartbeat) como secundária
- Binance é apenas um de três oracles (Binance/Coinbase/Kraken via getExchangeTickers)
- 1s latência não impacta decisões Scalp que operam em janelas de 5m/15m

**Toggles via env (debug):**
```
SCALP_DISABLE_BINANCE_WS=1   # desliga Binance WS (usa fetchLastPrice HTTP no tick)
SCALP_DISABLE_POLY_WS=1      # desliga Polymarket WS
SCALP_DISABLE_CHAINLINK_WS=1 # desliga Chainlink WS
HEAP_SNAPSHOT_ON_RSS=1       # dump heap snapshot quando RSS atinge HEAP_SNAPSHOT_RSS_MB
HEAP_SNAPSHOT_RSS_MB=220
BINANCE_WS_MIN_UPDATE_MS=200  # throttle defensivo
```

**Lição aprendida:**
- Heap V8 estável + RSS escalando = leak em **memória nativa**. GC não vê.
- WebSocket high-frequency streams são o suspeito principal nesse padrão.
- Heap snapshots NÃO mostram o leak quando ele é em Buffer pool nativo / TLS context / sockets.
- Sempre verificar a frequência de subscription real (`@trade` vs `@bookTicker` vs `@kline`).

**Invariante a preservar:**
- NUNCA assinar streams Binance `@trade` ou similares de alta frequência sem throttle/aggregation
- Se precisar de tick-level data, usar `@aggTrade` (agregado) ou `@kline_1s`
- Para preço atual, `@bookTicker` é suficiente para Scalp (mid de bid/ask)

---

### Verificação esperada

Após `npm run start:scalp` por 5+ minutos:
- `[mem] rss < 200MB` estável (vs 320MB+ no modo completo)
- `[loopLag] max < 200ms` (vs ~6000ms na cascade)
- `[gc] major` raro (<3 por janela de 5s)
- Zero `loop_stalled`
- Cards Scalp Force 5m + 15m com PTB, status, indicadores populados
- Indicadores TA Predict, RSI, MACD, etc. com valores numéricos reais

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

**Problema:** Dependências críticas como `ethers` (`^6.11.1`), `@polymarket/clob-client-v2`, e `viem` usam o prefixo `^`, que permite instalar minor versions mais novas automaticamente. Em um sistema de trading financeiro, uma atualização automática de biblioteca pode introduzir quebras inesperadas.

**Localização:** `package.json`

**Solução sugerida:** Fixar todas as dependências em versões exatas (remover `^`), garantindo reprodutibilidade total. O `package-lock.json` já mitiga o risco localmente, mas fixar no `package.json` é a prática correta para produção financeira.

```json
"dependencies": {
  "@polymarket/clob-client-v2": "1.0.2",
  "viem": "2.28.0",
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

## Sessão: 01/05/2026 — Travamento pós-minutos: zombie sockets HTTP

### 🔴 Bug #22 — `fetchWithTimeout` liberava semáforos antes do socket morrer

**Contexto:** A ação anterior tratou o Binance WS como causa definitiva e desabilitou `startBinanceTradeStream` por default. Isso reduziu a pressão, mas não resolveu o travamento tardio: ainda havia assinatura de RSS >320MB, loopLag alto e major GCs com heap V8 moderado.

**Root cause real remanescente:** `src/net/http.js` usava `Promise.race` dentro de `fetchWithTimeout`. Quando o timeout vencia, o wrapper retornava erro e executava `finally`, liberando os semáforos global/por-host enquanto o `fetch()` real ainda podia estar vivo em background. Resultado: vaga liberada falsa → nova conexão entra → socket/TLS antigo segue segurando memória nativa → cascade RSS.

**Bug adicional no mesmo ponto:** `httpPauseChanged` entrava no `queueSignal`, mas não no `signal` passado ao `fetch()` ativo. O pause global bloqueava novas requisições/fila, mas não abortava requests já em voo.

**Correção aplicada:**
- `src/net/http.js`: removido `Promise.race`; agora `fetchWithTimeout` espera o `fetch()` abortável resolver/rejeitar antes de liberar semáforos.
- `src/net/http.js`: `AbortSignal` ativo agora combina deadline, signal externo e `_httpPauseController.signal`.
- `src/net/http.test.js`: testes cobrindo timeout abortando fetch ativo e pause global abortando fetch ativo.
- `src/data/binance.test.js`: asserção de refresh em background ajustada para aguardar o próximo tick.
- `package.json`: `npm test` serializado com `--test-concurrency=1`, porque a suíte usa mocks globais de `fetch`.

**Validação:**
- `npm test`: 9/9 passou.
- Runtime `npm run start:scalp`: processo `src/serverScalp.js` rodou por vários minutos.
- RSS observado estável em ~141-149MB; heap ~31-39/70-73MB; major GC reduziu RSS em vez de iniciar cascade.
- `httpDebug`: `slow=0 err=0`; sem `loop_stalled`, sem alertas RSS.

**Nota durável:** ver [[40-Incidents/2026-05-01-http-timeout-zombie-sockets|HTTP timeout zombie sockets]] no vault Obsidian.

### 🔴 Bug #23 — `npm start` ainda subia `src/server.js` completo

**Sintoma:** `npm run start:scalp` validava estabilidade, mas `npm run start` ainda reproduzia a cascata. Log do usuário mostrou:
- `Entrypoint: src/server.js`
- RSS 176MB → pause HTTP → 225MB → 253MB → 291MB → 363MB → 420MB
- `loopLag` p99 até ~2739ms
- `RSS 420MB > limit 320MB — exiting for restart`

**Root cause:** A decisão Fase 1 criou `src/serverScalp.js` para isolar só Scalp e pausar o resto, mas `scripts/start-clean.mjs` mantinha `src/server.js` como default. Ou seja, o comando operacional natural (`npm start`) reativava o servidor completo legado e invalidava a validação feita em `npm run start:scalp`.

**Correção aplicada:**
- `scripts/start-clean.mjs`: Scalp-Only (`src/serverScalp.js`) virou default.
- `src/server.js` completo agora é opt-in explícito por `--entry=full`, `ENTRY=full`, `ENTRY=server`, `ENTRY=legacy` ou `ENTRY=web`.
- `package.json`: adicionado `start:full`; `web` passa por `start-clean --entry=full`.

**Validação:**
- `npm test`: 9/9 passou.
- `npm run start` agora mostra `Entrypoint: src/serverScalp.js`.
- Startup observado: RSS 126MB → 138MB, `httpDebug req=16 slow=0 err=0`, sem cascade inicial.

**Nota durável:** ver [[40-Incidents/2026-05-01-npm-start-full-server-cascade|npm start full server cascade]] no vault Obsidian.
