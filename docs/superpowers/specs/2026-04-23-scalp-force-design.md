# Scalp Force Design

Date: 2026-04-23
Status: Draft for user review

## Summary

This spec defines two new dedicated indicators for the existing Polymarket BTC dashboard:

- `Scalp Force 5m`
- `Scalp Force 15m`

They are short-hold scalp strategies, separate from the current indicators that hold positions until market resolution.

The strategy intent is:

- detect strong directional bias at the start of a candle
- enter only when the contract price is still in the value zone (`50%-55%` by default)
- exit early at a take-profit target (`75%` by default)
- if take profit is not reached, exit after a configurable max hold time
- at timeout, prefer exit only above a configurable minimum exit percentage, otherwise force exit at market
- expose all relevant parameters in the UI so they can be tuned without code changes

## Goals

- Add a scalp-oriented strategy that operates on live contract prices during the candle, not only at market resolution.
- Keep separate behavior and reporting for `5m` and `15m`.
- Surface the new indicators inside the existing `Atividade em Tempo Real` area.
- Make the main tactical parameters visible and adjustable in the UI.
- Respect Polymarket minimum order sizing by using an explicit minimum shares floor in the stake calculation.

## Non-Goals

- Replace the current hold-to-expiry simulator.
- Merge scalp results into the existing `sim_trades_*` files.
- Introduce weighted machine-learning scoring for this MVP.
- Create a new page for the strategy.

## Strategy Definition

### Direction

Direction is determined at the start of a candle using:

- `Price to Beat`
- `Current Price`
- median of `Binance`, `Coinbase`, and `Kraken`

Rules:

- Candidate direction is `UP` if `Current Price` is above `Price to Beat` and the exchange median is also above `Price to Beat`.
- Candidate direction is `DOWN` if `Current Price` is below `Price to Beat` and the exchange median is also below `Price to Beat`.
- If `Current Price` and exchange median disagree around `Price to Beat`, the indicator does not arm.

This intentionally avoids an extra configurable PTB edge threshold in the MVP. If noise around the threshold proves to be a problem, a tolerance can be added later.

### Strength Filters

`Scalp Force 5m`

- requires `Heiken+OBV` in the candidate direction
- requires `5+ Agree` in the candidate direction

`Scalp Force 15m`

- requires `Heiken+OBV` in the candidate direction
- requires `5+ Agree` in the candidate direction
- requires `Delta 3m` in the candidate direction as an extra strength confirmation

### Entry

Entry is allowed only when all of the following are true:

- a new candle has started
- direction has been determined from `Price to Beat`, `Current Price`, and exchange median
- strength filters for the timeframe are aligned
- the chosen contract price is inside the configured entry band
- the entry occurs within a configurable opening window

Default entry parameters:

- `entry min % = 50`
- `entry max % = 55`
- `entry open window = configurable per indicator`

### Exit

Exit is monitored tick by tick using the live contract price of the chosen side.

Default exit logic:

- take profit at `75%`
- if TP is not hit, exit after `max hold time`
- at timeout:
  - if price is at or above `min exit %`, exit there
  - otherwise force market exit and record a timeout forced exit

The timeout path exists before any stop-based design because the user explicitly selected timeout-first behavior with a minimum acceptable exit percentage.

## Configurable Parameters

Each indicator must expose its own parameter set in the UI.

Required parameters:

- `entry min %`
- `entry max %`
- `take profit %`
- `max hold time`
- `min exit %`
- `entry open window`
- `base stake usd`
- `min shares floor`
- `max allowed effective stake usd`
- `enabled`

Default sizing rule:

`effectiveStakeUsd = max(baseStakeUsd, entryPrice * minSharesFloor)`

This makes the minimum shares rule explicit instead of relying on hidden fallback logic in order placement.

If `effectiveStakeUsd` exceeds `max allowed effective stake usd`, the strategy must not enter and must record the reason.

## State Model

Each scalp indicator keeps its own runtime state per timeframe.

States:

- `idle`
- `armed`
- `ready_to_enter`
- `in_position`
- `tp_hit`
- `timeout_min_exit`
- `timeout_force_exit`
- `cancelled`

Runtime fields:

- `armedAt`
- `entryAt`
- `entryPrice`
- `entryDirection`
- `targetPrice`
- `minExitPrice`
- `deadlineAt`
- `stakeUsd`
- `shares`
- `status`
- `exitAt`
- `exitPrice`
- `exitReason`
- `pnl`
- `priceToBeat`
- `currentPriceAtEntry`
- `exchangeMedianAtEntry`

## Architecture

### Engine Separation

The current engine keeps its existing behavior for hold-to-expiry strategies.

