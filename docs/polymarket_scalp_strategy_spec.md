# Polymarket Scalp Force 5m/15m - Especificacao Reversa

Data da extracao: 2026-05-01.

Escopo estrito: implementacao ativa no repositorio atual, com entrypoint operacional `src/serverScalp.js`, motor `src/engines/scalpForce.js`, executor `src/polyTrader.js` e override salvo em `logs/trading_config.runtime.json`.

## 1. Visao Geral

A estrategia ativa se chama `Scalp Force` e roda em dois timeframes:

- `Scalp Force 5m`
- `Scalp Force 15m`

O motor e uma maquina de estados por timeframe:

```text
idle -> armed -> in_position -> closed_*
```

O estado e reiniciado quando o slug do mercado muda. Se houver posicao aberta no rollover do candle, o motor calcula um fechamento por expiracao local:

```text
outcome = currentPrice >= priceToBeat ? UP : DOWN
exitPrice = won ? 1 : 0
```

## 2. Configuracao Ativa

Fonte ativa dos parametros: `logs/trading_config.runtime.json`.

Observacao: `src/serverScalp.js` tambem define defaults internos, mas na inicializacao chama `loadPersistedTradingConfig()` e mescla o runtime JSON. Portanto, estes valores abaixo sao os que representam a parametrizacao salva/ativa agora.

| Parametro | Scalp Force 5m | Scalp Force 15m |
|---|---:|---:|
| enabled | true | true |
| liveMode | false | false |
| stakeUsd | 5 | 5 |
| entryMinPct | 51 | 51 |
| entryMaxPct | 55 | 55 |
| takeProfitPct | 75 | 75 |
| minExitPct | 58 | 58 |
| tpExitMode | trail | trail |
| tpTrailCents | 2 | 2 |
| tpForceExitEnabled | true | true |
| tpForceFailTicks | 2 | 2 |
| trailingArmingCents | 1 | 3 |
| trailingCushionCents | 3 | 5 |
| maxEntriesPerCandle | 5 | 5 |
| entryOpenWindowSec | 300 | 900 |
| maxHoldSec | 300 | 900 |
| minSharesFloor | 5 | 5 |
| maxEffectiveStakeUsd | 10 | 10 |

Parametros usados pelo motor, mas ausentes no runtime/default de `serverScalp.js`, portanto caem no fallback hardcoded de `scalpForce.js`:

| Parametro | Fallback |
|---|---:|
| decayStopCushionUsd | 30 |
| hardStopCushionCents | 15 |
| hardStopGraceSec | 20 |

## 3. Engenharia Reversa da Entrada

### 3.1 Direcao

O motor usa a mediana das bolsas contra o Price to Beat:

```text
direction = exchangeMedian >= priceToBeat ? UP : DOWN
```

`exchangeMedian` vem da mediana dos precos de Binance, Coinbase e Kraken disponiveis em `src/serverScalp.js`.

`priceToBeatForScalp` vem do PTB oficial quando disponivel. Se nao houver PTB oficial, `serverScalp.js` usa um fallback latched por slug com o primeiro `chainlinkPrice` visto naquele mercado.

### 3.2 Confirmacao de forca

O contrato esperado por `src/engines/scalpForce.js` e:

```text
5m  exige: Heiken+OBV == direction AND 5+ Agree == direction
15m exige: Heiken+OBV == direction AND 5+ Agree == direction AND Delta 3m == direction
```

Nao ha pesos numericos no Scalp Force. A logica e booleana: todos os sinais exigidos precisam concordar.

Importante: no entrypoint ativo `src/serverScalp.js`, o objeto `simSignals` enviado ao motor contem objetos brutos (`heikenAshi`, `obv`, `delta`, etc.), mas nao monta as chaves string `"Heiken+OBV"`, `"5+ Agree"` e `"Delta 3m"`. Assim, pela implementacao ativa, `strengthAgrees()` tende a falhar e bloquear entrada. No `src/server.js` legado existe a montagem dessas chaves, mas esse nao e o entrypoint operacional default atual.

### 3.3 Banda de entrada

Depois de direcao e forca:

```text
contractPrice = direction == UP ? marketPriceUp : marketPriceDown
contractPct = contractPrice * 100
inBand = entryMinPct <= contractPct <= entryMaxPct
withinWindow = candleElapsedMs <= entryOpenWindowSec * 1000
```

Entrada so ocorre se:

```text
enabled == true
Polymarket current price fresh == true
Polymarket contract prices fresh == true
direction resolvida
forca confirma direction
withinWindow == true
inBand == true
stake efetivo valido
```

### 3.4 Stake efetivo

O motor calcula:

```text
floorUsd = minSharesFloor * contractPrice
effectiveStakeUsd = max(stakeUsd, floorUsd)
shares = effectiveStakeUsd / contractPrice
```

Se `effectiveStakeUsd > maxEffectiveStakeUsd`, a entrada fica armada, mas bloqueada.

## 4. Gestao de Posicao e Saidas

Ao entrar:

```text
entryPrice = contractPrice
targetPrice = takeProfitPct / 100
minExitThreshold = minExitPct / 100
deadlineAt = nowMs + maxHoldSec * 1000
entrySignedDelta = direction == UP
  ? currentPrice - priceToBeat
  : priceToBeat - currentPrice
```

### 4.1 Take-profit

```text
reached = contractPct >= takeProfitPct
```

Com `tpExitMode: exit`, fecha imediatamente com `exitReason = tp_hit`.

Com `tpExitMode: trail` ativo no runtime atual:

```text
tpArmed = reached || tpArmed
tpTrailStopPct = maxContractPctSinceEntry - tpTrailCents
trailHit = contractPct <= tpTrailStopPct
```

Se `trailHit`, fecha com `exitReason = tp_trailing_stop`.

### 4.2 TP force-fail

Quando TP esta armado em modo `trail`, o motor monitora se a forca ainda concorda:

```text
stillStrong = strengthAgrees(direction, signals, timeframe)
tpForceFailCount = stillStrong ? 0 : tpForceFailCount + 1
forceFail = tpForceFailCount >= tpForceFailTicks
```

Se `forceFail`, fecha com `exitReason = tp_force_fail`.

### 4.3 Decay stop

O decay stop usa o deslocamento do spot contra o PTB:

```text
currentSignedDelta = direction == UP
  ? currentPrice - priceToBeat
  : priceToBeat - currentPrice

decayThreshold = entrySignedDelta - decayStopCushionUsd
decayTriggered = currentSignedDelta < decayThreshold
```

Se acionar:

```text
exitReason = contractPct >= minExitPct
  ? decay_stop_min_exit
  : decay_stop_force_exit
```

### 4.4 Trailing stop geral

Arma somente depois do contrato andar a favor:

```text
armingThreshold = entryPct + trailingArmingCents
trailingArmed = contractPct >= armingThreshold
trailingStopPct = maxContractPctSinceEntry - trailingCushionCents
trailingTriggered = trailingArmed && contractPct <= trailingStopPct
```

Se acionar, fecha com `exitReason = trailing_stop`.

### 4.5 Hard stop

Protecao de colapso apos grace period:

```text
hardStopThresholdPct = entryPct - hardStopCushionCents
hardStopReady = holdSec >= hardStopGraceSec
hardStopTriggered = hardStopReady && contractPct <= hardStopThresholdPct
```

Se acionar, fecha com `exitReason = hard_stop`.

### 4.6 Timeout e hold favoravel

No vencimento do hold interno:

```text
expired = nowMs >= deadlineAt
btcMoreFavorable = currentSignedDelta > entrySignedDelta
contractNotWorsen = contractPct >= entryPrice * 100
```

Se `expired && btcMoreFavorable && contractNotWorsen`, entra em hold favoravel e nao fecha. A cada tick, se alguma condicao falhar, fecha:

```text
exitReason = contractPct >= minExitPct
  ? timeout_min_exit
  : timeout_force_exit
```

### 4.7 PnL interno do scalp

O snapshot fechado usa:

```text
returned = shares * exitPrice
pnlUsd = returned - effectiveStakeUsd
holdSeconds = (exitAt - entryAt) / 1000
```

## 5. Execucao Polymarket

### 5.1 Entrada LIVE/SIM

`src/serverScalp.js` dispara `polyTrader.placeTrade()` quando o runtime muda para `in_position`.

```text
side = BUY
price = runtime.entryPrice
sizeUsd = runtime.effectiveStakeUsd || runtime.stakeUsd || config.stakeUsd
tokenId = UP ? upTokenId : downTokenId
forceLive = config.liveMode
```

Como `liveMode` esta `false` para 5m e 15m, o modo ativo salvo e monitor/simulado, salvo se o modo global ou config for alterado.

### 5.2 Ordem enviada

`PolyTrader.placeTrade()`:

```text
cappedSize = min(sizeUsd, polyTrader.maxStake)
shares = floor((cappedSize / price) * 100) / 100
orderType = GTC
```

Em LIVE, usa:

```text
client.createAndPostOrder({
  tokenID,
  price,
  size: shares,
  side: BUY|SELL
}, undefined, OrderType.GTC)
```

Nao ha parametro explicito de slippage. O controle de preco e feito por ordem limitada GTC no preco calculado/observado. O tick size fica automatico no client.

### 5.3 Saida LIVE/SIM