The new scalp indicators add a separate state machine inside each timeframe engine:

- one state machine in the `5m` engine for `Scalp Force 5m`
- one state machine in the `15m` engine for `Scalp Force 15m`

This separation avoids corrupting the current simulation logic, which resolves positions only at market close.

### Data Flow

Per tick:

1. gather market data already used by the current engine
2. refresh `Price to Beat`, `Current Price`, exchange prices, and contract prices
3. evaluate scalp arming and entry conditions if state is not in position
4. evaluate TP or timeout exit if state is in position
5. update live payload for dashboard rendering
6. append a row to the scalp trade log only when a scalp position is fully closed

### Persistence

Scalp strategy results must live in dedicated files:

- `logs/scalp_trades_5m.csv`
- `logs/scalp_trades_15m.csv`

Each row stores:

- `timestamp`
- `market_slug`
- `window_min`
- `indicator`
- `side`
- `entry_price`
- `exit_price`
- `entry_time`
- `exit_time`
- `hold_seconds`
- `exit_reason`
- `stake`
- `shares`
- `pnl_usd`
- `price_to_beat`
- `current_price_entry`
- `exchange_median_entry`

This keeps scalp analytics separate from the existing `sim_trades_*` files.

## UI Design

### Location

The new indicators live in the current `Atividade em Tempo Real` block.

No separate page is introduced.

### Real-Time Cards

Add two cards:

- `Scalp Force 5m`
- `Scalp Force 15m`

Each card shows:

- candidate direction
- `Price to Beat`
- `Current Price`
- exchange median
- contract price
- configured entry band
- `take profit %`
- `min exit %`
- `max hold time`
- effective stake
- shares estimate
- current state
- most recent cancel or exit reason

### Lower Activity Strip

The area currently used for resolved-trade summary should become an operational strip for the scalp indicators:

- latest entry
- active open position
- time remaining
- target price
- latest exit reason
- cumulative P&L for `Scalp Force 5m`
- cumulative P&L for `Scalp Force 15m`

### Config Controls

Parameters must be editable on screen, not hidden in `.env`.

The UI should make the main tactical levers obvious and safe to tune:

- percentages shown as percentages, not decimal probabilities
- hold time shown in seconds or minutes, matching the timeframe context
- effective stake and minimum-shares implication shown together

## Error Handling

Do not arm or enter if:

- `Price to Beat` is missing
- `Current Price` is missing
- exchange median cannot be computed
- `Current Price` and exchange median disagree around `Price to Beat`
- contract price is outside the entry band
- strength filters are not aligned
- effective stake exceeds configured risk cap

If price data goes missing while in position:

- freeze state
- do not synthesize an exit
- resume monitoring on the next valid tick

## Testing Plan

Required scenarios:

- valid `5m` entry inside `50%-55%`
- valid `15m` entry inside `50%-55%`
- TP hit before timeout
- timeout exit above `min exit %`
- timeout forced exit below `min exit %`
- cancel before entry due to lost strength
- cancel due to stake required for `5 shares` exceeding max allowed effective stake
- disagreement between `Current Price` and exchange median around `Price to Beat`
- UI rendering of live states in `Atividade em Tempo Real`
- correct persistence into `scalp_trades_5m.csv` and `scalp_trades_15m.csv`

## Risks

- The simulator currently assumes exit at market resolution for most indicators; scalp exit introduces an additional simulation path that must remain isolated.
- Contract prices may move quickly near candle open, so entry window semantics must be explicit to avoid inconsistent backtests.
- If exchange data lags versus `Current Price`, the disagreement filter may become too conservative. This is acceptable in the MVP because false negatives are safer than false positives.

## Implementation Outline

1. Add two new indicator definitions and per-indicator config fields.
2. Add scalp runtime state machines to the `5m` and `15m` engines.
3. Add tick-based entry and exit monitoring using live contract prices.
4. Add dedicated scalp CSV persistence and summaries.
5. Extend the `Atividade em Tempo Real` UI with two scalp cards and adjustable parameters.
6. Add focused validation tests for entry, exit, and timeout behavior.

## Acceptance Criteria

- `Scalp Force 5m` and `Scalp Force 15m` appear in the existing activity panel.
- Both indicators can be enabled, configured, and monitored from the UI.
- Entry requires alignment between `Price to Beat`, `Current Price`, exchange median, and the configured strength indicators.
- Exit occurs by TP or timeout logic without waiting for market resolution.
- The strategy respects minimum shares through explicit effective stake calculation.
- Scalp results are logged to dedicated CSV files and do not overwrite existing hold-to-expiry trade logs.
- The user can tune time and percentage parameters directly in the UI.