Para os motivos de saida intra-candle:

```text
tp_hit
tp_trailing_stop
tp_force_fail
timeout_min_exit
timeout_force_exit
decay_stop_min_exit
decay_stop_force_exit
trailing_stop
hard_stop
```

`serverScalp.js` envia:

```text
side = SELL
price = trade.exitPrice
sizeUsd = trade.shares * trade.exitPrice
tokenId = mesmo lado da entrada
```

Depois chama `polyTrader.resolveScalpPair()` para carimbar no BUY o preco de saida tentado, status do SELL, PnL e resolucao.

### 5.4 Fill parcial, cancelamento e latencia

O codigo atual consulta status via `refreshTradeResults()`:

```text
client.getOrder(orderId)
originalSize = order.original_size
sizeMatched = order.size_matched
associatedTradeIds = order.associate_trades
fullyMatched = sizeMatched >= originalSize
```

Confirma fill quando:

```text
fullyMatched &&
!hasFailedAssociated &&
(allAssociatedConfirmed || orderLooksFilled || associatedTradeIds.length == 0)
```

Nao ha cancelamento automatico de ordem parcial no fluxo Scalp ativo. `getOpenOrders()` existe, mas a estrategia nao cancela ordens pendentes/parciais por latencia ou stale price.

Latencia/freshness operacional:

- `advanceScalp()` so recebe `enabled: true` se `polymarketCurrentFresh` e `polymarketPricesFresh` forem verdadeiros.
- O runner tem watchdog e timeout por `CONFIG.watchdogMs`/`CONFIG.tickTimeoutMs`.
- `refreshBalance()` e chamado 2s apos envio de ordem.

## 6. Refatoracao Sugerida

O acoplamento atual esta em tres pontos:

- parametros hardcoded/defaults em `src/serverScalp.js`;
- override em `logs/trading_config.runtime.json`;
- parametros fallback invisiveis em `src/engines/scalpForce.js`.

No novo diretorio, prefira carregar um arquivo externo unico antes de criar os runtimes. Exemplo Python para portar a mesma ideia:

```python
from dataclasses import dataclass
from pathlib import Path
import yaml

@dataclass(frozen=True)
class ScalpConfig:
    stake_usd: float
    entry_min_pct: float
    entry_max_pct: float
    take_profit_pct: float
    min_exit_pct: float
    tp_exit_mode: str
    tp_trail_cents: float
    tp_force_exit_enabled: bool
    tp_force_fail_ticks: int
    trailing_arming_cents: float
    trailing_cushion_cents: float
    decay_stop_cushion_usd: float
    hard_stop_cushion_cents: float
    hard_stop_grace_sec: int
    max_entries_per_candle: int
    entry_open_window_sec: int
    max_hold_sec: int
    min_shares_floor: float
    max_effective_stake_usd: float
    enabled: bool
    live_mode: bool

def load_scalp_configs(path: str | Path) -> dict[str, ScalpConfig]:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    strategies = raw["strategies"]
    return {
        name: ScalpConfig(**cfg)
        for name, cfg in strategies.items()
    }

configs = load_scalp_configs("polymarket_scalp_config.yaml")
scalp_5m = configs["scalp_force_5m"]
scalp_15m = configs["scalp_force_15m"]
```

Ao replicar, tambem normalize o mapa de sinais antes de chamar a estrategia:

```python
def build_scalp_signal_map(heiken_color, obv_slope, delta_3m, rsi, macd_side, ema_side, vwap_distance):
    out = {}
    out["Heiken Ashi"] = "UP" if heiken_color == "green" else "DOWN" if heiken_color == "red" else None
    out["OBV"] = "UP" if obv_slope and obv_slope > 0 else "DOWN" if obv_slope and obv_slope < 0 else None
    out["Delta 3m"] = "UP" if delta_3m and delta_3m > 0 else "DOWN" if delta_3m and delta_3m < 0 else None
    if out["Heiken Ashi"] == "UP" and out["OBV"] == "UP":
        out["Heiken+OBV"] = "UP"
    elif out["Heiken Ashi"] == "DOWN" and out["OBV"] == "DOWN":
        out["Heiken+OBV"] = "DOWN"

    votes = [
        out["Heiken Ashi"],
        "UP" if rsi > 50 else "DOWN" if rsi < 50 else None,
        macd_side,
        ema_side,
        out["OBV"],
        "UP" if vwap_distance > 0 else "DOWN" if vwap_distance < 0 else None,
        out["Delta 3m"],
    ]
    if votes.count("UP") >= 5:
        out["5+ Agree"] = "UP"
    elif votes.count("DOWN") >= 5:
        out["5+ Agree"] = "DOWN"
    return out
```
